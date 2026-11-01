// Draws the app icon (a fox in a Kober, a woven basket, on the VG green) and renders it to the files the PWA needs:
//
//   npm run icons          # writes public/icon.svg, public/logo.svg (the fox alone, without tile) and public/icons/*.png
//
// One drawing, four outputs: rounded for "any" (192, 512), full bleed for "maskable" (motif shrunk into the safe zone)
// and for the iOS home screen (iOS rounds the corners itself). Needs Google Chrome (or CHROME_PATH), like the
// screenshot script. Bump VERSION in public/sw.js afterwards so the new icons are picked up.
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');

// The fox: a flat fox face in a 512 x 512 box (alone it is the header logo)
const fox = `
    <path d="M92 92 L226 190 Q256 182 286 190 L420 92 Q444 224 392 330 Q336 440 256 450 Q176 440 120 330 Q68 224 92 92 Z" fill="#f08a24"/>
    <path d="M92 92 L168 150 L120 214 Q96 150 92 92 Z M420 92 L344 150 L392 214 Q416 150 420 92 Z" fill="#2b2f26" opacity=".85"/>
    <path d="M124 332 Q196 306 256 372 Q316 306 388 332 Q336 440 256 450 Q176 440 124 332 Z" fill="#ffffff"/>
    <circle cx="196" cy="274" r="19" fill="#2b2f26"/><circle cx="316" cy="274" r="19" fill="#2b2f26"/>
    <ellipse cx="256" cy="388" rx="26" ry="20" fill="#2b2f26"/>`;
// Motif of the app icon: the fox peeking out of a Kober (a woven basket with a handle rim), its paws on the rim.
// `scale` shrinks it around the centre (safe zone of maskable icons)
const WICKER = '#f4ecd8', WEAVE = '#6b8f2a';
const motif = scale => `
  <g transform="translate(256 271) scale(${scale}) translate(-256 -271)">
    <g transform="translate(256 206) scale(.74) translate(-256 -271)">${fox}</g>
    <path d="M86 350 L426 350 L398 462 Q256 484 114 462 Z" fill="${WICKER}"/>
    <path d="M110 406 L402 406 M150 362 V394 M214 362 V394 M278 362 V394 M342 362 V394 M182 418 V454 M246 418 V458 M310 418 V458 M374 418 V452"
      stroke="${WEAVE}" stroke-width="10" stroke-linecap="round" fill="none"/>
    <rect x="70" y="312" width="372" height="42" rx="21" fill="${WICKER}"/>
    <ellipse cx="178" cy="318" rx="36" ry="22" fill="#f08a24"/><ellipse cx="334" cy="318" rx="36" ry="22" fill="#f08a24"/>
  </g>`;

// dev: the icon of the dev site (blue instead of green, with a DEV bar) so both can sit on one home screen
const svg = ({ rounded, scale, dev, ribbon = true }) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${dev ? '#8a98f2' : '#8cbc50'}"/><stop offset="1" stop-color="${dev ? '#3b479e' : '#4c7005'}"/></linearGradient>
  <clipPath id="c"><rect width="512" height="512"${rounded ? ' rx="112"' : ''}/></clipPath></defs>
  <g clip-path="url(#c)"><rect width="512" height="512" fill="url(#g)"/>
  ${dev && ribbon ? `<g transform="translate(0 -36)">${motif(scale * 0.8)}</g><rect y="396" width="512" height="116" fill="#12163f" opacity=".92"/><text x="256" y="486" font-family="Helvetica,Arial,sans-serif" font-weight="800" font-size="92" text-anchor="middle" fill="#d8defe" letter-spacing="10">DEV</text>` : motif(scale)}</g>
</svg>`;

async function launch() {
  const opts = { headless: true };
  if (process.env.CHROME_PATH) return chromium.launch({ ...opts, executablePath: process.env.CHROME_PATH });
  try { return await chromium.launch({ ...opts, channel: 'chrome' }); } catch (e) { /* no Chrome: try a downloaded Chromium */ }
  return chromium.launch(opts);
}

const outputs = [
  { file: 'icons/icon-192.png', size: 192, rounded: true, scale: 1 },
  { file: 'icons/icon-512.png', size: 512, rounded: true, scale: 1 },
  { file: 'icons/icon-maskable-512.png', size: 512, rounded: false, scale: 0.78 },
  { file: 'icons/apple-touch-icon.png', size: 180, rounded: false, scale: 0.92 },
  { file: 'icons/dev-icon-192.png', size: 192, rounded: true, scale: 1, dev: true },
  { file: 'icons/dev-icon-512.png', size: 512, rounded: true, scale: 1, dev: true },
  { file: 'icons/dev-icon-maskable-512.png', size: 512, rounded: false, scale: 0.78, dev: true, ribbon: false },
  { file: 'icons/dev-apple-touch-icon.png', size: 180, rounded: false, scale: 0.92, dev: true },
];

// Without trailing spaces and with a final newline, like the file checks want them
const tidy = text => text.replace(/[ \t]+$/gm, '').trimEnd() + '\n';
fs.writeFileSync(path.join(PUBLIC, 'icon.svg'), tidy(svg({ rounded: true, scale: 1 })));
// The fox alone, without the green tile: for the header, where it sits on the green bar
fs.writeFileSync(path.join(PUBLIC, 'logo.svg'), tidy(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="64 88 384 366">${fox}</svg>`));
const browser = await launch();
try {
  const page = await browser.newPage();
  for (const o of outputs) {
    await page.setViewportSize({ width: o.size, height: o.size });
    await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${o.size}px;height:${o.size}px}</style>${svg(o)}`);
    await page.waitForTimeout(100); // let the resized viewport settle before the shot
    await page.screenshot({ path: path.join(PUBLIC, o.file), omitBackground: true, clip: { x: 0, y: 0, width: o.size, height: o.size } });
    console.log(`  ${o.file}`);
  }
} finally { await browser.close(); }
console.log('icons written');
