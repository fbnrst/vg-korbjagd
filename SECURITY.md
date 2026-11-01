# Security policy

Kober is a hobby project, maintained on a best-effort basis. There are no deadlines and no bug bounty.

## What the app protects, and what it does not

- There are no accounts. The **list code** (6 characters) of a shared list is the only access control, by design.
  Whoever knows the code can read, change and delete that list. Keep the code (and the share link or QR code) private.
- The app stores no personal data beyond the name and emoji a player chooses, and the list content itself.
  See the privacy notice at `public/privacy.html`.
- The database rules limit what can be written (types, sizes, no markup in user keys), see [docs/security.md](docs/security.md).

## Reporting a vulnerability

Please use GitHub's private reporting: **Security → Report a vulnerability** on this repository.
Do not open a public issue for a vulnerability.

## Out of scope

- Access by anyone who knows a list code (see above).
- Exhausting the free Firebase quota (for example by creating many lists).
- The Firebase web configuration in `public/firebase-config.js` being public. That is by design.

## Supported versions

The latest release (the site root) and the current development version (`/dev/`).

More detail: [docs/security.md](docs/security.md) (German).
