'use server';

import { redirect } from 'next/navigation';
import { z } from 'zod';
import { DienstFehler } from '@tcms/contract';
import { imDienst, legeProgrammAn, speichereEinrichtungsschritt } from '@tcms/service';
import { aktualisiereMandant, KEIN_RECHT } from '../aktion';
import { DEMO_PORTS } from '../demo';
import type { Ergebnis } from '../ergebnis';
import { einrichtungsPersonen } from '../setup-daten';
import { demoAkteur } from '../sitzung';
import { jetzt } from '../zeit';

// =============================================================================
// Einrichtungsassistent (S3): dünne Hülle um @tcms/service. Formular →
// Eingabe → Service (Rechte, Prüfungen, TS-05) → Meldung bzw. Weiterleitung.
// Die Personen der Kanzlei übergibt die Demo wie die kanzleikonsole.
// =============================================================================

const Basis = z.object({
  mandantId: z.uuid(),
  schritt: z.coerce.number().int().min(1).max(5),
  ziel: z.enum(['speichern', 'weiter', 'zurueck', 'anlegen']),
  daten: z.string().min(2).max(400_000),
});

/** Meldung je Schritt, wenn die Struktur der Eingabe nicht passt (wie bisher). */
const STRUKTUR: Record<number, string> = {
  1: 'Teilbereich oder Zeiträume sind unvollständig.',
  2: 'Das Geschäftsprofil ist unvollständig.',
  3: 'Ziele sind unvollständig (Text, Wesentlichkeitsgrenze, Risikoappetit).',
  4: 'Die Risikoentscheidungen konnten nicht gelesen werden.',
  5: 'Die Zuständigkeiten der Kontrollen konnten nicht gelesen werden.',
};

function meldung(e: DienstFehler, schritt: number): string {
  if (e.code === 'NICHT_BERECHTIGT') return KEIN_RECHT;
  if (e.code === 'NICHT_GEFUNDEN') return 'Mandant nicht gefunden.';
  if (e.code === 'KONFLIKT') return e.message;
  const fach = Object.entries(e.felder ?? {}).filter(([k]) => /^(schritt\d|version1)$/.test(k));
  if (fach.length) {
    const kopf = e.message.replace(/\.$/, ':');
    return [kopf, ...fach.flatMap(([, f]) => f)].join('\n');
  }
  if (e.message !== 'Eingabe ungültig.')
    return [e.message, ...Object.values(e.felder ?? {}).flat()].join('\n');
  return STRUKTUR[schritt] ?? 'Bitte die Eingaben prüfen.';
}

export async function speichereSchritt(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  const b = Basis.safeParse({
    mandantId: fd.get('mandantId'),
    schritt: fd.get('schritt'),
    ziel: fd.get('ziel'),
    daten: fd.get('daten'),
  });
  if (!b.success) return { fehler: 'Bitte die Eingaben prüfen.' };
  const { mandantId, schritt, ziel } = b.data;
  const akteur = await demoAkteur(mandantId);
  if (!akteur) redirect('/anmelden');
  if (ziel === 'anlegen' && schritt !== 5)
    return { fehler: 'Version 1 wird im letzten Schritt angelegt.' };
  let daten: unknown;
  try {
    daten = JSON.parse(b.data.daten);
  } catch {
    return { fehler: 'Die Eingaben konnten nicht gelesen werden.' };
  }
  const personen = einrichtungsPersonen(mandantId);
  try {
    await imDienst(akteur, DEMO_PORTS, async (ctx) => {
      if (ziel === 'anlegen') {
        await legeProgrammAn(ctx, { mandantId, daten: daten as never, personen });
      } else {
        await speichereEinrichtungsschritt(ctx, {
          mandantId,
          ziel,
          personen,
          schritt,
          daten,
        } as never);
      }
    });
  } catch (e) {
    if (e instanceof DienstFehler) return { fehler: meldung(e, schritt) };
    throw e;
  }

  aktualisiereMandant(mandantId);
  const basis = `/staff/clients/${mandantId}/tcms`;
  if (ziel === 'anlegen') redirect(basis);
  if (ziel === 'weiter') redirect(`${basis}/setup?schritt=${schritt + 1}`);
  if (ziel === 'zurueck') redirect(`${basis}/setup?schritt=${Math.max(1, schritt - 1)}`);
  return {
    ok: `Entwurf gespeichert (${new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' }).format(jetzt())} Uhr).`,
  };
}
