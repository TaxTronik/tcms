// =============================================================================
// Routentabelle des Dienstes und Mandantenbindung (ADR 0001, Abschnitte 3.3, 7).
//
// Die Tabelle arbeitet ausschließlich auf dem rohen, bereits als kanonisch
// geprüften Pfad (siehe `ziel.ts`). Muster bestehen aus festen Segmenten
// `[a-z0-9-]+` und Parametern `:name`; mehrdeutige Muster derselben Methode
// werden beim Start abgewiesen, damit keine Anfrage eine unerwartete Route
// trifft.
// =============================================================================

import { DienstFehler, type Akteur } from '@tcms/contract';
import type { z } from 'zod';

export const METHODEN = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type Methode = (typeof METHODEN)[number];

type Ausgabe<S> = S extends z.ZodType ? z.output<S> : undefined;

export interface RoutenKontext<Tx, B, Q> {
  /** Transaktion aus `Datenzugriff.mitTenant` (Tenant des Akteurs). */
  tx: Tx;
  akteur: Akteur;
  /** Pfadparameter, roh (der Pfad enthält keine Prozentkodierung). */
  params: Readonly<Record<string, string>>;
  body: B;
  query: Q;
  requestId: string;
  jetzt: Date;
}

export interface RoutenDefinition<
  Tx,
  SB extends z.ZodType | undefined = undefined,
  SQ extends z.ZodType | undefined = undefined,
> {
  methode: Methode;
  /** Muster unter `/v1/`, z. B. `/v1/mandanten/:mandantId/risiken`. */
  pfad: string;
  /** `MANDANT`-Personen zugelassen (Portal-Endpunkt, ADR §3.3). Standard: nein. */
  portal?: boolean;
  /** zod-Schema des JSON-Bodys; ohne Schema muss der Body leer sein. */
  body?: SB;
  /** zod-Schema der Query als Objekt; ohne Schema ist keine Query erlaubt. */
  query?: SQ;
  status?: 200 | 201;
  handler: (ctx: RoutenKontext<Tx, Ausgabe<SB>, Ausgabe<SQ>>) => Promise<unknown>;
}

export interface Routen<Tx> {
  route<SB extends z.ZodType | undefined = undefined, SQ extends z.ZodType | undefined = undefined>(
    def: RoutenDefinition<Tx, SB, SQ>,
  ): void;
}

/** Eingetragene Route; `akteur: false` gibt es nur für eingebaute Routen (Health). */
export interface RoutenEintrag<Tx> {
  methode: Methode;
  pfad: string;
  segmente: readonly string[];
  akteur: boolean;
  /** Handler eingebauter Routen ohne Akteur (kein Tenant, keine Eingaben). */
  ohneAkteur: (() => Promise<unknown>) | undefined;
  portal: boolean;
  /** Pfad unter `/v1/mandanten/:mandantId/…`: Bindung an `cli.id` erzwungen. */
  mandantGebunden: boolean;
  body: z.ZodType | undefined;
  query: z.ZodType | undefined;
  status: 200 | 201;
  handler: (ctx: RoutenKontext<Tx, unknown, unknown>) => Promise<unknown>;
}

export interface Treffer<Tx> {
  eintrag: RoutenEintrag<Tx>;
  params: Record<string, string>;
}

const SEGMENT_FEST = /^[a-z0-9-]+$/;
const SEGMENT_PARAM = /^:[a-zA-Z][a-zA-Z0-9]*$/;
export const MANDANT_PARAM = 'mandantId';

export class RoutenTabelle<Tx> {
  readonly #eintraege: RoutenEintrag<Tx>[] = [];
  #eingefroren = false;

  /** Trägt eine Route mit Akteursbestätigung ein; wirft bei ungültigem oder mehrdeutigem Muster. */
  eintragen(def: RoutenDefinition<Tx, z.ZodType | undefined, z.ZodType | undefined>) {
    const { segmente, mandantGebunden } = this.#pruefe(def.methode, def.pfad);
    this.#eintraege.push({
      methode: def.methode,
      pfad: def.pfad,
      segmente,
      akteur: true,
      ohneAkteur: undefined,
      portal: def.portal === true,
      mandantGebunden,
      body: def.body,
      query: def.query,
      status: def.status ?? 200,
      handler: def.handler as RoutenEintrag<Tx>['handler'],
    });
  }

  /** Nur für eingebaute Routen (Health): Dienst-Token genügt, keine Eingaben. */
  eintragenOhneAkteur(def: { methode: Methode; pfad: string; handler: () => Promise<unknown> }) {
    const { segmente, mandantGebunden } = this.#pruefe(def.methode, def.pfad);
    if (mandantGebunden) throw new Error('Routen: Mandantenpfade brauchen eine Akteursbestätigung');
    this.#eintraege.push({
      methode: def.methode,
      pfad: def.pfad,
      segmente,
      akteur: false,
      ohneAkteur: def.handler,
      portal: false,
      mandantGebunden: false,
      body: undefined,
      query: undefined,
      status: 200,
      handler: async () => {
        throw new Error('Routen: Route ohne Akteur hat keinen Akteur-Handler');
      },
    });
  }

  #pruefe(methode: Methode, pfad: string) {
    if (this.#eingefroren) throw new Error('Routen: Tabelle ist bereits eingefroren');
    if (!(METHODEN as readonly string[]).includes(methode)) {
      throw new Error(`Routen: Methode ${String(methode)} nicht erlaubt`);
    }
    const segmente = zerlegeMuster(pfad);
    for (const vorhanden of this.#eintraege) {
      if (vorhanden.methode === methode && mehrdeutig(vorhanden.segmente, segmente)) {
        throw new Error(`Routen: ${methode} ${pfad} ist mehrdeutig zu ${vorhanden.pfad}`);
      }
    }
    return { segmente, mandantGebunden: segmente[1] === 'mandanten' && segmente.length > 2 };
  }

  /** Registrierungs-Schnittstelle für `AppDeps.routen` (immer mit Akteur). */
  registrar(): Routen<Tx> {
    return {
      route: (def) =>
        this.eintragen(def as RoutenDefinition<Tx, z.ZodType | undefined, z.ZodType | undefined>),
    };
  }

  einfrieren() {
    this.#eingefroren = true;
  }

  /** Alle Routen, deren Muster auf die Segmente passt (jede Methode). */
  suche(segmente: readonly string[]): Treffer<Tx>[] {
    const treffer: Treffer<Tx>[] = [];
    for (const eintrag of this.#eintraege) {
      if (eintrag.segmente.length !== segmente.length) continue;
      const params: Record<string, string> = Object.create(null);
      let passt = true;
      for (let i = 0; i < segmente.length && passt; i++) {
        const muster = eintrag.segmente[i]!;
        const wert = segmente[i]!;
        if (muster.startsWith(':')) params[muster.slice(1)] = wert;
        else passt = muster === wert;
      }
      if (passt) treffer.push({ eintrag, params });
    }
    return treffer;
  }
}

function zerlegeMuster(pfad: string): string[] {
  if (typeof pfad !== 'string' || !pfad.startsWith('/v1/')) {
    throw new Error(`Routen: Muster ${String(pfad)} muss mit /v1/ beginnen`);
  }
  const segmente = pfad.slice(1).split('/');
  const namen = new Set<string>();
  for (const [i, s] of segmente.entries()) {
    if (SEGMENT_PARAM.test(s)) {
      const name = s.slice(1);
      if (namen.has(name)) throw new Error(`Routen: Parameter ${name} doppelt in ${pfad}`);
      namen.add(name);
      // `:mandantId` nur an der Stelle, an der die Bindung greift.
      if (name === MANDANT_PARAM && !(i === 2 && segmente[1] === 'mandanten')) {
        throw new Error(`Routen: :${MANDANT_PARAM} nur als /v1/mandanten/:${MANDANT_PARAM}/…`);
      }
    } else if (!SEGMENT_FEST.test(s)) {
      throw new Error(`Routen: ungültiges Segment in ${pfad}`);
    }
  }
  if (segmente[1] === 'mandanten' && segmente.length > 2 && segmente[2] !== `:${MANDANT_PARAM}`) {
    throw new Error(`Routen: unter /v1/mandanten/ muss :${MANDANT_PARAM} folgen (${pfad})`);
  }
  return segmente;
}

function mehrdeutig(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((s, i) => s === b[i] || s.startsWith(':') || b[i]!.startsWith(':'));
}

/**
 * Mandantenbindung (ADR §3.3). Wirft `404 NICHT_GEFUNDEN` (nicht 403, damit
 * keine Existenz verraten wird), wenn
 * - eine `MANDANT`-Person eine Route ohne Portal-Kennzeichen aufruft oder
 * - der Pfad an einen Mandanten gebunden ist und `cli.id` fehlt oder abweicht.
 * Vergleich byte-genau, ohne Umwandlung der Schreibweise.
 */
export function bindeMandant(akteur: Akteur, mandantId: string | null, portal: boolean): void {
  if (akteur.art === 'MANDANT' && !portal) throw new DienstFehler('NICHT_GEFUNDEN');
  if (mandantId === null) return;
  const bestaetigt = akteur.art === 'KANZLEI' ? akteur.mandant?.id : akteur.mandantId;
  if (bestaetigt === undefined || bestaetigt !== mandantId) {
    throw new DienstFehler('NICHT_GEFUNDEN');
  }
}
