// =============================================================================
// Die App des Dienstes wie in Produktion (server.ts): alle Fachrouten aus dem
// Endpunktregister und Abgleich der Routentabelle mit dem Register beim
// Aufbau. Weicht eine Route ab oder fehlt eine, startet der Dienst nicht
// (eine Quelle der Wahrheit, `pruefeGegenRegister`).
// =============================================================================

import { ENDPUNKT_LISTE } from '@tcms/contract';
import type { Tx } from '@tcms/db';
import { erzeugeApp, type AppDeps } from './app';
import type { Routen } from './routen';
import { registriereAlle, type RoutenUmgebung } from './routen/index';

export function erzeugeDienst(
  deps: Omit<AppDeps<Tx>, 'routen' | 'register'> & RoutenUmgebung,
  /** Nur für Tests (Negativfälle des Abgleichs); der Dienst nutzt `registriereAlle`. */
  routen: (r: Routen<Tx>, u: RoutenUmgebung) => void = registriereAlle,
) {
  const { codes, ...app } = deps;
  return erzeugeApp<Tx>({ ...app, routen: (r) => routen(r, { codes }), register: ENDPUNKT_LISTE });
}
