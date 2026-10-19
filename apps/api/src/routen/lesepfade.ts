// Routen des Bereichs „lesepfade" (Welle 2). Registriert Endpunkte, die ausschließlich
// Funktionen aus @tcms/service aufrufen (ADR 0001 §2). Keine Logik und keine Rechte
// hier: Rechte prüft der Service, die Mandantenbindung die Routentabelle (ADR §3.3).
// Methode, Muster und Schemas stehen im Endpunktregister (`ENDPUNKTE`).
// Die Mandanten-ID kommt immer aus dem (an `cli.id` gebundenen) Pfad und wird
// zuletzt gesetzt, damit kein Body- oder Query-Feld sie überschreiben kann.
import { ENDPUNKTE } from '@tcms/contract';
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
  r.endpunkt(ENDPUNKTE.kontextLesen, (rc) =>
    leseKontext(dienstKontext(rc), { ...rc.query, mandantId: rc.params['mandantId']! }),
  );
  // Mandantenanker und Kontaktrollen (ADR §5): Pflege durch die kanzleikonsole.
  r.endpunkt(ENDPUNKTE.mandantAnkerSetzen, (rc) =>
    setzeMandantAnker(dienstKontext(rc), { ...rc.body, mandantId: rc.params['mandantId']! }),
  );
  r.endpunkt(ENDPUNKTE.kontakteLesen, (rc) =>
    ladeKontakte(dienstKontext(rc), { mandantId: rc.params['mandantId']! }),
  );
  r.endpunkt(ENDPUNKTE.kontaktRollenSetzen, (rc) =>
    setzeKontaktRollen(dienstKontext(rc), { ...rc.body, mandantId: rc.params['mandantId']! }),
  );
  // Portal-Startseite (P1): Mandantenkontakte des eigenen Mandanten (Rechte im Service).
  r.endpunkt(ENDPUNKTE.portalUebersichtLesen, (rc) =>
    ladePortalUebersicht(dienstKontext(rc), { mandantId: rc.params['mandantId']! }),
  );
  // Mandantenübergreifend (ADR §3.3): Liste der zugänglichen Mandanten im Body, nur KANZLEI.
  r.endpunkt(ENDPUNKTE.portfolioLesen, (rc) => ladePortfolio(dienstKontext(rc), rc.body));
  r.endpunkt(ENDPUNKTE.arbeitskorbLesen, (rc) => ladeArbeitskorb(dienstKontext(rc), rc.body));
  // Audit des Tenants: nur Admins/Partner (Recht im Service).
  r.endpunkt(ENDPUNKTE.auditLesen, (rc) => ladeAudit(dienstKontext(rc), rc.query));
  r.endpunkt(ENDPUNKTE.auditPruefen, (rc) => pruefeAudit(dienstKontext(rc), rc.body));
}
