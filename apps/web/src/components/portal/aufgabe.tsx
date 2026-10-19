import Link from 'next/link';
import { fmtDatum, fmtDatumKurz } from '@tcms/domain';
import { Icon } from '@/components/icon';
import type { PortalAufgabe } from '@/server/portal-daten';

const ICON_JE_KONTROLLE: Record<string, string> = {
  'K-EC-23': 'FileSpreadsheet',
  'K-EC-05': 'Warehouse',
  'K-EC-18': 'Warehouse',
  'K-EC-07': 'UserCheck',
  'K-EC-22': 'FileCheck',
  'K-EC-02': 'Tag',
  'K-EC-09': 'Gift',
  'K-EC-14': 'Settings',
  'K-EC-15': 'FileText',
  'K-EC-17': 'Store',
};

function ersterSatz(t: string): string {
  return t.length > 140 ? `${t.slice(0, 137).replace(/\s+\S*$/, '')} …` : t;
}

/** Aufgabenkarte im Portal (P1): Stufenleiste, Fälligkeit und Link zur Aufgabe (P2). */
export function AufgabeKarte({ a }: { a: PortalAufgabe }) {
  const { d } = a;
  const ueber = d.anzeige === 'UEBERFAELLIG';
  const zurueck = d.anzeige === 'ZURUECKGEWIESEN';
  const href = `/portal/tcms/aufgaben/${d.id}`;
  const schritt =
    a.art === 'BESTAETIGEN'
      ? 2
      : d.status === 'IN_DURCHFUEHRUNG' || d.status === 'ZURUECKGEWIESEN' || d.nachweise > 0
        ? 1
        : 0;
  const stufen =
    a.art === 'BESTAETIGEN'
      ? ['Erfasst', 'Bestätigen', 'Kanzlei prüft']
      : ['Erfassen', 'Übermitteln', 'Kanzlei prüft'];
  return (
    <div
      className="card p-3"
      style={{ boxShadow: 'none', ...(ueber ? { borderColor: '#f3cdc7' } : {}) }}
    >
      <div className="row" style={{ alignItems: 'flex-start', gap: 12 }}>
        <span className={`icon-ring ${ueber ? 'red' : zurueck ? 'amber' : 'brand'}`}>
          <Icon name={ICON_JE_KONTROLLE[d.code] ?? 'ListChecks'} />
        </span>
        <div className="grow">
          <div className="text-sm font-s">
            {d.titel} · {d.periodeLabel}
          </div>
          <div className="text-xs text-muted mt-1">
            {a.art === 'BESTAETIGEN'
              ? `Bitte als zweite Person bestätigen: ${ersterSatz(a.ziel)}`
              : ersterSatz(a.ziel)}
          </div>
          <div className="steps-mini mt-3">
            {stufen.map((s, i) => (
              <span key={s} style={{ display: 'contents' }}>
                {i > 0 ? <span className="st-line" /> : null}
                <span className={`st ${i < schritt ? 'done' : i === schritt ? 'now' : ''}`}>
                  <span className="pt">
                    {i < schritt ? (
                      <Icon name="Check" className="tx-icon-xs" />
                    ) : i === schritt ? (
                      <Icon
                        name={
                          a.art === 'BESTAETIGEN'
                            ? 'UserCheck'
                            : schritt === 0
                              ? 'Pencil'
                              : 'Upload'
                        }
                        className="tx-icon-xs"
                      />
                    ) : null}
                  </span>
                  {s}
                </span>
              </span>
            ))}
          </div>
          <div
            className="text-xs mt-2"
            style={ueber || zurueck ? { color: '#b42318' } : { color: 'rgb(var(--text-muted))' }}
          >
            {ueber ? (
              <strong>überfällig seit {fmtDatum(d.faelligAm)}</strong>
            ) : zurueck ? (
              <strong>von der Kanzlei zurückgegeben</strong>
            ) : (
              <>fällig am {fmtDatum(d.faelligAm)}</>
            )}
            {' · '}
            {d.nachweise >= d.mindestNachweise && d.nachweise > 0
              ? `${d.nachweise} Nachweis${d.nachweise === 1 ? '' : 'e'} hochgeladen`
              : `${d.nachweise} von ${d.mindestNachweise} Nachweis${d.mindestNachweise === 1 ? '' : 'en'}`}
            {!a.eigene ? ` · zuständig: ${a.zustaendig}` : ''}
          </div>
        </div>
        {ueber || zurueck ? (
          <Link href={href} className="btn-primary btn-tiny shrink0">
            {a.art === 'BESTAETIGEN' ? 'Jetzt bestätigen' : 'Jetzt erledigen'}
          </Link>
        ) : (
          <Link
            href={href}
            className="btn-secondary btn-tiny shrink0"
            title={`fällig am ${fmtDatum(d.faelligAm)}`}
          >
            {a.art === 'BESTAETIGEN' ? 'Bestätigen' : `fällig bis ${fmtDatumKurz(d.faelligAm)}`}
          </Link>
        )}
      </div>
    </div>
  );
}
