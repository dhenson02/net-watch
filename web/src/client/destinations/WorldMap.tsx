import { useEffect, useMemo, useState } from 'react';
import type { CountriesResponse } from '../../shared/api.ts';
import { EChart } from '../charts/EChart.tsx';
import type { EChartsCoreOption } from '../charts/echarts.ts';
import { fmtBytes } from '../charts/format.ts';
import { OTHER, SEQUENTIAL } from '../charts/palette.ts';
import { useColorScheme } from '../charts/useColorScheme.ts';
import { countryName, mapData, pctText, type MapDatum } from './geoView.ts';

type MapModule = typeof import('./mapSetup.ts');

/** The map chunk (ECharts' map series + the world outline), fetched once on first use. */
let loading: Promise<MapModule> | null = null;
const loadMap = () => (loading ??= import('./mapSetup.ts'));

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

type Props = {
  data: CountriesResponse;
  selected: string | null;
  onSelect: (cc: string) => void;
};

/**
 * 18: bytes per country of registration of the destination's address range,
 * on a log color scale. Local traffic is not on the map (the page shows it as
 * a figure); countries the outline lacks are listed under it.
 */
export function WorldMap({ data, selected, onSelect }: Props) {
  const scheme = useColorScheme();
  const [mod, setMod] = useState<MapModule | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    loadMap().then(
      (m) => live && setMod(m),
      (err: Error) => live && setError(`The map could not be loaded: ${err.message}`),
    );
    return () => {
      live = false;
    };
  }, []);

  const scale = useMemo(() => mapData(data.rows), [data]);
  const total = data.coverage.totalBytes;
  const offMap = mod ? data.rows.filter((r) => !mod.MAP_CCS.has(r.country)) : [];

  const option = useMemo<EChartsCoreOption | null>(() => {
    if (!mod) return null;
    const ramp = SEQUENTIAL[scheme];
    const tooltip = (p: any): string => {
      const d = p.data as MapDatum | undefined;
      const cc = p.name as string;
      const head = `<b>${esc(countryName(cc))}</b> <span class="muted">${esc(cc)}</span>`;
      if (!d) return `${head}<br><span class="muted">no traffic</span>`;
      return `${head}<br>${fmtBytes(d.bytes)} · ${pctText(d.bytes, total)} · ${d.ips} IP${d.ips === 1 ? '' : 's'}<br><span class="muted" style="font-size:11px">click to list its destinations</span>`;
    };
    return {
      animation: false,
      tooltip: { trigger: 'item', confine: true, formatter: tooltip },
      visualMap: {
        type: 'continuous',
        min: scale.min,
        max: scale.max,
        calculable: false,
        orient: 'horizontal',
        left: 'center',
        bottom: 0,
        itemWidth: 10,
        itemHeight: 200,
        text: [fmtBytes(10 ** scale.max), fmtBytes(10 ** scale.min)],
        formatter: (v: number) => fmtBytes(10 ** v),
        textGap: 8,
        inRange: { color: [...ramp] },
      },
      series: [
        {
          id: 'geo:countries',
          type: 'map',
          map: mod.MAP_NAME,
          nameProperty: 'cc',
          roam: true,
          scaleLimit: { min: 1, max: 8 },
          top: 8,
          bottom: 44,
          left: 8,
          right: 8,
          selectedMode: false,
          itemStyle: { areaColor: scheme === 'dark' ? '#2a2c31' : '#ecebe7', borderColor: scheme === 'dark' ? '#44464d' : '#c9c7c1', borderWidth: 0.5 },
          emphasis: { label: { show: false }, itemStyle: { areaColor: OTHER[scheme] } },
          data: scale.data.map((d) =>
            d.name === selected ? { ...d, itemStyle: { borderColor: scheme === 'dark' ? '#fff' : '#111', borderWidth: 1.5 } } : d,
          ),
        },
      ],
    };
  }, [mod, scale, scheme, total, selected]);

  const onEvents = useMemo(
    () => ({
      click: (p: any) => {
        if (p.data) onSelect(p.name as string);
      },
    }),
    [onSelect],
  );

  if (error) return <div className="panel-state panel-error">{error}</div>;
  if (!option) return <div className="panel-state">Loading the map…</div>;
  return (
    <>
      <EChart option={option} onEvents={onEvents} height={340} ariaLabel="Bytes per destination country on a world map, log color scale" />
      {offMap.length > 0 && (
        <p className="muted map-offmap">
          Not on the map:{' '}
          {offMap.map((r, i) => (
            <span key={r.country}>
              {i > 0 && ', '}
              <button type="button" className="link-button" onClick={() => onSelect(r.country)}>
                {countryName(r.country)}
              </button>{' '}
              {fmtBytes(r.bytes)}
            </span>
          ))}
        </p>
      )}
    </>
  );
}
