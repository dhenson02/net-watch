import { RX, TX } from '../charts/palette.ts';
import { useColorScheme } from '../charts/useColorScheme.ts';

type Series = readonly (number | null)[];

type Props = {
  /** Default 120 × 28. A string width (e.g. "100%") stretches the line to fit. */
  width?: number | string;
  height?: number;
  /** Formats the max in the tooltip. */
  fmt?: (v: number) => string;
} & (
  | {
      /** One series drawn up from the baseline. */
      values: Series;
    }
  | {
      /** tx above the midline, rx below (the 01 convention), on a shared scale. */
      tx: Series;
      rx: Series;
    }
);

const VB_W = 120;

/**
 * An inline SVG sparkline scaled to its own max. Plain SVG, not ECharts, so
 * dozens of them (table rows, tiles) cost no chart instances. A null point
 * breaks the line.
 */
export function Sparkline(props: Props) {
  const scheme = useColorScheme();
  const { width = VB_W, height = 28, fmt = String } = props;
  const mirrored = 'tx' in props;
  const series = mirrored ? [props.tx, props.rx] : [props.values];

  let max = 0;
  for (const s of series) for (const v of s) if (v !== null && v > max) max = v;
  const n = Math.max(...series.map((s) => s.length));
  const h = height;
  const base = mirrored ? h / 2 : h - 1;
  const span = mirrored ? h / 2 - 1 : h - 2;
  const x = (i: number) => (n <= 1 ? VB_W : (i / (n - 1)) * VB_W);
  const title = max > 0 ? `max ${fmt(max)}` : 'no activity';

  const draw = (s: Series, dir: 1 | -1, color: string, key: string) => {
    // Right-align shorter series so their newest points line up.
    const off = n - s.length;
    let line = '';
    let area = '';
    let run: [number, number][] = [];
    const flush = () => {
      if (run.length) {
        line += run.map(([px, py], j) => `${j ? 'L' : 'M'}${px.toFixed(1)},${py.toFixed(1)}`).join('');
        area += `M${run[0]![0].toFixed(1)},${base}${run.map(([px, py]) => `L${px.toFixed(1)},${py.toFixed(1)}`).join('')}L${run.at(-1)![0].toFixed(1)},${base}Z`;
      }
      run = [];
    };
    s.forEach((v, i) => {
      if (v === null) return flush();
      run.push([x(i + off), base - dir * (max > 0 ? (v / max) * span : 0)]);
    });
    flush();
    return (
      <g key={key} color={color}>
        <path d={area} fill="currentColor" fillOpacity={0.18} stroke="none" />
        <path d={line} fill="none" stroke="currentColor" strokeWidth={1.25} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
      </g>
    );
  };

  return (
    <svg className="sparkline" viewBox={`0 0 ${VB_W} ${h}`} width={width} height={h} preserveAspectRatio="none" role="img" aria-label={title}>
      <title>{title}</title>
      {mirrored ? (
        <>
          <line x1={0} x2={VB_W} y1={base} y2={base} stroke="var(--chart-axis)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
          {draw(props.tx, 1, TX[scheme], 'tx')}
          {draw(props.rx, -1, RX[scheme], 'rx')}
        </>
      ) : (
        draw(props.values, 1, 'var(--accent)', 'v')
      )}
    </svg>
  );
}
