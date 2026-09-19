// IP text → numbers, and the address scopes the geo views set apart. Pure.

/** An IPv4 address as a u32, or an IPv6 address as a 128-bit bigint. */
export type ParsedIp = { v: 4; n: number } | { v: 6; n: bigint };

const V4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

export function parseV4(text: string): number | null {
  const m = V4.exec(text);
  if (!m) return null;
  let n = 0;
  for (let i = 1; i <= 4; i++) {
    const o = Number(m[i]);
    if (o > 255) return null;
    n = n * 256 + o;
  }
  return n;
}

/** IPv6 text (with `::` and an optional dotted IPv4 tail) as a bigint. */
export function parseV6(text: string): bigint | null {
  if (!text.includes(':')) return null;
  let s = text;
  // A dotted IPv4 tail ("::ffff:1.2.3.4") becomes its two hex words.
  const lastColon = s.lastIndexOf(':');
  if (s.indexOf('.', lastColon) > 0) {
    const v4 = parseV4(s.slice(lastColon + 1));
    if (v4 === null) return null;
    s = `${s.slice(0, lastColon + 1)}${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const words = (h: string) => (h === '' ? [] : h.split(':'));
  const head = words(halves[0]!);
  const rest = halves.length === 2 ? words(halves[1]!) : [];
  const given = head.length + rest.length;
  if (halves.length === 1 ? given !== 8 : given > 7) return null;
  let n = 0n;
  for (const w of [...head, ...new Array<string>(8 - given).fill('0'), ...rest]) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(w)) return null;
    n = (n << 16n) | BigInt(parseInt(w, 16));
  }
  return n;
}

/** Plain IPv4, IPv6, or IPv4-mapped IPv6 (which becomes IPv4). Null if unparseable. */
export function parseIp(text: string): ParsedIp | null {
  const v4 = parseV4(text);
  if (v4 !== null) return { v: 4, n: v4 };
  const v6 = parseV6(text);
  if (v6 === null) return null;
  if (v6 >> 32n === 0xffffn) return { v: 4, n: Number(v6 & 0xffffffffn) };
  return { v: 6, n: v6 };
}

/**
 * Where an address points: `public` (the only scope with an ASN), or one of
 * the scopes the dashboard counts as local traffic.
 */
export type IpScope = 'public' | 'private' | 'loopback' | 'link-local' | 'multicast' | 'unspecified';

const inV4 = (n: number, base: string, bits: number) => {
  const b = parseV4(base)!;
  const size = 2 ** (32 - bits);
  return n >= b && n < b + size;
};

const inV6 = (n: bigint, base: string, bits: number) => n >> BigInt(128 - bits) === parseV6(base)! >> BigInt(128 - bits);

export function ipScope(ip: ParsedIp): IpScope {
  if (ip.v === 4) {
    const n = ip.n;
    if (n === 0) return 'unspecified';
    if (inV4(n, '127.0.0.0', 8)) return 'loopback';
    if (inV4(n, '169.254.0.0', 16)) return 'link-local';
    if (inV4(n, '224.0.0.0', 4) || n === 0xffffffff) return 'multicast';
    if (inV4(n, '10.0.0.0', 8) || inV4(n, '172.16.0.0', 12) || inV4(n, '192.168.0.0', 16) || inV4(n, '100.64.0.0', 10) || inV4(n, '0.0.0.0', 8)) {
      return 'private';
    }
    // Subnet broadcasts of private ranges are covered above; 240/4 is reserved.
    if (inV4(n, '240.0.0.0', 4)) return 'private';
    return 'public';
  }
  const n = ip.n;
  if (n === 0n) return 'unspecified';
  if (n === 1n) return 'loopback';
  if (inV6(n, 'fe80::', 10)) return 'link-local';
  if (inV6(n, 'ff00::', 8)) return 'multicast';
  if (inV6(n, 'fc00::', 7)) return 'private';
  return 'public';
}
