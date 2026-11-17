'use server';

import { redirect } from 'next/navigation';
import { z } from 'zod';
import { DienstFehler } from '@tcms/contract';
import { fordereZieleFreigabeAn, imDienst } from '@tcms/service';
import { aktualisiereMandant, KEIN_RECHT } from '../aktion';
import { DEMO_PORTS, demoPersonen } from '../demo';
import type { Ergebnis } from '../ergebnis';
import { demoAkteur } from '../sitzung';

// =============================================================================
// Freigabe der Compliance-Ziele nach Version 1 anfordern (z. B. wenn bei der
// Einrichtung noch keine gesetzliche Vertretung erfasst war): dünne Hülle um
// @tcms/service. Sitzung zuerst, dann Rechte, Programmsperre, Empfänger
// (nur aktive gesetzliche Vertretung) und Audit im Service.
// =============================================================================

const Eingabe = z.object({ mandantId: z.uuid(), empfaengerId: z.uuid() });

export async function zieleFreigabeAnfordern(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  const p = Eingabe.safeParse({
    mandantId: fd.get('mandantId'),
    empfaengerId: fd.get('empfaengerId'),
  });
  if (!p.success) return { fehler: 'Bitte eine gesetzliche Vertretung wählen.' };
  const { mandantId, empfaengerId } = p.data;
  const akteur = await demoAkteur(mandantId);
  if (!akteur) redirect('/anmelden');
  try {
    const r = await imDienst(akteur, DEMO_PORTS, (ctx) =>
      fordereZieleFreigabeAn(ctx, { mandantId, empfaengerId }),
    );
    aktualisiereMandant(mandantId);
    const name = demoPersonen.person(empfaengerId)?.name ?? 'der gesetzlichen Vertretung';
    return {
      ok: `Freigabe von ${r.ziele} ${r.ziele === 1 ? 'Ziel' : 'Zielen'} bei ${name} angefordert; die Freigabe erfolgt im Mandantenportal mit E-Mail-Code.`,
    };
  } catch (e) {
    if (!(e instanceof DienstFehler)) throw e;
    if (e.code === 'NICHT_GEFUNDEN') return { fehler: 'Tax-CMS nicht gefunden.' };
    if (e.code === 'NICHT_BERECHTIGT') return { fehler: KEIN_RECHT };
    const zeilen = Object.values(e.felder ?? {}).flat();
    return { fehler: e.code === 'UNGUELTIG' && zeilen.length ? zeilen.join('\n') : e.message };
  }
}
