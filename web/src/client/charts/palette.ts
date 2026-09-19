// Series colors. The values are the dataviz reference palette, validated with
// its checker for both modes (adjacent pairs): worst CVD ΔE 9.1 light / 8.4
// dark, normal-vision ΔE 19.6 / 19.3. In light mode slots 3, 4 and 5 are below
// 3:1 against the surface, so charts must carry a legend and tooltip (or
// direct labels) rather than rely on the fill alone.
//
// Slots are assigned in order, never cycled. A series past slot 8 folds into
// "other". Scatter-like charts, where any two colors can touch, should stop at
// 3 slots (the first three validate all-pairs).

export type Scheme = 'light' | 'dark';

export const CATEGORICAL: Record<Scheme, readonly string[]> = {
  //      blue       orange     aqua       yellow     magenta    green      violet     red
  light: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'],
  dark: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'],
};

export const SLOTS = 8;

/**
 * Sequential single-hue ramp (the dataviz reference blue, steps 100→700),
 * low → high, for continuous magnitude such as heatmap cells. Near zero
 * recedes toward the surface: light in light mode, dark in dark mode.
 */
export const SEQUENTIAL: Record<Scheme, readonly string[]> = {
  light: ['#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#184f95', '#0d366b'],
  dark: ['#0d366b', '#184f95', '#256abf', '#3987e5', '#6da7ec', '#9ec5f4', '#cde2fb'],
};

/** The "other" bucket: neutral, never a hue. */
export const OTHER: Record<Scheme, string> = { light: '#898781', dark: '#898781' };

/**
 * Direction pair, the same in every chart: tx warm, rx cool. tx is drawn
 * above zero and rx below.
 */
export const TX: Record<Scheme, string> = { light: '#eb6834', dark: '#d95926' };
export const RX: Record<Scheme, string> = { light: '#2a78d6', dark: '#3987e5' };

/**
 * Fixed hues for application protocols (the Sankey's middle layer), so HTTPS
 * looks the same on every page and every refresh. Indexes into CATEGORICAL;
 * apps not listed get APP_NEUTRAL, `unknown` gets OTHER.
 */
const APP_SLOTS: Record<string, number> = { HTTPS: 6, QUIC: 2, DNS: 3, SSH: 7, HTTP: 4 };
export const APP_NEUTRAL: Record<Scheme, string> = { light: '#5f7187', dark: '#7d8ea3' };

/** Color of an app label; a transport suffix (`DNS/UDP`) is ignored. */
export function appColor(label: string, scheme: Scheme): string {
  const app = label.replace(/\/(TCP|UDP)$/, '');
  if (app === 'unknown') return OTHER[scheme];
  const slot = APP_SLOTS[app];
  return slot === undefined ? APP_NEUTRAL[scheme] : CATEGORICAL[scheme][slot]!;
}

/** Color for a slot from SlotAssigner; -1 (no free slot) is "other". */
export function slotColor(slot: number, scheme: Scheme): string {
  return slot >= 0 && slot < SLOTS ? CATEGORICAL[scheme][slot]! : OTHER[scheme];
}

/** A slot is kept this long after its series was last seen. */
const RELEASE_MS = 60_000;

/**
 * Keeps a series' color stable while top-N rankings change: a name gets the
 * lowest free slot on first appearance and keeps it until it has been absent
 * for 60 s. Hold one per page (useSlots) so colors agree across its charts.
 */
export class SlotAssigner {
  #slots = new Map<string, { slot: number; lastSeen: number }>();

  /**
   * Marks `names` as present (in priority order: earlier names get free slots
   * first) and returns each one's slot, -1 for "other".
   */
  assign(names: Iterable<string>, now = Date.now()): Map<string, number> {
    for (const [name, s] of this.#slots) if (now - s.lastSeen > RELEASE_MS) this.#slots.delete(name);
    const used = new Set([...this.#slots.values()].map((s) => s.slot));
    const out = new Map<string, number>();
    for (const name of names) {
      let s = this.#slots.get(name);
      if (!s) {
        let slot = 0;
        while (used.has(slot)) slot++;
        if (slot >= SLOTS) {
          out.set(name, -1);
          continue;
        }
        used.add(slot);
        s = { slot, lastSeen: now };
        this.#slots.set(name, s);
      }
      s.lastSeen = now;
      out.set(name, s.slot);
    }
    return out;
  }

  /** Frees the slots of `names` now, e.g. when a chart switches what its series stand for. */
  release(names: Iterable<string>): void {
    for (const name of names) this.#slots.delete(name);
  }

  slot(name: string): number {
    return this.#slots.get(name)?.slot ?? -1;
  }
}
