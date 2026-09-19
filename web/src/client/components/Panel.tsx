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
  /** Element id, e.g. a scroll target. */
  id?: string;
  /**
   * Makes the title a disclosure button (▸/▾) that calls `onToggle`; while
   * `collapsed`, only the header shows.
   */
  collapsible?: { collapsed: boolean; onToggle: () => void };
};

/** A titled card with loading, error and empty states. */
export function Panel({ title, subtitle, actions, footnote = PAYLOAD_NOTE, loading, error, empty, wide, children, id, collapsible }: Props) {
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
    <section id={id} className={`panel${wide ? ' panel-wide' : ''}`} aria-busy={loading || undefined}>
      <header className="panel-head">
        <div>
          <h2 className="panel-title">
            {collapsible ? (
              <button type="button" className="panel-toggle" aria-expanded={!collapsible.collapsed} onClick={collapsible.onToggle}>
                {title} <span aria-hidden="true">{collapsible.collapsed ? '▸' : '▾'}</span>
              </button>
            ) : (
              title
            )}
          </h2>
          {subtitle && <p className="panel-subtitle">{subtitle}</p>}
        </div>
        {(actions || loading) && (
          <div className="panel-actions">
            {loading && <span className="spinner" aria-label="loading" />}
            {actions}
          </div>
        )}
      </header>
      {!collapsible?.collapsed && (
        <>
          <div className="panel-body">{body}</div>
          {footnote && <footer className="panel-foot">{footnote}</footer>}
        </>
      )}
    </section>
  );
}
