import { prisma } from '@tcms/db';
import { anmelden } from '@/server/actions/sitzung';
import { devLoginErlaubt } from '@/server/sitzung';

export const metadata = { title: 'Anmelden' };

const ROLLE: Record<string, string> = {
  BERUFSTRAEGER: 'Berufsträger:in',
  BEARBEITUNG: 'Bearbeitung',
  GESETZLICHER_VERTRETER: 'Gesetzliche Vertretung',
  TAX_COMPLIANCE_BEAUFTRAGTER: 'Tax-Compliance-Beauftragte:r',
  MITARBEITER: 'Mitarbeiter:in',
};

export default async function Anmelden({
  searchParams,
}: {
  searchParams: Promise<{ fehler?: string }>;
}) {
  const { fehler } = await searchParams;
  if (!devLoginErlaubt()) {
    return (
      <div className="page" style={{ maxWidth: 560, margin: '64px auto' }}>
        <h1 className="page-title">Anmeldung nicht verfügbar</h1>
        <p className="text-sm text-muted">
          Die Entwicklungs-Anmeldung ist deaktiviert. Für den Produktivbetrieb ist eine Anbindung an
          OIDC bzw. die kanzleikonsole vorgesehen.
        </p>
      </div>
    );
  }
  const personen = await prisma.person.findMany({
    where: { aktiv: true },
    include: { mandant: true },
    orderBy: [{ art: 'asc' }, { name: 'asc' }],
  });
  const kanzlei = personen.filter((p) => p.art === 'KANZLEI');
  const mandanten = new Map<string, typeof personen>();
  for (const p of personen.filter((x) => x.art === 'MANDANT')) {
    const k = p.mandant?.name ?? '—';
    mandanten.set(k, [...(mandanten.get(k) ?? []), p]);
  }
  const Karte = ({ p }: { p: (typeof personen)[number] }) => (
    <form action={anmelden}>
      <input type="hidden" name="personId" value={p.id} />
      <button
        type="submit"
        className="list-row w-full"
        style={{ background: 'none', border: 0, textAlign: 'left', cursor: 'pointer' }}
      >
        <span className="avatar">{p.kuerzel}</span>
        <span className="grow">
          <span className="text-sm font-m text-primary" style={{ display: 'block' }}>
            {p.name}
          </span>
          <span className="text-11 text-muted">
            {ROLLE[p.kanzleiRolle ?? p.mandantRolle ?? ''] ?? ''}
            {p.funktion ? ` · ${p.funktion}` : ''}
            {p.istAdmin ? ' · Admin' : ''}
          </span>
        </span>
      </button>
    </form>
  );
  return (
    <div className="page" style={{ maxWidth: 920, margin: '0 auto' }}>
      <h1 className="page-title mt-6">Tax-CMS · Anmeldung</h1>
      <p className="text-sm text-muted mb-4">
        Entwicklungs-Anmeldung per Personenauswahl (Demo-Daten, fiktiv). Vor einem Produktivbetrieb
        wird sie durch OIDC bzw. die kanzleikonsole ersetzt.
      </p>
      {fehler ? <div className="alert-error mb-4">Die Person wurde nicht gefunden.</div> : null}
      <div className="g12">
        <div className="card gc-6">
          <div className="card-header">
            <span className="card-title">Kanzlei</span>
          </div>
          {kanzlei.map((p) => (
            <Karte key={p.id} p={p} />
          ))}
        </div>
        <div className="card gc-6">
          <div className="card-header">
            <span className="card-title">Mandantenportal</span>
          </div>
          {[...mandanten.entries()].map(([name, liste]) => (
            <div key={name}>
              <div className="eyebrow px-4 mt-3">{name}</div>
              {liste.map((p) => (
                <Karte key={p.id} p={p} />
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
