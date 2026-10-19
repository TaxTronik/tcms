import Link from 'next/link';
import type { Prisma } from '@tcms/db';
import { fmtDatumZeit } from '@tcms/domain';
import { AdminKopf, NurAdmin, Seiten } from '@/components/admin/teile';
import { Icon } from '@/components/icon';
import { Hash } from '@/components/ui/badges';
import { AktionsForm, SubmitButton } from '@/components/ui/client';
import { Leerzustand } from '@/components/ui/leer';
import { pruefeHashkette } from '@/server/actions/admin';
import { kannVerwalten } from '@tcms/service';
import { lies } from '@/server/demo';
import { brauchtKanzlei } from '@/server/sitzung';

export const metadata = { title: 'Audit-Log' };

const PRO_SEITE = 50;
const TD = { padding: '9px 10px', verticalAlign: 'top' } as const;
type SP = Record<string, string | string[] | undefined>;
const eins = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';

export default async function AuditLog({ searchParams }: { searchParams: Promise<SP> }) {
  const nutzer = await brauchtKanzlei();
  if (!kannVerwalten(nutzer)) return <NurAdmin titel="Audit-Log" />;
  const sp = await searchParams;
  const mandantId = eins(sp['mandant']);
  const aktion = eins(sp['aktion']).trim();
  const seiteRoh = Number.parseInt(eins(sp['seite']) || '1', 10);

  // Audit des Tenants (Kette je Kanzlei, ADR 0001 §4); alles in einer Transaktion.
  const { programme, mandanten, aktionen, gesamt, seiten, seite, eintraege, letzter } = await lies(
    async (tx) => {
      const programme = await tx.tcmsProgramm.findMany({
        select: { id: true, mandant: { select: { id: true, name: true } } },
      });
      const mandanten = await tx.mandant.findMany({
        orderBy: { name: 'asc' },
        select: { id: true, name: true },
      });
      const aktionen = await tx.auditEvent.findMany({
        distinct: ['aktion'],
        select: { aktion: true },
        orderBy: { aktion: 'asc' },
      });
      const where: Prisma.AuditEventWhereInput = {};
      if (mandantId)
        where.programmId = {
          in: programme.filter((p) => p.mandant.id === mandantId).map((p) => p.id),
        };
      if (aktion) where.aktion = { startsWith: aktion };
      const gesamt = await tx.auditEvent.count({ where });
      const seiten = Math.max(1, Math.ceil(gesamt / PRO_SEITE));
      const seite = Math.min(Math.max(1, Number.isFinite(seiteRoh) ? seiteRoh : 1), seiten);
      const eintraege = await tx.auditEvent.findMany({
        where,
        orderBy: { seq: 'desc' },
        skip: (seite - 1) * PRO_SEITE,
        take: PRO_SEITE,
      });
      const letzter = await tx.auditEvent.findFirst({
        orderBy: { seq: 'desc' },
        select: { seq: true, hash: true, at: true },
      });
      return { programme, mandanten, aktionen, gesamt, seiten, seite, eintraege, letzter };
    },
  );
  const mandantJeProgramm = new Map(programme.map((p) => [p.id, p.mandant]));

  const praefixe = [
    ...new Set(
      aktionen.flatMap((a) => {
        const t = a.aktion.split('.');
        return [t.slice(0, 2).join('.'), a.aktion];
      }),
    ),
  ].sort();

  const href = (s: number) => {
    const p = new URLSearchParams();
    if (mandantId) p.set('mandant', mandantId);
    if (aktion) p.set('aktion', aktion);
    if (s > 1) p.set('seite', String(s));
    const q = p.toString();
    return q ? `/staff/admin/audit?${q}` : '/staff/admin/audit';
  };

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
                    Kettenende #{letzter.seq} · <Hash wert={letzter.hash} />
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
                  const m = e.programmId ? mandantJeProgramm.get(e.programmId) : undefined;
                  const detail = JSON.stringify(e.detail ?? {});
                  return (
                    <tr key={e.seq} id={`seq-${e.seq}`}>
                      <td style={TD} className="td-num text-xs">
                        {e.seq}
                      </td>
                      <td style={{ ...TD, whiteSpace: 'nowrap' }} className="text-xs mono">
                        {fmtDatumZeit(e.at)}
                      </td>
                      <td style={{ ...TD, whiteSpace: 'nowrap' }} className="text-sm">
                        {e.actorName}
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
                        {m ? m.name : <span className="text-muted">–</span>}
                      </td>
                      <td style={{ ...TD, whiteSpace: 'nowrap' }}>
                        <span className="badge-gray" title={`prev ${e.prevHash}`}>
                          <Icon name="Lock" className="tx-icon-xs" /> <Hash wert={e.hash} />
                        </span>
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
            {gesamt} {gesamt === 1 ? 'Eintrag' : 'Einträge'}
            {mandantId || aktion ? ' im Filter' : ''} · neueste zuerst · {PRO_SEITE} je Seite
          </span>
          <Seiten seite={seite} seiten={seiten} href={href} />
        </div>
      </div>
    </div>
  );
}
