'use client';

import { useActionState, type ReactNode } from 'react';
import { useFormStatus } from 'react-dom';
import type { Ergebnis } from '@/server/ergebnis';
import { Icon } from '../icon';

type Aktion = (prev: Ergebnis, fd: FormData) => Promise<Ergebnis>;

function Knopf({
  ziel,
  className,
  disabled,
  title,
  children,
}: {
  ziel: string;
  className: string;
  disabled?: boolean;
  title?: string;
  children: ReactNode;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      name="ziel"
      value={ziel}
      className={className}
      disabled={disabled || pending}
      title={title}
      aria-busy={pending}
    >
      {children}
    </button>
  );
}

/** Fehlermeldungen zeilenweise (Server liefert sie mit Zeilenumbruch getrennt). */
export function FehlerListe({ text }: { text: string }) {
  const [kopf, ...zeilen] = text.split('\n').filter(Boolean);
  return (
    <div className="alert-error mt-3 text-sm" role="alert">
      <strong>{kopf}</strong>
      {zeilen.length ? (
        <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
          {zeilen.map((z) => (
            <li key={z}>{z}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * Formular eines Assistentenschritts: serialisiert den Schrittzustand als JSON
 * und bietet „Zurück", „Entwurf speichern" und „Weiter" bzw. „Version 1 anlegen".
 */
export function SetupForm({
  aktion,
  mandantId,
  schritt,
  daten,
  darf,
  gesperrtGrund,
  hinweis,
  children,
}: {
  aktion: Aktion;
  mandantId: string;
  schritt: number;
  daten: unknown;
  darf: boolean;
  gesperrtGrund?: string;
  hinweis?: ReactNode;
  children: ReactNode;
}) {
  const [state, formAction] = useActionState(aktion, null);
  const letzter = schritt === 5;
  const sperre = darf ? undefined : gesperrtGrund;
  return (
    <form action={formAction}>
      <input type="hidden" name="mandantId" value={mandantId} />
      <input type="hidden" name="schritt" value={schritt} />
      <input type="hidden" name="daten" value={JSON.stringify(daten)} />
      <fieldset disabled={!darf} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
        {children}
      </fieldset>
      <div style={{ padding: '0 18px' }}>
        {state?.fehler ? <FehlerListe text={state.fehler} /> : null}
        {state?.ok ? (
          <div className="alert-success mt-3 text-sm" role="status">
            {state.ok}
          </div>
        ) : null}
      </div>
      <div
        className="form-actions"
        style={{
          borderTop: '1px solid rgb(var(--border-subtle))',
          padding: '12px 18px',
          marginTop: 16,
        }}
      >
        <span className="text-xs text-muted" style={{ marginRight: 'auto' }}>
          {hinweis}
        </span>
        <Knopf
          ziel="zurueck"
          className="btn-secondary"
          disabled={!darf || schritt === 1}
          title={
            sperre ??
            (schritt === 1
              ? 'Erster Schritt'
              : 'Speichert den Entwurf und geht einen Schritt zurück')
          }
        >
          <Icon name="ArrowLeft" className="tx-icon-xs" /> Zurück
        </Knopf>
        <Knopf ziel="speichern" className="btn-secondary" disabled={!darf} title={sperre}>
          <Icon name="Save" className="tx-icon-xs" /> Entwurf speichern
        </Knopf>
        {letzter ? (
          <Knopf ziel="anlegen" className="btn-primary" disabled={!darf} title={sperre}>
            <Icon name="CheckCheck" className="tx-icon-xs" /> Tax-CMS Version 1 anlegen
          </Knopf>
        ) : (
          <Knopf ziel="weiter" className="btn-primary" disabled={!darf} title={sperre}>
            Weiter <Icon name="ChevronRight" className="tx-icon-xs" />
          </Knopf>
        )}
      </div>
    </form>
  );
}
