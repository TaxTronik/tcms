// =============================================================================
// Portal (P3): Ereignis melden und eigene Meldungen lesen. Melden dürfen
// gesetzliche Vertretung und Tax-Compliance-Beauftragte des eigenen
// Mandanten (aktive Rolle, Fachkonzept §13); Anlagen kommen nur als Verweise
// der kanzleikonsole (ADR 0001 §6).
// =============================================================================

import {
  DienstFehler,
  nichtBerechtigt,
  PortalMeldungenLesenSchema,
  type Akteur,
  PortalMeldungSchema,
  type PortalMeldung,
  type PortalMeldungen,
  type PortalMeldungenLesen,
  type PortalMeldungErgebnis,
} from '@tcms/contract';
import { EREIGNISTYPEN, ereignistyp, fmtDatumZeit, PORTAL_SONSTIGES } from '@tcms/domain';
import { heuteDatum } from '../../kern/zeit';
import type { DienstKontext } from '../../kontext';
import { kannLesen, kannPortalLesen, siehtPortalMeldung, type KontaktRolle } from '../../rechte';
import { ladeKontaktRollen } from '../../rollen';
import { legeNachrichtAn } from '../programm-beschreibung/nachrichten';
import { legeEreignisAn } from './ereignisse';
import {
  aendere,
  alsTag,
  isoZeit,
  namenListe,
  programmVon,
  pruefe,
  pruefeMandant,
} from './gemeinsam';

/** Im Portal meldbare Typen: Katalogtypen mit Portal-Kachel und „Sonstiges". */
export const PORTAL_TYPEN: readonly string[] = [
  ...EREIGNISTYPEN.filter((t) => t.portal).map((t) => t.code),
  PORTAL_SONSTIGES.code,
];

export const NUR_GV_TCB =
  'Ereignisse melden die Geschäftsführung und die bzw. der Tax-Compliance-Beauftragte. Bitte wenden Sie sich an diese Personen.';
const KEIN_TCMS =
  'Für Ihr Unternehmen ist noch kein Tax-CMS eingerichtet. Bitte wenden Sie sich an Ihre Kanzlei.';
const ZWEI_JAHRE_MS = 730 * 86_400_000;

/**
 * Meldet-Recht (Fachkonzept §13): Mandantenkontakt mit aktiver Rolle GV oder
 * TCB beim eigenen Mandanten. Einzige Stelle dieser Regel; die Demo nutzt sie
 * nur, um Dateien Unberechtigter gar nicht erst anzunehmen.
 */
export function darfEreignisMelden(
  a: Akteur,
  mandantId: string,
  rollen: readonly KontaktRolle[],
): boolean {
  return a.art === 'MANDANT' && kannPortalLesen(a, mandantId, rollen);
}

/**
 * Meldet ein Ereignis aus dem Portal. Nur Mandantenkontakte mit Rolle GV oder
 * TCB beim eigenen Mandanten; Mitarbeitende und Kanzleipersonen sehen den
 * Mandanten, dürfen aber nicht melden (NICHT_BERECHTIGT); ohne aktive Rolle
 * oder fremder Mandant: NICHT_GEFUNDEN. Die Kanzlei wird über den Postausgang
 * benachrichtigt; den Empfänger nennt die kanzleikonsole (`benachrichtigen`).
 */
export async function meldeEreignis(
  ctx: DienstKontext,
  eingabe: PortalMeldung,
): Promise<PortalMeldungErgebnis> {
  const x = pruefe(PortalMeldungSchema, eingabe);
  const mandantId = x.mandantId.toLowerCase();
  const rollen = await ladeKontaktRollen(ctx.tx, ctx.akteur);
  if (!kannLesen(ctx.akteur, mandantId, rollen)) throw new DienstFehler('NICHT_GEFUNDEN');
  await pruefeMandant(ctx.tx, mandantId);
  if (!darfEreignisMelden(ctx.akteur, mandantId, rollen)) {
    // Kanzleipersonen melden nicht im Portal (andere Seite); Kontakte ohne GV/TCB fehlt die Rolle.
    throw nichtBerechtigt(ctx.akteur.art === 'MANDANT' ? 'PORTAL_ROLLE' : 'PARTEI', NUR_GV_TCB);
  }
  if (!PORTAL_TYPEN.includes(x.typ)) {
    const text = 'Bitte wählen Sie eine Art des Ereignisses.';
    throw new DienstFehler('UNGUELTIG', text, { typ: [text] });
  }
  const datum = alsTag(x.datum);
  if (Math.abs(datum.getTime() - heuteDatum(ctx.uhr).getTime()) > ZWEI_JAHRE_MS) {
    const text = 'Bitte prüfen Sie das Datum.';
    throw new DienstFehler('UNGUELTIG', text, { datum: [text] });
  }
  const akteurName = ctx.akteur.name;
  return aendere(ctx, async (tx, zeitpunkt) => {
    const programm = await programmVon(tx, mandantId);
    const mandant = await tx.mandant.findFirst({
      where: { id: mandantId },
      select: { name: true },
    });
    if (!programm || !mandant) throw new DienstFehler('NICHT_GEFUNDEN', KEIN_TCMS);
    const e = await legeEreignisAn(tx, {
      programmId: programm.id,
      typ: x.typ,
      titel: x.titel,
      beschreibung: x.beschreibung,
      quelle: 'PORTAL',
      gemeldetVon: ctx.akteur.id,
      ereignisDatum: datum,
      zeitpunkt,
    });
    const typTitel = ereignistyp(x.typ)?.titel ?? PORTAL_SONSTIGES.titel;
    // Benachrichtigung der von der kanzleikonsole genannten Person über den
    // Postausgang, adressiert nur über ihre ID (TS-06). Ohne Angabe keine
    // Nachricht: Das Ereignis steht im Ereigniseingang.
    if (x.benachrichtigen) {
      await legeNachrichtAn(tx, {
        mandantId,
        empfaengerId: x.benachrichtigen.id,
        zweck: 'EREIGNIS_GEMELDET',
        daten: {
          ereignisId: e.id,
          nummer: e.nummer,
          titel: x.titel,
          typ: typTitel,
          gemeldetVonId: ctx.akteur.id,
        },
        betreff: `Neues Ereignis ${e.nummer}: ${typTitel}`,
        text: `${akteurName} hat für ${mandant.name} am ${fmtDatumZeit(zeitpunkt)} ein Ereignis gemeldet: „${x.titel}". Bitte im Ereigniseingang triagieren.`,
        erstelltAm: zeitpunkt,
      });
    }
    return {
      wert: { id: e.id, nummer: e.nummer },
      protokoll: {
        aktion: 'tcms.ereignis.gemeldet',
        objektTyp: 'Ereignis',
        objektId: e.id,
        programmId: programm.id,
        detail: {
          nummer: e.nummer,
          typ: x.typ,
          quelle: 'PORTAL',
          // Nur die bekannten Felder des Verweises (ADR 0001 §6).
          anlagen: x.anlagen.map((a) => ({
            dokumentId: a.dokumentId,
            dateiname: a.dateiname,
            mime: a.mime,
            groesse: a.groesse,
            sha256: a.sha256,
          })),
          zusageAenderungen: x.zusageAenderungen,
          benachrichtigt: x.benachrichtigen?.id.toLowerCase() ?? null,
        },
      },
    };
  });
}

/**
 * Die letzten Portal-Meldungen des eigenen Mandanten (P3). Aufrufen dürfen
 * alle Kontakte mit aktiver Rolle beim eigenen Mandanten und Kanzleipersonen
 * mit Bezug (`kannLesen`); sonst NICHT_GEFUNDEN. Welche Meldungen sie sehen,
 * regelt `siehtPortalMeldung` wie in der Portal-Übersicht (ADR 0001 §5,
 * RT4-T-04): GV und TCB alle, alle anderen nur selbst gemeldete.
 */
export async function ladePortalMeldungen(
  ctx: DienstKontext,
  eingabe: PortalMeldungenLesen,
): Promise<PortalMeldungen> {
  const x = pruefe(PortalMeldungenLesenSchema, eingabe);
  const mandantId = x.mandantId.toLowerCase();
  const rollen = await ladeKontaktRollen(ctx.tx, ctx.akteur);
  if (!kannLesen(ctx.akteur, mandantId, rollen)) throw new DienstFehler('NICHT_GEFUNDEN');
  await pruefeMandant(ctx.tx, mandantId);
  // Dieselbe Regel wie `meldeEreignis` (Kennzeichen = Ergebnis der Prüfung dort).
  const melden = darfEreignisMelden(ctx.akteur, mandantId, rollen);
  const programm = await programmVon(ctx.tx, mandantId);
  if (!programm) return { melden, programmVorhanden: false, meldungen: [], namen: [] };
  const alle = kannPortalLesen(ctx.akteur, mandantId, rollen);
  const roh = await ctx.tx.ereignis.findMany({
    where: {
      programmId: programm.id,
      quelle: 'PORTAL',
      // Ohne Portal-Lesen nur die eigenen (dieselbe Regel wie unten, schon in der Abfrage,
      // damit die Grenze von 20 nur Sichtbares zählt).
      ...(alle ? {} : { gemeldetVon: { equals: ctx.akteur.id, mode: 'insensitive' as const } }),
    },
    orderBy: [{ gemeldetAm: 'desc' }, { id: 'desc' }],
    take: 20,
    select: {
      id: true,
      nummer: true,
      typ: true,
      titel: true,
      status: true,
      gemeldetAm: true,
      gemeldetVon: true,
    },
  });
  const meldungen = roh
    .filter((m) => siehtPortalMeldung(ctx.akteur, mandantId, rollen, m.gemeldetVon))
    .map((m) => ({ ...m, gemeldetAm: isoZeit(m.gemeldetAm) }));
  return {
    melden,
    programmVorhanden: true,
    meldungen,
    namen: await namenListe(
      ctx,
      meldungen.map((m) => m.gemeldetVon),
    ),
  };
}
