// =============================================================================
// Nummernkreise (ADR 0001 §4), bisher apps/web/src/server/nummern.ts. Alle
// Vergaben laufen in der Transaktion der jeweiligen Operation (`ctx.tx` bzw.
// `tx` aus `mitAudit`) und serialisieren sich über einen Advisory-Lock je
// Tenant und Nummernkreis (TS-08: kein globaler Lock):
//
//   - Ereignisse `<Jahr>-T-<nnnn>` und Feststellungen `F-<Jahr>-<nnn>` je
//     Programm (Sperre je Programm): Mandantenkontakte sehen Ereignisnummern im
//     Portal; eine kanzleiweite Folge verriete aus ihren Lücken das
//     Meldeaufkommen anderer Mandanten (wie `seq` im Audit, RT-03).
//   - Wiedervorlagen je Kanzlei (Tenant), wie bisher.
//
// Unter RLS sieht max + 1 nur die Nummern des eigenen Tenants; die eindeutigen
// Schlüssel (tenant_id, programmId, nummer) bzw. (tenant_id, wiedervorlageNr)
// sichern ab; das Maximum rechnet die Datenbank (keine Liste aller Nummern).
// Sperrreihenfolge: Zeilen (Programm, Ereignis, Feststellung,
// Risiko, Kontrolle, Durchführung) vor dem Nummernkreis – die Aufrufer sperren
// bzw. halten ihre Elternzeilen, bevor sie eine Nummer ziehen.
// =============================================================================

import { tenantSperre, type Tx } from '@tcms/db';

/** Höchste laufende Nummer hinter dem Präfix (nur Ziffern; andere Formen zählen nicht). */
async function hoechsteEreignisnummer(tx: Tx, programmId: string, praefix: string) {
  const muster = `${praefix}%`;
  const zeilen = await tx.$queryRaw<{ max: number | null }[]>`
    SELECT max(substring(nummer from ${praefix.length + 1}::int)::int) AS max
    FROM "Ereignis"
    WHERE "programmId" = ${programmId} AND nummer LIKE ${muster}
      AND substring(nummer from ${praefix.length + 1}::int) ~ '^[0-9]{1,9}$'`;
  return Number(zeilen[0]?.max ?? 0);
}

async function hoechsteFeststellungsnummer(tx: Tx, programmId: string, praefix: string) {
  const muster = `${praefix}%`;
  const zeilen = await tx.$queryRaw<{ max: number | null }[]>`
    SELECT max(substring(nummer from ${praefix.length + 1}::int)::int) AS max
    FROM "Feststellung"
    WHERE "programmId" = ${programmId} AND nummer LIKE ${muster}
      AND substring(nummer from ${praefix.length + 1}::int) ~ '^[0-9]{1,9}$'`;
  return Number(zeilen[0]?.max ?? 0);
}

/**
 * `<Jahr>-T-<nnnn>`, je Programm eindeutig (max + 1). Mehrere Nummern am Stück
 * über `anzahl`; bei `anzahl` 0 keine Sperre. Der Aufrufer hält die
 * Programmzeile (mindestens `FOR KEY SHARE`), bevor er die Nummer zieht.
 */
export async function naechsteEreignisnummern(
  tx: Tx,
  programmId: string,
  jahr: number,
  anzahl: number,
): Promise<string[]> {
  if (anzahl <= 0) return [];
  await tenantSperre(tx, `nummer.ereignis|${programmId}`);
  const praefix = `${jahr}-T-`;
  let max = await hoechsteEreignisnummer(tx, programmId, praefix);
  return Array.from({ length: anzahl }, () => `${praefix}${String(++max).padStart(4, '0')}`);
}

export async function naechsteEreignisnummer(
  tx: Tx,
  programmId: string,
  jahr: number,
): Promise<string> {
  return (await naechsteEreignisnummern(tx, programmId, jahr, 1))[0]!;
}

/** `F-<Jahr>-<nnn>`, eindeutig je Programm (max + 1 im Jahr; Sperre je Programm). */
export async function naechsteFeststellungsnummer(
  tx: Tx,
  programmId: string,
  jahr: number,
): Promise<string> {
  await tenantSperre(tx, `nummer.feststellung|${programmId}`);
  const praefix = `F-${jahr}-`;
  const max = await hoechsteFeststellungsnummer(tx, programmId, praefix);
  return `${praefix}${String(max + 1).padStart(3, '0')}`;
}

/** Wiedervorlage-Nummer kanzleiweit, also je Tenant (max + 1). */
export async function naechsteWiedervorlageNr(tx: Tx): Promise<number> {
  await tenantSperre(tx, 'nummer.wiedervorlage');
  const agg = await tx.massnahme.aggregate({ _max: { wiedervorlageNr: true } });
  return (agg._max.wiedervorlageNr ?? 0) + 1;
}
