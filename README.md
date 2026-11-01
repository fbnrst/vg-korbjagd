# Kober – a shared shopping list with a leaderboard

[![Checks](https://github.com/fbnrst/kober/actions/workflows/autofix.yml/badge.svg)](https://github.com/fbnrst/kober/actions/workflows/autofix.yml)
[![Deploy](https://github.com/fbnrst/kober/actions/workflows/pages.yml/badge.svg)](https://github.com/fbnrst/kober/actions/workflows/pages.yml)

**[Open the app](https://fbnrst.github.io/kober/)** · **[Help](https://fbnrst.github.io/kober/docs/)**

An independent, unofficial shopping list app. The list lives on your phone first; once you share it, phones sync live and a leaderboard ("who puts the most in the basket") starts. Idea and product data: the [VG app](https://gitlab.com/pyfox/vg-app) of VG Dresden. This project is not affiliated with VG Dresden.

## Features
- Local first: the list lives on the phone (no account, works offline). Sharing it adds live sync (QR code, link or 6-character code) and the leaderboard
- Add items by name, VG number (with suggestions from the VG master data) or barcode scanner; import lists from the VG app
- Checking off puts an item in the basket, with Undo for deletes; tabs for empties, checkout and (shared lists) ranking
- German and English UI, installable PWA, demo mode without Firebase
- Shared lists can be deleted for everyone and expire after 30 days without activity

## Documentation
[Help page](https://fbnrst.github.io/kober/docs/) (end users) · [privacy notice](public/privacy.html) · for maintainers (German, not deployed): [architecture, build, release and Firebase setup](docs/architecture.md) · [retention and deletion](docs/retention.md) · [security](docs/security.md) · [VG endpoints](docs/vg-api.md)

The site has two versions: the root is the latest release, [`/dev/`](https://fbnrst.github.io/kober/dev/) is the current `main`.

## Development
    npm start      # http://localhost:3000, demo mode without Firebase
    npm test

Conventions for humans and agents (language rules, checks with [prek](https://github.com/j178/prek), screenshots, release flow) are in [AGENTS.md](AGENTS.md).

## License

BSD 3-Clause, see [LICENSE](LICENSE.md). The VG data (see `docs/vg-api.md`) belongs to VG Dresden and is not part of this license.

Bundled third-party software (MIT, notices in the file headers): `public/vendor/qrcode.js` (qrcode-generator 1.4.4), `public/vendor/crypto-js.js` (CryptoJS 4.2.0).
