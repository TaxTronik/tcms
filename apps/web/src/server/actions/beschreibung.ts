'use server';

import { redirect } from 'next/navigation';
import { z } from 'zod';
import { DienstFehler } from '@tcms/contract';
import { BAUSTEIN_LABEL, type Abschnitt, type BausteinArt } from '@tcms/domain';
import {
  fordereBeschreibungsfreigabeAn,
  gibBeschreibungZurReview,
  imDienst,
  legeBeschreibungsversionAn,
  schliesseBeschreibungsreviewAb,
  speichereBeschreibungsabschnitt,
  weiseBeschreibungsreviewZurueck,
  type DienstKontext,
} from '@tcms/service';
import { aktualisiereMandant, KEIN_RECHT } from '../aktion';
import { DEMO_PORTS, demoPersonen, kontakteMitRolle, zustaendigkeit } from '../demo';
import type { Ergebnis } from '../ergebnis';
import { demoAkteur } from '../sitzung';

// =============================================================================
// CMS-Beschreibung (Fachkonzept S14, §9): dünne Hüllen um @tcms/service.
// Formular → Eingabe → Service (Rechte, Vier-Augen, Sperren, Snapshot) →
// Meldung. Empfänger, Zuständigkeit und Namen übergibt die Demo wie die
// kanzleikonsole.
// =============================================================================

const Ids = z.object({ mandantId: z.uuid(), versionId: z.string().min(1).max(64) });

function meldung(e: DienstFehler): string {
  if (e.code === 'NICHT_GEFUNDEN') return 'Version nicht gefunden.';
  if (
    e.code === 'NICHT_BERECHTIGT' &&
    e.message === 'Dieser Schritt ist zuständigen Personen vorbehalten.'
  )
    return KEIN_RECHT;
  if (e.code === 'UNGUELTIG') {
    const zeilen = Object.values(e.felder ?? {}).flat();
    return e.message === 'Eingabe ungültig.' || !zeilen.length
      ? 'Bitte die Eingaben prüfen.'
      : [e.message, ...zeilen].join('\n');
  }
  return e.message;
}

/** Führt die Service-Operation im Dienstkontext der angemeldeten Person aus. */
async function imDemo<T>(
  mandantId: string,
  fn: (ctx: DienstKontext) => Promise<T>,
): Promise<{ wert: T } | { fehler: string }> {
  const akteur = await demoAkteur(mandantId);
  if (!akteur) redirect('/anmelden');
  try {
    return { wert: await imDienst(akteur, DEMO_PORTS, fn) };
  } catch (e) {
    if (e instanceof DienstFehler) return { fehler: meldung(e) };
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Abschnitt im Entwurf bearbeiten
// ---------------------------------------------------------------------------

const BAUSTEINE = Object.keys(BAUSTEIN_LABEL) as BausteinArt[];
const Struktur = z
  .array(
    z.discriminatedUnion('typ', [
      z.object({ typ: z.literal('text') }),
      z.object({
        typ: z.literal('baustein'),
        art: z.enum(BAUSTEINE as [BausteinArt, ...BausteinArt[]]),
      }),
    ]),
  )
  .max(40);

const AbschnittForm = z.object({
  mandantId: z.uuid(),
  versionId: z.string().min(1).max(64),
  key: z.string().min(1).max(40),
  struktur: z.string().max(10_000),
  neuerBaustein: z.string().optional(),
});

/**
 * Baut die Blöcke des Abschnitts aus dem Formular (Textfelder je Block,
 * Entfernen-Haken für Bausteine, neuer Baustein); prüfen und speichern
 * übernimmt der Service.
 */
export async function speichereAbschnitt(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  const p = AbschnittForm.safeParse({
    mandantId: fd.get('mandantId'),
    versionId: fd.get('versionId'),
    key: fd.get('key'),
    struktur: fd.get('struktur'),
    neuerBaustein: fd.get('neuerBaustein') || undefined,
  });
  if (!p.success) return { fehler: 'Bitte die Eingaben prüfen.' };
  let struktur: z.infer<typeof Struktur>;
  try {
    struktur = Struktur.parse(JSON.parse(p.data.struktur));
  } catch {
    return { fehler: 'Bitte die Eingaben prüfen.' };
  }
  const bloecke: Abschnitt['bloecke'] = [];
  for (const [i, b] of struktur.entries()) {
    if (b.typ === 'text') {
      const t = fd.get(`text_${i}`);
      bloecke.push({ typ: 'text', text: typeof t === 'string' ? t : '' });
    } else if (fd.get(`entfernen_${i}`) !== 'on') {
      bloecke.push({ typ: 'baustein', art: b.art });
    }
  }
  const neu = fd.get('text_neu');
  if (typeof neu === 'string' && neu.trim() && !bloecke.some((b) => b.typ === 'text')) {
    bloecke.unshift({ typ: 'text', text: neu });
  }
  if (p.data.neuerBaustein) {
    const art = p.data.neuerBaustein as BausteinArt;
    if (!BAUSTEINE.includes(art)) return { fehler: 'Unbekannter Baustein.' };
    if (bloecke.some((b) => b.typ === 'baustein' && b.art === art))
      return {
        fehler: `Der Baustein „${BAUSTEIN_LABEL[art]}“ ist in diesem Abschnitt bereits enthalten.`,
      };
    bloecke.push({ typ: 'baustein', art });
  }
  if (bloecke.length === 0) bloecke.push({ typ: 'text', text: '' });
  if (bloecke.some((b) => b.typ === 'text' && b.text.length > 20_000))
    return { fehler: 'Ein Textblock darf höchstens 20.000 Zeichen haben.' };
  const { mandantId, versionId, key } = p.data;
  const r = await imDemo(mandantId, (ctx) =>
    speichereBeschreibungsabschnitt(ctx, { mandantId, versionId, key, bloecke } as never),
  );
  if ('fehler' in r) return { fehler: r.fehler };
  if (!r.wert.geaendert) return { ok: 'Keine Änderungen.' };
  aktualisiereMandant(mandantId);
  return { ok: `Abschnitt in v${r.wert.nummer} gespeichert.` };
}

// ---------------------------------------------------------------------------
// Neue Version aus der letzten anlegen
// ---------------------------------------------------------------------------

export async function neueVersion(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  const p = z.uuid().safeParse(fd.get('mandantId'));
  if (!p.success) return { fehler: 'Tax-CMS nicht gefunden.' };
  const mandantId = p.data;
  const r = await imDemo(mandantId, (ctx) => legeBeschreibungsversionAn(ctx, { mandantId }));
  if ('fehler' in r) return { fehler: r.fehler };
  aktualisiereMandant(mandantId);
  redirect(`/staff/clients/${mandantId}/tcms/beschreibung?version=${r.wert.versionId}`);
}

// ---------------------------------------------------------------------------
// Kanzlei-Review
// ---------------------------------------------------------------------------

export async function zurReview(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  const p = Ids.safeParse({ mandantId: fd.get('mandantId'), versionId: fd.get('versionId') });
  if (!p.success) return { fehler: 'Bitte die Eingaben prüfen.' };
  const r = await imDemo(p.data.mandantId, (ctx) => gibBeschreibungZurReview(ctx, p.data));
  if ('fehler' in r) return { fehler: r.fehler };
  aktualisiereMandant(p.data.mandantId);
  return { ok: `v${r.wert.nummer} liegt zur Kanzlei-Review vor.` };
}

export async function reviewAbschliessen(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  const p = Ids.safeParse({ mandantId: fd.get('mandantId'), versionId: fd.get('versionId') });
  if (!p.success) return { fehler: 'Bitte die Eingaben prüfen.' };
  const r = await imDemo(p.data.mandantId, (ctx) => schliesseBeschreibungsreviewAb(ctx, p.data));
  if ('fehler' in r) return { fehler: r.fehler };
  aktualisiereMandant(p.data.mandantId);
  return { ok: `Kanzlei-Review für v${r.wert.nummer} abgeschlossen.` };
}

export async function reviewZurueckweisen(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  const p = Ids.extend({ begruendung: z.string().trim().min(30) }).safeParse({
    mandantId: fd.get('mandantId'),
    versionId: fd.get('versionId'),
    begruendung: fd.get('begruendung'),
  });
  if (!p.success) return { fehler: 'Bitte eine Begründung mit mindestens 30 Zeichen angeben.' };
  const r = await imDemo(p.data.mandantId, (ctx) => weiseBeschreibungsreviewZurueck(ctx, p.data));
  if ('fehler' in r) return { fehler: r.fehler };
  aktualisiereMandant(p.data.mandantId);
  return { ok: `v${r.wert.nummer} ist zurück im Entwurf.` };
}

// ---------------------------------------------------------------------------
// Freigabe beim Mandanten anfordern (Snapshot + E-Mail-Code)
// ---------------------------------------------------------------------------

export async function freigabeAnfordern(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  const p = Ids.safeParse({ mandantId: fd.get('mandantId'), versionId: fd.get('versionId') });
  if (!p.success) return { fehler: 'Bitte die Eingaben prüfen.' };
  const { mandantId, versionId } = p.data;
  // Wie die kanzleikonsole: Empfänger (erste gesetzliche Vertretung), Zuständigkeit und Namen.
  const [gv] = await kontakteMitRolle(mandantId, 'GESETZLICHER_VERTRETER');
  if (!gv) return { fehler: 'Beim Mandanten ist keine gesetzliche Vertretung erfasst.' };
  const z0 = zustaendigkeit(mandantId);
  const person = (id: string | null) => {
    const x = id ? demoPersonen.person(id) : null;
    return x ? { id: x.id, name: x.name } : null;
  };
  const r = await imDemo(mandantId, (ctx) =>
    fordereBeschreibungsfreigabeAn(ctx, {
      mandantId,
      versionId,
      empfaengerId: gv.id,
      verantwortung: {
        berufstraeger: person(z0.berufstraegerId),
        bearbeitung: person(z0.bearbeitungId),
      },
      namen: demoPersonen.alle().map((x) => ({ id: x.id, name: x.name })),
    }),
  );
  if ('fehler' in r) return { fehler: r.fehler };
  aktualisiereMandant(mandantId);
  const zusatz = r.wert.zurueckgezogen.length
    ? ` Die offene Anforderung für v${r.wert.zurueckgezogen.join(', v')} wurde zurückgezogen.`
    : '';
  return {
    ok: `Freigabe bei ${gv.name} angefordert; der Bestätigungscode liegt im Postausgang.${zusatz}`,
  };
}
