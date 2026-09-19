import type { ReactNode } from 'react';
import { PAYLOAD_NOTE } from '../charts/format.ts';

type Props = {
  title: string;
  subtitle?: ReactNode;
  /** Right side of the header: toggles, segmented controls. */
  actions?: ReactNode;
  /** Defaults to the payload caveat every traffic chart carries; null hides it. */
  footnote?: ReactNode | null;
  loading?: boolean;
  error?: string | null;
  /** Shown instead of children when set (and not loading or failed). */
  empty?: ReactNode;
  /** Take the full row of the panel grid. */
  wide?: boolean;
  children?: ReactNode;
};

/** A titled card with loading, error and empty states. */
export function Panel({ title, subtitle, actions, footnote = PAYLOAD_NOTE, loading, error, empty, wide, children }: Props) {
  let body = children;
  if (error) {
    body = (
      <div className="panel-state panel-error" role="alert">
        {error}
      </div>
    );
  } else if (empty && !loading) {
    body = <div className="panel-state">{empty}</div>;
  }

  return (
    <section className={`panel${wide ? ' panel-wide' : ''}`} aria-busy={loading || undefined}>
      <header className="panel-head">
        <div>
          <h2 className="panel-title">{title}</h2>
          {subtitle && <p className="panel-subtitle">{subtitle}</p>}
        </div>
        {(actions || loading) && (
          <div className="panel-actions">
            {loading && <span className="spinner" aria-label="loading" />}
            {actions}
          </div>
        )}
      </header>
      <div className="panel-body">{body}</div>
      {footnote && <footer className="panel-foot">{footnote}</footer>}
    </section>
  );
}
