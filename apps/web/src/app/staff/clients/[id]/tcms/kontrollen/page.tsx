import Link from 'next/link';
import {
  AUSFUEHRUNG_LABEL,
  fmtDatum,
  frequenzLabel,
  gleicheFrequenz,
  katalogKontrolle,
  KONTROLLART_LABEL,
  PARTEI_LABEL,
} from '@tcms/domain';
import { Icon } from '@/components/icon';
import { GtBadge } from '@/components/ui/badges';
import { ToggleGroupLink } from '@/components/ui/client';
import { Leerzustand } from '@/components/ui/leer';
import { TcmsKopf } from '@/components/tcms/kopf';
import { DesignBadge, DurchfuehrungBadge } from '@/components/kontrollen/badges';
import { KontrolleDrawer } from '@/components/kontrollen/drawer';
import { KontrollMatrix } from '@/components/kontrollen/matrix';
import { kurzName } from '@/components/risiken/labels';
import { mitParams, param } from '@/components/risiken/url';
import { KEIN_RECHT } from '@/server/aktion';
import { personName, type KontrolleView } from '@/server/kontext';
import { ladeKontrollenZusatz } from '@/server/kontrollen-daten';
import { ladeStaffSeite, NUR_AKTUELL } from '@/server/seite';

export const metadata = { title: 'Kontrollmatrix' };

const P = { padding: '10px 7px' } as const;

function FrequenzZelle({ k, beantragtVon }: { k: KontrolleView; beantragtVon: string | null }) {
  const offen = k.abweichung && !k.abweichung.freigegebenVon ? k.abweichung : null;
  const frei = k.abweichung?.freigegebenVon ? k.abweichung : null;
  const vorlageAnders = !gleicheFrequenz(k.vorlage, k.frequenz);
  return (
    <div className="col-s" style={{ gap: 3 }}>
      <span className="row-s" style={{ flexWrap: 'wrap' }}>
        <span className="text-sm">{frequenzLabel(k.frequenz)}</span>
        {frei ? (
          <span
            className="badge-yellow"
            title={`Begründete Abweichung: „${frei.begruendung ?? ''}“ · freigegeben von ${frei.freigegebenVon ? 'zweiter Person' : '—'}\nVorlage: ${frequenzLabel(k.vorlage)} · Matrix: ${frequenzLabel(k.ableitung.mindest)}`}
          >
            abweichend
          </span>
        ) : k.ableitung.abweichendVonVorlage ? (
          <span className="badge-gray" title={k.ableitung.begruendung}>
            aus Matrix
          </span>
        ) : null}
        {offen ? (
          <span
            className="badge-purple"
            title={`Beantragt${beantragtVon ? ` von ${beantragtVon}` : ''}: ${frequenzLabel(offen.frequenz)} – „${offen.begruendung ?? ''}“`}
          >
            Abweichung beantragt
          </span>
        ) : null}
      </span>
      {vorlageAnders ? (
        <span className="text-11 text-muted" title={k.ableitung.begruendung}>
          Vorlage: {frequenzLabel(k.vorlage)}
        </span>
      ) : null}
    </div>
  );
}

export default async function Kontrollmatrix({
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
  const pfad = `${basis}/kontrollen`;

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
  const ansicht = param(sp, 'ansicht') === 'matrix' ? 'matrix' : 'liste';
  const auswahl = ctx.kontrollen.find((k) => k.id === param(sp, 'kontrolle')) ?? null;
  const { feststellungen, offeneAbweichungen, detail } = await ladeKontrollenZusatz(
    ctx,
    auswahl?.id ?? null,
  );
  const kontrolleHref = (kid: string) => mitParams(pfad, sp, { kontrolle: kid });
  const risikoHref = (rid: string) => mitStand(`${basis}/risiken?risiko=${rid}`);
  const risikoCode = new Map(ctx.risiken.map((r) => [r.id, r.code]));

  const schluessel = ctx.kontrollen.filter((k) => k.schluessel).length;
  const ohneDesign = ctx.kontrollen.filter((k) => k.design === 'NICHT_BEURTEILT').length;
  const mangel = ctx.kontrollen.filter((k) => k.design === 'MANGEL').length;
  const beantragt = ctx.kontrollen.filter(
    (k) => k.abweichung && !k.abweichung.freigegebenVon,
  ).length;
  const ueberfaellig = ctx.kontrollen.filter((k) => k.naechste?.anzeige === 'UEBERFAELLIG').length;

  return (
    <>
      <TcmsKopf seite={seite} />

      <div className="row-between mb-4" style={{ flexWrap: 'wrap', gap: 12 }}>
        <div className="row-lg" style={{ flexWrap: 'wrap' }}>
          <h2 className="text-xl font-b text-primary">Kontrollmatrix</h2>
          <span className="badge-gray">{ctx.kontrollen.length} aktiv</span>
          <span className="badge-brand" title="Schlüsselkontrollen">
            <Icon name="KeyRound" className="tx-icon-xs" /> {schluessel}
          </span>
          {ohneDesign ? (
            <span className="badge-gray">Design nicht beurteilt ({ohneDesign})</span>
          ) : null}
          {mangel ? <span className="badge-red">Designmangel ({mangel})</span> : null}
          {beantragt ? (
            <span className="badge-purple">
              {beantragt} Abweichung{beantragt === 1 ? '' : 'en'} beantragt
            </span>
          ) : null}
          {ueberfaellig ? <span className="badge-red">{ueberfaellig} überfällig</span> : null}
        </div>
        <div className="row-lg">
          <ToggleGroupLink
            param="ansicht"
            label="Ansicht"
            aktiv={ansicht}
            optionen={[
              ['liste', 'Liste'],
              ['matrix', 'Matrix'],
            ]}
          />
          <button
            type="button"
            className="btn-primary"
            disabled
            title={
              sperre ??
              'Kontrollen entstehen aus Katalogvorlagen mit der Risikoübernahme (Profil → Vorschläge); eigene Kontrollen folgen mit S7.'
            }
          >
            <Icon name="Plus" className="tx-icon-xs" /> Kontrolle hinzufügen
          </button>
        </div>
      </div>

      {ctx.kontrollen.length === 0 ? (
        <div className="card">
          <Leerzustand
            icon="SquareCheckBig"
            text="Noch keine Kontrollen – sie entstehen mit der Übernahme der Risiken aus dem Katalog."
          />
        </div>
      ) : ansicht === 'matrix' ? (
        <KontrollMatrix
          risiken={ctx.risiken}
          kontrollen={ctx.kontrollen}
          kontrolleHref={kontrolleHref}
          risikoHref={risikoHref}
        />
      ) : (
        <div className="card" style={{ overflow: 'hidden' }}>
          <div className="tbl-scroll">
            <table className="tbl">
              <thead>
                <tr>
                  <th style={P}>Kontrolle</th>
                  <th
                    style={P}
                    title="Art (P präventiv · D detektiv · K korrigierend) / Ausführung (M manuell · IT IT-gestützt · A automatisiert)"
                  >
                    Art / Ausf.
                  </th>
                  <th style={P} title="Governance-Typ des maßgeblichen Risikos">
                    GT
                  </th>
                  <th style={P}>Frequenz</th>
                  <th style={P}>Partei</th>
                  <th style={P} title="Durchführend / Vertretung · Gegenzeichnung (GZ)">
                    Personen
                  </th>
                  <th style={P} title="Schlüsselkontrolle">
                    <Icon name="KeyRound" className="tx-icon-xs" />
                  </th>
                  <th style={P}>Design</th>
                  <th style={P}>letzte Durchf.</th>
                  <th style={P}>nächste Fälligkeit</th>
                </tr>
              </thead>
              <tbody>
                {ctx.kontrollen.map((k) => {
                  const kat = katalogKontrolle(k.code);
                  const href = kontrolleHref(k.id);
                  const f = k.letzte ? feststellungen.get(k.letzte.id) : undefined;
                  const antrag = offeneAbweichungen.get(k.id);
                  const n = k.naechste;
                  return (
                    <tr key={k.id} className={`row-link${auswahl?.id === k.id ? ' sel' : ''}`}>
                      <td style={{ ...P, minWidth: 160, width: 210 }} className="wrap-cell">
                        <Link
                          href={href}
                          scroll={false}
                          className="mono text-xs text-muted unstyled"
                          style={{ display: 'block' }}
                        >
                          {k.code}
                        </Link>
                        <Link href={href} scroll={false} className="text-sm font-m unstyled">
                          {k.titel}
                        </Link>
                        <div className="row-wrap mt-1" style={{ gap: 4 }}>
                          {k.risikoIds.length ? (
                            k.risikoIds.map((rid) => (
                              <Link
                                key={rid}
                                href={risikoHref(rid)}
                                className="mono text-11 text-muted unstyled"
                                title={`abgedecktes Risiko ${risikoCode.get(rid) ?? ''}`}
                              >
                                {(risikoCode.get(rid) ?? '').replace(/^EC-/, '')}
                              </Link>
                            ))
                          ) : (
                            <span className="text-11 text-muted">
                              alle Risiken (Kultur, Kommunikation)
                            </span>
                          )}
                        </div>
                        {!k.pflichtattributeOk ? (
                          <div
                            className="text-11"
                            style={{ color: '#b42318' }}
                            title={k.pflichtattributeLuecken.join(', ')}
                          >
                            Pflichtattribute unvollständig
                          </div>
                        ) : null}
                      </td>
                      <td style={{ ...P, whiteSpace: 'nowrap' }}>
                        <span className="row-s">
                          <span className="badge-gray" title={KONTROLLART_LABEL[k.art]}>
                            {k.art}
                          </span>
                          <span className="badge-gray" title={AUSFUEHRUNG_LABEL[k.ausfuehrung]}>
                            {k.ausfuehrung}
                          </span>
                        </span>
                      </td>
                      <td style={P}>
                        <GtBadge gt={k.gt} />
                      </td>
                      <td style={{ ...P, minWidth: 128 }}>
                        <FrequenzZelle
                          k={k}
                          beantragtVon={antrag?.von ? personName(ctx, antrag.von) : null}
                        />
                      </td>
                      <td style={P}>
                        <span className="badge-gray">{PARTEI_LABEL[k.partei]}</span>
                        {kat?.review ? (
                          <div className="text-11 text-muted mt-1">{kat.review}</div>
                        ) : null}
                      </td>
                      <td style={{ ...P, whiteSpace: 'nowrap' }} className="text-sm">
                        <div
                          title={`Durchführend: ${personName(ctx, k.durchfuehrendId)} · Vertretung: ${personName(ctx, k.vertretungId)}`}
                        >
                          {kurzName(personName(ctx, k.durchfuehrendId))} /{' '}
                          {k.vertretungId ? kurzName(personName(ctx, k.vertretungId)) : '—'}
                        </div>
                        <div className="text-11 text-muted">
                          {k.gegenzeichnungMandant ? (
                            <span title="Gegenzeichnung durch zweite Person beim Mandanten">
                              GZ {kurzName(personName(ctx, k.vertretungId))} (Mandant)
                            </span>
                          ) : k.gegenzeichnerId ? (
                            <span title={`Gegenzeichnung: ${personName(ctx, k.gegenzeichnerId)}`}>
                              GZ {kurzName(personName(ctx, k.gegenzeichnerId))}
                              {k.schluessel ? ' (Pflicht)' : ''}
                            </span>
                          ) : (
                            'ohne Gegenzeichnung'
                          )}
                        </div>
                      </td>
                      <td style={P}>
                        {k.schluessel ? (
                          <span className="badge-brand" title="Schlüsselkontrolle">
                            <Icon name="KeyRound" className="tx-icon-xs" />
                          </span>
                        ) : (
                          <span className="text-disabled">·</span>
                        )}
                      </td>
                      <td style={{ ...P, whiteSpace: 'nowrap' }}>
                        <DesignBadge
                          design={k.design}
                          von={personName(ctx, k.designVon)}
                          am={k.designAm}
                          begruendung={k.designBegruendung}
                          kurz
                        />
                      </td>
                      <td style={P}>
                        {k.letzte ? (
                          <div className="col-s" style={{ gap: 3 }}>
                            <DurchfuehrungBadge d={k.letzte} umbruch />
                            {f ? (
                              <Link
                                href={mitStand(`${basis}/feststellungen/${f.id}`)}
                                className="text-11"
                                style={{
                                  color: !f.maskiert && f.p153Offen ? '#b42318' : undefined,
                                }}
                              >
                                → {f.nummer}
                                {!f.maskiert && f.p153Offen ? ' (§ 153 offen)' : ''}
                              </Link>
                            ) : null}
                          </div>
                        ) : (
                          <span
                            className="text-sm text-disabled"
                            title="noch keine abgeschlossene oder eingereichte Durchführung"
                          >
                            —
                          </span>
                        )}
                      </td>
                      <td style={{ ...P, whiteSpace: 'nowrap' }} className="text-sm">
                        {n ? (
                          <span
                            style={n.anzeige === 'UEBERFAELLIG' ? { color: '#b42318' } : undefined}
                            className={n.anzeige === 'UEBERFAELLIG' ? '' : 'text-secondary'}
                            title={`${n.periodeLabel} · ${n.anzeige.toLowerCase()}`}
                          >
                            {fmtDatum(n.faelligAm)}
                          </span>
                        ) : k.frequenz.turnus === 'KEIN' ? (
                          <span className="text-secondary">nach Ereignis</span>
                        ) : !ctx.programm?.wirksamAb ? (
                          <span
                            className="text-11 text-muted"
                            title="Durchführungen werden ab Beginn des Wirksamkeitszeitraums geplant"
                          >
                            ab Wirksamkeitszeitraum
                          </span>
                        ) : (
                          <span className="text-disabled" title="keine geplante Durchführung">
                            —
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="card-footer">
            <span>
              {ctx.kontrollen.length} aktive Kontrollen, davon {schluessel} Schlüsselkontrollen
            </span>
            <span>
              Frequenz = strengere aus Vorlage und Häufigkeitsmatrix (GT × Bruttoklasse);
              Abweichungen nur mit Begründung und zweiter Person
            </span>
          </div>
        </div>
      )}

      <p className="text-11 text-muted mt-4">
        Matrix-Startwerte und Governance-Typen sind ungeprüfte Entwürfe und vom Berufsträger zu
        kalibrieren. Statusangaben sind Betriebsinformationen, keine Aussage über Angemessenheit
        oder Wirksamkeit.
      </p>

      {auswahl ? (
        <KontrolleDrawer
          seite={seite}
          kontrolle={auswahl}
          detail={detail}
          feststellungJeDurchfuehrung={feststellungen}
          sperre={sperre}
          risikoHref={risikoHref}
        />
      ) : null}
    </>
  );
}
