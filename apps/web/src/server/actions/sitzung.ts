'use server';

import { redirect } from 'next/navigation';
import { demoPerson } from '../demo';
import { beendeSitzung, demoLoginErlaubt, setzeSitzung } from '../sitzung';

export async function anmelden(formData: FormData): Promise<void> {
  // TS-01: in Produktion immer verweigert, unabhängig von Schaltern.
  if (!demoLoginErlaubt())
    throw new Error('Die Demo-Anmeldung ist in dieser Umgebung deaktiviert.');
  const person = demoPerson(String(formData.get('personId') ?? ''));
  if (!person) redirect('/anmelden?fehler=1');
  await setzeSitzung(person.id);
  redirect(person.art === 'KANZLEI' ? '/staff/tcms' : '/portal/tcms');
}

export async function abmelden(): Promise<void> {
  await beendeSitzung();
  redirect('/anmelden');
}
