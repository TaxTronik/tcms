import Link from 'next/link';
import { fmtDatum, fmtDatumZeit, frequenzLabel } from '@tcms/domain';
import { Icon } from '@/components/icon';
import { StatusBadge } from '@/components/ui/badges';
import { Leerzustand } from '@/components/ui/leer';
import { TcmsKopf } from '@/components/tcms/kopf';
import { ladeFreigaben, type FreigabeZeile } from '@/server/kommunikation-daten';
import { personName, type PersonKurz } from '@/server/kontext';
import { ladeStaffSeite } from '@/server/seite';

export const metadata = { title: 'Kommunikation und Richtlinien' };

const ART_LABEL: Record<FreigabeZeile['art'], string> = {
  ZIELE: 'Compliance-Ziele',
  BESCHREIBUNG: 'CMS-Beschreibung',
  RISIKOAKZEPTANZ: 'Risikoakzeptanz',
  AUFKLAERUNG: 'Risikoaufklärung',
  KENNTNISNAHME: 'Kenntnisnahme',
};
const STATUS: Record<FreigabeZeile['status'], { label: string; badge: string }> = {
  OFFEN: { label: 'offen', badge: 'badge-yellow' },
  FREIGEGEBEN: { label: 'freigegeben', badge: 'badge-green' },
  ABGELEHNT: { label: 'abgelehnt', badge: 'badge-red' },
};
const ROLLE: Record<string, string> = {
  GESETZLICHER_VERTRETER: 'Gesetzliche Vertretung',
  TAX_COMPLIANCE_BEAUFTRAGTER: 'Tax-Compliance-Beauftragte:r',
  MITARBEITER: 'Mitarbeit',
  BERUFSTRAEGER: 'Berufsträger:in',
  BEARBEITUNG: 'Bearbeitung',
};
const TD = { padding: '10px 14px', verticalAlign: 'top' } as const;

function rolle(p: PersonKurz | undefined): string {
  if (!p) return '';
  const r = p.mandantRolle ?? p.kanzleiRolle;
  return r ? (ROLLE[r] ?? '') : (p.funktion ?? '');
}

export default async function Kommunikation({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const seite = await ladeStaffSeite(id, await searchParams);
  const { ctx, basis, mitStand } = seite;

  if (!ctx.programm) {
    return (
      <>
        <TcmsKopf seite={seite} />
        <div className="card">
          <Leerzustand
            icon="MessagesSquare"
            text="Für diesen Mandanten ist noch kein Tax-CMS eingerichtet."
          />
        </div>
      </>
    );
  }

  const alle = await ladeFreigaben(id, seite.standIso);
  const freigaben = alle.filter((f) => f.art !== 'KENNTNISNAHME');
  const kenntnisnahmen = alle.filter((f) => f.art === 'KENNTNISNAHME');
  const freigegebeneBeschreibungen = ctx.beschreibungen.filter(
    (b) => b.freigegebenAm && b.freigegebenAm.getTime() <= ctx.stand.getTime() + 86_399_999,
  );
  const k22 = ctx.kontrollen.find((k) => k.code === 'K-EC-22');
  const portalMeldungen = ctx.ereignisse.filter((e) => e.quelle === 'PORTAL');
  const meldeberechtigt = ctx.mandantPersonen.filter(
    (p) =>
      p.mandantRolle === 'GESETZLICHER_VERTRETER' ||
      p.mandantRolle === 'TAX_COMPLIANCE_BEAUFTRAGTER',
  );
  const p = (pid: string | null) => ctx.personen.get(pid ?? '');

  return (
    <>
      <TcmsKopf seite={seite} />

      <div
        className="alert-info mb-4 text-sm"
        role="note"
        style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}
      >
        <Icon name="Info" />
        <span>
          <strong>Richtlinienverwaltung folgt in Ausbaustufe B.</strong> Bis dahin zeigt diese Seite
          Freigaben und Kenntnisnahmen aus dem Portal (nur Lesen). Freigaben erteilen ausschließlich
          die gesetzlichen Vertreter mit E-Mail-Code.
        </span>
      </div>

      <div className="g12" style={{ alignItems: 'start' }}>
        <div className="gc-8 col" style={{ gap: 16 }}>
          <div className="card" style={{ overflow: 'hidden' }}>
            <div className="card-header">
              <span className="card-title">Freigaben</span>
              <span className="badge-gray">{freigaben.length}</span>
            </div>
            {freigaben.length === 0 ? (
              <Leerzustand
                icon="UserCheck"
                text="Noch keine Freigabe über das Portal angefordert."
              />
            ) : (
              <div className="tbl-scroll">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th style={TD}>Gegenstand</th>
                      <th style={TD}>Empfänger</th>
                      <th style={TD}>Angefordert</th>
                      <th style={TD}>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {freigaben.map((f) => (
                      <tr key={f.id}>
                        <td style={TD}>
                          <div className="text-sm font-m">{f.titel}</div>
                          <div className="text-11 text-muted mt-1">{ART_LABEL[f.art]}</div>
                        </td>
                        <td style={TD}>
                          <div className="text-sm">{personName(ctx, f.empfaengerId)}</div>
                          <div className="text-11 text-muted">{rolle(p(f.empfaengerId))}</div>
                        </td>
                        <td style={{ ...TD, whiteSpace: 'nowrap' }}>
                          <div className="text-xs">{fmtDatumZeit(f.angefordertAm)}</div>
                          <div className="text-11 text-muted">
                            {personName(ctx, f.angefordertVon)}
                          </div>
                        </td>
                        <td style={TD}>
                          <span className={STATUS[f.status].badge}>{STATUS[f.status].label}</span>
                          <div className="text-11 text-muted mt-1">
                            {f.erledigtAm
                              ? fmtDatumZeit(f.erledigtAm)
                              : f.status === 'OFFEN' && f.codeAblauf
                                ? `Code gültig bis ${fmtDatum(f.codeAblauf)}`
                                : ''}
                          </div>
                          {f.anmerkung ? (
                            <div className="text-11 text-secondary mt-1">„{f.anmerkung}"</div>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="card-footer">
              <span>
                Bestätigung per Token und E-Mail-Code; ohne Aussage zu elektronischen Signaturen.
              </span>
            </div>
          </div>

          <div className="card" style={{ overflow: 'hidden' }}>
            <div className="card-header">
              <span className="card-title">Kenntnisnahmen</span>
              <button
                type="button"
                className="btn-secondary btn-tiny"
                disabled
                title="Folgt in Ausbaustufe B"
              >
                <Icon name="Send" className="tx-icon-xs" /> Kenntnisnahme anfordern
              </button>
            </div>
            {kenntnisnahmen.length === 0 ? (
              <Leerzustand icon="FileCheck" text="Noch keine Kenntnisnahme angefordert." />
            ) : (
              <div className="tbl-scroll">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th style={TD}>Person</th>
                      <th style={TD}>Rolle</th>
                      <th style={TD}>Dokument</th>
                      <th style={TD}>Bestätigt</th>
                    </tr>
                  </thead>
                  <tbody>
                    {kenntnisnahmen.map((f) => (
                      <tr key={f.id}>
                        <td style={TD} className="text-sm">
                          {personName(ctx, f.empfaengerId)}
                        </td>
                        <td style={TD} className="text-xs text-secondary">
                          {rolle(p(f.empfaengerId))}
                        </td>
                        <td style={TD}>
                          <div className="text-sm font-m">{f.titel}</div>
                          <div className="text-11 text-muted mt-1">
                            angefordert {fmtDatum(f.angefordertAm)} von{' '}
                            {personName(ctx, f.angefordertVon)}
                          </div>
                        </td>
                        <td style={{ ...TD, whiteSpace: 'nowrap' }}>
                          {f.status === 'FREIGEGEBEN' && f.erledigtAm ? (
                            <span className="badge-green">{fmtDatumZeit(f.erledigtAm)}</span>
                          ) : f.status === 'ABGELEHNT' ? (
                            <span className="badge-red">abgelehnt</span>
                          ) : (
                            <span className="badge-yellow">offen</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="card-footer">
              <span>
                Kenntnisnahmen haben keinen Freigabevorbehalt; sie werden mit Person und Zeitpunkt
                protokolliert.
              </span>
            </div>
          </div>
        </div>
        <div className="gc-4 col" style={{ gap: 16 }}>
          <div className="card" style={{ overflow: 'hidden' }}>
            <div className="card-header">
              <span className="card-title">Freigabestände</span>
            </div>
            <div>
              <div
                className="px-4 py-2 text-xs font-s text-secondary"
                style={{ background: 'rgb(var(--surface-raised))' }}
              >
                Compliance-Ziele
              </div>
              {ctx.ziele.length === 0 ? (
                <div className="list-row text-sm text-muted">Keine Ziele erfasst.</div>
              ) : (
                ctx.ziele.map((z) => (
                  <div key={z.id} className="list-row">
                    <div className="grow" style={{ minWidth: 0 }}>
                      <div className="text-sm truncate" title={z.text}>
                        {z.text}
                      </div>
                      <div className="text-11 text-muted mt-1">
                        {z.freigabe === 'FREIGEGEBEN' && z.freigegebenAm
                          ? `${personName(ctx, z.freigegebenVon)} · ${fmtDatumZeit(z.freigegebenAm)}`
                          : z.freigabe === 'AUSSTEHEND'
                            ? 'Freigabe angefordert'
                            : 'Entwurf'}
                      </div>
                    </div>
                    <span
                      className={
                        z.freigabe === 'FREIGEGEBEN'
                          ? 'badge-green shrink0'
                          : z.freigabe === 'AUSSTEHEND'
                            ? 'badge-yellow shrink0'
                            : 'badge-gray shrink0'
                      }
                    >
                      {z.freigabe === 'FREIGEGEBEN'
                        ? 'freigegeben'
                        : z.freigabe === 'AUSSTEHEND'
                          ? 'ausstehend'
                          : 'Entwurf'}
                    </span>
                  </div>
                ))
              )}
              <div
                className="px-4 py-2 text-xs font-s text-secondary"
                style={{ background: 'rgb(var(--surface-raised))' }}
              >
                CMS-Beschreibung
              </div>
              {freigegebeneBeschreibungen.length === 0 ? (
                <div className="list-row text-sm text-muted">Noch keine Version freigegeben.</div>
              ) : (
                freigegebeneBeschreibungen
                  .map((b, i) => ({ b, abgeloest: i < freigegebeneBeschreibungen.length - 1 }))
                  .reverse()
                  .map(({ b, abgeloest }) => (
                    <Link
                      key={b.id}
                      href={mitStand(`${basis}/beschreibung`)}
                      className="list-row unstyled"
                    >
                      <div className="grow">
                        <div className="text-sm font-m">Version {b.nummer}</div>
                        <div className="text-11 text-muted mt-1">
                          {personName(ctx, b.freigegebenVon)} · {fmtDatumZeit(b.freigegebenAm)}
                        </div>
                      </div>
                      <span className={abgeloest ? 'badge-gray shrink0' : 'badge-green shrink0'}>
                        {abgeloest ? 'abgelöst' : 'freigegeben'}
                      </span>
                    </Link>
                  ))
              )}
            </div>
          </div>
          <div className="card" style={{ overflow: 'hidden' }}>
            <div className="card-header">
              <span className="card-title">Kultur und Meldewege</span>
            </div>
            <div>
              {k22 ? (
                <Link
                  href={mitStand(`${basis}/kontrollen?kontrolle=${k22.id}`)}
                  className="list-row unstyled"
                >
                  <span className="icon-ring brand" style={{ width: 28, height: 28 }}>
                    <Icon name="Landmark" className="tx-icon-xs" />
                  </span>
                  <div className="grow">
                    <div className="text-sm font-m">K-EC-22 · {k22.titel}</div>
                    <div className="text-11 text-muted mt-1">
                      {frequenzLabel(k22.frequenz)} · Designbeurteilung{' '}
                      {k22.design === 'ANGEMESSEN' && k22.designAm
                        ? `angemessen · ${personName(ctx, k22.designVon)} · ${fmtDatum(k22.designAm)}`
                        : k22.design === 'MANGEL'
                          ? 'Mangel'
                          : 'nicht beurteilt'}
                    </div>
                    {k22.letzte ? (
                      <div className="row-s mt-1 text-11 text-muted">
                        Letzte: {k22.letzte.periodeLabel}{' '}
                        <StatusBadge status={k22.letzte.anzeige} />
                      </div>
                    ) : null}
                  </div>
                </Link>
              ) : (
                <div className="list-row text-sm text-muted">
                  Kenntnisnahme-Kontrolle K-EC-22 ist nicht eingerichtet.
                </div>
              )}
              <div className="list-row">
                <span className="icon-ring amber" style={{ width: 28, height: 28 }}>
                  <Icon name="Bell" className="tx-icon-xs" />
                </span>
                <div className="grow">
                  <div className="text-sm font-m">Ereignismeldung im Portal</div>
                  <div className="text-11 text-muted mt-1">
                    Tax-Compliance → Ereignis melden · {portalMeldungen.length} Meldungen aus dem
                    Portal bisher
                  </div>
                  <div className="text-11 text-muted mt-1">
                    Meldeberechtigt:{' '}
                    {meldeberechtigt.length
                      ? meldeberechtigt.map((x) => `${x.name} (${rolle(x)})`).join(', ')
                      : '—'}
                  </div>
                </div>
              </div>
              <div className="list-row">
                <span className="icon-ring" style={{ width: 28, height: 28 }}>
                  <Icon name="Library" className="tx-icon-xs" />
                </span>
                <div className="grow">
                  <div className="text-sm font-m text-secondary">
                    Steuerrichtlinie, Arbeitsanweisungen, Schulungen
                  </div>
                  <div className="text-11 text-muted mt-1">
                    Versionierte Richtlinien mit Schulungsnachweisen folgen in Ausbaustufe B.
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
