import type { Prisma } from '@prisma/client';

/**
 * CMS-Beschreibung wie im Dienst anlegen: Neue Zeilen entstehen nur als
 * Entwurf (Trigger `BeschreibungVersion_neu`, Hinweis H4 aus RT4); der
 * Zielstand entsteht über die Übergänge Kanzlei-Review → beim Mandanten
 * (eingefroren) → freigegeben → abgelöst, die auch der Dienst nimmt.
 */
export async function versionAnlegen(
  prisma: Pick<Prisma.TransactionClient, 'beschreibungVersion'>,
  d: Omit<Prisma.BeschreibungVersionUncheckedCreateInput, 'status'> & {
    status: 'ENTWURF' | 'KANZLEI_REVIEW' | 'BEIM_MANDANTEN' | 'FREIGEGEBEN' | 'ABGELOEST';
  },
): Promise<{ id: string }> {
  const {
    status,
    reviewAngefordertVon,
    reviewAngefordertAm,
    reviewVon,
    reviewAm,
    freigabeAngefordertAm,
    snapshot,
    snapshotSha256,
    freigegebenVon,
    freigegebenAm,
    ...basis
  } = d;
  const v = await prisma.beschreibungVersion.create({
    data: { ...basis, status: 'ENTWURF' },
    select: { id: true },
  });
  const weiter = (data: Prisma.BeschreibungVersionUncheckedUpdateInput) =>
    prisma.beschreibungVersion.update({ where: { id: v.id }, data });
  if (status === 'ENTWURF') return v;
  const review = { reviewAngefordertVon, reviewAngefordertAm, reviewVon, reviewAm };
  if (status === 'KANZLEI_REVIEW') {
    await weiter({ status, ...review });
    return v;
  }
  await weiter({
    status: 'BEIM_MANDANTEN',
    ...review,
    freigabeAngefordertAm,
    snapshot,
    snapshotSha256,
  });
  if (status === 'BEIM_MANDANTEN') return v;
  await weiter({ status: 'FREIGEGEBEN', freigegebenVon, freigegebenAm });
  if (status === 'ABGELOEST') await weiter({ status: 'ABGELOEST' });
  return v;
}
