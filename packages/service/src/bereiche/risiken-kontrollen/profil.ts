// =============================================================================
// Geschäftsprofil (Profil-Tab), bisher apps/web/src/server/actions/profil.ts
// und programm-aufbau.ts (`nimmRisikoAuf`): Profiländerung als neuer Stand mit
// Triggern (Fachkonzept §4, §7) und Aufnahme vorgeschlagener Risiken.
//
// TS-05: Beide Operationen sperren zuerst das Programm des Mandanten
// (SELECT … FOR UPDATE), dann betroffene Risiken und Kontrollen (Reihenfolge
// Programm → Risiken → Kontrollen → Durchführungen). Der offene Profilstand
// wird bedingt geschlossen; „ein offener Stand je Programm" und
// (programmId, version) sind eindeutig – eine Gabelung ist unmöglich.
// =============================================================================

import {
  DienstFehler,
  ProfilAendernSchema,
  RisikoAufnehmenSchema,
  type ProfilAendern,
  type ProfilGeaendert,
  type RisikoAufgenommen,
  type RisikoAufnehmen,
} from '@tcms/contract';
import type { Prisma, Tx } from '@tcms/db';
import {
  addTage,
  BEWERTUNGSMODELL_VERSION,
  brutto as berechneBrutto,
  ereignistyp,
  fmtDatum,
  katalogRisiko,
  kontrollenFuerRisiko,
  leiteFrequenzAb,
  perioden,
  PROFIL_FRAGEN,
  schlageRisikenVor,
  type Geschaeftsprofil,
  type KatalogKontrolle,
  type Periode,
  type RisikoFuerFrequenz,
  type Turnus,
} from '@tcms/domain';
import { mitAudit, type Protokoll } from '../../audit';
import { naechsteEreignisnummern } from '../../kern/nummern';
import { heuteDatum, tagAlsDatum } from '../../kern/zeit';
import type { DienstKontext } from '../../kontext';
import {
  kanonisch,
  konflikt,
  konfliktSicher,
  pruefeBearbeiten,
  pruefeEingabe,
  sperreDurchfuehrungen,
  sperreKontrollen,
  sperreProgramm,
  sperreRisiken,
} from './gemeinsam';
import { pruefeKanzleiPersonen } from './kontrollen';
import { loescheUnberuehrte } from './planung';
import {
  ereignisseFuerAenderung,
  gleichesProfil,
  leseProfil,
  neuZuBewerten,
  profilDiff,
  pruefeProfil,
  type FrageDiff,
} from './profil-regeln';

const TAG_MS = 86_400_000;

function titelFuer(d: FrageDiff | undefined, typ: string, stichwort?: string): string {
  const kat = ereignistyp(typ);
  if (!d) return kat?.titel ?? typ;
  const passt = (z: string) => !stichwort || z.includes(stichwort);
  const neuZ = d.neu.find(passt);
  const weg = d.entfallen.find(passt);
  const zeile = neuZ ?? (weg ? `${weg} entfällt` : d.titel);
  return `Profiländerung ${d.nr}: ${zeile}`.slice(0, 160);
}

/** Programm unter Sperre; Profil und Risikoaufnahme erst ab Version 1. */
async function programmUnterSperre(tx: Tx, mandantId: string, ohneVersion1: string) {
  const ref = await sperreProgramm(tx, mandantId);
  const p = await tx.tcmsProgramm.findUniqueOrThrow({
    where: { id: ref.id },
    select: {
      id: true,
      mandantId: true,
      version1Am: true,
      erklaerungsTurnus: true,
      wirksamAb: true,
      wirksamBis: true,
    },
  });
  if (!p.version1Am) throw konflikt(ohneVersion1);
  return p;
}

async function offenerProfilStand(tx: Tx, programmId: string) {
  const s = await tx.profilStand.findFirst({
    where: { programmId, gueltigBis: null },
    orderBy: { gueltigAb: 'desc' },
  });
  if (!s) throw konflikt('Kein offener Profilstand vorhanden.');
  return s;
}

// -----------------------------------------------------------------------------
// Profil ändern
// -----------------------------------------------------------------------------

/**
 * Legt einen neuen Profilstand an (gültig ab heute oder einem Tag im nächsten
 * Jahr) und schließt den offenen. Folgen: aktive Risiken mit geänderter
 * Grundlage werden zur Neubewertung markiert (deterministisch, mit Grund);
 * auf Wunsch entstehen die Ereignisse der geänderten Profilfragen.
 */
export async function profilAendern(
  ctx: DienstKontext,
  eingabe: ProfilAendern,
): Promise<ProfilGeaendert> {
  const e = pruefeEingabe(ProfilAendernSchema, eingabe);
  const mandantId = kanonisch(e.mandantId);
  pruefeBearbeiten(ctx.akteur, mandantId);
  const { profil, fehler } = leseProfil(e.profil);
  if (!profil) throw new DienstFehler('UNGUELTIG', fehler.join(' '), { profil: fehler });
  const pflicht = pruefeProfil(profil);
  if (pflicht.length) throw new DienstFehler('UNGUELTIG', pflicht.join(' '), { profil: pflicht });
  const tag = heuteDatum(ctx.uhr);
  const gewaehlt = tagAlsDatum(e.gueltigAb);
  if (gewaehlt.getTime() < tag.getTime()) {
    throw new DienstFehler(
      'UNGUELTIG',
      'Ein neuer Profilstand gilt frühestens ab heute; historische Stände bleiben unverändert.',
      { gueltigAb: ['vor heute'] },
    );
  }
  if (gewaehlt.getTime() > tag.getTime() + 366 * TAG_MS) {
    throw new DienstFehler('UNGUELTIG', 'Gültig ab liegt mehr als ein Jahr in der Zukunft.', {
      gueltigAb: ['mehr als ein Jahr voraus'],
    });
  }

  return konfliktSicher(() =>
    mitAudit(ctx, async (tx, zeitpunkt) => {
      const programm = await programmUnterSperre(
        tx,
        mandantId,
        'Das Profil wird bis zur Anlage von Version 1 im Einrichtungsassistenten gepflegt.',
      );
      const letzter = await offenerProfilStand(tx, programm.id);
      // TS-05: nur auf dem Stand, den die Person bearbeitet hat.
      if (letzter.id !== e.profilStandId) throw konflikt('Das Profil wurde inzwischen geändert.');
      const alt = letzter.antworten as unknown as Geschaeftsprofil;
      if (gleichesProfil(alt, profil)) {
        throw new DienstFehler('UNGUELTIG', 'Keine Änderung gegenüber dem letzten Profilstand.');
      }
      // Gültig ab heute: ab dem Zeitpunkt der Änderung; künftig: ab Tagesbeginn.
      const ab = gewaehlt.getTime() === tag.getTime() ? zeitpunkt : gewaehlt;
      if (ab.getTime() <= letzter.gueltigAb.getTime()) {
        throw new DienstFehler(
          'UNGUELTIG',
          `Gültig ab muss nach dem Beginn des letzten Stands (${fmtDatum(letzter.gueltigAb)}) liegen.`,
          { gueltigAb: ['nicht nach dem letzten Stand'] },
        );
      }
      const zu = await tx.profilStand.updateMany({
        where: { id: letzter.id, gueltigBis: null },
        data: { gueltigBis: ab },
      });
      if (zu.count !== 1) throw konflikt('Das Profil wurde inzwischen geändert.');
      const stand = await tx.profilStand.create({
        data: {
          programmId: programm.id,
          version: letzter.version + 1,
          antworten: profil as unknown as Prisma.InputJsonValue,
          gueltigAb: ab,
          erstelltVon: ctx.akteur.id,
          createdAt: zeitpunkt,
        },
      });

      const diff = profilDiff(alt, profil);
      const risiken = await tx.risiko.findMany({
        where: { programmId: programm.id },
        select: { id: true, code: true, entscheidung: true, inaktivAb: true, neuBewerten: true },
        orderBy: { id: 'asc' },
      });
      const aktive = risiken.filter(
        (r) =>
          r.entscheidung === 'UEBERNOMMEN' &&
          !(r.inaktivAb && r.inaktivAb.getTime() <= zeitpunkt.getTime()),
      );
      const nb = neuZuBewerten(
        alt,
        profil,
        aktive.map((r) => r.code),
      );
      const typen = e.ereignisseAnlegen ? ereignisseFuerAenderung(alt, profil) : [];
      const neuVorgeschlagen = schlageRisikenVor(profil)
        .filter((v) => !risiken.some((r) => r.code === v.code && r.entscheidung === 'UEBERNOMMEN'))
        .map((v) => v.code);
      const protokolle: Protokoll[] = [];

      const markiert: { code: string; grund: string }[] = [];
      for (const r of aktive) {
        const grund = nb.get(r.code);
        if (!grund) continue;
        markiert.push({ code: r.code, grund });
        if (!r.neuBewerten)
          await tx.risiko.updateMany({ where: { id: r.id }, data: { neuBewerten: true } });
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
            gemeldetVon: ctx.akteur.id,
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
                    zustaendig: ctx.akteur.id,
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
          gueltigAb: e.gueltigAb,
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
          profilStandId: stand.id,
          version: stand.version,
          gueltigAb: ab.toISOString(),
          neuBewerten: markiert,
          ereignisse,
          neuVorgeschlagen,
        },
        protokoll: protokolle,
      };
    }),
  );
}

// -----------------------------------------------------------------------------
// Vorgeschlagenes Risiko aufnehmen
// -----------------------------------------------------------------------------

interface Rollen {
  bt: string;
  hb: string;
  /** Vertretung der Kanzleiseite (nicht Berufsträger:in, nicht Hauptbearbeitung). */
  kanzleiVertretung: string | null;
  tcb: string | null;
  mandantVertretung: string | null;
  gv: string | null;
}

/**
 * Rollen für die Vorbelegung: Kanzleiseite aus der ausdrücklichen Eingabe der
 * kanzleikonsole (nie für Rechte), Mandantenseite aus MandantKontaktRolle
 * (aktive Rollen, nach Anlage sortiert).
 */
async function rollenFuer(
  tx: Tx,
  mandantId: string,
  v: RisikoAufnehmen['verantwortliche'],
): Promise<Rollen> {
  const kontakte = await tx.mandantKontaktRolle.findMany({
    where: { mandantId, aktiv: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { kontaktId: true, rolle: true },
  });
  const erste = (rolle: string, ohne?: string | null) =>
    kontakte.find((k) => k.rolle === rolle && k.kontaktId !== ohne)?.kontaktId ?? null;
  const gv = erste('GESETZLICHER_VERTRETER');
  const tcb = erste('TAX_COMPLIANCE_BEAUFTRAGTER') ?? erste('MITARBEITER') ?? gv;
  const mandantVertretung =
    erste('MITARBEITER', tcb) ?? erste('GESETZLICHER_VERTRETER', tcb) ?? null;
  return {
    bt: kanonisch(v.berufstraeger.id),
    hb: kanonisch(v.hauptbearbeitung.id),
    kanzleiVertretung: v.vertretung ? kanonisch(v.vertretung.id) : null,
    tcb,
    mandantVertretung,
    gv,
  };
}

interface Zustaendigkeit {
  partei: 'KANZLEI' | 'MANDANT';
  durchfuehrendId: string | null;
  vertretungId: string | null;
  gegenzeichnerId: string | null;
  gegenzeichnungMandant: boolean;
}

/** Startbelegung wie im Seed: Kanzleikontrollen Hauptbearbeitung, Mandantenkontrollen TCB, Gegenzeichnung Berufsträger:in. */
function standardZustaendigkeit(kat: KatalogKontrolle, r: Rollen): Zustaendigkeit {
  const mandantSeite = kat.partei === 'MANDANT';
  const durchfuehrend =
    kat.code === 'K-EC-20' || kat.code === 'K-EC-24' ? r.bt : mandantSeite ? r.tcb : r.hb;
  const vertretung = mandantSeite ? r.mandantVertretung : r.kanzleiVertretung;
  const gegenzeichnungMandant = kat.code === 'K-EC-23' && r.mandantVertretung != null;
  const gegenzeichner = gegenzeichnungMandant
    ? r.mandantVertretung
    : durchfuehrend === r.bt
      ? r.kanzleiVertretung
      : r.bt;
  return {
    partei: kat.partei,
    durchfuehrendId: durchfuehrend,
    vertretungId: vertretung,
    gegenzeichnerId: gegenzeichner,
    gegenzeichnungMandant,
  };
}

function kontrollStandDaten(
  kat: KatalogKontrolle,
  z: Zustaendigkeit,
  von: string,
  zeitpunkt: Date,
) {
  return {
    version: 1,
    titel: kat.titel,
    ziel: kat.ziel,
    art: kat.art,
    ausfuehrung: kat.ausfuehrung,
    vorlageTurnus: kat.frequenz.turnus,
    vorlageAnlass: kat.frequenz.anlass,
    partei: z.partei,
    schluessel: kat.schluessel,
    durchfuehrendId: z.durchfuehrendId,
    vertretungId: z.vertretungId,
    gegenzeichnerId: z.gegenzeichnerId,
    gegenzeichnungMandant: z.gegenzeichnungMandant,
    nachweis: kat.nachweis,
    mindestNachweise: kat.mindestNachweise,
    schritte: kat.schritte as unknown as Prisma.InputJsonValue,
    kennzahlen: kat.kennzahlen as unknown as Prisma.InputJsonValue,
    toleranzEur: kat.toleranzEur,
    faelligNachTagen: kat.faelligNachTagen,
    design: 'NICHT_BEURTEILT' as const,
    gueltigAb: zeitpunkt,
    erstelltVon: von,
    createdAt: zeitpunkt,
  };
}

function durchfuehrungDaten(
  kontrolleId: string,
  standId: string,
  faelligNachTagen: number,
  p: Periode,
  zeitpunkt: Date,
): Prisma.DurchfuehrungCreateManyInput {
  return {
    kontrolleId,
    kontrolleStandId: standId,
    periodeLabel: p.label,
    periodeVon: p.von,
    periodeBis: p.bis,
    faelligAm: addTage(p.bis, faelligNachTagen),
    status: 'GEPLANT',
    createdAt: zeitpunkt,
  };
}

function gueltigerStand<T extends { gueltigAb: Date; gueltigBis: Date | null }>(
  liste: readonly T[],
  zeitpunkt: Date,
): T | undefined {
  return liste
    .filter(
      (s) =>
        s.gueltigAb.getTime() <= zeitpunkt.getTime() &&
        (s.gueltigBis == null || s.gueltigBis.getTime() > zeitpunkt.getTime()),
    )
    .sort((a, b) => b.gueltigAb.getTime() - a.gueltigAb.getTime())[0];
}

/**
 * Plant künftige Durchführungen einer (gesperrten) Kontrolle nach einem neuen
 * Turnus. Entfernt werden nur unberührte Perioden, die nach heute beginnen
 * (unter Sperre gelesen und beim Löschen erneut geprüft); laufende und
 * abgeschlossene bleiben.
 */
async function planeKuenftigNeu(
  tx: Tx,
  a: {
    kontrolleId: string;
    standId: string;
    faelligNachTagen: number;
    turnus: Turnus;
    start: Date;
    ende: Date;
    heute: Date;
    zeitpunkt: Date;
  },
): Promise<{ entfernt: number; angelegt: number }> {
  await sperreDurchfuehrungen(tx, a.kontrolleId);
  const alle = await tx.durchfuehrung.findMany({
    where: { kontrolleId: a.kontrolleId },
    include: {
      _count: { select: { nachweise: true, feststellungen: true, nachkontrolleFuer: true } },
    },
  });
  const entfernbar = alle.filter(
    (d) =>
      d.status === 'GEPLANT' &&
      !d.ausserplanmaessig &&
      d.begonnenAm == null &&
      d.durchgefuehrtVon == null &&
      d.eingereichtAm == null &&
      d.abgeschlossenAm == null &&
      d.periodeVon.getTime() > a.heute.getTime() &&
      d._count.nachweise === 0 &&
      d._count.feststellungen === 0 &&
      d._count.nachkontrolleFuer === 0,
  );
  await loescheUnberuehrte(
    tx,
    entfernbar.map((d) => d.id),
  );
  const ids = new Set(entfernbar.map((d) => d.id));
  const bleibend = alle.filter((d) => !ids.has(d.id) && !d.ausserplanmaessig);
  const letztesEnde = bleibend.reduce<Date | null>(
    (m, d) => (!m || d.periodeBis.getTime() > m.getTime() ? d.periodeBis : m),
    null,
  );
  const ab =
    letztesEnde && addTage(letztesEnde, 1).getTime() > a.start.getTime()
      ? addTage(letztesEnde, 1)
      : a.start;
  const neu = perioden(a.turnus, ab, a.ende).filter(
    (p) =>
      p.von.getTime() >= ab.getTime() ||
      (letztesEnde == null && p.bis.getTime() >= a.start.getTime()),
  );
  if (neu.length) {
    await tx.durchfuehrung.createMany({
      data: neu.map((p) =>
        durchfuehrungDaten(a.kontrolleId, a.standId, a.faelligNachTagen, p, a.zeitpunkt),
      ),
    });
  }
  return { entfernt: entfernbar.length, angelegt: neu.length };
}

/**
 * Nimmt ein aus dem aktuellen Profil vorgeschlagenes Katalogrisiko ins
 * Inventar auf (deterministischer Vorschlag mit Grund, AGENTS.md Regel 7):
 * Risiko mit Katalogstand anlegen bzw. Ablehnung aufheben, passende
 * Kontrollen verknüpfen oder aus dem Katalog anlegen (Vorbelegung der
 * Zuständigkeit aus der Eingabe und MandantKontaktRolle) und Durchführungen
 * planen.
 */
export async function vorgeschlagenesRisikoAufnehmen(
  ctx: DienstKontext,
  eingabe: RisikoAufnehmen,
): Promise<RisikoAufgenommen> {
  const e = pruefeEingabe(RisikoAufnehmenSchema, eingabe);
  const mandantId = kanonisch(e.mandantId);
  pruefeBearbeiten(ctx.akteur, mandantId);
  const kat = katalogRisiko(e.code);
  if (!kat)
    throw new DienstFehler('UNGUELTIG', 'Unbekanntes Katalogrisiko.', { code: ['unbekannt'] });

  return konfliktSicher(() =>
    mitAudit(ctx, async (tx, zeitpunkt) => {
      const programm = await programmUnterSperre(
        tx,
        mandantId,
        'Risiken werden bis zur Anlage von Version 1 im Einrichtungsassistenten übernommen.',
      );
      await pruefeKanzleiPersonen(tx, [
        { id: e.verantwortliche.berufstraeger.id, feld: 'verantwortliche.berufstraeger' },
        { id: e.verantwortliche.hauptbearbeitung.id, feld: 'verantwortliche.hauptbearbeitung' },
        ...(e.verantwortliche.vertretung
          ? [{ id: e.verantwortliche.vertretung.id, feld: 'verantwortliche.vertretung' }]
          : []),
      ]);
      // Nur deterministische Vorschläge des offenen Profilstands (mit Grund).
      const profilStand = await tx.profilStand.findFirst({
        where: { programmId: programm.id, gueltigBis: null },
        orderBy: { gueltigAb: 'desc' },
      });
      if (!profilStand) throw konflikt('Kein Profilstand vorhanden.');
      const vorschlag = schlageRisikenVor(
        profilStand.antworten as unknown as Geschaeftsprofil,
      ).find((v) => v.code === e.code);
      if (!vorschlag) {
        throw new DienstFehler(
          'UNGUELTIG',
          `${e.code} wird aus dem aktuellen Profil nicht vorgeschlagen.`,
          { code: ['nicht vorgeschlagen'] },
        );
      }
      const r = await rollenFuer(tx, mandantId, e.verantwortliche);
      const protokolle: Protokoll[] = [];

      // --- Risiko anlegen oder Ablehnung aufheben (unter Sperre) ---
      const vorhandenRef = await tx.risiko.findFirst({
        where: { programmId: programm.id, code: e.code },
        select: { id: true },
      });
      if (vorhandenRef) await sperreRisiken(tx, programm.id, [vorhandenRef.id]);
      const vorhanden = vorhandenRef
        ? await tx.risiko.findUniqueOrThrow({
            where: { id: vorhandenRef.id },
            include: { staende: true },
          })
        : null;
      if (vorhanden && vorhanden.entscheidung === 'UEBERNOMMEN') {
        throw konflikt(
          vorhanden.inaktivAb
            ? `${e.code} ist deaktiviert; eine Reaktivierung erfolgt im Risikoinventar.`
            : `${e.code} ist bereits im Risikoinventar.`,
        );
      }
      const standDaten = {
        titel: kat.titel,
        fehlerquelle: kat.fehlerquelle,
        folge: kat.folge,
        normanker: kat.normanker as unknown as Prisma.InputJsonValue,
        s: kat.s,
        w: kat.w,
        r: kat.r,
        gt: kat.gt,
        modell: BEWERTUNGSMODELL_VERSION,
        gueltigAb: zeitpunkt,
        erstelltVon: ctx.akteur.id,
        createdAt: zeitpunkt,
      };
      let risikoId: string;
      if (vorhanden) {
        const z = await tx.risiko.updateMany({
          where: { id: vorhanden.id, entscheidung: vorhanden.entscheidung },
          data: {
            entscheidung: 'UEBERNOMMEN',
            vorschlagsgrund: vorschlag.grund,
            freigabe: 'BEWERTET',
            ownerId: vorhanden.ownerId ?? r.tcb,
            aktivAb: zeitpunkt,
          },
        });
        if (z.count !== 1) throw konflikt('Das Risiko wurde inzwischen geändert.');
        if (!gueltigerStand(vorhanden.staende, zeitpunkt)) {
          const version = Math.max(0, ...vorhanden.staende.map((x) => x.version)) + 1;
          await tx.risikoStand.create({ data: { risikoId: vorhanden.id, version, ...standDaten } });
        }
        risikoId = vorhanden.id;
      } else {
        const neu = await tx.risiko.create({
          data: {
            programmId: programm.id,
            code: e.code,
            kern: kat.kern,
            entscheidung: 'UEBERNOMMEN',
            vorschlagsgrund: vorschlag.grund,
            freigabe: 'BEWERTET',
            ownerId: r.tcb,
            aktivAb: zeitpunkt,
            createdAt: zeitpunkt,
            staende: { create: { version: 1, ...standDaten } },
          },
        });
        risikoId = neu.id;
      }
      protokolle.push({
        aktion: 'tcms.risiko.aufgenommen',
        objektTyp: 'Risiko',
        objektId: risikoId,
        programmId: programm.id,
        detail: {
          code: e.code,
          vorschlagsgrund: vorschlag.grund,
          vorher: vorhanden ? vorhanden.entscheidung : null,
          quelle: 'Profilvorschlag',
        },
      });

      // --- Betroffene Kontrollen sperren, dann unter Sperre lesen ---
      const kandidaten = kontrollenFuerRisiko(e.code);
      const bestehendeRefs = await tx.kontrolle.findMany({
        where: { programmId: programm.id, code: { in: kandidaten.map((k) => k.code) } },
        select: { id: true },
      });
      await sperreKontrollen(
        tx,
        programm.id,
        bestehendeRefs.map((k) => k.id),
      );
      const bestehende = await tx.kontrolle.findMany({
        where: { id: { in: bestehendeRefs.map((k) => k.id) } },
        include: { staende: true, risiken: true },
      });
      const alleRisiken = await tx.risiko.findMany({
        where: { programmId: programm.id },
        include: { staende: true },
      });

      // --- Bruttoklassen der aktiven Risiken (mit dem neuen) ---
      const bruttoJe = new Map<string, RisikoFuerFrequenz>();
      const risikoIdJe = new Map<string, string>([[e.code, risikoId]]);
      for (const x of alleRisiken) {
        if (x.id === risikoId) continue;
        if (
          x.entscheidung !== 'UEBERNOMMEN' ||
          (x.inaktivAb && x.inaktivAb.getTime() <= zeitpunkt.getTime())
        )
          continue;
        const s = gueltigerStand(x.staende, zeitpunkt);
        if (!s) continue;
        bruttoJe.set(x.code, {
          code: x.code,
          gt: s.gt,
          brutto: berechneBrutto(s.s, s.w, s.r as 1 | 2 | 3).klasse,
        });
        risikoIdJe.set(x.code, x.id);
      }
      const ohneNeues = new Map(bruttoJe);
      bruttoJe.set(e.code, {
        code: e.code,
        gt: kat.gt,
        brutto: berechneBrutto(kat.s, kat.w, kat.r).klasse,
      });

      // --- Planungshorizont ---
      const heute = heuteDatum(ctx.uhr);
      const start =
        programm.wirksamAb && addTage(programm.wirksamAb, -1).getTime() > heute.getTime()
          ? addTage(programm.wirksamAb, -1)
          : heute;
      const spaeteste = await tx.durchfuehrung.aggregate({
        where: { kontrolle: { programmId: programm.id }, ausserplanmaessig: false },
        _max: { periodeBis: true },
      });
      let ende: Date | null = programm.wirksamBis;
      const max = spaeteste._max.periodeBis;
      if (max && (!ende || max.getTime() > ende.getTime())) ende = max;
      const turnus = programm.erklaerungsTurnus;

      const neueKontrollen: string[] = [];
      const verknuepft: string[] = [];
      const neuGeplant: RisikoAufgenommen['neuGeplant'] = [];
      let anzahlDurchf = 0;

      for (const kk of kandidaten) {
        const bestehend = bestehende.find(
          (k) =>
            k.code === kk.code &&
            !(k.entfallenAb && k.entfallenAb.getTime() <= zeitpunkt.getTime()),
        );
        if (bestehend) {
          if (!bestehend.risiken.some((x) => x.risikoId === risikoId)) {
            await tx.risikoKontrolle.create({ data: { risikoId, kontrolleId: bestehend.id } });
            verknuepft.push(kk.code);
          }
          const stand = gueltigerStand(bestehend.staende, zeitpunkt);
          if (!stand) continue;
          const vorlage = { turnus: stand.vorlageTurnus, anlass: stand.vorlageAnlass };
          const idZuCode = new Map([...risikoIdJe.entries()].map(([c, id]) => [id, c]));
          const verkn = (m: Map<string, RisikoFuerFrequenz>) =>
            [...new Set([...bestehend.risiken.map((x) => idZuCode.get(x.risikoId)), e.code])]
              .filter((c): c is string => !!c && m.has(c))
              .map((c) => m.get(c)!);
          const vorher = leiteFrequenzAb(vorlage, verkn(ohneNeues), turnus).effektiv;
          const nachher = leiteFrequenzAb(vorlage, verkn(bruttoJe), turnus).effektiv;
          if (stand.abweichungTurnus == null && vorher.turnus !== nachher.turnus && ende) {
            const ergebnis = await planeKuenftigNeu(tx, {
              kontrolleId: bestehend.id,
              standId: stand.id,
              faelligNachTagen: stand.faelligNachTagen,
              turnus: nachher.turnus,
              start,
              ende,
              heute,
              zeitpunkt,
            });
            neuGeplant.push({
              code: kk.code,
              vorher: vorher.turnus,
              nachher: nachher.turnus,
              ...ergebnis,
            });
            anzahlDurchf += ergebnis.angelegt;
          }
          continue;
        }
        // Neue Kontrolle aus dem Katalog, verknüpft mit allen aktiven Risiken, die sie abdeckt.
        const codes = kk.risiken.filter((c) => bruttoJe.has(c));
        const z = standardZustaendigkeit(kk, r);
        const k = await tx.kontrolle.create({
          data: {
            programmId: programm.id,
            code: kk.code,
            aktivAb: zeitpunkt,
            createdAt: zeitpunkt,
            staende: { create: kontrollStandDaten(kk, z, ctx.akteur.id, zeitpunkt) },
            risiken: { create: codes.map((c) => ({ risikoId: risikoIdJe.get(c)! })) },
          },
          include: { staende: { select: { id: true } } },
        });
        neueKontrollen.push(kk.code);
        const ableitung = leiteFrequenzAb(
          kk.frequenz,
          codes.map((c) => bruttoJe.get(c)!),
          turnus,
        );
        if (ende && ende.getTime() >= start.getTime()) {
          const daten = perioden(ableitung.effektiv.turnus, start, ende).map((p) =>
            durchfuehrungDaten(k.id, k.staende[0]!.id, kk.faelligNachTagen, p, zeitpunkt),
          );
          if (daten.length) await tx.durchfuehrung.createMany({ data: daten });
          anzahlDurchf += daten.length;
        }
        protokolle.push({
          aktion: 'tcms.kontrolle.angelegt',
          objektTyp: 'Kontrolle',
          objektId: k.id,
          programmId: programm.id,
          detail: {
            code: kk.code,
            risiken: codes,
            frequenz: ableitung.effektiv,
            anlass: `Risiko ${e.code} aufgenommen`,
          },
        });
      }
      if (neuGeplant.length) {
        protokolle.push({
          aktion: 'tcms.durchfuehrungen.neu_geplant',
          objektTyp: 'TcmsProgramm',
          objektId: programm.id,
          programmId: programm.id,
          detail: { anlass: `Risiko ${e.code} aufgenommen`, kontrollen: neuGeplant },
        });
      }
      return {
        wert: {
          risikoId,
          code: e.code,
          neueKontrollen,
          verknuepft,
          neuGeplant,
          durchfuehrungen: anzahlDurchf,
        },
        protokoll: protokolle,
      };
    }),
  );
}
