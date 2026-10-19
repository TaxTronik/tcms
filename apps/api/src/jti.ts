// =============================================================================
// Einmaligkeit der Akteursbestätigung (ADR 0001, Abschnitte 3.2 und 4).
//
// Der Dienst trägt jede `jti` nach erfolgreicher Prüfung ein, bevor die Route
// läuft, und zwar außerhalb der Tenant-Transaktion: Auch eine Anfrage, deren
// Route später scheitert, verbraucht ihre `jti`. Die Prüfung ist atomar
// (`INSERT … ON CONFLICT DO NOTHING RETURNING`), damit zwei gleichzeitige
// Anfragen mit derselben `jti` nicht beide durchkommen.
// =============================================================================

import type pg from 'pg';
import type { Logger } from './log';

export interface JtiSpeicher {
  /** `true` genau dann, wenn diese `jti` zum ersten Mal eingetragen wurde. */
  einmalig(jti: string, exp: Date): Promise<boolean>;
}

function pruefeEingabe(jti: string, exp: Date) {
  if (typeof jti !== 'string' || jti.length === 0) throw new Error('jti: leer');
  if (!(exp instanceof Date) || !Number.isFinite(exp.getTime()))
    throw new Error('jti: exp ungültig');
}

/** Nur für Tests: In Produktion verweigert (der Speicher wäre je Prozess). */
export class SpeicherJti implements JtiSpeicher {
  readonly #eintraege = new Map<string, number>();

  constructor() {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('SpeicherJti ist nur für Tests bestimmt');
    }
  }

  // Ohne `await` zwischen Prüfen und Eintragen, daher im Event-Loop atomar.
  async einmalig(jti: string, exp: Date): Promise<boolean> {
    pruefeEingabe(jti, exp);
    if (this.#eintraege.has(jti)) return false;
    this.#eintraege.set(jti, exp.getTime());
    return true;
  }

  async aufraeumen(jetzt: Date = new Date()): Promise<number> {
    let n = 0;
    for (const [jti, exp] of this.#eintraege) {
      if (exp < jetzt.getTime()) {
        this.#eintraege.delete(jti);
        n++;
      }
    }
    return n;
  }
}

/** Karenz vor dem Löschen abgelaufener jti (Uhrabweichung Dienst/Datenbank), in Sekunden. */
export const JTI_KARENZ_S = 300;

/**
 * Tabelle `akteur_jti (jti text PRIMARY KEY, exp timestamptz NOT NULL)` aus
 * dem Schema von `packages/db` (nicht mandantengebunden, ohne RLS; die
 * Laufzeitrolle braucht INSERT, SELECT für RETURNING und DELETE).
 */
export class PgJti implements JtiSpeicher {
  readonly #pool: Pick<pg.Pool, 'query'>;
  readonly #stapel: number;
  readonly #maxStapelJeLauf: number;
  readonly #karenzS: number;

  constructor(
    pool: Pick<pg.Pool, 'query'>,
    opts: { stapel?: number; maxStapelJeLauf?: number; karenzS?: number } = {},
  ) {
    this.#pool = pool;
    this.#stapel = opts.stapel ?? 1000;
    this.#maxStapelJeLauf = opts.maxStapelJeLauf ?? 100;
    this.#karenzS = opts.karenzS ?? JTI_KARENZ_S;
    if (!Number.isInteger(this.#karenzS) || this.#karenzS < 0) {
      throw new Error('PgJti: Karenz muss eine nicht negative ganze Zahl sein');
    }
  }

  async einmalig(jti: string, exp: Date): Promise<boolean> {
    pruefeEingabe(jti, exp);
    const r = await this.#pool.query(
      'INSERT INTO akteur_jti (jti, exp) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING jti',
      [jti, exp],
    );
    return r.rowCount === 1;
  }

  /**
   * Löscht abgelaufene Einträge in Stapeln (kurze Sperren, begrenzte Arbeit je
   * Lauf), aber erst nach einer Karenz: `exp` ist Dienstzeit, `now()` die Uhr
   * der Datenbank. Geht die Datenbank vor, würde eine `jti` sonst gelöscht,
   * während der Dienst die Bestätigung noch annimmt – ein Fenster für
   * Wiederholungen in Höhe der Uhrabweichung. Ein abgelaufener, noch nicht
   * gelöschter Eintrag weist dieselbe `jti` weiter ab (fail closed). Ohne
   * `FOR UPDATE`: Das bräuchte das UPDATE-Recht, das die Laufzeitrolle auf
   * `akteur_jti` nicht hat; parallele Läufe löschen schlimmstenfalls dieselben
   * Zeilen (dann 0 Zeilen).
   */
  async aufraeumen(): Promise<number> {
    let gesamt = 0;
    for (let i = 0; i < this.#maxStapelJeLauf; i++) {
      const r = await this.#pool.query(
        `DELETE FROM akteur_jti WHERE jti IN (
           SELECT jti FROM akteur_jti WHERE exp < now() - make_interval(secs => $2) LIMIT $1
         )`,
        [this.#stapel, this.#karenzS],
      );
      gesamt += r.rowCount ?? 0;
      if ((r.rowCount ?? 0) < this.#stapel) break;
    }
    return gesamt;
  }
}

/**
 * Räumt in einem Intervall mit Streuung auf (Basis plus bis zu 50 %), damit
 * mehrere Instanzen nicht im Gleichtakt löschen. Liefert eine Stopp-Funktion.
 */
export function starteJtiAufraeumen(
  speicher: { aufraeumen(): Promise<number> },
  opts: { log: Logger; intervallMs?: number; zufall?: () => number },
): () => void {
  const basis = opts.intervallMs ?? 60_000;
  const zufall = opts.zufall ?? Math.random;
  let timer: NodeJS.Timeout | undefined;
  let gestoppt = false;
  const plane = () => {
    if (gestoppt) return;
    timer = setTimeout(lauf, basis + Math.floor(zufall() * basis * 0.5));
    timer.unref();
  };
  const lauf = async () => {
    try {
      const geloescht = await speicher.aufraeumen();
      if (geloescht > 0) opts.log.schreibe('info', 'jti_aufgeraeumt', { anzahl: geloescht });
    } catch (e) {
      opts.log.schreibe('warn', 'jti_aufraeumen_fehlgeschlagen', {
        fehler: e instanceof Error ? e.name : 'unbekannt',
      });
    } finally {
      plane();
    }
  };
  plane();
  return () => {
    gestoppt = true;
    if (timer) clearTimeout(timer);
  };
}
