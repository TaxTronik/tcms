// Routen des Bereichs „lesepfade" (Welle 2). Registriert Endpunkte, die ausschließlich
// Funktionen aus @tcms/service aufrufen (ADR 0001 §2). Keine Logik und keine Rechte
// hier: Rechte prüft der Service, die Mandantenbindung die Routentabelle (ADR §3.3).
import { KontextQuerySchema } from '@tcms/contract';
import type { Tx } from '@tcms/db';
import { leseKontext } from '@tcms/service';
import type { Routen } from '../routen';
import { dienstKontext } from './kontext';

export function registriereLesepfade(r: Routen<Tx>): void {
  r.route({
    methode: 'GET',
    pfad: '/v1/mandanten/:mandantId/kontext',
    query: KontextQuerySchema,
    handler: (rc) =>
      leseKontext(dienstKontext(rc), { mandantId: rc.params['mandantId']!, ...rc.query }),
  });
}
