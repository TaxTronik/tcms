// =============================================================================
// Abgleich gegen Datenbankfehler in Tests (gemeinsamer Helfer, tcms-s10).
//
// Prisma hängt an die Meldung eines Fehlers einen Codeausschnitt der
// aufrufenden Stelle an (die Zeilen vor dem Aufruf und den Aufruf selbst). Ein
// `rejects.toThrow(/Muster/)` besteht dann auch, wenn das Muster nur dort
// steht – in einem Kommentar, einer Testtabelle oder einer Meldung im
// Quelltext neben dem Aufruf –, während die Datenbank aus einem ganz anderen
// Grund abgewiesen hat (in der kanzleikonsole so gefunden: eine
// Trigger-Mutation blieb grün). Ebenso trifft ein allgemeines Muster
// (`/Unique constraint/`, `/check constraint/`, `/null value/`) jede andere
// Regel derselben Art: Fällt die geprüfte Regel weg, weist oft eine andere ab,
// und der Test bleibt grün.
//
// DB-Tests prüfen Datenbankfehler deshalb nur hierüber:
//
//   dbFehlerAus(e)              SQLSTATE und Meldung des Servers aus den
//                               strukturierten Feldern (Prisma mit adapter-pg:
//                               `meta.driverAdapterError.cause`; `pg`:
//                               `code`/`message`), nie aus der `message` eines
//                               Prisma-Fehlers
//   dbAbgewiesen(p, erwartet)   genau dieser SQLSTATE und genau diese Meldung
//                               des Servers (`regel.*` benennt die Regel: CHECK,
//                               eindeutiger Index und Fremdschlüssel mit Namen,
//                               RLS und Rechte mit Tabelle, Trigger mit Text)
//   abgewiesenOhneDb(p, m)      ein eigener Fehler des Codes (kein Prisma- und
//                               kein Datenbankfehler), Meldung genau bzw. Muster
//
// Ein anderer Fehler besteht nie: kein DienstFehler, kein TypeError, kein
// Prisma-Fehler ohne Datenbankursache. `fehlerabgleich.test.ts` verbietet neue
// ungeschützte Abgleiche (`toThrow(<Text>)` u. a.) in allen Tests.
// =============================================================================

/** Fehler der Datenbank, wie der Server ihn meldet (ohne Codeausschnitt). */
export interface DbFehler {
  /** SQLSTATE, z. B. `23514` (CHECK), `23505` (eindeutig), `42501` (Recht, RLS), `P0001` (Trigger). */
  readonly sqlstate: string;
  /** Meldung des Servers. */
  readonly meldung: string;
  /** Prisma-Fehlercode (`P2002`, `P2010` …); `null` bei `pg`. */
  readonly prisma: string | null;
}

/** Erwarteter Datenbankfehler. Text: Meldung genau gleich; Muster: nur gegen die Meldung des Servers. */
export interface DbErwartung {
  readonly sqlstate: string;
  readonly meldung: string | RegExp;
}

const SQLSTATE = /^[0-9A-Z]{5}$/;

const text = (x: unknown): string | null => (typeof x === 'string' ? x : null);
const objekt = (x: unknown): Record<string, unknown> | null =>
  x !== null && typeof x === 'object' ? (x as Record<string, unknown>) : null;

/** Ein Fehler des Prisma-Clients (bekannt, unbekannt, Validierung …). */
function istPrismaFehler(o: Record<string, unknown>): boolean {
  return typeof o['clientVersion'] === 'string';
}

/**
 * Datenbankfehler aus einem Fehler von Prisma (adapter-pg) oder `pg`, sonst
 * `null`. Liest nur strukturierte Felder; die `message` eines Prisma-Fehlers
 * (mit Codeausschnitt) bleibt ungelesen.
 */
export function dbFehlerAus(e: unknown): DbFehler | null {
  const o = objekt(e);
  if (!o) return null;
  if (istPrismaFehler(o)) {
    const ursache = objekt(objekt(objekt(o['meta'])?.['driverAdapterError'])?.['cause']);
    const sqlstate = text(ursache?.['originalCode']) ?? text(ursache?.['code']);
    const meldung = text(ursache?.['originalMessage']) ?? text(ursache?.['message']);
    if (sqlstate === null || !SQLSTATE.test(sqlstate) || meldung === null) return null;
    return { sqlstate, meldung, prisma: text(o['code']) };
  }
  // pg (DatabaseError): SQLSTATE in `code`, Schweregrad gesetzt; `message` ist
  // die Meldung des Servers.
  const sqlstate = text(o['code']);
  if (
    e instanceof Error &&
    sqlstate !== null &&
    SQLSTATE.test(sqlstate) &&
    typeof o['severity'] === 'string'
  ) {
    return { sqlstate, meldung: e.message, prisma: null };
  }
  return null;
}

/** Kurzbeschreibung eines unerwarteten Fehlers für die Testausgabe. */
function art(e: unknown): string {
  const o = objekt(e);
  if (!o) return typeof e;
  const name = e instanceof Error ? e.name : 'Objekt';
  const code = text(o['code']);
  return code ? `${name} (${code})` : name;
}

const passt = (ist: string, soll: string | RegExp) =>
  typeof soll === 'string' ? ist === soll : soll.test(ist);

/** Prüft einen bereits gefangenen Fehler gegen die Erwartung; wirft sonst. */
export function erwarteDbFehler(e: unknown, erwartet: DbErwartung, wo = ''): DbFehler {
  const vor = wo ? `${wo}: ` : '';
  const f = dbFehlerAus(e);
  if (!f) {
    throw new Error(`${vor}erwartet Datenbankfehler ${erwartet.sqlstate}, erhalten ${art(e)}`);
  }
  if (f.sqlstate !== erwartet.sqlstate || !passt(f.meldung, erwartet.meldung)) {
    throw new Error(
      `${vor}erwartet ${erwartet.sqlstate} ${String(erwartet.meldung)}, ` +
        `erhalten ${f.sqlstate} ${f.meldung}`,
    );
  }
  return f;
}

/** Erwartet, dass `aufruf` an genau dieser Regel der Datenbank scheitert. */
export async function dbAbgewiesen(
  aufruf: Promise<unknown>,
  erwartet: DbErwartung,
  wo = '',
): Promise<DbFehler> {
  try {
    await aufruf;
  } catch (e) {
    return erwarteDbFehler(e, erwartet, wo);
  }
  throw new Error(
    `${wo ? `${wo}: ` : ''}erwartet Abweisung durch die Datenbank (${erwartet.sqlstate} ` +
      `${String(erwartet.meldung)}), aber angenommen`,
  );
}

/**
 * Erwartet einen eigenen Fehler des Codes (kein Prisma- und kein
 * Datenbankfehler) mit genau dieser Meldung bzw. einer Meldung zum Muster.
 * Liefert den Fehler.
 */
export async function abgewiesenOhneDb(
  aufruf: Promise<unknown>,
  meldung: string | RegExp,
  wo = '',
): Promise<Error> {
  const vor = wo ? `${wo}: ` : '';
  try {
    await aufruf;
  } catch (e) {
    const o = objekt(e);
    if (!(e instanceof Error) || !o || istPrismaFehler(o) || dbFehlerAus(e) !== null) {
      throw new Error(`${vor}erwartet eigenen Fehler, erhalten ${art(e)}`);
    }
    if (!passt(e.message, meldung)) {
      throw new Error(`${vor}erwartet Meldung ${String(meldung)}, erhalten ${e.message}`);
    }
    return e;
  }
  throw new Error(`${vor}erwartet Fehler ${String(meldung)}, aber kein Fehler`);
}

/**
 * Erwartungen je Regelart, mit dem Wortlaut von PostgreSQL (lc_messages C/en).
 * Jede nennt die Regel selbst, damit eine andere Regel derselben Art nicht
 * besteht.
 */
export const regel = {
  /** CHECK-Constraint `name` der Tabelle. */
  check: (tabelle: string, name: string): DbErwartung => ({
    sqlstate: '23514',
    meldung: `new row for relation "${tabelle}" violates check constraint "${name}"`,
  }),
  /** Eindeutiger Index bzw. Schlüssel `name`. */
  eindeutig: (name: string): DbErwartung => ({
    sqlstate: '23505',
    meldung: `duplicate key value violates unique constraint "${name}"`,
  }),
  /** Fremdschlüssel `name` beim Schreiben in `tabelle`. */
  fremdschluessel: (tabelle: string, name: string): DbErwartung => ({
    sqlstate: '23503',
    meldung: `insert or update on table "${tabelle}" violates foreign key constraint "${name}"`,
  }),
  /** NOT NULL der Spalte. */
  nichtNull: (tabelle: string, spalte: string): DbErwartung => ({
    sqlstate: '23502',
    meldung: `null value in column "${spalte}" of relation "${tabelle}" violates not-null constraint`,
  }),
  /** RLS: neue Zeile verletzt die Policy (WITH CHECK bzw. USING bei RETURNING). */
  rls: (tabelle: string): DbErwartung => ({
    sqlstate: '42501',
    meldung: `new row violates row-level security policy for table "${tabelle}"`,
  }),
  /** Fehlendes Tabellenrecht der Rolle. */
  keinRecht: (tabelle: string): DbErwartung => ({
    sqlstate: '42501',
    meldung: `permission denied for table ${tabelle}`,
  }),
  /** Nur der Eigentümer darf das Objekt ändern. */
  nurEigentuemer: (art: 'table' | 'function', objektName: string): DbErwartung => ({
    sqlstate: '42501',
    meldung: `must be owner of ${art} ${objektName}`,
  }),
  /** `RAISE EXCEPTION` eines Triggers, genau dieser Text. */
  trigger: (meldung: string): DbErwartung => ({ sqlstate: 'P0001', meldung }),
  /** Wert passt nicht zum Typ (UUID, Enum …), genau diese Meldung. */
  eingabe: (meldung: string): DbErwartung => ({ sqlstate: '22P02', meldung }),
} as const;
