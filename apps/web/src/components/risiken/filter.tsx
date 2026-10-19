'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  GRUPPE_LABEL,
  KLASSE_LABEL,
  SCHADEN_LABEL,
  WAHRSCHEINLICHKEIT_LABEL,
  type Schaden,
  type Wahrscheinlichkeit,
} from '@tcms/domain';
import { Icon } from '../icon';

export interface FilterWerte {
  gruppe: string;
  gt: string;
  klasse: string;
  appetit: boolean;
  uebersteuert: boolean;
  kern: boolean;
  neu: boolean;
  s: string;
  w: string;
}

const FILTER_KEYS = [
  'gruppe',
  'gt',
  'klasse',
  'appetit',
  'uebersteuert',
  'kern',
  'neu',
  's',
  'w',
] as const;

/** Filterzeile des Risikoinventars; Zustand liegt in den Query-Parametern. */
export function RisikoFilter({ werte, anzahlNeu }: { werte: FilterWerte; anzahlNeu: number }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const setze = (aenderung: Record<string, string | null>) => {
    const p = new URLSearchParams(params.toString());
    p.delete('risiko');
    for (const [k, v] of Object.entries(aenderung)) {
      if (v) p.set(k, v);
      else p.delete(k);
    }
    const q = p.toString();
    router.push(q ? `${pathname}?${q}` : pathname, { scroll: false });
  };
  const aktiv = FILTER_KEYS.some((k) => params.get(k));
  const sel = { padding: '5px 10px', fontSize: 13, width: 'auto' } as const;
  return (
    <div className="card p-4 mb-4">
      <div className="row-between" style={{ flexWrap: 'wrap', gap: 12, alignItems: 'flex-end' }}>
        <div className="row-lg" style={{ flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <span>
            <label className="label-sm" htmlFor="f-gruppe">
              Gruppe
            </label>
            <select
              id="f-gruppe"
              className="input"
              style={sel}
              value={werte.gruppe}
              onChange={(e) => setze({ gruppe: e.target.value || null })}
            >
              <option value="">Alle</option>
              {(Object.keys(GRUPPE_LABEL) as (keyof typeof GRUPPE_LABEL)[]).map((g) => (
                <option key={g} value={g}>
                  {g} · {GRUPPE_LABEL[g]}
                </option>
              ))}
            </select>
          </span>
          <span>
            <label className="label-sm" htmlFor="f-gt">
              Governance-Typ
            </label>
            <select
              id="f-gt"
              className="input"
              style={sel}
              value={werte.gt}
              onChange={(e) => setze({ gt: e.target.value || null })}
            >
              <option value="">Alle</option>
              <option value="FP">FP</option>
              <option value="FF">FF</option>
              <option value="IN">IN</option>
            </select>
          </span>
          <span>
            <label className="label-sm" htmlFor="f-klasse">
              Klasse (brutto)
            </label>
            <select
              id="f-klasse"
              className="input"
              style={sel}
              value={werte.klasse}
              onChange={(e) => setze({ klasse: e.target.value || null })}
            >
              <option value="">Alle</option>
              {(['GERING', 'MITTEL', 'HOCH', 'KRITISCH'] as const).map((k) => (
                <option key={k} value={k}>
                  {KLASSE_LABEL[k]}
                </option>
              ))}
            </select>
          </span>
          <label className="row-s text-sm text-secondary" style={{ paddingBottom: 7 }}>
            <input
              type="checkbox"
              className="checkbox"
              checked={werte.appetit}
              onChange={(e) => setze({ appetit: e.target.checked ? '1' : null })}
            />{' '}
            nur über Appetit
          </label>
          <label className="row-s text-sm text-secondary" style={{ paddingBottom: 7 }}>
            <input
              type="checkbox"
              className="checkbox"
              checked={werte.uebersteuert}
              onChange={(e) => setze({ uebersteuert: e.target.checked ? '1' : null })}
            />{' '}
            nur übersteuert
          </label>
          <label className="row-s text-sm text-secondary" style={{ paddingBottom: 7 }}>
            <input
              type="checkbox"
              className="checkbox"
              checked={werte.kern}
              onChange={(e) => setze({ kern: e.target.checked ? '1' : null })}
            />{' '}
            nur Kernrisiken
          </label>
          <label
            className="row-s text-sm text-secondary"
            style={{ paddingBottom: 7 }}
            title="Ereignis oder Profiländerung nach der letzten Bewertung"
          >
            <input
              type="checkbox"
              className="checkbox"
              checked={werte.neu}
              onChange={(e) => setze({ neu: e.target.checked ? '1' : null })}
            />{' '}
            nur „neu bewerten"
            {anzahlNeu ? <span className="badge-yellow">{anzahlNeu}</span> : null}
          </label>
        </div>
        <div className="row-s shrink0" style={{ paddingBottom: 3 }}>
          {werte.s && werte.w ? (
            <span className="badge-brand" title="Filter aus der Heatmap">
              S = {SCHADEN_LABEL[werte.s as Schaden] ?? werte.s} · W ={' '}
              {WAHRSCHEINLICHKEIT_LABEL[werte.w as Wahrscheinlichkeit] ?? werte.w}
              <button
                type="button"
                className="link"
                aria-label="Heatmap-Filter entfernen"
                onClick={() => setze({ s: null, w: null })}
                style={{ textDecoration: 'none', marginLeft: 4 }}
              >
                <Icon name="X" className="tx-icon-xs" />
              </button>
            </span>
          ) : null}
          <button
            type="button"
            className="btn-secondary"
            disabled={!aktiv}
            title={aktiv ? undefined : 'Kein Filter aktiv'}
            onClick={() => setze(Object.fromEntries(FILTER_KEYS.map((k) => [k, null])))}
          >
            <Icon name="RotateCcw" className="tx-icon-xs" /> Filter zurücksetzen
          </button>
        </div>
      </div>
    </div>
  );
}
