import type { ReactNode } from 'react';
import { prisma } from '@tcms/db';
import { AppShell } from '@/components/shell/app-shell';
import { brauchtKanzlei } from '@/server/sitzung';
import { heute } from '@/server/zeit';

export default async function StaffLayout({ children }: { children: ReactNode }) {
  const nutzer = await brauchtKanzlei();
  // Roter Punkt am Portfolio, wenn irgendwo eine Durchführung überfällig ist.
  const ueberfaellig = await prisma.durchfuehrung.count({
    where: {
      faelligAm: { lt: heute() },
      status: { in: ['GEPLANT', 'IN_DURCHFUEHRUNG', 'ZURUECKGEWIESEN'] },
    },
  });
  return (
    <AppShell
      nutzer={nutzer}
      titel="Kanzlei Dr. Roth"
      untertitel="Tax-CMS · Kanzlei"
      gruppen={[
        {
          label: 'Übersicht',
          eintraege: [
            {
              href: '/staff/tcms',
              label: 'Tax-CMS-Portfolio',
              icon: 'ShieldCheck',
              dot: ueberfaellig > 0 ? 'red' : null,
            },
            { href: '/staff/arbeitskorb', label: 'Arbeitskorb', icon: 'ListChecks' },
          ],
        },
        {
          label: 'Administration',
          eintraege: [
            { href: '/staff/admin/katalog', label: 'Tax-CMS-Katalog', icon: 'Library' },
            { href: '/staff/admin/audit', label: 'Audit-Log', icon: 'Shield' },
            { href: '/staff/admin/postausgang', label: 'Postausgang (Entwicklung)', icon: 'Mail' },
          ],
        },
      ]}
    >
      {children}
    </AppShell>
  );
}
