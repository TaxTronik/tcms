'use client';

import { useState } from 'react';
import { ShieldAlert, ShieldCheck, TriangleAlert } from 'lucide-react';
import type { Paragraph153Entscheidung } from '@tcms/domain';
import { entscheideP153 } from '@/server/actions/feststellungen';
import { AktionsForm, SubmitButton } from '../ui/client';
import { Gesperrt } from './dialog';

export interface P153Option {
  wert: Paragraph153Entscheidung;
  titel: string;
  text: string;
}

export interface P153Ergebnis {
  label: string;
  begruendung: string | null;
  frist: string | null;
  beleg: string;
}

const MIN = 30;

/**
 * §-153-Würdigung: vier gleichrangige Optionen ohne Vorauswahl und ohne
 * Empfehlung. Für alle außer der zuständigen Berufsträgerin sichtbar gesperrt;
 * die Action prüft das Recht zusätzlich serverseitig.
 */
export function P153Block({
  mandantId,
  feststellungId,
  bisher,
  optionen,
  darf,
  sperrGrund,
  sperrHinweis,
  ergebnis,
  offen,
  heuteIso,
}: {
  mandantId: string;
  feststellungId: string;
  /** Bisherige Entscheidung (nach „weitere Klärung"); der Service weist abweichende Stände ab. */
  bisher: Paragraph153Entscheidung | null;
  optionen: P153Option[];
  darf: boolean;
  /** Tooltip der gesperrten Bedienelemente. */
  sperrGrund: string | null;
  /** Hinweistext oberhalb der gesperrten Optionen. */
  sperrHinweis: string | null;
  ergebnis: P153Ergebnis | null;
  /** true: Entscheidung (oder Folgeentscheidung nach „weitere Klärung") steht aus. */
  offen: boolean;
  heuteIso: string;
}) {
  const [wahl, setWahl] = useState<Paragraph153Entscheidung | null>(null);
  const [text, setText] = useState('');
  const fristNoetig = wahl === 'BERICHTIGUNG' || wahl === 'WEITERE_KLAERUNG';
  const gesperrt = !darf;
  const rot = { border: '#f3cdc7', bg: '#fbeae8', text: '#b42318' };

  const kopf = offen ? (
    <div className="card-header" style={{ backgroundColor: rot.bg, borderBottomColor: rot.border }}>
      <span className="row" style={{ alignItems: 'flex-start', color: rot.text }}>
        <ShieldAlert className="tx-icon-lg" aria-hidden />
        <span>
          <span className="card-title" style={{ display: 'block', color: rot.text }}>
            Würdigung durch Berufsträger erforderlich (höchstpersönlich)
          </span>
          <span className="text-xs" style={{ color: rot.text }}>
            Das Ergebnis ist nicht vorausgewählt. Strafrechtliche Bewertung ist nicht Teil des
            Moduls.
          </span>
        </span>
      </span>
      <span className="row-s shrink0">
        <span className="badge-gray">§ 153 AO</span>
        <span className="badge-yellow" title="Normanker ungeprüft">
          UNGEPRÜFT
        </span>
      </span>
    </div>
  ) : (
    <div className="card-header">
      <span className="row-s">
        <ShieldCheck className="tx-icon" aria-hidden />
        <span className="card-title">§-153-Würdigung</span>
      </span>
      <span className="row-s shrink0">
        <span className="badge-gray">§ 153 AO</span>
        <span className="badge-yellow" title="Normanker ungeprüft">
          UNGEPRÜFT
        </span>
      </span>
    </div>
  );

  return (
    <div className="card" style={offen ? { borderColor: rot.border } : undefined}>
      {kopf}
      <div className="p-4">
        {ergebnis ? (
          <div className={offen ? 'mb-4' : ''}>
            <div className="row-wrap" style={{ gap: 8 }}>
              <span className="badge-green">Entschieden: {ergebnis.label}</span>
              <span className="text-xs text-muted">{ergebnis.beleg}</span>
            </div>
            {ergebnis.begruendung ? (
              <p className="text-sm text-secondary mt-2">{ergebnis.begruendung}</p>
            ) : null}
            {ergebnis.frist ? (
              <div className="text-xs text-muted mt-1">Frist: {ergebnis.frist}</div>
            ) : null}
            {offen ? (
              <div className="alert-info-sm mt-3 text-sm">
                Die Entscheidung „weitere Klärung“ ist nicht abschließend. Nach der Klärung ist eine
                Folgeentscheidung zu dokumentieren.
              </div>
            ) : null}
          </div>
        ) : null}

        {offen ? (
          <>
            {gesperrt && sperrHinweis ? (
              <div
                className="alert-warning mb-4"
                style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}
              >
                <TriangleAlert className="tx-icon-lg shrink0" aria-hidden />
                <span>{sperrHinweis}</span>
              </div>
            ) : null}
            <AktionsForm action={entscheideP153}>
              <input type="hidden" name="mandantId" value={mandantId} />
              <input type="hidden" name="id" value={feststellungId} />
              <input type="hidden" name="bisher" value={bisher ?? ''} />
              <fieldset
                disabled={gesperrt}
                style={{ border: 0, padding: 0, margin: 0 }}
                title={gesperrt ? (sperrGrund ?? undefined) : undefined}
              >
                <legend className="sr-only">Ergebnis der §-153-Würdigung</legend>
                <div
                  className="g12"
                  style={{ gap: 12 }}
                  role="radiogroup"
                  aria-label="Ergebnis der §-153-Würdigung"
                >
                  {optionen.map((o) => {
                    const aktiv = wahl === o.wert;
                    return (
                      <label
                        key={o.wert}
                        className="card gc-6 p-3 row"
                        style={{
                          alignItems: 'flex-start',
                          gap: 10,
                          cursor: gesperrt ? 'not-allowed' : 'pointer',
                          boxShadow: 'none',
                          ...(aktiv
                            ? {
                                borderColor: 'rgb(var(--brand-300))',
                                backgroundColor: 'rgb(var(--brand-50))',
                              }
                            : {}),
                        }}
                        title={gesperrt ? (sperrGrund ?? undefined) : undefined}
                      >
                        <input
                          type="radio"
                          className="checkbox"
                          name="entscheidung"
                          value={o.wert}
                          checked={aktiv}
                          onChange={() => setWahl(o.wert)}
                          style={{ marginTop: 2 }}
                        />
                        <span>
                          <span className="text-sm font-s" style={{ display: 'block' }}>
                            {o.titel}
                          </span>
                          <span
                            className="text-xs text-muted"
                            style={{ display: 'block', marginTop: 2 }}
                          >
                            {o.text}
                          </span>
                        </span>
                      </label>
                    );
                  })}
                </div>
                <div className="g12 mt-3" style={{ gap: 12 }}>
                  <div className="gc-8">
                    <label className="label-sm" htmlFor={`p153-begruendung-${feststellungId}`}>
                      Begründung <span className="text-muted">(mindestens {MIN} Zeichen)</span>
                    </label>
                    <textarea
                      id={`p153-begruendung-${feststellungId}`}
                      name="begruendung"
                      className="input"
                      placeholder="Begründung der Entscheidung (Pflichtfeld)"
                      value={text}
                      onChange={(e) => setText(e.target.value)}
                      minLength={MIN}
                      required
                    />
                    <div className="hint mono" style={{ textAlign: 'right' }}>
                      {text.trim().length}/{MIN}
                    </div>
                  </div>
                  <div className="gc-4">
                    <label className="label-sm" htmlFor={`p153-frist-${feststellungId}`}>
                      {wahl === 'WEITERE_KLAERUNG' ? 'Klärung bis' : 'Frist für Berichtigung'}
                    </label>
                    <input
                      id={`p153-frist-${feststellungId}`}
                      type="date"
                      name="frist"
                      className="input"
                      min={heuteIso}
                      required={fristNoetig}
                    />
                    <div className="hint">
                      erforderlich bei „Berichtigung erforderlich“ und „Weitere Klärung“; erzeugt
                      eine Wiedervorlage
                    </div>
                  </div>
                </div>
                <div className="form-actions mt-3">
                  <Gesperrt
                    grund={
                      gesperrt
                        ? (sperrGrund ?? 'gesperrt')
                        : !wahl
                          ? 'Bitte eine der vier Optionen wählen'
                          : text.trim().length < MIN
                            ? `Begründung mit mindestens ${MIN} Zeichen`
                            : null
                    }
                  >
                    <SubmitButton disabled={gesperrt || !wahl || text.trim().length < MIN}>
                      Entscheidung dokumentieren
                    </SubmitButton>
                  </Gesperrt>
                </div>
              </fieldset>
            </AktionsForm>
          </>
        ) : null}
      </div>
    </div>
  );
}
