import type { ReactNode } from "react";

/**
 * A chart with its filters in a left side panel, as in Top talkers. The chart
 * sets the height; the panel matches it and scrolls when its controls and
 * legend need more room. Stacks (controls above the chart) on narrow screens.
 */
export function ChartLayout({
  side,
  children,
}: {
  side: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="chart-layout">
      <aside className="chart-side" aria-label="Filters">
        <div className="chart-side-inner">{side}</div>
      </aside>
      <div className="chart-main">{children}</div>
    </div>
  );
}
