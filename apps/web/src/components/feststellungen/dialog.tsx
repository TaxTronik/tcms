'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import type { Ergebnis } from '@/server/ergebnis';
import { AktionsForm, SubmitButton } from '../ui/client';

type Aktion = (prev: Ergebnis, formData: FormData) => Promise<Ergebnis>;

/**
 * Gesperrte Buttons haben in taxtronik.css `pointer-events: none`; der Tooltip
 * mit dem Sperrgrund hängt deshalb an einem umschließenden Element.
 */
export function Gesperrt({
  grund,
  blass = false,
  children,
}: {
  grund: string | null | undefined;
  blass?: boolean;
  children: ReactNode;
}) {
  if (!grund) return <>{children}</>;
  return (
    <span
      title={grund}
      style={{ display: 'inline-flex', cursor: 'not-allowed', ...(blass ? { opacity: 0.5 } : {}) }}
    >
      {children}
    </span>
  );
}

/**
 * Modal mit Formular für Server Actions. Wird per Portal an <body> gehängt,
 * damit der Auslöser auch innerhalb eines anderen Formulars stehen darf.
 * Optional mit Begründungspflicht (Zeichenzähler wie BegruendungsDialog).
 */
export function FormDialog({
  ausloeser,
  ausloeserClass = 'btn-secondary btn-tiny',
  ausloeserTitel,
  titel,
  hinweis,
  action,
  felder,
  bestaetigen = 'Speichern',
  gefahr = false,
  disabled,
  disabledGrund,
  begruendungMin,
  begruendungHinweis,
  breit = false,
  children,
}: {
  ausloeser: ReactNode;
  ausloeserClass?: string;
  ausloeserTitel?: string;
  titel: string;
  hinweis?: string;
  action: Aktion;
  felder?: Record<string, string>;
  bestaetigen?: string;
  gefahr?: boolean;
  disabled?: boolean;
  disabledGrund?: string;
  begruendungMin?: number;
  begruendungHinweis?: string;
  breit?: boolean;
  children?: ReactNode;
}) {
  const [offen, setOffen] = useState(false);
  const [text, setText] = useState('');
  const [bereit, setBereit] = useState(false);
  useEffect(() => setBereit(true), []);
  useEffect(() => {
    if (!offen) return;
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOffen(false);
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [offen]);
  const schliessen = () => {
    setOffen(false);
    setText('');
  };
  const zuKurz = begruendungMin != null && text.trim().length < begruendungMin;
  return (
    <>
      <Gesperrt grund={disabled ? (disabledGrund ?? 'gesperrt') : null}>
        <button
          type="button"
          className={ausloeserClass}
          onClick={() => setOffen(true)}
          disabled={disabled}
          title={disabled ? disabledGrund : ausloeserTitel}
          aria-haspopup="dialog"
          style={disabled ? { opacity: 0.5, pointerEvents: 'none' } : undefined}
        >
          {ausloeser}
        </button>
      </Gesperrt>
      {offen && bereit
        ? createPortal(
            <div
              className="modal-backdrop-m"
              role="dialog"
              aria-modal="true"
              aria-label={titel}
              onClick={schliessen}
            >
              <div
                className="modal-card"
                style={breit ? { width: 'min(720px, 100%)' } : undefined}
                onClick={(e) => e.stopPropagation()}
              >
                <div className="drawer-head">
                  <div className="grow">
                    <div className="card-title">{titel}</div>
                    {hinweis ? <div className="text-xs text-muted mt-1">{hinweis}</div> : null}
                  </div>
                  <button
                    type="button"
                    className="modal-close-icon"
                    aria-label="Schließen"
                    onClick={schliessen}
                  >
                    <X className="tx-icon" aria-hidden />
                  </button>
                </div>
                <AktionsForm action={action} className="p-4 col" onErfolg={schliessen}>
                  {Object.entries(felder ?? {}).map(([k, v]) => (
                    <input key={k} type="hidden" name={k} value={v} />
                  ))}
                  {children}
                  {begruendungMin != null ? (
                    <div>
                      <label className="label" htmlFor="dialog-begruendung">
                        Begründung{' '}
                        <span className="text-muted text-xs">
                          (mindestens {begruendungMin} Zeichen)
                        </span>
                      </label>
                      <textarea
                        id="dialog-begruendung"
                        name="begruendung"
                        className="input"
                        value={text}
                        onChange={(e) => setText(e.target.value)}
                        required
                        minLength={begruendungMin}
                        autoFocus
                      />
                      <div className="row-between text-xs text-muted mt-1">
                        <span>
                          {begruendungHinweis ?? 'Wird mit Name und Zeitpunkt protokolliert.'}
                        </span>
                        <span className="mono">
                          {text.trim().length}/{begruendungMin}
                        </span>
                      </div>
                    </div>
                  ) : null}
                  <div className="form-actions">
                    <button type="button" className="btn-secondary" onClick={schliessen}>
                      Abbrechen
                    </button>
                    <SubmitButton
                      className={gefahr ? 'btn-danger-outline' : 'btn-primary'}
                      disabled={zuKurz}
                    >
                      {bestaetigen}
                    </SubmitButton>
                  </div>
                </AktionsForm>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
