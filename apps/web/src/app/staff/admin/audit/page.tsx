import Link from 'next/link';
import { MAX_AUDIT_POS } from '@tcms/contract';
import { DEMO_MANDANTEN } from '@tcms/db/demo';
import { fmtDatumZeit } from '@tcms/domain';
import { AdminKopf, NurAdmin } from '@/components/admin/teile';
import { Icon } from '@/components/icon';
import { Hash } from '@/components/ui/badges';
import { AktionsForm, SubmitButton } from '@/components/ui/client';
import { Leerzustand } from '@/components/ui/leer';
import { pruefeHashkette } from '@/server/actions/admin';
import { imDienst, kannVerwalten, ladeAudit } from '@tcms/service';
import { DEMO_PORTS } from '@/server/demo';
import { brauchtKanzlei } from '@/server/sitzung';

export const metadata = { title: 'Audit-Log' };

const PRO_SEITE = 50;
/** Akteursart maskierter Einträge (ohne Namen). */
const AKTEUR_ART = { KANZLEI: 'Kanzlei', MANDANT: 'Mandant', SYSTEM: 'System' } as const;
const TD = { padding: '9px 10px', verticalAlign: 'top' } as const;
type SP = Record<string, string | string[] | undefined>;
const eins = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';

export default async function AuditLog({ searchParams }: { searchParams: Promise<SP> }) {
  const nutzer = await brauchtKanzlei();
  if (!kannVerwalten(nutzer)) return <NurAdmin titel="Audit-Log" />;
  const sp = await searchParams;
  // Filter nur in gültiger Form an den Service (sonst ignoriert); Mandanten aus dem Verzeichnis.
  const mandantRoh = eins(sp['mandant']);
  const mandantId = DEMO_MANDANTEN.some((m) => m.id === mandantRoh) ? mandantRoh : '';
  const aktionRoh = eins(sp['aktion']).trim();
  const aktion = /^[a-z0-9._]{1,100}$/.test(aktionRoh) ? aktionRoh : '';
  const vorRoh = eins(sp['vor']);
  const vor = /^[0-9]{1,10}$/.test(vorRoh)
    ? Math.min(Number(vorRoh), MAX_AUDIT_POS)
    : MAX_AUDIT_POS;

  // Audit des Tenants (Kette je Kanzlei, ADR 0001 §4) über @tcms/service, neueste zuerst.
  const seite = await imDienst(nutzer, DEMO_PORTS, (ctx) =>
    ladeAudit(ctx, {
      ...(mandantId ? { mandantId } : {}),
      ...(aktion ? { aktion } : {}),
      vor,
      limit: PRO_SEITE,
    }),
  );
  const eintraege = seite.eintraege;
  const letzter = seite.kopf;
  const mandanten = [...DEMO_MANDANTEN]
    .map((m) => ({ id: m.id, name: m.name }))
    .sort((x, y) => x.name.localeCompare(y.name, 'de'));
  const mandantName = new Map(mandanten.map((m) => [m.id, m.name]));
  const praefixe = [
    ...new Set(
      eintraege.flatMap((e) => {
        const t = e.aktion.split('.');
        return [t.slice(0, 2).join('.'), e.aktion];
      }),
    ),
  ].sort();

  const href = (v: number | null) => {
    const p = new URLSearchParams();
    if (mandantId) p.set('mandant', mandantId);
    if (aktion) p.set('aktion', aktion);
    if (v !== null) p.set('vor', String(v));
    const q = p.toString();
    return q ? `/staff/admin/audit?${q}` : '/staff/admin/audit';
  };
  const ersteSeite = vor === MAX_AUDIT_POS;

  return (
    <div className="page">
      <AdminKopf
        titel="Audit-Log"
        unter="Manipulationsevidentes Protokoll aller fachlichen Änderungen (SHA-256-Hashkette)"
      />

      <div className="g12 mb-4" style={{ alignItems: 'start' }}>
        <div className="card gc-8 p-4">
          <form
            method="get"
            action="/staff/admin/audit"
            className="row-lg"
            style={{ flexWrap: 'wrap', alignItems: 'flex-end' }}
          >
            <div>
              <label className="label-sm" htmlFor="a-m">
                Mandant
              </label>
              <select
                id="a-m"
                name="mandant"
                className="input"
                defaultValue={mandantId}
                style={{ maxWidth: 240 }}
              >
                <option value="">Alle</option>
                {mandanten.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label-sm" htmlFor="a-a">
                Aktion beginnt mit
              </label>
              <input
                id="a-a"
                name="aktion"
                className="input mono"
                list="a-praefixe"
                placeholder="z. B. tcms.durchfuehrung"
                defaultValue={aktion}
                style={{ width: 200, fontSize: 13 }}
              />
              <datalist id="a-praefixe">
                {praefixe.map((p) => (
                  <option key={p} value={p} />
                ))}
              </datalist>
            </div>
            <div className="row">
              <button type="submit" className="btn-secondary">
                <Icon name="Search" className="tx-icon-xs" /> Filtern
              </button>
              {mandantId || aktion ? (
                <Link href="/staff/admin/audit" className="btn-secondary">
                  Zurücksetzen
                </Link>
              ) : null}
            </div>
          </form>
        </div>

        <div className="card gc-4 p-4">
          <div className="row-between">
            <div>
              <div className="text-sm font-m">Integrität</div>
              <div className="text-11 text-muted mt-1">
                {letzter ? (
                  <>
                    Kettenende #{letzter.pos}
                    {letzter.hash ? (
                      <>
                        {' '}
                        · <Hash wert={letzter.hash} />
                      </>
                    ) : (
                      ' · Hash nicht angezeigt (vertrauliche Einträge)'
                    )}
                  </>
                ) : (
                  'noch keine Einträge'
                )}
              </div>
            </div>
            <AktionsForm action={pruefeHashkette}>
              <SubmitButton className="btn-secondary">
                <Icon name="ShieldCheck" className="tx-icon-xs" /> Hashkette prüfen
              </SubmitButton>
            </AktionsForm>
          </div>
        </div>
      </div>

      <div
        className="alert-info mb-4 text-sm"
        role="note"
        style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}
      >
        <Icon name="Info" />
        <span>
          Hashkette ohne qualifizierten Zeitstempel (RFC 3161 folgt). Ein Hash bindet Inhalte, er
          authentifiziert keine Person. Einträge werden nie geändert oder gelöscht.
        </span>
      </div>

      <div className="card" style={{ overflow: 'hidden' }}>
        {eintraege.length === 0 ? (
          <Leerzustand
            icon="Shield"
            text={
              mandantId || aktion
                ? 'Keine Einträge für diesen Filter.'
                : 'Noch keine Audit-Einträge.'
            }
          />
        ) : (
          <div className="tbl-scroll">
            <table className="tbl">
              <thead>
                <tr>
                  <th style={TD} className="td-num">
                    #
                  </th>
                  <th style={TD}>Zeit</th>
                  <th style={TD}>Person</th>
                  <th style={TD}>Aktion</th>
                  <th style={TD}>Objekt</th>
                  <th style={TD}>Mandant</th>
                  <th style={TD}>Hash</th>
                </tr>
              </thead>
              <tbody>
                {eintraege.map((e) => {
                  const m = e.mandantId ? mandantName.get(e.mandantId) : undefined;
                  // Vertrauliche Feststellung ohne Beteiligung: nur Art, Zeit, Objekt (Service).
                  const detail = e.maskiert ? '{}' : JSON.stringify(e.detail ?? {});
                  return (
                    <tr key={e.pos} id={`pos-${e.pos}`}>
                      <td style={TD} className="td-num text-xs">
                        {e.pos}
                      </td>
                      <td style={{ ...TD, whiteSpace: 'nowrap' }} className="text-xs mono">
                        {fmtDatumZeit(new Date(e.at))}
                      </td>
                      <td style={{ ...TD, whiteSpace: 'nowrap' }} className="text-sm">
                        {e.maskiert ? (
                          <span className="text-muted">
                            {e.akteurArt ? AKTEUR_ART[e.akteurArt] : '–'}{' '}
                            <span className="badge-gray">vertraulich</span>
                          </span>
                        ) : (
                          e.actorName
                        )}
                      </td>
                      <td style={TD}>
                        <span className="mono text-xs font-s">{e.aktion}</span>
                        {detail !== '{}' ? (
                          <div
                            className="text-11 text-muted mt-1 mono"
                            title={detail}
                            style={{
                              maxWidth: 300,
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {detail}
                          </div>
                        ) : null}
                      </td>
                      <td style={TD} className="text-xs">
                        {e.objektTyp}
                        <div className="mono text-muted text-11" title={e.objektId}>
                          …{e.objektId.slice(-8)}
                        </div>
                      </td>
                      <td style={{ ...TD, maxWidth: 170 }} className="text-xs text-secondary">
                        {m ?? <span className="text-muted">–</span>}
                      </td>
                      <td style={{ ...TD, whiteSpace: 'nowrap' }}>
                        {!e.maskiert && e.hash ? (
                          <span className="badge-gray" title={`prev ${e.prevHash ?? '–'}`}>
                            <Icon name="Lock" className="tx-icon-xs" /> <Hash wert={e.hash} />
                          </span>
                        ) : (
                          <span
                            className="text-muted text-xs"
                            title="Nicht angezeigt: hängt von vertraulichen Einträgen ab. Die Prüfung der Hashkette umfasst ihn."
                          >
                            –
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div className="card-footer">
          <span>
            {eintraege.length} {eintraege.length === 1 ? 'Eintrag' : 'Einträge'}
            {mandantId || aktion ? ' im Filter' : ''} · neueste zuerst · {PRO_SEITE} je Seite
          </span>
          <span className="row-s">
            {!ersteSeite ? (
              <Link href={href(null)} className="btn-secondary btn-tiny">
                <Icon name="ArrowLeft" className="tx-icon-xs" /> neueste
              </Link>
            ) : null}
            {seite.weiter !== null ? (
              <Link href={href(seite.weiter)} className="btn-secondary btn-tiny">
                ältere <Icon name="ChevronRight" className="tx-icon-xs" />
              </Link>
            ) : null}
          </span>
        </div>
      </div>
    </div>
  );
}
