import Link from 'next/link';
import { KLASSE_RANG } from '@tcms/domain';
import { GtBadge, KlasseBadge } from '@/components/ui/badges';
import type { KontrolleView, RisikoView } from '@/server/kontext';

/**
 * Matrix Risiken × Kontrollen (Fachkonzept S6): Punkt je Zuordnung, gefüllt =
 * Schlüsselkontrolle; Risiken ohne Kontrolle rot.
 */
export function KontrollMatrix({
  risiken,
  kontrollen,
  kontrolleHref,
  risikoHref,
}: {
  risiken: RisikoView[];
  kontrollen: KontrolleView[];
  kontrolleHref: (id: string) => string;
  risikoHref: (id: string) => string;
}) {
  const zeilen = [...risiken].sort(
    (a, b) =>
      KLASSE_RANG[b.bewertung.brutto.klasse] - KLASSE_RANG[a.bewertung.brutto.klasse] ||
      a.code.localeCompare(b.code),
  );
  const ohneKontrolle = zeilen.filter((r) => r.kontrollIds.length === 0);
  const ohneRisiko = kontrollen.filter((k) => k.risikoIds.length === 0);
  return (
    <div className="card" style={{ overflow: 'hidden' }}>
      <div className="tbl-scroll">
        <table className="tbl matrix-tbl">
          <thead>
            <tr>
              <th className="rot" style={{ position: 'sticky', left: 0, zIndex: 1, minWidth: 260 }}>
                Risiko{' '}
                <span className="text-muted" style={{ textTransform: 'none', fontWeight: 500 }}>
                  × Kontrolle K-EC-…
                </span>
              </th>
              <th>Brutto</th>
              <th>GT</th>
              {kontrollen.map((k) => (
                <th
                  key={k.id}
                  title={`${k.code} · ${k.titel}${k.schluessel ? ' (Schlüsselkontrolle)' : ''}`}
                  style={{ padding: '6px 4px' }}
                >
                  <Link
                    href={kontrolleHref(k.id)}
                    className="unstyled mono"
                    style={k.schluessel ? { color: 'rgb(var(--brand-700))' } : undefined}
                  >
                    {k.code.replace(/^K-EC-/, '')}
                  </Link>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {zeilen.map((r) => (
              <tr key={r.id} className={r.kontrollIds.length === 0 ? 'ohne' : undefined}>
                <td
                  className="rot"
                  style={{
                    position: 'sticky',
                    left: 0,
                    background: 'rgb(var(--surface-card))',
                    whiteSpace: 'nowrap',
                  }}
                >
                  <Link href={risikoHref(r.id)} className="unstyled">
                    <span className="text-sm font-m mono">{r.code}</span>{' '}
                    <span className="text-xs text-muted" title={r.titel}>
                      · {r.titel.length > 34 ? `${r.titel.slice(0, 33)}…` : r.titel}
                    </span>
                  </Link>
                  {r.kontrollIds.length === 0 ? (
                    <span className="badge-red" style={{ marginLeft: 6 }}>
                      ohne Kontrolle
                    </span>
                  ) : null}
                </td>
                <td>
                  <KlasseBadge klasse={r.bewertung.brutto.klasse} />
                </td>
                <td>
                  <GtBadge gt={r.gt} />
                </td>
                {kontrollen.map((k) => {
                  const zu = r.kontrollIds.includes(k.id);
                  return (
                    <td key={k.id} style={{ padding: '6px 4px' }}>
                      {zu ? (
                        <Link
                          href={kontrolleHref(k.id)}
                          className="unstyled"
                          title={`${k.schluessel ? 'Schlüsselkontrolle' : 'Zugeordnete Kontrolle'}: ${k.code} · ${k.titel} → ${r.code}`}
                          style={
                            k.schluessel
                              ? { color: 'rgb(var(--brand-600))', fontSize: 16 }
                              : { fontSize: 15 }
                          }
                        >
                          {k.schluessel ? '●' : <span className="text-muted">○</span>}
                        </Link>
                      ) : null}
                    </td>
                  );
                })}
              </tr>
            ))}
            <tr>
              <td
                className="rot text-xs text-muted"
                style={{ position: 'sticky', left: 0, background: 'rgb(var(--surface-card))' }}
              >
                Risiken je Kontrolle
              </td>
              <td />
              <td />
              {kontrollen.map((k) => (
                <td
                  key={k.id}
                  className="mono text-xs"
                  style={{ padding: '6px 4px' }}
                  title={k.risikoCodes.join(', ') || 'keine Risikozuordnung'}
                >
                  {k.risikoIds.length || <span className="text-disabled">0</span>}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
      <div className="p-4" style={{ borderTop: '1px solid rgb(var(--border-default))' }}>
        <p className="text-sm text-secondary">
          <span style={{ color: 'rgb(var(--brand-600))' }}>●</span> Schlüsselkontrolle ·{' '}
          <span className="text-muted">○</span> zugeordnete Kontrolle.{' '}
          {ohneKontrolle.length === 0
            ? `Alle ${zeilen.length} Risiken sind mindestens einer Kontrolle zugeordnet.`
            : `${ohneKontrolle.length} ${ohneKontrolle.length === 1 ? 'Risiko ist' : 'Risiken sind'} ohne Kontrolle (rot markiert): ${ohneKontrolle.map((r) => r.code).join(', ')}.`}
          {ohneRisiko.length
            ? ` Ohne Risikozuordnung: ${ohneRisiko.map((k) => k.code).join(', ')} (Grundelemente Kultur/Kommunikation).`
            : ''}
        </p>
      </div>
    </div>
  );
}
