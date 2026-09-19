import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
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

/** An (i) button that shows `children` on hover or focus, or on tap/click (touch has no hover). */
function InfoTip({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  return (
    <span ref={ref} className={`info-tip${open ? ' info-tip-open' : ''}`}>
      <button type="button" className="info-btn" aria-label="More information" aria-expanded={open} aria-describedby={id} onClick={() => setOpen((o) => !o)}>
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
          <circle cx="8" cy="4.9" r="0.95" fill="currentColor" />
          <path d="M8 7.3v4.4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      </button>
      <span id={id} role="tooltip" className="info-pop">
        {children}
      </span>
    </span>
  );
}

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
            {subtitle && <InfoTip>{subtitle}</InfoTip>}
          </h2>
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
