'use server';

import { redirect } from 'next/navigation';
import { z } from 'zod';
import { prisma, type Prisma } from '@tcms/db';
import {
  ABSCHNITTE,
  BAUSTEIN_LABEL,
  isoDatum,
  naechsteVersion,
  type Abschnitt,
  type BausteinArt,
} from '@tcms/domain';
import { aktualisiereMandant, KEIN_RECHT, mitAudit, type Protokoll } from '../aktion';
import {
  baueSnapshot,
  geruestAbschnitte,
  letzteBearbeitung,
  normalisiereAbschnitte,
  type VerlaufEintrag,
} from '../beschreibung-daten';
import type { Ergebnis } from '../ergebnis';
import { adresse, codeNachricht, erzeugeCode } from '../freigaben-daten';
import { ladeKontext } from '../kontext';
import { kannBearbeiten } from '../rechte';
import { brauchtKanzlei } from '../sitzung';
import { heute } from '../zeit';

// =============================================================================
// CMS-Beschreibung (Fachkonzept S14, §9): Entwurf bearbeiten, Kanzlei-Review im
// Vier-Augen-Prinzip, Freigabe beim Mandanten mit Snapshot und SHA-256.
// Freigegebene Versionen sind unveränderlich; Änderungen nur als neue Version.
// =============================================================================

class Abbruch extends Error {}

const ABSCHNITT_KEYS = ABSCHNITTE.map((a) => a.key) as [string, ...string[]];
const BAUSTEINE = Object.keys(BAUSTEIN_LABEL) as BausteinArt[];
const MAX_TEXT = 20_000;

async function ladeVersion(id: string) {
  return prisma.beschreibungVersion.findUnique({
    where: { id },
    include: { programm: { include: { mandant: true } } },
  });
}

function versionsZahl(n: string): [number, number] {
  const [a, b] = n.split('.').map((x) => Number.parseInt(x, 10));
  return [a ?? 0, b ?? 0];
}

async function fuehreAus(fn: () => Promise<unknown>): Promise<Ergebnis | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    if (e instanceof Abbruch) return { fehler: e.message };
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Abschnitt im Entwurf bearbeiten
// ---------------------------------------------------------------------------

const AbschnittSchema = z.object({
  versionId: z.string().min(1),
  key: z.enum(ABSCHNITT_KEYS),
  neuerBaustein: z.string().optional(),
});

export async function speichereAbschnitt(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  const nutzer = await brauchtKanzlei();
  const p = AbschnittSchema.safeParse({
    versionId: fd.get('versionId'),
    key: fd.get('key'),
    neuerBaustein: fd.get('neuerBaustein') || undefined,
  });
  if (!p.success) return { fehler: 'Bitte die Eingaben prüfen.' };
  const v = await ladeVersion(p.data.versionId);
  if (!v) return { fehler: 'Version nicht gefunden.' };
  if (!kannBearbeiten(nutzer, v.programm.mandant)) return { fehler: KEIN_RECHT };
  if (v.status !== 'ENTWURF')
    return {
      fehler:
        'Nur Entwürfe sind bearbeitbar. Änderungen an dieser Version entstehen als neue Version.',
    };

  const abschnitte = normalisiereAbschnitte(v.abschnitte);
  const idx = abschnitte.findIndex((a) => a.key === p.data.key);
  const alt = abschnitte[idx]!;
  const bloecke: Abschnitt['bloecke'] = [];
  for (const [i, b] of alt.bloecke.entries()) {
    if (b.typ === 'text') {
      const t = fd.get(`text_${i}`);
      bloecke.push({
        typ: 'text',
        text: typeof t === 'string' ? t.replace(/\r\n/g, '\n').trimEnd() : b.text,
      });
    } else if (fd.get(`entfernen_${i}`) !== 'on') {
      bloecke.push(b);
    }
  }
  const neu = fd.get('text_neu');
  if (typeof neu === 'string' && neu.trim() && !bloecke.some((b) => b.typ === 'text')) {
    bloecke.unshift({ typ: 'text', text: neu.replace(/\r\n/g, '\n').trimEnd() });
  }
  if (p.data.neuerBaustein) {
    const art = p.data.neuerBaustein as BausteinArt;
    if (!BAUSTEINE.includes(art)) return { fehler: 'Unbekannter Baustein.' };
    if (bloecke.some((b) => b.typ === 'baustein' && b.art === art))
      return {
        fehler: `Der Baustein „${BAUSTEIN_LABEL[art]}“ ist in diesem Abschnitt bereits enthalten.`,
      };
    bloecke.push({ typ: 'baustein', art });
  }
  if (bloecke.some((b) => b.typ === 'text' && b.text.length > MAX_TEXT))
    return {
      fehler: `Ein Textblock darf höchstens ${MAX_TEXT.toLocaleString('de-DE')} Zeichen haben.`,
    };
  if (JSON.stringify(bloecke) === JSON.stringify(alt.bloecke)) return { ok: 'Keine Änderungen.' };

  const zeichen = (bl: Abschnitt['bloecke']) =>
    bl.reduce((s, b) => s + (b.typ === 'text' ? b.text.trim().length : 0), 0);
  const arten = (bl: Abschnitt['bloecke']) =>
    bl.filter((b) => b.typ === 'baustein').map((b) => (b as { art: BausteinArt }).art);
  abschnitte[idx] = { key: alt.key, bloecke };

  const fehler = await fuehreAus(() =>
    mitAudit(nutzer, async (tx) => {
      const r = await tx.beschreibungVersion.updateMany({
        where: { id: v.id, status: 'ENTWURF' },
        data: { abschnitte: abschnitte as unknown as Prisma.InputJsonValue },
      });
      if (r.count !== 1) throw new Abbruch('Die Version ist inzwischen kein Entwurf mehr.');
      return {
        wert: null,
        protokoll: {
          aktion: 'tcms.beschreibung.abschnitt_geaendert',
          objektTyp: 'BeschreibungVersion',
          objektId: v.id,
          programmId: v.programmId,
          detail: {
            nummer: v.nummer,
            abschnitt: alt.key,
            zeichenVorher: zeichen(alt.bloecke),
            zeichenNachher: zeichen(bloecke),
            bausteineVorher: arten(alt.bloecke),
            bausteineNachher: arten(bloecke),
          },
        },
      };
    }),
  );
  if (fehler) return fehler;
  aktualisiereMandant(v.programm.mandantId);
  return { ok: `Abschnitt in v${v.nummer} gespeichert.` };
}

// ---------------------------------------------------------------------------
// Neue Version aus der letzten anlegen
// ---------------------------------------------------------------------------

export async function neueVersion(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  const nutzer = await brauchtKanzlei();
  const programmId = String(fd.get('programmId') ?? '');
  const programm = await prisma.tcmsProgramm.findUnique({
    where: { id: programmId },
    include: { mandant: true },
  });
  if (!programm) return { fehler: 'Tax-CMS nicht gefunden.' };
  if (!kannBearbeiten(nutzer, programm.mandant)) return { fehler: KEIN_RECHT };

  let neueId = '';
  const fehler = await fuehreAus(async () => {
    neueId = await mitAudit(nutzer, async (tx, zeitpunkt) => {
      const versionen = await tx.beschreibungVersion.findMany({
        where: { programmId },
        orderBy: { createdAt: 'asc' },
      });
      const offen = versionen.find((x) => x.status === 'ENTWURF' || x.status === 'KANZLEI_REVIEW');
      if (offen)
        throw new Abbruch(
          `Version ${offen.nummer} ist noch in Bearbeitung (${offen.status === 'ENTWURF' ? 'Entwurf' : 'Kanzlei-Review'}).`,
        );
      const hoechste = versionen
        .map((x) => x.nummer)
        .sort((a, b) => {
          const [a1, a2] = versionsZahl(a);
          const [b1, b2] = versionsZahl(b);
          return a1 - b1 || a2 - b2;
        })
        .at(-1);
      const basis = versionen.at(-1) ?? null;
      const nummer = naechsteVersion(hoechste ?? null);
      const abschnitte = basis ? normalisiereAbschnitte(basis.abschnitte) : geruestAbschnitte();
      const v = await tx.beschreibungVersion.create({
        data: {
          programmId,
          nummer,
          status: 'ENTWURF',
          abschnitte: abschnitte as unknown as Prisma.InputJsonValue,
          createdAt: zeitpunkt,
          erstelltVon: nutzer.id,
        },
      });
      return {
        wert: v.id,
        protokoll: {
          aktion: 'tcms.beschreibung.version_angelegt',
          objektTyp: 'BeschreibungVersion',
          objektId: v.id,
          programmId,
          detail: { nummer, basis: basis?.nummer ?? null },
        },
      };
    });
  });
  if (fehler) return fehler;
  aktualisiereMandant(programm.mandantId);
  redirect(`/staff/clients/${programm.mandantId}/tcms/beschreibung?version=${neueId}`);
}

// ---------------------------------------------------------------------------
// Kanzlei-Review
// ---------------------------------------------------------------------------

const IdSchema = z.object({ versionId: z.string().min(1) });

export async function zurReview(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  const nutzer = await brauchtKanzlei();
  const p = IdSchema.safeParse(Object.fromEntries(fd));
  if (!p.success) return { fehler: 'Bitte die Eingaben prüfen.' };
  const v = await ladeVersion(p.data.versionId);
  if (!v) return { fehler: 'Version nicht gefunden.' };
  if (!kannBearbeiten(nutzer, v.programm.mandant)) return { fehler: KEIN_RECHT };
  if (v.status !== 'ENTWURF')
    return { fehler: 'Nur ein Entwurf kann zur Kanzlei-Review gegeben werden.' };
  const fehler = await fuehreAus(() =>
    mitAudit(nutzer, async (tx, zeitpunkt) => {
      const r = await tx.beschreibungVersion.updateMany({
        where: { id: v.id, status: 'ENTWURF' },
        data: {
          status: 'KANZLEI_REVIEW',
          reviewAngefordertVon: nutzer.id,
          reviewAngefordertAm: zeitpunkt,
          reviewVon: null,
          reviewAm: null,
        },
      });
      if (r.count !== 1) throw new Abbruch('Die Version ist inzwischen kein Entwurf mehr.');
      return {
        wert: null,
        protokoll: {
          aktion: 'tcms.beschreibung.review_angefordert',
          objektTyp: 'BeschreibungVersion',
          objektId: v.id,
          programmId: v.programmId,
          detail: { nummer: v.nummer },
        },
      };
    }),
  );
  if (fehler) return fehler;
  aktualisiereMandant(v.programm.mandantId);
  return { ok: `v${v.nummer} liegt zur Kanzlei-Review vor.` };
}

async function verlaufVon(versionId: string): Promise<VerlaufEintrag[]> {
  const rows = await prisma.auditEvent.findMany({
    where: { objektTyp: 'BeschreibungVersion', objektId: versionId },
    orderBy: { seq: 'asc' },
  });
  return rows.map((a) => ({
    at: a.at,
    aktion: a.aktion,
    actorId: a.actorId,
    actorName: a.actorName,
    objektId: a.objektId,
    detail: (a.detail as Record<string, unknown>) ?? {},
  }));
}

export async function reviewAbschliessen(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  const nutzer = await brauchtKanzlei();
  const p = IdSchema.safeParse(Object.fromEntries(fd));
  if (!p.success) return { fehler: 'Bitte die Eingaben prüfen.' };
  const v = await ladeVersion(p.data.versionId);
  if (!v) return { fehler: 'Version nicht gefunden.' };
  if (!kannBearbeiten(nutzer, v.programm.mandant)) return { fehler: KEIN_RECHT };
  if (v.status !== 'KANZLEI_REVIEW' || v.reviewVon)
    return { fehler: 'Für diese Version ist keine Kanzlei-Review offen.' };
  const letzte = letzteBearbeitung(v, await verlaufVon(v.id));
  if (letzte && letzte === nutzer.id)
    return {
      fehler:
        'Die Review schließt eine zweite Person ab – nicht die letzte Bearbeitung des Textes.',
    };
  const fehler = await fuehreAus(() =>
    mitAudit(nutzer, async (tx, zeitpunkt) => {
      const r = await tx.beschreibungVersion.updateMany({
        where: { id: v.id, status: 'KANZLEI_REVIEW', reviewVon: null },
        data: { reviewVon: nutzer.id, reviewAm: zeitpunkt },
      });
      if (r.count !== 1) throw new Abbruch('Die Review wurde inzwischen bereits abgeschlossen.');
      return {
        wert: null,
        protokoll: {
          aktion: 'tcms.beschreibung.review_abgeschlossen',
          objektTyp: 'BeschreibungVersion',
          objektId: v.id,
          programmId: v.programmId,
          detail: { nummer: v.nummer, letzteBearbeitung: letzte },
        },
      };
    }),
  );
  if (fehler) return fehler;
  aktualisiereMandant(v.programm.mandantId);
  return { ok: `Kanzlei-Review für v${v.nummer} abgeschlossen.` };
}

const ZurueckSchema = z.object({
  versionId: z.string().min(1),
  begruendung: z.string().trim().min(30),
});

export async function reviewZurueckweisen(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  const nutzer = await brauchtKanzlei();
  const p = ZurueckSchema.safeParse(Object.fromEntries(fd));
  if (!p.success) return { fehler: 'Bitte eine Begründung mit mindestens 30 Zeichen angeben.' };
  const v = await ladeVersion(p.data.versionId);
  if (!v) return { fehler: 'Version nicht gefunden.' };
  if (!kannBearbeiten(nutzer, v.programm.mandant)) return { fehler: KEIN_RECHT };
  if (v.status !== 'KANZLEI_REVIEW')
    return { fehler: 'Für diese Version ist keine Kanzlei-Review offen.' };
  const fehler = await fuehreAus(() =>
    mitAudit(nutzer, async (tx) => {
      const r = await tx.beschreibungVersion.updateMany({
        where: { id: v.id, status: 'KANZLEI_REVIEW' },
        data: {
          status: 'ENTWURF',
          reviewAngefordertVon: null,
          reviewAngefordertAm: null,
          reviewVon: null,
          reviewAm: null,
        },
      });
      if (r.count !== 1) throw new Abbruch('Die Version ist nicht mehr in der Kanzlei-Review.');
      return {
        wert: null,
        protokoll: {
          aktion: 'tcms.beschreibung.review_zurueckgewiesen',
          objektTyp: 'BeschreibungVersion',
          objektId: v.id,
          programmId: v.programmId,
          detail: { nummer: v.nummer, begruendung: p.data.begruendung },
        },
      };
    }),
  );
  if (fehler) return fehler;
  aktualisiereMandant(v.programm.mandantId);
  return { ok: `v${v.nummer} ist zurück im Entwurf.` };
}

// ---------------------------------------------------------------------------
// Freigabe beim Mandanten anfordern (Snapshot + E-Mail-Code)
// ---------------------------------------------------------------------------

export async function freigabeAnfordern(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  const nutzer = await brauchtKanzlei();
  const p = IdSchema.safeParse(Object.fromEntries(fd));
  if (!p.success) return { fehler: 'Bitte die Eingaben prüfen.' };
  const v = await ladeVersion(p.data.versionId);
  if (!v) return { fehler: 'Version nicht gefunden.' };
  const mandant = v.programm.mandant;
  if (!kannBearbeiten(nutzer, mandant)) return { fehler: KEIN_RECHT };
  if (v.status !== 'KANZLEI_REVIEW' || !v.reviewVon)
    return {
      fehler: 'Die Freigabe kann erst nach abgeschlossener Kanzlei-Review angefordert werden.',
    };
  const gv = await prisma.person.findFirst({
    where: { mandantId: mandant.id, mandantRolle: 'GESETZLICHER_VERTRETER', aktiv: true },
    orderBy: { name: 'asc' },
  });
  if (!gv) return { fehler: 'Beim Mandanten ist keine gesetzliche Vertretung erfasst.' };
  const ctx = await ladeKontext(mandant.id, isoDatum(heute()), false);
  if (!ctx) return { fehler: 'Tax-CMS nicht gefunden.' };
  const titel = `CMS-Beschreibung v${v.nummer}`;

  let ergebnis = { zurueckgezogen: [] as string[] };
  const fehler = await fuehreAus(async () => {
    ergebnis = await mitAudit(nutzer, async (tx, zeitpunkt) => {
      const { snapshot, sha256: hash } = baueSnapshot(
        { nummer: v.nummer, abschnitte: normalisiereAbschnitte(v.abschnitte) },
        ctx,
        zeitpunkt,
      );
      const r = await tx.beschreibungVersion.updateMany({
        where: { id: v.id, status: 'KANZLEI_REVIEW', reviewVon: { not: null } },
        data: {
          status: 'BEIM_MANDANTEN',
          freigabeAngefordertAm: zeitpunkt,
          snapshot: snapshot as unknown as Prisma.InputJsonValue,
          snapshotSha256: hash,
        },
      });
      if (r.count !== 1) throw new Abbruch('Die Version hat ihren Status inzwischen geändert.');

      // Eine noch offene Anforderung einer älteren Version wird zurückgezogen.
      const aeltere = await tx.beschreibungVersion.findMany({
        where: { programmId: v.programmId, status: 'BEIM_MANDANTEN', id: { not: v.id } },
      });
      const protokoll: Protokoll[] = [];
      for (const a of aeltere) {
        await tx.beschreibungVersion.update({ where: { id: a.id }, data: { status: 'ABGELOEST' } });
        await tx.freigabe.updateMany({
          where: { programmId: v.programmId, art: 'BESCHREIBUNG', refId: a.id, status: 'OFFEN' },
          data: {
            status: 'ABGELEHNT',
            anmerkung: `Zurückgezogen: ersetzt durch Anforderung v${v.nummer}`,
            erledigtAm: zeitpunkt,
            codeHash: null,
          },
        });
        protokoll.push({
          aktion: 'tcms.beschreibung.freigabe_zurueckgezogen',
          objektTyp: 'BeschreibungVersion',
          objektId: a.id,
          programmId: v.programmId,
          detail: { nummer: a.nummer, ersetztDurch: v.nummer },
        });
      }

      const { code, codeHash, codeAblauf } = erzeugeCode(zeitpunkt);
      const freigabe = await tx.freigabe.create({
        data: {
          programmId: v.programmId,
          art: 'BESCHREIBUNG',
          refId: v.id,
          titel,
          angefordertVon: nutzer.id,
          angefordertAm: zeitpunkt,
          empfaengerId: gv.id,
          codeHash,
          codeAblauf,
          status: 'OFFEN',
        },
      });
      const n = codeNachricht({
        empfaenger: gv.name,
        mandant: mandant.name,
        titel,
        code,
        codeAblauf,
        sha256: hash,
      });
      await tx.nachricht.create({
        data: { an: adresse(gv), betreff: n.betreff, text: n.text, createdAt: zeitpunkt },
      });
      protokoll.push({
        aktion: 'tcms.beschreibung.freigabe_angefordert',
        objektTyp: 'BeschreibungVersion',
        objektId: v.id,
        programmId: v.programmId,
        detail: {
          nummer: v.nummer,
          freigabeId: freigabe.id,
          empfaenger: gv.name,
          snapshotSha256: hash,
          codeAblauf: codeAblauf.toISOString(),
        },
      });
      return { wert: { zurueckgezogen: aeltere.map((a) => a.nummer) }, protokoll };
    });
  });
  if (fehler) return fehler;
  aktualisiereMandant(mandant.id);
  const zusatz = ergebnis.zurueckgezogen.length
    ? ` Die offene Anforderung für v${ergebnis.zurueckgezogen.join(', v')} wurde zurückgezogen.`
    : '';
  return {
    ok: `Freigabe bei ${gv.name} angefordert; der Bestätigungscode liegt im Postausgang.${zusatz}`,
  };
}
