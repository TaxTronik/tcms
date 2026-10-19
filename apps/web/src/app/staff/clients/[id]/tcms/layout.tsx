import Link from 'next/link';
import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { isoDatum } from '@tcms/domain';
import { Icon } from '@/components/icon';
import { TcmsTabs } from '@/components/tcms/tabs';
import { ladeKontext, personName } from '@/server/kontext';
import { kannLesen } from '@tcms/service';
import { brauchtKanzleiFuer } from '@/server/sitzung';
import { heute } from '@/server/zeit';

export default async function MandantTcmsLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  // Ohne Bezug zum Mandanten: 404 (keine Existenz, kein Name; ADR 0001 §3.3).
  const nutzer = await brauchtKanzleiFuer(id);
  if (!kannLesen(nutzer, id)) notFound();
  const ctx = await ladeKontext(id, isoDatum(heute()), false);
  if (!ctx) notFound();
  const ueberfaellig = ctx.durchfuehrungen.filter((d) => d.anzeige === 'UEBERFAELLIG').length;
  const neu = ctx.ereignisse.filter((e) => e.status === 'NEU').length;
  // Maskierte vertrauliche Feststellungen tragen keine Steuerwirkung (RT-01, Service).
  const p153 = ctx.feststellungen.filter((f) => !f.maskiert && f.p153Offen).length;
  const basis = `/staff/clients/${id}/tcms`;
  return (
    <div className="page">
      <div className="row-between mb-4" style={{ flexWrap: 'wrap' }}>
        <div className="col" style={{ gap: 2 }}>
          <div className="row" style={{ gap: 12 }}>
            <h1 className="page-title" style={{ marginBottom: 0 }}>
              {ctx.mandant.name}
            </h1>
            <span className="badge-green">Aktiv</span>
          </div>
          <div className="text-sm text-muted">
            {ctx.mandant.rechtsform}
            {ctx.mandant.datevNr ? ` · DATEV ${ctx.mandant.datevNr}` : ''}
          </div>
          <div className="text-xs text-muted">
            <span className="font-m text-secondary">Berufsträger:</span>{' '}
            {personName(ctx, ctx.mandant.berufstraegerId)} &nbsp;·&nbsp;
            <span className="font-m text-secondary">Bearbeitung:</span>{' '}
            {personName(ctx, ctx.mandant.bearbeitungId)}
          </div>
        </div>
        <Link className="btn-secondary text-xs" href="/staff/tcms">
          <Icon name="ArrowLeft" className="tx-icon-xs" /> Zum Tax-CMS-Portfolio
        </Link>
      </div>
      {ctx.programm && (ctx.programm.status === 'AKTIV' || ctx.programm.version1Am) ? (
        <TcmsTabs
          basis={basis}
          dots={{
            '/kontrollen': ueberfaellig
              ? { farbe: 'red', titel: `${ueberfaellig} überfällig` }
              : undefined,
            '/ereignisse': neu ? { farbe: 'amber', titel: `${neu} ungetriagiert` } : undefined,
            '/feststellungen': p153
              ? { farbe: 'red', titel: `${p153} §-153-Würdigung offen` }
              : undefined,
          }}
        />
      ) : null}
      {children}
    </div>
  );
}
