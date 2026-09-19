/** A CSS custom property of the current theme, e.g. for canvas text colors. */
export const cssVar = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
