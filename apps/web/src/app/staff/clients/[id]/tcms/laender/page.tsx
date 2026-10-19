import Link from 'next/link';
import { fmtDatum, fmtEurGanz, fmtMonatJahr, LAND_NAME } from '@tcms/domain';
import { Icon } from '@/components/icon';
import { LandDrawerInhalt, LandDrawerKopf, REG_BADGE } from '@/components/laender/drawer';
import {
  LandHinzufuegenForm,
  LandStandForm,
  SammelErfassung,
} from '@/components/laender/formulare';
import { SchwellenKarte } from '@/components/laender/schwelle';
import { TcmsKopf } from '@/components/tcms/kopf';
import { DetailDrawer } from '@/components/ui/client';
import { Leerzustand } from '@/components/ui/leer';
import { personName } from '@/server/kontext';
import {
  ereignisseZumLand,
  kontrollenZumLand,
  ladeLaenderDetail,
  risikenZumLand,
} from '@/server/laender-daten';
import { NUR_AKTUELL, ladeStaffSeite } from '@/server/seite';

export const metadata = { title: 'Länder-Monitor' };

type SP = Record<string, string | string[] | undefined>;
const eins = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

const REG_TABELLE = {
  VOLLSTAENDIG: 'vollständig',
  FEHLT: 'fehlt',
  PRUEFEN: 'Steuersätze prüfen',
} as const;

export default async function LaenderMonitor({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SP>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const seite = await ladeStaffSeite(id, sp);
  const { ctx, basis, mitStand, darfBearbeiten } = seite;

  if (!ctx.programm) {
    return (
      <div className="card">
        <Leerzustand icon="Globe" text="Für diesen Mandanten ist noch kein Tax-CMS eingerichtet." />
      </div>
    );
  }

  const detail = await ladeLaenderDetail(id, seite.standIso);
  const erfassen = eins(sp['erfassen']) === '1' && darfBearbeiten;
  const landCode = eins(sp['land']);
  const auswahl = ctx.laender.find((l) => l.land === landCode) ?? null;
  const gesperrt = ctx.historisch ? NUR_AKTUELL : 'Nur zuständige Personen erfassen Länderdaten';
  const maxLfd = Math.max(1, ...ctx.laender.map((l) => l.fernverkaeufeLfdEur));
  const juengster =
    [...detail.historie.values()]
      .map((h) => h[0]!)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null;
  const erfasst = eins(sp['erfasst']);
  const neueEreignisse = eins(sp['ereignisse']);
  const p1 = ctx.profil?.p1;
  const kanaele = p1
    ? [
        ...(p1.eigenerShop ? [`eigener Shop${p1.shopSystem ? ` (${p1.shopSystem})` : ''}`] : []),
        ...p1.marktplaetze,
      ]
    : [];
  const lagerArt = (land: string) => ctx.profil?.p2.lager.find((x) => x.land === land)?.art ?? null;
  const hrefLand = (land: string) => mitStand(`${basis}/laender?land=${land}`);

  return (
    <>
      <TcmsKopf seite={seite} />

      <div className="row-between mb-4" style={{ flexWrap: 'wrap', gap: 12 }}>
        <div className="col" style={{ gap: 2 }}>
          <h2 className="text-xl font-b text-primary">
            Länder-Monitor — Umsatzsteuer &amp; Registrierungen
          </h2>
          <p className="text-sm text-muted">
            Fernverkäufe, Lager und Registrierungsstatus je Land
            {ctx.laenderStand
              ? ` — Datenstand ${fmtDatum(ctx.laenderStand)} (${ctx.laenderQuelle === 'CSV' ? 'CSV-Import' : 'manuell erfasst'}).`
              : '.'}
          </p>
        </div>
        <div className="row-lg">
          <button
            type="button"
            className="btn-secondary"
            disabled
            title="CSV-Import folgt; bitte die Daten manuell erfassen"
          >
            <Icon name="Upload" className="tx-icon-xs" /> CSV-Upload
          </button>
          {darfBearbeiten ? (
            erfassen ? (
              <Link href={mitStand(`${basis}/laender`)} className="btn-secondary">
                <Icon name="X" className="tx-icon-xs" /> Erfassung schließen
              </Link>
            ) : (
              <Link href={`${basis}/laender?erfassen=1`} className="btn-secondary">
                <Icon name="Pencil" className="tx-icon-xs" /> Daten manuell erfassen
              </Link>
            )
          ) : (
            <button type="button" className="btn-secondary" disabled title={gesperrt}>
              <Icon name="Pencil" className="tx-icon-xs" /> Daten manuell erfassen
            </button>
          )}
        </div>
      </div>

      {erfasst ? (
        <div className="alert-success mb-4 text-sm" role="status">
          {erfasst} Länderstände gespeichert; frühere Stände bleiben in der Historie.
          {neueEreignisse
            ? ` Ereignis ${neueEreignisse.split(',').join(', ')} im Ereigniseingang angelegt.`
            : ''}
        </div>
      ) : null}

      <SchwellenKarte
        schwelle={ctx.schwelle}
        lfd={ctx.fernverkaeufeLfd}
        vorjahr={ctx.fernverkaeufeVorjahr}
        jahr={(ctx.laenderStand ?? ctx.stand).getUTCFullYear()}
        stand={ctx.laenderStand}
        quelle={ctx.laenderQuelle}
        erfasst={
          juengster ? { am: juengster.createdAt, von: personName(ctx, juengster.erfasstVon) } : null
        }
      />

      {erfassen ? (
        <>
          {ctx.laender.length ? (
            <SammelErfassung
              mandantId={id}
              laender={ctx.laender}
              heute={seite.heuteIso}
              zurueck={`${basis}/laender`}
            />
          ) : null}
          <LandHinzufuegenForm
            mandantId={id}
            vorhanden={ctx.laender.map((l) => l.land)}
            heute={seite.heuteIso}
          />
        </>
      ) : ctx.laender.length === 0 ? (
        <div className="card mt-4">
          <Leerzustand icon="Globe" text="Im Länder-Monitor sind noch keine Länder erfasst.">
            {darfBearbeiten ? (
              <Link href={`${basis}/laender?erfassen=1#land-neu`} className="btn-primary">
                <Icon name="Plus" /> Erstes Land erfassen
              </Link>
            ) : null}
          </Leerzustand>
        </div>
      ) : (
        <div className="card mt-4" style={{ overflow: 'hidden' }}>
          <div className="tbl-scroll">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Land</th>
                  <th className="td-num">Fernverkäufe lfd. Jahr</th>
                  <th>Lager seit</th>
                  <th>OSS</th>
                  <th>Lokale USt-Nr.</th>
                  <th title="ZM-relevante Bewegungen (Zusammenfassende Meldung)">ZM-relevant</th>
                  <th>Steuersätze geprüft am</th>
                  <th className="td-num">Offene Ereignisse</th>
                  <th>Registrierungsstatus</th>
                </tr>
              </thead>
              <tbody>
                {ctx.laender.map((l) => {
                  const fest = detail.feststellungen.get(l.land) ?? [];
                  const offen = ereignisseZumLand(ctx, detail, l.land).filter(
                    (e) => e.status === 'NEU' || e.status === 'IN_TRIAGE',
                  ).length;
                  const fehlt = l.registrierung === 'FEHLT';
                  return (
                    <tr
                      key={l.land}
                      className={auswahl?.land === l.land ? 'sel' : undefined}
                      style={
                        fehlt && auswahl?.land !== l.land
                          ? { backgroundColor: 'rgb(239 68 68 / 0.05)' }
                          : undefined
                      }
                    >
                      <td>
                        <Link
                          href={hrefLand(l.land)}
                          style={{ textDecoration: 'none', whiteSpace: 'nowrap' }}
                          title={`Details zu ${l.land} öffnen`}
                        >
                          <span className="text-sm font-m text-primary">{l.land}</span>{' '}
                          <span className="text-xs text-muted">{LAND_NAME[l.land] ?? ''}</span>
                        </Link>
                        {fehlt ? (
                          <div className="text-11 mt-1" style={{ color: '#b42318' }}>
                            Lager seit {fmtMonatJahr(l.lagerSeit)} ohne Registrierung
                            {fest[0] ? (
                              <>
                                ,{' '}
                                <Link
                                  href={mitStand(`${basis}/feststellungen/${fest[0].id}`)}
                                  style={{ textDecoration: 'underline', color: 'inherit' }}
                                >
                                  Feststellung {fest[0].nummer}
                                </Link>
                              </>
                            ) : null}
                          </div>
                        ) : ctx.laenderStand && l.stand.getTime() !== ctx.laenderStand.getTime() ? (
                          <div className="text-11 text-muted" style={{ whiteSpace: 'nowrap' }}>
                            Stand {fmtDatum(l.stand)}
                          </div>
                        ) : null}
                      </td>
                      <td>
                        <div className="row-between">
                          <span className="mono" style={{ marginLeft: 'auto' }}>
                            {fmtEurGanz(l.fernverkaeufeLfdEur)}
                          </span>
                        </div>
                        <span className="bar-micro">
                          <span className="bar-track">
                            <span
                              className={`bar-fill${fehlt ? ' a' : ''}`}
                              style={{
                                display: 'block',
                                width: `${(l.fernverkaeufeLfdEur / maxLfd) * 100}%`,
                              }}
                            />
                          </span>
                        </span>
                      </td>
                      <td className="text-sm text-secondary">
                        {l.lagerSeit ? (
                          <>
                            {fmtMonatJahr(l.lagerSeit)}
                            {lagerArt(l.land) ? (
                              <div className="text-11 text-muted">{lagerArt(l.land)}</div>
                            ) : null}
                          </>
                        ) : (
                          '–'
                        )}
                      </td>
                      <td>
                        <span className="row-s">
                          <span className={`status-dot ${l.oss ? 'dot-green' : 'dot-gray'}`} />
                          <span className="text-sm">{l.oss ? 'ja' : 'nein'}</span>
                        </span>
                      </td>
                      <td>
                        {l.lokaleUstNr ? (
                          <span className="badge-green">erteilt</span>
                        ) : l.lagerSeit ? (
                          <span className="badge-red">fehlt</span>
                        ) : (
                          <span className="text-sm text-secondary">–</span>
                        )}
                      </td>
                      <td className="text-sm">
                        {l.zmRelevant ? (
                          <span className="badge-yellow">ja</span>
                        ) : (
                          <span className="text-secondary">–</span>
                        )}
                      </td>
                      <td>
                        {l.steuersaetzeGeprueftAm ? (
                          <span className="text-sm text-secondary">
                            {fmtDatum(l.steuersaetzeGeprueftAm)}
                          </span>
                        ) : (
                          <span className="badge-yellow" title="Noch nicht geprüft">
                            prüfen
                          </span>
                        )}
                      </td>
                      <td className="td-num text-sm">{offen}</td>
                      <td>
                        <span className={REG_BADGE[l.registrierung]}>
                          {REG_TABELLE[l.registrierung]}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="card-footer" style={{ flexWrap: 'wrap', gap: 8 }}>
            <span>
              {ctx.laender.length} Länder im Monitor · Summe lfd. Jahr (EU-Ausland):{' '}
              <span className="mono">{fmtEurGanz(ctx.fernverkaeufeLfd)}</span>
            </span>
            <span className="text-11">
              Zeile öffnet den Länder-Drawer mit Historie, Risiken und Kontrollen
            </span>
          </div>
        </div>
      )}

      <div
        className="alert-info-sm mt-4"
        style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}
      >
        <Icon name="Info" />
        <span>
          Stufe 1: manuelle Erfassung; jede Erfassung legt einen neuen Stand an. Automatisierte
          Importe (Plattform-/Zahlungsreports, DATEV) folgen mit Stufe 2.
          {kanaele.length
            ? ` Verkaufskanäle laut Geschäftsprofil (P1): ${kanaele.join(', ')} – nicht je Land erfasst.`
            : ''}
        </span>
      </div>

      {auswahl ? (
        <DetailDrawer
          param="land"
          titel={`${auswahl.land} — Registrierungen und Fristen`}
          kopf={<LandDrawerKopf l={auswahl} lagerArt={lagerArt(auswahl.land)} />}
        >
          {(() => {
            const risiken = risikenZumLand(ctx, detail, auswahl.land);
            return (
              <LandDrawerInhalt
                ctx={ctx}
                l={auswahl}
                basis={basis}
                mitStand={mitStand}
                historie={detail.historie.get(auswahl.land) ?? []}
                feststellungen={detail.feststellungen.get(auswahl.land) ?? []}
                ereignisse={ereignisseZumLand(ctx, detail, auswahl.land)}
                risiken={risiken}
                kontrollen={kontrollenZumLand(ctx, detail, auswahl.land)}
                formular={
                  darfBearbeiten ? (
                    <LandStandForm mandantId={id} land={auswahl} heute={seite.heuteIso} />
                  ) : (
                    <button type="button" className="btn-primary" disabled title={gesperrt}>
                      <Icon name="Save" className="tx-icon-xs" /> Neuen Stand speichern
                    </button>
                  )
                }
              />
            );
          })()}
        </DetailDrawer>
      ) : null}
    </>
  );
}
