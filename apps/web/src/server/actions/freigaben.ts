'use server';

import { redirect } from 'next/navigation';
import { z } from 'zod';
import { prisma, type Prisma } from '@tcms/db';
import { isoDatum } from '@tcms/domain';
import { aktualisiereMandant, mitAudit, type Protokoll } from '../aktion';
import { baueSnapshot, normalisiereAbschnitte } from '../beschreibung-daten';
import type { Ergebnis } from '../ergebnis';
import {
  adresse,
  brauchtCode,
  codeNachricht,
  codePasst,
  CODE_GUELTIG_TAGE,
  erzeugeCode,
  MAX_FEHLVERSUCHE,
} from '../freigaben-daten';
import { ladeKontext } from '../kontext';
import { istGesetzlicherVertreter } from '../rechte';
import { brauchtPortal } from '../sitzung';
import { heute, jetzt } from '../zeit';

// =============================================================================
// Portal P4: Freigaben (nur gesetzliche Vertretung, Bestätigung per E-Mail-Code)
// und Kenntnisnahmen (einfache Bestätigung durch die adressierte Person).
// =============================================================================

class Abbruch extends Error {}

const NUR_GV = 'Freigaben sind der gesetzlichen Vertretung vorbehalten.';

async function ladeFreigabe(id: string) {
  return prisma.freigabe.findUnique({
    where: { id },
    include: { programm: { include: { mandant: true } } },
  });
}

// ---------------------------------------------------------------------------
// Bestätigungscode anfordern (erstmals oder erneut)
// ---------------------------------------------------------------------------

export async function codeAnfordern(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  const nutzer = await brauchtPortal();
  const id = String(fd.get('freigabeId') ?? '');
  const f = await ladeFreigabe(id);
  if (!f || f.programm.mandantId !== nutzer.mandantId)
    return { fehler: 'Anforderung nicht gefunden.' };
  if (!brauchtCode(f.art)) return { fehler: 'Für eine Kenntnisnahme ist kein Code nötig.' };
  if (!istGesetzlicherVertreter(nutzer)) return { fehler: NUR_GV };
  if (f.status !== 'OFFEN') return { fehler: 'Diese Freigabe ist bereits erledigt.' };

  await mitAudit(nutzer, async (tx, zeitpunkt) => {
    const { code, codeHash, codeAblauf } = erzeugeCode(zeitpunkt);
    // Der Code geht an die anfordernde gesetzliche Vertretung; sie wird Empfänger:in der Freigabe.
    await tx.freigabe.update({
      where: { id: f.id },
      data: { codeHash, codeAblauf, empfaengerId: nutzer.id },
    });
    let hash: string | null = null;
    if (f.art === 'BESCHREIBUNG') {
      const v = await tx.beschreibungVersion.findUnique({
        where: { id: f.refId },
        select: { snapshotSha256: true },
      });
      hash = v?.snapshotSha256 ?? null;
    }
    const n = codeNachricht({
      empfaenger: nutzer.name,
      mandant: f.programm.mandant.name,
      titel: f.titel,
      code,
      codeAblauf,
      sha256: hash,
    });
    await tx.nachricht.create({
      data: { an: adresse(nutzer), betreff: n.betreff, text: n.text, createdAt: zeitpunkt },
    });
    return {
      wert: null,
      protokoll: {
        aktion: 'tcms.freigabe.code_angefordert',
        objektTyp: 'Freigabe',
        objektId: f.id,
        programmId: f.programmId,
        detail: {
          art: f.art,
          titel: f.titel,
          codeAblauf: codeAblauf.toISOString(),
          ...(f.empfaengerId !== nutzer.id ? { empfaengerVorher: f.empfaengerId } : {}),
        },
      },
    };
  });
  aktualisiereMandant(f.programm.mandantId);
  return {
    ok: `Ein neuer Bestätigungscode wurde an ${nutzer.email} gesendet. Er ist ${CODE_GUELTIG_TAGE} Tage gültig.`,
  };
}

// ---------------------------------------------------------------------------
// Freigeben mit E-Mail-Code
// ---------------------------------------------------------------------------

const FreigebenSchema = z.object({
  freigabeId: z.string().min(1),
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/),
});

export async function freigeben(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  const nutzer = await brauchtPortal();
  const p = FreigebenSchema.safeParse(Object.fromEntries(fd));
  if (!p.success) return { fehler: 'Bitte den 6-stelligen Code aus der E-Mail eingeben.' };
  const f = await ladeFreigabe(p.data.freigabeId);
  if (!f || f.programm.mandantId !== nutzer.mandantId)
    return { fehler: 'Anforderung nicht gefunden.' };
  if (!brauchtCode(f.art)) return { fehler: 'Diese Anforderung ist eine Kenntnisnahme.' };
  if (!istGesetzlicherVertreter(nutzer)) return { fehler: NUR_GV };
  if (f.status !== 'OFFEN') return { fehler: 'Diese Freigabe ist bereits erledigt.' };
  if (f.empfaengerId !== nutzer.id)
    return {
      fehler:
        'Der Bestätigungscode wurde an eine andere Person gesendet. Bitte fordern Sie einen eigenen Code an.',
    };
  if (!f.codeHash || !f.codeAblauf)
    return { fehler: 'Bitte fordern Sie zuerst einen Bestätigungscode an.' };
  if (f.codeAblauf.getTime() < jetzt().getTime())
    return { fehler: 'Der Code ist abgelaufen. Bitte fordern Sie einen neuen Code an.' };

  if (!codePasst(p.data.code, f.codeHash)) {
    const ausgestellt = new Date(f.codeAblauf.getTime() - CODE_GUELTIG_TAGE * 86_400_000);
    const codeHash = f.codeHash;
    // Zählen und Sperren atomar: Zeile sperren (FOR UPDATE), Fehlversuche in derselben Transaktion zählen.
    const ergebnis = await mitAudit(nutzer, async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Freigabe" WHERE id = ${f.id} FOR UPDATE`;
      const aktuell = await tx.freigabe.findUnique({
        where: { id: f.id },
        select: { codeHash: true, status: true },
      });
      if (!aktuell || aktuell.status !== 'OFFEN' || aktuell.codeHash !== codeHash) {
        return { wert: { versuch: 0, sperren: false, veraltet: true }, protokoll: [] };
      }
      const bisher = await tx.auditEvent.count({
        where: {
          objektTyp: 'Freigabe',
          objektId: f.id,
          aktion: 'tcms.freigabe.code_falsch',
          at: { gte: ausgestellt },
        },
      });
      const versuch = bisher + 1;
      const sperren = versuch >= MAX_FEHLVERSUCHE;
      if (sperren)
        await tx.freigabe.update({
          where: { id: f.id },
          data: { codeHash: null, codeAblauf: null },
        });
      const protokoll: Protokoll[] = [
        {
          aktion: 'tcms.freigabe.code_falsch',
          objektTyp: 'Freigabe',
          objektId: f.id,
          programmId: f.programmId,
          detail: { versuch },
        },
      ];
      if (sperren)
        protokoll.push({
          aktion: 'tcms.freigabe.code_gesperrt',
          objektTyp: 'Freigabe',
          objektId: f.id,
          programmId: f.programmId,
          detail: { versuche: versuch },
        });
      return { wert: { versuch, sperren, veraltet: false }, protokoll };
    });
    aktualisiereMandant(f.programm.mandantId);
    if (ergebnis.veraltet)
      return { fehler: 'Der Code ist nicht mehr gültig. Bitte fordern Sie einen neuen Code an.' };
    const { versuch, sperren } = ergebnis;
    return {
      fehler: sperren
        ? `Der Code wurde nach ${MAX_FEHLVERSUCHE} Fehlversuchen gesperrt. Bitte fordern Sie einen neuen Code an.`
        : `Der Code stimmt nicht. Noch ${MAX_FEHLVERSUCHE - versuch} Versuch${MAX_FEHLVERSUCHE - versuch === 1 ? '' : 'e'}.`,
    };
  }

  // Beschreibung: Version muss beim Mandanten liegen; fehlt der Snapshot (Altbestand), wird er jetzt erzeugt.
  let version: Awaited<ReturnType<typeof prisma.beschreibungVersion.findUnique>> = null;
  let ctx: Awaited<ReturnType<typeof ladeKontext>> = null;
  if (f.art === 'BESCHREIBUNG') {
    version = await prisma.beschreibungVersion.findUnique({ where: { id: f.refId } });
    if (!version || version.programmId !== f.programmId)
      return { fehler: 'Die zugehörige Beschreibungsversion wurde nicht gefunden.' };
    if (version.status !== 'BEIM_MANDANTEN')
      return { fehler: 'Diese Version liegt nicht mehr zur Freigabe vor.' };
    if (!version.snapshot) ctx = await ladeKontext(f.programm.mandantId, isoDatum(heute()), false);
  }

  try {
    await mitAudit(nutzer, async (tx, zeitpunkt) => {
      // Bedingung bindet den geprüften Code: ein inzwischen gesperrter oder erneuerter Code greift nicht.
      const r = await tx.freigabe.updateMany({
        where: { id: f.id, status: 'OFFEN', codeHash: f.codeHash, codeAblauf: { gte: zeitpunkt } },
        data: { status: 'FREIGEGEBEN', erledigtAm: zeitpunkt, codeHash: null },
      });
      if (r.count !== 1)
        throw new Abbruch('Die Freigabe ist bereits erledigt oder der Code ist nicht mehr gültig.');
      const protokoll: Protokoll[] = [
        {
          aktion: 'tcms.freigabe.erteilt',
          objektTyp: 'Freigabe',
          objektId: f.id,
          programmId: f.programmId,
          detail: { art: f.art, titel: f.titel, bestaetigung: 'E-Mail-Code' },
        },
      ];

      if (f.art === 'BESCHREIBUNG' && version) {
        let snapshotDaten: { snapshot: Prisma.InputJsonValue; snapshotSha256: string } | null =
          null;
        if (!version.snapshot && ctx) {
          const s = baueSnapshot(
            { nummer: version.nummer, abschnitte: normalisiereAbschnitte(version.abschnitte) },
            ctx,
            zeitpunkt,
          );
          snapshotDaten = {
            snapshot: s.snapshot as unknown as Prisma.InputJsonValue,
            snapshotSha256: s.sha256,
          };
        }
        const u = await tx.beschreibungVersion.updateMany({
          where: { id: version.id, status: 'BEIM_MANDANTEN' },
          data: {
            status: 'FREIGEGEBEN',
            freigegebenVon: nutzer.id,
            freigegebenAm: zeitpunkt,
            ...(snapshotDaten ?? {}),
          },
        });
        if (u.count !== 1) throw new Abbruch('Diese Version liegt nicht mehr zur Freigabe vor.');
        // Vorgänger (freigegeben oder noch beim Mandanten) werden abgelöst.
        const vorgaenger = await tx.beschreibungVersion.findMany({
          where: {
            programmId: version.programmId,
            id: { not: version.id },
            createdAt: { lt: version.createdAt },
            status: { in: ['FREIGEGEBEN', 'BEIM_MANDANTEN'] },
          },
        });
        for (const a of vorgaenger) {
          await tx.beschreibungVersion.update({
            where: { id: a.id },
            data: { status: 'ABGELOEST' },
          });
          if (a.status === 'BEIM_MANDANTEN') {
            await tx.freigabe.updateMany({
              where: {
                programmId: version.programmId,
                art: 'BESCHREIBUNG',
                refId: a.id,
                status: 'OFFEN',
              },
              data: {
                status: 'ABGELEHNT',
                anmerkung: `Gegenstandslos: v${version.nummer} wurde freigegeben`,
                erledigtAm: zeitpunkt,
                codeHash: null,
              },
            });
          }
          protokoll.push({
            aktion: 'tcms.beschreibung.abgeloest',
            objektTyp: 'BeschreibungVersion',
            objektId: a.id,
            programmId: version.programmId,
            detail: { nummer: a.nummer, durch: version.nummer },
          });
        }
        protokoll.push({
          aktion: 'tcms.beschreibung.freigegeben',
          objektTyp: 'BeschreibungVersion',
          objektId: version.id,
          programmId: version.programmId,
          detail: {
            nummer: version.nummer,
            bestaetigung: 'E-Mail-Code',
            snapshotSha256: snapshotDaten?.snapshotSha256 ?? version.snapshotSha256,
          },
        });
      }

      if (f.art === 'ZIELE') {
        // refId: einzelnes Ziel oder Teilbereich (alle noch nicht freigegebenen Ziele).
        const ziel = await tx.complianceZiel.findUnique({
          where: { id: f.refId },
          include: { teilbereich: true },
        });
        const where =
          ziel && ziel.teilbereich.programmId === f.programmId
            ? { id: ziel.id }
            : { teilbereichId: f.refId, teilbereich: { programmId: f.programmId } };
        const z = await tx.complianceZiel.updateMany({
          where: { ...where, freigabe: { not: 'FREIGEGEBEN' } },
          data: { freigabe: 'FREIGEGEBEN', freigegebenAm: zeitpunkt, freigegebenVon: nutzer.id },
        });
        protokoll.push({
          aktion: 'tcms.ziele.freigegeben',
          objektTyp: 'Freigabe',
          objektId: f.id,
          programmId: f.programmId,
          detail: { ziele: z.count },
        });
      }
      return { wert: null, protokoll };
    });
  } catch (e) {
    if (e instanceof Abbruch) return { fehler: e.message };
    throw e;
  }
  aktualisiereMandant(f.programm.mandantId);
  // Die Karte verschwindet aus „Offen"; die Bestätigung zeigt die Seite über den Parameter.
  redirect(`/portal/tcms/freigaben?erledigt=${f.id}`);
}

// ---------------------------------------------------------------------------
// Kenntnisnahme bestätigen
// ---------------------------------------------------------------------------

const KenntnisSchema = z.object({ freigabeId: z.string().min(1), gelesen: z.literal('on') });

export async function kenntnisnehmen(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  const nutzer = await brauchtPortal();
  const p = KenntnisSchema.safeParse(Object.fromEntries(fd));
  if (!p.success) return { fehler: 'Bitte bestätigen Sie, dass Sie das Dokument gelesen haben.' };
  const f = await ladeFreigabe(p.data.freigabeId);
  if (!f || f.programm.mandantId !== nutzer.mandantId)
    return { fehler: 'Anforderung nicht gefunden.' };
  if (f.art !== 'KENNTNISNAHME')
    return { fehler: 'Diese Anforderung ist eine Freigabe mit Bestätigungscode.' };
  if (f.empfaengerId !== nutzer.id)
    return { fehler: 'Diese Kenntnisnahme ist an eine andere Person gerichtet.' };
  if (f.status !== 'OFFEN') return { fehler: 'Diese Kenntnisnahme ist bereits bestätigt.' };
  try {
    await mitAudit(nutzer, async (tx, zeitpunkt) => {
      const r = await tx.freigabe.updateMany({
        where: { id: f.id, status: 'OFFEN' },
        data: { status: 'FREIGEGEBEN', erledigtAm: zeitpunkt },
      });
      if (r.count !== 1) throw new Abbruch('Diese Kenntnisnahme ist bereits bestätigt.');
      return {
        wert: null,
        protokoll: {
          aktion: 'tcms.freigabe.kenntnisnahme',
          objektTyp: 'Freigabe',
          objektId: f.id,
          programmId: f.programmId,
          detail: { titel: f.titel, refId: f.refId },
        },
      };
    });
  } catch (e) {
    if (e instanceof Abbruch) return { fehler: e.message };
    throw e;
  }
  aktualisiereMandant(f.programm.mandantId);
  redirect(`/portal/tcms/freigaben?erledigt=${f.id}`);
}
