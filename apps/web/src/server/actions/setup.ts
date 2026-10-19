'use server';

import { redirect } from 'next/navigation';
import { z } from 'zod';
import { prisma, Prisma } from '@tcms/db';
import { PAKET } from '@tcms/domain';
import {
  KontrollenSchema,
  leseEntwurf,
  pruefeSchritt1,
  pruefeSchritt2,
  pruefeSchritt3,
  pruefeSchritt4,
  RisikenSchema,
  TeilbereichSchema,
  ZieleSchema,
  type SetupEntwurf,
} from '@/components/setup/entwurf';
import { gleich, leseProfil } from '@/components/profil/profil-logik';
import { aktualisiereMandant, KEIN_RECHT, mitAudit, type Protokoll } from '../aktion';
import type { Ergebnis } from '../ergebnis';
import { berechnePlan, pruefeKontrollen, rollen, schreibeVersion1 } from '../programm-aufbau';
import { kannBearbeiten } from '../rechte';
import { ladeUmfeld } from '../setup-daten';
import { brauchtKanzlei } from '../sitzung';
import { heute, jetzt } from '../zeit';

// =============================================================================
// Einrichtungsassistent (S3): Schritte speichern, prüfen und Version 1 anlegen.
// Der Entwurf liegt in TcmsProgramm.setupEntwurf; das Programm wird beim ersten
// Speichern im Status ENTWURF angelegt.
// =============================================================================

const Basis = z.object({
  mandantId: z.string().min(1),
  schritt: z.coerce.number().int().min(1).max(5),
  ziel: z.enum(['speichern', 'weiter', 'zurueck', 'anlegen']),
  daten: z.string().min(2).max(400_000),
});

function fehlerText(kopf: string, zeilen: string[]): Ergebnis {
  return { fehler: [kopf, ...zeilen].join('\n') };
}

export async function speichereSchritt(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  const nutzer = await brauchtKanzlei();
  const b = Basis.safeParse({
    mandantId: fd.get('mandantId'),
    schritt: fd.get('schritt'),
    ziel: fd.get('ziel'),
    daten: fd.get('daten'),
  });
  if (!b.success) return { fehler: 'Bitte die Eingaben prüfen.' };
  const { mandantId, schritt, ziel } = b.data;

  const mandant = await prisma.mandant.findUnique({ where: { id: mandantId } });
  if (!mandant) return { fehler: 'Mandant nicht gefunden.' };
  if (!kannBearbeiten(nutzer, mandant)) return { fehler: KEIN_RECHT };
  if (ziel === 'anlegen' && schritt !== 5)
    return { fehler: 'Version 1 wird im letzten Schritt angelegt.' };

  const programm = await prisma.tcmsProgramm.findFirst({
    where: { mandantId },
    orderBy: { createdAt: 'desc' },
  });
  if (programm && (programm.status !== 'ENTWURF' || programm.version1Am)) {
    return {
      fehler:
        'Für diesen Mandanten ist bereits ein Tax-CMS angelegt; Änderungen erfolgen in den Bereichen des Cockpits.',
    };
  }
  const tag = heute();
  const umfeld = await ladeUmfeld(mandantId, tag);
  if (!umfeld) return { fehler: 'Mandant nicht gefunden.' };
  const r = rollen(umfeld);
  const gvIds = umfeld.mandantPersonen
    .filter((p) => p.mandantRolle === 'GESETZLICHER_VERTRETER')
    .map((p) => p.id);

  let roh: Record<string, unknown>;
  try {
    roh = JSON.parse(b.data.daten) as Record<string, unknown>;
  } catch {
    return { fehler: 'Die Eingaben konnten nicht gelesen werden.' };
  }

  // ---- Schrittdaten in den Entwurf übernehmen ----
  const alt = leseEntwurf(programm?.setupEntwurf, tag, r.gv);
  const neu: SetupEntwurf = { ...alt };
  let geaendert = false;
  switch (schritt) {
    case 1: {
      const p = TeilbereichSchema.safeParse(roh);
      if (!p.success) return { fehler: 'Teilbereich oder Zeiträume sind unvollständig.' };
      neu.teilbereich = p.data.teilbereich;
      neu.zeitraum = p.data.zeitraum;
      geaendert = !gleich(alt.teilbereich, neu.teilbereich) || !gleich(alt.zeitraum, neu.zeitraum);
      break;
    }
    case 2: {
      const { profil, fehler } = leseProfil(roh['profil']);
      if (!profil) return fehlerText('Das Geschäftsprofil ist unvollständig:', fehler);
      neu.profil = profil;
      geaendert = !gleich(alt.profil, neu.profil);
      break;
    }
    case 3: {
      const p = ZieleSchema.safeParse(roh);
      if (!p.success)
        return { fehler: 'Ziele sind unvollständig (Text, Wesentlichkeitsgrenze, Risikoappetit).' };
      neu.ziele = p.data.ziele;
      neu.freigabe = p.data.freigabe;
      geaendert = !gleich(alt.ziele, neu.ziele) || !gleich(alt.freigabe, neu.freigabe);
      break;
    }
    case 4: {
      const p = RisikenSchema.safeParse(roh);
      if (!p.success) return { fehler: 'Die Risikoentscheidungen konnten nicht gelesen werden.' };
      neu.risiken = { ...alt.risiken, ...p.data.risiken };
      geaendert = !gleich(alt.risiken, neu.risiken);
      break;
    }
    case 5: {
      const p = KontrollenSchema.safeParse(roh);
      if (!p.success)
        return { fehler: 'Die Zuständigkeiten der Kontrollen konnten nicht gelesen werden.' };
      neu.kontrollen = p.data.kontrollen;
      geaendert = !gleich(alt.kontrollen, neu.kontrollen);
      break;
    }
  }

  // ---- Prüfung ----
  const pruefe = (n: number): string[] => {
    switch (n) {
      case 1:
        return pruefeSchritt1(neu, tag);
      case 2:
        return pruefeSchritt2(neu);
      case 3:
        return pruefeSchritt3(neu, gvIds);
      case 4:
        return pruefeSchritt4(neu);
      default:
        return pruefeKontrollen(berechnePlan(neu, umfeld), umfeld);
    }
  };
  if (ziel === 'weiter') {
    const f = pruefe(schritt);
    if (f.length) return fehlerText(`Schritt ${schritt} ist noch nicht vollständig:`, f);
    // Profil- oder Risikoänderungen verlangen eine erneute Bestätigung der Folgeschritte.
    const obergrenze = schritt === 2 && geaendert ? 3 : schritt === 4 && geaendert ? 4 : 5;
    neu.abgeschlossen = Math.max(schritt, Math.min(alt.abgeschlossen, obergrenze));
  } else if (geaendert) {
    neu.abgeschlossen = Math.min(alt.abgeschlossen, schritt - 1);
  }

  let plan: ReturnType<typeof berechnePlan> | null = null;
  if (ziel === 'anlegen') {
    if (alt.abgeschlossen < 4)
      return { fehler: 'Bitte zuerst die Schritte 1 bis 4 mit „Weiter" abschließen.' };
    const alle: string[] = [];
    for (const n of [1, 2, 3, 4, 5]) for (const f of pruefe(n)) alle.push(`Schritt ${n}: ${f}`);
    plan = berechnePlan(neu, umfeld);
    if (!plan.zeitraum) alle.push('Schritt 1: Zeiträume fehlen.');
    if (!plan.risiken.some((x) => x.uebernehmen))
      alle.push('Schritt 4: Mindestens ein Risiko übernehmen.');
    if (alle.length) return fehlerText('Version 1 kann noch nicht angelegt werden:', alle);
    neu.abgeschlossen = 5;
  }

  neu.gespeichertVon = nutzer.name;

  // ---- Speichern (und ggf. Version 1) ----
  await mitAudit<{ programmId: string; version1: boolean }>(nutzer, async (tx, zeitpunkt) => {
    const protokolle: Protokoll[] = [];
    neu.gespeichertAm = zeitpunkt.toISOString();
    let programmId = programm?.id ?? null;
    if (!programmId) {
      const p = await tx.tcmsProgramm.create({
        data: {
          mandantId,
          paketId: PAKET.id,
          paketVersion: PAKET.version,
          status: 'ENTWURF',
          erklaerungsTurnus: neu.zeitraum.erklaerungsTurnus,
          setupEntwurf: neu as unknown as Prisma.InputJsonValue,
          createdAt: zeitpunkt,
        },
      });
      programmId = p.id;
      protokolle.push({
        aktion: 'tcms.programm.angelegt',
        objektTyp: 'TcmsProgramm',
        objektId: p.id,
        programmId: p.id,
        detail: {
          paket: `${PAKET.name} ${PAKET.version}`,
          status: 'ENTWURF',
          quelle: 'Einrichtungsassistent',
        },
      });
    } else {
      await tx.tcmsProgramm.update({
        where: { id: programmId },
        data: {
          setupEntwurf: neu as unknown as Prisma.InputJsonValue,
          erklaerungsTurnus: neu.zeitraum.erklaerungsTurnus,
        },
      });
    }
    protokolle.push({
      aktion: 'tcms.setup.entwurf_gespeichert',
      objektTyp: 'TcmsProgramm',
      objektId: programmId,
      programmId,
      detail: { schritt, aktion: ziel, abgeschlossen: neu.abgeschlossen, geaendert },
    });
    if (ziel === 'anlegen' && plan) {
      const v1 = await schreibeVersion1(tx, {
        programmId,
        e: neu,
        plan,
        u: umfeld,
        nutzer,
        zeitpunkt,
      });
      protokolle.push(...v1.protokolle);
      return { wert: { programmId, version1: true }, protokoll: protokolle };
    }
    return { wert: { programmId, version1: false }, protokoll: protokolle };
  });

  aktualisiereMandant(mandantId);
  const basis = `/staff/clients/${mandantId}/tcms`;
  if (ziel === 'anlegen') redirect(basis);
  if (ziel === 'weiter') redirect(`${basis}/setup?schritt=${schritt + 1}`);
  if (ziel === 'zurueck') redirect(`${basis}/setup?schritt=${Math.max(1, schritt - 1)}`);
  return {
    ok: `Entwurf gespeichert (${new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' }).format(jetzt())} Uhr).`,
  };
}
