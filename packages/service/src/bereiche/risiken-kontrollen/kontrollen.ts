// =============================================================================
// Fachoperationen Kontrollmatrix (S6), bisher
// apps/web/src/server/actions/kontrollen.ts.
//
// - Jede Änderung schreibt einen neuen Kontrollstand fort (Regel 3).
// - Frequenzen werden berechnet (Vorlage × Häufigkeitsmatrix); eine
//   Abweichung ist ein beantragter Wert mit Begründung, den eine zweite
//   Person freigibt (Regel 2, 4).
// - Bei geänderter Frequenz werden künftige, unberührte Durchführungen neu
//   geplant; abgeschlossene bleiben unverändert (Fachkonzept §6).
// - TS-05: Kontrolle (SELECT … FOR UPDATE) sperren, Zustand unter der Sperre
//   lesen; Stände bedingt schließen, eindeutige Schlüssel gegen Gabelung.
// =============================================================================

import {
  AbweichungAufhebenSchema,
  AbweichungBeantragenSchema,
  AbweichungEntscheidenSchema,
  DesignBeurteilenSchema,
  DienstFehler,
  nichtBerechtigt,
  VerantwortlicheAendernSchema,
  type AbweichungAufheben,
  type AbweichungBeantragen,
  type AbweichungEntscheiden,
  type DesignBeurteilen,
  type KontrolleGeaendert,
  type VerantwortlicheAendern,
} from '@tcms/contract';
import type { Tx } from '@tcms/db';
import { frequenzLabel, gleicheFrequenz, mindestensSoStreng, type Frequenz } from '@tcms/domain';
import { mitAudit, type Protokoll } from '../../audit';
import { heuteDatum } from '../../kern/zeit';
import type { DienstKontext } from '../../kontext';
import { gleicheId, zweitePerson } from '../../rechte';
import {
  kanonisch,
  konflikt,
  konfliktSicher,
  pruefeBearbeiten,
  pruefeEingabe,
  programmDes,
  sperreKontrollen,
  ZWEITE_PERSON,
} from './gemeinsam';
import {
  abweichungOffen,
  aktuelleRisikenDerKontrolle,
  antragDerAbweichung,
  effektiveFrequenz,
  neuerKontrollStand,
  offenerKontrollStand,
  planeDurchfuehrungenNeu,
  type KontrolleStandRoh,
} from './planung';

const OHNE_ABWEICHUNG = {
  abweichungTurnus: null,
  abweichungAnlass: null,
  abweichungBegruendung: null,
  abweichungFreigegebenVon: null,
} as const;

/**
 * Sperrt die Kontrolle (nur, wenn sie zum Programm des Mandanten gehört) und
 * liest sie mit offenem Stand unter der Sperre. Entfallene Kontrollen sind
 * nicht änderbar; ein anderer als der gesehene Stand ergibt KONFLIKT.
 */
async function kontrolleUnterSperre(
  tx: Tx,
  mandantId: string,
  kontrolleId: string,
  standId: string,
  jetzt: Date,
) {
  const programm = await programmDes(tx, mandantId);
  await sperreKontrollen(tx, programm.id, [kontrolleId]);
  const k = await tx.kontrolle.findFirst({
    where: { id: kontrolleId, programmId: programm.id },
    include: { programm: { select: { id: true, erklaerungsTurnus: true } } },
  });
  if (!k) throw new DienstFehler('NICHT_GEFUNDEN');
  if (k.entfallenAb && k.entfallenAb.getTime() <= jetzt.getTime()) {
    throw konflikt('Die Kontrolle ist entfallen.');
  }
  const alt = await offenerKontrollStand(tx, k.id);
  // TS-05: nur auf dem Stand, den die Person gesehen hat.
  if (alt.id !== standId)
    throw konflikt('Die Kontrolle wurde inzwischen geändert. Bitte neu laden.');
  return { k, alt };
}

function ergebnis(
  kontrolleId: string,
  neu: KontrolleStandRoh,
  frequenz: Frequenz,
  neuplanung: KontrolleGeaendert['neuplanung'],
): KontrolleGeaendert {
  return {
    kontrolleId,
    standId: neu.id,
    version: neu.version,
    frequenz: { turnus: frequenz.turnus, anlass: frequenz.anlass },
    neuplanung,
  };
}

// -----------------------------------------------------------------------------
// Designbeurteilung
// -----------------------------------------------------------------------------

/** Designbeurteilung (angemessen oder Mangel) mit Person, Datum und Begründung. */
export async function designBeurteilen(
  ctx: DienstKontext,
  eingabe: DesignBeurteilen,
): Promise<KontrolleGeaendert> {
  const e = pruefeEingabe(DesignBeurteilenSchema, eingabe);
  const mandantId = kanonisch(e.mandantId);
  pruefeBearbeiten(ctx.akteur, mandantId);
  return konfliktSicher(() =>
    mitAudit(ctx, async (tx, zeitpunkt) => {
      const { k, alt } = await kontrolleUnterSperre(
        tx,
        mandantId,
        e.kontrolleId,
        e.standId,
        zeitpunkt,
      );
      const neu = await neuerKontrollStand(
        tx,
        alt,
        {
          design: e.design,
          designVon: ctx.akteur.id,
          designAm: zeitpunkt,
          designBegruendung: e.begruendung,
        },
        zeitpunkt,
        ctx.akteur.id,
      );
      const risiken = await aktuelleRisikenDerKontrolle(tx, k.id, zeitpunkt);
      const { frequenz } = effektiveFrequenz(neu, risiken, k.programm.erklaerungsTurnus);
      return {
        wert: ergebnis(k.id, neu, frequenz, null),
        protokoll: {
          aktion: 'tcms.kontrolle.design',
          objektTyp: 'Kontrolle',
          objektId: k.id,
          programmId: k.programmId,
          detail: {
            code: k.code,
            vorher: alt.design,
            nachher: e.design,
            begruendung: e.begruendung,
            version: neu.version,
          },
        },
      };
    }),
  );
}

// -----------------------------------------------------------------------------
// Frequenzabweichung (Vier-Augen)
// -----------------------------------------------------------------------------

/**
 * Beantragt eine Frequenzabweichung. Eine Kontrolle unter der Matrixfrequenz
 * ist zulässig, braucht aber Begründung und Freigabe durch eine zweite Person
 * (Fachkonzept §6); bis dahin gilt die berechnete Frequenz.
 */
export async function frequenzAbweichungBeantragen(
  ctx: DienstKontext,
  eingabe: AbweichungBeantragen,
): Promise<KontrolleGeaendert> {
  const e = pruefeEingabe(AbweichungBeantragenSchema, eingabe);
  const mandantId = kanonisch(e.mandantId);
  pruefeBearbeiten(ctx.akteur, mandantId);
  const ziel: Frequenz = { turnus: e.turnus, anlass: e.anlass };
  if (ziel.turnus === 'KEIN' && !ziel.anlass) {
    throw new DienstFehler(
      'UNGUELTIG',
      'Eine Kontrolle ohne Turnus braucht mindestens die Prüfung bei Auslösung.',
      { anlass: ['ohne Turnus Pflicht'] },
    );
  }
  return konfliktSicher(() =>
    mitAudit(ctx, async (tx, zeitpunkt) => {
      const { k, alt } = await kontrolleUnterSperre(
        tx,
        mandantId,
        e.kontrolleId,
        e.standId,
        zeitpunkt,
      );
      if (alt.abweichungTurnus != null) {
        throw konflikt(
          abweichungOffen(alt)
            ? 'Es ist bereits eine Abweichung beantragt.'
            : 'Es besteht bereits eine freigegebene Abweichung – bitte zuerst aufheben.',
        );
      }
      const risiken = await aktuelleRisikenDerKontrolle(tx, k.id, zeitpunkt);
      const { ableitung, frequenz } = effektiveFrequenz(alt, risiken, k.programm.erklaerungsTurnus);
      if (gleicheFrequenz(ziel, frequenz)) {
        throw new DienstFehler(
          'UNGUELTIG',
          `Die gewählte Frequenz entspricht der abgeleiteten (${frequenzLabel(frequenz)}).`,
          { turnus: ['entspricht der abgeleiteten Frequenz'] },
        );
      }
      const unterMatrix = !mindestensSoStreng(ziel, ableitung.mindest);
      const neu = await neuerKontrollStand(
        tx,
        alt,
        {
          abweichungTurnus: ziel.turnus,
          abweichungAnlass: ziel.anlass,
          abweichungBegruendung: e.begruendung,
          abweichungFreigegebenVon: null,
        },
        zeitpunkt,
        ctx.akteur.id,
      );
      return {
        wert: ergebnis(k.id, neu, frequenz, null),
        protokoll: {
          aktion: 'tcms.kontrolle.abweichung_beantragt',
          objektTyp: 'Kontrolle',
          objektId: k.id,
          programmId: k.programmId,
          detail: {
            code: k.code,
            abgeleitet: frequenzLabel(frequenz),
            mindest: frequenzLabel(ableitung.mindest),
            beantragt: frequenzLabel(ziel),
            unterMatrix,
            begruendung: e.begruendung,
            version: neu.version,
          },
        },
      };
    }),
  );
}

/**
 * Entscheidet über eine beantragte Frequenzabweichung: nur eine zweite Person
 * (≠ beantragend, aus den Ständen unter der Sperre ermittelt). Freigabe plant
 * künftige Durchführungen neu; Ablehnung braucht eine Begründung. Genau eine
 * von gleichzeitigen Entscheidungen wirkt.
 */
export async function frequenzAbweichungEntscheiden(
  ctx: DienstKontext,
  eingabe: AbweichungEntscheiden,
): Promise<KontrolleGeaendert> {
  const e = pruefeEingabe(AbweichungEntscheidenSchema, eingabe);
  const mandantId = kanonisch(e.mandantId);
  pruefeBearbeiten(ctx.akteur, mandantId);
  return konfliktSicher(() =>
    mitAudit(ctx, async (tx, zeitpunkt) => {
      const { k, alt } = await kontrolleUnterSperre(
        tx,
        mandantId,
        e.kontrolleId,
        e.standId,
        zeitpunkt,
      );
      if (!abweichungOffen(alt)) throw konflikt('Es ist keine Frequenzabweichung beantragt.');
      const staende = await tx.kontrolleStand.findMany({
        where: { kontrolleId: k.id, gueltigAb: { lte: alt.gueltigAb } },
        orderBy: { version: 'asc' },
      });
      const antrag = antragDerAbweichung(staende);
      if (!zweitePerson(ctx.akteur, antrag.von)) {
        throw nichtBerechtigt('VIER_AUGEN', ZWEITE_PERSON);
      }
      const ziel: Frequenz = {
        turnus: alt.abweichungTurnus!,
        anlass: alt.abweichungAnlass ?? false,
      };
      const risiken = await aktuelleRisikenDerKontrolle(tx, k.id, zeitpunkt);
      const vorher = effektiveFrequenz(alt, risiken, k.programm.erklaerungsTurnus);

      if (e.entscheidung === 'ABLEHNEN') {
        const neu = await neuerKontrollStand(tx, alt, OHNE_ABWEICHUNG, zeitpunkt, ctx.akteur.id);
        return {
          wert: ergebnis(k.id, neu, vorher.frequenz, null),
          protokoll: {
            aktion: 'tcms.kontrolle.abweichung_abgelehnt',
            objektTyp: 'Kontrolle',
            objektId: k.id,
            programmId: k.programmId,
            detail: {
              code: k.code,
              beantragtVon: antrag.von,
              beantragt: frequenzLabel(ziel),
              begruendung: e.begruendung ?? '',
              version: neu.version,
            },
          },
        };
      }

      const unterMatrix = !mindestensSoStreng(ziel, vorher.ableitung.mindest);
      const neu = await neuerKontrollStand(
        tx,
        alt,
        { abweichungFreigegebenVon: ctx.akteur.id },
        zeitpunkt,
        ctx.akteur.id,
      );
      const protokolle: Protokoll[] = [
        {
          aktion: 'tcms.kontrolle.abweichung_freigegeben',
          objektTyp: 'Kontrolle',
          objektId: k.id,
          programmId: k.programmId,
          detail: {
            code: k.code,
            beantragtVon: antrag.von,
            vorher: frequenzLabel(vorher.frequenz),
            nachher: frequenzLabel(ziel),
            mindest: frequenzLabel(vorher.ableitung.mindest),
            unterMatrix,
            version: neu.version,
            ...(e.begruendung ? { begruendung: e.begruendung } : {}),
          },
        },
      ];
      let neuplanung: KontrolleGeaendert['neuplanung'] = null;
      if (vorher.frequenz.turnus !== ziel.turnus) {
        neuplanung = await planeDurchfuehrungenNeu(tx, {
          programmId: k.programmId,
          kontrolleId: k.id,
          code: k.code,
          standId: neu.id,
          faelligNachTagen: neu.faelligNachTagen,
          turnusVorher: vorher.frequenz.turnus,
          turnusNachher: ziel.turnus,
          heute: heuteDatum(ctx.uhr),
          zeitpunkt,
        });
        if (neuplanung)
          protokolle.push({
            aktion: 'tcms.kontrolle.neu_geplant',
            objektTyp: 'Kontrolle',
            objektId: k.id,
            programmId: k.programmId,
            detail: { ...neuplanung, anlass: 'Frequenzabweichung freigegeben' },
          });
      }
      return { wert: ergebnis(k.id, neu, ziel, neuplanung), protokoll: protokolle };
    }),
  );
}

/** Hebt eine freigegebene Abweichung auf; es gilt wieder die berechnete Frequenz. */
export async function frequenzAbweichungAufheben(
  ctx: DienstKontext,
  eingabe: AbweichungAufheben,
): Promise<KontrolleGeaendert> {
  const e = pruefeEingabe(AbweichungAufhebenSchema, eingabe);
  const mandantId = kanonisch(e.mandantId);
  pruefeBearbeiten(ctx.akteur, mandantId);
  return konfliktSicher(() =>
    mitAudit(ctx, async (tx, zeitpunkt) => {
      const { k, alt } = await kontrolleUnterSperre(
        tx,
        mandantId,
        e.kontrolleId,
        e.standId,
        zeitpunkt,
      );
      if (alt.abweichungTurnus == null || !alt.abweichungFreigegebenVon) {
        throw konflikt('Es besteht keine freigegebene Abweichung.');
      }
      const risiken = await aktuelleRisikenDerKontrolle(tx, k.id, zeitpunkt);
      const vorher = effektiveFrequenz(alt, risiken, k.programm.erklaerungsTurnus);
      const neu = await neuerKontrollStand(tx, alt, OHNE_ABWEICHUNG, zeitpunkt, ctx.akteur.id);
      const nachher = effektiveFrequenz(neu, risiken, k.programm.erklaerungsTurnus);
      const protokolle: Protokoll[] = [
        {
          aktion: 'tcms.kontrolle.abweichung_aufgehoben',
          objektTyp: 'Kontrolle',
          objektId: k.id,
          programmId: k.programmId,
          detail: {
            code: k.code,
            vorher: frequenzLabel(vorher.frequenz),
            nachher: frequenzLabel(nachher.frequenz),
            begruendung: e.begruendung,
            version: neu.version,
          },
        },
      ];
      let neuplanung: KontrolleGeaendert['neuplanung'] = null;
      if (vorher.frequenz.turnus !== nachher.frequenz.turnus) {
        neuplanung = await planeDurchfuehrungenNeu(tx, {
          programmId: k.programmId,
          kontrolleId: k.id,
          code: k.code,
          standId: neu.id,
          faelligNachTagen: neu.faelligNachTagen,
          turnusVorher: vorher.frequenz.turnus,
          turnusNachher: nachher.frequenz.turnus,
          heute: heuteDatum(ctx.uhr),
          zeitpunkt,
        });
        if (neuplanung)
          protokolle.push({
            aktion: 'tcms.kontrolle.neu_geplant',
            objektTyp: 'Kontrolle',
            objektId: k.id,
            programmId: k.programmId,
            detail: { ...neuplanung, anlass: 'Frequenzabweichung aufgehoben' },
          });
      }
      return { wert: ergebnis(k.id, neu, nachher.frequenz, neuplanung), protokoll: protokolle };
    }),
  );
}

// -----------------------------------------------------------------------------
// Verantwortliche Personen
// -----------------------------------------------------------------------------

function ungueltig(meldung: string, feld: string): DienstFehler {
  return new DienstFehler('UNGUELTIG', meldung, { [feld]: [meldung] });
}

/**
 * Kanzleipersonen sind IDs der kanzleikonsole; der Dienst kennt sie nicht und
 * prüft nur die UUID-Form (Schema). Zusätzlich fail closed: ein Kontakt
 * dieses Mandanten (aktive oder frühere Rolle) ist keine Kanzleiperson. Die
 * Prüfung bleibt bewusst auf den Mandanten der Anfrage beschränkt; eine
 * tenantweite Suche verriete, ob eine ID bei einem anderen Mandanten als
 * Kontakt existiert (Existenz-Orakel).
 */
export async function pruefeKanzleiPersonen(
  tx: Tx,
  mandantId: string,
  ids: readonly { id: string; feld: string }[],
): Promise<void> {
  if (ids.length === 0) return;
  const kontakte = await tx.mandantKontaktRolle.findMany({
    where: { mandantId, kontaktId: { in: ids.map((x) => x.id) } },
    select: { kontaktId: true },
  });
  for (const x of ids) {
    if (kontakte.some((k) => gleicheId(k.kontaktId, x.id))) {
      throw ungueltig('Diese Person ist keine Person der Kanzlei.', x.feld);
    }
  }
}

/** Mandantenseite: Kontakte mit aktiver Rolle bei genau diesem Mandanten. */
async function pruefeMandantPersonen(
  tx: Tx,
  mandantId: string,
  ids: readonly { id: string; feld: string }[],
): Promise<void> {
  const aktiv = await tx.mandantKontaktRolle.findMany({
    where: { mandantId, aktiv: true, kontaktId: { in: ids.map((x) => x.id) } },
    select: { kontaktId: true },
  });
  for (const x of ids) {
    if (!aktiv.some((k) => gleicheId(k.kontaktId, x.id))) {
      throw ungueltig('Diese Person hat keine aktive Rolle beim Mandanten.', x.feld);
    }
  }
}

/**
 * Ändert durchführende Person, Vertretung und Gegenzeichnung einer Kontrolle
 * (neuer Stand). Die Seite (`partei`) aus der Eingabe muss zum gesperrten
 * Kontrollstand passen (sonst KONFLIKT). Die Personen müssen zur Partei der Kontrolle passen:
 * Mandantenseite = aktive Rolle bei diesem Mandanten, Kanzleiseite = kein
 * Mandantenkontakt. Vier-Augen: Gegenzeichnung nie durch die durchführende
 * Person; Schlüsselkontrollen brauchen eine Gegenzeichnung.
 */
export async function verantwortlicheAendern(
  ctx: DienstKontext,
  eingabe: VerantwortlicheAendern,
): Promise<KontrolleGeaendert> {
  const e = pruefeEingabe(VerantwortlicheAendernSchema, eingabe);
  const mandantId = kanonisch(e.mandantId);
  const durchfuehrendId = kanonisch(e.durchfuehrendId);
  const vertretungId = kanonisch(e.vertretungId);
  const gegenzeichnerEingabe = e.gegenzeichnerId ? kanonisch(e.gegenzeichnerId) : null;
  pruefeBearbeiten(ctx.akteur, mandantId);
  if (durchfuehrendId === vertretungId) {
    throw ungueltig('Vertretung und durchführende Person müssen verschieden sein.', 'vertretungId');
  }
  return konfliktSicher(() =>
    mitAudit(ctx, async (tx, zeitpunkt) => {
      const { k, alt } = await kontrolleUnterSperre(
        tx,
        mandantId,
        e.kontrolleId,
        e.standId,
        zeitpunkt,
      );
      // TS-05: Die Personen sind für die Seite gewählt, die der Aufrufer gesehen
      // hat. Unter der Sperre geprüft: passt sie nicht zum Kontrollstand, gilt
      // keine Personenprüfung der anderen Seite – KONFLIKT, neu laden.
      if (alt.partei !== e.partei) {
        throw konflikt(
          'Die Seite der Kontrolle (Kanzlei/Mandant) passt nicht zum gesehenen Stand. Bitte neu laden.',
        );
      }
      if (e.gegenzeichnungMandant && alt.partei !== 'MANDANT') {
        throw ungueltig(
          'Eine Gegenzeichnung beim Mandanten gibt es nur bei Kontrollen des Mandanten.',
          'gegenzeichnungMandant',
        );
      }
      const gegenzeichnungMandant = e.gegenzeichnungMandant;
      // Bei Gegenzeichnung beim Mandanten bestätigt die Vertretung; der
      // gespeicherte Wert bleibt unverändert (wie bisher).
      const gegenzeichnerId = gegenzeichnungMandant ? alt.gegenzeichnerId : gegenzeichnerEingabe;

      const seite = [
        { id: durchfuehrendId, feld: 'durchfuehrendId' },
        { id: vertretungId, feld: 'vertretungId' },
      ];
      if (alt.partei === 'MANDANT') await pruefeMandantPersonen(tx, mandantId, seite);
      else await pruefeKanzleiPersonen(tx, mandantId, seite);

      if (!gegenzeichnungMandant) {
        if (alt.schluessel && !gegenzeichnerId) {
          throw ungueltig(
            'Schlüsselkontrollen brauchen eine gegenzeichnende Person.',
            'gegenzeichnerId',
          );
        }
        if (gegenzeichnerId) {
          if (gleicheId(gegenzeichnerId, durchfuehrendId)) {
            throw ungueltig(
              'Die gegenzeichnende Person darf nicht die durchführende sein.',
              'gegenzeichnerId',
            );
          }
          // Gegenzeichnung durch eine Person der Kanzlei (oder zweite Person beim Mandanten).
          await pruefeKanzleiPersonen(tx, mandantId, [
            { id: gegenzeichnerId, feld: 'gegenzeichnerId' },
          ]);
        }
      }
      if (
        alt.durchfuehrendId === durchfuehrendId &&
        alt.vertretungId === vertretungId &&
        alt.gegenzeichnerId === gegenzeichnerId &&
        alt.gegenzeichnungMandant === gegenzeichnungMandant
      ) {
        throw new DienstFehler('UNGUELTIG', 'Keine Änderung der Zuständigkeiten.');
      }
      const neu = await neuerKontrollStand(
        tx,
        alt,
        { durchfuehrendId, vertretungId, gegenzeichnerId, gegenzeichnungMandant },
        zeitpunkt,
        ctx.akteur.id,
      );
      const risiken = await aktuelleRisikenDerKontrolle(tx, k.id, zeitpunkt);
      const { frequenz } = effektiveFrequenz(neu, risiken, k.programm.erklaerungsTurnus);
      return {
        wert: ergebnis(k.id, neu, frequenz, null),
        protokoll: {
          aktion: 'tcms.kontrolle.zustaendigkeit',
          objektTyp: 'Kontrolle',
          objektId: k.id,
          programmId: k.programmId,
          // Nur IDs (ADR 0001 §5); Namen löst die kanzleikonsole auf.
          detail: {
            code: k.code,
            vorher: {
              durchfuehrend: alt.durchfuehrendId,
              vertretung: alt.vertretungId,
              gegenzeichnung: alt.gegenzeichnerId,
              gegenzeichnungMandant: alt.gegenzeichnungMandant,
            },
            nachher: {
              durchfuehrend: durchfuehrendId,
              vertretung: vertretungId,
              gegenzeichnung: gegenzeichnerId,
              gegenzeichnungMandant,
            },
            version: neu.version,
          },
        },
      };
    }),
  );
}
