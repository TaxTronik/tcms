import Link from 'next/link';
import type { CSSProperties } from 'react';
import {
  ANZEIGE_BADGE,
  ANZEIGE_LABEL,
  fmtDatum,
  frequenzLabel,
  monatSchluessel,
  PARTEI_LABEL,
  pruflast,
  type AnzeigeStatus,
  type Pruflast,
} from '@tcms/domain';
import { Icon } from '@/components/icon';
import { Leerzustand } from '@/components/ui/leer';
import { TcmsKopf } from '@/components/tcms/kopf';
import type { DurchfuehrungView } from '@/server/kontext';
import { ladeStaffSeite } from '@/server/seite';

export const metadata = { title: 'Kontrollkalender' };

type SP = Record<string, string | string[] | undefined>;
const eins = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';
const MON_KURZ = [
  'Jan',
  'Feb',
  'Mär',
  'Apr',
  'Mai',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Okt',
  'Nov',
  'Dez',
];

/** Statusfarbe des Punktes aus der Badge-Zuordnung der Domain (eine Quelle für Farben). */
function punktStil(a: AnzeigeStatus): { className: string; style?: CSSProperties } {
  const b = ANZEIGE_BADGE[a];
  if (b === 'badge-green') return { className: 'dot-green' };
  if (b === 'badge-red') return { className: 'dot-red' };
  if (b === 'badge-yellow') return { className: 'dot-amber' };
  if (b === 'badge-purple') return { className: '', style: { backgroundColor: '#7c3aed' } };
  if (b === 'badge-brand')
    return { className: '', style: { backgroundColor: 'rgb(var(--brand-600))' } };
  return { className: 'dot-gray' };
}

function monatPlus(d: Date, n: number): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
}

function Punkt({ d, href }: { d: DurchfuehrungView; href: string }) {
  const p = punktStil(d.anzeige);
  return (
    <Link
      href={href}
      title={`${d.code} · ${d.periodeLabel}${d.ausserplanmaessig ? ' (außerplanmäßig)' : ''} · ${ANZEIGE_LABEL[d.anzeige]} · fällig ${fmtDatum(d.faelligAm)}`}
      aria-label={`${d.code} ${d.periodeLabel}: ${ANZEIGE_LABEL[d.anzeige]}`}
      style={{ display: 'inline-flex', padding: 2 }}
    >
      <span
        className={`status-dot ${p.className}`}
        style={{
          width: 11,
          height: 11,
          ...p.style,
          ...(d.ausserplanmaessig
            ? { outline: '1.5px solid rgb(var(--text-muted))', outlineOffset: 1 }
            : {}),
        }}
      />
    </Link>
  );
}

export default async function Kalender({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SP>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const seite = await ladeStaffSeite(id, sp);
  const { ctx, basis, mitStand } = seite;

  if (!ctx.programm) {
    return (
      <>
        <TcmsKopf seite={seite} />
        <div className="card">
          <Leerzustand
            icon="CalendarRange"
            text="Für diesen Mandanten ist noch kein Tax-CMS eingerichtet."
          />
        </div>
      </>
    );
  }

  // ---- Zeitraum der Matrix: 12 Monate ab Wirksamkeitsbeginn bzw. Kalenderjahr ----
  const p = ctx.programm;
  const standMonat = monatPlus(ctx.stand, 0);
  const abParam = eins(sp['ab']);
  let start: Date;
  if (/^\d{4}-\d{2}$/.test(abParam)) {
    start = new Date(`${abParam}-01T00:00:00Z`);
  } else if (p.wirksamAb && monatPlus(p.wirksamAb, 12).getTime() > standMonat.getTime()) {
    start = monatPlus(p.wirksamAb, 0);
  } else {
    start = new Date(Date.UTC(ctx.stand.getUTCFullYear(), 0, 1));
  }
  const monate = Array.from({ length: 12 }, (_, i) => monatPlus(start, i));
  const schluessel = monate.map(monatSchluessel);
  const imZeitraum = (m: Date) =>
    !!p.wirksamAb &&
    !!p.wirksamBis &&
    m.getTime() >= monatPlus(p.wirksamAb, 0).getTime() &&
    m.getTime() <= monatPlus(p.wirksamBis, 0).getTime();

  // ---- Filter ----
  const partei = eins(sp['partei']);
  const nurSchluessel = eins(sp['schluessel']) === '1';
  const kontrollen = ctx.kontrollen.filter(
    (k) => (!partei || k.partei === partei) && (!nurSchluessel || k.schluessel),
  );
  const ids = new Set(kontrollen.map((k) => k.id));
  const durchf = ctx.durchfuehrungen.filter((d) => ids.has(d.kontrolleId));
  const jeZelle = new Map<string, DurchfuehrungView[]>();
  for (const d of durchf) {
    const key = `${d.kontrolleId}|${monatSchluessel(d.faelligAm)}`;
    const liste = jeZelle.get(key) ?? [];
    liste.push(d);
    jeZelle.set(key, liste);
  }
  const imFenster = durchf.filter((d) => schluessel.includes(monatSchluessel(d.faelligAm)));

  const link = (over: { ab?: string; partei?: string; schluessel?: string }) => {
    const q = new URLSearchParams();
    const ab = over.ab ?? (abParam || '');
    const pa = over.partei ?? partei;
    const sc = over.schluessel ?? (nurSchluessel ? '1' : '');
    if (ab) q.set('ab', ab);
    if (pa) q.set('partei', pa);
    if (sc) q.set('schluessel', sc);
    const s = q.toString();
    return mitStand(s ? `${basis}/kalender?${s}` : `${basis}/kalender`);
  };
  const ym = (d: Date) => monatSchluessel(d);

  // ---- Prüflast je Monat nach Governance-Typ ----
  const lastBasis = durchf.map((d) => ({
    faelligAm: d.faelligAm,
    gt: d.gt,
    ausserplanmaessig: d.ausserplanmaessig,
    entfallen: d.anzeige === 'ENTFALLEN',
  }));
  const last: Pruflast[] = schluessel.map((m) => pruflast(lastBasis, m));
  const maxLast = Math.max(1, ...last.map((l) => l.gesamt));
  const filterAktiv = !!partei || nurSchluessel;

  const ZEILEN: { key: 'FP' | 'FF' | 'IN' | 'ausloesungen'; label: string; title: string }[] = [
    { key: 'FP', label: 'FP · periodisch', title: 'periodisch an festen Zeitpunkten' },
    { key: 'FF', label: 'FF · laufend', title: 'laufend und anlassbezogen; zuzüglich Auslösungen' },
    {
      key: 'IN',
      label: 'IN · Aufklärung',
      title: 'gegengezeichnete Aufklärung statt wiederkehrender Kontrolle',
    },
    {
      key: 'ausloesungen',
      label: 'Auslösungen',
      title: 'außerplanmäßige Durchführungen aus Ereignissen',
    },
  ];

  return (
    <>
      <TcmsKopf seite={seite} />

      <div className="card mb-4 p-3">
        <div className="row-between" style={{ flexWrap: 'wrap', gap: 12 }}>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <Link
              href={link({ ab: ym(monatPlus(start, -12)) })}
              className="btn-secondary btn-tiny"
              aria-label="Zwölf Monate zurück"
            >
              <Icon name="ArrowLeft" className="tx-icon-xs" /> 12 Monate
            </Link>
            <span className="text-sm font-s" style={{ minWidth: 150, textAlign: 'center' }}>
              {MON_KURZ[monate[0]!.getUTCMonth()]} {monate[0]!.getUTCFullYear()} –{' '}
              {MON_KURZ[monate[11]!.getUTCMonth()]} {monate[11]!.getUTCFullYear()}
            </span>
            <Link
              href={link({ ab: ym(monatPlus(start, 12)) })}
              className="btn-secondary btn-tiny"
              aria-label="Zwölf Monate vor"
            >
              12 Monate <Icon name="ChevronRight" className="tx-icon-xs" />
            </Link>
            {p.wirksamAb ? (
              <Link href={link({ ab: ym(p.wirksamAb) })} className="btn-secondary btn-tiny">
                Ab Wirksamkeitsbeginn
              </Link>
            ) : null}
            <Link
              href={link({ ab: `${ctx.stand.getUTCFullYear()}-01` })}
              className="btn-secondary btn-tiny"
            >
              Kalenderjahr {ctx.stand.getUTCFullYear()}
            </Link>
          </div>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <span className="text-xs text-muted">Partei</span>
            {(
              [
                ['', 'Alle'],
                ['KANZLEI', 'Kanzlei'],
                ['MANDANT', 'Mandant'],
              ] as const
            ).map(([w, l]) => (
              <Link
                key={w || 'alle'}
                href={link({ partei: w })}
                className={`tab-pill${partei === w ? ' active' : ''}`}
              >
                {l}
              </Link>
            ))}
            <Link
              href={link({ schluessel: nurSchluessel ? '' : '1' })}
              className={`tab-pill${nurSchluessel ? ' active' : ''}`}
            >
              <Icon name="KeyRound" className="tx-icon-xs" /> nur Schlüsselkontrollen
            </Link>
          </div>
        </div>
      </div>

      <div className="card" style={{ overflow: 'hidden' }}>
        <div className="card-header">
          <span className="card-title">Kontrollkalender · {kontrollen.length} Kontrollen</span>
          <span className="text-xs text-muted">
            {imFenster.length} Durchführungen im Fenster · nach Fälligkeit
          </span>
        </div>
        {kontrollen.length === 0 ? (
          <Leerzustand icon="CalendarRange" text="Keine Kontrollen für diesen Filter." />
        ) : (
          <div className="tbl-scroll">
            <table className="tbl matrix-tbl">
              <thead>
                <tr>
                  <th className="rot" style={{ minWidth: 230 }}>
                    Kontrolle
                  </th>
                  {monate.map((m) => {
                    const jetzt = ym(m) === ym(standMonat);
                    return (
                      <th
                        key={ym(m)}
                        title={imZeitraum(m) ? 'im Wirksamkeitszeitraum' : undefined}
                        style={{
                          minWidth: 52,
                          ...(jetzt
                            ? {
                                color: 'rgb(var(--brand-700))',
                                boxShadow: 'inset 0 -2px 0 rgb(var(--brand-600))',
                              }
                            : {}),
                          ...(imZeitraum(m) && !jetzt
                            ? { backgroundColor: 'rgb(var(--brand-50))' }
                            : {}),
                        }}
                      >
                        {MON_KURZ[m.getUTCMonth()]}
                        <div className="text-11" style={{ fontWeight: 500, textTransform: 'none' }}>
                          {String(m.getUTCFullYear()).slice(2)}
                        </div>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {kontrollen.map((k) => (
                  <tr key={k.id}>
                    <td className="rot" style={{ maxWidth: 300 }}>
                      <div className="truncate" title={`${k.code} · ${k.titel}`}>
                        <Link
                          href={mitStand(`${basis}/kontrollen?kontrolle=${k.id}`)}
                          className="text-sm font-m unstyled"
                        >
                          {k.code}
                        </Link>
                        {k.schluessel ? (
                          <span
                            className="text-muted"
                            style={{ marginLeft: 4, verticalAlign: -2, display: 'inline-flex' }}
                          >
                            <Icon
                              name="KeyRound"
                              className="tx-icon-xs"
                              title="Schlüsselkontrolle"
                            />
                          </span>
                        ) : null}
                        <span className="text-xs text-secondary"> · {k.titel}</span>
                      </div>
                      <div className="row-s text-11 text-muted" style={{ marginTop: 2 }}>
                        <span className="mono font-s">{k.gt ?? '—'}</span> ·{' '}
                        {frequenzLabel(k.frequenz)} · {PARTEI_LABEL[k.partei]}
                      </div>
                    </td>
                    {monate.map((m) => {
                      const liste = jeZelle.get(`${k.id}|${ym(m)}`) ?? [];
                      return (
                        <td
                          key={ym(m)}
                          style={
                            imZeitraum(m)
                              ? { backgroundColor: 'rgb(var(--brand-50) / 0.45)' }
                              : undefined
                          }
                        >
                          {liste.length === 0 ? (
                            <span className="text-disabled text-11">·</span>
                          ) : (
                            liste.map((d) => (
                              <Punkt
                                key={d.id}
                                d={d}
                                href={mitStand(`${basis}/durchfuehrungen/${d.id}`)}
                              />
                            ))
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="card-footer" style={{ flexWrap: 'wrap', gap: 10 }}>
          <span className="row-wrap" style={{ gap: 12 }}>
            {(
              [
                'GEPLANT',
                'FAELLIG',
                'ZUR_GEGENZEICHNUNG',
                'OHNE_BEFUND',
                'MIT_BEFUND',
                'UEBERFAELLIG',
              ] as AnzeigeStatus[]
            ).map((a) => {
              const s = punktStil(a);
              return (
                <span key={a} className="row-s">
                  <span
                    className={`status-dot ${s.className}`}
                    style={{ width: 9, height: 9, ...s.style }}
                  />{' '}
                  {ANZEIGE_LABEL[a]}
                </span>
              );
            })}
            <span className="row-s">
              <span
                className="status-dot dot-gray"
                style={{
                  width: 9,
                  height: 9,
                  outline: '1.5px solid rgb(var(--text-muted))',
                  outlineOffset: 1,
                }}
              />{' '}
              außerplanmäßig
            </span>
          </span>
          {p.wirksamAb && p.wirksamBis ? (
            <span>
              Hinterlegt: Wirksamkeitszeitraum {fmtDatum(p.wirksamAb)} – {fmtDatum(p.wirksamBis)}
            </span>
          ) : null}
        </div>
      </div>

      <div className="card mt-4" style={{ overflow: 'hidden' }}>
        <div className="card-header">
          <span className="card-title">Manuelle Prüflast je Monat nach Governance-Typ</span>
          <span className="text-xs text-muted">
            {filterAktiv ? 'gefiltert · ' : ''}Durchführungen nach Fälligkeitsmonat, ohne entfallene
          </span>
        </div>
        <div className="tbl-scroll">
          <table className="tbl matrix-tbl">
            <thead>
              <tr>
                <th className="rot" style={{ minWidth: 230 }}>
                  Governance-Typ
                </th>
                {monate.map((m) => (
                  <th
                    key={ym(m)}
                    style={
                      ym(m) === ym(standMonat)
                        ? {
                            color: 'rgb(var(--brand-700))',
                            boxShadow: 'inset 0 -2px 0 rgb(var(--brand-600))',
                          }
                        : undefined
                    }
                  >
                    {MON_KURZ[m.getUTCMonth()]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ZEILEN.map((z) => (
                <tr key={z.key}>
                  <td className="rot text-sm" title={z.title}>
                    {z.label}
                  </td>
                  {last.map((l) => (
                    <td key={l.monat} className="mono text-sm">
                      {l[z.key] ? l[z.key] : <span className="text-disabled">0</span>}
                    </td>
                  ))}
                </tr>
              ))}
              <tr>
                <td className="rot text-sm font-s">Gesamt</td>
                {last.map((l) => (
                  <td key={l.monat} style={{ verticalAlign: 'bottom' }}>
                    <div className="col-s" style={{ alignItems: 'center', gap: 3 }}>
                      <span
                        className="bar-track"
                        style={{
                          width: 8,
                          height: 34,
                          display: 'flex',
                          alignItems: 'flex-end',
                          borderRadius: 4,
                          overflow: 'hidden',
                        }}
                        aria-hidden
                      >
                        <span
                          className="bar-fill"
                          style={{ width: '100%', height: `${(l.gesamt / maxLast) * 100}%` }}
                        />
                      </span>
                      <span className="mono text-sm font-s">{l.gesamt}</span>
                    </div>
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
        <div className="card-footer">
          <span>
            Frequenzen aus Governance-Typ × Bruttoklasse (Startwerte, vom Berufsträger zu
            kalibrieren). FF zuzüglich Auslösungen aus Ereignissen.
          </span>
          <span>Referenzzeile der Abgabefristen folgt mit der Steuertermin-Anbindung.</span>
        </div>
      </div>
    </>
  );
}
