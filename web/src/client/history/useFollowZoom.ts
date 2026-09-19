import { useEffect, useRef, type RefObject } from 'react';
import type { EChartsType } from '../charts/echarts.ts';

/**
 * Makes a track under the throughput chart (12, 16) follow its zoom (slider,
 * ctrl+wheel) until the chart commits a new range. Not linked through the
 * `history` group: that would also replay the track's tooltips on the chart
 * above, by data index. The track needs a disabled inside dataZoom on x.
 */
export function useFollowZoom(main: RefObject<EChartsType | null>, track: RefObject<EChartsType | null>) {
  const followed = useRef<EChartsType | null>(null);
  // No deps: the chart above may be created after this track.
  useEffect(() => {
    const m = main.current;
    if (!m || m === followed.current) return;
    followed.current = m;
    const onZoom = () => {
      const dz = (m.getOption() as { dataZoom?: { start?: number; end?: number }[] }).dataZoom?.[0];
      if (dz) track.current?.dispatchAction({ type: 'dataZoom', start: dz.start ?? 0, end: dz.end ?? 100 });
    };
    m.on('datazoom', onZoom);
    return () => {
      m.off('datazoom', onZoom);
      followed.current = null;
    };
  });
}
