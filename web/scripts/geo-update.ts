// Downloads the iptoasn.com IP → ASN table (public domain) for the
// Destinations page (plan 18). Run it deliberately: `npm run geo:update`.
// The server never downloads anything; it reads the file at GEOIP_FILE
// (default data/ip2asn-combined.tsv.gz under web/) and reloads it within
// 10 minutes of a change.
//
//   GEOIP_URL   source (default https://iptoasn.com/data/ip2asn-combined.tsv.gz)
//   GEOIP_FILE  destination, relative to web/ (the server's setting)
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { config } from '../src/server/config.ts';
import { parseTable } from '../src/server/geo/asn.ts';

const url = process.env.GEOIP_URL || 'https://iptoasn.com/data/ip2asn-combined.tsv.gz';
const out = config.geoipFile;
const tmp = `${out}.tmp`;

console.log(`downloading ${url}`);
const res = await fetch(url, { signal: AbortSignal.timeout(300_000) });
if (!res.ok) throw new Error(`${url}: ${res.status} ${res.statusText}`);
const buf = Buffer.from(await res.arrayBuffer());

// Check it parses before replacing the current file.
const text = (buf[0] === 0x1f && buf[1] === 0x8b ? gunzipSync(buf) : buf).toString('utf8');
const { table, skipped } = await parseTable(text);
if (table.size < 1000) throw new Error(`only ${table.size} ranges in the download; keeping the current file`);

await mkdir(dirname(out), { recursive: true });
try {
  await writeFile(tmp, buf);
  await rename(tmp, out);
} finally {
  await rm(tmp, { force: true });
}
console.log(`${out}: ${table.size.toLocaleString()} ranges, ${table.infos.length.toLocaleString()} distinct ASN/country entries${skipped ? `, ${skipped} lines skipped` : ''}`);
