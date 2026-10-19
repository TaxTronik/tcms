'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { Icon, type IconName } from '../icon';

export interface NavEintrag {
  href: string;
  label: string;
  icon: IconName;
  dot?: 'red' | 'amber' | null;
  exakt?: boolean;
}

export interface NavGruppe {
  label: string;
  eintraege: NavEintrag[];
}

export function Sidebar({
  titel,
  untertitel,
  gruppen,
  fuss,
}: {
  titel: string;
  untertitel: string;
  gruppen: NavGruppe[];
  fuss: ReactNode;
}) {
  const pfad = usePathname();
  const alle = gruppen.flatMap((g) => g.eintraege);
  const aktiv =
    alle.find((e) => e.href === pfad)?.href ??
    alle
      .filter((e) => !e.exakt && pfad.startsWith(e.href + '/'))
      .sort((a, b) => b.href.length - a.href.length)[0]?.href;
  return (
    <aside className="app-sidebar" aria-label="Hauptmenü">
      <div className="logo-box">
        <span style={{ fontSize: 17, fontWeight: 700 }} className="text-primary truncate">
          {titel}
        </span>
        <span className="text-xs text-muted">{untertitel}</span>
      </div>
      <nav aria-label="Hauptnavigation">
        {gruppen.map((g) => (
          <div key={g.label}>
            <div className="nav-group-label">{g.label}</div>
            {g.eintraege.map((e) => (
              <Link
                key={e.href}
                href={e.href}
                className={`nav-item${aktiv === e.href ? ' active' : ''}`}
                aria-current={aktiv === e.href ? 'page' : undefined}
              >
                <Icon name={e.icon} />
                <span className="grow">{e.label}</span>
                {e.dot ? <span className={`status-dot dot-${e.dot}`} /> : null}
              </Link>
            ))}
          </div>
        ))}
      </nav>
      <div className="nav-footer">{fuss}</div>
    </aside>
  );
}
