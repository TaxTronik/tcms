// =============================================================================
// Arbeitskorb (`POST /v1/arbeitskorb`): eigene Aufgaben der Person über die
// von der kanzleikonsole bestätigten Mandanten. Quelle sind die aktuellen
// Kontexte (blockweise, `jeAktuellerKontext`) plus wenige Zusatzfelder
// (Antragsteller von Frequenzabweichungen und Verwerfen-Anträgen), beide nur
// für Programme der geladenen Mandanten. Zuständigkeit: eigene Zuweisung an
// Objekten oder `bt`/`hb` aus der Liste. Keine Leistungsvergleiche – nur die
// eigenen Aufgaben; Personen nur als IDs.
// =============================================================================

import {
  ArbeitskorbAntwortSchema,
  type Akteur,
  type ArbeitskorbAntwort,
  type MandantenListe,
} from '@tcms/contract';
import {
  frequenzLabel,
  isoDatum,
  KLASSE_LABEL,
  tageZwischen,
  type AnzeigeStatus,
} from '@tcms/domain';
import {
  jeAktuellerKontext,
  type FeststellungView,
  type TcmsKontext,
} from '../../kern/tcms-kontext';
import { heuteDatum } from '../../kern/zeit';
import type { DienstKontext } from '../../kontext';
import {
  gleicheId,
  istBerufstraeger,
  kannBearbeiten,
  kannGegenzeichnen,
  kannWuerdigen,
  liestAlleVertraulichen,
  zweitePerson,
} from '../../rechte';
import { alsJson, antwortNach } from './hilfen';
import { zugaengeAusListe } from './zugang';

type Korb = ArbeitskorbAntwort;
/** Interne Zeilen mit `Date`; `alsJson` bildet sie in die Antwort ab. */
interface KorbRoh {
  durchfuehrungen: (Omit<Korb['durchfuehrungen'][number], 'faelligAm'> & { faelligAm: Date })[];
  gegenzeichnungen: (Omit<Korb['gegenzeichnungen'][number], 'faelligAm' | 'eingereichtAm'> & {
    faelligAm: Date;
    eingereichtAm: Date | null;
  })[];
  vierAugen: (Omit<Korb['vierAugen'][number], 'beantragtAm'> & { beantragtAm: Date | null })[];
  p153: (Omit<Korb['p153'][number], 'erfasstAm'> & { erfasstAm: Date })[];
  p153BeiAnderen: Korb['p153BeiAnderen'];
  ereignisse: (Omit<Korb['ereignisse'][number], 'gemeldetAm'> & { gemeldetAm: Date })[];
  beschreibungen: (Omit<Korb['beschreibungen'][number], 'angefordertAm'> & {
    angefordertAm: Date | null;
  })[];
  mandantenZustaendig: number;
}

const OFFEN_ODER_FAELLIG: readonly AnzeigeStatus[] = [
  'FAELLIG',
  'IN_DURCHFUEHRUNG',
  'ZURUECKGEWIESEN',
  'UEBERFAELLIG',
];

interface AbweichungsStand {
  kontrolleId: string;
  gueltigAb: Date;
  erstelltVon: string | null;
  abweichungTurnus: string | null;
  abweichungAnlass: boolean | null;
  abweichungBegruendung: string | null;
  abweichungFreigegebenVon: string | null;
}

function gleicheAbweichung(a: AbweichungsStand, b: AbweichungsStand): boolean {
  return (
    a.abweichungTurnus === b.abweichungTurnus &&
    (a.abweichungAnlass ?? false) === (b.abweichungAnlass ?? false) &&
    a.abweichungBegruendung === b.abweichungBegruendung &&
    a.abweichungFreigegebenVon === b.abweichungFreigegebenVon
  );
}

/**
 * Wer die offene Frequenzabweichung beantragt hat: der früheste Stand der
 * ununterbrochenen Folge mit derselben offenen Abweichung (spätere Stände
 * können durch Design- oder Personenänderungen entstanden sein). Gleiche
 * Regel wie die Kontrollhistorie der Demo (`antragDerAbweichung`).
 */
function abweichungsAntrag(aufsteigend: readonly AbweichungsStand[]): {
  von: string | null;
  am: Date | null;
} {
  const letzter = aufsteigend[aufsteigend.length - 1];
  if (!letzter || letzter.abweichungTurnus == null || letzter.abweichungFreigegebenVon) {
    return { von: null, am: null };
  }
  let i = aufsteigend.length - 1;
  while (i > 0 && gleicheAbweichung(aufsteigend[i - 1]!, letzter)) i--;
  return { von: aufsteigend[i]!.erstelltVon, am: aufsteigend[i]!.gueltigAb };
}

/** Arbeitskorb über die bestätigten Mandanten (nur Kanzleipersonen). */
export async function ladeArbeitskorb(
  ctx: DienstKontext,
  eingabe: MandantenListe,
): Promise<ArbeitskorbAntwort> {
  const zugaenge = zugaengeAusListe(ctx.akteur, eingabe);
  const heute = heuteDatum(ctx.uhr);
  const kontexte: { k: TcmsKontext; nutzer: Akteur }[] = [];
  // Nur Mandanten mit Programm bleiben; der Kontext wird für die Zusatzfelder gebraucht.
  await jeAktuellerKontext(ctx, zugaenge, (k, nutzer) => {
    if (k.programm) kontexte.push({ k, nutzer });
  });

  const programmIds = kontexte.map((c) => c.k.programm!.id);
  const abweichungsKontrollIds = kontexte.flatMap((c) =>
    c.k.kontrollen.filter((x) => x.abweichung && !x.abweichung.freigegebenVon).map((x) => x.id),
  );
  const abweichungsStaende: AbweichungsStand[] = abweichungsKontrollIds.length
    ? await ctx.tx.kontrolleStand.findMany({
        where: { kontrolleId: { in: abweichungsKontrollIds } },
        orderBy: [{ gueltigAb: 'asc' }, { id: 'asc' }],
        select: {
          kontrolleId: true,
          gueltigAb: true,
          erstelltVon: true,
          abweichungTurnus: true,
          abweichungAnlass: true,
          abweichungBegruendung: true,
          abweichungFreigegebenVon: true,
        },
      })
    : [];
  const verwerfen = programmIds.length
    ? await ctx.tx.feststellung.findMany({
        where: {
          programmId: { in: programmIds },
          verwerfenBeantragtVon: { not: null },
          verwerfenBestaetigtVon: null,
          status: { not: 'VERWORFEN' },
        },
        select: {
          id: true,
          programmId: true,
          nummer: true,
          titel: true,
          verwerfenBegruendung: true,
          verwerfenBeantragtVon: true,
          vertraulich: true,
        },
        orderBy: [{ nummer: 'asc' }, { id: 'asc' }],
      })
    : [];
  const staendeJe = new Map<string, AbweichungsStand[]>();
  for (const st of abweichungsStaende) {
    staendeJe.set(st.kontrolleId, [...(staendeJe.get(st.kontrolleId) ?? []), st]);
  }

  const korb: KorbRoh = {
    durchfuehrungen: [],
    gegenzeichnungen: [],
    vierAugen: [],
    p153: [],
    p153BeiAnderen: { anzahl: 0, mandantIds: [] },
    ereignisse: [],
    beschreibungen: [],
    mandantenZustaendig: 0,
  };

  // Titel und Begründung vertraulicher Feststellungen in Verwerfen-Anträgen nur
  // für die Kanzleileitung (tcms-s12); für alle anderen ohne beides wie bisher
  // (Fachkonzept §13 – der Eintrag hat keine maskierte Variante).
  const vertraulichLesbar = liestAlleVertraulichen(ctx.akteur);
  for (const { k: c, nutzer } of kontexte) {
    if (nutzer.art !== 'KANZLEI' || !nutzer.mandant) continue;
    const m = c.mandant;
    const mandant = { id: m.id, name: m.name };
    const zustaendig = nutzer.mandant.zustaendigBerufstraeger || nutzer.mandant.hauptbearbeitung;
    const darfBearbeiten = kannBearbeiten(nutzer, m.id);
    if (zustaendig) korb.mandantenZustaendig++;
    const kontrolleJe = new Map(c.kontrollen.map((x) => [x.id, x]));

    // ---- Durchführungen, für die die Person verantwortlich ist ----
    for (const d of c.durchfuehrungen) {
      if (!gleicheId(d.durchgefuehrtVon ?? d.durchfuehrendId, nutzer.id)) continue;
      const tage = tageZwischen(heute, d.faelligAm);
      const relevant =
        OFFEN_ODER_FAELLIG.includes(d.anzeige) || (d.anzeige === 'GEPLANT' && tage <= 14);
      if (!relevant) continue;
      korb.durchfuehrungen.push({
        mandant,
        id: d.id,
        code: d.code,
        titel: d.titel,
        periode: d.periodeLabel,
        faelligAm: d.faelligAm,
        tage,
        anzeige: d.anzeige,
        schluessel: d.schluessel,
        nachweise: d.nachweise,
        mindestNachweise: d.mindestNachweise,
      });
    }

    // ---- Gegenzeichnungen, die die Person leisten darf ----
    for (const d of c.durchfuehrungen) {
      if (d.anzeige !== 'ZUR_GEGENZEICHNUNG') continue;
      const kontrolle = kontrolleJe.get(d.kontrolleId);
      if (!kontrolle) continue;
      const recht = kannGegenzeichnen(
        nutzer,
        kontrolle,
        m.id,
        d.durchgefuehrtVon,
        !!d.mandantBestaetigtVon,
      );
      if (!recht.erlaubt) continue;
      if (
        !gleicheId(kontrolle.gegenzeichnerId, nutzer.id) &&
        !(istBerufstraeger(nutzer) && zustaendig)
      )
        continue;
      korb.gegenzeichnungen.push({
        mandant,
        id: d.id,
        code: d.code,
        titel: d.titel,
        periode: d.periodeLabel,
        faelligAm: d.faelligAm,
        tage: tageZwischen(heute, d.faelligAm),
        anzeige: d.anzeige,
        schluessel: d.schluessel,
        nachweise: d.nachweise,
        mindestNachweise: d.mindestNachweise,
        durchgefuehrtVon: d.durchgefuehrtVon,
        eingereichtAm: d.eingereichtAm,
      });
    }

    // ---- Vier-Augen-Bestätigungen (zweite Person) ----
    if (zustaendig && darfBearbeiten) {
      for (const r of c.risiken) {
        for (const u of r.uebersteuerungen) {
          if (u.status !== 'BEANTRAGT' || !zweitePerson(nutzer, u.beantragtVon)) continue;
          korb.vierAugen.push({
            mandant,
            art: 'UEBERSTEUERUNG',
            key: u.id,
            objektId: r.id,
            titel: `${r.code} · ${r.titel}`,
            detail: `Netto (${u.sicht === 'DESIGN' ? 'Design' : 'Betrieb'}) ${KLASSE_LABEL[u.berechnet]} → ${KLASSE_LABEL[u.klasse]}`,
            begruendung: u.begruendung,
            beantragtVon: [u.beantragtVon],
            beantragtAm: u.beantragtAm,
          });
        }
      }
      for (const x of c.kontrollen) {
        if (!x.abweichung || x.abweichung.freigegebenVon) continue;
        const info = abweichungsAntrag(staendeJe.get(x.id) ?? []);
        if (!zweitePerson(nutzer, info.von)) continue;
        korb.vierAugen.push({
          mandant,
          art: 'FREQUENZ',
          key: x.standId,
          objektId: x.id,
          titel: `${x.code} · ${x.titel}`,
          detail: `Matrix ${frequenzLabel(x.ableitung.effektiv)} → beantragt ${frequenzLabel(x.abweichung.frequenz)}`,
          begruendung: x.abweichung.begruendung,
          beantragtVon: info.von ? [info.von] : [],
          beantragtAm: info.am,
        });
      }
      for (const f of verwerfen.filter((x) => x.programmId === c.programm!.id)) {
        if (!zweitePerson(nutzer, f.verwerfenBeantragtVon)) continue;
        const ohneInhalt = f.vertraulich && !vertraulichLesbar;
        korb.vierAugen.push({
          mandant,
          art: 'VERWERFEN',
          key: f.id,
          objektId: f.id,
          // Vertrauliche Feststellungen ohne Titel und Begründung (Fachkonzept §13),
          // außer für die Kanzleileitung (tcms-s12).
          titel: `${f.nummer} · ${ohneInhalt ? 'vertrauliche Feststellung' : f.titel}`,
          detail: 'Feststellung verwerfen',
          begruendung: ohneInhalt ? null : f.verwerfenBegruendung,
          beantragtVon: f.verwerfenBeantragtVon ? [f.verwerfenBeantragtVon] : [],
          beantragtAm: null,
        });
      }
      const zurFreigabe = c.risiken.filter(
        (r) => r.freigabe === 'ZUR_FREIGABE' && zweitePerson(nutzer, r.freigabeEingereichtVon),
      );
      if (zurFreigabe.length > 0) {
        korb.vierAugen.push({
          mandant,
          art: 'RISIKOFREIGABE',
          key: `rf-${m.id}`,
          objektId: null,
          titel: `${zurFreigabe.length} ${zurFreigabe.length === 1 ? 'Risiko' : 'Risiken'} zur Freigabe des Inventars`,
          detail:
            zurFreigabe
              .map((r) => r.code)
              .slice(0, 6)
              .join(', ') + (zurFreigabe.length > 6 ? ' …' : ''),
          begruendung: null,
          beantragtVon: [
            ...new Set(
              zurFreigabe.map((r) => r.freigabeEingereichtVon).filter((x): x is string => !!x),
            ),
          ],
          beantragtAm: null,
        });
      }
    }

    // ---- §-153-Würdigungen ----
    // Nur lesbare Feststellungen (RT-01): Maskierte tragen keine Steuerwirkung.
    // Wer zuständig ist (BT oder Hauptbearbeitung), gehört ohnehin zum Kreis
    // der Beteiligten (`kannVertraulichLesen`) und sieht alle, ebenso die
    // Kanzleileitung (tcms-s12).
    const p153 = c.feststellungen.filter((f): f is FeststellungView => !f.maskiert && f.p153Offen);
    if (p153.length > 0) {
      if (kannWuerdigen(nutzer, m.id) && zustaendig) {
        for (const f of p153) {
          korb.p153.push({
            mandant,
            id: f.id,
            nummer: f.nummer,
            titel: f.titel,
            schwere: f.schwere,
            auswirkung: f.auswirkung,
            vertraulich: f.vertraulich,
            erfasstAm: f.erfasstAm,
          });
        }
      } else if (zustaendig) {
        korb.p153BeiAnderen.anzahl += p153.length;
        korb.p153BeiAnderen.mandantIds.push(m.id);
      }
    }

    // ---- Neue Ereignisse ----
    if (zustaendig) {
      for (const e of c.ereignisse) {
        if (e.status !== 'NEU') continue;
        korb.ereignisse.push({
          mandant,
          id: e.id,
          nummer: e.nummer,
          typ: e.typ,
          titel: e.titel,
          quelle: e.quelle,
          gemeldetVon: e.gemeldetVon,
          gemeldetAm: e.gemeldetAm,
        });
      }
    }

    // ---- Beschreibungen im Kanzlei-Review ----
    if (zustaendig && darfBearbeiten) {
      for (const b of c.beschreibungen) {
        if (b.status !== 'KANZLEI_REVIEW') continue;
        if (gleicheId(b.reviewAngefordertVon, nutzer.id)) continue;
        korb.beschreibungen.push({
          mandant,
          id: b.id,
          nummer: b.nummer,
          angefordertVon: b.reviewAngefordertVon,
          angefordertAm: b.reviewAngefordertAm,
        });
      }
    }
  }

  const rang = (a: AnzeigeStatus) =>
    a === 'UEBERFAELLIG'
      ? 0
      : a === 'ZURUECKGEWIESEN'
        ? 1
        : a === 'IN_DURCHFUEHRUNG'
          ? 2
          : a === 'FAELLIG'
            ? 3
            : 4;
  korb.durchfuehrungen.sort(
    (a, b) =>
      rang(a.anzeige) - rang(b.anzeige) ||
      a.faelligAm.getTime() - b.faelligAm.getTime() ||
      a.code.localeCompare(b.code),
  );
  korb.gegenzeichnungen.sort(
    (a, b) => (a.eingereichtAm?.getTime() ?? 0) - (b.eingereichtAm?.getTime() ?? 0),
  );
  korb.p153.sort((a, b) => a.erfasstAm.getTime() - b.erfasstAm.getTime());
  korb.ereignisse.sort((a, b) => a.gemeldetAm.getTime() - b.gemeldetAm.getTime());
  return antwortNach(
    ArbeitskorbAntwortSchema,
    'ladeArbeitskorb',
    alsJson({ heute: isoDatum(heute), ...korb }),
  );
}
