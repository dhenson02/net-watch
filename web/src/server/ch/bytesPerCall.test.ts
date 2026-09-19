import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BPC_BUCKETS } from '../../shared/api.ts';
import {
  bucketOf,
  buildBytesPerCall,
  bytesPerCallQuery,
  parseBpcBy,
  parseBpcDir,
  parseInstance,
  type BytesPerCallQueryRow,
} from './bytesPerCall.ts';
import { parseRange } from './range.ts';

const T0 = Date.UTC(2026, 8, 18, 12);
const HOUR = 3_600_000;
const base = { from: T0, to: T0 + HOUR, table: 'flows' as const, dir: 'tx' as const, by: 'app' as const };
const row = (k: string, bucket: number, calls: number, bytes: number): BytesPerCallQueryRow => ({ k, bucket, calls: String(calls), bytes: String(bytes) });

test('parse: dir, by and the pid/start pair', () => {
  assert.equal(parseBpcDir(undefined), 'tx');
  assert.equal(parseBpcDir('rx'), 'rx');
  assert.throws(() => parseBpcDir('both'), /dir/);
  assert.equal(parseBpcBy(''), 'app');
  assert.equal(parseBpcBy('name'), 'name');
  assert.throws(() => parseBpcBy('uid'), /by/);
  assert.equal(parseInstance({}), null);
  assert.deepEqual(parseInstance({ pid: '042', start: '18446744073709551615' }), { pid: 42, start: '18446744073709551615' });
  assert.throws(() => parseInstance({ pid: '42' }), /together/);
  assert.throws(() => parseInstance({ pid: 'x', start: '1' }), /pid/);
  assert.throws(() => parseInstance({ pid: '1', start: '18446744073709551616' }), /start/);
});

test('bucketOf: floor(log2), under 1 B in bucket 0, capped at 1 MiB+', () => {
  assert.equal(bucketOf(0), 0);
  assert.equal(bucketOf(0.4), 0);
  assert.equal(bucketOf(1), 0);
  assert.equal(bucketOf(1.99), 0);
  assert.equal(bucketOf(2), 1);
  assert.equal(bucketOf(1500), 10);
  assert.equal(bucketOf(1 << 20), 20);
  assert.equal(bucketOf(1e12), BPC_BUCKETS - 1);
});

test('bytesPerCallQuery: raw flows row by row, the rollup summed per flow-minute first', () => {
  const raw = bytesPerCallQuery({ r: parseRange({ from: String(T0), to: String(T0 + HOUR) }), dir: 'rx', by: 'name', filters: { app: 'DNS' } });
  assert.match(raw.sql, /SELECT name AS k, rx_bytes AS b, rx_calls AS c FROM flows WHERE ts >= /);
  assert.match(raw.sql, /AND app = \{f_app:String\}/);
  assert.match(raw.sql, /least\(toUInt8\(floor\(log2\(greatest\(b \/ c, 1\)\)\)\), 20\) AS bucket/);
  assert.match(raw.sql, /WHERE c > 0\s+GROUP BY k, bucket/);
  assert.equal(raw.params.f_app, 'DNS');
  assert.ok(!/pid =/.test(raw.sql));

  const day = bytesPerCallQuery({ r: parseRange({ from: String(T0), to: String(T0 + 24 * HOUR) }), dir: 'tx', by: 'app', filters: {} });
  assert.match(day.sql, /sum\(tx_bytes\) AS b, sum\(tx_calls\) AS c\s+FROM flows_1m\s/);
  assert.match(day.sql, /GROUP BY k, minute, pid, proc_start, proto, app, raddr, rport/);

  // uid needs the join onto processes.
  const uid = bytesPerCallQuery({ r: parseRange({ from: String(T0), to: String(T0 + 24 * HOUR) }), dir: 'tx', by: 'app', filters: { uid: 1000 } });
  assert.match(uid.sql, /LEFT JOIN/);

  const one = bytesPerCallQuery({
    r: { ...parseRange({ from: String(T0), to: String(T0 + 24 * HOUR) }), table: 'flows', col: 'ts' },
    dir: 'tx',
    by: 'app',
    filters: {},
    instance: { pid: 7, start: '18446744073709551615' },
  });
  assert.match(one.sql, /FROM flows WHERE pid = \{pid:UInt32\} AND proc_start = \{start:UInt64\} AND ts >= /);
  assert.equal(one.params.start, '18446744073709551615');
  assert.equal(one.params.pid, 7);
});

test('buildBytesPerCall: histograms per key, top by calls, the rest folded, the total', () => {
  const rows = [
    row('HTTPS', 10, 30, 30_000),
    row('HTTPS', 14, 10, 200_000),
    row('DNS', 6, 100, 6_000),
    row('SSH', 5, 5, 200),
    row('QUIC', 8, 3, 900),
    row('bad', 99, 1, 1),
  ];
  const out = buildBytesPerCall(rows, base, 2);
  assert.deepEqual(
    out.rows.map((r) => [r.key, r.totalCalls, r.totalBytes]),
    [
      ['DNS', 100, 6000],
      ['HTTPS', 40, 230_000],
      [null, 8, 1100],
    ],
  );
  assert.equal(out.folded, 2);
  assert.equal(out.rows[1]!.calls[10], 30);
  assert.equal(out.rows[1]!.bytes[14], 200_000);
  assert.equal(out.rows[2]!.calls[5], 5);
  assert.equal(out.rows[2]!.calls[8], 3);
  for (const r of out.rows) assert.equal(r.calls.length, BPC_BUCKETS);
  // The out-of-range bucket is dropped.
  assert.equal(out.total.totalCalls, 148);
  assert.equal(out.total.totalBytes, 237_100);
  assert.equal(out.total.calls.reduce((a, b) => a + b, 0), 148);
  assert.deepEqual([out.from, out.table, out.dir, out.by], [T0, 'flows', 'tx', 'app']);

  const none = buildBytesPerCall([], base);
  assert.deepEqual([none.rows, none.folded, none.total.totalCalls], [[], 0, 0]);
  const few = buildBytesPerCall(rows.slice(0, 3), base);
  assert.equal(few.folded, 0);
  assert.ok(few.rows.every((r) => r.key !== null));
});
