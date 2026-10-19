import {
  fmtDatum,
  fmtDatumKurz,
  FESTSTELLUNG_STATUS_LABEL,
  P153_LABEL,
  type FeststellungStatus,
  type Paragraph153Entscheidung,
} from '@tcms/domain';
import { FESTSTELLUNG_STATUS_BADGE } from '@/server/feststellungen-daten';
import { Icon } from '../icon';

export function FeststellungStatusBadge({ status }: { status: FeststellungStatus }) {
  return (
    <span className={FESTSTELLUNG_STATUS_BADGE[status]}>{FESTSTELLUNG_STATUS_LABEL[status]}</span>
  );
}

/** §-153-Status: offen rot, entschieden grün (mit Datum), ohne Pfad „—". */
export function P153Badge({
  erforderlich,
  entscheidung,
  am,
  frist,
}: {
  erforderlich: boolean;
  entscheidung: Paragraph153Entscheidung | null;
  am: Date | null;
  frist: Date | null;
}) {
  if (entscheidung && am) {
    const label = P153_LABEL[entscheidung].replace(' bis …', '');
    const text =
      entscheidung === 'WEITERE_KLAERUNG' && frist
        ? `Entschieden: weitere Klärung bis ${fmtDatumKurz(frist)}`
        : `Entschieden ${fmtDatum(am)}`;
    return (
      <span
        className="badge-green"
        title={`${label} · ${fmtDatum(am)}`}
        style={{ whiteSpace: 'normal' }}
      >
        {text}
      </span>
    );
  }
  if (erforderlich) return <span className="badge-red">Würdigung offen</span>;
  return <span className="text-sm text-muted">—</span>;
}

export function VertraulichBadge() {
  return (
    <span className="badge-gray" title="Nur für Beteiligte sichtbar">
      <Icon name="EyeOff" className="tx-icon-xs" /> vertraulich
    </span>
  );
}
