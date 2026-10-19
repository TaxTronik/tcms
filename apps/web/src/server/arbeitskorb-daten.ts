import 'server-only';
import type { ArbeitskorbAntwort } from '@tcms/contract';
import type { AnzeigeStatus, Klasse } from '@tcms/domain';
import { imDienst, ladeArbeitskorb as ladeArbeitskorbImDienst } from '@tcms/service';
import {
  DEMO_PORTS,
  demoPersonen,
  mandantenListe,
  zustaendigkeit,
  type KanzleiAkteur,
} from './demo';
import { heute as heuteFn } from './zeit';

// =============================================================================
// Arbeitskorb der Demo: Aufgaben aus @tcms/service (`ladeArbeitskorb`, Liste
// der zugänglichen Mandanten wie von der kanzleikonsole). Die Demo ergänzt
// Namen aus ihrem Verzeichnis und die Links ihrer Seiten.
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

const datum = (iso: string) => new Date(iso);
const datumOder = (iso: string | null) => (iso ? new Date(iso) : null);
const name = (id: string | null | undefined) => (id ? (demoPersonen.person(id)?.name ?? '—') : '—');

function vierAugenHref(v: ArbeitskorbAntwort['vierAugen'][number], basis: string): string {
  switch (v.art) {
    case 'UEBERSTEUERUNG':
      return `${basis}/risiken?risiko=${v.objektId}`;
    case 'FREQUENZ':
      return `${basis}/kontrollen?kontrolle=${v.objektId}`;
    case 'VERWERFEN':
      return `${basis}/feststellungen/${v.objektId}`;
    case 'RISIKOFREIGABE':
      return `${basis}/risiken`;
  }
}

/** Arbeitskorb der angemeldeten Kanzleiperson über ihre zugänglichen Mandanten. */
export async function ladeArbeitskorb(nutzer: KanzleiAkteur): Promise<Arbeitskorb> {
  const k = await imDienst(nutzer, DEMO_PORTS, (ctx) =>
    ladeArbeitskorbImDienst(ctx, mandantenListe(nutzer)),
  );
  const basis = (m: { id: string }) => `/staff/clients/${m.id}/tcms`;
  const durchf = (d: ArbeitskorbAntwort['durchfuehrungen'][number]): AkDurchfuehrung => ({
    ...d,
    faelligAm: datum(d.faelligAm),
    href: `${basis(d.mandant)}/durchfuehrungen/${d.id}`,
  });
  const bt = k.p153BeiAnderen.mandantIds.map((id) => name(zustaendigkeit(id).berufstraegerId));
  return {
    heute: heuteFn(),
    durchfuehrungen: k.durchfuehrungen.map(durchf),
    gegenzeichnungen: k.gegenzeichnungen.map((g) => ({
      ...durchf(g),
      durchgefuehrtVon: name(g.durchgefuehrtVon),
      eingereichtAm: datumOder(g.eingereichtAm),
    })),
    vierAugen: k.vierAugen.map((v) => ({
      mandant: v.mandant,
      art: v.art,
      key: v.key,
      titel: v.titel,
      detail: v.detail,
      begruendung: v.begruendung,
      beantragtVon: v.beantragtVon.length ? v.beantragtVon.map(name).join(', ') : '—',
      beantragtAm: datumOder(v.beantragtAm),
      href: vierAugenHref(v, basis(v.mandant)),
    })),
    p153: k.p153.map((f) => ({
      ...f,
      erfasstAm: datum(f.erfasstAm),
      href: `${basis(f.mandant)}/feststellungen/${f.id}`,
    })),
    p153BeiAnderen: { anzahl: k.p153BeiAnderen.anzahl, berufstraeger: [...new Set(bt)] },
    ereignisse: k.ereignisse.map((e) => ({
      ...e,
      gemeldetVon: name(e.gemeldetVon),
      gemeldetAm: datum(e.gemeldetAm),
      href: `${basis(e.mandant)}/ereignisse?e=${e.id}`,
    })),
    beschreibungen: k.beschreibungen.map((b) => ({
      ...b,
      angefordertVon: name(b.angefordertVon),
      angefordertAm: datumOder(b.angefordertAm),
      href: `${basis(b.mandant)}/beschreibung`,
    })),
    mandantenZustaendig: k.mandantenZustaendig,
  };
}
