// The stacked-area throughput chart shared by Live (01) and History (05):
// a time x axis, bands stacked per direction, tx above zero and rx mirrored
// below it (or one stack above zero), thin total lines on top, and an axis
// tooltip sectioned by direction.
//
// Series ids follow one scheme, which the tooltip relies on:
//   `${stack}:${key}`  a band (stack is tx, rx or sum)
//   `total:${stack}`   the stack's total line
// Anything else (an overlay's series) is listed after the sections with its
// series name, unless `omit` names its id prefix (11's ghost lines and 13's
// band, whose rows `sectionRows` puts inside each section instead).
import type { EChartsCoreOption } from './echarts.ts';
import { fmtRate, fmtTime } from './format.ts';

/** tx and rx, or tx + rx summed into one stack. */
export type Stack = 'tx' | 'rx' | 'sum';
export type Point = [ts: number, kbps: number | null];

export const STACK_LABEL: Record<Stack, string> = { tx: '↑ sent', rx: '↓ received', sum: '⇅ sent + received' };

export const GRID = { top: 32, right: 16, bottom: 28, left: 64 };

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

type TipParam = { seriesId: string; seriesName: string; value: [number, number | null]; color: string };

export const tipRow = (color: string, name: string, value: string) =>
  `<div class="tip-row"><span class="tip-swatch" style="background:${color}"></span>` +
  `<span class="tip-name">${esc(name)}</span><span class="tip-num">${value}</span></div>`;

const STACK_OF = /^(tx|rx|sum):/;

/**
 * Axis tooltip formatter: the time (plus `note`, e.g. the bucket width), then
 * one section per stack with its total and its bands, largest first, zero
 * rows left out; then any other series.
 */
export function stackTooltip(
  stacks: readonly Stack[],
  opts: {
    timeStyle?: 'time' | 'datetime';
    note?: string;
    /** Extra rows (tipRow HTML) under a section's total, before its bands. */
    sectionRows?: (stack: Stack, ts: number, total: number | null) => string;
    /** Series id prefixes left out of the rows after the sections. */
    omit?: string | readonly string[];
  } = {},
) {
  return (params: TipParam[]): string => {
    const ts = params[0]?.value[0];
    if (ts === undefined) return '';
    const section = (stack: Stack) => {
      const rows = params
        .filter((p) => p.seriesId.startsWith(`${stack}:`) && p.value[1])
        .sort((a, b) => Math.abs(b.value[1]!) - Math.abs(a.value[1]!))
        .map((p) => tipRow(p.color, p.seriesName, fmtRate(Math.abs(p.value[1]!))))
        .join('');
      const v = params.find((p) => p.seriesId === `total:${stack}`)?.value[1];
      const total = v === null || v === undefined ? '—' : fmtRate(Math.abs(v));
      const more = opts.sectionRows?.(stack, ts, v ?? null) ?? '';
      return `<div class="tip-head"><span>${STACK_LABEL[stack]}</span><span class="tip-num">${total}</span></div>${more}${rows}`;
    };
    const omit = opts.omit === undefined ? [] : typeof opts.omit === 'string' ? [opts.omit] : opts.omit;
    const omitted = (id: string) => omit.some((prefix) => id.startsWith(prefix));
    const extra = params
      .filter((p) => !STACK_OF.test(p.seriesId) && !p.seriesId.startsWith('total:') && !omitted(p.seriesId) && p.value[1] !== null && p.value[1] !== undefined)
      .map((p) => tipRow(p.color, p.seriesName, fmtRate(Math.abs(p.value[1]!))))
      .join('');
    const note = opts.note ? ` <span class="muted">${esc(opts.note)}</span>` : '';
    return `<div class="tip"><div class="tip-time">${fmtTime(ts, opts.timeStyle ?? 'time')}${note}</div>${stacks.map(section).join('')}${extra}</div>`;
  };
}

/** One band: a stacked area without stroke. `faded` lowers the fill (colors reused past the palette). */
export function bandSeries(b: { key: string; label: string; color: string; faded?: boolean }, stack: Stack, data: Point[]) {
  const opacity = stack === 'rx' ? 0.6 : 0.85;
  return {
    id: `${stack}:${b.key}`,
    name: b.label,
    type: 'line',
    stack,
    data,
    color: b.color,
    areaStyle: { opacity: b.faded ? opacity * 0.5 : opacity },
    lineStyle: { width: 0 },
    symbol: 'none',
    showSymbol: false,
    sampling: 'lttb',
    emphasis: { disabled: true },
  };
}

/** The stack's total as a thin line in `ink`; `zeroLine` also draws the y = 0 rule (once per chart). */
export function totalSeries(stack: Stack, data: Point[], ink: string, zeroLine = false) {
  return {
    id: `total:${stack}`,
    name: 'total',
    type: 'line',
    data,
    color: ink,
    lineStyle: { width: 1, color: ink, opacity: 0.7 },
    symbol: 'none',
    showSymbol: false,
    sampling: 'lttb',
    silent: true,
    z: 3,
    emphasis: { disabled: true },
    ...(zeroLine && {
      markLine: { silent: true, symbol: 'none', label: { show: false }, lineStyle: { color: ink, type: 'solid', width: 1, opacity: 0.5 }, data: [{ yAxis: 0 }] },
    }),
  };
}

type OptionOpts = {
  /** The stacks drawn: [tx, rx] mirrors rx below zero; a single stack sits above zero. */
  stacks: readonly Stack[];
  /** Muted text color for the in-plot direction labels. */
  muted: string;
  tooltip: (params: any) => string;
  grid?: Partial<typeof GRID>;
  /** Merged over the result (dataZoom, brush, …). */
  extra?: EChartsCoreOption;
};

/**
 * The chart's structure, without series: grid, scrolling legend, axis
 * tooltip, time x axis, |value| rate y axis, and the direction labels inside
 * the plot (top-left, and bottom-left when mirrored). Series come from
 * bandSeries/totalSeries and are pushed separately.
 */
export function mirroredStackOption({ stacks, muted, tooltip, grid: gridPatch, extra }: OptionOpts): EChartsCoreOption {
  const grid = { ...GRID, ...gridPatch };
  // Always two labels with fixed ids, so a merged option change between one
  // and two stacks updates both rather than leaving a stale second label.
  const label = (id: string, text: string, pos: { top?: number; bottom?: number }) => ({
    id,
    type: 'text',
    left: grid.left + 8,
    ...pos,
    silent: true,
    z: 10,
    style: { text, fill: muted, font: '11px sans-serif' },
  });
  const mirrored = stacks.length === 2;
  return {
    animation: false,
    grid,
    legend: { type: 'scroll', top: 0, left: 0, right: 0, icon: 'roundRect', itemWidth: 10, itemHeight: 10 },
    tooltip: { trigger: 'axis', axisPointer: { type: 'line' }, formatter: tooltip, confine: true },
    xAxis: { type: 'time', splitLine: { show: false } },
    yAxis: { type: 'value', axisLabel: { formatter: (v: number) => fmtRate(Math.abs(v)) } },
    graphic: [
      label('stack-label-top', STACK_LABEL[stacks[0]!], { top: grid.top + 4 }),
      label('stack-label-bottom', mirrored ? STACK_LABEL[stacks[1]!] : '', { bottom: grid.bottom + 4 }),
    ],
    ...extra,
  };
}
