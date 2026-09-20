import { useMemo } from 'react';
import type { AsnResponse } from '../../shared/api.ts';
import { EChart } from '../charts/EChart.tsx';
import type { EChartsCoreOption } from '../charts/echarts.ts';
import { fmtBytes } from '../charts/format.ts';
import { RX, TX } from '../charts/palette.ts';
import { useColorScheme } from '../charts/useColorScheme.ts';
import { ASN_BARS, asnBars, countryName, pctText } from './geoView.ts';
import { fontPx } from '../charts/fonts.ts';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

type Props = {
  data: AsnResponse;
  /** The selected ASN: its bar stays solid, the others fade. */
  selected: number | null;
  onSelect: (asn: number) => void;
};

/**
 * 18: the top 20 networks (ASNs) by bytes, mirrored: sent to the right,
 * received to the left. A click selects the ASN (the table narrows to it).
 */
export function AsnBars({ data, selected, onSelect }: Props) {
  const scheme = useColorScheme();
  const bars = useMemo(() => asnBars(data.rows), [data]);
  const total = data.coverage.totalBytes;

  const option = useMemo<EChartsCoreOption>(() => {
    const fade = (i: number) => (selected !== null && bars.asns[i] !== selected ? 0.3 : 1);
    const max = Math.max(1, ...bars.tx, ...bars.rx.map((v) => -v));
    const tooltip = (ps: any[]): string => {
      const i = ps[0]?.dataIndex as number | undefined;
      if (i === undefined) return '';
      const r = bars.rows[i]!;
      return [
        `<b>AS${r.asn}</b> ${esc(r.org)}`,
        `<span class="muted">${esc(countryName(r.country))} · ${r.ips} IP${r.ips === 1 ? '' : 's'}</span>`,
        `↑ sent ${fmtBytes(r.tx)} · ↓ received ${fmtBytes(r.rx)}`,
        `${fmtBytes(r.bytes)} · ${pctText(r.bytes, total)} of ${data.dir === 'total' ? 'all bytes' : data.dir === 'tx' ? 'sent bytes' : 'received bytes'}`,
        `<span class="muted" style="font-size:11px">click to list its destinations</span>`,
      ].join('<br>');
    };
    return {
      animation: false,
      grid: { left: 8, right: 16, top: 24, bottom: 8, containLabel: true },
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, confine: true, formatter: tooltip },
      legend: { data: ['↑ sent', '↓ received'], top: 0, right: 0, itemWidth: 10, itemHeight: 10 },
      xAxis: {
        type: 'value',
        min: -max,
        max,
        axisLabel: { formatter: (v: number) => fmtBytes(Math.abs(v)), hideOverlap: true },
        splitLine: { lineStyle: { opacity: 0.5 } },
      },
      yAxis: { type: 'category', data: bars.labels, axisTick: { show: false }, axisLabel: { fontSize: fontPx(12) } },
      series: [
        {
          id: 'asn:tx',
          name: '↑ sent',
          type: 'bar',
          stack: 'asn',
          barWidth: '70%',
          itemStyle: { color: TX[scheme] },
          data: bars.tx.map((v, i) => ({ value: v, itemStyle: { opacity: fade(i) } })),
        },
        {
          id: 'asn:rx',
          name: '↓ received',
          type: 'bar',
          stack: 'asn',
          itemStyle: { color: RX[scheme] },
          data: bars.rx.map((v, i) => ({ value: v, itemStyle: { opacity: fade(i) } })),
        },
      ],
    };
  }, [bars, selected, scheme, total, data.dir]);

  const onEvents = useMemo(
    () => ({
      click: (p: any) => {
        const asn = bars.asns[p.dataIndex as number];
        if (asn !== undefined) onSelect(asn);
      },
    }),
    [bars, onSelect],
  );

  const height = Math.max(160, Math.min(ASN_BARS, bars.labels.length) * 24 + 48);
  return <EChart option={option} onEvents={onEvents} height={height} ariaLabel="Bytes sent and received per network (ASN), largest first" />;
}
