'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';

const TABS: [string, string][] = [
  ['', 'Übersicht'],
  ['/profil', 'Profil'],
  ['/risiken', 'Risiken'],
  ['/kontrollen', 'Kontrollen'],
  ['/kalender', 'Kalender'],
  ['/feststellungen', 'Feststellungen'],
  ['/ereignisse', 'Ereignisse'],
  ['/laender', 'Länder'],
  ['/kommunikation', 'Kommunikation'],
  ['/beschreibung', 'Beschreibung'],
  ['/pruefung', 'Prüfung'],
];

/** TCMS-Tab-Leiste (Konzept 2.3) mit Status-Punkten; behält den Stichtag. */
export function TcmsTabs({
  basis,
  dots,
}: {
  basis: string;
  dots: Record<string, { farbe: 'red' | 'amber'; titel: string } | undefined>;
}) {
  const pfad = usePathname();
  const params = useSearchParams();
  const stand = params.get('stand');
  const aktiv =
    TABS.filter(([s]) => s && (pfad === basis + s || pfad.startsWith(basis + s + '/'))).sort(
      (a, b) => b[0].length - a[0].length,
    )[0]?.[0] ??
    (pfad === basis
      ? ''
      : pfad.startsWith(basis + '/durchfuehrungen')
        ? '/kontrollen'
        : pfad.startsWith(basis + '/setup')
          ? '/profil'
          : '');
  return (
    <nav className="tcms-tabs" aria-label="Tax-CMS-Bereiche" style={{ overflowX: 'auto' }}>
      {TABS.map(([s, label]) => {
        const dot = dots[s];
        const href = `${basis}${s}${stand ? `?stand=${stand}` : ''}`;
        return (
          <Link
            key={s}
            href={href}
            className={`tab-pill${aktiv === s ? ' active' : ''}`}
            aria-current={aktiv === s ? 'page' : undefined}
          >
            {label}
            {dot ? <span className={`status-dot dot-${dot.farbe}`} title={dot.titel} /> : null}
          </Link>
        );
      })}
    </nav>
  );
}
