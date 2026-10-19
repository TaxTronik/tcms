import type { ReactNode } from 'react';
import { Icon, type IconName } from '../icon';

export function Leerzustand({
  icon,
  text,
  children,
}: {
  icon: IconName;
  text: string;
  children?: ReactNode;
}) {
  return (
    <div className="center" style={{ padding: '48px 24px' }}>
      <div style={{ display: 'inline-flex' }} className="text-muted">
        <Icon name={icon} className="tx-icon-xl" />
      </div>
      <p className="text-sm text-muted mt-2">{text}</p>
      {children ? <div className="mt-4">{children}</div> : null}
    </div>
  );
}
