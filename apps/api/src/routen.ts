// =============================================================================
// Routentabelle des Dienstes und Mandantenbindung (ADR 0001, Abschnitte 3.3, 7).
//
// Die Tabelle arbeitet ausschließlich auf dem rohen, bereits als kanonisch
// geprüften Pfad (siehe `ziel.ts`). Muster bestehen aus festen Segmenten
// `[a-z0-9-]+` und Parametern `:name`; mehrdeutige Muster derselben Methode
// werden beim Start abgewiesen, damit keine Anfrage eine unerwartete Route
// trifft.
//
// Fachrouten entstehen aus dem Endpunktregister des Vertrags
// (`Routen.endpunkt`, `ENDPUNKTE` aus @tcms/contract): Methode, Muster,
// zugelassene Akteursarten, Schemas und Erfolgsstatus stehen nur dort, die
// Routen liefern nur den Handler. `pruefeGegenRegister` vergleicht beim Start die
// Tabelle mit dem Register (eine Quelle der Wahrheit).
// =============================================================================

import {
  DienstFehler,
  NUR_KANZLEI,
  pruefeAkteure,
  type Akteur,
  type AkteurArt,
  type Endpunkt,
} from '@tcms/contract';
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
  /**
   * Zugelassene Akteursarten (ADR §3.3); Standard: nur `KANZLEI`. Dieselben
   * Regeln wie im Endpunktregister (`pruefeAkteure`): `SYSTEM` nur allein und
   * nicht auf Mandantenpfaden.
   */
  akteure?: readonly AkteurArt[];
  /** zod-Schema des JSON-Bodys; ohne Schema muss der Body leer sein. */
  body?: SB;
  /** zod-Schema der Query als Objekt; ohne Schema ist keine Query erlaubt. */
  query?: SQ;
  /** zod-Schema der Pfadparameter (streng); ohne Schema werden sie nicht geprüft. */
  params?: z.ZodType;
  status?: 200 | 201;
  handler: (ctx: RoutenKontext<Tx, Ausgabe<SB>, Ausgabe<SQ>>) => Promise<unknown>;
}

type SchemaOderLeer<S> = S extends z.ZodType ? z.output<S> : undefined;

/** Handler eines Registereintrags: Body und Query typisiert, Ergebnis wie `antwortSchema`. */
export type EndpunktHandler<Tx, E extends Endpunkt> = (
  ctx: RoutenKontext<Tx, SchemaOderLeer<E['bodySchema']>, SchemaOderLeer<E['querySchema']>>,
) => Promise<z.input<E['antwortSchema']>>;

export interface Routen<Tx> {
  /** Fachroute aus dem Endpunktregister (der einzige Weg für Produktionsrouten). */
  endpunkt<E extends Endpunkt>(endpunkt: E, handler: EndpunktHandler<Tx, E>): void;
  /** Freie Route; nur für Tests. Der Dienst weist sie beim Start ab (`pruefeGegenRegister`). */
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
  /** Zugelassene Akteursarten; jede andere Art erhält 404 (`pruefeZugang`). Leer ohne Akteur. */
  akteure: readonly AkteurArt[];
  /** Pfad unter `/v1/mandanten/:mandantId/…`: Bindung an `cli.id` erzwungen. */
  mandantGebunden: boolean;
  body: z.ZodType | undefined;
  query: z.ZodType | undefined;
  params: z.ZodType | undefined;
  status: 200 | 201;
  /** Registereintrag, aus dem die Route entstand (`undefined` bei freien Routen). */
  endpunkt: Endpunkt | undefined;
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
  eintragen(
    def: RoutenDefinition<Tx, z.ZodType | undefined, z.ZodType | undefined>,
    endpunkt?: Endpunkt,
  ) {
    const { segmente, mandantGebunden } = this.#pruefe(def.methode, def.pfad);
    const akteure = pruefeAkteure(
      `${def.methode} ${def.pfad}`,
      def.pfad,
      true,
      def.akteure ?? NUR_KANZLEI,
    );
    this.#eintraege.push({
      methode: def.methode,
      pfad: def.pfad,
      segmente,
      akteur: true,
      ohneAkteur: undefined,
      akteure,
      mandantGebunden,
      body: def.body,
      query: def.query,
      params: def.params,
      status: def.status ?? 200,
      endpunkt,
      handler: def.handler as RoutenEintrag<Tx>['handler'],
    });
  }

  /** Route aus einem Registereintrag: alles außer dem Handler kommt aus dem Register. */
  eintragenAusRegister<E extends Endpunkt>(endpunkt: E, handler: EndpunktHandler<Tx, E>) {
    if (!endpunkt.akteur) throw new Error(`Routen: ${endpunkt.name} braucht eingebauten Handler`);
    this.eintragen(
      {
        methode: endpunkt.methode,
        pfad: endpunkt.pfad,
        akteure: endpunkt.akteure,
        body: endpunkt.bodySchema ?? undefined,
        query: endpunkt.querySchema ?? undefined,
        params: endpunkt.paramsSchema,
        status: endpunkt.erfolgStatus,
        handler: handler as RoutenDefinition<
          Tx,
          z.ZodType | undefined,
          z.ZodType | undefined
        >['handler'],
      },
      endpunkt,
    );
  }

  /** Nur für eingebaute Routen (Health): Dienst-Token genügt, keine Eingaben. */
  eintragenOhneAkteur(endpunkt: Endpunkt, handler: () => Promise<unknown>) {
    const { methode, pfad } = endpunkt;
    if (endpunkt.akteur || endpunkt.bodySchema || endpunkt.querySchema) {
      throw new Error(`Routen: ${endpunkt.name} ist keine Route ohne Akteur`);
    }
    const { segmente, mandantGebunden } = this.#pruefe(methode, pfad);
    if (mandantGebunden || segmente.some((s) => s.startsWith(':'))) {
      throw new Error('Routen: Routen ohne Akteur haben keine Parameter');
    }
    this.#eintraege.push({
      methode,
      pfad,
      segmente,
      akteur: false,
      ohneAkteur: handler,
      akteure: Object.freeze([]),
      mandantGebunden: false,
      body: undefined,
      query: undefined,
      params: undefined,
      status: 200,
      endpunkt,
      handler: async () => {
        throw new Error('Routen: Route ohne Akteur hat keinen Akteur-Handler');
      },
    });
  }

  /** Eingetragene Routen in Eintragsreihenfolge (Abgleich mit dem Register, Tests). */
  eintraege(): readonly RoutenEintrag<Tx>[] {
    return this.#eintraege;
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
      endpunkt: (e, handler) => this.eintragenAusRegister(e, handler),
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
 * Vergleicht die Routentabelle mit dem Endpunktregister: Jede Route stammt aus
 * genau einem Registereintrag und stimmt mit ihm überein (Methode, Muster,
 * Akteursarten, Akteur, Schemas, Status); jeder Registereintrag hat genau eine Route.
 * Wirft mit allen Abweichungen (nur Namen und Muster, keine Werte).
 */
export function pruefeGegenRegister<Tx>(
  eintraege: readonly RoutenEintrag<Tx>[],
  register: readonly Endpunkt[],
): void {
  const fehler: string[] = [];
  const namen = new Map<string, Endpunkt>();
  for (const e of register) {
    if (namen.has(e.name)) fehler.push(`Registereintrag ${e.name} doppelt`);
    namen.set(e.name, e);
  }
  const gesehen = new Map<string, number>();
  for (const r of eintraege) {
    const e = r.endpunkt;
    if (!e) {
      fehler.push(`Route ohne Registereintrag: ${r.methode} ${r.pfad}`);
      continue;
    }
    if (!namen.has(e.name)) {
      fehler.push(`Route ohne Registereintrag: ${r.methode} ${r.pfad} (${e.name})`);
      continue;
    }
    if (namen.get(e.name) !== e) {
      fehler.push(`Route ${r.methode} ${r.pfad} verweist auf fremden Eintrag ${e.name}`);
      continue;
    }
    gesehen.set(e.name, (gesehen.get(e.name) ?? 0) + 1);
    const gleich =
      r.methode === e.methode &&
      r.pfad === e.pfad &&
      gleicheArten(r.akteure, e.akteure) &&
      r.akteur === e.akteur &&
      r.mandantGebunden === e.mandantenbezogen &&
      r.status === e.erfolgStatus &&
      r.body === (e.bodySchema ?? undefined) &&
      r.query === (e.querySchema ?? undefined) &&
      r.params === (e.akteur ? e.paramsSchema : undefined);
    if (!gleich) fehler.push(`Route ${r.methode} ${r.pfad} weicht von ${e.name} ab`);
  }
  for (const e of register) {
    const n = gesehen.get(e.name) ?? 0;
    if (n !== 1) fehler.push(`Registereintrag ${e.name} hat ${n} Routen statt genau einer`);
  }
  if (fehler.length > 0) {
    throw new Error(`Routen weichen vom Endpunktregister ab:\n- ${fehler.join('\n- ')}`);
  }
}

/** Gleiche Akteursarten in gleicher Reihenfolge (Abgleich mit dem Register). */
function gleicheArten(a: readonly AkteurArt[], b: readonly AkteurArt[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/**
 * Akteursart und Mandantenbindung (ADR §3.3), vor jeder Auswertung der
 * Eingaben. Wirft `404 NICHT_GEFUNDEN` (nicht 403, damit keine Existenz
 * verraten wird), wenn
 * - die Art des Akteurs nicht zu den zugelassenen Arten der Route gehört
 *   (Mandantenkontakt auf Kanzlei-Route, Systemakteur auf einer Route für
 *   Personen, Person auf einer Systemroute) oder
 * - der Pfad an einen Mandanten gebunden ist und `cli.id` fehlt oder abweicht
 *   (ein Systemakteur hat nie einen Mandantenbezug).
 * Vergleich byte-genau, ohne Umwandlung der Schreibweise.
 */
export function pruefeZugang(
  akteur: Akteur,
  akteure: readonly AkteurArt[],
  mandantId: string | null,
): void {
  if (!akteure.includes(akteur.art)) throw new DienstFehler('NICHT_GEFUNDEN');
  if (mandantId === null) return;
  const bestaetigt =
    akteur.art === 'KANZLEI'
      ? akteur.mandant?.id
      : akteur.art === 'MANDANT'
        ? akteur.mandantId
        : undefined;
  if (bestaetigt === undefined || bestaetigt !== mandantId) {
    throw new DienstFehler('NICHT_GEFUNDEN');
  }
}
