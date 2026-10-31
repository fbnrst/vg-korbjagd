# AGENTS.md

Guidance for AI agents and humans working on **vg-korbjagd**: a shared shopping list PWA with a game (leaderboard), independent of VG Dresden but using its public product data.

## Language rules

- **Source code is English**: identifiers, comments, test names, error/log messages, config comments, workflow step names.
- **The web app UI is localised**: it follows the system language, German or English (English is the fallback). All user-visible text lives in `public/i18n.js` (`STRINGS.en` and `STRINGS.de`, keys must exist in both). Do not hard-code UI text in `app.js`; static texts in `index.html` have English defaults that `applyStatic()` replaces. Use `t('key', { param })`. Never name a loop variable `t` in `app.js` (it shadows the translation function). `?lang=de|en` overrides the language for testing.
- Documentation: `README.md` and `docs/*.md` are currently German and stay German unless asked otherwise. The end-user help page (`public/docs/index.html`) and the privacy notice (`public/privacy.html`) are bilingual and follow the same language detection.
- Data coming from the VG servers (product and deposit names) stays German.

## Layout

- `public/` is the whole app (static, ES modules, no build). Served by GitHub Pages.
  - `app.js` UI and flows, `store.js` data layer, `vg.js` VG data/import, `i18n.js` texts, `sw.js` service worker, `legal-config.js` contact for the privacy page.
  - `privacy.html`, `docs/index.html` (help page for end users), `vendor/` (third-party, MIT, excluded from checks).
- `scripts/` maintenance scripts: `cleanup-lists.mjs` (cleanup of old lists), `make-icons.swift` (renders `public/icons/*.png`, macOS only; bump `VERSION` in `public/sw.js` afterwards). `database.rules.json` Firebase Realtime Database rules (**published by hand in the Firebase console**, see `docs/security.md`).
- `test/` Node tests (`node --test`, no dependencies). `docs/` developer docs.

## Behaviour that must stay true

- **Local first**: the list lives in `localStorage` under the list code `LOCAL` (no name, no server, works offline). The leaderboard/game only exists for shared lists. Sharing uploads the local list (`store.importList`, no points are awarded for existing items) and removes the local copy; the header buttons are reset (circular arrow: a dialog to remove checked-off items or all items, optionally empties; on a shared list also "Leave this list"; it also holds the VG app import), "?" (menu with help and privacy) and share. There is no title in the header: it shows the basket counter instead.
- Shared lists can be deleted by any member ("Delete this list for everyone", `store.deleteList`; the rules allow writes at list level only for deleting) and expire after 30 days without activity: `store.js` stamps `activity` (at most hourly; opening or changing counts) and `.github/workflows/cleanup.yml` runs `scripts/cleanup-lists.mjs` weekly (needs the secret `FIREBASE_SERVICE_ACCOUNT`, see `docs/retention.md`). A client that sees its shared list disappear falls back to the local list.
- Checkout shows only items with a VG number. Typing three or more digits (numbers) or two or more letters (names) shows a tappable list of matching products (tap = add). Names are de-duplicated; the VG number is only kept when the name is unambiguous. Placeholder products ("unbesetzt …", "RESERVIERT …", about a fifth of the VG list) are filtered out in `vg.js`.
- Points: +1 for checking off an item (or entering its VG number in the "No." field) and +1 per empties piece; un-checking or deleting takes the point back from the person who got it; equal points share the same place.
- Colours are the VG Dresden palette taken from vg-dresden.de (soft green #8bad73, green #669c03, light greens #e8edde/#d4dac8, orange #f7a642). They live as CSS variables at the top of `public/index.html`, `privacy.html` and `docs/index.html`; filled buttons use a darker green and `--on-green` text for contrast. Keep light and dark values in sync.
- Everything read from the database is untrusted: **escape it with `esc()` before it goes into HTML** (titles, user keys, ids, numbers). User keys are `"<emoji> <name>"` and are sanitised by `userKey()` in `store.js`; keep `store.js` validation in line with `database.rules.json`.
- The Firebase web config in `public/firebase-config.js` is public by design (allow-listed in `.gitleaks.toml`). Access control is the rules file plus the list code.
- The VG endpoints are public and send CORS `*` when the browser sends an `Origin` header (plain `curl` hides this); see `docs/vg-api.md`. Do not call the write endpoints (`shareList.php`, `sendFeedback.php`).

## Commands

```bash
npm test                                             # node --test
python3 -m http.server 3100 --directory public       # serve the app (port 3000 may be taken by another session)
prek run --all-files                                 # all checks (installed as git hook via `prek install`)
```

Checks: prek (`.pre-commit-config.yaml`: file hygiene, JSON/YAML, `node --check`, tests, gitleaks) locally, the same in GitHub Actions (`.github/workflows/checks.yml`, plus a full-history gitleaks scan). `pages.yml` tests and deploys `public/`.

## Testing notes

- With an empty `firebase-config.js` (`export default null`) the app runs in a demo mode that stores shared lists in the browser as well.
- Testing against the real Firebase project creates lists that the hardened rules do not let clients delete. Prefer demo mode or the unit tests; clean up leftovers in the Firebase console.
- Browser-pane checks: emulate a 375px viewport; the on-screen keyboard and service workers cannot be tested there.
