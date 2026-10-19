'use client';

import { useState, type ReactNode } from 'react';
import {
  KLASSE_LABEL,
  MIN_BEGRUENDUNG,
  type Geschaeftsprofil,
  type GovernanceTyp,
  type Klasse,
} from '@tcms/domain';
import type { Ergebnis } from '@/server/ergebnis';
import { Icon } from '../icon';
import { GtBadge, KlasseBadge } from '../ui/badges';
import { ProfilFormular, TextChips, type PersonInfo } from '../profil/profil-formular';
import {
  dauerText,
  type Appetit,
  type EntwurfKontrolle,
  type EntwurfRisiko,
  type EntwurfZiel,
  type SetupEntwurf,
} from './entwurf';
import { SetupForm } from './setup-form';

type Aktion = (prev: Ergebnis, fd: FormData) => Promise<Ergebnis>;

interface Basis {
  aktion: Aktion;
  mandantId: string;
  darf: boolean;
  gesperrtGrund?: string;
}

// ---------------------------------------------------------------------------
// Schritt 1: Teilbereich und Zeiträume
// ---------------------------------------------------------------------------

export function SchrittTeilbereich({
  start,
  paket,
  ...b
}: Basis & {
  start: Pick<SetupEntwurf, 'teilbereich' | 'zeitraum'>;
  paket: { name: string; version: string; risiken: number; kontrollen: number; fragen: number };
}) {
  const [tb, setTb] = useState(start.teilbereich);
  const [zr, setZr] = useState(start.zeitraum);
  const dauer = dauerText(zr.wirksamAb, zr.wirksamBis);
  return (
    <SetupForm
      {...b}
      schritt={1}
      daten={{ teilbereich: tb, zeitraum: zr }}
      hinweis="Entwurf jederzeit speicherbar; noch keine Version angelegt."
    >
      <div className="stage-body with-rule">
        <div className="col" style={{ gap: 10 }}>
          <label className="card stage active" style={{ display: 'block', cursor: 'pointer' }}>
            <span className="stage-head">
              <input type="radio" name="paket" className="checkbox" checked readOnly />
              <span className="grow">
                <span className="stage-title">{tb.name}</span>{' '}
                <span className="stage-sub">
                  Paket „{paket.name} v{paket.version}" · {paket.risiken} Risiken ·{' '}
                  {paket.kontrollen} Kontrollvorlagen · {paket.fragen} Profilfragen
                </span>
              </span>
              <Icon name="CheckCircle2" />
            </span>
          </label>
          {['Organschaft', 'Lohnsteuer'].map((n) => (
            <label key={n} className="card stage" style={{ display: 'block' }}>
              <span className="stage-head">
                <input type="radio" name="paket" className="checkbox" disabled />
                <span className="grow">
                  <span className="stage-title text-muted">{n} (geplant)</span>{' '}
                  <span className="stage-sub">Paket in Vorbereitung — noch nicht verfügbar.</span>
                </span>
              </span>
            </label>
          ))}
        </div>

        <div className="mt-4">
          <label className="label" htmlFor="abgrenzung">
            Abgrenzungstext
          </label>
          <textarea
            id="abgrenzung"
            className="input"
            rows={4}
            value={tb.abgrenzung}
            onChange={(e) => setTb({ ...tb, abgrenzung: e.target.value })}
          />
          <p className="hint">
            Erscheint in der CMS-Beschreibung, Abschnitt 0 „Teilbereich &amp; Abgrenzung". Die
            Abgrenzung verantworten die gesetzlichen Vertreter.
          </p>
        </div>

        <div className="mt-3">
          <span className="label">Ein-/Ausschlüsse</span>
          <div className="col-s">
            <div className="row" style={{ alignItems: 'flex-start' }}>
              <span className="badge-green shrink0" style={{ marginTop: 4 }}>
                Einschluss
              </span>
              <TextChips
                className="row grow"
                label="Einschluss hinzufügen"
                werte={tb.einschluesse}
                onChange={(w) => setTb({ ...tb, einschluesse: w })}
              />
            </div>
            <div className="row" style={{ alignItems: 'flex-start' }}>
              <span className="badge-gray shrink0" style={{ marginTop: 4 }}>
                Ausschluss
              </span>
              <TextChips
                className="row grow"
                label="Ausschluss hinzufügen"
                ton="badge-gray"
                werte={tb.ausschluesse}
                onChange={(w) => setTb({ ...tb, ausschluesse: w })}
              />
            </div>
          </div>
        </div>

        <div className="mt-4">
          <span className="label">Zeiträume und Erklärungsturnus</span>
          <div className="row-lg" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div>
              <label className="label-sm" htmlFor="stichtag">
                Angemessenheit zum Stichtag
              </label>
              <input
                id="stichtag"
                type="date"
                className="input"
                style={{ width: 'auto' }}
                value={zr.angemessenheitStichtag}
                onChange={(e) => setZr({ ...zr, angemessenheitStichtag: e.target.value })}
              />
            </div>
            <div>
              <label className="label-sm" htmlFor="wirksam-ab">
                Wirksamkeitszeitraum von
              </label>
              <input
                id="wirksam-ab"
                type="date"
                className="input"
                style={{ width: 'auto' }}
                value={zr.wirksamAb}
                onChange={(e) => setZr({ ...zr, wirksamAb: e.target.value })}
              />
            </div>
            <div>
              <label className="label-sm" htmlFor="wirksam-bis">
                bis
              </label>
              <input
                id="wirksam-bis"
                type="date"
                className="input"
                style={{ width: 'auto' }}
                value={zr.wirksamBis}
                onChange={(e) => setZr({ ...zr, wirksamBis: e.target.value })}
              />
            </div>
            <div>
              <label className="label-sm" htmlFor="turnus">
                Erklärungsturnus (UStVA)
              </label>
              <select
                id="turnus"
                className="input"
                value={zr.erklaerungsTurnus}
                onChange={(e) =>
                  setZr({
                    ...zr,
                    erklaerungsTurnus: e.target
                      .value as SetupEntwurf['zeitraum']['erklaerungsTurnus'],
                  })
                }
              >
                <option value="MONATLICH">monatlich</option>
                <option value="QUARTALSWEISE">quartalsweise</option>
                <option value="JAEHRLICH">jährlich</option>
              </select>
            </div>
          </div>
          <p className="hint">
            {dauer ? `Wirksamkeitszeitraum: ${dauer}. ` : ''}Regelmäßig mindestens ein halbes
            Geschäftsjahr (vgl. Tz. 61); Beginn nach dem Angemessenheits-Stichtag. Der
            Erklärungsturnus bestimmt „jede Periode" der Häufigkeitsmatrix (FP).
          </p>
        </div>
      </div>
    </SetupForm>
  );
}

// ---------------------------------------------------------------------------
// Schritt 2: Geschäftsprofil
// ---------------------------------------------------------------------------

export function SchrittProfil({
  start,
  personen,
  heuteIso,
  ...b
}: Basis & { start: Geschaeftsprofil; personen: PersonInfo[]; heuteIso: string }) {
  const [profil, setProfil] = useState(start);
  return (
    <SetupForm
      {...b}
      schritt={2}
      daten={{ profil }}
      hinweis="Änderungen am Profil setzen Risiko- und Kontrollvorschlag neu auf."
    >
      <div className="stage-body with-rule">
        <ProfilFormular
          wert={profil}
          onChange={setProfil}
          personen={personen}
          heuteIso={heuteIso}
        />
      </div>
    </SetupForm>
  );
}

// ---------------------------------------------------------------------------
// Schritt 3: Compliance-Ziele
// ---------------------------------------------------------------------------

const APPETITE: Appetit[] = ['MITTEL', 'HOCH', 'GERING'];

export function SchrittZiele({
  start,
  gv,
  ...b
}: Basis & {
  start: Pick<SetupEntwurf, 'ziele' | 'freigabe'>;
  gv: { id: string; name: string }[];
}) {
  const [ziele, setZiele] = useState<EntwurfZiel[]>(start.ziele);
  const [freigabe, setFreigabe] = useState(start.freigabe);
  const [bearbeiten, setBearbeiten] = useState<string | null>(null);
  const aendere = (key: string, teil: Partial<EntwurfZiel>) =>
    setZiele(ziele.map((z) => (z.key === key ? { ...z, ...teil } : z)));
  return (
    <SetupForm
      {...b}
      schritt={3}
      daten={{ ziele, freigabe }}
      hinweis="Ziele und Risikoappetit entscheidet der Mandant; die Kanzlei bereitet vor."
    >
      <div className="stage-body with-rule">
        <div className="col" style={{ gap: 10 }}>
          {ziele.map((z) => (
            <div key={z.key} className="card p-3" style={z.aktiv ? undefined : { opacity: 0.65 }}>
              <div className="row mb-2" style={{ alignItems: 'flex-start' }}>
                <input
                  type="checkbox"
                  className="checkbox mt-1"
                  checked={z.aktiv}
                  title="Ziel übernehmen"
                  aria-label="Ziel übernehmen"
                  onChange={(e) => aendere(z.key, { aktiv: e.target.checked })}
                />
                {z.eigen || bearbeiten === z.key ? (
                  <textarea
                    className="input grow"
                    rows={2}
                    style={{ minHeight: 56 }}
                    placeholder="Ziel formulieren …"
                    aria-label="Zieltext"
                    value={z.text}
                    onChange={(e) => aendere(z.key, { text: e.target.value })}
                  />
                ) : (
                  <div className="text-sm font-s grow">{z.text}</div>
                )}
                {z.eigen ? (
                  <button
                    type="button"
                    className="icon-action"
                    title="Ziel entfernen"
                    aria-label="Ziel entfernen"
                    onClick={() => setZiele(ziele.filter((x) => x.key !== z.key))}
                  >
                    <Icon name="X" />
                  </button>
                ) : (
                  <button
                    type="button"
                    className="icon-action"
                    title={bearbeiten === z.key ? 'Bearbeitung beenden' : 'Text anpassen'}
                    aria-label="Text anpassen"
                    onClick={() => setBearbeiten(bearbeiten === z.key ? null : z.key)}
                  >
                    <Icon name={bearbeiten === z.key ? 'Check' : 'Pencil'} className="tx-icon-xs" />
                  </button>
                )}
              </div>
              <div
                className="row-between"
                style={{ flexWrap: 'wrap', gap: 12, alignItems: 'flex-end' }}
              >
                <div className="row-lg" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
                  <div>
                    <label className="label-sm" htmlFor={`w-${z.key}`}>
                      Wesentlichkeitsgrenze
                    </label>
                    <span className="row-s">
                      <input
                        id={`w-${z.key}`}
                        type="number"
                        min={0}
                        step={100}
                        className="input mono"
                        style={{ width: 120, textAlign: 'right' }}
                        value={z.wesentlichkeitEur}
                        onChange={(e) =>
                          aendere(z.key, {
                            wesentlichkeitEur:
                              e.target.value === '' ? 0 : Math.round(Number(e.target.value)),
                          })
                        }
                      />
                      <span className="text-sm text-muted">€</span>
                    </span>
                  </div>
                  <div>
                    <label className="label-sm" htmlFor={`a-${z.key}`}>
                      Risikoappetit
                    </label>
                    <select
                      id={`a-${z.key}`}
                      className="input"
                      value={z.risikoappetit}
                      onChange={(e) => aendere(z.key, { risikoappetit: e.target.value as Appetit })}
                    >
                      {APPETITE.map((a) => (
                        <option key={a} value={a}>
                          {KLASSE_LABEL[a]}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                <div className="row-s shrink0">
                  {!z.aktiv ? (
                    <span className="badge-gray">nicht übernommen</span>
                  ) : freigabe.anfordern ? (
                    <span
                      className="badge-yellow"
                      title="Die Freigabe wird mit Version 1 im Portal angefordert"
                    >
                      Mandantenfreigabe ausstehend
                    </span>
                  ) : (
                    <span className="badge-gray">ohne Freigabeanforderung</span>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
        <div className="mt-2">
          <button
            type="button"
            className="btn-secondary btn-tiny"
            onClick={() =>
              setZiele([
                ...ziele,
                {
                  key: `eigen-${Date.now().toString(36)}`,
                  text: '',
                  wesentlichkeitEur: 0,
                  risikoappetit: 'MITTEL',
                  aktiv: true,
                  eigen: true,
                },
              ])
            }
          >
            <Icon name="Plus" className="tx-icon-xs" /> Eigenes Ziel hinzufügen
          </button>
        </div>
        <div className="card p-3 mt-4">
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <label className="row-s">
              <input
                type="checkbox"
                className="checkbox"
                checked={freigabe.anfordern}
                disabled={gv.length === 0}
                onChange={(e) =>
                  setFreigabe({
                    ...freigabe,
                    anfordern: e.target.checked,
                    empfaengerId: freigabe.empfaengerId ?? gv[0]?.id ?? null,
                  })
                }
              />
              <span className="text-sm font-m">Freigabe beim Mandanten anfordern</span>
            </label>
            {freigabe.anfordern ? (
              <select
                className="input"
                aria-label="Gesetzliche Vertretung"
                value={freigabe.empfaengerId ?? ''}
                onChange={(e) => setFreigabe({ ...freigabe, empfaengerId: e.target.value || null })}
              >
                {gv.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} (gesetzliche Vertretung)
                  </option>
                ))}
              </select>
            ) : null}
          </div>
          <p className="hint">
            {gv.length === 0
              ? 'Für diesen Mandanten ist keine gesetzliche Vertretung erfasst; die Freigabe kann später angefordert werden.'
              : 'Die Anforderung entsteht mit Version 1; die Freigabe erfolgt durch die gesetzliche Vertretung im Mandantenportal (Bestätigung per E-Mail-Code).'}
          </p>
        </div>
      </div>
    </SetupForm>
  );
}

// ---------------------------------------------------------------------------
// Schritt 4: Risikovorschlag
// ---------------------------------------------------------------------------

export interface RisikoZeile {
  code: string;
  titel: string;
  grund: string;
  frage: string;
  kern: boolean;
  gt: GovernanceTyp;
  brutto: Klasse;
  bruttoErklaerung: string;
  ueberAppetit: boolean;
}

export function SchrittRisiken({
  zeilen,
  start,
  nichtVorgeschlagen,
  appetit,
  ...b
}: Basis & {
  zeilen: RisikoZeile[];
  start: Record<string, EntwurfRisiko>;
  nichtVorgeschlagen: { code: string; titel: string; anwendbarWenn: string }[];
  appetit: Klasse;
}) {
  const [risiken, setRisiken] = useState<Record<string, EntwurfRisiko>>(() =>
    Object.fromEntries(
      zeilen.map((z) => [
        z.code,
        z.kern
          ? { uebernehmen: true, begruendung: '' }
          : (start[z.code] ?? { uebernehmen: true, begruendung: '' }),
      ]),
    ),
  );
  const setze = (code: string, teil: Partial<EntwurfRisiko>) =>
    setRisiken({ ...risiken, [code]: { ...risiken[code]!, ...teil } });
  const uebernommen = zeilen.filter((z) => risiken[z.code]?.uebernehmen).length;
  return (
    <SetupForm
      {...b}
      schritt={4}
      daten={{ risiken }}
      hinweis={`${uebernommen} von ${zeilen.length} übernommen · Risikoappetit ${KLASSE_LABEL[appetit]}`}
    >
      <div
        className="stage-body with-rule"
        style={{ paddingLeft: 0, paddingRight: 0, paddingBottom: 0 }}
      >
        <div className="tbl-scroll">
          <table className="tbl">
            <thead>
              <tr>
                <th style={{ width: '6rem' }}>Übernehmen</th>
                <th>Risiko</th>
                <th>Grund</th>
                <th>GT</th>
                <th>Brutto</th>
                <th style={{ width: '5rem' }} />
              </tr>
            </thead>
            <tbody>
              {zeilen.map((z) => {
                const r = risiken[z.code]!;
                const zuKurz = !r.uebernehmen && r.begruendung.trim().length < MIN_BEGRUENDUNG;
                return (
                  <tr key={z.code}>
                    <td style={{ verticalAlign: 'top' }}>
                      <input
                        type="checkbox"
                        className="checkbox"
                        checked={r.uebernehmen}
                        disabled={z.kern}
                        title={z.kern ? 'Kernrisiko – immer aktiv' : 'Übernehmen'}
                        aria-label={`${z.code} übernehmen`}
                        onChange={(e) => setze(z.code, { uebernehmen: e.target.checked })}
                      />
                    </td>
                    <td className="wrap-cell" style={{ verticalAlign: 'top' }}>
                      <span className={r.uebernehmen ? 'text-sm font-m' : 'text-sm text-muted'}>
                        {z.code} · {z.titel}
                      </span>
                      {!r.uebernehmen ? (
                        <div className="mt-2">
                          <textarea
                            className="input"
                            rows={2}
                            style={{
                              fontSize: 13,
                              padding: '5px 10px',
                              minHeight: 56,
                              minWidth: 420,
                            }}
                            placeholder={`Begründung der Ablehnung (mindestens ${MIN_BEGRUENDUNG} Zeichen)`}
                            aria-label={`Begründung der Ablehnung ${z.code}`}
                            value={r.begruendung}
                            onChange={(e) => setze(z.code, { begruendung: e.target.value })}
                          />
                          <div className="row-between text-11 mt-1">
                            <span
                              className={zuKurz ? '' : 'text-muted'}
                              style={zuKurz ? { color: '#b42318' } : undefined}
                            >
                              Ablehnen erfordert eine Begründung; sie wird mit Name und Zeitpunkt
                              protokolliert.
                            </span>
                            <span className="mono text-muted">
                              {r.begruendung.trim().length}/{MIN_BEGRUENDUNG}
                            </span>
                          </div>
                        </div>
                      ) : null}
                    </td>
                    <td style={{ verticalAlign: 'top' }}>
                      {r.uebernehmen ? (
                        <span className="badge-brand" title={`Profilantwort ${z.frage}`}>
                          {z.grund}
                        </span>
                      ) : (
                        <span className="badge-gray" title={z.grund}>
                          nicht übernommen
                        </span>
                      )}
                    </td>
                    <td style={{ verticalAlign: 'top' }}>
                      {r.uebernehmen ? (
                        <GtBadge gt={z.gt} />
                      ) : (
                        <span className="text-muted">–</span>
                      )}
                    </td>
                    <td style={{ verticalAlign: 'top' }}>
                      {r.uebernehmen ? (
                        <KlasseBadge
                          klasse={z.brutto}
                          title={`Brutto-Startwert: ${z.bruttoErklaerung}`}
                        />
                      ) : (
                        <span className="text-muted">–</span>
                      )}
                    </td>
                    <td style={{ verticalAlign: 'top' }}>
                      {z.kern ? (
                        <span
                          className="badge-gray"
                          title="Kernrisiko – immer aktiv, nicht ablehnbar"
                        >
                          <Icon name="Lock" className="tx-icon-xs" /> Kern
                        </span>
                      ) : r.uebernehmen && z.ueberAppetit ? (
                        <span
                          className="text-11 text-muted"
                          style={{ whiteSpace: 'nowrap' }}
                          title="Bruttoklasse über dem Risikoappetit: braucht eine Kontrolle mit Designbeurteilung (Phase 3)"
                        >
                          über Appetit
                        </span>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div style={{ padding: '12px 18px 0' }}>
          <div className="alert-info-sm text-sm">
            Kernrisiken (EC-GOB-01 bis -03, EC-UST-09, EC-UST-10, EC-VER-01 bis -03) sind immer
            aktiv und können nicht abgelehnt werden. Ablehnen erfordert eine Begründung und wird
            protokolliert. Brutto-Startwerte stammen aus dem Bewertungsmodell und sind vom
            Berufsträger zu kalibrieren.
          </div>
          {nichtVorgeschlagen.length ? (
            <details className="details-box mt-3">
              <summary>
                <Icon name="ChevronRight" className="tx-icon-xs" /> {nichtVorgeschlagen.length}{' '}
                Katalogrisiken laut Profil nicht vorgeschlagen
              </summary>
              <div className="details-body">
                <div className="col-s">
                  {nichtVorgeschlagen.map((n) => (
                    <div key={n.code} className="row-between text-sm">
                      <span>
                        <span className="mono text-muted">{n.code}</span> {n.titel}
                      </span>
                      <span className="text-xs text-muted">anwendbar wenn {n.anwendbarWenn}</span>
                    </div>
                  ))}
                </div>
              </div>
            </details>
          ) : null}
        </div>
      </div>
    </SetupForm>
  );
}

// ---------------------------------------------------------------------------
// Schritt 5: Kontrollvorschlag
// ---------------------------------------------------------------------------

export interface KontrolleZeile {
  code: string;
  titel: string;
  art: string;
  schluessel: boolean;
  review: string | null;
  frequenz: string;
  ableitungKurz: string;
  begruendung: string;
  abweichend: boolean;
  vorlage: string;
  risikoCodes: string[];
  primaer: string | null;
  durchfuehrungen: number;
}

export interface KontrollGruppe {
  code: string | null;
  titel: string;
  brutto: Klasse | null;
  kontrollen: KontrolleZeile[];
}

type P = { id: string; name: string };

function PersonSelect({
  wert,
  pool,
  onChange,
  leer,
  label,
}: {
  wert: string | null;
  pool: P[];
  onChange: (id: string | null) => void;
  leer?: boolean;
  label: string;
}) {
  return (
    <select
      className="input"
      style={AUSWAHL}
      aria-label={label}
      value={wert ?? ''}
      onChange={(e) => onChange(e.target.value || null)}
    >
      {leer || !wert ? <option value="">—</option> : null}
      {pool.map((p) => (
        <option key={p.id} value={p.id}>
          {kurzname(p.name)}
        </option>
      ))}
    </select>
  );
}

const ZELLE = { padding: '8px 6px' } as const;
const AUSWAHL = { fontSize: 12.5, padding: '4px 4px' } as const;
const kurzname = (n: string) => n.replace(/^StB\s+/, '');

export function SchrittKontrollen({
  gruppen,
  start,
  kanzlei,
  mandant,
  zusammenfassung,
  ...b
}: Basis & {
  gruppen: KontrollGruppe[];
  start: Record<string, EntwurfKontrolle>;
  kanzlei: P[];
  mandant: P[];
  zusammenfassung: ReactNode;
}) {
  const [wahl, setWahl] = useState<Record<string, EntwurfKontrolle>>(start);
  const setze = (code: string, teil: Partial<EntwurfKontrolle>) =>
    setWahl({ ...wahl, [code]: { ...wahl[code]!, ...teil } });
  const anzahl = new Set(gruppen.flatMap((g) => g.kontrollen.map((k) => k.code))).size;
  const pool = (partei: 'KANZLEI' | 'MANDANT') => (partei === 'KANZLEI' ? kanzlei : mandant);

  return (
    <SetupForm
      {...b}
      schritt={5}
      daten={{ kontrollen: wahl }}
      hinweis="Abschluss erzeugt Version 1; Ziele gehen danach zur Mandantenfreigabe."
    >
      <div className="stage-body with-rule">
        <div className="col" style={{ gap: 10 }}>
          {gruppen.map((g, gi) => {
            const eigene = g.kontrollen.filter((k) => k.primaer === g.code);
            return (
              <details key={g.code ?? 'ohne'} className="details-box" open={gi < 2}>
                <summary>
                  <Icon name="ChevronDown" className="tx-icon-xs" />
                  {g.code ? <span className="mono text-muted">{g.code}</span> : null}
                  <span className="grow">{g.titel}</span>
                  {g.brutto ? (
                    <KlasseBadge klasse={g.brutto} title="Bruttoklasse (Startwert)" />
                  ) : null}
                  <span className="badge-gray">
                    {g.kontrollen.length} {g.kontrollen.length === 1 ? 'Vorlage' : 'Vorlagen'}
                  </span>
                </summary>
                <div className="details-body tbl-scroll">
                  <table className="tbl">
                    <thead>
                      <tr>
                        <th style={ZELLE}>Vorlage</th>
                        <th style={ZELLE}>Schlüssel</th>
                        <th style={ZELLE}>Partei</th>
                        <th style={ZELLE}>Durchführend</th>
                        <th style={ZELLE}>Vertretung</th>
                        <th style={ZELLE}>Gegenzeichnung</th>
                        <th style={ZELLE}>Frequenz</th>
                      </tr>
                    </thead>
                    <tbody>
                      {g.kontrollen.map((k) => {
                        const w = wahl[k.code]!;
                        const vorlageZelle = (
                          <td style={{ ...ZELLE, minWidth: 180 }} className="wrap-cell">
                            <span className="text-sm font-m">
                              {k.code} · {k.titel}
                            </span>
                            <div className="text-11 text-muted">
                              {k.art}
                              {k.review ? ` · ${k.review}` : ''}
                              {k.risikoCodes.length > 1
                                ? ` · deckt ${k.risikoCodes.join(', ')}`
                                : ''}
                            </div>
                          </td>
                        );
                        if (g.code && k.primaer !== g.code) {
                          return (
                            <tr key={k.code}>
                              {vorlageZelle}
                              <td style={ZELLE} colSpan={6}>
                                <span className="text-xs text-muted">
                                  Zuständigkeiten und Frequenz unter {k.primaer}{' '}
                                  (frequenzbestimmendes Risiko)
                                </span>
                              </td>
                            </tr>
                          );
                        }
                        return (
                          <tr key={k.code}>
                            {vorlageZelle}
                            <td style={ZELLE}>
                              {k.schluessel ? (
                                <span className="badge-brand">
                                  <Icon name="KeyRound" className="tx-icon-xs" /> Schlüssel
                                </span>
                              ) : (
                                <span className="text-muted">–</span>
                              )}
                            </td>
                            <td style={ZELLE}>
                              <select
                                className="input"
                                style={AUSWAHL}
                                aria-label={`Partei ${k.code}`}
                                value={w.partei}
                                onChange={(e) => {
                                  const partei = e.target.value as 'KANZLEI' | 'MANDANT';
                                  const p = pool(partei);
                                  setze(k.code, {
                                    partei,
                                    durchfuehrendId: p[0]?.id ?? null,
                                    vertretungId: p[1]?.id ?? null,
                                  });
                                }}
                              >
                                <option value="KANZLEI">Kanzlei</option>
                                <option value="MANDANT">Mandant</option>
                              </select>
                            </td>
                            <td style={ZELLE}>
                              <PersonSelect
                                label={`Durchführend ${k.code}`}
                                wert={w.durchfuehrendId}
                                pool={pool(w.partei)}
                                onChange={(id) => setze(k.code, { durchfuehrendId: id })}
                              />
                            </td>
                            <td style={ZELLE}>
                              <PersonSelect
                                label={`Vertretung ${k.code}`}
                                leer
                                wert={w.vertretungId}
                                pool={pool(w.partei)}
                                onChange={(id) => setze(k.code, { vertretungId: id })}
                              />
                            </td>
                            <td style={ZELLE}>
                              <span className="row-s">
                                <select
                                  className="input"
                                  style={AUSWAHL}
                                  aria-label={`Gegenzeichnung ${k.code}`}
                                  value={w.gegenzeichnerId ?? ''}
                                  onChange={(e) =>
                                    setze(k.code, { gegenzeichnerId: e.target.value || null })
                                  }
                                >
                                  <option value="">—</option>
                                  <optgroup label="Kanzlei">
                                    {kanzlei.map((p) => (
                                      <option key={p.id} value={p.id}>
                                        {kurzname(p.name)}
                                      </option>
                                    ))}
                                  </optgroup>
                                  <optgroup label="Mandant (zweite Person)">
                                    {mandant.map((p) => (
                                      <option key={p.id} value={p.id}>
                                        {kurzname(p.name)}
                                      </option>
                                    ))}
                                  </optgroup>
                                </select>
                                {k.schluessel ? (
                                  <span
                                    className="font-b"
                                    style={{ color: '#b42318' }}
                                    title="Pflicht bei Schlüsselkontrolle"
                                  >
                                    *
                                  </span>
                                ) : null}
                              </span>
                            </td>
                            <td style={{ ...ZELLE, minWidth: 120 }} className="wrap-cell">
                              <span className="text-sm font-m" title={k.begruendung}>
                                {k.frequenz}
                              </span>
                              <p className="hint" title={k.begruendung}>
                                {k.ableitungKurz}
                                {k.abweichend ? ` · Vorlage ${k.vorlage}` : ''}
                              </p>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  {g.code && eigene.length === 0 ? (
                    <p className="hint">
                      Alle Vorlagen dieses Risikos werden unter dem frequenzbestimmenden Risiko
                      konfiguriert.
                    </p>
                  ) : null}
                </div>
              </details>
            );
          })}
        </div>
        <p className="hint mt-3">
          {anzahl} Kontrollen aus dem Paket. Frequenzen sind aus der Häufigkeitsmatrix abgeleitet
          (strengere aus Vorlage und Governance-Typ × Bruttoklasse); Abweichungen erfordern nach der
          Einrichtung eine Begründung und eine zweite Person. Die Designbeurteilung folgt in Phase
          3.
        </p>
        {zusammenfassung}
      </div>
    </SetupForm>
  );
}
