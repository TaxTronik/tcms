'use server';

import { redirect } from 'next/navigation';
import { DF_MIN_BEGRUENDUNG } from '@tcms/contract';
import {
  beantrageEntfallen as dienstBeantrageEntfallen,
  beginneDurchfuehrung as dienstBeginne,
  gegenzeichneDurchfuehrung as dienstGegenzeichne,
  gibEntfallenFrei as dienstGibEntfallenFrei,
  legeNachtragAn as dienstLegeNachtragAn,
  lehneEntfallenAb as dienstLehneEntfallenAb,
} from '@tcms/service';
import {
  entfernenAls,
  handeln,
  hochladenAls,
  kanzleiHandlung,
  speichernAls,
  text,
  zurueckweisenAls,
} from '../durchfuehrung-daten';
import type { Ergebnis } from '../ergebnis';

// =============================================================================
// Server Actions der Kontrolldurchführung (S8, Kanzlei): dünne Hüllen um
// @tcms/service (Formular → Eingabe → Service im Dienstkontext des
// Demo-Akteurs mit Bezug auf den Mandanten des Formulars → Revalidierung).
// Rechte, Status, Vier-Augen und Audit prüft bzw. schreibt ausschließlich der
// Service; die Hüllen liegen in durchfuehrung-daten.ts.
// =============================================================================

const ZU_KURZ = `Bitte eine Begründung mit mindestens ${DF_MIN_BEGRUENDUNG} Zeichen angeben.`;

// ---------------------------------------------------------------------------
// Kanzlei (S8)
// ---------------------------------------------------------------------------

/** Fällig → In Durchführung. */
export async function beginneDurchfuehrung(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  return handeln(await kanzleiHandlung(fd), fd, async (ctx, ziel) => {
    await dienstBeginne(ctx, ziel);
    return { ok: 'Durchführung begonnen.' };
  });
}

/** Schritte abhaken, Werte und Ergebnisvorschlag speichern; optional einreichen. */
export async function speichereDurchfuehrung(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  return speichernAls(await kanzleiHandlung(fd), fd);
}

export async function ladeNachweisHoch(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  return hochladenAls(await kanzleiHandlung(fd), fd);
}

export async function entferneNachweis(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  return entfernenAls(await kanzleiHandlung(fd), fd);
}

export async function weiseDurchfuehrungZurueck(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  return zurueckweisenAls(await kanzleiHandlung(fd), fd);
}

/** Gegenzeichnen; bei Befund ohne verknüpfte Feststellung mit Inline-Erfassung (Dialog). */
export async function gegenzeichneDurchfuehrung(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  const h = await kanzleiHandlung(fd);
  const feststellung = fd.has('fTitel')
    ? {
        titel: text(fd, 'fTitel'),
        sachverhalt: text(fd, 'fSachverhalt'),
        klasse: text(fd, 'fKlasse'),
        schwere: text(fd, 'fSchwere'),
        auswirkung: text(fd, 'fAuswirkung'),
        risikoIds: [
          ...new Set(fd.getAll('fRisiko').filter((v): v is string => typeof v === 'string')),
        ],
      }
    : undefined;
  return handeln(h, fd, async (ctx, ziel) => {
    const r = await dienstGegenzeichne(ctx, {
      ...ziel,
      ...(feststellung ? { feststellung: feststellung as never } : {}),
    });
    return {
      ok:
        r.status === 'MIT_BEFUND'
          ? `Gegengezeichnet – abgeschlossen mit Befund (Feststellung ${r.feststellung?.nummer ?? '—'}).`
          : 'Gegengezeichnet – abgeschlossen ohne Befund.',
    };
  });
}

export async function beantrageEntfallen(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  const begruendung = text(fd, 'begruendung').trim().slice(0, 4000);
  if (begruendung.length < DF_MIN_BEGRUENDUNG) return { fehler: ZU_KURZ };
  return handeln(await kanzleiHandlung(fd), fd, async (ctx, ziel) => {
    await dienstBeantrageEntfallen(ctx, { ...ziel, begruendung });
    return {
      ok: 'Entfallen beantragt. Die Freigabe erfolgt durch eine zweite Person (Berufsträger:in).',
    };
  });
}

export async function gibEntfallenFrei(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  return handeln(await kanzleiHandlung(fd), fd, async (ctx, ziel) => {
    await dienstGibEntfallenFrei(ctx, ziel);
    return { ok: 'Entfallen freigegeben. Die Durchführung zählt nicht als „ohne Befund“.' };
  });
}

/** Antrag ablehnen (zweite Person, Begründung ≥ 30) oder als antragstellende Person zurückziehen. */
export async function lehneEntfallenAb(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  const h = await kanzleiHandlung(fd);
  const begruendung = text(fd, 'begruendung').trim().slice(0, 4000);
  return handeln(h, fd, async (ctx, ziel) => {
    const zieheZurueck = begruendung.length === 0;
    await dienstLehneEntfallenAb(ctx, { ...ziel, ...(zieheZurueck ? {} : { begruendung }) });
    return { ok: zieheZurueck ? 'Antrag zurückgezogen.' : 'Antrag abgelehnt.' };
  });
}

export async function legeNachtragAn(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  const begruendung = text(fd, 'begruendung').trim().slice(0, 4000);
  if (begruendung.length < DF_MIN_BEGRUENDUNG)
    return {
      fehler: `Bitte den Anlass des Nachtrags mit mindestens ${DF_MIN_BEGRUENDUNG} Zeichen begründen.`,
    };
  const h = await kanzleiHandlung(fd);
  let ziel: string | null = null;
  const erg = await handeln(h, fd, async (ctx, z) => {
    const r = await dienstLegeNachtragAn(ctx, { ...z, begruendung });
    ziel = `/staff/clients/${h.mandantId}/tcms/durchfuehrungen/${r.durchfuehrungId}`;
    return { ok: 'Nachtrag angelegt.' };
  });
  if (ziel) redirect(ziel);
  return erg;
}
