import type { ReactNode } from 'react';
import { fmtDatum } from '@tcms/domain';
import { abmelden } from '@/server/actions/sitzung';
import type { DemoPerson } from '@/server/demo';
import { heute, istDemo } from '@/server/zeit';
import { Icon } from '../icon';
import { ThemeToggle } from '../ui/client';
import { Sidebar, type NavGruppe } from './sidebar';

export function AppShell({
  nutzer,
  titel,
  untertitel,
  gruppen,
  children,
}: {
  nutzer: Pick<DemoPerson, 'name' | 'kuerzel' | 'funktion'>;
  titel: string;
  untertitel: string;
  gruppen: NavGruppe[];
  children: ReactNode;
}) {
  const fuss = (
    <>
      <form action={abmelden}>
        <button type="submit" className="side-action side-action-danger">
          <Icon name="LogOut" /> <span>Abmelden</span>
        </button>
      </form>
      <div className="mt-2 px-2 text-11 text-muted">
        Tax-CMS · Stufe 1 · Branchenpaket E-Commerce 1.0
      </div>
    </>
  );
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Zum Inhalt springen
      </a>
      <Sidebar titel={titel} untertitel={untertitel} gruppen={gruppen} fuss={fuss} />
      <main className="app-main" id="main-content">
        <div className="app-topbar">
          <div className="row grow">
            {istDemo() ? (
              <span className="demo-hinweis" title="TCMS_DEMO_TODAY ist gesetzt">
                Demo-Datum {fmtDatum(heute())}
              </span>
            ) : null}
          </div>
          <div className="row-s">
            <ThemeToggle />
            <span className="topbar-divider" aria-hidden="true" />
            <span className="row-s">
              <span className="avatar">{nutzer.kuerzel}</span>
              <span className="col" style={{ lineHeight: 1.2, gap: 0 }}>
                <span className="text-xs font-s text-primary">{nutzer.name}</span>
                <span className="text-11 text-muted">{nutzer.funktion ?? ''}</span>
              </span>
            </span>
          </div>
        </div>
        {children}
      </main>
    </div>
  );
}
