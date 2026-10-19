'use server';

import { redirect } from 'next/navigation';
import { LAND_NAME } from '@tcms/domain';
import { fuegeLandHinzu, speichereLandStaende } from '@tcms/service';
import { aktualisiereMandant } from '../aktion';
import type { Ergebnis } from '../ergebnis';
import { dienstAufruf, eingabe, feld } from '../feststellungen-daten';
import { brauchtKanzleiFuer } from '../sitzung';

// =============================================================================
// Länder-Monitor (Fachkonzept S12): Länderdaten manuell erfassen. Dünne Hüllen
// um die Fachoperationen aus @tcms/service: Jede Erfassung legt dort einen
// neuen LandStand an (Historie bleibt), neues Lagerland und Schwellenwechsel
// lösen Ereignisse (T-02, T-04) aus. Hier werden nur Formularwerte gelesen
// (deutsche Betragsschreibweise, Kontrollkästchen).
// =============================================================================

class Abbruch extends Error {}

const MAX_EUR = 100_000_000_000;

function betrag(roh: FormDataEntryValue | null, feldName: string): number {
  const s = String(roh ?? '').replace(/\s|€/g, '');
  if (!s) return 0;
  const norm = s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s;
  const n = Number(norm);
  if (!Number.isFinite(n) || n < 0 || n > MAX_EUR)
    throw new Abbruch(`${feldName}: bitte einen Betrag ab 0 € angeben.`);
  return n;
}

/** Liest die Felder eines Landes; Präfix z. B. „CZ." bei der Sammelerfassung. */
function leseLand(fd: FormData, land: string, praefix: string) {
  const name = LAND_NAME[land] ?? land;
  const lager = String(fd.get(`${praefix}lagerSeit`) ?? '').trim();
  const geprueft = String(fd.get(`${praefix}steuersaetzeGeprueftAm`) ?? '').trim();
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
    steuersaetzeGeprueftAm: geprueft || null,
  };
}

const UNGUELTIG =
  'Bitte die Angaben prüfen (Stand als Datum, „Lager seit“ als Monat, Beträge ab 0 €).';

async function kanzlei(fd: FormData) {
  const mandantId = feld(fd, 'mandantId');
  return { mandantId, akteur: await brauchtKanzleiFuer(mandantId) };
}

// ---------------------------------------------------------------------------
// Ein Land aktualisieren (Drawer)
// ---------------------------------------------------------------------------

export async function speichereLandStand(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  const { mandantId, akteur } = await kanzlei(fd);
  const land = feld(fd, 'land');
  let laender;
  try {
    laender = [leseLand(fd, land, '')];
  } catch (e) {
    if (e instanceof Abbruch) return { fehler: e.message };
    throw e;
  }
  const r = await dienstAufruf(
    akteur,
    (ctx) =>
      speichereLandStaende(ctx, eingabe({ mandantId, datenstand: feld(fd, 'stand'), laender })),
    { ungueltig: UNGUELTIG },
  );
  if ('fehler' in r) return r;
  aktualisiereMandant(mandantId);
  const ereignisse = r.wert.ereignisse;
  return {
    ok: `Neuer Stand für ${land} gespeichert; der bisherige Stand bleibt in der Historie.${ereignisse.length ? ` Ereignis ${ereignisse.join(', ')} im Ereigniseingang angelegt.` : ''}`,
  };
}

// ---------------------------------------------------------------------------
// Sammelerfassung aller Länder zu einem Stand
// ---------------------------------------------------------------------------

export async function speichereLaender(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  const { mandantId, akteur } = await kanzlei(fd);
  const codes = [...new Set(fd.getAll('land').map(String))].filter((l) => /^[A-Z]{2}$/.test(l));
  if (!codes.length) return { fehler: 'Keine Länder übermittelt.' };
  let laender;
  try {
    laender = codes.map((l) => leseLand(fd, l, `${l}.`));
  } catch (e) {
    if (e instanceof Abbruch) return { fehler: e.message };
    throw e;
  }
  const r = await dienstAufruf(
    akteur,
    (ctx) =>
      speichereLandStaende(ctx, eingabe({ mandantId, datenstand: feld(fd, 'stand'), laender })),
    { ungueltig: UNGUELTIG },
  );
  if ('fehler' in r) return r;
  aktualisiereMandant(mandantId);
  const q = new URLSearchParams({ erfasst: String(r.wert.staende.length) });
  if (r.wert.ereignisse.length) q.set('ereignisse', r.wert.ereignisse.join(','));
  redirect(`/staff/clients/${mandantId}/tcms/laender?${q.toString()}`);
}

// ---------------------------------------------------------------------------
// Land hinzufügen
// ---------------------------------------------------------------------------

export async function landHinzufuegen(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  const { mandantId, akteur } = await kanzlei(fd);
  const land = feld(fd, 'land').toUpperCase();
  let eingabeLand;
  try {
    eingabeLand = leseLand(fd, land, '');
  } catch (e) {
    if (e instanceof Abbruch) return { fehler: e.message };
    throw e;
  }
  const r = await dienstAufruf(
    akteur,
    (ctx) =>
      fuegeLandHinzu(ctx, eingabe({ mandantId, datenstand: feld(fd, 'stand'), land: eingabeLand })),
    { ungueltig: UNGUELTIG },
  );
  if ('fehler' in r) return r;
  aktualisiereMandant(mandantId);
  redirect(`/staff/clients/${mandantId}/tcms/laender?land=${land}`);
}
