import type { ReactNode } from 'react';
import { fmtDatumZeit } from '@tcms/domain';
import { AdminKopf, NurAdmin } from '@/components/admin/teile';
import { Icon } from '@/components/icon';
import { Leerzustand } from '@/components/ui/leer';
import { kannVerwalten } from '@tcms/service';
import { lies } from '@/server/demo';
import { brauchtKanzlei } from '@/server/sitzung';

export const metadata = { title: 'Postausgang (Entwicklung)' };

const TD = { padding: '10px 14px', verticalAlign: 'top' } as const;

/** Hebt sechsstellige Bestätigungscodes hervor, damit sie beim Testen schnell zu finden sind. */
function mitCodes(text: string): ReactNode[] {
  return text.split(/(\b\d{6}\b)/g).map((teil, i) =>
    /^\d{6}$/.test(teil) ? (
      <span key={i} className="badge-brand mono" title="Bestätigungscode">
        {teil}
      </span>
    ) : (
      <span key={i}>{teil}</span>
    ),
  );
}

export default async function Postausgang() {
  const nutzer = await brauchtKanzlei();
  if (!kannVerwalten(nutzer)) return <NurAdmin titel="Postausgang (Entwicklung)" />;
  const nachrichten = await lies((tx) =>
    tx.nachricht.findMany({
      orderBy: { createdAt: 'desc' },
      take: 200,
    }),
  );

  return (
    <div className="page">
      <AdminKopf
        titel="Postausgang"
        unter="Entwicklungsumgebung · Nachrichten an Mandanten und Kanzlei"
      />

      <div
        className="alert-warning mb-4 text-sm"
        role="note"
        style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}
      >
        <Icon name="Mail" />
        <span>
          <strong>Kein E-Mail-Versand.</strong> In der Entwicklung werden keine E-Mails versandt;
          Benachrichtigungen und Bestätigungscodes (z. B. für Freigaben im Portal) landen hier.
        </span>
      </div>

      <div className="card" style={{ overflow: 'hidden' }}>
        {nachrichten.length === 0 ? (
          <Leerzustand icon="Inbox" text="Der Postausgang ist leer." />
        ) : (
          <div className="tbl-scroll">
            <table className="tbl">
              <thead>
                <tr>
                  <th style={TD}>Zeit</th>
                  <th style={TD}>Empfänger</th>
                  <th style={TD}>Betreff</th>
                  <th style={TD}>Text</th>
                </tr>
              </thead>
              <tbody>
                {nachrichten.map((n) => (
                  <tr key={n.id}>
                    <td style={{ ...TD, whiteSpace: 'nowrap' }} className="text-xs mono">
                      {fmtDatumZeit(n.createdAt)}
                    </td>
                    <td style={{ ...TD, whiteSpace: 'nowrap' }} className="text-sm">
                      {n.an}
                    </td>
                    <td style={{ ...TD, minWidth: 200 }} className="text-sm font-m">
                      {n.betreff}
                    </td>
                    <td
                      style={{ ...TD, minWidth: 320, whiteSpace: 'pre-wrap' }}
                      className="text-xs text-secondary"
                    >
                      {mitCodes(n.text)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="card-footer">
          <span>
            {nachrichten.length} {nachrichten.length === 1 ? 'Nachricht' : 'Nachrichten'} · neueste
            zuerst
          </span>
        </div>
      </div>
    </div>
  );
}
