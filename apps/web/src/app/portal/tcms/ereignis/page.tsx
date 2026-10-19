import Link from 'next/link';
import { prisma } from '@tcms/db';
import { EREIGNIS_STATUS_BADGE, fmtDatum, fmtDatumZeit, isoDatum } from '@tcms/domain';
import { Icon } from '@/components/icon';
import { Leerzustand } from '@/components/ui/leer';
import { PortalEreignisFormular } from '@/components/ereignisse/portal-formular';
import {
  darfPortalMelden,
  PORTAL_KACHELN,
  PORTAL_STATUS_LABEL,
  typInfo,
} from '@/server/ereignisse-daten';
import { brauchtPortal } from '@/server/sitzung';
import { heute } from '@/server/zeit';

export const metadata = { title: 'Ereignis melden' };

type SP = Record<string, string | string[] | undefined>;

export default async function PortalEreignisSeite({ searchParams }: { searchParams: Promise<SP> }) {
  const nutzer = await brauchtPortal();
  const sp = await searchParams;
  const gemeldetNr = Array.isArray(sp['gemeldet']) ? sp['gemeldet'][0] : sp['gemeldet'];

  const mandant = await prisma.mandant.findUnique({ where: { id: nutzer.mandantId } });
  const programm = await prisma.tcmsProgramm.findFirst({
    where: { mandantId: nutzer.mandantId },
    orderBy: { createdAt: 'desc' },
  });
  const bearbeitung = mandant
    ? await prisma.person.findUnique({ where: { id: mandant.bearbeitungId } })
    : null;

  const meldungen = programm
    ? await prisma.ereignis.findMany({
        where: { programmId: programm.id, quelle: 'PORTAL' },
        orderBy: { gemeldetAm: 'desc' },
        take: 20,
      })
    : [];
  const melderIds = [
    ...new Set(meldungen.map((m) => m.gemeldetVon).filter((x): x is string => !!x)),
  ];
  const melder = new Map(
    (
      await prisma.person.findMany({
        where: { id: { in: melderIds } },
        select: { id: true, name: true },
      })
    ).map((p) => [p.id, p.name]),
  );
  const bestaetigt = gemeldetNr ? meldungen.find((m) => m.nummer === gemeldetNr) : undefined;

  const darf = darfPortalMelden(nutzer);
  const sperrHinweis = darf
    ? null
    : 'Ereignisse melden die Geschäftsführung und die bzw. der Tax-Compliance-Beauftragte Ihres Unternehmens.';

  return (
    <div className="page">
      <Link className="back-link" href="/portal/tcms">
        <Icon name="ArrowLeft" className="tx-icon-xs" /> Zur Übersicht
      </Link>

      <h1 className="page-title">Ereignis melden</h1>
      <p className="text-sm text-muted mb-6" style={{ maxWidth: 820 }}>
        Melden Sie betriebliche Veränderungen. Ihre Kanzlei prüft und meldet sich bei Fragen — meist
        innerhalb eines Arbeitstags.
      </p>

      {!programm ? (
        <div className="card">
          <Leerzustand
            icon="ShieldCheck"
            text="Für Ihr Unternehmen ist noch kein Tax-CMS eingerichtet. Bitte wenden Sie sich an Ihre Kanzlei."
          />
        </div>
      ) : (
        <div className="g12">
          <div className="gc-7 col" style={{ gap: 16 }}>
            {bestaetigt ? (
              <div className="card">
                <div className="card-header">
                  <span className="card-title">Bestätigung</span>
                </div>
                <div className="p-4 col">
                  <div
                    className="alert-success"
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      textAlign: 'center',
                      gap: 10,
                    }}
                    role="status"
                  >
                    <span className="icon-ring green" style={{ width: 44, height: 44 }}>
                      <Icon name="Check" className="tx-icon-lg" />
                    </span>
                    <span className="font-s">Ereignis eingegangen</span>
                    <div
                      className="card p-2 mono text-sm"
                      style={{
                        boxShadow: 'none',
                        backgroundColor: 'rgb(var(--surface-raised))',
                        textAlign: 'center',
                      }}
                    >
                      Vorgangsnummer: {bestaetigt.nummer}
                    </div>
                    <span className="text-sm">
                      Gemeldet am {fmtDatumZeit(bestaetigt.gemeldetAm)} von{' '}
                      {melder.get(bestaetigt.gemeldetVon ?? '') ?? nutzer.name}. Ihre Kanzlei wurde
                      benachrichtigt.
                    </span>
                  </div>
                  <div>
                    <div className="text-sm font-s text-primary mb-2">So geht es weiter</div>
                    <ol
                      className="col-s text-sm text-secondary"
                      style={{ paddingLeft: 18, margin: 0 }}
                    >
                      <li>
                        Ihre Kanzlei sichtet die Meldung und entscheidet, welche Schritte nötig sind
                        – meist innerhalb eines Arbeitstags.
                      </li>
                      <li>
                        Bei Rückfragen meldet sich {bearbeitung?.name ?? 'Ihre Kanzlei'} bei Ihnen
                        {bearbeitung?.email ? ` (${bearbeitung.email})` : ''}.
                      </li>
                      <li>
                        Je nach Art der Änderung werden Steuersätze, Registrierungen oder Abläufe
                        geprüft; gegebenenfalls erhalten Sie dazu Aufgaben im Portal.
                      </li>
                      <li>
                        Den Bearbeitungsstand sehen Sie jederzeit rechts unter „Ihre bisherigen
                        Meldungen“.
                      </li>
                    </ol>
                  </div>
                  <div className="form-actions">
                    <Link href="/portal/tcms" className="btn-secondary">
                      Zurück zur Übersicht
                    </Link>
                    <Link href="/portal/tcms/ereignis" className="btn-primary">
                      Weiteres Ereignis melden
                    </Link>
                  </div>
                </div>
              </div>
            ) : (
              <>
                {sperrHinweis ? (
                  <div
                    className="alert-info-sm"
                    style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}
                  >
                    <Icon name="Info" className="tx-icon shrink0" />
                    <span>
                      {sperrHinweis} Bitte wenden Sie sich an diese Personen oder direkt an Ihre
                      Kanzlei.
                    </span>
                  </div>
                ) : null}
                <PortalEreignisFormular
                  kacheln={PORTAL_KACHELN}
                  heuteIso={isoDatum(heute())}
                  darf={darf}
                  sperrHinweis={sperrHinweis}
                />
              </>
            )}
          </div>

          <div className="gc-5 col" style={{ gap: 16 }}>
            <div className="card">
              <div className="card-header">
                <span className="card-title">Ihre bisherigen Meldungen</span>
                <span className="badge-gray">{meldungen.length}</span>
              </div>
              {meldungen.length === 0 ? (
                <Leerzustand icon="Inbox" text="Sie haben noch keine Ereignisse gemeldet." />
              ) : (
                <div>
                  {meldungen.map((m) => {
                    const t = typInfo(m.typ);
                    return (
                      <div
                        key={m.id}
                        className={`list-row${bestaetigt?.id === m.id ? ' sel' : ''}`}
                      >
                        <span className={`icon-ring ${t.ton}`}>
                          <Icon name={t.icon} />
                        </span>
                        <div className="grow" style={{ minWidth: 0 }}>
                          <div className="text-sm font-m text-primary">{m.titel}</div>
                          <div className="text-11 text-muted mt-1">
                            <span className="mono">{m.nummer}</span> · {fmtDatum(m.gemeldetAm)}
                            {m.gemeldetVon ? ` · ${melder.get(m.gemeldetVon) ?? ''}` : ''}
                          </div>
                        </div>
                        <span className={`${EREIGNIS_STATUS_BADGE[m.status]} shrink0`}>
                          {PORTAL_STATUS_LABEL[m.status]}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="card p-4">
              <span className="row" style={{ alignItems: 'flex-start' }}>
                <span className="icon-ring">
                  <Icon name="ShieldCheck" />
                </span>
                <span className="text-sm text-secondary grow">
                  Jede Meldung wird dokumentiert und auditgesichert. Rückfragen kommen von der
                  Kanzlei
                  {bearbeitung ? ` (Ansprechpartner: ${bearbeitung.name})` : ''}.
                </span>
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
