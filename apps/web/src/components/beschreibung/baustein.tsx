import type { CSSProperties, ReactNode } from 'react';
import {
  BAUSTEIN_LABEL,
  BAUSTEIN_QUELLE,
  fmtEurGanz,
  fmtMonatJahr,
  KLASSE_LABEL,
  KONTROLLART_LABEL,
  PARTEI_LABEL,
  type BausteinArt,
} from '@tcms/domain';
import { Icon } from '@/components/icon';
import { GtBadge, KlasseBadge } from '@/components/ui/badges';
import { fmtIso } from './status';
import type { BausteinQuelle, BausteinSatz } from './typen';

const TD: CSSProperties = { padding: '6px 8px', verticalAlign: 'top' };
const TH: CSSProperties = { padding: '6px 8px', fontSize: 11 };

function Tabelle({ kopf, children }: { kopf: string[]; children: ReactNode }) {
  return (
    <div className="tbl-scroll">
      <table className="tbl">
        <thead>
          <tr>
            {kopf.map((k, i) => (
              <th key={`${k}-${i}`} style={TH}>
                {k}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

const REG_BADGE = {
  VOLLSTAENDIG: 'badge-green',
  FEHLT: 'badge-red',
  PRUEFEN: 'badge-yellow',
} as const;
const REG_LABEL = {
  VOLLSTAENDIG: 'vollständig',
  FEHLT: 'Registrierung fehlt',
  PRUEFEN: 'Steuersätze prüfen',
} as const;

function Inhalt<A extends BausteinArt>({ art, d }: { art: A; d: NonNullable<BausteinSatz[A]> }) {
  switch (art) {
    case 'TEILBEREICH': {
      const t = d as NonNullable<BausteinSatz['TEILBEREICH']>;
      return (
        <div className="col" style={{ gap: 8 }}>
          <div className="text-sm font-s">{t.name}</div>
          <p className="text-sm text-secondary">{t.abgrenzung}</p>
          <div className="row-wrap" style={{ gap: 6 }}>
            <span className="text-11 text-muted" style={{ width: 92 }}>
              Eingeschlossen
            </span>
            {t.einschluesse.map((e) => (
              <span key={e} className="badge-green">
                {e}
              </span>
            ))}
          </div>
          <div className="row-wrap" style={{ gap: 6 }}>
            <span className="text-11 text-muted" style={{ width: 92 }}>
              Ausgeschlossen
            </span>
            {t.ausschluesse.map((e) => (
              <span key={e} className="badge-gray">
                {e}
              </span>
            ))}
          </div>
          {t.zielLaender.length || t.kanaele.length ? (
            <div className="text-11 text-muted">
              {t.zielLaender.length ? (
                <>
                  Zielländer: <span className="mono">{t.zielLaender.join(' · ')}</span>
                </>
              ) : null}
              {t.zielLaender.length && t.kanaele.length ? ' · ' : ''}
              {t.kanaele.length ? <>Kanäle: {t.kanaele.join(', ')}</> : null}
            </div>
          ) : null}
        </div>
      );
    }
    case 'ZIELE': {
      const z = d as BausteinSatz['ZIELE'];
      if (!z.ziele.length)
        return <p className="text-sm text-muted">Noch keine Compliance-Ziele erfasst.</p>;
      return (
        <Tabelle kopf={['Ziel', 'Wesentlichkeit', 'Appetit', 'Freigabe']}>
          {z.ziele.map((x, i) => (
            <tr key={i}>
              <td className="text-sm wrap-cell" style={TD}>
                {x.text}
              </td>
              <td className="td-num mono text-xs" style={TD}>
                {fmtEurGanz(x.wesentlichkeitEur)}
              </td>
              <td style={TD}>
                <KlasseBadge klasse={x.risikoappetit} />
              </td>
              <td className="text-11" style={TD}>
                {x.freigabe === 'FREIGEGEBEN' ? (
                  <>
                    <span className="badge-green">freigegeben</span>
                    <div className="text-11 text-muted mt-1">
                      {x.freigegebenVon ?? '—'} · {fmtIso(x.freigegebenAm)}
                    </div>
                  </>
                ) : (
                  <span className="badge-yellow">
                    {x.freigabe === 'AUSSTEHEND' ? 'Freigabe ausstehend' : 'Entwurf'}
                  </span>
                )}
              </td>
            </tr>
          ))}
        </Tabelle>
      );
    }
    case 'RISIKOINVENTAR': {
      const r = d as BausteinSatz['RISIKOINVENTAR'];
      if (!r.risiken.length)
        return <p className="text-sm text-muted">Noch keine aktiven Risiken.</p>;
      const ueber = r.risiken.filter((x) => x.ueberAppetit).length;
      return (
        <>
          <Tabelle
            kopf={[
              'ID',
              'Risiko',
              'GT',
              'Brutto',
              r.sicht === 'BETRIEB' ? 'Netto (Betrieb)' : 'Netto (Design)',
            ]}
          >
            {r.risiken.map((x) => (
              <tr key={x.code}>
                <td className="mono text-xs" style={{ ...TD, whiteSpace: 'nowrap' }}>
                  {x.code}
                </td>
                <td className="text-sm wrap-cell" style={TD}>
                  {x.titel}
                </td>
                <td style={TD}>
                  <GtBadge gt={x.gt} />
                </td>
                <td style={TD}>
                  <KlasseBadge klasse={x.brutto} />
                </td>
                <td style={{ ...TD, whiteSpace: 'nowrap' }}>
                  <KlasseBadge klasse={x.netto} />
                  {x.ueberAppetit ? (
                    <span
                      title="über dem Risikoappetit"
                      style={{
                        color: '#b42318',
                        marginLeft: 6,
                        display: 'inline-flex',
                        verticalAlign: 'middle',
                      }}
                    >
                      <Icon
                        name="TriangleAlert"
                        className="tx-icon-xs"
                        title="über dem Risikoappetit"
                      />
                    </span>
                  ) : null}
                </td>
              </tr>
            ))}
          </Tabelle>
          <div className="text-11 text-muted mt-2">
            {r.risiken.length} aktive Risiken · Risikoappetit {KLASSE_LABEL[r.appetit]} · {ueber}{' '}
            über Appetit
          </div>
        </>
      );
    }
    case 'KONTROLLMATRIX': {
      const k = d as BausteinSatz['KONTROLLMATRIX'];
      if (!k.kontrollen.length)
        return <p className="text-sm text-muted">Noch keine aktiven Kontrollen.</p>;
      return (
        <>
          <Tabelle kopf={['ID', 'Kontrolle', 'Art', 'Frequenz', 'Partei', 'Designbeurteilung']}>
            {k.kontrollen.map((x) => (
              <tr key={x.code}>
                <td className="mono text-xs" style={{ ...TD, whiteSpace: 'nowrap' }}>
                  {x.code}
                  {x.schluessel ? (
                    <span
                      title="Schlüsselkontrolle"
                      style={{ marginLeft: 4, display: 'inline-flex', verticalAlign: 'middle' }}
                    >
                      <Icon name="KeyRound" className="tx-icon-xs" title="Schlüsselkontrolle" />
                    </span>
                  ) : null}
                </td>
                <td className="text-sm wrap-cell" style={TD}>
                  {x.titel}
                  {x.risikoCodes.length ? (
                    <div className="text-11 text-muted mono">{x.risikoCodes.join(' · ')}</div>
                  ) : null}
                </td>
                <td className="text-xs" style={TD} title={KONTROLLART_LABEL[x.art]}>
                  {x.art}
                </td>
                <td className="text-xs wrap-cell" style={TD}>
                  {x.frequenz}
                </td>
                <td className="text-xs" style={TD}>
                  {PARTEI_LABEL[x.partei]}
                </td>
                <td className="text-11" style={TD}>
                  {x.design === 'ANGEMESSEN' ? (
                    <>
                      <span className="badge-green">angemessen</span>
                      <div className="text-11 text-muted mt-1">
                        {x.designVon ?? '—'} · {fmtIso(x.designAm)}
                      </div>
                    </>
                  ) : x.design === 'MANGEL' ? (
                    <span className="badge-red">Mangel · {x.designVon ?? '—'}</span>
                  ) : (
                    <span className="badge-gray">nicht beurteilt</span>
                  )}
                </td>
              </tr>
            ))}
          </Tabelle>
          <div className="text-11 text-muted mt-2">
            {k.kontrollen.length} aktive Kontrollen · davon{' '}
            {k.kontrollen.filter((x) => x.schluessel).length} Schlüsselkontrollen
          </div>
        </>
      );
    }
    case 'VERANTWORTUNG': {
      const v = d as BausteinSatz['VERANTWORTUNG'];
      return (
        <>
          <div className="row-wrap mb-2" style={{ gap: 6 }}>
            {v.rollen.map((r) => (
              <span key={`${r.rolle}-${r.name}`} className="badge-gray">
                {r.rolle}: <strong className="font-s">{r.name}</strong>
              </span>
            ))}
          </div>
          {v.kontrollen.length ? (
            <Tabelle kopf={['Kontrolle', 'Partei', 'Durchführung', 'Vertretung', 'Gegenzeichnung']}>
              {v.kontrollen.map((x) => (
                <tr key={x.code}>
                  <td className="text-sm wrap-cell" style={TD}>
                    <span className="mono text-xs">{x.code}</span> {x.titel}
                  </td>
                  <td className="text-xs" style={TD}>
                    {PARTEI_LABEL[x.partei]}
                  </td>
                  <td className="text-xs" style={TD}>
                    {x.durchfuehrend}
                  </td>
                  <td className="text-xs" style={TD}>
                    {x.vertretung}
                  </td>
                  <td className="text-xs" style={TD}>
                    {/* Ältere Snapshots ohne Feld tragen „ (Mandant)" schon im Namen. */}
                    {x.gegenzeichnung}
                    {x.gegenzeichnungMandant ? ' (Mandant)' : ''}
                  </td>
                </tr>
              ))}
            </Tabelle>
          ) : null}
        </>
      );
    }
    case 'LAENDER': {
      const l = d as BausteinSatz['LAENDER'];
      if (!l.laender.length)
        return (
          <p className="text-sm text-muted">Im Länder-Monitor sind noch keine Länder erfasst.</p>
        );
      return (
        <>
          <Tabelle kopf={['Land', 'Fernverkäufe lfd. Jahr', 'Lager seit', 'Registrierung']}>
            {l.laender.map((x) => (
              <tr key={x.land}>
                <td className="text-sm" style={TD}>
                  <span className="font-m">{x.land}</span>{' '}
                  <span className="text-xs text-muted">{x.name}</span>
                </td>
                <td className="td-num mono text-xs" style={TD}>
                  {fmtEurGanz(x.fernverkaeufeLfdEur)}
                </td>
                <td className="text-xs" style={TD}>
                  {x.lagerSeit ? fmtMonatJahr(x.lagerSeit) : '–'}
                </td>
                <td style={TD}>
                  <span className="row-s" style={{ flexWrap: 'wrap', gap: 4 }}>
                    {x.oss ? <span className="badge-green">OSS</span> : null}
                    {x.lokaleUstNr ? <span className="badge-green">lokale USt-Nr.</span> : null}
                    <span className={REG_BADGE[x.registrierung]}>{REG_LABEL[x.registrierung]}</span>
                  </span>
                </td>
              </tr>
            ))}
          </Tabelle>
          <div className="text-11 text-muted mt-2">
            EU-Fernverkäufe lfd. Jahr <span className="mono">{fmtEurGanz(l.summeLfd)}</span> ·
            Vorjahr <span className="mono">{fmtEurGanz(l.summeVorjahr)}</span> · {l.schwelle}
            {l.stand ? ` · Datenstand ${fmtIso(l.stand)}` : ''}
          </div>
        </>
      );
    }
    case 'FESTSTELLUNGEN': {
      const f = d as BausteinSatz['FESTSTELLUNGEN'];
      if (!f.feststellungen.length)
        return <p className="text-sm text-muted">Keine offenen Feststellungen.</p>;
      return (
        <Tabelle kopf={['Nr.', 'Feststellung', 'Schwere', 'Status', 'Maßnahmen offen']}>
          {f.feststellungen.map((x) => (
            <tr key={x.nummer}>
              <td className="mono text-xs" style={{ ...TD, whiteSpace: 'nowrap' }}>
                {x.nummer}
              </td>
              <td className="text-sm wrap-cell" style={TD}>
                {x.titel}
              </td>
              <td style={TD}>
                <KlasseBadge klasse={x.schwere} />
              </td>
              <td className="text-xs" style={TD}>
                {x.status}
              </td>
              <td className="td-num text-xs" style={TD}>
                {x.massnahmenOffen}
              </td>
            </tr>
          ))}
        </Tabelle>
      );
    }
    default:
      return null;
  }
}

/** Lebender Baustein: farbig umrandet, nicht editierbar, mit Stand-Datum. */
export function BausteinBlock({
  art,
  quelle,
  aktion,
}: {
  art: BausteinArt;
  quelle: BausteinQuelle;
  aktion?: ReactNode;
}) {
  const daten = quelle.satz ? (quelle.satz as Partial<BausteinSatz>)[art] : undefined;
  const tagText =
    quelle.modus === 'live'
      ? `automatisch · Stand ${fmtIso(quelle.stand)}`
      : `eingefroren${quelle.stand ? ` · Stand ${fmtIso(quelle.stand)}` : ''}`;
  return (
    <div className="living-block p-3" style={{ marginTop: 18 }}>
      <span className="lb-tag">{tagText}</span>
      <div className="row-between mb-2">
        <div className="text-sm font-s">{BAUSTEIN_LABEL[art]}</div>
        {aktion}
      </div>
      {daten ? (
        <Inhalt art={art} d={daten as never} />
      ) : quelle.modus === 'snapshot' ? (
        <p className="text-sm text-muted">
          <Icon name="Lock" className="tx-icon-xs" /> Dieser Snapshot enthält nur die Gliederung;
          die Bausteindaten wurden bei der Freigabe nicht mit eingefroren.
        </p>
      ) : (
        <p className="text-sm text-muted">Für diesen Baustein liegen noch keine Daten vor.</p>
      )}
      <div className="text-11 text-muted mt-2">
        {quelle.modus === 'live'
          ? `Baustein nicht editierbar — Inhalt aus ${BAUSTEIN_QUELLE[art]}.`
          : 'Eingefrorener Inhalt der Version — unveränderlich, durch den Snapshot-Hash gebunden.'}
      </div>
    </div>
  );
}
