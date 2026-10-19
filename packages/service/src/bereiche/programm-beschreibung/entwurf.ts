// =============================================================================
// Entwurfsstand des Einrichtungsassistenten (TcmsProgramm.setupEntwurf):
// Startwerte, Lesen gespeicherter Entwürfe und Prüfungen je Schritt (bisher
// apps/web/src/components/setup/entwurf.ts und profil-logik.ts). Reine
// Funktionen ohne I/O; die Struktur (zod) steht im Vertrag.
// =============================================================================

import {
  EinrichtungProfilSchema,
  KontrollenSchrittSchema,
  RisikenSchrittSchema,
  TeilbereichSchrittSchema,
  ZieleSchrittSchema,
  type EntwurfRisiko,
  type SetupEntwurf,
} from '@tcms/contract';
import {
  addTage,
  isoDatum,
  leeresProfil,
  MIN_BEGRUENDUNG,
  PROFIL_FRAGEN,
  schlageRisikenVor,
  TEILBEREICH_VORLAGE,
  ZIEL_VORLAGEN,
  type Geschaeftsprofil,
} from '@tcms/domain';

// Übersetzungsprüfung: Der Vertrag beschreibt genau das Geschäftsprofil der Domain.
type Gleich<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const PROFIL_GLEICH: Gleich<
  ReturnType<typeof EinrichtungProfilSchema.parse>,
  Geschaeftsprofil
> = true;
void PROFIL_GLEICH;

// ---------------------------------------------------------------------------
// Geschäftsprofil (Struktur und fachliche Pflichtangaben)
// ---------------------------------------------------------------------------

function frageNr(key: string): string {
  return PROFIL_FRAGEN.find((f) => f.key === key)?.nr ?? key.toUpperCase();
}

/** Strukturprüfung; liefert das bereinigte Profil oder lesbare Fehler je Profilfrage. */
export function leseEinrichtungsProfil(roh: unknown): {
  profil: Geschaeftsprofil | null;
  fehler: string[];
} {
  const p = EinrichtungProfilSchema.safeParse(roh);
  if (!p.success) {
    const fragen = [...new Set(p.error.issues.map((i) => frageNr(String(i.path[0] ?? ''))))];
    return {
      profil: null,
      fehler: fragen.map((f) => `${f}: Angaben unvollständig oder im falschen Format.`),
    };
  }
  const profil: Geschaeftsprofil = structuredClone(p.data);
  // Leere Zeilen aus dem Formular entfernen, Listen eindeutig machen.
  profil.p1.marktplaetze = [...new Set(profil.p1.marktplaetze.filter(Boolean))];
  profil.p3.laender = [...new Set(profil.p3.laender)];
  profil.p4.warengruppen = profil.p4.warengruppen.filter((w) => w.name.length > 0);
  profil.p5.laender = profil.p5.drittlandImport ? [...new Set(profil.p5.laender)] : [];
  profil.p6.zahlungswege = [...new Set(profil.p6.zahlungswege.filter(Boolean))];
  profil.p8.systeme = profil.p8.systeme.filter((s) => s.name.length > 0);
  profil.p9.lokaleUstNr = [...new Set(profil.p9.lokaleUstNr)];
  profil.p11.anbieter = profil.p11.vorhanden ? profil.p11.anbieter.filter((a) => a.length > 0) : [];
  if (!profil.p1.eigenerShop) profil.p1.shopSystem = '';
  return { profil, fehler: [] };
}

/** Fachliche Pflichtangaben (Einrichtung und Profiländerung). */
export function pruefeEinrichtungsProfil(p: Geschaeftsprofil): string[] {
  const f: string[] = [];
  if (!p.p1.eigenerShop && p.p1.marktplaetze.length === 0)
    f.push('P1: Mindestens einen Verkaufskanal angeben (eigener Shop oder Marktplatz).');
  if (p.p1.eigenerShop && !p.p1.shopSystem.trim())
    f.push('P1: Shopsystem des eigenen Shops angeben.');
  const lagerLaender = p.p2.lager.map((l) => l.land);
  if (new Set(lagerLaender).size !== lagerLaender.length)
    f.push('P2: Jedes Lagerland nur einmal angeben.');
  if (p.p3.laender.length === 0) f.push('P3: Mindestens ein Zielland angeben.');
  if (p.p4.warengruppen.length === 0) f.push('P4: Mindestens eine Warengruppe angeben.');
  if (p.p5.drittlandImport && p.p5.laender.length === 0)
    f.push('P5: Herkunftsländer des Drittlandimports angeben.');
  if (p.p6.zahlungswege.length === 0) f.push('P6: Mindestens einen Zahlungsweg angeben.');
  if (p.p11.vorhanden && p.p11.anbieter.length === 0)
    f.push('P11: Mindestens einen ausländischen Anbieter nennen.');
  return f;
}

/** Stabile Serialisierung (Schlüssel sortiert): JSONB ordnet Schlüssel beim Speichern um. */
function stabil(wert: unknown): string {
  if (wert === null || typeof wert !== 'object') return JSON.stringify(wert ?? null);
  if (Array.isArray(wert)) return `[${wert.map(stabil).join(',')}]`;
  const e = Object.entries(wert as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${e.map(([k, v]) => `${JSON.stringify(k)}:${stabil(v)}`).join(',')}}`;
}

export const inhaltGleich = (x: unknown, y: unknown) => stabil(x) === stabil(y);

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
      risikoappetit: z.risikoappetit as 'GERING' | 'MITTEL' | 'HOCH',
      aktiv: true,
      eigen: false,
    })),
    freigabe: { anfordern: gvId != null, empfaengerId: gvId },
    risiken: {},
    kontrollen: {},
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Liest einen gespeicherten Entwurf; unlesbare Teile fallen auf Startwerte zurück. */
export function leseEntwurf(roh: unknown, heute: Date, gvId: string | null): SetupEntwurf {
  const basis = neuerEntwurf(heute, gvId);
  if (!roh || typeof roh !== 'object' || Array.isArray(roh)) return basis;
  const r = roh as Partial<Record<keyof SetupEntwurf, unknown>>;
  const tb = TeilbereichSchrittSchema.safeParse({
    teilbereich: r.teilbereich,
    zeitraum: r.zeitraum,
  });
  const zi = ZieleSchrittSchema.safeParse({ ziele: r.ziele, freigabe: r.freigabe });
  const ri = RisikenSchrittSchema.safeParse({ risiken: r.risiken });
  const ko = KontrollenSchrittSchema.safeParse({ kontrollen: r.kontrollen });
  const pr = leseEinrichtungsProfil(r.profil);
  return {
    v: 1,
    abgeschlossen:
      typeof r.abgeschlossen === 'number' && Number.isFinite(r.abgeschlossen)
        ? Math.max(0, Math.min(5, Math.floor(r.abgeschlossen)))
        : 0,
    teilbereich: tb.success ? tb.data.teilbereich : basis.teilbereich,
    zeitraum: tb.success ? tb.data.zeitraum : basis.zeitraum,
    profil: pr.profil ?? basis.profil,
    ziele: zi.success ? zi.data.ziele : basis.ziele,
    freigabe: zi.success ? zi.data.freigabe : basis.freigabe,
    risiken: ri.success ? ri.data.risiken : {},
    kontrollen: ko.success ? ko.data.kontrollen : {},
    gespeichertVon:
      typeof r.gespeichertVon === 'string' && UUID.test(r.gespeichertVon)
        ? r.gespeichertVon.toLowerCase()
        : null,
    gespeichertAm: typeof r.gespeichertAm === 'string' ? r.gespeichertAm.slice(0, 40) : null,
  };
}

// ---------------------------------------------------------------------------
// Prüfungen je Schritt (Kontrollen: siehe aufbau.ts)
// ---------------------------------------------------------------------------

function tag(iso: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || isoDatum(d) !== iso ? null : d;
}

/** Erster Tag nach sechs vollen Monaten ab `ab` minus ein Tag (z. B. 01.01. → 30.06.). */
export function mindestEnde(ab: Date): Date {
  return addTage(
    new Date(Date.UTC(ab.getUTCFullYear(), ab.getUTCMonth() + 6, ab.getUTCDate())),
    -1,
  );
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
  const { profil, fehler } = leseEinrichtungsProfil(e.profil);
  if (!profil) return fehler;
  return pruefeEinrichtungsProfil(profil);
}

/** Schritt 3: Ziele; eine Freigabe der Ziele erteilt nur eine aktive gesetzliche Vertretung. */
export function pruefeSchritt3(e: SetupEntwurf, gvIds: readonly string[]): string[] {
  const f: string[] = [];
  const aktiv = e.ziele.filter((z) => z.aktiv);
  if (aktiv.length === 0) f.push('Mindestens ein Compliance-Ziel übernehmen.');
  aktiv.forEach((z, i) => {
    if (z.text.trim().length < 20)
      f.push(`Ziel ${i + 1}: Zieltext mit mindestens 20 Zeichen formulieren.`);
  });
  if (new Set(e.ziele.map((z) => z.key)).size !== e.ziele.length)
    f.push('Jedes Ziel braucht einen eigenen Schlüssel.');
  if (e.freigabe.anfordern) {
    const id = e.freigabe.empfaengerId?.toLowerCase() ?? null;
    if (!id) f.push('Für die Freigabeanforderung eine gesetzliche Vertretung wählen.');
    else if (!gvIds.some((g) => g.toLowerCase() === id))
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
export function risikoEntscheidung(e: SetupEntwurf, code: string, kern: boolean): EntwurfRisiko {
  if (kern) return { uebernehmen: true, begruendung: '' };
  return e.risiken[code] ?? { uebernehmen: true, begruendung: '' };
}
