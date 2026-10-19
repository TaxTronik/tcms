// Routen des Bereichs „lesepfade" (Welle 2). Registriert Endpunkte, die ausschließlich
// Funktionen aus @tcms/service aufrufen (ADR 0001 §2). Keine Logik und keine Rechte
// hier: Rechte prüft der Service, die Mandantenbindung die Routentabelle (ADR §3.3).
import { KontextQuerySchema, MandantenListeSchema } from '@tcms/contract';
import type { Tx } from '@tcms/db';
import { ladeArbeitskorb, ladePortalUebersicht, ladePortfolio, leseKontext } from '@tcms/service';
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
  // Portal-Startseite (P1): Mandantenkontakte des eigenen Mandanten (Rechte im Service).
  r.route({
    methode: 'GET',
    pfad: '/v1/mandanten/:mandantId/portal/uebersicht',
    portal: true,
    handler: (rc) =>
      ladePortalUebersicht(dienstKontext(rc), { mandantId: rc.params['mandantId']! }),
  });
  // Mandantenübergreifend (ADR §3.3): Liste der zugänglichen Mandanten im Body, nur KANZLEI.
  r.route({
    methode: 'POST',
    pfad: '/v1/portfolio',
    body: MandantenListeSchema,
    handler: (rc) => ladePortfolio(dienstKontext(rc), rc.body),
  });
  r.route({
    methode: 'POST',
    pfad: '/v1/arbeitskorb',
    body: MandantenListeSchema,
    handler: (rc) => ladeArbeitskorb(dienstKontext(rc), rc.body),
  });
}
