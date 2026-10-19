import { fmtEur, type PhasenInfo } from '@tcms/domain';
import { Icon } from '../icon';

/** Phasen-Stepper (bestehender Stepper der kanzleikonsole). */
const PHASEN_KURZ = [
  'Aufbau',
  'Risikoanalyse',
  'Kontrollplanung',
  'Beschreibung',
  'Angemessenheit dok.',
  'Wirksamkeitszeitraum',
  'Prüfung & Regelbetrieb',
];

export function PhasenStepper({
  phasen,
  aktiv,
  unterzeilen,
}: {
  phasen: PhasenInfo[];
  aktiv: number;
  unterzeilen?: Record<number, string>;
}) {
  return (
    <ol className="stepper stepper-lang stepper-phasen">
      {phasen.map((p, i) => {
        const zustand = p.nr < aktiv ? 'done' : p.nr === aktiv ? 'active' : '';
        return (
          <li key={p.nr} className={`step ${zustand}`}>
            <span className="step-dot">
              {zustand === 'done' ? <Icon name="Check" className="tx-icon-xs" /> : p.nr}
            </span>
            <span className="step-txt">
              <span className="step-title" title={p.name}>
                {p.nr} {PHASEN_KURZ[p.nr - 1] ?? p.name}
              </span>
              <span className="step-sub">
                {unterzeilen?.[p.nr] ??
                  (p.nr < aktiv ? 'Gate erfüllt' : p.nr === aktiv ? 'aktiv' : '')}
              </span>
            </span>
            {i < phasen.length - 1 ? <span className="step-line" /> : null}
          </li>
        );
      })}
    </ol>
  );
}

export function MiniSteps({
  aktiv,
  gesamt = 7,
  titel,
}: {
  aktiv: number;
  gesamt?: number;
  titel?: string[];
}) {
  return (
    <span className="mini-steps" aria-label={`Phase ${aktiv} von ${gesamt}`}>
      {Array.from({ length: gesamt }, (_, i) => (
        <span
          key={i}
          className={`mini-step ${i + 1 < aktiv ? 'done' : i + 1 === aktiv ? 'active' : ''}`}
          title={titel?.[i]}
        />
      ))}
    </span>
  );
}

export function BarRows({
  zeilen,
}: {
  zeilen: {
    label: string;
    wert: number;
    text?: string;
    farbe?: '' | 'g' | 'a' | 'r' | 'v' | 'muted';
  }[];
}) {
  const max = Math.max(1, ...zeilen.map((z) => z.wert));
  return (
    <div className="bars">
      {zeilen.map((z) => (
        <div key={z.label} className="bar-row">
          <span className="bar-label">{z.label}</span>
          <span className="bar-track">
            <span
              className={`bar-fill ${z.farbe && z.farbe !== 'muted' ? z.farbe : ''}`}
              style={{
                width: `${(z.wert / max) * 100}%`,
                ...(z.farbe === 'muted' ? { background: 'rgb(var(--text-muted))' } : {}),
              }}
            />
          </span>
          <span className="bar-val">{z.text ?? z.wert}</span>
        </div>
      ))}
    </div>
  );
}

export function Donut({
  teile,
  mitte,
  unter,
  groesse = 84,
}: {
  teile: { wert: number; farbe: string; label: string }[];
  mitte: string;
  unter: string;
  groesse?: number;
}) {
  const summe = teile.reduce((s, t) => s + t.wert, 0) || 1;
  let lauf = 0;
  const stops = teile
    .map((t) => {
      const von = (lauf / summe) * 100;
      lauf += t.wert;
      return `${t.farbe} ${von}% ${(lauf / summe) * 100}%`;
    })
    .join(', ');
  return (
    <div className="row-lg">
      <div
        className="donut"
        style={{ width: groesse, height: groesse, background: `conic-gradient(${stops})` }}
        role="img"
        aria-label={`${mitte} ${unter}`}
      >
        <div className="donut-center">
          <span className="v">{mitte}</span>
          <span className="l">{unter}</span>
        </div>
      </div>
      <div className="donut-legend">
        {teile.map((t) => (
          <span key={t.label} className="row-s">
            <span className="dot" style={{ background: t.farbe }} />
            <span>
              {t.wert} {t.label}
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}

/** EU-Lieferschwelle (Konzept 3.4.4): reine CSS-Anzeige mit Marken bei 80 und 100 %. */
export function SchwellenGauge({ anteil }: { anteil: number }) {
  const pct = Math.min(100, anteil * 100);
  const cls = anteil > 1 ? 'over' : anteil >= 0.8 ? 'warn' : 'ok';
  return (
    <div
      className="gauge"
      role="meter"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(anteil * 100)}
      aria-label="Anteil an der EU-Lieferschwelle"
    >
      <div className={`gauge-fill ${cls}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

/** Abweichung auf einer Skala mit Toleranzzone (Konzept 3.4.12). */
export function ToleranzSkala({
  wert,
  toleranz,
  erklaert,
}: {
  wert: number;
  toleranz: number;
  erklaert: boolean;
}) {
  const spanne = Math.max(toleranz * 10, Math.abs(wert) * 1.3, 1);
  const pos = (v: number) => Math.max(0, Math.min(100, 50 + (v / spanne) * 50));
  const innerhalb = Math.abs(wert) <= toleranz;
  const farbe = innerhalb ? 'ok' : erklaert ? 'warn' : 'bad';
  return (
    <div>
      <div className="tol">
        <div className="tol-track" />
        <div
          className="tol-zone"
          style={{ left: `${pos(-toleranz)}%`, width: `${pos(toleranz) - pos(-toleranz)}%` }}
        />
        <div className={`tol-marker ${farbe}`} style={{ top: -5, left: `${pos(wert)}%` }} />
      </div>
      <div className="tol-scale">
        <span>−{fmtEur(spanne)}</span>
        <span>0</span>
        <span>+{fmtEur(spanne)}</span>
      </div>
    </div>
  );
}

/** Kompakte Monatssegmente für Wirksamkeitszeiträume (Konzept 3.4.10). */
export function ZeitraumLeiste({ monate, aktuell }: { monate: string[]; aktuell: number }) {
  return (
    <div
      className="tl"
      style={
        monate.length !== 6
          ? { gridTemplateColumns: `repeat(${Math.max(1, monate.length)}, minmax(0, 1fr))` }
          : undefined
      }
    >
      {monate.map((m, i) => (
        <div
          key={m}
          className={`tl-seg ${i + 1 < aktuell ? 'done' : i + 1 === aktuell ? 'now' : ''}`}
        >
          {i + 1 < aktuell ? (
            <span className="tl-mark">
              <Icon name="Check" className="tx-icon-xs" />
            </span>
          ) : null}
          <span className="text-xs font-s">{m}</span>
        </div>
      ))}
    </div>
  );
}
