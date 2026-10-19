'use client';

import { useMemo, useState, type ReactNode } from 'react';
import { fmtEur } from '@tcms/domain';
import { Icon } from '../icon';
import { ToleranzSkala } from '../ui/visual';
import {
  alsEingabe,
  LAGE_BADGE,
  LAGE_TEXT,
  parseDezimal,
  werteZeilen,
  type KennzahlDef,
  type Werte,
} from './werte';

// =============================================================================
// Hauptspalte einer Kontrolldurchführung: Schritte, Toleranz, Werte, Ergebnis.
// Bearbeitbar für die durchführende Person, sonst schreibgeschützt. Die
// Eingaben gehören über das form-Attribut zum EntwurfFormular in der Fußleiste;
// die Nachweis-Karte (eigenes Upload-Formular) wird als Slot eingesetzt.
// =============================================================================

export interface EditorSchritt {
  titel: string;
  hinweis: string;
  erledigt: boolean;
  kommentar: string;
}

const RAND = '1px solid rgb(var(--border-subtle))';

export function DurchfuehrungEditor({
  variante,
  formId,
  bearbeitbar,
  sperrGrund,
  schritte,
  kennzahlen,
  werte,
  toleranzEur,
  periodeKurz,
  ergebnis,
  ergebnisKommentar,
  nachweise,
  ergebnisZusatz,
  minBefund,
}: {
  variante: 'staff' | 'portal';
  formId: string;
  bearbeitbar: boolean;
  sperrGrund?: string | null;
  schritte: EditorSchritt[];
  kennzahlen: KennzahlDef[];
  werte: Werte;
  toleranzEur: number | null;
  periodeKurz: string;
  ergebnis: 'OHNE_BEFUND' | 'MIT_BEFUND' | null;
  ergebnisKommentar: string | null;
  nachweise: ReactNode;
  ergebnisZusatz?: ReactNode;
  minBefund: number;
}) {
  const sie = variante === 'portal';
  const f = bearbeitbar ? formId : undefined;
  const titel = bearbeitbar ? undefined : (sperrGrund ?? undefined);
  const [erledigt, setErledigt] = useState(() => schritte.map((s) => s.erledigt));
  const [eingaben, setEingaben] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      kennzahlen.filter((k) => !k.differenzAus).map((k) => [k.key, alsEingabe(werte[k.key]?.wert)]),
    ),
  );
  const [bemerkungen, setBemerkungen] = useState<Record<string, string>>(() =>
    Object.fromEntries(kennzahlen.map((k) => [k.key, werte[k.key]?.bemerkung ?? ''])),
  );
  const [erklaert, setErklaert] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(kennzahlen.map((k) => [k.key, werte[k.key]?.erklaert ?? false])),
  );
  const [wahl, setWahl] = useState(ergebnis);

  const live: Werte = useMemo(() => {
    const out: Werte = {};
    for (const k of kennzahlen) {
      const p = k.differenzAus ? null : parseDezimal(eingaben[k.key] ?? '');
      out[k.key] = {
        wert: p === 'fehler' ? null : p,
        bemerkung: bemerkungen[k.key] ?? '',
        erklaert: erklaert[k.key] ?? false,
      };
    }
    return out;
  }, [kennzahlen, eingaben, bemerkungen, erklaert]);
  const zeilen = werteZeilen(kennzahlen, bearbeitbar ? live : werte, toleranzEur);
  const anzahlErledigt = erledigt.filter(Boolean).length;
  const alleErledigt = schritte.length > 0 && anzahlErledigt === schritte.length;
  const differenzen = zeilen.filter(
    (z) => z.def.differenzAus && z.wert != null && toleranzEur != null,
  );

  // ---------------------------------------------------------------- Schritte
  const schrittKarte = sie ? (
    <div className="card">
      <div className="card-header">
        <span className="card-title">Schritte</span>
        <span className={alleErledigt ? 'badge-green' : 'badge-gray'}>
          {anzahlErledigt} von {schritte.length} erledigt
        </span>
      </div>
      <div className="p-4 col" style={{ gap: 12 }}>
        {schritte.map((s, i) => (
          <div key={i} className="card p-3" style={{ boxShadow: 'none' }}>
            <label className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
              <span className={`icon-ring ${erledigt[i] ? 'green' : 'amber'}`}>
                <Icon name={erledigt[i] ? 'FileCheck' : 'FileText'} />
              </span>
              <input
                type="checkbox"
                className="checkbox"
                style={{ marginTop: 9 }}
                name={`schritt_${i}_erledigt`}
                form={f}
                checked={erledigt[i] ?? false}
                disabled={!bearbeitbar}
                title={titel}
                onChange={(e) =>
                  setErledigt((a) => a.map((x, j) => (j === i ? e.target.checked : x)))
                }
              />
              <span className="grow" style={{ paddingTop: 6 }}>
                <span className="text-sm font-m" style={{ display: 'block' }}>
                  {s.titel}
                </span>
                <span className="text-xs text-muted" style={{ display: 'block', marginTop: 2 }}>
                  {s.hinweis}
                </span>
              </span>
            </label>
            {bearbeitbar ? (
              <input
                className="input mt-2"
                style={{ fontSize: 13, padding: '6px 10px' }}
                name={`schritt_${i}_kommentar`}
                form={f}
                defaultValue={s.kommentar}
                placeholder="Anmerkung (optional)"
                aria-label={`Anmerkung zu Schritt ${i + 1}`}
                maxLength={2000}
              />
            ) : s.kommentar ? (
              <div className="text-xs text-secondary mt-2">Anmerkung: {s.kommentar}</div>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  ) : (
    <div className="card">
      <div className="card-header">
        <span className="card-title">Schritte &amp; Checkliste</span>
        <span className={alleErledigt ? 'badge-green' : 'badge-gray'}>
          {anzahlErledigt} von {schritte.length}
        </span>
      </div>
      <div>
        {schritte.map((s, i) => (
          <div
            key={i}
            className="row p-3"
            style={{
              alignItems: 'flex-start',
              borderBottom: i < schritte.length - 1 ? RAND : undefined,
            }}
          >
            <input
              type="checkbox"
              className="checkbox"
              style={{ marginTop: 2 }}
              id={`schritt-${i}`}
              name={`schritt_${i}_erledigt`}
              form={f}
              checked={erledigt[i] ?? false}
              disabled={!bearbeitbar}
              title={titel}
              onChange={(e) =>
                setErledigt((a) => a.map((x, j) => (j === i ? e.target.checked : x)))
              }
            />
            <div className="grow">
              <label
                htmlFor={`schritt-${i}`}
                className="text-sm font-m"
                style={{ display: 'block' }}
              >
                {i + 1} · {s.titel}
              </label>
              <div className="text-xs text-muted mt-1">{s.hinweis}</div>
              {bearbeitbar ? (
                <input
                  className="input mt-2"
                  style={{ fontSize: 12.5, padding: '5px 10px' }}
                  name={`schritt_${i}_kommentar`}
                  form={f}
                  defaultValue={s.kommentar}
                  placeholder="Kommentar (optional)"
                  aria-label={`Kommentar zu Schritt ${i + 1}`}
                  maxLength={2000}
                />
              ) : s.kommentar ? (
                <div className="text-xs text-secondary mt-1">Kommentar: {s.kommentar}</div>
              ) : null}
            </div>
          </div>
        ))}
        {schritte.length === 0 ? (
          <div className="p-4 text-sm text-muted">
            Für diese Kontrollversion sind keine Schritte hinterlegt.
          </div>
        ) : null}
      </div>
    </div>
  );

  // ---------------------------------------------------------- Toleranz-Visual
  const toleranzKarten = differenzen.map((z) => {
    const a = kennzahlen.find((k) => k.key === z.def.differenzAus![0]);
    const b = kennzahlen.find((k) => k.key === z.def.differenzAus![1]);
    return (
      <div key={z.def.key} className="card p-4">
        <div className="text-xs font-s">
          {z.def.label} {a && b ? `${a.label} / ${b.label}` : ''}:{' '}
          <span className="mono">{fmtEur(z.wert)}</span> · Toleranz ±{fmtEur(toleranzEur)}
        </div>
        <ToleranzSkala
          wert={z.wert ?? 0}
          toleranz={toleranzEur ?? 0}
          erklaert={z.lage === 'ERKLAERT'}
        />
        <div className="text-xs text-muted mt-2">
          {z.lage === 'OK'
            ? 'innerhalb der Toleranz.'
            : z.lage === 'ERKLAERT'
              ? `außerhalb der Toleranz, erklärt: ${z.bemerkung}`
              : sie
                ? 'außerhalb der Toleranz — bitte erläutern Sie die Abweichung.'
                : 'außerhalb der Toleranz und nicht erklärt.'}
        </div>
      </div>
    );
  });

  // -------------------------------------------------------------------- Werte
  const werteKarte =
    kennzahlen.length > 0 ? (
      <div className="card">
        <div className="card-header">
          <span className="card-title">{sie ? 'Werte' : 'Werte & Toleranz'}</span>
          <span className="text-xs text-muted">
            {sie ? 'Beträge in Euro' : 'Angaben der durchführenden Person'}
          </span>
        </div>
        <div className="tbl-scroll">
          <table className="tbl">
            <thead>
              <tr>
                <th>Kennzahl</th>
                <th className="td-num">Wert {periodeKurz}</th>
                <th className="td-num">Soll/Toleranz</th>
                <th>Bemerkung</th>
              </tr>
            </thead>
            <tbody>
              {zeilen.map((z) => {
                const pruefbar =
                  z.abweichung != null || z.def.differenzAus != null || z.def.sollEur != null;
                return (
                  <tr key={z.def.key} style={{ backgroundColor: 'transparent' }}>
                    <td className={`text-sm${z.def.differenzAus ? ' font-m' : ''}`}>
                      {z.def.label}
                    </td>
                    <td className={`td-num${z.def.differenzAus ? ' font-s' : ''}`}>
                      {bearbeitbar && !z.def.differenzAus ? (
                        <input
                          className="input mono"
                          style={{
                            width: 130,
                            textAlign: 'right',
                            padding: '5px 8px',
                            fontSize: 13,
                            display: 'inline-block',
                          }}
                          name={`wert_${z.def.key}`}
                          form={f}
                          inputMode="decimal"
                          value={eingaben[z.def.key] ?? ''}
                          onChange={(e) =>
                            setEingaben((x) => ({ ...x, [z.def.key]: e.target.value }))
                          }
                          placeholder="0,00"
                          aria-label={z.def.label}
                          aria-invalid={parseDezimal(eingaben[z.def.key] ?? '') === 'fehler'}
                        />
                      ) : (
                        fmtEur(z.wert)
                      )}
                    </td>
                    <td
                      className={`td-num${z.def.sollEur == null && !z.def.differenzAus ? ' text-muted' : ''}`}
                      style={{ whiteSpace: 'nowrap' }}
                    >
                      {z.def.differenzAus
                        ? toleranzEur != null
                          ? `Toleranz ${fmtEur(toleranzEur)}`
                          : 'Soll 0,00 €'
                        : z.def.sollEur != null
                          ? fmtEur(z.def.sollEur)
                          : '—'}
                    </td>
                    <td className="text-sm" style={bearbeitbar ? { minWidth: 220 } : undefined}>
                      {bearbeitbar ? (
                        <div className="col" style={{ gap: 4 }}>
                          <input
                            className="input"
                            style={{ padding: '5px 8px', fontSize: 13 }}
                            name={`bemerkung_${z.def.key}`}
                            form={f}
                            value={bemerkungen[z.def.key] ?? ''}
                            onChange={(e) =>
                              setBemerkungen((x) => ({ ...x, [z.def.key]: e.target.value }))
                            }
                            placeholder={
                              pruefbar ? 'Erläuterung der Abweichung' : 'Bemerkung (optional)'
                            }
                            aria-label={`Bemerkung ${z.def.label}`}
                            maxLength={1000}
                          />
                          {pruefbar ? (
                            <span className="row-wrap">
                              <label className="row-s text-xs text-secondary">
                                <input
                                  type="checkbox"
                                  className="checkbox"
                                  name={`erklaert_${z.def.key}`}
                                  form={f}
                                  checked={erklaert[z.def.key] ?? false}
                                  onChange={(e) =>
                                    setErklaert((x) => ({ ...x, [z.def.key]: e.target.checked }))
                                  }
                                />
                                Abweichung erklärt
                              </label>
                              {z.lage ? (
                                <span className={LAGE_BADGE[z.lage]}>{LAGE_TEXT[z.lage]}</span>
                              ) : null}
                            </span>
                          ) : null}
                        </div>
                      ) : (
                        <span className="row-wrap">
                          {z.bemerkung ? (
                            <span>{z.bemerkung}</span>
                          ) : (
                            <span className="text-muted">—</span>
                          )}
                          {z.lage && z.lage !== 'OK' ? (
                            <span className={LAGE_BADGE[z.lage]}>{LAGE_TEXT[z.lage]}</span>
                          ) : null}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    ) : null;

  // ----------------------------------------------------------------- Ergebnis
  const optionen: {
    wert: 'OHNE_BEFUND' | 'MIT_BEFUND';
    text: string;
    icon: string;
    ton: string;
  }[] = sie
    ? [
        {
          wert: 'OHNE_BEFUND',
          text: 'keine Auffälligkeiten festgestellt',
          icon: 'Check',
          ton: 'green',
        },
        {
          wert: 'MIT_BEFUND',
          text: 'Auffälligkeiten festgestellt (bitte kommentieren)',
          icon: 'TriangleAlert',
          ton: 'amber',
        },
      ]
    : [
        { wert: 'OHNE_BEFUND', text: 'ohne Befund', icon: 'Check', ton: 'green' },
        { wert: 'MIT_BEFUND', text: 'mit Befund', icon: 'TriangleAlert', ton: 'amber' },
      ];
  const ergebnisKarte = (
    <div className="card">
      <div className="card-header">
        <span className="card-title">Ergebnis</span>
        {!sie ? (
          <span className="text-xs text-muted">
            {bearbeitbar ? 'Vorschlag für die Gegenzeichnung' : 'Angabe der durchführenden Person'}
          </span>
        ) : null}
      </div>
      <div className={sie ? 'p-4 col' : 'p-4 col-s'} style={sie ? { gap: 12 } : undefined}>
        {optionen.map((o) =>
          sie ? (
            <div key={o.wert} className="card p-3" style={{ boxShadow: 'none' }}>
              <label className="row" style={{ gap: 12 }}>
                <span className={`icon-ring ${o.ton}`}>
                  <Icon name={o.icon} />
                </span>
                <input
                  type="radio"
                  name="ergebnis"
                  value={o.wert}
                  className="checkbox"
                  form={f}
                  checked={wahl === o.wert}
                  disabled={!bearbeitbar}
                  title={titel}
                  onChange={() => setWahl(o.wert)}
                />
                <span className="text-sm grow">{o.text}</span>
              </label>
            </div>
          ) : (
            <label key={o.wert} className="row-s">
              <input
                type="radio"
                className="checkbox"
                name="ergebnis"
                value={o.wert}
                form={f}
                checked={wahl === o.wert}
                disabled={!bearbeitbar}
                title={titel}
                onChange={() => setWahl(o.wert)}
              />{' '}
              <span className={`text-sm${!bearbeitbar && wahl !== o.wert ? ' text-muted' : ''}`}>
                {o.text}
              </span>
            </label>
          ),
        )}
        {bearbeitbar ? (
          <div className="mt-2">
            <textarea
              className="input"
              name="ergebnisKommentar"
              form={f}
              defaultValue={ergebnisKommentar ?? ''}
              placeholder={
                sie
                  ? 'Kommentar zu den Auffälligkeiten …'
                  : 'Beschreibung des Befunds bzw. Bemerkung zum Ergebnis …'
              }
              aria-label="Kommentar zum Ergebnis"
              maxLength={4000}
            />
            <div className="hint">
              {sie
                ? `Nur bei Auffälligkeiten erforderlich (mindestens ${minBefund} Zeichen).`
                : `Bei „mit Befund“ Pflicht (mindestens ${minBefund} Zeichen); die Feststellung wird bei der Gegenzeichnung erfasst.`}
            </div>
          </div>
        ) : ergebnisKommentar ? (
          <div className="text-sm text-secondary mt-2" style={{ whiteSpace: 'pre-wrap' }}>
            {ergebnisKommentar}
          </div>
        ) : null}
        {ergebnisZusatz}
      </div>
    </div>
  );

  return (
    <>
      {schrittKarte}
      {toleranzKarten}
      {werteKarte}
      {nachweise}
      {ergebnisKarte}
    </>
  );
}
