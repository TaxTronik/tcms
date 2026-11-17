import 'server-only';

// Nummernkreise (Ereignisse und Feststellungen je Programm, Wiedervorlagen je
// Kanzlei) liegen in @tcms/service (kern/nummern.ts, ADR 0001 §4). Diese Datei
// hält nur die bisherigen Importpfade der Demo stabil.
export {
  naechsteEreignisnummer,
  naechsteEreignisnummern,
  naechsteFeststellungsnummer,
  naechsteWiedervorlageNr,
} from '@tcms/service';
