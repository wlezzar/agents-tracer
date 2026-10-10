import { readColors } from './colors.js';

// The theme: the system's, light, or dark, kept in localStorage. The page's CSS follows the
// system unless the root element's data-theme names one.

const THEMES = ['system', 'light', 'dark'] as const;
const KEY = 'trace-theme';

let theme: string = localStorage.getItem(KEY) ?? 'system';
let applied: () => void = () => undefined;

/** What runs after the theme is applied, such as redrawing the canvases. */
export function onThemeApplied(callback: () => void): void {
  applied = callback;
}

/** Applies the theme to the page, labels the theme button, and reads the colors again. */
export function applyTheme(): void {
  const root = document.documentElement;
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
  const button = document.getElementById('theme');
  if (button) button.textContent = `Theme: ${theme}`;
  readColors();
  applied();
}

/** Moves to the next theme, keeps it, and applies it. */
export function cycleTheme(): void {
  const at = THEMES.findIndex((t) => t === theme);
  theme = THEMES[(at + 1) % THEMES.length] ?? 'system';
  localStorage.setItem(KEY, theme);
  applyTheme();
}

// The system's scheme can change while the page is open.
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  applyTheme();
});
