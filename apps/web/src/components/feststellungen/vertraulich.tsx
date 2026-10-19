'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import { EyeOff } from 'lucide-react';
import { setzeVertraulich } from '@/server/actions/feststellungen';

/** Schalter „vertraulich" (nur Berufsträger; gesperrt sichtbar mit Grund). */
export function VertraulichSchalter({
  id,
  wert,
  gesperrtGrund,
}: {
  id: string;
  wert: boolean;
  gesperrtGrund: string | null;
}) {
  const [state, action, pending] = useActionState(setzeVertraulich, null);
  const ref = useRef<HTMLFormElement>(null);
  // Sofortige Rückmeldung; nach der Revalidierung gilt wieder der Serverwert.
  const [an, setAn] = useState(wert);
  useEffect(() => setAn(wert), [wert, state]);
  return (
    <form ref={ref} action={action}>
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="wert" value={an ? '1' : '0'} />
      <label
        className="row-between"
        style={{ cursor: gesperrtGrund ? 'not-allowed' : 'pointer' }}
        title={gesperrtGrund ?? 'Nur für Beteiligte sichtbar'}
      >
        <span className="row-s text-sm">
          <EyeOff className="tx-icon-xs" aria-hidden /> vertraulich
        </span>
        <input
          type="checkbox"
          className="checkbox"
          checked={an}
          disabled={!!gesperrtGrund || pending}
          onChange={(e) => {
            setAn(e.target.checked);
            const form = ref.current;
            // Wert erst nach dem Rendern des neuen Zustands übermitteln.
            setTimeout(() => form?.requestSubmit(), 0);
          }}
          aria-label="Feststellung vertraulich markieren"
        />
      </label>
      {state?.fehler ? (
        <div className="alert-error mt-2 text-xs" role="alert">
          {state.fehler}
        </div>
      ) : null}
    </form>
  );
}
