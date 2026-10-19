import 'server-only';
import { notFound } from 'next/navigation';
import { isoDatum } from '@tcms/domain';
import { kannLesen, kontextRechte } from '@tcms/service';
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

/**
 * Kontext einer Staff-Seite (TS-03): Ohne Bezug zum Mandanten oder ohne
 * Leserecht 404 statt 403, damit keine Existenz verraten wird (ADR 0001 §3.3).
 * Leserecht und Maskierung vertraulicher Feststellungen prüft der Service
 * (`ladeKontext`); die Rechte-Kennzeichen kommen aus `kontextRechte`.
 */
export async function ladeStaffSeite(
  id: string,
  sp: Record<string, string | string[] | undefined>,
): Promise<StaffSeite> {
  const nutzer = await brauchtKanzleiFuer(id);
  if (!kannLesen(nutzer, id)) notFound();
  const { stand, historisch } = leseStand(sp['stand']);
  const ctx = await ladeKontext(id, isoDatum(stand), historisch);
  if (!ctx) notFound();
  const standIso = isoDatum(ctx.stand);
  const rechte = kontextRechte(nutzer, ctx);
  const mitStand = (href: string) =>
    ctx.historisch ? `${href}${href.includes('?') ? '&' : '?'}stand=${standIso}` : href;
  return {
    nutzer,
    ctx,
    darfBearbeiten: rechte.bearbeiten,
    darfWuerdigen: rechte.wuerdigen,
    standIso,
    heuteIso: isoDatum(ctx.heute),
    basis: `/staff/clients/${id}/tcms`,
    mitStand,
  };
}

export const NUR_AKTUELL = 'Änderungen nur im aktuellen Stand möglich';
