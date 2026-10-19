import {
  AUSFUEHRUNG_LABEL,
  BEWERTUNGSMODELL_VERSION,
  brutto,
  EREIGNISTYPEN,
  fmtEur,
  FOLGE_LABEL,
  GOVERNANCE_LABEL,
  GRUPPE_LABEL,
  KATALOG_KONTROLLEN,
  KATALOG_RISIKEN,
  KERN_RISIKEN,
  klasseAusScore,
  kontrollenFuerRisiko,
  KONTROLLART_LABEL,
  MATRIX_ZEILEN,
  NORMSTUFE_BADGE,
  NORMSTUFE_LABEL,
  PAKET,
  PARTEI_LABEL,
  PROFIL_FRAGEN,
  REICHWEITE_LABEL,
  SCHADEN_LABEL,
  SCHAEDEN,
  score,
  WAHRSCHEINLICHKEIT_LABEL,
  WAHRSCHEINLICHKEITEN,
  type RisikoGruppe,
} from '@tcms/domain';
import { AdminKopf, LinkTabs, NurAdmin } from '@/components/admin/teile';
import { Icon } from '@/components/icon';
import { GtBadge, KlasseBadge } from '@/components/ui/badges';
import { brauchtKanzlei } from '@/server/sitzung';

export const metadata = { title: 'Tax-CMS-Katalog' };

type Tab = 'risiken' | 'kontrollen' | 'ereignisse' | 'matrix' | 'profil';
const TABS: [Tab, string, number?][] = [
  ['risiken', 'Risiken', KATALOG_RISIKEN.length],
  ['kontrollen', 'Kontrollen', KATALOG_KONTROLLEN.length],
  ['ereignisse', 'Ereignistypen', EREIGNISTYPEN.length],
  ['matrix', 'Häufigkeitsmatrix & Bewertung'],
  ['profil', 'Profilfragen', PROFIL_FRAGEN.length],
];
const RING: Record<string, string> = {
  brand: 'brand',
  violet: 'violet',
  amber: 'amber',
  red: 'red',
  green: 'green',
};
const W_KURZ: Record<string, string> = {
  SELTEN: 'selten',
  MOEGLICH: 'möglich',
  WAHRSCHEINLICH: 'wahrsch.',
  HAEUFIG: 'häufig',
};
const TH = { padding: '10px 14px' } as const;
const TD = { padding: '10px 14px', verticalAlign: 'top' } as const;

export default async function Katalog({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const nutzer = await brauchtKanzlei();
  if (!nutzer.istAdmin) return <NurAdmin titel="Tax-CMS-Katalog" />;
  const sp = await searchParams;
  const roh = Array.isArray(sp['tab']) ? sp['tab'][0] : sp['tab'];
  const tab: Tab = TABS.some(([t]) => t === roh) ? (roh as Tab) : 'risiken';

  return (
    <div className="page">
      <AdminKopf
        titel="Tax-CMS-Katalog"
        unter={`Branchenpaket ${PAKET.name} v${PAKET.version} · Startfassung · nur Lesen`}
        rechts={
          <span className="row" style={{ gap: 8 }}>
            <span className="badge-yellow">Status: Entwurf (ungeprüft)</span>
            <button
              type="button"
              className="btn-secondary"
              disabled
              title="Katalogpflege (nur vorwärts, Vier-Augen-Prinzip) folgt in Ausbaustufe B"
            >
              <Icon name="Plus" className="tx-icon-xs" /> Neue Version
            </button>
          </span>
        }
      />

      <div
        className="alert-warning mb-4"
        role="note"
        style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}
      >
        <Icon name="TriangleAlert" className="tx-icon-lg" />
        <p>
          <strong>Ungeprüfter Entwurf.</strong> Katalogwerte, Normanker und die Startwerte der
          Häufigkeitsmatrix sind ungeprüfte Entwürfe und vom Berufsträger zu kalibrieren. Normanker
          tragen die Vertrauensstufe UNGEPRÜFT, bis ein Berufsträger sie freigibt; der Katalog
          ersetzt keine Einzelfallprüfung.
        </p>
      </div>

      <div className="mini-kpis mb-4" style={{ gridTemplateColumns: 'repeat(5, minmax(0, 1fr))' }}>
        <div className="mini-kpi">
          <div className="v">
            {PAKET.name} v{PAKET.version}
          </div>
          <div className="l">Paket · Status Entwurf</div>
        </div>
        <div className="mini-kpi">
          <div className="v">{KATALOG_RISIKEN.length}</div>
          <div className="l">Risiken, davon {KERN_RISIKEN.length} Kernrisiken</div>
        </div>
        <div className="mini-kpi">
          <div className="v">{KATALOG_KONTROLLEN.length}</div>
          <div className="l">
            Kontrollvorlagen, davon {KATALOG_KONTROLLEN.filter((k) => k.schluessel).length}{' '}
            Schlüssel
          </div>
        </div>
        <div className="mini-kpi">
          <div className="v">{EREIGNISTYPEN.length}</div>
          <div className="l">Ereignistypen</div>
        </div>
        <div className="mini-kpi">
          <div className="v mono">{BEWERTUNGSMODELL_VERSION}</div>
          <div className="l">Bewertungsmodell</div>
        </div>
      </div>

      <LinkTabs tabs={TABS} aktiv={tab} basis="/staff/admin/katalog" />

      {tab === 'risiken' ? <RisikenTab /> : null}
      {tab === 'kontrollen' ? <KontrollenTab /> : null}
      {tab === 'ereignisse' ? <EreignisseTab /> : null}
      {tab === 'matrix' ? <MatrixTab /> : null}
      {tab === 'profil' ? <ProfilTab /> : null}

      <p className="text-11 text-muted mt-4">
        Katalogänderungen laufen nur vorwärts im Vier-Augen-Prinzip; Mandanten erhalten eine neue
        Version als Update-Vorschlag, nie still.
      </p>
    </div>
  );
}

function Normanker({ text, stufe }: { text: string; stufe: keyof typeof NORMSTUFE_BADGE }) {
  return (
    <div className="row-s" style={{ alignItems: 'flex-start', marginBottom: 3, gap: 6 }}>
      <span
        className={`${NORMSTUFE_BADGE[stufe]} shrink0`}
        style={{ fontSize: 10.5, padding: '0 6px', marginTop: 1 }}
      >
        {NORMSTUFE_LABEL[stufe]}
      </span>
      <span className="text-xs grow">{text}</span>
    </div>
  );
}

function RisikenTab() {
  const gruppen: RisikoGruppe[] = ['UST', 'GOB', 'ERT', 'VER'];
  return (
    <div className="card" style={{ overflow: 'hidden' }}>
      <div className="tbl-scroll">
        <table className="tbl">
          <thead>
            <tr>
              <th style={TH}>ID</th>
              <th style={TH}>Fehlerquelle → Folge</th>
              <th style={TH}>Normanker (ungeprüft)</th>
              <th style={TH}>Anwendbar wenn</th>
              <th style={TH}>GT</th>
              <th style={TH}>S / W / R</th>
              <th style={TH}>Brutto</th>
              <th style={TH}>Kontrollen</th>
            </tr>
          </thead>
          <tbody>
            {gruppen.map((g) => {
              const liste = KATALOG_RISIKEN.filter((r) => r.gruppe === g);
              return [
                <tr key={`g-${g}`}>
                  <td
                    colSpan={8}
                    className="text-xs font-s text-secondary"
                    style={{ padding: '8px 14px', background: 'rgb(var(--surface-raised))' }}
                  >
                    {GRUPPE_LABEL[g]} · {liste.length}
                  </td>
                </tr>,
                ...liste.map((r) => {
                  const b = brutto(r.s, r.w, r.r);
                  return (
                    <tr key={r.code}>
                      <td style={{ ...TD, whiteSpace: 'nowrap' }}>
                        <span className="mono text-xs font-s">{r.code}</span>
                        {r.kern ? (
                          <div className="mt-1">
                            <span
                              className="badge-brand"
                              style={{ fontSize: 10.5, padding: '0 6px' }}
                            >
                              Kern
                            </span>
                          </div>
                        ) : null}
                      </td>
                      <td style={{ ...TD, minWidth: 260 }}>
                        <div className="text-sm font-m">{r.titel}</div>
                        <div className="text-11 text-muted mt-1">
                          {r.fehlerquelle} → {r.folge}
                        </div>
                        {r.wirktAuf.length ? (
                          <div className="text-11 text-muted mt-1">
                            wirkt auf {r.wirktAuf.join(', ')}
                          </div>
                        ) : null}
                      </td>
                      <td style={{ ...TD, minWidth: 210 }}>
                        {r.normanker.length ? (
                          r.normanker.map((n) => (
                            <Normanker key={n.text} text={n.text} stufe={n.stufe} />
                          ))
                        ) : (
                          <span className="text-muted">–</span>
                        )}
                      </td>
                      <td style={{ ...TD, minWidth: 130 }} className="text-xs text-secondary">
                        {r.anwendbarWenn}
                      </td>
                      <td style={TD}>
                        <GtBadge gt={r.gt} />
                      </td>
                      <td
                        style={{ ...TD, whiteSpace: 'nowrap' }}
                        className="text-xs"
                        title={`S ${SCHADEN_LABEL[r.s]} · W ${WAHRSCHEINLICHKEIT_LABEL[r.w]} · R ${REICHWEITE_LABEL[r.r]}`}
                      >
                        {r.s} / {W_KURZ[r.w]} / {r.r}
                      </td>
                      <td style={TD}>
                        <KlasseBadge klasse={b.klasse} title={b.erklaerung} />
                      </td>
                      <td style={{ ...TD, minWidth: 90 }} className="text-xs mono">
                        {kontrollenFuerRisiko(r.code)
                          .map((k) => k.code.replace('K-EC-', ''))
                          .join(', ') || '–'}
                      </td>
                    </tr>
                  );
                }),
              ];
            })}
          </tbody>
        </table>
      </div>
      <div className="card-footer">
        <span>
          S = Schadensintensität (N/M/H), W = Wahrscheinlichkeit, R = Reichweite; GT =
          Governance-Typ. Brutto berechnet mit Modell {BEWERTUNGSMODELL_VERSION}.
        </span>
        <span>Kontrollen als Nummer K-EC-nn</span>
      </div>
    </div>
  );
}

function KontrollenTab() {
  return (
    <div className="card" style={{ overflow: 'hidden' }}>
      <div className="tbl-scroll">
        <table className="tbl">
          <thead>
            <tr>
              <th style={TH}>ID</th>
              <th style={TH}>Kontrolle</th>
              <th style={TH}>Art</th>
              <th style={TH}>Ausf.</th>
              <th style={TH}>Frequenz (Vorlage)</th>
              <th style={TH}>Partei</th>
              <th style={TH}>Nachweis</th>
              <th style={TH}>Toleranz</th>
              <th style={TH}>Risiken</th>
            </tr>
          </thead>
          <tbody>
            {KATALOG_KONTROLLEN.map((k) => (
              <tr key={k.code}>
                <td style={{ ...TD, whiteSpace: 'nowrap' }}>
                  <span className="mono text-xs font-s">{k.code}</span>
                  {k.schluessel ? (
                    <div className="mt-1">
                      <span className="badge-brand" style={{ fontSize: 10.5, padding: '0 6px' }}>
                        <Icon name="KeyRound" className="tx-icon-xs" /> Schlüssel
                      </span>
                    </div>
                  ) : null}
                </td>
                <td style={{ ...TD, minWidth: 260 }}>
                  <div className="text-sm font-m">{k.titel}</div>
                  <div className="text-11 text-muted mt-1">{k.ziel}</div>
                  <div className="text-11 text-muted mt-1">
                    {k.schritte.length} Schritte
                    {k.kennzahlen.length ? ` · ${k.kennzahlen.length} Kennzahlen` : ''} · fällig{' '}
                    {k.faelligNachTagen} Tage nach Periodenende
                  </div>
                </td>
                <td style={TD} title={KONTROLLART_LABEL[k.art]}>
                  <span className="badge-gray mono">{k.art}</span>
                </td>
                <td style={TD} className="text-xs" title={AUSFUEHRUNG_LABEL[k.ausfuehrung]}>
                  {k.ausfuehrung}
                </td>
                <td style={{ ...TD, minWidth: 110 }} className="text-xs">
                  {k.frequenzText}
                </td>
                <td style={{ ...TD, minWidth: 100 }} className="text-xs">
                  {PARTEI_LABEL[k.partei]}
                  {k.review ? <div className="text-11 text-muted">{k.review}</div> : null}
                </td>
                <td style={{ ...TD, minWidth: 160 }} className="text-xs text-secondary">
                  {k.nachweis}
                  <div className="text-11 text-muted">mind. {k.mindestNachweise} Datei(en)</div>
                </td>
                <td style={{ ...TD, whiteSpace: 'nowrap' }} className="text-xs mono">
                  {k.toleranzEur != null ? fmtEur(k.toleranzEur) : '–'}
                </td>
                <td style={{ ...TD, minWidth: 110 }} className="text-xs mono">
                  {k.risiken.join(', ') || '–'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="card-footer">
        <span>
          Art: P präventiv, D detektiv, K korrigierend · Ausführung: M manuell, IT IT-gestützt, A
          automatisiert.
        </span>
        <span>Maßgeblich ist die strengere Frequenz aus Vorlage und Häufigkeitsmatrix.</span>
      </div>
    </div>
  );
}

function EreignisseTab() {
  return (
    <div className="card" style={{ overflow: 'hidden' }}>
      <div className="tbl-scroll">
        <table className="tbl">
          <thead>
            <tr>
              <th style={TH}>ID</th>
              <th style={TH}>Ereignis</th>
              <th style={TH}>Quelle Stufe 1</th>
              <th style={TH}>Folge im Modul</th>
              <th style={TH}>Vorgeschlagene Folgen (Triage)</th>
              <th style={TH}>Portal</th>
            </tr>
          </thead>
          <tbody>
            {EREIGNISTYPEN.map((e) => (
              <tr key={e.code}>
                <td style={{ ...TD, whiteSpace: 'nowrap' }}>
                  <span className="row">
                    <span
                      className={`icon-ring ${RING[e.ton] ?? 'brand'}`}
                      style={{ width: 28, height: 28 }}
                    >
                      <Icon name={e.icon} className="tx-icon-xs" />
                    </span>
                    <span className="mono text-xs font-s">{e.code}</span>
                  </span>
                </td>
                <td style={{ ...TD, minWidth: 200 }} className="text-sm font-m">
                  {e.titel}
                </td>
                <td style={{ ...TD, minWidth: 140 }} className="text-xs text-secondary">
                  {e.quelleStufe1}
                </td>
                <td style={{ ...TD, minWidth: 180 }} className="text-xs text-secondary">
                  {e.folgeText}
                </td>
                <td style={{ ...TD, minWidth: 260 }}>
                  {e.folgen.map((f, i) => (
                    <div key={i} className="text-xs" style={{ marginBottom: 3 }}>
                      <span className="font-m">{FOLGE_LABEL[f.art]}</span>
                      {f.ziel ? <span className="mono text-muted"> · {f.ziel}</span> : null}
                      <span className="text-muted"> — {f.text}</span>
                    </div>
                  ))}
                </td>
                <td style={TD} className="text-xs">
                  {e.portal ? (
                    <span className="badge-green">{e.portalLabel ?? 'ja'}</span>
                  ) : (
                    <span className="text-muted">–</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="card-footer">
        <span>
          Jedes Ereignis wird triagiert; erledigt ist es erst, wenn jede Folge erledigt oder
          begründet verworfen ist.
        </span>
      </div>
    </div>
  );
}

function MatrixTab() {
  return (
    <div className="g12" style={{ alignItems: 'start' }}>
      <div className="card gc-12" style={{ overflow: 'hidden' }}>
        <div className="card-header">
          <span className="card-title">Häufigkeitsmatrix Governance-Typ × Bruttoklasse</span>
          <span className="badge-yellow">Startwerte, zu kalibrieren</span>
        </div>
        <div className="tbl-scroll">
          <table className="tbl">
            <thead>
              <tr>
                <th style={TH}>GT</th>
                <th style={TH}>Kontrollzyklus</th>
                <th style={TH}>kritisch / hoch</th>
                <th style={TH}>mittel</th>
                <th style={TH}>gering</th>
              </tr>
            </thead>
            <tbody>
              {MATRIX_ZEILEN.map((z) => (
                <tr key={z.gt}>
                  <td style={{ ...TD, whiteSpace: 'nowrap' }}>
                    <GtBadge gt={z.gt} />{' '}
                    <span className="text-xs text-muted">
                      {GOVERNANCE_LABEL[z.gt].split(' · ')[1]}
                    </span>
                  </td>
                  <td style={{ ...TD, minWidth: 260 }} className="text-xs text-secondary">
                    {z.zyklus}
                  </td>
                  <td style={TD} className="text-sm">
                    {z.hoch}
                  </td>
                  <td style={TD} className="text-sm">
                    {z.mittel}
                  </td>
                  <td style={TD} className="text-sm">
                    {z.gering}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="card-footer">
          <span>
            Maßgeblich ist die Bruttoklasse. Hängt eine Kontrolle an mehreren Risiken, gilt die
            strengste Frequenz; eine Kontrolle unter der Matrixfrequenz braucht Begründung und
            zweite Person.
          </span>
        </div>
      </div>

      <div className="card gc-7" style={{ overflow: 'hidden' }}>
        <div className="card-header">
          <span className="card-title">
            Bewertungsmodell {BEWERTUNGSMODELL_VERSION} · Bruttoklasse S × W
          </span>
        </div>
        <div className="tbl-scroll">
          <table className="tbl">
            <thead>
              <tr>
                <th style={TH}>S \ W</th>
                {WAHRSCHEINLICHKEITEN.map((w) => (
                  <th key={w} style={TH}>
                    {WAHRSCHEINLICHKEIT_LABEL[w]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {SCHAEDEN.map((s) => (
                <tr key={s}>
                  <td style={TD} className="text-sm font-m">
                    {s} · {SCHADEN_LABEL[s]}
                  </td>
                  {WAHRSCHEINLICHKEITEN.map((w) => (
                    <td key={w} style={TD}>
                      <span className="row-s">
                        <KlasseBadge klasse={klasseAusScore(score(s, w))} />
                        <span className="text-11 text-muted mono">({score(s, w)})</span>
                      </span>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="card-footer">
          <span>
            Reichweite 3 hebt um eine Klasse, höchstens bis kritisch. Der Governance-Typ verändert
            die Klasse nicht.
          </span>
        </div>
      </div>

      <div className="card gc-5">
        <div className="card-header">
          <span className="card-title">Nettoklassen</span>
        </div>
        <div className="p-4 col text-sm" style={{ gap: 10 }}>
          <div>
            <div className="font-m">Netto (Design)</div>
            <div className="text-xs text-secondary mt-1">
              −1 Klasse bei mindestens einer zugeordneten Kontrolle mit Designbeurteilung
              „angemessen"; −2, wenn zusätzlich eine präventive und eine detektive Kontrolle
              angemessen sind oder eine präventive Schlüsselkontrolle besteht. Untergrenze gering.
            </div>
          </div>
          <div>
            <div className="font-m">Netto (Betrieb)</div>
            <div className="text-xs text-secondary mt-1">
              Wie Design, der Abschlag zählt aber nur, wenn die letzte fällige Durchführung ohne
              Befund abgeschlossen und gegengezeichnet ist. Überfällig oder mit Befund → Abschlag
              entfällt.
            </div>
          </div>
          <div>
            <div className="font-m">Übersteuerung</div>
            <div className="text-xs text-secondary mt-1">
              Begründung (mind. 30 Zeichen) und Freigabe durch eine zweite Person; der berechnete
              Wert bleibt sichtbar.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ProfilTab() {
  const gruppen = [...new Set(PROFIL_FRAGEN.map((f) => f.gruppe))];
  const bezug = (nr: string) =>
    KATALOG_RISIKEN.filter((r) => {
      const treffer: string[] = r.anwendbarWenn.match(/P\d+/g) ?? [];
      return treffer.includes(nr);
    }).map((r) => r.code);
  return (
    <div className="g12" style={{ alignItems: 'start' }}>
      {gruppen.map((g) => (
        <div key={g} className="card gc-6" style={{ overflow: 'hidden' }}>
          <div className="card-header">
            <span className="card-title">{g}</span>
          </div>
          <div>
            {PROFIL_FRAGEN.filter((f) => f.gruppe === g).map((f) => {
              const risiken = bezug(f.nr);
              return (
                <div key={f.nr} className="list-row">
                  <span className="badge-gray mono shrink0">{f.nr}</span>
                  <div className="grow">
                    <div className="text-sm font-m">{f.titel}</div>
                    <div className="text-11 text-muted mt-1">
                      {risiken.length
                        ? `Anwendbarkeit im Risikokatalog: ${risiken.join(', ')}`
                        : 'Kein direkter Bezug in der Anwendbarkeit der Katalogrisiken'}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
      <div className="card gc-12 p-4">
        <div className="text-sm font-m">Regeln für den Risikovorschlag</div>
        <ul className="text-xs text-secondary mt-2" style={{ paddingLeft: 18, lineHeight: 1.7 }}>
          <li>Kernrisiken sind immer aktiv: {KERN_RISIKEN.join(', ')}.</li>
          <li>
            Jeder Vorschlag ist deterministisch aus dem Geschäftsprofil abgeleitet und nennt seinen
            Grund; keine KI-Vorschläge.
          </li>
          <li>
            Übernehmen ist ein Klick; Ablehnen verlangt eine Begründung und wird protokolliert.
          </li>
          <li>Jede Profiländerung erzeugt eine neue Profilversion.</li>
        </ul>
      </div>
    </div>
  );
}
