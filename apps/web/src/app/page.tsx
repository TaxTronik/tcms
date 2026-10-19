import { redirect } from 'next/navigation';
import { aktuellerNutzer } from '@/server/sitzung';

export default async function Start() {
  const n = await aktuellerNutzer();
  if (!n) redirect('/anmelden');
  redirect(n.art === 'KANZLEI' ? '/staff/tcms' : '/portal/tcms');
}
