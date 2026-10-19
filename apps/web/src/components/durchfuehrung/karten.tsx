import Link from 'next/link';
import type { ReactNode } from 'react';
import {
  DESIGN_LABEL,
  fmtDatum,
  fmtDatumZeit,
  fmtEur,
  frequenzLabel,
  KONTROLLART_LABEL,
  AUSFUEHRUNG_LABEL,
  type Turnus,
} from '@tcms/domain';
import type { DurchfuehrungDetail, NachweisZeile, Recht } from '@/server/durchfuehrung-daten';
import type { Ergebnis } from '@/server/ergebnis';
import { Icon } from '../icon';
import { Hash, StatusBadge } from '../ui/badges';
import { EntfernenKnopf, UploadFormular } from './formulare';
import { fmtGroesse } from './werte';

type Aktion = (prev: Ergebnis, fd: FormData) => Promise<Ergebnis>;
const RAND = '1px solid rgb(var(--border-subtle))';

function name(d: DurchfuehrungDetail, id: string | null | undefined): string {
  if (!id) return '—';
  return (d.personen[id]?.name ?? '—').replace(/^StB\s+/, '');
}

function dateiIcon(n: NachweisZeile): string {
  const x = n.dateiname.toLowerCase();
  if (/\.(xlsx?|csv|ods)$/.test(x) || n.mime.includes('spreadsheet') || n.mime === 'text/csv')
    return 'FileSpreadsheet';
  return 'FileText';
}

// ---------------------------------------------------------------------------
// Nachweise
// ---------------------------------------------------------------------------

export function NachweiseKarte({
  d,
  variante,
  hochladen,
  hochladenAction,
  entfernenAction,
  felder,
  gesperrtText,
}: {
  d: DurchfuehrungDetail;
  variante: 'staff' | 'portal';
  hochladen: Recht;
  hochladenAction: Aktion;
  entfernenAction: Aktion;
  felder: Record<string, string>;
  gesperrtText: string;
}) {
  const sie = variante === 'portal';
  const mind = d.kontrolle.mindestNachweise;
  return (
    <div className="card">
      <div className="card-header">
        <span className="card-title">{sie ? 'Anlagen' : 'Nachweise'}</span>
        <span className="row-s">
          {mind > 0 ? (
            <span
              className={d.nachweise.length >= mind ? 'badge-green' : 'badge-yellow'}
              title={`Nachweisanforderung: ${d.kontrolle.nachweis}`}
            >
              {d.nachweise.length} von mind. {mind}
            </span>
          ) : null}
          <span className="badge-gray">
            {d.nachweise.length === 1 ? '1 Datei' : `${d.nachweise.length} Dateien`}
          </span>
        </span>
      </div>
      <div>
        {d.nachweise.map((n) => (
          <div key={n.id} className="list-row" style={{ alignItems: 'flex-start' }}>
            <span className="icon-ring">
              <Icon name={dateiIcon(n)} />
            </span>
            <div className="grow" style={{ minWidth: 0 }}>
              <a
                href={`/api/nachweise/${n.id}?mandant=${d.mandantId}`}
                className="text-sm font-m"
                style={{ textDecoration: 'none', wordBreak: 'break-all' }}
                download
              >
                {n.dateiname}
              </a>
              <div className="row-wrap mt-1">
                {n.gesperrt ? (
                  <span className="badge-gray" title={`SHA-256 ${n.sha256}`}>
                    <Icon name="Lock" className="tx-icon-xs" /> gesperrt · Hash{' '}
                    <Hash wert={n.sha256} />
                  </span>
                ) : (
                  <span className="badge-gray" title={`SHA-256 ${n.sha256}`}>
                    <Icon name="Hash" className="tx-icon-xs" /> Hash <Hash wert={n.sha256} />
                  </span>
                )}
                {!n.gesperrt ? (
                  <span className="badge-yellow">
                    {sie ? 'bis zum Übermitteln änderbar' : 'bis zum Einreichen änderbar'}
                  </span>
                ) : null}
                <span className="text-11 text-muted">
                  {fmtGroesse(n.groesse)} · {name(d, n.hochgeladenVon)} ·{' '}
                  {fmtDatumZeit(n.hochgeladenAm)}
                </span>
              </div>
            </div>
            <div className="row-s shrink0">
              <a
                className="btn-secondary btn-tiny"
                href={`/api/nachweise/${n.id}?mandant=${d.mandantId}`}
                download
                title="Herunterladen"
              >
                <Icon name="Download" className="tx-icon-xs" /> Download
              </a>
              {!n.gesperrt && hochladen.erlaubt && d.status !== 'GEPLANT' ? (
                <EntfernenKnopf
                  action={entfernenAction}
                  felder={{ ...felder, nachweisId: n.id }}
                  dateiname={n.dateiname}
                />
              ) : null}
            </div>
          </div>
        ))}
        {d.nachweise.length === 0 ? (
          <div className="p-4 text-sm text-muted">
            {sie ? 'Noch keine Anlagen hochgeladen.' : 'Noch keine Nachweise hochgeladen.'}{' '}
            Erwartet: {d.kontrolle.nachweis}.
          </div>
        ) : null}
        {d.nachweiseAusgeblendet > 0 ? (
          <div className="p-3 text-xs text-muted" style={{ borderTop: RAND }}>
            {d.nachweiseAusgeblendet} später hochgeladene Datei(en) zum Stichtag ausgeblendet.
          </div>
        ) : null}
      </div>
      <div className="p-3" style={{ borderTop: RAND }}>
        {hochladen.erlaubt ? (
          <UploadFormular action={hochladenAction} felder={felder} variante={variante} />
        ) : (
          <div
            className="upload-zone"
            aria-disabled="true"
            style={{ opacity: 0.6 }}
            title={hochladen.grund ?? undefined}
          >
            <Icon
              name={d.nachweise.some((n) => n.gesperrt) ? 'Lock' : 'Upload'}
              className="tx-icon-lg"
            />
            <div className="mt-1">{gesperrtText}</div>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Seitenspalte
// ---------------------------------------------------------------------------

export function KontrollbeschreibungKarte({
  d,
  frequenz,
}: {
  d: DurchfuehrungDetail;
  frequenz?: { turnus: Turnus; anlass: boolean } | null;
}) {
  const k = d.kontrolle;
  return (
    <details className="details-box" open>
      <summary>Kontrollbeschreibung</summary>
      <div className="details-body text-sm text-secondary col" style={{ gap: 6 }}>
        <span>Ziel: {k.ziel}</span>
        <span>
          Nachweis: {k.nachweis}
          {k.mindestNachweise > 0
            ? ` (mindestens ${k.mindestNachweise} ${k.mindestNachweise === 1 ? 'Datei' : 'Dateien'})`
            : ''}
          .
        </span>
        {k.toleranzEur != null ? <span>Toleranz: {fmtEur(k.toleranzEur)} je Periode.</span> : null}
        <span className="text-xs text-muted">
          {KONTROLLART_LABEL[k.art]} · {AUSFUEHRUNG_LABEL[k.ausfuehrung]}
          {frequenz ? ` · ${frequenzLabel(frequenz)}` : ''} · fällig {k.faelligNachTagen} Tage nach
          Periodenende
        </span>
        <span className="text-xs text-muted">
          Version v{k.version} · gültig ab {fmtDatum(k.gueltigAb)} ·{' '}
          {k.design === 'ANGEMESSEN'
            ? `Designbeurteilung: angemessen · ${name(d, k.designVon)} · ${fmtDatum(k.designAm)}`
            : k.design === 'MANGEL'
              ? `Designbeurteilung: Mangel · ${name(d, k.designVon)}`
              : `Designbeurteilung: ${DESIGN_LABEL[k.design]}`}
        </span>
      </div>
    </details>
  );
}

export function RisikenKarte({
  d,
  href,
}: {
  d: DurchfuehrungDetail;
  href?: (risikoId: string) => string;
}) {
  return (
    <div className="card">
      <div className="card-header">
        <span className="card-title">Verknüpfte Risiken</span>
      </div>
      <div className="p-3 row-wrap">
        {d.risiken.length === 0 ? (
          <span className="text-sm text-muted">keine aktiven Risiken verknüpft</span>
        ) : null}
        {d.risiken.map((r) =>
          href ? (
            <Link
              key={r.id}
              href={href(r.id)}
              className="badge-gray mono"
              style={{ textDecoration: 'none' }}
              title={r.titel}
            >
              {r.code}
            </Link>
          ) : (
            <span key={r.id} className="badge-gray mono" title={r.titel}>
              {r.code}
            </span>
          ),
        )}
      </div>
    </div>
  );
}

export function LetzteKarte({ d, href }: { d: DurchfuehrungDetail; href: (id: string) => string }) {
  return (
    <div className="card">
      <div className="card-header">
        <span className="card-title">Letzte Durchführungen</span>
      </div>
      <div>
        {d.letzte.length === 0 ? (
          <div className="p-3 text-sm text-muted">keine früheren Perioden</div>
        ) : null}
        {d.letzte.map((x, i) => (
          <Link
            key={x.id}
            href={href(x.id)}
            className="row-between p-3"
            style={{
              textDecoration: 'none',
              borderBottom: i < d.letzte.length - 1 ? RAND : undefined,
            }}
          >
            <span className="text-sm">{x.periodeLabel}</span>
            <StatusBadge status={x.anzeige} />
          </Link>
        ))}
      </div>
    </div>
  );
}

export function VerlaufKarte({ d, titel = 'Verlauf' }: { d: DurchfuehrungDetail; titel?: string }) {
  return (
    <div className="card">
      <div className="card-header">
        <span className="card-title">{titel}</span>
        <span
          className="text-11 text-muted"
          title="Einträge aus der Audit-Hashkette; „System“ = aus Datum abgeleitet"
        >
          Audit-Protokoll
        </span>
      </div>
      <div>
        {d.verlauf.length === 0 ? (
          <div className="p-3 text-sm text-muted">Noch keine Einträge.</div>
        ) : null}
        {d.verlauf.map((e, i) => (
          <div
            key={`${e.seq}-${i}`}
            className="p-3"
            style={{ borderBottom: i < d.verlauf.length - 1 ? RAND : undefined }}
          >
            <div className="text-xs">
              <span className="mono text-muted">
                {e.system ? fmtDatum(e.at) : fmtDatumZeit(e.at)}
              </span>{' '}
              ·{' '}
              <span className="font-m">
                {e.system ? 'System' : e.actorName.replace(/^StB\s+/, '')}
              </span>{' '}
              · {e.text}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Personenbelege: abgeschlossene Handlungen mit Name und Zeitpunkt. */
export function PersonenbelegeKarte({ d }: { d: DurchfuehrungDetail }) {
  const zeilen: { label: string; person: string; zeit: Date | null; zusatz?: ReactNode }[] = [];
  if (d.begonnenAm)
    zeilen.push({ label: 'Begonnen', person: name(d, d.durchgefuehrtVon), zeit: d.begonnenAm });
  if (d.eingereichtAm)
    zeilen.push({
      label: d.kontrolle.partei === 'MANDANT' ? 'Übermittelt' : 'Eingereicht',
      person: name(d, d.durchgefuehrtVon),
      zeit: d.eingereichtAm,
    });
  if (d.mandantBestaetigtVon)
    zeilen.push({
      label: 'Bestätigt (Mandant)',
      person: name(d, d.mandantBestaetigtVon),
      zeit: d.mandantBestaetigtAm,
    });
  if (d.zurueckgewiesenVon && d.zurueckgewiesenAm)
    zeilen.push({
      label: 'Zuletzt zurückgewiesen',
      person: name(d, d.zurueckgewiesenVon),
      zeit: d.zurueckgewiesenAm,
    });
  if (d.abgeschlossenAm && d.gegengezeichnetVon)
    zeilen.push({
      label: 'Gegengezeichnet',
      person: name(d, d.gegengezeichnetVon),
      zeit: d.abgeschlossenAm,
    });
  if (d.entfallenVon)
    zeilen.push({ label: 'Entfallen beantragt', person: name(d, d.entfallenVon), zeit: null });
  if (d.entfallenAm)
    zeilen.push({
      label: 'Entfallen freigegeben',
      person: name(d, d.entfallenFreigegebenVon),
      zeit: d.entfallenAm,
    });
  return (
    <div className="card">
      <div className="card-header">
        <span className="card-title">Personenbelege</span>
      </div>
      <div>
        {zeilen.length === 0 ? (
          <div className="p-3 text-sm text-muted">Noch keine abgeschlossenen Handlungen.</div>
        ) : null}
        {zeilen.map((z, i) => (
          <div key={i} className="row-between p-3" style={{ borderBottom: RAND, gap: 8 }}>
            <span className="text-xs text-muted">{z.label}</span>
            <span className="text-xs font-m" style={{ textAlign: 'right' }}>
              {z.person}
              {z.zeit ? ` · ${fmtDatumZeit(z.zeit)}` : ''}
            </span>
          </div>
        ))}
        <div className="p-3 text-11 text-muted">
          Das Ergebnis ist die Angabe der durchführenden Person; die Gegenzeichnung belegt die
          Vier-Augen-Handlung, nicht die materielle Richtigkeit. Ein Hash bindet Inhalte, er
          authentifiziert keine Person.
        </div>
      </div>
    </div>
  );
}
