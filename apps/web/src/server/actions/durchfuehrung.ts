'use server';

import { redirect } from 'next/navigation';
import { z } from 'zod';
import type { Tx } from '@tcms/db';
import { addTage } from '@tcms/domain';
import { aktualisiereMandant, KEIN_RECHT, mitAudit, type Protokoll } from '../aktion';
import {
  Abbruch,
  ausHistorischemStand,
  fuehreAus,
  kernBeginnen,
  kernEntfernen,
  kernHochladen,
  kernSpeichern,
  kernZurueckweisen,
  ladeFuerAktion,
  rechteFuer,
  text,
  type DurchfuehrungDetail,
} from '../durchfuehrung-daten';
import type { Ergebnis } from '../ergebnis';
import { naechsteFeststellungsnummer } from '../nummern';
import { brauchtKanzlei } from '../sitzung';
import { heute } from '../zeit';

// =============================================================================
// Server Actions der Kontrolldurchführung (S8, Kanzlei). Rechte und Status
// werden in jeder Action serverseitig geprüft (durchfuehrung-daten.ts:
// rechteFuer); jede Änderung läuft über mitAudit.
// =============================================================================

const NUR_AKTUELL = 'Änderungen nur im aktuellen Stand möglich';

/** Fällig → In Durchführung. */
export async function beginneDurchfuehrung(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  return kernBeginnen(await brauchtKanzlei(), fd);
}

/** Schritte abhaken, Werte und Ergebnisvorschlag speichern; optional einreichen. */
export async function speichereDurchfuehrung(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  return kernSpeichern(await brauchtKanzlei(), fd);
}

export async function ladeNachweisHoch(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  return kernHochladen(await brauchtKanzlei(), fd);
}

export async function entferneNachweis(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  return kernEntfernen(await brauchtKanzlei(), fd);
}

export async function weiseDurchfuehrungZurueck(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  return kernZurueckweisen(await brauchtKanzlei(), fd);
}

// ---------------------------------------------------------------------------
// Gegenzeichnen (mit Inline-Erfassung der Feststellung bei Befund)
// ---------------------------------------------------------------------------

const FeststellungSchema = z.object({
  fTitel: z.string().trim().min(5, 'Titel: mindestens 5 Zeichen').max(200),
  fSachverhalt: z.string().trim().min(20, 'Sachverhalt: mindestens 20 Zeichen').max(4000),
  fKlasse: z.enum(['DESIGNMANGEL', 'DURCHFUEHRUNGSMANGEL', 'STEUERLICHER_FEHLER', 'HINWEIS'], {
    message: 'Klasse wählen',
  }),
  fSchwere: z.enum(['GERING', 'MITTEL', 'HOCH', 'KRITISCH'], { message: 'Schwere wählen' }),
  fAuswirkung: z.enum(['JA', 'NEIN', 'UNKLAR'], { message: 'Steuerliche Auswirkung wählen' }),
});

export async function gegenzeichneDurchfuehrung(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  const nutzer = await brauchtKanzlei();
  return fuehreAus(async () => {
    if (ausHistorischemStand(fd)) return { fehler: NUR_AKTUELL };
    const d = await ladeFuerAktion(text(fd, 'id'));
    if (!d) return { fehler: 'Durchführung nicht gefunden.' };
    const r = rechteFuer(nutzer, d, false).gegenzeichnen;
    if (!r.erlaubt) return { fehler: r.grund ?? KEIN_RECHT };
    const ergebnis = d.ergebnis;
    if (!ergebnis)
      return {
        fehler: 'Der Ergebnisvorschlag der durchführenden Person fehlt. Bitte zurückweisen.',
      };

    let inline: (z.infer<typeof FeststellungSchema> & { risikoIds: string[] }) | null = null;
    if (ergebnis === 'MIT_BEFUND' && d.feststellungen.length === 0) {
      const p = FeststellungSchema.safeParse(Object.fromEntries(fd));
      if (!p.success)
        return {
          fehler: `Feststellung unvollständig: ${p.error.issues.map((i) => i.message).join(', ')}.`,
        };
      const erlaubt = new Set(d.risiken.map((x) => x.id));
      const risikoIds = fd
        .getAll('fRisiko')
        .filter((v): v is string => typeof v === 'string' && erlaubt.has(v));
      if (risikoIds.length === 0)
        return { fehler: 'Feststellung unvollständig: mindestens ein betroffenes Risiko wählen.' };
      inline = { ...p.data, risikoIds };
    }

    const nummer = await mitAudit(nutzer, async (tx, zeitpunkt) => {
      await tx.$queryRaw`SELECT id FROM "Durchfuehrung" WHERE id = ${d.id} FOR UPDATE`;
      const akt = await tx.durchfuehrung.findUnique({
        where: { id: d.id },
        select: { status: true, mandantBestaetigtVon: true },
      });
      if (!akt || akt.status !== 'ZUR_GEGENZEICHNUNG')
        throw new Abbruch(
          'Der Status hat sich zwischenzeitlich geändert. Bitte die Seite neu laden.',
        );
      if (d.kontrolle.gegenzeichnungMandant && !akt.mandantBestaetigtVon)
        throw new Abbruch('Bestätigung durch eine zweite Person beim Mandanten steht aus.');
      const protokolle: Protokoll[] = [];
      let nummer: string | null = null;
      if (ergebnis === 'MIT_BEFUND') {
        const vorhanden = await tx.feststellung.findFirst({
          where: { durchfuehrungId: d.id },
          select: { nummer: true },
        });
        if (vorhanden) nummer = vorhanden.nummer;
        else {
          if (!inline) throw new Abbruch('Bei Befund ist eine Feststellung zu erfassen.');
          nummer = await naechsteFeststellungsnummer(tx, d.programmId, zeitpunkt.getUTCFullYear());
          const f = await tx.feststellung.create({
            data: {
              programmId: d.programmId,
              nummer,
              titel: inline.fTitel,
              sachverhalt: inline.fSachverhalt,
              quelle: 'KONTROLLE',
              quelleText: `${d.kontrolle.code} ${d.periodeLabel}`,
              durchfuehrungId: d.id,
              klasse: inline.fKlasse,
              schwere: inline.fSchwere,
              auswirkung: inline.fAuswirkung,
              status: 'ERFASST',
              erfasstVon: nutzer.id,
              erfasstAm: zeitpunkt,
              risiken: { create: inline.risikoIds.map((risikoId) => ({ risikoId })) },
            },
          });
          protokolle.push({
            aktion: 'tcms.feststellung.erfasst',
            objektTyp: 'Feststellung',
            objektId: f.id,
            programmId: d.programmId,
            detail: {
              nummer,
              durchfuehrungId: d.id,
              quelle: 'KONTROLLE',
              quelleText: `${d.kontrolle.code} ${d.periodeLabel}`,
              klasse: inline.fKlasse,
              schwere: inline.fSchwere,
              auswirkung: inline.fAuswirkung,
              risiken: d.risiken.filter((x) => inline.risikoIds.includes(x.id)).map((x) => x.code),
            },
          });
        }
      }
      await tx.durchfuehrung.update({
        where: { id: d.id },
        data: { status: ergebnis, gegengezeichnetVon: nutzer.id, abgeschlossenAm: zeitpunkt },
      });
      await tx.nachweis.updateMany({ where: { durchfuehrungId: d.id }, data: { gesperrt: true } });
      protokolle.push({
        aktion: 'tcms.durchfuehrung.gegengezeichnet',
        objektTyp: 'Durchfuehrung',
        objektId: d.id,
        programmId: d.programmId,
        detail: {
          kontrolle: d.kontrolle.code,
          periode: d.periodeLabel,
          ergebnis,
          durchgefuehrtVon: d.durchgefuehrtVon,
          mandantBestaetigtVon: d.mandantBestaetigtVon,
          feststellung: nummer,
        },
      });
      return { wert: nummer, protokoll: protokolle };
    });
    aktualisiereMandant(d.mandantId);
    return {
      ok:
        ergebnis === 'MIT_BEFUND'
          ? `Gegengezeichnet – abgeschlossen mit Befund (Feststellung ${nummer}).`
          : 'Gegengezeichnet – abgeschlossen ohne Befund.',
    };
  });
}

// ---------------------------------------------------------------------------
// Entfallen: Antrag mit Begründung, Freigabe durch zweite Person (Berufsträger)
// ---------------------------------------------------------------------------

const OFFEN = ['GEPLANT', 'IN_DURCHFUEHRUNG', 'ZURUECKGEWIESEN'] as const;

async function zeileSperren(tx: Tx, id: string) {
  await tx.$queryRaw`SELECT id FROM "Durchfuehrung" WHERE id = ${id} FOR UPDATE`;
  const akt = await tx.durchfuehrung.findUnique({
    where: { id },
    select: { status: true, entfallenBegruendung: true, entfallenVon: true },
  });
  if (!akt) throw new Abbruch('Durchführung nicht gefunden.');
  return akt;
}

function basisDetail(d: DurchfuehrungDetail) {
  return { kontrolle: d.kontrolle.code, periode: d.periodeLabel };
}

export async function beantrageEntfallen(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  const nutzer = await brauchtKanzlei();
  return fuehreAus(async () => {
    if (ausHistorischemStand(fd)) return { fehler: NUR_AKTUELL };
    const begruendung = text(fd, 'begruendung').trim();
    if (begruendung.length < 30)
      return { fehler: 'Bitte eine Begründung mit mindestens 30 Zeichen angeben.' };
    const d = await ladeFuerAktion(text(fd, 'id'));
    if (!d) return { fehler: 'Durchführung nicht gefunden.' };
    const r = rechteFuer(nutzer, d, false).entfallenBeantragen;
    if (!r.erlaubt) return { fehler: r.grund ?? KEIN_RECHT };
    await mitAudit(nutzer, async (tx) => {
      const akt = await zeileSperren(tx, d.id);
      if (!(OFFEN as readonly string[]).includes(akt.status) || akt.entfallenBegruendung)
        throw new Abbruch(
          'Der Status hat sich zwischenzeitlich geändert. Bitte die Seite neu laden.',
        );
      await tx.durchfuehrung.update({
        where: { id: d.id },
        data: {
          entfallenBegruendung: begruendung.slice(0, 4000),
          entfallenVon: nutzer.id,
          entfallenAm: null,
        },
      });
      return {
        wert: null,
        protokoll: {
          aktion: 'tcms.durchfuehrung.entfallen_beantragt',
          objektTyp: 'Durchfuehrung',
          objektId: d.id,
          programmId: d.programmId,
          detail: { ...basisDetail(d), begruendung },
        },
      };
    });
    aktualisiereMandant(d.mandantId);
    return {
      ok: 'Entfallen beantragt. Die Freigabe erfolgt durch eine zweite Person (Berufsträger:in).',
    };
  });
}

export async function gibEntfallenFrei(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  const nutzer = await brauchtKanzlei();
  return fuehreAus(async () => {
    if (ausHistorischemStand(fd)) return { fehler: NUR_AKTUELL };
    const d = await ladeFuerAktion(text(fd, 'id'));
    if (!d) return { fehler: 'Durchführung nicht gefunden.' };
    const r = rechteFuer(nutzer, d, false).entfallenFreigeben;
    if (!r.erlaubt) return { fehler: r.grund ?? KEIN_RECHT };
    await mitAudit(nutzer, async (tx, zeitpunkt) => {
      const akt = await zeileSperren(tx, d.id);
      if (!(OFFEN as readonly string[]).includes(akt.status) || !akt.entfallenBegruendung)
        throw new Abbruch('Kein offener Antrag. Bitte die Seite neu laden.');
      if (akt.entfallenVon === nutzer.id) throw new Abbruch('Freigabe durch eine zweite Person.');
      await tx.durchfuehrung.update({
        where: { id: d.id },
        data: { status: 'ENTFALLEN', entfallenAm: zeitpunkt },
      });
      await tx.nachweis.updateMany({ where: { durchfuehrungId: d.id }, data: { gesperrt: true } });
      return {
        wert: null,
        protokoll: {
          aktion: 'tcms.durchfuehrung.entfallen',
          objektTyp: 'Durchfuehrung',
          objektId: d.id,
          programmId: d.programmId,
          detail: {
            ...basisDetail(d),
            begruendung: akt.entfallenBegruendung,
            beantragtVon: akt.entfallenVon,
          },
        },
      };
    });
    aktualisiereMandant(d.mandantId);
    return { ok: 'Entfallen freigegeben. Die Durchführung zählt nicht als „ohne Befund“.' };
  });
}

/** Antrag ablehnen (zweite Person, Begründung ≥ 30) oder als antragstellende Person zurückziehen. */
export async function lehneEntfallenAb(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  const nutzer = await brauchtKanzlei();
  return fuehreAus(async () => {
    if (ausHistorischemStand(fd)) return { fehler: NUR_AKTUELL };
    const d = await ladeFuerAktion(text(fd, 'id'));
    if (!d) return { fehler: 'Durchführung nicht gefunden.' };
    const r = rechteFuer(nutzer, d, false).entfallenAblehnen;
    if (!r.erlaubt) return { fehler: r.grund ?? KEIN_RECHT };
    const zurueckziehen = d.entfallenVon === nutzer.id;
    const begruendung = text(fd, 'begruendung').trim();
    if (!zurueckziehen && begruendung.length < 30)
      return { fehler: 'Bitte eine Begründung mit mindestens 30 Zeichen angeben.' };
    await mitAudit(nutzer, async (tx) => {
      const akt = await zeileSperren(tx, d.id);
      if (!(OFFEN as readonly string[]).includes(akt.status) || !akt.entfallenBegruendung)
        throw new Abbruch('Kein offener Antrag. Bitte die Seite neu laden.');
      await tx.durchfuehrung.update({
        where: { id: d.id },
        data: { entfallenBegruendung: null, entfallenVon: null, entfallenAm: null },
      });
      return {
        wert: null,
        protokoll: {
          aktion: 'tcms.durchfuehrung.entfallen_abgelehnt',
          objektTyp: 'Durchfuehrung',
          objektId: d.id,
          programmId: d.programmId,
          detail: {
            ...basisDetail(d),
            begruendung: zurueckziehen ? '' : begruendung,
            antrag: akt.entfallenBegruendung,
            beantragtVon: akt.entfallenVon,
          },
        },
      };
    });
    aktualisiereMandant(d.mandantId);
    return { ok: zurueckziehen ? 'Antrag zurückgezogen.' : 'Antrag abgelehnt.' };
  });
}

// ---------------------------------------------------------------------------
// Nachtrag zu einer abgeschlossenen Durchführung
// ---------------------------------------------------------------------------

export async function legeNachtragAn(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  const nutzer = await brauchtKanzlei();
  let ziel: string | null = null;
  const erg = await fuehreAus(async () => {
    if (ausHistorischemStand(fd)) return { fehler: NUR_AKTUELL };
    const begruendung = text(fd, 'begruendung').trim();
    if (begruendung.length < 30)
      return { fehler: 'Bitte den Anlass des Nachtrags mit mindestens 30 Zeichen begründen.' };
    const d = await ladeFuerAktion(text(fd, 'id'));
    if (!d) return { fehler: 'Durchführung nicht gefunden.' };
    const r = rechteFuer(nutzer, d, false).nachtrag;
    if (!r.erlaubt) return { fehler: r.grund ?? KEIN_RECHT };
    const neuId = await mitAudit(nutzer, async (tx, zeitpunkt) => {
      await tx.$queryRaw`SELECT id FROM "Durchfuehrung" WHERE id = ${d.id} FOR UPDATE`;
      const offen = await tx.durchfuehrung.findFirst({
        where: {
          nachtragZuId: d.id,
          status: { in: ['GEPLANT', 'IN_DURCHFUEHRUNG', 'ZUR_GEGENZEICHNUNG', 'ZURUECKGEWIESEN'] },
        },
        select: { id: true },
      });
      if (offen) throw new Abbruch('Zu dieser Durchführung besteht bereits ein offener Nachtrag.');
      const neu = await tx.durchfuehrung.create({
        data: {
          kontrolleId: d.kontrolle.id,
          kontrolleStandId: d.kontrolle.standId,
          periodeLabel: `${d.periodeLabel} · Nachtrag`,
          periodeVon: d.periodeVon,
          periodeBis: d.periodeBis,
          faelligAm: addTage(heute(), 14),
          status: 'GEPLANT',
          ausserplanmaessig: true,
          anlass: `Nachtrag zu ${d.kontrolle.code} ${d.periodeLabel}: ${begruendung}`.slice(
            0,
            2000,
          ),
          nachtragZuId: d.id,
          createdAt: zeitpunkt,
        },
      });
      return {
        wert: neu.id,
        protokoll: {
          aktion: 'tcms.durchfuehrung.nachtrag_angelegt',
          objektTyp: 'Durchfuehrung',
          objektId: neu.id,
          programmId: d.programmId,
          detail: { ...basisDetail(d), nachtragZuId: d.id, begruendung },
        },
      };
    });
    aktualisiereMandant(d.mandantId);
    ziel = `/staff/clients/${d.mandantId}/tcms/durchfuehrungen/${neuId}`;
    return { ok: 'Nachtrag angelegt.' };
  });
  if (ziel) redirect(ziel);
  return erg;
}
