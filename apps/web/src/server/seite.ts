import 'server-only';
import { notFound } from 'next/navigation';
import { isoDatum } from '@tcms/domain';
import { kannBearbeiten, kannLesen, kannVertraulichLesen, kannWuerdigen } from '@tcms/service';
import type { KanzleiAkteur } from './demo';
import { ladeKontext, type TcmsKontext } from './kontext';
import { brauchtKanzleiFuer } from './sitzung';
import { leseStand } from './zeit';

export interface StaffSeite {
  /** Akteur mit Bezug auf diesen Mandanten (wie `cli` der Akteursbestätigung). */
  nutzer: KanzleiAkteur;
  ctx: TcmsKontext;
  /** Aktuell schreibbar: Bearbeitungsrecht und kein historischer Stand. */
  darfBearbeiten: boolean;
  darfWuerdigen: boolean;
  standIso: string;
  heuteIso: string;
  /** Basis-URL des Mandanten-TCMS, z. B. /staff/clients/abc/tcms */
  basis: string;
  /** Hängt ?stand= an, wenn ein historischer Stand gewählt ist. */
  mitStand: (href: string) => string;
}

export async function ladeStaffSeite(
  id: string,
  sp: Record<string, string | string[] | undefined>,
): Promise<StaffSeite> {
  const nutzer = await brauchtKanzleiFuer(id);
  // Ohne Bezug zum Mandanten: 404 statt 403, damit keine Existenz verraten wird (ADR 0001 §3.3).
  if (!kannLesen(nutzer, id)) notFound();
  const { stand, historisch } = leseStand(sp['stand']);
  const ctx = await ladeKontext(id, isoDatum(stand), historisch);
  if (!ctx) notFound();
  const standIso = isoDatum(stand);
  const sicht = maskiereVertraulich(ctx, nutzer);
  const mitStand = (href: string) =>
    historisch ? `${href}${href.includes('?') ? '&' : '?'}stand=${standIso}` : href;
  return {
    nutzer,
    ctx: sicht,
    darfBearbeiten: !historisch && kannBearbeiten(nutzer, id),
    darfWuerdigen: !historisch && kannWuerdigen(nutzer, id),
    standIso,
    heuteIso: isoDatum(ctx.heute),
    basis: `/staff/clients/${id}/tcms`,
    mitStand,
  };
}

/**
 * Vertrauliche Feststellungen (Fachkonzept §13) nur für Beteiligte
 * (`kannVertraulichLesen`). Für alle anderen werden Titel und Sachverhalt ersetzt.
 */
export function maskiereVertraulich(ctx: TcmsKontext, n: KanzleiAkteur): TcmsKontext {
  const darf = (f: TcmsKontext['feststellungen'][number]) =>
    !f.vertraulich || kannVertraulichLesen(n, ctx.mandant.id, f.beteiligte);
  if (ctx.feststellungen.every(darf)) return ctx;
  return {
    ...ctx,
    feststellungen: ctx.feststellungen.map((f) =>
      darf(f)
        ? f
        : {
            ...f,
            titel: 'Vertrauliche Feststellung',
            sachverhalt: '',
            quelleText: 'vertraulich',
            risikoCodes: [],
          },
    ),
  };
}

export const NUR_AKTUELL = 'Änderungen nur im aktuellen Stand möglich';
