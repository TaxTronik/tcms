// Routen des Bereichs „lesepfade" (Welle 2). Registriert Endpunkte, die ausschließlich
// Funktionen aus @tcms/service aufrufen (ADR 0001 §2). Keine Logik und keine Rechte
// hier: Rechte prüft der Service, die Mandantenbindung die Routentabelle (ADR §3.3).
// Die Mandanten-ID kommt immer aus dem (an `cli.id` gebundenen) Pfad und wird
// zuletzt gesetzt, damit kein Body- oder Query-Feld sie überschreiben kann.
import {
  AuditPruefenEingabeSchema,
  AuditQuerySchema,
  KontaktRollenBodySchema,
  KontextQuerySchema,
  MandantAnkerBodySchema,
  MandantenListeSchema,
} from '@tcms/contract';
import type { Tx } from '@tcms/db';
import {
  ladeArbeitskorb,
  ladeAudit,
  ladeKontakte,
  ladePortalUebersicht,
  ladePortfolio,
  leseKontext,
  pruefeAudit,
  setzeKontaktRollen,
  setzeMandantAnker,
} from '@tcms/service';
import type { Routen } from '../routen';
import { dienstKontext } from './kontext';

export function registriereLesepfade(r: Routen<Tx>): void {
  r.route({
    methode: 'GET',
    pfad: '/v1/mandanten/:mandantId/kontext',
    query: KontextQuerySchema,
    handler: (rc) =>
      leseKontext(dienstKontext(rc), { ...rc.query, mandantId: rc.params['mandantId']! }),
  });
  // Mandantenanker und Kontaktrollen (ADR §5): Pflege durch die kanzleikonsole.
  r.route({
    methode: 'PUT',
    pfad: '/v1/mandanten/:mandantId',
    body: MandantAnkerBodySchema,
    handler: (rc) =>
      setzeMandantAnker(dienstKontext(rc), { ...rc.body, mandantId: rc.params['mandantId']! }),
  });
  r.route({
    methode: 'GET',
    pfad: '/v1/mandanten/:mandantId/kontakte',
    handler: (rc) => ladeKontakte(dienstKontext(rc), { mandantId: rc.params['mandantId']! }),
  });
  r.route({
    methode: 'PUT',
    pfad: '/v1/mandanten/:mandantId/kontakte',
    body: KontaktRollenBodySchema,
    handler: (rc) =>
      setzeKontaktRollen(dienstKontext(rc), { ...rc.body, mandantId: rc.params['mandantId']! }),
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
  // Audit des Tenants: nur Admins/Partner (Recht im Service).
  r.route({
    methode: 'GET',
    pfad: '/v1/audit',
    query: AuditQuerySchema,
    handler: (rc) => ladeAudit(dienstKontext(rc), rc.query),
  });
  r.route({
    methode: 'POST',
    pfad: '/v1/audit/pruefen',
    body: AuditPruefenEingabeSchema,
    handler: (rc) => pruefeAudit(dienstKontext(rc), rc.body),
  });
}
