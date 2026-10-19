'use client';

import Link from 'next/link';
import { useActionState, useState, type ReactNode } from 'react';
import { useFormStatus } from 'react-dom';
import type { Geschaeftsprofil } from '@tcms/domain';
import type { Ergebnis } from '@/server/ergebnis';
import { Icon } from '../icon';
import { ProfilFormular, type PersonInfo } from './profil-formular';

type Aktion = (prev: Ergebnis, fd: FormData) => Promise<Ergebnis>;

function Senden({
  children,
  className = 'btn-primary',
  title,
  disabled,
}: {
  children: ReactNode;
  className?: string;
  title?: string;
  disabled?: boolean;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className={className}
      disabled={disabled || pending}
      title={title}
      aria-busy={pending}
    >
      {children}
    </button>
  );
}

/** „Profil ändern": neuer Profilstand mit Gültig-ab-Datum; Trigger laut Fachkonzept § 4/§ 7. */
export function ProfilAenderung({
  aktion,
  programmId,
  start,
  personen,
  heuteIso,
  abbrechen,
}: {
  aktion: Aktion;
  programmId: string;
  start: Geschaeftsprofil;
  personen: PersonInfo[];
  heuteIso: string;
  abbrechen: string;
}) {
  const [profil, setProfil] = useState(start);
  const [state, formAction] = useActionState(aktion, null);
  return (
    <form action={formAction}>
      <input type="hidden" name="programmId" value={programmId} />
      <input type="hidden" name="profil" value={JSON.stringify(profil)} />
      <div className="p-4">
        <ProfilFormular
          wert={profil}
          onChange={setProfil}
          personen={personen}
          heuteIso={heuteIso}
        />
        <div className="row-lg mt-4" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div>
            <label className="label-sm" htmlFor="gueltig-ab">
              Gültig ab
            </label>
            <input
              id="gueltig-ab"
              name="gueltigAb"
              type="date"
              className="input"
              style={{ width: 'auto' }}
              min={heuteIso}
              defaultValue={heuteIso}
              required
            />
          </div>
          <label className="row-s" style={{ paddingBottom: 8 }}>
            <input type="checkbox" className="checkbox" name="ereignisse" defaultChecked />
            <span className="text-sm">Ereignisse im Ereigniseingang anlegen</span>
          </label>
        </div>
        <p className="hint">
          Der bisherige Stand wird zum Gültig-ab-Datum geschlossen, ein neuer Stand angelegt;
          frühere Stände bleiben unverändert. Je geänderter Profilfrage entsteht das Ereignis laut
          Fachkonzept (z. B. P2 → T-02). Risiken, deren Grundlage sich ändert, werden zur
          Neubewertung markiert. Abwählen, wenn die Änderung aus einem bereits erfassten Ereignis
          stammt.
        </p>
        {state?.fehler ? (
          <div className="alert-error mt-3 text-sm" role="alert">
            {state.fehler}
          </div>
        ) : null}
      </div>
      <div
        className="form-actions"
        style={{ borderTop: '1px solid rgb(var(--border-default))', padding: '12px 16px' }}
      >
        <Link href={abbrechen} className="btn-secondary">
          Abbrechen
        </Link>
        <Senden>
          <Icon name="Save" className="tx-icon-xs" /> Neuen Profilstand anlegen
        </Senden>
      </div>
    </form>
  );
}

/** „Risiko aufnehmen" für einen deterministischen Profilvorschlag (ein Klick, protokolliert). */
export function RisikoAufnehmen({
  aktion,
  programmId,
  code,
  darf,
  grund,
  label = 'Risiko aufnehmen',
}: {
  aktion: Aktion;
  programmId: string;
  code: string;
  darf: boolean;
  grund?: string;
  label?: string;
}) {
  const [state, formAction] = useActionState(aktion, null);
  return (
    <form action={formAction} className="col-s" style={{ alignItems: 'flex-end' }}>
      <input type="hidden" name="programmId" value={programmId} />
      <input type="hidden" name="code" value={code} />
      {state?.ok ? (
        <span className="badge-green">
          <Icon name="Check" className="tx-icon-xs" /> aufgenommen
        </span>
      ) : (
        <Senden
          className="btn-secondary btn-tiny"
          disabled={!darf}
          title={darf ? `${code} mit Katalogkontrollen ins Inventar aufnehmen` : grund}
        >
          <Icon name="Plus" className="tx-icon-xs" /> {label}
        </Senden>
      )}
      {state?.fehler ? (
        <span
          className="text-11"
          style={{ color: '#b42318', maxWidth: 320, textAlign: 'right' }}
          role="alert"
        >
          {state.fehler}
        </span>
      ) : null}
      {state?.ok ? (
        <span
          className="text-11 text-muted"
          style={{ maxWidth: 420, textAlign: 'right' }}
          role="status"
        >
          {state.ok}
        </span>
      ) : null}
    </form>
  );
}
