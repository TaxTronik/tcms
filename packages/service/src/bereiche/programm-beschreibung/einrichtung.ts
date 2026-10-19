// =============================================================================
// Einrichtungsassistent (S3) als Service: Entwurf lesen, Schritt speichern und
// prüfen, Programm mit Version 1 anlegen (bisher apps/web/src/server/actions/
// setup.ts). Der Entwurf liegt in TcmsProgramm.setupEntwurf; das Programm
// entsteht beim ersten Speichern im Status ENTWURF.
//
// Sicherheit:
//   - Lesen: Kanzleiperson mit Bezug (`kannLesen`); Schreiben: `kannBearbeiten`.
//   - TS-05: höchstens ein Programm je Mandant. Bestehende Programmzeile wird
//     für jede Änderung gesperrt (FOR UPDATE), Prüfung und Änderung laufen in
//     derselben Transaktion; ein gleichzeitiges erstes Anlegen scheitert am
//     eindeutigen Schlüssel (tenant_id, mandantId) → `KONFLIKT`, ein zweites
//     „Version 1 anlegen" sieht unter der Sperre AKTIV → `KONFLIKT`.
//   - TS-07: kein Stichtag; „heute" kommt aus der Uhr des Kontexts.
//   - Personen (Berufsträger:in, Hauptbearbeitung, Kanzleipersonen) sind
//     ausdrückliche Eingabe der kanzleikonsole und dienen nur Vorbelegung und
//     Zuständigkeitsprüfung, nie Rechten. Mandantenkontakte kommen aus
//     MandantKontaktRolle.
// =============================================================================

import {
  DienstFehler,
  EinrichtungLesenEingabeSchema,
  EntwurfSpeichernEingabeSchema,
  ProgrammAnlegenEingabeSchema,
  type EinrichtungLesenEingabe,
  type EinrichtungPersonen,
  type EinrichtungView,
  type EntwurfKontrolle,
  type EntwurfSpeichernEingabe,
  type EntwurfSpeichernErgebnis,
  type PlanView,
  type ProgrammAnlegenEingabe,
  type ProgrammAnlegenErgebnis,
  type SetupEntwurf,
} from '@tcms/contract';
import { Prisma, type Tx } from '@tcms/db';
import { isoDatum, katalogRisiko, KATALOG_KONTROLLEN, PAKET } from '@tcms/domain';
import { mitAudit, type Protokoll } from '../../audit';
import { heuteDatum } from '../../kern/zeit';
import type { DienstKontext } from '../../kontext';
import { kannBearbeiten } from '../../rechte';
import {
  aufbauRollen,
  berechnePlan,
  pruefeKontrollZustaendigkeiten,
  schreibeVersion1,
  type AufbauPerson,
  type AufbauPlan,
  type AufbauUmfeld,
} from './aufbau';
import {
  inhaltGleich,
  leseEinrichtungsProfil,
  leseEntwurf,
  pruefeSchritt1,
  pruefeSchritt2,
  pruefeSchritt3,
  pruefeSchritt4,
} from './entwurf';
import {
  aktiveKontakte,
  fachlichUngueltig,
  iso,
  kanzleiZugriff,
  konfliktBeiEindeutigkeit,
  programmIdDesMandanten,
  pruefeEingabe,
} from './gemeinsam';

const BEREITS_EINGERICHTET =
  'Für diesen Mandanten ist bereits ein Tax-CMS angelegt; Änderungen erfolgen in den Bereichen des Cockpits.';
const KONTROLL_CODES = new Set(KATALOG_KONTROLLEN.map((k) => k.code));

const klein = (id: string | null) => (id ? id.toLowerCase() : null);

/** Umfeld aus Mandant, aktiven Kontakten (Datenbank) und den Personen der kanzleikonsole. */
async function baueUmfeld(
  tx: Tx,
  mandant: { id: string; name: string },
  personen: EinrichtungPersonen,
  heute: Date,
): Promise<{ umfeld: AufbauUmfeld; gvIds: string[] }> {
  const kontakte = await aktiveKontakte(tx, mandant.id);
  const mandantPersonen: AufbauPerson[] = [];
  for (const k of kontakte) {
    if (!mandantPersonen.some((p) => p.id === k.kontaktId))
      mandantPersonen.push({ id: k.kontaktId, mandantRolle: k.rolle });
  }
  const bt = klein(personen.berufstraegerId);
  const hb = klein(personen.bearbeitungId);
  const kanzlei: AufbauPerson[] = [];
  for (const id of [...personen.kanzlei.map((x) => x.toLowerCase()), bt, hb]) {
    if (id && !kanzlei.some((p) => p.id === id)) kanzlei.push({ id, mandantRolle: null });
  }
  return {
    umfeld: {
      mandant: {
        id: mandant.id,
        name: mandant.name,
        berufstraegerId: bt ?? '',
        bearbeitungId: hb ?? '',
      },
      kanzlei,
      mandantPersonen,
      heute,
    },
    gvIds: kontakte.filter((k) => k.rolle === 'GESETZLICHER_VERTRETER').map((k) => k.kontaktId),
  };
}

function kontrollenKanonisch(
  roh: Record<string, EntwurfKontrolle>,
): Record<string, EntwurfKontrolle> {
  const out: Record<string, EntwurfKontrolle> = {};
  const unbekannt: string[] = [];
  for (const [code, k] of Object.entries(roh)) {
    if (!KONTROLL_CODES.has(code)) {
      unbekannt.push(`${code}: keine Kontrolle des Katalogs.`);
      continue;
    }
    out[code] = {
      partei: k.partei,
      durchfuehrendId: klein(k.durchfuehrendId),
      vertretungId: klein(k.vertretungId),
      gegenzeichnerId: klein(k.gegenzeichnerId),
    };
  }
  if (unbekannt.length) fachlichUngueltig('Unbekannte Kontrollen.', 'kontrollen', unbekannt);
  return out;
}

function pruefeAlle(n: number, e: SetupEntwurf, u: AufbauUmfeld, gvIds: string[]): string[] {
  switch (n) {
    case 1:
      return pruefeSchritt1(e, u.heute);
    case 2:
      return pruefeSchritt2(e);
    case 3:
      return pruefeSchritt3(e, gvIds);
    case 4:
      return pruefeSchritt4(e);
    default:
      return pruefeKontrollZustaendigkeiten(berechnePlan(e, u), u);
  }
}

interface ProgrammZeile {
  id: string;
  status: 'ENTWURF' | 'AKTIV';
  version1Am: Date | null;
  setupEntwurf: Prisma.JsonValue;
  createdAt: Date;
}

async function ladeProgramm(
  tx: Tx,
  mandantId: string,
  sperren: boolean,
): Promise<ProgrammZeile | null> {
  const id = await programmIdDesMandanten(tx, mandantId, sperren);
  if (!id) return null;
  return tx.tcmsProgramm.findUnique({
    where: { id },
    select: { id: true, status: true, version1Am: true, setupEntwurf: true, createdAt: true },
  });
}

const eingerichtet = (p: ProgrammZeile | null) =>
  !!p && (p.status !== 'ENTWURF' || p.version1Am !== null);

function planView(p: AufbauPlan): PlanView {
  return {
    appetit: p.appetit,
    zeitraum: p.zeitraum
      ? {
          stichtag: isoDatum(p.zeitraum.stichtag),
          ab: isoDatum(p.zeitraum.ab),
          bis: isoDatum(p.zeitraum.bis),
        }
      : null,
    risiken: p.risiken.map((r) => ({
      code: r.code,
      titel: r.kat.titel,
      kern: r.kern,
      gt: r.kat.gt,
      grund: r.grund,
      frage: r.frage,
      uebernehmen: r.uebernehmen,
      begruendung: r.begruendung,
      brutto: r.brutto.klasse,
      ueberAppetit: r.ueberAppetit,
    })),
    nichtVorgeschlagen: p.nichtVorgeschlagen.map((k) => ({ code: k.code, titel: k.titel })),
    kontrollen: p.kontrollen.map((k) => ({
      code: k.code,
      titel: k.kat.titel,
      schluessel: k.kat.schluessel,
      risikoCodes: [...k.risikoCodes],
      primaer: k.primaer,
      vorlage: { turnus: k.kat.frequenz.turnus, anlass: k.kat.frequenz.anlass },
      effektiv: { turnus: k.ableitung.effektiv.turnus, anlass: k.ableitung.effektiv.anlass },
      gt: k.ableitung.gt,
      begruendung: k.ableitung.begruendung,
      zust: {
        partei: k.zust.partei,
        durchfuehrendId: k.zust.durchfuehrendId,
        vertretungId: k.zust.vertretungId,
        gegenzeichnerId: k.zust.gegenzeichnerId,
        gegenzeichnungMandant: k.zust.gegenzeichnungMandant,
      },
      perioden: k.perioden.length,
    })),
    prueflast: p.prueflast.map((x) => ({
      monat: x.monat,
      FP: x.FP,
      FF: x.FF,
      IN: x.IN,
      ausloesungen: x.ausloesungen,
      gesamt: x.gesamt,
    })),
    durchfuehrungen: p.durchfuehrungen,
  };
}

/** Entwurf, Plan und offene Prüfpunkte des Assistenten (bzw. „eingerichtet"). */
export async function ladeEinrichtung(
  ctx: DienstKontext,
  eingabe: EinrichtungLesenEingabe,
): Promise<EinrichtungView> {
  const e = pruefeEingabe(EinrichtungLesenEingabeSchema, eingabe);
  const mandantId = e.mandantId.toLowerCase();
  const mandant = await kanzleiZugriff(ctx, mandantId, false);
  const heute = heuteDatum(ctx.uhr);
  const programm = await ladeProgramm(ctx.tx, mandantId, false);
  // Lesen ohne vollständige Personenliste: Kanzleipersonen sind Zuständigkeit,
  // Vertretung und die im Entwurf bereits gewählten Personen (Prüfung beim Speichern).
  const gespeichert = leseEntwurf(programm?.setupEntwurf, heute, null);
  const gewaehlt = Object.values(gespeichert.kontrollen)
    .filter((k) => k.partei === 'KANZLEI')
    .flatMap((k) => [k.durchfuehrendId, k.vertretungId, k.gegenzeichnerId])
    .filter((id): id is string => !!id);
  const personen: EinrichtungPersonen = {
    berufstraegerId: e.berufstraegerId ?? null,
    bearbeitungId: e.bearbeitungId ?? null,
    kanzlei: [e.vertretungId, ...gewaehlt].filter((id): id is string => !!id),
  };
  const { umfeld, gvIds } = await baueUmfeld(ctx.tx, mandant, personen, heute);
  const darfBearbeiten = kannBearbeiten(ctx.akteur, mandantId);
  const programmView = programm
    ? {
        id: programm.id,
        status: programm.status,
        version1Am: iso(programm.version1Am),
        createdAt: programm.createdAt.toISOString(),
      }
    : null;
  if (eingerichtet(programm)) {
    return {
      programm: programmView,
      eingerichtet: true,
      entwurf: null,
      plan: null,
      pruefung: [],
      gesetzlicheVertreter: gvIds,
      darfBearbeiten,
    };
  }
  const entwurf = leseEntwurf(programm?.setupEntwurf, heute, aufbauRollen(umfeld).gv);
  return {
    programm: programmView,
    eingerichtet: false,
    entwurf,
    plan: planView(berechnePlan(entwurf, umfeld)),
    pruefung: [1, 2, 3, 4, 5].map((n) => ({
      schritt: n,
      fehler: pruefeAlle(n, entwurf, umfeld, gvIds),
    })),
    gesetzlicheVertreter: gvIds,
    darfBearbeiten,
  };
}

/**
 * Speichert einen Schritt in den Entwurf. `weiter` prüft den Schritt und
 * schließt ihn ab (unvollständig → `UNGUELTIG`, nichts gespeichert); Profil-
 * oder Risikoänderungen verlangen eine erneute Bestätigung der Folgeschritte.
 */
export async function speichereEinrichtungsschritt(
  ctx: DienstKontext,
  eingabe: EntwurfSpeichernEingabe,
): Promise<EntwurfSpeichernErgebnis> {
  const e = pruefeEingabe(EntwurfSpeichernEingabeSchema, eingabe);
  const mandantId = e.mandantId.toLowerCase();
  const mandant = await kanzleiZugriff(ctx, mandantId, true);
  const heute = heuteDatum(ctx.uhr);
  // TS-05: bestehendes Programm unter Zeilensperre prüfen und ändern.
  const programm = await ladeProgramm(ctx.tx, mandantId, true);
  if (eingerichtet(programm)) throw new DienstFehler('KONFLIKT', BEREITS_EINGERICHTET);
  const { umfeld, gvIds } = await baueUmfeld(ctx.tx, mandant, e.personen, heute);
  const alt = leseEntwurf(programm?.setupEntwurf, heute, aufbauRollen(umfeld).gv);
  const neu: SetupEntwurf = { ...alt };
  let geaendert = false;
  switch (e.schritt) {
    case 1:
      neu.teilbereich = e.daten.teilbereich;
      neu.zeitraum = e.daten.zeitraum;
      geaendert =
        !inhaltGleich(alt.teilbereich, neu.teilbereich) ||
        !inhaltGleich(alt.zeitraum, neu.zeitraum);
      break;
    case 2: {
      const { profil, fehler } = leseEinrichtungsProfil(e.daten.profil);
      if (!profil) fachlichUngueltig('Das Geschäftsprofil ist unvollständig.', 'schritt2', fehler);
      neu.profil = profil;
      geaendert = !inhaltGleich(alt.profil, neu.profil);
      break;
    }
    case 3:
      neu.ziele = e.daten.ziele;
      neu.freigabe = {
        anfordern: e.daten.freigabe.anfordern,
        empfaengerId: klein(e.daten.freigabe.empfaengerId),
      };
      geaendert = !inhaltGleich(alt.ziele, neu.ziele) || !inhaltGleich(alt.freigabe, neu.freigabe);
      break;
    case 4: {
      const unbekannt = Object.keys(e.daten.risiken).filter((c) => !katalogRisiko(c));
      if (unbekannt.length)
        fachlichUngueltig(
          'Unbekannte Risiken.',
          'risiken',
          unbekannt.map((c) => `${c}: kein Risiko des Katalogs.`),
        );
      neu.risiken = { ...alt.risiken, ...e.daten.risiken };
      geaendert = !inhaltGleich(alt.risiken, neu.risiken);
      break;
    }
    case 5:
      neu.kontrollen = kontrollenKanonisch(e.daten.kontrollen);
      geaendert = !inhaltGleich(alt.kontrollen, neu.kontrollen);
      break;
  }

  if (e.ziel === 'weiter') {
    const f = pruefeAlle(e.schritt, neu, umfeld, gvIds);
    if (f.length)
      fachlichUngueltig(
        `Schritt ${e.schritt} ist noch nicht vollständig.`,
        `schritt${e.schritt}`,
        f,
      );
    const obergrenze = e.schritt === 2 && geaendert ? 3 : e.schritt === 4 && geaendert ? 4 : 5;
    neu.abgeschlossen = Math.max(e.schritt, Math.min(alt.abgeschlossen, obergrenze));
  } else if (geaendert) {
    neu.abgeschlossen = Math.min(alt.abgeschlossen, e.schritt - 1);
  }
  neu.gespeichertVon = ctx.akteur.id;

  return mitAudit(ctx, async (tx, zeitpunkt) => {
    const protokolle: Protokoll[] = [];
    neu.gespeichertAm = zeitpunkt.toISOString();
    let programmId = programm?.id ?? null;
    if (!programmId) {
      const p = await konfliktBeiEindeutigkeit(
        'Das Programm wurde inzwischen angelegt. Bitte neu laden.',
        () =>
          tx.tcmsProgramm.create({
            data: {
              mandantId,
              paketId: PAKET.id,
              paketVersion: PAKET.version,
              status: 'ENTWURF',
              erklaerungsTurnus: neu.zeitraum.erklaerungsTurnus,
              setupEntwurf: neu as unknown as Prisma.InputJsonValue,
              createdAt: zeitpunkt,
            },
            select: { id: true },
          }),
      );
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
      const r = await tx.tcmsProgramm.updateMany({
        where: { id: programmId, status: 'ENTWURF', version1Am: null },
        data: {
          setupEntwurf: neu as unknown as Prisma.InputJsonValue,
          erklaerungsTurnus: neu.zeitraum.erklaerungsTurnus,
        },
      });
      if (r.count !== 1) throw new DienstFehler('KONFLIKT', BEREITS_EINGERICHTET);
    }
    protokolle.push({
      aktion: 'tcms.setup.entwurf_gespeichert',
      objektTyp: 'TcmsProgramm',
      objektId: programmId,
      programmId,
      detail: { schritt: e.schritt, aktion: e.ziel, abgeschlossen: neu.abgeschlossen, geaendert },
    });
    return {
      wert: { programmId, angelegt: !programm, abgeschlossen: neu.abgeschlossen, geaendert },
      protokoll: protokolle,
    };
  });
}

/**
 * Legt Version 1 an (Teilbereich, Ziele, Profil, Risiken, Kontrollen,
 * Durchführungen und ggf. Freigabe der Ziele). Genau einmal je Mandant.
 */
export async function legeProgrammAn(
  ctx: DienstKontext,
  eingabe: ProgrammAnlegenEingabe,
): Promise<ProgrammAnlegenErgebnis> {
  const e = pruefeEingabe(ProgrammAnlegenEingabeSchema, eingabe);
  const mandantId = e.mandantId.toLowerCase();
  const mandant = await kanzleiZugriff(ctx, mandantId, true);
  const heute = heuteDatum(ctx.uhr);
  // TS-05: Sperre auf die Programmzeile; ein paralleles Anlegen wartet und sieht dann AKTIV.
  const programm = await ladeProgramm(ctx.tx, mandantId, true);
  if (eingerichtet(programm)) throw new DienstFehler('KONFLIKT', BEREITS_EINGERICHTET);
  if (!programm) {
    fachlichUngueltig('Version 1 kann noch nicht angelegt werden.', 'version1', [
      'Bitte zuerst die Schritte 1 bis 4 mit „Weiter" abschließen.',
    ]);
  }
  const { umfeld, gvIds } = await baueUmfeld(ctx.tx, mandant, e.personen, heute);
  const alt = leseEntwurf(programm.setupEntwurf, heute, aufbauRollen(umfeld).gv);
  const neu: SetupEntwurf = { ...alt, kontrollen: kontrollenKanonisch(e.daten.kontrollen) };
  if (alt.abgeschlossen < 4) {
    fachlichUngueltig('Version 1 kann noch nicht angelegt werden.', 'version1', [
      'Bitte zuerst die Schritte 1 bis 4 mit „Weiter" abschließen.',
    ]);
  }
  const alle: string[] = [];
  for (const n of [1, 2, 3, 4, 5])
    for (const f of pruefeAlle(n, neu, umfeld, gvIds)) alle.push(`Schritt ${n}: ${f}`);
  const plan = berechnePlan(neu, umfeld);
  if (!plan.zeitraum) alle.push('Schritt 1: Zeiträume fehlen.');
  if (!plan.risiken.some((x) => x.uebernehmen))
    alle.push('Schritt 4: Mindestens ein Risiko übernehmen.');
  if (alle.length)
    fachlichUngueltig('Version 1 kann noch nicht angelegt werden.', 'version1', alle);
  neu.abgeschlossen = 5;
  neu.gespeichertVon = ctx.akteur.id;

  return mitAudit(ctx, async (tx, zeitpunkt) => {
    neu.gespeichertAm = zeitpunkt.toISOString();
    const r = await tx.tcmsProgramm.updateMany({
      where: { id: programm.id, status: 'ENTWURF', version1Am: null },
      data: {
        setupEntwurf: neu as unknown as Prisma.InputJsonValue,
        erklaerungsTurnus: neu.zeitraum.erklaerungsTurnus,
      },
    });
    if (r.count !== 1) throw new DienstFehler('KONFLIKT', BEREITS_EINGERICHTET);
    const v1 = await schreibeVersion1(tx, {
      programmId: programm.id,
      e: neu,
      plan,
      u: umfeld,
      nutzer: { id: ctx.akteur.id },
      zeitpunkt,
    });
    return {
      wert: {
        programmId: programm.id,
        risiken: v1.risiken,
        abgelehnt: v1.abgelehnt,
        kontrollen: v1.kontrollen,
        durchfuehrungen: v1.durchfuehrungen,
        ziele: v1.ziele,
        freigabeId: v1.freigabeId,
      },
      protokoll: [
        {
          aktion: 'tcms.setup.entwurf_gespeichert',
          objektTyp: 'TcmsProgramm',
          objektId: programm.id,
          programmId: programm.id,
          detail: { schritt: 5, aktion: 'anlegen', abgeschlossen: 5, geaendert: true },
        },
        ...v1.protokolle,
      ],
    };
  });
}
