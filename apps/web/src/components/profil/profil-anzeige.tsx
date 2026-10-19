import type { ReactNode } from 'react';
import {
  fmtEurGanz,
  fmtMonatJahr,
  LAND_NAME,
  PROFIL_FRAGEN,
  type Geschaeftsprofil,
} from '@tcms/domain';
import { LAGER_ART_LABEL, type FrageDiff } from './profil-logik';

// =============================================================================
// Lesbare Darstellung eines Profilstands (P1–P12) und Diff zum Vorgänger.
// =============================================================================

type Key = keyof Geschaeftsprofil;

const jn = (b: boolean) => (b ? 'ja' : 'nein');

function Laender({ codes, leer = '—' }: { codes: string[]; leer?: string }) {
  if (!codes.length) return <span className="text-sm text-muted">{leer}</span>;
  return (
    <span className="row-wrap" style={{ gap: 4 }}>
      {codes.map((c) => (
        <span key={c} className="badge-brand mono" title={LAND_NAME[c] ?? c}>
          {c}
        </span>
      ))}
    </span>
  );
}

function Werte({ liste, leer = 'keine' }: { liste: string[]; leer?: string }) {
  if (!liste.length) return <span className="text-sm text-muted">{leer}</span>;
  return (
    <span className="row-wrap" style={{ gap: 4 }}>
      {liste.map((w) => (
        <span key={w} className="badge-gray">
          {w}
        </span>
      ))}
    </span>
  );
}

function Zeile({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="row-between" style={{ gap: 12, alignItems: 'flex-start', padding: '3px 0' }}>
      <span className="text-sm text-secondary shrink0">{label}</span>
      <span className="text-sm" style={{ textAlign: 'right' }}>
        {children}
      </span>
    </div>
  );
}

function inhalt(p: Geschaeftsprofil, key: Key): ReactNode {
  switch (key) {
    case 'p1':
      return (
        <>
          <Zeile label="Eigener Shop">{p.p1.eigenerShop ? p.p1.shopSystem || 'ja' : 'nein'}</Zeile>
          <Zeile label="Marktplätze">
            <Werte liste={p.p1.marktplaetze} />
          </Zeile>
        </>
      );
    case 'p2':
      return (
        <>
          <Zeile label="Eigenversand ab DE">{jn(p.p2.eigenversandDE)}</Zeile>
          <Zeile label="Lager">
            {p.p2.lager.length ? (
              <span className="col-s" style={{ alignItems: 'flex-end' }}>
                {p.p2.lager.map((l) => (
                  <span key={l.land} className="row-s">
                    <span className="badge-brand mono">{l.land}</span>
                    <span className="text-xs text-muted">
                      seit {fmtMonatJahr(l.seit)} · {LAGER_ART_LABEL[l.art] ?? l.art}
                    </span>
                  </span>
                ))}
              </span>
            ) : (
              <span className="text-muted">keine</span>
            )}
          </Zeile>
        </>
      );
    case 'p3':
      return (
        <>
          <Zeile label="Zielländer">
            <Laender codes={p.p3.laender} />
          </Zeile>
          <Zeile label="B2B-Anteil">{p.p3.b2bAnteilProzent} %</Zeile>
          <Zeile label="EU-B2B · Inland-B2B">
            {jn(p.p3.b2bEU)} · {jn(p.p3.b2bInland)}
          </Zeile>
        </>
      );
    case 'p4':
      return (
        <>
          <Zeile label="Warengruppen">
            <span className="col-s" style={{ alignItems: 'flex-end' }}>
              {p.p4.warengruppen.map((w) => (
                <span key={w.name}>
                  {w.name}{' '}
                  {w.abweichenderSatz ? (
                    <span className="badge-yellow">abweichender Satz</span>
                  ) : (
                    <span className="text-xs text-muted">Regelsatz</span>
                  )}
                </span>
              ))}
            </span>
          </Zeile>
          <Zeile label="Gebrauchtware">{jn(p.p4.gebrauchtware)}</Zeile>
        </>
      );
    case 'p5':
      return p.p5.drittlandImport ? (
        <>
          <Zeile label="Import aus">
            <Laender codes={p.p5.laender} />
          </Zeile>
          <Zeile label="Zollabwicklung">{p.p5.zollabwicklung || '—'}</Zeile>
        </>
      ) : (
        <Zeile label="Drittlandimport">nein</Zeile>
      );
    case 'p6':
      return (
        <Zeile label="Zahlungswege">
          <Werte liste={p.p6.zahlungswege} />
        </Zeile>
      );
    case 'p7':
      return (
        <Zeile label="Gutscheine · Abos · Bundles">
          {jn(p.p7.gutscheine)} · {jn(p.p7.abos)} · {jn(p.p7.bundles)}
        </Zeile>
      );
    case 'p8':
      return (
        <Zeile label="Systeme">
          {p.p8.systeme.length ? (
            <span className="col-s" style={{ alignItems: 'flex-end' }}>
              {p.p8.systeme.map((s, i) => (
                <span key={i}>
                  <span className="text-xs text-muted">{s.art}:</span> {s.name}
                  {s.version && s.version !== '—' ? ` ${s.version}` : ''}
                </span>
              ))}
            </span>
          ) : (
            <span className="text-muted">keine erfasst</span>
          )}
        </Zeile>
      );
    case 'p9':
      return (
        <>
          <Zeile label="OSS · IOSS">
            {p.p9.ossSeit ? `seit ${fmtMonatJahr(p.p9.ossSeit)}` : 'kein OSS'} ·{' '}
            {p.p9.ioss ? 'IOSS' : 'kein IOSS'}
          </Zeile>
          <Zeile label="Lokale USt-Registrierungen">
            <Laender codes={p.p9.lokaleUstNr} leer="keine" />
          </Zeile>
          <Zeile label="Dauerfristverlängerung">{jn(p.p9.dauerfrist)}</Zeile>
        </>
      );
    case 'p10':
      return (
        <>
          <Zeile label="Vorjahresumsatz">
            <span className="mono">{fmtEurGanz(p.p10.vorjahresumsatzEur)}</span>
          </Zeile>
          <Zeile label="EU-Fernverkäufe Vorjahr">
            <span className="mono">{fmtEurGanz(p.p10.euFernverkaeufeVorjahrEur)}</span>
          </Zeile>
          <Zeile label="EU-Fernverkäufe lfd. Jahr">
            <span className="mono">{fmtEurGanz(p.p10.euFernverkaeufeLfdEur)}</span>
          </Zeile>
        </>
      );
    case 'p11':
      return (
        <Zeile label="Ausländische Leistende">
          {p.p11.vorhanden ? (
            <Werte liste={p.p11.anbieter} />
          ) : (
            <span className="text-muted">keine</span>
          )}
        </Zeile>
      );
    case 'p12':
      return (
        <Zeile label="Buchhaltung">
          {p.p12.buchhaltung === 'KANZLEI' ? 'über die Kanzlei' : 'intern'}
        </Zeile>
      );
  }
}

const GRUPPEN = [...new Set(PROFIL_FRAGEN.map((f) => f.gruppe))];

/** Profil gruppiert in zwei Spalten; geänderte Fragen (gegenüber dem Vorgänger) sind markiert. */
export function ProfilAnzeige({
  profil,
  geaendert,
}: {
  profil: Geschaeftsprofil;
  geaendert?: ReadonlySet<string>;
}) {
  return (
    <div className="g12" style={{ gap: '8px 28px' }}>
      {GRUPPEN.map((g) => (
        <div key={g} className="gc-6">
          <div className="text-xs font-s text-secondary mb-2 mt-2">{g}</div>
          {PROFIL_FRAGEN.filter((f) => f.gruppe === g).map((f) => {
            const neu = geaendert?.has(f.key);
            return (
              <div
                key={f.key}
                className="mb-2"
                style={{
                  borderLeft: `2px solid ${neu ? 'rgb(var(--brand-500))' : 'rgb(var(--border-subtle))'}`,
                  paddingLeft: 10,
                }}
                title={neu ? 'gegenüber dem vorherigen Stand geändert' : undefined}
              >
                <div className="label-sm row-s" style={{ marginBottom: 2 }}>
                  {f.nr} · {f.titel}
                  {neu ? (
                    <span className="badge-brand" style={{ padding: '0 6px', fontSize: 11 }}>
                      geändert
                    </span>
                  ) : null}
                </div>
                {inhalt(profil, f.key)}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/** Diff-Zeilen zum Vorgängerstand. */
export function ProfilDiffListe({ diff }: { diff: FrageDiff[] }) {
  if (!diff.length) return <p className="text-xs text-muted">Keine inhaltliche Änderung.</p>;
  return (
    <div className="col" style={{ gap: 6 }}>
      {diff.map((d) => (
        <div key={d.key}>
          <div className="text-xs font-s text-secondary">
            {d.nr} · {d.titel}
          </div>
          {d.neu.map((z) => (
            <div key={`n-${z}`} className="text-xs row-s" style={{ alignItems: 'flex-start' }}>
              <span className="mono" style={{ color: '#166534', width: 10 }}>
                +
              </span>
              <span>{z}</span>
            </div>
          ))}
          {d.entfallen.map((z) => (
            <div
              key={`e-${z}`}
              className="text-xs row-s text-muted"
              style={{ alignItems: 'flex-start' }}
            >
              <span className="mono" style={{ color: '#b42318', width: 10 }}>
                −
              </span>
              <span style={{ textDecoration: 'line-through' }}>{z}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
