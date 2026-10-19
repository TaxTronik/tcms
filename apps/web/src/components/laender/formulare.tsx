import Link from 'next/link';
import { EU_LAENDER, isoDatum, LAND_NAME } from '@tcms/domain';
import { Icon } from '@/components/icon';
import { AktionsForm, SubmitButton } from '@/components/ui/client';
import { landHinzufuegen, speichereLaender, speichereLandStand } from '@/server/actions/laender';
import type { LandView } from '@/server/kontext';

const KLEIN = { padding: '4px 6px', fontSize: 12 } as const;

interface Werte {
  fernverkaeufeLfdEur: number;
  fernverkaeufeVorjahrEur: number;
  lagerSeit: string | null;
  oss: boolean;
  lokaleUstNr: boolean;
  zmRelevant: boolean;
  steuersaetzeGeprueftAm: Date | null;
}

const LEER: Werte = {
  fernverkaeufeLfdEur: 0,
  fernverkaeufeVorjahrEur: 0,
  lagerSeit: null,
  oss: true,
  lokaleUstNr: false,
  zmRelevant: false,
  steuersaetzeGeprueftAm: null,
};

/** Eingabefelder eines Landes (Drawer und „Land hinzufügen"). */
function Felder({ w, heute, ip }: { w: Werte; heute: string; ip: string }) {
  return (
    <div className="g12" style={{ gap: 10 }}>
      <div className="gc-6">
        <label className="label-sm" htmlFor={`${ip}-fernverkaeufeLfdEur`}>
          Fernverkäufe lfd. Jahr (€)
        </label>
        <input
          id={`${ip}-fernverkaeufeLfdEur`}
          name="fernverkaeufeLfdEur"
          className="input mono"
          type="number"
          min={0}
          step="0.01"
          defaultValue={w.fernverkaeufeLfdEur}
          required
        />
      </div>
      <div className="gc-6">
        <label className="label-sm" htmlFor={`${ip}-fernverkaeufeVorjahrEur`}>
          Fernverkäufe Vorjahr (€)
        </label>
        <input
          id={`${ip}-fernverkaeufeVorjahrEur`}
          name="fernverkaeufeVorjahrEur"
          className="input mono"
          type="number"
          min={0}
          step="0.01"
          defaultValue={w.fernverkaeufeVorjahrEur}
          required
        />
      </div>
      <div className="gc-6">
        <label className="label-sm" htmlFor={`${ip}-lagerSeit`}>
          Lager seit (Monat)
        </label>
        <input
          id={`${ip}-lagerSeit`}
          name="lagerSeit"
          className="input"
          type="month"
          defaultValue={w.lagerSeit ?? ''}
        />
        <div className="hint">leer = kein Lager im Land</div>
      </div>
      <div className="gc-6">
        <label className="label-sm" htmlFor={`${ip}-steuersaetzeGeprueftAm`}>
          Steuersätze geprüft am
        </label>
        <input
          id={`${ip}-steuersaetzeGeprueftAm`}
          name="steuersaetzeGeprueftAm"
          className="input"
          type="date"
          max={heute}
          defaultValue={w.steuersaetzeGeprueftAm ? isoDatum(w.steuersaetzeGeprueftAm) : ''}
        />
      </div>
      <div className="gc-12 row-wrap" style={{ gap: 18 }}>
        <label className="row-s text-sm">
          <input type="checkbox" className="checkbox" name="oss" defaultChecked={w.oss} /> OSS
        </label>
        <label className="row-s text-sm">
          <input
            type="checkbox"
            className="checkbox"
            name="lokaleUstNr"
            defaultChecked={w.lokaleUstNr}
          />{' '}
          lokale USt-Nr. erteilt
        </label>
        <label className="row-s text-sm">
          <input
            type="checkbox"
            className="checkbox"
            name="zmRelevant"
            defaultChecked={w.zmRelevant}
          />{' '}
          ZM-relevante Bewegungen
        </label>
      </div>
    </div>
  );
}

function StandFeld({ heute, min, ip }: { heute: string; min?: string; ip: string }) {
  return (
    <div>
      <label className="label-sm" htmlFor={`${ip}-stand`}>
        Stand (Datum der Daten)
      </label>
      <input
        id={`${ip}-stand`}
        name="stand"
        className="input"
        type="date"
        max={heute}
        min={min}
        defaultValue={heute}
        required
        style={{ maxWidth: 200 }}
      />
    </div>
  );
}

/** Neuer Stand für ein Land (im Drawer). */
export function LandStandForm({
  mandantId,
  land,
  heute,
}: {
  mandantId: string;
  land: LandView;
  heute: string;
}) {
  return (
    <AktionsForm
      action={speichereLandStand}
      key={`land-${land.land}`}
      className="col"
      style={{ gap: 10 }}
    >
      <input type="hidden" name="mandantId" value={mandantId} />
      <input type="hidden" name="land" value={land.land} />
      <StandFeld heute={heute} min={isoDatum(land.stand)} ip="drawer" />
      <Felder w={land} heute={heute} ip="drawer" />
      <div
        className="form-actions"
        style={{ justifyContent: 'space-between', alignItems: 'center' }}
      >
        <span className="text-11 text-muted">
          Der bisherige Stand bleibt unverändert in der Historie.
        </span>
        <SubmitButton>
          <Icon name="Save" className="tx-icon-xs" /> Neuen Stand speichern
        </SubmitButton>
      </div>
    </AktionsForm>
  );
}

/** Sammelerfassung: alle Länder zu einem Stand. */
export function SammelErfassung({
  mandantId,
  laender,
  heute,
  zurueck,
}: {
  mandantId: string;
  laender: LandView[];
  heute: string;
  zurueck: string;
}) {
  return (
    <AktionsForm
      action={speichereLaender}
      key="sammel"
      className="card mt-4"
      style={{ overflow: 'hidden' }}
    >
      <input type="hidden" name="mandantId" value={mandantId} />
      <div className="card-header" style={{ flexWrap: 'wrap', gap: 12 }}>
        <span className="card-title">Länderdaten erfassen</span>
        <span className="row-s" style={{ gap: 8 }}>
          <label className="label-sm" htmlFor="sammel-stand" style={{ marginBottom: 0 }}>
            Stand
          </label>
          <input
            id="sammel-stand"
            name="stand"
            className="input"
            type="date"
            max={heute}
            defaultValue={heute}
            required
            style={{ width: 'auto', ...KLEIN }}
          />
        </span>
      </div>
      <div className="tbl-scroll">
        <table className="tbl">
          <thead>
            <tr>
              <th>Land</th>
              <th className="td-num">Fernverkäufe lfd. Jahr (€)</th>
              <th className="td-num">Vorjahr (€)</th>
              <th>Lager seit</th>
              <th>OSS</th>
              <th>Lokale USt-Nr.</th>
              <th>ZM-relevant</th>
              <th>Steuersätze geprüft am</th>
            </tr>
          </thead>
          <tbody>
            {laender.map((l) => (
              <tr key={l.land}>
                <td style={{ padding: '8px 16px' }}>
                  <input type="hidden" name="land" value={l.land} />
                  <span className="text-sm font-m">{l.land}</span>{' '}
                  <span className="text-xs text-muted">{LAND_NAME[l.land] ?? ''}</span>
                </td>
                <td style={{ padding: '8px 12px' }}>
                  <input
                    aria-label={`${l.land} Fernverkäufe lfd. Jahr`}
                    name={`${l.land}.fernverkaeufeLfdEur`}
                    className="input mono"
                    type="number"
                    min={0}
                    step="0.01"
                    defaultValue={l.fernverkaeufeLfdEur}
                    style={{ ...KLEIN, textAlign: 'right', minWidth: 120 }}
                  />
                </td>
                <td style={{ padding: '8px 12px' }}>
                  <input
                    aria-label={`${l.land} Fernverkäufe Vorjahr`}
                    name={`${l.land}.fernverkaeufeVorjahrEur`}
                    className="input mono"
                    type="number"
                    min={0}
                    step="0.01"
                    defaultValue={l.fernverkaeufeVorjahrEur}
                    style={{ ...KLEIN, textAlign: 'right', minWidth: 110 }}
                  />
                </td>
                <td style={{ padding: '8px 12px' }}>
                  <input
                    aria-label={`${l.land} Lager seit`}
                    name={`${l.land}.lagerSeit`}
                    className="input"
                    type="month"
                    defaultValue={l.lagerSeit ?? ''}
                    style={{ ...KLEIN, minWidth: 130 }}
                  />
                </td>
                <td style={{ padding: '8px 12px' }}>
                  <input
                    aria-label={`${l.land} OSS`}
                    type="checkbox"
                    className="checkbox"
                    name={`${l.land}.oss`}
                    defaultChecked={l.oss}
                  />
                </td>
                <td style={{ padding: '8px 12px' }}>
                  <input
                    aria-label={`${l.land} lokale USt-Nr.`}
                    type="checkbox"
                    className="checkbox"
                    name={`${l.land}.lokaleUstNr`}
                    defaultChecked={l.lokaleUstNr}
                  />
                </td>
                <td style={{ padding: '8px 12px' }}>
                  <input
                    aria-label={`${l.land} ZM-relevant`}
                    type="checkbox"
                    className="checkbox"
                    name={`${l.land}.zmRelevant`}
                    defaultChecked={l.zmRelevant}
                  />
                </td>
                <td style={{ padding: '8px 12px' }}>
                  <input
                    aria-label={`${l.land} Steuersätze geprüft am`}
                    name={`${l.land}.steuersaetzeGeprueftAm`}
                    className="input"
                    type="date"
                    max={heute}
                    defaultValue={
                      l.steuersaetzeGeprueftAm ? isoDatum(l.steuersaetzeGeprueftAm) : ''
                    }
                    style={{ ...KLEIN, minWidth: 130 }}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="card-footer" style={{ flexWrap: 'wrap', gap: 10 }}>
        <span>
          Je Land entsteht ein neuer Stand; frühere Stände bleiben erhalten. Ein neu erfasstes Lager
          legt ein Ereignis T-02 an.
        </span>
        <span className="row-s" style={{ gap: 8 }}>
          <Link href={zurueck} className="btn-secondary">
            Abbrechen
          </Link>
          <SubmitButton>
            <Icon name="Save" className="tx-icon-xs" /> Alle Stände speichern
          </SubmitButton>
        </span>
      </div>
    </AktionsForm>
  );
}

/** Weiteres EU-Land in den Monitor aufnehmen. */
export function LandHinzufuegenForm({
  mandantId,
  vorhanden,
  heute,
}: {
  mandantId: string;
  vorhanden: string[];
  heute: string;
}) {
  const frei = EU_LAENDER.filter((l) => l !== 'DE' && !vorhanden.includes(l));
  return (
    <div className="card mt-4" id="land-neu">
      <div className="card-header">
        <span className="card-title">Land hinzufügen</span>
        <span className="text-xs text-muted">{frei.length} EU-Länder noch nicht im Monitor</span>
      </div>
      <AktionsForm action={landHinzufuegen} key="land-neu" className="p-4 col" style={{ gap: 10 }}>
        <input type="hidden" name="mandantId" value={mandantId} />
        <div className="row-wrap" style={{ gap: 16, alignItems: 'flex-end' }}>
          <div>
            <label className="label-sm" htmlFor="land-neu-code">
              Land
            </label>
            <select
              id="land-neu-code"
              name="land"
              className="input"
              required
              defaultValue=""
              style={{ minWidth: 220 }}
            >
              <option value="" disabled>
                Land wählen …
              </option>
              {frei.map((l) => (
                <option key={l} value={l}>
                  {l} · {LAND_NAME[l] ?? l}
                </option>
              ))}
            </select>
          </div>
          <StandFeld heute={heute} ip="neu" />
        </div>
        <Felder w={LEER} heute={heute} ip="neu" />
        <div className="form-actions">
          <SubmitButton disabled={!frei.length}>
            <Icon name="Plus" className="tx-icon-xs" /> Land aufnehmen
          </SubmitButton>
        </div>
      </AktionsForm>
    </div>
  );
}
