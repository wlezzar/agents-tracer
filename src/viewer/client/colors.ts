// The colors the canvases draw with, read from the page's CSS custom properties, which differ by
// theme; read again whenever the theme changes.

/** The colors' CSS custom properties: each color category's, then the page's tokens. */
const PROPERTIES: readonly (readonly [key: string, property: string])[] = [
  ['model', '--series-1'],
  ['shell', '--series-2'],
  ['tool', '--series-3'],
  ['you', '--wait-you'],
  ['youbg', '--wait-youbg'],
  ['bg', '--wait-bg'],
  ...[
    'page',
    'surface-1',
    'text-primary',
    'text-secondary',
    'muted',
    'grid',
    'axis',
    'critical',
    'on-fill',
    'wash',
    'hover',
    'gap-band',
    'lift',
  ].map((k) => [k, `--${k}`] as const),
];

const COLORS = new Map<string, string>();

/** Reads every color from the page's CSS as it is now. */
export function readColors(): void {
  const cs = getComputedStyle(document.documentElement);
  for (const [key, property] of PROPERTIES) COLORS.set(key, cs.getPropertyValue(property).trim());
}

/** The color of a category or a token; empty (which a canvas ignores) for an unknown one. */
export function color(key: string): string {
  return COLORS.get(key) ?? '';
}

/** The color of a category or a token, or `key` itself, as a CSS color, when it is neither. */
export function colorOr(key: string): string {
  return COLORS.get(key) ?? key;
}
