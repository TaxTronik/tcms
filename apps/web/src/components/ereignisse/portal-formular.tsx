'use client';

import { useActionState, useState } from 'react';
import Link from 'next/link';
import { Check, Send, Upload } from 'lucide-react';
import { meldeEreignis } from '@/server/actions/portal-ereignis';
import { Icon } from '../icon';
import { Gesperrt } from '../feststellungen/dialog';

export interface Kachel {
  code: string;
  label: string;
  icon: string;
  ton: 'brand' | 'violet' | 'amber' | 'red' | 'green';
}

/** P3: Kacheln je Ereignistyp, kurzes Formular, Absenden (Sie-Form). */
export function PortalEreignisFormular({
  kacheln,
  heuteIso,
  darf,
  sperrHinweis,
}: {
  kacheln: Kachel[];
  heuteIso: string;
  darf: boolean;
  sperrHinweis: string | null;
}) {
  const [state, action, pending] = useActionState(meldeEreignis, null);
  const [typ, setTyp] = useState<string | null>(null);
  const [titel, setTitel] = useState('');
  const [beschreibung, setBeschreibung] = useState('');
  const [datum, setDatum] = useState(heuteIso);
  const [dateien, setDateien] = useState<string[]>([]);

  const artOk = !!typ;
  const detailsOk = titel.trim().length >= 5 && beschreibung.trim().length >= 10 && !!datum;
  const bereit = artOk && detailsOk;
  const gewaehlt = kacheln.find((k) => k.code === typ);

  return (
    <form action={action} className="col" style={{ gap: 16 }}>
      <fieldset
        disabled={!darf || pending}
        style={{ border: 0, padding: 0, margin: 0, minWidth: 0, gap: 16 }}
        className="col"
      >
        <div className="card">
          <div className="card-header">
            <span className="card-title">1 · Art des Ereignisses</span>
            {gewaehlt ? <span className="badge-brand">{gewaehlt.label}</span> : null}
          </div>
          <div className="p-4">
            <div
              role="radiogroup"
              aria-label="Art des Ereignisses"
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))',
                gap: 12,
              }}
            >
              {kacheln.map((k) => {
                const aktiv = typ === k.code;
                return (
                  <label
                    key={k.code}
                    className="card p-3"
                    style={{
                      textAlign: 'center',
                      cursor: darf ? 'pointer' : 'not-allowed',
                      boxShadow: 'none',
                      ...(aktiv
                        ? {
                            borderColor: 'rgb(var(--brand-300))',
                            backgroundColor: 'rgb(var(--brand-50))',
                          }
                        : {}),
                    }}
                  >
                    <input
                      type="radio"
                      name="typ"
                      value={k.code}
                      checked={aktiv}
                      onChange={() => setTyp(k.code)}
                      className="sr-only"
                    />
                    <span
                      className={`icon-ring ${k.ton} mb-2`}
                      style={{ width: 32, height: 32, marginLeft: 'auto', marginRight: 'auto' }}
                    >
                      <Icon name={k.icon} />
                    </span>
                    <span
                      className={`text-xs ${aktiv ? 'font-b' : 'font-m'}`}
                      style={{
                        display: 'block',
                        ...(aktiv ? { color: 'rgb(var(--brand-700))' } : {}),
                      }}
                    >
                      {k.label}
                    </span>
                  </label>
                );
              })}
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <span className="card-title">2 · Details</span>
          </div>
          <div className="p-4 col">
            <div>
              <label className="label-sm" htmlFor="p3-datum">
                Datum (seit wann bzw. ab wann gilt die Änderung?)
              </label>
              <input
                id="p3-datum"
                type="date"
                name="datum"
                className="input"
                style={{ width: 'auto' }}
                value={datum}
                onChange={(e) => setDatum(e.target.value)}
                required
              />
            </div>
            <div>
              <label className="label-sm" htmlFor="p3-titel">
                Bezeichnung
              </label>
              <input
                id="p3-titel"
                name="titel"
                className="input"
                placeholder="z. B. Outdoor-Kochbücher ab 11/2026"
                value={titel}
                onChange={(e) => setTitel(e.target.value)}
                required
                minLength={5}
                maxLength={200}
              />
            </div>
            <div>
              <label className="label-sm" htmlFor="p3-beschreibung">
                Beschreibung
              </label>
              <textarea
                id="p3-beschreibung"
                name="beschreibung"
                className="input"
                placeholder="z. B. Wir verkaufen ab November zusätzlich Kochbücher über den eigenen Shop und Amazon …"
                value={beschreibung}
                onChange={(e) => setBeschreibung(e.target.value)}
                required
                minLength={10}
                maxLength={4000}
              />
              <div className="hint">
                Was ändert sich? Ab wann? Schätzung der Größenordnung, wenn bekannt.
              </div>
            </div>
            <div>
              <span className="label-sm">Anlagen (optional)</span>
              <label
                className="upload-zone"
                style={{ display: 'block', cursor: darf ? 'pointer' : 'not-allowed' }}
              >
                <input
                  type="file"
                  name="anlagen"
                  multiple
                  className="sr-only"
                  accept=".pdf,.png,.jpg,.jpeg,.gif,.webp,.csv,.txt,.xlsx,.xls,.docx,.doc"
                  onChange={(e) => setDateien(Array.from(e.target.files ?? []).map((f) => f.name))}
                />
                <span className="row-s" style={{ justifyContent: 'center' }}>
                  <Upload className="tx-icon-xs" aria-hidden /> Dateien hier ablegen oder{' '}
                  <span style={{ textDecoration: 'underline' }}>Datei auswählen</span>
                </span>
                <span className="hint" style={{ display: 'block' }}>
                  höchstens 5 Dateien, je bis 10 MB (PDF, Bild, CSV, Excel, Word)
                </span>
                {dateien.length ? (
                  <span className="text-xs text-secondary mt-2" style={{ display: 'block' }}>
                    {dateien.join(' · ')}
                  </span>
                ) : null}
              </label>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <span className="card-title">3 · Senden</span>
          </div>
          <div className="p-4 col">
            <div className="steps-mini" aria-label="Fortschritt">
              <div className={`st ${artOk ? 'done' : 'now'}`}>
                <span className="pt">
                  {artOk ? <Check className="tx-icon-xs" aria-hidden /> : '1'}
                </span>{' '}
                Art gewählt
              </div>
              <div className="st-line" />
              <div className={`st ${detailsOk ? 'done' : artOk ? 'now' : ''}`}>
                <span className="pt">
                  {detailsOk ? <Check className="tx-icon-xs" aria-hidden /> : '2'}
                </span>{' '}
                Details ausgefüllt
              </div>
              <div className="st-line" />
              <div className={`st ${bereit ? 'done' : ''}`}>
                <span className="pt">
                  {bereit ? <Check className="tx-icon-xs" aria-hidden /> : '3'}
                </span>{' '}
                Abgabe bereit
              </div>
            </div>
            <label className="row-s">
              <input type="checkbox" className="checkbox" name="zusage" value="1" />{' '}
              <span className="text-sm">
                Ich informiere die Kanzlei zeitnah, wenn sich an diesen Angaben etwas ändert.
              </span>
            </label>
            {state?.fehler ? (
              <div className="alert-error text-sm" role="alert">
                {state.fehler}
              </div>
            ) : null}
            <div className="form-actions">
              <Link href="/portal/tcms" className="btn-secondary">
                Abbrechen
              </Link>
              <Gesperrt
                grund={
                  !darf
                    ? sperrHinweis
                    : !bereit
                      ? 'Bitte wählen Sie die Art und füllen Sie die Details aus.'
                      : null
                }
              >
                <button
                  type="submit"
                  className="btn-primary"
                  disabled={!darf || !bereit || pending}
                  aria-busy={pending}
                >
                  <Send className="tx-icon" aria-hidden />{' '}
                  {pending ? 'Wird gesendet …' : 'Ereignis melden'}
                </button>
              </Gesperrt>
            </div>
          </div>
        </div>
      </fieldset>
    </form>
  );
}
