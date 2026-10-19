// =============================================================================
// Tax-CMS-Kontext als Antwort des Dienstes (`GET /v1/mandanten/:id/kontext`).
// Der Lesestand kommt aus `ladeKontext` (Kern: `kannLesen`, Maskierung
// vertraulicher Feststellungen); hier wird er explizit in den Vertrag
// abgebildet und vor dem Senden streng geprüft.
// =============================================================================

import {
  DienstFehler,
  KontextAntwortSchema,
  KontextEingabeSchema,
  type Akteur,
  type KontextAntwort,
  type KontextEingabe,
} from '@tcms/contract';
import { isoDatum } from '@tcms/domain';
import { ladeKontext, type TcmsKontext } from '../../kern/tcms-kontext';
import type { DienstKontext } from '../../kontext';
import { kannBearbeiten, kannWuerdigen } from '../../rechte';
import { alsJson, antwortNach, pruefeEingabe } from './hilfen';

/**
 * Rechte des Akteurs für den geladenen Kontext (Kennzeichen für die
 * Oberfläche). Historische Stände sind schreibgeschützt (AGENTS.md Regel 6).
 */
export function kontextRechte(
  a: Akteur,
  k: Pick<TcmsKontext, 'mandant' | 'historisch'>,
): KontextAntwort['rechte'] {
  return {
    bearbeiten: !k.historisch && kannBearbeiten(a, k.mandant.id),
    wuerdigen: !k.historisch && kannWuerdigen(a, k.mandant.id),
  };
}

/**
 * Bildet den internen Lesestand in die Antwort ab. Felder aus JSON-Spalten
 * (Schritte, Kennzahlen, Normanker, Abschnitte) werden einzeln übernommen,
 * damit dort gespeicherte Zusatzfelder nie nach außen gelangen; Namen
 * (`namen`) bleiben im Dienst (die kanzleikonsole löst sie auf).
 */
export function kontextAlsAntwort(a: Akteur, k: TcmsKontext): KontextAntwort {
  const roh = {
    heute: isoDatum(k.heute),
    stand: isoDatum(k.stand),
    historisch: k.historisch,
    mandant: { ...k.mandant },
    rechte: kontextRechte(a, k),
    kontaktRollen: k.kontaktRollen.map((r) => ({
      kontaktId: r.kontaktId,
      rolle: r.rolle,
      funktion: r.funktion,
    })),
    programm: k.programm,
    teilbereich: k.teilbereich,
    ziele: k.ziele,
    appetit: k.appetit,
    profil: k.profil,
    profilGueltigAb: k.profilGueltigAb,
    risiken: k.risiken.map((r) => ({
      ...r,
      normanker: r.normanker.map((n) => ({ text: n.text, stufe: n.stufe })),
    })),
    vorschlaege: k.vorschlaege,
    kontrollen: k.kontrollen.map((x) => ({
      ...x,
      schritte: x.schritte.map((s) => ({ titel: s.titel, hinweis: s.hinweis })),
      kennzahlen: x.kennzahlen.map((z) => ({
        key: z.key,
        label: z.label,
        sollEur: z.sollEur,
        differenzAus: z.differenzAus,
      })),
    })),
    durchfuehrungen: k.durchfuehrungen,
    feststellungen: k.feststellungen,
    ereignisse: k.ereignisse,
    laender: k.laender,
    schwelle: k.schwelle,
    fernverkaeufeLfd: k.fernverkaeufeLfd,
    fernverkaeufeVorjahr: k.fernverkaeufeVorjahr,
    laenderStand: k.laenderStand,
    laenderQuelle: k.laenderQuelle,
    beschreibungen: k.beschreibungen.map((b) => ({
      ...b,
      abschnitte: b.abschnitte.map((x) => ({
        key: x.key,
        bloecke: x.bloecke.map((bl) =>
          bl.typ === 'text' ? { typ: 'text', text: bl.text } : { typ: 'baustein', art: bl.art },
        ),
      })),
    })),
    phasen: k.phasen,
    aktivePhase: k.aktivePhase,
    grundelemente: k.grundelemente,
    prueflast: k.prueflast,
    zeitraum: k.zeitraum,
    ausgeblendet: k.ausgeblendet,
  };
  return antwortNach(KontextAntwortSchema, 'leseKontext', alsJson(roh));
}

/**
 * Kontext eines Mandanten für eine Kanzleiperson (TS-03: `kannLesen` im Kern,
 * vertrauliche Feststellungen maskiert). Mandantenkontakte lesen nur über die
 * Portal-Sichten, nie den vollständigen Kontext mit Kanzlei-Interna
 * (Nettoklassen, §-153-Details): für sie `NICHT_GEFUNDEN`.
 */
export async function leseKontext(
  ctx: DienstKontext,
  eingabe: KontextEingabe,
): Promise<KontextAntwort> {
  const e = pruefeEingabe(KontextEingabeSchema, eingabe);
  if (ctx.akteur.art !== 'KANZLEI') throw new DienstFehler('NICHT_GEFUNDEN');
  const k = await ladeKontext(ctx, e);
  return kontextAlsAntwort(ctx.akteur, k);
}
