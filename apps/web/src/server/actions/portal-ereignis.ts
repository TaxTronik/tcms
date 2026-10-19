'use server';

import { redirect } from 'next/navigation';
import { z } from 'zod';
import { prisma } from '@tcms/db';
import { fmtDatumZeit } from '@tcms/domain';
import { aktualisiereMandant, mitAudit } from '../aktion';
import type { Ergebnis } from '../ergebnis';
import {
  darfPortalMelden,
  legeAnlageAb,
  legeEreignisAn,
  PORTAL_KACHELN,
  typInfo,
} from '../ereignisse-daten';
import { brauchtPortal } from '../sitzung';
import { heute } from '../zeit';

// =============================================================================
// Server Action P3 – Ereignis melden (Portal). Melden dürfen gesetzliche
// Vertreter und Tax-Compliance-Beauftragte (Fachkonzept §13).
// =============================================================================

const MAX_ANLAGEN = 5;
const MAX_BYTES = 10 * 1024 * 1024;
const ERLAUBTE_TYPEN =
  /^(application\/pdf|image\/(png|jpeg|gif|webp)|text\/(csv|plain)|application\/(vnd\.openxmlformats-officedocument\.(spreadsheetml\.sheet|wordprocessingml\.document)|vnd\.ms-excel|msword|zip))$/;

const Schema = z.object({
  typ: z.string().refine((t) => PORTAL_KACHELN.some((k) => k.code === t)),
  titel: z.string().trim().min(5).max(200),
  beschreibung: z.string().trim().min(10).max(4000),
  datum: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .transform((v) => new Date(`${v}T00:00:00Z`))
    .refine((d) => !Number.isNaN(d.getTime())),
});

export async function meldeEreignis(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  const n = await brauchtPortal();
  if (!darfPortalMelden(n)) {
    return {
      fehler:
        'Ereignisse melden die Geschäftsführung und die bzw. der Tax-Compliance-Beauftragte. Bitte wenden Sie sich an diese Personen.',
    };
  }
  if (!fd.get('typ')) return { fehler: 'Bitte wählen Sie zuerst die Art des Ereignisses.' };
  const p = Schema.safeParse({
    typ: fd.get('typ'),
    titel: fd.get('titel'),
    beschreibung: fd.get('beschreibung'),
    datum: fd.get('datum'),
  });
  if (!p.success)
    return {
      fehler:
        'Bitte geben Sie eine Bezeichnung (mindestens 5 Zeichen), eine Beschreibung (mindestens 10 Zeichen) und ein Datum an.',
    };
  const tag = heute();
  const zweiJahre = 730 * 86_400_000;
  if (Math.abs(p.data.datum.getTime() - tag.getTime()) > zweiJahre)
    return { fehler: 'Bitte prüfen Sie das Datum.' };

  const programm = await prisma.tcmsProgramm.findFirst({
    where: { mandantId: n.mandantId },
    orderBy: { createdAt: 'desc' },
    include: { mandant: true },
  });
  if (!programm)
    return {
      fehler:
        'Für Ihr Unternehmen ist noch kein Tax-CMS eingerichtet. Bitte wenden Sie sich an Ihre Kanzlei.',
    };

  const dateien = fd
    .getAll('anlagen')
    .filter(
      (x): x is File =>
        typeof x === 'object' && x !== null && 'arrayBuffer' in x && (x as File).size > 0,
    );
  if (dateien.length > MAX_ANLAGEN)
    return { fehler: `Bitte höchstens ${MAX_ANLAGEN} Anlagen beifügen.` };
  for (const d of dateien) {
    if (d.size > MAX_BYTES) return { fehler: `Die Datei „${d.name}" ist größer als 10 MB.` };
    if (d.type && !ERLAUBTE_TYPEN.test(d.type))
      return {
        fehler: `Der Dateityp von „${d.name}" wird nicht unterstützt (PDF, Bild, CSV, Excel, Word).`,
      };
  }
  // Dateien inhaltsadressiert ablegen; Metadaten und Hash gehen in den Audit-Eintrag.
  const anlagen: {
    dateiname: string;
    mime: string;
    groesse: number;
    sha256: string;
    speicherpfad: string;
  }[] = [];
  for (const d of dateien) {
    const gespeichert = await legeAnlageAb(Buffer.from(await d.arrayBuffer()));
    anlagen.push({
      dateiname: d.name.slice(0, 200),
      mime: d.type || 'application/octet-stream',
      groesse: gespeichert.groesse,
      sha256: gespeichert.sha256,
      speicherpfad: gespeichert.speicherpfad,
    });
  }

  const typ = p.data.typ;
  const res = await mitAudit(n, async (tx, zeitpunkt) => {
    const e = await legeEreignisAn(tx, {
      programmId: programm.id,
      typ,
      titel: p.data.titel,
      beschreibung: p.data.beschreibung,
      quelle: 'PORTAL',
      gemeldetVon: n.id,
      ereignisDatum: p.data.datum,
      zeitpunkt,
    });
    // Benachrichtigung der Kanzlei (Postausgang der Entwicklungsumgebung).
    const bearbeitung = await tx.person.findUnique({
      where: { id: programm.mandant.bearbeitungId },
    });
    await tx.nachricht.create({
      data: {
        an: bearbeitung?.name ?? 'Kanzlei',
        betreff: `Neues Ereignis ${e.nummer}: ${typInfo(typ).titel}`,
        text: `${n.name} hat für ${programm.mandant.name} am ${fmtDatumZeit(zeitpunkt)} ein Ereignis gemeldet: „${p.data.titel}". Bitte im Ereigniseingang triagieren.`,
        createdAt: zeitpunkt,
      },
    });
    return {
      wert: e,
      protokoll: {
        aktion: 'tcms.ereignis.gemeldet',
        objektTyp: 'Ereignis',
        objektId: e.id,
        programmId: programm.id,
        detail: {
          nummer: e.nummer,
          typ,
          quelle: 'PORTAL',
          anlagen,
          zusageAenderungen: fd.get('zusage') === '1',
        },
      },
    };
  });
  aktualisiereMandant(programm.mandantId);
  redirect(`/portal/tcms/ereignis?gemeldet=${encodeURIComponent(res.nummer)}`);
}
