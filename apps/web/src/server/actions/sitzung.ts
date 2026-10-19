'use server';

import { redirect } from 'next/navigation';
import { prisma } from '@tcms/db';
import { beendeSitzung, devLoginErlaubt, setzeSitzung } from '../sitzung';

export async function anmelden(formData: FormData): Promise<void> {
  if (!devLoginErlaubt())
    throw new Error('Die Entwicklungs-Anmeldung ist in dieser Umgebung deaktiviert.');
  const id = String(formData.get('personId') ?? '');
  const person = await prisma.person.findUnique({ where: { id } });
  if (!person || !person.aktiv) redirect('/anmelden?fehler=1');
  await setzeSitzung(person.id);
  redirect(person.art === 'KANZLEI' ? '/staff/tcms' : '/portal/tcms');
}

export async function abmelden(): Promise<void> {
  await beendeSitzung();
  redirect('/anmelden');
}
