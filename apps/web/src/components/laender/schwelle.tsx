import {
  EU_LIEFERSCHWELLE_EUR,
  fmtDatum,
  fmtDatumZeit,
  fmtEurGanz,
  type SchwellenErgebnis,
} from '@tcms/domain';
import { SchwellenGauge } from '@/components/ui/visual';

/** Kopfkarte EU-Lieferschwelle: laufendes Jahr und Vorjahr gegen 10.000 € (Fachkonzept S12). */
export function SchwellenKarte({
  schwelle,
  lfd,
  vorjahr,
  jahr,
  stand,
  quelle,
  erfasst,
}: {
  schwelle: SchwellenErgebnis;
  lfd: number;
  vorjahr: number;
  jahr: number;
  stand: Date | null;
  quelle: 'MANUELL' | 'CSV' | null;
  erfasst: { am: Date; von: string } | null;
}) {
  const skala = Math.max(lfd, vorjahr, EU_LIEFERSCHWELLE_EUR);
  const monat = stand ? stand.getUTCMonth() + 1 : 12;
  const MON = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
  const lfdUeber = schwelle.anteilLfd > 1;
  const lfdBadge = lfdUeber
    ? 'badge-red'
    : schwelle.anteilLfd >= 0.8
      ? 'badge-yellow'
      : 'badge-green';
  const lfdText = lfdUeber
    ? 'überschritten'
    : schwelle.anteilLfd >= 0.8
      ? `Warnung · ${Math.round(schwelle.anteilLfd * 100)} %`
      : `unterschritten · ${Math.round(schwelle.anteilLfd * 100)} %`;
  return (
    <div className="card">
      <div className="card-header">
        <span className="card-title">
          EU-Fernverkäufe — Schwelle {fmtEurGanz(EU_LIEFERSCHWELLE_EUR)} (OSS)
        </span>
        <span className="row-s" style={{ gap: 8 }}>
          <span
            className={
              schwelle.status === 'UEBERSCHRITTEN'
                ? 'badge-red'
                : schwelle.status === 'WARNUNG'
                  ? 'badge-yellow'
                  : 'badge-green'
            }
          >
            {schwelle.label}
          </span>
          <span className="text-xs text-muted">Warnung ab 80 % der Schwelle</span>
        </span>
      </div>
      <div className="p-4">
        <div className="bars" style={{ gap: 14 }}>
          <div className="bar-row">
            <span className="bar-label">
              {jahr} ({monat === 12 ? 'Jan–Dez' : `Jan–${MON[monat - 1]}`})
            </span>
            <span className="bar-track">
              <span
                className={`bar-fill ${lfdUeber ? 'r' : schwelle.anteilLfd >= 0.8 ? 'a' : 'g'}`}
                style={{ display: 'block', width: `${(lfd / skala) * 100}%` }}
              />
            </span>
            <span className="row-s" style={{ justifyContent: 'flex-end', gap: 8 }}>
              <span className="bar-val">{fmtEurGanz(lfd)}</span>
              <span className={lfdBadge}>{lfdText}</span>
            </span>
          </div>
          <div className="bar-row">
            <span className="bar-label">{jahr - 1}</span>
            <span className="bar-track">
              <span
                className="bar-fill"
                style={{ display: 'block', width: `${(vorjahr / skala) * 100}%`, opacity: 0.5 }}
              />
            </span>
            <span className="row-s" style={{ justifyContent: 'flex-end', gap: 8 }}>
              <span className="bar-val text-muted">{fmtEurGanz(vorjahr)}</span>
              <span className="badge-gray">
                {schwelle.anteilVorjahr > 1 ? 'überschritten' : 'unterschritten'}
              </span>
            </span>
          </div>
        </div>
        {schwelle.status !== 'UEBERSCHRITTEN' ? (
          <div className="mt-4">
            <div className="row-between text-11 text-muted mb-1">
              <span>Anteil an der Schwelle (laufendes Jahr)</span>
              <span className="mono">{Math.round(schwelle.anteilLfd * 100)} %</span>
            </div>
            <SchwellenGauge anteil={schwelle.anteilLfd} />
          </div>
        ) : null}
        <div className="text-11 text-muted mt-3">
          {stand ? `Stand ${fmtDatum(stand)} · ` : ''}
          {schwelle.status === 'UEBERSCHRITTEN'
            ? 'Besteuerung über OSS und lokale Registrierungen · '
            : ''}
          Balken relativ zum höchsten Wert ({fmtEurGanz(skala)}) · Schwelle vgl. § 3c Abs. 4 UStG
          (Normanker ungeprüft).
        </div>
      </div>
      <div className="card-footer">
        <span>
          Datenquelle: {quelle === 'CSV' ? 'CSV-Import' : 'manuell erfasst'}
          {erfasst ? ` am ${fmtDatumZeit(erfasst.am)} von ${erfasst.von}` : ''} · Import folgt mit
          Stufe 2
        </span>
        <span className="mono">Schwelle: {fmtEurGanz(EU_LIEFERSCHWELLE_EUR)}</span>
      </div>
    </div>
  );
}
