'use client';

import { useId, useState, type ReactNode } from 'react';
import {
  EU_LAENDER,
  LAGER_ART_LABEL,
  LAGER_ARTEN,
  LAND_NAME,
  lagerOhneRegistrierung,
  MARKTPLAETZE,
  PROFIL_FRAGEN,
  schlageRisikenVor,
  ZAHLUNGSWEGE,
  type Geschaeftsprofil,
  type LagerArt,
} from '@tcms/domain';
import { Icon } from '../icon';

// =============================================================================
// Formular für das Geschäftsprofil P1–P12 (Einrichtungsassistent Schritt 2 und
// Profiländerung). Kontrollierte Komponente; die Prüfung erfolgt serverseitig.
// =============================================================================

export interface PersonInfo {
  id: string;
  name: string;
  funktion: string | null;
  rolle: string;
}

const LAGER_LAENDER = [...EU_LAENDER, 'CH', 'GB'];
const SYSTEM_ARTEN = [
  'Shop',
  'Marktplatz-Tool',
  'Warenwirtschaft',
  'FiBu',
  'Schnittstelle',
  'Sonstiges',
];

const landLabel = (c: string) => (LAND_NAME[c] ? `${LAND_NAME[c]} (${c})` : c);

/** Monat (YYYY-MM) des fachlichen Heute (Demo-Datum) aus dem Server; Browser-Uhr nur als Rückfall. */
function monatAus(heuteIso?: string): string {
  if (heuteIso) return heuteIso.slice(0, 7);
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function Gruppe({ titel, children }: { titel: string; children: ReactNode }) {
  return (
    <div className="mb-4">
      <div className="text-xs font-s text-secondary mb-2">{titel}</div>
      {children}
    </div>
  );
}

function Frage({ nr, titel, children }: { nr: string; titel: string; children: ReactNode }) {
  return (
    <div className="mb-3">
      <span className="label-sm">
        {nr} · {titel}
      </span>
      {children}
    </div>
  );
}

function JaNein({
  label,
  wert,
  onChange,
}: {
  label: string;
  wert: boolean;
  onChange: (b: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="row-between" style={{ gap: 16 }}>
      <label className="text-sm text-secondary" htmlFor={id}>
        {label}
      </label>
      <select
        id={id}
        className="input shrink0"
        value={wert ? 'ja' : 'nein'}
        onChange={(e) => onChange(e.target.value === 'ja')}
      >
        <option value="ja">Ja</option>
        <option value="nein">Nein</option>
      </select>
    </div>
  );
}

function Haken({
  label,
  wert,
  onChange,
}: {
  label: string;
  wert: boolean;
  onChange: (b: boolean) => void;
}) {
  return (
    <label className="row-s">
      <input
        type="checkbox"
        className="checkbox"
        checked={wert}
        onChange={(e) => onChange(e.target.checked)}
      />{' '}
      <span className="text-sm">{label}</span>
    </label>
  );
}

function Mehrfach({
  optionen,
  werte,
  onChange,
}: {
  optionen: readonly string[];
  werte: string[];
  onChange: (w: string[]) => void;
}) {
  return (
    <div className="row-wrap" style={{ gap: '6px 14px' }}>
      {optionen.map((o) => (
        <Haken
          key={o}
          label={o}
          wert={werte.includes(o)}
          onChange={(b) => onChange(b ? [...werte, o] : werte.filter((w) => w !== o))}
        />
      ))}
    </div>
  );
}

/** Länder als ISO-Codes mit Mehrfachauswahl (Badges + Auswahlliste). */
export function LaenderChips({
  werte,
  onChange,
  auswahl = EU_LAENDER,
  frei = false,
  label,
}: {
  werte: string[];
  onChange: (w: string[]) => void;
  auswahl?: readonly string[];
  frei?: boolean;
  label: string;
}) {
  const [eingabe, setEingabe] = useState('');
  const uebrig = auswahl.filter((c) => !werte.includes(c));
  const hinzu = (c: string) => {
    const code = c.trim().toUpperCase();
    if (/^[A-Z]{2}$/.test(code) && !werte.includes(code)) onChange([...werte, code]);
    setEingabe('');
  };
  return (
    <div className="row" style={{ flexWrap: 'wrap' }}>
      {werte.map((c) => (
        <span key={c} className="badge-brand mono" title={LAND_NAME[c] ?? c}>
          {c}
          <button
            type="button"
            className="unstyled"
            style={{ background: 'none', border: 0, padding: 0, lineHeight: 0 }}
            aria-label={`${c} entfernen`}
            onClick={() => onChange(werte.filter((w) => w !== c))}
          >
            <Icon name="X" className="tx-icon-xs" />
          </button>
        </span>
      ))}
      {frei ? (
        <input
          className="input"
          style={{ width: 140, padding: '5px 10px', fontSize: 13 }}
          placeholder="ISO-Code, Enter …"
          aria-label={label}
          value={eingabe}
          maxLength={2}
          onChange={(e) => setEingabe(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              hinzu(eingabe);
            }
          }}
          onBlur={() => eingabe && hinzu(eingabe)}
        />
      ) : (
        <select
          className="input"
          style={{ padding: '5px 10px', fontSize: 13 }}
          aria-label={label}
          value=""
          onChange={(e) => e.target.value && hinzu(e.target.value)}
        >
          <option value="">Land …</option>
          {uebrig.map((c) => (
            <option key={c} value={c}>
              {landLabel(c)}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

/** Freitext-Liste als Badges (z. B. Anbieter, Ein-/Ausschlüsse). */
export function TextChips({
  werte,
  onChange,
  label,
  ton = 'badge-brand',
  breite = 200,
  className = 'row',
}: {
  werte: string[];
  onChange: (w: string[]) => void;
  label: string;
  ton?: string;
  breite?: number;
  className?: string;
}) {
  const [eingabe, setEingabe] = useState('');
  const hinzu = () => {
    const t = eingabe.trim();
    if (t && !werte.includes(t)) onChange([...werte, t]);
    setEingabe('');
  };
  return (
    <div className={className} style={{ flexWrap: 'wrap' }}>
      {werte.map((w) => (
        <span key={w} className={ton}>
          {w}
          <button
            type="button"
            style={{ background: 'none', border: 0, padding: 0, lineHeight: 0, color: 'inherit' }}
            aria-label={`${w} entfernen`}
            onClick={() => onChange(werte.filter((x) => x !== w))}
          >
            <Icon name="X" className="tx-icon-xs" />
          </button>
        </span>
      ))}
      <input
        className="input"
        style={{ width: breite, padding: '5px 10px', fontSize: 13 }}
        placeholder="Eintrag hinzufügen …"
        aria-label={label}
        value={eingabe}
        onChange={(e) => setEingabe(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            hinzu();
          }
        }}
        onBlur={() => eingabe.trim() && hinzu()}
      />
    </div>
  );
}

function ZahlFeld({
  label,
  wert,
  onChange,
  einheit = '€',
  max,
}: {
  label: string;
  wert: number;
  onChange: (n: number) => void;
  einheit?: string;
  max?: number;
}) {
  const id = useId();
  return (
    <div className="row-between" style={{ gap: 16 }}>
      <label className="text-sm text-secondary" htmlFor={id}>
        {label}
      </label>
      <span className="row-s shrink0">
        <input
          id={id}
          type="number"
          className="input mono"
          style={{ width: 160, textAlign: 'right' }}
          min={0}
          max={max}
          step={1}
          value={Number.isFinite(wert) ? wert : 0}
          onChange={(e) => onChange(e.target.value === '' ? 0 : Number(e.target.value))}
        />
        <span className="text-sm text-muted">{einheit}</span>
      </span>
    </div>
  );
}

const titel = (key: keyof Geschaeftsprofil) => PROFIL_FRAGEN.find((f) => f.key === key)!;

export function ProfilFormular({
  wert,
  onChange,
  personen,
  heuteIso,
}: {
  wert: Geschaeftsprofil;
  heuteIso?: string;
  onChange: (p: Geschaeftsprofil) => void;
  /** Gesetzliche Vertretung und TCB aus den Stammdaten (P12, nur Anzeige). */
  personen: PersonInfo[];
}) {
  const p = wert;
  const setze = <K extends keyof Geschaeftsprofil>(key: K, teil: Partial<Geschaeftsprofil[K]>) =>
    onChange({ ...p, [key]: { ...p[key], ...teil } });
  const ohneReg = lagerOhneRegistrierung(p);
  const vorschlaege = schlageRisikenVor(p);
  const F = (key: keyof Geschaeftsprofil) => ({ nr: titel(key).nr, titel: titel(key).titel });

  return (
    <div>
      <Gruppe titel="Kanäle & Fulfillment">
        <Frage {...F('p1')}>
          <div className="row-wrap" style={{ gap: '6px 14px' }}>
            <Haken
              label="Eigener Shop"
              wert={p.p1.eigenerShop}
              onChange={(b) => setze('p1', { eigenerShop: b })}
            />
            {p.p1.eigenerShop ? (
              <input
                className="input"
                style={{ width: 220, padding: '5px 10px', fontSize: 13 }}
                placeholder="Shopsystem, z. B. Shopware 6"
                aria-label="Shopsystem"
                value={p.p1.shopSystem}
                onChange={(e) => setze('p1', { shopSystem: e.target.value })}
              />
            ) : null}
          </div>
          <div className="mt-2">
            <Mehrfach
              optionen={MARKTPLAETZE}
              werte={p.p1.marktplaetze}
              onChange={(w) => setze('p1', { marktplaetze: w })}
            />
          </div>
        </Frage>
        <Frage {...F('p2')}>
          <div className="mb-2">
            <Haken
              label="Eigenversand ab Deutschland"
              wert={p.p2.eigenversandDE}
              onChange={(b) => setze('p2', { eigenversandDE: b })}
            />
          </div>
          <div className="col-s">
            {p.p2.lager.map((l, i) => (
              <div key={i} className="row">
                <select
                  className="input"
                  title="Land"
                  aria-label="Lagerland"
                  value={l.land}
                  onChange={(e) =>
                    setze('p2', {
                      lager: p.p2.lager.map((x, j) =>
                        j === i ? { ...x, land: e.target.value } : x,
                      ),
                    })
                  }
                >
                  {LAGER_LAENDER.map((c) => (
                    <option key={c} value={c}>
                      {landLabel(c)}
                    </option>
                  ))}
                </select>
                <input
                  type="month"
                  className="input"
                  style={{ width: 'auto' }}
                  title="Beginn"
                  aria-label="Beginn"
                  value={l.seit}
                  onChange={(e) =>
                    setze('p2', {
                      lager: p.p2.lager.map((x, j) =>
                        j === i ? { ...x, seit: e.target.value } : x,
                      ),
                    })
                  }
                />
                <select
                  className="input"
                  title="Art"
                  aria-label="Art des Lagers"
                  value={l.art}
                  onChange={(e) =>
                    setze('p2', {
                      lager: p.p2.lager.map((x, j) =>
                        j === i ? { ...x, art: e.target.value as LagerArt } : x,
                      ),
                    })
                  }
                >
                  {LAGER_ARTEN.map((a) => (
                    <option key={a} value={a}>
                      {LAGER_ART_LABEL[a]}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="icon-action"
                  title="Zeile entfernen"
                  aria-label="Zeile entfernen"
                  onClick={() => setze('p2', { lager: p.p2.lager.filter((_, j) => j !== i) })}
                >
                  <Icon name="X" />
                </button>
              </div>
            ))}
          </div>
          <div className="mt-2">
            <button
              type="button"
              className="btn-secondary btn-tiny"
              onClick={() =>
                setze('p2', {
                  lager: [
                    ...p.p2.lager,
                    {
                      land: p.p2.lager.length ? 'PL' : 'DE',
                      seit: monatAus(heuteIso),
                      art: 'EIGEN',
                    },
                  ],
                })
              }
            >
              <Icon name="Plus" className="tx-icon-xs" /> Land hinzufügen
            </button>
          </div>
        </Frage>
      </Gruppe>

      <Gruppe titel="Märkte & Kunden">
        <Frage {...F('p3')}>
          <LaenderChips
            label="Zielland hinzufügen"
            werte={p.p3.laender}
            onChange={(w) => setze('p3', { laender: w })}
          />
          <div className="row-wrap mt-2" style={{ gap: '6px 18px' }}>
            <span className="row-s">
              <span className="text-sm text-secondary">B2B-Anteil</span>
              <input
                type="number"
                className="input mono"
                min={0}
                max={100}
                style={{ width: 80, textAlign: 'right' }}
                aria-label="B2B-Anteil in Prozent"
                value={p.p3.b2bAnteilProzent}
                onChange={(e) =>
                  setze('p3', {
                    b2bAnteilProzent: e.target.value === '' ? 0 : Number(e.target.value),
                  })
                }
              />
              <span className="text-sm text-muted">%</span>
            </span>
            <Haken
              label="EU-B2B-Verkäufe"
              wert={p.p3.b2bEU}
              onChange={(b) => setze('p3', { b2bEU: b })}
            />
            <Haken
              label="Inland-B2B-Verkäufe"
              wert={p.p3.b2bInland}
              onChange={(b) => setze('p3', { b2bInland: b })}
            />
          </div>
        </Frage>
        <Frage {...F('p6')}>
          <Mehrfach
            optionen={ZAHLUNGSWEGE}
            werte={p.p6.zahlungswege}
            onChange={(w) => setze('p6', { zahlungswege: w })}
          />
        </Frage>
        <Frage {...F('p7')}>
          <div className="col-s">
            <JaNein
              label="Eigene Gutscheine (Einzweck/Mehrzweck)"
              wert={p.p7.gutscheine}
              onChange={(b) => setze('p7', { gutscheine: b })}
            />
            <JaNein
              label="Abonnements"
              wert={p.p7.abos}
              onChange={(b) => setze('p7', { abos: b })}
            />
            <JaNein
              label="Bundles"
              wert={p.p7.bundles}
              onChange={(b) => setze('p7', { bundles: b })}
            />
          </div>
        </Frage>
      </Gruppe>

      <Gruppe titel="Sortiment & Systeme">
        <Frage {...F('p4')}>
          <div className="col-s">
            {p.p4.warengruppen.map((w, i) => (
              <div key={i} className="row">
                <input
                  className="input"
                  style={{ maxWidth: 320 }}
                  placeholder="Warengruppe"
                  aria-label="Warengruppe"
                  value={w.name}
                  onChange={(e) =>
                    setze('p4', {
                      warengruppen: p.p4.warengruppen.map((x, j) =>
                        j === i ? { ...x, name: e.target.value } : x,
                      ),
                    })
                  }
                />
                <Haken
                  label="abweichender Steuersatz"
                  wert={w.abweichenderSatz}
                  onChange={(b) =>
                    setze('p4', {
                      warengruppen: p.p4.warengruppen.map((x, j) =>
                        j === i ? { ...x, abweichenderSatz: b } : x,
                      ),
                    })
                  }
                />
                <button
                  type="button"
                  className="icon-action"
                  title="Zeile entfernen"
                  aria-label="Zeile entfernen"
                  onClick={() =>
                    setze('p4', { warengruppen: p.p4.warengruppen.filter((_, j) => j !== i) })
                  }
                >
                  <Icon name="X" />
                </button>
              </div>
            ))}
          </div>
          <div className="mt-2 mb-2">
            <button
              type="button"
              className="btn-secondary btn-tiny"
              onClick={() =>
                setze('p4', {
                  warengruppen: [...p.p4.warengruppen, { name: '', abweichenderSatz: false }],
                })
              }
            >
              <Icon name="Plus" className="tx-icon-xs" /> Warengruppe hinzufügen
            </button>
          </div>
          <JaNein
            label="Gebrauchtware / Differenzbesteuerung"
            wert={p.p4.gebrauchtware}
            onChange={(b) => setze('p4', { gebrauchtware: b })}
          />
        </Frage>
        <Frage {...F('p5')}>
          <JaNein
            label="Import aus Drittländern"
            wert={p.p5.drittlandImport}
            onChange={(b) => setze('p5', { drittlandImport: b })}
          />
          {p.p5.drittlandImport ? (
            <div className="col-s mt-2">
              <LaenderChips
                label="Herkunftsland hinzufügen"
                frei
                werte={p.p5.laender}
                onChange={(w) => setze('p5', { laender: w })}
              />
              <div className="row-between" style={{ gap: 16 }}>
                <span className="text-sm text-secondary">Zollabwicklung</span>
                <input
                  className="input shrink0"
                  style={{ width: 260 }}
                  placeholder="z. B. Spediteur mit indirekter Vertretung"
                  aria-label="Zollabwicklung"
                  value={p.p5.zollabwicklung}
                  onChange={(e) => setze('p5', { zollabwicklung: e.target.value })}
                />
              </div>
            </div>
          ) : null}
        </Frage>
        <Frage {...F('p8')}>
          <div className="col-s">
            {p.p8.systeme.map((s, i) => (
              <div key={i} className="row">
                <select
                  className="input"
                  aria-label="Systemart"
                  value={SYSTEM_ARTEN.includes(s.art) ? s.art : 'Sonstiges'}
                  onChange={(e) =>
                    setze('p8', {
                      systeme: p.p8.systeme.map((x, j) =>
                        j === i ? { ...x, art: e.target.value } : x,
                      ),
                    })
                  }
                >
                  {SYSTEM_ARTEN.map((a) => (
                    <option key={a}>{a}</option>
                  ))}
                </select>
                <input
                  className="input"
                  style={{ maxWidth: 240 }}
                  placeholder="System"
                  aria-label="System"
                  value={s.name}
                  onChange={(e) =>
                    setze('p8', {
                      systeme: p.p8.systeme.map((x, j) =>
                        j === i ? { ...x, name: e.target.value } : x,
                      ),
                    })
                  }
                />
                <input
                  className="input"
                  style={{ maxWidth: 110 }}
                  placeholder="Version"
                  aria-label="Version"
                  value={s.version}
                  onChange={(e) =>
                    setze('p8', {
                      systeme: p.p8.systeme.map((x, j) =>
                        j === i ? { ...x, version: e.target.value } : x,
                      ),
                    })
                  }
                />
                <button
                  type="button"
                  className="icon-action"
                  title="Zeile entfernen"
                  aria-label="Zeile entfernen"
                  onClick={() => setze('p8', { systeme: p.p8.systeme.filter((_, j) => j !== i) })}
                >
                  <Icon name="X" />
                </button>
              </div>
            ))}
          </div>
          <div className="mt-2">
            <button
              type="button"
              className="btn-secondary btn-tiny"
              onClick={() =>
                setze('p8', { systeme: [...p.p8.systeme, { art: 'Shop', name: '', version: '' }] })
              }
            >
              <Icon name="Plus" className="tx-icon-xs" /> System hinzufügen
            </button>
          </div>
        </Frage>
      </Gruppe>

      <Gruppe titel="Organisation">
        <Frage {...F('p9')}>
          <div className="row-wrap" style={{ gap: '6px 18px' }}>
            <span className="row-s">
              <Haken
                label="OSS-Registrierung seit"
                wert={p.p9.ossSeit != null}
                onChange={(b) => setze('p9', { ossSeit: b ? monatAus(heuteIso) : null })}
              />
              {p.p9.ossSeit != null ? (
                <input
                  type="month"
                  className="input"
                  style={{ width: 'auto' }}
                  aria-label="OSS seit"
                  value={p.p9.ossSeit}
                  onChange={(e) => setze('p9', { ossSeit: e.target.value || null })}
                />
              ) : null}
            </span>
            <Haken label="IOSS" wert={p.p9.ioss} onChange={(b) => setze('p9', { ioss: b })} />
            <Haken
              label="Dauerfristverlängerung"
              wert={p.p9.dauerfrist}
              onChange={(b) => setze('p9', { dauerfrist: b })}
            />
          </div>
          <div className="row mt-2" style={{ flexWrap: 'wrap' }}>
            <span className="text-sm text-secondary">Lokale USt-Registrierungen:</span>
            <LaenderChips
              label="Registrierungsland hinzufügen"
              auswahl={LAGER_LAENDER.filter((c) => c !== 'DE')}
              werte={p.p9.lokaleUstNr}
              onChange={(w) => setze('p9', { lokaleUstNr: w })}
            />
          </div>
          {ohneReg.length ? (
            <p className="hint" style={{ color: '#b42318' }}>
              Hinweis:{' '}
              {ohneReg
                .map((l) => `Lager ${l.land} seit ${l.seit.slice(5, 7)}/${l.seit.slice(0, 4)}`)
                .join(', ')}{' '}
              ohne lokale USt-Registrierung – als Feststellung prüfen (P9).
            </p>
          ) : null}
        </Frage>
        <Frage {...F('p10')}>
          <div className="col-s">
            <ZahlFeld
              label="Vorjahresumsatz"
              wert={p.p10.vorjahresumsatzEur}
              onChange={(n) => setze('p10', { vorjahresumsatzEur: n })}
            />
            <ZahlFeld
              label="EU-Fernverkäufe Vorjahr"
              wert={p.p10.euFernverkaeufeVorjahrEur}
              onChange={(n) => setze('p10', { euFernverkaeufeVorjahrEur: n })}
            />
            <ZahlFeld
              label="EU-Fernverkäufe laufendes Jahr"
              wert={p.p10.euFernverkaeufeLfdEur}
              onChange={(n) => setze('p10', { euFernverkaeufeLfdEur: n })}
            />
          </div>
        </Frage>
        <Frage {...F('p11')}>
          <JaNein
            label="Eingangsleistungen ausländischer Plattformen, Werbe- oder SaaS-Anbieter"
            wert={p.p11.vorhanden}
            onChange={(b) => setze('p11', { vorhanden: b })}
          />
          {p.p11.vorhanden ? (
            <div className="mt-2">
              <TextChips
                label="Anbieter hinzufügen"
                werte={p.p11.anbieter}
                onChange={(w) => setze('p11', { anbieter: w })}
              />
            </div>
          ) : null}
        </Frage>
        <Frage {...F('p12')}>
          <div className="col-s">
            {personen.map((x) => (
              <div key={x.id} className="row-between" style={{ gap: 16 }}>
                <span className="text-sm text-secondary">{x.rolle}</span>
                <span className="text-sm">
                  {x.name}
                  {x.funktion ? <span className="text-muted"> ({x.funktion})</span> : null}
                </span>
              </div>
            ))}
            <div className="row-between" style={{ gap: 16 }}>
              <span className="text-sm text-secondary">Buchhaltung</span>
              <select
                className="input shrink0"
                aria-label="Buchhaltung"
                value={p.p12.buchhaltung}
                onChange={(e) =>
                  setze('p12', { buchhaltung: e.target.value as 'KANZLEI' | 'INTERN' })
                }
              >
                <option value="KANZLEI">über die Kanzlei</option>
                <option value="INTERN">intern beim Mandanten</option>
              </select>
            </div>
            <p className="hint">
              Personen stammen aus den Stammdaten des Mandanten; ein Wechsel ist Ereignis T-12.
            </p>
          </div>
        </Frage>
      </Gruppe>

      <div className="alert-info-sm text-sm">
        Aus diesen Angaben folgen {vorschlaege.length} Risikovorschläge, davon{' '}
        {vorschlaege.filter((v) => v.kern).length} Kernrisiken. Der Vorschlag ist deterministisch
        und nennt je Risiko seinen Grund.
      </div>
    </div>
  );
}
