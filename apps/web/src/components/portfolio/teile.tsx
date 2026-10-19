import Link from 'next/link';
import type { ReactNode } from 'react';
import { Icon, type IconName } from '@/components/icon';

/** KPI-Karte des Portfolios (Mockup S1): Chip, Zahl, Beschriftung; optional als Filterlink. */
export function KpiKarte({
  icon,
  ton,
  wert,
  label,
  href,
  title,
  minBreite = 190,
}: {
  icon: IconName;
  ton: 'brand' | 'red' | 'amber' | 'gray' | 'green';
  wert: number | string;
  label: string;
  href?: string;
  title?: string;
  minBreite?: number;
}) {
  const inhalt = (
    <div className="row">
      <span className={`kpi-chip chip-${ton}`}>
        <Icon name={icon} />
      </span>
      <div className="col" style={{ gap: 0 }}>
        <span className="text-2xl font-b text-primary">{wert}</span>
        <span className="text-xs text-muted">{label}</span>
      </div>
    </div>
  );
  return href ? (
    <Link
      href={href}
      className="card p-3 grow unstyled"
      style={{ minWidth: minBreite }}
      title={title}
    >
      {inhalt}
    </Link>
  ) : (
    <div className="card p-3 grow" style={{ minWidth: minBreite }} title={title}>
      {inhalt}
    </div>
  );
}

/**
 * Primäraktion „Tax-CMS einrichten" ohne Client-Logik: aufklappbare Auswahl
 * der Mandanten ohne Tax-CMS (natives <details>), Ziel ist S3.
 */
export function EinrichtenMenue({
  mandanten,
}: {
  mandanten: { id: string; name: string; darf: boolean; grund?: string }[];
}) {
  if (mandanten.length === 0) {
    return (
      <button
        type="button"
        className="btn-primary shrink0"
        disabled
        title="Alle Mandanten haben bereits ein Tax-CMS."
      >
        <Icon name="Plus" /> Tax-CMS einrichten
      </button>
    );
  }
  return (
    <details className="rel shrink0">
      <summary className="btn-primary" style={{ listStyle: 'none', cursor: 'pointer' }}>
        <Icon name="Plus" /> Tax-CMS einrichten <Icon name="ChevronDown" className="tx-icon-xs" />
      </summary>
      <div
        className="card"
        style={{
          position: 'absolute',
          right: 0,
          top: 'calc(100% + 6px)',
          zIndex: 20,
          minWidth: 320,
          overflow: 'hidden',
        }}
      >
        <div
          className="px-4 py-2 text-xs font-s text-secondary"
          style={{ borderBottom: '1px solid rgb(var(--border-default))' }}
        >
          Mandant wählen
        </div>
        {mandanten.map((m) =>
          m.darf ? (
            <Link
              key={m.id}
              href={`/staff/clients/${m.id}/tcms/setup`}
              className="list-row unstyled"
              style={{ alignItems: 'center' }}
            >
              <Icon name="Building2" className="tx-icon-xs text-muted" />
              <span className="text-sm grow">{m.name}</span>
              <Icon name="ChevronRight" className="tx-icon-xs text-muted" />
            </Link>
          ) : (
            <span
              key={m.id}
              className="list-row text-disabled"
              style={{ alignItems: 'center' }}
              title={m.grund}
            >
              <Icon name="Lock" className="tx-icon-xs" />
              <span className="text-sm grow">{m.name}</span>
            </span>
          ),
        )}
      </div>
    </details>
  );
}

/** Kompakte Zelle mit Zahl; 0 erscheint gedämpft. */
export function Zahl({ wert, children }: { wert: number; children?: ReactNode }) {
  return (
    <span className={wert === 0 ? 'text-muted' : 'text-primary font-m'}>
      {wert}
      {children}
    </span>
  );
}
