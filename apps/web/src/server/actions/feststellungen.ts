'use server';

import { FESTSTELLUNG_STATUS_LABEL, P153_LABEL, type FeststellungStatus } from '@tcms/domain';
import {
  aktualisiereWuerdigung as aktualisiereWuerdigungDienst,
  beantrageFeststellungVerwerfen,
  bestaetigeFeststellungVerwerfen,
  entscheideP153 as entscheideP153Dienst,
  erfasseFeststellung as erfasseFeststellungDienst,
  erledigeMassnahme as erledigeMassnahmeDienst,
  fuegeErklaerungHinzu as fuegeErklaerungHinzuDienst,
  legeMassnahmeAn as legeMassnahmeAnDienst,
  legeNachkontrolleAn as legeNachkontrolleAnDienst,
  lehneFeststellungVerwerfenAb,
  schalteFeststellungWeiter as schalteFeststellungWeiterDienst,
  setzeVertraulich as setzeVertraulichDienst,
} from '@tcms/service';
import { demoPerson } from '../demo';
import type { Ergebnis } from '../ergebnis';
import { dienstAktion, eingabe, feld, optional } from '../feststellungen-daten';
import { brauchtKanzleiFuer } from '../sitzung';

// =============================================================================
// Server Actions S10 – Feststellungen und Maßnahmen. Dünne Hüllen: Formular →
// Eingabe-Objekt → Fachoperation aus @tcms/service im Dienstkontext der
// angemeldeten Person (Bezug auf den Mandanten des Formulars, wie `cli`).
// Rechte, Vertraulichkeit, Status und Audit prüft ausschließlich der Service.
// =============================================================================

async function kanzlei(fd: FormData) {
  const mandantId = feld(fd, 'mandantId');
  return { mandantId, akteur: await brauchtKanzleiFuer(mandantId) };
}

export async function schalteFeststellungWeiter(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  const { mandantId, akteur } = await kanzlei(fd);
  return dienstAktion(
    akteur,
    mandantId,
    (ctx) =>
      schalteFeststellungWeiterDienst(
        ctx,
        eingabe({ mandantId, feststellungId: feld(fd, 'id'), von: feld(fd, 'von') }),
      ),
    (r) => `Status: ${FESTSTELLUNG_STATUS_LABEL[r.status as FeststellungStatus]}.`,
  );
}

export async function entscheideP153(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  const { mandantId, akteur } = await kanzlei(fd);
  if (!feld(fd, 'entscheidung')) return { fehler: 'Bitte eine der vier Optionen wählen.' };
  return dienstAktion(
    akteur,
    mandantId,
    (ctx) =>
      entscheideP153Dienst(
        ctx,
        eingabe({
          mandantId,
          feststellungId: feld(fd, 'id'),
          entscheidung: feld(fd, 'entscheidung'),
          begruendung: feld(fd, 'begruendung'),
          frist: optional(fd, 'frist'),
          bisher: optional(fd, 'bisher') ?? null,
        }),
      ),
    (r) =>
      `Entscheidung dokumentiert: ${P153_LABEL[r.entscheidung].replace(' bis …', '')}${r.wiedervorlageNr ? ` · Wiedervorlage #${r.wiedervorlageNr}` : ''}.`,
    {
      ungueltig: 'Bitte eine Option wählen und die Entscheidung begründen (mindestens 30 Zeichen).',
    },
  );
}

export async function aktualisiereWuerdigung(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  const { mandantId, akteur } = await kanzlei(fd);
  return dienstAktion(
    akteur,
    mandantId,
    (ctx) =>
      aktualisiereWuerdigungDienst(
        ctx,
        eingabe({
          mandantId,
          feststellungId: feld(fd, 'id'),
          schwere: feld(fd, 'schwere'),
          auswirkung: feld(fd, 'auswirkung'),
          ursache: optional(fd, 'ursache') ?? null,
        }),
      ),
    () => 'Würdigungsangaben gespeichert.',
  );
}

/** Betrag aus deutscher Schreibweise; leer → null, keine Zahl → undefined. */
function betrag(roh: string): number | null | undefined {
  const s = roh.trim();
  if (!s) return null;
  const zahl = Number(s.replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(zahl) ? zahl : undefined;
}

export async function fuegeErklaerungHinzu(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  const { mandantId, akteur } = await kanzlei(fd);
  const auswirkungEur = betrag(feld(fd, 'auswirkungEur'));
  if (auswirkungEur === undefined) return { fehler: 'Die geschätzte Auswirkung ist keine Zahl.' };
  return dienstAktion(
    akteur,
    mandantId,
    (ctx) =>
      fuegeErklaerungHinzuDienst(
        ctx,
        eingabe({
          mandantId,
          feststellungId: feld(fd, 'feststellungId'),
          steuerart: feld(fd, 'steuerart'),
          land: feld(fd, 'land'),
          zeitraum: feld(fd, 'zeitraum'),
          auswirkungEur,
        }),
      ),
    () => 'Betroffene Erklärung erfasst.',
    { ungueltig: 'Bitte Steuerart, Land und Zeitraum angeben.' },
  );
}

export async function legeMassnahmeAn(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  const { mandantId, akteur } = await kanzlei(fd);
  // Art der Person aus dem Demo-Verzeichnis (im Zielbild: kanzleikonsole).
  const person = demoPerson(feld(fd, 'verantwortlich'));
  if (!person) {
    return {
      fehler: 'Bitte Beschreibung (mindestens 5 Zeichen), Verantwortliche:n und Frist angeben.',
    };
  }
  return dienstAktion(
    akteur,
    mandantId,
    (ctx) =>
      legeMassnahmeAnDienst(
        ctx,
        eingabe({
          mandantId,
          feststellungId: feld(fd, 'feststellungId'),
          beschreibung: feld(fd, 'beschreibung'),
          verantwortlich: { id: person.id, art: person.art },
          frist: feld(fd, 'frist'),
        }),
      ),
    (r) => `Maßnahme angelegt · Wiedervorlage #${r.wiedervorlageNr}.`,
    {
      ungueltig: 'Bitte Beschreibung (mindestens 5 Zeichen), Verantwortliche:n und Frist angeben.',
    },
  );
}

export async function erledigeMassnahme(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  const { mandantId, akteur } = await kanzlei(fd);
  return dienstAktion(
    akteur,
    mandantId,
    (ctx) =>
      erledigeMassnahmeDienst(
        ctx,
        eingabe({ mandantId, massnahmeId: feld(fd, 'id'), nachweis: feld(fd, 'nachweis') }),
      ),
    (r) => `Maßnahme #${r.wiedervorlageNr} erledigt.`,
    {
      ungueltig: 'Bitte den Nachweis der Umsetzung beschreiben (mindestens 10 Zeichen).',
      nichtGefunden: 'Maßnahme nicht gefunden.',
    },
  );
}

export async function legeNachkontrolleAn(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  const { mandantId, akteur } = await kanzlei(fd);
  return dienstAktion(
    akteur,
    mandantId,
    (ctx) =>
      legeNachkontrolleAnDienst(
        ctx,
        eingabe({
          mandantId,
          feststellungId: feld(fd, 'feststellungId'),
          kontrolleId: feld(fd, 'kontrolleId'),
          faelligAm: feld(fd, 'faelligAm'),
        }),
      ),
    (r) => `Nachkontrolle ${r.kontrolleCode} angelegt und verknüpft.`,
    {
      ungueltig: 'Bitte Kontrolle und Fälligkeit wählen.',
      nichtGefunden: 'Die Kontrolle ist im Programm nicht aktiv.',
    },
  );
}

export async function beantrageVerwerfen(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  const { mandantId, akteur } = await kanzlei(fd);
  return dienstAktion(
    akteur,
    mandantId,
    (ctx) =>
      beantrageFeststellungVerwerfen(
        ctx,
        eingabe({
          mandantId,
          feststellungId: feld(fd, 'id'),
          begruendung: feld(fd, 'begruendung'),
        }),
      ),
    () => 'Verwerfen beantragt. Eine zweite Person muss bestätigen.',
    { ungueltig: 'Die Begründung muss mindestens 30 Zeichen lang sein.' },
  );
}

export async function bestaetigeVerwerfen(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  const { mandantId, akteur } = await kanzlei(fd);
  return dienstAktion(
    akteur,
    mandantId,
    (ctx) =>
      bestaetigeFeststellungVerwerfen(ctx, eingabe({ mandantId, feststellungId: feld(fd, 'id') })),
    () => 'Feststellung verworfen.',
  );
}

export async function lehneVerwerfenAb(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  const { mandantId, akteur } = await kanzlei(fd);
  return dienstAktion(
    akteur,
    mandantId,
    (ctx) =>
      lehneFeststellungVerwerfenAb(ctx, eingabe({ mandantId, feststellungId: feld(fd, 'id') })),
    (r) => (r.zurueckgezogen ? 'Antrag zurückgezogen.' : 'Antrag auf Verwerfen abgelehnt.'),
  );
}

export async function setzeVertraulich(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  const { mandantId, akteur } = await kanzlei(fd);
  const wert = feld(fd, 'wert');
  if (wert !== '0' && wert !== '1') return { fehler: 'Bitte die Eingaben prüfen.' };
  return dienstAktion(
    akteur,
    mandantId,
    (ctx) =>
      setzeVertraulichDienst(
        ctx,
        eingabe({ mandantId, feststellungId: feld(fd, 'id'), vertraulich: wert === '1' }),
      ),
    (r) =>
      !r.geaendert
        ? r.vertraulich
          ? 'Bereits vertraulich.'
          : 'Bereits nicht vertraulich.'
        : r.vertraulich
          ? 'Als vertraulich markiert – nur für Beteiligte sichtbar.'
          : 'Vertraulichkeit aufgehoben.',
  );
}

export async function erfasseFeststellung(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  const { mandantId, akteur } = await kanzlei(fd);
  const quelle = feld(fd, 'quelle');
  // Wie bisher: Die Durchführung zählt nur bei Quelle „Kontrolle".
  const durchfuehrungId = quelle === 'KONTROLLE' ? optional(fd, 'durchfuehrungId') : undefined;
  const risikoIds = fd
    .getAll('risiken')
    .filter((x): x is string => typeof x === 'string' && x !== '');
  return dienstAktion(
    akteur,
    mandantId,
    (ctx) =>
      erfasseFeststellungDienst(
        ctx,
        eingabe({
          mandantId,
          titel: feld(fd, 'titel'),
          sachverhalt: feld(fd, 'sachverhalt'),
          quelle,
          quelleText: feld(fd, 'quelleText'),
          durchfuehrungId,
          klasse: feld(fd, 'klasse'),
          schwere: feld(fd, 'schwere'),
          auswirkung: feld(fd, 'auswirkung'),
          risikoIds,
        }),
      ),
    (r) =>
      r.auswirkungHerabgestuft
        ? `Feststellung ${r.nummer} erfasst. Die steuerliche Auswirkung „nein“ stufen nur Berufsträger:innen ein; sie ist als „unklar“ zur Würdigung erfasst.`
        : `Feststellung ${r.nummer} erfasst.`,
    {
      ungueltig:
        'Bitte Titel (mind. 5 Zeichen), Sachverhalt (mind. 20 Zeichen), Quelle und Einstufung angeben.',
      nichtGefunden: 'Unbekanntes Risiko oder unbekannte Durchführung gewählt.',
    },
  );
}
