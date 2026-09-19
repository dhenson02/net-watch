// ECharts themes built from the page's CSS custom properties, so charts use
// the same ink, gridlines and surface as the rest of the UI. ECharts cannot
// switch a theme in place: EChart re-creates the chart when the scheme flips.
import { echarts } from './echarts.ts';
import { CATEGORICAL, type Scheme } from './palette.ts';

export function themeName(scheme: Scheme): string {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  const text = v('--text');
  const muted = v('--muted');
  const grid = v('--chart-grid');
  const axis = v('--chart-axis');
  const surface = v('--surface');

  const axisCommon = {
    axisLine: { lineStyle: { color: axis } },
    axisTick: { lineStyle: { color: axis } },
    axisLabel: { color: muted },
    splitLine: { lineStyle: { color: grid, width: 1 } },
    nameTextStyle: { color: muted },
  };

  const name = `net-watch-${scheme}`;
  echarts.registerTheme(name, {
    color: [...CATEGORICAL[scheme]],
    backgroundColor: 'transparent',
    textStyle: { fontFamily: 'inherit', color: text },
    legend: { textStyle: { color: text }, inactiveColor: muted },
    tooltip: {
      backgroundColor: surface,
      borderColor: v('--border'),
      textStyle: { color: text },
      extraCssText: 'box-shadow: 0 4px 16px rgb(0 0 0 / 0.18); border-radius: 6px;',
    },
    categoryAxis: axisCommon,
    valueAxis: axisCommon,
    timeAxis: axisCommon,
    logAxis: axisCommon,
    line: { symbol: 'none', lineStyle: { width: 2 } },
    axisPointer: { lineStyle: { color: muted }, crossStyle: { color: muted } },
  });
  return name;
}
