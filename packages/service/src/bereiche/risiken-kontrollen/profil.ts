// =============================================================================
// Geschäftsprofil (Profil-Tab), bisher apps/web/src/server/actions/profil.ts
// und programm-aufbau.ts (`nimmRisikoAuf`): Profiländerung als neuer Stand mit
// Triggern (Fachkonzept §4, §7) und Aufnahme vorgeschlagener Risiken – die
// einzige Risikoaufnahme mit Neuplanung im Service. Profilregeln aus
// `@tcms/domain`, Kontrollvorlagen aus `kern/kontroll-vorlage.ts`.
//
// TS-05: Beide Operationen sperren zuerst das Programm des Mandanten
// (SELECT … FOR NO KEY UPDATE), dann betroffene Risiken und Kontrollen
// (Ordnung im Kopf von `gemeinsam.ts`: Programm → Risiken → Kontrollen →
// Durchführungen → Nummernkreise). `profilAendern` sperrt alle Risiken des
// Programms, bevor es das Kennzeichen „neu bewerten“ liest und setzt. Der
// offene Profilstand wird bedingt geschlossen; „ein offener Stand je Programm"
// und (programmId, version) sind eindeutig – eine Gabelung ist unmöglich.
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
  ereignisseFuerAenderung,
  ereignistyp,
  fmtDatum,
  frequenzLabel,
  gleicheFrequenz,
  gleichesProfil,
  kalenderjahr,
  katalogRisiko,
  kontrollenFuerRisiko,
  leiteFrequenzAb,
  mindestensSoStreng,
  neuZuBewerten,
  perioden,
  profilDiff,
  PROFIL_FRAGEN,
  pruefeProfil,
  schlageRisikenVor,
  type FrageDiff,
  type Geschaeftsprofil,
  type RisikoFuerFrequenz,
} from '@tcms/domain';
import { mitAudit, type Protokoll } from '../../audit';
import {
  geplanteDurchfuehrung,
  gueltigerStand,
  kontrollStandDaten,
  mandantSeiteVorbelegen,
  standardKontrollZustaendigkeit,
  type VorbelegungsRollen,
} from '../../kern/kontroll-vorlage';
import { leseProfil } from '../../kern/profil';
import { naechsteEreignisnummern } from '../../kern/nummern';
import { heuteDatum, tagAlsDatum } from '../../kern/zeit';
import type { DienstKontext } from '../../kontext';
import {
  kanonisch,
  konflikt,
  konfliktSicher,
  pruefeBearbeiten,
  pruefeEingabe,
  sperreKontrollen,
  sperreProgramm,
  sperreRisiken,
} from './gemeinsam';
import { pruefeKanzleiPersonen } from './kontrollen';
import { effektiveFrequenz, neuerKontrollStand, planeDurchfuehrungenNeu } from './planung';

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
    orderBy: [{ gueltigAb: 'desc' }, { id: 'desc' }],
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
      // TS-05: Risiken des Programms sperren (Programm → Risiken nach ID) und das
      // Kennzeichen „neu bewerten“ erst unter der Sperre lesen – eine parallele
      // Neubewertung setzt es sonst nach unserem Lesen zurück.
      const refs = await tx.risiko.findMany({
        where: { programmId: programm.id },
        select: { id: true },
        orderBy: { id: 'asc' },
      });
      await sperreRisiken(
        tx,
        programm.id,
        refs.map((r) => r.id),
      );
      const risiken = await tx.risiko.findMany({
        where: { programmId: programm.id, id: { in: refs.map((r) => r.id) } },
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

      // Den Nummernkreis nur sperren, wenn Ereignisse entstehen (Ordnung: Nummernkreise
      // nach den Zeilensperren).
      const nummern =
        typen.length > 0
          ? await naechsteEreignisnummern(tx, kalenderjahr(zeitpunkt), typen.length)
          : [];
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

/**
 * Rollen für die Vorbelegung: Kanzleiseite aus der ausdrücklichen Eingabe der
 * kanzleikonsole (nie für Rechte), Mandantenseite aus MandantKontaktRolle
 * (aktive Rollen, nach Anlage sortiert).
 */
async function rollenFuer(
  tx: Tx,
  mandantId: string,
  v: RisikoAufnehmen['verantwortliche'],
): Promise<VorbelegungsRollen> {
  const kontakte = await tx.mandantKontaktRolle.findMany({
    where: { mandantId, aktiv: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { kontaktId: true, rolle: true },
  });
  return {
    bt: kanonisch(v.berufstraeger.id),
    hb: kanonisch(v.hauptbearbeitung.id),
    kanzleiVertretung: v.vertretung ? kanonisch(v.vertretung.id) : null,
    ...mandantSeiteVorbelegen(kontakte.map((k) => ({ id: k.kontaktId, rolle: k.rolle }))),
  };
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
      await pruefeKanzleiPersonen(tx, mandantId, [
        { id: e.verantwortliche.berufstraeger.id, feld: 'verantwortliche.berufstraeger' },
        { id: e.verantwortliche.hauptbearbeitung.id, feld: 'verantwortliche.hauptbearbeitung' },
        ...(e.verantwortliche.vertretung
          ? [{ id: e.verantwortliche.vertretung.id, feld: 'verantwortliche.vertretung' }]
          : []),
      ]);
      // Nur deterministische Vorschläge (mit Grund): des offenen Profilstands (auch
      // eines im Voraus erfassten, wie die Profilseite der Demo) oder des heute
      // gültigen Stands, den der Lesepfad `ladeProfil.vorschlaege` nennt (Befund 14).
      const staende = await tx.profilStand.findMany({
        where: { programmId: programm.id },
        orderBy: [{ gueltigAb: 'desc' }, { id: 'asc' }],
      });
      const offen = staende.find((s) => s.gueltigBis == null);
      if (!offen) throw konflikt('Kein Profilstand vorhanden.');
      const heuteGueltig = gueltigerStand(staende, zeitpunkt);
      const vorschlagAus = (s: (typeof staende)[number] | undefined) =>
        s
          ? schlageRisikenVor(s.antworten as unknown as Geschaeftsprofil).find(
              (v) => v.code === e.code,
            )
          : undefined;
      const vorschlag = vorschlagAus(offen) ?? vorschlagAus(heuteGueltig);
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
            include: { staende: { orderBy: [{ version: 'asc' }, { id: 'asc' }] } },
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
      // Das Detail nennt am Ende auch die verknüpften und neuen Kontrollen (Befund 35).
      const aufgenommen: Protokoll = {
        aktion: 'tcms.risiko.aufgenommen',
        objektTyp: 'Risiko',
        objektId: risikoId,
        programmId: programm.id,
      };
      protokolle.push(aufgenommen);

      // --- Betroffene Kontrollen sperren, dann unter Sperre lesen ---
      const kandidaten = kontrollenFuerRisiko(e.code);
      const bestehendeRefs = await tx.kontrolle.findMany({
        where: { programmId: programm.id, code: { in: kandidaten.map((k) => k.code) } },
        select: { id: true },
        orderBy: { id: 'asc' },
      });
      await sperreKontrollen(
        tx,
        programm.id,
        bestehendeRefs.map((k) => k.id),
      );
      const bestehende = await tx.kontrolle.findMany({
        where: { id: { in: bestehendeRefs.map((k) => k.id) } },
        include: {
          staende: { orderBy: [{ version: 'asc' }, { id: 'asc' }] },
          risiken: { orderBy: { risikoId: 'asc' } },
        },
        orderBy: [{ code: 'asc' }, { id: 'asc' }],
      });
      const alleRisiken = await tx.risiko.findMany({
        where: { programmId: programm.id },
        include: { staende: { orderBy: [{ version: 'asc' }, { id: 'asc' }] } },
        orderBy: [{ code: 'asc' }, { id: 'asc' }],
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
          const neuVerknuepft = !bestehend.risiken.some((x) => x.risikoId === risikoId);
          if (neuVerknuepft) {
            await tx.risikoKontrolle.create({ data: { risikoId, kontrolleId: bestehend.id } });
            verknuepft.push(kk.code);
          }
          let stand = gueltigerStand(bestehend.staende, zeitpunkt);
          if (!stand) continue;
          const idZuCode = new Map([...risikoIdJe.entries()].map(([c, id]) => [id, c]));
          const verkn = (m: Map<string, RisikoFuerFrequenz>) =>
            [...new Set([...bestehend.risiken.map((x) => idZuCode.get(x.risikoId)), e.code])]
              .filter((c): c is string => !!c && m.has(c))
              .map((c) => m.get(c)!);
          // Effektive Frequenz wie in der Neubewertung (eine Regel, `planung.ts`): eine
          // offene Abweichung zählt nicht, eine freigegebene schon.
          const vorher = effektiveFrequenz(stand, verkn(ohneNeues), turnus);
          let nachher = effektiveFrequenz(stand, verkn(bruttoJe), turnus);
          const anlass = `Risiko ${e.code} aufgenommen`;
          // Eine freigegebene Abweichung wurde gegen die bisherige Mindestfrequenz
          // freigegeben; deckt sie die durch das neue Risiko geänderte nicht mehr, endet
          // sie (Doppelbedingung wie in der Neubewertung, Befund 3).
          if (
            stand.abweichungTurnus != null &&
            stand.abweichungFreigegebenVon &&
            !gleicheFrequenz(vorher.ableitung.mindest, nachher.ableitung.mindest)
          ) {
            const abw = { turnus: stand.abweichungTurnus, anlass: stand.abweichungAnlass ?? false };
            if (!mindestensSoStreng(abw, nachher.ableitung.mindest)) {
              stand = await neuerKontrollStand(
                tx,
                stand,
                {
                  abweichungTurnus: null,
                  abweichungAnlass: null,
                  abweichungBegruendung: null,
                  abweichungFreigegebenVon: null,
                },
                zeitpunkt,
                ctx.akteur.id,
              );
              nachher = effektiveFrequenz(stand, verkn(bruttoJe), turnus);
              protokolle.push({
                aktion: 'tcms.kontrolle.abweichung_aufgehoben',
                objektTyp: 'Kontrolle',
                objektId: bestehend.id,
                programmId: programm.id,
                detail: {
                  code: kk.code,
                  abweichung: frequenzLabel(abw),
                  mindest: frequenzLabel(nachher.ableitung.mindest),
                  grund: anlass,
                },
              });
            }
          }
          // Befund 35: Verknüpfung und Frequenzänderung stehen in der Spur der Kontrolle.
          if (neuVerknuepft) {
            protokolle.push({
              aktion: 'tcms.kontrolle.risiko_verknuepft',
              objektTyp: 'Kontrolle',
              objektId: bestehend.id,
              programmId: programm.id,
              detail: {
                code: kk.code,
                risiko: e.code,
                risikoId,
                frequenz: {
                  vorher: frequenzLabel(vorher.frequenz),
                  nachher: frequenzLabel(nachher.frequenz),
                },
                anlass,
              },
            });
          }
          if (!gleicheFrequenz(vorher.frequenz, nachher.frequenz)) {
            protokolle.push({
              aktion: 'tcms.kontrolle.frequenz_geaendert',
              objektTyp: 'Kontrolle',
              objektId: bestehend.id,
              programmId: programm.id,
              detail: {
                code: kk.code,
                vorher: frequenzLabel(vorher.frequenz),
                nachher: frequenzLabel(nachher.frequenz),
                grund: nachher.ableitung.begruendung,
                anlass,
              },
            });
          }
          if (vorher.frequenz.turnus !== nachher.frequenz.turnus) {
            const plan = await planeDurchfuehrungenNeu(tx, {
              programmId: programm.id,
              kontrolleId: bestehend.id,
              code: kk.code,
              standId: stand.id,
              faelligNachTagen: stand.faelligNachTagen,
              turnusVorher: vorher.frequenz.turnus,
              turnusNachher: nachher.frequenz.turnus,
              heute,
              zeitpunkt,
            });
            if (plan) {
              neuGeplant.push({
                code: kk.code,
                vorher: plan.turnusVorher,
                nachher: plan.turnusNachher,
                entfernt: plan.entfernt.length,
                angelegt: plan.angelegt.length,
              });
              anzahlDurchf += plan.angelegt.length;
              protokolle.push({
                aktion: 'tcms.kontrolle.neu_geplant',
                objektTyp: 'Kontrolle',
                objektId: bestehend.id,
                programmId: programm.id,
                detail: { ...plan, anlass },
              });
            }
          }
          continue;
        }
        // Neue Kontrolle aus dem Katalog, verknüpft mit allen aktiven Risiken, die sie abdeckt.
        const codes = kk.risiken.filter((c) => bruttoJe.has(c));
        const z = standardKontrollZustaendigkeit(kk, r);
        const k = await tx.kontrolle.create({
          data: {
            programmId: programm.id,
            code: kk.code,
            aktivAb: zeitpunkt,
            createdAt: zeitpunkt,
            staende: { create: kontrollStandDaten(kk, z, ctx.akteur.id, zeitpunkt) },
            risiken: { create: codes.map((c) => ({ risikoId: risikoIdJe.get(c)! })) },
          },
          include: {
            staende: { select: { id: true }, orderBy: [{ version: 'asc' }, { id: 'asc' }] },
          },
        });
        neueKontrollen.push(kk.code);
        const ableitung = leiteFrequenzAb(
          kk.frequenz,
          codes.map((c) => bruttoJe.get(c)!),
          turnus,
        );
        if (ende && ende.getTime() >= start.getTime()) {
          const daten = perioden(ableitung.effektiv.turnus, start, ende).map((p) =>
            geplanteDurchfuehrung(k.id, k.staende[0]!.id, kk.faelligNachTagen, p, zeitpunkt),
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
      aufgenommen.detail = {
        code: e.code,
        vorschlagsgrund: vorschlag.grund,
        vorher: vorhanden ? vorhanden.entscheidung : null,
        quelle: 'Profilvorschlag',
        verknuepft,
        neueKontrollen,
      };
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
