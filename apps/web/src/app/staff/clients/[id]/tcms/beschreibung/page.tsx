import Link from 'next/link';
import {
  ABSCHNITTE,
  abschnittHatText,
  BAUSTEIN_LABEL,
  fmtDatum,
  fmtDatumZeit,
  type BausteinArt,
} from '@tcms/domain';
import { AbschnittAnsicht } from '@/components/beschreibung/abschnitt';
import { AbschnittEditor } from '@/components/beschreibung/editor';
import {
  BeschreibungStatusBadge,
  BESCHREIBUNG_STATUS_LABEL,
  fmtIso,
} from '@/components/beschreibung/status';
import type { BausteinQuelle } from '@/components/beschreibung/typen';
import { Icon } from '@/components/icon';
import { TcmsKopf } from '@/components/tcms/kopf';
import { Hash } from '@/components/ui/badges';
import { AktionsForm, BegruendungsDialog, SubmitButton } from '@/components/ui/client';
import { Disclaimer } from '@/components/ui/disclaimer';
import { Leerzustand } from '@/components/ui/leer';
import {
  freigabeAnfordern,
  neueVersion,
  reviewAbschliessen,
  reviewZurueckweisen,
  zurReview,
} from '@/server/actions/beschreibung';
import {
  baueBausteine,
  ladeBeschreibungsDaten,
  letzteBearbeitung,
  normalisiereAbschnitte,
  pruefeSnapshot,
  statusZum,
  type BeschreibungStatus,
  type VersionRoh,
} from '@/server/beschreibung-daten';
import { personKurzname, personName } from '@/server/kontext';
import { NUR_AKTUELL, ladeStaffSeite } from '@/server/seite';
import { tagesende } from '@/server/zeit';

export const metadata = { title: 'CMS-Beschreibung' };

type SP = Record<string, string | string[] | undefined>;
const eins = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function BeschreibungSeite({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SP>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const seite = await ladeStaffSeite(id, sp);
  const { ctx, basis, mitStand, nutzer, darfBearbeiten } = seite;

  if (!ctx.programm) {
    return (
      <div className="card">
        <Leerzustand
          icon="FileText"
          text="Für diesen Mandanten ist noch kein Tax-CMS eingerichtet."
        />
      </div>
    );
  }

  const daten = await ladeBeschreibungsDaten(ctx.programm.id);
  const ende = tagesende(ctx.stand);
  const sichtbar = daten.versionen.filter((v) => v.createdAt.getTime() <= ende.getTime());
  // Zum Stichtag: spätere Schritte ausblenden, Status aus den Zeitstempeln ableiten.
  const bis = (d: Date | null) => (d && d.getTime() <= ende.getTime() ? d : null);
  const versionen = sichtbar.map((v) => ({
    ...v,
    anzeige: statusZum(v, sichtbar, daten.freigaben, ende, ctx.historisch),
    ...(ctx.historisch
      ? {
          reviewAngefordertAm: bis(v.reviewAngefordertAm),
          reviewAngefordertVon: bis(v.reviewAngefordertAm) ? v.reviewAngefordertVon : null,
          reviewAm: bis(v.reviewAm),
          reviewVon: bis(v.reviewAm) ? v.reviewVon : null,
          freigabeAngefordertAm: bis(v.freigabeAngefordertAm),
          freigegebenAm: bis(v.freigegebenAm),
          freigegebenVon: bis(v.freigegebenAm) ? v.freigegebenVon : null,
        }
      : {}),
  }));
  const aktuell = versionen.at(-1) ?? null;
  const offeneVersion =
    daten.versionen.find((v) => v.status === 'ENTWURF' || v.status === 'KANZLEI_REVIEW') ?? null;
  const neuGesperrt = !darfBearbeiten
    ? ctx.historisch
      ? NUR_AKTUELL
      : 'Nur zuständige Personen legen Versionen an'
    : offeneVersion
      ? `v${offeneVersion.nummer} ist noch in Bearbeitung`
      : null;

  const NeueVersion = ({
    text,
    klasse = 'btn-secondary btn-tiny',
  }: {
    text: string;
    klasse?: string;
  }) => (
    <AktionsForm action={neueVersion} key="neue-version">
      <input type="hidden" name="programmId" value={ctx.programm!.id} />
      <SubmitButton className={klasse} disabled={!!neuGesperrt} title={neuGesperrt ?? undefined}>
        <Icon name="Plus" className="tx-icon-xs" /> {text}
      </SubmitButton>
    </AktionsForm>
  );

  if (!aktuell) {
    return (
      <>
        <TcmsKopf seite={seite} />
        <Disclaimer />
        <div className="card mt-4">
          <Leerzustand
            icon="FileText"
            text="Es gibt noch keine CMS-Beschreibung. Die erste Version entsteht aus der Gliederung mit allen lebenden Bausteinen."
          >
            <NeueVersion text="Erste Version anlegen" klasse="btn-primary" />
          </Leerzustand>
        </div>
      </>
    );
  }

  const v = versionen.find((x) => x.id === eins(sp['version'])) ?? aktuell;
  const istAktuell = v.id === aktuell.id;
  const abschnittKey = eins(sp['abschnitt']) ?? 'teilbereich';
  const gesamt = abschnittKey === 'alle';
  const vorlage = ABSCHNITTE.find((a) => a.key === abschnittKey) ?? ABSCHNITTE[0]!;

  // Eingefroren: Versionen mit Snapshot ab der Anforderung beim Mandanten.
  const eingefroren =
    !!v.snapshot &&
    (v.anzeige === 'BEIM_MANDANTEN' || v.anzeige === 'FREIGEGEBEN' || v.anzeige === 'ABGELOEST');
  const abschnitte = eingefroren ? normalisiereAbschnitte(v.snapshot!.abschnitte) : v.abschnitte;
  const quelle: BausteinQuelle = eingefroren
    ? { modus: 'snapshot', stand: v.snapshot!.stand ?? null, satz: v.snapshot!.bausteine ?? null }
    : { modus: 'live', stand: seite.standIso, satz: baueBausteine(ctx) };
  const hashOk = pruefeSnapshot(v.snapshot, v.snapshotSha256);
  const luecken = abschnitte.filter((a) => !abschnittHatText(a));
  const abschnitt = abschnitte.find((a) => a.key === vorlage.key)!;

  const href = (o: { version?: string; abschnitt?: string; bearbeiten?: boolean }) => {
    const q = new URLSearchParams();
    const ver = o.version ?? v.id;
    if (ver !== aktuell.id) q.set('version', ver);
    const ab = o.abschnitt ?? abschnittKey;
    if (ab !== 'teilbereich') q.set('abschnitt', ab);
    if (o.bearbeiten) q.set('bearbeiten', '1');
    const s = q.toString();
    return mitStand(`${basis}/beschreibung${s ? `?${s}` : ''}`);
  };

  // Rechte und Sperrgründe
  const letzte = letzteBearbeitung(v, daten.verlauf);
  const bearbeitbar = darfBearbeiten && v.status === 'ENTWURF' && !ctx.historisch;
  const bearbeitenGrund = ctx.historisch
    ? NUR_AKTUELL
    : !darfBearbeiten
      ? 'Nur zuständige Personen bearbeiten die Beschreibung'
      : v.status !== 'ENTWURF'
        ? 'Nur Entwürfe sind bearbeitbar – Änderungen entstehen als neue Version'
        : null;
  const bearbeiten = bearbeitbar && eins(sp['bearbeiten']) === '1' && !gesamt;
  const reviewGrund = !darfBearbeiten
    ? ctx.historisch
      ? NUR_AKTUELL
      : 'Nur zuständige Personen'
    : letzte === nutzer.id
      ? 'Die Review schließt eine zweite Person ab – Sie haben den Text zuletzt bearbeitet'
      : null;
  const andereBeimMandanten = daten.versionen.filter(
    (x) => x.status === 'BEIM_MANDANTEN' && x.id !== v.id,
  );
  const offeneFreigabe =
    daten.freigaben.filter((f) => f.refId === v.id && f.status === 'OFFEN').at(-1) ?? null;
  const gv = ctx.mandantPersonen.find((p) => p.mandantRolle === 'GESETZLICHER_VERTRETER') ?? null;

  const ref = ABSCHNITTE.findIndex((a) => a.key === vorlage.key);
  const naechste = ABSCHNITTE[ref + 1];
  const vorige = ABSCHNITTE[ref - 1];

  return (
    <>
      <TcmsKopf seite={seite} />

      <div className="row-between mb-4" style={{ flexWrap: 'wrap', gap: 12 }}>
        <div className="row-lg wrap">
          <h2 className="text-xl font-b text-primary">CMS-Beschreibung</h2>
          <span className="badge-brand">
            Version {v.nummer} · {BESCHREIBUNG_STATUS_LABEL[v.anzeige]}
          </span>
          {!istAktuell ? <span className="badge-gray">ältere Version</span> : null}
        </div>
        <div className="row-lg" style={{ alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <Statusaktionen
            v={v}
            darf={darfBearbeiten && !ctx.historisch}
            gesperrt={ctx.historisch ? NUR_AKTUELL : 'Nur zuständige Personen'}
            reviewGrund={reviewGrund}
            andereBeimMandanten={andereBeimMandanten.map((x) => x.nummer)}
            gvName={gv?.name ?? null}
          />
        </div>
      </div>

      <Disclaimer />

      {v.anzeige === 'BEIM_MANDANTEN' ? (
        <div
          className="alert-info mt-3 row-s"
          style={{ gap: 10, alignItems: 'flex-start' }}
          role="status"
        >
          <Icon name="MailCheck" />
          <span>
            <strong>
              Zur Freigabe bei{' '}
              {offeneFreigabe
                ? personName(ctx, offeneFreigabe.empfaengerId)
                : (gv?.name ?? 'der gesetzlichen Vertretung')}
            </strong>{' '}
            seit {fmtDatumZeit(v.freigabeAngefordertAm)}.{' '}
            {offeneFreigabe?.hatCode && offeneFreigabe.codeAblauf
              ? `Bestätigung per E-Mail-Code, gültig bis ${fmtDatum(offeneFreigabe.codeAblauf)} (Postausgang).`
              : 'Ein Bestätigungscode ist noch nicht versandt; die gesetzliche Vertretung fordert ihn im Portal an.'}{' '}
            {eingefroren
              ? 'Angezeigt wird der zur Freigabe vorgelegte Snapshot.'
              : 'Für diese Version liegt noch kein Snapshot vor; er entsteht spätestens bei der Freigabe.'}
          </span>
        </div>
      ) : null}
      {v.anzeige === 'KANZLEI_REVIEW' && v.reviewVon && !ctx.historisch ? (
        <div className="alert-success mt-3 text-sm" role="status">
          Kanzlei-Review abgeschlossen · {personKurzname(ctx, v.reviewVon)} ·{' '}
          {fmtDatumZeit(v.reviewAm)}. Die Freigabe beim Mandanten kann angefordert werden.
        </div>
      ) : null}

      <div className="g12 mt-4" style={{ alignItems: 'start' }}>
        {/* Gliederung */}
        <div className="card gc-3 p-3">
          <div
            className="text-xs font-s text-muted mb-2"
            style={{ textTransform: 'uppercase', letterSpacing: '0.025em' }}
          >
            Inhalt
          </div>
          <nav aria-label="Gliederung der CMS-Beschreibung">
            {ABSCHNITTE.map((a) => {
              const ab = abschnitte.find((x) => x.key === a.key)!;
              const luecke = !abschnittHatText(ab);
              const aktiv = !gesamt && a.key === vorlage.key;
              return (
                <div key={a.key}>
                  <Link
                    className={`nav-item${aktiv ? ' active' : ''}`}
                    href={href({ abschnitt: a.key })}
                    aria-current={aktiv ? 'true' : undefined}
                  >
                    {a.nr !== 'A' ? (
                      <span className={`mono${aktiv ? '' : ' text-muted'}`} style={{ width: 16 }}>
                        {a.nr}
                      </span>
                    ) : null}
                    <span className="grow">{a.nr === 'A' ? 'Anhang' : a.titel}</span>
                    {luecke ? (
                      <span
                        className="status-dot dot-amber"
                        style={{ marginTop: 7 }}
                        title="Kein Freitext — Lücke"
                      />
                    ) : null}
                  </Link>
                  {a.key === 'anhang' ? (
                    <div className="text-11 text-muted" style={{ padding: '2px 10px 8px' }}>
                      {ab.bloecke
                        .filter((b) => b.typ === 'baustein')
                        .map((b) => BAUSTEIN_LABEL[(b as { art: BausteinArt }).art])
                        .join(' · ') || 'ohne Bausteine'}
                    </div>
                  ) : null}
                </div>
              );
            })}
            <Link
              className={`nav-item${gesamt ? ' active' : ''}`}
              href={href({ abschnitt: 'alle' })}
              style={{ marginTop: 6 }}
            >
              <Icon name="FileText" className="tx-icon-xs" />
              <span className="grow">Gesamtansicht</span>
            </Link>
          </nav>
          <div
            className="mt-3"
            style={{ borderTop: '1px solid rgb(var(--border-default))', paddingTop: 10 }}
          >
            {luecken.length ? (
              <span
                className="badge-yellow"
                title={luecken
                  .map((l) => ABSCHNITTE.find((a) => a.key === l.key)?.titel)
                  .join('\n')}
              >
                Lücken ({luecken.length})
              </span>
            ) : (
              <span className="text-11 text-muted">alle Abschnitte mit Freitext dokumentiert</span>
            )}
          </div>
        </div>

        {/* Editor */}
        <div className="card gc-6">
          <div className="card-header" style={{ flexWrap: 'wrap', gap: 8 }}>
            <span className="card-title">
              {gesamt
                ? `Gesamtansicht v${v.nummer}`
                : vorlage.nr === 'A'
                  ? 'Anhang'
                  : `Abschnitt ${vorlage.nr} — ${vorlage.titel}`}
            </span>
            {gesamt ? null : bearbeiten ? (
              <span className="badge-brand">
                <Icon name="Pencil" className="tx-icon-xs" /> Bearbeitung
              </span>
            ) : bearbeitbar ? (
              <Link href={href({ bearbeiten: true })} className="btn-secondary btn-tiny">
                <Icon name="Pencil" className="tx-icon-xs" /> Bearbeiten
              </Link>
            ) : (
              <button
                type="button"
                className="btn-secondary btn-tiny"
                disabled
                title={bearbeitenGrund ?? undefined}
              >
                {eingefroren ? (
                  <Icon name="Lock" className="tx-icon-xs" />
                ) : (
                  <Icon name="Pencil" className="tx-icon-xs" />
                )}{' '}
                Bearbeiten
              </button>
            )}
          </div>
          <div className="p-4">
            {gesamt ? (
              <div className="col" style={{ gap: 18 }}>
                {ABSCHNITTE.map((a) => (
                  <AbschnittAnsicht
                    key={a.key}
                    abschnitt={abschnitte.find((x) => x.key === a.key)!}
                    vorlage={a}
                    quelle={quelle}
                    mitTitel
                  />
                ))}
              </div>
            ) : bearbeiten ? (
              <AbschnittEditor
                versionId={v.id}
                abschnitt={abschnitt}
                quelle={quelle}
                abbrechenHref={href({})}
              />
            ) : (
              <AbschnittAnsicht abschnitt={abschnitt} vorlage={vorlage} quelle={quelle} />
            )}
          </div>
          <div className="card-footer" style={{ flexWrap: 'wrap', gap: 8 }}>
            <span>
              {eingefroren
                ? `Eingefrorener Inhalt v${v.nummer} – unveränderlich. Änderungen entstehen als neue Version.`
                : v.status === 'ENTWURF'
                  ? `Änderungen werden in v${v.nummer} gespeichert und protokolliert.`
                  : `Änderungen erzeugen eine neue Version.`}
              {ctx.historisch && !eingefroren
                ? ' Freitext im aktuellen Bearbeitungsstand; Entwürfe werden nicht je Tag versioniert.'
                : ''}
            </span>
            {gesamt ? null : (
              <span className="row-s" style={{ gap: 10 }}>
                {vorige ? (
                  <Link
                    href={href({ abschnitt: vorige.key })}
                    className="text-muted"
                    style={{ textDecoration: 'none' }}
                  >
                    ← {vorige.nr === 'A' ? 'Anhang' : vorige.nr}
                  </Link>
                ) : null}
                {naechste ? (
                  <Link
                    href={href({ abschnitt: naechste.key })}
                    className="text-muted"
                    style={{ textDecoration: 'none' }}
                  >
                    {naechste.nr === 'A' ? 'Anhang' : naechste.nr} →
                  </Link>
                ) : null}
              </span>
            )}
          </div>
        </div>

        {/* Versionen & Freigabe */}
        <div className="gc-3 col" style={{ gap: 16 }}>
          <div className="card">
            <div className="card-header">
              <span className="card-title">Versionen</span>
            </div>
            <div>
              {[...versionen].reverse().map((x) => (
                <Link
                  key={x.id}
                  href={href({ version: x.id, bearbeiten: false })}
                  className={`list-row${x.id === v.id ? ' sel' : ''}`}
                  style={{ textDecoration: 'none' }}
                  aria-current={x.id === v.id ? 'true' : undefined}
                >
                  <div className="grow">
                    <div className="row-s" style={{ gap: 6 }}>
                      <span
                        className="text-sm font-b mono"
                        style={
                          x.anzeige === 'ABGELOEST' ? { textDecoration: 'line-through' } : undefined
                        }
                      >
                        v{x.nummer}
                      </span>
                      <BeschreibungStatusBadge status={x.anzeige} />
                    </div>
                    <div className="text-11 text-muted mt-1">
                      {versionsZeile(x, x.anzeige, (pid) => personKurzname(ctx, pid))}
                    </div>
                  </div>
                  {x.id === aktuell.id ? (
                    <span className="badge-brand shrink0">aktuell</span>
                  ) : null}
                </Link>
              ))}
            </div>
            <div className="card-footer">
              <NeueVersion text="Neue Version anlegen" />
              <span className="text-11">aus v{aktuell.nummer}</span>
            </div>
          </div>

          <div className="card">
            <div className="card-header">
              <span className="card-title">Snapshot</span>
              {eingefroren ? (
                <span className="badge-gray">
                  <Icon name="Lock" className="tx-icon-xs" /> <Hash wert={v.snapshotSha256 ?? ''} />
                </span>
              ) : null}
            </div>
            <div className="p-4 col" style={{ gap: 6 }}>
              {eingefroren ? (
                <>
                  {hashOk === true ? (
                    <span className="row-s text-sm" style={{ color: '#166534' }}>
                      <Icon name="CheckCircle2" className="tx-icon-xs" /> Hash geprüft: Inhalt
                      unverändert
                    </span>
                  ) : hashOk === false ? (
                    <span className="row-s text-sm" style={{ color: '#b42318' }}>
                      <Icon name="TriangleAlert" className="tx-icon-xs" /> Hash weicht vom
                      gespeicherten Inhalt ab
                    </span>
                  ) : null}
                  <span className="text-11 text-muted">
                    {v.snapshot?.erzeugtAm
                      ? `Eingefroren am ${fmtDatumZeit(new Date(v.snapshot.erzeugtAm))}`
                      : 'Eingefroren bei der Freigabe'}
                    {v.snapshot?.stand ? ` · Datenstand ${fmtIso(v.snapshot.stand)}` : ''}
                  </span>
                  <span className="text-11 text-muted mono" style={{ wordBreak: 'break-all' }}>
                    SHA-256 {v.snapshotSha256}
                  </span>
                  <span className="text-11 text-muted">
                    Ein Hash bindet Inhalte; er authentifiziert keine Person.
                  </span>
                </>
              ) : (
                <span className="text-xs text-muted">
                  Lebende Bausteine zeigen den Stand {fmtIso(seite.standIso)}. Beim Anfordern der
                  Freigabe wird der Inhalt eingefroren und mit SHA-256 gebunden.
                </span>
              )}
            </div>
          </div>

          <div className="card">
            <div className="card-header">
              <span className="card-title">Freigabeverlauf</span>
            </div>
            <Verlauf
              versionen={versionen}
              daten={daten}
              ende={ende}
              name={(pid) => personKurzname(ctx, pid)}
            />
          </div>

          <div className="card">
            <div className="card-header">
              <span className="card-title">Aktionen</span>
            </div>
            <div className="p-3 row-s" style={{ gap: 8 }}>
              <button
                type="button"
                className="btn-secondary"
                disabled
                title="Export folgt mit dem Nachweispaket (Prüfungsvorbereitung)"
              >
                <Icon name="Download" /> PDF
              </button>
              <button
                type="button"
                className="btn-secondary"
                disabled
                title="Export folgt mit dem Nachweispaket (Prüfungsvorbereitung)"
              >
                <Icon name="FileText" /> DOCX
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function versionsZeile(
  x: VersionRoh,
  anzeige: BeschreibungStatus,
  name: (id: string | null) => string,
): string {
  if ((anzeige === 'FREIGEGEBEN' || anzeige === 'ABGELOEST') && x.freigegebenAm) {
    return `${fmtDatum(x.freigegebenAm)} · ${name(x.freigegebenVon)}`;
  }
  if (anzeige === 'BEIM_MANDANTEN' && x.freigabeAngefordertAm)
    return `angefordert ${fmtDatum(x.freigabeAngefordertAm)}`;
  if (anzeige === 'KANZLEI_REVIEW')
    return x.reviewVon
      ? `Review: ${name(x.reviewVon)} · ${fmtDatum(x.reviewAm)}`
      : `Review offen seit ${fmtDatum(x.reviewAngefordertAm)}`;
  if (anzeige === 'ABGELOEST') return `${fmtDatum(x.createdAt)} · zurückgezogen`;
  return `${fmtDatum(x.createdAt)} · ${name(x.erstelltVon)}`;
}

// ---------------------------------------------------------------------------
// Statusabhängige Aktionen im Kopf
// ---------------------------------------------------------------------------

function Statusaktionen({
  v,
  darf,
  gesperrt,
  reviewGrund,
  andereBeimMandanten,
  gvName,
}: {
  v: VersionRoh & { anzeige: BeschreibungStatus };
  darf: boolean;
  gesperrt: string;
  reviewGrund: string | null;
  andereBeimMandanten: string[];
  gvName: string | null;
}) {
  const anfordernGesperrt = 'Erst nach durchlaufener Kanzlei-Review';
  const id = <input type="hidden" name="versionId" value={v.id} />;
  if (v.anzeige !== v.status) {
    // Historischer Stand: nur Anzeige.
    return (
      <button type="button" className="btn-secondary" disabled title={NUR_AKTUELL}>
        <Icon name="History" className="tx-icon-xs" /> nur Lesen
      </button>
    );
  }
  if (v.status === 'ENTWURF') {
    return (
      <>
        <AktionsForm
          action={zurReview}
          key={`review-${v.id}`}
          className="col"
          style={{ alignItems: 'flex-end' }}
        >
          {id}
          <SubmitButton
            className="btn-secondary"
            disabled={!darf}
            title={darf ? undefined : gesperrt}
          >
            <Icon name="Send" className="tx-icon-xs" /> Zur Kanzlei-Review einreichen
          </SubmitButton>
        </AktionsForm>
        <button type="button" className="btn-primary" disabled title={anfordernGesperrt}>
          Freigabe beim Mandanten anfordern
        </button>
      </>
    );
  }
  if (v.status === 'KANZLEI_REVIEW') {
    const zurueck = (
      <BegruendungsDialog
        ausloeser={
          <>
            <Icon name="RotateCcw" className="tx-icon-xs" /> Zurück in den Entwurf
          </>
        }
        ausloeserClass="btn-secondary"
        titel={`v${v.nummer} zurück in den Entwurf`}
        hinweis="Die Kanzlei-Review endet; der Entwurf kann wieder bearbeitet werden."
        action={reviewZurueckweisen}
        felder={{ versionId: v.id }}
        bestaetigen="Zurückgeben"
        vierAugen={false}
        disabled={!darf}
        disabledGrund={gesperrt}
      />
    );
    if (!v.reviewVon) {
      return (
        <>
          {zurueck}
          <AktionsForm
            action={reviewAbschliessen}
            key={`abschluss-${v.id}`}
            className="col"
            style={{ alignItems: 'flex-end' }}
          >
            {id}
            <SubmitButton
              className="btn-secondary"
              disabled={!!reviewGrund}
              title={reviewGrund ?? 'Vier-Augen-Prinzip: zweite Person bestätigt den Entwurf'}
            >
              <Icon name="FileCheck" className="tx-icon-xs" /> Review abschließen
            </SubmitButton>
          </AktionsForm>
          <button type="button" className="btn-primary" disabled title={anfordernGesperrt}>
            Freigabe beim Mandanten anfordern
          </button>
        </>
      );
    }
    const hinweis = [
      gvName
        ? `Empfänger: ${gvName} (gesetzliche Vertretung), Bestätigung per E-Mail-Code`
        : 'Keine gesetzliche Vertretung erfasst',
      andereBeimMandanten.length
        ? `Die offene Anforderung für v${andereBeimMandanten.join(', v')} wird zurückgezogen`
        : null,
    ]
      .filter(Boolean)
      .join(' · ');
    return (
      <>
        {zurueck}
        <AktionsForm
          action={freigabeAnfordern}
          key={`anfordern-${v.id}`}
          className="col"
          style={{ alignItems: 'flex-end' }}
        >
          {id}
          <SubmitButton
            className="btn-primary"
            disabled={!darf || !gvName}
            title={!darf ? gesperrt : hinweis}
          >
            <Icon name="Send" className="tx-icon-xs" /> Freigabe beim Mandanten anfordern
          </SubmitButton>
          {andereBeimMandanten.length ? (
            <span className="text-11 text-muted mt-1">
              Offene Anforderung v{andereBeimMandanten.join(', v')} wird zurückgezogen.
            </span>
          ) : null}
        </AktionsForm>
      </>
    );
  }
  if (v.status === 'BEIM_MANDANTEN') {
    return (
      <span className="badge-yellow">
        <Icon name="MailCheck" className="tx-icon-xs" /> wartet auf Freigabe durch den Mandanten
      </span>
    );
  }
  return (
    <span className={v.status === 'FREIGEGEBEN' ? 'badge-green' : 'badge-gray'}>
      <Icon name="Lock" className="tx-icon-xs" />{' '}
      {v.status === 'FREIGEGEBEN' ? 'freigegeben – unveränderlich' : 'abgelöst – unveränderlich'}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Freigabeverlauf über alle Versionen (neueste zuerst)
// ---------------------------------------------------------------------------

function Verlauf({
  versionen,
  daten,
  ende,
  name,
}: {
  versionen: VersionRoh[];
  daten: Awaited<ReturnType<typeof ladeBeschreibungsDaten>>;
  ende: Date;
  name: (id: string | null) => string;
}) {
  type E = { at: Date; icon: string; titel: string; unter: string };
  const e: E[] = [];
  const nr = new Map(versionen.map((v) => [v.id, v.nummer]));
  for (const v of versionen) {
    if (v.freigegebenAm)
      e.push({
        at: v.freigegebenAm,
        icon: 'CheckCheck',
        titel: `Freigabe v${v.nummer} durch ${name(v.freigegebenVon)}`,
        unter: `E-Mail-Code bestätigt · ${fmtDatumZeit(v.freigegebenAm)}`,
      });
    if (v.freigabeAngefordertAm)
      e.push({
        at: v.freigabeAngefordertAm,
        icon: 'Send',
        titel: `Anforderung v${v.nummer} an Mandant`,
        unter: fmtDatumZeit(v.freigabeAngefordertAm),
      });
    if (v.reviewAm)
      e.push({
        at: v.reviewAm,
        icon: 'FileCheck',
        titel: `Kanzlei-Review v${v.nummer} durch ${name(v.reviewVon)}`,
        unter: fmtDatumZeit(v.reviewAm),
      });
    if (v.reviewAngefordertAm)
      e.push({
        at: v.reviewAngefordertAm,
        icon: 'Users',
        titel: `v${v.nummer} zur Kanzlei-Review`,
        unter: `${name(v.reviewAngefordertVon)} · ${fmtDatumZeit(v.reviewAngefordertAm)}`,
      });
  }
  for (const f of daten.freigaben) {
    if (f.status === 'ABGELEHNT' && f.erledigtAm)
      e.push({
        at: f.erledigtAm,
        icon: 'Ban',
        titel: `Anforderung v${nr.get(f.refId) ?? '?'} ${f.anmerkung?.startsWith('Gegenstandslos') ? 'gegenstandslos' : 'zurückgezogen'}`,
        unter: `${f.anmerkung ?? ''} · ${fmtDatumZeit(f.erledigtAm)}`,
      });
  }
  for (const a of daten.verlauf) {
    if (a.aktion === 'tcms.beschreibung.review_zurueckgewiesen') {
      e.push({
        at: a.at,
        icon: 'RotateCcw',
        titel: `v${String(a.detail['nummer'] ?? '')} zurück in den Entwurf`,
        unter: `${a.actorName.replace(/^StB\s+/, '')} · ${fmtDatumZeit(a.at)}`,
      });
    }
  }
  const liste = e
    .filter((x) => x.at.getTime() <= ende.getTime())
    .sort((a, b) => b.at.getTime() - a.at.getTime())
    .slice(0, 8);
  if (!liste.length)
    return <div className="p-4 text-sm text-muted">Noch keine Review- oder Freigabeschritte.</div>;
  return (
    <div>
      {liste.map((x, i) => (
        <div key={i} className="list-row">
          <span className="icon-ring">
            <Icon name={x.icon} />
          </span>
          <div className="grow">
            <div className="text-sm font-m">{x.titel}</div>
            <div className="text-11 text-muted mt-1">{x.unter}</div>
          </div>
        </div>
      ))}
    </div>
  );
}
