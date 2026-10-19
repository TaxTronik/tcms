import Link from 'next/link';
import {
  fmtDatum,
  fmtDatumZeit,
  KLASSE_LABEL,
  AUSWIRKUNG_LABEL,
  FESTSTELLUNG_KLASSE_LABEL,
  type FeststellungKlasse,
} from '@tcms/domain';
import { Icon } from '../icon';
import { StatusBadge } from '../ui/badges';
import { AktionsForm, SubmitButton } from '../ui/client';
import { FormDialog, Gesperrt } from '../feststellungen/dialog';
import { erledigeFolge, verwerfeFolge } from '@/server/actions/ereignisse';
import {
  FOLGE_STATUS_BADGE,
  FOLGE_STATUS_LABEL,
  type FolgeDetail,
} from '@/server/ereignisse-daten';

export interface PersonOption {
  id: string;
  label: string;
}

const KLEIN = { padding: '4px 8px', fontSize: 12 } as const;

/** Zeile eines Folgevorschlags in der Mehrfachauswahl (innerhalb des Formulars „Folgen anlegen"). */
export function VorschlagZeile({
  mandantId,
  ereignisId,
  f,
  personen,
  standardZustaendig,
  standardFrist,
  heuteIso,
  vorbelegt,
  hinweis,
  ereignisTitel,
  gesperrt,
  sperrGrund,
  erste,
}: {
  mandantId: string;
  ereignisId: string;
  f: FolgeDetail;
  personen: PersonOption[];
  standardZustaendig: string;
  standardFrist: string;
  heuteIso: string;
  vorbelegt: boolean;
  hinweis: string | null;
  ereignisTitel: string;
  gesperrt: boolean;
  sperrGrund: string | null;
  erste: boolean;
}) {
  return (
    <div
      className="row"
      style={{
        alignItems: 'flex-start',
        gap: 10,
        ...(erste
          ? {}
          : { borderTop: '1px solid rgb(var(--border-subtle) / 0.4)', paddingTop: 10 }),
      }}
    >
      <input
        type="checkbox"
        className="checkbox"
        name="folge"
        value={f.id}
        defaultChecked={vorbelegt}
        disabled={gesperrt}
        style={{ marginTop: 3 }}
        aria-label={`${f.artLabel} ${f.ziel ?? ''} auswählen`}
      />
      <span className="grow" style={{ minWidth: 0 }}>
        <span className="text-sm font-m text-primary" style={{ display: 'block' }}>
          {f.artLabel}
          {f.ziel ? <span className="mono"> {f.ziel}</span> : null}
        </span>
        <span className="text-xs text-muted" style={{ display: 'block' }}>
          {f.text}
        </span>
        {hinweis ? (
          <span className="text-11" style={{ display: 'block', color: '#b42318' }}>
            {hinweis}
          </span>
        ) : null}
        <span className="row-s mt-1" style={{ flexWrap: 'wrap' }}>
          <span className="text-11 text-muted">Zuständigkeit</span>
          <select
            name={`zustaendig_${f.id}`}
            className="input"
            style={KLEIN}
            defaultValue={standardZustaendig}
            disabled={gesperrt}
            title="Zuständigkeit"
          >
            <option value="">nicht festgelegt</option>
            {personen.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
          <span className="text-11 text-muted">
            {f.art === 'KONTROLLE_AUSSERPLANMAESSIG' ? 'Fällig' : 'Frist'}
          </span>
          <input
            type="date"
            name={`frist_${f.id}`}
            className="input"
            style={{ ...KLEIN, width: 'auto' }}
            defaultValue={f.art === 'FESTSTELLUNG_ANLEGEN' ? '' : standardFrist}
            min={heuteIso}
            disabled={gesperrt}
            title={
              f.art === 'KONTROLLE_AUSSERPLANMAESSIG'
                ? 'Fälligkeit der außerplanmäßigen Durchführung (Pflicht)'
                : 'Frist'
            }
          />
        </span>
        {f.art === 'FESTSTELLUNG_ANLEGEN' ? (
          <span className="col-s mt-2" style={{ display: 'flex' }}>
            <input
              name={`ftitel_${f.id}`}
              className="input"
              style={KLEIN}
              defaultValue={ereignisTitel}
              placeholder="Titel der Feststellung"
              disabled={gesperrt}
              aria-label="Titel der Feststellung"
            />
            <span className="row-s" style={{ flexWrap: 'wrap' }}>
              <select
                name={`fklasse_${f.id}`}
                className="input"
                style={KLEIN}
                defaultValue=""
                disabled={gesperrt}
                aria-label="Klasse"
              >
                <option value="">Klasse …</option>
                {(Object.keys(FESTSTELLUNG_KLASSE_LABEL) as FeststellungKlasse[]).map((k) => (
                  <option key={k} value={k}>
                    {FESTSTELLUNG_KLASSE_LABEL[k]}
                  </option>
                ))}
              </select>
              <select
                name={`fschwere_${f.id}`}
                className="input"
                style={KLEIN}
                defaultValue=""
                disabled={gesperrt}
                aria-label="Schwere"
              >
                <option value="">Schwere …</option>
                {(['GERING', 'MITTEL', 'HOCH', 'KRITISCH'] as const).map((k) => (
                  <option key={k} value={k}>
                    {KLASSE_LABEL[k]}
                  </option>
                ))}
              </select>
              <select
                name={`fauswirkung_${f.id}`}
                className="input"
                style={KLEIN}
                defaultValue=""
                disabled={gesperrt}
                aria-label="Steuerliche Auswirkung"
              >
                <option value="">Auswirkung …</option>
                {(['JA', 'NEIN', 'UNKLAR'] as const).map((k) => (
                  <option key={k} value={k}>
                    steuerl. Auswirkung: {AUSWIRKUNG_LABEL[k]}
                  </option>
                ))}
              </select>
            </span>
          </span>
        ) : null}
      </span>
      <FormDialog
        ausloeser="verwerfen"
        ausloeserClass="btn-secondary btn-tiny"
        ausloeserTitel="Vorschlag begründet verwerfen"
        titel={`Folge verwerfen: ${f.artLabel}${f.ziel ? ` ${f.ziel}` : ''}`}
        hinweis="Ein Ereignis ist erst erledigt, wenn jede Folge erledigt oder begründet verworfen ist."
        action={verwerfeFolge}
        felder={{ mandantId, ereignisId, id: f.id }}
        bestaetigen="Verwerfen"
        gefahr
        begruendungMin={30}
        disabled={gesperrt}
        disabledGrund={sperrGrund ?? undefined}
      />
    </div>
  );
}

/** Angelegte, erledigte oder verworfene Folge mit verknüpftem Objekt. */
export function FolgeZeile({
  mandantId,
  ereignisId,
  f,
  basis,
  mitStand,
  zustaendigName,
  gesperrt,
  sperrGrund,
  risikoCode,
}: {
  mandantId: string;
  ereignisId: string;
  f: FolgeDetail;
  basis: string;
  mitStand: (href: string) => string;
  zustaendigName: string | null;
  gesperrt: boolean;
  sperrGrund: string | null;
  risikoCode: string | null;
}) {
  const d = f.durchfuehrung;
  const abgeschlossen =
    !d || d.anzeige === 'OHNE_BEFUND' || d.anzeige === 'MIT_BEFUND' || d.anzeige === 'ENTFALLEN';
  const erledigenGesperrt = gesperrt || (f.art === 'KONTROLLE_AUSSERPLANMAESSIG' && !abgeschlossen);
  const erledigenGrund = gesperrt
    ? sperrGrund
    : f.art === 'KONTROLLE_AUSSERPLANMAESSIG' && !abgeschlossen
      ? 'Erst nach abgeschlossener (gegengezeichneter) Durchführung'
      : undefined;
  return (
    <div className="list-row" style={{ padding: '10px 0', gap: 10 }}>
      <span
        className={`status-dot ${f.status === 'ERLEDIGT' ? 'dot-green' : f.status === 'VERWORFEN' ? 'dot-gray' : 'dot-amber'}`}
        style={{ marginTop: 7 }}
      />
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="text-sm font-m">
          {f.artLabel}
          {f.ziel ? <span className="mono"> {f.ziel}</span> : null}
        </div>
        <div className="text-xs text-muted">{f.text}</div>
        <div className="text-11 text-muted mt-1">
          {zustaendigName ? `Zuständig: ${zustaendigName}` : 'ohne Zuständigkeit'}
          {f.frist ? ` · Frist ${fmtDatum(f.frist)}` : ''}
          {f.angelegt
            ? ` · angelegt von ${f.angelegt.von.replace(/^StB\s+/, '')}, ${fmtDatumZeit(f.angelegt.am)}`
            : ''}
        </div>
        <div className="row-wrap mt-1">
          {d ? (
            <Link
              href={mitStand(`${basis}/durchfuehrungen/${d.id}`)}
              className="row-s"
              style={{ textDecoration: 'none', flexWrap: 'wrap' }}
              title="Außerplanmäßige Durchführung öffnen"
            >
              <span className="badge-gray mono">{d.code}</span>
              <span className="text-11 text-muted">fällig {fmtDatum(d.faelligAm)}</span>
              <StatusBadge status={d.anzeige} />
            </Link>
          ) : null}
          {f.feststellung ? (
            <Link
              href={mitStand(`${basis}/feststellungen/${f.feststellung.id}`)}
              className="badge-gray"
              style={{ textDecoration: 'none' }}
              title="Zur Feststellung"
            >
              → {f.feststellung.nummer}
            </Link>
          ) : null}
          {risikoCode && (f.art === 'RISIKO_NEU_BEWERTEN' || f.art === 'RISIKO_AKTIVIEREN') ? (
            <Link
              href={mitStand(`${basis}/risiken?risiko=${risikoCode}`)}
              className="badge-gray mono"
              style={{ textDecoration: 'none' }}
            >
              {risikoCode}
            </Link>
          ) : null}
          {f.art === 'PROFIL_AENDERN' && f.status === 'ANGELEGT' ? (
            <Link href={mitStand(`${basis}/profil`)} className="text-11">
              Geschäftsprofil öffnen →
            </Link>
          ) : null}
          {f.status === 'ERLEDIGT' && f.erledigtAm ? (
            <span className="text-11 text-muted">erledigt {fmtDatumZeit(f.erledigtAm)}</span>
          ) : null}
        </div>
        {f.verwerfen ? (
          <div className="text-11 text-muted mt-1">
            Verworfen · {f.verwerfen.von.replace(/^StB\s+/, '')} · {fmtDatumZeit(f.verwerfen.am)}:{' '}
            {f.verwerfen.begruendung}
          </div>
        ) : null}
      </div>
      <span className="col-s shrink0" style={{ alignItems: 'flex-end' }}>
        <span className={FOLGE_STATUS_BADGE[f.status]}>{FOLGE_STATUS_LABEL[f.status]}</span>
        {f.status === 'ANGELEGT' ? (
          <span className="row-s">
            <AktionsForm action={erledigeFolge}>
              <input type="hidden" name="mandantId" value={mandantId} />
              <input type="hidden" name="ereignisId" value={ereignisId} />
              <input type="hidden" name="id" value={f.id} />
              <Gesperrt grund={erledigenGesperrt ? (erledigenGrund ?? 'gesperrt') : null}>
                <SubmitButton className="btn-secondary btn-tiny" disabled={erledigenGesperrt}>
                  <Icon name="Check" className="tx-icon-xs" /> erledigt
                </SubmitButton>
              </Gesperrt>
            </AktionsForm>
            <FormDialog
              ausloeser="verwerfen"
              titel={`Folge verwerfen: ${f.artLabel}${f.ziel ? ` ${f.ziel}` : ''}`}
              hinweis={
                f.art === 'KONTROLLE_AUSSERPLANMAESSIG'
                  ? 'Die angelegte Durchführung bleibt bestehen; sie entfällt nur mit Begründung und Freigabe in der Durchführung.'
                  : undefined
              }
              action={verwerfeFolge}
              felder={{ mandantId, ereignisId, id: f.id }}
              bestaetigen="Verwerfen"
              gefahr
              begruendungMin={30}
              disabled={gesperrt}
              disabledGrund={sperrGrund ?? undefined}
            />
          </span>
        ) : null}
      </span>
    </div>
  );
}
