'use client';

import {
  startTransition,
  useActionState,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { useFormStatus } from 'react-dom';
import { X } from 'lucide-react';
import { AUSWIRKUNG_LABEL, FESTSTELLUNG_KLASSE_LABEL, KLASSE_LABEL } from '@tcms/domain';
import type { Ergebnis } from '@/server/ergebnis';
import { Icon } from '../icon';
import { SubmitButton } from '../ui/client';
import { fmtGroesse, MAX_DATEI_BYTES } from './werte';

type Aktion = (prev: Ergebnis, fd: FormData) => Promise<Ergebnis>;

function Felder({ felder }: { felder: Record<string, string> }) {
  return (
    <>
      {Object.entries(felder).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
    </>
  );
}

function Meldung({ state }: { state: Ergebnis }) {
  if (state?.fehler) {
    return (
      <div className="alert-error text-sm" role="alert" data-meldung="fehler">
        {state.fehler}
      </div>
    );
  }
  if (state?.ok) {
    return (
      <div className="alert-success text-sm" role="status" data-meldung="ok">
        {state.ok}
      </div>
    );
  }
  return null;
}

// ----------------------------------------------------------------------------
// Fußleiste mit „Entwurf speichern" / „Einreichen". Die Eingaben (Schritte,
// Werte, Ergebnis) liegen in den Karten und gehören über das form-Attribut zu
// diesem Formular. Absenden ohne automatischen Formular-Reset, damit
// ungespeicherte Eingaben bei einer Ablehnung erhalten bleiben.
// ----------------------------------------------------------------------------

export function EntwurfFormular({
  action,
  formId,
  felder,
  speichern = 'Entwurf speichern',
  einreichen,
  einreichenTitel,
  links,
  rechts,
}: {
  action: Aktion;
  formId: string;
  felder: Record<string, string>;
  speichern?: string;
  einreichen: string;
  einreichenTitel?: string;
  links?: ReactNode;
  rechts?: ReactNode;
}) {
  const [state, dispatch, pending] = useActionState(action, null);
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const submitter = (e.nativeEvent as SubmitEvent).submitter as HTMLElement | null;
    const fd = new FormData(e.currentTarget, submitter);
    startTransition(() => dispatch(fd));
  };
  return (
    <div className="col" style={{ gap: 8 }}>
      <Meldung state={state} />
      <div className="form-actions" style={{ flexWrap: 'wrap' }}>
        {links}
        <form id={formId} onSubmit={onSubmit} className="row-s">
          <Felder felder={felder} />
          <button
            type="submit"
            name="absicht"
            value="speichern"
            className="btn-secondary"
            disabled={pending}
            aria-busy={pending}
          >
            <Icon name="Save" /> {speichern}
          </button>
          <button
            type="submit"
            name="absicht"
            value="einreichen"
            className="btn-primary"
            disabled={pending}
            aria-busy={pending}
            title={einreichenTitel}
          >
            <Icon name="Send" /> {einreichen}
          </button>
        </form>
        {rechts}
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Einzelne Handlung als Knopf (Beginnen, Bestätigen, Gegenzeichnen …)
// ----------------------------------------------------------------------------

export function AktionsKnopf({
  action,
  felder,
  children,
  className = 'btn-primary',
  disabled,
  title,
  bestaetigen,
}: {
  action: Aktion;
  felder: Record<string, string>;
  children: ReactNode;
  className?: string;
  disabled?: boolean;
  title?: string;
  /** Rückfrage vor dem Absenden. */
  bestaetigen?: string;
}) {
  const [state, formAction] = useActionState(action, null);
  return (
    <form
      action={formAction}
      className="col"
      style={{ gap: 6, alignItems: 'flex-end' }}
      onSubmit={(e) => {
        if (bestaetigen && !window.confirm(bestaetigen)) e.preventDefault();
      }}
    >
      <Felder felder={felder} />
      <SubmitButton className={className} disabled={disabled} title={title}>
        {children}
      </SubmitButton>
      {state?.fehler || state?.ok ? (
        <div style={{ maxWidth: 420 }}>
          <Meldung state={state} />
        </div>
      ) : null}
    </form>
  );
}

// ----------------------------------------------------------------------------
// Nachweis entfernen (nur ungesperrt)
// ----------------------------------------------------------------------------

export function EntfernenKnopf({
  action,
  felder,
  dateiname,
}: {
  action: Aktion;
  felder: Record<string, string>;
  dateiname: string;
}) {
  const [state, formAction] = useActionState(action, null);
  return (
    <form
      action={formAction}
      className="row-s"
      onSubmit={(e) => {
        if (!window.confirm(`${dateiname} entfernen?`)) e.preventDefault();
      }}
    >
      <Felder felder={felder} />
      {state?.fehler ? (
        <span className="text-xs" style={{ color: '#b42318' }} data-meldung="fehler">
          {state.fehler}
        </span>
      ) : null}
      <SubmitButton className="btn-secondary btn-tiny" title="Ungesperrten Nachweis entfernen">
        <Icon name="Trash2" className="tx-icon-xs" /> Entfernen
      </SubmitButton>
    </form>
  );
}

// ----------------------------------------------------------------------------
// Upload-Zone (Dateiauswahl oder Ablegen, Prüfung der Größe vor dem Senden)
// ----------------------------------------------------------------------------

function UploadKnopf({ gesperrt }: { gesperrt: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="btn-primary"
      disabled={gesperrt || pending}
      aria-busy={pending}
    >
      <Icon name="Upload" /> {pending ? 'Wird hochgeladen …' : 'Hochladen'}
    </button>
  );
}

export function UploadFormular({
  action,
  felder,
  variante,
}: {
  action: Aktion;
  felder: Record<string, string>;
  variante: 'staff' | 'portal';
}) {
  const [state, formAction] = useActionState(action, null);
  const input = useRef<HTMLInputElement>(null);
  const [auswahl, setAuswahl] = useState<File[]>([]);
  const [ziehen, setZiehen] = useState(false);
  useEffect(() => {
    if (state?.ok) setAuswahl([]);
  }, [state]);
  const zuGross = auswahl.filter((f) => f.size > MAX_DATEI_BYTES);
  const summe = auswahl.reduce((s, f) => s + f.size, 0);
  const problem = zuGross.length
    ? `Höchstens 20 MB je Datei: ${zuGross.map((f) => f.name).join(', ')}`
    : summe > MAX_DATEI_BYTES
      ? 'Zusammen höchstens 20 MB je Upload — bitte größere Dateien einzeln hochladen'
      : null;
  const sie = variante === 'portal';
  return (
    <form action={formAction} className="col" style={{ gap: 8 }}>
      <Felder felder={felder} />
      <div
        className="upload-zone"
        style={
          ziehen
            ? { borderColor: 'rgb(var(--brand-500))', background: 'rgb(var(--brand-50))' }
            : sie
              ? { padding: 24 }
              : undefined
        }
        onDragOver={(e) => {
          e.preventDefault();
          setZiehen(true);
        }}
        onDragLeave={() => setZiehen(false)}
        onDrop={(e) => {
          e.preventDefault();
          setZiehen(false);
          if (input.current && e.dataTransfer.files.length) {
            input.current.files = e.dataTransfer.files;
            setAuswahl(Array.from(e.dataTransfer.files));
          }
        }}
      >
        {sie ? (
          <div className="cta-illu mb-3" style={{ justifyContent: 'center' }}>
            <span className="icon-ring green" style={{ width: 44, height: 44 }}>
              <Icon name="FileSpreadsheet" className="tx-icon-lg" />
            </span>
            <span className="icon-ring brand" style={{ width: 44, height: 44 }}>
              <Icon name="FileText" className="tx-icon-lg" />
            </span>
            <span className="icon-ring amber" style={{ width: 44, height: 44 }}>
              <Icon name="Upload" className="tx-icon-lg" />
            </span>
          </div>
        ) : (
          <Icon name="Upload" className="tx-icon-lg" />
        )}
        <div
          className={sie ? 'text-sm font-s mb-2' : 'mt-1 mb-2'}
          style={sie ? { color: 'rgb(var(--text-secondary))' } : undefined}
        >
          {sie ? 'Dateien hier ablegen oder auswählen' : 'Dateien hier ablegen oder auswählen'}
        </div>
        <input
          ref={input}
          id={`${felder['id'] ?? 'upload'}-dateien`}
          type="file"
          name="dateien"
          multiple
          className="sr-only"
          onChange={(e) => setAuswahl(Array.from(e.target.files ?? []))}
        />
        <div className="row-s" style={{ justifyContent: 'center' }}>
          <label
            htmlFor={`${felder['id'] ?? 'upload'}-dateien`}
            className="btn-secondary"
            style={{ cursor: 'pointer' }}
          >
            <Icon name="Upload" /> Datei auswählen
          </label>
          {auswahl.length ? <UploadKnopf gesperrt={!!problem} /> : null}
        </div>
        {auswahl.length ? (
          <div className="text-xs mt-2" style={{ color: 'rgb(var(--text-secondary))' }}>
            {auswahl.map((f) => `${f.name} (${fmtGroesse(f.size)})`).join(' · ')}
          </div>
        ) : null}
        <div className="text-11 mt-2">
          {sie
            ? 'Je Datei bis 20 MB. Nach dem Übermitteln werden die Dateien gesperrt; der SHA-256-Hash wird gespeichert.'
            : 'Je Datei bis 20 MB. Beim Einreichen werden die Nachweise gesperrt; der SHA-256-Hash wird gespeichert.'}
        </div>
      </div>
      {problem ? (
        <div className="alert-error text-sm" role="alert">
          {problem}
        </div>
      ) : (
        <Meldung state={state} />
      )}
    </form>
  );
}

// ----------------------------------------------------------------------------
// Gegenzeichnen mit Befund: Inline-Erfassung der Feststellung
// ----------------------------------------------------------------------------

export function GegenzeichnenMitBefundDialog({
  action,
  felder,
  disabled,
  title,
  risiken,
  vorschlagSachverhalt,
  vorschlagTitel,
}: {
  action: Aktion;
  felder: Record<string, string>;
  disabled?: boolean;
  title?: string;
  risiken: { id: string; code: string; titel: string }[];
  vorschlagSachverhalt: string;
  vorschlagTitel: string;
}) {
  const [offen, setOffen] = useState(false);
  const [state, formAction] = useActionState(action, null);
  useEffect(() => {
    if (!offen) return;
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOffen(false);
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [offen]);
  useEffect(() => {
    if (state?.ok) setOffen(false);
  }, [state]);
  return (
    <>
      <button
        type="button"
        className="btn-primary"
        disabled={disabled}
        title={title}
        onClick={() => setOffen(true)}
      >
        <Icon name="UserCheck" /> Gegenzeichnen …
      </button>
      {offen ? (
        <div
          className="modal-backdrop-m"
          role="dialog"
          aria-modal="true"
          aria-label="Gegenzeichnen mit Befund"
          onClick={() => setOffen(false)}
        >
          <div
            className="modal-card"
            style={{ width: 'min(640px, 100%)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="drawer-head">
              <div className="grow">
                <div className="card-title">Gegenzeichnen – abgeschlossen mit Befund</div>
                <div className="text-xs text-muted mt-1">
                  Die durchführende Person hat einen Befund angegeben. Mit der Gegenzeichnung wird
                  die verknüpfte Feststellung erfasst (Status „Erfasst“).
                </div>
              </div>
              <button
                type="button"
                className="modal-close-icon"
                aria-label="Schließen"
                onClick={() => setOffen(false)}
              >
                <X className="tx-icon" aria-hidden />
              </button>
            </div>
            <form action={formAction} className="p-4 col" style={{ gap: 12 }}>
              <Felder felder={felder} />
              <div>
                <label className="label" htmlFor="fTitel">
                  Titel der Feststellung
                </label>
                <input
                  id="fTitel"
                  name="fTitel"
                  className="input"
                  required
                  minLength={5}
                  maxLength={200}
                  defaultValue={vorschlagTitel}
                />
              </div>
              <div>
                <label className="label" htmlFor="fSachverhalt">
                  Sachverhalt <span className="text-muted text-xs">(mindestens 20 Zeichen)</span>
                </label>
                <textarea
                  id="fSachverhalt"
                  name="fSachverhalt"
                  className="input"
                  required
                  minLength={20}
                  defaultValue={vorschlagSachverhalt}
                />
              </div>
              <div className="g12" style={{ gap: 12 }}>
                <div className="gc-6">
                  <label className="label" htmlFor="fKlasse">
                    Klasse
                  </label>
                  <select
                    id="fKlasse"
                    name="fKlasse"
                    className="input"
                    required
                    defaultValue=""
                    style={{ width: '100%' }}
                  >
                    <option value="" disabled>
                      bitte wählen
                    </option>
                    {Object.entries(FESTSTELLUNG_KLASSE_LABEL).map(([k, v]) => (
                      <option key={k} value={k}>
                        {v}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="gc-6">
                  <label className="label" htmlFor="fSchwere">
                    Schwere
                  </label>
                  <select
                    id="fSchwere"
                    name="fSchwere"
                    className="input"
                    required
                    defaultValue=""
                    style={{ width: '100%' }}
                  >
                    <option value="" disabled>
                      bitte wählen
                    </option>
                    {Object.entries(KLASSE_LABEL).map(([k, v]) => (
                      <option key={k} value={k}>
                        {v}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
                <legend className="label">Steuerliche Auswirkung</legend>
                <div className="row-wrap" style={{ gap: 16 }}>
                  {Object.entries(AUSWIRKUNG_LABEL).map(([k, v]) => (
                    <label key={k} className="row-s text-sm">
                      <input
                        type="radio"
                        name="fAuswirkung"
                        value={k}
                        className="checkbox"
                        required
                      />{' '}
                      {v}
                    </label>
                  ))}
                </div>
                <div className="hint">
                  Bei „ja“ oder „unklar“ startet der §-153-Pfad; die Würdigung trifft ausschließlich
                  ein Berufsträger.
                </div>
              </fieldset>
              <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
                <legend className="label">Betroffene Risiken</legend>
                <div className="col-s">
                  {risiken.map((r) => (
                    <label key={r.id} className="row-s text-sm">
                      <input
                        type="checkbox"
                        name="fRisiko"
                        value={r.id}
                        className="checkbox"
                        defaultChecked
                      />
                      <span className="mono text-xs">{r.code}</span>{' '}
                      <span className="text-secondary">{r.titel}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
              <Meldung state={state} />
              <div className="form-actions">
                <button type="button" className="btn-secondary" onClick={() => setOffen(false)}>
                  Abbrechen
                </button>
                <SubmitButton>Gegenzeichnen und Feststellung erfassen</SubmitButton>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </>
  );
}
