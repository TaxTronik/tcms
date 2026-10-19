import Link from 'next/link';
import type { ReactNode } from 'react';
import {
  AUSFUEHRUNG_LABEL,
  fmtDatum,
  fmtDatumZeit,
  fmtEur,
  frequenzLabel,
  GOVERNANCE_ERKLAERUNG,
  KLASSE_LABEL,
  katalogKontrolle,
  KONTROLLART_LABEL,
  MATRIX_ZEILEN,
  matrixFrequenz,
  mindestensSoStreng,
  periodeFuer,
  PARTEI_LABEL,
  TURNUS_LABEL,
  type GovernanceTyp,
  type Klasse,
} from '@tcms/domain';
import { Icon } from '@/components/icon';
import { GtBadge, KlasseBadge } from '@/components/ui/badges';
import {
  AktionsForm,
  BegruendungsDialog,
  DetailDrawer,
  SubmitButton,
} from '@/components/ui/client';
import {
  designBeurteilen,
  frequenzAbweichungAufheben,
  frequenzAbweichungBeantragen,
  frequenzAbweichungEntscheiden,
  verantwortlicheAendern,
} from '@/server/actions/kontrollen';
import { personName, type KontrolleView, type PersonKurz } from '@/server/kontext';
import type { KontrolleDetail } from '@/server/kontrollen-daten';
import { zweitePerson } from '@tcms/service';
import type { StaffSeite } from '@/server/seite';
import { kurzName } from '../risiken/labels';
import { DesignBadge, DurchfuehrungBadge, SchluesselBadge } from './badges';
import {
  auditKurztext,
  BETRIEB_BADGE,
  BETRIEB_KURZ,
  BETRIEB_LABEL,
  KONTROLL_AUDIT_LABEL,
} from './labels';

const SEL = { padding: '5px 10px', fontSize: 13 } as const;
const SPALTEN: { key: 'hoch' | 'mittel' | 'gering'; label: string; klassen: Klasse[] }[] = [
  { key: 'hoch', label: 'kritisch / hoch', klassen: ['KRITISCH', 'HOCH'] },
  { key: 'mittel', label: 'mittel', klassen: ['MITTEL'] },
  { key: 'gering', label: 'gering', klassen: ['GERING'] },
];

function Abschnitt({
  titel,
  offen,
  children,
  rechts,
}: {
  titel: ReactNode;
  offen?: boolean;
  children: ReactNode;
  rechts?: ReactNode;
}) {
  return (
    <details className="details-box" open={offen}>
      <summary>
        <span className="grow">{titel}</span>
        {rechts}
      </summary>
      <div className="details-body col">{children}</div>
    </details>
  );
}

function datumZeit(d: Date): string {
  return d.getUTCHours() === 0 && d.getUTCMinutes() === 0 ? fmtDatum(d) : fmtDatumZeit(d);
}

function Personenwahl({
  name,
  label,
  personen,
  wert,
  leer,
}: {
  name: string;
  label: string;
  personen: PersonKurz[];
  wert: string | null;
  leer?: string;
}) {
  return (
    <div className="gc-6" style={{ minWidth: 0 }}>
      <label className="label-sm" htmlFor={`pw-${name}`}>
        {label}
      </label>
      <select
        id={`pw-${name}`}
        name={name}
        className="input"
        style={{ ...SEL, width: '100%' }}
        defaultValue={wert ?? ''}
      >
        {leer ? <option value="">{leer}</option> : null}
        {personen.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
            {p.funktion ? ` · ${p.funktion}` : ''}
          </option>
        ))}
      </select>
    </div>
  );
}

export function KontrolleDrawer({
  seite,
  kontrolle: k,
  detail,
  feststellungJeDurchfuehrung,
  sperre,
  risikoHref,
}: {
  seite: StaffSeite;
  kontrolle: KontrolleView;
  detail: KontrolleDetail | null;
  feststellungJeDurchfuehrung: Map<string, { id: string; nummer: string; p153Offen: boolean }>;
  sperre: string | null;
  risikoHref: (id: string) => string;
}) {
  const { ctx, basis, mitStand, nutzer } = seite;
  const kat = katalogKontrolle(k.code);
  const turnus = ctx.programm?.erklaerungsTurnus ?? 'MONATLICH';
  const periode = periodeFuer(k.vorlage, turnus);
  const risiken = ctx.risiken.filter((r) => k.risikoIds.includes(r.id));
  const quelle = k.ableitung.quelle;
  const offen = k.abweichung && !k.abweichung.freigegebenVon ? k.abweichung : null;
  const freigegeben = k.abweichung?.freigegebenVon ? k.abweichung : null;
  const antragVon = detail?.abweichungBeantragtVon ?? null;
  const darfEntscheiden = zweitePerson(nutzer, antragVon);
  const felder = { id: k.id, stand: seite.standIso };
  const kanzlei = [...ctx.personen.values()]
    .filter((p) => p.art === 'KANZLEI')
    .sort((a, b) => a.name.localeCompare(b.name));
  const seitePersonen = k.partei === 'MANDANT' ? ctx.mandantPersonen : kanzlei;
  const durchf = ctx.durchfuehrungen
    .filter((d) => d.kontrolleId === k.id)
    .sort((a, b) => b.faelligAm.getTime() - a.faelligAm.getTime());
  const vergangen = durchf.filter((d) => d.anzeige !== 'GEPLANT').slice(0, 8);
  // die nächsten drei geplanten, absteigend angezeigt wie die vergangenen
  const geplant = durchf
    .filter((d) => d.anzeige === 'GEPLANT')
    .reverse()
    .slice(0, 3)
    .reverse();
  const luecken: string[] = [];
  if (!k.ziel) luecken.push('Ziel');
  if (k.schritte.length === 0) luecken.push('Schritte');
  if (!k.nachweis) luecken.push('Nachweisanforderung');
  if (!k.durchfuehrendId) luecken.push('durchführende Person');
  if (!k.vertretungId || k.vertretungId === k.durchfuehrendId)
    luecken.push('Vertretung (verschieden von der durchführenden Person)');
  if (
    k.schluessel &&
    !k.gegenzeichnungMandant &&
    (!k.gegenzeichnerId || k.gegenzeichnerId === k.durchfuehrendId)
  )
    luecken.push('Gegenzeichnung (Pflicht bei Schlüsselkontrollen)');
  if (k.design === 'NICHT_BEURTEILT') luecken.push('Designbeurteilung');

  // Der Anlass-Anteil der Mindestfrequenz kann aus einem anderen Risiko stammen als der Turnus.
  const anlassAus =
    k.ableitung.mindest.anlass &&
    quelle &&
    !matrixFrequenz(quelle.gt, quelle.brutto, periode).anlass
      ? risiken
          .filter((r) => matrixFrequenz(r.gt, r.bewertung.brutto.klasse, periode).anlass)
          .map((r) => `${r.code} (${r.gt})`)
      : [];
  const zellenRisiken = (gt: GovernanceTyp, klassen: Klasse[]) =>
    risiken.filter((r) => r.gt === gt && klassen.includes(r.bewertung.brutto.klasse));

  const kopf = (
    <>
      <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
        <span className="text-base font-b text-primary">
          {k.code} · {k.titel}
        </span>
        {k.schluessel ? <SchluesselBadge /> : null}
        <span className="badge-gray">{PARTEI_LABEL[k.partei]}</span>
      </div>
      <div className="text-xs text-muted mt-1">
        {KONTROLLART_LABEL[k.art]} · {AUSFUEHRUNG_LABEL[k.ausfuehrung]} · GT {k.gt ?? '—'} ·
        Frequenz {frequenzLabel(k.frequenz)} · Stand v{k.version}
      </div>
    </>
  );

  return (
    <DetailDrawer param="kontrolle" titel={`Kontrolle ${k.code}`} kopf={kopf}>
      <div className="col">
        {k.naechste?.anzeige === 'UEBERFAELLIG' ? (
          <div className="alert-error text-sm" role="alert">
            <strong>Überfällig:</strong> {k.naechste.periodeLabel}, fällig{' '}
            {fmtDatum(k.naechste.faelligAm)}. Netto (Betrieb) der verknüpften Risiken ohne Abschlag
            dieser Kontrolle.
          </div>
        ) : null}

        <Abschnitt titel="Ziel und Beschreibung" offen>
          <p className="text-sm text-secondary">{k.ziel}</p>
          <div className="g12 text-sm">
            <div className="gc-6">
              <span className="label-sm">Art · Ausführung</span>
              {KONTROLLART_LABEL[k.art]} · {AUSFUEHRUNG_LABEL[k.ausfuehrung]}
            </div>
            <div className="gc-6">
              <span className="label-sm">Partei</span>
              {PARTEI_LABEL[k.partei]}
              {kat?.review ? `, ${kat.review}` : ''}
            </div>
            <div className="gc-6">
              <span className="label-sm">Nachweisanforderung</span>
              {k.nachweis}
            </div>
            <div className="gc-6">
              <span className="label-sm">Mindestnachweise · Fälligkeit</span>
              {k.mindestNachweise} {k.mindestNachweise === 1 ? 'Datei' : 'Dateien'} ·{' '}
              {k.faelligNachTagen} Tage nach Periodenende
            </div>
          </div>
          {luecken.length ? (
            <div className="alert-warning text-xs">
              Pflichtattribute: Lücken ({luecken.length}) – {luecken.join(', ')}.
            </div>
          ) : (
            <span className="text-11 text-muted">
              Pflichtattribute dokumentiert (Ziel, Schritte, Nachweis, Toleranz, Personen, Frequenz,
              Designbeurteilung).
            </span>
          )}
        </Abschnitt>

        <Abschnitt titel={`Schritte (${k.schritte.length})`} offen>
          <ol className="col-s" style={{ paddingLeft: 18, margin: 0 }}>
            {k.schritte.map((s, i) => (
              <li key={i} className="text-sm">
                <span className="font-m">{s.titel}</span>
                {s.hinweis ? <span className="text-xs text-muted"> – {s.hinweis}</span> : null}
              </li>
            ))}
          </ol>
        </Abschnitt>

        <Abschnitt titel="Kennzahlen und Toleranz">
          {k.kennzahlen.length === 0 ? (
            <p className="text-sm text-muted">Keine Kennzahlen definiert.</p>
          ) : null}
          {k.kennzahlen.map((z) => (
            <div key={z.key} className="row-between text-sm">
              <span>{z.label}</span>
              <span className="mono text-xs text-muted">
                {z.differenzAus
                  ? `Differenz aus ${z.differenzAus.join(' − ')}`
                  : z.sollEur != null
                    ? `Soll ${fmtEur(z.sollEur)}`
                    : 'ohne Soll'}
              </span>
            </div>
          ))}
          <p className="text-xs text-secondary">
            Toleranz:{' '}
            {k.toleranzEur != null ? fmtEur(k.toleranzEur) : 'keine Betragstoleranz festgelegt'}
          </p>
        </Abschnitt>

        <Abschnitt
          titel="Frequenzherleitung"
          offen
          rechts={
            offen ? (
              <span className="badge-purple">Abweichung beantragt</span>
            ) : freigegeben ? (
              <span className="badge-yellow">abweichend</span>
            ) : k.ableitung.abweichendVonVorlage ? (
              <span className="badge-gray">aus Matrix</span>
            ) : null
          }
        >
          <div className="g12 text-sm">
            <div className="gc-4">
              <span className="label-sm">Vorlage (Katalog)</span>
              {frequenzLabel(k.vorlage)}
            </div>
            <div className="gc-4">
              <span className="label-sm">Mindestfrequenz (Matrix)</span>
              {frequenzLabel(k.ableitung.mindest)}
            </div>
            <div className="gc-4">
              <span className="label-sm">Maßgeblich</span>
              <strong>{frequenzLabel(k.frequenz)}</strong>
            </div>
          </div>
          <p className="text-xs text-muted">
            {quelle ? (
              <>
                Maßgeblich ist <strong>{quelle.code}</strong> ({quelle.gt} · brutto{' '}
                {KLASSE_LABEL[quelle.brutto]}): Matrixzeile {quelle.gt} – „
                {MATRIX_ZEILEN.find((m) => m.gt === quelle.gt)?.zyklus}“. Die Bruttoklasse bestimmt
                die Dichte, weil die Nettoklasse selbst von den Kontrollen abhängt. Hängt eine
                Kontrolle an mehreren Risiken, gilt die strengste Frequenz; wirksam ist die
                strengere aus Vorlage und Matrix
                {freigegeben ? ', hier ersetzt durch die freigegebene Abweichung' : ''}.
                {anlassAus.length
                  ? ` Prüfung bei jeder Auslösung aus: ${anlassAus.join(', ')}.`
                  : ''}
              </>
            ) : (
              'Keine verknüpften Risiken – es gilt die Vorlage.'
            )}{' '}
            „Jede Periode“ = {TURNUS_LABEL[periode]}.
          </p>
          <div className="tbl-scroll">
            <table className="tbl" style={{ fontSize: 12.5 }}>
              <thead>
                <tr>
                  <th style={{ padding: '7px 8px' }}>GT</th>
                  {SPALTEN.map((s) => (
                    <th key={s.key} style={{ padding: '7px 8px' }}>
                      {s.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {MATRIX_ZEILEN.map((z) => (
                  <tr key={z.gt}>
                    <td style={{ padding: '7px 8px' }} title={GOVERNANCE_ERKLAERUNG[z.gt]}>
                      <span className="badge-gray mono">{z.gt}</span>
                    </td>
                    {SPALTEN.map((s) => {
                      const drin = zellenRisiken(z.gt, s.klassen);
                      const massgeblich =
                        quelle && quelle.gt === z.gt && s.klassen.includes(quelle.brutto);
                      return (
                        <td
                          key={s.key}
                          style={{
                            padding: '7px 8px',
                            whiteSpace: 'normal',
                            ...(drin.length ? { backgroundColor: 'rgb(var(--brand-50))' } : {}),
                            ...(massgeblich
                              ? { boxShadow: 'inset 0 0 0 2px rgb(var(--brand-500))' }
                              : {}),
                          }}
                        >
                          <div className={drin.length ? 'text-primary' : 'text-muted'}>
                            {z[s.key]}
                          </div>
                          {drin.length ? (
                            <div className="mono text-11">{drin.map((r) => r.code).join(', ')}</div>
                          ) : null}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {risiken.length ? (
            <div className="col-s">
              {risiken.map((r) => {
                const f = matrixFrequenz(r.gt, r.bewertung.brutto.klasse, periode);
                return (
                  <div key={r.id} className="row-between text-sm" style={{ gap: 8 }}>
                    <Link href={risikoHref(r.id)} className="row-s">
                      <span className="mono">{r.code}</span>
                      <GtBadge gt={r.gt} />
                      <KlasseBadge klasse={r.bewertung.brutto.klasse} />
                    </Link>
                    <span className={quelle?.code === r.code ? 'font-m' : 'text-muted'}>
                      → {frequenzLabel(f)}
                      {quelle?.code === r.code ? ' (strengste)' : ''}
                    </span>
                  </div>
                );
              })}
            </div>
          ) : null}
          {k.abweichung ? (
            <div className={offen ? 'alert-info-sm' : 'alert-warning'}>
              <div className="text-sm">
                <strong>{offen ? 'Abweichung beantragt' : 'Freigegebene Abweichung'}:</strong>{' '}
                {frequenzLabel(k.abweichung.frequenz)}
                {!mindestensSoStreng(k.abweichung.frequenz, k.ableitung.mindest) ? (
                  <span
                    className="badge-amber"
                    style={{ marginLeft: 8 }}
                    title={`Mindestfrequenz aus der Häufigkeitsmatrix: ${frequenzLabel(k.ableitung.mindest)}`}
                  >
                    unter Matrixfrequenz
                  </span>
                ) : null}
              </div>
              <div className="text-xs mt-1">„{k.abweichung.begruendung}“</div>
              <div className="text-11 mt-1">
                {antragVon
                  ? `beantragt ${personName(ctx, antragVon)}${detail?.abweichungBeantragtAm ? ` · ${datumZeit(detail.abweichungBeantragtAm)}` : ''}`
                  : ''}
                {freigegeben ? ` · freigegeben ${personName(ctx, freigegeben.freigegebenVon)}` : ''}
              </div>
            </div>
          ) : null}
          <div className="row-s" style={{ flexWrap: 'wrap' }}>
            {!k.abweichung ? (
              <BegruendungsDialog
                ausloeser={
                  <>
                    <Icon name="CalendarClock" className="tx-icon-xs" /> Abweichung beantragen…
                  </>
                }
                titel={`${k.code} · Frequenzabweichung beantragen`}
                hinweis={`Maßgeblich: ${frequenzLabel(k.frequenz)}. Mindestfrequenz aus der Häufigkeitsmatrix: ${frequenzLabel(k.ableitung.mindest)} – eine Frequenz darunter braucht eine Begründung. Freigabe in jedem Fall durch eine zweite Person.`}
                action={frequenzAbweichungBeantragen}
                felder={felder}
                bestaetigen="Abweichung beantragen"
                disabled={!!sperre}
                disabledGrund={sperre ?? undefined}
              >
                <div className="g12">
                  <div className="gc-6">
                    <label className="label-sm" htmlFor={`fa-turnus-${k.id}`}>
                      Turnus
                    </label>
                    <select
                      id={`fa-turnus-${k.id}`}
                      name="turnus"
                      className="input"
                      style={SEL}
                      defaultValue={k.frequenz.turnus}
                    >
                      {(['MONATLICH', 'QUARTALSWEISE', 'JAEHRLICH', 'KEIN'] as const).map((t) => (
                        <option key={t} value={t}>
                          {t === 'KEIN' ? 'kein Turnus' : TURNUS_LABEL[t]}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="gc-6" style={{ display: 'flex', alignItems: 'flex-end' }}>
                    <label className="row-s text-sm text-secondary" style={{ paddingBottom: 7 }}>
                      <input
                        type="checkbox"
                        className="checkbox"
                        name="anlass"
                        defaultChecked={k.frequenz.anlass}
                      />{' '}
                      zusätzlich bei jeder Auslösung
                    </label>
                  </div>
                </div>
              </BegruendungsDialog>
            ) : null}
            {offen ? (
              <>
                <AktionsForm action={frequenzAbweichungEntscheiden} className="inline-form">
                  <input type="hidden" name="id" value={k.id} />
                  <input type="hidden" name="entscheidung" value="freigeben" />
                  <input type="hidden" name="stand" value={seite.standIso} />
                  <SubmitButton
                    className="btn-primary btn-tiny"
                    disabled={!!sperre || !darfEntscheiden}
                    title={
                      sperre ??
                      (darfEntscheiden
                        ? undefined
                        : 'Von dir beantragt – die Freigabe erteilt eine zweite Person')
                    }
                  >
                    <Icon name="Check" className="tx-icon-xs" /> Abweichung freigeben
                  </SubmitButton>
                </AktionsForm>
                <BegruendungsDialog
                  ausloeser="Ablehnen…"
                  titel="Frequenzabweichung ablehnen"
                  action={frequenzAbweichungEntscheiden}
                  felder={{ ...felder, entscheidung: 'ablehnen' }}
                  bestaetigen="Ablehnen"
                  vierAugen={false}
                  disabled={!!sperre || !darfEntscheiden}
                  disabledGrund={
                    sperre ?? 'Von dir beantragt – die Entscheidung trifft eine zweite Person'
                  }
                />
              </>
            ) : null}
            {freigegeben ? (
              <BegruendungsDialog
                ausloeser="Abweichung aufheben…"
                titel="Frequenzabweichung aufheben"
                hinweis={`Danach gilt wieder die abgeleitete Frequenz (${frequenzLabel(k.ableitung.effektiv)}); künftige Durchführungen werden neu geplant.`}
                action={frequenzAbweichungAufheben}
                felder={felder}
                bestaetigen="Aufheben"
                vierAugen={false}
                disabled={!!sperre}
                disabledGrund={sperre ?? undefined}
              />
            ) : null}
          </div>
        </Abschnitt>

        <Abschnitt
          titel="Designbeurteilung"
          offen={k.design !== 'ANGEMESSEN'}
          rechts={
            <DesignBadge
              design={k.design}
              von={personName(ctx, k.designVon)}
              am={k.designAm}
              kurz
            />
          }
        >
          {k.design === 'NICHT_BEURTEILT' ? (
            <p className="text-sm text-muted">
              Noch nicht beurteilt. Ohne Designbeurteilung zählt die Kontrolle für Netto (Design)
              nicht.
            </p>
          ) : (
            <>
              <DesignBadge design={k.design} von={personName(ctx, k.designVon)} am={k.designAm} />
              {k.designBegruendung ? (
                <p className="text-xs text-secondary">„{k.designBegruendung}“</p>
              ) : null}
              <span className="text-11 text-muted">
                Designbeurteilung durch {personName(ctx, k.designVon)} ·{' '}
                {k.designAm ? datumZeit(k.designAm) : '—'}
              </span>
            </>
          )}
          <div>
            <BegruendungsDialog
              ausloeser={
                <>
                  <Icon name="ShieldCheck" className="tx-icon-xs" />{' '}
                  {k.design === 'NICHT_BEURTEILT' ? 'Design beurteilen…' : 'Neu beurteilen…'}
                </>
              }
              titel={`${k.code} · Designbeurteilung`}
              hinweis="Die Beurteilung wird mit Name und Datum als neuer Kontrollstand dokumentiert. Ein Mangel nimmt den Netto-Abschlag dieser Kontrolle weg."
              action={designBeurteilen}
              felder={felder}
              bestaetigen="Beurteilung speichern"
              vierAugen={false}
              disabled={!!sperre}
              disabledGrund={sperre ?? undefined}
            >
              <span className="label">Ergebnis</span>
              <div className="row-lg">
                <label className="row-s text-sm">
                  <input type="radio" name="design" value="ANGEMESSEN" required />{' '}
                  Designbeurteilung: angemessen
                </label>
                <label className="row-s text-sm">
                  <input type="radio" name="design" value="MANGEL" required /> Mangel
                </label>
              </div>
            </BegruendungsDialog>
          </div>
        </Abschnitt>

        <Abschnitt titel="Zuständigkeiten">
          <div className="g12 text-sm">
            <div className="gc-4">
              <span className="label-sm">Durchführend</span>
              {personName(ctx, k.durchfuehrendId)}
            </div>
            <div className="gc-4">
              <span className="label-sm">Vertretung</span>
              {personName(ctx, k.vertretungId)}
            </div>
            <div className="gc-4">
              <span className="label-sm">Gegenzeichnung</span>
              {k.gegenzeichnungMandant
                ? `${personName(ctx, k.vertretungId)} (zweite Person beim Mandanten)`
                : personName(ctx, k.gegenzeichnerId)}
              {k.schluessel ? <span className="text-11 text-muted"> · Pflicht</span> : null}
            </div>
          </div>
          <details className="details-box">
            <summary>
              <Icon name="Users" className="tx-icon-xs" /> Zuständigkeiten ändern
            </summary>
            <div className="details-body">
              <AktionsForm action={verantwortlicheAendern} className="col">
                <input type="hidden" name="id" value={k.id} />
                <input type="hidden" name="stand" value={seite.standIso} />
                <fieldset
                  disabled={!!sperre}
                  style={{ border: 0, padding: 0, margin: 0 }}
                  className="col"
                >
                  <div className="g12">
                    <Personenwahl
                      name="durchfuehrendId"
                      label={`Durchführend (${PARTEI_LABEL[k.partei]})`}
                      personen={seitePersonen}
                      wert={k.durchfuehrendId}
                    />
                    <Personenwahl
                      name="vertretungId"
                      label={`Vertretung (${PARTEI_LABEL[k.partei]})`}
                      personen={seitePersonen}
                      wert={k.vertretungId}
                    />
                    <Personenwahl
                      name="gegenzeichnerId"
                      label="Gegenzeichnung (Kanzlei)"
                      personen={kanzlei}
                      wert={k.gegenzeichnerId}
                      leer={k.schluessel ? undefined : '— keine —'}
                    />
                    {k.partei === 'MANDANT' ? (
                      <div className="gc-6" style={{ display: 'flex', alignItems: 'flex-end' }}>
                        <label
                          className="row-s text-sm text-secondary"
                          style={{ paddingBottom: 7 }}
                        >
                          <input
                            type="checkbox"
                            className="checkbox"
                            name="gegenzeichnungMandant"
                            defaultChecked={k.gegenzeichnungMandant}
                          />{' '}
                          Gegenzeichnung durch zweite Person beim Mandanten (Vertretung)
                        </label>
                      </div>
                    ) : null}
                  </div>
                  <p className="hint">
                    Die Gegenzeichnung erfolgt nie durch die durchführende Person derselben
                    Durchführung. Die Änderung erzeugt einen neuen Kontrollstand.
                  </p>
                  <div className="form-actions">
                    <SubmitButton
                      className="btn-primary btn-tiny"
                      disabled={!!sperre}
                      title={sperre ?? undefined}
                    >
                      Zuständigkeiten speichern
                    </SubmitButton>
                  </div>
                </fieldset>
              </AktionsForm>
            </div>
          </details>
        </Abschnitt>

        <Abschnitt
          titel={`Durchführungen (${durchf.length})`}
          offen
          rechts={
            <span className={BETRIEB_BADGE[k.betrieb]} title={BETRIEB_LABEL[k.betrieb]}>
              Betrieb: {BETRIEB_KURZ[k.betrieb]}
            </span>
          }
        >
          {durchf.length === 0 ? (
            <p className="text-sm text-muted">
              Keine Durchführungen geplant
              {k.frequenz.turnus === 'KEIN'
                ? ' – Prüfung bei Auslösung (Ereignis).'
                : ctx.programm?.wirksamAb
                  ? '.'
                  : ' – die Planung beginnt mit dem Wirksamkeitszeitraum.'}
            </p>
          ) : null}
          {[...geplant, ...vergangen].map((d) => {
            const f = feststellungJeDurchfuehrung.get(d.id);
            return (
              <div key={d.id} className="row-between" style={{ gap: 8, flexWrap: 'wrap' }}>
                <Link href={mitStand(`${basis}/durchfuehrungen/${d.id}`)} className="text-sm">
                  {d.periodeLabel}
                  {d.ausserplanmaessig ? (
                    <span className="text-11 text-muted"> · außerplanmäßig</span>
                  ) : null}
                </Link>
                <span className="row-s" style={{ flexWrap: 'wrap' }}>
                  <span className="text-11 text-muted">fällig {fmtDatum(d.faelligAm)}</span>
                  <DurchfuehrungBadge d={d} />
                  {f ? (
                    <Link
                      href={mitStand(`${basis}/feststellungen/${f.id}`)}
                      className="text-11 mono"
                    >
                      {f.nummer}
                    </Link>
                  ) : null}
                  {d.durchgefuehrtVon ? (
                    <span className="text-11 text-muted">
                      {kurzName(personName(ctx, d.durchgefuehrtVon))}
                    </span>
                  ) : null}
                </span>
              </div>
            );
          })}
          {durchf.length > geplant.length + vergangen.length ? (
            <span className="text-11 text-muted">
              … weitere {durchf.length - geplant.length - vergangen.length} im Kalender
            </span>
          ) : null}
        </Abschnitt>

        <Abschnitt titel={`Stand-Historie (${detail?.staende.length ?? 0})`}>
          {(detail?.staende ?? []).map((s) => (
            <div key={s.id} className="row" style={{ alignItems: 'flex-start', gap: 10 }}>
              <span className={s.id === k.standId ? 'badge-brand mono' : 'badge-gray mono'}>
                v{s.version}
              </span>
              <span className="col-s grow" style={{ gap: 2 }}>
                <span className="text-sm">{s.aenderungen.join(', ')}</span>
                <span className="text-11 text-muted">
                  {datumZeit(s.gueltigAb)} – {s.gueltigBis ? datumZeit(s.gueltigBis) : 'aktuell'} ·{' '}
                  {personName(ctx, s.erstelltVon)}
                  {s.design !== 'NICHT_BEURTEILT'
                    ? ` · Design ${s.design === 'ANGEMESSEN' ? 'angemessen' : 'Mangel'}`
                    : ''}
                  {s.abweichung
                    ? ` · Abweichung ${frequenzLabel({ turnus: s.abweichung.turnus, anlass: s.abweichung.anlass })}${s.abweichung.freigegebenVon ? '' : ' (beantragt)'}`
                    : ''}
                </span>
              </span>
            </div>
          ))}
          <p className="text-11 text-muted">
            Laufende Durchführungen behalten ihre Version; jede Änderung schreibt einen neuen Stand
            mit Gültig-ab fort.
          </p>
        </Abschnitt>

        <Abschnitt titel="Historie">
          {(detail?.audit ?? []).length === 0 ? (
            <p className="text-sm text-muted">
              Keine protokollierten Änderungen an dieser Kontrolle.
            </p>
          ) : null}
          {(detail?.audit ?? []).map((a) => (
            <div key={a.seq} className="row" style={{ alignItems: 'flex-start' }}>
              <span className="text-xs mono text-muted shrink0">{datumZeit(a.at)}</span>
              <span className="text-xs text-secondary shrink0">{a.actorName}</span>
              <span className="text-sm grow">
                {KONTROLL_AUDIT_LABEL[a.aktion] ?? a.aktion}
                {auditKurztext(a.detail) ? (
                  <span className="text-11 text-muted"> · {auditKurztext(a.detail)}</span>
                ) : null}
              </span>
            </div>
          ))}
        </Abschnitt>
      </div>
    </DetailDrawer>
  );
}
