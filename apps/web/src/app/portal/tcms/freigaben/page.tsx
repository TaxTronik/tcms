import Link from 'next/link';
import { fmtDatumZeit, isoDatum } from '@tcms/domain';
import { Icon } from '@/components/icon';
import { ErledigtZeile, erledigtText, FreigabeKarte } from '@/components/portal/freigabe';
import { Leerzustand } from '@/components/ui/leer';
import { baueBausteine } from '@/server/beschreibung-daten';
import { ladeFreigaben, ladePostausgang } from '@/server/freigaben-daten';
import { ladeKontext } from '@/server/kontext';
import { darfLesen } from '@/server/portal-daten';
import { istGesetzlicherVertreter } from '@/server/rechte';
import { brauchtPortal, devLoginErlaubt } from '@/server/sitzung';
import { heute, jetzt } from '@/server/zeit';

export const metadata = { title: 'Freigaben und Kenntnisnahmen' };

export default async function PortalFreigaben({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const nutzer = await brauchtPortal();
  const sp = await searchParams;
  const erledigtId = Array.isArray(sp['erledigt']) ? sp['erledigt'][0] : sp['erledigt'];
  const [uebersicht, ctx] = await Promise.all([
    ladeFreigaben(nutzer.mandantId),
    ladeKontext(nutzer.mandantId, isoDatum(heute()), false),
  ]);
  const istGv = istGesetzlicherVertreter(nutzer);
  const lesen = darfLesen(nutzer);
  // Mitarbeitende sehen nur Anforderungen, die an sie gerichtet sind.
  const sichtbar = uebersicht.eintraege.filter((f) => lesen || f.empfaengerId === nutzer.id);
  const kann = (f: (typeof sichtbar)[number]) =>
    f.art === 'KENNTNISNAHME' ? f.empfaengerId === nutzer.id : istGv;
  const offen = sichtbar
    .filter((f) => f.status === 'OFFEN')
    .sort((a, b) => Number(kann(b)) - Number(kann(a)));
  const erledigt = sichtbar.filter((f) => f.status !== 'OFFEN');
  const gvNamen = (ctx?.mandantPersonen ?? [])
    .filter((p) => p.mandantRolle === 'GESETZLICHER_VERTRETER')
    .map((p) => p.name)
    .join(', ');
  const live =
    ctx?.programm && offen.some((f) => f.version && !f.version.snapshot)
      ? { stand: isoDatum(ctx.stand), satz: baueBausteine(ctx) }
      : null;
  const zeit = jetzt();
  const bestaetigt = erledigtId
    ? erledigt.find((f) => f.id === erledigtId && f.status === 'FREIGEGEBEN')
    : undefined;
  const post = devLoginErlaubt() ? await ladePostausgang(nutzer) : [];

  return (
    <div className="page">
      <h1 className="page-title">Freigaben und Kenntnisnahmen</h1>
      <p className="text-sm text-muted mb-4" style={{ maxWidth: 820 }}>
        Hier geben Sie Dokumente Ihres Compliance-Programms frei oder bestätigen, dass Sie sie zur
        Kenntnis genommen haben. Jede Bestätigung wird mit Name und Zeitpunkt dokumentiert.
      </p>

      {bestaetigt ? (
        <div className="alert-success mb-4 row-s" style={{ gap: 10 }} role="status">
          <Icon name="CheckCheck" />
          <span>
            <strong>{bestaetigt.titel}</strong>{' '}
            {bestaetigt.art === 'KENNTNISNAHME' ? 'zur Kenntnis genommen' : 'freigegeben'} ·{' '}
            {fmtDatumZeit(bestaetigt.erledigtAm)}. Vielen Dank – die Bestätigung ist mit Name und
            Zeitpunkt dokumentiert.
          </span>
        </div>
      ) : null}

      <div className="g12" style={{ alignItems: 'start' }}>
        <div className="gc-8 col" style={{ gap: 16 }}>
          <div className="card">
            <div className="card-header">
              <span className="card-title">Offen</span>
              <span className={offen.length ? 'badge-yellow' : 'badge-green'}>
                {offen.length ? `${offen.length} offen` : 'nichts offen'}
              </span>
            </div>
            {offen.length ? (
              <div className="p-4 col" style={{ gap: 14 }}>
                {offen.map((f) => (
                  <FreigabeKarte
                    key={f.id}
                    f={f}
                    nutzer={nutzer}
                    istGv={istGv}
                    lesen={lesen}
                    gvNamen={gvNamen}
                    live={live}
                    jetzt={zeit}
                  />
                ))}
              </div>
            ) : (
              <Leerzustand
                icon="CheckCheck"
                text="Derzeit liegt nichts zur Freigabe oder Kenntnisnahme vor."
              />
            )}
            <div className="card-footer">
              Freigaben sind der gesetzlichen Vertretung vorbehalten; Kenntnisnahmen bestätigt die
              adressierte Person.
            </div>
          </div>

          <div className="card">
            <div className="card-header">
              <span className="card-title">Erledigt</span>
              <span className="text-xs text-muted">
                {erledigt.length + (lesen ? uebersicht.fruehere.length : 0)}
              </span>
            </div>
            {erledigt.length || (lesen && uebersicht.fruehere.length) ? (
              <div>
                {erledigt.map((f) => {
                  const e = erledigtText(f);
                  return (
                    <ErledigtZeile
                      key={f.id}
                      titel={f.titel}
                      art={f.art}
                      text={e.text}
                      abgelehnt={e.abgelehnt}
                      hash={f.status === 'FREIGEGEBEN' ? f.version?.snapshotSha256 : null}
                    />
                  );
                })}
                {lesen
                  ? uebersicht.fruehere.map((v) => (
                      <ErledigtZeile
                        key={v.id}
                        titel={`CMS-Beschreibung v${v.nummer}`}
                        art="BESCHREIBUNG"
                        text={`freigegeben · ${v.freigegebenVon} · ${fmtDatumZeit(v.freigegebenAm)}${v.status === 'ABGELOEST' ? ' · inzwischen durch eine neuere Version abgelöst' : ''}`}
                        hash={v.snapshotSha256}
                      />
                    ))
                  : null}
              </div>
            ) : (
              <div className="p-4 text-sm text-muted">Noch keine erledigten Freigaben.</div>
            )}
          </div>
        </div>

        <div className="gc-4 col" style={{ gap: 16 }}>
          <div className="card">
            <div className="card-header">
              <span className="card-title">So funktioniert die Freigabe</span>
            </div>
            <div className="p-4 col" style={{ gap: 10 }}>
              {[
                [
                  'FileText',
                  'Dokument ansehen',
                  'Die vorgelegte Fassung ist eingefroren und durch einen SHA-256-Wert gebunden.',
                ],
                [
                  'Mail',
                  'Code anfordern',
                  'Sie erhalten einen 6-stelligen Code per E-Mail; er ist 7 Tage gültig.',
                ],
                [
                  'CheckCheck',
                  'Freigeben',
                  'Mit dem Code bestätigen Sie die Fassung. Nach fünf Fehlversuchen wird der Code gesperrt.',
                ],
              ].map(([icon, titel, text]) => (
                <div key={titel} className="row" style={{ alignItems: 'flex-start', gap: 10 }}>
                  <span className="icon-ring brand" style={{ width: 30, height: 30 }}>
                    <Icon name={icon!} className="tx-icon-xs" />
                  </span>
                  <div>
                    <div className="text-sm font-s">{titel}</div>
                    <div className="text-xs text-muted">{text}</div>
                  </div>
                </div>
              ))}
            </div>
            <div className="card-footer">
              Ein Hash bindet Inhalte; er ersetzt keine Unterschrift.
            </div>
          </div>

          {post.length ? (
            <details className="details-box" style={{ background: 'rgb(var(--surface-card))' }}>
              <summary>
                <Icon name="Mail" className="tx-icon-xs" /> Postausgang (nur Entwicklungsumgebung)
              </summary>
              <div className="details-body col" style={{ gap: 10 }}>
                <span className="text-11 text-muted">
                  In Stufe 1 werden keine E-Mails versandt. Die letzten Nachrichten an Sie:
                </span>
                {post.map((n) => (
                  <div
                    key={n.id}
                    className="p-3"
                    style={{ border: '1px solid rgb(var(--border-default))', borderRadius: 8 }}
                  >
                    <div className="text-xs font-s">{n.betreff}</div>
                    <div className="text-11 text-muted mb-1">{fmtDatumZeit(n.createdAt)}</div>
                    <div
                      className="text-xs"
                      style={{ whiteSpace: 'pre-line', wordBreak: 'break-word' }}
                    >
                      {n.text}
                    </div>
                  </div>
                ))}
              </div>
            </details>
          ) : null}

          <Link href="/portal/tcms" className="btn-secondary" style={{ justifyContent: 'center' }}>
            <Icon name="ArrowLeft" className="tx-icon-xs" /> Zur Übersicht
          </Link>
        </div>
      </div>
    </div>
  );
}
