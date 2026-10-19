// =============================================================================
// Kommunikation (S13) als Service: Freigaben und Kenntnisnahmen eines
// Programms zum Stichtag (bisher apps/web/src/server/kommunikation-daten.ts).
// Nur Kanzleipersonen mit Bezug (`kannLesen`); keine Codes, keine Code-Hashes.
// Je Freigabe der Zustellstatus der jüngsten Nachricht an den aktuellen
// Empfänger (Stufe 4, nur im aktuellen Stand, ohne Inhalte der Nachricht).
// =============================================================================

import {
  FreigabenHistorieEingabeSchema,
  type FreigabeHistorieZeile,
  type FreigabenHistorie,
  type FreigabenHistorieEingabe,
} from '@tcms/contract';
import { heuteDatum, leseStand, tagesende } from '../../kern/zeit';
import { zustellungenDerFreigaben } from '../../kern/zustellung';
import type { DienstKontext } from '../../kontext';
import { codeStatus } from './code';
import { iso, isoTagVon, kanzleiZugriff, programmIdDesMandanten, pruefeEingabe } from './gemeinsam';

/** Freigaben und Kenntnisnahmen des Programms zum Stichtag (Kommunikation, S13). */
export async function ladeFreigabenHistorie(
  ctx: DienstKontext,
  eingabe: FreigabenHistorieEingabe,
): Promise<FreigabenHistorie> {
  const e = pruefeEingabe(FreigabenHistorieEingabeSchema, eingabe);
  const mandantId = e.mandantId.toLowerCase();
  await kanzleiZugriff(ctx, mandantId, false);
  const { stand, historisch } = leseStand(e.stand, heuteDatum(ctx.uhr));
  const ende = tagesende(stand);
  const programmId = await programmIdDesMandanten(ctx.tx, mandantId, false);
  if (!programmId) return { stand: isoTagVon(stand), historisch, freigaben: [] };
  const roh = await ctx.tx.freigabe.findMany({
    where: { programmId, angefordertAm: { lte: ende } },
    orderBy: [{ angefordertAm: 'desc' }, { id: 'asc' }],
  });
  const jetzt = new Date();
  // Betrieblicher Zustand wie der Code-Status: nur im aktuellen Stand.
  const zustellungen = await zustellungenDerFreigaben(ctx.tx, mandantId, roh, { historisch });
  const freigaben: FreigabeHistorieZeile[] = roh.map((f) => {
    // Eine später erledigte Anforderung gilt am Stichtag als offen.
    const spaeter = f.erledigtAm != null && f.erledigtAm.getTime() > ende.getTime();
    return {
      id: f.id,
      art: f.art,
      titel: f.titel,
      empfaengerId: f.empfaengerId,
      angefordertVon: f.angefordertVon,
      angefordertAm: f.angefordertAm.toISOString(),
      status: spaeter ? 'OFFEN' : f.status,
      erledigtAm: spaeter ? null : iso(f.erledigtAm),
      anmerkung: spaeter ? null : f.anmerkung,
      codeStatus: historisch ? 'KEIN' : codeStatus(f, jetzt, ctx.codes),
      codeAblauf: historisch ? null : iso(f.codeAblauf),
      zustellung: zustellungen.get(f.id) ?? null,
    };
  });
  return { stand: isoTagVon(stand), historisch, freigaben };
}
