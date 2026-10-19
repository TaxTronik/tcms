import 'server-only';
import { MAX_MANDANTEN_JE_ANFRAGE } from '@tcms/contract';
import {
  frequenzLabel,
  isoDatum,
  KLASSE_LABEL,
  tageZwischen,
  type AnzeigeStatus,
  type Klasse,
} from '@tcms/domain';
import {
  istBerufstraeger,
  kannBearbeiten,
  kannGegenzeichnen,
  kannWuerdigen,
  zweitePerson,
} from '@tcms/service';
import { fuerMandant, lies, type KanzleiAkteur } from './demo';
import { ladeKontext, personName, type TcmsKontext } from './kontext';
import { antragDerAbweichung } from './kontrollen-daten';
import { heute as heuteFn } from './zeit';

// =============================================================================
// Arbeitskorb der angemeldeten Person über alle Mandanten. Quelle sind die
// aktuellen Kontexte (ladeKontext) plus wenige Zusatzfelder aus der DB
// (Antragsteller von Frequenzabweichungen und Verwerfen-Anträgen).
// Zuständigkeit: eigene Zuweisung an Objekten oder Berufsträger/Hauptbearbeitung
// des Mandanten. Keine Leistungsvergleiche – nur die eigenen Aufgaben.
// =============================================================================

interface MandantRef {
  id: string;
  name: string;
}

export interface AkDurchfuehrung {
  mandant: MandantRef;
  id: string;
  code: string;
  titel: string;
  periode: string;
  faelligAm: Date;
  tage: number;
  anzeige: AnzeigeStatus;
  schluessel: boolean;
  nachweise: number;
  mindestNachweise: number;
  href: string;
}

export interface AkGegenzeichnung extends AkDurchfuehrung {
  durchgefuehrtVon: string;
  eingereichtAm: Date | null;
}

export type VierAugenArt = 'UEBERSTEUERUNG' | 'FREQUENZ' | 'VERWERFEN' | 'RISIKOFREIGABE';

export interface AkVierAugen {
  mandant: MandantRef;
  art: VierAugenArt;
  key: string;
  titel: string;
  detail: string;
  begruendung: string | null;
  beantragtVon: string;
  beantragtAm: Date | null;
  href: string;
}

export interface AkP153 {
  mandant: MandantRef;
  id: string;
  nummer: string;
  titel: string;
  schwere: Klasse;
  auswirkung: 'JA' | 'NEIN' | 'UNKLAR';
  vertraulich: boolean;
  erfasstAm: Date;
  href: string;
}

export interface AkEreignis {
  mandant: MandantRef;
  id: string;
  nummer: string;
  typ: string;
  titel: string;
  quelle: 'PORTAL' | 'KONTROLLE' | 'STAMMDATEN' | 'RSS' | 'MANUELL';
  gemeldetVon: string;
  gemeldetAm: Date;
  href: string;
}

export interface AkBeschreibung {
  mandant: MandantRef;
  id: string;
  nummer: string;
  angefordertVon: string;
  angefordertAm: Date | null;
  href: string;
}

export interface Arbeitskorb {
  heute: Date;
  durchfuehrungen: AkDurchfuehrung[];
  gegenzeichnungen: AkGegenzeichnung[];
  vierAugen: AkVierAugen[];
  p153: AkP153[];
  /** Für Personen ohne Würdigungsrecht: Anzahl offener Würdigungen in ihren Mandaten (nur Hinweis). */
  p153BeiAnderen: { anzahl: number; berufstraeger: string[] };
  ereignisse: AkEreignis[];
  beschreibungen: AkBeschreibung[];
  mandantenZustaendig: number;
}

const OFFEN_ODER_FAELLIG: readonly AnzeigeStatus[] = [
  'FAELLIG',
  'IN_DURCHFUEHRUNG',
  'ZURUECKGEWIESEN',
  'UEBERFAELLIG',
];

/**
 * Arbeitskorb über die zugänglichen Mandanten (ADR 0001 §3.3: Liste kommt von
 * der kanzleikonsole, höchstens 5 000). Rechte je Mandant über den Akteur mit
 * Bezug auf genau diesen Mandanten.
 */
export async function ladeArbeitskorb(
  person: KanzleiAkteur,
  zugaenglich: readonly string[],
): Promise<Arbeitskorb> {
  if (zugaenglich.length > MAX_MANDANTEN_JE_ANFRAGE) throw new Error('Zu viele Mandanten');
  const heute = heuteFn();
  const iso = isoDatum(heute);
  const mandanten = await lies((tx) =>
    tx.mandant.findMany({
      where: { aktiv: true, id: { in: [...zugaenglich] } },
      orderBy: { name: 'asc' },
      select: { id: true },
    }),
  );
  const kontexte = (await Promise.all(mandanten.map((m) => ladeKontext(m.id, iso, false)))).filter(
    (c): c is TcmsKontext => !!c && !!c.programm,
  );

  const programmIds = kontexte.map((c) => c.programm!.id);
  const abweichungsKontrollIds = kontexte.flatMap((c) =>
    c.kontrollen.filter((k) => k.abweichung && !k.abweichung.freigegebenVon).map((k) => k.id),
  );
  const [abweichungsStaende, verwerfen] = await lies((tx) =>
    Promise.all([
      abweichungsKontrollIds.length
        ? tx.kontrolleStand.findMany({
            where: { kontrolleId: { in: abweichungsKontrollIds } },
            orderBy: { gueltigAb: 'asc' },
          })
        : Promise.resolve([]),
      programmIds.length
        ? tx.feststellung.findMany({
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
          })
        : Promise.resolve([]),
    ]),
  );
  // Antragsteller:in = Person, die den Stand mit der (unveränderten) offenen Abweichung zuerst angelegt hat.
  const staendeJe = new Map<string, typeof abweichungsStaende>();
  for (const st of abweichungsStaende)
    staendeJe.set(st.kontrolleId, [...(staendeJe.get(st.kontrolleId) ?? []), st]);
  const antragJe = new Map([...staendeJe].map(([kid, liste]) => [kid, antragDerAbweichung(liste)]));

  const korb: Arbeitskorb = {
    heute,
    durchfuehrungen: [],
    gegenzeichnungen: [],
    vierAugen: [],
    p153: [],
    p153BeiAnderen: { anzahl: 0, berufstraeger: [] },
    ereignisse: [],
    beschreibungen: [],
    mandantenZustaendig: 0,
  };

  for (const ctx of kontexte) {
    const m = ctx.mandant;
    const mandant: MandantRef = { id: m.id, name: m.name };
    const basis = `/staff/clients/${m.id}/tcms`;
    const nutzer = fuerMandant(person, m.id);
    const zustaendig =
      !!nutzer.mandant &&
      (nutzer.mandant.zustaendigBerufstraeger || nutzer.mandant.hauptbearbeitung);
    const darfBearbeiten = kannBearbeiten(nutzer, m.id);
    if (zustaendig) korb.mandantenZustaendig++;
    const kontrolleJe = new Map(ctx.kontrollen.map((k) => [k.id, k]));

    // ---- Durchführungen, für die die Person verantwortlich ist ----
    for (const d of ctx.durchfuehrungen) {
      const verantwortlich = d.durchgefuehrtVon ?? d.durchfuehrendId;
      if (verantwortlich !== nutzer.id) continue;
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
        href: `${basis}/durchfuehrungen/${d.id}`,
      });
    }

    // ---- Gegenzeichnungen, die die Person leisten darf ----
    for (const d of ctx.durchfuehrungen) {
      if (d.anzeige !== 'ZUR_GEGENZEICHNUNG') continue;
      const k = kontrolleJe.get(d.kontrolleId);
      if (!k) continue;
      const recht = kannGegenzeichnen(
        nutzer,
        k,
        m.id,
        d.durchgefuehrtVon,
        !!d.mandantBestaetigtVon,
      );
      if (!recht.erlaubt) continue;
      if (k.gegenzeichnerId !== nutzer.id && !(istBerufstraeger(nutzer) && zustaendig)) continue;
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
        durchgefuehrtVon: personName(ctx, d.durchgefuehrtVon),
        eingereichtAm: d.eingereichtAm,
        href: `${basis}/durchfuehrungen/${d.id}`,
      });
    }

    // ---- Vier-Augen-Bestätigungen (zweite Person) ----
    if (zustaendig && darfBearbeiten) {
      for (const r of ctx.risiken) {
        for (const u of r.uebersteuerungen) {
          if (u.status !== 'BEANTRAGT' || !zweitePerson(nutzer, u.beantragtVon)) continue;
          korb.vierAugen.push({
            mandant,
            art: 'UEBERSTEUERUNG',
            key: u.id,
            titel: `${r.code} · ${r.titel}`,
            detail: `Netto (${u.sicht === 'DESIGN' ? 'Design' : 'Betrieb'}) ${KLASSE_LABEL[u.berechnet]} → ${KLASSE_LABEL[u.klasse]}`,
            begruendung: u.begruendung,
            beantragtVon: personName(ctx, u.beantragtVon),
            beantragtAm: u.beantragtAm,
            href: `${basis}/risiken?risiko=${r.id}`,
          });
        }
      }
      for (const k of ctx.kontrollen) {
        if (!k.abweichung || k.abweichung.freigegebenVon) continue;
        const info = antragJe.get(k.id);
        if (!zweitePerson(nutzer, info?.von)) continue;
        korb.vierAugen.push({
          mandant,
          art: 'FREQUENZ',
          key: k.standId,
          titel: `${k.code} · ${k.titel}`,
          detail: `Matrix ${frequenzLabel(k.ableitung.effektiv)} → beantragt ${frequenzLabel(k.abweichung.frequenz)}`,
          begruendung: k.abweichung.begruendung,
          beantragtVon: personName(ctx, info?.von),
          beantragtAm: info?.am ?? null,
          href: `${basis}/kontrollen?kontrolle=${k.id}`,
        });
      }
      for (const f of verwerfen.filter((x) => x.programmId === ctx.programm!.id)) {
        if (!zweitePerson(nutzer, f.verwerfenBeantragtVon)) continue;
        korb.vierAugen.push({
          mandant,
          art: 'VERWERFEN',
          key: f.id,
          titel: `${f.nummer} · ${f.vertraulich ? 'vertrauliche Feststellung' : f.titel}`,
          detail: 'Feststellung verwerfen',
          begruendung: f.vertraulich ? null : f.verwerfenBegruendung,
          beantragtVon: personName(ctx, f.verwerfenBeantragtVon),
          beantragtAm: null,
          href: `${basis}/feststellungen/${f.id}`,
        });
      }
      const zurFreigabe = ctx.risiken.filter(
        (r) => r.freigabe === 'ZUR_FREIGABE' && zweitePerson(nutzer, r.freigabeEingereichtVon),
      );
      if (zurFreigabe.length > 0) {
        const von = [
          ...new Set(zurFreigabe.map((r) => personName(ctx, r.freigabeEingereichtVon))),
        ].join(', ');
        korb.vierAugen.push({
          mandant,
          art: 'RISIKOFREIGABE',
          key: `rf-${m.id}`,
          titel: `${zurFreigabe.length} ${zurFreigabe.length === 1 ? 'Risiko' : 'Risiken'} zur Freigabe des Inventars`,
          detail:
            zurFreigabe
              .map((r) => r.code)
              .slice(0, 6)
              .join(', ') + (zurFreigabe.length > 6 ? ' …' : ''),
          begruendung: null,
          beantragtVon: von,
          beantragtAm: null,
          href: `${basis}/risiken`,
        });
      }
    }

    // ---- §-153-Würdigungen ----
    const p153 = ctx.feststellungen.filter((f) => f.p153Offen);
    if (p153.length > 0) {
      if (kannWuerdigen(nutzer, m.id) && (zustaendig || nutzer.id === m.berufstraegerId)) {
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
            href: `${basis}/feststellungen/${f.id}`,
          });
        }
      } else if (zustaendig) {
        korb.p153BeiAnderen.anzahl += p153.length;
        const bt = personName(ctx, m.berufstraegerId);
        if (!korb.p153BeiAnderen.berufstraeger.includes(bt))
          korb.p153BeiAnderen.berufstraeger.push(bt);
      }
    }

    // ---- Neue Ereignisse ----
    if (zustaendig) {
      for (const e of ctx.ereignisse) {
        if (e.status !== 'NEU') continue;
        korb.ereignisse.push({
          mandant,
          id: e.id,
          nummer: e.nummer,
          typ: e.typ,
          titel: e.titel,
          quelle: e.quelle,
          gemeldetVon: personName(ctx, e.gemeldetVon),
          gemeldetAm: e.gemeldetAm,
          href: `${basis}/ereignisse?e=${e.id}`,
        });
      }
    }

    // ---- Beschreibungen im Kanzlei-Review ----
    if (zustaendig && darfBearbeiten) {
      for (const b of ctx.beschreibungen) {
        if (b.status !== 'KANZLEI_REVIEW') continue;
        if (b.reviewAngefordertVon === nutzer.id) continue;
        korb.beschreibungen.push({
          mandant,
          id: b.id,
          nummer: b.nummer,
          angefordertVon: personName(ctx, b.reviewAngefordertVon),
          angefordertAm: b.reviewAngefordertAm,
          href: `${basis}/beschreibung`,
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
  return korb;
}
