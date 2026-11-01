// WCAG 2.x contrast helper for the colour tokens in public/theme.css.
// Usage: node scripts/contrast.mjs   (prints the pairs that matter for readability; test/contrast.test.js checks the limits)
import fs from 'node:fs';

export function parseHex(hex) {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new Error('not a hex colour: ' + hex);
  let h = m[1]; if (h.length === 3) h = [...h].map(c => c + c).join('');
  return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
}
export function luminance(hex) {
  const [r, g, b] = parseHex(hex).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
// Token maps of the light and the dark block of theme.css (plain hex values only)
export function readTokens(css) {
  const grab = block => Object.fromEntries([...block.matchAll(/--([\w-]+)\s*:\s*(#[0-9a-fA-F]{3,6})\s*;/g)].map(m => [m[1], m[2]]));
  const darkAt = css.indexOf('prefers-color-scheme:dark');
  return { light: grab(css.slice(0, darkAt)), dark: grab(css.slice(darkAt)) };
}
// [foreground token, background token, minimum ratio, what it is]
export const PAIRS = [
  ['fg', 'bg', 4.5, 'text on the page'],
  ['mute', 'bg', 4.5, 'muted text on the page'], ['mute', 'card', 4.5, 'muted text on cards'], ['mute', 'green2', 4.5, 'muted text on light green'],
  ['green', 'card', 4.5, 'links and the active tab on cards'],
  ['ctl-bd', 'bg', 3, 'input border on the page background'], ['ctl-bd', 'card', 3, 'input border on cards'],
  ['tone-bd', 'card', 3, 'unchecked check ring on cards'], ['tone-bd', 'bg', 3, 'unchecked check ring on the page'],
  ['tone-fg', 'tone-bg', 4.5, 'badge chip text'],
  ['focus', 'bg', 3, 'focus ring on the page'], ['focus', 'card', 3, 'focus ring on cards'],
];
export function measure(css = fs.readFileSync(new URL('../public/theme.css', import.meta.url), 'utf8')) {
  const tok = readTokens(css), out = [];
  for (const mode of ['light', 'dark']) for (const [f, b, min, what] of PAIRS) {
    const ok = tok[mode][f] && tok[mode][b];
    out.push({ mode, f, b, min, what, ratio: ok ? contrast(tok[mode][f], tok[mode][b]) : null });
  }
  return out;
}
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  for (const r of measure()) console.log(`${r.mode.padEnd(5)} ${r.f.padEnd(8)} on ${r.b.padEnd(7)} ${r.ratio == null ? 'n/a' : r.ratio.toFixed(2)}  (min ${r.min})  ${r.what}`);
}
