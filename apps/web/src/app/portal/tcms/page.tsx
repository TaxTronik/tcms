import Link from 'next/link';
import { ereignistyp, fmtDatum, fmtDatumKurz, isoDatum, PHASEN, tageZwischen } from '@tcms/domain';
import { Icon } from '@/components/icon';
import { AufgabeKarte } from '@/components/portal/aufgabe';
import { DokThumb } from '@/components/portal/freigabe';
import { Leerzustand } from '@/components/ui/leer';
import { MiniSteps } from '@/components/ui/visual';
import { brauchtCode, ladeFreigaben } from '@/server/freigaben-daten';
import { ladeKontext } from '@/server/kontext';
import { istGesetzlicherVertreter, kannPortalLesen } from '@tcms/service';
import { kanzleiTeam, PHASE_EINFACH, portalAufgaben, zeitraumMonate } from '@/server/portal-daten';
import { brauchtPortal } from '@/server/sitzung';
import { heute } from '@/server/zeit';

export const metadata = { title: 'Tax-Compliance' };

const MELDUNG_STATUS: Record<string, [string, string]> = {
  NEU: ['eingegangen', 'badge-brand'],
  IN_TRIAGE: ['in Prüfung', 'badge-brand'],
  ERLEDIGT: ['abgeschlossen', 'badge-green'],
  VERWORFEN: ['geprüft – ohne Folgen', 'badge-gray'],
};
const TON: Record<string, string> = {
  brand: 'brand',
  violet: 'violet',
  amber: 'amber',
  red: 'red',
  green: 'green',
};

export default async function PortalUebersicht() {
  const { akteur: nutzer, rollen } = await brauchtPortal();
  const ctx = await ladeKontext(nutzer.mandantId, isoDatum(heute()), false);
  if (!ctx?.programm) {
    return (
      <div className="page">
        <h1 className="page-title">Tax-Compliance</h1>
        <div className="card mt-4">
          <Leerzustand
            icon="ShieldCheck"
            text="Für Ihr Unternehmen ist noch kein Tax-Compliance-Programm eingerichtet. Ihre Kanzlei meldet sich, sobald es losgeht."
          />
        </div>
      </div>
    );
  }

  // Portal-Übersicht: GV und TCB (aktive Rolle); Mitarbeitende sehen nur Eigenes.
  const lesen = kannPortalLesen(nutzer, nutzer.mandantId, rollen);
  const istGv = istGesetzlicherVertreter(nutzer, nutzer.mandantId, rollen);
  const darfMelden = lesen;
  const aufgaben = portalAufgaben(ctx, nutzer);
  const meine = aufgaben.filter((a) => a.eigene);
  const weitere = lesen ? aufgaben.filter((a) => !a.eigene) : [];
  const ueberfaellig = aufgaben.filter((a) => a.d.anzeige === 'UEBERFAELLIG');
  const meineUeber = meine.filter((a) => a.d.anzeige === 'UEBERFAELLIG').length;
  const { eintraege } = await ladeFreigaben(nutzer.mandantId);
  const kannF = (f: (typeof eintraege)[number]) =>
    brauchtCode(f.art) ? istGv && f.empfaengerId === nutzer.id : f.empfaengerId === nutzer.id;
  const offeneF = eintraege
    .filter((f) => f.status === 'OFFEN' && (lesen || f.empfaengerId === nutzer.id))
    .sort((a, b) => Number(kannF(b)) - Number(kannF(a)));
  const monate = zeitraumMonate(ctx);
  const zr = ctx.zeitraum;
  const p = ctx.programm;
  const mandantIds = new Set(ctx.mandantPersonen.map((x) => x.id));
  const meldungen = ctx.ereignisse
    .filter(
      (e) =>
        (e.quelle === 'PORTAL' || (e.gemeldetVon && mandantIds.has(e.gemeldetVon))) &&
        (lesen || e.gemeldetVon === nutzer.id),
    )
    .slice(0, 4);
  const team = kanzleiTeam(ctx);
  const restTage = p.wirksamBis ? tageZwischen(ctx.heute, p.wirksamBis) : null;

  return (
    <div className="page">
      <h1 className="page-title">Tax-Compliance</h1>
      <p className="text-sm text-muted mb-4" style={{ maxWidth: 820 }}>
        Ihre Kanzlei dokumentiert das Compliance-Programm für Ihren Onlinehandel. Hier sehen Sie den
        Stand und wo Ihre Mitarbeit gebraucht wird.
      </p>

      {/* Bühne: Phase bzw. gemeinsamer Kontrollzeitraum */}
      <div className="card p-4 mb-4">
        {zr && p.wirksamAb && p.wirksamBis && ctx.aktivePhase === 6 ? (
          <>
            <div className="row-between mb-3" style={{ flexWrap: 'wrap', gap: 8 }}>
              <div className="row-lg">
                <span className="text-lg font-b text-primary">
                  Zeitraum {fmtDatumKurz(p.wirksamAb)} – {fmtDatum(p.wirksamBis)}
                </span>
                <span className="badge-brand">
                  Monat {zr.monat} von {zr.monate}
                </span>
              </div>
              <span className="row-lg">
                {ueberfaellig.length ? (
                  <span className="badge-red">
                    {ueberfaellig.length} Aufgabe{ueberfaellig.length === 1 ? '' : 'n'} überfällig
                  </span>
                ) : (
                  <span className="badge-green">keine Aufgabe überfällig</span>
                )}
                {restTage != null && restTage >= 0 ? (
                  <span className="text-xs text-muted">
                    verbleibend: {restTage} Tage (bis {fmtDatumKurz(p.wirksamBis)})
                  </span>
                ) : null}
              </span>
            </div>
            <div
              className="tl"
              style={{ gridTemplateColumns: `repeat(${Math.max(1, monate.length)}, 1fr)` }}
            >
              {monate.map((m, i) => (
                <div
                  key={i}
                  className={`tl-seg ${m.zustand === 'offen' ? '' : m.zustand}`}
                  title={m.offen ? `${m.offen} offene Aufgabe(n)` : undefined}
                >
                  {m.label}
                  {m.zustand === 'done' ? (
                    <span className="tl-mark">
                      <Icon name="Check" className="tx-icon-xs" />
                    </span>
                  ) : m.zustand === 'offen' ? (
                    <span
                      className="tl-mark status-dot dot-red"
                      style={{ width: 9, height: 9, top: 7, right: 7 }}
                    />
                  ) : null}
                </div>
              ))}
            </div>
            <div className="row-wrap mt-3 text-xs text-muted" style={{ gap: 14 }}>
              <span className="row-s">
                <span className="status-dot dot-green" /> Monat ohne offene Aufgaben
              </span>
              <span className="row-s">
                <span className="status-dot" style={{ backgroundColor: 'rgb(var(--brand-600))' }} />{' '}
                laufender Monat
              </span>
              <span className="row-s">
                <span className="status-dot dot-red" /> Aufgabe offen
              </span>
              <span className="row-s">
                <span className="status-dot dot-gray" /> noch nicht begonnen
              </span>
            </div>
          </>
        ) : (
          <div className="row-between" style={{ flexWrap: 'wrap', gap: 12 }}>
            <div className="col" style={{ gap: 4 }}>
              <div className="row-lg">
                <span className="text-lg font-b text-primary">
                  Stand: {PHASEN[ctx.aktivePhase - 1]}
                </span>
                <span className="badge-brand">Schritt {ctx.aktivePhase} von 7</span>
              </div>
              <span className="text-sm text-secondary">{PHASE_EINFACH[ctx.aktivePhase]}</span>
            </div>
            <MiniSteps aktiv={ctx.aktivePhase} titel={[...PHASEN]} />
          </div>
        )}
        {ctx.aktivePhase === 6 ? (
          <div className="text-xs text-muted mt-2">{PHASE_EINFACH[6]}</div>
        ) : null}
      </div>

      {/* Aufgaben, Freigaben, Ereignis melden */}
      <div className="g12 mb-4" style={{ alignItems: 'start' }}>
        <div className="card gc-5">
          <div className="card-header">
            <span className="card-title">Ihre Aufgaben</span>
            {meineUeber ? (
              <span className="badge-red">{meineUeber} überfällig</span>
            ) : (
              <span className="badge-gray">{meine.length} offen</span>
            )}
          </div>
          {meine.length ? (
            <div className="p-4 col" style={{ gap: 14 }}>
              {meine.slice(0, 3).map((a) => (
                <AufgabeKarte key={a.d.id} a={a} />
              ))}
              {meine.length > 3 ? (
                <details className="details-box">
                  <summary>
                    <Icon name="ListChecks" className="tx-icon-xs" /> {meine.length - 3} weitere
                    Aufgabe{meine.length - 3 === 1 ? '' : 'n'} anzeigen
                  </summary>
                  <div className="details-body col" style={{ gap: 10 }}>
                    {meine.slice(3).map((a) => (
                      <AufgabeKarte key={a.d.id} a={a} />
                    ))}
                  </div>
                </details>
              ) : null}
            </div>
          ) : (
            <Leerzustand icon="CheckCheck" text="Für Sie liegt gerade keine Aufgabe an." />
          )}
          {weitere.length ? (
            <details className="details-box" style={{ margin: '0 16px 16px' }}>
              <summary>
                <Icon name="Users" className="tx-icon-xs" /> Weitere Aufgaben in Ihrem Unternehmen (
                {weitere.length})
              </summary>
              <div className="details-body col" style={{ gap: 10 }}>
                {weitere.map((a) => (
                  <AufgabeKarte key={a.d.id} a={a} />
                ))}
              </div>
            </details>
          ) : null}
        </div>

        <div className="card gc-4">
          <div className="card-header">
            <span className="card-title">Zur Freigabe / Kenntnis</span>
            {offeneF.length ? (
              <span className="badge-yellow">{offeneF.length} offen</span>
            ) : (
              <span className="badge-green">nichts offen</span>
            )}
          </div>
          {offeneF.length ? (
            <div className="p-4 col" style={{ gap: 12 }}>
              {offeneF.map((f) => {
                const code = brauchtCode(f.art);
                // TS-06: nur die adressierte Person handelt.
                const kann = code
                  ? istGv && f.empfaengerId === nutzer.id
                  : f.empfaengerId === nutzer.id;
                return (
                  <div key={f.id} className="card p-3" style={{ boxShadow: 'none' }}>
                    <div className="row" style={{ alignItems: 'flex-start', gap: 12 }}>
                      <DokThumb />
                      <div className="grow">
                        <div className="text-sm font-s">{f.titel}</div>
                        <div className="text-xs text-muted mt-1">
                          {code ? 'angefordert' : 'zur Kenntnis gebeten'} am{' '}
                          {fmtDatum(f.angefordertAm)}
                          {!kann
                            ? ` · für ${code ? 'die gesetzliche Vertretung' : f.empfaengerName}`
                            : ''}
                        </div>
                      </div>
                    </div>
                    <div className="form-actions mt-2" style={{ paddingTop: 0 }}>
                      {kann ? (
                        <Link
                          href={`/portal/tcms/freigaben#f-${f.id}`}
                          className={code ? 'btn-primary btn-tiny' : 'btn-secondary btn-tiny'}
                        >
                          {code ? 'Freigeben' : 'Zur Kenntnis'}
                        </Link>
                      ) : (
                        <Link
                          href={`/portal/tcms/freigaben#f-${f.id}`}
                          className="btn-secondary btn-tiny"
                          title={
                            code
                              ? 'Freigaben sind der gesetzlichen Vertretung vorbehalten'
                              : `an ${f.empfaengerName} gerichtet`
                          }
                        >
                          <Icon name="Lock" className="tx-icon-xs" /> Ansehen
                        </Link>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <Leerzustand icon="FileCheck" text="Derzeit liegt nichts zur Freigabe vor." />
          )}
          <div className="card-footer">
            <span>Freigaben sind der Geschäftsführung vorbehalten.</span>
            <Link
              href="/portal/tcms/freigaben"
              className="text-muted shrink0"
              style={{ textDecoration: 'none', whiteSpace: 'nowrap', marginLeft: 8 }}
            >
              Alle →
            </Link>
          </div>
        </div>

        <div
          className="card gc-3 p-4"
          style={{
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'space-between',
            gap: 14,
            minHeight: 360,
          }}
        >
          <div>
            <span className="text-lg font-b">Neues melden</span>
            <p className="text-sm text-secondary mt-2">
              Neuer Marktplatz, neues Lager, neues Zielland, neue Warengruppe oder neuer
              Zahlungsdienst? Bitte melden Sie Veränderungen — die Kanzlei kümmert sich um die
              Prüfung.
            </p>
          </div>
          <div className="cta-illu" style={{ justifyContent: 'center' }}>
            <span className="icon-ring brand" style={{ width: 44, height: 44 }}>
              <Icon name="Store" className="tx-icon-lg" />
            </span>
            <span className="icon-ring violet" style={{ width: 44, height: 44 }}>
              <Icon name="Warehouse" className="tx-icon-lg" />
            </span>
            <span className="icon-ring amber" style={{ width: 44, height: 44 }}>
              <Icon name="Tag" className="tx-icon-lg" />
            </span>
            <span className="icon-ring green" style={{ width: 44, height: 44 }}>
              <Icon name="CreditCard" className="tx-icon-lg" />
            </span>
          </div>
          {darfMelden ? (
            <Link
              href="/portal/tcms/ereignis"
              className="btn-primary"
              style={{ justifyContent: 'center', padding: 11, fontSize: 14 }}
            >
              <Icon name="Plus" /> Ereignis melden
            </Link>
          ) : (
            <button
              type="button"
              className="btn-primary"
              style={{ justifyContent: 'center', padding: 11, fontSize: 14 }}
              disabled
              title="Meldungen erfolgen über die Geschäftsführung oder die bzw. den Tax-Compliance-Beauftragten"
            >
              <Icon name="Plus" /> Ereignis melden
            </button>
          )}
        </div>
      </div>

      {/* Meldehistorie + Team */}
      <div className="g12" style={{ alignItems: 'start' }}>
        <div className="card gc-8">
          <div className="card-header">
            <span className="card-title">
              {lesen ? 'Ihre letzten Meldungen' : 'Ihre Meldungen'}
            </span>
            <span className="text-xs text-muted">werden von der Kanzlei geprüft</span>
          </div>
          {meldungen.length ? (
            <div>
              {meldungen.map((e) => {
                const t = ereignistyp(e.typ);
                const [label, badge] = MELDUNG_STATUS[e.status] ?? ['eingegangen', 'badge-brand'];
                return (
                  <div key={e.id} className="list-row">
                    <span className={`icon-ring ${TON[t?.ton ?? 'brand'] ?? 'brand'}`}>
                      <Icon name={t?.icon ?? 'Bell'} />
                    </span>
                    <div className="grow">
                      <div className="text-sm font-m">{e.titel}</div>
                      <div className="text-11 text-muted mt-1">
                        {e.typ} · gemeldet {fmtDatum(e.gemeldetAm)}
                        {e.gemeldetVon
                          ? ` von ${ctx.personen.get(e.gemeldetVon)?.name ?? '—'}`
                          : ''}{' '}
                        · Vorgang {e.nummer}
                      </div>
                    </div>
                    <span className={`${badge} shrink0`}>{label}</span>
                  </div>
                );
              })}
            </div>
          ) : (
            <Leerzustand icon="Inbox" text="Noch keine Meldungen über das Portal." />
          )}
          <div className="card-footer">Jede Meldung und Entscheidung ist dokumentiert.</div>
        </div>

        <div className="card gc-4">
          <div className="card-header">
            <span className="card-title">Ihr Team in der Kanzlei</span>
          </div>
          <div className="p-4 col" style={{ gap: 14 }}>
            <div className="row">
              <div className="avatar-stack" style={{ marginRight: 10 }}>
                {team.map((t, i) => (
                  <span
                    key={t.person.id}
                    className="avatar"
                    style={
                      i === 1
                        ? { backgroundColor: '#6d28d9', boxShadow: 'inset 0 0 0 1.5px #5b21b6' }
                        : undefined
                    }
                  >
                    {t.person.kuerzel}
                  </span>
                ))}
              </div>
              <div className="col" style={{ gap: 0 }}>
                <span className="text-sm font-s">{team.map((t) => t.person.name).join(' · ')}</span>
                <span className="text-11 text-muted">{team.map((t) => t.rolle).join(' · ')}</span>
              </div>
            </div>
            <div className="col-s" style={{ gap: 6 }}>
              {team.map((t) => (
                <div key={t.person.id} className="col-s" style={{ gap: 6 }}>
                  <a
                    href={`mailto:${t.person.email}`}
                    className="btn-secondary btn-tiny"
                    style={{ justifyContent: 'flex-start' }}
                  >
                    <Icon name="Mail" className="tx-icon-xs" /> {t.person.email}
                  </a>
                  {t.person.telefon ? (
                    <a
                      href={`tel:${t.person.telefon.replace(/\s/g, '')}`}
                      className="btn-secondary btn-tiny"
                      style={{ justifyContent: 'flex-start' }}
                    >
                      <Icon name="Phone" className="tx-icon-xs" /> {t.person.telefon}
                    </a>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
          <div className="card-footer">Ihre Freigaben und Meldungen laufen über dieses Team.</div>
        </div>
      </div>

      <div className="alert-info-sm mt-4">
        Angaben Ihrer Kanzlei. Statusangaben sind Arbeitsstände, keine Aussage über Angemessenheit
        oder Wirksamkeit. Rückfragen richten Sie bitte an Ihr Kanzleiteam.
      </div>
    </div>
  );
}
