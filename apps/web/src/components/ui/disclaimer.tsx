import { HINWEIS_PFLICHTFRAMING } from '@tcms/domain';
import { Icon } from '../icon';

/** Pflicht-Framing (Konzept 6.7): Struktur und Beleg, kein Urteil. */
export function Disclaimer() {
  const [kopf, ...rest] = HINWEIS_PFLICHTFRAMING.split('. ');
  return (
    <div
      className="alert-warning"
      style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}
      role="note"
    >
      <Icon name="ShieldAlert" className="tx-icon-lg" />
      <p>
        <strong>{kopf}.</strong> {rest.join('. ')}
      </p>
    </div>
  );
}
