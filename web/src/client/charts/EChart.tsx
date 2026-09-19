import { useEffect, useLayoutEffect, useRef, type CSSProperties, type RefObject } from 'react';
import { echarts, type EChartsCoreOption, type EChartsType } from './echarts.ts';
import { themeName } from './theme.ts';
import { useColorScheme } from './useColorScheme.ts';

type Handler = (params: any) => void;

type Props = {
  option: EChartsCoreOption;
  onEvents?: Record<string, Handler>;
  /** Charts sharing a group get linked cursors and tooltips (echarts.connect). */
  group?: string;
  /** Receives the instance, for incremental updates (see useEChartRef). */
  chartRef?: RefObject<EChartsType | null>;
  /** Called after every (re)creation, e.g. to re-apply data pushed through chartRef. */
  onInit?: (chart: EChartsType) => void;
  height?: number | string;
  className?: string;
  style?: CSSProperties;
  ariaLabel?: string;
};

/** A ref for an EChart's instance. Live charts push new data through it:
 *  `ref.current?.setOption({ series: [{ id, data }] })` instead of rebuilding
 *  the option each tick. It is null while the chart is (re)created. */
export function useEChartRef() {
  return useRef<EChartsType | null>(null);
}

/**
 * The one ECharts wrapper. Resizes with its container and re-creates itself
 * with the matching theme when the OS color scheme flips. `option` is merged
 * on change (notMerge: false), so memoize it.
 */
export function EChart({ option, onEvents, group, chartRef, onInit, height = 280, className, style, ariaLabel }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<EChartsType | null>(null);
  const scheme = useColorScheme();
  const latest = useRef({ option, onInit });
  latest.current = { option, onInit };

  useLayoutEffect(() => {
    const c = echarts.init(el.current!, themeName(scheme));
    c.setOption({ aria: { enabled: true }, ...latest.current.option });
    chart.current = c;
    if (chartRef) chartRef.current = c;
    latest.current.onInit?.(c);
    const ro = new ResizeObserver(() => c.resize());
    ro.observe(el.current!);
    return () => {
      ro.disconnect();
      c.dispose();
      chart.current = null;
      if (chartRef) chartRef.current = null;
    };
  }, [scheme, chartRef]);

  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false; // the layout effect already applied it
      return;
    }
    chart.current?.setOption(option, { notMerge: false, lazyUpdate: true });
  }, [option]);

  useEffect(() => {
    const c = chart.current;
    if (!c || !onEvents) return;
    for (const [name, fn] of Object.entries(onEvents)) c.on(name, fn);
    return () => {
      for (const [name, fn] of Object.entries(onEvents)) c.off(name, fn);
    };
  }, [onEvents, scheme]);

  useEffect(() => {
    const c = chart.current;
    if (!c || !group) return;
    c.group = group;
    echarts.connect(group);
  }, [group, scheme]);

  return <div ref={el} className={className} style={{ width: '100%', height, ...style }} role="img" aria-label={ariaLabel} />;
}
