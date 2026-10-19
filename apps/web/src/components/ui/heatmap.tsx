'use client';

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  KLASSE_LABEL,
  KLASSE_RANG,
  SCHADEN_LABEL,
  WAHRSCHEINLICHKEIT_LABEL,
  WAHRSCHEINLICHKEITEN,
  type Klasse,
  type Schaden,
  type Wahrscheinlichkeit,
} from '@tcms/domain';

export interface HeatRisiko {
  code: string;
  titel: string;
  s: Schaden;
  w: Wahrscheinlichkeit;
  brutto: Klasse;
  design: Klasse;
  betrieb: Klasse;
}

type Sicht = 'brutto' | 'design' | 'betrieb';

const NOTIZ: Record<Sicht, string> = {
  brutto: 'Bruttobewertung nach S × W; Reichweite 3 hebt um eine Klasse.',
  design: 'Netto (Design): Abschlag 1–2 durch angemessen beurteilte Kontrollen.',
  betrieb: 'Netto (Betrieb): Abschlag entfällt bei überfälliger oder beanstandeter Durchführung.',
};

/** Risiko-Heatmap 3 × 4 (Konzept 3.4.3): Zelle = S × W, Farbe = höchste Klasse der Sicht. */
export function RiskHeatmap({
  risiken,
  basis,
  gross,
}: {
  risiken: HeatRisiko[];
  basis: string;
  gross?: boolean;
}) {
  const [sicht, setSicht] = useState<Sicht>('brutto');
  const router = useRouter();
  const params = useSearchParams();
  const zaehler: Record<Klasse, number> = { KRITISCH: 0, HOCH: 0, MITTEL: 0, GERING: 0 };
  for (const r of risiken) zaehler[r[sicht]]++;
  const zellen = (['H', 'M', 'N'] as Schaden[]).flatMap((s) =>
    WAHRSCHEINLICHKEITEN.map((w) => {
      const drin = risiken.filter((r) => r.s === s && r.w === w);
      const max = drin.reduce<Klasse | null>(
        (m, r) => (!m || KLASSE_RANG[r[sicht]] > KLASSE_RANG[m] ? r[sicht] : m),
        null,
      );
      return { s, w, drin, max };
    }),
  );
  const oeffne = (s: Schaden, w: Wahrscheinlichkeit) => {
    const p = new URLSearchParams();
    const stand = params.get('stand');
    if (stand) p.set('stand', stand);
    p.set('s', s);
    p.set('w', w);
    router.push(`${basis}?${p.toString()}`);
  };
  return (
    <div>
      <div className="row-between mb-3" style={{ flexWrap: 'wrap', gap: 8 }}>
        <div className="toggle-group" role="tablist" aria-label="Bewertungssicht">
          {(
            [
              ['brutto', 'Brutto'],
              ['design', 'Netto Design'],
              ['betrieb', 'Netto Betrieb'],
            ] as [Sicht, string][]
          ).map(([k, l]) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={sicht === k}
              className={sicht === k ? 'active' : undefined}
              onClick={() => setSicht(k)}
            >
              {l}
            </button>
          ))}
        </div>
        <span className="text-11 text-muted mono">
          {zaehler.KRITISCH} / {zaehler.HOCH} / {zaehler.MITTEL} / {zaehler.GERING}{' '}
          kritisch/hoch/mittel/gering
        </span>
      </div>
      <div
        className="heatmap"
        role="grid"
        aria-label="Risiko-Heatmap"
        style={gross ? { gridTemplateColumns: '110px repeat(4, 1fr)' } : undefined}
      >
        <div className="hm-axis" />
        {WAHRSCHEINLICHKEITEN.map((w) => (
          <div key={w} className="hm-axis">
            {WAHRSCHEINLICHKEIT_LABEL[w]}
          </div>
        ))}
        {zellen.map(({ s, w, drin, max }) => (
          <Zelle
            key={`${s}-${w}`}
            s={s}
            w={w}
            drin={drin}
            max={max}
            sicht={sicht}
            gross={!!gross}
            onClick={() => oeffne(s, w)}
          />
        ))}
      </div>
      <div className="text-11 text-muted mt-3">
        {NOTIZ[sicht]} Zelle anklicken filtert das Inventar.
      </div>
    </div>
  );
}

function Zelle({
  s,
  w,
  drin,
  max,
  sicht,
  gross,
  onClick,
}: {
  s: Schaden;
  w: Wahrscheinlichkeit;
  drin: HeatRisiko[];
  max: Klasse | null;
  sicht: Sicht;
  gross: boolean;
  onClick: () => void;
}) {
  const cls = max ? `hm-${KLASSE_RANG[max]}` : 'hm-0';
  const titel = drin.length
    ? drin.map((r) => `${r.code} · ${KLASSE_LABEL[r[sicht]]}`).join('\n')
    : 'keine Risiken';
  return (
    <>
      {w === 'SELTEN' ? <div className="hm-axis">S = {SCHADEN_LABEL[s]}</div> : null}
      <button
        type="button"
        className={`hm-cell ${cls}`}
        title={titel}
        onClick={onClick}
        disabled={drin.length === 0}
        style={gross ? { minHeight: 76 } : undefined}
      >
        <span className="n">{drin.length || ''}</span>
        <span className="l">{max ? KLASSE_LABEL[max] : ''}</span>
      </button>
    </>
  );
}
