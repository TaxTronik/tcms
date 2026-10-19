// Routen des Bereichs „risiken-kontrollen" (Welle 2). Registriert Endpunkte, die ausschließlich
// Funktionen aus @tcms/service aufrufen (ADR 0001 §2).
import type { Tx } from '@tcms/db';
import type { Routen } from '../routen';

export function registriereRisikenKontrollen(_r: Routen<Tx>): void {}
