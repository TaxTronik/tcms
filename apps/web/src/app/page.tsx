import { redirect } from 'next/navigation';
import { aktuellePerson } from '@/server/sitzung';

export default async function Start() {
  const n = await aktuellePerson();
  if (!n) redirect('/anmelden');
  redirect(n.art === 'KANZLEI' ? '/staff/tcms' : '/portal/tcms');
}
