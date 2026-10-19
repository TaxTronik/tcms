import Link from 'next/link';
import type { ReactNode } from 'react';
import {
  brutto as berechneBrutto,
  EREIGNIS_STATUS_BADGE,
  EREIGNIS_STATUS_LABEL,
  FOLGE_LABEL,
  fmtDatum,
  fmtDatumZeit,
  GOVERNANCE_ERKLAERUNG,
  GOVERNANCE_LABEL,
  GRUPPE_LABEL,
  katalogRisiko,
  KLASSE_LABEL,
  KLASSE_RANG,
  KONTROLLART_LABEL,
  NORMSTUFE_BADGE,
  NORMSTUFE_LABEL,
  REICHWEITE_LABEL,
  SCHADEN_LABEL,
  WAHRSCHEINLICHKEIT_LABEL,
  type FolgeArt,
  type Klasse,
} from '@tcms/domain';
import { Icon } from '@/components/icon';
import { KlasseBadge } from '@/components/ui/badges';
import {
  AktionsForm,
  BegruendungsDialog,
  DetailDrawer,
  SubmitButton,
} from '@/components/ui/client';
import { BETRIEB_BADGE, BETRIEB_KURZ, BETRIEB_LABEL } from '@/components/kontrollen/labels';
import { DesignBadge, DurchfuehrungBadge } from '@/components/kontrollen/badges';
import {
  risikenFreigabeSchritt,
  risikoakzeptanzAnfordern,
  risikoFreigabeZurueckweisen,
  risikoNeuBewerten,
  uebersteuerungBeantragen,
  uebersteuerungEntscheiden,
} from '@/server/actions/risiken';
import { personName, type FeststellungView, type RisikoView } from '@/server/kontext';
import type { AkzeptanzView, NeuBewertenHinweis, RisikoDetail } from '@/server/risiken-daten';
import { zweitePerson } from '@tcms/service';
import type { StaffSeite } from '@/server/seite';
import {
  AKZEPTANZ_STATUS_BADGE,
  AKZEPTANZ_STATUS_LABEL,
  kurzName,
  mindestfrequenzText,
  RISIKO_AUDIT_LABEL,
  RISIKO_FREIGABE_BADGE,
  RISIKO_FREIGABE_LABEL,
  RISIKO_FREIGABE_SCHRITTE,
  SICHT_LABEL,
  UEBERSTEUERUNG_STATUS_BADGE,
  UEBERSTEUERUNG_STATUS_LABEL,
} from './labels';

const KLASSEN: Klasse[] = ['GERING', 'MITTEL', 'HOCH', 'KRITISCH'];
const W_KURZ = {
  SELTEN: 'selten',
  MOEGLICH: 'möglich',
  WAHRSCHEINLICH: 'wahrsch.',
  HAEUFIG: 'häufig',
} as const;

/** Datum mit Uhrzeit; reine Tagesdaten (UTC-Mitternacht) ohne Uhrzeit. */
function datumZeit(d: Date): string {
  return d.getUTCHours() === 0 && d.getUTCMinutes() === 0 ? fmtDatum(d) : fmtDatumZeit(d);
}
const SEL = { padding: '5px 10px', fontSize: 13 } as const;

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

function auditText(detail: Record<string, unknown>): string {
  const teile: string[] = [];
  const v = detail['vorher'] as Record<string, unknown> | undefined;
  const n = detail['nachher'] as Record<string, unknown> | undefined;
  if (v && n && typeof v === 'object' && typeof n === 'object' && 's' in v) {
    const f = (x: Record<string, unknown>) =>
      `${x['s']}/${String(x['w']).toLowerCase()}/${x['r']}${x['gt'] ? `/${x['gt']}` : ''}`;
    teile.push(`${f(v)} → ${f(n)}`);
  }
  if (typeof detail['sicht'] === 'string' && typeof detail['klasse'] === 'string') {
    teile.push(
      `${SICHT_LABEL[detail['sicht'] as 'DESIGN' | 'BETRIEB'] ?? detail['sicht']}: ${KLASSE_LABEL[detail['berechnet'] as Klasse] ?? '?'} → ${KLASSE_LABEL[detail['klasse'] as Klasse] ?? detail['klasse']}`,
    );
  }
  if (typeof detail['empfaenger'] === 'string') teile.push(`an ${detail['empfaenger']}`);
  if (typeof detail['anlass'] === 'string') teile.push(`Anlass: ${detail['anlass']}`);
  if (typeof detail['begruendung'] === 'string' && detail['begruendung'])
    teile.push(`„${detail['begruendung']}"`);
  return teile.join(' · ');
}

export function RisikoDrawer({
  seite,
  risiko: r,
  detail,
  hinweise,
  akzeptanzen,
  sperre,
  link,
}: {
  seite: StaffSeite;
  risiko: RisikoView;
  detail: RisikoDetail | null;
  hinweise: NeuBewertenHinweis[];
  akzeptanzen: AkzeptanzView[];
  sperre: string | null;
  link: (aenderung: Record<string, string | null>) => string;
}) {
  const { ctx, basis, mitStand, nutzer } = seite;
  const b = r.bewertung;
  const kat = katalogRisiko(r.code);
  const kontrollen = ctx.kontrollen.filter((k) => r.kontrollIds.includes(k.id));
  const betriebAktiv =
    !!ctx.programm?.wirksamAb && ctx.programm.wirksamAb.getTime() <= ctx.stand.getTime();
  const turnus = ctx.programm?.erklaerungsTurnus ?? 'MONATLICH';
  // Mandant und gesehener Risikostand (TS-05) gehen mit jeder Aktion mit.
  const felder = { id: r.id, stand: seite.standIso, mandantId: ctx.mandant.id, standId: r.standId };

  const ende = ctx.stand.getTime() + 86_400_000 - 1;
  // Status zum Stichtag: später entschiedene Übersteuerungen galten dort noch als beantragt.
  const uebersteuerungen = r.uebersteuerungen.map((u) =>
    u.entschiedenAm && u.entschiedenAm.getTime() > ende
      ? { ...u, status: 'BEANTRAGT' as const, entschiedenVon: null, entschiedenAm: null }
      : u,
  );
  const wirksamU = (sicht: 'DESIGN' | 'BETRIEB') =>
    uebersteuerungen.find((u) => u.sicht === sicht && u.status === 'FREIGEGEBEN');
  const offeneU = uebersteuerungen.filter((u) => u.status === 'BEANTRAGT');
  const ereignisse = ctx.ereignisse.filter((e) => e.folgen.some((f) => f.ziel === r.code));
  // Maskierte vertrauliche Feststellungen nennen keine Risikocodes (RT-01, Service).
  const feststellungen = ctx.feststellungen.filter(
    (f): f is FeststellungView => !f.maskiert && f.risikoCodes.includes(r.code),
  );
  const offeneAkzeptanz = akzeptanzen.find((a) => a.status === 'OFFEN');
  const gesetzlicheVertreter = ctx.mandantPersonen.filter(
    (p) => p.mandantRolle === 'GESETZLICHER_VERTRETER',
  );
  const beeinflusstVon = ctx.risiken.filter((x) => x.wirktAuf.includes(r.code));
  const schrittIndex = RISIKO_FREIGABE_SCHRITTE.indexOf(r.freigabe);
  const istZweite = zweitePerson(nutzer, r.freigabeEingereichtVon);

  const kopf = (
    <>
      <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
        <span className="text-base font-b text-primary">
          {r.code} · {r.titel}
        </span>
        <span className={RISIKO_FREIGABE_BADGE[r.freigabe]}>
          {RISIKO_FREIGABE_LABEL[r.freigabe]}
        </span>
        {hinweise.length ? (
          <span className="badge-yellow" title={hinweise.map((h) => h.text).join('\n')}>
            <Icon name="RefreshCw" className="tx-icon-xs" /> neu bewerten
          </span>
        ) : null}
      </div>
      <div className="text-xs text-muted mt-1">
        Gruppe {r.gruppe} · Governance-Typ {r.gt} · Brutto {KLASSE_LABEL[b.brutto.klasse]} · Netto{' '}
        {betriebAktiv ? 'Betrieb' : 'Design'} {KLASSE_LABEL[r.netto]} · Verantwortlich:{' '}
        {personName(ctx, r.ownerId)}
      </div>
    </>
  );

  const neuBewertenDialog = (
    <BegruendungsDialog
      ausloeser={
        <>
          <Icon name="RefreshCw" className="tx-icon-xs" />{' '}
          {r.freigabe === 'IDENTIFIZIERT' ? 'Bewertung erfassen…' : 'Neu bewerten…'}
        </>
      }
      titel={`${r.code} neu bewerten`}
      hinweis={`Der aktuelle Stand wird mit Gültig-bis geschlossen und ein neuer Stand angelegt (Modell ${b.modell}). Geänderte Werte brauchen eine erneute Freigabe durch eine zweite Person.`}
      action={risikoNeuBewerten}
      felder={felder}
      bestaetigen="Neuen Stand speichern"
      disabled={!!sperre}
      disabledGrund={sperre ?? undefined}
    >
      <div className="g12">
        <div className="gc-6">
          <label className="label-sm" htmlFor={`nb-s-${r.id}`}>
            Schadensintensität (S)
          </label>
          <select id={`nb-s-${r.id}`} name="s" className="input" style={SEL} defaultValue={r.s}>
            {(['N', 'M', 'H'] as const).map((s) => (
              <option key={s} value={s}>
                {s} — {SCHADEN_LABEL[s]}
              </option>
            ))}
          </select>
        </div>
        <div className="gc-6">
          <label className="label-sm" htmlFor={`nb-w-${r.id}`}>
            Wahrscheinlichkeit (W)
          </label>
          <select id={`nb-w-${r.id}`} name="w" className="input" style={SEL} defaultValue={r.w}>
            {(['SELTEN', 'MOEGLICH', 'WAHRSCHEINLICH', 'HAEUFIG'] as const).map((w) => (
              <option key={w} value={w}>
                {WAHRSCHEINLICHKEIT_LABEL[w]}
              </option>
            ))}
          </select>
        </div>
        <div className="gc-6">
          <label className="label-sm" htmlFor={`nb-r-${r.id}`}>
            Reichweite (R)
          </label>
          <select
            id={`nb-r-${r.id}`}
            name="r"
            className="input"
            style={SEL}
            defaultValue={String(r.r)}
          >
            {([1, 2, 3] as const).map((x) => (
              <option key={x} value={x}>
                {REICHWEITE_LABEL[x]}
              </option>
            ))}
          </select>
        </div>
        <div className="gc-6">
          <label className="label-sm" htmlFor={`nb-gt-${r.id}`}>
            Governance-Typ
          </label>
          <select id={`nb-gt-${r.id}`} name="gt" className="input" style={SEL} defaultValue={r.gt}>
            {(['FP', 'FF', 'IN'] as const).map((g) => (
              <option key={g} value={g}>
                {GOVERNANCE_LABEL[g]}
              </option>
            ))}
          </select>
        </div>
      </div>
      {hinweise.length ? (
        <div className="alert-warning text-xs">
          Anlass: {hinweise.map((h) => h.text).join(' · ')}
        </div>
      ) : null}
      <p className="hint">
        Ändern sich GT oder Bruttoklasse, werden künftige Durchführungen der verknüpften Kontrollen
        neu geplant; abgeschlossene bleiben unverändert.
      </p>
    </BegruendungsDialog>
  );

  return (
    <DetailDrawer param="risiko" titel={`Risikodetail ${r.code}`} kopf={kopf}>
      <div className="col">
        {hinweise.length ? (
          <div
            className="alert-warning row-between"
            role="status"
            style={{ alignItems: 'flex-start', gap: 12 }}
          >
            <span className="col-s">
              <strong className="text-sm">Neu bewerten</strong>
              {hinweise.map((h) => (
                <span key={h.text} className="text-xs">
                  {h.ereignisId ? (
                    <Link href={mitStand(`${basis}/ereignisse?e=${h.ereignisId}`)}>{h.text}</Link>
                  ) : (
                    h.text
                  )}
                </span>
              ))}
            </span>
            <span className="shrink0">{neuBewertenDialog}</span>
          </div>
        ) : null}

        <Abschnitt titel="Beschreibung" offen>
          <p className="text-sm text-secondary">
            <span className="font-m text-primary">Fehlerquelle:</span> {r.fehlerquelle} →{' '}
            <span className="font-m text-primary">Folge:</span> {r.folge}.
          </p>
        </Abschnitt>

        <Abschnitt titel="Anwendbarkeit">
          <div className="row-wrap">
            {r.kern ? <span className="badge-gray">Kernrisiko – immer aktiv</span> : null}
            {r.vorschlagsgrund && !r.kern ? (
              <span className="badge-brand">{r.vorschlagsgrund}</span>
            ) : null}
            {r.herkunft === 'BERATER' ? (
              <span className="badge-gray">eigenes Risiko (Herkunft Berater)</span>
            ) : null}
          </div>
          <p className="text-11 text-muted">
            {kat ? `Katalog: anwendbar wenn ${kat.anwendbarWenn}. ` : ''}
            {detail ? `Im Inventar seit ${fmtDatum(detail.aktivAb)}.` : ''}
          </p>
        </Abschnitt>

        <Abschnitt titel={`Normanker (${r.normanker.length})`}>
          {r.normanker.length === 0 ? (
            <p className="text-sm text-muted">Kein Normanker hinterlegt.</p>
          ) : null}
          {r.normanker.map((n) => (
            <details key={n.text} className="details-box">
              <summary>
                <span className="grow">{n.text}</span>
                <span className={NORMSTUFE_BADGE[n.stufe]}>{NORMSTUFE_LABEL[n.stufe]}</span>
              </summary>
              <div className="details-body">
                <p className="text-11 text-muted">
                  {n.stufe === 'GEPRUEFT'
                    ? 'Vom Berufsträger geprüft. Normtext ist im Katalog nicht hinterlegt.'
                    : n.stufe === 'KI_VERMUTUNG'
                      ? 'KI-Vermutung – nicht ohne Prüfung durch einen Berufsträger verwenden. Normtext ausgeblendet.'
                      : 'ungeprüft · Freigabe durch Berufsträger ausstehend – Normtext ausgeblendet.'}
                </p>
              </div>
            </details>
          ))}
          <div className="alert-info-sm">
            <span className="text-sm">
              Normanker und Katalogwerte sind ungeprüfte Entwürfe (Katalog v
              {ctx.programm?.paketVersion ?? '1.0'}); sie ersetzen keine Einzelfallprüfung.
            </span>
          </div>
        </Abschnitt>

        <Abschnitt titel="Bewertung" offen>
          <div className="g12">
            <div className="gc-6">
              <span className="label-sm">Schadensintensität (S)</span>
              <span className="text-sm">
                {r.s} — {SCHADEN_LABEL[r.s]}
              </span>
            </div>
            <div className="gc-6">
              <span className="label-sm">Wahrscheinlichkeit (W)</span>
              <span className="text-sm">{WAHRSCHEINLICHKEIT_LABEL[r.w]}</span>
            </div>
            <div className="gc-6">
              <span className="label-sm">Reichweite (R)</span>
              <span className="text-sm">{REICHWEITE_LABEL[r.r]}</span>
            </div>
            <div className="gc-6">
              <span className="label-sm">Governance-Typ</span>
              <span className="text-sm" title={GOVERNANCE_ERKLAERUNG[r.gt]}>
                {GOVERNANCE_LABEL[r.gt]}
              </span>
            </div>
          </div>
          <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
            <span className="text-xs text-muted">Brutto</span>
            <KlasseBadge klasse={b.brutto.klasse} title={b.brutto.erklaerung} />
            <span className="text-muted">→</span>
            <span className="text-xs text-muted">Netto Design</span>
            <KlasseBadge
              klasse={b.wirksamDesign}
              uebersteuert={b.uebersteuertDesign}
              title={b.nettoDesign.erklaerung}
            />
            {b.uebersteuertDesign ? (
              <span className="text-11 text-muted">
                berechnet {KLASSE_LABEL[b.nettoDesign.klasse]}
              </span>
            ) : null}
            <span className="text-muted">→</span>
            <span className="text-xs text-muted">Netto Betrieb</span>
            <KlasseBadge
              klasse={b.wirksamBetrieb}
              uebersteuert={b.uebersteuertBetrieb}
              title={b.nettoBetrieb.erklaerung}
            />
            {b.uebersteuertBetrieb ? (
              <span className="text-11 text-muted">
                berechnet {KLASSE_LABEL[b.nettoBetrieb.klasse]}
              </span>
            ) : null}
          </div>
          <div className="col-s text-xs text-muted">
            <span>
              <span className="font-m text-secondary">Brutto:</span> {b.brutto.erklaerung}.
            </span>
            <span>
              <span className="font-m text-secondary">Netto (Design):</span>{' '}
              {b.nettoDesign.erklaerung}
              {b.nettoDesign.zaehlend.length ? ` (${b.nettoDesign.zaehlend.join(', ')})` : ''}.
            </span>
            <span>
              <span className="font-m text-secondary">Netto (Betrieb):</span>{' '}
              {b.nettoBetrieb.erklaerung}
              {b.nettoBetrieb.zaehlend.length ? ` (${b.nettoBetrieb.zaehlend.join(', ')})` : ''}.
            </span>
            <span>
              Modell {b.modell} · Stand gültig ab {datumZeit(r.gueltigAb)} · Der Governance-Typ
              verändert die Klasse nicht.
            </span>
          </div>
          <div className="row-s">
            <Icon name="CalendarClock" className="tx-icon-xs" />
            <span className="text-sm">
              Manuell prüfen (Mindestfrequenz): {mindestfrequenzText(r.gt, b.brutto.klasse, turnus)}
            </span>
          </div>
          <div className="row-s" style={{ flexWrap: 'wrap' }}>
            {neuBewertenDialog}
            <BegruendungsDialog
              ausloeser={
                <>
                  <Icon name="Pencil" className="tx-icon-xs" /> Übersteuern…
                </>
              }
              titel={`${r.code} · Nettoklasse übersteuern`}
              hinweis="Die Übersteuerung ist ein eigenes Objekt; der berechnete Wert bleibt sichtbar. Gilt erst nach Freigabe durch eine zweite Person."
              action={uebersteuerungBeantragen}
              felder={felder}
              bestaetigen="Übersteuerung beantragen"
              disabled={!!sperre || offeneU.length >= 2}
              disabledGrund={sperre ?? 'Für beide Sichten ist bereits eine Übersteuerung beantragt'}
            >
              <div className="g12">
                <div className="gc-6">
                  <label className="label-sm" htmlFor={`u-sicht-${r.id}`}>
                    Sicht
                  </label>
                  <select
                    id={`u-sicht-${r.id}`}
                    name="sicht"
                    className="input"
                    style={SEL}
                    defaultValue={betriebAktiv ? 'BETRIEB' : 'DESIGN'}
                  >
                    <option value="DESIGN">
                      Netto Design (berechnet: {KLASSE_LABEL[b.nettoDesign.klasse]})
                    </option>
                    <option value="BETRIEB">
                      Netto Betrieb (berechnet: {KLASSE_LABEL[b.nettoBetrieb.klasse]})
                    </option>
                  </select>
                </div>
                <div className="gc-6">
                  <label className="label-sm" htmlFor={`u-klasse-${r.id}`}>
                    Zielklasse
                  </label>
                  <select
                    id={`u-klasse-${r.id}`}
                    name="klasse"
                    className="input"
                    style={SEL}
                    defaultValue=""
                  >
                    <option value="" disabled>
                      bitte wählen
                    </option>
                    {KLASSEN.map((k) => (
                      <option key={k} value={k}>
                        {KLASSE_LABEL[k]}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </BegruendungsDialog>
          </div>
        </Abschnitt>

        <Abschnitt titel={`Brutto/Netto-Herleitung · Kontrollen (${kontrollen.length})`} offen>
          {kontrollen.length === 0 ? (
            <div className="alert-error text-sm">Keine Kontrolle zugeordnet – Netto = Brutto.</div>
          ) : (
            <div className="col-s">
              {kontrollen.map((k) => (
                <div
                  key={k.id}
                  className="row-between"
                  style={{ flexWrap: 'wrap', gap: 8, alignItems: 'flex-start' }}
                >
                  <span className="col-s" style={{ gap: 2 }}>
                    <Link
                      href={mitStand(`${basis}/kontrollen?kontrolle=${k.id}`)}
                      className="text-sm font-m"
                    >
                      {k.code} · {k.titel}
                    </Link>
                    <span className="text-11 text-muted">
                      {KONTROLLART_LABEL[k.art]}
                      {k.schluessel ? ' · Schlüsselkontrolle' : ''} · Design{' '}
                      {b.nettoDesign.zaehlend.includes(k.code) ? 'zählt' : 'zählt nicht'} · Betrieb{' '}
                      {b.nettoBetrieb.zaehlend.includes(k.code) ? 'zählt' : 'zählt nicht'}
                    </span>
                  </span>
                  <span className="row-s" style={{ flexWrap: 'wrap' }}>
                    <DesignBadge
                      design={k.design}
                      von={personName(ctx, k.designVon)}
                      am={k.designAm}
                      begruendung={k.designBegruendung}
                    />
                    <span className={BETRIEB_BADGE[k.betrieb]} title={BETRIEB_LABEL[k.betrieb]}>
                      Betrieb: {BETRIEB_KURZ[k.betrieb]}
                    </span>
                    {k.letzte ? <DurchfuehrungBadge d={k.letzte} /> : null}
                    {k.letzte ? (
                      <Link
                        href={mitStand(`${basis}/durchfuehrungen/${k.letzte.id}`)}
                        className="text-xs text-muted"
                      >
                        zur Durchführung
                      </Link>
                    ) : null}
                  </span>
                </div>
              ))}
            </div>
          )}
          <p className="text-11 text-muted">
            Netto (Design): −1 bei mindestens einer angemessen beurteilten Kontrolle, −2 bei
            präventiver und detektiver oder präventiver Schlüsselkontrolle. Netto (Betrieb):
            Abschlag zählt nur bei letzter fälliger Durchführung ohne Befund und gegengezeichnet.{' '}
            {betriebAktiv
              ? 'Für den Risikoappetit gilt Netto (Betrieb).'
              : 'Vor Beginn des Wirksamkeitszeitraums gilt für den Risikoappetit Netto (Design).'}
          </p>
        </Abschnitt>

        <Abschnitt
          titel="Risikoappetit"
          offen={r.ueberAppetit}
          rechts={
            r.ueberAppetit ? (
              <span className="badge-red">über Appetit</span>
            ) : (
              <span className="badge-green">im Appetit</span>
            )
          }
        >
          <p className="text-sm text-secondary">
            Risikoappetit laut Compliance-Zielen: <strong>{KLASSE_LABEL[ctx.appetit]}</strong> ·
            maßgebliche Nettoklasse ({betriebAktiv ? 'Betrieb' : 'Design'}):{' '}
            <strong>{KLASSE_LABEL[r.netto]}</strong>.
          </p>
          {r.ueberAppetit ? (
            <div className="alert-warning text-sm">
              Liegt ein Risiko über dem Appetit, ist eine Maßnahme oder eine Risikoakzeptanz durch
              die gesetzlichen Vertreter (Portal) erforderlich.
            </div>
          ) : null}
          {feststellungen.length ? (
            <div className="col-s">
              <span className="label-sm">Feststellungen und Maßnahmen</span>
              {feststellungen.map((f) => (
                <div key={f.id} className="row-between" style={{ gap: 8 }}>
                  <Link href={mitStand(`${basis}/feststellungen/${f.id}`)} className="text-sm">
                    <span className="mono">{f.nummer}</span> · {f.titel}
                  </Link>
                  <span className={f.massnahmenOffen ? 'badge-yellow' : 'badge-gray'}>
                    {f.massnahmenOffen
                      ? `${f.massnahmenOffen} Maßnahmen offen`
                      : `${f.massnahmen} Maßnahmen`}
                  </span>
                </div>
              ))}
            </div>
          ) : null}
          {akzeptanzen.length ? (
            <div className="col-s">
              <span className="label-sm">Risikoakzeptanz</span>
              {akzeptanzen.map((a) => (
                <div key={a.id} className="row-between" style={{ gap: 8, flexWrap: 'wrap' }}>
                  <span className="text-xs text-secondary">
                    angefordert {fmtDatumZeit(a.angefordertAm)} von{' '}
                    {personName(ctx, a.angefordertVon)} bei {personName(ctx, a.empfaengerId)}
                    {a.erledigtAm ? ` · entschieden ${fmtDatumZeit(a.erledigtAm)}` : ''}
                    {a.anmerkung ? ` · „${a.anmerkung}"` : ''}
                  </span>
                  <span className={AKZEPTANZ_STATUS_BADGE[a.status]}>
                    {AKZEPTANZ_STATUS_LABEL[a.status]}
                  </span>
                </div>
              ))}
            </div>
          ) : null}
          {r.ueberAppetit ? (
            <div>
              <BegruendungsDialog
                ausloeser={
                  <>
                    <Icon name="Send" className="tx-icon-xs" /> Risikoakzeptanz anfordern…
                  </>
                }
                titel={`Risikoakzeptanz ${r.code} anfordern`}
                hinweis="Freigabe im Portal nur durch gesetzliche Vertreter (Bestätigung per E-Mail-Code). Die Erläuterung erscheint dort im Wortlaut."
                action={risikoakzeptanzAnfordern}
                felder={felder}
                bestaetigen="Im Portal anfordern"
                vierAugen={false}
                disabled={!!sperre || !!offeneAkzeptanz || gesetzlicheVertreter.length === 0}
                disabledGrund={
                  sperre ??
                  (offeneAkzeptanz
                    ? `Bereits angefordert am ${fmtDatum(offeneAkzeptanz.angefordertAm)} – wartet auf ${personName(ctx, offeneAkzeptanz.empfaengerId)}`
                    : 'Keine gesetzlichen Vertreter beim Mandanten hinterlegt')
                }
              >
                <label className="label-sm" htmlFor={`ak-empf-${r.id}`}>
                  Gesetzliche:r Vertreter:in
                </label>
                <select
                  id={`ak-empf-${r.id}`}
                  name="empfaengerId"
                  className="input"
                  style={SEL}
                  defaultValue={gesetzlicheVertreter[0]?.id}
                >
                  {gesetzlicheVertreter.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                      {p.funktion ? ` (${p.funktion})` : ''}
                    </option>
                  ))}
                </select>
              </BegruendungsDialog>
            </div>
          ) : null}
        </Abschnitt>

        <Abschnitt
          titel={`Übersteuerungen (${uebersteuerungen.length})`}
          offen={offeneU.length > 0}
          rechts={
            offeneU.length ? <span className="badge-purple">{offeneU.length} beantragt</span> : null
          }
        >
          {uebersteuerungen.length === 0 ? (
            <p className="text-sm text-muted">
              Keine Übersteuerung. Es gelten die berechneten Nettoklassen.
            </p>
          ) : null}
          {uebersteuerungen.map((u) => {
            const wirksam = wirksamU(u.sicht)?.id === u.id;
            const darf = zweitePerson(nutzer, u.beantragtVon);
            const grund =
              sperre ??
              (darf ? undefined : 'Beantragt von dir – die Entscheidung trifft eine zweite Person');
            return (
              <div
                key={u.id}
                className="col-s"
                style={{ borderTop: '1px solid rgb(var(--border-subtle) / 0.4)', paddingTop: 8 }}
              >
                <div className="row-between" style={{ gap: 8, flexWrap: 'wrap' }}>
                  <span className="row-s text-sm">
                    <span className="font-m">{SICHT_LABEL[u.sicht]}:</span>{' '}
                    <KlasseBadge klasse={u.berechnet} title="berechnet zum Antrag" /> →{' '}
                    <KlasseBadge klasse={u.klasse} uebersteuert />
                  </span>
                  <span className="row-s">
                    <span className={UEBERSTEUERUNG_STATUS_BADGE[u.status]}>
                      {UEBERSTEUERUNG_STATUS_LABEL[u.status]}
                    </span>
                    {u.status === 'FREIGEGEBEN' ? (
                      <span className={wirksam ? 'badge-brand' : 'badge-gray'}>
                        {wirksam ? 'gilt' : 'abgelöst'}
                      </span>
                    ) : null}
                  </span>
                </div>
                <span className="text-xs text-secondary">„{u.begruendung}"</span>
                <span className="text-11 text-muted">
                  beantragt {personName(ctx, u.beantragtVon)} · {fmtDatumZeit(u.beantragtAm)}
                  {u.entschiedenVon
                    ? ` · entschieden ${personName(ctx, u.entschiedenVon)} · ${fmtDatumZeit(u.entschiedenAm)}`
                    : ''}
                </span>
                {u.status === 'BEANTRAGT' ? (
                  <div className="row-s">
                    <AktionsForm action={uebersteuerungEntscheiden} className="inline-form">
                      <input type="hidden" name="id" value={u.id} />
                      <input type="hidden" name="mandantId" value={ctx.mandant.id} />
                      <input type="hidden" name="entscheidung" value="freigeben" />
                      <input type="hidden" name="stand" value={seite.standIso} />
                      <SubmitButton
                        className="btn-primary btn-tiny"
                        disabled={!!grund}
                        title={grund}
                      >
                        <Icon name="Check" className="tx-icon-xs" /> Freigeben
                      </SubmitButton>
                    </AktionsForm>
                    <BegruendungsDialog
                      ausloeser="Ablehnen…"
                      titel="Übersteuerung ablehnen"
                      action={uebersteuerungEntscheiden}
                      felder={{
                        id: u.id,
                        entscheidung: 'ablehnen',
                        stand: seite.standIso,
                        mandantId: ctx.mandant.id,
                      }}
                      bestaetigen="Ablehnen"
                      vierAugen={false}
                      disabled={!!grund}
                      disabledGrund={grund}
                    />
                  </div>
                ) : null}
              </div>
            );
          })}
        </Abschnitt>

        <Abschnitt
          titel="Freigabe (Vier-Augen)"
          offen={r.freigabe !== 'FREIGEGEBEN'}
          rechts={
            <span className={RISIKO_FREIGABE_BADGE[r.freigabe]}>
              {RISIKO_FREIGABE_LABEL[r.freigabe]}
            </span>
          }
        >
          <div className="steps-mini">
            {RISIKO_FREIGABE_SCHRITTE.map((s, i) => (
              <span
                key={s}
                className="row"
                style={{ flex: i < RISIKO_FREIGABE_SCHRITTE.length - 1 ? 1 : undefined, gap: 0 }}
              >
                <span
                  className={`st ${i < schrittIndex || r.freigabe === 'FREIGEGEBEN' ? 'done' : i === schrittIndex ? 'now' : ''}`}
                >
                  <span className="pt">
                    {i < schrittIndex || r.freigabe === 'FREIGEGEBEN' ? (
                      <Icon name="Check" className="tx-icon-xs" />
                    ) : (
                      i + 1
                    )}
                  </span>
                  {RISIKO_FREIGABE_LABEL[s]}
                </span>
                {i < RISIKO_FREIGABE_SCHRITTE.length - 1 ? <span className="st-line" /> : null}
              </span>
            ))}
          </div>
          <p className="text-xs text-muted">
            {r.freigabeEingereichtVon
              ? `Eingereicht von ${personName(ctx, r.freigabeEingereichtVon)}. `
              : ''}
            {r.freigabe === 'FREIGEGEBEN' && r.freigegebenVon
              ? `Freigegeben von ${personName(ctx, r.freigegebenVon)} · ${r.freigegebenAm ? datumZeit(r.freigegebenAm) : '—'}. `
              : ''}
            Die Freigabe erteilt eine zweite Person mit Bearbeitungsrecht (nicht die einreichende).
            Eine geänderte Bewertung setzt den Status auf „bewertet“ zurück.
          </p>
          {r.freigabe === 'IDENTIFIZIERT' ? (
            <p className="text-sm text-secondary">
              Zuerst die Bewertung erfassen („Bewertung erfassen…“ im Abschnitt Bewertung).
            </p>
          ) : null}
          {r.freigabe === 'BEWERTET' ? (
            <AktionsForm action={risikenFreigabeSchritt}>
              <input type="hidden" name="ids" value={r.id} />
              <input type="hidden" name="mandantId" value={ctx.mandant.id} />
              <input type="hidden" name="aktion" value="einreichen" />
              <input type="hidden" name="stand" value={seite.standIso} />
              <SubmitButton
                className="btn-primary btn-tiny"
                disabled={!!sperre}
                title={sperre ?? undefined}
              >
                <Icon name="Send" className="tx-icon-xs" /> Zur Freigabe einreichen
              </SubmitButton>
            </AktionsForm>
          ) : null}
          {r.freigabe === 'ZUR_FREIGABE' ? (
            <div className="row-s">
              <AktionsForm action={risikenFreigabeSchritt} className="inline-form">
                <input type="hidden" name="ids" value={r.id} />
                <input type="hidden" name="mandantId" value={ctx.mandant.id} />
                <input type="hidden" name="aktion" value="freigeben" />
                <input type="hidden" name="stand" value={seite.standIso} />
                <SubmitButton
                  className="btn-primary btn-tiny"
                  disabled={!!sperre || !istZweite}
                  title={
                    sperre ??
                    (istZweite
                      ? undefined
                      : 'Von dir eingereicht – die Freigabe erteilt eine zweite Person')
                  }
                >
                  <Icon name="CheckCheck" className="tx-icon-xs" /> Freigeben
                </SubmitButton>
              </AktionsForm>
              <BegruendungsDialog
                ausloeser="Zurückweisen…"
                titel={`${r.code} zurückweisen`}
                action={risikoFreigabeZurueckweisen}
                felder={felder}
                bestaetigen="Zurückweisen"
                vierAugen={false}
                disabled={!!sperre || !istZweite}
                disabledGrund={
                  sperre ?? 'Von dir eingereicht – die Entscheidung trifft eine zweite Person'
                }
              />
            </div>
          ) : null}
        </Abschnitt>

        <Abschnitt titel={`Interdependenzen (${r.wirktAuf.length + beeinflusstVon.length})`}>
          {r.wirktAuf.length + beeinflusstVon.length === 0 ? (
            <p className="text-sm text-muted">Keine Interdependenz im Katalog hinterlegt.</p>
          ) : null}
          {r.wirktAuf.length ? (
            <div className="row-wrap">
              <span className="text-xs text-muted">wirkt auf</span>
              {r.wirktAuf.map((c) => {
                const ziel = ctx.risiken.find((x) => x.code === c);
                return ziel ? (
                  <Link
                    key={c}
                    href={link({ risiko: ziel.id })}
                    className="badge-gray mono"
                    style={{ textDecoration: 'none' }}
                    title={ziel.titel}
                  >
                    {c}
                  </Link>
                ) : (
                  <span
                    key={c}
                    className="badge-gray mono"
                    title="nicht im Inventar"
                    style={{ opacity: 0.6 }}
                  >
                    {c}
                  </span>
                );
              })}
            </div>
          ) : null}
          {beeinflusstVon.length ? (
            <div className="row-wrap">
              <span className="text-xs text-muted">beeinflusst von</span>
              {beeinflusstVon.map((x) => (
                <Link
                  key={x.id}
                  href={link({ risiko: x.id })}
                  className="badge-gray mono"
                  style={{ textDecoration: 'none' }}
                  title={x.titel}
                >
                  {x.code}
                </Link>
              ))}
            </div>
          ) : null}
        </Abschnitt>

        <Abschnitt
          titel={`Ereignisse (${ereignisse.length})`}
          rechts={
            r.offeneEreignisse ? (
              <span className="badge-yellow">{r.offeneEreignisse} offen</span>
            ) : null
          }
        >
          {ereignisse.length === 0 ? (
            <p className="text-sm text-muted">Kein Ereignis mit Bezug auf dieses Risiko.</p>
          ) : null}
          {ereignisse.map((e) => (
            <div key={e.id} className="col-s">
              <div className="row-between" style={{ flexWrap: 'wrap', gap: 8 }}>
                <span className="text-sm">
                  <Link href={mitStand(`${basis}/ereignisse?e=${e.id}`)} className="font-m mono">
                    {e.typ}
                  </Link>{' '}
                  · {e.titel}
                </span>
                <span className={EREIGNIS_STATUS_BADGE[e.status]}>
                  {EREIGNIS_STATUS_LABEL[e.status]} · {fmtDatum(e.gemeldetAm)}
                </span>
              </div>
              {e.folgen
                .filter((f) => f.ziel === r.code)
                .map((f) => (
                  <span key={f.id} className="text-11 text-muted">
                    Folge: {FOLGE_LABEL[f.art as FolgeArt] ?? f.art} – {f.text} (
                    {f.status.toLowerCase()})
                  </span>
                ))}
            </div>
          ))}
        </Abschnitt>

        <Abschnitt titel={`Stand-Historie (${detail?.staende.length ?? 0})`}>
          {detail && detail.staende.length ? (
            <div className="tbl-scroll">
              <table className="tbl" style={{ fontSize: 12.5 }}>
                <thead>
                  <tr>
                    <th style={{ padding: '8px 10px' }}>gültig ab</th>
                    <th style={{ padding: '8px 10px' }}>gültig bis</th>
                    <th style={{ padding: '8px 10px' }}>S / W / R</th>
                    <th style={{ padding: '8px 10px' }}>GT</th>
                    <th style={{ padding: '8px 10px' }}>Brutto</th>
                    <th style={{ padding: '8px 10px' }}>Person</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.staende.map((s) => {
                    const bk = berechneBrutto(s.s, s.w, s.r).klasse;
                    return (
                      <tr key={s.id} className={s.id === r.standId ? 'sel' : undefined}>
                        <td style={{ padding: '8px 10px' }} className="mono text-xs">
                          {datumZeit(s.gueltigAb)}
                        </td>
                        <td style={{ padding: '8px 10px' }} className="mono text-xs">
                          {s.gueltigBis ? (
                            datumZeit(s.gueltigBis)
                          ) : (
                            <span className="badge-brand">aktuell</span>
                          )}
                        </td>
                        <td
                          style={{ padding: '8px 10px' }}
                          title={`${SCHADEN_LABEL[s.s]} / ${WAHRSCHEINLICHKEIT_LABEL[s.w]} / ${REICHWEITE_LABEL[s.r]}`}
                        >
                          {s.s} / {W_KURZ[s.w]} / {s.r}
                        </td>
                        <td style={{ padding: '8px 10px' }}>{s.gt}</td>
                        <td style={{ padding: '8px 10px' }}>
                          <KlasseBadge klasse={bk} title={`Modell ${s.modell}`} />
                        </td>
                        <td
                          style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}
                          className="text-xs"
                          title={personName(ctx, s.erstelltVon)}
                        >
                          {kurzName(personName(ctx, s.erstelltVon))}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm text-muted">Keine Stände bis zum Stichtag.</p>
          )}
          <p className="text-11 text-muted">
            Versionierte Stände werden nie geändert: eine Neubewertung schließt den Stand mit
            Gültig-bis und legt einen neuen an.
          </p>
        </Abschnitt>

        <Abschnitt titel="Historie">
          <div className="col-s">
            {(detail?.audit ?? []).map((a) => (
              <div key={a.pos} className="row" style={{ alignItems: 'flex-start' }}>
                <span className="text-xs mono text-muted shrink0">{datumZeit(a.at)}</span>
                <span className="text-xs text-secondary shrink0">{a.actorName}</span>
                <span className="text-sm grow">
                  {RISIKO_AUDIT_LABEL[a.aktion] ?? a.aktion}
                  {auditText(a.detail) ? (
                    <span className="text-11 text-muted"> · {auditText(a.detail)}</span>
                  ) : null}
                </span>
              </div>
            ))}
            {detail ? (
              <div className="row">
                <span className="text-xs mono text-muted shrink0">{fmtDatum(detail.aktivAb)}</span>
                <span className="text-xs text-secondary shrink0">—</span>
                <span className="text-sm grow">
                  Risiko ins Inventar übernommen (
                  {detail.herkunft === 'KATALOG'
                    ? `Katalog v${ctx.programm?.paketVersion ?? '1.0'}`
                    : 'Herkunft Berater'}
                  )
                </span>
              </div>
            ) : null}
          </div>
        </Abschnitt>
        <p className="text-11 text-muted">
          Gruppe {GRUPPE_LABEL[r.gruppe]} · Klassen werden berechnet, nie gespeichert-überschrieben.
          Statusangaben sind Betriebsinformationen.
          {KLASSE_RANG[b.nettoBetrieb.klasse] > KLASSE_RANG[b.nettoDesign.klasse]
            ? ' Netto (Betrieb) liegt über Netto (Design), weil ein Kontrollabschlag im Betrieb entfällt.'
            : ''}
        </p>
      </div>
    </DetailDrawer>
  );
}
