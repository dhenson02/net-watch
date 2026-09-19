// IP → ASN, org and country from a local iptoasn.com table (18, option A).
//
// The file is `ip2asn-combined.tsv` (optionally gzipped), one range per line:
//   range_start \t range_end \t AS_number \t country_code \t AS_description
// IPv4 and IPv6 ranges, public domain, from https://iptoasn.com (fetched by
// `npm run geo:update`, never at runtime). Ranges with AS 0 ("Not routed")
// are skipped. Lookups are a binary search over sorted range arrays: u32 for
// IPv4, two u64 halves for IPv6.
import { readFile, stat } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import type { Geo, GeoStatus } from '../../shared/api.ts';
import { parseIp, parseV4, parseV6, type ParsedIp } from './ip.ts';

type Log = { info: (o: object, msg: string) => void; warn: (o: object, msg: string) => void };

/** The org part of an AS description: "AMAZON-02 - Amazon.com, Inc." → "Amazon.com, Inc."; else as is. */
export function orgName(desc: string): string {
  const d = desc.trim();
  const i = d.indexOf(' - ');
  return i > 0 && i + 3 < d.length ? d.slice(i + 3).trim() : d;
}

/** ISO 3166 alpha-2, or '' for iptoasn's "None"/"Unknown". */
const countryCode = (raw: string) => (/^[A-Z]{2}$/.test(raw) ? raw : '');

const M64 = (1n << 64n) - 1n;

/** The parsed table. Build with `parseTable`; `lookup` is a binary search. */
export class AsnTable {
  readonly v4Start: Uint32Array;
  readonly v4End: Uint32Array;
  readonly v4Info: Uint32Array;
  readonly v6StartHi: BigUint64Array;
  readonly v6StartLo: BigUint64Array;
  readonly v6EndHi: BigUint64Array;
  readonly v6EndLo: BigUint64Array;
  readonly v6Info: Uint32Array;
  /** Distinct (asn, org, cc) triples; the Info arrays index into it. */
  readonly infos: Geo[];

  constructor(v4: [number, number, number][], v6: [bigint, bigint, number][], infos: Geo[]) {
    v4.sort((a, b) => a[0] - b[0]);
    v6.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    this.v4Start = Uint32Array.from(v4, (r) => r[0]);
    this.v4End = Uint32Array.from(v4, (r) => r[1]);
    this.v4Info = Uint32Array.from(v4, (r) => r[2]);
    this.v6StartHi = BigUint64Array.from(v6, (r) => r[0] >> 64n);
    this.v6StartLo = BigUint64Array.from(v6, (r) => r[0] & M64);
    this.v6EndHi = BigUint64Array.from(v6, (r) => r[1] >> 64n);
    this.v6EndLo = BigUint64Array.from(v6, (r) => r[1] & M64);
    this.v6Info = Uint32Array.from(v6, (r) => r[2]);
    this.infos = infos;
  }

  get size(): number {
    return this.v4Start.length + this.v6Info.length;
  }

  lookupParsed(ip: ParsedIp): Geo | null {
    if (ip.v === 4) {
      // Last range starting at or before ip.
      let lo = 0;
      let hi = this.v4Start.length - 1;
      let at = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (this.v4Start[mid]! <= ip.n) {
          at = mid;
          lo = mid + 1;
        } else hi = mid - 1;
      }
      return at >= 0 && ip.n <= this.v4End[at]! ? this.infos[this.v4Info[at]!]! : null;
    }
    const h = ip.n >> 64n;
    const l = ip.n & M64;
    let lo = 0;
    let hi = this.v6Info.length - 1;
    let at = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const sh = this.v6StartHi[mid]!;
      if (sh < h || (sh === h && this.v6StartLo[mid]! <= l)) {
        at = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (at < 0) return null;
    const eh = this.v6EndHi[at]!;
    return h < eh || (h === eh && l <= this.v6EndLo[at]!) ? this.infos[this.v6Info[at]!]! : null;
  }

  lookup(ip: string): Geo | null {
    const p = parseIp(ip);
    return p ? this.lookupParsed(p) : null;
  }
}

/**
 * Parses the TSV text. Yields to the event loop every `chunk` lines when
 * `yieldEvery` is given, so a 500k-line file does not stall the server.
 */
export async function parseTable(text: string, yieldEvery?: () => Promise<void>, chunk = 50_000): Promise<{ table: AsnTable; skipped: number }> {
  const v4: [number, number, number][] = [];
  const v6: [bigint, bigint, number][] = [];
  const infos: Geo[] = [];
  const infoIdx = new Map<string, number>();
  let skipped = 0;
  let pos = 0;
  let line = 0;
  while (pos < text.length) {
    let end = text.indexOf('\n', pos);
    if (end < 0) end = text.length;
    const row = text.slice(pos, end).replace(/\r$/, '');
    pos = end + 1;
    if (++line % chunk === 0 && yieldEvery) await yieldEvery();
    if (!row || row.startsWith('#')) continue;
    const f = row.split('\t');
    if (f.length < 5) {
      skipped++;
      continue;
    }
    const asn = Number(f[2]);
    if (!Number.isInteger(asn) || asn <= 0) continue; // "Not routed"
    const cc = countryCode(f[3]!);
    const org = orgName(f.slice(4).join('\t'));
    const key = `${asn}\u0000${cc}\u0000${org}`;
    let idx = infoIdx.get(key);
    if (idx === undefined) {
      idx = infos.length;
      infos.push({ asn, org, cc });
      infoIdx.set(key, idx);
    }
    const a4 = parseV4(f[0]!);
    if (a4 !== null) {
      const b4 = parseV4(f[1]!);
      if (b4 === null || b4 < a4) skipped++;
      else v4.push([a4, b4, idx]);
      continue;
    }
    const a6 = parseV6(f[0]!);
    const b6 = parseV6(f[1]!);
    if (a6 === null || b6 === null || b6 < a6) skipped++;
    else v6.push([a6, b6, idx]);
  }
  return { table: new AsnTable(v4, v6, infos), skipped };
}

/** How often the file's mtime is checked, so `npm run geo:update` needs no restart. */
const RECHECK_MS = 10 * 60_000;

/**
 * The loaded database, or none. `start()` loads the file in the background
 * (the API serves without geo meanwhile) and reloads it when it changes.
 * Every lookup returns null while nothing is loaded.
 */
export class GeoDb {
  private table: AsnTable | null = null;
  private fileDate: number | null = null;
  private error: string | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private loading: Promise<void> | null = null;
  readonly file: string | null;
  private readonly log: Log | undefined;

  constructor(file: string | null, log?: Log) {
    this.file = file;
    this.log = log;
  }

  /** For tests: a database from an already parsed table. */
  static fromTable(table: AsnTable, fileDate: number | null = null): GeoDb {
    const db = new GeoDb(null);
    db.table = table;
    db.fileDate = fileDate;
    return db;
  }

  /** Starts loading (resolves when the first load attempt ends). */
  start(): Promise<void> {
    if (!this.file) return Promise.resolve();
    this.timer = setInterval(() => void this.reloadIfChanged(), RECHECK_MS);
    this.timer.unref();
    return this.reloadIfChanged();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  get loaded(): boolean {
    return this.table !== null;
  }

  status(): GeoStatus {
    return { loaded: this.table !== null, entries: this.table?.size ?? 0, fileDate: this.fileDate, error: this.error };
  }

  lookup(ip: string): Geo | null {
    return this.table ? this.table.lookup(ip) : null;
  }

  lookupParsed(ip: ParsedIp): Geo | null {
    return this.table ? this.table.lookupParsed(ip) : null;
  }

  /**
   * Sets `geo` on each row whose `ip` the database knows; leaves the others
   * as they are (no key), and every row when nothing is loaded.
   */
  enrich<T extends { ip: string; geo?: Geo }>(rows: T[]): T[] {
    if (!this.table) return rows;
    const seen = new Map<string, Geo | null>();
    for (const r of rows) {
      let g = seen.get(r.ip);
      if (g === undefined) seen.set(r.ip, (g = this.table.lookup(r.ip)));
      if (g) r.geo = g;
    }
    return rows;
  }

  private reloadIfChanged(): Promise<void> {
    if (this.loading) return this.loading;
    this.loading = this.load().finally(() => (this.loading = null));
    return this.loading;
  }

  private async load(): Promise<void> {
    const file = this.file!;
    let mtime: number;
    try {
      mtime = (await stat(file)).mtimeMs;
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      const msg = e.code === 'ENOENT' ? `${file} not found (run "npm run geo:update")` : e.message;
      if (msg !== this.error) this.log?.warn({ file }, `geo: ${msg}; destinations are shown without ASN/country`);
      this.error = msg;
      return;
    }
    if (this.table && mtime === this.fileDate) return;
    const t0 = performance.now();
    try {
      let buf = await readFile(file);
      if (buf[0] === 0x1f && buf[1] === 0x8b) buf = gunzipSync(buf);
      const { table, skipped } = await parseTable(buf.toString('utf8'), () => new Promise((r) => setImmediate(r)));
      if (table.size === 0) throw new Error('no ranges in the file');
      this.table = table;
      this.fileDate = Math.round(mtime);
      this.error = null;
      this.log?.info({ file, entries: table.size, skipped, ms: Math.round(performance.now() - t0) }, 'geo: IP → ASN table loaded');
    } catch (err) {
      this.error = (err as Error).message;
      this.log?.warn({ file, err: this.error }, 'geo: could not load the IP → ASN table');
    }
  }
}
