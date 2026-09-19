// Pure logic of the uid → process → app treemap (07): URL params, the user
// colors (root marked), the series data for the treemap and sunburst views,
// and tooltip text.
import type { TreemapDir, TreemapUser } from '../../shared/api.ts';
import { CATEGORICAL, OTHER, type Scheme } from '../charts/palette.ts';

export const VIEW_PARAM = 'tm';
export const DIR_PARAM = 'tm_dir';

export type TreemapView = 'treemap' | 'sunburst';

export const parseView = (raw: string | null): TreemapView => (raw === 'sunburst' ? 'sunburst' : 'treemap');
export const parseDir = (raw: string | null): TreemapDir => (raw === 'tx' || raw === 'rx' ? raw : 'total');

/** The uid of rollup rows whose process is unknown (the server's UNKNOWN_UID). */
export const UNKNOWN_UID = 4294967295;
export const ROOT_UID = 0;
/** Root always gets this slot (red), which no other user is given: root-owned traffic stands out. */
export const ROOT_SLOT = 7;

/**
 * A color per user, in the order given (largest first): root gets ROOT_SLOT,
 * the unknown uid and users past the free slots get the neutral "other",
 * every other user the next unused categorical slot.
 */
export function userColors(users: readonly Pick<TreemapUser, 'uid'>[], scheme: Scheme): Map<number, string> {
  const palette = CATEGORICAL[scheme];
  const out = new Map<number, string>();
  let next = 0;
  for (const { uid } of users) {
    if (uid === ROOT_UID) out.set(uid, palette[ROOT_SLOT]!);
    else if (uid === UNKNOWN_UID) out.set(uid, OTHER[scheme]);
    else {
      if (next === ROOT_SLOT) next++;
      out.set(uid, next < palette.length ? palette[next++]! : OTHER[scheme]);
    }
  }
  return out;
}

/** `#rrggbb` mixed toward white by `t` (0..1), like zrender's `lift`. */
export function lighten(hex: string, t: number): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = (shift: number) => {
    const c = (n >> shift) & 255;
    return Math.round(c + (255 - c) * t)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${ch(16)}${ch(8)}${ch(0)}`;
}

/** Extra fields a node carries for the tooltip; ECharts passes them back in `params.data`. */
export interface NodeInfo {
  kind: 'user' | 'proc' | 'app';
  uid: number;
  folded?: number;
}

export interface SeriesNode {
  name: string;
  value: number;
  info: NodeInfo;
  itemStyle?: { color: string };
  children?: SeriesNode[];
  /** Set on nodes with nothing below them: no click, no hover effect, plain cursor. */
  cursor?: 'default';
  emphasis?: { disabled: true };
  nodeClick?: false;
}

/** Marks a node that cannot be drilled into: inert on hover and click (the treemap's click is gated in the panel). */
export const INERT = { cursor: 'default', emphasis: { disabled: true }, nodeClick: false } as const;

/**
 * The series data. Users carry their color; the treemap varies the shade of
 * their children itself (levels' colorSaturation, in fact HSL lightness). The sunburst
 * has no such mapping, so `shades` gives every process and app an explicit,
 * progressively lighter shade of its user's color. The folded "other" process
 * node is always neutral.
 */
export function seriesData(users: readonly TreemapUser[], scheme: Scheme, shades = false): SeriesNode[] {
  const colors = userColors(users, scheme);
  const other = OTHER[scheme];
  return users.map((u) => {
    const color = colors.get(u.uid) ?? other;
    const n = u.children.length;
    return {
      name: u.name,
      value: u.value,
      info: { kind: 'user', uid: u.uid },
      itemStyle: { color },
      children: u.children.map((p, i) => {
        const base = p.folded !== undefined ? other : shades ? lighten(color, 0.1 + (0.35 * i) / Math.max(1, n - 1)) : undefined;
        return {
          name: p.name,
          value: p.value,
          info: { kind: 'proc', uid: u.uid, ...(p.folded !== undefined ? { folded: p.folded } : {}) },
          ...(base ? { itemStyle: { color: base } } : {}),
          ...(p.children.length ? {} : INERT),
          children: p.children.map((a) => ({
            name: a.name,
            value: a.value,
            info: { kind: 'app', uid: u.uid },
            ...INERT,
            ...(shades && base ? { itemStyle: { color: lighten(base, 0.3) } } : {}),
          })),
        };
      }),
    };
  });
}

/** `12.3%` of the total; `<0.1%` for a sliver. */
export function shareText(value: number, total: number): string {
  if (!(total > 0)) return '—';
  const pct = (value / total) * 100;
  if (pct > 0 && pct < 0.1) return '<0.1%';
  return `${pct >= 10 ? pct.toFixed(0) : pct.toFixed(1)}%`;
}

/**
 * Names on the way to a node, from ECharts' `treePathInfo` (the first entry
 * is the series' own root and is left out): `jay › firefox › HTTPS`.
 */
export function pathText(path: readonly { name: string }[] | undefined): string {
  return (path ?? [])
    .slice(1)
    .map((p) => p.name)
    .join(' › ');
}
