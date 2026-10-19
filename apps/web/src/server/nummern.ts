import 'server-only';
import { tenantSperre, type Tx } from '@tcms/db';

// =============================================================================
// Nummernkreise je Kanzlei (Tenant, ADR 0001 §4). Alle Vergaben laufen in der
// Transaktion der jeweiligen Action und serialisieren sich über einen
// Advisory-Lock je Tenant und Nummernkreis (TS-08: kein globaler Lock). Unter
// RLS sieht max + 1 nur die Nummern des eigenen Tenants; die eindeutigen
// Schlüssel (tenant_id, nummer) bzw. (tenant_id, wiedervorlageNr) sichern ab.
// =============================================================================

/** `<Jahr>-T-<nnnn>`, je Kanzlei eindeutig (max + 1). Mehrere Nummern am Stück über `anzahl`. */
export async function naechsteEreignisnummern(
  tx: Tx,
  jahr: number,
  anzahl: number,
): Promise<string[]> {
  await tenantSperre(tx, 'nummer.ereignis');
  const praefix = `${jahr}-T-`;
  const vorhandene = await tx.ereignis.findMany({
    where: { nummer: { startsWith: praefix } },
    select: { nummer: true },
  });
  let max = vorhandene.reduce(
    (m, e) => Math.max(m, Number.parseInt(e.nummer.slice(praefix.length), 10) || 0),
    0,
  );
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
  const vorhandene = await tx.feststellung.findMany({
    where: { programmId, nummer: { startsWith: praefix } },
    select: { nummer: true },
  });
  const max = vorhandene.reduce(
    (m, f) => Math.max(m, Number.parseInt(f.nummer.slice(praefix.length), 10) || 0),
    0,
  );
  return `${praefix}${String(max + 1).padStart(3, '0')}`;
}

/** Wiedervorlage-Nummer kanzleiweit, also je Tenant (max + 1). */
export async function naechsteWiedervorlageNr(tx: Tx): Promise<number> {
  await tenantSperre(tx, 'nummer.wiedervorlage');
  const agg = await tx.massnahme.aggregate({ _max: { wiedervorlageNr: true } });
  return (agg._max.wiedervorlageNr ?? 0) + 1;
}
