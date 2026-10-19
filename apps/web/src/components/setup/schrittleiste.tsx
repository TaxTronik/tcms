import Link from 'next/link';
import type { CSSProperties, ReactNode } from 'react';
import { fmtDatum, KLASSE_LABEL, MONATE, TURNUS_LABEL, type Pruflast } from '@tcms/domain';
import { Icon } from '../icon';
import { SCHRITTE } from './anzeige';

// =============================================================================
// Schrittleiste und Stufenkarten des Einrichtungsassistenten (Server).
// =============================================================================

const INNEN: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  minWidth: 0,
  textDecoration: 'none',
  color: 'inherit',
};

export function Schrittleiste({
  aktiv,
  abgeschlossen,
  href,
  unterzeilen,
}: {
  aktiv: number;
  abgeschlossen: number;
  href: (n: number) => string;
  unterzeilen: Record<number, string>;
}) {
  return (
    <ol className="stepper stepper-lang" aria-label="Schritte des Einrichtungsassistenten">
      {SCHRITTE.map((s, i) => {
        const zustand = s.nr === aktiv ? 'active' : s.nr <= abgeschlossen ? 'done' : '';
        const erreichbar = s.nr <= abgeschlossen + 1;
        const inhalt = (
          <>
            <span className="step-dot">
              {zustand === 'done' ? <Icon name="Check" className="tx-icon-xs" /> : s.nr}
            </span>
            <span className="step-txt">
              <span className="step-title">
                {s.nr} {s.titel}
              </span>
              <span className="step-sub">
                {unterzeilen[s.nr] ??
                  (zustand === 'done' ? 'erledigt' : zustand === 'active' ? 'aktuell' : 'offen')}
              </span>
            </span>
          </>
        );
        return (
          <li key={s.nr} className={`step ${zustand}`}>
            {erreichbar && s.nr !== aktiv ? (
              <Link href={href(s.nr)} style={INNEN}>
                {inhalt}
              </Link>
            ) : (
              <span style={INNEN} aria-current={s.nr === aktiv ? 'step' : undefined}>
                {inhalt}
              </span>
            )}
            {i < SCHRITTE.length - 1 ? <span className="step-line" /> : null}
          </li>
        );
      })}
    </ol>
  );
}

export const STUFEN_UNTERTITEL: Record<number, string> = {
  1: 'Festlegen, welcher Teilbereich mit welcher Paketvorlage eingerichtet wird; dazu Angemessenheits-Stichtag und Wirksamkeitszeitraum.',
  2: 'Die Antworten steuern Risikovorschlag (Schritt 4) und Kontrollvorschlag (Schritt 5).',
  3: 'Vorlagen aus dem Paket; Wesentlichkeitsgrenze und Risikoappetit je Ziel festlegen.',
  4: 'Vorschlag aus dem Paket auf Basis des Geschäftsprofils; Brutto-Startwerte aus dem Bewertungsmodell.',
  5: 'Vorlagen je übernommenem Risiko; Partei und Personen zuweisen, Frequenz aus der Häufigkeitsmatrix. Gegenzeichnung ist bei Schlüsselkontrollen Pflicht.',
};

/** Eingeklappte Stufe (erledigt oder offen) mit Kurzfassung. */
export function StufeZu({
  nr,
  titel,
  text,
  erledigt,
  href,
}: {
  nr: number;
  titel: string;
  text: string;
  erledigt: boolean;
  href: string | null;
}) {
  return (
    <div className={`card stage mb-4${erledigt ? ' done' : ''}`}>
      <div className="stage-head">
        <span className="num">{erledigt ? <Icon name="Check" className="tx-icon-xs" /> : nr}</span>
        <div className="grow">
          <div className={`stage-title${erledigt ? '' : ' text-muted'}`}>{titel}</div>
          <div className="stage-sub">{text}</div>
        </div>
        {href ? (
          <Link href={href} className="btn-secondary btn-tiny">
            {erledigt ? (
              <>
                <Icon name="Pencil" className="tx-icon-xs" /> Bearbeiten
              </>
            ) : (
              'Öffnen'
            )}
          </Link>
        ) : null}
      </div>
    </div>
  );
}

export function StufeOffen({
  nr,
  titel,
  children,
}: {
  nr: number;
  titel: string;
  children: ReactNode;
}) {
  return (
    <div className="card stage active mb-4" id={`schritt-${nr}`}>
      <div className="stage-head">
        <span className="num">{nr}</span>
        <div className="grow">
          <div className="stage-title">{titel}</div>
          <div className="stage-sub">{STUFEN_UNTERTITEL[nr]}</div>
        </div>
        <span className="badge-gray shrink0">Schritt {nr} von 5</span>
      </div>
      {children}
    </div>
  );
}

export interface ZusammenfassungDaten {
  teilbereich: string;
  stichtag: Date | null;
  wirksamAb: Date | null;
  wirksamBis: Date | null;
  turnus: 'MONATLICH' | 'QUARTALSWEISE' | 'JAEHRLICH';
  ziele: number;
  appetit: 'GERING' | 'MITTEL' | 'HOCH' | 'KRITISCH';
  freigabeAn: string | null;
  risiken: number;
  kern: number;
  abgelehnt: number;
  kontrollen: number;
  schluessel: number;
  durchfuehrungen: number;
  prueflast: Pruflast[];
}

export function Zusammenfassung({ d }: { d: ZusammenfassungDaten }) {
  const monat = (m: string) => `${MONATE[Number(m.slice(5, 7)) - 1]?.slice(0, 3)} ${m.slice(2, 4)}`;
  return (
    <div className="card mt-4">
      <div className="card-header">
        <span className="card-title">Zusammenfassung Version 1</span>
        <span className="badge-gray">Entwurf</span>
      </div>
      <div className="p-4">
        <div className="mini-kpis">
          <div className="mini-kpi">
            <div className="v">{d.risiken}</div>
            <div className="l">Risiken übernommen, davon {d.kern} Kernrisiken</div>
          </div>
          <div className="mini-kpi">
            <div className="v">{d.abgelehnt}</div>
            <div className="l">Vorschläge begründet abgelehnt</div>
          </div>
          <div className="mini-kpi">
            <div className="v">{d.kontrollen}</div>
            <div className="l">Kontrollen, davon {d.schluessel} Schlüsselkontrollen</div>
          </div>
          <div className="mini-kpi">
            <div className="v">{d.durchfuehrungen}</div>
            <div className="l">Durchführungen im Wirksamkeitszeitraum geplant</div>
          </div>
        </div>
        <div className="g12 mt-4">
          <div className="gc-6">
            <div className="col-s">
              {[
                ['Teilbereich', d.teilbereich],
                ['Angemessenheit zum Stichtag', fmtDatum(d.stichtag)],
                [
                  'Wirksamkeitszeitraum',
                  d.wirksamAb && d.wirksamBis
                    ? `${fmtDatum(d.wirksamAb)} – ${fmtDatum(d.wirksamBis)}`
                    : '—',
                ],
                ['Erklärungsturnus', TURNUS_LABEL[d.turnus]],
                [
                  'Compliance-Ziele',
                  `${d.ziele} · höchster Risikoappetit ${KLASSE_LABEL[d.appetit]}`,
                ],
                [
                  'Freigabe der Ziele',
                  d.freigabeAn ? `wird bei ${d.freigabeAn} angefordert` : 'keine Anforderung',
                ],
              ].map(([k, v]) => (
                <div key={k} className="row-between" style={{ gap: 12 }}>
                  <span className="text-sm text-secondary">{k}</span>
                  <span className="text-sm" style={{ textAlign: 'right' }}>
                    {v}
                  </span>
                </div>
              ))}
            </div>
          </div>
          <div className="gc-6">
            <div className="text-xs font-s text-secondary mb-2">
              Manuelle Prüflast je Monat (Prognose aus den geplanten Durchführungen)
            </div>
            <div className="tbl-scroll">
              <table className="tbl">
                <thead>
                  <tr>
                    <th style={{ padding: '6px 8px' }} />
                    {d.prueflast.map((p) => (
                      <th key={p.monat} className="td-num" style={{ padding: '6px 8px' }}>
                        {monat(p.monat)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {(['FP', 'FF', 'IN'] as const).map((gt) => (
                    <tr key={gt}>
                      <td style={{ padding: '6px 8px' }} className="text-xs">
                        {gt}
                      </td>
                      {d.prueflast.map((p) => (
                        <td key={p.monat} className="td-num text-xs" style={{ padding: '6px 8px' }}>
                          {p[gt]}
                        </td>
                      ))}
                    </tr>
                  ))}
                  <tr>
                    <td style={{ padding: '6px 8px' }} className="text-xs font-s">
                      gesamt
                    </td>
                    {d.prueflast.map((p) => (
                      <td
                        key={p.monat}
                        className="td-num text-xs font-s"
                        style={{ padding: '6px 8px' }}
                      >
                        {p.gesamt}
                      </td>
                    ))}
                  </tr>
                </tbody>
              </table>
            </div>
            <p className="hint">Zuzüglich anlassbezogener Prüfungen bei jeder Auslösung (FF/IN).</p>
          </div>
        </div>
        <p className="hint mt-3">
          Nach dem Anlegen steht das Tax-CMS in Phase 1 „Aufbau", bis die gesetzlichen Vertreter die
          Ziele freigeben. Inventarfreigabe im Vier-Augen-Prinzip und Designbeurteilung der
          Kontrollen folgen in Phase 2 und 3.
        </p>
      </div>
    </div>
  );
}
