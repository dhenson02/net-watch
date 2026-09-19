import type { ReactNode } from 'react';

export type Tone = 'ok' | 'warn' | 'bad';

type Props = {
  label: string;
  value: ReactNode;
  unit?: string;
  /** Usually a <Sparkline>, drawn under the value. */
  spark?: ReactNode;
  /** Left border color. Omit for tiles that have no health judgement. */
  tone?: Tone;
  /** Words that carry the tone without color ("OK", "Lagging", …). */
  status?: string;
  subtitle?: ReactNode;
};

const ICON: Record<Tone, string> = { ok: '✓', warn: '!', bad: '✕' };

/** One KPI: label, big value, optional sparkline and a tone shown as border + icon + word. */
export function StatTile({ label, value, unit, spark, tone, status, subtitle }: Props) {
  return (
    <section className={`stat-tile${tone ? ` tone-${tone}` : ''}`} aria-label={label}>
      <header className="stat-tile-head">
        <h2 className="stat-label">{label}</h2>
        {tone && status && (
          <span className="stat-status">
            <span className="stat-icon" aria-hidden="true">
              {ICON[tone]}
            </span>
            {status}
          </span>
        )}
      </header>
      <div className="stat-value num">
        {value}
        {unit && <span className="stat-unit"> {unit}</span>}
      </div>
      {spark && <div className="stat-spark">{spark}</div>}
      {subtitle && <p className="stat-sub">{subtitle}</p>}
    </section>
  );
}
