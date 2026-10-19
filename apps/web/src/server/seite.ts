import 'server-only';
import { notFound } from 'next/navigation';
import { isoDatum } from '@tcms/domain';
import { ladeKontext, type TcmsKontext } from './kontext';
import { kannBearbeiten, kannWuerdigen } from './rechte';
import { brauchtKanzlei, type Nutzer } from './sitzung';
import { leseStand } from './zeit';

export interface StaffSeite {
  nutzer: Nutzer;
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
  const nutzer = await brauchtKanzlei();
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
    darfBearbeiten: !historisch && kannBearbeiten(nutzer, ctx.mandant),
    darfWuerdigen: !historisch && kannWuerdigen(nutzer, ctx.mandant),
    standIso,
    heuteIso: isoDatum(ctx.heute),
    basis: `/staff/clients/${id}/tcms`,
    mitStand,
  };
}

/**
 * Vertrauliche Feststellungen (Fachkonzept §13) nur für Beteiligte: Admin,
 * zuständige:r Berufsträger:in, Hauptbearbeitung, erfassende, würdigende und
 * verantwortliche Personen. Für alle anderen werden Titel und Sachverhalt ersetzt.
 */
export function maskiereVertraulich(ctx: TcmsKontext, n: Nutzer): TcmsKontext {
  const darf = (f: TcmsKontext['feststellungen'][number]) =>
    !f.vertraulich ||
    (n.art === 'KANZLEI' &&
      (n.istAdmin ||
        n.id === ctx.mandant.berufstraegerId ||
        n.id === ctx.mandant.bearbeitungId ||
        f.beteiligte.includes(n.id)));
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
