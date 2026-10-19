import Link from 'next/link';
import {
  AUSWIRKUNG_BADGE,
  AUSWIRKUNG_LABEL,
  EREIGNIS_QUELLE_LABEL,
  ereignistyp,
  fmtDatum,
  fmtDatumZeit,
  relativTage,
} from '@tcms/domain';
import { Icon, type IconName } from '@/components/icon';
import { KpiKarte } from '@/components/portfolio/teile';
import { KlasseBadge, StatusBadge } from '@/components/ui/badges';
import { Leerzustand } from '@/components/ui/leer';
import { ladeArbeitskorb, type VierAugenArt } from '@/server/arbeitskorb-daten';
import { istBerufstraeger } from '@tcms/service';
import { zugaenglicheMandanten } from '@/server/demo';
import { brauchtKanzlei } from '@/server/sitzung';

export const metadata = { title: 'Arbeitskorb' };

const VIER_AUGEN: Record<VierAugenArt, { label: string; icon: IconName }> = {
  UEBERSTEUERUNG: { label: 'Übersteuerung', icon: 'Pencil' },
  FREQUENZ: { label: 'Frequenzabweichung', icon: 'CalendarClock' },
  VERWERFEN: { label: 'Verwerfen', icon: 'Ban' },
  RISIKOFREIGABE: { label: 'Inventarfreigabe', icon: 'UserCheck' },
};

const RING: Record<string, string> = {
  brand: 'brand',
  violet: 'violet',
  amber: 'amber',
  red: 'red',
  green: 'green',
};

function GruppenKopf({
  id,
  icon,
  titel,
  anzahl,
  ton,
}: {
  id: string;
  icon: IconName;
  titel: string;
  anzahl: number;
  ton: string;
}) {
  return (
    <div className="card-header" id={id}>
      <span className="row">
        <Icon name={icon} className="tx-icon text-muted" />
        <span className="card-title">{titel}</span>
      </span>
      <span className={anzahl > 0 ? ton : 'badge-gray'}>{anzahl}</span>
    </div>
  );
}

export default async function ArbeitskorbSeite() {
  const nutzer = await brauchtKanzlei();
  const korb = await ladeArbeitskorb(nutzer, zugaenglicheMandanten(nutzer));
  const bt = istBerufstraeger(nutzer);

  const ueberfaellig = korb.durchfuehrungen.filter((d) => d.anzeige === 'UEBERFAELLIG').length;
  const gesamt =
    korb.durchfuehrungen.length +
    korb.gegenzeichnungen.length +
    korb.vierAugen.length +
    korb.p153.length +
    korb.ereignisse.length +
    korb.beschreibungen.length;

  return (
    <div className="page">
      <div className="row-between mb-4" style={{ flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 className="page-title" style={{ marginBottom: 0 }}>
            Arbeitskorb
          </h1>
          <p className="text-sm text-muted mt-1">
            Offene Tax-CMS-Aufgaben von {nutzer.name} über alle Mandanten · Stand{' '}
            {fmtDatum(korb.heute)}
          </p>
        </div>
        <span className={gesamt ? 'badge-brand' : 'badge-green'}>
          {gesamt ? `${gesamt} offene Aufgaben` : 'nichts offen'}
        </span>
      </div>

      <div className="row-lg mb-4" style={{ alignItems: 'stretch', flexWrap: 'wrap' }}>
        <KpiKarte
          icon="AlarmClock"
          ton={ueberfaellig ? 'red' : 'gray'}
          wert={ueberfaellig}
          label="Durchführungen überfällig"
          href="#durchfuehrungen"
          minBreite={150}
        />
        <KpiKarte
          icon="ListChecks"
          ton={korb.durchfuehrungen.length - ueberfaellig ? 'brand' : 'gray'}
          wert={korb.durchfuehrungen.length - ueberfaellig}
          label="fällig oder demnächst"
          href="#durchfuehrungen"
          minBreite={150}
        />
        <KpiKarte
          icon="UserCheck"
          ton={korb.gegenzeichnungen.length ? 'brand' : 'gray'}
          wert={korb.gegenzeichnungen.length}
          label="Gegenzeichnungen"
          href="#gegenzeichnungen"
          minBreite={150}
        />
        <KpiKarte
          icon="Users"
          ton={korb.vierAugen.length ? 'amber' : 'gray'}
          wert={korb.vierAugen.length}
          label="Vier-Augen-Bestätigungen"
          href="#vier-augen"
          minBreite={150}
        />
        <KpiKarte
          icon="Flame"
          ton={korb.p153.length ? 'red' : 'gray'}
          wert={korb.p153.length}
          label="§-153-Würdigungen"
          href="#p153"
          minBreite={150}
        />
        <KpiKarte
          icon="Inbox"
          ton={korb.ereignisse.length ? 'amber' : 'gray'}
          wert={korb.ereignisse.length}
          label="neue Ereignisse"
          href="#ereignisse"
          minBreite={150}
        />
      </div>

      {/* Reihe 1: Durchführungen und Gegenzeichnungen */}
      <div className="g12" style={{ alignItems: 'start' }}>
        <div className="card gc-7" style={{ overflow: 'hidden' }}>
          <GruppenKopf
            id="durchfuehrungen"
            icon="SquareCheckBig"
            titel="Durchführungen"
            anzahl={korb.durchfuehrungen.length}
            ton={ueberfaellig ? 'badge-red' : 'badge-brand'}
          />
          {korb.durchfuehrungen.length === 0 ? (
            <Leerzustand
              icon="CheckCheck"
              text="Keine fälligen oder überfälligen Durchführungen in Ihrer Verantwortung."
            />
          ) : (
            <div className="tbl-scroll">
              <table className="tbl">
                <thead>
                  <tr>
                    <th style={{ padding: '10px 16px' }}>Kontrolle</th>
                    <th style={{ padding: '10px 16px' }}>Fälligkeit</th>
                    <th style={{ padding: '10px 16px' }}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {korb.durchfuehrungen.map((d) => (
                    <tr key={d.id}>
                      <td style={{ padding: '10px 16px' }}>
                        <Link
                          href={d.href}
                          className="text-sm font-m unstyled"
                          style={{ display: 'block' }}
                        >
                          {d.code} · {d.titel}
                          {d.schluessel ? (
                            <span
                              className="text-muted"
                              style={{ marginLeft: 6, verticalAlign: -2, display: 'inline-flex' }}
                            >
                              <Icon
                                name="KeyRound"
                                className="tx-icon-xs"
                                title="Schlüsselkontrolle"
                              />
                            </span>
                          ) : null}
                        </Link>
                        <div className="text-11 text-muted mt-1">
                          {d.mandant.name} · {d.periode} · Nachweise {d.nachweise}/
                          {d.mindestNachweise}
                        </div>
                      </td>
                      <td style={{ padding: '10px 16px', whiteSpace: 'nowrap' }}>
                        <span className="text-sm mono">{fmtDatum(d.faelligAm)}</span>
                        <div
                          className="text-11 mt-1"
                          style={d.tage < 0 ? { color: '#b42318' } : undefined}
                        >
                          {relativTage(d.tage)}
                        </div>
                      </td>
                      <td style={{ padding: '10px 16px' }}>
                        {d.anzeige === 'GEPLANT' ? (
                          <span className="badge-gray">demnächst fällig</span>
                        ) : (
                          <StatusBadge status={d.anzeige} />
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="card-footer">
            <span>
              Eigene Durchführungen: Fälligkeitsfenster offen, überfällig oder in den nächsten 14
              Tagen fällig.
            </span>
          </div>
        </div>

        <div className="card gc-5" style={{ overflow: 'hidden' }}>
          <GruppenKopf
            id="gegenzeichnungen"
            icon="UserCheck"
            titel="Gegenzeichnungen"
            anzahl={korb.gegenzeichnungen.length}
            ton="badge-purple"
          />
          {korb.gegenzeichnungen.length === 0 ? (
            <Leerzustand
              icon="CheckCheck"
              text="Keine eingereichten Durchführungen warten auf Ihre Gegenzeichnung."
            />
          ) : (
            <div>
              {korb.gegenzeichnungen.map((g) => (
                <Link key={g.id} href={g.href} className="list-row unstyled">
                  <span className="icon-ring violet" style={{ width: 28, height: 28 }}>
                    <Icon name="FileCheck" className="tx-icon-xs" />
                  </span>
                  <div className="grow">
                    <div className="text-sm font-m">
                      {g.code} · {g.titel}
                    </div>
                    <div className="text-11 text-muted mt-1">
                      {g.mandant.name} · {g.periode}
                    </div>
                    <div className="text-11 text-muted">
                      Durchgeführt von {g.durchgefuehrtVon}
                      {g.eingereichtAm ? ` · eingereicht ${fmtDatumZeit(g.eingereichtAm)}` : ''} ·
                      Nachweise {g.nachweise}/{g.mindestNachweise}
                    </div>
                  </div>
                  {g.schluessel ? (
                    <span className="badge-brand shrink0">
                      <Icon name="KeyRound" className="tx-icon-xs" /> Schlüssel
                    </span>
                  ) : null}
                </Link>
              ))}
            </div>
          )}
          <div className="card-footer">
            <span>Eigene Durchführungen erscheinen hier nicht (Vier-Augen-Prinzip).</span>
          </div>
        </div>
      </div>

      {/* Reihe 2: §-153 und Vier-Augen */}
      <div className="g12 mt-4" style={{ alignItems: 'start' }}>
        <div className="card gc-6" style={{ overflow: 'hidden' }}>
          <GruppenKopf
            id="p153"
            icon="Flame"
            titel="§-153-Würdigungen"
            anzahl={korb.p153.length}
            ton="badge-red"
          />
          {korb.p153.length > 0 ? (
            <div>
              {korb.p153.map((f) => (
                <Link key={f.id} href={f.href} className="list-row unstyled">
                  <span className="kpi-chip chip-red" style={{ width: 28, height: 28 }}>
                    <Icon name="Flame" className="tx-icon-xs" />
                  </span>
                  <div className="grow">
                    <div className="text-sm font-m row-s" style={{ flexWrap: 'wrap' }}>
                      {f.nummer} · {f.vertraulich ? 'vertrauliche Feststellung' : f.titel}
                      {f.vertraulich ? (
                        <span className="badge-gray">
                          <Icon name="EyeOff" className="tx-icon-xs" /> vertraulich
                        </span>
                      ) : null}
                    </div>
                    <div className="text-11 text-muted mt-1">
                      {f.mandant.name} · erfasst {fmtDatum(f.erfasstAm)}
                    </div>
                  </div>
                  <span className="row-s shrink0">
                    <span className={AUSWIRKUNG_BADGE[f.auswirkung]} title="Steuerliche Auswirkung">
                      Auswirkung {AUSWIRKUNG_LABEL[f.auswirkung]}
                    </span>
                    <KlasseBadge klasse={f.schwere} />
                  </span>
                </Link>
              ))}
            </div>
          ) : !bt && korb.p153BeiAnderen.anzahl > 0 ? (
            <div className="p-4">
              <div className="alert-info text-sm" role="note">
                In Ihren Mandaten{' '}
                {korb.p153BeiAnderen.anzahl === 1
                  ? 'ist eine §-153-Würdigung'
                  : `sind ${korb.p153BeiAnderen.anzahl} §-153-Würdigungen`}{' '}
                offen. Die Würdigung entscheidet ausschließlich der zuständige Berufsträger (
                {korb.p153BeiAnderen.berufstraeger.join(', ')}).
              </div>
            </div>
          ) : (
            <Leerzustand
              icon="CheckCheck"
              text={
                bt
                  ? 'Keine offenen §-153-Würdigungen in Ihren Mandaten.'
                  : '§-153-Würdigungen entscheiden ausschließlich Berufsträger; in Ihren Mandaten ist keine offen.'
              }
            />
          )}
          <div className="card-footer">
            <span>
              Vier gleichrangige Optionen ohne Vorauswahl; Entscheidung höchstpersönlich durch den
              Berufsträger.
            </span>
          </div>
        </div>

        <div className="card gc-6" style={{ overflow: 'hidden' }}>
          <GruppenKopf
            id="vier-augen"
            icon="Users"
            titel="Vier-Augen-Bestätigungen"
            anzahl={korb.vierAugen.length}
            ton="badge-yellow"
          />
          {korb.vierAugen.length === 0 ? (
            <Leerzustand icon="CheckCheck" text="Keine Anträge warten auf Sie als zweite Person." />
          ) : (
            <div>
              {korb.vierAugen.map((v) => (
                <Link key={v.key} href={v.href} className="list-row unstyled">
                  <span className="icon-ring amber" style={{ width: 28, height: 28 }}>
                    <Icon name={VIER_AUGEN[v.art].icon} className="tx-icon-xs" />
                  </span>
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="text-sm font-m">{v.titel}</div>
                    <div className="text-11 text-muted mt-1">
                      {v.mandant.name} · {v.detail}
                    </div>
                    {v.begruendung ? (
                      <div className="text-11 text-secondary mt-1 truncate" title={v.begruendung}>
                        „{v.begruendung}"
                      </div>
                    ) : null}
                    <div className="text-11 text-muted">
                      Beantragt von {v.beantragtVon}
                      {v.beantragtAm ? ` · ${fmtDatumZeit(v.beantragtAm)}` : ''}
                    </div>
                  </div>
                  <span className="badge-gray shrink0">{VIER_AUGEN[v.art].label}</span>
                </Link>
              ))}
            </div>
          )}
          <div className="card-footer">
            <span>
              Übersteuerungen, Frequenzabweichungen, Verwerfen und Inventarfreigaben bestätigt eine
              zweite Person.
            </span>
          </div>
        </div>
      </div>

      {/* Reihe 3: Ereignisse und Beschreibungen */}
      <div className="g12 mt-4" style={{ alignItems: 'start' }}>
        <div className="card gc-6" style={{ overflow: 'hidden' }}>
          <GruppenKopf
            id="ereignisse"
            icon="Inbox"
            titel="Neue Ereignisse"
            anzahl={korb.ereignisse.length}
            ton="badge-yellow"
          />
          {korb.ereignisse.length === 0 ? (
            <Leerzustand icon="Inbox" text="Keine ungetriagierten Ereignisse in Ihren Mandaten." />
          ) : (
            <div>
              {korb.ereignisse.map((e) => {
                const t = ereignistyp(e.typ);
                return (
                  <Link key={e.id} href={e.href} className="list-row unstyled">
                    <span
                      className={`icon-ring ${RING[t?.ton ?? 'brand']}`}
                      style={{ width: 28, height: 28 }}
                    >
                      <Icon name={t?.icon ?? 'Bell'} className="tx-icon-xs" />
                    </span>
                    <div className="grow">
                      <div className="text-sm font-m">
                        {e.typ} · {e.titel}
                      </div>
                      <div className="text-11 text-muted mt-1">
                        {e.mandant.name} · {EREIGNIS_QUELLE_LABEL[e.quelle]} · {e.gemeldetVon} ·{' '}
                        {fmtDatum(e.gemeldetAm)}
                      </div>
                    </div>
                    <span className="badge-brand shrink0">neu</span>
                  </Link>
                );
              })}
            </div>
          )}
          <div className="card-footer">
            <span>Jedes Ereignis wird triagiert; Verwerfen braucht eine Begründung.</span>
          </div>
        </div>

        <div className="card gc-6" style={{ overflow: 'hidden' }}>
          <GruppenKopf
            id="beschreibungen"
            icon="FileText"
            titel="CMS-Beschreibungen im Kanzlei-Review"
            anzahl={korb.beschreibungen.length}
            ton="badge-brand"
          />
          {korb.beschreibungen.length === 0 ? (
            <Leerzustand
              icon="FileCheck"
              text="Keine Beschreibungsversion wartet auf Ihr Review."
            />
          ) : (
            <div>
              {korb.beschreibungen.map((b) => (
                <Link key={b.id} href={b.href} className="list-row unstyled">
                  <span className="icon-ring brand" style={{ width: 28, height: 28 }}>
                    <Icon name="FileText" className="tx-icon-xs" />
                  </span>
                  <div className="grow">
                    <div className="text-sm font-m">CMS-Beschreibung v{b.nummer}</div>
                    <div className="text-11 text-muted mt-1">
                      {b.mandant.name} · Review angefordert von {b.angefordertVon}
                      {b.angefordertAm ? ` · ${fmtDatumZeit(b.angefordertAm)}` : ''}
                    </div>
                  </div>
                  <span className="badge-brand shrink0">Kanzlei-Review</span>
                </Link>
              ))}
            </div>
          )}
          <div className="card-footer">
            <span>Review vor der Freigabe beim Mandanten.</span>
          </div>
        </div>
      </div>

      <p className="text-11 text-muted mt-6">
        Der Arbeitskorb zeigt nur eigene Aufgaben: zugewiesene Durchführungen und Gegenzeichnungen
        sowie Aufgaben aus {korb.mandantenZustaendig}{' '}
        {korb.mandantenZustaendig === 1 ? 'Mandat' : 'Mandaten'} mit Tax-CMS, in denen Sie
        Berufsträger oder Bearbeitung sind. Rechte werden beim Ausführen im jeweiligen Screen erneut
        geprüft.
      </p>
    </div>
  );
}
