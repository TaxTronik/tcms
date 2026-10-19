import 'server-only';
import { addTage, isoDatum, MONATE, monatSchluessel } from '@tcms/domain';
import type { DurchfuehrungView, PersonKurz, TcmsKontext } from './kontext';

// =============================================================================
// Portal P1: mandantenbezogene Sicht ohne Kanzlei-Interna (keine Nettoklassen,
// keine §-153-Details, keine Feststellungen). Lesen dürfen gesetzliche
// Vertreter und Tax-Compliance-Beauftragte; Mitarbeitende sehen nur Eigenes.
// =============================================================================

export const PHASE_EINFACH: Record<number, string> = {
  1: 'Wir richten das Compliance-Programm für Ihren Onlinehandel gemeinsam ein.',
  2: 'Ihre Kanzlei analysiert die steuerlichen Risiken Ihres Onlinehandels.',
  3: 'Die Kontrollen werden geplant und die Zuständigkeiten festgelegt.',
  4: 'Die Beschreibung Ihres Compliance-Programms wird erstellt und Ihnen zur Freigabe vorgelegt.',
  5: 'Das Compliance-Programm ist zu einem Stichtag dokumentiert.',
  6: 'Die Kontrollen laufen; jeder Monat wird mit Nachweisen dokumentiert.',
  7: 'Das Programm läuft im Regelbetrieb und wird jährlich überprüft.',
};

export interface PortalAufgabe {
  d: DurchfuehrungView;
  art: 'DURCHFUEHREN' | 'BESTAETIGEN';
  eigene: boolean;
  zustaendig: string;
  nachweis: string;
  ziel: string;
}

const OFFEN = new Set(['FAELLIG', 'UEBERFAELLIG', 'IN_DURCHFUEHRUNG', 'ZURUECKGEWIESEN']);

/** Offene Mandantenaufgaben: Durchführungen der Partei Mandant und Bestätigungen durch eine zweite Person. */
export function portalAufgaben(ctx: TcmsKontext, nutzer: { id: string }): PortalAufgabe[] {
  const kontrolle = new Map(ctx.kontrollen.map((k) => [k.id, k]));
  const horizont = addTage(ctx.heute, 30);
  const liste: PortalAufgabe[] = [];
  for (const d of ctx.durchfuehrungen) {
    const k = kontrolle.get(d.kontrolleId);
    if (!k || k.partei !== 'MANDANT') continue;
    const bald =
      d.anzeige === 'GEPLANT' &&
      d.faelligAm.getTime() <= horizont.getTime() &&
      d.periodeBis.getTime() < horizont.getTime();
    if (OFFEN.has(d.anzeige) || bald) {
      const eigene = nutzer.id === k.durchfuehrendId || nutzer.id === k.vertretungId;
      liste.push({
        d,
        art: 'DURCHFUEHREN',
        eigene,
        zustaendig: ctx.personen.get(k.durchfuehrendId ?? '')?.name ?? '—',
        nachweis: k.nachweis,
        ziel: k.ziel,
      });
    } else if (d.anzeige === 'ZUR_GEGENZEICHNUNG' && k.gegenzeichnungMandant) {
      const eigene = nutzer.id === k.vertretungId && nutzer.id !== d.durchgefuehrtVon;
      liste.push({
        d,
        art: 'BESTAETIGEN',
        eigene,
        zustaendig: ctx.personen.get(k.vertretungId ?? '')?.name ?? '—',
        nachweis: k.nachweis,
        ziel: k.ziel,
      });
    }
  }
  const prio = (a: PortalAufgabe) =>
    a.d.anzeige === 'UEBERFAELLIG'
      ? 0
      : a.d.anzeige === 'ZURUECKGEWIESEN'
        ? 1
        : a.art === 'BESTAETIGEN'
          ? 2
          : 3;
  return liste.sort(
    (a, b) => prio(a) - prio(b) || a.d.faelligAm.getTime() - b.d.faelligAm.getTime(),
  );
}

export interface MonatsSegment {
  label: string;
  zustand: 'done' | 'now' | 'offen' | '';
  offen: number;
}

/** Monate des Wirksamkeitszeitraums mit offenen Mandantenaufgaben je Periode. */
export function zeitraumMonate(ctx: TcmsKontext): MonatsSegment[] {
  const p = ctx.programm;
  if (!p?.wirksamAb || !p.wirksamBis) return [];
  const kontrolle = new Map(ctx.kontrollen.map((k) => [k.id, k]));
  const offenJe = new Map<string, number>();
  for (const d of ctx.durchfuehrungen) {
    if (kontrolle.get(d.kontrolleId)?.partei !== 'MANDANT' || !OFFEN.has(d.anzeige)) continue;
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

/** Kanzleiteam des Mandanten (Berufsträger:in und Bearbeitung). */
export function kanzleiTeam(ctx: TcmsKontext): { person: PersonKurz; rolle: string }[] {
  const t: { person: PersonKurz; rolle: string }[] = [];
  const bt = ctx.personen.get(ctx.mandant.berufstraegerId);
  const hb = ctx.personen.get(ctx.mandant.bearbeitungId);
  if (bt) t.push({ person: bt, rolle: bt.funktion?.split(',')[0] ?? 'Berufsträger:in' });
  if (hb && hb.id !== bt?.id) t.push({ person: hb, rolle: hb.funktion ?? 'Bearbeitung' });
  return t;
}

export const heuteIso = (ctx: TcmsKontext) => isoDatum(ctx.heute);
