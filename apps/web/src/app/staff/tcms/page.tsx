import Link from 'next/link';
import {
  ANZEIGE_LABEL,
  fmtDatum,
  fmtDatumKurz,
  fmtMonatJahr,
  isoDatum,
  KLASSE_LABEL,
  PAKET,
  PHASEN,
  type Klasse,
} from '@tcms/domain';
import { Icon } from '@/components/icon';
import { EinrichtenMenue, KpiKarte, Zahl } from '@/components/portfolio/teile';
import { Leerzustand } from '@/components/ui/leer';
import { MiniSteps } from '@/components/ui/visual';
import { KEIN_RECHT } from '@/server/aktion';
import { ladePortfolio, type PortfolioZeile } from '@/server/portfolio-daten';
import { kannBearbeiten } from '@/server/rechte';
import { brauchtKanzlei } from '@/server/sitzung';

export const metadata = { title: 'Tax-CMS-Portfolio' };

type SP = Record<string, string | string[] | undefined>;
const eins = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';

const PHASEN_KURZ = [
  'Aufbau',
  'Risikoanalyse',
  'Kontrollplanung',
  'Beschreibung',
  'Angemessenheit dok.',
  'Wirksamkeitszeitraum',
  'Prüfung & Regelbetrieb',
];
const ZELLE = { padding: '12px 10px' } as const;

export default async function Portfolio({ searchParams }: { searchParams: Promise<SP> }) {
  const nutzer = await brauchtKanzlei();
  const sp = await searchParams;
  const filter = {
    q: eins(sp['q']).trim(),
    bt: eins(sp['bt']),
    phase: eins(sp['phase']),
    ueberfaellig: eins(sp['ueberfaellig']) === '1',
    handlung: eins(sp['handlung']) === '1',
  };
  const { heute, zeilen, berufstraeger } = await ladePortfolio();

  const mitProgramm = zeilen.filter((z) => z.hatProgramm);
  const kpi = {
    mandanten: mitProgramm.length,
    ueberfaellig: mitProgramm.reduce((s, z) => s + z.ueberfaellig, 0),
    hochOffen: mitProgramm.reduce((s, z) => s + z.feststellungenHochOffen, 0),
    ereignisse: mitProgramm.reduce((s, z) => s + z.ereignisseNeu, 0),
    laufend: mitProgramm.filter((z) => z.zeitraum.art === 'LAUFEND').length,
    p153: mitProgramm.reduce((s, z) => s + z.p153Offen, 0),
  };

  const sichtbar = zeilen.filter((z) => {
    if (
      filter.q &&
      !z.mandant.name.toLocaleLowerCase('de').includes(filter.q.toLocaleLowerCase('de'))
    )
      return false;
    if (filter.bt && z.mandant.berufstraegerId !== filter.bt) return false;
    if (filter.phase === 'ohne' && z.hatProgramm) return false;
    if (filter.phase && filter.phase !== 'ohne' && String(z.phase) !== filter.phase) return false;
    if (filter.ueberfaellig && z.ueberfaellig === 0) return false;
    if (filter.handlung && !z.handlungsbedarf) return false;
    return true;
  });
  const filterAktiv = !!(
    filter.q ||
    filter.bt ||
    filter.phase ||
    filter.ueberfaellig ||
    filter.handlung
  );
  const ohneProgramm = zeilen
    .filter((z) => !z.hatProgramm)
    .map((z) => {
      const darf = kannBearbeiten(nutzer, z.mandant);
      return { id: z.mandant.id, name: z.mandant.name, darf, grund: darf ? undefined : KEIN_RECHT };
    });

  return (
    <div className="page">
      <div className="row-between mb-4" style={{ flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 className="page-title" style={{ marginBottom: 0 }}>
            Tax-CMS
          </h1>
          <p className="text-sm text-muted mt-1">Compliance-Programme der Mandanten im Überblick</p>
        </div>
        <EinrichtenMenue mandanten={ohneProgramm} />
      </div>

      {/* KPI-Reihe (Fachkonzept S1) */}
      <div className="row-lg mb-4" style={{ alignItems: 'stretch', flexWrap: 'wrap' }}>
        <KpiKarte
          icon="LayoutGrid"
          ton="brand"
          wert={kpi.mandanten}
          label="Mandanten mit Tax-CMS"
          href="/staff/tcms"
          title="Alle Mandanten anzeigen"
        />
        <KpiKarte
          icon="AlarmClock"
          ton={kpi.ueberfaellig ? 'red' : 'gray'}
          wert={kpi.ueberfaellig}
          label="Kontrollen überfällig"
          href="/staff/tcms?ueberfaellig=1"
          title="Nur Mandanten mit Überfälligem"
        />
        <KpiKarte
          icon="Flame"
          ton={kpi.hochOffen ? 'red' : 'gray'}
          wert={kpi.hochOffen}
          label="Feststellungen hoch/kritisch offen"
          href="/staff/tcms?handlung=1"
          title={kpi.p153 ? `${kpi.p153} §-153-Würdigung(en) offen` : undefined}
        />
        <KpiKarte
          icon="Inbox"
          ton={kpi.ereignisse ? 'amber' : 'gray'}
          wert={kpi.ereignisse}
          label="Ereignisse nicht triagiert"
          href="/staff/tcms?handlung=1"
          title="Nur Mandanten mit Handlungsbedarf"
        />
        <KpiKarte
          icon="CalendarRange"
          ton="gray"
          wert={kpi.laufend}
          label="Laufende Wirksamkeitszeiträume"
          href="/staff/tcms?phase=6"
          title="Nur Phase 6"
        />
      </div>

      {/* Filter (GET, ohne Client-Logik) */}
      <div className="card p-4 mb-4">
        <form method="get" action="/staff/tcms" className="col" style={{ gap: 12 }}>
          <div className="row-lg" style={{ flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div>
              <label className="label-sm" htmlFor="f-q">
                Suche
              </label>
              <input
                id="f-q"
                name="q"
                type="search"
                className="input"
                placeholder="Mandant …"
                defaultValue={filter.q}
                style={{ width: 220 }}
              />
            </div>
            <div>
              <label className="label-sm" htmlFor="f-bt">
                Berufsträger
              </label>
              <select id="f-bt" name="bt" className="input" defaultValue={filter.bt}>
                <option value="">Alle</option>
                {berufstraeger.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label-sm" htmlFor="f-phase">
                Phase
              </label>
              <select id="f-phase" name="phase" className="input" defaultValue={filter.phase}>
                <option value="">Alle</option>
                {PHASEN_KURZ.map((p, i) => (
                  <option key={p} value={String(i + 1)}>
                    Phase {i + 1} · {p}
                  </option>
                ))}
                <option value="ohne">ohne Tax-CMS</option>
              </select>
            </div>
            <div>
              <label className="label-sm" htmlFor="f-paket">
                Paket
              </label>
              <select
                id="f-paket"
                className="input"
                defaultValue="ec"
                title="Weitere Branchenpakete folgen in Ausbaustufe 3"
              >
                <option value="ec">
                  {PAKET.name} v{PAKET.version}
                </option>
              </select>
            </div>
          </div>
          <div className="row-between" style={{ flexWrap: 'wrap', gap: 12 }}>
            <div className="row-lg" style={{ flexWrap: 'wrap', gap: 20 }}>
              <label className="row" htmlFor="f-ue">
                <input
                  type="checkbox"
                  id="f-ue"
                  name="ueberfaellig"
                  value="1"
                  className="checkbox"
                  defaultChecked={filter.ueberfaellig}
                />
                <span className="text-sm">nur mit Überfälligem</span>
              </label>
              <label className="row" htmlFor="f-hb">
                <input
                  type="checkbox"
                  id="f-hb"
                  name="handlung"
                  value="1"
                  className="checkbox"
                  defaultChecked={filter.handlung}
                />
                <span className="text-sm">nur mit Handlungsbedarf</span>
              </label>
            </div>
            <div className="row shrink0">
              {filterAktiv ? (
                <Link href="/staff/tcms" className="btn-secondary">
                  Zurücksetzen
                </Link>
              ) : null}
              <button type="submit" className="btn-secondary">
                <Icon name="Search" className="tx-icon-xs" /> Anwenden
              </button>
              <button
                type="button"
                className="btn-secondary"
                disabled
                title="Gespeicherte Ansichten folgen in Ausbaustufe B. Der Filter steht in der Adresse und lässt sich als Lesezeichen sichern."
              >
                Ansicht speichern <Icon name="ChevronDown" className="tx-icon-xs" />
              </button>
            </div>
          </div>
        </form>
      </div>

      {/* Portfolio-Tabelle */}
      <div className="card" style={{ overflow: 'hidden' }}>
        {zeilen.length === 0 ? (
          <Leerzustand
            icon="ShieldCheck"
            text="Noch kein Mandant angelegt. Ein Tax-CMS wird je Mandant über den Einrichtungsassistenten aufgebaut."
          />
        ) : sichtbar.length === 0 ? (
          <Leerzustand icon="Search" text="Kein Mandant entspricht dem Filter.">
            <Link href="/staff/tcms" className="btn-secondary">
              Filter zurücksetzen
            </Link>
          </Leerzustand>
        ) : (
          <div className="tbl-scroll">
            <table className="tbl">
              <thead>
                <tr>
                  <th style={{ ...ZELLE, width: 180 }}>Mandant</th>
                  <th style={ZELLE}>Phase</th>
                  <th
                    style={{ ...ZELLE, width: 64 }}
                    title="Risiken, deren Nettoklasse über dem Risikoappetit liegt"
                  >
                    Über Appetit
                  </th>
                  <th
                    style={{ ...ZELLE, width: 84 }}
                    className="td-num"
                    title="Manuelle Prüflast im Folgemonat (Prognose aus geplanten Durchführungen)"
                  >
                    Prüfungen/ Monat
                  </th>
                  <th
                    style={ZELLE}
                    title="Fällig: Fälligkeitsfenster offen oder in den nächsten 14 Tagen"
                  >
                    Kontrollen fällig/ überfällig
                  </th>
                  <th style={{ ...ZELLE, width: 110 }} className="td-num">
                    Feststel&shy;lungen offen
                  </th>
                  <th style={{ ...ZELLE, width: 84 }} className="td-num">
                    Ereignisse neu
                  </th>
                  <th style={ZELLE}>Wirksamkeits&shy;zeitraum</th>
                  <th style={ZELLE}>Nächster Termin</th>
                  <th style={ZELLE}>Berufs&shy;träger</th>
                </tr>
              </thead>
              <tbody>
                {sichtbar.map((z) =>
                  z.hatProgramm ? (
                    <Zeile key={z.mandant.id} z={z} />
                  ) : (
                    <OhneZeile key={z.mandant.id} z={z} darf={kannBearbeiten(nutzer, z.mandant)} />
                  ),
                )}
              </tbody>
            </table>
          </div>
        )}
        <div className="card-footer">
          <span>
            Sortierung: zuerst Handlungsbedarf. Klick auf den Mandanten öffnet das Cockpit.
          </span>
          <span>
            {sichtbar.length} von {zeilen.length} Mandanten · Stand {fmtDatum(heute)}
          </span>
        </div>
      </div>
      <p className="text-11 text-muted mt-4">
        Statusangaben sind Betriebsinformationen, keine Aussage über Angemessenheit oder
        Wirksamkeit. Prüflast und Fälligkeiten folgen aus Governance-Typ × Bruttoklasse (Startwerte,
        vom Berufsträger zu kalibrieren).
      </p>
    </div>
  );
}

function Zeile({ z }: { z: PortfolioZeile }) {
  const href = `/staff/clients/${z.mandant.id}/tcms`;
  const zr = z.zeitraum;
  return (
    <tr>
      <td style={ZELLE}>
        <Link href={href} className="text-sm font-m unstyled" style={{ display: 'block' }}>
          {z.mandant.name}
        </Link>
        <div
          className="text-11 text-muted mt-1"
          title={z.teilbereich ? `Teilbereich: ${z.teilbereich}` : undefined}
        >
          {z.paket}
        </div>
      </td>
      <td style={ZELLE}>
        <span className="row-s" title={`Phase ${z.phase} von 7: ${z.phaseName}`}>
          <MiniSteps aktiv={z.phase} titel={[...PHASEN]} />
          <span className="text-xs text-muted">{z.phase}/7</span>
        </span>
      </td>
      <td
        style={ZELLE}
        title={`Risikoappetit ${KLASSE_LABEL[z.appetit as Klasse] ?? '—'} · ${z.risiken} aktive Risiken`}
      >
        {z.ueberAppetit > 0 ? (
          <Link href={`${href}/risiken?appetit=1`} className="row-s unstyled">
            <span className="status-dot dot-red" />
            <span className="text-sm font-m mono">{z.ueberAppetit}</span>
          </Link>
        ) : z.risiken > 0 ? (
          <span className="text-sm mono">0</span>
        ) : (
          <span className="text-muted">–</span>
        )}
      </td>
      <td
        style={ZELLE}
        className="td-num"
        title={
          z.prueflast
            ? `${z.prueflastMonat}: FP ${z.prueflast.FP} · FF ${z.prueflast.FF} · IN ${z.prueflast.IN}${z.prueflast.ausloesungen ? ` · Auslösungen ${z.prueflast.ausloesungen}` : ''}`
            : 'Noch keine Durchführungen geplant'
        }
      >
        {z.prueflast ? z.prueflast.gesamt : <span className="text-muted">–</span>}
      </td>
      <td style={ZELLE}>
        {z.faellig === 0 && z.ueberfaellig === 0 ? (
          <span className="text-sm text-muted">nichts fällig</span>
        ) : (
          <span className="text-sm" style={{ whiteSpace: 'nowrap' }}>
            {z.faellig} fällig
            {z.ueberfaellig > 0 ? (
              <>
                {' · '}
                <Link href={`${href}/kontrollen`} className="unstyled" style={{ color: '#b42318' }}>
                  {z.ueberfaellig} überfällig
                </Link>
              </>
            ) : null}
          </span>
        )}
        {z.zurGegenzeichnung > 0 ? (
          <div className="text-11 mt-1" style={{ color: '#6d28d9', whiteSpace: 'nowrap' }}>
            {z.zurGegenzeichnung} zur Gegenzeichnung
          </div>
        ) : null}
      </td>
      <td style={ZELLE} className="td-num">
        <span className="row-s" style={{ justifyContent: 'flex-end' }}>
          {z.p153Offen > 0 ? (
            <Link
              href={`${href}/feststellungen`}
              className="badge-red unstyled"
              title={`${z.p153Offen} §-153-Würdigung(en) offen`}
            >
              §153
            </Link>
          ) : null}
          <span
            title={
              z.feststellungenHochOffen ? `${z.feststellungenHochOffen} hoch/kritisch` : undefined
            }
          >
            <Zahl wert={z.feststellungenOffen} />
          </span>
        </span>
      </td>
      <td style={ZELLE} className="td-num">
        {z.ereignisseNeu > 0 ? (
          <Link href={`${href}/ereignisse`} className="unstyled text-primary font-m">
            {z.ereignisseNeu}
          </Link>
        ) : (
          <Zahl wert={0} />
        )}
      </td>
      <td style={ZELLE}>
        {zr.art === 'LAUFEND' ? (
          <div
            className="col-s"
            style={{ minWidth: 110 }}
            title={`${fmtDatum(zr.ab)} – ${fmtDatum(zr.bis)}`}
          >
            <div className="progress">
              <div
                className="fill"
                style={{ width: `${Math.round((zr.monat / zr.monate) * 100)}%` }}
              />
            </div>
            <span className="text-11 text-muted">
              Monat {zr.monat} von {zr.monate}
            </span>
          </div>
        ) : zr.art === 'ABGESCHLOSSEN' ? (
          <span className="text-sm" title={`${fmtDatum(zr.ab)} – ${fmtDatum(zr.bis)}`}>
            {z.phase === 7 ? 'Regelbetrieb' : 'abgelaufen'} ·{' '}
            {fmtMonatJahr(isoDatum(zr.ab).slice(0, 7))}–{fmtMonatJahr(isoDatum(zr.bis).slice(0, 7))}
          </span>
        ) : zr.art === 'BEVORSTEHEND' ? (
          <span className="text-sm text-secondary">beginnt {fmtDatum(zr.ab)}</span>
        ) : (
          <span className="text-sm text-muted">noch nicht begonnen</span>
        )}
      </td>
      <td style={ZELLE}>
        {z.naechsterTermin ? (
          <Link
            href={`${href}/durchfuehrungen/${z.naechsterTermin.durchfuehrungId}`}
            className="unstyled"
            title={`${z.naechsterTermin.code} · ${z.naechsterTermin.titel} · ${z.naechsterTermin.periode} · ${ANZEIGE_LABEL[z.naechsterTermin.anzeige]}`}
          >
            <span className="text-sm mono" style={{ display: 'block' }}>
              {fmtDatumKurz(z.naechsterTermin.datum)}
            </span>
            <span className="text-11 text-muted" style={{ whiteSpace: 'nowrap' }}>
              {z.naechsterTermin.code}
            </span>
          </Link>
        ) : (
          <span className="text-muted">–</span>
        )}
      </td>
      <td style={ZELLE}>
        <span className="text-sm text-secondary">{z.berufstraeger}</span>
      </td>
    </tr>
  );
}

function OhneZeile({ z, darf }: { z: PortfolioZeile; darf: boolean }) {
  return (
    <tr>
      <td style={ZELLE}>
        <Link
          href={`/staff/clients/${z.mandant.id}/tcms`}
          className="text-sm font-m unstyled"
          style={{ display: 'block' }}
        >
          {z.mandant.name}
        </Link>
        <div className="text-11 text-muted mt-1">
          {z.entwurf ? 'Einrichtung läuft' : 'kein Tax-CMS eingerichtet'}
        </div>
      </td>
      <td style={ZELLE} colSpan={8}>
        <span className="row-lg">
          <span className="text-sm text-muted">
            Phase, Risiken und Kontrollen entstehen im Einrichtungsassistenten.
          </span>
          {darf ? (
            <Link
              href={`/staff/clients/${z.mandant.id}/tcms/setup`}
              className="btn-secondary btn-tiny"
            >
              <Icon name={z.entwurf ? 'ArrowRight' : 'Plus'} className="tx-icon-xs" />{' '}
              {z.entwurf ? 'Einrichtung fortsetzen' : 'Einrichtung starten'}
            </Link>
          ) : (
            <button type="button" className="btn-secondary btn-tiny" disabled title={KEIN_RECHT}>
              <Icon name={z.entwurf ? 'ArrowRight' : 'Plus'} className="tx-icon-xs" />{' '}
              {z.entwurf ? 'Einrichtung fortsetzen' : 'Einrichtung starten'}
            </button>
          )}
        </span>
      </td>
      <td style={ZELLE}>
        <span className="text-sm text-secondary">{z.berufstraeger}</span>
      </td>
    </tr>
  );
}
