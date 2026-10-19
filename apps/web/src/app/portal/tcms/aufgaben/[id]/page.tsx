import Link from 'next/link';
import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import {
  ANZEIGE_BADGE,
  fmtDatum,
  fmtDatumKurz,
  fmtDatumZeit,
  type AnzeigeStatus,
} from '@tcms/domain';
import { Icon } from '@/components/icon';
import { BegruendungsDialog } from '@/components/ui/client';
import { DurchfuehrungEditor } from '@/components/durchfuehrung/editor';
import { AktionsKnopf, EntwurfFormular } from '@/components/durchfuehrung/formulare';
import { NachweiseKarte } from '@/components/durchfuehrung/karten';
import {
  bestaetigeAufgabe,
  entferneAnlage,
  gibAufgabeZurueck,
  ladeAnlageHoch,
  speichereAufgabe,
} from '@/server/actions/portal-aufgabe';
import {
  darfPortalLesen,
  ladeDurchfuehrungDetail,
  MIN_BEFUND_KOMMENTAR,
  ohneInhalte,
  personName,
  rechteFuer,
  statusZumStand,
  type DurchfuehrungDetail,
} from '@/server/durchfuehrung-daten';
import { brauchtPortal } from '@/server/sitzung';
import { leseStand } from '@/server/zeit';

export const metadata = { title: 'Kontrollaufgabe' };

const FORM_ID = 'aufgabe-entwurf';

function statusText(d: DurchfuehrungDetail): string {
  const a: AnzeigeStatus = d.anzeige;
  switch (a) {
    case 'UEBERFAELLIG':
      return `überfällig (Frist ${fmtDatum(d.faelligAm)})`;
    case 'FAELLIG':
      return `fällig bis ${fmtDatum(d.faelligAm)}`;
    case 'IN_DURCHFUEHRUNG':
      return `in Bearbeitung · Frist ${fmtDatum(d.faelligAm)}`;
    case 'ZURUECKGEWIESEN':
      return 'zur Überarbeitung zurückgegeben';
    case 'ZUR_GEGENZEICHNUNG':
      return d.kontrolle.gegenzeichnungMandant && !d.mandantBestaetigtVon
        ? 'übermittelt – Bestätigung ausstehend'
        : 'übermittelt – Prüfung durch die Kanzlei';
    case 'OHNE_BEFUND':
      return 'abgeschlossen – ohne Befund';
    case 'MIT_BEFUND':
      return 'abgeschlossen – mit Befund';
    case 'ENTFALLEN':
      return 'entfallen';
    default:
      return `geplant (ab ${fmtDatum(d.periodeBis)})`;
  }
}

function Punkt({
  farbe,
  children,
}: {
  farbe: 'green' | 'amber' | 'red' | 'gray';
  children: ReactNode;
}) {
  return (
    <span className="row-s" style={{ alignItems: 'flex-start' }}>
      <span className={`status-dot dot-${farbe}`} style={{ marginTop: 6 }} />
      <span className="text-sm">{children}</span>
    </span>
  );
}

export default async function Kontrollaufgabe({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const nutzer = (await brauchtPortal()).handelnde;
  const { id } = await params;
  const sp = await searchParams;
  const { stand, historisch } = leseStand(sp['stand']);
  const d = await ladeDurchfuehrungDetail(id, stand, historisch);
  if (!d || !darfPortalLesen(nutzer, d) || !d.vorhandenZumStand) notFound();

  const r = rechteFuer(nutzer, d, historisch);
  const felder = { id: d.id, stand: historisch ? (sp['stand']?.toString() ?? '') : '' };
  const gzm = d.kontrolle.gegenzeichnungMandant;
  const bearbeitbar = r.bearbeiten.erlaubt;
  // Im historischen Stand gilt der Status zum Stichtag; vor Beginn keine Inhalte.
  const status = historisch ? statusZumStand(d) : d.status;
  const offen = ['GEPLANT', 'IN_DURCHFUEHRUNG', 'ZURUECKGEWIESEN'].includes(status);
  const abgeschlossen = status === 'OHNE_BEFUND' || status === 'MIT_BEFUND';
  const inhalt = historisch && !d.begonnenAm ? ohneInhalte(d) : d;
  const zugewiesen =
    nutzer.id === d.kontrolle.durchfuehrendId || nutzer.id === d.kontrolle.vertretungId;
  const kanzlei = personName(d, d.mandant.berufstraegerId);
  const editorKey = JSON.stringify([
    historisch ? stand.toISOString() : '',
    r.bearbeiten.erlaubt,
    d.schritte,
    d.werte,
    d.ergebnis,
    d.ergebnisKommentar,
  ]);

  // -------------------------------------------------------------- Anleitung
  let anleitung: ReactNode;
  if (offen && zugewiesen) {
    anleitung = (
      <>
        {d.kontrolle.ziel} Bitte erledigen Sie die Schritte für {d.periodeLabel} und laden Sie die
        Nachweise hoch ({d.kontrolle.nachweis}). Nach dem Übermitteln{' '}
        {gzm
          ? 'bestätigt eine zweite Person bei Ihnen die Vollständigkeit; danach prüft die Kanzlei.'
          : 'erfolgt die Prüfung durch die Kanzlei.'}
      </>
    );
  } else if (offen) {
    anleitung = (
      <>
        Diese Aufgabe bearbeitet {personName(d, d.kontrolle.durchfuehrendId)} (Vertretung{' '}
        {personName(d, d.kontrolle.vertretungId)}). Sie sehen den{' '}
        {historisch ? `Stand zum ${fmtDatum(stand)}` : 'aktuellen Stand'}.
      </>
    );
  } else if (
    status === 'ZUR_GEGENZEICHNUNG' &&
    gzm &&
    !d.mandantBestaetigtVon &&
    r.mandantBestaetigen.erlaubt
  ) {
    anleitung = (
      <>
        {personName(d, d.durchgefuehrtVon)} hat die Aufgabe am {fmtDatumZeit(d.eingereichtAm)}{' '}
        übermittelt. Bitte prüfen Sie die Angaben und Anlagen auf Vollständigkeit und bestätigen Sie
        sie. Danach prüft die Kanzlei und schließt die Aufgabe ab.
      </>
    );
  } else if (status === 'ZUR_GEGENZEICHNUNG') {
    anleitung = (
      <>
        Vielen Dank – die Angaben wurden am {fmtDatumZeit(d.eingereichtAm)} von{' '}
        {personName(d, d.durchgefuehrtVon)} übermittelt. Die Anlagen sind jetzt gesperrt.{' '}
        {gzm && !d.mandantBestaetigtVon
          ? 'Als Nächstes bestätigt eine zweite Person bei Ihnen die Vollständigkeit.'
          : `Die Kanzlei (${kanzlei}) prüft und schließt die Aufgabe ab.`}
      </>
    );
  } else if (abgeschlossen) {
    anleitung = (
      <>
        Die Kanzlei hat die Aufgabe am {fmtDatumZeit(d.abgeschlossenAm)} abgeschlossen (
        {status === 'OHNE_BEFUND' ? 'ohne Befund' : 'mit Befund'}). Die Angaben und Anlagen sind
        unveränderlich gespeichert.
      </>
    );
  } else {
    anleitung = (
      <>Diese Aufgabe ist entfallen{d.entfallenBegruendung ? `: ${d.entfallenBegruendung}` : '.'}</>
    );
  }

  // ------------------------------------------------------------- Mini-Schritte
  const ersterOffen = inhalt.schritte.findIndex((s) => !s.erledigt);
  const offeneSchritte = inhalt.schritte.filter((s) => !s.erledigt).length;
  const fehlendeAnlagen = Math.max(0, d.kontrolle.mindestNachweise - d.nachweise.length);

  // ------------------------------------------------------------------ Fußleiste
  let fuss: ReactNode = null;
  if (bearbeitbar) {
    fuss = (
      <EntwurfFormular
        action={speichereAufgabe}
        formId={FORM_ID}
        felder={felder}
        einreichen={gzm ? 'Zur Bestätigung übermitteln' : 'An Kanzlei übermitteln'}
        einreichenTitel="Alle Schritte erledigt, Anlagen vollständig und Ergebnis gewählt"
      />
    );
  } else if (offen) {
    fuss = (
      <div className="form-actions">
        <button
          type="button"
          className="btn-secondary"
          disabled
          title={r.bearbeiten.grund ?? undefined}
        >
          Entwurf speichern
        </button>
        <button
          type="button"
          className="btn-primary"
          disabled
          title={r.bearbeiten.grund ?? undefined}
        >
          {gzm ? 'Zur Bestätigung übermitteln' : 'An Kanzlei übermitteln'}
        </button>
      </div>
    );
  }

  const gesperrtText = historisch
    ? 'Historischer Stand — nur Lesen'
    : status === 'ZUR_GEGENZEICHNUNG'
      ? 'Nach dem Übermitteln gesperrt'
      : abgeschlossen
        ? 'Abgeschlossen — Anlagen gesperrt und unveränderlich'
        : status === 'ENTFALLEN'
          ? 'Entfallen — keine Uploads'
          : (r.bearbeiten.grund ?? 'Upload nicht möglich');

  const bestaetigungOffen = status === 'ZUR_GEGENZEICHNUNG' && gzm && !d.mandantBestaetigtVon;

  return (
    <div className="page">
      <Link className="back-link" href="/portal/tcms">
        <Icon name="ArrowLeft" className="tx-icon-xs" /> Zur Tax-Compliance-Übersicht
      </Link>

      {historisch ? (
        <div className="alert-warning mb-3 row-between" role="status">
          <span className="row-s">
            <Icon name="History" />
            <strong>Stand zum {fmtDatum(stand)} — nur Lesen.</strong>
          </span>
          <Link href={`/portal/tcms/aufgaben/${d.id}`} className="btn-secondary btn-tiny shrink0">
            Zum aktuellen Stand
          </Link>
        </div>
      ) : null}

      <h1 className="page-title">
        Kontrollaufgabe · {d.kontrolle.titel} {d.periodeLabel}
      </h1>
      <div className="row-lg mb-3" style={{ flexWrap: 'wrap' }}>
        <span className="badge-gray">{d.kontrolle.code}</span>
        <span className={ANZEIGE_BADGE[d.anzeige]}>{statusText(d)}</span>
        <span className="badge-gray">
          Formular-Version v{d.kontrolle.version} · {fmtDatum(d.kontrolle.gueltigAb)}
        </span>
        {d.original ? (
          <span className="badge-gray">Nachtrag zu {d.original.periodeLabel}</span>
        ) : null}
      </div>

      {status === 'ZURUECKGEWIESEN' && d.zurueckweisungsgrund ? (
        <div className="alert-warning mb-3 row-s" style={{ alignItems: 'flex-start' }}>
          <Icon name="RotateCcw" />
          <span>
            <strong>
              Zur Überarbeitung zurückgegeben von {personName(d, d.zurueckgewiesenVon)}
              {d.zurueckgewiesenAm ? ` am ${fmtDatumZeit(d.zurueckgewiesenAm)}` : ''}:
            </strong>{' '}
            {d.zurueckweisungsgrund}
          </span>
        </div>
      ) : null}
      <div className={abgeschlossen ? 'alert-success mb-4 text-sm' : 'alert-info-sm mb-4'}>
        {anleitung}
      </div>

      {inhalt.schritte.length > 0 ? (
        <div className="card p-3 mb-4">
          <div className="steps-mini" style={{ flexWrap: 'wrap', rowGap: 8 }}>
            {inhalt.schritte.map((s, i) => (
              <span key={i} style={{ display: 'contents' }}>
                {i > 0 ? <span className="st-line" /> : null}
                <span
                  className={`st ${s.erledigt ? 'done' : i === ersterOffen && offen ? 'now' : ''}`}
                >
                  <span className="pt">
                    {s.erledigt ? (
                      <Icon name="Check" className="tx-icon-xs" />
                    ) : i === ersterOffen && offen ? (
                      <Icon name="CircleDot" className="tx-icon-xs" />
                    ) : (
                      i + 1
                    )}
                  </span>{' '}
                  {i + 1} · {s.titel}
                </span>
              </span>
            ))}
          </div>
          {offen && (offeneSchritte > 0 || fehlendeAnlagen > 0) ? (
            <div
              className="row-s text-xs mt-2"
              style={{ color: d.anzeige === 'UEBERFAELLIG' ? '#b42318' : 'rgb(var(--text-muted))' }}
            >
              <Icon
                name={d.anzeige === 'UEBERFAELLIG' ? 'TriangleAlert' : 'Info'}
                className="tx-icon-xs"
              />
              <span>
                {[
                  offeneSchritte
                    ? `${offeneSchritte} ${offeneSchritte === 1 ? 'Schritt' : 'Schritte'} offen`
                    : null,
                  fehlendeAnlagen
                    ? `${fehlendeAnlagen} ${fehlendeAnlagen === 1 ? 'Anlage fehlt' : 'Anlagen fehlen'}`
                    : null,
                ]
                  .filter(Boolean)
                  .join(', ')}
                {d.anzeige === 'UEBERFAELLIG'
                  ? ` — die Frist ${fmtDatum(d.faelligAm)} ist überschritten.`
                  : '.'}
              </span>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="g12">
        {/* Hauptspalte */}
        <div className="gc-8 col" style={{ gap: 16 }}>
          <DurchfuehrungEditor
            key={editorKey}
            variante="portal"
            formId={FORM_ID}
            bearbeitbar={bearbeitbar}
            sperrGrund={bearbeitbar ? null : (r.bearbeiten.grund ?? null)}
            schritte={inhalt.schritte}
            kennzahlen={d.kennzahlen}
            werte={inhalt.werte}
            toleranzEur={d.kontrolle.toleranzEur}
            periodeKurz={d.periodeLabel}
            ergebnis={inhalt.ergebnis}
            ergebnisKommentar={inhalt.ergebnisKommentar}
            minBefund={MIN_BEFUND_KOMMENTAR}
            nachweise={
              <NachweiseKarte
                d={d}
                variante="portal"
                hochladen={r.bearbeiten}
                hochladenAction={ladeAnlageHoch}
                entfernenAction={entferneAnlage}
                felder={felder}
                gesperrtText={gesperrtText}
              />
            }
          />
          {fuss}
        </div>

        {/* Seitenspalte */}
        <div className="gc-4 col" style={{ gap: 16 }}>
          <div className="card">
            <div className="card-header">
              <span className="card-title">Status</span>
            </div>
            <div className="p-4 col-s" style={{ gap: 8 }}>
              <Punkt farbe="gray">
                Aufgabe fällig ab {fmtDatumKurz(d.periodeBis)} · Frist {fmtDatum(d.faelligAm)}
              </Punkt>
              {d.begonnenAm ? (
                <Punkt farbe="green">
                  begonnen {fmtDatumZeit(d.begonnenAm)} — {personName(d, d.durchgefuehrtVon)}
                </Punkt>
              ) : null}
              {d.nachweise.length > 0 ? (
                <Punkt farbe="green">
                  {d.nachweise.length === 1 ? '1 Anlage' : `${d.nachweise.length} Anlagen`}{' '}
                  hochgeladen, zuletzt{' '}
                  {fmtDatumKurz(d.nachweise[d.nachweise.length - 1]!.hochgeladenAm)}
                </Punkt>
              ) : null}
              {status === 'ZURUECKGEWIESEN' && d.zurueckgewiesenAm ? (
                <Punkt farbe="amber">zurückgegeben {fmtDatumZeit(d.zurueckgewiesenAm)}</Punkt>
              ) : null}
              {d.eingereichtAm && status !== 'ZURUECKGEWIESEN' ? (
                <Punkt farbe="green">
                  übermittelt {fmtDatumZeit(d.eingereichtAm)} — {personName(d, d.durchgefuehrtVon)}
                </Punkt>
              ) : null}
              {d.mandantBestaetigtVon ? (
                <Punkt farbe="green">
                  bestätigt {d.mandantBestaetigtAm ? fmtDatumZeit(d.mandantBestaetigtAm) : ''} —{' '}
                  {personName(d, d.mandantBestaetigtVon)}
                </Punkt>
              ) : null}
              {d.abgeschlossenAm ? (
                <Punkt farbe="green">
                  abgeschlossen {fmtDatumZeit(d.abgeschlossenAm)} — Kanzlei (
                  {personName(d, d.gegengezeichnetVon)})
                </Punkt>
              ) : null}
              {d.anzeige === 'UEBERFAELLIG' ? (
                <Punkt farbe="red">Frist {fmtDatum(d.faelligAm)} überschritten</Punkt>
              ) : null}
            </div>
          </div>

          {bestaetigungOffen ? (
            <div className="card">
              <div className="card-header">
                <span className="card-title">Bestätigung</span>
                <span className="badge-purple">zweite Person</span>
              </div>
              <div className="p-4 col" style={{ gap: 12 }}>
                <span className="text-sm text-secondary">
                  Eine zweite Person bei Ihnen bestätigt, dass die Angaben von{' '}
                  {personName(d, d.durchgefuehrtVon)} vollständig sind (vorgesehen:{' '}
                  {personName(d, d.kontrolle.gegenzeichnerId)}). Die durchführende Person kann nicht
                  selbst bestätigen.
                </span>
                <div
                  className="row-s"
                  style={{ justifyContent: 'flex-end', flexWrap: 'wrap', alignItems: 'flex-start' }}
                >
                  <BegruendungsDialog
                    ausloeser="Zur Überarbeitung zurückgeben …"
                    ausloeserClass="btn-secondary"
                    titel="Zur Überarbeitung zurückgeben"
                    hinweis="Bitte beschreiben Sie, was fehlt oder zu korrigieren ist. Die Anlagen werden für die Überarbeitung wieder freigegeben."
                    action={gibAufgabeZurueck}
                    felder={felder}
                    bestaetigen="Zurückgeben"
                    vierAugen={false}
                    disabled={!r.zurueckweisen.erlaubt}
                    disabledGrund={r.zurueckweisen.grund ?? undefined}
                  />
                  <AktionsKnopf
                    action={bestaetigeAufgabe}
                    felder={felder}
                    disabled={!r.mandantBestaetigen.erlaubt}
                    title={r.mandantBestaetigen.grund ?? 'Vollständigkeit bestätigen'}
                    bestaetigen="Bestätigen Sie die Vollständigkeit der Angaben und Anlagen?"
                  >
                    <Icon name="UserCheck" /> Vollständigkeit bestätigen
                  </AktionsKnopf>
                </div>
              </div>
            </div>
          ) : null}

          {abgeschlossen || status === 'ENTFALLEN' ? null : (
            <div className="card">
              <div className="card-header">
                <span className="card-title">Nach der Übermittlung</span>
              </div>
              <div className="p-4">
                <span className="row" style={{ alignItems: 'flex-start' }}>
                  <span className="kpi-chip chip-brand">
                    <Icon name="UserCheck" />
                  </span>
                  <span className="text-sm text-secondary grow">
                    {gzm
                      ? `Eine zweite Person (${personName(d, d.kontrolle.gegenzeichnerId)}) bestätigt die Vollständigkeit. Danach prüft die Kanzlei (${kanzlei}) und schließt die Aufgabe ab.`
                      : `Die Kanzlei (${personName(d, d.kontrolle.gegenzeichnerId)}) prüft Ihre Angaben und schließt die Aufgabe ab. Bei Rückfragen erhalten Sie die Aufgabe mit einer Begründung zurück.`}
                  </span>
                </span>
              </div>
            </div>
          )}

          <div className="card">
            <div className="card-header">
              <span className="card-title">Ansprechpartner in der Kanzlei</span>
            </div>
            <div className="p-4 col-s" style={{ gap: 6 }}>
              {[d.mandant.berufstraegerId, d.mandant.bearbeitungId].map((pid) => (
                <span key={pid} className="row-s text-sm">
                  <Icon name="UserRound" className="tx-icon-xs" /> {personName(d, pid)}
                  {d.personen[pid]?.funktion ? (
                    <span className="text-muted text-xs"> · {d.personen[pid]!.funktion}</span>
                  ) : null}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
