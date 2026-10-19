import Link from 'next/link';
import type { ReactNode } from 'react';
import {
  EREIGNIS_STATUS_BADGE,
  EREIGNIS_STATUS_LABEL,
  FESTSTELLUNG_STATUS_LABEL,
  fmtDatum,
  fmtDatumZeit,
  fmtEurGanz,
  fmtMonatJahr,
  frequenzLabel,
  LAND_NAME,
  PARTEI_LABEL,
} from '@tcms/domain';
import { Icon } from '@/components/icon';
import { KlasseBadge, StatusBadge } from '@/components/ui/badges';
import type { EreignisView, KontrolleView, LandView, TcmsKontext } from '@/server/kontext';
import { personKurzname } from '@/server/kontext';
import type { LandFeststellung, LandRisiko, LandStandRoh } from '@/server/laender-daten';

export const REG_BADGE = {
  VOLLSTAENDIG: 'badge-green',
  FEHLT: 'badge-red',
  PRUEFEN: 'badge-yellow',
} as const;
export const REG_LABEL = {
  VOLLSTAENDIG: 'vollständig',
  FEHLT: 'fehlt',
  PRUEFEN: 'prüfen',
} as const;
const REG_LANG = {
  VOLLSTAENDIG: 'Registrierung vollständig',
  FEHLT: 'Registrierung fehlt',
  PRUEFEN: 'Steuersätze prüfen',
} as const;

export function LandDrawerKopf({ l, lagerArt }: { l: LandView; lagerArt: string | null }) {
  return (
    <>
      <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
        <span className="text-lg font-b text-primary">{l.land} — Registrierungen und Fristen</span>
        <span className={REG_BADGE[l.registrierung]}>{REG_LANG[l.registrierung]}</span>
      </div>
      <div className="text-xs text-muted mt-1">
        {LAND_NAME[l.land] ?? l.land}
        {l.lagerSeit
          ? ` · Lager seit ${fmtMonatJahr(l.lagerSeit)}${lagerArt ? ` (${lagerArt})` : ''}`
          : ' · kein Lager'}{' '}
        · {l.oss ? 'OSS aktiv' : 'kein OSS'} · Stand {fmtDatum(l.stand)}
      </div>
    </>
  );
}

function H({ children, rechts }: { children: ReactNode; rechts?: ReactNode }) {
  return (
    <div className="row-between mb-2">
      <h3 className="text-sm font-s">{children}</h3>
      {rechts}
    </div>
  );
}

function Diff({ alt, neu }: { alt: LandStandRoh; neu: LandStandRoh }) {
  const d: string[] = [];
  const ja = (b: boolean) => (b ? 'ja' : 'nein');
  if (alt.fernverkaeufeLfdEur !== neu.fernverkaeufeLfdEur)
    d.push(
      `Fernverkäufe ${fmtEurGanz(alt.fernverkaeufeLfdEur)} → ${fmtEurGanz(neu.fernverkaeufeLfdEur)}`,
    );
  if (alt.fernverkaeufeVorjahrEur !== neu.fernverkaeufeVorjahrEur)
    d.push(
      `Vorjahr ${fmtEurGanz(alt.fernverkaeufeVorjahrEur)} → ${fmtEurGanz(neu.fernverkaeufeVorjahrEur)}`,
    );
  if (alt.lagerSeit !== neu.lagerSeit)
    d.push(
      `Lager seit ${alt.lagerSeit ? fmtMonatJahr(alt.lagerSeit) : '–'} → ${neu.lagerSeit ? fmtMonatJahr(neu.lagerSeit) : '–'}`,
    );
  if (alt.oss !== neu.oss) d.push(`OSS ${ja(alt.oss)} → ${ja(neu.oss)}`);
  if (alt.lokaleUstNr !== neu.lokaleUstNr)
    d.push(`lokale USt-Nr. ${ja(alt.lokaleUstNr)} → ${ja(neu.lokaleUstNr)}`);
  if (alt.zmRelevant !== neu.zmRelevant)
    d.push(`ZM-relevant ${ja(alt.zmRelevant)} → ${ja(neu.zmRelevant)}`);
  if ((alt.steuersaetzeGeprueftAm?.getTime() ?? 0) !== (neu.steuersaetzeGeprueftAm?.getTime() ?? 0))
    d.push(
      `Steuersätze geprüft ${fmtDatum(alt.steuersaetzeGeprueftAm)} → ${fmtDatum(neu.steuersaetzeGeprueftAm)}`,
    );
  if (alt.registrierung !== neu.registrierung)
    d.push(`Status ${REG_LABEL[alt.registrierung]} → ${REG_LABEL[neu.registrierung]}`);
  if (!d.length) return <span className="text-11 text-muted">unverändert fortgeschrieben</span>;
  return (
    <span className="row-wrap" style={{ gap: 4 }}>
      {d.map((x) => (
        <span key={x} className="badge-gray" style={{ fontSize: 11 }}>
          {x}
        </span>
      ))}
    </span>
  );
}

export function LandDrawerInhalt({
  ctx,
  l,
  basis,
  mitStand,
  historie,
  feststellungen,
  ereignisse,
  risiken,
  kontrollen,
  formular,
}: {
  ctx: TcmsKontext;
  l: LandView;
  basis: string;
  mitStand: (href: string) => string;
  historie: LandStandRoh[];
  feststellungen: LandFeststellung[];
  ereignisse: EreignisView[];
  risiken: LandRisiko[];
  kontrollen: KontrolleView[];
  formular: ReactNode;
}) {
  const registriert = ctx.profil?.p9.lokaleUstNr.includes(l.land) ?? false;
  const offeneE = ereignisse.filter((e) => e.status === 'NEU' || e.status === 'IN_TRIAGE');
  const schritte: { text: string; zustand: 'done' | 'now' | '' }[] = l.lagerSeit
    ? [
        { text: `Lager seit ${fmtMonatJahr(l.lagerSeit)}`, zustand: 'done' },
        ...(feststellungen.length
          ? [{ text: `Feststellung ${feststellungen[0]!.nummer}`, zustand: 'done' as const }]
          : []),
        { text: 'lokale USt-Registrierung', zustand: l.lokaleUstNr ? 'done' : 'now' },
        {
          text: 'Steuersätze geprüft',
          zustand: l.steuersaetzeGeprueftAm ? 'done' : l.lokaleUstNr ? 'now' : '',
        },
      ]
    : [
        { text: l.oss ? 'über OSS erklärt' : 'kein OSS', zustand: l.oss ? 'done' : 'now' },
        { text: 'Steuersätze geprüft', zustand: l.steuersaetzeGeprueftAm ? 'done' : 'now' },
      ];

  return (
    <>
      <div className="mini-kpis mb-4">
        <div className="mini-kpi">
          <div className="v mono">{fmtEurGanz(l.fernverkaeufeLfdEur)}</div>
          <div className="l">Fernverkäufe lfd. Jahr</div>
        </div>
        <div className="mini-kpi">
          <div className="v mono">{fmtEurGanz(l.fernverkaeufeVorjahrEur)}</div>
          <div className="l">Vorjahr</div>
        </div>
        <div className="mini-kpi">
          <div className="v">{l.zmRelevant ? 'ja' : 'nein'}</div>
          <div className="l">ZM-relevante Bewegungen</div>
        </div>
      </div>

      <H rechts={<span className={REG_BADGE[l.registrierung]}>{REG_LABEL[l.registrierung]}</span>}>
        Registrierung
      </H>
      <div className="steps-mini mb-3" style={{ flexWrap: 'wrap', rowGap: 8 }}>
        {schritte.map((s, i) => (
          <span key={s.text} style={{ display: 'contents' }}>
            {i > 0 ? <span className="st-line" /> : null}
            <span className={`st ${s.zustand}`}>
              <span className="pt">
                {s.zustand === 'done' ? <Icon name="Check" className="tx-icon-xs" /> : i + 1}
              </span>
              {s.text}
            </span>
          </span>
        ))}
      </div>
      <div
        className="p-3 mb-4"
        style={{ border: '1px dashed rgb(var(--border-strong))', borderRadius: 10 }}
      >
        <div className="row-s" style={{ alignItems: 'flex-start', gap: 8 }}>
          <Icon name="FileText" className="tx-icon text-muted" />
          <span className="text-sm text-secondary">
            {l.lagerSeit && !l.lokaleUstNr
              ? `Keine lokale USt-Registrierung erfasst, obwohl seit ${fmtMonatJahr(l.lagerSeit)} ein Lager besteht (vgl. EC-UST-05).`
              : l.lokaleUstNr
                ? `Lokale USt-Nummer erfasst${registriert ? ' (Geschäftsprofil P9)' : ''}.`
                : `Keine lokale Registrierung erfasst; Umsätze ${l.oss ? 'laufen über den OSS' : 'ohne OSS-Kennzeichen'}.`}
          </span>
        </div>
        <div className="text-11 text-muted mt-1">
          Nachweise (z. B. Registrierungsbescheid) werden an der Durchführung des Lagerland-Monitors
          (K-EC-05) abgelegt. Geschäftsprofil P9: lokale USt-Nummern{' '}
          {ctx.profil?.p9.lokaleUstNr.length ? ctx.profil.p9.lokaleUstNr.join(', ') : 'keine'}
          {ctx.profil?.p9.ossSeit ? ` · OSS seit ${fmtMonatJahr(ctx.profil.p9.ossSeit)}` : ''}.
        </div>
      </div>

      {feststellungen.map((f) => (
        <div
          key={f.id}
          className="alert-warning mb-4"
          style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}
        >
          <Icon name="Flame" className="tx-icon-lg" />
          <p>
            Feststellung{' '}
            <Link
              href={mitStand(`${basis}/feststellungen/${f.id}`)}
              className="font-s"
              style={{ textDecoration: 'underline' }}
            >
              {f.nummer}&nbsp;→
            </Link>
            <br />
            <span className="text-xs">
              „{f.titel}“ ·{' '}
              {FESTSTELLUNG_STATUS_LABEL[f.status as keyof typeof FESTSTELLUNG_STATUS_LABEL] ??
                f.status}
              {f.p153Offen ? ' · §-153-Würdigung offen' : ''}
            </span>
          </p>
        </div>
      ))}

      <H rechts={<span className="text-11 text-muted">aus den Merkmalen des Landes</span>}>
        Länderbezogene Risiken
      </H>
      {risiken.length ? (
        <div className="card mb-4" style={{ boxShadow: 'none' }}>
          {risiken.map(({ risiko: r, grund }) => (
            <Link
              key={r.id}
              href={mitStand(`${basis}/risiken?risiko=${r.id}`)}
              className="list-row"
              style={{ textDecoration: 'none' }}
            >
              <span className="badge-gray mono shrink0">{r.code}</span>
              <div className="grow">
                <div className="text-sm font-m text-primary">{r.titel}</div>
                <div className="text-11 text-muted mt-1">weil {grund}</div>
              </div>
              <span className="row-s shrink0" title="Netto (maßgeblich für den Appetit)">
                <KlasseBadge klasse={r.netto} />
                {r.ueberAppetit ? (
                  <span style={{ color: '#b42318', display: 'inline-flex' }}>
                    <Icon
                      name="TriangleAlert"
                      className="tx-icon-xs"
                      title="über dem Risikoappetit"
                    />
                  </span>
                ) : null}
              </span>
            </Link>
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted mb-4">Keine länderbezogenen Risiken im Inventar.</p>
      )}

      <H rechts={<span className="text-11 text-muted">{kontrollen.length}</span>}>
        Zugehörige Kontrollen
      </H>
      {kontrollen.length ? (
        <div className="card mb-4" style={{ boxShadow: 'none' }}>
          {kontrollen.map((k) => {
            const d = k.naechste ?? k.letzte;
            return (
              <Link
                key={k.id}
                href={mitStand(d ? `${basis}/durchfuehrungen/${d.id}` : `${basis}/kontrollen`)}
                className="list-row"
                style={{ textDecoration: 'none' }}
              >
                <span className="badge-gray mono shrink0">{k.code}</span>
                <div className="grow">
                  <div className="text-sm font-m text-primary">
                    {k.titel}
                    {k.schluessel ? (
                      <span className="badge-brand" style={{ marginLeft: 6 }}>
                        <Icon name="KeyRound" className="tx-icon-xs" /> Schlüssel
                      </span>
                    ) : null}
                  </div>
                  <div className="text-11 text-muted mt-1">
                    {frequenzLabel(k.frequenz)} · {PARTEI_LABEL[k.partei]} ·{' '}
                    {personKurzname(ctx, k.durchfuehrendId)}
                    {d ? ` · ${d.periodeLabel}` : ''}
                  </div>
                </div>
                {d ? (
                  <StatusBadge status={d.anzeige} />
                ) : (
                  <span className="badge-gray">keine Durchführung</span>
                )}
              </Link>
            );
          })}
        </div>
      ) : (
        <p className="text-sm text-muted mb-4">Keine Kontrollen zugeordnet.</p>
      )}

      <H>Fristen im Land</H>
      <div className="card mb-4" style={{ boxShadow: 'none' }}>
        <div className="list-row">
          <span
            className={`status-dot ${l.oss ? 'dot-green' : 'dot-gray'}`}
            style={{ marginTop: 7 }}
          />
          <div className="grow">
            <div className="row-between" style={{ alignItems: 'flex-start' }}>
              <span className="text-sm font-m">OSS-Erklärung</span>
              <span className={`${l.oss ? 'badge-green' : 'badge-gray'} shrink0`}>
                {l.oss ? 'über OSS' : 'kein OSS'}
              </span>
            </div>
            <div className="text-11 text-muted mt-1">
              Abstimmung vor Abgabe K-EC-04, Fristenkontrolle K-EC-13
            </div>
          </div>
        </div>
        {l.zmRelevant ? (
          <div className="list-row">
            <span className="status-dot dot-amber" style={{ marginTop: 7 }} />
            <div className="grow">
              <div className="row-between" style={{ alignItems: 'flex-start' }}>
                <span className="text-sm font-m">Zusammenfassende Meldung</span>
                <span className="badge-yellow shrink0">ZM-relevant</span>
              </div>
              <div className="text-11 text-muted mt-1">Verbringens- und ZM-Abstimmung K-EC-06</div>
            </div>
          </div>
        ) : null}
        <div className="list-row">
          <span
            className={`status-dot ${l.lokaleUstNr ? 'dot-green' : l.lagerSeit ? 'dot-red' : 'dot-gray'}`}
            style={{ marginTop: 7 }}
          />
          <div className="grow">
            <div className="row-between" style={{ alignItems: 'flex-start' }}>
              <span className="text-sm font-m">Lokale Umsatzsteuererklärungen</span>
              <span
                className={`${l.lokaleUstNr ? 'badge-green' : l.lagerSeit ? 'badge-red' : 'badge-gray'} shrink0`}
              >
                {l.lokaleUstNr
                  ? 'registriert'
                  : l.lagerSeit
                    ? 'wartet auf Registrierung'
                    : 'keine Registrierung erfasst'}
              </span>
            </div>
            <div className="text-11 text-muted mt-1">
              Termine führt das Fristenkontrollbuch (K-EC-13); Anbindung der Steuertermine folgt.
            </div>
          </div>
        </div>
      </div>

      {offeneE.length || ereignisse.length ? (
        <>
          <H rechts={<span className="text-11 text-muted">{offeneE.length} offen</span>}>
            Ereignisse
          </H>
          <div className="card mb-4" style={{ boxShadow: 'none' }}>
            {ereignisse.slice(0, 5).map((e) => (
              <Link
                key={e.id}
                href={mitStand(`${basis}/ereignisse?e=${e.id}`)}
                className="list-row"
                style={{ textDecoration: 'none' }}
              >
                <span className="badge-gray mono shrink0">{e.typ}</span>
                <div className="grow">
                  <div className="text-sm font-m text-primary">{e.titel}</div>
                  <div className="text-11 text-muted mt-1">
                    {e.nummer} · {fmtDatum(e.gemeldetAm)}
                  </div>
                </div>
                <span className={EREIGNIS_STATUS_BADGE[e.status]}>
                  {EREIGNIS_STATUS_LABEL[e.status]}
                </span>
              </Link>
            ))}
          </div>
        </>
      ) : null}

      <H rechts={<span className="text-11 text-muted">{historie.length} Stände</span>}>Historie</H>
      <div className="col-s mb-4" style={{ gap: 10 }}>
        {historie.map((s, i) => {
          const vorher = historie[i + 1];
          return (
            <div
              key={s.id}
              className="text-xs text-secondary"
              style={{
                borderLeft: `2px solid ${i === 0 ? 'rgb(var(--brand-500))' : 'rgb(var(--border-default))'}`,
                paddingLeft: 10,
              }}
            >
              <div className="row-between">
                <span>
                  <span className="mono font-s">{fmtDatum(s.stand)}</span> ·{' '}
                  {personKurzname(ctx, s.erfasstVon)} ·{' '}
                  {s.quelle === 'CSV' ? 'CSV-Import' : 'manuell'}
                  {i === 0 ? (
                    <span className="badge-brand" style={{ marginLeft: 6, fontSize: 11 }}>
                      maßgeblich
                    </span>
                  ) : null}
                </span>
                <span className="text-11 text-muted">erfasst {fmtDatumZeit(s.createdAt)}</span>
              </div>
              <div className="mt-1">
                {vorher ? (
                  <Diff alt={vorher} neu={s} />
                ) : (
                  <span className="text-11 text-muted">
                    Erster Stand: {fmtEurGanz(s.fernverkaeufeLfdEur)} lfd. · Vorjahr{' '}
                    {fmtEurGanz(s.fernverkaeufeVorjahrEur)} · Lager{' '}
                    {s.lagerSeit ? fmtMonatJahr(s.lagerSeit) : '–'} · {REG_LABEL[s.registrierung]}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <H>Neuen Stand erfassen</H>
      {formular}
    </>
  );
}
