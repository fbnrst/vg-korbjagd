# Kober – a shared shopping list with a leaderboard

[![Checks](https://github.com/fbnrst/kober/actions/workflows/autofix.yml/badge.svg)](https://github.com/fbnrst/kober/actions/workflows/autofix.yml)
[![Deploy](https://github.com/fbnrst/kober/actions/workflows/pages.yml/badge.svg)](https://github.com/fbnrst/kober/actions/workflows/pages.yml)

<img src="public/docs/img/readme-phones.png" alt="The list and the ranking tab on a phone" width="340" align="right">

### 👉 [Open Kober on your phone](https://fbnrst.github.io/kober/)
No account, no app store.

[Install](https://fbnrst.github.io/kober/docs/#en-install) · [Help](https://fbnrst.github.io/kober/docs/) · [Privacy](https://fbnrst.github.io/kober/privacy.html)

An independent, unofficial shopping list app. The list lives on your phone first; once you share it, phones sync live and a leaderboard ("who puts the most in the basket") starts. Idea and product data: the [VG app](https://gitlab.com/pyfox/vg-app) of VG Dresden. This project is not affiliated with VG Dresden.

**Features**

- A shared shopping list: everyone with the code (QR code, link or 6 characters) sees changes live and who put what in the basket
- A leaderboard on top: points for checking off items and returning empties, so shopping becomes a little game
- Works without account or server first: the list stays on your phone until you share it

<br clear="right">

## For developers and maintainers
- For maintainers (not deployed): [architecture, build, release and Firebase setup](docs/architecture.md), [retention and deletion](docs/retention.md), [security](docs/security.md), [VG endpoints](docs/vg-api.md)

The app has two versions: the [release](https://fbnrst.github.io/kober/) (latest tag) and [`/dev/`](https://fbnrst.github.io/kober/dev/) (current `main`).

### Development
    npm start      # http://localhost:3000, demo mode without Firebase
    npm test

Conventions for humans and agents (language rules, checks with [prek](https://github.com/j178/prek), screenshots, release flow) are in [AGENTS.md](AGENTS.md).

## License

BSD 3-Clause, see [LICENSE](LICENSE.md). The VG data (see `docs/vg-api.md`) belongs to VG Dresden and is not part of this license.

Bundled third-party software: `public/vendor/qrcode.js` (qrcode-generator 1.4.4, MIT) and `public/vendor/crypto-js.js` (CryptoJS 4.2.0, MIT), notices in the file headers; `public/vendor/zxing.min.js` (@zxing/library 0.21.3, Apache License 2.0, see `public/vendor/zxing-LICENSE.txt`).
