// =============================================================================
// Einmaligkeit der Akteursbestätigung (ADR 0001, Abschnitte 3.2 und 4).
//
// Der Dienst trägt jede `jti` nach erfolgreicher Prüfung ein, bevor die Route
// läuft, und zwar außerhalb der Tenant-Transaktion: Auch eine Anfrage, deren
// Route später scheitert, verbraucht ihre `jti`. Die Prüfung muss atomar sein,
// damit zwei gleichzeitige Anfragen mit derselben `jti` nicht beide
// durchkommen.
// =============================================================================

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
