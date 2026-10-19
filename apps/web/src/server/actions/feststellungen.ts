'use server';

import { z } from 'zod';
import {
  FESTSTELLUNG_STATUS_LABEL,
  isoDatum,
  naechsterFeststellungsschritt,
  p153Erforderlich,
  P153_LABEL,
  type FeststellungStatus,
} from '@tcms/domain';
import { db, personImMandat, type KanzleiAkteur } from '../demo';
import {
  aktualisiereMandant,
  KEIN_RECHT,
  mitAudit,
  NUR_BERUFSTRAEGER,
  type Protokoll,
} from '../aktion';
import type { Ergebnis } from '../ergebnis';
import {
  istBeteiligt,
  legeAusserplanmaessigeDurchfuehrungAn,
  naechsteFeststellungsnummer,
  naechsteWiedervorlageNr,
  p153Abschliessend,
} from '../feststellungen-daten';
import {
  auswirkungBeimAnlegen,
  kannBearbeiten,
  kannWuerdigen,
  mitBezug,
  zweitePerson,
} from '../berechtigung';
import { brauchtKanzlei } from '../sitzung';
import { heute, jetzt } from '../zeit';

// =============================================================================
// Server Actions S10 – Feststellungen und Maßnahmen. Jede Änderung läuft über
// mitAudit; Rechte werden hier geprüft, nie nur im UI.
// =============================================================================

const PRUEFEN = 'Bitte die Eingaben prüfen.';
const VERTRAULICH = 'Diese Feststellung ist vertraulich und nur für Beteiligte zugänglich.';
const ABGESCHLOSSEN =
  'Die Feststellung ist geschlossen oder verworfen und kann nicht mehr geändert werden.';

const datum = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .transform((v) => new Date(`${v}T00:00:00Z`))
  .refine((d) => !Number.isNaN(d.getTime()));

async function ladeFeststellung(id: string) {
  return db.feststellung.findUnique({
    where: { id },
    include: { programm: { include: { mandant: true } }, massnahmen: true, nachkontrolle: true },
  });
}
type Geladen = NonNullable<Awaited<ReturnType<typeof ladeFeststellung>>>;

function beteiligt(n: KanzleiAkteur, f: Geladen): boolean {
  return istBeteiligt(
    mitBezug(n, f.programm.mandantId),
    {
      erfasstVon: f.erfasstVon,
      p153EntschiedenVon: f.p153EntschiedenVon,
      verwerfenBeantragtVon: f.verwerfenBeantragtVon,
      massnahmenVerantwortlich: f.massnahmen.map((m) => m.verantwortlich),
    },
    f.programm.mandantId,
  );
}

/** Gemeinsame Vorprüfung: Objekt vorhanden, Bearbeitungsrecht, Vertraulichkeit, nicht abgeschlossen. */
async function vorpruefung(
  n: KanzleiAkteur,
  id: string,
  opt: { offen?: boolean } = { offen: true },
): Promise<{ f: Geladen } | { fehler: string }> {
  const f = await ladeFeststellung(id);
  if (!f) return { fehler: 'Feststellung nicht gefunden.' };
  if (!kannBearbeiten(n, f.programm.mandant)) return { fehler: KEIN_RECHT };
  if (f.vertraulich && !beteiligt(n, f)) return { fehler: VERTRAULICH };
  if (opt.offen !== false && (f.status === 'GESCHLOSSEN' || f.status === 'VERWORFEN'))
    return { fehler: ABGESCHLOSSEN };
  return { f };
}

function tagHeute(): Date {
  return heute();
}

// ----------------------------------------------------------------------------
// Status weiterschalten
// ----------------------------------------------------------------------------

export async function schalteFeststellungWeiter(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  const n = await brauchtKanzlei();
  const p = z.object({ id: z.string().min(1) }).safeParse(Object.fromEntries(fd));
  if (!p.success) return { fehler: PRUEFEN };
  const v = await vorpruefung(n, p.data.id);
  if ('fehler' in v) return v;
  const { f } = v;
  const schritt = naechsterFeststellungsschritt({
    status: f.status,
    auswirkung: f.auswirkung,
    p153Entschieden: p153Abschliessend(f.p153Entscheidung),
    massnahmen: f.massnahmen.length,
    massnahmenOffen: f.massnahmen.filter((m) => m.status === 'OFFEN').length,
    nachkontrolleOhneBefund:
      f.nachkontrolle?.status === 'OHNE_BEFUND' && !!f.nachkontrolle.gegengezeichnetVon,
  });
  if (!schritt.ziel) return { fehler: 'Für diesen Status gibt es keinen weiteren Schritt.' };
  if (schritt.blockiert) return { fehler: `Noch nicht möglich: ${schritt.blockiert}.` };
  const ziel = schritt.ziel;
  await mitAudit(n, async (tx, zeitpunkt) => {
    await tx.feststellung.update({
      where: { id: f.id },
      data: { status: ziel, ...(ziel === 'GESCHLOSSEN' ? { geschlossenAm: zeitpunkt } : {}) },
    });
    return {
      wert: null,
      protokoll: {
        aktion: 'tcms.feststellung.status',
        objektTyp: 'Feststellung',
        objektId: f.id,
        programmId: f.programmId,
        detail: { nummer: f.nummer, von: f.status, nach: ziel },
      },
    };
  });
  aktualisiereMandant(f.programm.mandantId);
  return { ok: `Status: ${FESTSTELLUNG_STATUS_LABEL[ziel]}.` };
}

// ----------------------------------------------------------------------------
// §-153-Würdigung (nur Berufsträger, höchstpersönlich)
// ----------------------------------------------------------------------------

const P153Schema = z.object({
  id: z.string().min(1),
  entscheidung: z.enum(['BERICHTIGUNG', 'KEINE_PFLICHT', 'WEITERE_KLAERUNG', 'UEBERGABE']),
  begruendung: z.string().trim().min(30),
  frist: z.string().optional(),
});

export async function entscheideP153(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  const n = await brauchtKanzlei();
  const roh = Object.fromEntries(fd);
  if (!roh['entscheidung']) return { fehler: 'Bitte eine der vier Optionen wählen.' };
  const p = P153Schema.safeParse(roh);
  if (!p.success)
    return {
      fehler: 'Bitte eine Option wählen und die Entscheidung begründen (mindestens 30 Zeichen).',
    };
  const f = await ladeFeststellung(p.data.id);
  if (!f) return { fehler: 'Feststellung nicht gefunden.' };
  // Höchstpersönlich: ausschließlich zuständige Berufsträger:innen (serverseitig).
  if (!kannWuerdigen(n, f.programm.mandant)) return { fehler: NUR_BERUFSTRAEGER };
  if (f.vertraulich && !beteiligt(n, f)) return { fehler: VERTRAULICH };
  if (f.status === 'GESCHLOSSEN' || f.status === 'VERWORFEN') return { fehler: ABGESCHLOSSEN };
  if (!p153Erforderlich(f.auswirkung))
    return { fehler: 'Ohne steuerliche Auswirkung („nein") gibt es keinen §-153-Pfad.' };
  if (p153Abschliessend(f.p153Entscheidung))
    return { fehler: 'Die §-153-Würdigung ist bereits dokumentiert.' };

  const { entscheidung, begruendung } = p.data;
  const braucheFrist = entscheidung === 'BERICHTIGUNG' || entscheidung === 'WEITERE_KLAERUNG';
  let frist: Date | null = null;
  if (p.data.frist) {
    const d = datum.safeParse(p.data.frist);
    if (!d.success) return { fehler: 'Das Fristdatum ist ungültig.' };
    frist = d.data;
  }
  if (braucheFrist && !frist) {
    return {
      fehler:
        entscheidung === 'BERICHTIGUNG'
          ? 'Bitte eine Frist für die Berichtigung setzen.'
          : 'Bitte das Datum setzen, bis zu dem geklärt wird.',
    };
  }
  if (frist && frist.getTime() < tagHeute().getTime())
    return { fehler: 'Die Frist darf nicht in der Vergangenheit liegen.' };
  if (!braucheFrist) frist = null;

  const wv = await mitAudit(n, async (tx, zeitpunkt) => {
    await tx.feststellung.update({
      where: { id: f.id },
      data: {
        p153Entscheidung: entscheidung,
        p153Begruendung: begruendung,
        p153Frist: frist,
        p153EntschiedenVon: n.id,
        p153EntschiedenAm: zeitpunkt,
        ...(f.status === 'ERFASST' ? { status: 'IN_WUERDIGUNG' as const } : {}),
      },
    });
    const protokoll: Protokoll[] = [
      {
        aktion: 'tcms.feststellung.p153_entschieden',
        objektTyp: 'Feststellung',
        objektId: f.id,
        programmId: f.programmId,
        detail: {
          nummer: f.nummer,
          entscheidung,
          frist: frist ? isoDatum(frist) : null,
          vorher: f.p153Entscheidung,
        },
      },
    ];
    if (f.status === 'ERFASST') {
      protokoll.push({
        aktion: 'tcms.feststellung.status',
        objektTyp: 'Feststellung',
        objektId: f.id,
        programmId: f.programmId,
        detail: { nummer: f.nummer, von: 'ERFASST', nach: 'IN_WUERDIGUNG' },
      });
    }
    // Wiedervorlage mit der vom Berufsträger gesetzten Frist (Fachkonzept §9, §-153-Pfad Schritt 3).
    let nr: number | null = null;
    if (frist) {
      nr = await naechsteWiedervorlageNr(tx);
      const beschreibung =
        entscheidung === 'BERICHTIGUNG'
          ? 'Berichtigung veranlassen und Nachweis ablegen (Übermittlungsprotokoll, Bescheid)'
          : 'Sachverhalt klären und §-153-Würdigung erneut vornehmen';
      const m = await tx.massnahme.create({
        data: {
          feststellungId: f.id,
          wiedervorlageNr: nr,
          beschreibung,
          verantwortlich: n.id,
          frist,
          createdAt: zeitpunkt,
        },
      });
      protokoll.push({
        aktion: 'tcms.massnahme.angelegt',
        objektTyp: 'Massnahme',
        objektId: m.id,
        programmId: f.programmId,
        detail: { nummer: f.nummer, wiedervorlageNr: nr, beschreibung, frist: isoDatum(frist) },
      });
    }
    return { wert: nr, protokoll };
  });
  aktualisiereMandant(f.programm.mandantId);
  return {
    ok: `Entscheidung dokumentiert: ${P153_LABEL[entscheidung].replace(' bis …', '')}${wv ? ` · Wiedervorlage #${wv}` : ''}.`,
  };
}

// ----------------------------------------------------------------------------
// Würdigungsangaben und betroffene Erklärungen
// ----------------------------------------------------------------------------

const WuerdigungSchema = z.object({
  id: z.string().min(1),
  schwere: z.enum(['GERING', 'MITTEL', 'HOCH', 'KRITISCH']),
  auswirkung: z.enum(['JA', 'NEIN', 'UNKLAR']),
  ursache: z.string().trim().max(2000).optional(),
});

export async function aktualisiereWuerdigung(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  const n = await brauchtKanzlei();
  const p = WuerdigungSchema.safeParse(Object.fromEntries(fd));
  if (!p.success) return { fehler: PRUEFEN };
  const v = await vorpruefung(n, p.data.id);
  if ('fehler' in v) return v;
  const { f } = v;
  if (f.status !== 'ERFASST' && f.status !== 'IN_WUERDIGUNG')
    return { fehler: 'Schwere und Auswirkung sind nur bis zum Ende der Würdigung änderbar.' };
  if (f.p153Entscheidung && p.data.auswirkung !== f.auswirkung)
    return {
      fehler:
        'Nach dokumentierter §-153-Würdigung ist die steuerliche Auswirkung nicht mehr änderbar.',
    };
  // Herabstufen auf „keine Auswirkung“ beendet den §-153-Pfad – das ist faktisch eine
  // Würdigungsentscheidung und bleibt Berufsträger:innen vorbehalten (AGENTS.md Regel 5).
  if (
    (f.auswirkung === 'JA' || f.auswirkung === 'UNKLAR') &&
    p.data.auswirkung === 'NEIN' &&
    !kannWuerdigen(n, f.programm.mandant)
  ) {
    return {
      fehler: `${NUR_BERUFSTRAEGER} Die steuerliche Auswirkung auf „nein“ zu setzen beendet die §-153-Würdigung.`,
    };
  }
  const { schwere, auswirkung } = p.data;
  const ursache = p.data.ursache || null;
  await mitAudit(n, async (tx) => {
    await tx.feststellung.update({ where: { id: f.id }, data: { schwere, auswirkung, ursache } });
    return {
      wert: null,
      protokoll: {
        aktion: 'tcms.feststellung.wuerdigung',
        objektTyp: 'Feststellung',
        objektId: f.id,
        programmId: f.programmId,
        detail: {
          nummer: f.nummer,
          vorher: { schwere: f.schwere, auswirkung: f.auswirkung, ursache: f.ursache },
          nachher: { schwere, auswirkung, ursache },
        },
      },
    };
  });
  aktualisiereMandant(f.programm.mandantId);
  return { ok: 'Würdigungsangaben gespeichert.' };
}

const ErklaerungSchema = z.object({
  feststellungId: z.string().min(1),
  steuerart: z.string().trim().min(2).max(120),
  land: z.string().trim().min(2).max(40),
  zeitraum: z.string().trim().min(2).max(40),
  auswirkungEur: z.string().trim().optional(),
});

export async function fuegeErklaerungHinzu(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  const n = await brauchtKanzlei();
  const p = ErklaerungSchema.safeParse(Object.fromEntries(fd));
  if (!p.success) return { fehler: 'Bitte Steuerart, Land und Zeitraum angeben.' };
  const v = await vorpruefung(n, p.data.feststellungId);
  if ('fehler' in v) return v;
  const { f } = v;
  let betrag: number | null = null;
  if (p.data.auswirkungEur) {
    const zahl = Number(p.data.auswirkungEur.replace(/\./g, '').replace(',', '.'));
    if (!Number.isFinite(zahl)) return { fehler: 'Die geschätzte Auswirkung ist keine Zahl.' };
    betrag = Math.round(zahl * 100) / 100;
  }
  const { steuerart, land, zeitraum } = p.data;
  await mitAudit(n, async (tx) => {
    const e = await tx.betroffeneErklaerung.create({
      data: {
        feststellungId: f.id,
        steuerart,
        land: land.toUpperCase(),
        zeitraum,
        auswirkungEur: betrag,
      },
    });
    return {
      wert: null,
      protokoll: {
        aktion: 'tcms.feststellung.erklaerung',
        objektTyp: 'Feststellung',
        objektId: f.id,
        programmId: f.programmId,
        detail: {
          nummer: f.nummer,
          erklaerungId: e.id,
          steuerart,
          land: land.toUpperCase(),
          zeitraum,
          auswirkungEur: betrag,
        },
      },
    };
  });
  aktualisiereMandant(f.programm.mandantId);
  return { ok: 'Betroffene Erklärung erfasst.' };
}

// ----------------------------------------------------------------------------
// Maßnahmen
// ----------------------------------------------------------------------------

const MassnahmeSchema = z.object({
  feststellungId: z.string().min(1),
  beschreibung: z.string().trim().min(5).max(500),
  verantwortlich: z.string().min(1),
  frist: datum,
});

export async function legeMassnahmeAn(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  const n = await brauchtKanzlei();
  const p = MassnahmeSchema.safeParse(Object.fromEntries(fd));
  if (!p.success)
    return {
      fehler: 'Bitte Beschreibung (mindestens 5 Zeichen), Verantwortliche:n und Frist angeben.',
    };
  const v = await vorpruefung(n, p.data.feststellungId);
  if ('fehler' in v) return v;
  const { f } = v;
  if (p.data.frist.getTime() < tagHeute().getTime())
    return { fehler: 'Die Frist darf nicht in der Vergangenheit liegen.' };
  const person = await personImMandat(p.data.verantwortlich, f.programm.mandantId);
  if (!person)
    return { fehler: 'Die verantwortliche Person ist für diesen Mandanten nicht zulässig.' };
  const { beschreibung, verantwortlich, frist } = p.data;
  const nr = await mitAudit(n, async (tx, zeitpunkt) => {
    const wv = await naechsteWiedervorlageNr(tx);
    const m = await tx.massnahme.create({
      data: {
        feststellungId: f.id,
        wiedervorlageNr: wv,
        beschreibung,
        verantwortlich,
        frist,
        createdAt: zeitpunkt,
      },
    });
    const protokoll: Protokoll[] = [
      {
        aktion: 'tcms.massnahme.angelegt',
        objektTyp: 'Massnahme',
        objektId: m.id,
        programmId: f.programmId,
        detail: {
          nummer: f.nummer,
          wiedervorlageNr: wv,
          beschreibung,
          verantwortlich: person.name,
          frist: isoDatum(frist),
        },
      },
    ];
    // Neue offene Maßnahme während der Nachkontrolle: zurück auf „Maßnahmen offen".
    if (f.status === 'NACHKONTROLLE') {
      await tx.feststellung.update({ where: { id: f.id }, data: { status: 'MASSNAHMEN_OFFEN' } });
      protokoll.push({
        aktion: 'tcms.feststellung.status',
        objektTyp: 'Feststellung',
        objektId: f.id,
        programmId: f.programmId,
        detail: {
          nummer: f.nummer,
          von: 'NACHKONTROLLE',
          nach: 'MASSNAHMEN_OFFEN',
          grund: `neue Maßnahme #${wv}`,
        },
      });
    }
    return { wert: wv, protokoll };
  });
  aktualisiereMandant(f.programm.mandantId);
  return { ok: `Maßnahme angelegt · Wiedervorlage #${nr}.` };
}

const ErledigenSchema = z.object({
  id: z.string().min(1),
  nachweis: z.string().trim().min(10).max(2000),
});

export async function erledigeMassnahme(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  const n = await brauchtKanzlei();
  const p = ErledigenSchema.safeParse(Object.fromEntries(fd));
  if (!p.success)
    return { fehler: 'Bitte den Nachweis der Umsetzung beschreiben (mindestens 10 Zeichen).' };
  const m = await db.massnahme.findUnique({ where: { id: p.data.id } });
  if (!m) return { fehler: 'Maßnahme nicht gefunden.' };
  const f = await ladeFeststellung(m.feststellungId);
  if (!f) return { fehler: 'Feststellung nicht gefunden.' };
  const darf = kannBearbeiten(n, f.programm.mandant) || n.id === m.verantwortlich;
  if (!darf) return { fehler: KEIN_RECHT };
  if (f.vertraulich && !beteiligt(n, f)) return { fehler: VERTRAULICH };
  if (f.status === 'GESCHLOSSEN' || f.status === 'VERWORFEN') return { fehler: ABGESCHLOSSEN };
  if (m.status === 'ERLEDIGT') return { fehler: 'Die Maßnahme ist bereits erledigt.' };
  await mitAudit(n, async (tx, zeitpunkt) => {
    await tx.massnahme.update({
      where: { id: m.id },
      data: { status: 'ERLEDIGT', erledigtAm: zeitpunkt, erledigtVon: n.id },
    });
    return {
      wert: null,
      protokoll: {
        aktion: 'tcms.massnahme.erledigt',
        objektTyp: 'Massnahme',
        objektId: m.id,
        programmId: f.programmId,
        detail: { nummer: f.nummer, wiedervorlageNr: m.wiedervorlageNr, nachweis: p.data.nachweis },
      },
    };
  });
  aktualisiereMandant(f.programm.mandantId);
  return { ok: `Maßnahme #${m.wiedervorlageNr} erledigt.` };
}

// ----------------------------------------------------------------------------
// Nachkontrolle: außerplanmäßige Durchführung anlegen und verknüpfen
// ----------------------------------------------------------------------------

const NachkontrolleSchema = z.object({
  feststellungId: z.string().min(1),
  kontrolleId: z.string().min(1),
  faelligAm: datum,
});

export async function legeNachkontrolleAn(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  const n = await brauchtKanzlei();
  const p = NachkontrolleSchema.safeParse(Object.fromEntries(fd));
  if (!p.success) return { fehler: 'Bitte Kontrolle und Fälligkeit wählen.' };
  const v = await vorpruefung(n, p.data.feststellungId);
  if ('fehler' in v) return v;
  const { f } = v;
  if (f.status !== 'MASSNAHMEN_OFFEN' && f.status !== 'NACHKONTROLLE')
    return { fehler: 'Eine Nachkontrolle ist ab dem Status „Maßnahmen offen" möglich.' };
  const nk = f.nachkontrolle;
  if (nk && nk.status !== 'MIT_BEFUND' && nk.status !== 'ENTFALLEN')
    return { fehler: 'Es ist bereits eine Nachkontrolle verknüpft.' };
  if (p.data.faelligAm.getTime() < tagHeute().getTime())
    return { fehler: 'Die Fälligkeit darf nicht in der Vergangenheit liegen.' };
  const k = await db.kontrolle.findFirst({
    where: { id: p.data.kontrolleId, programmId: f.programmId },
  });
  if (!k || (k.entfallenAb && k.entfallenAb.getTime() <= jetzt().getTime()))
    return { fehler: 'Die Kontrolle ist im Programm nicht aktiv.' };
  const res = await mitAudit(n, async (tx, zeitpunkt) => {
    const d = await legeAusserplanmaessigeDurchfuehrungAn(tx, {
      kontrolleId: k.id,
      faelligAm: p.data.faelligAm,
      anlass: `Nachkontrolle ${f.nummer}`,
      label: `außerplanmäßig (Nachkontrolle ${f.nummer})`,
      zeitpunkt,
    });
    await tx.feststellung.update({ where: { id: f.id }, data: { nachkontrolleId: d.id } });
    return {
      wert: d,
      protokoll: [
        {
          aktion: 'tcms.feststellung.nachkontrolle',
          objektTyp: 'Feststellung',
          objektId: f.id,
          programmId: f.programmId,
          detail: {
            nummer: f.nummer,
            durchfuehrungId: d.id,
            kontrolle: d.code,
            faelligAm: isoDatum(p.data.faelligAm),
          },
        },
        {
          aktion: 'tcms.durchfuehrung.ausserplanmaessig',
          objektTyp: 'Durchfuehrung',
          objektId: d.id,
          programmId: f.programmId,
          detail: {
            kontrolle: d.code,
            anlass: `Nachkontrolle ${f.nummer}`,
            faelligAm: isoDatum(p.data.faelligAm),
          },
        },
      ],
    };
  });
  aktualisiereMandant(f.programm.mandantId);
  return { ok: `Nachkontrolle ${res.code} angelegt und verknüpft.` };
}

// ----------------------------------------------------------------------------
// Verwerfen (Begründung ≥ 30, Bestätigung durch zweite Person)
// ----------------------------------------------------------------------------

export async function beantrageVerwerfen(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  const n = await brauchtKanzlei();
  const p = z
    .object({ id: z.string().min(1), begruendung: z.string().trim().min(30).max(2000) })
    .safeParse(Object.fromEntries(fd));
  if (!p.success) return { fehler: 'Die Begründung muss mindestens 30 Zeichen lang sein.' };
  const v = await vorpruefung(n, p.data.id);
  if ('fehler' in v) return v;
  const { f } = v;
  if (f.verwerfenBeantragtVon && !f.verwerfenBestaetigtVon)
    return { fehler: 'Das Verwerfen ist bereits beantragt.' };
  await mitAudit(n, async (tx) => {
    await tx.feststellung.update({
      where: { id: f.id },
      data: {
        verwerfenBegruendung: p.data.begruendung,
        verwerfenBeantragtVon: n.id,
        verwerfenBestaetigtVon: null,
      },
    });
    return {
      wert: null,
      protokoll: {
        aktion: 'tcms.feststellung.verwerfen_beantragt',
        objektTyp: 'Feststellung',
        objektId: f.id,
        programmId: f.programmId,
        detail: { nummer: f.nummer, begruendung: p.data.begruendung },
      },
    };
  });
  aktualisiereMandant(f.programm.mandantId);
  return { ok: 'Verwerfen beantragt. Eine zweite Person muss bestätigen.' };
}

export async function bestaetigeVerwerfen(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  const n = await brauchtKanzlei();
  const p = z.object({ id: z.string().min(1) }).safeParse(Object.fromEntries(fd));
  if (!p.success) return { fehler: PRUEFEN };
  const v = await vorpruefung(n, p.data.id);
  if ('fehler' in v) return v;
  const { f } = v;
  if (!f.verwerfenBeantragtVon || f.verwerfenBestaetigtVon)
    return { fehler: 'Es liegt kein offener Antrag auf Verwerfen vor.' };
  if (!zweitePerson(n, f.verwerfenBeantragtVon))
    return { fehler: 'Die Bestätigung muss durch eine zweite Person erfolgen.' };
  const von = f.status as FeststellungStatus;
  await mitAudit(n, async (tx) => {
    await tx.feststellung.update({
      where: { id: f.id },
      data: { status: 'VERWORFEN', verwerfenBestaetigtVon: n.id },
    });
    return {
      wert: null,
      protokoll: {
        aktion: 'tcms.feststellung.verwerfen_bestaetigt',
        objektTyp: 'Feststellung',
        objektId: f.id,
        programmId: f.programmId,
        detail: { nummer: f.nummer, von, nach: 'VERWORFEN', beantragtVon: f.verwerfenBeantragtVon },
      },
    };
  });
  aktualisiereMandant(f.programm.mandantId);
  return { ok: 'Feststellung verworfen.' };
}

export async function lehneVerwerfenAb(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  const n = await brauchtKanzlei();
  const p = z.object({ id: z.string().min(1) }).safeParse(Object.fromEntries(fd));
  if (!p.success) return { fehler: PRUEFEN };
  const v = await vorpruefung(n, p.data.id);
  if ('fehler' in v) return v;
  const { f } = v;
  if (!f.verwerfenBeantragtVon || f.verwerfenBestaetigtVon)
    return { fehler: 'Es liegt kein offener Antrag auf Verwerfen vor.' };
  const zurueckgezogen = f.verwerfenBeantragtVon === n.id;
  await mitAudit(n, async (tx) => {
    await tx.feststellung.update({
      where: { id: f.id },
      data: { verwerfenBegruendung: null, verwerfenBeantragtVon: null },
    });
    return {
      wert: null,
      protokoll: {
        aktion: 'tcms.feststellung.verwerfen_abgelehnt',
        objektTyp: 'Feststellung',
        objektId: f.id,
        programmId: f.programmId,
        detail: {
          nummer: f.nummer,
          beantragtVon: f.verwerfenBeantragtVon,
          begruendung: f.verwerfenBegruendung,
          zurueckgezogen,
        },
      },
    };
  });
  aktualisiereMandant(f.programm.mandantId);
  return { ok: zurueckgezogen ? 'Antrag zurückgezogen.' : 'Antrag auf Verwerfen abgelehnt.' };
}

// ----------------------------------------------------------------------------
// Vertraulich (wie eine Subsumtion; nur Berufsträger)
// ----------------------------------------------------------------------------

export async function setzeVertraulich(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  const n = await brauchtKanzlei();
  const p = z
    .object({ id: z.string().min(1), wert: z.enum(['0', '1']) })
    .safeParse(Object.fromEntries(fd));
  if (!p.success) return { fehler: PRUEFEN };
  const f = await ladeFeststellung(p.data.id);
  if (!f) return { fehler: 'Feststellung nicht gefunden.' };
  if (!kannWuerdigen(n, f.programm.mandant)) return { fehler: NUR_BERUFSTRAEGER };
  if (f.vertraulich && !beteiligt(n, f)) return { fehler: VERTRAULICH };
  const wert = p.data.wert === '1';
  if (wert === f.vertraulich)
    return { ok: wert ? 'Bereits vertraulich.' : 'Bereits nicht vertraulich.' };
  await mitAudit(n, async (tx) => {
    await tx.feststellung.update({ where: { id: f.id }, data: { vertraulich: wert } });
    return {
      wert: null,
      protokoll: {
        aktion: 'tcms.feststellung.vertraulich',
        objektTyp: 'Feststellung',
        objektId: f.id,
        programmId: f.programmId,
        detail: { nummer: f.nummer, vertraulich: wert },
      },
    };
  });
  aktualisiereMandant(f.programm.mandantId);
  return {
    ok: wert
      ? 'Als vertraulich markiert – nur für Beteiligte sichtbar.'
      : 'Vertraulichkeit aufgehoben.',
  };
}

// ----------------------------------------------------------------------------
// Feststellung manuell erfassen
// ----------------------------------------------------------------------------

const ErfassenSchema = z.object({
  programmId: z.string().min(1),
  titel: z.string().trim().min(5).max(200),
  sachverhalt: z.string().trim().min(20).max(4000),
  quelle: z.enum(['KONTROLLE', 'EREIGNIS', 'STICHPROBE', 'HINWEIS', 'AUSSENPRUEFUNG']),
  quelleText: z.string().trim().min(2).max(200),
  durchfuehrungId: z.string().optional(),
  klasse: z.enum(['DESIGNMANGEL', 'DURCHFUEHRUNGSMANGEL', 'STEUERLICHER_FEHLER', 'HINWEIS']),
  schwere: z.enum(['GERING', 'MITTEL', 'HOCH', 'KRITISCH']),
  auswirkung: z.enum(['JA', 'NEIN', 'UNKLAR']),
});

export async function erfasseFeststellung(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  const n = await brauchtKanzlei();
  const roh = Object.fromEntries([...fd.entries()].filter(([k]) => k !== 'risiken'));
  const p = ErfassenSchema.safeParse(roh);
  if (!p.success)
    return {
      fehler:
        'Bitte Titel (mind. 5 Zeichen), Sachverhalt (mind. 20 Zeichen), Quelle und Einstufung angeben.',
    };
  const programm = await db.tcmsProgramm.findUnique({
    where: { id: p.data.programmId },
    include: { mandant: true },
  });
  if (!programm) return { fehler: 'Programm nicht gefunden.' };
  if (!kannBearbeiten(n, programm.mandant)) return { fehler: KEIN_RECHT };
  const risikoIds = fd.getAll('risiken').map(String).filter(Boolean);
  const risiken = risikoIds.length
    ? await db.risiko.findMany({
        where: { id: { in: risikoIds }, programmId: programm.id },
        select: { id: true },
      })
    : [];
  if (risiken.length !== risikoIds.length) return { fehler: 'Unbekanntes Risiko gewählt.' };
  let durchfuehrungId: string | null = null;
  if (p.data.quelle === 'KONTROLLE' && p.data.durchfuehrungId) {
    const d = await db.durchfuehrung.findFirst({
      where: { id: p.data.durchfuehrungId, kontrolle: { programmId: programm.id } },
    });
    if (!d) return { fehler: 'Die gewählte Durchführung gehört nicht zu diesem Mandanten.' };
    durchfuehrungId = d.id;
  }
  const { titel, sachverhalt, quelle, quelleText, klasse, schwere } = p.data;
  // TS-04: „keine Auswirkung" ist eine Würdigungsentscheidung (nur Berufsträger:innen).
  const auswirkung = auswirkungBeimAnlegen(n, programm.mandant, p.data.auswirkung);
  const herabgestuft = auswirkung !== p.data.auswirkung;
  const nummer = await mitAudit(n, async (tx, zeitpunkt) => {
    const nr = await naechsteFeststellungsnummer(tx, programm.id, zeitpunkt.getUTCFullYear());
    const f = await tx.feststellung.create({
      data: {
        programmId: programm.id,
        nummer: nr,
        titel,
        sachverhalt,
        quelle,
        quelleText,
        durchfuehrungId,
        klasse,
        schwere,
        auswirkung,
        status: 'ERFASST',
        erfasstVon: n.id,
        erfasstAm: zeitpunkt,
        risiken: { create: risiken.map((r) => ({ risikoId: r.id })) },
      },
    });
    return {
      wert: nr,
      protokoll: {
        aktion: 'tcms.feststellung.erfasst',
        objektTyp: 'Feststellung',
        objektId: f.id,
        programmId: programm.id,
        detail: {
          nummer: nr,
          quelle: quelleText,
          manuell: true,
          auswirkung,
          ...(herabgestuft ? { auswirkungAngegeben: p.data.auswirkung } : {}),
        },
      },
    };
  });
  aktualisiereMandant(programm.mandantId);
  return {
    ok: herabgestuft
      ? `Feststellung ${nummer} erfasst. Die steuerliche Auswirkung „nein“ stufen nur Berufsträger:innen ein; sie ist als „unklar“ zur Würdigung erfasst.`
      : `Feststellung ${nummer} erfasst.`,
  };
}
