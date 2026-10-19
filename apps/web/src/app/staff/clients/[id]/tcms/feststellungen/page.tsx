import Link from 'next/link';
import {
  AUSWIRKUNG_BADGE,
  AUSWIRKUNG_LABEL,
  FESTSTELLUNG_KLASSE_LABEL,
  FESTSTELLUNG_STATUS_LABEL,
  fmtDatum,
  KLASSE_LABEL,
  p153Erforderlich,
  QUELLE_LABEL,
  relativTage,
  tageZwischen,
  type FeststellungKlasse,
  type FeststellungQuelle,
  type FeststellungStatus,
} from '@tcms/domain';
import { Icon } from '@/components/icon';
import { KlasseBadge } from '@/components/ui/badges';
import { Leerzustand } from '@/components/ui/leer';
import { TcmsKopf } from '@/components/tcms/kopf';
import {
  FeststellungStatusBadge,
  P153Badge,
  VertraulichBadge,
} from '@/components/feststellungen/badges';
import { FormDialog } from '@/components/feststellungen/dialog';
import { FeststellungFilter } from '@/components/feststellungen/filter';
import { erfasseFeststellung } from '@/server/actions/feststellungen';
import {
  istBeteiligt,
  kontrollCode,
  ladeFeststellungListe,
  type MassnahmeZeile,
} from '@/server/feststellungen-daten';
import { personKurzname } from '@/server/kontext';
import { ladeStaffSeite, NUR_AKTUELL } from '@/server/seite';

export const metadata = { title: 'Feststellungen und Maßnahmen' };

type SP = Record<string, string | string[] | undefined>;
/** Kompaktere Zellen, damit alle zehn Spalten bei 1440 px sichtbar bleiben. */
const ZELLE = { paddingLeft: 9, paddingRight: 9 } as const;
const eins = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';

const STATUS_FILTER: [string, string][] = [
  ['offen', 'offen (nicht geschlossen)'],
  ...(
    [
      'ERFASST',
      'IN_WUERDIGUNG',
      'MASSNAHMEN_OFFEN',
      'NACHKONTROLLE',
      'GESCHLOSSEN',
      'VERWORFEN',
    ] as FeststellungStatus[]
  ).map((s): [string, string] => [s, FESTSTELLUNG_STATUS_LABEL[s]]),
];

export default async function FeststellungenSeite({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SP>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const seite = await ladeStaffSeite(id, sp);
  const { ctx, basis, mitStand, nutzer } = seite;

  if (!ctx.programm) {
    return (
      <div className="card">
        <Leerzustand
          icon="ShieldCheck"
          text="Für diesen Mandanten ist noch kein Tax-CMS eingerichtet."
        />
      </div>
    );
  }

  const zusatz = await ladeFeststellungListe(ctx.programm.id, ctx.stand);
  const darfSehen = (fid: string) => {
    const f = ctx.feststellungen.find((x) => x.id === fid);
    const z = zusatz.get(fid);
    if (!f || !z) return false;
    if (!f.vertraulich) return true;
    return istBeteiligt(
      nutzer,
      {
        erfasstVon: z.erfasstVon,
        p153EntschiedenVon: z.p153EntschiedenVon,
        massnahmenVerantwortlich: z.massnahmen.map((m) => m.verantwortlich),
      },
      ctx.mandant,
    );
  };

  const fStatus = eins(sp['status']);
  const fKlasse = eins(sp['klasse']);
  const fQuelle = eins(sp['quelle']);
  const fP153 = eins(sp['p153']) === '1';
  const gefiltert = ctx.feststellungen.filter((f) => {
    if (fStatus === 'offen' && (f.status === 'GESCHLOSSEN' || f.status === 'VERWORFEN'))
      return false;
    if (fStatus && fStatus !== 'offen' && f.status !== fStatus) return false;
    if (fKlasse && f.klasse !== fKlasse) return false;
    if (fQuelle && f.quelle !== fQuelle) return false;
    if (fP153 && !f.p153Offen) return false;
    return true;
  });

  const offen = ctx.feststellungen.filter(
    (f) => f.status !== 'GESCHLOSSEN' && f.status !== 'VERWORFEN',
  ).length;
  const p153Offen = ctx.feststellungen.filter((f) => f.p153Offen).length;

  // Maßnahmen-Übersicht (offene Maßnahmen offener Feststellungen, nach Frist).
  const massnahmen: (MassnahmeZeile & { nummer: string; sichtbar: boolean })[] = [];
  let erledigtGesamt = 0;
  for (const f of ctx.feststellungen) {
    const z = zusatz.get(f.id);
    if (!z || f.status === 'VERWORFEN') continue;
    for (const m of z.massnahmen) {
      if (m.status === 'OFFEN')
        massnahmen.push({ ...m, nummer: f.nummer, sichtbar: darfSehen(f.id) });
      else erledigtGesamt++;
    }
  }
  massnahmen.sort((a, b) => a.frist.getTime() - b.frist.getTime());

  // Für das Erfassungsformular.
  const befundDurchf = ctx.durchfuehrungen
    .filter(
      (d) =>
        d.anzeige === 'MIT_BEFUND' ||
        d.anzeige === 'ZUR_GEGENZEICHNUNG' ||
        d.anzeige === 'IN_DURCHFUEHRUNG' ||
        d.anzeige === 'UEBERFAELLIG',
    )
    .sort((a, b) => b.faelligAm.getTime() - a.faelligAm.getTime())
    .slice(0, 40);

  const erfassen = (
    <FormDialog
      ausloeser={
        <>
          <Icon name="Plus" className="tx-icon-xs" /> Feststellung erfassen
        </>
      }
      ausloeserClass="btn-primary btn-tiny"
      titel="Feststellung erfassen"
      hinweis={
        'Nummer wird automatisch vergeben (F-Jahr-lfd. Nr.). Bei steuerlicher Auswirkung „ja“ oder „unklar“ startet der §-153-Pfad.'
      }
      action={erfasseFeststellung}
      felder={{ programmId: ctx.programm.id }}
      bestaetigen="Erfassen"
      breit
      disabled={!seite.darfBearbeiten}
      disabledGrund={ctx.historisch ? NUR_AKTUELL : 'Erfassen ist zuständigen Personen vorbehalten'}
    >
      <div>
        <label className="label-sm" htmlFor="f-titel">
          Titel
        </label>
        <input
          id="f-titel"
          name="titel"
          className="input"
          required
          minLength={5}
          maxLength={200}
          placeholder="z. B. Clearingkonto Klarna mit Restsaldo"
        />
      </div>
      <div>
        <label className="label-sm" htmlFor="f-sachverhalt">
          Sachverhalt
        </label>
        <textarea
          id="f-sachverhalt"
          name="sachverhalt"
          className="input"
          required
          minLength={20}
          placeholder="Was wurde festgestellt? Wo, seit wann, in welchem Umfang?"
        />
      </div>
      <div className="g12" style={{ gap: 12 }}>
        <div className="gc-4">
          <label className="label-sm" htmlFor="f-quelle">
            Quelle
          </label>
          <select
            id="f-quelle"
            name="quelle"
            className="input"
            style={{ width: '100%' }}
            defaultValue="HINWEIS"
          >
            {(Object.keys(QUELLE_LABEL) as FeststellungQuelle[]).map((q) => (
              <option key={q} value={q}>
                {QUELLE_LABEL[q]}
              </option>
            ))}
          </select>
        </div>
        <div className="gc-8">
          <label className="label-sm" htmlFor="f-quelletext">
            Quelle (Angabe)
          </label>
          <input
            id="f-quelletext"
            name="quelleText"
            className="input"
            required
            minLength={2}
            placeholder="z. B. Hinweis Buchhaltung, Außenprüfung USt 2024"
          />
        </div>
      </div>
      <div>
        <label className="label-sm" htmlFor="f-durchf">
          Durchführung (nur bei Quelle Kontrolle, optional)
        </label>
        <select
          id="f-durchf"
          name="durchfuehrungId"
          className="input"
          style={{ width: '100%' }}
          defaultValue=""
        >
          <option value="">— keine —</option>
          {befundDurchf.map((d) => (
            <option key={d.id} value={d.id}>
              {d.code} · {d.periodeLabel}
            </option>
          ))}
        </select>
      </div>
      <div className="g12" style={{ gap: 12 }}>
        <div className="gc-4">
          <label className="label-sm" htmlFor="f-klasse">
            Klasse
          </label>
          <select
            id="f-klasse"
            name="klasse"
            className="input"
            style={{ width: '100%' }}
            defaultValue=""
            required
          >
            <option value="" disabled>
              bitte wählen
            </option>
            {(Object.keys(FESTSTELLUNG_KLASSE_LABEL) as FeststellungKlasse[]).map((k) => (
              <option key={k} value={k}>
                {FESTSTELLUNG_KLASSE_LABEL[k]}
              </option>
            ))}
          </select>
        </div>
        <div className="gc-4">
          <label className="label-sm" htmlFor="f-schwere">
            Schwere
          </label>
          <select
            id="f-schwere"
            name="schwere"
            className="input"
            style={{ width: '100%' }}
            defaultValue=""
            required
          >
            <option value="" disabled>
              bitte wählen
            </option>
            {(['GERING', 'MITTEL', 'HOCH', 'KRITISCH'] as const).map((k) => (
              <option key={k} value={k}>
                {KLASSE_LABEL[k]}
              </option>
            ))}
          </select>
        </div>
        <div className="gc-4">
          <label className="label-sm" htmlFor="f-auswirkung">
            Steuerliche Auswirkung
          </label>
          <select
            id="f-auswirkung"
            name="auswirkung"
            className="input"
            style={{ width: '100%' }}
            defaultValue=""
            required
          >
            <option value="" disabled>
              bitte wählen
            </option>
            {(['JA', 'NEIN', 'UNKLAR'] as const).map((k) => (
              <option key={k} value={k}>
                {AUSWIRKUNG_LABEL[k]}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div>
        <label className="label-sm" htmlFor="f-risiken">
          Betroffene Risiken (Mehrfachauswahl mit Strg/Cmd)
        </label>
        <select
          id="f-risiken"
          name="risiken"
          multiple
          className="input"
          style={{ width: '100%', minHeight: 120 }}
        >
          {ctx.risiken.map((r) => (
            <option key={r.id} value={r.id}>
              {r.code} · {r.titel}
            </option>
          ))}
        </select>
      </div>
    </FormDialog>
  );

  return (
    <>
      <TcmsKopf
        seite={seite}
        titel={<h2 className="text-xl font-b text-primary">Feststellungen und Maßnahmen</h2>}
      />

      <div className="row-between mb-4" style={{ flexWrap: 'wrap', gap: 12 }}>
        <FeststellungFilter
          status={STATUS_FILTER}
          klassen={(Object.keys(FESTSTELLUNG_KLASSE_LABEL) as FeststellungKlasse[]).map((k) => [
            k,
            FESTSTELLUNG_KLASSE_LABEL[k],
          ])}
          quellen={(Object.keys(QUELLE_LABEL) as FeststellungQuelle[]).map((k) => [
            k,
            QUELLE_LABEL[k],
          ])}
        />
        {erfassen}
      </div>

      <div className="card" style={{ overflow: 'hidden' }}>
        {gefiltert.length === 0 ? (
          <Leerzustand
            icon="FileCheck"
            text={
              ctx.feststellungen.length === 0
                ? 'Noch keine Feststellungen erfasst.'
                : 'Keine Feststellung entspricht den Filtern.'
            }
          />
        ) : (
          <div className="tbl-scroll">
            <table className="tbl" style={{ fontSize: 13 }}>
              <thead>
                <tr>
                  <th style={ZELLE}>ID</th>
                  <th style={ZELLE}>Titel</th>
                  <th style={ZELLE}>Quelle</th>
                  <th style={ZELLE}>Klasse</th>
                  <th style={ZELLE}>Schwere</th>
                  <th style={ZELLE}>Steuerliche Auswirkung</th>
                  <th style={ZELLE}>§-153-Status</th>
                  <th className="td-num" style={{ ...ZELLE, whiteSpace: 'normal' }}>
                    Maßnahmen offen
                  </th>
                  <th style={ZELLE}>Älteste Frist</th>
                  <th style={ZELLE}>Status</th>
                </tr>
              </thead>
              <tbody>
                {gefiltert.map((f) => {
                  const href = mitStand(`${basis}/feststellungen/${f.id}`);
                  const z = zusatz.get(f.id);
                  if (!darfSehen(f.id)) {
                    return (
                      <tr key={f.id}>
                        <td style={ZELLE}>
                          <span className="mono text-xs font-m" style={{ whiteSpace: 'nowrap' }}>
                            {f.nummer}
                          </span>
                        </td>
                        <td colSpan={9} style={ZELLE}>
                          <span className="row-s">
                            <VertraulichBadge />
                            <span className="text-sm text-muted">
                              Vertrauliche Feststellung – Inhalt nur für Beteiligte sichtbar.
                            </span>
                          </span>
                        </td>
                      </tr>
                    );
                  }
                  const code =
                    f.quelle === 'KONTROLLE'
                      ? kontrollCode(f.quelleText)
                      : f.quelle === 'EREIGNIS'
                        ? (/\d{4}-T-\d{4}/.exec(f.quelleText)?.[0] ?? null)
                        : null;
                  const ueberfaellig =
                    f.aeltesteFrist && tageZwischen(ctx.stand, f.aeltesteFrist) < 0;
                  const gesamt = f.massnahmen;
                  return (
                    <tr key={f.id} className="row-link">
                      <td style={ZELLE}>
                        <Link
                          href={href}
                          className="mono text-xs font-m"
                          style={{ textDecoration: 'none', whiteSpace: 'nowrap' }}
                        >
                          {f.nummer}
                        </Link>
                      </td>
                      <td style={{ ...ZELLE, minWidth: 180 }}>
                        <Link
                          href={href}
                          className="text-sm font-m text-primary"
                          style={{ textDecoration: 'none' }}
                        >
                          {f.titel}
                        </Link>
                        {f.vertraulich ? (
                          <span style={{ marginLeft: 6 }}>
                            <VertraulichBadge />
                          </span>
                        ) : null}
                        {z?.verwerfenOffen ? (
                          <span
                            style={{ marginLeft: 6 }}
                            className="badge-yellow"
                            title="Antrag auf Verwerfen wartet auf zweite Person"
                          >
                            Verwerfen beantragt
                          </span>
                        ) : null}
                      </td>
                      <td style={ZELLE}>
                        <span className="badge-gray">{QUELLE_LABEL[f.quelle]}</span>
                        <div
                          className={
                            code ? 'mono text-xs text-muted mt-1' : 'text-xs text-muted mt-1'
                          }
                        >
                          {code ?? f.quelleText}
                        </div>
                      </td>
                      <td style={ZELLE}>
                        <span className="badge-gray" style={{ whiteSpace: 'normal' }}>
                          {FESTSTELLUNG_KLASSE_LABEL[f.klasse].replace('mangel', '\u00ADmangel')}
                        </span>
                      </td>
                      <td style={ZELLE}>
                        <KlasseBadge klasse={f.schwere} />
                      </td>
                      <td style={ZELLE}>
                        <span className={AUSWIRKUNG_BADGE[f.auswirkung]}>
                          {AUSWIRKUNG_LABEL[f.auswirkung]}
                        </span>
                      </td>
                      <td style={{ ...ZELLE, maxWidth: 200 }}>
                        <P153Badge
                          erforderlich={p153Erforderlich(f.auswirkung) && f.status !== 'VERWORFEN'}
                          entscheidung={z?.p153Entscheidung ?? null}
                          am={z?.p153EntschiedenAm ?? null}
                          frist={z?.p153Frist ?? null}
                        />
                      </td>
                      <td className="td-num" style={{ ...ZELLE, whiteSpace: 'nowrap' }}>
                        {f.massnahmenOffen > 0 ? (
                          f.massnahmenOffen
                        ) : gesamt > 0 ? (
                          <>
                            {gesamt}/{gesamt}
                            <div
                              className="text-11 text-muted"
                              style={{ fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif' }}
                            >
                              {f.status === 'NACHKONTROLLE' ? 'Nachkontrolle offen' : 'umgesetzt'}
                            </div>
                          </>
                        ) : (
                          0
                        )}
                      </td>
                      <td className="text-sm" style={{ ...ZELLE, whiteSpace: 'nowrap' }}>
                        {f.aeltesteFrist ? (
                          <span
                            style={ueberfaellig ? { color: '#b42318' } : undefined}
                            title={ueberfaellig ? 'Frist überschritten' : undefined}
                          >
                            {fmtDatum(f.aeltesteFrist)}
                          </span>
                        ) : (
                          <span className="text-muted">—</span>
                        )}
                      </td>
                      <td style={ZELLE}>
                        <FeststellungStatusBadge status={f.status} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div className="card-footer">
          <span>
            {ctx.feststellungen.length} Feststellungen gesamt · {offen} offen · {p153Offen}{' '}
            §-153-Würdigung{p153Offen === 1 ? '' : 'en'} offen
            {gefiltert.length !== ctx.feststellungen.length
              ? ` · ${gefiltert.length} angezeigt`
              : ''}
          </span>
          {gefiltert.length !== ctx.feststellungen.length ? (
            <Link href={mitStand(`${basis}/feststellungen`)} className="text-muted">
              Alle anzeigen
            </Link>
          ) : null}
        </div>
      </div>

      <div className="card mt-4" style={{ overflow: 'hidden' }}>
        <div className="card-header">
          <span className="card-title">Offene Maßnahmen</span>
          <span className={massnahmen.length ? 'badge-yellow' : 'badge-gray'}>
            {massnahmen.length} offen
          </span>
        </div>
        {massnahmen.length === 0 ? (
          <Leerzustand icon="CheckCheck" text="Keine offenen Maßnahmen." />
        ) : (
          <div className="tbl-scroll">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Wiedervorlage</th>
                  <th>Maßnahme</th>
                  <th>Feststellung</th>
                  <th>Verantwortlich</th>
                  <th>Frist</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {massnahmen.map((m) => {
                  const tage = tageZwischen(ctx.stand, m.frist);
                  const href = mitStand(`${basis}/feststellungen/${m.feststellungId}`);
                  return (
                    <tr key={m.id}>
                      <td>
                        <Link href={href} className="badge-gray" style={{ textDecoration: 'none' }}>
                          <Icon name="CalendarClock" className="tx-icon-xs" />{' '}
                          <span className="mono">#{m.wiedervorlageNr}</span>
                        </Link>
                      </td>
                      <td className="text-sm">
                        {m.sichtbar ? (
                          m.beschreibung
                        ) : (
                          <span className="text-muted">vertraulich</span>
                        )}
                      </td>
                      <td>
                        <Link
                          href={href}
                          className="mono text-xs"
                          style={{ textDecoration: 'none', whiteSpace: 'nowrap' }}
                        >
                          {m.nummer}
                        </Link>
                      </td>
                      <td className="text-sm">
                        {m.sichtbar ? personKurzname(ctx, m.verantwortlich) : '—'}
                      </td>
                      <td className="text-sm" style={{ whiteSpace: 'nowrap' }}>
                        {fmtDatum(m.frist)}{' '}
                        <span className="text-11 text-muted">· {relativTage(tage)}</span>
                      </td>
                      <td>
                        {tage < 0 ? (
                          <span className="badge-red">überfällig</span>
                        ) : (
                          <span className="badge-yellow">offen</span>
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
          <span>
            {erledigtGesamt} Maßnahme{erledigtGesamt === 1 ? '' : 'n'} erledigt ·
            Wiedervorlage-Nummern kanzleiweit fortlaufend
          </span>
        </div>
      </div>
    </>
  );
}
