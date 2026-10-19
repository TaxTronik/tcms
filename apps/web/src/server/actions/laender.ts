'use server';

import { redirect } from 'next/navigation';
import { type Tx } from '@tcms/db';
import {
  bewerteSchwelle,
  ereignistyp,
  EU_LAENDER,
  fmtEurGanz,
  fmtMonatJahr,
  isoDatum,
  istEuAusland,
  LAND_NAME,
} from '@tcms/domain';
import { db } from '../demo';
import { aktualisiereMandant, KEIN_RECHT, mitAudit, type Protokoll } from '../aktion';
import type { Ergebnis } from '../ergebnis';
import { naechsteEreignisnummer } from '../nummern';
import { kannBearbeiten } from '../berechtigung';
import type { KanzleiAkteur } from '../demo';
import { brauchtKanzlei } from '../sitzung';
import { heute } from '../zeit';

// =============================================================================
// Länder-Monitor (Fachkonzept S12): Länderdaten manuell erfassen. Jede Erfassung
// legt einen neuen LandStand an; frühere Stände bleiben unverändert erhalten.
// Neues Lagerland und Schwellenwechsel lösen Ereignisse (T-02, T-04) aus.
// =============================================================================

class Abbruch extends Error {}

interface Eingabe {
  land: string;
  fernverkaeufeLfdEur: number;
  fernverkaeufeVorjahrEur: number;
  lagerSeit: string | null;
  oss: boolean;
  lokaleUstNr: boolean;
  zmRelevant: boolean;
  steuersaetzeGeprueftAm: Date | null;
}

const MAX_EUR = 100_000_000_000;

function betrag(roh: FormDataEntryValue | null, feld: string): number {
  const s = String(roh ?? '').replace(/\s|€/g, '');
  if (!s) return 0;
  const norm = s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s;
  const n = Number(norm);
  if (!Number.isFinite(n) || n < 0 || n > MAX_EUR)
    throw new Abbruch(`${feld}: bitte einen Betrag ab 0 € angeben.`);
  return Math.round(n * 100) / 100;
}

function datum(roh: FormDataEntryValue | null): Date | null {
  const s = String(roh ?? '').trim();
  if (!s) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Abbruch('Bitte ein gültiges Datum angeben.');
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new Abbruch('Bitte ein gültiges Datum angeben.');
  return d;
}

/** Liest die Felder eines Landes; Präfix z. B. „CZ." bei der Sammelerfassung. */
function leseLand(fd: FormData, land: string, praefix: string, stand: Date): Eingabe {
  const name = LAND_NAME[land] ?? land;
  const lager = String(fd.get(`${praefix}lagerSeit`) ?? '').trim();
  if (lager && !/^\d{4}-(0[1-9]|1[0-2])$/.test(lager))
    throw new Abbruch(`${land}: „Lager seit“ bitte als Monat angeben.`);
  if (lager && lager > isoDatum(stand).slice(0, 7))
    throw new Abbruch(`${land}: „Lager seit“ liegt nach dem Stand.`);
  const geprueft = datum(fd.get(`${praefix}steuersaetzeGeprueftAm`));
  if (geprueft && geprueft.getTime() > stand.getTime())
    throw new Abbruch(`${land}: Die Prüfung der Steuersätze liegt nach dem Stand.`);
  return {
    land,
    fernverkaeufeLfdEur: betrag(
      fd.get(`${praefix}fernverkaeufeLfdEur`),
      `${name}, Fernverkäufe lfd. Jahr`,
    ),
    fernverkaeufeVorjahrEur: betrag(
      fd.get(`${praefix}fernverkaeufeVorjahrEur`),
      `${name}, Fernverkäufe Vorjahr`,
    ),
    lagerSeit: lager || null,
    oss: fd.get(`${praefix}oss`) === 'on',
    lokaleUstNr: fd.get(`${praefix}lokaleUstNr`) === 'on',
    zmRelevant: fd.get(`${praefix}zmRelevant`) === 'on',
    steuersaetzeGeprueftAm: geprueft,
  };
}

function leseStand(fd: FormData): Date {
  const stand = datum(fd.get('stand'));
  if (!stand) throw new Abbruch('Bitte den Stand (Datum) angeben.');
  if (stand.getTime() > heute().getTime())
    throw new Abbruch('Der Stand darf nicht in der Zukunft liegen.');
  return stand;
}

async function ladeProgramm(programmId: string) {
  return db.tcmsProgramm.findUnique({ where: { id: programmId }, include: { mandant: true } });
}

type Jeweils = Awaited<ReturnType<Tx['landStand']['findMany']>>;

function juengsteJeLand(staende: Jeweils): Map<string, Jeweils[number]> {
  const m = new Map<string, Jeweils[number]>();
  for (const s of staende) {
    const b = m.get(s.land);
    if (
      !b ||
      s.stand > b.stand ||
      (s.stand.getTime() === b.stand.getTime() && s.createdAt > b.createdAt)
    )
      m.set(s.land, s);
  }
  return m;
}

function summen(
  m: Map<string, { land: string; fernverkaeufeLfdEur: unknown; fernverkaeufeVorjahrEur: unknown }>,
) {
  let lfd = 0;
  let vj = 0;
  for (const s of m.values()) {
    if (!istEuAusland(s.land)) continue;
    lfd += Number(s.fernverkaeufeLfdEur);
    vj += Number(s.fernverkaeufeVorjahrEur);
  }
  return { lfd, vj };
}

/**
 * Legt die neuen Stände an (Prüfung gegen den jüngsten Stand je Land) und
 * erzeugt die ausgelösten Ereignisse. Läuft innerhalb von mitAudit.
 */
async function schreibeStaende(
  tx: Tx,
  zeitpunkt: Date,
  nutzer: Pick<KanzleiAkteur, 'id'>,
  programmId: string,
  stand: Date,
  eingaben: Eingabe[],
  modus: 'neu' | 'aktualisieren',
): Promise<{ protokoll: Protokoll[]; ereignisse: string[]; ids: string[] }> {
  const alle = await tx.landStand.findMany({ where: { programmId } });
  const vorher = juengsteJeLand(alle);
  const nachher = new Map(vorher);
  const protokoll: Protokoll[] = [];
  const ids: string[] = [];
  const ereignisse: { typ: string; titel: string; beschreibung: string; datum: Date }[] = [];

  for (const e of eingaben) {
    const alt = vorher.get(e.land);
    if (modus === 'neu' && alt) throw new Abbruch(`${e.land} ist bereits im Länder-Monitor.`);
    if (modus === 'aktualisieren' && !alt)
      throw new Abbruch(`${e.land} ist nicht im Länder-Monitor.`);
    if (alt && stand.getTime() < alt.stand.getTime()) {
      throw new Abbruch(
        `${e.land}: Es gibt bereits einen Stand zum ${isoDatum(alt.stand).split('-').reverse().join('.')}. Neue Stände dürfen nicht davor liegen.`,
      );
    }
    const neu = await tx.landStand.create({
      data: {
        programmId,
        land: e.land,
        fernverkaeufeLfdEur: e.fernverkaeufeLfdEur,
        fernverkaeufeVorjahrEur: e.fernverkaeufeVorjahrEur,
        lagerSeit: e.lagerSeit,
        oss: e.oss,
        lokaleUstNr: e.lokaleUstNr,
        zmRelevant: e.zmRelevant,
        steuersaetzeGeprueftAm: e.steuersaetzeGeprueftAm,
        stand,
        quelle: 'MANUELL',
        erfasstVon: nutzer.id,
        createdAt: zeitpunkt,
      },
    });
    ids.push(neu.id);
    nachher.set(e.land, neu);
    const vergleich = alt
      ? {
          fernverkaeufeLfdEur: [Number(alt.fernverkaeufeLfdEur), e.fernverkaeufeLfdEur],
          fernverkaeufeVorjahrEur: [Number(alt.fernverkaeufeVorjahrEur), e.fernverkaeufeVorjahrEur],
          lagerSeit: [alt.lagerSeit, e.lagerSeit],
          oss: [alt.oss, e.oss],
          lokaleUstNr: [alt.lokaleUstNr, e.lokaleUstNr],
          zmRelevant: [alt.zmRelevant, e.zmRelevant],
          steuersaetzeGeprueftAm: [
            alt.steuersaetzeGeprueftAm ? isoDatum(alt.steuersaetzeGeprueftAm) : null,
            e.steuersaetzeGeprueftAm ? isoDatum(e.steuersaetzeGeprueftAm) : null,
          ],
        }
      : null;
    const geaendert = vergleich
      ? Object.fromEntries(Object.entries(vergleich).filter(([, [a, b]]) => a !== b))
      : null;
    protokoll.push({
      aktion: modus === 'neu' ? 'tcms.laender.land_hinzugefuegt' : 'tcms.laender.stand_erfasst',
      objektTyp: 'LandStand',
      objektId: neu.id,
      programmId,
      detail: {
        land: e.land,
        stand: isoDatum(stand),
        vorherigerStand: alt ? alt.id : null,
        geaendert,
        quelle: 'manuell',
      },
    });
    if (e.lagerSeit && (!alt || !alt.lagerSeit) && e.land !== 'DE') {
      const name = LAND_NAME[e.land] ?? e.land;
      ereignisse.push({
        typ: 'T-02',
        titel: `Neues Lagerland ${e.land} seit ${fmtMonatJahr(e.lagerSeit)} (Länder-Monitor)`,
        beschreibung: `Im Länder-Monitor wurde für ${name} erstmals ein Lager erfasst (seit ${fmtMonatJahr(e.lagerSeit)}, Stand ${isoDatum(stand).split('-').reverse().join('.')}). Lokale USt-Registrierung: ${e.lokaleUstNr ? 'erfasst' : 'nicht erfasst'}.`,
        datum: new Date(`${e.lagerSeit}-01T00:00:00Z`),
      });
    }
  }

  // Schwellenwechsel der EU-Fernverkäufe (K-EC-01): Warnstufe oder Überschreitung neu erreicht.
  const a = summen(vorher);
  const b = summen(nachher);
  const sa = bewerteSchwelle(a.lfd, a.vj).status;
  const sb = bewerteSchwelle(b.lfd, b.vj).status;
  if (sa !== sb && (sb === 'UEBERSCHRITTEN' || (sb === 'WARNUNG' && sa === 'UNTERSCHRITTEN'))) {
    const pct = Math.round((b.lfd / 10_000) * 100);
    ereignisse.push({
      typ: 'T-04',
      titel:
        sb === 'UEBERSCHRITTEN'
          ? `Lieferschwelle überschritten (${fmtEurGanz(b.lfd)} von 10.000 €)`
          : `Lieferschwelle ${pct} % erreicht (${fmtEurGanz(b.lfd)} von 10.000 €)`,
      beschreibung: `Die im Länder-Monitor erfassten kumulierten EU-Fernverkäufe liegen bei ${fmtEurGanz(b.lfd)} (Vorjahr ${fmtEurGanz(b.vj)}).`,
      datum: stand,
    });
  }

  const nummern: string[] = [];
  for (const ev of ereignisse) {
    const nummer = await naechsteEreignisnummer(tx, zeitpunkt.getUTCFullYear());
    const kat = ereignistyp(ev.typ);
    const neu = await tx.ereignis.create({
      data: {
        programmId,
        nummer,
        typ: ev.typ,
        titel: ev.titel,
        beschreibung: ev.beschreibung,
        quelle: 'MANUELL',
        gemeldetVon: nutzer.id,
        gemeldetAm: zeitpunkt,
        ereignisDatum: ev.datum,
        status: 'NEU',
        folgen: {
          create: (kat?.folgen ?? []).map((f) => ({
            art: f.art,
            ziel: f.ziel ?? null,
            text: f.text,
          })),
        },
      },
    });
    nummern.push(nummer);
    protokoll.push({
      aktion: 'tcms.ereignis.gemeldet',
      objektTyp: 'Ereignis',
      objektId: neu.id,
      programmId,
      detail: { nummer, typ: ev.typ, quelle: 'Länder-Monitor' },
    });
  }
  return { protokoll, ereignisse: nummern, ids };
}

function fehlerAus(e: unknown): Ergebnis {
  if (e instanceof Abbruch) return { fehler: e.message };
  throw e;
}

// ---------------------------------------------------------------------------
// Ein Land aktualisieren (Drawer)
// ---------------------------------------------------------------------------

export async function speichereLandStand(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  const nutzer = await brauchtKanzlei();
  const programm = await ladeProgramm(String(fd.get('programmId') ?? ''));
  if (!programm) return { fehler: 'Tax-CMS nicht gefunden.' };
  if (!kannBearbeiten(nutzer, programm.mandant)) return { fehler: KEIN_RECHT };
  const land = String(fd.get('land') ?? '');
  let ergebnis: { ereignisse: string[] };
  try {
    const stand = leseStand(fd);
    const eingabe = leseLand(fd, land, '', stand);
    ergebnis = await mitAudit(nutzer, async (tx, zeitpunkt) => {
      const r = await schreibeStaende(
        tx,
        zeitpunkt,
        nutzer,
        programm.id,
        stand,
        [eingabe],
        'aktualisieren',
      );
      return { wert: { ereignisse: r.ereignisse }, protokoll: r.protokoll };
    });
  } catch (e) {
    return fehlerAus(e);
  }
  aktualisiereMandant(programm.mandantId);
  return {
    ok: `Neuer Stand für ${land} gespeichert; der bisherige Stand bleibt in der Historie.${ergebnis.ereignisse.length ? ` Ereignis ${ergebnis.ereignisse.join(', ')} im Ereigniseingang angelegt.` : ''}`,
  };
}

// ---------------------------------------------------------------------------
// Sammelerfassung aller Länder zu einem Stand
// ---------------------------------------------------------------------------

export async function speichereLaender(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  const nutzer = await brauchtKanzlei();
  const programm = await ladeProgramm(String(fd.get('programmId') ?? ''));
  if (!programm) return { fehler: 'Tax-CMS nicht gefunden.' };
  if (!kannBearbeiten(nutzer, programm.mandant)) return { fehler: KEIN_RECHT };
  const laender = [...new Set(fd.getAll('land').map(String))].filter((l) => /^[A-Z]{2}$/.test(l));
  if (!laender.length) return { fehler: 'Keine Länder übermittelt.' };
  let ergebnis: { anzahl: number; ereignisse: string[] };
  try {
    const stand = leseStand(fd);
    const eingaben = laender.map((l) => leseLand(fd, l, `${l}.`, stand));
    ergebnis = await mitAudit(nutzer, async (tx, zeitpunkt) => {
      const r = await schreibeStaende(
        tx,
        zeitpunkt,
        nutzer,
        programm.id,
        stand,
        eingaben,
        'aktualisieren',
      );
      return { wert: { anzahl: r.ids.length, ereignisse: r.ereignisse }, protokoll: r.protokoll };
    });
  } catch (e) {
    return fehlerAus(e);
  }
  aktualisiereMandant(programm.mandantId);
  const q = new URLSearchParams({ erfasst: String(ergebnis.anzahl) });
  if (ergebnis.ereignisse.length) q.set('ereignisse', ergebnis.ereignisse.join(','));
  redirect(`/staff/clients/${programm.mandantId}/tcms/laender?${q.toString()}`);
}

// ---------------------------------------------------------------------------
// Land hinzufügen
// ---------------------------------------------------------------------------

export async function landHinzufuegen(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  const nutzer = await brauchtKanzlei();
  const programm = await ladeProgramm(String(fd.get('programmId') ?? ''));
  if (!programm) return { fehler: 'Tax-CMS nicht gefunden.' };
  if (!kannBearbeiten(nutzer, programm.mandant)) return { fehler: KEIN_RECHT };
  const land = String(fd.get('land') ?? '').toUpperCase();
  if (!EU_LAENDER.includes(land) || land === 'DE')
    return { fehler: 'Bitte ein EU-Land außer Deutschland wählen.' };
  try {
    const stand = leseStand(fd);
    const eingabe = leseLand(fd, land, '', stand);
    await mitAudit(nutzer, async (tx, zeitpunkt) => {
      const r = await schreibeStaende(tx, zeitpunkt, nutzer, programm.id, stand, [eingabe], 'neu');
      return { wert: null, protokoll: r.protokoll };
    });
  } catch (e) {
    return fehlerAus(e);
  }
  aktualisiereMandant(programm.mandantId);
  redirect(`/staff/clients/${programm.mandantId}/tcms/laender?land=${land}`);
}
