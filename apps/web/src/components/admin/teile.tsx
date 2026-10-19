import Link from 'next/link';
import type { ReactNode } from 'react';
import { Icon } from '@/components/icon';
import { Leerzustand } from '@/components/ui/leer';

/** Seitenrahmen der Administration mit Titel und Untertitel. */
export function AdminKopf({
  titel,
  unter,
  rechts,
}: {
  titel: string;
  unter: string;
  rechts?: ReactNode;
}) {
  return (
    <div className="row-between mb-4" style={{ flexWrap: 'wrap', gap: 12 }}>
      <div>
        <div className="eyebrow">Administration</div>
        <h1 className="page-title" style={{ marginBottom: 0 }}>
          {titel}
        </h1>
        <p className="text-sm text-muted mt-1">{unter}</p>
      </div>
      {rechts}
    </div>
  );
}

/** Hinweis für Personen ohne Admin-Recht (Rechte serverseitig, Seite bleibt erklärend). */
export function NurAdmin({ titel }: { titel: string }) {
  return (
    <div className="page">
      <AdminKopf titel={titel} unter="Admin-Bereich" />
      <div className="card">
        <Leerzustand
          icon="Lock"
          text="Admin-Bereich: Dieser Bereich ist Admins/Partnern vorbehalten."
        />
      </div>
    </div>
  );
}

/** Tab-Leiste als Links (Zustand im Query-Parameter, ohne Client-Logik). */
export function LinkTabs({
  tabs,
  aktiv,
  basis,
  param = 'tab',
}: {
  tabs: [string, string, number?][];
  aktiv: string;
  basis: string;
  param?: string;
}) {
  return (
    <nav className="tcms-tabs" aria-label="Bereiche" style={{ marginBottom: 16 }}>
      {tabs.map(([wert, label, anzahl]) => (
        <Link
          key={wert}
          href={`${basis}?${param}=${wert}`}
          className={`tab-pill${aktiv === wert ? ' active' : ''}`}
          aria-current={aktiv === wert ? 'page' : undefined}
        >
          {label}
          {anzahl != null ? (
            <span className="text-11" style={{ opacity: 0.7 }}>
              {anzahl}
            </span>
          ) : null}
        </Link>
      ))}
    </nav>
  );
}

/** Pagination für Tabellen (Links, 1-basiert). */
export function Seiten({
  seite,
  seiten,
  href,
}: {
  seite: number;
  seiten: number;
  href: (s: number) => string;
}) {
  if (seiten <= 1) return null;
  return (
    <span className="row-s">
      {seite > 1 ? (
        <Link
          href={href(seite - 1)}
          className="btn-secondary btn-tiny"
          aria-label="Vorherige Seite"
        >
          <Icon name="ArrowLeft" className="tx-icon-xs" /> zurück
        </Link>
      ) : (
        <button type="button" className="btn-secondary btn-tiny" disabled>
          <Icon name="ArrowLeft" className="tx-icon-xs" /> zurück
        </button>
      )}
      <span className="text-xs text-muted" style={{ padding: '0 8px' }}>
        Seite {seite} von {seiten}
      </span>
      {seite < seiten ? (
        <Link href={href(seite + 1)} className="btn-secondary btn-tiny" aria-label="Nächste Seite">
          weiter <Icon name="ChevronRight" className="tx-icon-xs" />
        </Link>
      ) : (
        <button type="button" className="btn-secondary btn-tiny" disabled>
          weiter <Icon name="ChevronRight" className="tx-icon-xs" />
        </button>
      )}
    </span>
  );
}
