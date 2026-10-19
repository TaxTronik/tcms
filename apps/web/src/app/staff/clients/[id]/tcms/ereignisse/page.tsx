import Link from 'next/link';
import {
  EREIGNIS_QUELLE_LABEL,
  EREIGNIS_STATUS_BADGE,
  EREIGNIS_STATUS_LABEL,
  EREIGNISTYPEN,
  ereignisErledigt,
  ereignistyp,
  fmtDatum,
  fmtDatumZeit,
  isoDatum,
  kurzHash,
} from '@tcms/domain';
import { Icon } from '@/components/icon';
import { GtBadge, KlasseBadge } from '@/components/ui/badges';
import { AktionsForm, SubmitButton } from '@/components/ui/client';
import { Leerzustand } from '@/components/ui/leer';
import { TcmsKopf } from '@/components/tcms/kopf';
import { FormDialog, Gesperrt } from '@/components/feststellungen/dialog';
import { FolgeZeile, VorschlagZeile, type PersonOption } from '@/components/ereignisse/folge-zeile';
import {
  beantrageEreignisVerwerfen,
  bestaetigeEreignisVerwerfen,
  erfasseEreignis,
  fuegeFolgeHinzu,
  legeFolgenAn,
  lehneEreignisVerwerfenAb,
  nehmeInPruefung,
  schliesseEreignisAb,
} from '@/server/actions/ereignisse';
import { KEIN_RECHT } from '@/server/aktion';
import { ladeEreignisDetail, typInfo } from '@/server/ereignisse-daten';
import { personKurzname, personName, type EreignisView } from '@/server/kontext';
import { ladeStaffSeite, NUR_AKTUELL, type StaffSeite } from '@/server/seite';

export const metadata = { title: 'Ereigniseingang' };

type SP = Record<string, string | string[] | undefined>;

function quelleText(e: EreignisView): string {
  return EREIGNIS_QUELLE_LABEL[e.quelle].replace(/^manuell$/, 'Kanzlei (manuell)');
}

export default async function EreignisseSeite({
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
      <div className="card">
        <Leerzustand
          icon="ShieldCheck"
          text="Für diesen Mandanten ist noch kein Tax-CMS eingerichtet."
        />
      </div>
    );
  }

  const offen = ctx.ereignisse.filter((e) => e.status === 'NEU').length;
  const eParam = Array.isArray(sp['e']) ? sp['e'][0] : sp['e'];
  const gewaehlt =
    ctx.ereignisse.find((e) => e.id === eParam) ??
    ctx.ereignisse.find((e) => e.status === 'NEU' || e.status === 'IN_TRIAGE') ??
    ctx.ereignisse[0] ??
    null;
  const detail = gewaehlt ? await ladeEreignisDetail(id, gewaehlt.id, seite.standIso) : null;
  const fNummer = new Map(ctx.feststellungen.map((f) => [f.id, f.nummer]));
  const sperre = ctx.historisch ? NUR_AKTUELL : !seite.darfBearbeiten ? KEIN_RECHT : null;

  const erfassen = (
    <FormDialog
      ausloeser={
        <>
          <Icon name="Plus" className="tx-icon-xs" /> Ereignis erfassen
        </>
      }
      ausloeserClass="btn-secondary btn-tiny"
      titel="Ereignis erfassen (Kanzlei)"
      hinweis="Vorgangsnummer wird automatisch vergeben. Die Folgen des Ereignistyps werden als Vorschläge angelegt."
      action={erfasseEreignis}
      felder={{ mandantId: id }}
      bestaetigen="Erfassen"
      breit
      disabled={sperre !== null}
      disabledGrund={sperre ?? undefined}
    >
      <div className="g12" style={{ gap: 12 }}>
        <div className="gc-8">
          <label className="label-sm" htmlFor="e-typ">
            Ereignistyp
          </label>
          <select
            id="e-typ"
            name="typ"
            className="input"
            style={{ width: '100%' }}
            defaultValue=""
            required
          >
            <option value="" disabled>
              bitte wählen
            </option>
            {EREIGNISTYPEN.map((t) => (
              <option key={t.code} value={t.code}>
                {t.code} · {t.titel}
              </option>
            ))}
          </select>
        </div>
        <div className="gc-4">
          <label className="label-sm" htmlFor="e-quelle">
            Quelle
          </label>
          <select
            id="e-quelle"
            name="quelle"
            className="input"
            style={{ width: '100%' }}
            defaultValue="MANUELL"
          >
            {(['MANUELL', 'KONTROLLE', 'STAMMDATEN', 'RSS'] as const).map((q) => (
              <option key={q} value={q}>
                {EREIGNIS_QUELLE_LABEL[q]}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div>
        <label className="label-sm" htmlFor="e-titel">
          Bezeichnung
        </label>
        <input
          id="e-titel"
          name="titel"
          className="input"
          required
          minLength={5}
          maxLength={200}
          placeholder="z. B. USt-Sonderprüfung für Q2 2026 angekündigt"
        />
      </div>
      <div>
        <label className="label-sm" htmlFor="e-beschreibung">
          Beschreibung
        </label>
        <textarea
          id="e-beschreibung"
          name="beschreibung"
          className="input"
          required
          minLength={10}
        />
      </div>
      <div>
        <label className="label-sm" htmlFor="e-datum">
          Datum des Ereignisses
        </label>
        <input
          id="e-datum"
          name="datum"
          type="date"
          className="input"
          style={{ width: 'auto' }}
          required
          defaultValue={seite.heuteIso}
        />
      </div>
    </FormDialog>
  );

  return (
    <>
      <TcmsKopf
        seite={seite}
        titel={
          <>
            <h2 className="text-xl font-b text-primary">Ereigniseingang</h2>
            <span className={offen ? 'badge-yellow' : 'badge-gray'}>{offen} nicht triagiert</span>
          </>
        }
      />
      <div className="row-between mb-4" style={{ flexWrap: 'wrap', gap: 12 }}>
        <p className="text-sm text-muted">
          Jede Meldung wird triagiert; verworfen nur begründet — alle Schritte auditgesichert.
        </p>
        {erfassen}
      </div>

      <div className="g12">
        {/* Liste */}
        <div className="card gc-7" style={{ alignSelf: 'start' }}>
          <div className="card-header">
            <span className="card-title">Eingang</span>
            <span className="text-xs text-muted">Neueste oben · Auswahl öffnet die Triage</span>
          </div>
          {ctx.ereignisse.length === 0 ? (
            <Leerzustand icon="Inbox" text="Noch keine Ereignisse gemeldet." />
          ) : (
            <div>
              {ctx.ereignisse.map((e) => {
                const t = typInfo(e.typ);
                const sel = gewaehlt?.id === e.id;
                const fs = e.folgen
                  .filter((f) => f.art === 'FESTSTELLUNG_ANLEGEN' && f.objektId)
                  .map((f) => ({ id: f.objektId!, nummer: fNummer.get(f.objektId!) }));
                return (
                  <div
                    key={e.id}
                    className={`list-row${sel ? ' sel' : ''}`}
                    aria-current={sel ? 'true' : undefined}
                  >
                    <span className={`icon-ring ${t.ton}`}>
                      <Icon name={t.icon} />
                    </span>
                    <div className="grow" style={{ minWidth: 0 }}>
                      <Link
                        href={mitStand(`${basis}/ereignisse?e=${e.id}`)}
                        scroll={false}
                        className="text-sm font-m text-primary"
                        style={{ textDecoration: 'none', display: 'block' }}
                      >
                        {e.typ === 'SONST' ? 'Sonstiges' : e.typ} · {e.titel}
                      </Link>
                      <div className="row-s text-11 text-muted mt-1" style={{ flexWrap: 'wrap' }}>
                        <span className="badge-gray">{quelleText(e)}</span>
                        <span className="mono">{e.nummer}</span>
                        <span>
                          {e.gemeldetVon ? `${personKurzname(ctx, e.gemeldetVon)} · ` : ''}
                          {fmtDatumZeit(e.gemeldetAm)}
                        </span>
                        {fs.map((x) =>
                          x.nummer ? (
                            <Link
                              key={x.id}
                              className="badge-gray"
                              href={mitStand(`${basis}/feststellungen/${x.id}`)}
                              style={{ textDecoration: 'none' }}
                              title={`Zur Feststellung ${x.nummer}`}
                            >
                              → {x.nummer}
                            </Link>
                          ) : null,
                        )}
                      </div>
                    </div>
                    <span className="col-s shrink0" style={{ alignItems: 'flex-end' }}>
                      <span className={EREIGNIS_STATUS_BADGE[e.status]}>
                        {EREIGNIS_STATUS_LABEL[e.status]}
                      </span>
                      {e.verwerfenBegruendung && e.status !== 'VERWORFEN' ? (
                        <span className="badge-yellow">Verwerfen beantragt</span>
                      ) : null}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
          <div className="card-footer">
            <span>
              {ctx.ereignisse.length} Einträge insgesamt · {offen} nicht triagiert ·{' '}
              {ctx.ereignisse.filter((e) => e.status === 'IN_TRIAGE').length} in Triage
            </span>
          </div>
        </div>

        {/* Triage-Panel */}
        <div className="gc-5" style={{ alignSelf: 'start', position: 'sticky', top: 72 }}>
          {gewaehlt && detail ? (
            <TriagePanel seite={seite} e={gewaehlt} detail={detail} sperre={sperre} />
          ) : (
            <div className="card">
              <Leerzustand icon="Inbox" text="Ereignis auswählen, um es zu triagieren." />
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function TriagePanel({
  seite,
  e,
  detail,
  sperre,
}: {
  seite: StaffSeite;
  e: EreignisView;
  detail: NonNullable<Awaited<ReturnType<typeof ladeEreignisDetail>>>;
  sperre: string | null;
}) {
  const { ctx, basis, mitStand, nutzer } = seite;
  const mandantId = ctx.mandant.id;
  const t = typInfo(e.typ);
  const kat = ereignistyp(e.typ);
  const melder = e.gemeldetVon ? ctx.personen.get(e.gemeldetVon) : null;
  const abgeschlossen = e.status === 'ERLEDIGT' || e.status === 'VERWORFEN';
  const panelSperre = sperre ?? (abgeschlossen ? 'Ereignis ist abgeschlossen' : null);
  const gesperrt = panelSperre !== null;

  const vorschlaege = detail.folgen.filter((f) => f.status === 'VORGESCHLAGEN');
  const weitere = detail.folgen.filter((f) => f.status !== 'VORGESCHLAGEN');
  const fertig = ereignisErledigt(detail.folgen);
  const einsErledigt = detail.folgen.some((f) => f.status === 'ERLEDIGT');

  const personen: PersonOption[] = [
    ...[...ctx.personen.values()]
      .filter((p) => p.art === 'KANZLEI')
      .map((p) => ({ id: p.id, label: `${p.name.replace(/^StB\s+/, '')} (Kanzlei)` })),
    ...ctx.mandantPersonen.map((p) => ({ id: p.id, label: `${p.name} (Mandant)` })),
  ];
  const frist = isoDatum(new Date(ctx.heute.getTime() + 14 * 86_400_000));

  // Betroffene Risiken und Kontrollen laut Katalog (Ziele der Folgen des Ereignistyps).
  const ziele = [
    ...new Set(
      [...(kat?.folgen ?? []).map((f) => f.ziel), ...detail.folgen.map((f) => f.ziel)].filter(
        (z): z is string => !!z,
      ),
    ),
  ];
  const risikoZiele = ziele.filter((z) => z.startsWith('EC-')).sort();
  const kontrollZiele = ziele.filter((z) => z.startsWith('K-EC-')).sort();

  const hinweisFuer = (art: string, ziel: string | null): string | null => {
    if (!ziel) return null;
    if (art === 'RISIKO_NEU_BEWERTEN' && !ctx.risiken.some((r) => r.code === ziel))
      return 'Risiko ist im Inventar nicht aktiv – verwerfen oder zuerst aufnehmen.';
    if (art === 'KONTROLLE_AUSSERPLANMAESSIG' && !ctx.kontrollen.some((k) => k.code === ziel))
      return 'Kontrolle ist im Programm nicht aktiv.';
    return null;
  };

  return (
    <div className="card">
      <div className="card-header">
        <div className="col" style={{ gap: 2, minWidth: 0 }}>
          <span className="row-s">
            <span className={`icon-ring ${t.ton}`} style={{ width: 26, height: 26 }}>
              <Icon name={t.icon} className="tx-icon-xs" />
            </span>
            <span className="card-title">{e.typ === 'SONST' ? 'Sonstiges' : e.typ} · Triage</span>
          </span>
          <span className="text-11 text-muted">
            Vorgang <span className="mono">{e.nummer}</span> · Eingang {fmtDatum(e.gemeldetAm)}
            {melder
              ? ` · gemeldet von ${melder.name.replace(/^StB\s+/, '')}${melder.funktion ? ` (${melder.funktion})` : ''}`
              : ''}
          </span>
        </div>
        <span className={`${EREIGNIS_STATUS_BADGE[e.status]} shrink0`}>
          {EREIGNIS_STATUS_LABEL[e.status]}
        </span>
      </div>

      <div className="p-4">
        <div className="text-sm font-m text-primary">{e.titel}</div>
        <div className="text-11 text-muted mt-1">
          {t.titel} · Ereignisdatum {fmtDatum(e.ereignisDatum)} · Quelle {quelleText(e)}
        </div>
        <div className="text-xs font-s text-secondary mt-3 mb-1">Beschreibung</div>
        <p className="text-sm text-secondary" style={{ whiteSpace: 'pre-wrap' }}>
          {e.beschreibung}
        </p>

        {detail.anlagen.length ? (
          <>
            <div className="text-xs font-s text-secondary mt-3 mb-1">Anlagen</div>
            <div className="col-s">
              {detail.anlagen.map((a) => (
                <a
                  key={a.sha256}
                  className="row-s text-sm"
                  href={`${basis}/ereignisse/anlage?e=${e.id}&h=${a.sha256}`}
                  style={{ textDecoration: 'none' }}
                  title={`SHA-256 ${a.sha256}`}
                >
                  <Icon name="FileText" className="tx-icon-xs" /> {a.dateiname}
                  <span className="badge-gray">
                    <Icon name="Lock" className="tx-icon-xs" />{' '}
                    <span className="mono">{kurzHash(a.sha256)}</span>
                  </span>
                  <span className="text-11 text-muted">
                    {Math.max(1, Math.round(a.groesse / 1024))} KB
                  </span>
                </a>
              ))}
            </div>
          </>
        ) : null}

        {risikoZiele.length || kontrollZiele.length ? (
          <>
            <div className="text-xs font-s text-secondary mt-4 mb-1">Betroffen laut Katalog</div>
            <div className="col-s">
              {risikoZiele.length ? (
                <div className="row-wrap">
                  <span className="text-11 text-muted">Risiken:</span>
                  {risikoZiele.map((code) => {
                    const r = ctx.risiken.find((x) => x.code === code);
                    return (
                      <span key={code} className="row-s">
                        <Link
                          href={mitStand(`${basis}/risiken?risiko=${code}`)}
                          className="badge-gray mono"
                          style={{ textDecoration: 'none' }}
                          title={r?.titel ?? 'im Inventar nicht aktiv'}
                        >
                          {code}
                        </Link>
                        {r ? (
                          <KlasseBadge klasse={r.netto} title="Nettoklasse (wirksam)" />
                        ) : (
                          <span className="text-11 text-muted">nicht aktiv</span>
                        )}
                        {r?.neuBewerten ? <span className="badge-yellow">neu bewerten</span> : null}
                      </span>
                    );
                  })}
                </div>
              ) : null}
              {kontrollZiele.length ? (
                <div className="row-wrap">
                  <span className="text-11 text-muted">Kontrollen:</span>
                  {kontrollZiele.map((code) => {
                    const k = ctx.kontrollen.find((x) => x.code === code);
                    return k ? (
                      <span key={code} className="row-s">
                        <Link
                          href={mitStand(`${basis}/kontrollen?kontrolle=${k.id}`)}
                          className="badge-gray mono"
                          style={{ textDecoration: 'none' }}
                          title={k.titel}
                        >
                          {code}
                        </Link>
                        <GtBadge gt={k.gt} />
                      </span>
                    ) : (
                      <span key={code} className="row-s">
                        <span className="badge-gray mono">{code}</span>
                        <span className="text-11 text-muted">nicht aktiv</span>
                      </span>
                    );
                  })}
                </div>
              ) : null}
            </div>
          </>
        ) : null}

        {vorschlaege.length ? (
          <>
            <div className="text-xs font-s text-secondary mt-4 mb-2">Vorgeschlagene Folgen</div>
            <AktionsForm action={legeFolgenAn}>
              <input type="hidden" name="mandantId" value={mandantId} />
              <input type="hidden" name="ereignisId" value={e.id} />
              <div className="col-s">
                {vorschlaege.map((f, i) => {
                  const hinweis = hinweisFuer(f.art, f.ziel);
                  return (
                    <VorschlagZeile
                      key={f.id}
                      mandantId={mandantId}
                      ereignisId={e.id}
                      f={f}
                      personen={personen}
                      standardZustaendig={
                        f.art === 'HINWEIS'
                          ? ctx.mandant.berufstraegerId
                          : ctx.mandant.bearbeitungId
                      }
                      standardFrist={frist}
                      heuteIso={seite.heuteIso}
                      vorbelegt={f.art !== 'FESTSTELLUNG_ANLEGEN' && !hinweis}
                      hinweis={hinweis}
                      ereignisTitel={e.titel}
                      gesperrt={gesperrt}
                      sperrGrund={panelSperre}
                      erste={i === 0}
                    />
                  );
                })}
              </div>
              <div
                className="alert-info-sm mt-4"
                style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}
              >
                <Icon name="Info" className="tx-icon shrink0" />
                <span>
                  Systemvorschlag aus Ereignistyp {kat ? kat.code : 'Sonstiges'} und Katalogregeln.
                  Keine automatische Bewertung — die Entscheidung liegt bei der Kanzlei.
                </span>
              </div>
              <div className="form-actions mt-3">
                <Gesperrt grund={panelSperre}>
                  <SubmitButton disabled={gesperrt}>Ausgewählte Folgen anlegen</SubmitButton>
                </Gesperrt>
              </div>
            </AktionsForm>
          </>
        ) : null}

        {weitere.length ? (
          <>
            <div className="text-xs font-s text-secondary mt-4 mb-1">Folgen</div>
            <div>
              {weitere.map((f) => (
                <FolgeZeile
                  key={f.id}
                  mandantId={mandantId}
                  ereignisId={e.id}
                  f={f}
                  basis={basis}
                  mitStand={mitStand}
                  zustaendigName={f.zustaendig ? personKurzname(ctx, f.zustaendig) : null}
                  gesperrt={gesperrt}
                  sperrGrund={panelSperre}
                  risikoCode={f.ziel}
                />
              ))}
            </div>
          </>
        ) : null}

        {!abgeschlossen ? (
          <div className="mt-3">
            <FormDialog
              ausloeser={
                <>
                  <Icon name="Plus" className="tx-icon-xs" /> Weitere Folge
                </>
              }
              titel="Weitere Folge vorschlagen"
              hinweis="Eigene Triage-Entscheidung, z. B. Profil- oder Länderprüfung als Aufgabe."
              action={fuegeFolgeHinzu}
              felder={{ mandantId, ereignisId: e.id }}
              bestaetigen="Vorschlagen"
              disabled={gesperrt}
              disabledGrund={panelSperre ?? undefined}
            >
              <div className="g12" style={{ gap: 12 }}>
                <div className="gc-8">
                  <label className="label-sm" htmlFor="wf-art">
                    Art
                  </label>
                  <select
                    id="wf-art"
                    name="art"
                    className="input"
                    style={{ width: '100%' }}
                    defaultValue="HINWEIS"
                  >
                    <option value="RISIKO_NEU_BEWERTEN">Risiko neu bewerten</option>
                    <option value="RISIKO_AKTIVIEREN">Risiko aktivieren</option>
                    <option value="KONTROLLE_AUSSERPLANMAESSIG">
                      Kontrolle außerplanmäßig einplanen
                    </option>
                    <option value="PROFIL_AENDERN">Geschäftsprofil ändern / Länderprüfung</option>
                    <option value="FESTSTELLUNG_ANLEGEN">Feststellung anlegen</option>
                    <option value="HINWEIS">Hinweis an Berufsträger</option>
                  </select>
                </div>
                <div className="gc-4">
                  <label className="label-sm" htmlFor="wf-ziel">
                    Risiko-/Kontrollcode
                  </label>
                  <input
                    id="wf-ziel"
                    name="ziel"
                    className="input"
                    placeholder="EC-UST-02"
                    maxLength={20}
                  />
                </div>
              </div>
              <div>
                <label className="label-sm" htmlFor="wf-text">
                  Beschreibung
                </label>
                <input
                  id="wf-text"
                  name="text"
                  className="input"
                  required
                  minLength={5}
                  placeholder="z. B. Länder-Monitor um CZ ergänzen"
                />
              </div>
            </FormDialog>
          </div>
        ) : null}

        {detail.verwerfenAntrag ? (
          <div className="alert-warning text-sm mt-4">
            <div>
              <strong>Verwerfen beantragt</strong> von{' '}
              {detail.verwerfenAntrag.von.replace(/^StB\s+/, '')} ·{' '}
              {fmtDatumZeit(detail.verwerfenAntrag.am)}
            </div>
            <div className="text-xs mt-1">{detail.verwerfenAntrag.begruendung}</div>
            <div className="row-s mt-2">
              <AktionsForm action={bestaetigeEreignisVerwerfen}>
                <input type="hidden" name="mandantId" value={mandantId} />
                <input type="hidden" name="id" value={e.id} />
                <Gesperrt
                  blass
                  grund={
                    panelSperre ??
                    (nutzer.id === detail.verwerfenAntrag.vonId
                      ? 'Die Bestätigung muss durch eine zweite Person erfolgen'
                      : null)
                  }
                >
                  <SubmitButton
                    className="btn-danger-outline btn-tiny"
                    disabled={gesperrt || nutzer.id === detail.verwerfenAntrag.vonId}
                  >
                    Verwerfen bestätigen
                  </SubmitButton>
                </Gesperrt>
              </AktionsForm>
              <AktionsForm action={lehneEreignisVerwerfenAb}>
                <input type="hidden" name="mandantId" value={mandantId} />
                <input type="hidden" name="id" value={e.id} />
                <Gesperrt grund={panelSperre}>
                  <SubmitButton className="btn-secondary btn-tiny" disabled={gesperrt}>
                    {nutzer.id === detail.verwerfenAntrag.vonId
                      ? 'Antrag zurückziehen'
                      : 'Ablehnen'}
                  </SubmitButton>
                </Gesperrt>
              </AktionsForm>
            </div>
          </div>
        ) : null}

        {detail.verwerfen ? (
          <div className="alert-warning text-sm mt-4">
            <strong>Verworfen</strong> · bestätigt von {detail.verwerfen.von.replace(/^StB\s+/, '')}{' '}
            · {fmtDatumZeit(detail.verwerfen.am)}
            <div className="text-xs mt-1">{detail.verwerfen.begruendung}</div>
          </div>
        ) : null}

        {!abgeschlossen ? (
          <div
            className="form-actions mt-4"
            style={{
              borderTop: '1px solid rgb(var(--border-subtle) / 0.4)',
              paddingTop: 12,
              flexWrap: 'wrap',
            }}
          >
            {!detail.verwerfenAntrag ? (
              <FormDialog
                ausloeser="Verwerfen …"
                ausloeserClass="btn-danger-outline"
                ausloeserTitel="Begründung erforderlich, zweite Person beteiligt"
                titel={`Ereignis ${e.nummer} verwerfen`}
                hinweis="Nur ohne angelegte Folgen. Eine zweite Person bestätigt; offene Vorschläge werden dann mit verworfen."
                action={beantrageEreignisVerwerfen}
                felder={{ mandantId, id: e.id }}
                bestaetigen="Verwerfen beantragen"
                gefahr
                begruendungMin={30}
                begruendungHinweis="Wird von einer zweiten Person bestätigt."
                disabled={
                  gesperrt ||
                  weitere.some((f) => f.status === 'ANGELEGT' || f.status === 'ERLEDIGT')
                }
                disabledGrund={
                  panelSperre ?? 'Folgen sind bereits angelegt – einzeln erledigen oder verwerfen'
                }
              />
            ) : null}
            {e.status === 'NEU' ? (
              <AktionsForm action={nehmeInPruefung}>
                <input type="hidden" name="mandantId" value={mandantId} />
                <input type="hidden" name="id" value={e.id} />
                <Gesperrt grund={panelSperre}>
                  <SubmitButton className="btn-secondary" disabled={gesperrt}>
                    In Prüfung nehmen
                  </SubmitButton>
                </Gesperrt>
              </AktionsForm>
            ) : null}
            <AktionsForm action={schliesseEreignisAb}>
              <input type="hidden" name="mandantId" value={mandantId} />
              <input type="hidden" name="id" value={e.id} />
              <Gesperrt
                grund={
                  panelSperre ??
                  (!fertig
                    ? 'Erst wenn jede Folge erledigt oder begründet verworfen ist'
                    : !einsErledigt
                      ? 'Keine Folge erledigt – bitte „Ereignis verwerfen“ (Bestätigung durch eine zweite Person)'
                      : null)
                }
              >
                <SubmitButton
                  className="btn-primary"
                  disabled={gesperrt || !fertig || !einsErledigt}
                >
                  Ereignis abschließen
                </SubmitButton>
              </Gesperrt>
            </AktionsForm>
          </div>
        ) : (
          <div className="text-xs text-muted mt-4">
            {e.status === 'ERLEDIGT'
              ? 'Erledigt – alle Folgen erledigt oder begründet verworfen.'
              : 'Verworfen.'}
            {e.triagiertVon
              ? ` Triage: ${personName(ctx, e.triagiertVon).replace(/^StB\s+/, '')}${e.triagiertAm ? `, ${fmtDatumZeit(e.triagiertAm)}` : ''}.`
              : ''}
          </div>
        )}

        {detail.verlauf.length ? (
          <details className="details-box mt-4">
            <summary>
              <Icon name="History" className="tx-icon-xs" /> Verlauf ({detail.verlauf.length})
            </summary>
            <div className="details-body col-s">
              {detail.verlauf.map((v) => (
                <div key={v.id} className="text-xs">
                  <span className="mono text-muted">{fmtDatumZeit(v.at)}</span> ·{' '}
                  <span className="font-m">{v.actorName.replace(/^StB\s+/, '')}</span> · {v.text}
                </div>
              ))}
            </div>
          </details>
        ) : null}
      </div>
      <div className="card-footer" style={{ display: 'block' }}>
        {detail.meldung ? (
          <span className="text-11 mono text-muted">
            Ereignis in Audit-Chain: {detail.meldung.aktion} · {fmtDatumZeit(detail.meldung.at)} ·
            Hash {kurzHash(detail.meldung.hash)}
          </span>
        ) : (
          <span className="text-11 text-muted">Kein Meldungseintrag im Audit-Log.</span>
        )}
      </div>
    </div>
  );
}
