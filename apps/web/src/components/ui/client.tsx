'use client';

import { useActionState, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useFormStatus } from 'react-dom';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Moon, Sun, X } from 'lucide-react';
import type { Ergebnis } from '@/server/ergebnis';

// ----------------------------------------------------------------------------
// Darstellung hell/dunkel (localStorage, kein Flackern dank Bootstrap-Skript)
// ----------------------------------------------------------------------------

export function ThemeToggle() {
  const [dunkel, setDunkel] = useState(false);
  useEffect(() => setDunkel(document.documentElement.classList.contains('dark')), []);
  return (
    <button
      type="button"
      className="icon-action"
      title="Darstellung wechseln"
      aria-label="Darstellung wechseln"
      onClick={() => {
        const neu = !document.documentElement.classList.contains('dark');
        document.documentElement.classList.toggle('dark', neu);
        try {
          localStorage.setItem('tcms-theme', neu ? 'dark' : 'light');
        } catch {
          /* Speicher nicht verfügbar */
        }
        setDunkel(neu);
      }}
    >
      {dunkel ? <Sun className="tx-icon" aria-hidden /> : <Moon className="tx-icon" aria-hidden />}
    </button>
  );
}

// ----------------------------------------------------------------------------
// Stichtag-Selektor (Konzept 3.4.5): ?stand=YYYY-MM-DD, historisch = nur Lesen
// ----------------------------------------------------------------------------

export function StichtagSelector({ stand, heute }: { stand: string; heute: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const id = useId();
  const setze = (wert: string | null) => {
    const p = new URLSearchParams(params.toString());
    if (!wert || wert >= heute) p.delete('stand');
    else p.set('stand', wert);
    const q = p.toString();
    router.push(q ? `${pathname}?${q}` : pathname);
  };
  return (
    <span className="row-s">
      <label className="label-sm mb-0" htmlFor={id} style={{ marginBottom: 0 }}>
        Stichtag
      </label>
      <input
        id={id}
        type="date"
        className="input"
        style={{ width: 'auto', padding: '4px 8px', fontSize: 12 }}
        value={stand}
        max={heute}
        onChange={(e) => setze(e.target.value || null)}
      />
      <button
        type="button"
        className="text-xs text-muted"
        style={{ background: 'none', border: 0 }}
        onClick={() => setze(null)}
        title="Zum aktuellen Stand"
      >
        Heute
      </button>
    </span>
  );
}

/** Hängt den aktuellen Stichtag an interne Links an. */
export function useStandHref(href: string): string {
  const params = useSearchParams();
  const stand = params.get('stand');
  if (!stand) return href;
  return href.includes('?') ? `${href}&stand=${stand}` : `${href}?stand=${stand}`;
}

// ----------------------------------------------------------------------------
// Formulare mit Server Actions
// ----------------------------------------------------------------------------

export function SubmitButton({
  children,
  className = 'btn-primary',
  disabled,
  title,
  name,
  value,
}: {
  children: ReactNode;
  className?: string;
  disabled?: boolean;
  title?: string;
  name?: string;
  value?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className={className}
      disabled={disabled || pending}
      title={title}
      name={name}
      value={value}
      aria-busy={pending}
    >
      {children}
    </button>
  );
}

type Aktion = (prev: Ergebnis, formData: FormData) => Promise<Ergebnis>;

export function AktionsForm({
  action,
  children,
  className,
  style,
  onErfolg,
  encType,
}: {
  action: Aktion;
  children: ReactNode;
  className?: string;
  style?: React.CSSProperties;
  onErfolg?: () => void;
  encType?: 'multipart/form-data';
}) {
  const [state, formAction] = useActionState(action, null);
  useEffect(() => {
    if (state?.ok && onErfolg) onErfolg();
  }, [state, onErfolg]);
  return (
    <form action={formAction} className={className} style={style} encType={encType}>
      {children}
      {state?.fehler ? (
        <div className="alert-error mt-3 text-sm" role="alert">
          {state.fehler}
        </div>
      ) : null}
      {state?.ok ? (
        <div className="alert-success mt-3 text-sm" role="status">
          {state.ok}
        </div>
      ) : null}
    </form>
  );
}

// ----------------------------------------------------------------------------
// Modal mit Begründungspflicht (Konzept 6.4 OverrideModal)
// ----------------------------------------------------------------------------

export function BegruendungsDialog({
  ausloeser,
  ausloeserClass = 'btn-secondary btn-tiny',
  titel,
  hinweis,
  action,
  felder,
  bestaetigen = 'Absenden',
  min = 30,
  vierAugen = true,
  disabled,
  disabledGrund,
  children,
}: {
  ausloeser: ReactNode;
  ausloeserClass?: string;
  titel: string;
  hinweis?: string;
  action: Aktion;
  felder?: Record<string, string>;
  bestaetigen?: string;
  min?: number;
  vierAugen?: boolean;
  disabled?: boolean;
  disabledGrund?: string;
  children?: ReactNode;
}) {
  const [offen, setOffen] = useState(false);
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!offen) return;
    ref.current?.focus();
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOffen(false);
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [offen]);
  return (
    <>
      <button
        type="button"
        className={ausloeserClass}
        onClick={() => setOffen(true)}
        disabled={disabled}
        title={disabled ? disabledGrund : undefined}
      >
        {ausloeser}
      </button>
      {offen ? (
        <div
          className="modal-backdrop-m"
          role="dialog"
          aria-modal="true"
          aria-label={titel}
          onClick={() => setOffen(false)}
        >
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="drawer-head">
              <div className="grow">
                <div className="card-title">{titel}</div>
                {hinweis ? <div className="text-xs text-muted mt-1">{hinweis}</div> : null}
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
            <AktionsForm action={action} className="p-4 col" onErfolg={() => setOffen(false)}>
              {Object.entries(felder ?? {}).map(([k, v]) => (
                <input key={k} type="hidden" name={k} value={v} />
              ))}
              {children}
              <label className="label" htmlFor="begruendung">
                Begründung <span className="text-muted text-xs">(mindestens {min} Zeichen)</span>
              </label>
              <textarea
                ref={ref}
                id="begruendung"
                name="begruendung"
                className="input"
                value={text}
                onChange={(e) => setText(e.target.value)}
                required
                minLength={min}
              />
              <div className="row-between text-xs text-muted">
                <span>
                  {vierAugen
                    ? 'Wird von einer zweiten Person bestätigt.'
                    : 'Wird mit Name und Zeitpunkt protokolliert.'}
                </span>
                <span className="mono">
                  {text.trim().length}/{min}
                </span>
              </div>
              <div className="form-actions">
                <button type="button" className="btn-secondary" onClick={() => setOffen(false)}>
                  Abbrechen
                </button>
                <SubmitButton disabled={text.trim().length < min}>{bestaetigen}</SubmitButton>
              </div>
            </AktionsForm>
          </div>
        </div>
      ) : null}
    </>
  );
}

// ----------------------------------------------------------------------------
// Detail-Drawer (Konzept 3.4.2), über Query-Parameter deeplinkbar
// ----------------------------------------------------------------------------

export function DetailDrawer({
  param,
  titel,
  kopf,
  children,
}: {
  param: string;
  titel: string;
  kopf: ReactNode;
  children: ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const schliessen = () => {
    const p = new URLSearchParams(params.toString());
    p.delete(param);
    const q = p.toString();
    router.push(q ? `${pathname}?${q}` : pathname, { scroll: false });
  };
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && schliessen();
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  });
  return (
    <>
      <div className="drawer-backdrop" onClick={schliessen} />
      <aside className="drawer-panel" role="dialog" aria-modal="true" aria-label={titel}>
        <div className="drawer-head">
          <div className="grow">{kopf}</div>
          <button
            type="button"
            className="modal-close-icon"
            aria-label="Schließen"
            onClick={schliessen}
          >
            <X className="tx-icon" aria-hidden />
          </button>
        </div>
        <div className="drawer-body">{children}</div>
      </aside>
    </>
  );
}

// ----------------------------------------------------------------------------
// Umschaltgruppe, deren Zustand im Query-Parameter liegt
// ----------------------------------------------------------------------------

export function ToggleGroupLink({
  param,
  optionen,
  aktiv,
  label,
}: {
  param: string;
  optionen: [string, string][];
  aktiv: string;
  label: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  return (
    <div className="toggle-group" role="tablist" aria-label={label}>
      {optionen.map(([wert, text]) => (
        <button
          key={wert}
          type="button"
          role="tab"
          aria-selected={aktiv === wert}
          className={aktiv === wert ? 'active' : undefined}
          onClick={() => {
            const p = new URLSearchParams(params.toString());
            p.set(param, wert);
            router.push(`${pathname}?${p.toString()}`, { scroll: false });
          }}
        >
          {text}
        </button>
      ))}
    </div>
  );
}
