'use server';

import type { AbweichungBeantragen, DesignBeurteilen } from '@tcms/contract';
import { frequenzLabel } from '@tcms/domain';
import {
  designBeurteilen as dienstDesignBeurteilen,
  frequenzAbweichungAufheben as dienstAbweichungAufheben,
  frequenzAbweichungBeantragen as dienstAbweichungBeantragen,
  frequenzAbweichungEntscheiden as dienstAbweichungEntscheiden,
  verantwortlicheAendern as dienstVerantwortlicheAendern,
} from '@tcms/service';
import { aktualisiereMandant } from '../aktion';
import type { Ergebnis } from '../ergebnis';
import { feld, fuehreAus, historisch } from '../risiken-kontrollen-aufruf';
import { NUR_AKTUELL } from '../seite';

// =============================================================================
// Server Actions Kontrollmatrix (S6): dünne Hüllen um @tcms/service (Bereich
// risiken-kontrollen). Jede Änderung beruht auf dem angezeigten Kontrollstand
// (`standId`); hat sich der Stand inzwischen geändert, meldet der Service
// einen Konflikt. Frequenzen berechnet und Vier-Augen prüft der Service.
// =============================================================================

const BEGRUENDUNG_30 = 'eine Begründung (mindestens 30 Zeichen)';
const NICHT_GEFUNDEN = 'Kontrolle nicht gefunden.';

function ja(fd: FormData, name: string): boolean {
  const v = feld(fd, name);
  return v === 'on' || v === 'true';
}

function neuGeplant(n: { angelegt: string[]; entfernt: string[] } | null): string {
  return n
    ? ` Künftige Durchführungen neu geplant (${n.angelegt.length} angelegt, ${n.entfernt.length} entfernt).`
    : '';
}

export async function designBeurteilen(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  if (historisch(fd)) return { fehler: NUR_AKTUELL };
  const mandantId = feld(fd, 'mandantId');
  const design = feld(fd, 'design') as DesignBeurteilen['design'];
  const r = await fuehreAus(
    mandantId,
    (ctx) =>
      dienstDesignBeurteilen(ctx, {
        mandantId,
        kontrolleId: feld(fd, 'id'),
        standId: feld(fd, 'standId'),
        design,
        begruendung: feld(fd, 'begruendung'),
      }),
    {
      ungueltig: `Bitte Ergebnis (angemessen oder Mangel) und ${BEGRUENDUNG_30} angeben.`,
      nichtGefunden: NICHT_GEFUNDEN,
    },
  );
  if ('fehler' in r) return r;
  aktualisiereMandant(mandantId);
  const code = feld(fd, 'code');
  return {
    ok:
      design === 'ANGEMESSEN'
        ? `Designbeurteilung erfasst: angemessen (${code}).`
        : `Designbeurteilung erfasst: Mangel (${code}). Netto (Design) der verknüpften Risiken ohne Abschlag dieser Kontrolle.`,
  };
}

export async function frequenzAbweichungBeantragen(
  _prev: Ergebnis,
  fd: FormData,
): Promise<Ergebnis> {
  if (historisch(fd)) return { fehler: NUR_AKTUELL };
  const mandantId = feld(fd, 'mandantId');
  const ziel = {
    turnus: feld(fd, 'turnus') as AbweichungBeantragen['turnus'],
    anlass: ja(fd, 'anlass'),
  };
  const r = await fuehreAus(
    mandantId,
    (ctx) =>
      dienstAbweichungBeantragen(ctx, {
        mandantId,
        kontrolleId: feld(fd, 'id'),
        standId: feld(fd, 'standId'),
        ...ziel,
        begruendung: feld(fd, 'begruendung'),
      }),
    { ungueltig: `Bitte Turnus und ${BEGRUENDUNG_30} angeben.`, nichtGefunden: NICHT_GEFUNDEN },
  );
  if ('fehler' in r) return r;
  aktualisiereMandant(mandantId);
  return {
    ok: `Frequenzabweichung beantragt (${frequenzLabel(r.wert.frequenz)} → ${frequenzLabel(ziel)}). Gilt erst nach Freigabe durch eine zweite Person.`,
  };
}

export async function frequenzAbweichungEntscheiden(
  _prev: Ergebnis,
  fd: FormData,
): Promise<Ergebnis> {
  if (historisch(fd)) return { fehler: NUR_AKTUELL };
  const mandantId = feld(fd, 'mandantId');
  const freigeben = feld(fd, 'entscheidung') === 'freigeben';
  const begruendung = feld(fd, 'begruendung').trim();
  const r = await fuehreAus(
    mandantId,
    (ctx) =>
      dienstAbweichungEntscheiden(ctx, {
        mandantId,
        kontrolleId: feld(fd, 'id'),
        standId: feld(fd, 'standId'),
        entscheidung: freigeben ? 'FREIGEBEN' : 'ABLEHNEN',
        ...(begruendung ? { begruendung } : {}),
      }),
    { ungueltig: `Die Ablehnung braucht ${BEGRUENDUNG_30}.`, nichtGefunden: NICHT_GEFUNDEN },
  );
  if ('fehler' in r) return r;
  aktualisiereMandant(mandantId);
  return {
    ok: freigeben
      ? `Frequenzabweichung freigegeben: ${frequenzLabel(r.wert.frequenz)}.${neuGeplant(r.wert.neuplanung)}`
      : 'Frequenzabweichung abgelehnt – es gilt die abgeleitete Frequenz.',
  };
}

/** Hebt eine freigegebene Abweichung auf; es gilt wieder die berechnete Frequenz. */
export async function frequenzAbweichungAufheben(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  if (historisch(fd)) return { fehler: NUR_AKTUELL };
  const mandantId = feld(fd, 'mandantId');
  const r = await fuehreAus(
    mandantId,
    (ctx) =>
      dienstAbweichungAufheben(ctx, {
        mandantId,
        kontrolleId: feld(fd, 'id'),
        standId: feld(fd, 'standId'),
        begruendung: feld(fd, 'begruendung'),
      }),
    { ungueltig: `Bitte ${BEGRUENDUNG_30} angeben.`, nichtGefunden: NICHT_GEFUNDEN },
  );
  if ('fehler' in r) return r;
  aktualisiereMandant(mandantId);
  return {
    ok: `Abweichung aufgehoben – es gilt die abgeleitete Frequenz.${neuGeplant(r.wert.neuplanung)}`,
  };
}

export async function verantwortlicheAendern(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  if (historisch(fd)) return { fehler: NUR_AKTUELL };
  const mandantId = feld(fd, 'mandantId');
  // Nur bei Kontrollen des Mandanten angeboten; der Service weist es sonst ab.
  const gegenzeichnungMandant = ja(fd, 'gegenzeichnungMandant');
  const r = await fuehreAus(
    mandantId,
    (ctx) =>
      dienstVerantwortlicheAendern(ctx, {
        mandantId,
        kontrolleId: feld(fd, 'id'),
        standId: feld(fd, 'standId'),
        // Gesehene Seite der Kontrolle; der Service prüft sie (Schema, Zeilensperre).
        partei: feld(fd, 'partei') as 'KANZLEI' | 'MANDANT',
        durchfuehrendId: feld(fd, 'durchfuehrendId'),
        vertretungId: feld(fd, 'vertretungId'),
        gegenzeichnerId: gegenzeichnungMandant ? null : feld(fd, 'gegenzeichnerId') || null,
        gegenzeichnungMandant,
      }),
    {
      ungueltig: 'Bitte durchführende Person und Vertretung wählen.',
      nichtGefunden: NICHT_GEFUNDEN,
    },
  );
  if ('fehler' in r) return r;
  aktualisiereMandant(mandantId);
  return { ok: `Zuständigkeiten für ${feld(fd, 'code')} geändert (neuer Stand).` };
}
