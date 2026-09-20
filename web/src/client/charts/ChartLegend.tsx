import { useCallback, useEffect, useState, type RefObject } from 'react';
import type { EChartsType } from './echarts.ts';
import { useColorScheme } from './useColorScheme.ts';

export type LegendItem = { name: string; color: string; /** Drawn with a lighter fill (a reused hue). */ faded?: boolean };

const selectedOf = (c: EChartsType | null): Record<string, boolean> =>
  ((c?.getOption() as { legend?: { selected?: Record<string, boolean> }[] } | undefined)?.legend?.[0]?.selected) ?? {};

/**
 * The chart's legend as a checkbox list for the side panel. The chart keeps a
 * hidden ECharts legend (`legend: { show: false, data }`), so selection,
 * `legendselectchanged` handlers and stacking behave as with a drawn legend.
 */
export function ChartLegend({ chart, items, title = 'Series', hint }: { chart: RefObject<EChartsType | null>; items: readonly LegendItem[]; title?: string; hint?: string }) {
  const scheme = useColorScheme();
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const sync = useCallback(() => {
    setHidden(new Set(Object.entries(selectedOf(chart.current)).flatMap(([k, on]) => (on ? [] : [k]))));
  }, [chart]);

  // The chart is re-created when the color scheme flips, so re-bind then; item changes cover data pushes.
  useEffect(() => {
    const c = chart.current;
    if (!c) return;
    c.on('legendselectchanged', sync);
    sync();
    return () => {
      c.off('legendselectchanged', sync);
    };
  }, [chart, sync, scheme, items]);

  if (items.length === 0) return null;
  return (
    <fieldset className="tt-names chart-legend">
      <legend>
        {title}
        <button type="button" className="tt-names-all" disabled={hidden.size === 0} onClick={() => (chart.current?.dispatchAction({ type: 'legendAllSelect' }), sync())}>
          show all
        </button>
      </legend>
      <ul>
        {items.map((it) => (
          <li key={it.name}>
            <label title={hint}>
              <input type="checkbox" checked={!hidden.has(it.name)} onChange={() => (chart.current?.dispatchAction({ type: 'legendToggleSelect', name: it.name }), sync())} />
              <i className="legend-swatch" style={{ background: it.color, opacity: it.faded ? 0.6 : 1 }} aria-hidden="true" />
              <span title={it.name}>{it.name}</span>
            </label>
          </li>
        ))}
      </ul>
    </fieldset>
  );
}
