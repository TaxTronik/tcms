import type { ReactNode } from 'react';
import { prisma } from '@tcms/db';
import { AppShell } from '@/components/shell/app-shell';
import { brauchtPortal } from '@/server/sitzung';

export default async function PortalLayout({ children }: { children: ReactNode }) {
  const nutzer = await brauchtPortal();
  const mandant = await prisma.mandant.findUnique({ where: { id: nutzer.mandantId } });
  return (
    <AppShell
      nutzer={nutzer}
      titel={mandant?.name ?? 'Mandantenportal'}
      untertitel="Mandantenportal"
      gruppen={[
        {
          label: 'Zusammenarbeit',
          eintraege: [
            { href: '/portal/tcms', label: 'Tax-Compliance', icon: 'ShieldCheck', exakt: true },
            { href: '/portal/tcms/ereignis', label: 'Ereignis melden', icon: 'Bell' },
            {
              href: '/portal/tcms/freigaben',
              label: 'Freigaben & Kenntnisnahmen',
              icon: 'FileCheck',
            },
          ],
        },
      ]}
    >
      {children}
    </AppShell>
  );
}
