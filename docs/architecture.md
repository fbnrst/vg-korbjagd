# Architecture

Orientation for developers: where things live and how the parts work together. Detailed behaviour rules (points, name check, layout, accessibility, overload behaviour) are in [AGENTS.md](../AGENTS.md), the user-facing operation on the help page `public/docs/index.html`.

Kober is a static site with no server and no build step (ES modules, GitHub Pages). The list first lives only in `localStorage` (code `LOCAL`). Only when it is shared does it move to the Firebase Realtime Database; all devices then subscribe to the same list. The VG server, Open Food Facts and Firebase are called directly from the browser.

## Module overview (`public/`)

| File | Purpose |
|---|---|
| `index.html`, `theme.css` | shell, views and dialogs; `theme.css` is the only place for colours (light/dark) |
| `app.js` | UI, events, scanner, dialogs, start (`init`), share/join/leave/delete |
| `flows.js` | pure logic behind flows of `app.js` (reset plan, too-long numbers, checkout ticks, VG loader, first upload) |
| `store.js` | data layer: adapters (Firebase, local), list logic, points, activity stamp, write timeout (`guardAdapter`) |
| `conn.js` | connection state of a shared list (`ok`, `connecting`, `degraded`, `busy`), backoff |
| `outbox.js` | journal of waiting changes in `localStorage` |
| `cache.js` | last live snapshot per shared list in `localStorage` |
| `sim.js` | simulated server with fault injection (`?sim=…`) and a manual clock for tests |
| `vg.js` | load and cache VG master data, index and search, name check, scan codes, import of VG app links |
| `i18n.js` | all visible texts (`STRINGS.en`, `STRINGS.de`), `t()`, `applyStatic()` |
| `a11y.js` | dialog semantics, focus trap, menu keyboard, `shortName()` |
| `env.js` | `IS_DEV` (path `/dev/`) and `NS`, the prefix for every storage key and cache name |
| `sw.js` | service worker: file list precached, then network first (`no-cache`), cache on failure |
| `firebase-config.js`, `firebase-config.dev.js` | Firebase web configuration (public); `null` = demo mode |
| `privacy.html`, `docs/index.html`, `legal-config.js` | privacy page, help page (both bilingual), contact details |
| `manifest.json`, `icon.svg`, `logo.svg`, `icons/` | PWA metadata and icons (`npm run icons`) |
| `vendor/` | third-party libraries (QR code, CryptoJS, zxing), excluded from the checks |

The Firebase SDK (10.14.1) is loaded from `gstatic.com` only when needed; the scanner on iOS/Safari loads `vendor/zxing.min.js` (`@zxing/library@0.21.3`) when needed; Chrome/Android use the built-in `BarcodeDetector`. Unknown EANs are looked up at Open Food Facts.

## Data model

Everything lives under `lists/<CODE>` (6 characters from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`; the rules allow `^[A-Z0-9]{6}$`). The local list has the same shape in `localStorage` (key `NS + 'kober-local-db'`), but without scores.

```
lists/<CODE>/
  meta/created            timestamp, writable once
  activity                timestamp (ms), stamped at most hourly
  items/<id>              id, title, amount, checked, addedBy, addedAt  (required)
                          unit, info, vgNum, ean, checkedBy, checkedAt  (optional)
  scores/<user key>                   points, integer 0 to 100000
  deposit/<deposit type id>/<user key>   empties pieces, 1 to 100000
```

- **User key:** `"<emoji> <name>"` (`userKey` in `store.js`, pattern as in the rules, at most 60 characters). There is no login: the same key is the same person.
- **Limits in the rules:** `title` 1-120 characters, `amount` 1-999, `unit` up to 20, `info` up to 200, `vgNum` 1-9999999, `ean` 8-14 digits, no foreign fields in `items`, `meta` and at list level.
- **Rules** (`database.rules.json`, published by hand in the Firebase console): everything outside `lists/<CODE>` is locked, reading with the code is open, writing at list level only for deleting (`!newData.exists()`). `store.js` must match, `test/rules.test.js` evaluates the rules. See [security.md](security.md) and [retention.md](retention.md).
- The names of the deposit types come from the VG data, not from Firebase.

## Data layer (`store.js`)

`createStore(adapter)` is written once and runs against an adapter (`subscribe`, `get`, `update` as a transaction, `set`, `remove`; Firebase additionally `connect`/`disconnect`). `update`: returning `undefined` aborts, `null` deletes. The store methods abort when the target state has already been reached; that is why they are repeatable (the basis of the outbox).

- `firebaseAdapter` for shared lists; `localAdapter` (`localStorage`, other tabs through the `storage` event) for the local list, in demo mode (`firebase-config.js` is `null`) also for shared lists, and in the tests with a storage object of their own.
- Points (`scores`) are changed only by a second transaction (`bump`/`point`) after the item transaction, and only if that changed something. The rules for this (who gets and who loses the point, undo, new round) are in AGENTS.md under "Points".
- Resetting: `clearOpen`, `clearChecked`, `clearAll`, `clearDeposit`, `resetScores`; which of them run is decided by `resetPlan` in `flows.js`.
- Activity: the writing methods stamp `activity` (not on a bad connection). `deleteList` removes the whole list. `.github/workflows/cleanup.yml` runs `scripts/cleanup-lists.mjs` weekly (lists without activity for 30 days, service account secret `FIREBASE_SERVICE_ACCOUNT`).
- `renameUser` moves points, empties and "by" marks to a new user key.

## Flows (`app.js`)

- **Start (`init`):** `?list=<CODE>` (different from the stored code) joins (`joinShared`), a stored code plus name starts the shared list (`startShared`), otherwise the local one (`startLocal`). If starting the shared list fails (offline), the code stays stored and the local list runs. `LS` (`app.js`) stores `me`, `code`, `numMode`, `checkoutTicks` under `NS`.
- **Share:** `shareLocalList` asks for name and emoji if needed, creates a new list through `uploadLocalList` (`flows.js`) and uploads items and empties with `importList` (no points); only then is the local copy removed. On an error it stays unchanged.
- **Join:** by link, QR code (scanner in mode `join`) or code (`parseListCode`); `joinShared` checks `exists`, otherwise a notice and back to the local list.
- **Leave:** forgets the code and starts the local list; the shared list stays for the others.
- **Delete:** `deleteList` for everyone. When a shared list disappears (deleted or by the cleanup job), the `onSnapshot` reports it (no `meta` any more, only on a healthy connection, `shouldForgetList`) and the app falls back to the local list.
- **Rendering:** `state` is replaced and rendered again on every adapter event; waiting outbox entries are laid on top (`outbox.overlayFor`). Tabs: list, empties, checkout, ranking (shared only).

## Offline and overload

- **Local list:** `localStorage` only, works without a network; the Firebase SDK is never loaded for it.
- **VG data (`loadVg`):** first `getChecksums.php`; if the checksums match the cache (`NS + 'kober-vg-v2'`) or the network is gone, the cache is used, otherwise all five lists are reloaded and stored. Timeout 20 s per request. `createVgLoader` (`flows.js`) turns this into the states `loading`, `ready`, `unreachable` for the Empties tab. Endpoint details: [vg-api.md](vg-api.md).
- **Service worker:** puts the files from `FILES` into the cache on install (`kober-v<VERSION>`, on dev `kober-dev-v…`); same origin, GET: network first, cache on failure. Firebase, VG and other hosts bypass it. When files change, bump `VERSION` in `sw.js`.
- **Connection (`conn.js`):** `degraded` after 3 s without a connection, on flapping or write timeouts; `busy` after 15 s without ever having connected or on "connected and immediately disconnected" (connection limit). Back to `ok` only after 5 s of stability. On `busy` the app disconnects itself and retries with backoff and jitter (up to 120 s). `guardAdapter` aborts hanging writes after 8 s (`PendingError`, the operation stays queued).
- **Outbox (`outbox.js`):** item and empties operations are noted as an intent (`{id, code, op, args, ts}`) under `NS + 'kober-outbox'` before they are sent, and struck out once they are through. While `degraded`/`busy` everything waits; on `ok` and at start `store.flush(code)` replays the entries of the open list. At most 200 entries, at most 24 h old, every entry is validated again on load. Deliberately accepted edge cases are in AGENTS.md.
- **Cache (`cache.js`):** last live snapshot per list under `NS + 'kober-cache:' + code` (3 lists, at most 200 KB each, at most 30 days old); shown read-only on the first load until live data arrives.
- **Testing:** `?sim=overload|slow|flap|recover:<s>|cut:<s>[:<back>]` (demo mode or dev only); `test/overload.test.js` and `test/outbox.test.js` use the same simulation with a manual clock.

## Building and publishing

- No build for the app itself: `public/` is the site. Locally `npm start` (port 3000) or `python3 -m http.server --directory public`; without a Firebase configuration the demo mode runs.
- `.github/workflows/pages.yml` (push to `main`, manual): `node --test`, then `scripts/build-site.mjs` builds a site from two states: the root is the newest release (tag `v*`, until one exists `main`), `/dev/` is `main` with its own Firebase configuration, its own manifest name and its own icons. How a release works: AGENTS.md, "Release and dev site".
- `.github/workflows/autofix.yml` runs the same checks as locally (`prek.toml`); `cleanup.yml` is the cleanup job.
- The database rules are not published along with it but applied by hand (dev first).

## Setting up your own Firebase project

Only needed if someone runs the app under their own address (forks are not an intended mode of operation; production and dev are already set up).

1. In the [Firebase console](https://console.firebase.google.com) create a project and a **Realtime Database** (region Europe).
2. *Realtime Database → Rules*: paste the content of `database.rules.json` and publish ([security.md](security.md#publishing-the-rules)).
3. *Project settings → General → Your apps → Add app (Web)*: enter the configuration in `public/firebase-config.js` (public identifiers, no secrets). Dev uses `public/firebase-config.dev.js`.
4. For the deletion after 30 days, set up the cleanup job (secret `FIREBASE_SERVICE_ACCOUNT`, [retention.md](retention.md)).
5. GitHub: *Settings → Pages → Source: GitHub Actions*. Every push to `main` tests and publishes `public/` (`pages.yml`).

## Where things live

- **Colours:** only `public/theme.css` (tokens, light/dark); the pages link the file. Contrast limits in `scripts/contrast.mjs`.
- **Texts:** only `public/i18n.js`; the help page and the privacy page are bilingual and carry their own texts.
- **Tests:** `test/*.test.js`, `npm test` (`node --test`, no dependencies), one file per module (store, rules, VG, i18n, flows, outbox/cache, overload, cleanup, theme, a11y, Safari 15 scan, site build, name check). Not tested automatically: the UI in `app.js` and the service worker; the real Firebase adapter together with the rules runs in `npm run test:emulator` (see [security.md](security.md)); the network calls in `vg.js` were checked once by hand against the real VG server on 2026-11-01 (all read endpoints 200 with CORS `*`, `loadVg()` cold in about 0.3 s, afterwards only checksums; an unknown `shareId` returns the text `0`, decryption then fails); layout is checked by `npm run test:screens` (needs Chrome).
- **Scripts:** `scripts/` (cleanup, icons, help screenshots, layout check, name matching, site build).
