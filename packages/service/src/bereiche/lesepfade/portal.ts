// =============================================================================
// Portal-Startseite P1 (`GET /v1/mandanten/:mandantId/portal/uebersicht`):
// mandantenbezogene Sicht ohne Kanzlei-Interna. Nur Mandantenkontakte mit
// aktiver Rolle beim eigenen Mandanten (`kannLesen` im Kern); gesetzliche
// Vertretung und Tax-Compliance-Beauftragte sehen alle Mandantenaufgaben und
// Meldungen, Mitarbeitende nur, was ihnen zugewiesen ist (Durchführung,
// Vertretung, Gegenzeichnung) bzw. was sie selbst gemeldet haben (auch in
// Zählern und Monatsleiste). Welche Durchführung eine offene Aufgabe ist, wer
// sie sieht und ob sie „eigene“ ist, entscheidet dieselbe Funktion wie in der
// Aufgabenliste P2 (`portalAufgabe`, Bereich durchfuehrung).
// =============================================================================

import {
  DienstFehler,
  nichtBerechtigt,
  type Akteur,
  PortalUebersichtAntwortSchema,
  PortalUebersichtEingabeSchema,
  type PortalUebersichtAntwort,
  type PortalUebersichtEingabe,
} from '@tcms/contract';
import { isoDatum, MONATE, monatSchluessel } from '@tcms/domain';
import { ladeKontext, type KontrolleView, type TcmsKontext } from '../../kern/tcms-kontext';
import type { DienstKontext } from '../../kontext';
import {
  istGesetzlicherVertreter,
  kannPortalLesen,
  siehtPortalMeldung,
  type KontaktRolle,
  type KontrollZustaendigkeit,
} from '../../rechte';
import { ladeKontaktRollen } from '../../rollen';
import {
  AUFGABE_OFFEN,
  aufgabenRang,
  darfPortalLesen,
  portalAufgabe,
} from '../durchfuehrung/rechte';
import { alsJson, antwortNach, pruefeEingabe } from './hilfen';

/** Höchstzahl gemeldeter Ereignisse in der Übersicht (neueste zuerst). */
const MAX_MELDUNGEN = 20;

type MonatsSegment = NonNullable<PortalUebersichtAntwort['programm']>['monate'][number];
type Aufgabe = Omit<PortalUebersichtAntwort['aufgaben'][number], 'faelligAm'> & {
  faelligAm: Date;
};
type DurchfuehrungSicht = TcmsKontext['durchfuehrungen'][number];

/** Zuständigkeit der Durchführung (aus dem Kontrollstand des Kontexts). */
function zustaendigkeit(k: KontrolleView): KontrollZustaendigkeit {
  return {
    partei: k.partei,
    durchfuehrendId: k.durchfuehrendId,
    vertretungId: k.vertretungId,
    gegenzeichnerId: k.gegenzeichnerId,
    gegenzeichnungMandant: k.gegenzeichnungMandant,
  };
}

/**
 * Offene Mandantenaufgaben, die die Person sehen darf: dieselbe Regel wie die
 * Aufgabenliste P2 (`portalAufgabe` im Bereich durchfuehrung) – Sichtbarkeit,
 * Art und `eigene`; bestätigte Aufgaben erscheinen nicht mehr als Bestätigung.
 */
function portalAufgaben(ctx: TcmsKontext, a: Akteur, rollen: readonly KontaktRolle[]): Aufgabe[] {
  const kontrolle = new Map(ctx.kontrollen.map((k) => [k.id, k]));
  const liste: Aufgabe[] = [];
  for (const d of ctx.durchfuehrungen) {
    const k = kontrolle.get(d.kontrolleId);
    if (!k) continue;
    const aufgabe = portalAufgabe(a, ctx.mandant.id, rollen, zustaendigkeit(k), d, ctx.heute);
    if (!aufgabe) continue;
    liste.push({
      durchfuehrungId: d.id,
      code: d.code,
      titel: d.titel,
      periodeLabel: d.periodeLabel,
      faelligAm: d.faelligAm,
      anzeige: d.anzeige,
      status: d.status,
      nachweise: d.nachweise,
      mindestNachweise: d.mindestNachweise,
      nachweis: k.nachweis,
      ziel: k.ziel,
      ...aufgabe,
      zustaendigId: aufgabe.art === 'DURCHFUEHREN' ? k.durchfuehrendId : k.vertretungId,
    });
  }
  return liste.sort(
    (x, y) => aufgabenRang(x) - aufgabenRang(y) || x.faelligAm.getTime() - y.faelligAm.getTime(),
  );
}

/** Monate des Wirksamkeitszeitraums mit offenen (sichtbaren) Mandantenaufgaben je Periode. */
function zeitraumMonate(
  ctx: TcmsKontext,
  sichtbar: (d: DurchfuehrungSicht, k: KontrolleView) => boolean,
): MonatsSegment[] {
  const p = ctx.programm;
  if (!p?.wirksamAb || !p.wirksamBis) return [];
  const kontrolle = new Map(ctx.kontrollen.map((k) => [k.id, k]));
  const offenJe = new Map<string, number>();
  for (const d of ctx.durchfuehrungen) {
    const k = kontrolle.get(d.kontrolleId);
    if (k?.partei !== 'MANDANT' || !AUFGABE_OFFEN.has(d.anzeige)) continue;
    if (!sichtbar(d, k)) continue;
    const m = monatSchluessel(d.periodeBis);
    offenJe.set(m, (offenJe.get(m) ?? 0) + 1);
  }
  const jetzt = monatSchluessel(ctx.heute);
  const seg: MonatsSegment[] = [];
  for (
    let d = new Date(Date.UTC(p.wirksamAb.getUTCFullYear(), p.wirksamAb.getUTCMonth(), 1));
    d.getTime() <= p.wirksamBis.getTime();
    d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))
  ) {
    const m = monatSchluessel(d);
    const offen = offenJe.get(m) ?? 0;
    seg.push({
      label: (MONATE[d.getUTCMonth()] ?? '').slice(0, 3),
      zustand: m === jetzt ? 'now' : m < jetzt ? (offen ? 'offen' : 'done') : '',
      offen,
    });
  }
  return seg;
}

/** Portal-Startseite des eigenen Mandanten (nur Mandantenkontakte mit aktiver Rolle). */
export async function ladePortalUebersicht(
  ctx: DienstKontext,
  eingabe: PortalUebersichtEingabe,
): Promise<PortalUebersichtAntwort> {
  const e = pruefeEingabe(PortalUebersichtEingabeSchema, eingabe);
  const a = ctx.akteur;
  if (a.art !== 'MANDANT') {
    throw nichtBerechtigt('PARTEI', 'Die Portal-Übersicht ist Mandantenkontakten vorbehalten.');
  }
  // Leserecht (aktive Rolle beim eigenen Mandanten) prüft der Kern; sonst NICHT_GEFUNDEN.
  const k = await ladeKontext(ctx, { mandantId: e.mandantId });
  const rollen = await ladeKontaktRollen(ctx.tx, a);
  const lesen = kannPortalLesen(a, k.mandant.id, rollen);
  const gv = istGesetzlicherVertreter(a, k.mandant.id, rollen);

  const aufgaben = portalAufgaben(k, a, rollen);
  // Zähler der Monatsleiste mit derselben Sichtbarkeit wie die Aufgaben (P2).
  const sichtbar = (_d: DurchfuehrungSicht, x: KontrolleView) =>
    darfPortalLesen(a, k.mandant.id, rollen, zustaendigkeit(x));
  const kontakte = new Set(k.kontaktRollen.map((r) => r.kontaktId.toLowerCase()));
  const meldungen = k.ereignisse
    .filter(
      (x) =>
        (x.quelle === 'PORTAL' || (!!x.gemeldetVon && kontakte.has(x.gemeldetVon.toLowerCase()))) &&
        siehtPortalMeldung(a, k.mandant.id, rollen, x.gemeldetVon),
    )
    .slice(0, MAX_MELDUNGEN)
    .map((x) => ({
      id: x.id,
      nummer: x.nummer,
      typ: x.typ,
      titel: x.titel,
      status: x.status,
      gemeldetAm: x.gemeldetAm,
      gemeldetVon: x.gemeldetVon,
    }));
  const p = k.programm;
  const roh = {
    heute: isoDatum(k.heute),
    mandant: { id: k.mandant.id, name: k.mandant.name },
    rechte: { portalLesen: lesen, gesetzlicherVertreter: gv, melden: lesen },
    programm: p
      ? {
          aktivePhase: k.aktivePhase,
          wirksamAb: p.wirksamAb,
          wirksamBis: p.wirksamBis,
          zeitraum: k.zeitraum ? { monat: k.zeitraum.monat, monate: k.zeitraum.monate } : null,
          monate: zeitraumMonate(k, sichtbar),
        }
      : null,
    aufgaben: p ? aufgaben : [],
    meldungen: p ? meldungen : [],
  };
  return antwortNach(PortalUebersichtAntwortSchema, 'ladePortalUebersicht', alsJson(roh));
}
