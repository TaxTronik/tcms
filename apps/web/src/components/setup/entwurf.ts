// =============================================================================
// Entwurfsstand des Einrichtungsassistenten (TcmsProgramm.setupEntwurf).
// Reine Typen, Startwerte und Prüfungen je Schritt; Server und Client nutzen
// dieselben Regeln.
// =============================================================================

import { z } from 'zod';
import {
  addTage,
  isoDatum,
  leeresProfil,
  MIN_BEGRUENDUNG,
  schlageRisikenVor,
  TEILBEREICH_VORLAGE,
  ZIEL_VORLAGEN,
  type Geschaeftsprofil,
} from '@tcms/domain';
import { leseProfil, pruefeProfil } from '../profil/profil-logik';

export const SCHRITTE = [
  { nr: 1, titel: 'Teilbereich', sub: 'Paketvorlage, Abgrenzung und Zeiträume' },
  { nr: 2, titel: 'Geschäftsprofil', sub: 'P1–P12' },
  { nr: 3, titel: 'Compliance-Ziele', sub: 'Wesentlichkeit und Risikoappetit' },
  { nr: 4, titel: 'Risikovorschlag', sub: 'übernehmen oder begründet ablehnen' },
  { nr: 5, titel: 'Kontrollvorschlag', sub: 'Zuständigkeiten und Frequenzen' },
] as const;

export type ErklaerungsTurnus = 'MONATLICH' | 'QUARTALSWEISE' | 'JAEHRLICH';
export type Appetit = 'GERING' | 'MITTEL' | 'HOCH';

export interface EntwurfZiel {
  key: string;
  text: string;
  wesentlichkeitEur: number;
  risikoappetit: Appetit;
  aktiv: boolean;
  eigen: boolean;
}

export interface EntwurfRisiko {
  uebernehmen: boolean;
  begruendung: string;
}

export interface EntwurfKontrolle {
  partei: 'KANZLEI' | 'MANDANT';
  durchfuehrendId: string | null;
  vertretungId: string | null;
  gegenzeichnerId: string | null;
}

export interface SetupEntwurf {
  v: 1;
  /** Höchster geprüft abgeschlossener Schritt (0–5). */
  abgeschlossen: number;
  teilbereich: { name: string; abgrenzung: string; einschluesse: string[]; ausschluesse: string[] };
  zeitraum: {
    angemessenheitStichtag: string;
    wirksamAb: string;
    wirksamBis: string;
    erklaerungsTurnus: ErklaerungsTurnus;
  };
  profil: Geschaeftsprofil;
  ziele: EntwurfZiel[];
  freigabe: { anfordern: boolean; empfaengerId: string | null };
  risiken: Record<string, EntwurfRisiko>;
  kontrollen: Record<string, EntwurfKontrolle>;
  gespeichertVon?: string | null;
  gespeichertAm?: string | null;
}

const isoTag = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const kurz = z.string().trim().max(200);

export const TeilbereichSchema = z.object({
  teilbereich: z.object({
    name: z.string().trim().min(1).max(200),
    abgrenzung: z.string().trim().max(4000),
    einschluesse: z.array(kurz).max(30),
    ausschluesse: z.array(kurz).max(30),
  }),
  zeitraum: z.object({
    angemessenheitStichtag: isoTag.or(z.literal('')),
    wirksamAb: isoTag.or(z.literal('')),
    wirksamBis: isoTag.or(z.literal('')),
    erklaerungsTurnus: z.enum(['MONATLICH', 'QUARTALSWEISE', 'JAEHRLICH']),
  }),
});

export const ZieleSchema = z.object({
  ziele: z
    .array(
      z.object({
        key: z.string().min(1).max(60),
        text: z.string().trim().max(1000),
        wesentlichkeitEur: z.number().int().min(0).max(1e9),
        risikoappetit: z.enum(['GERING', 'MITTEL', 'HOCH']),
        aktiv: z.boolean(),
        eigen: z.boolean(),
      }),
    )
    .max(20),
  freigabe: z.object({ anfordern: z.boolean(), empfaengerId: z.string().min(1).nullable() }),
});

export const RisikenSchema = z.object({
  risiken: z.record(
    z.string(),
    z.object({ uebernehmen: z.boolean(), begruendung: z.string().trim().max(2000) }),
  ),
});

export const KontrollenSchema = z.object({
  kontrollen: z.record(
    z.string(),
    z.object({
      partei: z.enum(['KANZLEI', 'MANDANT']),
      durchfuehrendId: z.string().min(1).nullable(),
      vertretungId: z.string().min(1).nullable(),
      gegenzeichnerId: z.string().min(1).nullable(),
    }),
  ),
});

// ---------------------------------------------------------------------------
// Startwerte
// ---------------------------------------------------------------------------

function letzterTagDesMonats(jahr: number, monat0: number): Date {
  return new Date(Date.UTC(jahr, monat0 + 1, 0));
}

/** Vorschlag: Angemessenheit zum Ende des übernächsten Monats, danach sechs Monate Wirksamkeit. */
export function standardZeitraum(heute: Date): SetupEntwurf['zeitraum'] {
  const stichtag = letzterTagDesMonats(heute.getUTCFullYear(), heute.getUTCMonth() + 2);
  const ab = addTage(stichtag, 1);
  const bis = letzterTagDesMonats(ab.getUTCFullYear(), ab.getUTCMonth() + 5);
  return {
    angemessenheitStichtag: isoDatum(stichtag),
    wirksamAb: isoDatum(ab),
    wirksamBis: isoDatum(bis),
    erklaerungsTurnus: 'MONATLICH',
  };
}

export function neuerEntwurf(heute: Date, gvId: string | null): SetupEntwurf {
  return {
    v: 1,
    abgeschlossen: 0,
    teilbereich: {
      name: TEILBEREICH_VORLAGE.name,
      abgrenzung: TEILBEREICH_VORLAGE.abgrenzung,
      einschluesse: [...TEILBEREICH_VORLAGE.einschluesse],
      ausschluesse: [...TEILBEREICH_VORLAGE.ausschluesse],
    },
    zeitraum: standardZeitraum(heute),
    profil: leeresProfil(),
    ziele: ZIEL_VORLAGEN.map((z) => ({
      key: z.key,
      text: z.text,
      wesentlichkeitEur: z.wesentlichkeitEur,
      risikoappetit: z.risikoappetit as Appetit,
      aktiv: true,
      eigen: false,
    })),
    freigabe: { anfordern: gvId != null, empfaengerId: gvId },
    risiken: {},
    kontrollen: {},
  };
}

/** Liest einen gespeicherten Entwurf; unlesbare Teile fallen auf Startwerte zurück. */
export function leseEntwurf(roh: unknown, heute: Date, gvId: string | null): SetupEntwurf {
  const basis = neuerEntwurf(heute, gvId);
  if (!roh || typeof roh !== 'object') return basis;
  const r = roh as Partial<SetupEntwurf>;
  const tb = TeilbereichSchema.safeParse({ teilbereich: r.teilbereich, zeitraum: r.zeitraum });
  const zi = ZieleSchema.safeParse({ ziele: r.ziele, freigabe: r.freigabe });
  const ri = RisikenSchema.safeParse({ risiken: r.risiken });
  const ko = KontrollenSchema.safeParse({ kontrollen: r.kontrollen });
  const pr = leseProfil(r.profil);
  return {
    v: 1,
    abgeschlossen:
      typeof r.abgeschlossen === 'number'
        ? Math.max(0, Math.min(5, Math.floor(r.abgeschlossen)))
        : 0,
    teilbereich: tb.success ? tb.data.teilbereich : basis.teilbereich,
    zeitraum: tb.success ? tb.data.zeitraum : basis.zeitraum,
    profil: pr.profil ?? basis.profil,
    ziele: zi.success ? zi.data.ziele : basis.ziele,
    freigabe: zi.success ? zi.data.freigabe : basis.freigabe,
    risiken: ri.success ? ri.data.risiken : {},
    kontrollen: ko.success ? ko.data.kontrollen : {},
    gespeichertVon: typeof r.gespeichertVon === 'string' ? r.gespeichertVon : null,
    gespeichertAm: typeof r.gespeichertAm === 'string' ? r.gespeichertAm : null,
  };
}

// ---------------------------------------------------------------------------
// Prüfungen je Schritt (Kontrollen: siehe programm-aufbau.ts)
// ---------------------------------------------------------------------------

function tag(iso: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Erster Tag nach sechs vollen Monaten ab `ab` minus ein Tag (z. B. 01.01. → 30.06.). */
export function mindestEnde(ab: Date): Date {
  return addTage(
    new Date(Date.UTC(ab.getUTCFullYear(), ab.getUTCMonth() + 6, ab.getUTCDate())),
    -1,
  );
}

/** Dauer eines Zeitraums als Text, z. B. „6 Monate" oder „rund 5,5 Monate". */
export function dauerText(abIso: string, bisIso: string): string | null {
  const ab = tag(abIso);
  const bis = tag(bisIso);
  if (!ab || !bis || bis.getTime() < ab.getTime()) return null;
  const nach = addTage(bis, 1);
  const volle =
    (nach.getUTCFullYear() - ab.getUTCFullYear()) * 12 + nach.getUTCMonth() - ab.getUTCMonth();
  if (nach.getUTCDate() === ab.getUTCDate()) return `${volle} ${volle === 1 ? 'Monat' : 'Monate'}`;
  const tage = Math.round((nach.getTime() - ab.getTime()) / 86_400_000);
  return `rund ${(tage / 30.44).toLocaleString('de-DE', { maximumFractionDigits: 1 })} Monate`;
}

export function pruefeSchritt1(e: SetupEntwurf, heute: Date): string[] {
  const f: string[] = [];
  if (e.teilbereich.abgrenzung.trim().length < 30)
    f.push(
      'Abgrenzungstext: mindestens 30 Zeichen – er erscheint in der CMS-Beschreibung (Abschnitt 0).',
    );
  const stichtag = tag(e.zeitraum.angemessenheitStichtag);
  const ab = tag(e.zeitraum.wirksamAb);
  const bis = tag(e.zeitraum.wirksamBis);
  if (!stichtag) f.push('Angemessenheits-Stichtag angeben.');
  else if (stichtag.getTime() < heute.getTime())
    f.push('Der Angemessenheits-Stichtag darf nicht in der Vergangenheit liegen.');
  if (!ab || !bis) f.push('Beginn und Ende des Wirksamkeitszeitraums angeben.');
  else {
    if (stichtag && ab.getTime() <= stichtag.getTime())
      f.push('Der Wirksamkeitszeitraum beginnt nach dem Angemessenheits-Stichtag.');
    if (bis.getTime() < mindestEnde(ab).getTime())
      f.push('Der Wirksamkeitszeitraum umfasst regelmäßig mindestens sechs Monate (vgl. Tz. 61).');
    if (bis.getTime() > addTage(ab, 3 * 366).getTime())
      f.push('Der Wirksamkeitszeitraum ist länger als drei Jahre – bitte prüfen.');
  }
  return f;
}

export function pruefeSchritt2(e: SetupEntwurf): string[] {
  const { profil, fehler } = leseProfil(e.profil);
  if (!profil) return fehler;
  return pruefeProfil(profil);
}

export function pruefeSchritt3(e: SetupEntwurf, gvIds: readonly string[]): string[] {
  const f: string[] = [];
  const aktiv = e.ziele.filter((z) => z.aktiv);
  if (aktiv.length === 0) f.push('Mindestens ein Compliance-Ziel übernehmen.');
  aktiv.forEach((z, i) => {
    if (z.text.trim().length < 20)
      f.push(`Ziel ${i + 1}: Zieltext mit mindestens 20 Zeichen formulieren.`);
  });
  if (e.freigabe.anfordern) {
    if (!e.freigabe.empfaengerId)
      f.push('Für die Freigabeanforderung eine gesetzliche Vertretung wählen.');
    else if (!gvIds.includes(e.freigabe.empfaengerId))
      f.push('Die Freigabe der Ziele erteilt nur eine gesetzliche Vertretung des Mandanten.');
  }
  return f;
}

export function pruefeSchritt4(e: SetupEntwurf): string[] {
  const f: string[] = [];
  for (const v of schlageRisikenVor(e.profil)) {
    if (v.kern) continue;
    const r = e.risiken[v.code];
    if (r && !r.uebernehmen && r.begruendung.trim().length < MIN_BEGRUENDUNG) {
      f.push(`${v.code}: Ablehnung mit mindestens ${MIN_BEGRUENDUNG} Zeichen begründen.`);
    }
  }
  return f;
}

/** Entscheidung je Vorschlag (Standard: übernehmen; Kernrisiken immer). */
export function entscheidung(e: SetupEntwurf, code: string, kern: boolean): EntwurfRisiko {
  if (kern) return { uebernehmen: true, begruendung: '' };
  return e.risiken[code] ?? { uebernehmen: true, begruendung: '' };
}
