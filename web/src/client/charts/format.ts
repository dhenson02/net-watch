// Formatters shared by every chart, tooltip and table.

/** Subtitle or footnote for every traffic chart. */
export const PAYLOAD_NOTE = 'application payload (excludes headers and retransmits)';

const sig3 = (n: number) => (n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2));

/** A rate in kbps (the wire unit) with SI prefixes: 12_400 → "12.4 Mbps". */
export function fmtRate(kbps: number): string {
  let v = Math.abs(kbps) * 1000;
  const sign = kbps < 0 ? '-' : '';
  if (v === 0) return '0 bps';
  const units = ['bps', 'kbps', 'Mbps', 'Gbps', 'Tbps'];
  let i = 0;
  while (v >= 999.5 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return `${sign}${i === 0 ? Math.round(v) : sig3(v)} ${units[i]}`;
}

/** Bytes with IEC units, like ClickHouse's formatReadableSize: "1.50 KiB". */
export function fmtBytes(bytes: number): string {
  let v = Math.abs(bytes);
  const sign = bytes < 0 ? '-' : '';
  if (v < 1024) return `${sign}${Math.round(v)} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB'];
  let i = -1;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${sign}${v.toFixed(2)} ${units[i]}`;
}

/** A duration: "350 ms", "42 s", "5m 03s", "15m", "2h 10m", "3d 4h", "7d". Zero trailing units are dropped. */
export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s} s`;
  const two = (big: number, bigUnit: string, small: number, smallUnit: string) =>
    small ? `${big}${bigUnit} ${String(small).padStart(2, '0')}${smallUnit}` : `${big}${bigUnit}`;
  const m = Math.floor(s / 60);
  if (m < 60) return two(m, 'm', s % 60, 's');
  const h = Math.floor(m / 60);
  if (h < 24) return two(h, 'h', m % 60, 'm');
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

/** The browser's IANA timezone; send it with any hour/day bucketing. */
export const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;

const formatters = new Map<string, Intl.DateTimeFormat>();

type TimeStyle = 'time' | 'datetime' | 'date';

const STYLES: Record<TimeStyle, Intl.DateTimeFormatOptions> = {
  time: { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false },
  datetime: { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false },
  date: { year: 'numeric', month: 'short', day: 'numeric' },
};

/** ms since epoch as local (or `tz`) wall time. */
export function fmtTime(ms: number, style: TimeStyle = 'datetime', tz = browserTz): string {
  const key = `${style}|${tz}`;
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(undefined, { ...STYLES[style], timeZone: tz });
    formatters.set(key, f);
  }
  return f.format(ms);
}
