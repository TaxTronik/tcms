import { ABSCHNITTE, fmtDatum, fmtDatumZeit } from '@tcms/domain';
import { AbschnittAnsicht, Freitext } from '@/components/beschreibung/abschnitt';
import type { BausteinQuelle, BausteinSatz } from '@/components/beschreibung/typen';
import { Icon } from '@/components/icon';
import { Hash } from '@/components/ui/badges';
import { AktionsForm, SubmitButton } from '@/components/ui/client';
import { codeAnfordern, freigeben, kenntnisnehmen } from '@/server/actions/freigaben';
import { normalisiereAbschnitte } from '@/server/beschreibung-daten';
import { brauchtCode, FREIGABE_ART_LABEL, type FreigabeEintrag } from '@/server/freigaben-daten';

export function DokThumb() {
  return (
    <span className="doc-thumb" aria-hidden="true">
      <span className="l" />
      <span className="l" />
      <span className="l s" />
      <span className="l xs" />
    </span>
  );
}

/** Dokumentansicht: Beschreibung (Snapshot bzw. aktuelle Fassung) oder Text der Kenntnisnahme. */
function Dokument({
  f,
  live,
}: {
  f: FreigabeEintrag;
  live: { stand: string; satz: BausteinSatz } | null;
}) {
  if (f.version) {
    const snap = f.version.snapshot;
    const abschnitte = snap ? normalisiereAbschnitte(snap.abschnitte) : f.version.abschnitte;
    const quelle: BausteinQuelle = snap
      ? { modus: 'snapshot', stand: snap.stand ?? null, satz: snap.bausteine ?? null }
      : live
        ? { modus: 'live', stand: live.stand, satz: live.satz }
        : { modus: 'snapshot', stand: null, satz: null };
    return (
      <div className="col" style={{ gap: 14 }}>
        {snap && f.version.snapshotSha256 ? (
          <div className="text-11 text-muted row-s" style={{ gap: 6 }}>
            <span className="badge-gray">
              <Icon name="Lock" className="tx-icon-xs" /> <Hash wert={f.version.snapshotSha256} />
            </span>
            Vorgelegte Fassung, durch SHA-256 gebunden.
          </div>
        ) : null}
        {ABSCHNITTE.map((a) => (
          <AbschnittAnsicht
            key={a.key}
            abschnitt={abschnitte.find((x) => x.key === a.key)!}
            vorlage={a}
            quelle={quelle}
            mitTitel
            lueckenHinweis={false}
          />
        ))}
      </div>
    );
  }
  if (f.inhalt) return <Freitext text={f.inhalt} />;
  return (
    <p className="text-sm text-muted">Für diese Anforderung ist kein Dokumenttext hinterlegt.</p>
  );
}

function CodeStatus({ f, jetzt }: { f: FreigabeEintrag; jetzt: Date }) {
  if (f.codeGesperrt)
    return (
      <span className="text-xs" style={{ color: '#b42318' }}>
        Der Bestätigungscode ist nach mehreren Fehlversuchen gesperrt. Bitte wenden Sie sich an Ihre
        Kanzlei.
      </span>
    );
  if (!f.hatCode || !f.codeAblauf)
    return <span className="text-xs text-muted">Noch kein Bestätigungscode angefordert.</span>;
  if (f.codeAblauf.getTime() < jetzt.getTime())
    return (
      <span className="text-xs" style={{ color: '#b42318' }}>
        Der Code ist am {fmtDatum(f.codeAblauf)} abgelaufen.
      </span>
    );
  return (
    <span className="text-xs text-muted">
      Code an Sie gesendet · gültig bis {fmtDatum(f.codeAblauf)}
    </span>
  );
}

/** Offene Freigabe oder Kenntnisnahme (P4) mit rollenabhängiger Bedienung. */
export function FreigabeKarte({
  f,
  nutzer,
  istGv,
  lesen,
  gvNamen,
  live,
  jetzt,
}: {
  f: FreigabeEintrag;
  nutzer: { id: string; email: string };
  istGv: boolean;
  lesen: boolean;
  gvNamen: string;
  live: { stand: string; satz: BausteinSatz } | null;
  jetzt: Date;
}) {
  const code = brauchtCode(f.art);
  const darfDokument = lesen || f.empfaengerId === nutzer.id;
  const gueltig =
    f.hatCode &&
    !!f.codeAblauf &&
    f.codeAblauf.getTime() >= jetzt.getTime() &&
    f.empfaengerId === nutzer.id;
  return (
    <div className="card p-4" id={`f-${f.id}`} style={{ boxShadow: 'none' }}>
      <div className="row" style={{ alignItems: 'flex-start', gap: 14 }}>
        <DokThumb />
        <div className="grow">
          <div className="row-s" style={{ gap: 8, flexWrap: 'wrap' }}>
            <span className="text-base font-s">{f.titel}</span>
            <span className={code ? 'badge-yellow' : 'badge-brand'}>
              {FREIGABE_ART_LABEL[f.art] ?? f.art}
            </span>
          </div>
          <div className="text-xs text-muted mt-1">
            {code ? 'angefordert' : 'zur Kenntnis gebeten'} am {fmtDatum(f.angefordertAm)} von{' '}
            {f.angefordertVon} ·{' '}
            {code
              ? `für die gesetzliche Vertretung (${f.empfaengerName})`
              : `an ${f.empfaengerName}`}
          </div>
        </div>
      </div>

      {darfDokument ? (
        <details className="details-box mt-3">
          <summary>
            <Icon name="FileText" className="tx-icon-xs" /> Dokument ansehen
          </summary>
          <div className="details-body" style={{ maxHeight: 520, overflowY: 'auto' }}>
            <Dokument f={f} live={live} />
          </div>
        </details>
      ) : null}

      <div
        className="mt-3"
        style={{ borderTop: '1px solid rgb(var(--border-default))', paddingTop: 12 }}
      >
        {code ? (
          istGv ? (
            <div className="col" style={{ gap: 10 }}>
              <p className="text-sm text-secondary">
                Mit der Freigabe bestätigen Sie als gesetzliche Vertretung die vorgelegte Fassung.
                Die Bestätigung erfolgt mit dem 6-stelligen Code aus Ihrer E-Mail an {nutzer.email}.
              </p>
              {gueltig ? (
                <AktionsForm
                  action={freigeben}
                  key={`freigeben-${f.id}`}
                  className="row-wrap"
                  style={{ gap: 10, alignItems: 'flex-end' }}
                >
                  <input type="hidden" name="freigabeId" value={f.id} />
                  <div>
                    <label className="label-sm" htmlFor={`code-${f.id}`}>
                      Bestätigungscode
                    </label>
                    <input
                      id={`code-${f.id}`}
                      name="code"
                      className="input mono"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      pattern="\d{6}"
                      maxLength={6}
                      placeholder="000000"
                      required
                      style={{ width: 140, letterSpacing: '0.2em' }}
                    />
                  </div>
                  <SubmitButton>
                    <Icon name="CheckCheck" className="tx-icon-xs" /> Freigeben
                  </SubmitButton>
                </AktionsForm>
              ) : null}
              <div className="row-between" style={{ flexWrap: 'wrap', gap: 8 }}>
                <CodeStatus
                  f={{ ...f, hatCode: f.hatCode && f.empfaengerId === nutzer.id }}
                  jetzt={jetzt}
                />
                <AktionsForm action={codeAnfordern} key={`code-${f.id}`}>
                  <input type="hidden" name="freigabeId" value={f.id} />
                  <SubmitButton className={gueltig ? 'btn-secondary btn-tiny' : 'btn-primary'}>
                    <Icon name="Mail" className="tx-icon-xs" />{' '}
                    {gueltig ? 'Code erneut senden' : 'Bestätigungscode per E-Mail anfordern'}
                  </SubmitButton>
                </AktionsForm>
              </div>
            </div>
          ) : (
            <div className="row-between" style={{ gap: 12, flexWrap: 'wrap' }}>
              <span className="row-s text-sm text-secondary" style={{ gap: 8 }}>
                <Icon name="Lock" className="tx-icon-xs" />
                Freigaben sind der gesetzlichen Vertretung vorbehalten
                {gvNamen ? ` (${gvNamen})` : ''}.
              </span>
              <button
                type="button"
                className="btn-primary btn-tiny"
                disabled
                title={`Nur die gesetzliche Vertretung kann freigeben${gvNamen ? `: ${gvNamen}` : ''}`}
              >
                Freigeben
              </button>
            </div>
          )
        ) : f.empfaengerId === nutzer.id ? (
          <AktionsForm
            action={kenntnisnehmen}
            key={`kenntnis-${f.id}`}
            className="row-between"
            style={{ gap: 12, flexWrap: 'wrap' }}
          >
            <input type="hidden" name="freigabeId" value={f.id} />
            <label className="row-s text-sm" style={{ gap: 8 }}>
              <input type="checkbox" className="checkbox" name="gelesen" required /> Ich habe das
              Dokument gelesen und nehme es zur Kenntnis.
            </label>
            <SubmitButton className="btn-secondary">
              <Icon name="Check" className="tx-icon-xs" /> Zur Kenntnis genommen
            </SubmitButton>
          </AktionsForm>
        ) : (
          <div className="row-between" style={{ gap: 12, flexWrap: 'wrap' }}>
            <span className="row-s text-sm text-secondary" style={{ gap: 8 }}>
              <Icon name="Lock" className="tx-icon-xs" />
              Diese Kenntnisnahme ist an {f.empfaengerName} gerichtet.
            </span>
            <button
              type="button"
              className="btn-secondary btn-tiny"
              disabled
              title={`Nur ${f.empfaengerName} kann die Kenntnisnahme bestätigen`}
            >
              Zur Kenntnis genommen
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/** Erledigte Freigabe/Kenntnisnahme als Zeile. */
export function ErledigtZeile({
  titel,
  art,
  text,
  hash,
  abgelehnt,
}: {
  titel: string;
  art: string;
  text: string;
  hash?: string | null;
  abgelehnt?: boolean;
}) {
  return (
    <div className="list-row">
      <span className={`icon-ring ${abgelehnt ? '' : 'green'}`}>
        <Icon name={abgelehnt ? 'Ban' : 'CheckCheck'} />
      </span>
      <div className="grow">
        <div className="row-s" style={{ gap: 8, flexWrap: 'wrap' }}>
          <span className="text-sm font-m">{titel}</span>
          <span className="badge-gray">{FREIGABE_ART_LABEL[art] ?? art}</span>
        </div>
        <div className="text-11 text-muted mt-1">{text}</div>
      </div>
      {hash ? (
        <span className="badge-gray shrink0" title="SHA-256 der freigegebenen Fassung">
          <Icon name="Lock" className="tx-icon-xs" /> <Hash wert={hash} />
        </span>
      ) : null}
    </div>
  );
}

export function erledigtText(f: FreigabeEintrag): { text: string; abgelehnt: boolean } {
  if (f.status === 'ABGELEHNT')
    return {
      text: `${f.anmerkung ?? 'nicht mehr offen'} · ${fmtDatumZeit(f.erledigtAm)}`,
      abgelehnt: true,
    };
  if (f.art === 'KENNTNISNAHME')
    return {
      text: `zur Kenntnis genommen · ${f.empfaengerName} · ${fmtDatumZeit(f.erledigtAm)}`,
      abgelehnt: false,
    };
  const wer = f.version?.freigegebenVon ?? f.empfaengerName;
  return {
    text: `freigegeben · ${wer} · ${fmtDatumZeit(f.erledigtAm)} · E-Mail-Code bestätigt`,
    abgelehnt: false,
  };
}
