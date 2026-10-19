import 'server-only';
import type { KontrollDurchfuehrung } from '@tcms/contract';
import { isoDatum } from '@tcms/domain';
import { ladeKontrolle, ladeKontrollen } from '@tcms/service';
import type { TcmsKontext } from './kontext';
import { lies } from './risiken-kontrollen-aufruf';

// =============================================================================
// Zusatzdaten für die Kontrollmatrix (S6) aus @tcms/service (Bereich
// risiken-kontrollen): Stand-Historie, Audit-Spur, Antrag einer Abweichung und
// Feststellungen je Durchführung – stichtagsbezogen, im Dienstkontext der
// angemeldeten Person. Planung und Kontrollstände liegen im Service.
// =============================================================================

/** Antragsteller:in einer offenen Abweichung aus den Kontrollständen (Arbeitskorb). */
export { antragDerFrequenzAbweichung as antragDerAbweichung } from '@tcms/service';

export interface KontrolleStandView {
  id: string;
  version: number;
  gueltigAb: Date;
  gueltigBis: Date | null;
  erstelltVon: string | null;
  design: 'ANGEMESSEN' | 'NICHT_BEURTEILT' | 'MANGEL';
  designVon: string | null;
  designAm: Date | null;
  designBegruendung: string | null;
  durchfuehrendId: string | null;
  vertretungId: string | null;
  gegenzeichnerId: string | null;
  gegenzeichnungMandant: boolean;
  abweichung: {
    turnus: 'KEIN' | 'JAEHRLICH' | 'QUARTALSWEISE' | 'MONATLICH';
    anlass: boolean;
    begruendung: string | null;
    freigegebenVon: string | null;
  } | null;
  /** Kurzbeschreibung der Änderung gegenüber dem Vorgängerstand. */
  aenderungen: string[];
}

export interface AuditZeile {
  seq: number;
  at: Date;
  actorName: string;
  aktion: string;
  detail: Record<string, unknown>;
}

export interface KontrolleDetail {
  staende: KontrolleStandView[];
  audit: AuditZeile[];
  /** Antragsteller:in der (offenen oder freigegebenen) Frequenzabweichung. */
  abweichungBeantragtVon: string | null;
  abweichungBeantragtAm: Date | null;
}

/** Feststellung je Durchführung; vertrauliche für Nicht-Beteiligte ohne §-153-Kennzeichen (RT-01). */
export type FeststellungJeDurchfuehrung = Map<
  string,
  NonNullable<KontrollDurchfuehrung['feststellung']>
>;

export interface KontrollenZusatz {
  feststellungen: FeststellungJeDurchfuehrung;
  offeneAbweichungen: Map<string, { von: string | null; am: Date | null }>;
  detail: KontrolleDetail | null;
}

const datumOder = (iso: string | null) => (iso ? new Date(iso) : null);

/**
 * Feststellungen je Durchführung, Antragsteller:innen offener Abweichungen
 * und – für die ausgewählte Kontrolle – Stand-Historie und Audit-Spur. Ein
 * Service-Aufruf (eine Transaktion) für die ganze Seite.
 */
export async function ladeKontrollenZusatz(
  ctx: TcmsKontext,
  auswahlId: string | null,
): Promise<KontrollenZusatz> {
  const leer: KontrollenZusatz = {
    feststellungen: new Map(),
    offeneAbweichungen: new Map(),
    detail: null,
  };
  if (!ctx.programm) return leer;
  const mandantId = ctx.mandant.id;
  const stand = isoDatum(ctx.stand);
  const geladen = await lies(mandantId, async (c) => ({
    liste: await ladeKontrollen(c, { mandantId, stand }),
    detail: auswahlId ? await ladeKontrolle(c, { mandantId, kontrolleId: auswahlId, stand }) : null,
  }));
  if (!geladen) return leer;
  const { liste, detail } = geladen;
  const feststellungen: FeststellungJeDurchfuehrung = new Map();
  const offeneAbweichungen: KontrollenZusatz['offeneAbweichungen'] = new Map();
  for (const k of liste.kontrollen) {
    for (const d of [k.letzte, k.naechste]) {
      if (d?.feststellung) feststellungen.set(d.id, d.feststellung);
    }
    if (k.abweichung && !k.abweichung.freigegebenVon) {
      offeneAbweichungen.set(k.id, {
        von: k.abweichung.beantragtVon,
        am: datumOder(k.abweichung.beantragtAm),
      });
    }
  }
  for (const d of detail?.durchfuehrungen ?? []) {
    if (d.feststellung) feststellungen.set(d.id, d.feststellung);
  }
  return {
    feststellungen,
    offeneAbweichungen,
    detail: detail
      ? {
          staende: detail.staende.map((s) => ({
            ...s,
            gueltigAb: new Date(s.gueltigAb),
            gueltigBis: datumOder(s.gueltigBis),
            designAm: datumOder(s.designAm),
          })),
          audit: detail.audit.map((a) => ({
            seq: a.seq,
            at: new Date(a.at),
            actorName: (a.actorId && detail.namen[a.actorId]) || '—',
            aktion: a.aktion,
            detail: a.detail,
          })),
          abweichungBeantragtVon: detail.kontrolle.abweichung?.beantragtVon ?? null,
          abweichungBeantragtAm: datumOder(detail.kontrolle.abweichung?.beantragtAm ?? null),
        }
      : null,
  };
}
