'use server';

import { redirect } from 'next/navigation';
import { parseJsonStrikt, type ProfilAendern } from '@tcms/contract';
import { profilAendern, vorgeschlagenesRisikoAufnehmen } from '@tcms/service';
import { demoPersonen, zustaendigkeit } from '../demo';
import { aktualisiereMandant } from '../aktion';
import type { Ergebnis } from '../ergebnis';
import { feld, fuehreAus } from '../risiken-kontrollen-aufruf';

// =============================================================================
// Geschäftsprofil (Profil-Tab): dünne Hüllen um @tcms/service (Bereich
// risiken-kontrollen). Die Demo spielt die kanzleikonsole: Für „Risiko
// aufnehmen" übergibt sie die verantwortlichen Kanzleipersonen des Mandanten
// aus ihrem Verzeichnis (nur Vorbelegung, nie Rechte – Nachtrag Welle 2).
// =============================================================================

export async function aendereProfil(_prev: Ergebnis, fd: FormData): Promise<Ergebnis> {
  const mandantId = feld(fd, 'mandantId');
  // Strenges JSON wie im Dienst: keine doppelten Schlüssel, kein __proto__.
  const json = parseJsonStrikt(new TextEncoder().encode(feld(fd, 'profil')));
  if (!json.ok) return { fehler: 'Das Profil konnte nicht gelesen werden.' };
  const r = await fuehreAus(
    mandantId,
    (ctx) =>
      profilAendern(ctx, {
        mandantId,
        profilStandId: feld(fd, 'profilStandId'),
        profil: json.wert as ProfilAendern['profil'],
        gueltigAb: feld(fd, 'gueltigAb'),
        ereignisseAnlegen: feld(fd, 'ereignisse') === 'on',
      }),
    {
      ungueltig: 'Bitte die Eingaben prüfen (Profil und Gültig-ab-Datum).',
      nichtGefunden: 'Tax-CMS nicht gefunden.',
    },
  );
  if ('fehler' in r) return r;
  aktualisiereMandant(mandantId);
  redirect(
    `/staff/clients/${mandantId}/tcms/profil?geaendert=1&nb=${r.wert.neuBewerten.length}&ev=${r.wert.ereignisse.length}&nv=${r.wert.neuVorgeschlagen.length}#historie`,
  );
}

/**
 * Verantwortliche Kanzleipersonen des Mandanten, wie sie die kanzleikonsole
 * übergäbe: zuständige:r Berufsträger:in, Hauptbearbeitung und als Vertretung
 * die erste weitere Kanzleiperson (nach Name).
 */
function verantwortlicheAusVerzeichnis(mandantId: string) {
  const z = zustaendigkeit(mandantId);
  const kanzlei = [...demoPersonen.alle()]
    .filter((p) => p.art === 'KANZLEI')
    .sort((a, b) => a.name.localeCompare(b.name, 'de'));
  const person = (id: string | null) => {
    const p = kanzlei.find((x) => x.id === id);
    return p ? { id: p.id, name: p.name } : null;
  };
  const berufstraeger = person(z.berufstraegerId);
  const hauptbearbeitung = person(z.bearbeitungId);
  if (!berufstraeger || !hauptbearbeitung) return null;
  const vertretung =
    kanzlei.find((p) => p.id !== berufstraeger.id && p.id !== hauptbearbeitung.id) ?? null;
  return {
    berufstraeger,
    hauptbearbeitung,
    vertretung: vertretung ? { id: vertretung.id, name: vertretung.name } : null,
  };
}

export async function nimmVorgeschlagenesRisikoAuf(
  _prev: Ergebnis,
  fd: FormData,
): Promise<Ergebnis> {
  const mandantId = feld(fd, 'mandantId');
  const verantwortliche = verantwortlicheAusVerzeichnis(mandantId);
  if (!verantwortliche) return { fehler: 'Mandant nicht gefunden.' };
  const r = await fuehreAus(
    mandantId,
    (ctx) =>
      vorgeschlagenesRisikoAufnehmen(ctx, {
        mandantId,
        code: feld(fd, 'code'),
        verantwortliche,
      }),
    { ungueltig: 'Bitte die Eingaben prüfen.', nichtGefunden: 'Tax-CMS nicht gefunden.' },
  );
  if ('fehler' in r) return r;
  aktualisiereMandant(mandantId);
  const e = r.wert;
  const q = new URLSearchParams({ aufgenommen: e.code, d: String(e.durchfuehrungen) });
  if (e.neueKontrollen.length) q.set('kn', e.neueKontrollen.join(','));
  if (e.verknuepft.length) q.set('vk', e.verknuepft.join(','));
  if (e.neuGeplant.length) q.set('ng', e.neuGeplant.map((n) => n.code).join(','));
  redirect(`/staff/clients/${mandantId}/tcms/profil?${q.toString()}#vorschlaege`);
}
