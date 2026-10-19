// =============================================================================
// Nur für Web-DB-Tests: Demodaten, die ein Test verbraucht, vor dem Lauf in den
// Seed-Zustand zurücksetzen, damit zwei Läufe hintereinander auf derselben
// Datenbank grün sind (Aufgabe tcms-int 2g).
//
// Das Zurücksetzen eines Mandanten löscht sein Tax-CMS-Programm samt aller
// abhängigen Zeilen. Eine eingefrorene CMS-Beschreibung kann die Laufzeitrolle
// nicht löschen (Trigger `BeschreibungVersion_eingefroren`); deshalb läuft das
// Zurücksetzen als Eigentümerrolle (`DATABASE_OWNER_URL`) in genau einer
// Transaktion im Demo-Tenant, in der der Trigger abgeschaltet ist. Das Audit
// bleibt unverändert (nur anhängen).
// =============================================================================

import { erzeugeClient } from '@tcms/db';
import { DEMO_TENANT_ID } from '@tcms/db/demo';

/** Löschfolge der Programm-Daten (Kinder vor Eltern); `$1` = Mandanten-ID. */
const LOESCHEN: readonly string[] = [
  `DELETE FROM "FeststellungRisiko" WHERE "feststellungId" IN (SELECT f.id FROM "Feststellung" f JOIN "TcmsProgramm" p ON p.id = f."programmId" WHERE p."mandantId" = $1::uuid)
     OR "risikoId" IN (SELECT r.id FROM "Risiko" r JOIN "TcmsProgramm" p ON p.id = r."programmId" WHERE p."mandantId" = $1::uuid)`,
  `DELETE FROM "BetroffeneErklaerung" WHERE "feststellungId" IN (SELECT f.id FROM "Feststellung" f JOIN "TcmsProgramm" p ON p.id = f."programmId" WHERE p."mandantId" = $1::uuid)`,
  `DELETE FROM "Massnahme" WHERE "feststellungId" IN (SELECT f.id FROM "Feststellung" f JOIN "TcmsProgramm" p ON p.id = f."programmId" WHERE p."mandantId" = $1::uuid)`,
  `DELETE FROM "Feststellung" WHERE "programmId" IN (SELECT id FROM "TcmsProgramm" WHERE "mandantId" = $1::uuid)`,
  `DELETE FROM "Nachweis" WHERE "durchfuehrungId" IN (SELECT d.id FROM "Durchfuehrung" d JOIN "Kontrolle" k ON k.id = d."kontrolleId" JOIN "TcmsProgramm" p ON p.id = k."programmId" WHERE p."mandantId" = $1::uuid)`,
  `DELETE FROM "Durchfuehrung" WHERE "kontrolleId" IN (SELECT k.id FROM "Kontrolle" k JOIN "TcmsProgramm" p ON p.id = k."programmId" WHERE p."mandantId" = $1::uuid)`,
  `DELETE FROM "RisikoKontrolle" WHERE "kontrolleId" IN (SELECT k.id FROM "Kontrolle" k JOIN "TcmsProgramm" p ON p.id = k."programmId" WHERE p."mandantId" = $1::uuid)`,
  `DELETE FROM "KontrolleStand" WHERE "kontrolleId" IN (SELECT k.id FROM "Kontrolle" k JOIN "TcmsProgramm" p ON p.id = k."programmId" WHERE p."mandantId" = $1::uuid)`,
  `DELETE FROM "Kontrolle" WHERE "programmId" IN (SELECT id FROM "TcmsProgramm" WHERE "mandantId" = $1::uuid)`,
  `DELETE FROM "Uebersteuerung" WHERE "risikoId" IN (SELECT r.id FROM "Risiko" r JOIN "TcmsProgramm" p ON p.id = r."programmId" WHERE p."mandantId" = $1::uuid)`,
  `DELETE FROM "RisikoStand" WHERE "risikoId" IN (SELECT r.id FROM "Risiko" r JOIN "TcmsProgramm" p ON p.id = r."programmId" WHERE p."mandantId" = $1::uuid)`,
  `DELETE FROM "Risiko" WHERE "programmId" IN (SELECT id FROM "TcmsProgramm" WHERE "mandantId" = $1::uuid)`,
  `DELETE FROM "EreignisFolge" WHERE "ereignisId" IN (SELECT e.id FROM "Ereignis" e JOIN "TcmsProgramm" p ON p.id = e."programmId" WHERE p."mandantId" = $1::uuid)`,
  `DELETE FROM "Ereignis" WHERE "programmId" IN (SELECT id FROM "TcmsProgramm" WHERE "mandantId" = $1::uuid)`,
  `DELETE FROM "ComplianceZiel" WHERE "teilbereichId" IN (SELECT t.id FROM "Teilbereich" t JOIN "TcmsProgramm" p ON p.id = t."programmId" WHERE p."mandantId" = $1::uuid)`,
  `DELETE FROM "Teilbereich" WHERE "programmId" IN (SELECT id FROM "TcmsProgramm" WHERE "mandantId" = $1::uuid)`,
  `DELETE FROM "ProfilStand" WHERE "programmId" IN (SELECT id FROM "TcmsProgramm" WHERE "mandantId" = $1::uuid)`,
  `DELETE FROM "LandStand" WHERE "programmId" IN (SELECT id FROM "TcmsProgramm" WHERE "mandantId" = $1::uuid)`,
  `DELETE FROM "BeschreibungVersion" WHERE "programmId" IN (SELECT id FROM "TcmsProgramm" WHERE "mandantId" = $1::uuid)`,
  `DELETE FROM "Freigabe" WHERE "programmId" IN (SELECT id FROM "TcmsProgramm" WHERE "mandantId" = $1::uuid)`,
  `DELETE FROM "TcmsProgramm" WHERE "mandantId" = $1::uuid`,
];

/**
 * Setzt einen Demo-Mandanten auf „ohne Tax-CMS" zurück (Seed-Zustand von
 * Bergkamm). Mandantenanker und Kontaktrollen bleiben. Ohne Programm: keine
 * Änderung.
 */
export async function setzeMandantOhneTcmsZurueck(mandantId: string): Promise<void> {
  const eigentuemer = erzeugeClient(process.env['DATABASE_OWNER_URL']);
  try {
    await eigentuemer.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('tcms.tenant_id', ${DEMO_TENANT_ID}, true)`;
      await tx.$executeRawUnsafe(
        'ALTER TABLE "BeschreibungVersion" DISABLE TRIGGER "BeschreibungVersion_eingefroren"',
      );
      for (const sql of LOESCHEN) await tx.$executeRawUnsafe(sql, mandantId);
      await tx.$executeRawUnsafe(
        'ALTER TABLE "BeschreibungVersion" ENABLE TRIGGER "BeschreibungVersion_eingefroren"',
      );
    });
  } finally {
    await eigentuemer.$disconnect();
  }
}
