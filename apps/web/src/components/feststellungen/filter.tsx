'use client';

import { useEffect, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Save } from 'lucide-react';

const SCHLUESSEL = 'tcms-feststellungen-ansicht';
const FILTER = ['status', 'klasse', 'quelle', 'p153'] as const;

/** Filterleiste S10: Zustand im Query-String, gespeicherte Ansicht im Browser. */
export function FeststellungFilter({
  status,
  klassen,
  quellen,
}: {
  status: [string, string][];
  klassen: [string, string][];
  quellen: [string, string][];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [gespeichert, setGespeichert] = useState<string | null>(null);
  const [meldung, setMeldung] = useState<string | null>(null);

  useEffect(() => {
    try {
      setGespeichert(localStorage.getItem(SCHLUESSEL));
    } catch {
      /* Speicher nicht verfügbar */
    }
  }, []);

  const setze = (key: string, wert: string | null) => {
    const p = new URLSearchParams(params.toString());
    if (wert) p.set(key, wert);
    else p.delete(key);
    const q = p.toString();
    router.push(q ? `${pathname}?${q}` : pathname, { scroll: false });
  };

  const aktuelleAnsicht = () => {
    const p = new URLSearchParams();
    for (const k of FILTER) {
      const v = params.get(k);
      if (v) p.set(k, v);
    }
    return p.toString();
  };

  const hatFilter = FILTER.some((k) => params.get(k));
  const sel = { padding: '4px 8px', fontSize: 12 } as const;

  return (
    <div className="row-lg" style={{ flexWrap: 'wrap' }}>
      <select
        className="input"
        style={sel}
        aria-label="Status filtern"
        value={params.get('status') ?? ''}
        onChange={(e) => setze('status', e.target.value || null)}
      >
        <option value="">Alle Status</option>
        {status.map(([w, l]) => (
          <option key={w} value={w}>
            {l}
          </option>
        ))}
      </select>
      <select
        className="input"
        style={sel}
        aria-label="Klasse filtern"
        value={params.get('klasse') ?? ''}
        onChange={(e) => setze('klasse', e.target.value || null)}
      >
        <option value="">Alle Klassen</option>
        {klassen.map(([w, l]) => (
          <option key={w} value={w}>
            {l}
          </option>
        ))}
      </select>
      <select
        className="input"
        style={sel}
        aria-label="Quelle filtern"
        value={params.get('quelle') ?? ''}
        onChange={(e) => setze('quelle', e.target.value || null)}
      >
        <option value="">Alle Quellen</option>
        {quellen.map(([w, l]) => (
          <option key={w} value={w}>
            {l}
          </option>
        ))}
      </select>
      <label className="row-s text-xs text-secondary">
        <input
          type="checkbox"
          className="checkbox"
          checked={params.get('p153') === '1'}
          onChange={(e) => setze('p153', e.target.checked ? '1' : null)}
        />{' '}
        nur §-153 offen
      </label>
      {hatFilter ? (
        <button
          type="button"
          className="btn-secondary btn-tiny"
          title="Aktuelle Filter als Ansicht in diesem Browser speichern"
          onClick={() => {
            try {
              localStorage.setItem(SCHLUESSEL, aktuelleAnsicht());
              setGespeichert(aktuelleAnsicht());
              setMeldung('Ansicht gespeichert');
            } catch {
              setMeldung('Speichern nicht möglich');
            }
          }}
        >
          <Save className="tx-icon-xs" aria-hidden /> Ansicht speichern
        </button>
      ) : gespeichert ? (
        <button
          type="button"
          className="btn-secondary btn-tiny"
          title="Gespeicherte Filter anwenden"
          onClick={() => {
            const p = new URLSearchParams(gespeichert);
            const stand = params.get('stand');
            if (stand) p.set('stand', stand);
            router.push(`${pathname}?${p.toString()}`, { scroll: false });
          }}
        >
          <Save className="tx-icon-xs" aria-hidden /> Gespeicherte Ansicht
        </button>
      ) : (
        <button
          type="button"
          className="btn-secondary btn-tiny"
          disabled
          title="Erst Filter wählen, dann als Ansicht speichern"
        >
          <Save className="tx-icon-xs" aria-hidden /> Ansicht speichern
        </button>
      )}
      {hatFilter ? (
        <button
          type="button"
          className="text-xs text-muted"
          style={{ background: 'none', border: 0, cursor: 'pointer' }}
          onClick={() =>
            router.push(
              params.get('stand') ? `${pathname}?stand=${params.get('stand')}` : pathname,
              { scroll: false },
            )
          }
        >
          Filter zurücksetzen
        </button>
      ) : null}
      {meldung ? (
        <span className="text-11 text-muted" role="status">
          {meldung}
        </span>
      ) : null}
    </div>
  );
}
