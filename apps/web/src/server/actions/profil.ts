'use server';

import { redirect } from 'next/navigation';
import { z } from 'zod';
import { prisma, Prisma, type Tx } from '@tcms/db';
import {
  ereignistyp,
  fmtDatum,
  isoDatum,
  PROFIL_FRAGEN,
  schlageRisikenVor,
  type Geschaeftsprofil,
} from '@tcms/domain';
import {
  ereignisseFuerAenderung,
  gleichesProfil,
  leseProfil,
  neuZuBewerten,
  profilDiff,
  pruefeProfil,
  type FrageDiff,
} from '@/components/profil/profil-logik';
import { aktualisiereMandant, KEIN_RECHT, mitAudit, type Protokoll } from '../aktion';
import type { Ergebnis } from '../ergebnis';
import { naechsteEreignisnummern } from '../nummern';
import { AufbauFehler, nimmRisikoAuf } from '../programm-aufbau';
import { kannBearbeiten } from '../rechte';
import { ladeUmfeld } from '../setup-daten';
import { brauchtKanzlei } from '../sitzung';
import { heute, jetzt } from '../zeit';

// =============================================================================
// Geschäftsprofil (Profil-Tab): Profiländerung als neuer Stand mit Triggern
// (Fachkonzept § 4, § 7) und Aufnahme vorgeschlagener Risiken.
// =============================================================================

async function programmFuer(programmId: string) {
  return prisma.tcmsProgramm.findUnique({ where: { id: programmId }, include: { mandant: true } });
}

const AenderungSchema = z.object({
  programmId: z.string().min(1),
  profil: z.string().min(2).max(200_000),
  gueltigAb: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  ereignisse: z.string().optional(),
});

function titelFuer(d: FrageDiff | undefined, typ: string, stichwort?: string): string {
  const kat = ereignistyp(typ);
  if (!d) return kat?.titel ?? typ;
  const passt = (z: string) => !stichwort || z.includes(stichwort);
  const neuZ = d.neu.find(passt);
  const weg = d.entfallen.find(passt);
  const zeile = neuZ ?? (weg ? `${weg} entfällt` : d.titel);
  return `Profiländerung ${d.nr}: ${zeile}`.slice(0, 160);
}

export async function aendereProfil(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  const nutzer = await brauchtKanzlei();
  const p = AenderungSchema.safeParse({
    programmId: fd.get('programmId'),
    profil: fd.get('profil'),
    gueltigAb: fd.get('gueltigAb'),
    ereignisse: fd.get('ereignisse') ?? undefined,
  });
  if (!p.success) return { fehler: 'Bitte die Eingaben prüfen (Profil und Gültig-ab-Datum).' };
  const programm = await programmFuer(p.data.programmId);
  if (!programm) return { fehler: 'Tax-CMS nicht gefunden.' };
  if (!kannBearbeiten(nutzer, programm.mandant)) return { fehler: KEIN_RECHT };
  if (!programm.version1Am)
    return {
      fehler: 'Das Profil wird bis zur Anlage von Version 1 im Einrichtungsassistenten gepflegt.',
    };

  let roh: unknown;
  try {
    roh = JSON.parse(p.data.profil);
  } catch {
    return { fehler: 'Das Profil konnte nicht gelesen werden.' };
  }
  const { profil, fehler } = leseProfil(roh);
  if (!profil) return { fehler: ['Das Geschäftsprofil ist unvollständig:', ...fehler].join(' ') };
  const pflicht = pruefeProfil(profil);
  if (pflicht.length) return { fehler: pflicht.join(' ') };

  const letzter = await prisma.profilStand.findFirst({
    where: { programmId: programm.id, gueltigBis: null },
    orderBy: { gueltigAb: 'desc' },
  });
  if (!letzter) return { fehler: 'Kein offener Profilstand vorhanden.' };
  const alt = letzter.antworten as unknown as Geschaeftsprofil;
  if (gleichesProfil(alt, profil))
    return { fehler: 'Keine Änderung gegenüber dem letzten Profilstand.' };

  const tag = heute();
  const gewaehlt = new Date(`${p.data.gueltigAb}T00:00:00Z`);
  if (Number.isNaN(gewaehlt.getTime())) return { fehler: 'Gültig-ab-Datum ist ungültig.' };
  if (gewaehlt.getTime() < tag.getTime())
    return {
      fehler:
        'Ein neuer Profilstand gilt frühestens ab heute; historische Stände bleiben unverändert.',
    };
  if (gewaehlt.getTime() > tag.getTime() + 366 * 86_400_000)
    return { fehler: 'Gültig ab liegt mehr als ein Jahr in der Zukunft.' };

  const diff = profilDiff(alt, profil);
  const risiken = await prisma.risiko.findMany({
    where: { programmId: programm.id },
    select: { id: true, code: true, entscheidung: true, inaktivAb: true, neuBewerten: true },
  });
  const aktive = risiken.filter(
    (r) =>
      r.entscheidung === 'UEBERNOMMEN' &&
      !(r.inaktivAb && r.inaktivAb.getTime() <= jetzt().getTime()),
  );
  const nb = neuZuBewerten(
    alt,
    profil,
    aktive.map((r) => r.code),
  );
  const typen = p.data.ereignisse === 'on' ? ereignisseFuerAenderung(alt, profil) : [];
  const neuVorgeschlagen = schlageRisikenVor(profil)
    .filter((v) => !risiken.some((r) => r.code === v.code && r.entscheidung === 'UEBERNOMMEN'))
    .map((v) => v.code);

  const ergebnis = await mitAudit(nutzer, async (tx, zeitpunkt) => {
    // Gültig ab heute: ab dem Zeitpunkt der Änderung; künftig: ab Tagesbeginn.
    const ab = isoDatum(gewaehlt) === isoDatum(tag) ? zeitpunkt : gewaehlt;
    if (ab.getTime() <= letzter.gueltigAb.getTime())
      throw new AufbauFehler(
        `Gültig ab muss nach dem Beginn des letzten Stands (${fmtDatum(letzter.gueltigAb)}) liegen.`,
      );
    await tx.profilStand.update({ where: { id: letzter.id }, data: { gueltigBis: ab } });
    const stand = await tx.profilStand.create({
      data: {
        programmId: programm.id,
        antworten: profil as unknown as Prisma.InputJsonValue,
        gueltigAb: ab,
        erstelltVon: nutzer.id,
        createdAt: zeitpunkt,
      },
    });
    const protokolle: Protokoll[] = [];

    const markiert: { code: string; grund: string }[] = [];
    for (const r of aktive) {
      const grund = nb.get(r.code);
      if (!grund) continue;
      markiert.push({ code: r.code, grund });
      if (!r.neuBewerten)
        await tx.risiko.update({ where: { id: r.id }, data: { neuBewerten: true } });
      protokolle.push({
        aktion: 'tcms.risiko.neu_bewerten_markiert',
        objektTyp: 'Risiko',
        objektId: r.id,
        programmId: programm.id,
        detail: { code: r.code, grund, anlass: 'Profiländerung', profilStandId: stand.id },
      });
    }

    const nummern = await naechsteEreignisnummern(tx, zeitpunkt.getUTCFullYear(), typen.length);
    const ereignisse: string[] = [];
    for (const [i, t] of typen.entries()) {
      const kat = ereignistyp(t.typ);
      if (!kat) continue;
      const d = diff.find((x) => x.key === t.frage);
      const nummer = nummern[i]!;
      const zeilen = d
        ? [...d.neu.map((z) => `neu: ${z}`), ...d.entfallen.map((z) => `entfällt: ${z}`)]
        : [];
      const ev = await tx.ereignis.create({
        data: {
          programmId: programm.id,
          nummer,
          typ: t.typ,
          titel: titelFuer(d, t.typ, t.stichwort),
          beschreibung: [
            `Geschäftsprofil geändert (${PROFIL_FRAGEN.find((f) => f.key === t.frage)?.nr ?? ''}), gültig ab ${fmtDatum(gewaehlt)}.`,
            ...zeilen,
          ].join('\n'),
          quelle: 'STAMMDATEN',
          gemeldetVon: nutzer.id,
          gemeldetAm: zeitpunkt,
          ereignisDatum: gewaehlt,
          status: 'NEU',
          folgen: {
            create: kat.folgen.map((f) => {
              const risiko = f.ziel ? aktive.find((r) => r.code === f.ziel) : undefined;
              if (f.art === 'PROFIL_AENDERN')
                return {
                  art: f.art,
                  text: f.text,
                  status: 'ERLEDIGT' as const,
                  objektId: stand.id,
                  zustaendig: nutzer.id,
                  erledigtAm: zeitpunkt,
                };
              if (f.art === 'RISIKO_NEU_BEWERTEN' && risiko && nb.has(risiko.code))
                return {
                  art: f.art,
                  ziel: f.ziel,
                  text: f.text,
                  status: 'ANGELEGT' as const,
                  objektId: risiko.id,
                };
              if (f.art === 'RISIKO_AKTIVIEREN' && risiko)
                return {
                  art: f.art,
                  ziel: f.ziel,
                  text: f.text,
                  status: 'ERLEDIGT' as const,
                  objektId: risiko.id,
                  erledigtAm: zeitpunkt,
                };
              return { art: f.art, ziel: f.ziel ?? null, text: f.text };
            }),
          },
        },
      });
      ereignisse.push(nummer);
      protokolle.push({
        aktion: 'tcms.ereignis.angelegt',
        objektTyp: 'Ereignis',
        objektId: ev.id,
        programmId: programm.id,
        detail: { nummer, typ: t.typ, quelle: 'Profiländerung' },
      });
    }

    protokolle.unshift({
      aktion: 'tcms.profil.geaendert',
      objektTyp: 'TcmsProgramm',
      objektId: programm.id,
      programmId: programm.id,
      detail: {
        profilStandId: stand.id,
        vorherId: letzter.id,
        gueltigAb: isoDatum(gewaehlt),
        frage: diff[0]?.nr ?? null,
        aenderung: diff[0] ? (diff[0].neu[0] ?? `${diff[0].entfallen[0]} entfällt`) : null,
        fragen: diff.map((d) => d.nr),
        aenderungen: diff.map((d) => ({ frage: d.nr, neu: d.neu, entfallen: d.entfallen })),
        neuBewerten: markiert,
        ereignisse,
        neuVorgeschlagen,
      },
    });
    return {
      wert: {
        markiert: markiert.length,
        ereignisse: ereignisse.length,
        neu: neuVorgeschlagen.length,
      },
      protokoll: protokolle,
    };
  }).catch((e: unknown) => {
    if (e instanceof AufbauFehler) return { fehler: e.message } as const;
    throw e;
  });
  if ('fehler' in ergebnis) return { fehler: ergebnis.fehler };

  aktualisiereMandant(programm.mandantId);
  redirect(
    `/staff/clients/${programm.mandantId}/tcms/profil?geaendert=1&nb=${ergebnis.markiert}&ev=${ergebnis.ereignisse}&nv=${ergebnis.neu}#historie`,
  );
}

const AufnahmeSchema = z.object({
  programmId: z.string().min(1),
  code: z.string().regex(/^EC-[A-Z]{3}-\d{2}$/),
});

export async function nimmVorgeschlagenesRisikoAuf(
  _prev: Ergebnis,
  fd: FormData,
): Promise<Ergebnis> {
  const nutzer = await brauchtKanzlei();
  const p = AufnahmeSchema.safeParse({ programmId: fd.get('programmId'), code: fd.get('code') });
  if (!p.success) return { fehler: 'Bitte die Eingaben prüfen.' };
  const programm = await programmFuer(p.data.programmId);
  if (!programm) return { fehler: 'Tax-CMS nicht gefunden.' };
  if (!kannBearbeiten(nutzer, programm.mandant)) return { fehler: KEIN_RECHT };
  if (!programm.version1Am)
    return {
      fehler: 'Risiken werden bis zur Anlage von Version 1 im Einrichtungsassistenten übernommen.',
    };

  // Nur deterministische Vorschläge des jüngsten Profilstands (mit Grund).
  const stand = await prisma.profilStand.findFirst({
    where: { programmId: programm.id, gueltigBis: null },
    orderBy: { gueltigAb: 'desc' },
  });
  if (!stand) return { fehler: 'Kein Profilstand vorhanden.' };
  const vorschlag = schlageRisikenVor(stand.antworten as unknown as Geschaeftsprofil).find(
    (v) => v.code === p.data.code,
  );
  if (!vorschlag)
    return { fehler: `${p.data.code} wird aus dem aktuellen Profil nicht vorgeschlagen.` };

  const umfeld = await ladeUmfeld(programm.mandantId, heute());
  if (!umfeld) return { fehler: 'Mandant nicht gefunden.' };
  const ergebnis = await mitAudit(nutzer, async (tx, zeitpunkt) => {
    const a = await nimmRisikoAuf(tx, {
      programmId: programm.id,
      code: vorschlag.code,
      grund: vorschlag.grund,
      u: umfeld,
      nutzer,
      zeitpunkt,
    });
    return { wert: a, protokoll: a.protokolle };
  }).catch((e: unknown) => {
    if (e instanceof AufbauFehler) return { fehler: e.message } as const;
    throw e;
  });
  if ('fehler' in ergebnis) return { fehler: ergebnis.fehler };

  aktualisiereMandant(programm.mandantId);
  const q = new URLSearchParams({
    aufgenommen: vorschlag.code,
    d: String(ergebnis.durchfuehrungen),
  });
  if (ergebnis.neueKontrollen.length) q.set('kn', ergebnis.neueKontrollen.join(','));
  if (ergebnis.verknuepft.length) q.set('vk', ergebnis.verknuepft.join(','));
  if (ergebnis.neuGeplant.length) q.set('ng', ergebnis.neuGeplant.map((n) => n.code).join(','));
  redirect(`/staff/clients/${programm.mandantId}/tcms/profil?${q.toString()}#vorschlaege`);
}
