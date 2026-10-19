// =============================================================================
// Dienstkontext einer Route: Transaktion und Akteur aus der Prüfkette, echte
// Uhr, keine Namensauflösung (die kanzleikonsole löst Namen auf) und eine
// Nachweisablage, die nur Verweise der kanzleikonsole annimmt (ADR 0001 §6).
// Personen und Systemakteur bekommen getrennte Kontexte: `dienstKontext` nur
// für Personen, `systemKontext` nur für den Systemakteur (ADR 0001 §3.2).
// =============================================================================
import type { Tx } from '@tcms/db';
import {
  echteUhr,
  keinPersonenVerzeichnis,
  personAkteur,
  systemAkteur,
  verweisAblage,
  type DienstKontext,
  type SystemKontext,
} from '@tcms/service';
import type { RoutenKontext } from '../routen';

/**
 * Kontext einer Fachoperation für Personen. Ein Systemakteur erhält hier
 * `NICHT_GEFUNDEN`, bevor die Operation läuft oder die Transaktion benutzt
 * wird (zweite Schicht neben der Akteursprüfung der Routentabelle).
 */
export function dienstKontext(ctx: RoutenKontext<Tx, unknown, unknown>): DienstKontext {
  return {
    tx: ctx.tx,
    akteur: personAkteur(ctx.akteur),
    uhr: echteUhr,
    personen: keinPersonenVerzeichnis,
    ablage: verweisAblage,
  };
}

/**
 * Kontext einer Systemoperation (Nachrichten abholen, Zustellung bzw.
 * Unzustellbarkeit melden). Jede
 * Person – auch ein Admin – erhält `NICHT_GEFUNDEN`, bevor die Operation läuft.
 */
export function systemKontext(ctx: RoutenKontext<Tx, unknown, unknown>): SystemKontext {
  return { tx: ctx.tx, akteur: systemAkteur(ctx.akteur), uhr: echteUhr };
}
