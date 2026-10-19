import { ANZEIGE_BADGE, ANZEIGE_LABEL, fmtDatum, fmtDatumKurz, type Design } from '@tcms/domain';
import type { DurchfuehrungView } from '@/server/kontext';
import { Icon } from '../icon';
import { kurzName } from '../risiken/labels';

/** Designbeurteilung: grün „angemessen · Name · Datum", grau „nicht beurteilt", rot „Mangel". */
export function DesignBadge({
  design,
  von,
  am,
  begruendung,
  kurz,
}: {
  design: Design;
  von: string | null;
  am: Date | null;
  begruendung?: string | null;
  kurz?: boolean;
}) {
  if (design === 'NICHT_BEURTEILT') return <span className="badge-gray">nicht beurteilt</span>;
  const wer = kurzName(von);
  const titel = `Designbeurteilung: ${design === 'ANGEMESSEN' ? 'angemessen' : 'Mangel'} · ${von ?? '—'} · ${fmtDatum(am)}${begruendung ? `\n${begruendung}` : ''}`;
  if (design === 'MANGEL') {
    return (
      <span className="badge-red" title={titel}>
        {kurz
          ? `Mangel · ${wer} · ${fmtDatumKurz(am)}`
          : `Design: Mangel · ${wer} · ${fmtDatum(am)}`}
      </span>
    );
  }
  return (
    <span className="badge-green" title={titel}>
      {kurz
        ? `angemessen · ${wer} · ${fmtDatumKurz(am)}`
        : `Design: angemessen · ${wer} · ${fmtDatum(am)}`}
    </span>
  );
}

/** Status einer Durchführung mit Datum, z. B. „abgeschlossen – ohne Befund 20.09.". */
export function DurchfuehrungBadge({ d, umbruch }: { d: DurchfuehrungView; umbruch?: boolean }) {
  const datum =
    d.anzeige === 'OHNE_BEFUND' || d.anzeige === 'MIT_BEFUND' ? d.abgeschlossenAm : null;
  return (
    <span
      className={ANZEIGE_BADGE[d.anzeige]}
      title={`${d.periodeLabel} · fällig ${fmtDatum(d.faelligAm)}`}
      style={
        umbruch
          ? { whiteSpace: 'normal', maxWidth: 150, lineHeight: 1.3, borderRadius: 10 }
          : undefined
      }
    >
      {d.anzeige === 'IN_DURCHFUEHRUNG' ? <Icon name="CircleDot" className="tx-icon-xs" /> : null}
      {ANZEIGE_LABEL[d.anzeige]}
      {datum ? ` ${fmtDatumKurz(datum)}` : ''}
    </span>
  );
}

export function SchluesselBadge() {
  return (
    <span className="badge-brand" title="Schlüsselkontrolle">
      <Icon name="KeyRound" className="tx-icon-xs" /> Schlüssel
    </span>
  );
}
