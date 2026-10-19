'use server';

import { z } from 'zod';
import { prisma } from '@tcms/db';
import {
  EREIGNISTYPEN,
  ereignisErledigt,
  FOLGE_LABEL,
  isoDatum,
  type FolgeArt,
} from '@tcms/domain';
import { aktualisiereMandant, KEIN_RECHT, mitAudit, type Protokoll } from '../aktion';
import type { Ergebnis } from '../ergebnis';
import { legeEreignisAn } from '../ereignisse-daten';
import {
  legeAusserplanmaessigeDurchfuehrungAn,
  naechsteFeststellungsnummer,
} from '../feststellungen-daten';
import { kannBearbeiten, zweitePerson } from '../rechte';
import { brauchtKanzlei, type Nutzer } from '../sitzung';
import { heute, jetzt } from '../zeit';

// =============================================================================
// Server Actions S11 – Ereigniseingang und Triage. Ein Ereignis ist erst
// erledigt, wenn jede Folge erledigt oder begründet verworfen ist.
// =============================================================================

const PRUEFEN = 'Bitte die Eingaben prüfen.';
const ABGESCHLOSSEN = 'Das Ereignis ist bereits erledigt oder verworfen.';

const datum = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .transform((v) => new Date(`${v}T00:00:00Z`))
  .refine((d) => !Number.isNaN(d.getTime()));

async function ladeEreignis(id: string) {
  return prisma.ereignis.findUnique({
    where: { id },
    include: { folgen: true, programm: { include: { mandant: true } } },
  });
}
type Geladen = NonNullable<Awaited<ReturnType<typeof ladeEreignis>>>;

async function vorpruefung(
  n: Nutzer,
  id: string,
  offen = true,
): Promise<{ e: Geladen } | { fehler: string }> {
  const e = await ladeEreignis(id);
  if (!e) return { fehler: 'Ereignis nicht gefunden.' };
  if (!kannBearbeiten(n, e.programm.mandant)) return { fehler: KEIN_RECHT };
  if (offen && (e.status === 'ERLEDIGT' || e.status === 'VERWORFEN'))
    return { fehler: ABGESCHLOSSEN };
  return { e };
}

function triageStart(
  n: Nutzer,
  e: Pick<Geladen, 'id' | 'status' | 'nummer' | 'programmId'>,
  zeitpunkt: Date,
): {
  data: { status: 'IN_TRIAGE'; triagiertVon: string; triagiertAm: Date } | null;
  protokoll: Protokoll | null;
} {
  if (e.status !== 'NEU') return { data: null, protokoll: null };
  return {
    data: { status: 'IN_TRIAGE', triagiertVon: n.id, triagiertAm: zeitpunkt },
    protokoll: {
      aktion: 'tcms.ereignis.in_triage',
      objektTyp: 'Ereignis',
      objektId: e.id,
      programmId: e.programmId,
      detail: { nummer: e.nummer },
    },
  };
}

/** Kanzleipersonen und Personen dieses Mandanten. */
async function zulaessigePerson(
  id: string | undefined,
  mandantId: string,
): Promise<{ id: string; name: string } | null | 'ungueltig'> {
  if (!id) return null;
  const p = await prisma.person.findUnique({ where: { id } });
  if (!p || !p.aktiv || (p.art !== 'KANZLEI' && p.mandantId !== mandantId)) return 'ungueltig';
  return { id: p.id, name: p.name };
}

// ----------------------------------------------------------------------------
// In Prüfung nehmen
// ----------------------------------------------------------------------------

export async function nehmeInPruefung(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  const n = await brauchtKanzlei();
  const p = z.object({ id: z.string().min(1) }).safeParse(Object.fromEntries(fd));
  if (!p.success) return { fehler: PRUEFEN };
  const v = await vorpruefung(n, p.data.id);
  if ('fehler' in v) return v;
  const { e } = v;
  if (e.status !== 'NEU') return { fehler: 'Das Ereignis ist bereits in Prüfung.' };
  await mitAudit(n, async (tx, zeitpunkt) => {
    const t = triageStart(n, e, zeitpunkt);
    await tx.ereignis.update({ where: { id: e.id }, data: t.data! });
    return { wert: null, protokoll: t.protokoll! };
  });
  aktualisiereMandant(e.programm.mandantId);
  return { ok: 'In Prüfung genommen.' };
}

// ----------------------------------------------------------------------------
// Folgen anlegen (Mehrfachauswahl der Vorschläge)
// ----------------------------------------------------------------------------

const FS_KLASSEN = [
  'DESIGNMANGEL',
  'DURCHFUEHRUNGSMANGEL',
  'STEUERLICHER_FEHLER',
  'HINWEIS',
] as const;
const KLASSEN = ['GERING', 'MITTEL', 'HOCH', 'KRITISCH'] as const;
const AUSWIRKUNGEN = ['JA', 'NEIN', 'UNKLAR'] as const;

export async function legeFolgenAn(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  const n = await brauchtKanzlei();
  const ereignisId = String(fd.get('ereignisId') ?? '');
  const gewaehlt = fd.getAll('folge').map(String).filter(Boolean);
  if (!ereignisId) return { fehler: PRUEFEN };
  if (gewaehlt.length === 0) return { fehler: 'Bitte mindestens eine Folge auswählen.' };
  const v = await vorpruefung(n, ereignisId);
  if ('fehler' in v) return v;
  const { e } = v;
  const programmId = e.programmId;
  const mandantId = e.programm.mandantId;
  const tag = heute();

  // Eingaben je Folge prüfen, bevor etwas geschrieben wird.
  type Plan = {
    folge: Geladen['folgen'][number];
    zustaendig: { id: string; name: string } | null;
    frist: Date | null;
    risiko?: { id: string; code: string; aktiv: boolean } | null;
    kontrolle?: { id: string; code: string } | null;
    feststellung?: {
      titel: string;
      klasse: (typeof FS_KLASSEN)[number];
      schwere: (typeof KLASSEN)[number];
      auswirkung: (typeof AUSWIRKUNGEN)[number];
    };
  };
  const plaene: Plan[] = [];
  const fehler: string[] = [];
  for (const id of gewaehlt) {
    const folge = e.folgen.find((f) => f.id === id);
    if (!folge || folge.status !== 'VORGESCHLAGEN') {
      fehler.push('Eine gewählte Folge ist nicht mehr offen.');
      continue;
    }
    const label = `${FOLGE_LABEL[folge.art]}${folge.ziel ? ` ${folge.ziel}` : ''}`;
    const zustaendig = await zulaessigePerson(
      String(fd.get(`zustaendig_${id}`) ?? '') || undefined,
      mandantId,
    );
    if (zustaendig === 'ungueltig') {
      fehler.push(`${label}: Zuständigkeit ist nicht zulässig.`);
      continue;
    }
    const fristRoh = String(fd.get(`frist_${id}`) ?? '');
    let frist: Date | null = null;
    if (fristRoh) {
      const d = datum.safeParse(fristRoh);
      if (!d.success) {
        fehler.push(`${label}: Frist ist ungültig.`);
        continue;
      }
      if (d.data.getTime() < tag.getTime()) {
        fehler.push(`${label}: Frist liegt in der Vergangenheit.`);
        continue;
      }
      frist = d.data;
    }
    const plan: Plan = { folge, zustaendig, frist };
    if (folge.art === 'RISIKO_NEU_BEWERTEN' || folge.art === 'RISIKO_AKTIVIEREN') {
      const r = folge.ziel
        ? await prisma.risiko.findUnique({
            where: { programmId_code: { programmId, code: folge.ziel } },
          })
        : null;
      const aktiv =
        !!r &&
        r.entscheidung === 'UEBERNOMMEN' &&
        (!r.inaktivAb || r.inaktivAb.getTime() > jetzt().getTime());
      if (folge.art === 'RISIKO_NEU_BEWERTEN' && !aktiv) {
        fehler.push(
          `${label}: Risiko ist im Inventar nicht aktiv – Folge verwerfen oder Risiko zuerst aufnehmen.`,
        );
        continue;
      }
      plan.risiko = r ? { id: r.id, code: r.code, aktiv } : null;
    }
    if (folge.art === 'KONTROLLE_AUSSERPLANMAESSIG') {
      const k = folge.ziel
        ? await prisma.kontrolle.findUnique({
            where: { programmId_code: { programmId, code: folge.ziel } },
          })
        : null;
      if (
        !k ||
        k.aktivAb.getTime() > jetzt().getTime() ||
        (k.entfallenAb && k.entfallenAb.getTime() <= jetzt().getTime())
      ) {
        fehler.push(`${label}: Kontrolle ist im Programm nicht aktiv.`);
        continue;
      }
      if (!frist) {
        fehler.push(`${label}: Bitte eine Fälligkeit (Frist) setzen.`);
        continue;
      }
      plan.kontrolle = { id: k.id, code: k.code };
    }
    if (folge.art === 'FESTSTELLUNG_ANLEGEN') {
      const fp = z
        .object({
          titel: z.string().trim().min(5).max(200),
          klasse: z.enum(FS_KLASSEN),
          schwere: z.enum(KLASSEN),
          auswirkung: z.enum(AUSWIRKUNGEN),
        })
        .safeParse({
          titel: fd.get(`ftitel_${id}`),
          klasse: fd.get(`fklasse_${id}`),
          schwere: fd.get(`fschwere_${id}`),
          auswirkung: fd.get(`fauswirkung_${id}`),
        });
      if (!fp.success) {
        fehler.push(`${label}: Titel (mind. 5 Zeichen), Klasse, Schwere und Auswirkung angeben.`);
        continue;
      }
      plan.feststellung = fp.data;
    }
    plaene.push(plan);
  }
  if (fehler.length) return { fehler: fehler.join(' ') };

  const ergebnis = await mitAudit(n, async (tx, zeitpunkt) => {
    const protokoll: Protokoll[] = [];
    const t = triageStart(n, e, zeitpunkt);
    if (t.data) {
      await tx.ereignis.update({ where: { id: e.id }, data: t.data });
      protokoll.push(t.protokoll!);
    }
    const angelegt: string[] = [];
    for (const pl of plaene) {
      const f = pl.folge;
      let objektId: string | null = null;
      let status: 'ANGELEGT' | 'ERLEDIGT' = 'ANGELEGT';
      let objektText: string | null = null;
      if (f.art === 'RISIKO_NEU_BEWERTEN' || (f.art === 'RISIKO_AKTIVIEREN' && pl.risiko?.aktiv)) {
        await tx.risiko.update({ where: { id: pl.risiko!.id }, data: { neuBewerten: true } });
        objektId = pl.risiko!.id;
        protokoll.push({
          aktion: 'tcms.risiko.neu_bewerten_markiert',
          objektTyp: 'Risiko',
          objektId: pl.risiko!.id,
          programmId,
          detail: { code: pl.risiko!.code, anlass: `Ereignis ${e.nummer}` },
        });
      } else if (f.art === 'RISIKO_AKTIVIEREN') {
        objektId = pl.risiko?.id ?? null;
      } else if (f.art === 'KONTROLLE_AUSSERPLANMAESSIG') {
        const d = await legeAusserplanmaessigeDurchfuehrungAn(tx, {
          kontrolleId: pl.kontrolle!.id,
          faelligAm: pl.frist!,
          anlass: `Ereignis ${e.nummer} (${e.typ})`,
          label: `außerplanmäßig (Ereignis ${e.nummer})`,
          ereignisFolgeId: f.id,
          zeitpunkt,
        });
        objektId = d.id;
        objektText = d.code;
        protokoll.push({
          aktion: 'tcms.durchfuehrung.ausserplanmaessig',
          objektTyp: 'Durchfuehrung',
          objektId: d.id,
          programmId,
          detail: {
            kontrolle: d.code,
            anlass: `Ereignis ${e.nummer}`,
            faelligAm: isoDatum(pl.frist!),
          },
        });
      } else if (f.art === 'FESTSTELLUNG_ANLEGEN') {
        const fs = pl.feststellung!;
        const nr = await naechsteFeststellungsnummer(tx, programmId, zeitpunkt.getUTCFullYear());
        const neu = await tx.feststellung.create({
          data: {
            programmId,
            nummer: nr,
            titel: fs.titel,
            sachverhalt: e.beschreibung,
            quelle: 'EREIGNIS',
            quelleText: `Ereignis ${e.nummer} (${e.typ})`,
            ereignisId: e.id,
            klasse: fs.klasse,
            schwere: fs.schwere,
            auswirkung: fs.auswirkung,
            status: 'ERFASST',
            erfasstVon: n.id,
            erfasstAm: zeitpunkt,
          },
        });
        objektId = neu.id;
        objektText = nr;
        status = 'ERLEDIGT';
        protokoll.push({
          aktion: 'tcms.feststellung.erfasst',
          objektTyp: 'Feststellung',
          objektId: neu.id,
          programmId,
          detail: { nummer: nr, quelle: `Ereignis ${e.nummer}` },
        });
      }
      await tx.ereignisFolge.update({
        where: { id: f.id },
        data: {
          status,
          objektId,
          zustaendig: pl.zustaendig?.id ?? null,
          frist: pl.frist,
          ...(status === 'ERLEDIGT' ? { erledigtAm: zeitpunkt } : {}),
        },
      });
      protokoll.push({
        aktion: 'tcms.ereignis.folge_angelegt',
        objektTyp: 'EreignisFolge',
        objektId: f.id,
        programmId,
        detail: {
          ereignis: e.nummer,
          art: f.art,
          label: FOLGE_LABEL[f.art],
          ziel: f.ziel,
          objekt: objektText,
          zustaendig: pl.zustaendig?.name ?? null,
          frist: pl.frist ? isoDatum(pl.frist) : null,
        },
      });
      angelegt.push(objektText ?? FOLGE_LABEL[f.art]);
    }
    return { wert: angelegt, protokoll };
  });
  aktualisiereMandant(mandantId);
  return { ok: `${ergebnis.length} ${ergebnis.length === 1 ? 'Folge' : 'Folgen'} angelegt.` };
}

// ----------------------------------------------------------------------------
// Weitere Folge vorschlagen (eigene Triage-Entscheidung)
// ----------------------------------------------------------------------------

const ART = [
  'RISIKO_NEU_BEWERTEN',
  'RISIKO_AKTIVIEREN',
  'KONTROLLE_AUSSERPLANMAESSIG',
  'PROFIL_AENDERN',
  'FESTSTELLUNG_ANLEGEN',
  'HINWEIS',
] as const;

export async function fuegeFolgeHinzu(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  const n = await brauchtKanzlei();
  const p = z
    .object({
      ereignisId: z.string().min(1),
      art: z.enum(ART),
      ziel: z.string().trim().max(20).optional(),
      text: z.string().trim().min(5).max(300),
    })
    .safeParse(Object.fromEntries(fd));
  if (!p.success) return { fehler: 'Bitte Art und Beschreibung (mind. 5 Zeichen) angeben.' };
  const v = await vorpruefung(n, p.data.ereignisId);
  if ('fehler' in v) return v;
  const { e } = v;
  const ziel = p.data.ziel ? p.data.ziel.toUpperCase() : null;
  const art: FolgeArt = p.data.art;
  if (
    (art === 'RISIKO_NEU_BEWERTEN' || art === 'RISIKO_AKTIVIEREN') &&
    !(ziel && /^EC-[A-Z]{3}-\d{2}$/.test(ziel))
  )
    return { fehler: 'Bitte den Risikocode angeben (z. B. EC-UST-02).' };
  if (art === 'KONTROLLE_AUSSERPLANMAESSIG' && !(ziel && /^K-EC-\d{2}$/.test(ziel)))
    return { fehler: 'Bitte den Kontrollcode angeben (z. B. K-EC-02).' };
  await mitAudit(n, async (tx) => {
    const f = await tx.ereignisFolge.create({
      data: { ereignisId: e.id, art, ziel, text: p.data.text },
    });
    return {
      wert: null,
      protokoll: {
        aktion: 'tcms.ereignis.folge_hinzugefuegt',
        objektTyp: 'EreignisFolge',
        objektId: f.id,
        programmId: e.programmId,
        detail: { ereignis: e.nummer, art, label: FOLGE_LABEL[art], ziel, text: p.data.text },
      },
    };
  });
  aktualisiereMandant(e.programm.mandantId);
  return { ok: 'Folge vorgeschlagen – jetzt auswählen und anlegen.' };
}

// ----------------------------------------------------------------------------
// Folge erledigen / verwerfen
// ----------------------------------------------------------------------------

async function ladeFolge(id: string) {
  return prisma.ereignisFolge.findUnique({
    where: { id },
    include: { ereignis: { include: { folgen: true, programm: { include: { mandant: true } } } } },
  });
}

/** Neubewertungs-Markierung nur aufheben, wenn keine andere offene Folge sie braucht. */
async function markierungFrei(risikoId: string, ausserFolgeId: string): Promise<boolean> {
  const andere = await prisma.ereignisFolge.count({
    where: {
      id: { not: ausserFolgeId },
      objektId: risikoId,
      art: { in: ['RISIKO_NEU_BEWERTEN', 'RISIKO_AKTIVIEREN'] },
      status: 'ANGELEGT',
    },
  });
  return andere === 0;
}

export async function erledigeFolge(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  const n = await brauchtKanzlei();
  const p = z.object({ id: z.string().min(1) }).safeParse(Object.fromEntries(fd));
  if (!p.success) return { fehler: PRUEFEN };
  const f = await ladeFolge(p.data.id);
  if (!f) return { fehler: 'Folge nicht gefunden.' };
  const e = f.ereignis;
  if (!kannBearbeiten(n, e.programm.mandant) && n.id !== f.zustaendig)
    return { fehler: KEIN_RECHT };
  if (e.status === 'ERLEDIGT' || e.status === 'VERWORFEN') return { fehler: ABGESCHLOSSEN };
  if (f.status !== 'ANGELEGT') return { fehler: 'Nur angelegte Folgen können erledigt werden.' };
  if (f.art === 'KONTROLLE_AUSSERPLANMAESSIG' && f.objektId) {
    const d = await prisma.durchfuehrung.findUnique({ where: { id: f.objektId } });
    if (!d || !['OHNE_BEFUND', 'MIT_BEFUND', 'ENTFALLEN'].includes(d.status)) {
      return {
        fehler: 'Die außerplanmäßige Durchführung ist noch nicht abgeschlossen (gegengezeichnet).',
      };
    }
  }
  const risikoFrei =
    (f.art === 'RISIKO_NEU_BEWERTEN' || f.art === 'RISIKO_AKTIVIEREN') && f.objektId
      ? await markierungFrei(f.objektId, f.id)
      : false;
  await mitAudit(n, async (tx, zeitpunkt) => {
    await tx.ereignisFolge.update({
      where: { id: f.id },
      data: { status: 'ERLEDIGT', erledigtAm: zeitpunkt },
    });
    const protokoll: Protokoll[] = [
      {
        aktion: 'tcms.ereignis.folge_erledigt',
        objektTyp: 'EreignisFolge',
        objektId: f.id,
        programmId: e.programmId,
        detail: { ereignis: e.nummer, art: f.art, label: FOLGE_LABEL[f.art], ziel: f.ziel },
      },
    ];
    if (risikoFrei && f.objektId) {
      await tx.risiko.update({ where: { id: f.objektId }, data: { neuBewerten: false } });
      protokoll.push({
        aktion: 'tcms.risiko.neubewertung_erledigt',
        objektTyp: 'Risiko',
        objektId: f.objektId,
        programmId: e.programmId,
        detail: { code: f.ziel, anlass: `Ereignis ${e.nummer}` },
      });
    }
    return { wert: null, protokoll };
  });
  aktualisiereMandant(e.programm.mandantId);
  return { ok: 'Folge erledigt.' };
}

export async function verwerfeFolge(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  const n = await brauchtKanzlei();
  const p = z
    .object({ id: z.string().min(1), begruendung: z.string().trim().min(30).max(2000) })
    .safeParse(Object.fromEntries(fd));
  if (!p.success) return { fehler: 'Die Begründung muss mindestens 30 Zeichen lang sein.' };
  const f = await ladeFolge(p.data.id);
  if (!f) return { fehler: 'Folge nicht gefunden.' };
  const e = f.ereignis;
  if (!kannBearbeiten(n, e.programm.mandant)) return { fehler: KEIN_RECHT };
  if (e.status === 'ERLEDIGT' || e.status === 'VERWORFEN') return { fehler: ABGESCHLOSSEN };
  if (f.status !== 'VORGESCHLAGEN' && f.status !== 'ANGELEGT')
    return { fehler: 'Die Folge ist bereits erledigt oder verworfen.' };
  if (f.art === 'FESTSTELLUNG_ANLEGEN' && f.objektId)
    return { fehler: 'Die Feststellung ist angelegt; sie wird in S10 bearbeitet oder verworfen.' };
  const risikoFrei =
    f.status === 'ANGELEGT' &&
    (f.art === 'RISIKO_NEU_BEWERTEN' || f.art === 'RISIKO_AKTIVIEREN') &&
    f.objektId
      ? await markierungFrei(f.objektId, f.id)
      : false;
  await mitAudit(n, async (tx, zeitpunkt) => {
    const t = triageStart(n, e, zeitpunkt);
    const protokoll: Protokoll[] = [];
    if (t.data) {
      await tx.ereignis.update({ where: { id: e.id }, data: t.data });
      protokoll.push(t.protokoll!);
    }
    await tx.ereignisFolge.update({ where: { id: f.id }, data: { status: 'VERWORFEN' } });
    protokoll.push({
      aktion: 'tcms.ereignis.folge_verworfen',
      objektTyp: 'EreignisFolge',
      objektId: f.id,
      programmId: e.programmId,
      detail: {
        ereignis: e.nummer,
        art: f.art,
        label: FOLGE_LABEL[f.art],
        ziel: f.ziel,
        vorher: f.status,
        begruendung: p.data.begruendung,
      },
    });
    if (risikoFrei && f.objektId) {
      await tx.risiko.update({ where: { id: f.objektId }, data: { neuBewerten: false } });
      protokoll.push({
        aktion: 'tcms.risiko.neubewertung_erledigt',
        objektTyp: 'Risiko',
        objektId: f.objektId,
        programmId: e.programmId,
        detail: { code: f.ziel, anlass: `Folge verworfen (Ereignis ${e.nummer})` },
      });
    }
    return { wert: null, protokoll };
  });
  aktualisiereMandant(e.programm.mandantId);
  return { ok: 'Folge begründet verworfen.' };
}

// ----------------------------------------------------------------------------
// Ereignis abschließen / verwerfen
// ----------------------------------------------------------------------------

export async function schliesseEreignisAb(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  const n = await brauchtKanzlei();
  const p = z.object({ id: z.string().min(1) }).safeParse(Object.fromEntries(fd));
  if (!p.success) return { fehler: PRUEFEN };
  const v = await vorpruefung(n, p.data.id);
  if ('fehler' in v) return v;
  const { e } = v;
  if (!ereignisErledigt(e.folgen))
    return {
      fehler: 'Noch nicht möglich: jede Folge muss erledigt oder begründet verworfen sein.',
    };
  // Ohne erledigte Folge wäre das Abschließen ein Verwerfen des Ereignisses – das braucht eine zweite Person.
  if (!e.folgen.some((f) => f.status === 'ERLEDIGT')) {
    return {
      fehler:
        'Keine Folge ist erledigt. Bitte „Ereignis verwerfen“ verwenden – das bestätigt eine zweite Person.',
    };
  }
  await mitAudit(n, async (tx, zeitpunkt) => {
    await tx.ereignis.update({
      where: { id: e.id },
      data: {
        status: 'ERLEDIGT',
        verwerfenBegruendung: null,
        ...(e.triagiertVon ? {} : { triagiertVon: n.id, triagiertAm: zeitpunkt }),
      },
    });
    return {
      wert: null,
      protokoll: {
        aktion: 'tcms.ereignis.abgeschlossen',
        objektTyp: 'Ereignis',
        objektId: e.id,
        programmId: e.programmId,
        detail: { nummer: e.nummer, folgen: e.folgen.length },
      },
    };
  });
  aktualisiereMandant(e.programm.mandantId);
  return { ok: `Ereignis ${e.nummer} erledigt.` };
}

export async function beantrageEreignisVerwerfen(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  const n = await brauchtKanzlei();
  const p = z
    .object({ id: z.string().min(1), begruendung: z.string().trim().min(30).max(2000) })
    .safeParse(Object.fromEntries(fd));
  if (!p.success) return { fehler: 'Die Begründung muss mindestens 30 Zeichen lang sein.' };
  const v = await vorpruefung(n, p.data.id);
  if ('fehler' in v) return v;
  const { e } = v;
  if (e.verwerfenBegruendung) return { fehler: 'Das Verwerfen ist bereits beantragt.' };
  if (e.folgen.some((f) => f.status === 'ANGELEGT' || f.status === 'ERLEDIGT')) {
    return {
      fehler:
        'Es sind bereits Folgen angelegt. Diese einzeln erledigen oder verwerfen und das Ereignis dann abschließen.',
    };
  }
  await mitAudit(n, async (tx) => {
    await tx.ereignis.update({
      where: { id: e.id },
      data: { verwerfenBegruendung: p.data.begruendung },
    });
    return {
      wert: null,
      protokoll: {
        aktion: 'tcms.ereignis.verwerfen_beantragt',
        objektTyp: 'Ereignis',
        objektId: e.id,
        programmId: e.programmId,
        detail: { nummer: e.nummer, begruendung: p.data.begruendung },
      },
    };
  });
  aktualisiereMandant(e.programm.mandantId);
  return { ok: 'Verwerfen beantragt. Eine zweite Person muss bestätigen.' };
}

async function antragsteller(ereignisId: string): Promise<string | null> {
  const a = await prisma.auditEvent.findFirst({
    where: {
      objektTyp: 'Ereignis',
      objektId: ereignisId,
      aktion: 'tcms.ereignis.verwerfen_beantragt',
    },
    orderBy: { seq: 'desc' },
  });
  return a?.actorId ?? null;
}

export async function bestaetigeEreignisVerwerfen(
  _prev: Ergebnis,
  fd: FormData,
): Promise<Ergebnis> {
  const n = await brauchtKanzlei();
  const p = z.object({ id: z.string().min(1) }).safeParse(Object.fromEntries(fd));
  if (!p.success) return { fehler: PRUEFEN };
  const v = await vorpruefung(n, p.data.id);
  if ('fehler' in v) return v;
  const { e } = v;
  if (!e.verwerfenBegruendung) return { fehler: 'Es liegt kein offener Antrag auf Verwerfen vor.' };
  const von = await antragsteller(e.id);
  if (!zweitePerson(n, von))
    return { fehler: 'Die Bestätigung muss durch eine zweite Person erfolgen.' };
  const offene = e.folgen.filter((f) => f.status === 'VORGESCHLAGEN');
  await mitAudit(n, async (tx, zeitpunkt) => {
    await tx.ereignisFolge.updateMany({
      where: { id: { in: offene.map((f) => f.id) } },
      data: { status: 'VERWORFEN' },
    });
    await tx.ereignis.update({
      where: { id: e.id },
      data: {
        status: 'VERWORFEN',
        ...(e.triagiertVon ? {} : { triagiertVon: n.id, triagiertAm: zeitpunkt }),
      },
    });
    return {
      wert: null,
      protokoll: {
        aktion: 'tcms.ereignis.verwerfen_bestaetigt',
        objektTyp: 'Ereignis',
        objektId: e.id,
        programmId: e.programmId,
        detail: { nummer: e.nummer, beantragtVon: von, folgenVerworfen: offene.length },
      },
    };
  });
  aktualisiereMandant(e.programm.mandantId);
  return { ok: `Ereignis ${e.nummer} verworfen.` };
}

export async function lehneEreignisVerwerfenAb(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  const n = await brauchtKanzlei();
  const p = z.object({ id: z.string().min(1) }).safeParse(Object.fromEntries(fd));
  if (!p.success) return { fehler: PRUEFEN };
  const v = await vorpruefung(n, p.data.id);
  if ('fehler' in v) return v;
  const { e } = v;
  if (!e.verwerfenBegruendung) return { fehler: 'Es liegt kein offener Antrag auf Verwerfen vor.' };
  const von = await antragsteller(e.id);
  await mitAudit(n, async (tx) => {
    await tx.ereignis.update({ where: { id: e.id }, data: { verwerfenBegruendung: null } });
    return {
      wert: null,
      protokoll: {
        aktion: 'tcms.ereignis.verwerfen_abgelehnt',
        objektTyp: 'Ereignis',
        objektId: e.id,
        programmId: e.programmId,
        detail: {
          nummer: e.nummer,
          beantragtVon: von,
          begruendung: e.verwerfenBegruendung,
          zurueckgezogen: von === n.id,
        },
      },
    };
  });
  aktualisiereMandant(e.programm.mandantId);
  return { ok: von === n.id ? 'Antrag zurückgezogen.' : 'Antrag auf Verwerfen abgelehnt.' };
}

// ----------------------------------------------------------------------------
// Ereignis manuell erfassen (Kanzlei)
// ----------------------------------------------------------------------------

const ErfassenSchema = z.object({
  programmId: z.string().min(1),
  typ: z.string().refine((t) => EREIGNISTYPEN.some((x) => x.code === t)),
  quelle: z.enum(['MANUELL', 'KONTROLLE', 'STAMMDATEN', 'RSS']),
  titel: z.string().trim().min(5).max(200),
  beschreibung: z.string().trim().min(10).max(4000),
  datum,
});

export async function erfasseEreignis(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  const n = await brauchtKanzlei();
  const p = ErfassenSchema.safeParse(Object.fromEntries(fd));
  if (!p.success)
    return {
      fehler:
        'Bitte Typ, Quelle, Titel (mind. 5 Zeichen), Beschreibung (mind. 10 Zeichen) und Datum angeben.',
    };
  const programm = await prisma.tcmsProgramm.findUnique({
    where: { id: p.data.programmId },
    include: { mandant: true },
  });
  if (!programm) return { fehler: 'Programm nicht gefunden.' };
  if (!kannBearbeiten(n, programm.mandant)) return { fehler: KEIN_RECHT };
  const res = await mitAudit(n, async (tx, zeitpunkt) => {
    const e = await legeEreignisAn(tx, {
      programmId: programm.id,
      typ: p.data.typ,
      titel: p.data.titel,
      beschreibung: p.data.beschreibung,
      quelle: p.data.quelle,
      gemeldetVon: n.id,
      ereignisDatum: p.data.datum,
      zeitpunkt,
    });
    return {
      wert: e,
      protokoll: {
        aktion: 'tcms.ereignis.erfasst',
        objektTyp: 'Ereignis',
        objektId: e.id,
        programmId: programm.id,
        detail: { nummer: e.nummer, typ: p.data.typ, quelle: p.data.quelle, folgen: e.folgen },
      },
    };
  });
  aktualisiereMandant(programm.mandantId);
  return { ok: `Ereignis ${res.nummer} erfasst – ${res.folgen} Folgen vorgeschlagen.` };
}
