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

/** The "other" bucket: neutral, never a hue. */
export const OTHER: Record<Scheme, string> = { light: '#898781', dark: '#898781' };

/**
 * Direction pair, the same in every chart: tx warm, rx cool. tx is drawn
 * above zero and rx below.
 */
export const TX: Record<Scheme, string> = { light: '#eb6834', dark: '#d95926' };
export const RX: Record<Scheme, string> = { light: '#2a78d6', dark: '#3987e5' };

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

  slot(name: string): number {
    return this.#slots.get(name)?.slot ?? -1;
  }
}
