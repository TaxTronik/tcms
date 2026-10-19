// =============================================================================
// Mandantenanker (`PUT /v1/mandanten/:mandantId`, ADR 0001 §5): Die
// kanzleikonsole legt den Anker eines Mandanten an bzw. aktualisiert seine
// Stammdaten (Name, Rechtsform, DATEV-Nummer). Nur mit `kannBearbeiten`
// (bestätigter Bezug und Admin, zuständige:r BT oder Hauptbearbeitung).
//
// TS-05: Parallele Aufrufe für denselben Anker serialisiert eine Sperre je
// Tenant und Mandant; die Zeile wird zusätzlich mit FOR UPDATE gelesen. Jede
// Änderung erzeugt genau ein Audit-Ereignis; ein unveränderter Anker keines.
// =============================================================================

import {
  DienstFehler,
  MandantAnkerAntwortSchema,
  MandantAnkerEingabeSchema,
  type Akteur,
  type MandantAnkerAntwort,
  type MandantAnkerEingabe,
} from '@tcms/contract';
import { Prisma, tenantSperre } from '@tcms/db';
import { mitAudit } from '../../audit';
import type { DienstKontext } from '../../kontext';
import { kannBearbeiten, kannLesen } from '../../rechte';
import { antwortNach, pruefeEingabe } from './hilfen';

/**
 * Bearbeitungsrecht für Stammdaten und Rollen eines Mandanten: ohne Bezug wie
 * unbekannt (`NICHT_GEFUNDEN`), mit Bezug ohne Zuständigkeit `NICHT_BERECHTIGT`.
 */
export function brauchtBearbeitung(a: Akteur, mandantId: string, was: string): void {
  if (kannBearbeiten(a, mandantId)) return;
  if (a.art !== 'KANZLEI' || !kannLesen(a, mandantId)) throw new DienstFehler('NICHT_GEFUNDEN');
  throw new DienstFehler(
    'NICHT_BERECHTIGT',
    `${was} ist zuständigen Personen der Kanzlei oder Admins vorbehalten.`,
  );
}

interface AnkerZeile {
  id: string;
  name: string;
  rechtsform: string;
  datevNr: string | null;
  aktiv: boolean;
}

/** Legt den Mandantenanker an oder aktualisiert seine Stammdaten (auditiert). */
export async function setzeMandantAnker(
  ctx: DienstKontext,
  eingabe: MandantAnkerEingabe,
): Promise<MandantAnkerAntwort> {
  const e = pruefeEingabe(MandantAnkerEingabeSchema, eingabe);
  const id = e.mandantId.toLowerCase();
  brauchtBearbeitung(ctx.akteur, id, 'Die Pflege der Stammdaten');
  const soll = { name: e.name, rechtsform: e.rechtsform, datevNr: e.datevNr };

  await tenantSperre(ctx.tx, `mandant.anker.${id}`);
  const [vorher] = await ctx.tx.$queryRaw<AnkerZeile[]>`
    SELECT id::text AS id, name, rechtsform, "datevNr", aktiv
    FROM "Mandant" WHERE id = ${id}::uuid FOR UPDATE`;

  if (vorher) {
    const geaendert = (Object.keys(soll) as (keyof typeof soll)[]).filter(
      (k) => vorher[k] !== soll[k],
    );
    if (geaendert.length === 0) {
      return antwortNach(MandantAnkerAntwortSchema, 'setzeMandantAnker', {
        mandant: vorher,
        angelegt: false,
        geaendert: false,
      });
    }
    const nachher = await mitAudit(ctx, async (tx) => {
      const m = await tx.mandant.update({
        where: { id },
        data: soll,
        select: { id: true, name: true, rechtsform: true, datevNr: true, aktiv: true },
      });
      return {
        wert: m,
        protokoll: {
          aktion: 'tcms.mandant.aktualisiert',
          objektTyp: 'Mandant',
          objektId: id,
          programmId: null,
          detail: {
            felder: geaendert,
            vorher: Object.fromEntries(geaendert.map((k) => [k, vorher[k]])),
            nachher: Object.fromEntries(geaendert.map((k) => [k, soll[k]])),
          },
        },
      };
    });
    return antwortNach(MandantAnkerAntwortSchema, 'setzeMandantAnker', {
      mandant: nachher,
      angelegt: false,
      geaendert: true,
    });
  }

  try {
    const neu = await mitAudit(ctx, async (tx) => {
      const m = await tx.mandant.create({
        data: { id, ...soll },
        select: { id: true, name: true, rechtsform: true, datevNr: true, aktiv: true },
      });
      return {
        wert: m,
        protokoll: {
          aktion: 'tcms.mandant.angelegt',
          objektTyp: 'Mandant',
          objektId: id,
          programmId: null,
          detail: { ...soll },
        },
      };
    });
    return antwortNach(MandantAnkerAntwortSchema, 'setzeMandantAnker', {
      mandant: neu,
      angelegt: true,
      geaendert: true,
    });
  } catch (f) {
    // Die ID ist global eindeutig: Gibt es sie (unsichtbar) in einem anderen Tenant,
    // scheitert das Anlegen. Antwort ohne Hinweis darauf, wo sie existiert.
    if (f instanceof Prisma.PrismaClientKnownRequestError && f.code === 'P2002') {
      throw new DienstFehler('KONFLIKT', 'Der Mandant kann nicht angelegt werden.');
    }
    throw f;
  }
}
