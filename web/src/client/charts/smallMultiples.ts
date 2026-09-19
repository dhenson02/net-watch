// Small multiples on one shared time axis (14, reused by 13 on the Process
// page): N grids stacked vertically in one ECharts instance, one x axis per
// grid (only the bottom one labelled), one cursor across all of them
// (axisPointer link) and one zoom (a dataZoom over every x axis). Each panel
// names its own y axis, so no legend is needed. Pure: no DOM, so node --test
// covers it.
import type { EChartsCoreOption } from './echarts.ts';
import { GRID } from './mirroredStack.ts';

export interface MultiplePanel {
  /** The y axis name, drawn at the panel's top-left. */
  name: string;
  /** Share of the plotting height, relative to the other panels' weights. */
  weight: number;
  /** Merged over the panel's value y axis (`type: 'log'`, formatters, min/max). */
  yAxis?: Record<string, unknown>;
  /** The panel's series; the builder sets their axis indexes. */
  series: Record<string, unknown>[];
}

export interface SmallMultiplesSpec {
  panels: readonly MultiplePanel[];
  /** The x extent, ms. */
  x: { min: number; max: number };
  /** Axis tooltip formatter over every panel. */
  tooltip?: (params: any) => string;
  /** Merged over the result (e.g. more dataZoom options). */
  extra?: EChartsCoreOption;
}

export interface Layout {
  /** Chart height, px. */
  height: number;
  /** Room above the first panel (its y axis name), px. */
  top?: number;
  /** Room under the last panel (the time labels), px. */
  bottom?: number;
  /** Room between panels (the next panel's name), px. */
  gap?: number;
}

export const MULTIPLES_LAYOUT = { top: 24, bottom: 28, gap: 30 } as const;

/**
 * The grids' tops and heights (px): the plotting height left after `top`,
 * `bottom` and the gaps, split by weight. Rounded so panels never overlap.
 */
export function gridLayout(weights: readonly number[], l: Layout): { top: number; height: number }[] {
  const top = l.top ?? MULTIPLES_LAYOUT.top;
  const bottom = l.bottom ?? MULTIPLES_LAYOUT.bottom;
  const gap = l.gap ?? MULTIPLES_LAYOUT.gap;
  const sum = weights.reduce((s, w) => s + w, 0) || 1;
  const plot = Math.max(0, l.height - top - bottom - gap * (weights.length - 1));
  const out: { top: number; height: number }[] = [];
  let y = top;
  for (const w of weights) {
    const h = Math.floor((plot * w) / sum);
    out.push({ top: y, height: h });
    y += h + gap;
  }
  return out;
}

/**
 * The option: grids, x axes (time, `x` extent, labels on the bottom one
 * only), y axes named per panel, the panels' series on their grid, the
 * linked axis pointer, an axis tooltip and an inside dataZoom (ctrl+wheel)
 * over every x axis.
 */
export function smallMultiplesOption(spec: SmallMultiplesSpec, layout: Layout, muted: string): EChartsCoreOption {
  const { panels, x } = spec;
  const grids = gridLayout(
    panels.map((p) => p.weight),
    layout,
  );
  const last = panels.length - 1;
  const xIndexes = panels.map((_, i) => i);
  return {
    animation: false,
    grid: grids.map((g) => ({ left: GRID.left, right: GRID.right, top: g.top, height: g.height })),
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    tooltip: { trigger: 'axis', axisPointer: { type: 'line' }, confine: true, ...(spec.tooltip && { formatter: spec.tooltip }) },
    xAxis: panels.map((_, i) => ({
      type: 'time',
      gridIndex: i,
      min: x.min,
      max: x.max,
      splitLine: { show: false },
      axisTick: { show: i === last },
      axisLabel: { show: i === last },
      // The cursor's time label only once, under the bottom panel.
      axisPointer: { label: { show: i === last } },
    })),
    yAxis: panels.map((p, i) => ({
      type: 'value',
      gridIndex: i,
      name: p.name,
      nameLocation: 'end',
      nameGap: 8,
      nameTextStyle: { align: 'left', color: muted, fontSize: 16 },
      splitNumber: 3,
      ...p.yAxis,
    })),
    series: panels.flatMap((p, i) => p.series.map((s) => ({ ...s, xAxisIndex: i, yAxisIndex: i }))),
    dataZoom: [{ type: 'inside', xAxisIndex: xIndexes, zoomOnMouseWheel: 'ctrl', moveOnMouseMove: false, moveOnMouseWheel: false }],
    ...spec.extra,
  };
}
