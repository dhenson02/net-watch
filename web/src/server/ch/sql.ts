// SQL fragments shared by the history queries. They are constants: user input
// never becomes SQL text, only `{name:Type}` parameters.
import { isIP } from 'node:net';
import { badRequest } from '../http-error.ts';

/**
 * `raddr` as text, matching the plain IPv4 that Redis and the live API show
 * (IPv4 is stored IPv4-mapped, `::ffff:a.b.c.d`). For the reverse direction,
 * filtering by user-typed text, use `raddr = toIPv6({ip:String})`: toIPv6 maps
 * IPv4 input to `::ffff:…`.
 */
export const DISPLAY_IP = "replaceRegexpOne(IPv6NumToString(raddr), '^::ffff:(\\d+\\.\\d+\\.\\d+\\.\\d+)$', '\\1')";

/** WHERE condition for one destination; its params come from `parseDest`. */
export const DEST_FILTER = 'raddr = toIPv6({dest_ip:String}) AND rport = {dest_port:UInt16}';

/**
 * Parses a destination filter, `ip:port` as the dashboard shows it
 * (`1.2.3.4:443`, `2001:db8::1:443` or `[2001:db8::1]:443`), into
 * `DEST_FILTER`'s params. Missing means no filter.
 */
export function parseDest(raw: unknown): { dest_ip: string; dest_port: number } | null {
  if (raw === undefined || raw === '') return null;
  const bad = () => badRequest('dest: expected ip:port');
  if (typeof raw !== 'string' || raw.length > 64) throw bad();
  const i = raw.lastIndexOf(':');
  if (i <= 0) throw bad();
  let ip = raw.slice(0, i);
  const port = raw.slice(i + 1);
  if (ip.startsWith('[') && ip.endsWith(']')) ip = ip.slice(1, -1);
  if (!isIP(ip) || !/^\d{1,5}$/.test(port) || Number(port) > 65535) throw bad();
  return { dest_ip: ip, dest_port: Number(port) };
}
