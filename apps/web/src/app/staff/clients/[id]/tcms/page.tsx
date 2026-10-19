import Link from 'next/link';
import {
  EREIGNIS_QUELLE_LABEL,
  ereignistyp,
  fmtDatum,
  fmtDatumKurz,
  fmtEurGanz,
  frequenzLabel,
  KLASSE_LABEL,
  LAND_NAME,
  MONATE,
  P153_LABEL,
  PARTEI_LABEL,
  relativTage,
  tageZwischen,
} from '@tcms/domain';
import { Icon } from '@/components/icon';
import { StatusBadge } from '@/components/ui/badges';
import { Disclaimer } from '@/components/ui/disclaimer';
import { RiskHeatmap } from '@/components/ui/heatmap';
import { Leerzustand } from '@/components/ui/leer';
import { BarRows, Donut, PhasenStepper, SchwellenGauge } from '@/components/ui/visual';
import { TcmsKopf } from '@/components/tcms/kopf';
import { personKurzname } from '@/server/kontext';
import { ladeStaffSeite } from '@/server/seite';

export const metadata = { title: 'Mandanten-Cockpit' };

const ICON_RING_TON: Record<string, string> = {
  brand: 'brand',
  violet: 'violet',
  amber: 'amber',
  red: 'red',
  green: 'green',
};

export default async function Cockpit({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const seite = await ladeStaffSeite(id, await searchParams);
  const { ctx, basis, mitStand } = seite;

  if (!ctx.programm || (ctx.programm.status === 'ENTWURF' && !ctx.programm.version1Am)) {
    const entwurf = !!ctx.programm;
    return (
      <div className="card">
        <Leerzustand
          icon="ShieldCheck"
          text={
            entwurf
              ? 'Die Einrichtung des Tax-CMS läuft. Version 1 ist noch nicht angelegt.'
              : 'Für diesen Mandanten ist noch kein Tax-CMS eingerichtet.'
          }
        >
          {seite.darfBearbeiten ? (
            <Link className="btn-primary" href={`${basis}/setup`}>
              <Icon name={entwurf ? 'ArrowRight' : 'Plus'} />{' '}
              {entwurf ? 'Einrichtung fortsetzen' : 'Tax-CMS einrichten'}
            </Link>
          ) : (
            <button
              type="button"
              className="btn-primary"
              disabled
              title="Dieser Schritt ist zuständigen Personen vorbehalten."
            >
              <Icon name={entwurf ? 'ArrowRight' : 'Plus'} />{' '}
              {entwurf ? 'Einrichtung fortsetzen' : 'Tax-CMS einrichten'}
            </button>
          )}
        </Leerzustand>
      </div>
    );
  }

  const p153 = ctx.feststellungen.filter((f) => f.p153Offen);
  const ueberAppetit = ctx.risiken.filter((r) => r.ueberAppetit).length;
  const faellige = ctx.durchfuehrungen
    .filter(
      (d) =>
        d.anzeige === 'UEBERFAELLIG' ||
        d.anzeige === 'ZUR_GEGENZEICHNUNG' ||
        ((d.anzeige === 'FAELLIG' ||
          d.anzeige === 'IN_DURCHFUEHRUNG' ||
          d.anzeige === 'ZURUECKGEWIESEN' ||
          d.anzeige === 'GEPLANT') &&
          tageZwischen(ctx.stand, d.faelligAm) <= 14),
    )
    .sort((a, b) => {
      const prio = (x: typeof a) =>
        x.anzeige === 'UEBERFAELLIG' ? 0 : x.anzeige === 'ZUR_GEGENZEICHNUNG' ? 2 : 1;
      return prio(a) - prio(b) || a.faelligAm.getTime() - b.faelligAm.getTime();
    });
  const offeneF = ctx.feststellungen.filter(
    (f) => f.status !== 'GESCHLOSSEN' && f.status !== 'VERWORFEN',
  );
  const neueE = ctx.ereignisse.filter((e) => e.status === 'NEU');
  const fehltRegistrierung = ctx.laender.filter((l) => l.registrierung === 'FEHLT');
  const last = ctx.prueflast[1] ?? ctx.prueflast[0];
  const lastMonat = last
    ? MONATE[Number(last.monat.slice(5, 7)) - 1] + ' ' + last.monat.slice(0, 4)
    : '';
  const aktivePhase = ctx.phasen[ctx.aktivePhase - 1];
  const zr = ctx.zeitraum;

  const unterzeilen: Record<number, string> = {};
  const fb = ctx.beschreibungen.filter((b) => b.freigegebenAm).at(-1);
  if (fb) unterzeilen[4] = `v${fb.nummer} freigegeben`;
  if (ctx.programm.angemessenheitStichtag)
    unterzeilen[5] =
      ctx.programm.angemessenheitStichtag.getTime() > ctx.stand.getTime()
        ? `Stichtag geplant ${fmtDatum(ctx.programm.angemessenheitStichtag)}`
        : `Stichtag ${fmtDatum(ctx.programm.angemessenheitStichtag)}`;
  if (zr && ctx.programm.wirksamAb)
    unterzeilen[6] =
      ctx.aktivePhase === 6
        ? `Monat ${zr.monat} von ${zr.monate}`
        : `${fmtDatumKurz(ctx.programm.wirksamAb)}–${fmtDatum(ctx.programm.wirksamBis)}`;
  if (ctx.programm.wirksamBis && ctx.aktivePhase < 7) {
    const ab = new Date(ctx.programm.wirksamBis.getTime() + 86_400_000);
    unterzeilen[7] = `ab ${fmtDatum(ab)}`;
  }
  for (const p of ctx.phasen)
    if (p.nr > ctx.aktivePhase && !unterzeilen[p.nr]) unterzeilen[p.nr] = '';
  if (aktivePhase && !unterzeilen[ctx.aktivePhase]) {
    unterzeilen[ctx.aktivePhase] =
      `Gate: ${aktivePhase.bedingungen.filter((b) => b.erfuellt).length} von ${aktivePhase.bedingungen.length}`;
  }

  return (
    <>
      <TcmsKopf seite={seite} />
      <Disclaimer />

      {p153.length > 0 ? (
        <div className="alert-error mt-3 row-between" role="alert">
          <span className="row-s">
            <Icon name="TriangleAlert" />
            <span>
              <strong>§-153-Würdigung offen</strong> —{' '}
              {p153.map((f) => `${f.nummer} (${f.titel})`).join(', ')}.
            </span>
          </span>
          <Link
            href={mitStand(`${basis}/feststellungen/${p153[0]!.id}`)}
            className="btn-secondary btn-tiny shrink0"
          >
            Jetzt würdigen
          </Link>
        </div>
      ) : null}

      <div className="card mt-4" style={{ padding: '20px 24px 14px' }}>
        <PhasenStepper phasen={ctx.phasen} aktiv={ctx.aktivePhase} unterzeilen={unterzeilen} />
      </div>

      {aktivePhase && aktivePhase.bedingungen.length > 0 ? (
        <details className="details-box mt-3">
          <summary>
            <Icon name="CheckCircle2" className="tx-icon-xs" /> Gate der aktiven Phase anzeigen ·{' '}
            {aktivePhase.bedingungen.filter((b) => b.erfuellt).length} von{' '}
            {aktivePhase.bedingungen.length} Bedingungen erfüllt
          </summary>
          <div className="details-body">
            <div className="row-wrap" style={{ gap: 18 }}>
              {aktivePhase.bedingungen.map((b) => (
                <span key={b.text} className="row-s">
                  {b.erfuellt ? (
                    <Icon name="CheckCircle2" />
                  ) : (
                    <Icon name="Circle" className="tx-icon-xs text-muted" />
                  )}
                  {b.link && !b.erfuellt ? (
                    <Link className="text-sm" href={mitStand(`${basis}/${b.link}`)}>
                      {b.text}
                    </Link>
                  ) : (
                    <span className={`text-sm${b.erfuellt ? '' : ' text-muted'}`}>{b.text}</span>
                  )}
                </span>
              ))}
            </div>
          </div>
        </details>
      ) : null}

      {/* Reihe 1 */}
      <div className="g12 mt-4">
        <div className="card gc-4">
          <div className="card-header">
            <span className="card-title">Sieben Grundelemente</span>
          </div>
          <div>
            {ctx.grundelemente.map((g) => (
              <Link
                key={g.key}
                href={mitStand(
                  `${basis}/${g.key === 'risiken' ? 'risiken' : g.key === 'programm' ? 'kontrollen' : g.key === 'ueberwachung' ? 'feststellungen' : 'beschreibung'}`,
                )}
                className="list-row"
                style={{ textDecoration: 'none', padding: '9px 16px' }}
                title={g.luecken.join('\n') || 'dokumentiert'}
              >
                <span
                  className={`icon-ring ${g.luecken.length ? 'amber' : 'green'}`}
                  style={{ width: 26, height: 26 }}
                >
                  <Icon name={GE_ICON[g.key] ?? 'Circle'} className="tx-icon-xs" />
                </span>
                <span className="text-sm grow">{g.titel}</span>
                {g.luecken.length ? (
                  <span className="badge-yellow shrink0">Lücken ({g.luecken.length})</span>
                ) : (
                  <span className="text-11 text-muted shrink0">dokumentiert</span>
                )}
              </Link>
            ))}
          </div>
        </div>

        <div className="card gc-8">
          <div className="card-header">
            <span className="card-title">Risiken — {ctx.risiken.length} aktiv</span>
            {ueberAppetit > 0 ? (
              <Link
                href={mitStand(`${basis}/risiken?appetit=1`)}
                className="badge-red"
                style={{ textDecoration: 'none' }}
              >
                {ueberAppetit} über Appetit
              </Link>
            ) : (
              <span className="badge-green">kein Risiko über Appetit</span>
            )}
          </div>
          <div className="p-4">
            <RiskHeatmap
              basis={`${basis}/risiken`}
              risiken={ctx.risiken.map((r) => ({
                code: r.code,
                titel: r.titel,
                s: r.s,
                w: r.w,
                brutto: r.bewertung.brutto.klasse,
                design: r.bewertung.wirksamDesign,
                betrieb: r.bewertung.wirksamBetrieb,
              }))}
            />
          </div>
          {last ? (
            <div
              style={{
                borderTop: '1px solid rgb(var(--border-default))',
                padding: '14px 24px 16px',
              }}
            >
              <div className="text-xs font-s text-secondary mb-2">
                Manuelle Prüflast · {lastMonat} (Prognose aus geplanten Durchführungen)
              </div>
              <BarRows
                zeilen={[
                  { label: 'FP · periodisch', wert: last.FP },
                  { label: 'FF · laufend', wert: last.FF, farbe: 'a' },
                  { label: 'IN · Aufklärung', wert: last.IN, farbe: 'muted' },
                  ...(last.ausloesungen
                    ? [{ label: 'Auslösungen', wert: last.ausloesungen, farbe: 'v' as const }]
                    : []),
                ]}
              />
            </div>
          ) : null}
        </div>
      </div>

      {/* Reihe 2 */}
      <div className="g12 mt-4">
        <div className="card gc-4">
          <div className="card-header">
            <span className="card-title">Wirksamkeitszeitraum</span>
            {zr ? (
              <span className="badge-gray">
                {zr.monat === 0 && ctx.programm.wirksamAb
                  ? `beginnt ${fmtDatum(ctx.programm.wirksamAb)}`
                  : ctx.programm.wirksamBis &&
                      ctx.stand.getTime() > ctx.programm.wirksamBis.getTime()
                    ? `abgeschlossen · ${zr.monate} Monate`
                    : `Monat ${zr.monat} von ${zr.monate}`}
              </span>
            ) : (
              <span className="badge-gray">nicht festgelegt</span>
            )}
          </div>
          {zr && ctx.programm.wirksamAb && ctx.programm.wirksamBis ? (
            <>
              <div className="p-4">
                <div className="row-between mb-2">
                  <span className="text-sm text-secondary">
                    {fmtDatumKurz(ctx.programm.wirksamAb)} – {fmtDatum(ctx.programm.wirksamBis)}
                  </span>
                </div>
                <div className="progress">
                  <div
                    className="fill"
                    style={{ width: `${Math.round((zr.monat / zr.monate) * 100)}%` }}
                  />
                </div>
                <div className="mt-4">
                  <Donut
                    mitte={String(zr.ohneBefund)}
                    unter={`von ${zr.relevante} ohne Befund`}
                    teile={[
                      {
                        wert: zr.ohneBefund,
                        farbe: '#10b981',
                        label: 'abgeschlossen – ohne Befund',
                      },
                      { wert: zr.mitBefund, farbe: '#f59e0b', label: 'abgeschlossen – mit Befund' },
                      { wert: zr.offen, farbe: 'rgb(var(--brand-500))', label: 'offen' },
                    ]}
                  />
                </div>
                <div className="row-wrap mt-4 text-xs text-secondary" style={{ gap: 12 }}>
                  <span className="row-s">
                    <span
                      className={`status-dot ${zr.ohneGegenzeichnung ? 'dot-amber' : 'dot-gray'}`}
                    />{' '}
                    {zr.ohneGegenzeichnung} ohne Gegenzeichnung
                  </span>
                  <span className="row-s">
                    <span className={`status-dot ${zr.ueberfaellig ? 'dot-red' : 'dot-gray'}`} />{' '}
                    {zr.ueberfaellig} überfällig
                  </span>
                  <span className="row-s">
                    <span
                      className={`status-dot ${zr.fehlendeNachweise ? 'dot-red' : 'dot-gray'}`}
                    />{' '}
                    {zr.fehlendeNachweise} fehlende Nachweise
                  </span>
                </div>
              </div>
              <div className="card-footer">
                <Link href={mitStand(`${basis}/kontrollen`)} className="text-muted">
                  Kontrollmatrix →
                </Link>
                <span>seit {fmtDatum(ctx.programm.wirksamAb)}</span>
              </div>
            </>
          ) : (
            <div className="p-4 text-sm text-muted">
              Der Wirksamkeitszeitraum beginnt nach dokumentierter Angemessenheit (Phase 5).
            </div>
          )}
        </div>

        <div className="card gc-8">
          <div className="card-header">
            <span className="card-title">Fällige Kontrollen</span>
            <Link
              href={mitStand(`${basis}/kontrollen`)}
              className="text-xs text-muted"
              style={{ textDecoration: 'none' }}
            >
              Kontrollmatrix →
            </Link>
          </div>
          {faellige.length === 0 ? (
            <Leerzustand icon="CheckCheck" text="In den nächsten 14 Tagen ist nichts fällig." />
          ) : (
            <div className="tbl-scroll">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Kontrolle</th>
                    <th>Periode</th>
                    <th>Fälligkeit</th>
                    <th>Partei</th>
                    <th>Status</th>
                    <th className="td-num">Zuständig</th>
                  </tr>
                </thead>
                <tbody>
                  {faellige.slice(0, 8).map((d) => {
                    const tage = tageZwischen(ctx.stand, d.faelligAm);
                    return (
                      <tr key={d.id}>
                        <td>
                          <Link
                            href={mitStand(`${basis}/durchfuehrungen/${d.id}`)}
                            className="text-sm font-m"
                            style={{ textDecoration: 'none' }}
                          >
                            {d.code} · {d.titel}
                          </Link>
                        </td>
                        <td className="text-sm text-secondary">{d.periodeLabel}</td>
                        <td>
                          <span
                            className="text-sm"
                            style={d.anzeige === 'UEBERFAELLIG' ? { color: '#b42318' } : undefined}
                          >
                            {fmtDatum(d.faelligAm)} · {relativTage(tage)}
                          </span>
                        </td>
                        <td>
                          <span className="badge-gray">{PARTEI_LABEL[d.partei]}</span>
                        </td>
                        <td>
                          <StatusBadge status={d.anzeige} />
                        </td>
                        <td className="td-num text-xs text-muted">
                          {personKurzname(
                            ctx,
                            d.anzeige === 'ZUR_GEGENZEICHNUNG'
                              ? d.gegenzeichnerId
                              : d.durchfuehrendId,
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <div className="card-footer">
            <span>{zr?.ohneGegenzeichnung ?? 0} Durchführungen warten auf Gegenzeichnung.</span>
            <span>{faellige.length > 8 ? `${faellige.length - 8} weitere` : ''}</span>
          </div>
        </div>
      </div>

      {/* Reihe 3 */}
      <div className="g12 mt-4">
        <div className="card gc-4">
          <div className="card-header">
            <span className="card-title">Offene Feststellungen</span>
            <Link
              href={mitStand(`${basis}/feststellungen`)}
              className="badge-gray"
              style={{ textDecoration: 'none' }}
            >
              {offeneF.length}
            </Link>
          </div>
          {offeneF.length === 0 ? (
            <Leerzustand icon="CheckCheck" text="Keine offenen Feststellungen." />
          ) : (
            <div>
              {offeneF.map((f) => (
                <Link
                  key={f.id}
                  href={mitStand(`${basis}/feststellungen/${f.id}`)}
                  className="list-row"
                  style={{ textDecoration: 'none' }}
                >
                  <span
                    className={`kpi-chip ${f.schwere === 'HOCH' || f.schwere === 'KRITISCH' ? 'chip-red' : 'chip-amber'}`}
                  >
                    <Icon name={f.p153Offen ? 'Flame' : 'FileCheck'} />
                  </span>
                  <div className="grow">
                    <div className="text-sm font-m">
                      {f.nummer} · {f.titel}
                    </div>
                    <div className="text-11 text-muted mt-1">
                      {KLASSE_LABEL[f.schwere]} ·{' '}
                      {f.p153Offen
                        ? '§-153-Würdigung offen'
                        : f.p153Entscheidung
                          ? `entschieden: ${P153_LABEL[f.p153Entscheidung]}`
                          : 'ohne §-153-Bezug'}{' '}
                      · Quelle {f.quelleText}
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>

        <div className="card gc-4">
          <div className="card-header">
            <span className="card-title">Ereigniseingang</span>
            <Link
              href={mitStand(`${basis}/ereignisse`)}
              className={neueE.length ? 'badge-yellow' : 'badge-gray'}
              style={{ textDecoration: 'none' }}
            >
              {neueE.length} ungetriagiert
            </Link>
          </div>
          {neueE.length === 0 ? (
            <Leerzustand icon="Inbox" text="Keine ungetriagierten Ereignisse." />
          ) : (
            <div>
              {neueE.map((e) => {
                const t = ereignistyp(e.typ);
                return (
                  <Link
                    key={e.id}
                    href={mitStand(`${basis}/ereignisse?e=${e.id}`)}
                    className="list-row"
                    style={{ textDecoration: 'none' }}
                  >
                    <span className={`icon-ring ${ICON_RING_TON[t?.ton ?? 'brand']}`}>
                      <Icon name={t?.icon ?? 'Bell'} />
                    </span>
                    <div className="grow">
                      <div className="text-sm font-m">
                        {e.typ} · {e.titel}
                      </div>
                      <div className="text-11 text-muted mt-1">
                        {EREIGNIS_QUELLE_LABEL[e.quelle]} · {personKurzname(ctx, e.gemeldetVon)} ·{' '}
                        {fmtDatum(e.gemeldetAm)}
                      </div>
                    </div>
                    <span className="badge-brand">neu</span>
                  </Link>
                );
              })}
            </div>
          )}
        </div>

        <div className="card gc-4">
          <div className="card-header">
            <span className="card-title">Länder-Kurzblick</span>
            <Link
              href={mitStand(`${basis}/laender`)}
              className="text-xs text-muted"
              style={{ textDecoration: 'none' }}
            >
              Alle {ctx.laender.length} Länder →
            </Link>
          </div>
          <div className="p-4">
            <div className="text-xs font-s text-secondary mb-1">
              EU-Fernverkäufe laufendes Jahr
              {ctx.laenderStand
                ? ` (${ctx.laenderQuelle === 'CSV' ? 'CSV-Import' : 'manuell erfasst'}, Stand ${fmtDatum(ctx.laenderStand)})`
                : ''}
            </div>
            <div className="row-between mb-1">
              <span className="text-lg font-b mono">{fmtEurGanz(ctx.fernverkaeufeLfd)}</span>
              <span
                className={
                  ctx.schwelle.status === 'UEBERSCHRITTEN'
                    ? 'badge-red'
                    : ctx.schwelle.status === 'WARNUNG'
                      ? 'badge-yellow'
                      : 'badge-green'
                }
              >
                {ctx.schwelle.label}
              </span>
            </div>
            <SchwellenGauge anteil={Math.max(ctx.schwelle.anteilLfd, ctx.schwelle.anteilVorjahr)} />
            <div className="text-11 text-muted mt-1">
              {ctx.profil?.p9.ossSeit
                ? `OSS seit ${ctx.profil.p9.ossSeit.slice(5, 7)}/${ctx.profil.p9.ossSeit.slice(0, 4)}`
                : 'kein OSS'}{' '}
              · Schwelle 10.000 € (vgl. § 3c Abs. 4 UStG)
            </div>
          </div>
          <div>
            <div
              className="row-between p-3"
              style={{ borderTop: '1px solid rgb(var(--border-default))' }}
            >
              <span className="row-s">
                <span
                  className={`status-dot ${fehltRegistrierung.length ? 'dot-amber' : 'dot-green'}`}
                />
                <span className="text-sm">{ctx.laender.length} Länder im Monitor</span>
              </span>
              <span className="text-11 text-muted">
                {ctx.laender.filter((l) => l.registrierung === 'VOLLSTAENDIG').length} vollständig
              </span>
            </div>
            {fehltRegistrierung.map((l) => (
              <Link
                key={l.id}
                href={mitStand(`${basis}/laender`)}
                className="row-between p-3"
                style={{
                  borderTop: '1px solid rgb(var(--border-default))',
                  textDecoration: 'none',
                }}
              >
                <span className="row-s">
                  <span className="status-dot dot-red" />
                  <span className="text-sm font-m">
                    {l.land} · Lager seit{' '}
                    {l.lagerSeit ? `${l.lagerSeit.slice(5, 7)}/${l.lagerSeit.slice(0, 4)}` : '—'}
                  </span>
                </span>
                <span className="badge-red">Registrierung fehlt</span>
              </Link>
            ))}
          </div>
        </div>
      </div>
      <p className="text-11 text-muted mt-6">
        Frequenzen folgen aus Governance-Typ × Bruttoklasse (Startwerte, vom Berufsträger zu
        kalibrieren). Statusangaben sind Betriebsinformationen, keine Aussage über Angemessenheit
        oder Wirksamkeit. Länder:{' '}
        {ctx.laender
          .map((l) => LAND_NAME[l.land] ?? l.land)
          .slice(0, 3)
          .join(', ')}
        {ctx.laender.length > 3 ? ' …' : ''} ·{' '}
        {frequenzLabel({ turnus: ctx.programm.erklaerungsTurnus, anlass: false })}{' '}
        erklärungspflichtig.
      </p>
    </>
  );
}

const GE_ICON: Record<string, string> = {
  kultur: 'Landmark',
  ziele: 'Flag',
  risiken: 'TriangleAlert',
  programm: 'SquareCheckBig',
  organisation: 'Users',
  kommunikation: 'MessagesSquare',
  ueberwachung: 'Route',
};
