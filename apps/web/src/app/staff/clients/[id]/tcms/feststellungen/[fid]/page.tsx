import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  ANZEIGE_LABEL,
  AUSWIRKUNG_BADGE,
  AUSWIRKUNG_LABEL,
  FESTSTELLUNG_KLASSE_LABEL,
  FESTSTELLUNG_SCHRITTE,
  FESTSTELLUNG_STATUS_LABEL,
  fmtDatum,
  fmtDatumKurz,
  fmtDatumZeit,
  fmtEur,
  isoDatum,
  KLASSE_LABEL,
  naechsterFeststellungsschritt,
  p153Erforderlich,
  P153_LABEL,
  QUELLE_LABEL,
  relativTage,
  tageZwischen,
} from '@tcms/domain';
import { Icon } from '@/components/icon';
import { GtBadge, KlasseBadge, StatusBadge } from '@/components/ui/badges';
import { AktionsForm, SubmitButton } from '@/components/ui/client';
import { Leerzustand } from '@/components/ui/leer';
import { TcmsKopf } from '@/components/tcms/kopf';
import { FeststellungStatusBadge, VertraulichBadge } from '@/components/feststellungen/badges';
import { FormDialog, Gesperrt } from '@/components/feststellungen/dialog';
import { P153Block } from '@/components/feststellungen/p153-block';
import { VertraulichSchalter } from '@/components/feststellungen/vertraulich';
import {
  aktualisiereWuerdigung,
  beantrageVerwerfen,
  bestaetigeVerwerfen,
  erledigeMassnahme,
  fuegeErklaerungHinzu,
  legeMassnahmeAn,
  legeNachkontrolleAn,
  lehneVerwerfenAb,
  schalteFeststellungWeiter,
} from '@/server/actions/feststellungen';
import { KEIN_RECHT, NUR_BERUFSTRAEGER } from '@/server/aktion';
import {
  istBeteiligt,
  kontrollCode,
  ladeFeststellungDetail,
  P153_ERLAEUTERUNG,
  P153_OPTIONEN,
  p153Abschliessend,
} from '@/server/feststellungen-daten';
import { personKurzname, personName } from '@/server/kontext';
import { ladeStaffSeite, NUR_AKTUELL } from '@/server/seite';

export const metadata = { title: 'Feststellung' };

type SP = Record<string, string | string[] | undefined>;

export default async function FeststellungDetailSeite({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; fid: string }>;
  searchParams: Promise<SP>;
}) {
  const { id, fid } = await params;
  const seite = await ladeStaffSeite(id, await searchParams);
  const { ctx, basis, mitStand, nutzer } = seite;
  if (!ctx.programm) notFound();
  const f = await ladeFeststellungDetail(ctx.programm.id, fid, ctx.stand, ctx.historisch);
  if (!f) notFound();

  const zurueck = (
    <Link href={mitStand(`${basis}/feststellungen`)} className="back-link">
      <Icon name="ArrowLeft" className="tx-icon-xs" /> Zur Feststellungsliste
    </Link>
  );

  const beteiligt = istBeteiligt(
    nutzer,
    {
      erfasstVon: f.erfasstVon,
      p153EntschiedenVon: f.p153?.von ?? null,
      verwerfenBeantragtVon: f.verwerfen?.beantragtVon ?? null,
      massnahmenVerantwortlich: f.massnahmen.map((m) => m.verantwortlich),
    },
    ctx.mandant.id,
  );
  // Zugriff: vertraulich zum Stichtag ODER heute – sonst ließe sich der aktuelle Inhalt über einen frühen Stichtag lesen.
  if ((f.vertraulich || f.vertraulichAktuell) && !beteiligt) {
    return (
      <>
        <TcmsKopf seite={seite} />
        {zurueck}
        <div className="card">
          <Leerzustand
            icon="EyeOff"
            text={`${f.nummer} ist als vertraulich markiert. Inhalt und Verlauf sind nur für Beteiligte sichtbar (zuständige Berufsträger:innen, Hauptbearbeitung, erfassende und verantwortliche Personen).`}
          />
        </div>
      </>
    );
  }

  const offen = f.status !== 'GESCHLOSSEN' && f.status !== 'VERWORFEN';
  const sperre = ctx.historisch
    ? NUR_AKTUELL
    : !seite.darfBearbeiten
      ? KEIN_RECHT
      : !offen
        ? 'Feststellung ist geschlossen oder verworfen'
        : null;
  const kannAendern = sperre === null;
  const p153Pfad = p153Erforderlich(f.auswirkung);
  const p153Fertig = p153Abschliessend(f.p153?.entscheidung);
  const massnahmenOffen = f.massnahmen.filter((m) => m.status === 'OFFEN').length;
  const schritt = naechsterFeststellungsschritt({
    status: f.status,
    auswirkung: f.auswirkung,
    p153Entschieden: p153Fertig,
    massnahmen: f.massnahmen.length,
    massnahmenOffen,
    nachkontrolleOhneBefund: f.nachkontrolle?.anzeige === 'OHNE_BEFUND',
  });

  // Stepper
  const idx = f.status === 'VERWORFEN' ? -1 : FESTSTELLUNG_SCHRITTE.indexOf(f.status);
  const unter: Record<string, string> = {
    ERFASST: `${fmtDatum(f.erfasstAm)} · ${personKurzname(ctx, f.erfasstVon)}`,
    IN_WUERDIGUNG: !p153Pfad
      ? 'kein §-153-Pfad'
      : f.p153
        ? p153Fertig
          ? `§ 153: entschieden ${fmtDatumKurz(f.p153.am)}`
          : `Klärung bis ${fmtDatumKurz(f.p153.frist)}`
        : '§-153-Entscheidung offen',
    MASSNAHMEN_OFFEN: f.massnahmen.length
      ? massnahmenOffen
        ? `${f.massnahmen.length} angelegt · ${massnahmenOffen} offen`
        : `${f.massnahmen.length} erledigt`
      : 'keine angelegt',
    NACHKONTROLLE: f.nachkontrolle
      ? `${f.nachkontrolle.code} · ${ANZEIGE_LABEL[f.nachkontrolle.anzeige]}`
      : '—',
    GESCHLOSSEN: f.geschlossenAm ? fmtDatum(f.geschlossenAm) : '—',
  };

  const quelleCode = f.durchfuehrung?.code ?? kontrollCode(f.quelleText);
  const quelleLink = f.durchfuehrung
    ? mitStand(`${basis}/durchfuehrungen/${f.durchfuehrung.id}`)
    : f.ereignis
      ? mitStand(`${basis}/ereignisse?e=${f.ereignis.id}`)
      : null;
  const quelleLinkText = f.durchfuehrung
    ? f.durchfuehrung.code
    : f.ereignis
      ? `${f.ereignis.nummer} (${f.ereignis.typ})`
      : null;

  const personenOptionen = [
    ...[...ctx.personen.values()]
      .filter((p) => p.art === 'KANZLEI')
      .map((p) => ({ id: p.id, label: `${p.name.replace(/^StB\s+/, '')} (Kanzlei)` })),
    ...ctx.mandantPersonen.map((p) => ({ id: p.id, label: `${p.name} (Mandant)` })),
  ];
  const plus14 = isoDatum(new Date(ctx.heute.getTime() + 14 * 86_400_000));
  const vorschlagKontrolle = f.durchfuehrung?.kontrolleId ?? f.nachkontrolle?.kontrolleId ?? '';
  const erklaerungOffen = f.erklaerungen.some((e) => e.auswirkungEur == null);
  const erklaerungSumme = f.erklaerungen.reduce((s, e) => s + (e.auswirkungEur ?? 0), 0);

  const nkMoeglich = f.status === 'MASSNAHMEN_OFFEN' || f.status === 'NACHKONTROLLE';
  const nkErsetzbar =
    !f.nachkontrolle ||
    f.nachkontrolle.anzeige === 'MIT_BEFUND' ||
    f.nachkontrolle.anzeige === 'ENTFALLEN';

  // §-153-Block
  const p153Sperre = ctx.historisch
    ? NUR_AKTUELL
    : !seite.darfWuerdigen
      ? NUR_BERUFSTRAEGER
      : !offen
        ? 'Feststellung ist geschlossen oder verworfen'
        : null;
  const rolle = nutzer.istBerufstraeger ? 'Berufsträger:in' : 'Bearbeitung';
  const p153Hinweis = ctx.historisch
    ? `Historischer Stand zum ${fmtDatum(ctx.stand)} – nur Lesen.`
    : !seite.darfWuerdigen
      ? `Sie sind als ${nutzer.name} (${rolle}) angemeldet. Die Würdigung ist der zuständigen Berufsträgerin bzw. dem zuständigen Berufsträger (${personName(ctx, ctx.mandant.berufstraegerId)}) vorbehalten und wird serverseitig erzwungen.`
      : null;

  const verwerfenOffen = f.verwerfen && f.status !== 'VERWORFEN';

  return (
    <>
      <TcmsKopf seite={seite} />
      {zurueck}

      <div className="row-between mb-3" style={{ flexWrap: 'wrap', gap: 12 }}>
        <div className="col" style={{ gap: 8 }}>
          <div className="row-lg" style={{ flexWrap: 'wrap' }}>
            <h2 className="text-xl font-b text-primary">
              {f.nummer} · {f.titel}
            </h2>
            <KlasseBadge klasse={f.schwere} title="Schwere" />
            {f.vertraulich ? <VertraulichBadge /> : null}
          </div>
          <div className="row-s" style={{ flexWrap: 'wrap' }}>
            <span className={AUSWIRKUNG_BADGE[f.auswirkung]}>
              steuerliche Auswirkung: {AUSWIRKUNG_LABEL[f.auswirkung]}
            </span>
            <span className="badge-gray">{FESTSTELLUNG_KLASSE_LABEL[f.klasse]}</span>
            <FeststellungStatusBadge status={f.status} />
          </div>
        </div>
      </div>

      {f.status === 'VERWORFEN' ? (
        <div className="alert-warning mb-3" role="status">
          <strong>Verworfen.</strong> {f.verwerfen?.begruendung ?? ''}
          {f.verwerfen ? (
            <span className="text-xs">
              {' '}
              — beantragt von {personKurzname(ctx, f.verwerfen.beantragtVon)}, bestätigt von{' '}
              {personKurzname(ctx, f.verwerfen.bestaetigtVon)}
            </span>
          ) : null}
        </div>
      ) : null}

      {/* Status-Schritte */}
      <div className="card mt-3 mb-4" style={{ padding: '18px 24px' }}>
        <ol className="stepper">
          {FESTSTELLUNG_SCHRITTE.map((s, i) => {
            const zustand =
              f.status === 'GESCHLOSSEN' || i < idx ? 'done' : i === idx ? 'active' : '';
            return (
              <li key={s} className={`step ${zustand}`}>
                <span className="step-dot">
                  {zustand === 'done' ? <Icon name="Check" className="tx-icon-xs" /> : i + 1}
                </span>
                <span className="step-txt">
                  <span className="step-title">
                    {i + 1} {FESTSTELLUNG_STATUS_LABEL[s]}
                  </span>
                  <span className="step-sub" title={unter[s]}>
                    {i <= idx || f.status === 'GESCHLOSSEN' || s === 'MASSNAHMEN_OFFEN'
                      ? unter[s]
                      : '—'}
                  </span>
                </span>
                {i < FESTSTELLUNG_SCHRITTE.length - 1 ? <span className="step-line" /> : null}
              </li>
            );
          })}
        </ol>
        {schritt.ziel ? (
          <div
            className="row-between mt-4"
            style={{
              borderTop: '1px solid rgb(var(--border-subtle) / 0.4)',
              paddingTop: 12,
              flexWrap: 'wrap',
              gap: 8,
            }}
          >
            <span className="text-sm text-secondary">
              Nächster Schritt: <strong>{FESTSTELLUNG_STATUS_LABEL[schritt.ziel]}</strong>
              {schritt.blockiert ? (
                <span className="text-muted"> — noch nicht möglich: {schritt.blockiert}</span>
              ) : null}
            </span>
            <AktionsForm action={schalteFeststellungWeiter} className="row-s">
              <input type="hidden" name="id" value={f.id} />
              <Gesperrt
                grund={
                  sperre ?? (schritt.blockiert ? `Noch nicht möglich: ${schritt.blockiert}` : null)
                }
              >
                <SubmitButton
                  className="btn-primary btn-tiny"
                  disabled={!kannAendern || !!schritt.blockiert}
                >
                  Weiter zu „{FESTSTELLUNG_STATUS_LABEL[schritt.ziel]}“
                </SubmitButton>
              </Gesperrt>
            </AktionsForm>
          </div>
        ) : null}
      </div>

      <div className="g12">
        {/* ================= Hauptspalte ================= */}
        <div className="gc-8 col" style={{ gap: 16 }}>
          <div className="card">
            <div className="card-header">
              <span className="card-title">Sachverhalt</span>
              {f.status === 'ERFASST' || f.status === 'IN_WUERDIGUNG' ? (
                <FormDialog
                  ausloeser={
                    <>
                      <Icon name="Pencil" className="tx-icon-xs" /> Würdigung bearbeiten
                    </>
                  }
                  titel="Würdigung: Schwere, Auswirkung, Ursache"
                  hinweis="Bei steuerlicher Auswirkung „ja“ oder „unklar“ startet der §-153-Pfad. Nach dokumentierter Würdigung ist die Auswirkung nicht mehr änderbar."
                  action={aktualisiereWuerdigung}
                  felder={{ id: f.id }}
                  disabled={!kannAendern}
                  disabledGrund={sperre ?? undefined}
                >
                  <div className="g12" style={{ gap: 12 }}>
                    <div className="gc-6">
                      <label className="label-sm" htmlFor="w-schwere">
                        Schwere
                      </label>
                      <select
                        id="w-schwere"
                        name="schwere"
                        className="input"
                        style={{ width: '100%' }}
                        defaultValue={f.schwere}
                      >
                        {(['GERING', 'MITTEL', 'HOCH', 'KRITISCH'] as const).map((k) => (
                          <option key={k} value={k}>
                            {KLASSE_LABEL[k]}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="gc-6">
                      <label className="label-sm" htmlFor="w-auswirkung">
                        Steuerliche Auswirkung
                      </label>
                      <select
                        id="w-auswirkung"
                        name="auswirkung"
                        className="input"
                        style={{ width: '100%' }}
                        defaultValue={f.auswirkung}
                        disabled={!!f.p153}
                      >
                        {(['JA', 'NEIN', 'UNKLAR'] as const).map((k) => (
                          <option key={k} value={k}>
                            {AUSWIRKUNG_LABEL[k]}
                          </option>
                        ))}
                      </select>
                      {f.p153 ? (
                        <input type="hidden" name="auswirkung" value={f.auswirkung} />
                      ) : null}
                    </div>
                  </div>
                  <div>
                    <label className="label-sm" htmlFor="w-ursache">
                      Ursache
                    </label>
                    <textarea
                      id="w-ursache"
                      name="ursache"
                      className="input"
                      defaultValue={f.ursache ?? ''}
                    />
                  </div>
                </FormDialog>
              ) : null}
            </div>
            <div className="p-4 text-sm text-secondary">
              <p style={{ whiteSpace: 'pre-wrap' }}>{f.sachverhalt}</p>
              <div className="mt-3">
                <span className="text-xs font-s text-secondary">Ursache: </span>
                <span className={f.ursache ? 'text-sm' : 'text-sm text-muted'}>
                  {f.ursache ?? 'noch nicht erfasst'}
                </span>
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-header">
              <span className="card-title">Betroffene Risiken und Kontrollen</span>
            </div>
            <div className="p-4 col-s">
              <div className="row-wrap">
                <span className="text-xs text-muted">Risiken:</span>
                {f.risiken.length === 0 ? (
                  <span className="text-xs text-muted">keine verknüpft</span>
                ) : null}
                {f.risiken.map((r) => {
                  const rv = ctx.risiken.find((x) => x.id === r.id);
                  return (
                    <span key={r.id} className="row-s">
                      <Link
                        href={mitStand(`${basis}/risiken?risiko=${r.code}`)}
                        className="badge-gray mono"
                        style={{ textDecoration: 'none' }}
                        title={rv?.titel}
                      >
                        {r.code}
                      </Link>
                      {rv ? <KlasseBadge klasse={rv.netto} title="Nettoklasse (wirksam)" /> : null}
                      {rv ? <GtBadge gt={rv.gt} /> : null}
                    </span>
                  );
                })}
              </div>
              <div className="row-wrap">
                <span className="text-xs text-muted">Verknüpfte Kontrolle:</span>
                {f.durchfuehrung ? (
                  <Link
                    href={mitStand(`${basis}/durchfuehrungen/${f.durchfuehrung.id}`)}
                    className="badge-gray mono"
                    style={{ textDecoration: 'none' }}
                    title={`Durchführung ${f.durchfuehrung.periodeLabel}`}
                  >
                    {f.durchfuehrung.code}
                  </Link>
                ) : (
                  <span className="text-xs text-muted">—</span>
                )}
                {f.nachkontrolle ? (
                  <>
                    <span className="text-xs text-muted">Nachkontrolle:</span>
                    <Link
                      href={mitStand(`${basis}/durchfuehrungen/${f.nachkontrolle.id}`)}
                      className="badge-gray mono"
                      style={{ textDecoration: 'none' }}
                    >
                      {f.nachkontrolle.code}
                    </Link>
                  </>
                ) : null}
              </div>
              {f.auswirkung !== 'NEIN' ? (
                <div className="text-xs text-muted">
                  jede steuerwirksame Feststellung führt zu{' '}
                  <Link href={mitStand(`${basis}/risiken?risiko=EC-VER-01`)} className="mono">
                    EC-VER-01
                  </Link>
                </div>
              ) : null}
            </div>
          </div>

          <div className="card" style={{ overflow: 'hidden' }}>
            <div className="card-header">
              <span className="card-title">Betroffene Erklärungen</span>
              <span className="row-s">
                {f.erklaerungen.length ? (
                  erklaerungOffen ? (
                    <span className="badge-yellow">Schätzung offen</span>
                  ) : (
                    <span className="badge-gray">Summe {fmtEur(erklaerungSumme)}</span>
                  )
                ) : null}
                {offen ? (
                  <FormDialog
                    ausloeser={
                      <>
                        <Icon name="Plus" className="tx-icon-xs" /> Erklärung
                      </>
                    }
                    titel="Betroffene Erklärung erfassen"
                    hinweis="§-153-Pfad Schritt 1: Steuerart, Land, Zeitraum, geschätzte Auswirkung."
                    action={fuegeErklaerungHinzu}
                    felder={{ feststellungId: f.id }}
                    disabled={!kannAendern}
                    disabledGrund={sperre ?? undefined}
                  >
                    <div>
                      <label className="label-sm" htmlFor="e-steuerart">
                        Steuerart / Erklärung
                      </label>
                      <input
                        id="e-steuerart"
                        name="steuerart"
                        className="input"
                        required
                        placeholder="z. B. USt (OSS), ZM, USt-VA"
                      />
                    </div>
                    <div className="g12" style={{ gap: 12 }}>
                      <div className="gc-4">
                        <label className="label-sm" htmlFor="e-land">
                          Land
                        </label>
                        <input
                          id="e-land"
                          name="land"
                          className="input"
                          required
                          maxLength={40}
                          placeholder="DE"
                        />
                      </div>
                      <div className="gc-4">
                        <label className="label-sm" htmlFor="e-zeitraum">
                          Zeitraum
                        </label>
                        <input
                          id="e-zeitraum"
                          name="zeitraum"
                          className="input"
                          required
                          placeholder="Q3 2026"
                        />
                      </div>
                      <div className="gc-4">
                        <label className="label-sm" htmlFor="e-betrag">
                          Geschätzte Auswirkung (€)
                        </label>
                        <input
                          id="e-betrag"
                          name="auswirkungEur"
                          className="input"
                          inputMode="decimal"
                          placeholder="leer = zu klären"
                        />
                      </div>
                    </div>
                  </FormDialog>
                ) : null}
              </span>
            </div>
            {f.erklaerungen.length === 0 ? (
              <div className="p-4 text-sm text-muted">Keine betroffenen Erklärungen erfasst.</div>
            ) : (
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Steuerart</th>
                    <th>Land</th>
                    <th>Zeitraum</th>
                    <th className="td-num">Geschätzte Auswirkung</th>
                  </tr>
                </thead>
                <tbody>
                  {f.erklaerungen.map((e) => (
                    <tr key={e.id}>
                      <td className="text-sm">{e.steuerart}</td>
                      <td className="text-sm">{e.land}</td>
                      <td className="text-sm">{e.zeitraum}</td>
                      <td className={e.auswirkungEur == null ? 'td-num text-muted' : 'td-num'}>
                        {e.auswirkungEur == null ? 'zu klären' : fmtEur(e.auswirkungEur)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* Maßnahmen */}
          <div className="card">
            <div className="card-header">
              <span className="card-title">Maßnahmen</span>
              <span className="row-s">
                {f.massnahmen.length ? (
                  massnahmenOffen ? (
                    <span className="badge-yellow">{massnahmenOffen} offen</span>
                  ) : (
                    <span className="badge-green">alle erledigt</span>
                  )
                ) : null}
                <FormDialog
                  ausloeser={
                    <>
                      <Icon name="Plus" className="tx-icon-xs" /> Maßnahme
                    </>
                  }
                  titel="Maßnahme anlegen"
                  hinweis="Die Wiedervorlage-Nummer wird kanzleiweit fortlaufend vergeben."
                  action={legeMassnahmeAn}
                  felder={{ feststellungId: f.id }}
                  bestaetigen="Anlegen"
                  disabled={!kannAendern}
                  disabledGrund={sperre ?? undefined}
                >
                  <div>
                    <label className="label-sm" htmlFor="m-beschreibung">
                      Maßnahme
                    </label>
                    <input
                      id="m-beschreibung"
                      name="beschreibung"
                      className="input"
                      required
                      minLength={5}
                      maxLength={500}
                      placeholder="z. B. Registrierung in CZ beauftragen"
                    />
                  </div>
                  <div className="g12" style={{ gap: 12 }}>
                    <div className="gc-8">
                      <label className="label-sm" htmlFor="m-verantwortlich">
                        Verantwortlich
                      </label>
                      <select
                        id="m-verantwortlich"
                        name="verantwortlich"
                        className="input"
                        style={{ width: '100%' }}
                        defaultValue=""
                        required
                      >
                        <option value="" disabled>
                          bitte wählen
                        </option>
                        {personenOptionen.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="gc-4">
                      <label className="label-sm" htmlFor="m-frist">
                        Frist
                      </label>
                      <input
                        id="m-frist"
                        name="frist"
                        type="date"
                        className="input"
                        required
                        min={seite.heuteIso}
                        defaultValue={plus14}
                      />
                    </div>
                  </div>
                </FormDialog>
              </span>
            </div>
            {f.massnahmen.length === 0 ? (
              <div className="p-4 text-sm text-muted">
                Noch keine Maßnahme angelegt. Für „Maßnahmen offen“ ist mindestens eine Maßnahme mit
                Verantwortlichem und Frist nötig.
              </div>
            ) : (
              <div>
                {f.massnahmen.map((m) => {
                  const tage = tageZwischen(ctx.stand, m.frist);
                  const ueber = m.status === 'OFFEN' && tage < 0;
                  const darfErledigen =
                    !ctx.historisch &&
                    offen &&
                    (seite.darfBearbeiten || nutzer.id === m.verantwortlich);
                  return (
                    <div key={m.id} className="list-row">
                      <span
                        className={`status-dot ${m.status === 'ERLEDIGT' ? 'dot-green' : ueber ? 'dot-red' : 'dot-amber'}`}
                        style={{ marginTop: 7 }}
                      />
                      <div className="grow">
                        <div className="text-sm font-m">{m.beschreibung}</div>
                        <div className="text-xs text-muted mt-1">
                          Verantwortlich: {personKurzname(ctx, m.verantwortlich)} · Frist{' '}
                          {fmtDatum(m.frist)}
                          {m.status === 'OFFEN' ? (
                            <span style={ueber ? { color: '#b42318' } : undefined}>
                              {' '}
                              ({relativTage(tage)})
                            </span>
                          ) : null}
                        </div>
                        <div className="row-wrap mt-2">
                          <span className="badge-gray" title="Wiedervorlage (kanzleiweit)">
                            <Icon name="CalendarClock" className="tx-icon-xs" /> Wiedervorlage{' '}
                            <span className="mono">#{m.wiedervorlageNr}</span>
                          </span>
                          {m.status === 'ERLEDIGT' ? (
                            <span className="text-xs text-muted">
                              Erledigt · {personKurzname(ctx, m.erledigtVon)} ·{' '}
                              {fmtDatumZeit(m.erledigtAm)}
                            </span>
                          ) : null}
                        </div>
                        {m.status === 'ERLEDIGT' && m.nachweis ? (
                          <div className="text-xs text-secondary mt-1">Nachweis: {m.nachweis}</div>
                        ) : null}
                      </div>
                      <span className="col-s shrink0" style={{ alignItems: 'flex-end' }}>
                        {m.status === 'ERLEDIGT' ? (
                          <span className="badge-green">erledigt</span>
                        ) : ueber ? (
                          <span className="badge-red">überfällig</span>
                        ) : (
                          <span className="badge-yellow">offen</span>
                        )}
                        {m.status === 'OFFEN' ? (
                          <FormDialog
                            ausloeser="Erledigen …"
                            titel={`Maßnahme #${m.wiedervorlageNr} erledigen`}
                            hinweis={m.beschreibung}
                            action={erledigeMassnahme}
                            felder={{ id: m.id }}
                            bestaetigen="Als erledigt dokumentieren"
                            disabled={!darfErledigen}
                            disabledGrund={
                              ctx.historisch
                                ? NUR_AKTUELL
                                : !offen
                                  ? 'Feststellung ist geschlossen oder verworfen'
                                  : KEIN_RECHT
                            }
                          >
                            <div>
                              <label className="label-sm" htmlFor={`n-${m.id}`}>
                                Nachweis der Umsetzung{' '}
                                <span className="text-muted">(mindestens 10 Zeichen)</span>
                              </label>
                              <textarea
                                id={`n-${m.id}`}
                                name="nachweis"
                                className="input"
                                required
                                minLength={10}
                                placeholder="Was wurde umgesetzt, wo liegt der Beleg?"
                              />
                            </div>
                          </FormDialog>
                        ) : null}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* §-153-Block */}
          {p153Pfad ? (
            <P153Block
              feststellungId={f.id}
              optionen={P153_OPTIONEN.map((o) => ({
                wert: o,
                titel:
                  o === 'KEINE_PFLICHT'
                    ? 'Keine Berichtigungspflicht (Begründung erforderlich)'
                    : o === 'WEITERE_KLAERUNG'
                      ? 'Weitere Klärung nötig bis [Datum]'
                      : P153_LABEL[o],
                text: P153_ERLAEUTERUNG[o],
              }))}
              darf={p153Sperre === null}
              sperrGrund={p153Sperre}
              sperrHinweis={p153Hinweis}
              offen={!p153Fertig && f.status !== 'VERWORFEN' && f.status !== 'GESCHLOSSEN'}
              heuteIso={seite.heuteIso}
              ergebnis={
                f.p153
                  ? {
                      label: P153_LABEL[f.p153.entscheidung].replace(' bis …', ''),
                      begruendung: f.p153.begruendung,
                      frist: f.p153.frist ? fmtDatum(f.p153.frist) : null,
                      beleg: `${personKurzname(ctx, f.p153.von)} · ${fmtDatumZeit(f.p153.am)}`,
                    }
                  : null
              }
            />
          ) : (
            <div className="card p-4 text-sm text-muted row-s">
              <Icon name="Info" className="tx-icon-xs" /> Kein §-153-Pfad: steuerliche Auswirkung
              „nein“.
            </div>
          )}

          {/* Nachkontrolle */}
          <div className="card">
            <div className="card-header">
              <span className="card-title">Nachkontrolle</span>
              {f.nachkontrolle ? (
                <StatusBadge status={f.nachkontrolle.anzeige} />
              ) : (
                <span className="badge-gray">nicht angelegt</span>
              )}
            </div>
            <div className="p-4 col-s">
              {f.nachkontrolle ? (
                <div className="row-between" style={{ flexWrap: 'wrap', gap: 8 }}>
                  <div>
                    <Link
                      href={mitStand(`${basis}/durchfuehrungen/${f.nachkontrolle.id}`)}
                      className="text-sm font-m"
                      style={{ textDecoration: 'none' }}
                    >
                      {f.nachkontrolle.code} · {f.nachkontrolle.titel}
                    </Link>
                    <div className="text-xs text-muted mt-1">
                      {f.nachkontrolle.periodeLabel} · fällig {fmtDatum(f.nachkontrolle.faelligAm)}
                      {f.nachkontrolle.ausserplanmaessig ? ' · außerplanmäßig' : ''}
                    </div>
                  </div>
                  <span className="text-xs text-muted">
                    Wirksamkeit der Maßnahmen wird mit dieser Durchführung belegt.
                  </span>
                </div>
              ) : (
                <div className="text-sm text-muted">
                  Die Wirksamkeit der Maßnahmen wird mit einer Kontrolldurchführung belegt (ab
                  Status „Maßnahmen offen“). Geschlossen wird erst nach Nachkontrolle ohne Befund
                  und Gegenzeichnung.
                </div>
              )}
              {nkErsetzbar && offen ? (
                <div className="mt-2">
                  <FormDialog
                    ausloeser={
                      <>
                        <Icon name="CalendarClock" className="tx-icon-xs" />{' '}
                        {f.nachkontrolle ? 'Neue Nachkontrolle anlegen' : 'Nachkontrolle anlegen'}
                      </>
                    }
                    titel="Nachkontrolle anlegen"
                    hinweis="Legt eine außerplanmäßige Durchführung der gewählten Kontrolle an und verknüpft sie mit der Feststellung."
                    action={legeNachkontrolleAn}
                    felder={{ feststellungId: f.id }}
                    bestaetigen="Anlegen und verknüpfen"
                    disabled={!kannAendern || !nkMoeglich}
                    disabledGrund={sperre ?? 'Nachkontrolle ab Status „Maßnahmen offen“'}
                  >
                    <div>
                      <label className="label-sm" htmlFor="nk-kontrolle">
                        Kontrolle
                      </label>
                      <select
                        id="nk-kontrolle"
                        name="kontrolleId"
                        className="input"
                        style={{ width: '100%' }}
                        defaultValue={vorschlagKontrolle}
                        required
                      >
                        <option value="" disabled>
                          bitte wählen
                        </option>
                        {ctx.kontrollen.map((k) => (
                          <option key={k.id} value={k.id}>
                            {k.code} · {k.titel}
                          </option>
                        ))}
                      </select>
                      {quelleCode ? (
                        <div className="hint">
                          Vorbelegt mit der Kontrolle, aus der die Feststellung stammt ({quelleCode}
                          ).
                        </div>
                      ) : null}
                    </div>
                    <div>
                      <label className="label-sm" htmlFor="nk-faellig">
                        Fällig am
                      </label>
                      <input
                        id="nk-faellig"
                        name="faelligAm"
                        type="date"
                        className="input"
                        style={{ width: 'auto' }}
                        required
                        min={seite.heuteIso}
                        defaultValue={plus14}
                      />
                    </div>
                  </FormDialog>
                </div>
              ) : null}
            </div>
          </div>
        </div>

        {/* ================= Seitenspalte ================= */}
        <div className="gc-4 col" style={{ gap: 16 }}>
          <div className="card">
            <div className="card-header">
              <span className="card-title">Erfassung</span>
            </div>
            <div className="p-4 col-s text-sm">
              <div className="row-between">
                <span className="text-secondary">Quelle</span>
                <span className="row-s" style={{ flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                  <span className="badge-gray">{QUELLE_LABEL[f.quelle]}</span>
                  {quelleLink && quelleLinkText ? (
                    <Link
                      href={quelleLink}
                      className="mono text-xs"
                      style={{ textDecoration: 'none' }}
                    >
                      {quelleLinkText}
                    </Link>
                  ) : null}
                  {f.durchfuehrung ? (
                    <span className="text-xs text-muted">({f.durchfuehrung.periodeLabel})</span>
                  ) : !quelleLink ? (
                    <span className="text-xs text-muted">{f.quelleText}</span>
                  ) : null}
                </span>
              </div>
              <div className="row-between">
                <span className="text-secondary">Erfasst von</span>
                <span>{personKurzname(ctx, f.erfasstVon)}</span>
              </div>
              <div className="row-between">
                <span className="text-secondary">Erfasst am</span>
                <span className="mono">{fmtDatum(f.erfasstAm)}</span>
              </div>
              <div className="row-between">
                <span className="text-secondary">Schwere</span>
                <KlasseBadge klasse={f.schwere} />
              </div>
              <div className="row-between">
                <span className="text-secondary">Klasse</span>
                <span className="badge-gray">{FESTSTELLUNG_KLASSE_LABEL[f.klasse]}</span>
              </div>
              <div className="row-between">
                <span className="text-secondary">Status</span>
                <FeststellungStatusBadge status={f.status} />
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-header">
              <span className="card-title">Verlauf</span>
              <span className="text-11 text-muted">aus dem Audit-Log</span>
            </div>
            {f.verlauf.length === 0 ? (
              <div className="p-4 text-sm text-muted">Keine Einträge.</div>
            ) : (
              <div>
                {f.verlauf.map((v, i) => (
                  <div
                    key={v.id}
                    className="p-3"
                    style={
                      i < f.verlauf.length - 1
                        ? { borderBottom: '1px solid rgb(var(--border-subtle) / 0.4)' }
                        : undefined
                    }
                  >
                    <div className="text-xs">
                      <span className="mono text-muted">{fmtDatumZeit(v.at)}</span> ·{' '}
                      <span className="font-m">{v.actorName.replace(/^StB\s+/, '')}</span> ·{' '}
                      {v.text}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="card">
            <div className="card-header">
              <span className="card-title">Weitere Aktionen</span>
            </div>
            <div className="p-3 col-s">
              <button
                type="button"
                className="btn-secondary w-full"
                disabled
                title="Der Subsumtions-Workspace ist in dieser Umgebung (Stufe 1) nicht angebunden"
              >
                <Icon name="FileSearch" className="tx-icon-xs" /> Einzelfall in Subsumtion würdigen
              </button>
              <div className="text-11 text-muted">vorbelegter Sachverhalt · nicht angebunden</div>

              {verwerfenOffen && f.verwerfen ? (
                <div className="alert-warning text-sm mt-2">
                  <div>
                    <strong>Verwerfen beantragt</strong> von{' '}
                    {personKurzname(ctx, f.verwerfen.beantragtVon)}:
                  </div>
                  <div className="text-xs mt-1">{f.verwerfen.begruendung}</div>
                  <div className="row-s mt-2" style={{ flexWrap: 'wrap' }}>
                    <AktionsForm action={bestaetigeVerwerfen}>
                      <input type="hidden" name="id" value={f.id} />
                      <Gesperrt
                        blass
                        grund={
                          sperre ??
                          (nutzer.id === f.verwerfen.beantragtVon
                            ? 'Die Bestätigung muss durch eine zweite Person erfolgen'
                            : null)
                        }
                      >
                        <SubmitButton
                          className="btn-danger-outline btn-tiny"
                          disabled={!kannAendern || nutzer.id === f.verwerfen.beantragtVon}
                          title={
                            sperre ??
                            (nutzer.id === f.verwerfen.beantragtVon
                              ? 'Die Bestätigung muss durch eine zweite Person erfolgen'
                              : undefined)
                          }
                        >
                          Verwerfen bestätigen
                        </SubmitButton>
                      </Gesperrt>
                    </AktionsForm>
                    <AktionsForm action={lehneVerwerfenAb}>
                      <input type="hidden" name="id" value={f.id} />
                      <Gesperrt grund={sperre}>
                        <SubmitButton className="btn-secondary btn-tiny" disabled={!kannAendern}>
                          {nutzer.id === f.verwerfen.beantragtVon
                            ? 'Antrag zurückziehen'
                            : 'Ablehnen'}
                        </SubmitButton>
                      </Gesperrt>
                    </AktionsForm>
                  </div>
                </div>
              ) : f.status !== 'VERWORFEN' ? (
                <FormDialog
                  ausloeser="Feststellung verwerfen …"
                  ausloeserClass="btn-danger-outline"
                  ausloeserTitel="Zweite Person und Begründung erforderlich"
                  titel={`${f.nummer} verwerfen`}
                  hinweis="Nur mit Begründung; eine zweite Person bestätigt."
                  action={beantrageVerwerfen}
                  felder={{ id: f.id }}
                  bestaetigen="Verwerfen beantragen"
                  gefahr
                  begruendungMin={30}
                  begruendungHinweis="Wird von einer zweiten Person bestätigt."
                  disabled={!kannAendern}
                  disabledGrund={sperre ?? undefined}
                />
              ) : null}

              <div
                className="mt-2"
                style={{ borderTop: '1px solid rgb(var(--border-subtle) / 0.4)', paddingTop: 10 }}
              >
                <VertraulichSchalter
                  id={f.id}
                  wert={f.vertraulich}
                  gesperrtGrund={
                    ctx.historisch
                      ? NUR_AKTUELL
                      : !seite.darfWuerdigen
                        ? 'Vertraulich markieren ist Berufsträger:innen vorbehalten'
                        : null
                  }
                />
              </div>
              <div className="text-11 text-muted">nur für Beteiligte sichtbar</div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
