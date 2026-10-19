import {
  ANZEIGE_BADGE,
  ANZEIGE_LABEL,
  GOVERNANCE_ERKLAERUNG,
  KLASSE_BADGE,
  KLASSE_LABEL,
  type AnzeigeStatus,
  type GovernanceTyp,
  type Klasse,
} from '@tcms/domain';
import { Icon } from '../icon';

export function KlasseBadge({
  klasse,
  title,
  uebersteuert,
}: {
  klasse: Klasse;
  title?: string;
  uebersteuert?: boolean;
}) {
  return (
    <span className={KLASSE_BADGE[klasse]} title={title}>
      {uebersteuert ? <Icon name="Pencil" className="tx-icon-xs" /> : null}
      {KLASSE_LABEL[klasse]}
    </span>
  );
}

export function StatusBadge({ status, title }: { status: AnzeigeStatus; title?: string }) {
  return (
    <span className={ANZEIGE_BADGE[status]} title={title}>
      {status === 'IN_DURCHFUEHRUNG' ? <Icon name="CircleDot" className="tx-icon-xs" /> : null}
      {ANZEIGE_LABEL[status]}
    </span>
  );
}

export function GtBadge({ gt }: { gt: GovernanceTyp | null }) {
  if (!gt) return <span className="text-muted">—</span>;
  return (
    <span className="badge-gray mono" title={GOVERNANCE_ERKLAERUNG[gt]}>
      {gt}
    </span>
  );
}

export function Hash({ wert }: { wert: string }) {
  return (
    <span className="mono" title={wert}>
      {wert.length > 8 ? `${wert.slice(0, 4)}…${wert.slice(-4)}` : wert}
    </span>
  );
}
