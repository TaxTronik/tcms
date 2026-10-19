// =============================================================================
// Portal-Startseite P1 (`GET /v1/mandanten/:mandantId/portal/uebersicht`):
// mandantenbezogene Sicht ohne Kanzlei-Interna. Nur Mandantenkontakte mit
// aktiver Rolle beim eigenen Mandanten (`kannLesen` im Kern); gesetzliche
// Vertretung und Tax-Compliance-Beauftragte sehen alle Mandantenaufgaben und
// Meldungen, Mitarbeitende nur, was ihnen zugewiesen ist bzw. was sie selbst
// gemeldet haben (auch in Zählern und Monatsleiste).
// =============================================================================

import {
  DienstFehler,
  nichtBerechtigt,
  PortalUebersichtAntwortSchema,
  PortalUebersichtEingabeSchema,
  type PortalUebersichtAntwort,
  type PortalUebersichtEingabe,
} from '@tcms/contract';
import { addTage, isoDatum, MONATE, monatSchluessel, type AnzeigeStatus } from '@tcms/domain';
import { ladeKontext, type TcmsKontext } from '../../kern/tcms-kontext';
import type { DienstKontext } from '../../kontext';
import { gleicheId, istGesetzlicherVertreter, kannPortalLesen } from '../../rechte';
import { ladeKontaktRollen } from '../../rollen';
import { alsJson, antwortNach, pruefeEingabe } from './hilfen';

const OFFEN = new Set<AnzeigeStatus>([
  'FAELLIG',
  'UEBERFAELLIG',
  'IN_DURCHFUEHRUNG',
  'ZURUECKGEWIESEN',
]);
/** Höchstzahl gemeldeter Ereignisse in der Übersicht (neueste zuerst). */
const MAX_MELDUNGEN = 20;

type MonatsSegment = NonNullable<PortalUebersichtAntwort['programm']>['monate'][number];
type Aufgabe = Omit<PortalUebersichtAntwort['aufgaben'][number], 'faelligAm'> & {
  faelligAm: Date;
};

/** Offene Mandantenaufgaben: Durchführungen der Partei Mandant und Bestätigungen durch eine zweite Person. */
function portalAufgaben(ctx: TcmsKontext, personId: string): Aufgabe[] {
  const kontrolle = new Map(ctx.kontrollen.map((k) => [k.id, k]));
  const horizont = addTage(ctx.heute, 30);
  const liste: Aufgabe[] = [];
  for (const d of ctx.durchfuehrungen) {
    const k = kontrolle.get(d.kontrolleId);
    if (!k || k.partei !== 'MANDANT') continue;
    const basis = {
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
    };
    const bald =
      d.anzeige === 'GEPLANT' &&
      d.faelligAm.getTime() <= horizont.getTime() &&
      d.periodeBis.getTime() < horizont.getTime();
    if (OFFEN.has(d.anzeige) || bald) {
      liste.push({
        ...basis,
        art: 'DURCHFUEHREN',
        eigene: gleicheId(personId, k.durchfuehrendId) || gleicheId(personId, k.vertretungId),
        zustaendigId: k.durchfuehrendId,
      });
    } else if (d.anzeige === 'ZUR_GEGENZEICHNUNG' && k.gegenzeichnungMandant) {
      liste.push({
        ...basis,
        art: 'BESTAETIGEN',
        eigene: gleicheId(personId, k.vertretungId) && !gleicheId(personId, d.durchgefuehrtVon),
        zustaendigId: k.vertretungId,
      });
    }
  }
  const prio = (a: Aufgabe) =>
    a.anzeige === 'UEBERFAELLIG'
      ? 0
      : a.anzeige === 'ZURUECKGEWIESEN'
        ? 1
        : a.art === 'BESTAETIGEN'
          ? 2
          : 3;
  return liste.sort((a, b) => prio(a) - prio(b) || a.faelligAm.getTime() - b.faelligAm.getTime());
}

/** Monate des Wirksamkeitszeitraums mit offenen (sichtbaren) Mandantenaufgaben je Periode. */
function zeitraumMonate(
  ctx: TcmsKontext,
  sichtbar: (d: TcmsKontext['durchfuehrungen'][number]) => boolean,
): MonatsSegment[] {
  const p = ctx.programm;
  if (!p?.wirksamAb || !p.wirksamBis) return [];
  const kontrolle = new Map(ctx.kontrollen.map((k) => [k.id, k]));
  const offenJe = new Map<string, number>();
  for (const d of ctx.durchfuehrungen) {
    if (kontrolle.get(d.kontrolleId)?.partei !== 'MANDANT' || !OFFEN.has(d.anzeige)) continue;
    if (!sichtbar(d)) continue;
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

  const alle = portalAufgaben(k, a.id);
  const aufgaben = lesen ? alle : alle.filter((x) => x.eigene);
  const kontrolle = new Map(k.kontrollen.map((x) => [x.id, x]));
  const eigeneDurchfuehrung = (d: TcmsKontext['durchfuehrungen'][number]) => {
    const x = kontrolle.get(d.kontrolleId);
    return !!x && (gleicheId(a.id, x.durchfuehrendId) || gleicheId(a.id, x.vertretungId));
  };
  const kontakte = new Set(k.kontaktRollen.map((r) => r.kontaktId.toLowerCase()));
  const meldungen = k.ereignisse
    .filter(
      (x) =>
        (x.quelle === 'PORTAL' || (!!x.gemeldetVon && kontakte.has(x.gemeldetVon.toLowerCase()))) &&
        (lesen || gleicheId(x.gemeldetVon, a.id)),
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
          monate: zeitraumMonate(k, lesen ? () => true : eigeneDurchfuehrung),
        }
      : null,
    aufgaben: p ? aufgaben : [],
    meldungen: p ? meldungen : [],
  };
  return antwortNach(PortalUebersichtAntwortSchema, 'ladePortalUebersicht', alsJson(roh));
}
