import type { ReactNode } from 'react';
import { abschnittHatText, type Abschnitt, type AbschnittVorlage } from '@tcms/domain';
import { Icon } from '@/components/icon';
import { BausteinBlock } from './baustein';
import type { BausteinQuelle } from './typen';

/** Freitext mit Absätzen (Leerzeile) und Zeilenumbrüchen. */
export function Freitext({ text }: { text: string }) {
  const absaetze = text
    .split(/\n\s*\n/)
    .map((a) => a.trim())
    .filter(Boolean);
  return (
    <>
      {absaetze.map((a, i) => (
        <p key={i} className="text-sm" style={{ margin: '0 0 10px', whiteSpace: 'pre-line' }}>
          {a}
        </p>
      ))}
    </>
  );
}

/** Abschnitt im Lesemodus: Freitextblöcke und lebende bzw. eingefrorene Bausteine. */
export function AbschnittAnsicht({
  abschnitt,
  vorlage,
  quelle,
  mitTitel = false,
  lueckenHinweis = true,
  fuss,
}: {
  abschnitt: Abschnitt;
  vorlage: AbschnittVorlage;
  quelle: BausteinQuelle;
  mitTitel?: boolean;
  lueckenHinweis?: boolean;
  fuss?: ReactNode;
}) {
  const hatText = abschnittHatText(abschnitt);
  return (
    <section
      id={`abschnitt-${abschnitt.key}`}
      style={{ display: 'flex', flexDirection: 'column', gap: 4 }}
    >
      {mitTitel ? (
        <h3 className="text-base font-s mb-2" style={{ marginTop: 8 }}>
          {vorlage.nr === 'A' ? 'Anhang' : `${vorlage.nr} ${vorlage.titel}`}
        </h3>
      ) : null}
      {!hatText && lueckenHinweis ? (
        <div
          className="alert-warning text-sm mb-2"
          style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '8px 12px' }}
        >
          <Icon name="TriangleAlert" className="tx-icon-xs" />
          <span>
            Kein Freitext — Lücke in diesem Abschnitt. Die Beschreibung ist Aufgabe der gesetzlichen
            Vertreter; die Kanzlei bereitet den Text vor.
          </span>
        </div>
      ) : null}
      {abschnitt.bloecke.map((b, i) =>
        b.typ === 'text' ? (
          b.text.trim() ? (
            <Freitext key={i} text={b.text} />
          ) : null
        ) : (
          <BausteinBlock key={i} art={b.art} quelle={quelle} />
        ),
      )}
      {fuss}
    </section>
  );
}
