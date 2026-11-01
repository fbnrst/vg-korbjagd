// Builds the one GitHub Pages site out of two versions of public/ (see "Release and dev site" in AGENTS.md):
//
//   node scripts/build-site.mjs <release public dir> <dev public dir> <out dir>
//
// The release lands at the root, the dev build (current main) under /dev/. The dev copy is turned into its own app: the dev
// Firebase project (public/firebase-config.dev.js, or demo mode while that is not set up), its own name and icons, so it can
// sit next to the release on a home screen. Browser storage and caches of the dev copy are separated in the code itself
// (public/env.js, public/sw.js).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const [releaseDir, devDir, outDir] = process.argv.slice(2);
if (!releaseDir || !devDir || !outDir) { console.error('usage: node scripts/build-site.mjs <release dir> <dev dir> <out dir>'); process.exit(1); }

const DEV_CONFIG = 'firebase-config.dev.js';
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');

fs.rmSync(outDir, { recursive: true, force: true });
fs.cpSync(releaseDir, outDir, { recursive: true });
fs.cpSync(devDir, path.join(outDir, 'dev'), { recursive: true });
const dev = path.join(outDir, 'dev');

// Firebase: the dev site never talks to the production database
const devConfig = fs.existsSync(path.join(devDir, DEV_CONFIG)) ? read(devDir, DEV_CONFIG) : 'export default null;\n';
fs.writeFileSync(path.join(dev, 'firebase-config.js'), devConfig);
for (const d of [outDir, dev]) fs.rmSync(path.join(d, DEV_CONFIG), { force: true });

// Own name and icons
const manifest = JSON.parse(read(dev, 'manifest.json'));
Object.assign(manifest, { name: 'Kober DEV', short_name: 'Kober DEV' });
manifest.icons = [
  { src: 'icons/dev-icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
  { src: 'icons/dev-icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
  { src: 'icons/dev-icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
];
fs.writeFileSync(path.join(dev, 'manifest.json'), JSON.stringify(manifest, null, 1));

let html = read(dev, 'index.html');
const swap = (from, to) => { if (!html.includes(from)) throw new Error(`index.html: "${from}" not found`); html = html.replace(from, to); };
swap('icons/apple-touch-icon.png', 'icons/dev-apple-touch-icon.png');
html = html.replace(/(<meta name="apple-mobile-web-app-title" content=")[^"]*/, '$1Kober DEV');
fs.writeFileSync(path.join(dev, 'index.html'), html);
// The dev service worker precaches the dev icons, not the release ones
let devSw = read(dev, 'sw.js');
const icons = devSw.match(/'\.\/icons\/[^']+'/g) || [];
if (!icons.length) throw new Error('sw.js: no icons in FILES');
for (const i of icons) if (!i.includes('/dev-')) devSw = devSw.replace(i, i.replace('./icons/', './icons/dev-'));
fs.writeFileSync(path.join(dev, 'sw.js'), devSw);

// Which build is this: shown at the bottom of the "…" menu (public/version.js). RELEASE_LABEL is the tag, DEV_LABEL "dev <commit>".
const stamp = (dir, label) => fs.writeFileSync(path.join(dir, 'version.js'), `// Written by scripts/build-site.mjs\nexport const BUILD = ${JSON.stringify(label)};\n`);
stamp(outDir, process.env.RELEASE_LABEL || 'dev');
stamp(dev, process.env.DEV_LABEL || 'dev');

// Cache name per deploy: VERSION in sw.js becomes a hash of the site's files (sw.js itself and, at the root, /dev/ left out),
// so every deploy that changes a file gets a new cache and an unchanged site keeps its worker
const hashDir = (dir, skip) => {
  const h = crypto.createHash('sha256');
  const walk = rel => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const r = rel ? rel + '/' + e.name : e.name;
      if (skip.includes(r)) continue;
      if (e.isDirectory()) walk(r);
      else h.update(r + '\0').update(fs.readFileSync(path.join(dir, r))).update('\0');
    }
  };
  walk('');
  return h.digest('hex').slice(0, 12);
};
const stampSw = (dir, skip) => {
  const sw = read(dir, 'sw.js');
  const re = /^const VERSION = '[^']*';/m;
  if (!re.test(sw)) throw new Error(`${dir}/sw.js: VERSION not found`);
  fs.writeFileSync(path.join(dir, 'sw.js'), sw.replace(re, `const VERSION = 'v${hashDir(dir, skip)}';`));
};
stampSw(dev, ['sw.js']);
stampSw(outDir, ['sw.js', 'dev']);

console.log(`site written to ${outDir} (release from ${releaseDir}, dev from ${devDir})`);
