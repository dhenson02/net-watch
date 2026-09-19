// Org names of the geo table (18), shared by the server's labels and the client.
import type { Geo } from './api.ts';

const SUFFIX = /,?\s+(inc\.?|llc|l\.l\.c\.|ltd\.?|limited|corp\.?|corporation|co\.?|gmbh|b\.v\.|s\.a\.|pbc|plc|ag|sa)$/i;

/** An org without its legal suffixes: "Amazon.com, Inc." → "Amazon.com", "Google LLC" → "Google". */
export function shortOrg(org: string): string {
  let s = org.trim();
  for (let i = 0; i < 3; i++) {
    const t = s.replace(SUFFIX, '').trim();
    if (t === s || !t) break;
    s = t;
  }
  return s;
}

/** Cuts `s` to `max` chars with an ellipsis. */
export const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** `org (ip:port)`: how the Sankey and the throughput legend name a known destination. */
export const orgDestLabel = (geo: Geo | undefined, dest: string) => (geo ? `${clip(shortOrg(geo.org), 24)} (${dest})` : dest);
