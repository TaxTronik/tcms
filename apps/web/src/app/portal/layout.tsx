import type { ReactNode } from 'react';
import { AppShell } from '@/components/shell/app-shell';
import { demoPersonen, liesDemo } from '@/server/demo';
import { brauchtPortal } from '@/server/sitzung';

export default async function PortalLayout({ children }: { children: ReactNode }) {
  const { akteur } = await brauchtPortal();
  const person = demoPersonen.person(akteur.id)!;
  const mandant = await liesDemo((tx) => tx.mandant.findFirst({ where: { id: akteur.mandantId } }));
  return (
    <AppShell
      nutzer={person}
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
