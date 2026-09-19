// Integration checks against the compose stack (`docker compose up -d --wait`
// in the repo root). Not part of `npm test`; run with `npm run test:int`.
// Starts the real server on a spare port and checks every endpoint's shape.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { after, before, test } from 'node:test';
import type {
  CompactTick,
  FlowAgg,
  HealthResponse,
  HistoryFlowsResponse,
  HistoryIngest,
  HistorySummary,
  LiveFlowsResponse,
  LiveMeta,
  LiveSnapshotResponse,
  ProcessInfo,
} from '../shared/api.ts';
import { DISPLAY_IP } from './ch/sql.ts';
import { config } from './config.ts';
import { createClickHouse } from './db/clickhouse.ts';

const PORT = Number(process.env.INT_PORT ?? 8797);
const BASE = `http://127.0.0.1:${PORT}`;
let server: ChildProcess;

async function get<T>(path: string): Promise<{ status: number; body: T }> {
  const res = await fetch(BASE + path, { signal: AbortSignal.timeout(10_000) });
  return { status: res.status, body: (await res.json()) as T };
}

before(async () => {
  server = spawn(process.execPath, ['src/server/index.ts'], {
    cwd: new URL('../../', import.meta.url),
    env: { ...process.env, WEB_PORT: String(PORT), LOG_LEVEL: 'warn' },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  for (let i = 0; i < 50; i++) {
    try {
      const { body } = await get<HealthResponse>('/api/health');
      if (body.redis.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('server did not come up with Redis connected');
});

after(() => {
  server?.kill();
});

test('health: both backends up', async () => {
  const { status, body } = await get<HealthResponse>('/api/health');
  assert.equal(status, 200);
  assert.ok(body.redis.ok, body.redis.error ?? '');
  assert.ok(body.clickhouse.ok, body.clickhouse.error ?? '');
});

test('live series: compact ticks, oldest first', async () => {
  const { status, body } = await get<CompactTick[]>('/api/live/series?seconds=900');
  assert.equal(status, 200);
  assert.ok(Array.isArray(body));
  for (let i = 1; i < body.length; i++) assert.ok(body[i]!.ts > body[i - 1]!.ts, 'ascending ts');
  for (const t of body.slice(-5)) {
    for (const k of ['ts', 'intervalMs', 'drops', 'nProcs', 'nFlows', 'txKbps', 'rxKbps'] as const) assert.equal(typeof t[k], 'number', k);
    for (const p of t.procs) assert.match(p.id, /^\d+:\d+$/);
    for (const v of Object.values(t.apps)) assert.equal(v.length, 2);
  }
  assert.equal((await get('/api/live/series?seconds=0')).status, 400);
});

test('live snapshot: process rows, ids kept as strings', async () => {
  const { status, body } = await get<LiveSnapshotResponse>('/api/live/snapshot');
  if (status === 503) return; // stream empty: nothing to check
  assert.equal(status, 200);
  assert.equal(typeof body.ts, 'number');
  assert.equal(typeof body.serverTimeMs, 'number');
  for (const p of body.processes) {
    assert.equal(typeof p.startNs, 'string');
    assert.equal(p.id, `${p.pid}:${p.startNs}`);
    assert.ok(p.cmdline.length <= 300, 'cmdline truncated');
    assert.ok(p.user === null || typeof p.user === 'string');
    assert.equal(typeof p.nFlows, 'number');
  }
});

function assertFlow(f: FlowAgg) {
  for (const k of ['name', 'proto', 'app', 'ip', 'id'] as const) assert.equal(typeof f[k], 'string', k);
  for (const k of ['rport', 'tx', 'rx'] as const) assert.equal(typeof f[k], 'number', k);
  assert.match(f.id, /^\d+:\d+$/);
  assert.ok(!f.ip.startsWith('::ffff:'), 'IPv4 shown plain');
}

test('live flows: mean kbps per (name, proto, app, ip, port), largest first', async () => {
  const { status, body } = await get<LiveFlowsResponse>('/api/live/flows?seconds=10');
  assert.equal(status, 200);
  assert.equal(typeof body.ticks, 'number');
  assert.ok(body.ticks <= 30);
  assert.equal(body.ts === null, body.ticks === 0);
  for (const f of body.flows) assertFlow(f);
  for (let i = 1; i < body.flows.length; i++) assert.ok(body.flows[i - 1]!.tx + body.flows[i - 1]!.rx >= body.flows[i]!.tx + body.flows[i]!.rx);
  assert.equal((await get('/api/live/flows?seconds=31')).status, 400);
  assert.equal((await get('/api/live/flows?seconds=0')).status, 400);
});

test('history flows: bytes per destination, both tables, dest filter', async () => {
  const now = Date.now();
  const week = await get<HistoryFlowsResponse>(`/api/history/flows?from=${now - 7 * 86_400_000}&to=${now}&limit=50`);
  assert.equal(week.status, 200);
  assert.equal(week.body.range.table, 'flows_1m');
  assert.ok(week.body.flows.length <= 50);
  assert.equal(typeof week.body.truncated, 'boolean');
  for (const f of week.body.flows) assertFlow(f);
  for (let i = 1; i < week.body.flows.length; i++) {
    const [a, b] = [week.body.flows[i - 1]!, week.body.flows[i]!];
    assert.ok(a.tx + a.rx >= b.tx + b.rx, 'largest first');
  }

  const raw = await get<HistoryFlowsResponse>(`/api/history/flows?from=${now - 3_600_000}&to=${now}`);
  assert.equal(raw.status, 200);
  assert.equal(raw.body.range.table, 'flows');

  const top = week.body.flows[0];
  if (top) {
    const dest = top.ip.includes(':') ? `[${top.ip}]:${top.rport}` : `${top.ip}:${top.rport}`;
    const one = await get<HistoryFlowsResponse>(`/api/history/flows?from=${now - 7 * 86_400_000}&to=${now}&dest=${encodeURIComponent(dest)}`);
    assert.equal(one.status, 200);
    assert.ok(one.body.flows.length > 0);
    for (const f of one.body.flows) assert.deepEqual([f.ip, f.rport], [top.ip, top.rport]);
  }

  for (const q of ['dest=example.com:443', 'dest=1.2.3.4', 'limit=0', 'limit=2001', 'limit=x']) {
    assert.equal((await get(`/api/history/flows?${q}`)).status, 400, q);
  }
});

test('live meta: numbers or null', async () => {
  const { status, body } = await get<LiveMeta>('/api/live/meta');
  assert.equal(status, 200);
  assert.equal(typeof body.serverTimeMs, 'number');
  for (const k of ['alive', 'ended'] as const) assert.equal(typeof body[k], 'number', k);
  for (const k of ['lastTickMs', 'intervalMs', 'drops'] as const) assert.ok(body[k] === null || typeof body[k] === 'number', k);
});

test('live events: hello first', async () => {
  const ctrl = new AbortController();
  const res = await fetch(`${BASE}/api/live/events`, { signal: ctrl.signal });
  assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  const reader = res.body!.getReader();
  const { value } = await reader.read();
  ctrl.abort();
  assert.match(new TextDecoder().decode(value), /^event: hello\ndata: \{"latestTs":(\d+|null)\}\n\n/);
});

test('history summary: shape, resolution and validation', async () => {
  const now = Date.now();
  const { status, body } = await get<HistorySummary>(`/api/history/summary?from=${now - 7 * 86_400_000}&to=${now}`);
  assert.equal(status, 200);
  assert.deepEqual(Object.keys(body.range).sort(), ['from', 'step', 'table', 'to']);
  assert.equal(body.range.table, 'flows_1m');
  for (const k of ['txBytes', 'rxBytes', 'processes'] as const) assert.equal(typeof body[k], 'number', k);

  const raw = await get<HistorySummary>(`/api/history/summary?from=${now - 3_600_000}&to=${now}`);
  assert.equal(raw.body.range.table, 'flows');

  const bad = await get<{ error: string }>(`/api/history/summary?from=${now}&to=${now - 1}`);
  assert.equal(bad.status, 400);
  assert.equal(typeof bad.body.error, 'string');
});

test('history ingest: latest ts in ms, rows in the last minute', async () => {
  const { status, body } = await get<HistoryIngest>('/api/history/ingest');
  assert.equal(status, 200);
  assert.equal(typeof body.rows1m, 'number');
  if (body.lastTsMs !== null) {
    assert.equal(typeof body.lastTsMs, 'number');
    assert.ok(Math.abs(body.serverTimeMs - body.lastTsMs) < 11 * 60_000, 'within the 10 min window');
  }
});

test('process: found by pid:start_ns, 404 otherwise', async () => {
  const ch = createClickHouse(config.clickhouse);
  try {
    const rs = await ch.query({ query: 'SELECT pid, toString(proc_start) AS start FROM processes LIMIT 1', format: 'JSONEachRow' });
    const [row] = await rs.json<{ pid: number; start: string }>();
    if (row) {
      const { status, body } = await get<ProcessInfo>(`/api/process/${row.pid}/${row.start}`);
      assert.equal(status, 200);
      assert.equal(body.start_ns, row.start);
      for (const k of ['start_ms', 'first_seen_ms', 'last_seen_ms', 'tx_total', 'rx_total'] as const) assert.equal(typeof body[k], 'number', k);
    }
  } finally {
    await ch.close();
  }
  assert.equal((await get('/api/process/1/18446744073709551615')).status, 404);
  assert.equal((await get('/api/process/x/1')).status, 400);
});

test('ClickHouse: DISPLAY_IP and toIPv6 round-trip', async () => {
  const ch = createClickHouse(config.clickhouse);
  try {
    const rs = await ch.query({
      query: `SELECT ${DISPLAY_IP} AS shown FROM (SELECT arrayJoin([toIPv6({v4:String}), toIPv6({v6:String})]) AS raddr)`,
      query_params: { v4: '1.2.3.4', v6: '2001:db8::1' },
      format: 'JSONEachRow',
    });
    assert.deepEqual(
      (await rs.json<{ shown: string }>()).map((r) => r.shown),
      ['1.2.3.4', '2001:db8::1'],
    );
    const mapped = await ch.query({ query: 'SELECT toIPv6({ip:String}) = toIPv6({m:String}) AS same', query_params: { ip: '1.2.3.4', m: '::ffff:1.2.3.4' }, format: 'JSONEachRow' });
    assert.deepEqual(await mapped.json(), [{ same: 1 }]);
  } finally {
    await ch.close();
  }
});
