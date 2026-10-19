'use server';

import { redirect } from 'next/navigation';
import { z } from 'zod';
import { DienstFehler } from '@tcms/contract';
import {
  bestaetigeKenntnisnahme,
  erteileFreigabe,
  fordereFreigabeCodeAn,
  FREIGABE_CODE_GUELTIG_TAGE,
  FREIGABE_MAX_FEHLVERSUCHE,
  imDienst,
  type DienstKontext,
} from '@tcms/service';
import { aktualisiereMandant } from '../aktion';
import { DEMO_PORTS, demoPersonen } from '../demo';
import type { Ergebnis } from '../ergebnis';
import { brauchtPortal } from '../sitzung';

// =============================================================================
// Portal P4: Freigaben (gesetzliche Vertretung, Bestätigung per E-Mail-Code)
// und Kenntnisnahmen – dünne Hüllen um @tcms/service. Rechte (TS-06: nur die
// adressierte Person), Codes (randomInt, Hash, Frist, Fehlversuche unter
// Sperre) und Snapshot-Prüfung liegen im Service.
// =============================================================================

const Id = z.string().min(1).max(64);

async function imPortal<T>(
  fn: (ctx: DienstKontext, mandantId: string) => Promise<T>,
): Promise<{ wert: T; mandantId: string } | { fehler: string }> {
  const { akteur } = await brauchtPortal();
  try {
    const wert = await imDienst(akteur, DEMO_PORTS, (ctx) => fn(ctx, akteur.mandantId));
    return { wert, mandantId: akteur.mandantId };
  } catch (e) {
    if (e instanceof DienstFehler) {
      return { fehler: e.code === 'NICHT_GEFUNDEN' ? 'Anforderung nicht gefunden.' : e.message };
    }
    throw e;
  }
}

export async function codeAnfordern(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  const { akteur } = await brauchtPortal();
  const p = Id.safeParse(fd.get('freigabeId'));
  if (!p.success) return { fehler: 'Anforderung nicht gefunden.' };
  const r = await imPortal((ctx, mandantId) =>
    fordereFreigabeCodeAn(ctx, { mandantId, freigabeId: p.data }),
  );
  if ('fehler' in r) return { fehler: r.fehler };
  aktualisiereMandant(r.mandantId);
  const email = demoPersonen.person(akteur.id)?.email ?? 'Ihre E-Mail-Adresse';
  return {
    ok: `Ein neuer Bestätigungscode wurde an ${email} gesendet. Er ist ${FREIGABE_CODE_GUELTIG_TAGE} Tage gültig.`,
  };
}

const FreigebenSchema = z.object({
  freigabeId: Id,
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/),
});

export async function freigeben(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  await brauchtPortal();
  const p = FreigebenSchema.safeParse(Object.fromEntries(fd));
  if (!p.success) return { fehler: 'Bitte den 6-stelligen Code aus der E-Mail eingeben.' };
  const r = await imPortal((ctx, mandantId) =>
    erteileFreigabe(ctx, { mandantId, freigabeId: p.data.freigabeId, code: p.data.code }),
  );
  if ('fehler' in r) return { fehler: r.fehler };
  aktualisiereMandant(r.mandantId);
  if (!r.wert.freigegeben) {
    const rest = r.wert.verbleibendeVersuche;
    return {
      fehler:
        r.wert.grund === 'GESPERRT'
          ? `Der Code wurde nach ${FREIGABE_MAX_FEHLVERSUCHE} Fehlversuchen gesperrt. Bitte wenden Sie sich an Ihre Kanzlei.`
          : `Der Code stimmt nicht. Noch ${rest} Versuch${rest === 1 ? '' : 'e'}.`,
    };
  }
  // Die Karte verschwindet aus „Offen"; die Bestätigung zeigt die Seite über den Parameter.
  redirect(`/portal/tcms/freigaben?erledigt=${p.data.freigabeId}`);
}

const KenntnisSchema = z.object({ freigabeId: Id, gelesen: z.literal('on') });

export async function kenntnisnehmen(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  await brauchtPortal();
  const p = KenntnisSchema.safeParse(Object.fromEntries(fd));
  if (!p.success) return { fehler: 'Bitte bestätigen Sie, dass Sie das Dokument gelesen haben.' };
  const r = await imPortal((ctx, mandantId) =>
    bestaetigeKenntnisnahme(ctx, { mandantId, freigabeId: p.data.freigabeId, gelesen: true }),
  );
  if ('fehler' in r) return { fehler: r.fehler };
  aktualisiereMandant(r.mandantId);
  redirect(`/portal/tcms/freigaben?erledigt=${p.data.freigabeId}`);
}
