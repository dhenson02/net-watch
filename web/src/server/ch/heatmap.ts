// Hour-of-day × day-of-week heatmap (06): the query over `flows_1m`, the
// per-cell sample counts (how many times each weekday-hour occurs in the
// range, in the browser's timezone) and the conversion to average kbps.
import { HEATMAP_CELLS, type HeatmapGrid, type HeatmapMetric, type HeatmapResponse, type HeatmapSplit } from '../../shared/api.ts';
import { badRequest } from '../http-error.ts';
import { filterSql, flowSource, type Filters } from './sql.ts';

/** Default span: four full weeks, so each cell averages four samples. */
export const HEATMAP_DEFAULT_SPAN = 28 * 86_400_000;
/** Longest span; the sample count walks the range in 15-minute steps. */
export const HEATMAP_MAX_SPAN = 366 * 86_400_000;
/** Grids of `split=app`: the top apps by the metric over the range. */
export const HEATMAP_SPLIT_TOP = 4;

/** The only SQL a `metric` selects. */
const METRIC_SQL: Record<HeatmapMetric, string> = {
  total: 'tx_bytes + rx_bytes',
  tx: 'tx_bytes',
  rx: 'rx_bytes',
};

export function parseMetric(raw: unknown): HeatmapMetric {
  if (raw === undefined || raw === '') return 'total';
  if (raw === 'total' || raw === 'tx' || raw === 'rx') return raw;
  throw badRequest('metric: expected total, tx or rx');
}

export function parseSplit(raw: unknown): HeatmapSplit {
  if (raw === undefined || raw === '' || raw === 'none') return 'none';
  if (raw === 'app') return 'app';
  throw badRequest('split: expected none or app');
}

function msParam(q: Record<string, unknown>, name: string): number | undefined {
  const raw = q[name];
  if (raw === undefined || raw === '') return undefined;
  const n = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(n)) throw badRequest(`${name}: expected ms since epoch`);
  return n;
}

/** `from`/`to` in ms; missing `to` is now, missing `from` four weeks before `to`. At most HEATMAP_MAX_SPAN. */
export function parseHeatRange(q: Record<string, unknown>, now = Date.now()): { from: number; to: number } {
  const to = msParam(q, 'to') ?? now;
  const from = msParam(q, 'from') ?? to - HEATMAP_DEFAULT_SPAN;
  if (from >= to) throw badRequest('from must be before to');
  if (to - from > HEATMAP_MAX_SPAN) throw badRequest('the heatmap range is at most 366 days');
  return { from, to };
}

/** Rollup minutes in the range, including the minute `from` falls in. A constant. */
const TIME = 'minute >= toStartOfMinute(fromUnixTimestamp64Milli({from:Int64})) AND minute < fromUnixTimestamp64Milli({to:Int64})';

/**
 * Bytes per (key, weekday, hour) in `tz`: `dow` 1 = Monday. `key` is '' or,
 * for `split=app`, the app, limited to the top HEATMAP_SPLIT_TOP apps by the
 * metric. `days` counts the dates with traffic in the cell.
 */
export function heatmapQuery(opts: { from: number; to: number; tz: string; metric: HeatmapMetric; split: HeatmapSplit; filters: Filters }): {
  sql: string;
  params: Record<string, unknown>;
} {
  const f = filterSql(opts.filters);
  const src = flowSource('flows_1m', TIME, opts.filters.uid !== undefined);
  const metric = METRIC_SQL[opts.metric];
  const split =
    opts.split === 'app'
      ? ` AND app IN (SELECT app FROM ${src} WHERE ${TIME}${f.sql} GROUP BY app HAVING sum(${metric}) > 0 ORDER BY sum(${metric}) DESC, app LIMIT ${HEATMAP_SPLIT_TOP})`
      : '';
  const sql = `SELECT ${opts.split === 'app' ? 'app' : "''"} AS key,
       toDayOfWeek(minute, 0, {tz:String}) AS dow,
       toHour(minute, {tz:String}) AS hour,
       sum(${metric}) AS bytes,
       uniqExact(toDate(minute, {tz:String})) AS days
FROM ${src}
WHERE ${TIME}${f.sql}${split}
GROUP BY key, dow, hour`;
  return { sql, params: { from: opts.from, to: opts.to, tz: opts.tz, ...f.params } };
}

export type HeatmapRow = { key: string; dow: number; hour: number; bytes: string | number; days: string | number };

const QUARTER = 15 * 60_000;
const DOW: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
const fmts = new Map<string, Intl.DateTimeFormat>();

/**
 * How many local hours of each (weekday, hour) cell overlap `[from, to)` in
 * `tz`, indexed `dow * 24 + hour` (0 = Monday). Every UTC offset is a multiple
 * of 15 minutes, so 15-minute steps see every local hour. A DST hour that
 * repeats counts once (its bytes land in the one cell), a skipped one not at
 * all.
 */
export function sampleCounts(from: number, to: number, tz: string): number[] {
  let f = fmts.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' });
    fmts.set(tz, f);
  }
  const out = new Array<number>(HEATMAP_CELLS).fill(0);
  let last = '';
  for (let t = Math.floor(from / QUARTER) * QUARTER; t < to; t += QUARTER) {
    const key = f.format(t);
    if (key === last) continue;
    last = key;
    let dow = -1;
    let hour = -1;
    for (const p of f.formatToParts(t)) {
      if (p.type === 'weekday') dow = DOW[p.value] ?? -1;
      else if (p.type === 'hour') hour = Number(p.value) % 24;
    }
    if (dow >= 0 && hour >= 0) out[dow * 24 + hour]!++;
  }
  return out;
}

/**
 * Grids of average kbps per cell (`bytes * 8 / 1000 / 3600 / samples`, null
 * where the range holds no sample of the cell), largest total first.
 * `samples` comes from sampleCounts over the covered part of the range.
 */
export function buildHeatmap(
  rows: HeatmapRow[],
  base: Omit<HeatmapResponse, 'samples' | 'grids'>,
  samples: number[],
): HeatmapResponse {
  const byKey = new Map<string, { bytes: number[]; active: number[] }>();
  for (const r of rows) {
    const i = (Number(r.dow) - 1) * 24 + Number(r.hour);
    if (!(i >= 0 && i < HEATMAP_CELLS)) continue;
    let g = byKey.get(r.key);
    if (!g) {
      g = { bytes: new Array<number>(HEATMAP_CELLS).fill(0), active: new Array<number>(HEATMAP_CELLS).fill(0) };
      byKey.set(r.key, g);
    }
    g.bytes[i]! += Number(r.bytes);
    g.active[i]! += Number(r.days);
  }
  const grids: HeatmapGrid[] = [...byKey].map(([key, g]) => ({
    key: base.split === 'app' ? key : null,
    bytes: g.bytes.reduce((a, b) => a + b, 0),
    kbps: g.bytes.map((b, i) => (samples[i]! > 0 ? (b * 8) / 1000 / 3600 / samples[i]! : null)),
    active: g.active,
  }));
  grids.sort((a, b) => b.bytes - a.bytes || String(a.key).localeCompare(String(b.key)));
  return { ...base, samples, grids };
}
