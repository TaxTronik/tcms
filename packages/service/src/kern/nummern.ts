// =============================================================================
// Nummernkreise je Kanzlei (Tenant, ADR 0001 §4), bisher
// apps/web/src/server/nummern.ts. Alle Vergaben laufen in der Transaktion der
// jeweiligen Operation (`ctx.tx` bzw. `tx` aus `mitAudit`) und serialisieren
// sich über einen Advisory-Lock je Tenant und Nummernkreis (TS-08: kein
// globaler Lock). Das Maximum rechnet die Datenbank (keine Liste aller
// Nummern); laufende Nummern, die keine reine Ziffernfolge sind, zählen
// nicht. Unter RLS sieht max + 1 nur die Nummern des eigenen Tenants;
// die eindeutigen Schlüssel (tenant_id, nummer) bzw. (tenant_id,
// wiedervorlageNr) sichern ab.
// =============================================================================

import { tenantSperre, type Tx } from '@tcms/db';

/** `<Jahr>-T-<nnnn>`, je Kanzlei eindeutig (max + 1). Mehrere Nummern am Stück über `anzahl`. */
export async function naechsteEreignisnummern(
  tx: Tx,
  jahr: number,
  anzahl: number,
): Promise<string[]> {
  await tenantSperre(tx, 'nummer.ereignis');
  const praefix = `${jahr}-T-`;
  // Höchste laufende Nummer des Jahres in der Datenbank (nicht alle Nummern lesen).
  const [z] = await tx.$queryRaw<{ max: number | null }[]>`
    SELECT MAX(substr(nummer, ${praefix.length + 1}::int)::int) AS max
      FROM "Ereignis"
     WHERE starts_with(nummer, ${praefix})
       AND substr(nummer, ${praefix.length + 1}::int) ~ '^[0-9]{1,9}$'`;
  let max = z?.max ?? 0;
  return Array.from({ length: anzahl }, () => `${praefix}${String(++max).padStart(4, '0')}`);
}

export async function naechsteEreignisnummer(tx: Tx, jahr: number): Promise<string> {
  return (await naechsteEreignisnummern(tx, jahr, 1))[0]!;
}

/** `F-<Jahr>-<nnn>`, eindeutig je Programm (max + 1 im Jahr). */
export async function naechsteFeststellungsnummer(
  tx: Tx,
  programmId: string,
  jahr: number,
): Promise<string> {
  await tenantSperre(tx, 'nummer.feststellung');
  const praefix = `F-${jahr}-`;
  const [z] = await tx.$queryRaw<{ max: number | null }[]>`
    SELECT MAX(substr(nummer, ${praefix.length + 1}::int)::int) AS max
      FROM "Feststellung"
     WHERE "programmId" = ${programmId} AND starts_with(nummer, ${praefix})
       AND substr(nummer, ${praefix.length + 1}::int) ~ '^[0-9]{1,9}$'`;
  const max = z?.max ?? 0;
  return `${praefix}${String(max + 1).padStart(3, '0')}`;
}

/** Wiedervorlage-Nummer kanzleiweit, also je Tenant (max + 1). */
export async function naechsteWiedervorlageNr(tx: Tx): Promise<number> {
  await tenantSperre(tx, 'nummer.wiedervorlage');
  const agg = await tx.massnahme.aggregate({ _max: { wiedervorlageNr: true } });
  return (agg._max.wiedervorlageNr ?? 0) + 1;
}
