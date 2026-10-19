import Link from 'next/link';
import type { ReactNode } from 'react';
import { fmtDatum, PHASEN } from '@tcms/domain';
import type { StaffSeite } from '@/server/seite';
import { Icon } from '../icon';
import { StichtagSelector } from '../ui/client';

/** Schlanker TCMS-Kopf: Teilbereich, Phase, Stichtag; darunter ggf. Banner für historische Stände. */
export function TcmsKopf({
  seite,
  rechts,
  titel,
}: {
  seite: StaffSeite;
  rechts?: ReactNode;
  titel?: ReactNode;
}) {
  const { ctx } = seite;
  return (
    <>
      <div className="row-between mb-3" style={{ flexWrap: 'wrap', gap: 12 }}>
        <div className="row-s" style={{ flexWrap: 'wrap' }}>
          {titel}
          {ctx.teilbereich ? <span className="badge-brand">{ctx.teilbereich.name}</span> : null}
          {ctx.programm ? (
            <span className="badge-purple" title={PHASEN[ctx.aktivePhase - 1]}>
              Phase {ctx.aktivePhase} von 7 · {PHASEN[ctx.aktivePhase - 1]}
            </span>
          ) : null}
        </div>
        <div className="row-s">
          <StichtagSelector stand={seite.standIso} heute={seite.heuteIso} />
          {rechts}
        </div>
      </div>
      {ctx.historisch ? (
        <div className="alert-warning mb-3 row-between" role="status">
          <span className="row-s">
            <Icon name="History" />
            <span>
              <strong>Stand zum {fmtDatum(ctx.stand)} — nur Lesen.</strong> Änderungen wirken auf
              den aktuellen Stand.
              {ctx.ausgeblendet > 0
                ? ` ${ctx.ausgeblendet} Einträge sind wegen des Stichtags ausgeblendet.`
                : ''}
            </span>
          </span>
          <Link href="?" className="btn-secondary btn-tiny shrink0">
            Zum aktuellen Stand
          </Link>
        </div>
      ) : null}
    </>
  );
}
