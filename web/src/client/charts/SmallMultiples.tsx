import { useMemo, type RefObject } from 'react';
import { cssVar } from './cssVar.ts';
import { EChart } from './EChart.tsx';
import type { EChartsType } from './echarts.ts';
import { smallMultiplesOption, type Layout, type SmallMultiplesSpec } from './smallMultiples.ts';
import { useColorScheme } from './useColorScheme.ts';

type Props = {
  /** Memoize it: a new spec re-applies the option. */
  spec: SmallMultiplesSpec;
  height: number;
  layout?: Omit<Layout, 'height'>;
  /** Links cursor, tooltip and zoom with other charts of the group (echarts.connect). */
  group?: string;
  chartRef?: RefObject<EChartsType | null>;
  ariaLabel?: string;
};

/**
 * N panels stacked on one shared time axis in one chart (see
 * smallMultiples.ts): one cursor across all panels, one zoom (ctrl+wheel).
 */
export function SmallMultiples({ spec, height, layout, group, chartRef, ariaLabel }: Props) {
  const scheme = useColorScheme();
  const option = useMemo(
    () => smallMultiplesOption(spec, { ...layout, height }, cssVar('--muted')),
    // scheme re-reads the muted color.
    [spec, height, layout, scheme],
  );
  return <EChart option={option} group={group} chartRef={chartRef} height={height} ariaLabel={ariaLabel} />;
}
