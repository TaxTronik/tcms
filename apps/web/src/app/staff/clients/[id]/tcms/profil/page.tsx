import Link from 'next/link';
import type { ReactNode } from 'react';
import {
  addTage,
  brutto,
  fmtDatum,
  fmtDatumZeit,
  fmtEurGanz,
  isoDatum,
  katalogRisiko,
  KLASSE_LABEL,
  schlageRisikenVor,
  type RisikoVorschlag,
} from '@tcms/domain';
import { Icon } from '@/components/icon';
import { GtBadge, KlasseBadge } from '@/components/ui/badges';
import { Leerzustand } from '@/components/ui/leer';
import { TcmsKopf } from '@/components/tcms/kopf';
import { ProfilAenderung, RisikoAufnehmen } from '@/components/profil/profil-aktionen';
import { ProfilAnzeige, ProfilDiffListe } from '@/components/profil/profil-anzeige';
import type { PersonInfo } from '@/components/profil/profil-formular';
import { profilDiff } from '@/components/profil/profil-logik';
import { leseEntwurf } from '@/components/setup/entwurf';
import { aendereProfil, nimmVorgeschlagenesRisikoAuf } from '@/server/actions/profil';
import { KEIN_RECHT } from '@/server/aktion';
import { personKurzname } from '@/server/kontext';
import { ladeStaffSeite, NUR_AKTUELL } from '@/server/seite';
import { ladeProfilDaten, type ProfilStandView } from '@/server/profil-daten';
import { ladeSetupProgramm } from '@/server/setup-daten';
import { tagesende } from '@/server/zeit';

export const metadata = { title: 'Geschäftsprofil' };

const ROLLE: Record<string, string> = {
  GESETZLICHER_VERTRETER: 'Gesetzliche Vertretung',
  TAX_COMPLIANCE_BEAUFTRAGTER: 'Tax-Compliance-Beauftragte:r',
};

function Abschnitt({
  titel,
  anzahl,
  ton = 'badge-gray',
  children,
  hinweis,
}: {
  titel: string;
  anzahl: number;
  ton?: string;
  children: ReactNode;
  hinweis?: string;
}) {
  return (
    <div style={{ borderTop: '1px solid rgb(var(--border-default))' }}>
      <div className="row-between" style={{ padding: '12px 24px 4px' }}>
        <span className="text-sm font-s">{titel}</span>
        <span className={ton}>{anzahl}</span>
      </div>
      {hinweis ? (
        <p className="hint" style={{ padding: '0 24px 4px' }}>
          {hinweis}
        </p>
      ) : null}
      <div>{children}</div>
    </div>
  );
}

function VorschlagKopf({ v }: { v: RisikoVorschlag }) {
  const kat = katalogRisiko(v.code);
  const b = kat ? brutto(kat.s, kat.w, kat.r) : null;
  return (
    <div className="grow">
      <div className="text-sm font-m">
        {v.code} · {kat?.titel ?? v.code}
      </div>
      <div className="row-wrap mt-1" style={{ gap: 6 }}>
        <span className="badge-brand" title={`Profilantwort ${v.frage}`}>
          {v.grund}
        </span>
        {kat ? <GtBadge gt={kat.gt} /> : null}
        {b ? <KlasseBadge klasse={b.klasse} title={`Brutto-Startwert: ${b.erklaerung}`} /> : null}
      </div>
    </div>
  );
}

export default async function ProfilSeite({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const seite = await ladeStaffSeite(id, sp);
  const { ctx, basis, mitStand } = seite;
  const darf = seite.darfBearbeiten;
  const sperrGrund = ctx.historisch ? NUR_AKTUELL : KEIN_RECHT;

  // ---- Noch kein Programm / Einrichtung läuft ----
  if (!ctx.programm) {
    return (
      <>
        <TcmsKopf seite={seite} />
        <div className="card">
          <Leerzustand
            icon="FileText"
            text="Für diesen Mandanten ist noch kein Tax-CMS eingerichtet; das Geschäftsprofil entsteht im Einrichtungsassistenten."
          >
            {darf ? (
              <Link className="btn-primary" href={`${basis}/setup`}>
                <Icon name="Plus" /> Tax-CMS einrichten
              </Link>
            ) : (
              <button type="button" className="btn-primary" disabled title={sperrGrund}>
                <Icon name="Plus" /> Tax-CMS einrichten
              </button>
            )}
          </Leerzustand>
        </div>
      </>
    );
  }
  if (!ctx.programm.version1Am) {
    const prog = await ladeSetupProgramm(id);
    const e = leseEntwurf(prog?.setupEntwurf, ctx.heute, null);
    return (
      <>
        <TcmsKopf seite={seite} />
        <div className="card">
          <Leerzustand
            icon="Pencil"
            text={`Die Einrichtung läuft: Entwurf mit ${e.abgeschlossen} von 5 abgeschlossenen Schritten${
              e.gespeichertAm
                ? `, zuletzt gespeichert am ${fmtDatumZeit(new Date(e.gespeichertAm))}${e.gespeichertVon ? ` von ${e.gespeichertVon}` : ''}`
                : ''
            }. Teilbereich, Geschäftsprofil und Ziele werden bis zur Anlage von Version 1 im Einrichtungsassistenten gepflegt.`}
          >
            {darf ? (
              <Link className="btn-primary" href={`${basis}/setup`}>
                <Icon name="ChevronRight" /> Einrichtung fortsetzen
              </Link>
            ) : (
              <button type="button" className="btn-primary" disabled title={sperrGrund}>
                Einrichtung fortsetzen
              </button>
            )}
          </Leerzustand>
        </div>
      </>
    );
  }

  // ---- Stände ----
  const { staende, risiken } = await ladeProfilDaten(ctx);
  const ende = tagesende(ctx.stand);
  const gueltigAm = (s: ProfilStandView) =>
    s.gueltigAb.getTime() <= ende.getTime() &&
    (s.gueltigBis == null || s.gueltigBis.getTime() > ende.getTime());
  const angezeigt = [...staende].reverse().find(gueltigAm) ?? null;
  const juengster =
    [...staende].reverse().find((s) => s.gueltigBis == null) ?? staende.at(-1) ?? null;
  const vorgaenger = (s: ProfilStandView) => staende[staende.indexOf(s) - 1] ?? null;
  const diffAngezeigt =
    angezeigt && vorgaenger(angezeigt)
      ? profilDiff(vorgaenger(angezeigt)!.antworten, angezeigt.antworten)
      : [];
  const aendern = sp['aendern'] === '1' && darf && juengster != null;

  // ---- Abgleich Profilvorschlag ↔ Inventar ----
  const basisStand = ctx.historisch ? angezeigt : juengster;
  const vorschlaege = basisStand ? schlageRisikenVor(basisStand.antworten) : [];
  const zeileJe = new Map(risiken.map((r) => [r.code, r]));
  const neu = vorschlaege.filter((v) => {
    const r = zeileJe.get(v.code);
    return (
      !r ||
      r.entscheidung === 'VORGESCHLAGEN' ||
      (ctx.historisch && r.createdAt.getTime() > ende.getTime())
    );
  });
  const abgelehnt = vorschlaege.filter(
    (v) => zeileJe.get(v.code)?.entscheidung === 'ABGELEHNT' && !neu.includes(v),
  );
  const deaktiviert = vorschlaege.filter((v) => {
    const r = zeileJe.get(v.code);
    return (
      r?.entscheidung === 'UEBERNOMMEN' &&
      r.inaktivAb != null &&
      r.inaktivAb.getTime() <= ende.getTime()
    );
  });
  const vorgeschlagen = new Set(vorschlaege.map((v) => v.code));
  const nichtMehr = ctx.risiken.filter((r) => !r.kern && !vorgeschlagen.has(r.code));
  const deckungsgleich = vorschlaege.filter((v) =>
    ctx.risiken.some((r) => r.code === v.code),
  ).length;
  // Markierung ist ein aktueller Zustand (nicht versioniert) – im historischen Stand ausgeblendet.
  const neuBewerten = ctx.historisch ? [] : ctx.risiken.filter((r) => r.neuBewerten);

  const personen: PersonInfo[] = ctx.mandantPersonen
    .filter(
      (p) =>
        p.mandantRolle === 'GESETZLICHER_VERTRETER' ||
        p.mandantRolle === 'TAX_COMPLIANCE_BEAUFTRAGTER',
    )
    .map((p) => ({
      id: p.id,
      name: p.name,
      funktion: p.funktion,
      rolle: ROLLE[p.mandantRolle ?? ''] ?? 'Mandant',
    }));

  /** Im Voraus erfasster Stand (Anlage vor dem Gültigkeitsbeginn). */
  const vorab = (s: ProfilStandView) => isoDatum(s.createdAt) < isoDatum(s.gueltigAb);
  const zustand = (s: ProfilStandView) => {
    if (s === angezeigt)
      return ctx.historisch
        ? { text: `Stand zum ${fmtDatum(ctx.stand)}`, ton: 'badge-yellow' }
        : { text: 'aktuell', ton: 'badge-green' };
    if (s.gueltigAb.getTime() > ende.getTime())
      return ctx.historisch
        ? { text: 'nach dem Stichtag', ton: 'badge-gray' }
        : { text: 'geplant', ton: 'badge-brand' };
    return { text: 'abgelöst', ton: 'badge-gray' };
  };

  const aendernKnopf = darf ? (
    <Link className="btn-primary btn-tiny" href={`${basis}/profil?aendern=1#aendern`}>
      <Icon name="Pencil" className="tx-icon-xs" /> Profil ändern
    </Link>
  ) : (
    <button type="button" className="btn-primary btn-tiny" disabled title={sperrGrund}>
      <Icon name="Pencil" className="tx-icon-xs" /> Profil ändern
    </button>
  );
  const ok = sp['geaendert'] === '1';
  const param = (k: string) => (Array.isArray(sp[k]) ? sp[k][0] : sp[k]) ?? '';
  const zahl = (k: string) => Number(param(k)) || 0;
  const aufgenommen = /^EC-[A-Z]{3}-\d{2}$/.test(param('aufgenommen'))
    ? param('aufgenommen')
    : null;
  const liste = (k: string) =>
    param(k)
      .split(',')
      .filter((x) => /^K-EC-\d{2}$/.test(x));

  return (
    <>
      <TcmsKopf
        seite={seite}
        titel={<span className="text-sm font-s">Geschäftsprofil</span>}
        rechts={aendernKnopf}
      />

      {ok && !ctx.historisch ? (
        <div className="alert-success mb-3 text-sm" role="status">
          Neuer Profilstand angelegt
          {juengster ? ` (gültig ab ${fmtDatum(juengster.gueltigAb)})` : ''}. {zahl('nb')} Risiko(s)
          zur Neubewertung markiert · {zahl('ev')} Ereignis(se) im Ereigniseingang angelegt ·{' '}
          {zahl('nv')} Vorschlag/Vorschläge noch nicht im Inventar.
        </div>
      ) : null}

      {aendern && juengster ? (
        <div className="card mb-4" id="aendern">
          <div className="card-header">
            <span className="card-title">Profil ändern</span>
            <span className="text-xs text-muted">
              Basis: Stand gültig ab {fmtDatum(juengster.gueltigAb)} ·{' '}
              {personKurzname(ctx, juengster.erstelltVon)}
            </span>
          </div>
          <ProfilAenderung
            aktion={aendereProfil}
            mandantId={ctx.mandant.id}
            profilStandId={juengster.id}
            start={juengster.antworten}
            personen={personen}
            heuteIso={seite.heuteIso}
            abbrechen={`${basis}/profil`}
          />
        </div>
      ) : null}

      <div className="g12">
        <div className="card gc-8" style={{ overflow: 'hidden' }}>
          <div className="card-header">
            <span className="card-title">
              Geschäftsprofil P1–P12
              {angezeigt ? (
                <span className="text-sm text-muted font-m">
                  {' '}
                  · gültig ab {fmtDatum(angezeigt.gueltigAb)}
                </span>
              ) : null}
            </span>
            {angezeigt ? (
              <span className={zustand(angezeigt).ton}>{zustand(angezeigt).text}</span>
            ) : null}
          </div>
          {angezeigt ? (
            <>
              <div className="px-6 py-3">
                <ProfilAnzeige
                  profil={angezeigt.antworten}
                  geaendert={new Set(diffAngezeigt.map((d) => d.key))}
                />
              </div>
              <div className="card-footer">
                <span>
                  Erfasst von {personKurzname(ctx, angezeigt.erstelltVon)}
                  {vorab(angezeigt) ? ` · angelegt am ${fmtDatumZeit(angezeigt.createdAt)}` : ''}
                  {diffAngezeigt.length
                    ? ` · ${diffAngezeigt.length} Frage(n) gegenüber dem Vorgänger geändert`
                    : ''}
                </span>
                <span>
                  {ctx.historisch
                    ? 'nur Lesen'
                    : juengster && juengster !== angezeigt
                      ? `geplanter Stand ab ${fmtDatum(juengster.gueltigAb)}`
                      : 'Antworten steuern den Risikovorschlag'}
                </span>
              </div>
            </>
          ) : (
            <Leerzustand
              icon="History"
              text={`Zum ${fmtDatum(ctx.stand)} bestand noch kein Profilstand.`}
            />
          )}
        </div>

        <div className="gc-4 col" style={{ gap: 16 }}>
          <div className="card">
            <div className="card-header">
              <span className="card-title">Teilbereich & Ziele</span>
            </div>
            <div className="p-4">
              {ctx.teilbereich ? (
                <>
                  <div className="text-sm font-m">{ctx.teilbereich.name}</div>
                  <p className="text-xs text-muted mt-1">{ctx.teilbereich.abgrenzung}</p>
                  <div className="row-wrap mt-2" style={{ gap: 4 }}>
                    {ctx.teilbereich.einschluesse.map((x) => (
                      <span key={x} className="badge-green" style={{ fontSize: 11 }}>
                        {x}
                      </span>
                    ))}
                    {ctx.teilbereich.ausschluesse.map((x) => (
                      <span
                        key={x}
                        className="badge-gray"
                        style={{ fontSize: 11 }}
                        title="Ausschluss"
                      >
                        {x}
                      </span>
                    ))}
                  </div>
                </>
              ) : (
                <p className="text-sm text-muted">Kein Teilbereich abgegrenzt.</p>
              )}
            </div>
            <div>
              {ctx.ziele.map((z) => (
                <div key={z.id} className="list-row" style={{ display: 'block' }}>
                  <div className="text-xs">{z.text}</div>
                  <div className="row-wrap mt-1" style={{ gap: 6 }}>
                    <span className="text-11 text-muted">
                      Wesentlichkeit {fmtEurGanz(z.wesentlichkeitEur)} · Appetit{' '}
                      {KLASSE_LABEL[z.risikoappetit]}
                    </span>
                    {z.freigabe === 'FREIGEGEBEN' ? (
                      <span className="badge-green" style={{ fontSize: 11 }}>
                        freigegeben · {personKurzname(ctx, z.freigegebenVon)} ·{' '}
                        {fmtDatum(z.freigegebenAm)}
                      </span>
                    ) : z.freigabe === 'AUSSTEHEND' ? (
                      <span className="badge-yellow" style={{ fontSize: 11 }}>
                        Mandantenfreigabe ausstehend
                      </span>
                    ) : (
                      <span className="badge-gray" style={{ fontSize: 11 }}>
                        Entwurf
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="card" id="historie">
            <div className="card-header">
              <span className="card-title">Historie</span>
              <span className="badge-gray">{staende.length} Stände</span>
            </div>
            <div>
              {[...staende].reverse().map((s) => {
                const z = zustand(s);
                const vor = vorgaenger(s);
                const d = vor ? profilDiff(vor.antworten, s.antworten) : null;
                // Historische Ansicht nur, wenn der Stand mindestens einen ganzen Kalendertag galt.
                const letzterTag = s.gueltigBis ? isoDatum(addTage(s.gueltigBis, -1)) : null;
                const ansicht =
                  letzterTag &&
                  s.gueltigBis!.getTime() <= ende.getTime() &&
                  s !== angezeigt &&
                  letzterTag >= isoDatum(s.gueltigAb)
                    ? letzterTag
                    : null;
                return (
                  <div
                    key={s.id}
                    className={`list-row${s === angezeigt ? ' sel' : ''}`}
                    style={{ display: 'block' }}
                  >
                    <div className="row-between">
                      <span className="text-sm font-m">Stand {staende.indexOf(s) + 1}</span>
                      <span className={z.ton}>{z.text}</span>
                    </div>
                    <div className="text-11 text-muted mt-1">
                      gültig ab {fmtDatum(s.gueltigAb)}
                      {s.gueltigBis ? ` bis ${fmtDatum(s.gueltigBis)}` : ''} ·{' '}
                      {personKurzname(ctx, s.erstelltVon)}
                      {vorab(s) ? ` · angelegt am ${fmtDatumZeit(s.createdAt)}` : ''}
                    </div>
                    {d ? (
                      <details
                        className="details-box mt-2"
                        open={s === angezeigt || s === juengster}
                      >
                        <summary style={{ padding: '6px 10px', fontSize: 12 }}>
                          <Icon name="ChevronDown" className="tx-icon-xs" /> Änderungen zum
                          Vorgänger ({d.length} {d.length === 1 ? 'Frage' : 'Fragen'})
                        </summary>
                        <div className="details-body" style={{ padding: '0 10px 10px' }}>
                          <ProfilDiffListe diff={d} />
                        </div>
                      </details>
                    ) : (
                      <div className="text-11 text-muted mt-1">
                        Erstanlage im Einrichtungsassistenten.
                      </div>
                    )}
                    {ansicht ? (
                      <Link
                        className="text-11 mt-1"
                        style={{ display: 'inline-block' }}
                        href={`${basis}/profil?stand=${ansicht}`}
                      >
                        Stand zum {fmtDatum(new Date(`${ansicht}T00:00:00Z`))} ansehen →
                      </Link>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      <div className="card mt-4" id="vorschlaege" style={{ overflow: 'hidden' }}>
        <div className="card-header">
          <span className="card-title">Risikovorschlag aus dem Profil</span>
          <span className="text-xs text-muted">
            {basisStand ? `Profilstand gültig ab ${fmtDatum(basisStand.gueltigAb)}` : '—'} ·
            deterministisch, je Vorschlag mit Grund
          </span>
        </div>
        <div className="p-4">
          {aufgenommen && !ctx.historisch ? (
            <div className="alert-success mb-3 text-sm" role="status">
              {aufgenommen} ins Risikoinventar aufgenommen (Brutto-Startwerte, Status bewertet)
              {liste('kn').length ? ` · Kontrollen angelegt: ${liste('kn').join(', ')}` : ''}
              {liste('vk').length ? ` · verknüpft mit ${liste('vk').join(', ')}` : ''}
              {liste('ng').length
                ? ` · künftige Durchführungen neu geplant: ${liste('ng').join(', ')}`
                : ''}
              {zahl('d') ? ` · ${zahl('d')} Durchführungen geplant` : ''}. Designbeurteilung und
              Freigabe folgen im Risikoinventar und in der Kontrollmatrix.
            </div>
          ) : null}
          <div className="mini-kpis">
            <div className="mini-kpi">
              <div className="v">{vorschlaege.length}</div>
              <div className="l">Vorschläge aus dem Profil</div>
            </div>
            <div className="mini-kpi">
              <div className="v">{deckungsgleich}</div>
              <div className="l">davon im Risikoinventar</div>
            </div>
            <div className="mini-kpi">
              <div className="v">{neu.length + abgelehnt.length}</div>
              <div className="l">nicht im Inventar ({abgelehnt.length} begründet abgelehnt)</div>
            </div>
            <div className="mini-kpi">
              <div className="v">{nichtMehr.length}</div>
              <div className="l">aktiv, aber nicht mehr vorgeschlagen</div>
            </div>
          </div>
        </div>

        {neu.length ? (
          <Abschnitt
            titel="Neu vorgeschlagen"
            anzahl={neu.length}
            ton="badge-brand"
            hinweis="Aufnehmen legt das Risiko mit Brutto-Startwerten und die noch fehlenden Katalogkontrollen an."
          >
            {neu.map((v) => (
              <div key={v.code} className="list-row" style={{ paddingLeft: 24, paddingRight: 24 }}>
                <VorschlagKopf v={v} />
                <RisikoAufnehmen
                  aktion={nimmVorgeschlagenesRisikoAuf}
                  mandantId={ctx.mandant.id}
                  code={v.code}
                  darf={darf}
                  grund={sperrGrund}
                />
              </div>
            ))}
          </Abschnitt>
        ) : null}

        {abgelehnt.length ? (
          <Abschnitt titel="Begründet abgelehnt, weiterhin vorgeschlagen" anzahl={abgelehnt.length}>
            {abgelehnt.map((v) => (
              <div key={v.code} className="list-row" style={{ paddingLeft: 24, paddingRight: 24 }}>
                <div className="grow">
                  <VorschlagKopf v={v} />
                  <div className="text-11 text-muted mt-1">
                    Ablehnung: {zeileJe.get(v.code)?.ablehnungsgrund ?? '—'}
                  </div>
                </div>
                <RisikoAufnehmen
                  aktion={nimmVorgeschlagenesRisikoAuf}
                  mandantId={ctx.mandant.id}
                  code={v.code}
                  darf={darf}
                  grund={sperrGrund}
                  label="Doch aufnehmen"
                />
              </div>
            ))}
          </Abschnitt>
        ) : null}

        {deaktiviert.length ? (
          <Abschnitt
            titel="Deaktiviert, erneut vorgeschlagen"
            anzahl={deaktiviert.length}
            hinweis="Die Reaktivierung erfolgt im Risikoinventar."
          >
            {deaktiviert.map((v) => (
              <div key={v.code} className="list-row" style={{ paddingLeft: 24, paddingRight: 24 }}>
                <VorschlagKopf v={v} />
                <Link className="btn-secondary btn-tiny" href={mitStand(`${basis}/risiken`)}>
                  Risikoinventar →
                </Link>
              </div>
            ))}
          </Abschnitt>
        ) : null}

        {nichtMehr.length ? (
          <Abschnitt
            titel="Nicht mehr vorgeschlagen"
            anzahl={nichtMehr.length}
            hinweis="Das Risiko bleibt aktiv, bis es im Risikoinventar bewusst deaktiviert wird."
          >
            {nichtMehr.map((r) => (
              <div key={r.id} className="list-row" style={{ paddingLeft: 24, paddingRight: 24 }}>
                <div className="grow">
                  <div className="text-sm font-m">
                    {r.code} · {r.titel}
                  </div>
                  <div className="text-11 text-muted mt-1">
                    Ursprünglicher Grund: {r.vorschlagsgrund ?? '—'}
                  </div>
                </div>
                <span className="badge-gray shrink0">bleibt aktiv</span>
                <Link
                  className="btn-secondary btn-tiny shrink0"
                  href={mitStand(`${basis}/risiken`)}
                >
                  Prüfen →
                </Link>
              </div>
            ))}
          </Abschnitt>
        ) : null}

        {neuBewerten.length ? (
          <Abschnitt
            titel="Zur Neubewertung markiert"
            anzahl={neuBewerten.length}
            ton="badge-yellow"
            hinweis="Markiert durch Profiländerung oder Ereignis-Triage; die Bewertung erfolgt im Risikoinventar."
          >
            <div className="row-wrap" style={{ padding: '4px 24px 14px', gap: 6 }}>
              {neuBewerten.map((r) => (
                <Link
                  key={r.id}
                  href={mitStand(`${basis}/risiken`)}
                  className="badge-yellow"
                  style={{ textDecoration: 'none' }}
                  title={r.titel}
                >
                  {r.code}
                </Link>
              ))}
            </div>
          </Abschnitt>
        ) : null}

        {!neu.length && !abgelehnt.length && !deaktiviert.length && !nichtMehr.length ? (
          <div style={{ borderTop: '1px solid rgb(var(--border-default))' }}>
            <Leerzustand
              icon="CheckCheck"
              text={`Profil und Risikoinventar sind deckungsgleich: alle ${vorschlaege.length} Vorschläge sind im Inventar.`}
            />
          </div>
        ) : null}
      </div>
      <p className="text-11 text-muted mt-4">
        Der Vorschlag folgt den Regeln des Pakets (Fachkonzept § 4) und ist ein ungeprüfter Entwurf;
        Kernrisiken sind immer aktiv. Profiländerungen erzeugen die zugehörigen Ereignisse (§ 7) im
        Ereigniseingang.
      </p>
    </>
  );
}
