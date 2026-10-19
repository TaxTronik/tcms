import { fmtDatum } from '@tcms/domain';

export type BeschreibungStatus =
  | 'ENTWURF'
  | 'KANZLEI_REVIEW'
  | 'BEIM_MANDANTEN'
  | 'FREIGEGEBEN'
  | 'ABGELOEST';

export const BESCHREIBUNG_STATUS_LABEL: Record<BeschreibungStatus, string> = {
  ENTWURF: 'Entwurf',
  KANZLEI_REVIEW: 'Kanzlei-Review',
  BEIM_MANDANTEN: 'Zur Mandantenfreigabe',
  FREIGEGEBEN: 'Freigegeben',
  ABGELOEST: 'abgelöst',
};

export const BESCHREIBUNG_STATUS_BADGE: Record<BeschreibungStatus, string> = {
  ENTWURF: 'badge-gray',
  KANZLEI_REVIEW: 'badge-purple',
  BEIM_MANDANTEN: 'badge-yellow',
  FREIGEGEBEN: 'badge-green',
  ABGELOEST: 'badge-gray',
};

export function BeschreibungStatusBadge({
  status,
  title,
}: {
  status: BeschreibungStatus;
  title?: string;
}) {
  return (
    <span className={BESCHREIBUNG_STATUS_BADGE[status]} title={title}>
      {BESCHREIBUNG_STATUS_LABEL[status]}
    </span>
  );
}

/** YYYY-MM-DD oder ISO-Zeitstempel als de-DE-Datum. */
export function fmtIso(s: string | null | undefined): string {
  if (!s) return '—';
  const d = new Date(s.length === 10 ? `${s}T00:00:00Z` : s);
  return Number.isNaN(d.getTime()) ? s : fmtDatum(d);
}
