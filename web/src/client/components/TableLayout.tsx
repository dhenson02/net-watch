import type { ReactNode } from "react";

/**
 * A table with its filters and toggles in a left side panel, laid out like a
 * chart (see ChartLayout). The container has a fixed height: the panel and the
 * table each scroll on their own, and header cells stick to the top of the
 * table. Stacks (controls above the table) on narrow screens.
 */
export function TableLayout({
  side,
  children,
}: {
  side?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="chart-layout table-layout">
      {side && (
        <aside className="chart-side" aria-label="Filters">
          <div className="chart-side-inner">{side}</div>
        </aside>
      )}
      <div className="chart-main table-main">{children}</div>
    </div>
  );
}
