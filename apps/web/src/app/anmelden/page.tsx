import { DEMO_MANDANTEN } from '@tcms/db/demo';
import { anmelden } from '@/server/actions/sitzung';
import { demoPersonen, type DemoPerson } from '@/server/demo';
import { demoLoginErlaubt } from '@/server/sitzung';

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
  if (!demoLoginErlaubt()) {
    return (
      <div className="page" style={{ maxWidth: 560, margin: '64px auto' }}>
        <h1 className="page-title">Anmeldung nicht verfügbar</h1>
        <p className="text-sm text-muted">
          Die Demo-Anmeldung ist in Produktion immer deaktiviert. Das Tax-CMS ist ein interner
          Dienst der kanzleikonsole; Anmeldung und Personen verwaltet die kanzleikonsole.
        </p>
      </div>
    );
  }
  // Statisches Demo-Verzeichnis (ersetzt die frühere Tabelle Person).
  const personen = [...demoPersonen.alle()].sort((a, b) => a.name.localeCompare(b.name, 'de'));
  const kanzlei = personen.filter((p) => p.art === 'KANZLEI');
  const mandanten = new Map<string, DemoPerson[]>();
  for (const p of personen.filter((x) => x.art === 'MANDANT')) {
    const k = DEMO_MANDANTEN.find((m) => m.id === p.mandantId)?.name ?? '—';
    mandanten.set(k, [...(mandanten.get(k) ?? []), p]);
  }
  const Karte = ({ p }: { p: DemoPerson }) => (
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
            {ROLLE[
              p.art === 'KANZLEI'
                ? p.istBerufstraeger
                  ? 'BERUFSTRAEGER'
                  : 'BEARBEITUNG'
                : (p.rolle ?? '')
            ] ?? ''}
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
        Demo-Anmeldung per Personenauswahl (Demo-Daten, fiktiv). Im Zielbild meldet die
        kanzleikonsole die Person an und ruft das Tax-CMS als internen Dienst auf.
      </p>
      {fehler ? (
        <div className="alert-error mb-4">
          {fehler === 'rolle'
            ? 'Für diese Person ist beim Mandanten keine aktive Rolle hinterlegt.'
            : 'Die Person wurde nicht gefunden.'}
        </div>
      ) : null}
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
