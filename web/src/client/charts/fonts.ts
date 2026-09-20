// Chart font helpers. Canvas text cannot resolve var() or 'inherit', so the
// stack and scale are read from the page's CSS custom properties. Kept free of
// DOM types (and safe under Node) so the pure option builders can import it.
type CssReader = { getPropertyValue(name: string): string };

function rootCss(): CssReader | undefined {
  const g = globalThis as unknown as { document?: { documentElement: unknown }; getComputedStyle?: (el: unknown) => CssReader };
  return g.document && g.getComputedStyle ? g.getComputedStyle(g.document.documentElement) : undefined;
}

/** Chart font stack, resolved from --font-mono. */
export function chartFontFamily(): string {
  return rootCss()?.getPropertyValue('--font-mono').trim() || 'monospace';
}

/** A px size scaled by --font-scale, like the --fs-* variables the rest of the UI uses. */
export function fontPx(basePx: number): number {
  const scale = parseFloat(rootCss()?.getPropertyValue('--font-scale') ?? '') || 1;
  return Math.round(basePx * scale * 10) / 10;
}
