// =============================================================================
// Nur für Tests: Programm einer Testwelt über den Einrichtungsassistenten
// anlegen (Schritte 1–4 und Version 1), wie es die kanzleikonsole täte.
// =============================================================================

import { leeresProfil, type Geschaeftsprofil } from '@tcms/domain';
import { legeProgrammAn, speichereEinrichtungsschritt } from './einrichtung';
import { neuerEntwurf } from './entwurf';
import { btFuer, im, type Welt } from './testwelt';

/** Personen der Kanzlei, wie sie die kanzleikonsole übergibt. */
export function personen(w: Welt) {
  return { berufstraegerId: w.bt, bearbeitungId: w.hb, kanzlei: [w.bt, w.hb, w.dritte] };
}

export function testProfil(): Geschaeftsprofil {
  const p = leeresProfil();
  p.p1 = { eigenerShop: true, shopSystem: 'Shopware 6', marktplaetze: ['Amazon'] };
  p.p3.laender = ['DE', 'AT', 'FR'];
  p.p4.warengruppen = [{ name: 'Outdoor-Ausrüstung', abweichenderSatz: false }];
  p.p6.zahlungswege = ['PayPal', 'Kreditkarte'];
  return p;
}

export const SCHRITT1 = {
  teilbereich: {
    name: 'Umsatzsteuer E-Commerce',
    abgrenzung: 'Umsatzsteuerliche Pflichten aus dem Onlinehandel einschließlich Marktplätzen.',
    einschluesse: ['Onlineshop'],
    ausschluesse: [],
  },
  zeitraum: {
    angemessenheitStichtag: '2026-12-31',
    wirksamAb: '2027-01-01',
    wirksamBis: '2027-06-30',
    erklaerungsTurnus: 'MONATLICH' as const,
  },
};

export function schritt3(w: Welt) {
  const e = neuerEntwurf(new Date('2026-10-19T00:00:00Z'), w.gv);
  return { ziele: e.ziele, freigabe: { anfordern: true, empfaengerId: w.gv } };
}

/** Durchläuft Schritte 1–4 mit „weiter" (Entwurf bereit für Version 1). */
export async function bereiteVor(w: Welt, mandantId = w.mandantA, gv = w.gv): Promise<void> {
  const a = btFuer(w, mandantId);
  const basis = { mandantId, ziel: 'weiter' as const, personen: personen(w) };
  await im(a, (ctx) =>
    speichereEinrichtungsschritt(ctx, { ...basis, schritt: 1, daten: SCHRITT1 }),
  );
  await im(a, (ctx) =>
    speichereEinrichtungsschritt(ctx, { ...basis, schritt: 2, daten: { profil: testProfil() } }),
  );
  const s3 = schritt3(w);
  await im(a, (ctx) =>
    speichereEinrichtungsschritt(ctx, {
      ...basis,
      schritt: 3,
      daten: { ziele: s3.ziele, freigabe: { anfordern: true, empfaengerId: gv } },
    }),
  );
  await im(a, (ctx) =>
    speichereEinrichtungsschritt(ctx, { ...basis, schritt: 4, daten: { risiken: {} } }),
  );
}

/** Schritte 1–4 und Version 1; liefert die Programm-ID. */
export async function richteEin(w: Welt, mandantId = w.mandantA, gv = w.gv): Promise<string> {
  await bereiteVor(w, mandantId, gv);
  const r = await im(btFuer(w, mandantId), (ctx) =>
    legeProgrammAn(ctx, { mandantId, daten: { kontrollen: {} }, personen: personen(w) }),
  );
  return r.programmId;
}
