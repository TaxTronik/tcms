import Link from 'next/link';
import { fmtDatum, fmtDatumZeit, frequenzLabel, MONATE } from '@tcms/domain';
import { Icon, type IconName } from '@/components/icon';
import { Hash } from '@/components/ui/badges';
import { Disclaimer } from '@/components/ui/disclaimer';
import { Leerzustand } from '@/components/ui/leer';
import { ZeitraumLeiste } from '@/components/ui/visual';
import { TcmsKopf } from '@/components/tcms/kopf';
import { personName } from '@/server/kontext';
import { ladeStaffSeite } from '@/server/seite';

export const metadata = { title: 'Prüfungsvorbereitung' };

const GE_ICON: Record<string, IconName> = {
  kultur: 'Landmark',
  ziele: 'Flag',
  risiken: 'TriangleAlert',
  programm: 'SquareCheckBig',
  organisation: 'Users',
  kommunikation: 'MessagesSquare',
  ueberwachung: 'Route',
};
const GE_LINK: Record<string, string> = {
  risiken: 'risiken',
  programm: 'kontrollen',
  ueberwachung: 'feststellungen',
  ziele: 'profil',
};
const TD = { padding: '10px 14px' } as const;

export default async function Pruefung({
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
            icon="FileSearch"
            text="Für diesen Mandanten ist noch kein Tax-CMS eingerichtet."
          />
        </div>
      </>
    );
  }

  const p = ctx.programm;
  const zr = ctx.zeitraum;
  const ende = ctx.stand.getTime() + 86_399_999;
  const stichtag =
    p.angemessenheitStichtag && p.angemessenheitStichtag.getTime() <= ende
      ? p.angemessenheitStichtag
      : null;

  // ---- Durchführungen im Wirksamkeitszeitraum ----
  // Zahlen und Regeln (Fälligkeit im Zeitraum + 60 Tage Nachlauf) rechnet der
  // Service im Kontext (`zeitraum`); die Seite zeigt sie nur an.
  const abgeschlossen = (zr?.ohneBefund ?? 0) + (zr?.mitBefund ?? 0);
  const zeitraumBegonnen = !!p.wirksamAb && p.wirksamAb.getTime() <= ende;

  // ---- Lückenanalyse ----
  // Wiederkehrende Kontrollen ohne jede (auch geplante) Durchführung mit Fälligkeit im Zeitraum.
  const ohneDurchfuehrung = (zr?.ohneDurchfuehrung ?? []).flatMap((code) =>
    ctx.kontrollen.filter((k) => k.code === code),
  );
  const ueberfaellig = ctx.durchfuehrungen.filter((d) => d.anzeige === 'UEBERFAELLIG').length;
  // Schwere und §-153 nur aus lesbaren Feststellungen (RT-01: maskierte ohne Inhalt).
  const hochOffen = ctx.feststellungen.filter(
    (f) =>
      !f.maskiert &&
      (f.schwere === 'HOCH' || f.schwere === 'KRITISCH') &&
      f.status !== 'GESCHLOSSEN' &&
      f.status !== 'VERWORFEN',
  ).length;
  const freigegeben = ctx.beschreibungen.filter(
    (b) => b.freigegebenAm && b.freigegebenAm.getTime() <= ende,
  );
  const risikenOhneFreigabe = ctx.risiken.filter((r) => r.freigabe !== 'FREIGEGEBEN').length;
  const ohneDesign = ctx.kontrollen.filter((k) => k.design === 'NICHT_BEURTEILT').length;
  const p153 = ctx.feststellungen.filter((f) => !f.maskiert && f.p153Offen).length;

  const luecken: {
    text: string;
    n: number;
    href: string;
    title?: string;
    nurZeitraum?: boolean;
    ton?: 'red' | 'amber';
  }[] = [
    {
      text: 'Kontrollen ohne Durchführung im Zeitraum (auch keine geplante)',
      n: ohneDurchfuehrung.length,
      href: 'kontrollen',
      title:
        ohneDurchfuehrung
          .map((k) => `${k.code} · ${k.titel} (${frequenzLabel(k.frequenz)})`)
          .join('\n') || undefined,
      nurZeitraum: true,
    },
    {
      text: 'Durchführungen ohne ausreichende Nachweise',
      n: zr?.fehlendeNachweise ?? 0,
      href: 'kontrollen',
      nurZeitraum: true,
      ton: 'red',
    },
    {
      text: 'Durchführungen ohne Gegenzeichnung',
      n: zr?.ohneGegenzeichnung ?? 0,
      href: 'kontrollen',
      nurZeitraum: true,
    },
    { text: 'Überfällige Durchführungen', n: ueberfaellig, href: 'kontrollen', ton: 'red' },
    {
      text: 'Offene Feststellungen hoch/kritisch',
      n: hochOffen,
      href: 'feststellungen',
      ton: 'red',
    },
    { text: 'Offene §-153-Würdigungen', n: p153, href: 'feststellungen', ton: 'red' },
    {
      text: 'CMS-Beschreibung nicht freigegeben',
      n: freigegeben.length ? 0 : 1,
      href: 'beschreibung',
    },
    { text: 'Risiken ohne Freigabe', n: risikenOhneFreigabe, href: 'risiken' },
    { text: 'Kontrollen ohne Designbeurteilung', n: ohneDesign, href: 'kontrollen' },
  ];
  const lueckenGesamt = luecken
    .filter((l) => !(l.nurZeitraum && !zeitraumBegonnen))
    .reduce((s, l) => s + (l.n > 0 ? 1 : 0), 0);

  // ---- Zeitraumleiste ----
  let leiste: { monate: string[]; aktuell: number } | null = null;
  if (p.wirksamAb && p.wirksamBis) {
    const n =
      (p.wirksamBis.getUTCFullYear() - p.wirksamAb.getUTCFullYear()) * 12 +
      p.wirksamBis.getUTCMonth() -
      p.wirksamAb.getUTCMonth() +
      1;
    const monate = Array.from({ length: n }, (_, i) => {
      const d = new Date(
        Date.UTC(p.wirksamAb!.getUTCFullYear(), p.wirksamAb!.getUTCMonth() + i, 1),
      );
      return `${MONATE[d.getUTCMonth()]!.slice(0, 3)} ${String(d.getUTCFullYear()).slice(2)}`;
    });
    const aktuell =
      ctx.stand.getTime() < p.wirksamAb.getTime()
        ? 0
        : ctx.stand.getTime() > p.wirksamBis.getTime()
          ? n + 1
          : (zr?.monat ?? 0);
    leiste = { monate, aktuell };
  }
  const wirksamkeitAktiv = ctx.aktivePhase >= 6;

  return (
    <>
      <TcmsKopf seite={seite} />
      <Disclaimer />

      <div className="g12 mt-4" style={{ alignItems: 'start' }}>
        <div className="card gc-8" style={{ overflow: 'hidden' }}>
          <div className="card-header">
            <span className="card-title">Prüfungsgegenstand</span>
            <span className="text-xs text-muted">{ctx.teilbereich?.name ?? '—'}</span>
          </div>
          <div className="g12 p-4" style={{ gap: 12 }}>
            <div
              className={`gc-6 stage ${!wirksamkeitAktiv && stichtag ? 'active' : stichtag ? 'done' : ''}`}
              style={{ border: '1px solid rgb(var(--border-default))', borderRadius: 10 }}
            >
              <div className="stage-head">
                <span className="num">1</span>
                <div>
                  <div className="stage-title">Angemessenheit zum Stichtag</div>
                  <div className="stage-sub">Design und Implementierung zu einem Zeitpunkt</div>
                </div>
              </div>
              <div className="stage-body">
                <div className="text-xs text-muted">Stichtag</div>
                <div className="text-lg font-b mono">{stichtag ? fmtDatum(stichtag) : '—'}</div>
                <div className="text-11 text-muted mt-1">
                  {freigegeben.length
                    ? `Beschreibung v${freigegeben.at(-1)!.nummer} freigegeben ${fmtDatum(freigegeben.at(-1)!.freigegebenAm)}`
                    : 'noch keine freigegebene Beschreibung'}
                </div>
              </div>
            </div>
            <div
              className={`gc-6 stage ${wirksamkeitAktiv && zeitraumBegonnen ? 'active' : ''}`}
              style={{ border: '1px solid rgb(var(--border-default))', borderRadius: 10 }}
            >
              <div className="stage-head">
                <span className="num">2</span>
                <div>
                  <div className="stage-title">Wirksamkeit über Zeitraum</div>
                  <div className="stage-sub">gelebte Kontrollen über den Wirksamkeitszeitraum</div>
                </div>
              </div>
              <div className="stage-body">
                <div className="text-xs text-muted">Zeitraum</div>
                <div className="text-lg font-b mono">
                  {p.wirksamAb && p.wirksamBis
                    ? `${fmtDatum(p.wirksamAb)} – ${fmtDatum(p.wirksamBis)}`
                    : '—'}
                </div>
                <div className="text-11 text-muted mt-1">
                  {zr && zeitraumBegonnen
                    ? `Monat ${Math.min(zr.monat, zr.monate)} von ${zr.monate}`
                    : p.wirksamAb
                      ? `beginnt ${fmtDatum(p.wirksamAb)}`
                      : 'nicht festgelegt (Vorschlag: sechs Monate)'}
                </div>
              </div>
            </div>
          </div>
          {leiste ? (
            <div className="px-4" style={{ paddingBottom: 16 }}>
              {/* ZeitraumLeiste hat ein festes 6-Spalten-Raster; andere Längen werden hier mit denselben Klassen gerendert. */}
              {leiste.monate.length === 6 ? (
                <ZeitraumLeiste monate={leiste.monate} aktuell={leiste.aktuell} />
              ) : (
                <div
                  className="tl"
                  style={{ gridTemplateColumns: `repeat(${leiste.monate.length}, 1fr)` }}
                >
                  {leiste.monate.map((m, i) => (
                    <div
                      key={m}
                      className={`tl-seg ${i + 1 < leiste!.aktuell ? 'done' : i + 1 === leiste!.aktuell ? 'now' : ''}`}
                    >
                      <span className="text-xs font-s">{m}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : null}
          <div className="card-footer">
            <span>Prüfer (Freitext) und Prüfungsart werden mit dem Nachweispaket erfasst.</span>
            <span>Phase {ctx.aktivePhase} von 7</span>
          </div>
        </div>

        <div className="card gc-4" style={{ overflow: 'hidden' }}>
          <div className="card-header">
            <span className="card-title">Nachweispaket</span>
            <span className="badge-gray">Ausbaustufe B</span>
          </div>
          <div className="p-4">
            <ul
              className="text-xs text-secondary"
              style={{ paddingLeft: 18, lineHeight: 1.75, margin: 0 }}
            >
              <li>Index mit Hashes (ZIP und PDF-Index)</li>
              <li>freigegebene Beschreibungsversion</li>
              <li>Risikoinventar und Kontrollmatrix zum Stichtag</li>
              <li>Durchführungen mit Nachweisen</li>
              <li>Feststellungen und Maßnahmen</li>
              <li>Audit-Auszug mit Prüfung der Hashkette</li>
            </ul>
            <div className="mt-4">
              <button
                type="button"
                className="btn-primary w-full"
                disabled
                title="Folgt in Ausbaustufe B"
              >
                <Icon name="Download" /> Nachweispaket erzeugen
              </button>
            </div>
            <p className="hint text-11 text-muted mt-2">
              Export durch Berufsträger oder Admin; der Export wird protokolliert. Lücken blockieren
              den Export nicht, sie erscheinen im Paket.
            </p>
          </div>
        </div>
      </div>

      <div className="g12 mt-4" style={{ alignItems: 'start' }}>
        <div className="card gc-6" style={{ overflow: 'hidden' }}>
          <div className="card-header">
            <span className="card-title">Lückenanalyse</span>
            {lueckenGesamt ? (
              <span className="badge-yellow">Lücken ({lueckenGesamt})</span>
            ) : (
              <span className="badge-green">dokumentiert</span>
            )}
          </div>
          <div>
            {luecken.map((l) => {
              const na = l.nurZeitraum && !zeitraumBegonnen;
              const dot = na
                ? 'dot-gray'
                : l.n === 0
                  ? 'dot-green'
                  : l.ton === 'red'
                    ? 'dot-red'
                    : 'dot-amber';
              return (
                <Link
                  key={l.text}
                  href={mitStand(`${basis}/${l.href}`)}
                  className="list-row unstyled"
                  title={l.title}
                  style={{ alignItems: 'center', padding: '10px 16px' }}
                >
                  <span className={`status-dot ${dot}`} />
                  <span className={`text-sm grow${na || l.n === 0 ? ' text-secondary' : ''}`}>
                    {l.text}
                  </span>
                  <span
                    className={`mono text-sm ${na ? 'text-muted' : l.n ? 'font-s' : 'text-muted'}`}
                  >
                    {na ? 'n. a.' : l.n}
                  </span>
                  <Icon name="ChevronRight" className="tx-icon-xs text-muted" />
                </Link>
              );
            })}
          </div>
          <div className="card-footer">
            <span>
              Zählung zum Stand {fmtDatum(ctx.stand)}; „n. a.", solange der Wirksamkeitszeitraum
              nicht begonnen hat.
            </span>
          </div>
        </div>

        <div className="card gc-6" style={{ overflow: 'hidden' }}>
          <div className="card-header">
            <span className="card-title">Sieben Grundelemente</span>
          </div>
          <div>
            {ctx.grundelemente.map((g) => (
              <Link
                key={g.key}
                href={mitStand(`${basis}/${GE_LINK[g.key] ?? 'beschreibung'}`)}
                className="list-row unstyled"
                style={{ padding: '9px 16px' }}
                title={g.luecken.join('\n') || 'dokumentiert'}
              >
                <span
                  className={`icon-ring ${g.luecken.length ? 'amber' : 'green'}`}
                  style={{ width: 26, height: 26 }}
                >
                  <Icon name={GE_ICON[g.key] ?? 'Circle'} className="tx-icon-xs" />
                </span>
                <div className="grow">
                  <div className="text-sm">{g.titel}</div>
                  {g.luecken.length ? (
                    <div className="text-11 text-muted mt-1">{g.luecken.join(' · ')}</div>
                  ) : null}
                </div>
                {g.luecken.length ? (
                  <span className="badge-yellow shrink0">Lücken ({g.luecken.length})</span>
                ) : (
                  <span className="text-11 text-muted shrink0">dokumentiert</span>
                )}
              </Link>
            ))}
          </div>
        </div>
      </div>

      <div className="g12 mt-4" style={{ alignItems: 'start' }}>
        <div className="card gc-7" style={{ overflow: 'hidden' }}>
          <div className="card-header">
            <span className="card-title">Freigegebene Beschreibungsversionen</span>
            <Link href={mitStand(`${basis}/beschreibung`)} className="text-xs text-muted unstyled">
              CMS-Beschreibung →
            </Link>
          </div>
          {freigegeben.length === 0 ? (
            <Leerzustand
              icon="FileText"
              text="Noch keine Version durch die gesetzlichen Vertreter freigegeben."
            />
          ) : (
            <div className="tbl-scroll">
              <table className="tbl">
                <thead>
                  <tr>
                    <th style={TD}>Version</th>
                    <th style={TD}>Freigegeben</th>
                    <th style={TD}>Snapshot</th>
                  </tr>
                </thead>
                <tbody>
                  {freigegeben
                    .map((b, i) => ({ b, abgeloest: i < freigegeben.length - 1 }))
                    .reverse()
                    .map(({ b, abgeloest }) => (
                      <tr key={b.id}>
                        <td style={TD}>
                          <span className="text-sm font-m">v{b.nummer}</span>{' '}
                          <span className={abgeloest ? 'badge-gray' : 'badge-green'}>
                            {abgeloest ? 'abgelöst' : 'freigegeben'}
                          </span>
                        </td>
                        <td style={TD}>
                          <div className="text-sm">{personName(ctx, b.freigegebenVon)}</div>
                          <div className="text-11 text-muted">{fmtDatumZeit(b.freigegebenAm)}</div>
                        </td>
                        <td style={TD}>
                          {b.snapshotSha256 ? (
                            <span className="badge-gray" title={`SHA-256 ${b.snapshotSha256}`}>
                              <Icon name="Lock" className="tx-icon-xs" />{' '}
                              <Hash wert={b.snapshotSha256} />
                            </span>
                          ) : (
                            <span className="text-11 text-muted">kein Snapshot</span>
                          )}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="card-footer">
            <span>Ein Hash bindet Inhalte, er authentifiziert keine Person.</span>
          </div>
        </div>

        <div className="card gc-5" style={{ overflow: 'hidden' }}>
          <div className="card-header">
            <span className="card-title">Durchführungen im Zeitraum</span>
          </div>
          {p.wirksamAb && p.wirksamBis ? (
            <div className="p-4">
              <div
                className="mini-kpis"
                style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' }}
              >
                <div className="mini-kpi">
                  <div className="v">{zr?.relevante ?? 0}</div>
                  <div className="l">fällig gewordene Durchführungen</div>
                </div>
                <div className="mini-kpi">
                  <div className="v">{abgeschlossen}</div>
                  <div className="l">abgeschlossen und gegengezeichnet</div>
                </div>
                <div className="mini-kpi">
                  <div className="v">{zr?.ohneBefund ?? 0}</div>
                  <div className="l">abgeschlossen – ohne Befund</div>
                </div>
                <div className="mini-kpi">
                  <div className="v">{zr?.mitBefund ?? 0}</div>
                  <div className="l">abgeschlossen – mit Befund</div>
                </div>
                <div className="mini-kpi">
                  <div className="v">{zr?.nachweise ?? 0}</div>
                  <div className="l">Nachweise dokumentiert</div>
                </div>
                <div className="mini-kpi">
                  <div className="v">{zr?.entfallen ?? 0}</div>
                  <div className="l">entfallen (zählen nicht als ohne Befund)</div>
                </div>
              </div>
              <p className="text-11 text-muted mt-3">
                Ein Kontrollergebnis ist die Angabe der durchführenden Person; die Gegenzeichnung
                belegt die Vier-Augen-Handlung, nicht die materielle Richtigkeit.
              </p>
            </div>
          ) : (
            <Leerzustand
              icon="CalendarRange"
              text="Der Wirksamkeitszeitraum ist noch nicht festgelegt."
            />
          )}
        </div>
      </div>
    </>
  );
}
