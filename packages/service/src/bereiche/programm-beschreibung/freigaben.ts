// =============================================================================
// Freigaben und Kenntnisnahmen (Fachkonzept §10 P4, §13) als Service: Portal
// (offene Anforderungen lesen, Code anfordern, freigeben mit Code, zur
// Kenntnis nehmen) und Neuadressierung durch die Kanzlei. Bisher
// apps/web/src/server/actions/freigaben.ts.
//
// Sicherheit:
//   - Portal nur für Mandantenkontakte mit aktiver Rolle beim eigenen
//     Mandanten. Sichtbar: GV/TCB alle Anforderungen des Mandanten,
//     Mitarbeitende nur die an sie gerichteten; Unsichtbares, Fremdes und
//     Unbekanntes → `NICHT_GEFUNDEN`.
//   - TS-06: Freigeben, Code anfordern und Kenntnis nehmen nur durch die
//     adressierte Person (Vergleich der IDs); Freigaben zusätzlich nur durch
//     eine aktive gesetzliche Vertretung. Eine andere Person zieht keine
//     Anforderung an sich; die Kanzlei adressiert neu (eigene, auditierte
//     Aktion, setzt Code und Fehlversuche zurück).
//   - Codes: siehe code.ts. Prüfen, Zählen und Erledigen unter Zeilensperre
//     der Freigabe in einer Transaktion (TS-05), Code nur einmal verwendbar,
//     keine Codes in Antworten, Audit-Details oder Fehlermeldungen.
//   - Beschreibung: freigegeben wird nur ein eingefrorener Inhalt, dessen
//     SHA-256 zum gespeicherten Hash passt (fail closed); danach ist die
//     Version unveränderlich.
// =============================================================================

import {
  DienstFehler,
  nichtBerechtigt,
  FreigabeNeuadressierungEingabeSchema,
  PortalCodeAnfordernEingabeSchema,
  PortalFreigabenEingabeSchema,
  PortalFreigebenEingabeSchema,
  PortalKenntnisnahmeEingabeSchema,
  type FreigabeNeuadressierungEingabe,
  type PortalCodeAnfordernEingabe,
  type PortalCodeAnfordernErgebnis,
  type PortalFreigabenEingabe,
  type PortalFreigabenView,
  type PortalFreigabeView,
  type PortalFreigebenEingabe,
  type PortalFreigebenErgebnis,
  type PortalKenntnisnahmeEingabe,
} from '@tcms/contract';
import type { Freigabe, Tx } from '@tcms/db';
import { mitAudit, type Protokoll } from '../../audit';
import { ladeKontext } from '../../kern/tcms-kontext';
import type { DienstKontext } from '../../kontext';
import {
  gleicheId,
  istGesetzlicherVertreter,
  kannLesen,
  kannPortalLesen,
  type KontaktRolle,
} from '../../rechte';
import { halteRollenFest, ladeKontaktRollen } from '../../rollen';
import { baueBausteine, normalisiereAbschnitte, pruefeSnapshot } from './bausteine';
import {
  brauchtCodeSchluessel,
  CODE_ANFORDERUNG_FENSTER_MS,
  codeAblaufAb,
  codeHash,
  codePasst,
  codeStatus,
  codeVerfahrenGueltig,
  erzeugeCode,
  istGesperrt,
  leseCodeZustand,
  MAX_CODE_ANFORDERUNGEN_JE_STUNDE,
  MAX_FEHLVERSUCHE,
} from './code';
import {
  aktiveKontakte,
  fachlichUngueltig,
  iso,
  isoTagVon,
  kanzleiZugriff,
  nichtGefunden,
  portalZugriff,
  pruefeEingabe,
  sperreFreigabe,
} from './gemeinsam';
import { legeNachrichtAn } from './nachrichten';
import { codeNachrichtText, neuAdressiertText } from './texte';

/** Arten mit Freigabevorbehalt (Bestätigungscode, nur gesetzliche Vertretung). */
export const FREIGABE_CODE_ARTEN = [
  'ZIELE',
  'BESCHREIBUNG',
  'RISIKOAKZEPTANZ',
  'AUFKLAERUNG',
] as const;
export function freigabeBrauchtCode(art: string): boolean {
  return (FREIGABE_CODE_ARTEN as readonly string[]).includes(art);
}

const NUR_GV = 'Freigaben sind der gesetzlichen Vertretung vorbehalten.';
const ANDERE_PERSON = 'Diese Freigabe ist an eine andere Person gerichtet.';
const ERLEDIGT = 'Diese Freigabe ist bereits erledigt.';
const GESPERRT = `Der Bestätigungscode ist nach ${MAX_FEHLVERSUCHE} Fehlversuchen gesperrt. Bitte wenden Sie sich an Ihre Kanzlei.`;
const ABGELAUFEN = 'Der Code ist abgelaufen. Bitte fordern Sie einen neuen Code an.';
const ZU_VIELE_CODES = `Sie haben in der letzten Stunde bereits ${MAX_CODE_ANFORDERUNGEN_JE_STUNDE} Codes angefordert. Bitte verwenden Sie den zuletzt erhaltenen Code oder versuchen Sie es später erneut.`;

/**
 * Code-Nachrichten dieser Freigabe an diesen Kontakt in der letzten Stunde
 * (echte Zeit; Hinweis H1). Unter der Zeilensperre der Freigabe gezählt:
 * Gleichzeitige Anforderungen laufen nacheinander und sehen einander.
 */
async function codesDerLetztenStunde(
  tx: Tx,
  mandantId: string,
  freigabeId: string,
  kontaktId: string,
): Promise<number> {
  return tx.nachricht.count({
    where: {
      mandantId,
      empfaengerId: kontaktId.toLowerCase(),
      zweck: 'FREIGABE_CODE',
      createdAt: { gt: new Date(Date.now() - CODE_ANFORDERUNG_FENSTER_MS) },
      daten: { path: ['freigabeId'], equals: freigabeId },
    },
  });
}

/** Sichtbarkeit im Portal: GV/TCB alles des Mandanten, sonst nur Eigenes. */
function sichtbarImPortal(
  ctx: DienstKontext,
  mandantId: string,
  rollen: readonly KontaktRolle[],
  f: Pick<Freigabe, 'empfaengerId'>,
): boolean {
  return kannPortalLesen(ctx.akteur, mandantId, rollen) || gleicheId(f.empfaengerId, ctx.akteur.id);
}

/**
 * Gesperrte, sichtbare Freigabe des Portals (sonst `NICHT_GEFUNDEN`). Die
 * Rollen gelten erst, wie sie nach der Zeilensperre und unter
 * `halteRollenFest` gelesen sind (TS-05, RT4-T-05): Eine in der Wartezeit
 * entzogene Rolle zählt nicht mehr, und bis zum Commit wird keine entzogen.
 */
async function portalFreigabe(ctx: DienstKontext, mandantId: string, freigabeId: string) {
  const { mandant } = await portalZugriff(ctx, mandantId);
  const f = await sperreFreigabe(ctx.tx, mandantId, freigabeId);
  await halteRollenFest(ctx.tx, mandantId);
  const rollen = await ladeKontaktRollen(ctx.tx, ctx.akteur);
  if (!kannLesen(ctx.akteur, mandantId, rollen)) nichtGefunden();
  if (!sichtbarImPortal(ctx, mandantId, rollen, f)) nichtGefunden();
  return { f, rollen, mandant };
}

// ---------------------------------------------------------------------------
// Portal: lesen
// ---------------------------------------------------------------------------

export async function ladePortalFreigaben(
  ctx: DienstKontext,
  eingabe: PortalFreigabenEingabe,
): Promise<PortalFreigabenView> {
  const e = pruefeEingabe(PortalFreigabenEingabeSchema, eingabe);
  const mandantId = e.mandantId.toLowerCase();
  const { rollen } = await portalZugriff(ctx, mandantId);
  const a = ctx.akteur;
  const lesen = kannPortalLesen(a, mandantId, rollen);
  const istGv = istGesetzlicherVertreter(a, mandantId, rollen);
  const tx = ctx.tx;
  const programme = await tx.tcmsProgramm.findMany({
    where: { mandantId },
    select: { id: true },
    orderBy: { id: 'asc' },
  });
  const ids = programme.map((p) => p.id);
  const kontakte = await aktiveKontakte(tx, mandantId);
  const gesetzlicheVertreter = kontakte
    .filter((k) => k.rolle === 'GESETZLICHER_VERTRETER')
    .map((k) => k.kontaktId);
  const leer: PortalFreigabenView = {
    freigaben: [],
    fruehere: [],
    live: null,
    gesetzlicheVertreter,
    istGesetzlicherVertreter: istGv,
    kannPortalLesen: lesen,
    namen: [],
  };
  if (!ids.length) return leer;
  const [alle, versionen] = await Promise.all([
    tx.freigabe.findMany({
      where: { programmId: { in: ids } },
      orderBy: [{ angefordertAm: 'desc' }, { id: 'asc' }],
    }),
    tx.beschreibungVersion.findMany({
      where: { programmId: { in: ids } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    }),
  ]);
  const freigaben = alle.filter((f) => lesen || gleicheId(f.empfaengerId, a.id));
  const versionJe = new Map(versionen.map((v) => [v.id, v]));
  const jetzt = new Date(); // Codefristen: echte Zeit
  const views: PortalFreigabeView[] = freigaben.map((f) => {
    const code = freigabeBrauchtCode(f.art);
    const istEmpfaenger = gleicheId(f.empfaengerId, a.id);
    const offen = f.status === 'OFFEN';
    const darfFreigeben = code && offen && istEmpfaenger && istGv;
    const darfKenntnisnehmen = !code && offen && istEmpfaenger;
    const sperrgrund = !offen
      ? null
      : code
        ? !istGv
          ? NUR_GV
          : !istEmpfaenger
            ? ANDERE_PERSON
            : null
        : !istEmpfaenger
          ? 'Diese Kenntnisnahme ist an eine andere Person gerichtet.'
          : null;
    const z = leseCodeZustand(f);
    const v = f.art === 'BESCHREIBUNG' ? versionJe.get(f.refId) : undefined;
    return {
      id: f.id,
      art: f.art,
      titel: f.titel,
      inhalt: f.inhalt,
      status: f.status,
      angefordertVon: f.angefordertVon,
      angefordertAm: f.angefordertAm.toISOString(),
      empfaengerId: f.empfaengerId,
      erledigtAm: iso(f.erledigtAm),
      anmerkung: f.anmerkung,
      brauchtCode: code,
      istEmpfaenger,
      darfFreigeben,
      darfKenntnisnehmen,
      sperrgrund,
      code:
        code && istEmpfaenger
          ? {
              status: codeStatus(f, jetzt, ctx.codes),
              ablauf: iso(f.codeAblauf),
              verbleibendeVersuche: Math.max(0, MAX_FEHLVERSUCHE - z.fehlversuche),
            }
          : null,
      version:
        v && v.programmId === f.programmId
          ? {
              id: v.id,
              nummer: v.nummer,
              status: v.status,
              abschnitte: normalisiereAbschnitte(v.abschnitte),
              snapshot:
                (v.snapshot as unknown as NonNullable<PortalFreigabeView['version']>['snapshot']) ??
                null,
              snapshotSha256: v.snapshotSha256,
              snapshotGeprueft: pruefeSnapshot(v.snapshot, v.snapshotSha256),
              freigegebenVon: v.freigegebenVon,
              freigegebenAm: iso(v.freigegebenAm),
            }
          : null,
    };
  });
  const mitDatensatz = new Set(
    alle.filter((f) => f.art === 'BESCHREIBUNG' && f.status === 'FREIGEGEBEN').map((f) => f.refId),
  );
  const fruehere = lesen
    ? versionen
        .filter((v) => v.freigegebenAm && v.freigegebenVon && !mitDatensatz.has(v.id))
        .map((v) => ({
          id: v.id,
          nummer: v.nummer,
          status: v.status,
          freigegebenVon: v.freigegebenVon!,
          freigegebenAm: v.freigegebenAm!.toISOString(),
          snapshotSha256: v.snapshotSha256,
        }))
        .reverse()
    : [];
  // Offene Beschreibung ohne Snapshot (Altbestand): lebende Bausteine zur Ansicht.
  const ohneSnapshot = views.some((f) => f.status === 'OFFEN' && f.version && !f.version.snapshot);
  let live: PortalFreigabenView['live'] = null;
  if (ohneSnapshot && lesen) {
    const k = await ladeKontext(ctx, { mandantId });
    if (k.programm) {
      live = {
        stand: isoTagVon(k.stand),
        bausteine: baueBausteine(k, {
          name: (id) => (id && k.namen.get(id)) || '—',
          verantwortung: { berufstraeger: null, bearbeitung: null },
        }),
      };
    }
  }
  const personen = new Set<string>();
  for (const f of views) {
    personen.add(f.angefordertVon);
    personen.add(f.empfaengerId);
    if (f.version?.freigegebenVon) personen.add(f.version.freigegebenVon);
  }
  for (const v of fruehere) personen.add(v.freigegebenVon);
  for (const g of gesetzlicheVertreter) personen.add(g);
  const namen = personen.size ? await ctx.personen.namen([...personen].sort()) : new Map();
  return {
    ...leer,
    freigaben: views,
    fruehere,
    live,
    namen: [...namen].map(([id, name]) => ({ id: String(id), name: String(name) })),
  };
}

// ---------------------------------------------------------------------------
// Portal: Code anfordern
// ---------------------------------------------------------------------------

/**
 * Vorgelegte Version einer Beschreibungsfreigabe (Nummer und SHA-256 des
 * eingefrorenen Inhalts) für die Vorlagendaten der Nachricht; sonst null.
 */
async function vorgelegteVersion(
  tx: Tx,
  f: Pick<Freigabe, 'art' | 'refId' | 'programmId'>,
): Promise<{ version: string | null; sha256: string | null }> {
  if (f.art !== 'BESCHREIBUNG') return { version: null, sha256: null };
  const v = await tx.beschreibungVersion.findFirst({
    where: { id: f.refId, programmId: f.programmId },
    select: { nummer: true, snapshotSha256: true },
  });
  return { version: v?.nummer ?? null, sha256: v?.snapshotSha256 ?? null };
}

/** Prüft die Handlungsrechte für eine Freigabe mit Code (Reihenfolge = Fehlermeldung). */
function pruefeFreigabeRecht(
  ctx: DienstKontext,
  mandantId: string,
  rollen: readonly KontaktRolle[],
  f: Freigabe,
): void {
  if (!freigabeBrauchtCode(f.art)) {
    fachlichUngueltig('Für eine Kenntnisnahme ist kein Code nötig.', 'freigabeId', [
      'Diese Anforderung ist eine Kenntnisnahme.',
    ]);
  }
  if (f.status !== 'OFFEN') throw new DienstFehler('KONFLIKT', ERLEDIGT);
  if (!istGesetzlicherVertreter(ctx.akteur, mandantId, rollen))
    throw nichtBerechtigt('PORTAL_ROLLE', NUR_GV);
  // TS-06: nur die adressierte Person; eine Neuadressierung ist Sache der Kanzlei.
  if (!gleicheId(f.empfaengerId, ctx.akteur.id))
    throw nichtBerechtigt('PORTAL_ZUGEORDNET', ANDERE_PERSON);
}

export async function fordereFreigabeCodeAn(
  ctx: DienstKontext,
  eingabe: PortalCodeAnfordernEingabe,
): Promise<PortalCodeAnfordernErgebnis> {
  const e = pruefeEingabe(PortalCodeAnfordernEingabeSchema, eingabe);
  const schluessel = brauchtCodeSchluessel(ctx.codes);
  const mandantId = e.mandantId.toLowerCase();
  const { f, rollen, mandant } = await portalFreigabe(ctx, mandantId, e.freigabeId);
  pruefeFreigabeRecht(ctx, mandantId, rollen, f);
  const z = leseCodeZustand(f);
  if (istGesperrt(z)) throw new DienstFehler('KONFLIKT', GESPERRT);
  // H1: Mengenbegrenzung je Freigabe und Kontakt (zusätzlich zur Fehlversuchsgrenze).
  if (
    (await codesDerLetztenStunde(ctx.tx, mandantId, f.id, ctx.akteur.id)) >=
    MAX_CODE_ANFORDERUNGEN_JE_STUNDE
  ) {
    throw new DienstFehler('KONFLIKT', ZU_VIELE_CODES);
  }
  const { version, sha256 } = await vorgelegteVersion(ctx.tx, f);
  // Neuer Code ersetzt den alten; die Fehlversuche dieser Freigabe bleiben stehen.
  const code = erzeugeCode();
  const codeAblauf = codeAblaufAb(new Date());
  return mitAudit(ctx, async (tx) => {
    // Bedingt auf den gelesenen Zustand (Hash und Zähler unter der Zeilensperre).
    const r = await tx.freigabe.updateMany({
      where: {
        id: f.id,
        status: 'OFFEN',
        empfaengerId: f.empfaengerId,
        codeHash: f.codeHash,
        codeSchluesselId: f.codeSchluesselId,
        codeFehlversuche: f.codeFehlversuche,
      },
      data: { ...codeHash(schluessel, f.id, code), codeAblauf },
    });
    if (r.count !== 1) throw new DienstFehler('KONFLIKT', ERLEDIGT);
    await legeNachrichtAn(tx, {
      mandantId,
      empfaengerId: ctx.akteur.id,
      zweck: 'FREIGABE_CODE',
      daten: {
        freigabeId: f.id,
        art: f.art,
        titel: f.titel,
        version,
        code,
        gueltigBis: codeAblauf.toISOString(),
        sha256,
      },
      ...codeNachrichtText({ mandant: mandant.name, titel: f.titel, code, codeAblauf, sha256 }),
    });
    return {
      wert: { freigabeId: f.id, codeAblauf: codeAblauf.toISOString() },
      protokoll: {
        aktion: 'tcms.freigabe.code_angefordert',
        objektTyp: 'Freigabe',
        objektId: f.id,
        programmId: f.programmId,
        detail: { art: f.art, titel: f.titel, codeAblauf: codeAblauf.toISOString() },
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Portal: freigeben mit Code
// ---------------------------------------------------------------------------

/**
 * Freigeben mit Bestätigungscode. Ein falscher Code wird gezählt und
 * protokolliert und liefert `freigegeben: false` (kein Fehler, damit Zähler
 * und Audit bestehen bleiben); nach MAX_FEHLVERSUCHE ist die Freigabe gesperrt.
 */
export async function erteileFreigabe(
  ctx: DienstKontext,
  eingabe: PortalFreigebenEingabe,
): Promise<PortalFreigebenErgebnis> {
  const e = pruefeEingabe(PortalFreigebenEingabeSchema, eingabe);
  const schluessel = brauchtCodeSchluessel(ctx.codes);
  const mandantId = e.mandantId.toLowerCase();
  const { f, rollen } = await portalFreigabe(ctx, mandantId, e.freigabeId);
  pruefeFreigabeRecht(ctx, mandantId, rollen, f);
  const z = leseCodeZustand(f);
  if (istGesperrt(z)) throw new DienstFehler('KONFLIKT', GESPERRT);
  if (!z.hash || !f.codeAblauf)
    throw new DienstFehler('KONFLIKT', 'Bitte fordern Sie zuerst einen Bestätigungscode an.');
  // H5: Code des früheren Verfahrens (ohne Schlüsselkennung) oder mit einem nicht mehr
  // konfigurierten Schlüssel gilt als abgelaufen – kein Fehlversuch, neuer Code nötig.
  if (!codeVerfahrenGueltig(schluessel, z)) throw new DienstFehler('KONFLIKT', ABGELAUFEN);
  // Echte Zeit: Die Demo-Uhr verlängert keine Codefrist.
  if (f.codeAblauf.getTime() < Date.now()) throw new DienstFehler('KONFLIKT', ABGELAUFEN);

  // Beschreibung: nur ein eingefrorener, unverfälschter Inhalt kann freigegeben
  // werden – vor dem Codevergleich, damit kein Versuch verbraucht wird.
  let version: {
    id: string;
    nummer: string;
    programmId: string;
    createdAt: Date;
    snapshotSha256: string;
  } | null = null;
  if (f.art === 'BESCHREIBUNG') {
    const v = await ctx.tx.beschreibungVersion.findFirst({
      where: { id: f.refId, programmId: f.programmId },
    });
    if (!v || v.status !== 'BEIM_MANDANTEN')
      throw new DienstFehler('KONFLIKT', 'Diese Version liegt nicht mehr zur Freigabe vor.');
    if (!v.snapshot || !v.snapshotSha256 || pruefeSnapshot(v.snapshot, v.snapshotSha256) !== true) {
      throw new DienstFehler(
        'KONFLIKT',
        'Der vorgelegte Inhalt ist nicht eingefroren oder nicht unverändert. Die Kanzlei muss die Freigabe neu anfordern.',
      );
    }
    version = {
      id: v.id,
      nummer: v.nummer,
      programmId: v.programmId,
      createdAt: v.createdAt,
      snapshotSha256: v.snapshotSha256,
    };
  }

  if (!codePasst(schluessel, f.id, e.code, z)) {
    const versuch = z.fehlversuche + 1;
    const sperren = versuch >= MAX_FEHLVERSUCHE;
    return mitAudit(ctx, async (tx) => {
      // Bedingt auf den gelesenen Zustand: Unter der Zeilensperre kann ihn niemand
      // zwischenzeitlich ändern; ohne Treffer bleibt nichts gezählt (fail closed).
      const r = await tx.freigabe.updateMany({
        where: {
          id: f.id,
          status: 'OFFEN',
          codeHash: f.codeHash,
          codeSchluesselId: f.codeSchluesselId,
          codeFehlversuche: f.codeFehlversuche,
        },
        data: sperren
          ? { codeFehlversuche: versuch, codeHash: null, codeSchluesselId: null, codeAblauf: null }
          : { codeFehlversuche: versuch },
      });
      if (r.count !== 1) throw new DienstFehler('KONFLIKT', 'Der Code ist nicht mehr gültig.');
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
      return {
        wert: {
          freigegeben: false as const,
          freigabeId: f.id,
          grund: sperren ? ('GESPERRT' as const) : ('CODE_FALSCH' as const),
          verbleibendeVersuche: Math.max(0, MAX_FEHLVERSUCHE - versuch),
        },
        protokoll,
      };
    });
  }

  return mitAudit(ctx, async (tx, zeitpunkt) => {
    // Code einmal verwendbar: Status, Person und genau dieser Codezustand sind Bedingung.
    const r = await tx.freigabe.updateMany({
      where: {
        id: f.id,
        status: 'OFFEN',
        empfaengerId: f.empfaengerId,
        codeHash: f.codeHash,
        codeSchluesselId: f.codeSchluesselId,
        codeFehlversuche: f.codeFehlversuche,
        codeAblauf: { gte: new Date() },
      },
      data: {
        status: 'FREIGEGEBEN',
        erledigtAm: zeitpunkt,
        codeHash: null,
        codeSchluesselId: null,
        codeAblauf: null,
      },
    });
    if (r.count !== 1)
      throw new DienstFehler(
        'KONFLIKT',
        'Die Freigabe ist bereits erledigt oder der Code ist nicht mehr gültig.',
      );
    const protokoll: Protokoll[] = [
      {
        aktion: 'tcms.freigabe.erteilt',
        objektTyp: 'Freigabe',
        objektId: f.id,
        programmId: f.programmId,
        detail: { art: f.art, titel: f.titel, bestaetigung: 'E-Mail-Code' },
      },
    ];
    if (version) {
      const u = await tx.beschreibungVersion.updateMany({
        where: { id: version.id, status: 'BEIM_MANDANTEN', snapshotSha256: version.snapshotSha256 },
        data: { status: 'FREIGEGEBEN', freigegebenVon: ctx.akteur.id, freigegebenAm: zeitpunkt },
      });
      if (u.count !== 1)
        throw new DienstFehler('KONFLIKT', 'Diese Version liegt nicht mehr zur Freigabe vor.');
      // Vorgänger (freigegeben oder noch beim Mandanten) werden abgelöst.
      const vorgaenger = await tx.beschreibungVersion.findMany({
        where: {
          programmId: version.programmId,
          id: { not: version.id },
          createdAt: { lt: version.createdAt },
          status: { in: ['FREIGEGEBEN', 'BEIM_MANDANTEN'] },
        },
        select: { id: true, nummer: true, status: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      for (const a of vorgaenger) {
        await tx.beschreibungVersion.updateMany({
          where: { id: a.id, status: a.status },
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
              codeSchluesselId: null,
              codeAblauf: null,
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
          snapshotSha256: version.snapshotSha256,
        },
      });
    }
    if (f.art === 'ZIELE') {
      // refId: Teilbereich (alle noch nicht freigegebenen Ziele) oder ein Ziel – je im Programm.
      const ziel = await tx.complianceZiel.findFirst({
        where: { id: f.refId, teilbereich: { programmId: f.programmId } },
        select: { id: true },
      });
      const z = await tx.complianceZiel.updateMany({
        where: {
          ...(ziel ? { id: ziel.id } : { teilbereichId: f.refId }),
          teilbereich: { programmId: f.programmId },
          freigabe: { not: 'FREIGEGEBEN' },
        },
        data: { freigabe: 'FREIGEGEBEN', freigegebenAm: zeitpunkt, freigegebenVon: ctx.akteur.id },
      });
      protokoll.push({
        aktion: 'tcms.ziele.freigegeben',
        objektTyp: 'Freigabe',
        objektId: f.id,
        programmId: f.programmId,
        detail: { ziele: z.count },
      });
    }
    return {
      wert: { freigegeben: true as const, freigabeId: f.id, erledigtAm: zeitpunkt.toISOString() },
      protokoll,
    };
  });
}

// ---------------------------------------------------------------------------
// Portal: Kenntnisnahme
// ---------------------------------------------------------------------------

export async function bestaetigeKenntnisnahme(
  ctx: DienstKontext,
  eingabe: PortalKenntnisnahmeEingabe,
): Promise<{ freigabeId: string; erledigtAm: string }> {
  const e = pruefeEingabe(PortalKenntnisnahmeEingabeSchema, eingabe);
  const mandantId = e.mandantId.toLowerCase();
  const { f } = await portalFreigabe(ctx, mandantId, e.freigabeId);
  if (f.art !== 'KENNTNISNAHME') {
    fachlichUngueltig('Diese Anforderung ist eine Freigabe mit Bestätigungscode.', 'freigabeId', [
      'Keine Kenntnisnahme.',
    ]);
  }
  if (!gleicheId(f.empfaengerId, ctx.akteur.id))
    throw nichtBerechtigt(
      'PORTAL_ZUGEORDNET',
      'Diese Kenntnisnahme ist an eine andere Person gerichtet.',
    );
  if (f.status !== 'OFFEN')
    throw new DienstFehler('KONFLIKT', 'Diese Kenntnisnahme ist bereits bestätigt.');
  return mitAudit(ctx, async (tx, zeitpunkt) => {
    const r = await tx.freigabe.updateMany({
      where: { id: f.id, status: 'OFFEN', empfaengerId: f.empfaengerId },
      data: { status: 'FREIGEGEBEN', erledigtAm: zeitpunkt },
    });
    if (r.count !== 1)
      throw new DienstFehler('KONFLIKT', 'Diese Kenntnisnahme ist bereits bestätigt.');
    return {
      wert: { freigabeId: f.id, erledigtAm: zeitpunkt.toISOString() },
      protokoll: {
        aktion: 'tcms.freigabe.kenntnisnahme',
        objektTyp: 'Freigabe',
        objektId: f.id,
        programmId: f.programmId,
        detail: { titel: f.titel, refId: f.refId },
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Kanzlei: Neuadressierung (TS-06)
// ---------------------------------------------------------------------------

/**
 * Richtet eine offene Anforderung an eine andere (oder dieselbe) Person des
 * Mandanten. Ein ausgestellter Code verfällt, die Fehlversuche beginnen neu
 * (Entsperren nach MAX_FEHLVERSUCHE). Freigaben nur an aktive gesetzliche
 * Vertretungen, Kenntnisnahmen an Kontakte mit aktiver Rolle.
 */
export async function adressiereFreigabeNeu(
  ctx: DienstKontext,
  eingabe: FreigabeNeuadressierungEingabe,
): Promise<{ freigabeId: string; vorherId: string; empfaengerId: string }> {
  const e = pruefeEingabe(FreigabeNeuadressierungEingabeSchema, eingabe);
  const mandantId = e.mandantId.toLowerCase();
  const empfaengerId = e.empfaengerId.toLowerCase();
  const mandant = await kanzleiZugriff(ctx, mandantId, true);
  const f = await sperreFreigabe(ctx.tx, mandantId, e.freigabeId);
  if (f.status !== 'OFFEN')
    throw new DienstFehler('KONFLIKT', 'Diese Anforderung ist bereits erledigt.');
  const code = freigabeBrauchtCode(f.art);
  // TS-05 (RT4-T-06): Rolle des Empfängers unter derselben Sperre wie die Rollenpflege prüfen.
  await halteRollenFest(ctx.tx, mandantId);
  const kontakte = await aktiveKontakte(ctx.tx, mandantId);
  const passt = kontakte.some(
    (k) => k.kontaktId === empfaengerId && (!code || k.rolle === 'GESETZLICHER_VERTRETER'),
  );
  if (!passt) {
    fachlichUngueltig('Empfänger ungültig.', 'empfaengerId', [
      code
        ? 'Die Freigabe erteilt nur eine gesetzliche Vertretung des Mandanten.'
        : 'Die Kenntnisnahme richtet sich an einen Kontakt des Mandanten mit aktiver Rolle.',
    ]);
  }
  const { version } = await vorgelegteVersion(ctx.tx, f);
  return mitAudit(ctx, async (tx) => {
    const r = await tx.freigabe.updateMany({
      where: { id: f.id, status: 'OFFEN', empfaengerId: f.empfaengerId },
      data: {
        empfaengerId,
        codeHash: null,
        codeSchluesselId: null,
        codeAblauf: null,
        codeFehlversuche: 0,
      },
    });
    if (r.count !== 1) throw new DienstFehler('KONFLIKT', 'Diese Anforderung hat sich geändert.');
    await legeNachrichtAn(tx, {
      mandantId,
      empfaengerId,
      zweck: 'FREIGABE_NEU_ADRESSIERT',
      daten: { freigabeId: f.id, art: f.art, titel: f.titel, version },
      ...neuAdressiertText({ mandant: mandant.name, titel: f.titel, brauchtCode: code }),
    });
    return {
      wert: { freigabeId: f.id, vorherId: f.empfaengerId, empfaengerId },
      protokoll: {
        aktion: 'tcms.freigabe.neu_adressiert',
        objektTyp: 'Freigabe',
        objektId: f.id,
        programmId: f.programmId,
        detail: {
          art: f.art,
          vorherId: f.empfaengerId,
          empfaengerId,
          codeZurueckgesetzt: f.codeHash !== null || f.codeFehlversuche > 0,
        },
      },
    };
  });
}
