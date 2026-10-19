// =============================================================================
// Texte der Nachrichten im Postausgang (Portal in Sie-Form). Ohne Namen und
// ohne Adressen: Die kanzleikonsole adressiert über die Empfänger-ID (TS-06)
// und kann persönlich anreden.
// =============================================================================

import { fmtDatum } from '@tcms/domain';

/** Nachricht mit Bestätigungscode für genau eine Freigabe. */
export function codeNachrichtText(o: {
  mandant: string;
  titel: string;
  code: string;
  codeAblauf: Date;
  sha256?: string | null;
}): { betreff: string; text: string } {
  return {
    betreff: `Freigabe angefordert: ${o.titel}`,
    text: [
      'Guten Tag,',
      '',
      `Ihre Kanzlei bittet Sie um Freigabe: ${o.titel} (${o.mandant}).`,
      '',
      `Ihr Bestätigungscode: ${o.code}`,
      `Der Code ist bis ${fmtDatum(o.codeAblauf)} gültig und nur für diese Freigabe verwendbar. Sie finden die Anforderung im Mandantenportal unter „Freigaben & Kenntnisnahmen“.`,
      ...(o.sha256 ? ['', `SHA-256 des vorgelegten Inhalts: ${o.sha256}`] : []),
    ].join('\n'),
  };
}

/** Hinweis an die neu adressierte Person (ohne Code). */
export function neuAdressiertText(o: { mandant: string; titel: string; brauchtCode: boolean }): {
  betreff: string;
  text: string;
} {
  return {
    betreff: `${o.brauchtCode ? 'Freigabe' : 'Kenntnisnahme'} angefordert: ${o.titel}`,
    text: [
      'Guten Tag,',
      '',
      `Ihre Kanzlei hat folgende Anforderung an Sie gerichtet: ${o.titel} (${o.mandant}).`,
      o.brauchtCode
        ? 'Den Bestätigungscode fordern Sie im Mandantenportal unter „Freigaben & Kenntnisnahmen“ an.'
        : 'Sie finden das Dokument im Mandantenportal unter „Freigaben & Kenntnisnahmen“.',
    ].join('\n'),
  };
}
