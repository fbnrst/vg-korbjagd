# vg-korbjagd – a shared shopping list with a leaderboard

[![Checks](https://github.com/fbnrst/vg-korbjagd/actions/workflows/autofix.yml/badge.svg)](https://github.com/fbnrst/vg-korbjagd/actions/workflows/autofix.yml)
[![Deploy](https://github.com/fbnrst/vg-korbjagd/actions/workflows/pages.yml/badge.svg)](https://github.com/fbnrst/vg-korbjagd/actions/workflows/pages.yml)

**App: <https://fbnrst.github.io/vg-korbjagd/>** · [Help](https://fbnrst.github.io/vg-korbjagd/docs/) · [Privacy](https://fbnrst.github.io/vg-korbjagd/privacy.html) · [Dev version](https://fbnrst.github.io/vg-korbjagd/dev/) (current `main`, see [Releases and the dev site](#releases-and-the-dev-site))

An independent, unofficial shopping list app. The list lives on your phone first; once you share it, phones sync live and a leaderboard ("who puts the most in the basket") starts. Idea and product data: the [VG app](https://gitlab.com/pyfox/vg-app) of VG Dresden. This project is not affiliated with VG Dresden.

No server of your own needed: a static site (GitHub Pages) plus a Firebase Realtime Database (free tier).

## Features
- The list lives on the phone first (no account, no name, works offline). Only when you share it does it go through the server, with live sync, joining by QR code, link or 6-character code, and the game starts. Name and emoji are asked for only then
- UI in the system language (German or English)
- Header with the fox logo, a share button and a "…" menu: reset list, import list (from the VG app), join list (local list), leave list (shared lists only), help and privacy
- Add items by text (name suggestions), VG number (from three digits a tappable list of products from the VG master data) or barcode scanner (Open Food Facts)
- Import of lists from the original VG app (share link, in the menu)
- Checking off puts an item in the basket; on shared lists everyone sees who did it
- Reset: remove only the checked-off items or all items, optionally clear the empties too; points stay as they are. On a shared list the reset applies to everyone
- Tabs: Empties (count deposit pieces), Checkout (only items with a VG number, bakery items separate, plus empties; the screen stays on) and, on shared lists only, Ranking (points for checking off and per empties piece)
- Shared lists can be deleted for everyone and expire after 30 days without activity ([retention](docs/retention.md))
- Installable as a PWA; demo mode without Firebase

Documentation: [help page in the app](https://fbnrst.github.io/vg-korbjagd/docs/) · [privacy notice](public/privacy.html) · [guide for parents and kids](docs/anleitung.md) (German) · [architecture](docs/architecture.md) (German) · [retention and deletion](docs/retention.md) (German) · [security](docs/security.md) (German) · [VG endpoints](docs/vg-api.md) (German)

## Try it locally (demo mode)
    npm start      # http://localhost:3000
    npm test       # store, rules, vg, i18n, cleanup tests

Without a Firebase configuration the app runs in demo mode: shared lists live in the browser only, and tabs in the same browser sync with each other. Testing with several phones needs Firebase.

## Setup with Firebase (once, free)
1. Create a project in the [Firebase console](https://console.firebase.google.com) and create a **Realtime Database** there (region Europe).
2. Under *Realtime Database → Rules* paste the contents of `database.rules.json` and publish. Lists are reachable only through their 6-character code and cannot be listed; anyone who knows the code can read, change and delete the list.
3. Under *Project settings → General → Add web app* copy the configuration into `public/firebase-config.js` (public identifiers, no secrets).
4. Optional, but needed for the promised deletion after 30 days: set up the cleanup job (secret `FIREBASE_SERVICE_ACCOUNT`, see [docs/retention.md](docs/retention.md)).
5. On GitHub set *Settings → Pages → Source: GitHub Actions*. Every push to `main` tests and publishes `public/` (`.github/workflows/pages.yml`).

Technical details, data model and offline behaviour: [docs/architecture.md](docs/architecture.md). The VG data is loaded directly from the VG server, endpoints in [docs/vg-api.md](docs/vg-api.md).

## Releases and the dev site

The site has two versions: the root shows the latest release (the newest git tag `v*`), `/dev/` shows the current `main`. Everyday work goes to `main` and only changes `/dev/`; a release is a tag (for example `gh release create v1.2.0`) followed by `gh workflow run pages.yml --ref main`. `/dev/` is its own app (blue header, own icon, own storage) with a second Firebase project (`public/firebase-config.dev.js`), so trying things never touches real lists.

## Development

Conventions for humans and agents are in [AGENTS.md](AGENTS.md): source code and comments are English, the UI follows the system language.

Code checks run locally as a git hook through [prek](https://github.com/j178/prek) (configuration: `.pre-commit-config.yaml`): file hygiene, JSON/YAML, JavaScript syntax, tests and gitleaks (secrets; the public Firebase configuration is allowed in `.gitleaks.toml`). Run `prek install` once, `prek run --all-files` manually. The screenshots of the help page are built locally from the real app (`npm install`, then `npm run docs:screenshots`; needs Chrome, sample data instead of real VG data) and only on explicit request. Every image is looked at before it is committed. The same checks run in GitHub Actions (`.github/workflows/autofix.yml`) as a single prek job through [autofix.ci](https://autofix.ci): gitleaks is part of prek, there is no separate secrets job, and what the fixing hooks can repair (whitespace, end of files) is committed back automatically.

## License

BSD 3-Clause, see [LICENSE](LICENSE.md). The VG data (see `docs/vg-api.md`) belongs to VG Dresden and is not part of this license.

Bundled third-party software (MIT, notices in the file headers): `public/vendor/qrcode.js` (qrcode-generator 1.4.4), `public/vendor/crypto-js.js` (CryptoJS 4.2.0).
