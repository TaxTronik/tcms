'use server';

import type { RisikoNeuBewerten, UebersteuerungBeantragen } from '@tcms/contract';
import { KLASSE_LABEL } from '@tcms/domain';
import {
  risikenFreigeben,
  risikenZurFreigabe,
  risikoakzeptanzAnfordern as dienstAkzeptanzAnfordern,
  risikoNeuBewerten as dienstNeuBewerten,
  risikoZurueckweisen,
  uebersteuerungBeantragen as dienstUebersteuerungBeantragen,
  uebersteuerungEntscheiden as dienstUebersteuerungEntscheiden,
} from '@tcms/service';
import { aktualisiereMandant } from '../aktion';
import type { Ergebnis } from '../ergebnis';
import { demoPersonen } from '../demo';
import { feld, fuehreAus, historisch } from '../risiken-kontrollen-aufruf';
import { NUR_AKTUELL } from '../seite';

// =============================================================================
// Server Actions Risikoinventar (S4) und Risikodetail (S5): dünne Hüllen um
// @tcms/service (Bereich risiken-kontrollen). Formular → Eingabe → Service im
// Dienstkontext der angemeldeten Person (`cli` = Mandant des Formulars) →
// Revalidierung. Bewertungen, Vier-Augen und Sperren prüft der Service.
// =============================================================================

const BEGRUENDUNG_30 = 'eine Begründung (mindestens 30 Zeichen)';

export async function risikoNeuBewerten(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  if (historisch(fd)) return { fehler: NUR_AKTUELL };
  const mandantId = feld(fd, 'mandantId');
  const r = await fuehreAus(
    mandantId,
    (ctx) =>
      dienstNeuBewerten(ctx, {
        mandantId,
        risikoId: feld(fd, 'id'),
        standId: feld(fd, 'standId'),
        // Werte prüft der Service (strenges Schema); hier nur Formular → Eingabe.
        s: feld(fd, 's') as RisikoNeuBewerten['s'],
        w: feld(fd, 'w') as RisikoNeuBewerten['w'],
        r: Number(feld(fd, 'r')) as RisikoNeuBewerten['r'],
        gt: feld(fd, 'gt') as RisikoNeuBewerten['gt'],
        begruendung: feld(fd, 'begruendung'),
      }),
    {
      ungueltig: `Bitte S, W, R, Governance-Typ und ${BEGRUENDUNG_30} angeben.`,
      nichtGefunden: 'Risiko nicht gefunden.',
    },
  );
  if ('fehler' in r) return r;
  aktualisiereMandant(mandantId);
  const e = r.wert;
  const code = e.code;
  const teile = [
    e.geaendert
      ? `${code} neu bewertet: Brutto ${KLASSE_LABEL[e.brutto.vorher]} → ${KLASSE_LABEL[e.brutto.nachher]}.${e.freigabe.vorher !== 'IDENTIFIZIERT' ? ' Die geänderte Bewertung braucht eine Freigabe durch eine zweite Person.' : ''}`
      : `${code}: Bewertung unverändert bestätigt.`,
  ];
  if (e.frequenzHinweise.length) teile.push(`Frequenz: ${e.frequenzHinweise.join('; ')}.`);
  for (const pl of e.neuplanungen)
    teile.push(
      `${pl.code} neu geplant (${pl.angelegt.length} angelegt, ${pl.entfernt.length} entfernt).`,
    );
  return { ok: teile.join(' ') };
}

export async function uebersteuerungBeantragen(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  if (historisch(fd)) return { fehler: NUR_AKTUELL };
  const mandantId = feld(fd, 'mandantId');
  const r = await fuehreAus(
    mandantId,
    (ctx) =>
      dienstUebersteuerungBeantragen(ctx, {
        mandantId,
        risikoId: feld(fd, 'id'),
        sicht: feld(fd, 'sicht') as UebersteuerungBeantragen['sicht'],
        klasse: feld(fd, 'klasse') as UebersteuerungBeantragen['klasse'],
        begruendung: feld(fd, 'begruendung'),
      }),
    {
      ungueltig: `Bitte Sicht, Zielklasse und ${BEGRUENDUNG_30} angeben.`,
      nichtGefunden: 'Risiko nicht gefunden.',
    },
  );
  if ('fehler' in r) return r;
  aktualisiereMandant(mandantId);
  const u = r.wert;
  return {
    ok: `Übersteuerung beantragt (${u.sicht === 'DESIGN' ? 'Netto Design' : 'Netto Betrieb'}: ${KLASSE_LABEL[u.berechnet]} → ${KLASSE_LABEL[u.klasse]}). Gilt erst nach Freigabe durch eine zweite Person.`,
  };
}

export async function uebersteuerungEntscheiden(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  if (historisch(fd)) return { fehler: NUR_AKTUELL };
  const mandantId = feld(fd, 'mandantId');
  const entscheidung = feld(fd, 'entscheidung') === 'freigeben' ? 'FREIGEBEN' : 'ABLEHNEN';
  const begruendung = feld(fd, 'begruendung').trim();
  const r = await fuehreAus(
    mandantId,
    (ctx) =>
      dienstUebersteuerungEntscheiden(ctx, {
        mandantId,
        uebersteuerungId: feld(fd, 'id'),
        entscheidung,
        ...(begruendung ? { begruendung } : {}),
      }),
    {
      ungueltig: `Die Ablehnung braucht ${BEGRUENDUNG_30}.`,
      nichtGefunden: 'Übersteuerung nicht gefunden.',
    },
  );
  if ('fehler' in r) return r;
  aktualisiereMandant(mandantId);
  return {
    ok:
      r.wert.status === 'FREIGEGEBEN'
        ? 'Übersteuerung freigegeben. Der berechnete Wert bleibt sichtbar.'
        : 'Übersteuerung abgelehnt.',
  };
}

/** Inventarfreigabe: „einreichen" bzw. „freigeben" für die ausgewählten Risiken. */
export async function risikenFreigabeSchritt(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  if (historisch(fd)) return { fehler: NUR_AKTUELL };
  const mandantId = feld(fd, 'mandantId');
  const risikoIds = [
    ...new Set(fd.getAll('ids').filter((x): x is string => typeof x === 'string' && x.length > 0)),
  ];
  if (risikoIds.length === 0) return { fehler: 'Bitte mindestens ein Risiko auswählen.' };
  const aktion = feld(fd, 'aktion');
  if (aktion !== 'einreichen' && aktion !== 'freigeben') return { fehler: 'Unbekannter Schritt.' };
  const r = await fuehreAus(
    mandantId,
    (ctx) =>
      aktion === 'einreichen'
        ? risikenZurFreigabe(ctx, { mandantId, risikoIds })
        : risikenFreigeben(ctx, { mandantId, risikoIds }),
    { ungueltig: 'Bitte die Auswahl prüfen.', nichtGefunden: 'Risiko nicht gefunden.' },
  );
  if ('fehler' in r) return r;
  aktualisiereMandant(mandantId);
  const { bearbeitet, uebersprungen } = r.wert;
  const text = aktion === 'einreichen' ? 'zur Freigabe eingereicht' : 'freigegeben';
  return {
    ok: `${bearbeitet.length === 1 ? bearbeitet[0]!.code : `${bearbeitet.length} Risiken`} ${text}.${uebersprungen.length ? ` Übersprungen: ${uebersprungen.map((u) => `${u.code} (${u.grund})`).join(', ')}.` : ''}`,
  };
}

export async function risikoFreigabeZurueckweisen(
  _prev: Ergebnis,
  fd: FormData,
): Promise<Ergebnis> {
  if (historisch(fd)) return { fehler: NUR_AKTUELL };
  const mandantId = feld(fd, 'mandantId');
  const r = await fuehreAus(
    mandantId,
    (ctx) =>
      risikoZurueckweisen(ctx, {
        mandantId,
        risikoId: feld(fd, 'id'),
        begruendung: feld(fd, 'begruendung'),
      }),
    {
      ungueltig: `Die Zurückweisung braucht ${BEGRUENDUNG_30}.`,
      nichtGefunden: 'Risiko nicht gefunden.',
    },
  );
  if ('fehler' in r) return r;
  aktualisiereMandant(mandantId);
  return { ok: `${r.wert.code} zurückgewiesen – Status wieder „bewertet".` };
}

export async function risikoakzeptanzAnfordern(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  if (historisch(fd)) return { fehler: NUR_AKTUELL };
  const mandantId = feld(fd, 'mandantId');
  const empfaengerId = feld(fd, 'empfaengerId');
  const r = await fuehreAus(
    mandantId,
    (ctx) =>
      dienstAkzeptanzAnfordern(ctx, {
        mandantId,
        risikoId: feld(fd, 'id'),
        empfaengerId,
        begruendung: feld(fd, 'begruendung'),
      }),
    {
      ungueltig: `Bitte Empfänger:in und eine Erläuterung (mindestens 30 Zeichen) angeben.`,
      nichtGefunden: 'Risiko nicht gefunden.',
    },
  );
  if ('fehler' in r) return r;
  aktualisiereMandant(mandantId);
  const name = demoPersonen.person(empfaengerId)?.name ?? 'der gesetzlichen Vertretung';
  return { ok: `Risikoakzeptanz bei ${name} angefordert (Portal, Bestätigung per E-Mail-Code).` };
}
