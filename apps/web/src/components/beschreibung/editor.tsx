import Link from 'next/link';
import { BAUSTEIN_LABEL, type Abschnitt, type BausteinArt } from '@tcms/domain';
import { Icon } from '@/components/icon';
import { AktionsForm, SubmitButton } from '@/components/ui/client';
import { speichereAbschnitt } from '@/server/actions/beschreibung';
import { BausteinBlock } from './baustein';
import type { BausteinQuelle } from './typen';

/** Formular je Abschnitt: Freitextblöcke als Textarea, Bausteine bleiben nicht editierbar. */
export function AbschnittEditor({
  mandantId,
  versionId,
  abschnitt,
  quelle,
  abbrechenHref,
}: {
  mandantId: string;
  versionId: string;
  abschnitt: Abschnitt;
  quelle: BausteinQuelle;
  abbrechenHref: string;
}) {
  const vorhanden = new Set(
    abschnitt.bloecke
      .filter((b) => b.typ === 'baustein')
      .map((b) => (b as { art: BausteinArt }).art),
  );
  const frei = (Object.keys(BAUSTEIN_LABEL) as BausteinArt[]).filter((a) => !vorhanden.has(a));
  const ohneText = !abschnitt.bloecke.some((b) => b.typ === 'text');
  return (
    <AktionsForm
      action={speichereAbschnitt}
      key={`${versionId}-${abschnitt.key}`}
      className="col"
      style={{ gap: 6 }}
    >
      <input type="hidden" name="mandantId" value={mandantId} />
      <input type="hidden" name="versionId" value={versionId} />
      <input type="hidden" name="key" value={abschnitt.key} />
      {/* Aufbau des Abschnitts beim Öffnen: ordnet Textfelder und Entfernen-Haken den Blöcken zu. */}
      <input
        type="hidden"
        name="struktur"
        value={JSON.stringify(
          abschnitt.bloecke.map((b) =>
            b.typ === 'text' ? { typ: 'text' } : { typ: 'baustein', art: b.art },
          ),
        )}
      />
      {ohneText ? (
        <>
          <label className="label-sm" htmlFor="text_neu">
            Freitext
          </label>
          <textarea
            id="text_neu"
            name="text_neu"
            className="input"
            rows={6}
            placeholder="Text dieses Abschnitts …"
          />
        </>
      ) : null}
      {abschnitt.bloecke.map((b, i) =>
        b.typ === 'text' ? (
          <div key={i}>
            <label className="label-sm" htmlFor={`text_${i}`}>
              Freitext{' '}
              {abschnitt.bloecke.filter((x) => x.typ === 'text').length > 1
                ? `(Block ${i + 1})`
                : ''}
            </label>
            <textarea
              id={`text_${i}`}
              name={`text_${i}`}
              className="input"
              rows={Math.min(14, Math.max(5, Math.ceil(b.text.length / 90) + 1))}
              defaultValue={b.text}
              placeholder="Text dieses Abschnitts … (Absätze durch eine Leerzeile trennen)"
            />
          </div>
        ) : (
          <BausteinBlock
            key={i}
            art={b.art}
            quelle={quelle}
            aktion={
              <label
                className="row-s text-11 text-muted"
                title="Baustein beim Speichern aus dem Abschnitt entfernen"
              >
                <input type="checkbox" className="checkbox" name={`entfernen_${i}`} /> entfernen
              </label>
            }
          />
        ),
      )}
      <div className="row-between mt-3" style={{ flexWrap: 'wrap', gap: 8 }}>
        <span className="row-s">
          <label className="label-sm" htmlFor="neuerBaustein" style={{ marginBottom: 0 }}>
            <Icon name="Plus" className="tx-icon-xs" /> Baustein einfügen
          </label>
          <select
            id="neuerBaustein"
            name="neuerBaustein"
            className="input"
            style={{ width: 'auto', padding: '4px 8px', fontSize: 12 }}
            defaultValue=""
          >
            <option value="">—</option>
            {frei.map((a) => (
              <option key={a} value={a}>
                {BAUSTEIN_LABEL[a]}
              </option>
            ))}
          </select>
        </span>
        <span className="row-s" style={{ gap: 8 }}>
          <Link href={abbrechenHref} className="btn-secondary">
            Fertig
          </Link>
          <SubmitButton>
            <Icon name="Save" className="tx-icon-xs" /> Abschnitt speichern
          </SubmitButton>
        </span>
      </div>
    </AktionsForm>
  );
}
