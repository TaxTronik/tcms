import Link from 'next/link';
import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { fmtDatum, fmtDatumZeit, PARTEI_LABEL } from '@tcms/domain';
import { Icon } from '@/components/icon';
import { GtBadge, StatusBadge } from '@/components/ui/badges';
import { BegruendungsDialog } from '@/components/ui/client';
import { Leerzustand } from '@/components/ui/leer';
import { TcmsKopf } from '@/components/tcms/kopf';
import { DurchfuehrungEditor } from '@/components/durchfuehrung/editor';
import {
  AktionsKnopf,
  EntwurfFormular,
  GegenzeichnenMitBefundDialog,
} from '@/components/durchfuehrung/formulare';
import {
  KontrollbeschreibungKarte,
  LetzteKarte,
  NachweiseKarte,
  PersonenbelegeKarte,
  RisikenKarte,
  VerlaufKarte,
} from '@/components/durchfuehrung/karten';
import {
  beantrageEntfallen,
  beginneDurchfuehrung,
  entferneNachweis,
  gegenzeichneDurchfuehrung,
  gibEntfallenFrei,
  ladeNachweisHoch,
  legeNachtragAn,
  lehneEntfallenAb,
  speichereDurchfuehrung,
  weiseDurchfuehrungZurueck,
} from '@/server/actions/durchfuehrung';
import {
  ladeDurchfuehrungDetail,
  MIN_BEFUND_KOMMENTAR,
  ohneInhalte,
  personName,
  pruefungAus,
  statusZumStand,
  type DurchfuehrungDetail,
} from '@/server/durchfuehrung-daten';
import { ladeStaffSeite } from '@/server/seite';

export const metadata = { title: 'Kontrolldurchführung' };

const FORM_ID = 'durchfuehrung-entwurf';

function periodeKurz(label: string): string {
  const m = /^([A-Za-zÄÖÜäöü]+) (\d{4})/.exec(label);
  return m && m[1]!.length > 3 ? `${m[1]!.slice(0, 3)} ${m[2]}` : label.replace(' · Nachtrag', '');
}

function kurz(d: DurchfuehrungDetail, id: string | null | undefined): string {
  return personName(d, id);
}

export default async function Kontrolldurchfuehrung({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; did: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id, did } = await params;
  const seite = await ladeStaffSeite(id, await searchParams);
  const { ctx, basis, mitStand, nutzer } = seite;
  // Rechte und Mandantenzugehörigkeit prüft der Service (nicht sichtbar → 404).
  const d = await ladeDurchfuehrungDetail(
    nutzer,
    id,
    did,
    ctx.historisch ? seite.standIso : undefined,
  );
  if (!d) notFound();

  const zurueck = (
    <Link href={mitStand(`${basis}/kontrollen`)} className="back-link" style={{ marginBottom: 0 }}>
      <Icon name="ArrowLeft" className="tx-icon-xs" /> zurück zu Kontrollen
    </Link>
  );

  if (!d.vorhandenZumStand) {
    return (
      <>
        <TcmsKopf seite={seite} titel={zurueck} />
        <div className="card">
          <Leerzustand
            icon="History"
            text={`Diese Durchführung wurde erst am ${fmtDatum(d.createdAt)} angelegt und existierte zum Stichtag noch nicht.`}
          >
            <Link href={`${basis}/durchfuehrungen/${d.id}`} className="btn-secondary">
              Zum aktuellen Stand
            </Link>
          </Leerzustand>
        </div>
      </>
    );
  }

  const r = d.rechte;
  const pruefung = pruefungAus(d);
  const kv = ctx.kontrollen.find((k) => k.id === d.kontrolle.id) ?? null;
  const felder = { id: d.id, mandant: d.mandantId, stand: ctx.historisch ? seite.standIso : '' };
  const istPruefer =
    d.status === 'ZUR_GEGENZEICHNUNG' && (r.gegenzeichnen.erlaubt || r.zurueckweisen.erlaubt);
  const istDurchfuehrend = d.beteiligte.includes(nutzer.id);
  const bearbeitbar = r.bearbeiten.erlaubt && d.status !== 'GEPLANT';
  const abgeschlossen = d.status === 'OHNE_BEFUND' || d.status === 'MIT_BEFUND';
  const offenerAntrag = d.status !== 'ENTFALLEN' && !!d.entfallenBegruendung;
  const gzm = d.kontrolle.gegenzeichnungMandant;
  const zeigeEntfallen =
    !ctx.historisch &&
    ['GEPLANT', 'IN_DURCHFUEHRUNG', 'ZURUECKGEWIESEN'].includes(d.status) &&
    !offenerAntrag;

  const editorKey = JSON.stringify([
    seite.standIso,
    ctx.historisch,
    r.bearbeiten.erlaubt && d.status !== 'GEPLANT',
    d.schritte,
    d.werte,
    d.ergebnis,
    d.ergebnisKommentar,
  ]);
  // Historischer Stand: Bedienleiste nach dem Status zum Stichtag; vor Beginn keine Inhalte.
  const fussStatus = ctx.historisch ? statusZumStand(d) : d.status;
  const leerZumStand = ctx.historisch && !d.begonnenAm;
  const inhalt = leerZumStand ? ohneInhalte(d) : d;

  // ------------------------------------------------------------ Kopfzeile rechts
  const kopfRechts = [
    `fällig bis ${fmtDatum(d.faelligAm)}`,
    d.eingereichtAm
      ? `eingereicht ${fmtDatumZeit(d.eingereichtAm)} von ${kurz(d, d.durchgefuehrtVon)}`
      : d.begonnenAm
        ? `begonnen ${fmtDatumZeit(d.begonnenAm)}`
        : null,
    d.abgeschlossenAm
      ? `gegengezeichnet ${fmtDatumZeit(d.abgeschlossenAm)} von ${kurz(d, d.gegengezeichnetVon)}`
      : null,
  ]
    .filter(Boolean)
    .join(' · ');

  const entfallenDialog = zeigeEntfallen ? (
    <BegruendungsDialog
      ausloeser={
        <>
          <Icon name="Ban" className="tx-icon-xs" /> Entfallen beantragen …
        </>
      }
      ausloeserClass="btn-secondary"
      titel="Entfallen beantragen"
      hinweis="Nur mit Begründung, z. B. keine Umsätze im Zeitraum. Eine entfallene Durchführung zählt nicht als „ohne Befund“. Die Freigabe erteilt eine zweite Person (Berufsträger:in)."
      action={beantrageEntfallen}
      felder={felder}
      bestaetigen="Antrag stellen"
      disabled={!r.entfallenBeantragen.erlaubt}
      disabledGrund={r.entfallenBeantragen.grund ?? undefined}
    />
  ) : null;

  // ------------------------------------------------------------------ Fußleiste
  let fuss: ReactNode = null;
  if (bearbeitbar) {
    fuss = (
      <EntwurfFormular
        action={speichereDurchfuehrung}
        formId={FORM_ID}
        felder={felder}
        einreichen="Zur Gegenzeichnung einreichen"
        links={entfallenDialog}
      />
    );
  } else if (fussStatus === 'GEPLANT') {
    fuss = (
      <div className="form-actions">
        {entfallenDialog}
        <AktionsKnopf
          action={beginneDurchfuehrung}
          felder={felder}
          disabled={!r.beginnen.erlaubt}
          title={r.beginnen.grund ?? 'Status wechselt zu „In Durchführung“'}
        >
          <Icon name="CircleDot" /> Durchführung beginnen
        </AktionsKnopf>
      </div>
    );
  } else if (fussStatus === 'IN_DURCHFUEHRUNG' || fussStatus === 'ZURUECKGEWIESEN') {
    fuss = (
      <div className="form-actions">
        {entfallenDialog}
        <button
          type="button"
          className="btn-secondary"
          disabled
          title={r.bearbeiten.grund ?? undefined}
        >
          <Icon name="Save" /> Entwurf speichern
        </button>
        <button
          type="button"
          className="btn-primary"
          disabled
          title={r.bearbeiten.grund ?? undefined}
        >
          <Icon name="Send" /> Zur Gegenzeichnung einreichen
        </button>
      </div>
    );
  } else if (fussStatus === 'ZUR_GEGENZEICHNUNG') {
    const befundOhneFeststellung = d.ergebnis === 'MIT_BEFUND' && d.feststellungen.length === 0;
    fuss = (
      <div className="form-actions" style={{ alignItems: 'flex-start' }}>
        <button
          type="button"
          className="btn-secondary"
          disabled
          title="Einreichung liegt vor — keine Änderung mehr möglich"
        >
          <Icon name="Save" /> Entwurf speichern
        </button>
        <BegruendungsDialog
          ausloeser={
            <>
              <Icon name="RotateCcw" /> Zurückweisen …
            </>
          }
          ausloeserClass="btn-danger-outline"
          titel="Durchführung zurückweisen"
          hinweis="Die durchführende Person erhält die Begründung und kann die Angaben überarbeiten. Die Nachweise werden dafür wieder entsperrt; die eingereichte Fassung bleibt im Audit-Protokoll mit Hashes belegt."
          action={weiseDurchfuehrungZurueck}
          felder={felder}
          bestaetigen="Zurückweisen"
          vierAugen={false}
          disabled={!r.zurueckweisen.erlaubt}
          disabledGrund={r.zurueckweisen.grund ?? undefined}
        />
        {befundOhneFeststellung ? (
          <GegenzeichnenMitBefundDialog
            action={gegenzeichneDurchfuehrung}
            felder={felder}
            disabled={!r.gegenzeichnen.erlaubt}
            title={r.gegenzeichnen.grund ?? 'Feststellung inline erfassen und gegenzeichnen'}
            risiken={d.risiken}
            vorschlagTitel={`${d.kontrolle.titel} ${d.periodeLabel}: Befund`}
            vorschlagSachverhalt={d.ergebnisKommentar ?? ''}
          />
        ) : (
          <AktionsKnopf
            action={gegenzeichneDurchfuehrung}
            felder={felder}
            disabled={!r.gegenzeichnen.erlaubt}
            title={
              r.gegenzeichnen.grund ??
              'Gegenzeichnung durch eine zweite Person (Vier-Augen-Prinzip)'
            }
            bestaetigen={`Durchführung gegenzeichnen – abgeschlossen ${d.ergebnis === 'MIT_BEFUND' ? 'mit' : 'ohne'} Befund?`}
          >
            <Icon name="UserCheck" /> Gegenzeichnen
          </AktionsKnopf>
        )}
      </div>
    );
  } else if (fussStatus === 'OHNE_BEFUND' || fussStatus === 'MIT_BEFUND') {
    fuss = (
      <div className="form-actions">
        <span className="text-xs text-muted grow" style={{ textAlign: 'right' }}>
          Abgeschlossene Durchführungen sind unveränderlich; Korrekturen entstehen als verknüpfter
          Nachtrag.
        </span>
        <BegruendungsDialog
          ausloeser={
            <>
              <Icon name="Plus" /> Nachtrag anlegen …
            </>
          }
          ausloeserClass="btn-secondary"
          titel="Nachtrag anlegen"
          hinweis="Der Nachtrag ist eine eigene, verknüpfte Durchführung derselben Periode und Kontrollversion. Die abgeschlossene Durchführung bleibt unverändert."
          action={legeNachtragAn}
          felder={felder}
          bestaetigen="Nachtrag anlegen"
          vierAugen={false}
          disabled={!r.nachtrag.erlaubt}
          disabledGrund={r.nachtrag.grund ?? undefined}
        />
      </div>
    );
  }

  // ------------------------------------------------- Zusatz in der Ergebnis-Karte
  const ergebnisZusatz = (
    <>
      {d.feststellungen.length > 0 ? (
        <div className="mt-2 col-s">
          {d.feststellungen.map((f) => (
            <Link
              key={f.id}
              href={mitStand(`${basis}/feststellungen/${f.id}`)}
              className="row-s text-sm"
              style={{ textDecoration: 'none' }}
            >
              <Icon name="FileCheck" className="tx-icon-xs" /> Verknüpfte Feststellung {f.nummer} ·{' '}
              {f.maskiert ? 'Vertrauliche Feststellung' : f.titel}
            </Link>
          ))}
        </div>
      ) : d.status === 'ZUR_GEGENZEICHNUNG' && d.ergebnis === 'MIT_BEFUND' ? (
        <div className="hint mt-2">
          Die verknüpfte Feststellung wird bei der Gegenzeichnung erfasst.
        </div>
      ) : null}
      {bearbeitbar ? (
        <div
          className="mt-3"
          style={{ borderTop: '1px solid rgb(var(--border-subtle))', paddingTop: 10 }}
        >
          <div className="label-sm">Voraussetzungen für das Einreichen (gespeicherter Stand)</div>
          <div className="row-wrap" style={{ gap: 14 }}>
            {[
              {
                ok: pruefung.schritteErledigt === pruefung.schritteGesamt,
                text: `Schritte ${pruefung.schritteErledigt}/${pruefung.schritteGesamt}`,
              },
              ...(d.kennzahlen.length
                ? [
                    {
                      ok: pruefung.werteFehlend.length === 0,
                      text: pruefung.werteFehlend.length
                        ? `${pruefung.werteFehlend.length} Werte offen`
                        : 'Werte vollständig',
                    },
                  ]
                : []),
              ...(pruefung.ausserhalb.length
                ? [
                    {
                      ok: d.ergebnis === 'MIT_BEFUND',
                      text: `Toleranz: ${pruefung.ausserhalb.length} nicht erklärt`,
                    },
                  ]
                : []),
              {
                ok: pruefung.nachweise >= pruefung.mindestNachweise,
                text: `Nachweise ${pruefung.nachweise}/${pruefung.mindestNachweise}`,
              },
              {
                ok: !!pruefung.ergebnis && !pruefung.kommentarFehlt,
                text: pruefung.ergebnis
                  ? pruefung.kommentarFehlt
                    ? 'Befund beschreiben'
                    : 'Ergebnis gewählt'
                  : 'Ergebnis offen',
              },
            ].map((x) => (
              <span key={x.text} className="row-s text-xs">
                <Icon
                  name={x.ok ? 'CircleCheck' : 'Circle'}
                  className={x.ok ? 'tx-icon-xs' : 'tx-icon-xs text-muted'}
                />
                <span className={x.ok ? '' : 'text-muted'}>{x.text}</span>
              </span>
            ))}
          </div>
        </div>
      ) : null}
    </>
  );

  const gesperrtText = ctx.historisch
    ? 'Historischer Stand — nur Lesen'
    : d.status === 'ZUR_GEGENZEICHNUNG'
      ? 'Nach Einreichung gesperrt'
      : abgeschlossen
        ? 'Abgeschlossen — Nachweise gesperrt und unveränderlich'
        : d.status === 'ENTFALLEN'
          ? 'Entfallen — keine Uploads'
          : d.status === 'GEPLANT' && r.beginnen.erlaubt
            ? 'Upload nach Beginn der Durchführung'
            : (r.bearbeiten.grund ?? 'Upload nicht möglich');

  return (
    <>
      <TcmsKopf seite={seite} titel={zurueck} />

      {/* Kopf: Kontrolle, Periode, Status, Partei */}
      <div className="row-between mb-2" style={{ flexWrap: 'wrap', gap: 12 }}>
        <div className="row-lg" style={{ flexWrap: 'wrap' }}>
          <h2 className="text-xl font-b text-primary">
            {d.kontrolle.code} · {d.kontrolle.titel}
          </h2>
          <span className="badge-brand">Periode: {d.periodeLabel}</span>
          <StatusBadge status={d.anzeige} />
          <span className="badge-gray">Partei: {PARTEI_LABEL[d.kontrolle.partei]}</span>
          {d.kontrolle.schluessel ? (
            <span className="badge-brand" title="Schlüsselkontrolle">
              <Icon name="KeyRound" className="tx-icon-xs" /> Schlüssel
            </span>
          ) : null}
          {kv?.gt ? <GtBadge gt={kv.gt} /> : null}
          {d.ausserplanmaessig ? <span className="badge-gray">außerplanmäßig</span> : null}
        </div>
        <span className="text-xs text-muted shrink0">{kopfRechts}</span>
      </div>
      <div className="row-wrap text-xs text-secondary mb-4" style={{ gap: 14 }}>
        <span>
          <span className="text-muted">Verantwortlich:</span>{' '}
          {personName(d, d.kontrolle.durchfuehrendId)}
        </span>
        <span>
          <span className="text-muted">Vertretung:</span> {personName(d, d.kontrolle.vertretungId)}
        </span>
        <span>
          <span className="text-muted">Durchgeführt von:</span>{' '}
          {d.durchgefuehrtVon && d.begonnenAm ? personName(d, d.durchgefuehrtVon) : '—'}
        </span>
        {gzm ? (
          <>
            <span>
              <span className="text-muted">Bestätigung Mandant:</span>{' '}
              {d.mandantBestaetigtVon
                ? personName(d, d.mandantBestaetigtVon)
                : `zweite Person (vorgesehen ${personName(d, d.kontrolle.gegenzeichnerId)})`}
            </span>
            <span>
              <span className="text-muted">Gegenzeichnung:</span>{' '}
              {d.gegengezeichnetVon
                ? personName(d, d.gegengezeichnetVon)
                : `Kanzlei (${personName(d, d.mandant.berufstraegerId)})`}
            </span>
          </>
        ) : (
          <span>
            <span className="text-muted">Gegenzeichnung:</span>{' '}
            {d.gegengezeichnetVon
              ? personName(d, d.gegengezeichnetVon)
              : personName(d, d.kontrolle.gegenzeichnerId)}
          </span>
        )}
      </div>

      {/* Zustandshinweise */}
      <div className="col mb-4" style={{ gap: 10 }}>
        {d.anzeige === 'UEBERFAELLIG' ? (
          <div className="alert-error row-s" role="alert">
            <Icon name="TriangleAlert" />
            <span>
              <strong>Überfällig.</strong> Fälligkeit {fmtDatum(d.faelligAm)} überschritten —
              Eskalation an {personName(d, d.mandant.berufstraegerId)}. Netto (Betrieb) der
              verknüpften Risiken steigt, bis die Durchführung nachgeholt ist.
            </span>
          </div>
        ) : null}
        {d.original ? (
          <div className="alert-info-sm row-s">
            <Icon name="Link2" />
            <span>
              <strong>Nachtrag</strong> zu{' '}
              <Link href={mitStand(`${basis}/durchfuehrungen/${d.original.id}`)}>
                {d.kontrolle.code} · {d.original.periodeLabel}
              </Link>
              {d.anlass ? ` — ${d.anlass.replace(/^Nachtrag zu [^:]+:\s*/, '')}` : ''}
            </span>
          </div>
        ) : null}
        {d.nachtraege.length > 0 ? (
          <div className="alert-info-sm row-s">
            <Icon name="Link2" />
            <span>
              Korrekturen als Nachtrag:{' '}
              {d.nachtraege.map((n, i) => (
                <span key={n.id}>
                  {i > 0 ? ', ' : ''}
                  <Link href={mitStand(`${basis}/durchfuehrungen/${n.id}`)}>{n.periodeLabel}</Link>
                </span>
              ))}
            </span>
          </div>
        ) : null}
        {d.status === 'ZURUECKGEWIESEN' && d.zurueckweisungsgrund ? (
          <div className="alert-warning row-s" style={{ alignItems: 'flex-start' }}>
            <Icon name="RotateCcw" />
            <span>
              <strong>
                Zurückgewiesen von {personName(d, d.zurueckgewiesenVon)}
                {d.zurueckgewiesenAm ? ` am ${fmtDatumZeit(d.zurueckgewiesenAm)}` : ''}:
              </strong>{' '}
              {d.zurueckweisungsgrund}
            </span>
          </div>
        ) : null}
        {offenerAntrag ? (
          <div
            className="alert-warning row-between"
            style={{ alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}
          >
            <span className="row-s" style={{ alignItems: 'flex-start' }}>
              <Icon name="Ban" />
              <span>
                <strong>Entfallen beantragt von {personName(d, d.entfallenVon)}:</strong>{' '}
                {d.entfallenBegruendung}
              </span>
            </span>
            <span className="row-s" style={{ alignItems: 'flex-start' }}>
              {d.entfallenVon === nutzer.id ? (
                <AktionsKnopf
                  action={lehneEntfallenAb}
                  felder={felder}
                  className="btn-secondary btn-tiny"
                  disabled={!r.entfallenAblehnen.erlaubt}
                  title={r.entfallenAblehnen.grund ?? undefined}
                  bestaetigen="Antrag zurückziehen?"
                >
                  Antrag zurückziehen
                </AktionsKnopf>
              ) : (
                <BegruendungsDialog
                  ausloeser="Ablehnen …"
                  ausloeserClass="btn-secondary btn-tiny"
                  titel="Antrag auf Entfallen ablehnen"
                  action={lehneEntfallenAb}
                  felder={felder}
                  bestaetigen="Ablehnen"
                  vierAugen={false}
                  disabled={!r.entfallenAblehnen.erlaubt}
                  disabledGrund={r.entfallenAblehnen.grund ?? undefined}
                />
              )}
              <AktionsKnopf
                action={gibEntfallenFrei}
                felder={felder}
                className="btn-primary btn-tiny"
                disabled={!r.entfallenFreigeben.erlaubt}
                title={r.entfallenFreigeben.grund ?? 'Als zweite Person freigeben'}
                bestaetigen="Entfallen freigeben? Die Durchführung zählt dann nicht als „ohne Befund“."
              >
                Entfallen freigeben
              </AktionsKnopf>
            </span>
          </div>
        ) : null}
        {d.status === 'ENTFALLEN' ? (
          <div className="alert-info-sm row-s">
            <Icon name="Ban" />
            <span>
              <strong>Entfallen</strong> — {d.entfallenBegruendung} (beantragt von{' '}
              {personName(d, d.entfallenVon)}, freigegeben von{' '}
              {personName(d, d.entfallenFreigegebenVon)}
              {d.entfallenAm ? ` am ${fmtDatum(d.entfallenAm)}` : ''}). Zählt nicht als „ohne
              Befund“.
            </span>
          </div>
        ) : null}
        {d.status === 'ZUR_GEGENZEICHNUNG' && gzm && !d.mandantBestaetigtVon ? (
          <div className="alert-info-sm row-s">
            <Icon name="Users" />
            <span>
              Übermittelt vom Mandanten. Vor der Gegenzeichnung bestätigt eine zweite Person beim
              Mandanten die Vollständigkeit (vorgesehen:{' '}
              {personName(d, d.kontrolle.gegenzeichnerId)}).
            </span>
          </div>
        ) : null}
        {istPruefer ? (
          <div
            className="alert-info-sm"
            style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}
          >
            <Icon name="UserCheck" className="tx-icon-lg" />
            <span>
              <strong>Prüferansicht — {nutzer.name}.</strong> Sie prüfen die Einreichung von{' '}
              {personName(d, d.durchgefuehrtVon)}
              {gzm && d.mandantBestaetigtVon
                ? ` (bestätigt durch ${personName(d, d.mandantBestaetigtVon)})`
                : ''}{' '}
              und zeichnen gegen. Die durchführende Person kann nicht selbst gegenzeichnen.
            </span>
          </div>
        ) : d.status === 'ZUR_GEGENZEICHNUNG' && istDurchfuehrend ? (
          <div className="alert-info-sm row-s">
            <Icon name="Lock" />
            <span>
              Eingereicht — wartet auf Gegenzeichnung durch{' '}
              {gzm
                ? `die Kanzlei (${personName(d, d.mandant.berufstraegerId)})`
                : personName(d, d.kontrolle.gegenzeichnerId)}
              . Die Nachweise sind gesperrt; Sie können nicht selbst gegenzeichnen.
            </span>
          </div>
        ) : null}
        {d.kontrolle.partei === 'MANDANT' &&
        ['GEPLANT', 'IN_DURCHFUEHRUNG', 'ZURUECKGEWIESEN'].includes(d.status) ? (
          <div className="alert-info-sm row-s">
            <Icon name="Building2" />
            <span>
              Durchführung durch den Mandanten im Portal (
              {personName(d, d.kontrolle.durchfuehrendId)}, Vertretung{' '}
              {personName(d, d.kontrolle.vertretungId)}).
            </span>
          </div>
        ) : null}
        {ctx.historisch ? (
          <div className="text-xs text-muted">
            {leerZumStand
              ? 'Zum Stichtag war die Durchführung noch nicht begonnen; Checkliste, Werte und Ergebnis sind daher leer.'
              : 'Status, Nachweise, Verlauf und Personenbelege beziehen sich auf den Stichtag. Checkliste, Werte und Ergebnis zeigen die zuletzt gespeicherte Fassung (Zwischenstände werden nicht versioniert).'}
          </div>
        ) : null}
      </div>

      <div className="g12">
        {/* Hauptspalte */}
        <div className="gc-8 col" style={{ gap: 16 }}>
          <DurchfuehrungEditor
            key={editorKey}
            variante="staff"
            formId={FORM_ID}
            bearbeitbar={bearbeitbar}
            sperrGrund={bearbeitbar ? null : (r.bearbeiten.grund ?? null)}
            schritte={inhalt.schritte}
            kennzahlen={d.kennzahlen}
            werte={inhalt.werte}
            toleranzEur={d.kontrolle.toleranzEur}
            periodeKurz={periodeKurz(d.periodeLabel)}
            ergebnis={inhalt.ergebnis}
            ergebnisKommentar={inhalt.ergebnisKommentar}
            minBefund={MIN_BEFUND_KOMMENTAR}
            ergebnisZusatz={ergebnisZusatz}
            nachweise={
              <NachweiseKarte
                d={d}
                variante="staff"
                hochladen={r.bearbeiten}
                hochladenAction={ladeNachweisHoch}
                entfernenAction={entferneNachweis}
                felder={felder}
                gesperrtText={gesperrtText}
              />
            }
          />
        </div>

        {/* Seitenspalte */}
        <div className="gc-4 col" style={{ gap: 16 }}>
          <KontrollbeschreibungKarte d={d} frequenz={kv?.frequenz ?? null} />
          <RisikenKarte
            d={d}
            href={(rid) => mitStand(`${basis}/risiken?risiko=${encodeURIComponent(rid)}`)}
          />
          <LetzteKarte d={d} href={(x) => mitStand(`${basis}/durchfuehrungen/${x}`)} />
          <PersonenbelegeKarte d={d} />
          <VerlaufKarte d={d} />
        </div>
      </div>

      <div className="mt-4">{fuss}</div>
    </>
  );
}
