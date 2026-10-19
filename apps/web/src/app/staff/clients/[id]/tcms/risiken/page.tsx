import Link from 'next/link';
import {
  fmtDatum,
  KLASSE_BADGE,
  KLASSE_LABEL,
  KLASSE_RANG,
  GOVERNANCE_ERKLAERUNG,
  type Klasse,
} from '@tcms/domain';
import { Icon } from '@/components/icon';
import { GtBadge, KlasseBadge } from '@/components/ui/badges';
import { AktionsForm, SubmitButton, ToggleGroupLink } from '@/components/ui/client';
import { RiskHeatmap } from '@/components/ui/heatmap';
import { Leerzustand } from '@/components/ui/leer';
import { TcmsKopf } from '@/components/tcms/kopf';
import { RisikoDrawer } from '@/components/risiken/drawer';
import { RisikoFilter, type FilterWerte } from '@/components/risiken/filter';
import {
  AKZEPTANZ_STATUS_LABEL,
  RISIKO_FREIGABE_BADGE,
  RISIKO_FREIGABE_LABEL,
  kurzName,
} from '@/components/risiken/labels';
import { mitParams, param } from '@/components/risiken/url';
import { risikenFreigabeSchritt } from '@/server/actions/risiken';
import { KEIN_RECHT } from '@/server/aktion';
import { personName, type RisikoView } from '@/server/kontext';
import { zweitePerson } from '@/server/rechte';
import { ladeAkzeptanzen, ladeNeuBewertenHinweise, ladeRisikoDetail } from '@/server/risiken-daten';
import { ladeStaffSeite, NUR_AKTUELL } from '@/server/seite';

export const metadata = { title: 'Risikoinventar' };

const P = { padding: '10px 8px' } as const;
const KLASSEN: Klasse[] = ['KRITISCH', 'HOCH', 'MITTEL', 'GERING'];

function NettoZelle({
  r,
  sicht,
  notiz,
}: {
  r: RisikoView;
  sicht: 'DESIGN' | 'BETRIEB';
  notiz?: string | null;
}) {
  const b = r.bewertung;
  const wirksam = sicht === 'DESIGN' ? b.wirksamDesign : b.wirksamBetrieb;
  const berechnet = sicht === 'DESIGN' ? b.nettoDesign : b.nettoBetrieb;
  const uebersteuert = sicht === 'DESIGN' ? b.uebersteuertDesign : b.uebersteuertBetrieb;
  const u = r.uebersteuerungen.find((x) => x.sicht === sicht && x.status === 'FREIGEGEBEN');
  const beantragt = r.uebersteuerungen.some((x) => x.sicht === sicht && x.status === 'BEANTRAGT');
  return (
    <div className="col-s" style={{ gap: 3 }}>
      <span className="row-s" style={{ flexWrap: 'wrap' }}>
        <KlasseBadge klasse={wirksam} title={berechnet.erklaerung} />
        {uebersteuert ? (
          <span
            className="badge-yellow"
            title={`berechnet: ${KLASSE_LABEL[berechnet.klasse]}${u ? ` · freigegeben ${fmtDatum(u.entschiedenAm)} · „${u.begruendung}"` : ''}`}
          >
            <Icon name="Pencil" className="tx-icon-xs" /> übersteuert
          </span>
        ) : null}
        {beantragt ? (
          <span className="badge-purple" title="Übersteuerung beantragt – wartet auf zweite Person">
            beantragt
          </span>
        ) : null}
      </span>
      {uebersteuert ? (
        <span className="text-11 text-muted">berechnet: {KLASSE_LABEL[berechnet.klasse]}</span>
      ) : null}
      {notiz ? (
        <span className="text-11" style={{ color: '#b42318' }}>
          {notiz}
        </span>
      ) : null}
    </div>
  );
}

export default async function Risikoinventar({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const seite = await ladeStaffSeite(id, sp);
  const { ctx, basis, mitStand, nutzer } = seite;
  const pfad = `${basis}/risiken`;

  if (!ctx.programm) {
    return (
      <div className="card">
        <Leerzustand
          icon="ShieldCheck"
          text="Für diesen Mandanten ist noch kein Tax-CMS eingerichtet."
        >
          {seite.darfBearbeiten ? (
            <Link className="btn-primary" href={`${basis}/setup`}>
              <Icon name="Plus" /> Tax-CMS einrichten
            </Link>
          ) : null}
        </Leerzustand>
      </div>
    );
  }

  const sperre = ctx.historisch ? NUR_AKTUELL : seite.darfBearbeiten ? null : KEIN_RECHT;
  const [hinweise, akzeptanzen] = await Promise.all([
    ladeNeuBewertenHinweise(ctx),
    ladeAkzeptanzen(ctx),
  ]);
  const betriebAktiv =
    !!ctx.programm.wirksamAb && ctx.programm.wirksamAb.getTime() <= ctx.stand.getTime();
  const kontrolleJe = new Map(ctx.kontrollen.map((k) => [k.id, k]));

  const werte: FilterWerte = {
    gruppe: param(sp, 'gruppe'),
    gt: param(sp, 'gt'),
    klasse: param(sp, 'klasse'),
    appetit: param(sp, 'appetit') === '1',
    uebersteuert: param(sp, 'uebersteuert') === '1',
    kern: param(sp, 'kern') === '1',
    neu: param(sp, 'neu') === '1',
    s: param(sp, 's'),
    w: param(sp, 'w'),
  };
  const gefiltert = ctx.risiken
    .filter((r) => !werte.gruppe || r.gruppe === werte.gruppe)
    .filter((r) => !werte.gt || r.gt === werte.gt)
    .filter((r) => !werte.klasse || r.bewertung.brutto.klasse === werte.klasse)
    .filter((r) => !werte.appetit || r.ueberAppetit)
    .filter(
      (r) =>
        !werte.uebersteuert ||
        r.bewertung.uebersteuertDesign ||
        r.bewertung.uebersteuertBetrieb ||
        r.uebersteuerungen.some((u) => u.status === 'BEANTRAGT'),
    )
    .filter((r) => !werte.kern || r.kern)
    .filter((r) => !werte.neu || (hinweise.get(r.id)?.length ?? 0) > 0)
    .filter((r) => !(werte.s && werte.w) || (r.s === werte.s && r.w === werte.w))
    .sort(
      (a, b) =>
        Number(b.ueberAppetit) - Number(a.ueberAppetit) ||
        KLASSE_RANG[b.bewertung.brutto.klasse] - KLASSE_RANG[a.bewertung.brutto.klasse] ||
        KLASSE_RANG[b.bewertung.wirksamBetrieb] - KLASSE_RANG[a.bewertung.wirksamBetrieb] ||
        a.code.localeCompare(b.code),
    );

  const ansicht = param(sp, 'ansicht') === 'heatmap' ? 'heatmap' : 'liste';
  const risikoParam = param(sp, 'risiko');
  const auswahl = ctx.risiken.find((r) => r.id === risikoParam || r.code === risikoParam) ?? null;
  const detail = auswahl ? await ladeRisikoDetail(auswahl, ctx.stand) : null;
  const link = (aenderung: Record<string, string | null>) => mitParams(pfad, sp, aenderung);

  const ueberAppetit = ctx.risiken.filter((r) => r.ueberAppetit).length;
  const anzahlNeu = ctx.risiken.filter((r) => (hinweise.get(r.id)?.length ?? 0) > 0).length;
  const offeneVorschlaege = ctx.vorschlaege.filter(
    (v) => v.entscheidung === 'VORGESCHLAGEN',
  ).length;
  const waehlbar = (r: RisikoView) =>
    !sperre &&
    (r.freigabe === 'BEWERTET' ||
      (r.freigabe === 'ZUR_FREIGABE' && zweitePerson(nutzer, r.freigabeEingereichtVon)));
  const mitAuswahl = !sperre && gefiltert.some(waehlbar);
  const bruttoZaehler = Object.fromEntries(
    KLASSEN.map((k) => [k, gefiltert.filter((r) => r.bewertung.brutto.klasse === k).length]),
  ) as Record<Klasse, number>;

  const tabelle = (
    <table className="tbl">
      <thead>
        <tr>
          {mitAuswahl ? (
            <th style={P}>
              <span className="sr-only">Auswahl</span>
            </th>
          ) : null}
          <th style={P}>ID</th>
          <th style={P}>Risiko</th>
          <th style={P}>Gruppe</th>
          <th style={P} title="Governance-Typ">
            GT
          </th>
          <th style={P}>Brutto</th>
          <th style={P} title="Zugeordnete Kontrollen (Schlüssel-Icon: davon Schlüsselkontrollen)">
            Kontr.
          </th>
          <th style={P}>Netto Design</th>
          <th style={P}>Netto Betrieb</th>
          <th
            style={P}
            title={`Netto ${betriebAktiv ? 'Betrieb' : 'Design'} über Risikoappetit (${KLASSE_LABEL[ctx.appetit]})`}
          >
            <span className="row-s" aria-label="über Appetit">
              <Icon name="Flag" className="tx-icon-xs" />
            </span>
          </th>
          <th style={P} title="Verantwortlich">
            Verantw.
          </th>
          <th style={P}>Status</th>
          <th style={P} className="td-num" title="Offene Ereignisfolgen mit Bezug auf das Risiko">
            Ereign.
          </th>
        </tr>
      </thead>
      <tbody>
        {gefiltert.map((r) => {
          const b = r.bewertung;
          const ks = r.kontrollIds.map((kid) => kontrolleJe.get(kid)).filter((k) => !!k);
          const schluessel = ks.filter((k) => k.schluessel).length;
          const ausfall =
            KLASSE_RANG[b.nettoBetrieb.klasse] > KLASSE_RANG[b.nettoDesign.klasse]
              ? ks
                  .filter(
                    (k) =>
                      k.design === 'ANGEMESSEN' &&
                      (k.betrieb === 'UEBERFAELLIG' || k.betrieb === 'MIT_BEFUND'),
                  )
                  .map(
                    (k) =>
                      `${k.code} ${k.betrieb === 'UEBERFAELLIG' ? 'überfällig' : 'mit Befund'}`,
                  )
              : [];
          const h = hinweise.get(r.id) ?? [];
          const ak = akzeptanzen.get(r.id)?.[0];
          const href = link({ risiko: r.id });
          return (
            <tr key={r.id} className={`row-link${auswahl?.id === r.id ? ' sel' : ''}`}>
              {mitAuswahl ? (
                <td style={P}>
                  <input
                    type="checkbox"
                    className="checkbox"
                    name="ids"
                    value={r.id}
                    disabled={!waehlbar(r)}
                    aria-label={`${r.code} auswählen`}
                    title={
                      waehlbar(r)
                        ? undefined
                        : r.freigabe === 'ZUR_FREIGABE'
                          ? 'Von dir eingereicht – Freigabe durch eine zweite Person'
                          : `Status ${RISIKO_FREIGABE_LABEL[r.freigabe]}`
                    }
                  />
                </td>
              ) : null}
              <td style={{ ...P, whiteSpace: 'nowrap' }}>
                <Link
                  href={href}
                  className="mono text-xs"
                  scroll={false}
                  style={{ textDecoration: 'none', color: 'inherit' }}
                >
                  {r.code}
                </Link>
              </td>
              <td style={{ ...P, minWidth: 180 }} className="wrap-cell">
                <Link
                  href={href}
                  scroll={false}
                  className="text-sm font-m"
                  style={{ textDecoration: 'none', color: 'inherit' }}
                >
                  {r.titel}
                </Link>
                {r.kern ? <span className="text-11 text-muted"> · Kern</span> : null}
              </td>
              <td style={P}>
                <span className="badge-gray" title={r.gruppeLabel}>
                  {r.gruppe}
                </span>
              </td>
              <td style={P}>
                <GtBadge gt={r.gt} />
              </td>
              <td style={P}>
                <KlasseBadge klasse={b.brutto.klasse} title={b.brutto.erklaerung} />
              </td>
              <td style={P}>
                {ks.length ? (
                  <span
                    className="row-s"
                    title={`${ks.length} ${ks.length === 1 ? 'Kontrolle' : 'Kontrollen'}${schluessel ? `, davon ${schluessel} Schlüsselkontrolle` : ''}: ${ks.map((k) => k.code).join(', ')}`}
                  >
                    <span className="mono">{ks.length}</span>
                    {schluessel ? <Icon name="KeyRound" className="tx-icon-xs" /> : null}
                  </span>
                ) : (
                  <span className="badge-red" title="Keine Kontrolle zugeordnet">
                    0
                  </span>
                )}
              </td>
              <td style={P}>
                <NettoZelle r={r} sicht="DESIGN" />
              </td>
              <td style={P}>
                <div style={{ maxWidth: 150 }}>
                  <NettoZelle
                    r={r}
                    sicht="BETRIEB"
                    notiz={ausfall.length ? `Klasse erhöht: ${ausfall.join(', ')}` : null}
                  />
                </div>
              </td>
              <td style={P}>
                {r.ueberAppetit ? (
                  <span
                    className="row-s"
                    title={`Netto ${betriebAktiv ? 'Betrieb' : 'Design'} ${KLASSE_LABEL[r.netto]} über Risikoappetit ${KLASSE_LABEL[ctx.appetit]}${ak ? ` · ${AKZEPTANZ_STATUS_LABEL[ak.status]}` : ''}`}
                  >
                    <span style={{ color: '#b42318', display: 'inline-flex' }}>
                      <Icon name="Flag" className="tx-icon-xs" />
                    </span>
                    {ak ? (
                      <span
                        className={`text-11 ${ak.status === 'FREIGEGEBEN' ? '' : 'text-muted'}`}
                      >
                        {ak.status === 'OFFEN'
                          ? 'Akz. offen'
                          : ak.status === 'FREIGEGEBEN'
                            ? 'akzeptiert'
                            : 'abgelehnt'}
                      </span>
                    ) : null}
                  </span>
                ) : (
                  <span className="text-disabled">·</span>
                )}
              </td>
              <td style={{ ...P, whiteSpace: 'nowrap' }} className="text-sm">
                <span title={personName(ctx, r.ownerId)}>
                  {kurzName(personName(ctx, r.ownerId))}
                </span>
              </td>
              <td style={{ ...P, whiteSpace: 'nowrap' }}>
                <div className="col-s" style={{ gap: 3, alignItems: 'flex-start' }}>
                  <span className={RISIKO_FREIGABE_BADGE[r.freigabe]}>
                    {RISIKO_FREIGABE_LABEL[r.freigabe]}
                  </span>
                  {h.length ? (
                    <span className="badge-yellow" title={h.map((x) => x.text).join('\n')}>
                      <Icon name="RefreshCw" className="tx-icon-xs" /> neu bewerten
                    </span>
                  ) : null}
                </div>
              </td>
              <td style={P} className="td-num">
                {r.offeneEreignisse ? (
                  <span className="mono">{r.offeneEreignisse}</span>
                ) : (
                  <span className="text-disabled">·</span>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );

  const fuss = (
    <div className="card-footer" style={{ flexWrap: 'wrap', gap: 8 }}>
      <span>
        {ctx.risiken.length} aktive Risiken · {ueberAppetit} über Appetit (Netto{' '}
        {betriebAktiv ? 'Betrieb' : 'Design'})
        {gefiltert.length !== ctx.risiken.length ? ` · ${gefiltert.length} angezeigt` : ''}
      </span>
      {mitAuswahl ? (
        <span className="row-s">
          <span className="text-xs text-muted">Auswahl:</span>
          <SubmitButton className="btn-secondary btn-tiny" name="aktion" value="einreichen">
            <Icon name="Send" className="tx-icon-xs" /> Zur Freigabe einreichen
          </SubmitButton>
          <SubmitButton className="btn-primary btn-tiny" name="aktion" value="freigeben">
            <Icon name="CheckCheck" className="tx-icon-xs" /> Freigeben (zweite Person)
          </SubmitButton>
        </span>
      ) : (
        <span>
          Modell {ctx.risiken[0]?.bewertung.modell ?? '—'} · Risikoappetit{' '}
          {KLASSE_LABEL[ctx.appetit]}
        </span>
      )}
    </div>
  );

  return (
    <>
      <TcmsKopf seite={seite} />

      <div className="row-between mb-4" style={{ flexWrap: 'wrap', gap: 12 }}>
        <div className="row-lg">
          <h2 className="text-xl font-b text-primary">Risikoinventar</h2>
          <span className="badge-gray">{ctx.risiken.length} aktiv</span>
          {anzahlNeu ? (
            <Link
              href={link({ neu: '1', risiko: null, ansicht: null })}
              className="badge-yellow"
              style={{ textDecoration: 'none' }}
              title="Ereignis oder Profiländerung nach der letzten Bewertung"
            >
              {anzahlNeu} neu bewerten
            </Link>
          ) : null}
        </div>
        <div className="row-lg">
          <ToggleGroupLink
            param="ansicht"
            label="Ansicht"
            aktiv={ansicht}
            optionen={[
              ['liste', 'Liste'],
              ['heatmap', 'Heatmap'],
            ]}
          />
          {sperre ? (
            <button type="button" className="btn-primary" disabled title={sperre}>
              <Icon name="Plus" className="tx-icon-xs" /> Risiko hinzufügen
            </button>
          ) : (
            <Link
              href={`${basis}/profil#vorschlaege`}
              className="btn-primary"
              title="Risiken entstehen aus dem Katalogvorschlag des Geschäftsprofils oder als eigenes Risiko (Herkunft Berater)"
            >
              <Icon name="Plus" className="tx-icon-xs" /> Risiko hinzufügen
              {offeneVorschlaege ? (
                <span className="badge-yellow" style={{ marginLeft: 4 }}>
                  {offeneVorschlaege}
                </span>
              ) : null}
            </Link>
          )}
        </div>
      </div>

      <RisikoFilter werte={werte} anzahlNeu={anzahlNeu} />

      {ansicht === 'liste' ? (
        <div className="card" style={{ overflow: 'hidden' }}>
          {gefiltert.length === 0 ? (
            <Leerzustand icon="Search" text="Keine Risiken für diese Filter.">
              <Link href={mitStand(pfad)} className="btn-secondary">
                Filter zurücksetzen
              </Link>
            </Leerzustand>
          ) : mitAuswahl ? (
            <AktionsForm action={risikenFreigabeSchritt}>
              <input type="hidden" name="stand" value={seite.standIso} />
              <div className="tbl-scroll">{tabelle}</div>
              {fuss}
            </AktionsForm>
          ) : (
            <>
              <div className="tbl-scroll">{tabelle}</div>
              {fuss}
            </>
          )}
        </div>
      ) : (
        <div className="card">
          <div className="card-header" style={{ flexWrap: 'wrap', gap: 8 }}>
            <span className="card-title">Risiken — Bruttobewertung (S × W)</span>
            <div className="row-lg">
              {KLASSEN.map((k) => (
                <span
                  key={k}
                  className={KLASSE_BADGE[k]}
                  title={`${bruttoZaehler[k]} Risiken mit Bruttoklasse ${KLASSE_LABEL[k]}`}
                >
                  {bruttoZaehler[k]} {KLASSE_LABEL[k]}
                </span>
              ))}
            </div>
          </div>
          <div className="p-4">
            <RiskHeatmap
              gross
              basis={pfad}
              risiken={gefiltert.map((r) => ({
                code: r.code,
                titel: r.titel,
                s: r.s,
                w: r.w,
                brutto: r.bewertung.brutto.klasse,
                design: r.bewertung.wirksamDesign,
                betrieb: r.bewertung.wirksamBetrieb,
              }))}
            />
          </div>
          <div className="card-footer">
            <span>
              {gefiltert.length} von {ctx.risiken.length} Risiken · Governance-Typ steuert die
              Kontrollhäufigkeit, nicht die Klasse
            </span>
            <span title={GOVERNANCE_ERKLAERUNG.FF}>
              Zelle anklicken öffnet die gefilterte Liste
            </span>
          </div>
        </div>
      )}

      <p className="text-11 text-muted mt-4">
        Klassen werden berechnet (Modell {ctx.risiken[0]?.bewertung.modell ?? 'ec-1.0'}), nie
        gespeichert-überschrieben; übersteuerte Werte tragen ein Badge, der berechnete Wert bleibt
        sichtbar. Normanker und Startwerte sind ungeprüfte Entwürfe. Statusangaben sind
        Betriebsinformationen.
      </p>

      {auswahl ? (
        <RisikoDrawer
          seite={seite}
          risiko={auswahl}
          detail={detail}
          hinweise={hinweise.get(auswahl.id) ?? []}
          akzeptanzen={akzeptanzen.get(auswahl.id) ?? []}
          sperre={sperre}
          link={link}
        />
      ) : null}
    </>
  );
}
