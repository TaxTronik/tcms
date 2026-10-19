import 'server-only';
import type { Tx } from '@tcms/db';

// =============================================================================
// Nummernkreise. Alle Vergaben laufen in der Transaktion der jeweiligen Action
// und serialisieren sich über einen gemeinsamen Advisory-Lock je Nummernkreis.
// =============================================================================

const LOCK_EREIGNIS = 4_711_101;
const LOCK_FESTSTELLUNG = 4_711_102;
const LOCK_WIEDERVORLAGE = 4_711_103;

/** `<Jahr>-T-<nnnn>`, global eindeutig (max + 1). Mehrere Nummern am Stück über `anzahl`. */
export async function naechsteEreignisnummern(
  tx: Tx,
  jahr: number,
  anzahl: number,
): Promise<string[]> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LOCK_EREIGNIS})`;
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
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LOCK_FESTSTELLUNG})`;
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

/** Wiedervorlage-Nummer kanzleiweit (max + 1). */
export async function naechsteWiedervorlageNr(tx: Tx): Promise<number> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LOCK_WIEDERVORLAGE})`;
  const agg = await tx.massnahme.aggregate({ _max: { wiedervorlageNr: true } });
  return (agg._max.wiedervorlageNr ?? 0) + 1;
}
