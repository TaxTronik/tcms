'use server';

import { z } from 'zod';
import { frequenzLabel, gleicheFrequenz, mindestensSoStreng, type Frequenz } from '@tcms/domain';
import { db, personImMandat, type KanzleiAkteur } from '../demo';
import { aktualisiereMandant, KEIN_RECHT, mitAudit, type Protokoll } from '../aktion';
import type { Ergebnis } from '../ergebnis';
import {
  aktuelleRisikenDerKontrolle,
  antragDerAbweichung,
  abweichungOffen,
  effektiveFrequenz,
  neuerKontrollStand,
  planeDurchfuehrungenNeu,
} from '../kontrollen-daten';
import { kannBearbeiten, zweitePerson } from '../berechtigung';
import { NUR_AKTUELL } from '../seite';
import { brauchtKanzlei } from '../sitzung';
import { heute, jetzt, leseStand } from '../zeit';

// =============================================================================
// Server Actions Kontrollmatrix (S6). Jede Änderung schreibt einen neuen
// Kontrollstand fort (Regel 3); Frequenzabweichungen bestätigt eine zweite
// Person (Regel 4); bei geänderter Frequenz werden künftige Durchführungen
// neu geplant und protokolliert (Fachkonzept §6).
// =============================================================================

const ZWEITE_PERSON = 'Die Entscheidung trifft eine zweite Person – nicht die beantragende.';
const TURNUSSE = ['KEIN', 'JAEHRLICH', 'QUARTALSWEISE', 'MONATLICH'] as const;

function historisch(fd: FormData): boolean {
  const s = fd.get('stand');
  return typeof s === 'string' && s !== '' && leseStand(s).historisch;
}

function felder(fd: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of fd.entries()) if (typeof v === 'string' && !(k in out)) out[k] = v;
  return out;
}

async function ladeKontrolle(id: string) {
  return db.kontrolle.findUnique({
    where: { id },
    include: { programm: { include: { mandant: true } }, staende: { orderBy: { version: 'asc' } } },
  });
}

type KontrolleMitProgramm = NonNullable<Awaited<ReturnType<typeof ladeKontrolle>>>;

function aktuellerStand(k: KontrolleMitProgramm) {
  return k.staende.find((s) => s.gueltigBis == null) ?? null;
}

function pruefe(nutzer: KanzleiAkteur, k: KontrolleMitProgramm | null): string | null {
  if (!k) return 'Kontrolle nicht gefunden.';
  if (!kannBearbeiten(nutzer, k.programm.mandant)) return KEIN_RECHT;
  if (k.entfallenAb && k.entfallenAb.getTime() <= jetzt().getTime())
    return 'Die Kontrolle ist entfallen.';
  if (!aktuellerStand(k)) return 'Kein gültiger Kontrollstand vorhanden.';
  return null;
}

// -----------------------------------------------------------------------------
// Designbeurteilung
// -----------------------------------------------------------------------------

const DesignSchema = z.object({
  id: z.string().min(1),
  design: z.enum(['ANGEMESSEN', 'MANGEL']),
  begruendung: z.string().trim().min(30),
});

export async function designBeurteilen(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  const nutzer = await brauchtKanzlei();
  if (historisch(fd)) return { fehler: NUR_AKTUELL };
  const p = DesignSchema.safeParse(felder(fd));
  if (!p.success)
    return {
      fehler:
        'Bitte Ergebnis (angemessen oder Mangel) und eine Begründung (mindestens 30 Zeichen) angeben.',
    };
  const k = await ladeKontrolle(p.data.id);
  const fehler = pruefe(nutzer, k);
  if (fehler || !k) return { fehler: fehler ?? 'Kontrolle nicht gefunden.' };
  const alt = aktuellerStand(k)!;
  await mitAudit(nutzer, async (tx, zeitpunkt) => {
    const neu = await neuerKontrollStand(
      tx,
      alt,
      {
        design: p.data.design,
        designVon: nutzer.id,
        designAm: zeitpunkt,
        designBegruendung: p.data.begruendung,
      },
      zeitpunkt,
      nutzer.id,
    );
    return {
      wert: neu.id,
      protokoll: {
        aktion: 'tcms.kontrolle.design',
        objektTyp: 'Kontrolle',
        objektId: k.id,
        programmId: k.programmId,
        detail: {
          code: k.code,
          vorher: alt.design,
          nachher: p.data.design,
          begruendung: p.data.begruendung,
          version: neu.version,
        },
      },
    };
  });
  aktualisiereMandant(k.programm.mandantId);
  return {
    ok:
      p.data.design === 'ANGEMESSEN'
        ? `Designbeurteilung erfasst: angemessen (${k.code}).`
        : `Designbeurteilung erfasst: Mangel (${k.code}). Netto (Design) der verknüpften Risiken ohne Abschlag dieser Kontrolle.`,
  };
}

// -----------------------------------------------------------------------------
// Frequenzabweichung (Vier-Augen)
// -----------------------------------------------------------------------------

const AbweichungSchema = z.object({
  id: z.string().min(1),
  turnus: z.enum(TURNUSSE),
  anlass: z.string().optional(),
  begruendung: z.string().trim().min(30),
});

export async function frequenzAbweichungBeantragen(
  _prev: Ergebnis,
  fd: FormData,
): Promise<Ergebnis> {
  const nutzer = await brauchtKanzlei();
  if (historisch(fd)) return { fehler: NUR_AKTUELL };
  const p = AbweichungSchema.safeParse(felder(fd));
  if (!p.success)
    return { fehler: 'Bitte Turnus und eine Begründung (mindestens 30 Zeichen) angeben.' };
  const k = await ladeKontrolle(p.data.id);
  const fehler = pruefe(nutzer, k);
  if (fehler || !k) return { fehler: fehler ?? 'Kontrolle nicht gefunden.' };
  const alt = aktuellerStand(k)!;
  if (alt.abweichungTurnus != null) {
    return {
      fehler: abweichungOffen(alt)
        ? 'Es ist bereits eine Abweichung beantragt.'
        : 'Es besteht bereits eine freigegebene Abweichung – bitte zuerst aufheben.',
    };
  }
  const ziel: Frequenz = {
    turnus: p.data.turnus,
    anlass: p.data.anlass === 'on' || p.data.anlass === 'true',
  };
  if (ziel.turnus === 'KEIN' && !ziel.anlass)
    return { fehler: 'Eine Kontrolle ohne Turnus braucht mindestens die Prüfung bei Auslösung.' };
  const risiken = await aktuelleRisikenDerKontrolle(db, k.id, jetzt());
  const { ableitung, frequenz } = effektiveFrequenz(alt, risiken, k.programm.erklaerungsTurnus);
  if (gleicheFrequenz(ziel, frequenz))
    return {
      fehler: `Die gewählte Frequenz entspricht der abgeleiteten (${frequenzLabel(frequenz)}).`,
    };
  // Fachkonzept §6: Eine Kontrolle unter der Matrixfrequenz ist zulässig, braucht aber
  // eine Begründung und die Freigabe durch eine zweite Person (beides erzwungen).
  const unterMatrix = !mindestensSoStreng(ziel, ableitung.mindest);
  await mitAudit(nutzer, async (tx, zeitpunkt) => {
    const neu = await neuerKontrollStand(
      tx,
      alt,
      {
        abweichungTurnus: ziel.turnus,
        abweichungAnlass: ziel.anlass,
        abweichungBegruendung: p.data.begruendung,
        abweichungFreigegebenVon: null,
      },
      zeitpunkt,
      nutzer.id,
    );
    return {
      wert: neu.id,
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
          begruendung: p.data.begruendung,
          version: neu.version,
        },
      },
    };
  });
  aktualisiereMandant(k.programm.mandantId);
  return {
    ok: `Frequenzabweichung beantragt (${frequenzLabel(frequenz)} → ${frequenzLabel(ziel)}${unterMatrix ? ', unter der Matrixfrequenz' : ''}). Gilt erst nach Freigabe durch eine zweite Person.`,
  };
}

const EntscheidungSchema = z.object({
  id: z.string().min(1),
  entscheidung: z.enum(['freigeben', 'ablehnen']),
  begruendung: z.string().trim().optional(),
});

export async function frequenzAbweichungEntscheiden(
  _prev: Ergebnis,
  fd: FormData,
): Promise<Ergebnis> {
  const nutzer = await brauchtKanzlei();
  if (historisch(fd)) return { fehler: NUR_AKTUELL };
  const p = EntscheidungSchema.safeParse(felder(fd));
  if (!p.success) return { fehler: 'Bitte die Eingaben prüfen.' };
  const begruendung = p.data.begruendung ?? '';
  if (p.data.entscheidung === 'ablehnen' && begruendung.length < 30)
    return { fehler: 'Die Ablehnung braucht eine Begründung (mindestens 30 Zeichen).' };
  const k = await ladeKontrolle(p.data.id);
  const fehler = pruefe(nutzer, k);
  if (fehler || !k) return { fehler: fehler ?? 'Kontrolle nicht gefunden.' };
  const alt = aktuellerStand(k)!;
  if (!abweichungOffen(alt)) return { fehler: 'Es ist keine Frequenzabweichung beantragt.' };
  const antrag = antragDerAbweichung(
    k.staende.filter((s) => s.gueltigAb.getTime() <= alt.gueltigAb.getTime()),
  );
  if (!zweitePerson(nutzer, antrag.von)) return { fehler: ZWEITE_PERSON };
  const ziel: Frequenz = { turnus: alt.abweichungTurnus!, anlass: alt.abweichungAnlass ?? false };
  const tag = heute();

  if (p.data.entscheidung === 'freigeben') {
    const risiken = await aktuelleRisikenDerKontrolle(db, k.id, jetzt());
    const vorher = effektiveFrequenz(alt, risiken, k.programm.erklaerungsTurnus);
    const unterMatrix = !mindestensSoStreng(ziel, vorher.ableitung.mindest);
    const plan = await mitAudit(nutzer, async (tx, zeitpunkt) => {
      const neu = await neuerKontrollStand(
        tx,
        alt,
        { abweichungFreigegebenVon: nutzer.id },
        zeitpunkt,
        nutzer.id,
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
            ...(begruendung ? { begruendung } : {}),
          },
        },
      ];
      let neuplanung = null;
      if (vorher.frequenz.turnus !== ziel.turnus) {
        neuplanung = await planeDurchfuehrungenNeu(tx, {
          programmId: k.programmId,
          kontrolleId: k.id,
          code: k.code,
          standId: neu.id,
          faelligNachTagen: neu.faelligNachTagen,
          turnusVorher: vorher.frequenz.turnus,
          turnusNachher: ziel.turnus,
          heute: tag,
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
      return { wert: neuplanung, protokoll: protokolle };
    });
    aktualisiereMandant(k.programm.mandantId);
    return {
      ok: `Frequenzabweichung freigegeben: ${frequenzLabel(ziel)}.${plan ? ` Künftige Durchführungen neu geplant (${plan.angelegt.length} angelegt, ${plan.entfernt.length} entfernt).` : ''}`,
    };
  }

  await mitAudit(nutzer, async (tx, zeitpunkt) => {
    const neu = await neuerKontrollStand(
      tx,
      alt,
      {
        abweichungTurnus: null,
        abweichungAnlass: null,
        abweichungBegruendung: null,
        abweichungFreigegebenVon: null,
      },
      zeitpunkt,
      nutzer.id,
    );
    return {
      wert: neu.id,
      protokoll: {
        aktion: 'tcms.kontrolle.abweichung_abgelehnt',
        objektTyp: 'Kontrolle',
        objektId: k.id,
        programmId: k.programmId,
        detail: {
          code: k.code,
          beantragtVon: antrag.von,
          beantragt: frequenzLabel(ziel),
          begruendung,
          version: neu.version,
        },
      },
    };
  });
  aktualisiereMandant(k.programm.mandantId);
  return { ok: 'Frequenzabweichung abgelehnt – es gilt die abgeleitete Frequenz.' };
}

const AufhebenSchema = z.object({ id: z.string().min(1), begruendung: z.string().trim().min(30) });

/** Hebt eine freigegebene Abweichung auf; es gilt wieder die berechnete Frequenz. */
export async function frequenzAbweichungAufheben(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  const nutzer = await brauchtKanzlei();
  if (historisch(fd)) return { fehler: NUR_AKTUELL };
  const p = AufhebenSchema.safeParse(felder(fd));
  if (!p.success) return { fehler: 'Bitte eine Begründung (mindestens 30 Zeichen) angeben.' };
  const k = await ladeKontrolle(p.data.id);
  const fehler = pruefe(nutzer, k);
  if (fehler || !k) return { fehler: fehler ?? 'Kontrolle nicht gefunden.' };
  const alt = aktuellerStand(k)!;
  if (alt.abweichungTurnus == null || !alt.abweichungFreigegebenVon)
    return { fehler: 'Es besteht keine freigegebene Abweichung.' };
  const risiken = await aktuelleRisikenDerKontrolle(db, k.id, jetzt());
  const vorher = effektiveFrequenz(alt, risiken, k.programm.erklaerungsTurnus);
  const tag = heute();
  const plan = await mitAudit(nutzer, async (tx, zeitpunkt) => {
    const neu = await neuerKontrollStand(
      tx,
      alt,
      {
        abweichungTurnus: null,
        abweichungAnlass: null,
        abweichungBegruendung: null,
        abweichungFreigegebenVon: null,
      },
      zeitpunkt,
      nutzer.id,
    );
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
          begruendung: p.data.begruendung,
          version: neu.version,
        },
      },
    ];
    let neuplanung = null;
    if (vorher.frequenz.turnus !== nachher.frequenz.turnus) {
      neuplanung = await planeDurchfuehrungenNeu(tx, {
        programmId: k.programmId,
        kontrolleId: k.id,
        code: k.code,
        standId: neu.id,
        faelligNachTagen: neu.faelligNachTagen,
        turnusVorher: vorher.frequenz.turnus,
        turnusNachher: nachher.frequenz.turnus,
        heute: tag,
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
    return { wert: neuplanung, protokoll: protokolle };
  });
  aktualisiereMandant(k.programm.mandantId);
  return {
    ok: `Abweichung aufgehoben – es gilt die abgeleitete Frequenz.${plan ? ` Künftige Durchführungen neu geplant (${plan.angelegt.length} angelegt, ${plan.entfernt.length} entfernt).` : ''}`,
  };
}

// -----------------------------------------------------------------------------
// Verantwortliche Personen
// -----------------------------------------------------------------------------

const PersonenSchema = z.object({
  id: z.string().min(1),
  durchfuehrendId: z.string().min(1),
  vertretungId: z.string().min(1),
  gegenzeichnerId: z.string().optional(),
  gegenzeichnungMandant: z.string().optional(),
});

export async function verantwortlicheAendern(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  const nutzer = await brauchtKanzlei();
  if (historisch(fd)) return { fehler: NUR_AKTUELL };
  const p = PersonenSchema.safeParse(felder(fd));
  if (!p.success) return { fehler: 'Bitte durchführende Person und Vertretung wählen.' };
  const k = await ladeKontrolle(p.data.id);
  const fehler = pruefe(nutzer, k);
  if (fehler || !k) return { fehler: fehler ?? 'Kontrolle nicht gefunden.' };
  const alt = aktuellerStand(k)!;
  const { durchfuehrendId, vertretungId } = p.data;
  const gegenzeichnungMandant =
    alt.partei === 'MANDANT' &&
    (p.data.gegenzeichnungMandant === 'on' || p.data.gegenzeichnungMandant === 'true');
  const gegenzeichnerId = gegenzeichnungMandant
    ? alt.gegenzeichnerId
    : p.data.gegenzeichnerId || null;

  const ids = [
    durchfuehrendId,
    vertretungId,
    ...(gegenzeichnerId && !gegenzeichnungMandant ? [gegenzeichnerId] : []),
  ];
  const personen = await Promise.all(ids.map((id) => personImMandat(id, k.programm.mandantId)));
  const person = (id: string) => personen.find((x) => x?.id === id) ?? null;
  const seite = (id: string) => {
    const x = person(id);
    if (!x) return false;
    // Mandantenseite: Kontakt mit aktiver Rolle bei genau diesem Mandanten (personImMandat).
    return alt.partei === 'MANDANT' ? x.art === 'MANDANT' : x.art === 'KANZLEI';
  };
  if (!seite(durchfuehrendId) || !seite(vertretungId)) {
    return {
      fehler:
        alt.partei === 'MANDANT'
          ? 'Durchführung und Vertretung liegen beim Mandanten (Personen des Mandanten wählen).'
          : 'Durchführung und Vertretung liegen bei der Kanzlei.',
    };
  }
  if (durchfuehrendId === vertretungId)
    return { fehler: 'Vertretung und durchführende Person müssen verschieden sein.' };
  if (!gegenzeichnungMandant) {
    if (alt.schluessel && !gegenzeichnerId)
      return { fehler: 'Schlüsselkontrollen brauchen eine gegenzeichnende Person.' };
    if (gegenzeichnerId) {
      const g = person(gegenzeichnerId);
      if (!g || g.art !== 'KANZLEI')
        return {
          fehler:
            'Die Gegenzeichnung erfolgt durch eine Person der Kanzlei (oder durch eine zweite Person beim Mandanten).',
        };
      if (gegenzeichnerId === durchfuehrendId)
        return { fehler: 'Die gegenzeichnende Person darf nicht die durchführende sein.' };
    }
  }
  if (
    alt.durchfuehrendId === durchfuehrendId &&
    alt.vertretungId === vertretungId &&
    alt.gegenzeichnerId === gegenzeichnerId &&
    alt.gegenzeichnungMandant === gegenzeichnungMandant
  ) {
    return { fehler: 'Keine Änderung der Zuständigkeiten.' };
  }

  await mitAudit(nutzer, async (tx, zeitpunkt) => {
    const neu = await neuerKontrollStand(
      tx,
      alt,
      { durchfuehrendId, vertretungId, gegenzeichnerId, gegenzeichnungMandant },
      zeitpunkt,
      nutzer.id,
    );
    const name = (id: string | null) => (id ? (person(id)?.name ?? id) : null);
    return {
      wert: neu.id,
      protokoll: {
        aktion: 'tcms.kontrolle.zustaendigkeit',
        objektTyp: 'Kontrolle',
        objektId: k.id,
        programmId: k.programmId,
        detail: {
          code: k.code,
          vorher: {
            durchfuehrend: alt.durchfuehrendId,
            vertretung: alt.vertretungId,
            gegenzeichnung: alt.gegenzeichnerId,
            gegenzeichnungMandant: alt.gegenzeichnungMandant,
          },
          nachher: {
            durchfuehrend: name(durchfuehrendId),
            vertretung: name(vertretungId),
            gegenzeichnung: gegenzeichnungMandant
              ? 'zweite Person beim Mandanten'
              : name(gegenzeichnerId),
            gegenzeichnungMandant,
          },
          version: neu.version,
        },
      },
    };
  });
  aktualisiereMandant(k.programm.mandantId);
  return { ok: `Zuständigkeiten für ${k.code} geändert (neuer Stand).` };
}
