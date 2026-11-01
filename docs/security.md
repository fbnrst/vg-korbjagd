# Security

This document describes the threat model, the trust boundaries and the operation of Kober's security measures. It is meant for the maintainer and for agents who change the rules, `store.js` or the rendering. Reports from outside go through [SECURITY.md](../SECURITY.md); the rules themselves are in `database.rules.json`, this document only says what they are for.

## Threat model

- There is no login. The **list code** is the only secret (a capability): 6 characters, drawn from 32 characters on creation (32^6 ≈ 10^9), and `[A-Z0-9]` is accepted (36^6 ≈ 2·10^9). Whoever knows it reads, changes and deletes the list. This is intended (shopping list within a family or flat share).
- The root is locked, lists cannot be enumerated. A code can only be guessed by probing individual paths. The rules have **no rate limit**.
- The Firebase web configuration (`public/firebase-config.js`) is public and not a secret. Whoever knows it can create new lists and so burden storage and quota of the free plan. The weekly cleanup job (30 days without activity, [retention.md](retention.md)) limits storage but does not prevent the flood.
- The number of items, users and deposit entries per list cannot be limited in the rules; whoever knows the code can fill a list. Remedy: create a new list.

| Action | With list code | With configuration only |
|---|---|---|
| Read list | yes | no |
| Change items, scores, deposits (within the limits) | yes | no |
| Delete list for everyone | yes, intended | no |
| Overwrite `meta`, restructure the list | no | no |
| Write data outside the limits (markup, huge values, foreign fields) | no | no |
| Create new lists | - | yes |

## Guarantees of the rules

The source of truth is `database.rules.json` and `test/rules.test.js` (a small evaluator of its own, not a real Firebase interpreter). In short:

| Node | Limit |
|---|---|
| `lists/$code` | code `^[A-Z0-9]{6}$`, `meta` required, writes at list level only as deletion |
| `meta` | only `created`, writable once |
| `activity` | number, at most now + 24 h |
| `items/$id` | fixed fields, lengths and number ranges, ID ≤ 40 characters, no extra fields |
| `scores`, `deposit` | integers (0 and 1 to 100000 respectively) |
| User key | `"<emoji> <name>"`, ≤ 60 characters, none of the characters < > & " ' and backtick |

Deleting (`null`) is not validated. The rules only check new writes, not data that is already stored. `store.js` validates the mirror image (`isUserKey`, `userKey()`, `isId`) so that legitimate clients never write data that would be rejected; both must be changed together.

## Trust boundaries

- **Not trustworthy:** everything from the database, from `localStorage` (the user can write to it, including the outbox `NS + 'kober-outbox'` and the cache `NS + 'kober-cache:<code>'`; both are validated on load) and product data from VG and Open Food Facts.
- **Escaping is mandatory:** each of these values goes into HTML through `esc()`. User keys are created through `userKey()`. The rules are the second layer, the escaping is the actual protection (the rules do not act on old data).
- **Invariant:** `esc()` (`public/app.js`) escapes `& < > "`, **not** `'`. Attributes must therefore always be in double quotes. An automatic test for this was not added because it cannot be written reliably (template strings, nested calls); check it in review when the rendering changes.

## Third parties, data flow and browser

- Connections go to Firebase (SDK from gstatic.com, `store.js`), to the VG endpoints (`vg.js`) and to Open Food Facts (`app.js`, only when scanning unknown codes). zxing (scanner on iPhones) has lived in `public/vendor/` since November 2026, there is no CDN any more. Everything is listed in `public/privacy.html`.
- **Content Security Policy** as a `<meta>` in all three pages (GitHub Pages sets no headers): scripts only from the own site, `gstatic.com` (Firebase SDK) and `*.firebasedatabase.app` (the database's long-polling fallback, hence also `frame-src`), no inline scripts (the help and privacy pages use `docs/help.js` and `privacy.js` for that), `connect-src` only Firebase, VG and Open Food Facts. It is the second layer behind `esc()`. `test/csp.test.js` checks the policy against the hosts in the code; whoever talks to a new host must add it in `public/index.html`. `frame-ancestors` does not work through `<meta>`.
- The list code sits in the link `?list=CODE`. All three pages set `<meta name="referrer" content="no-referrer">` (`test/referrer.test.js`) so that it is not sent along in requests to third parties.
- Release and `/dev/` share one origin. The prefix `NS` separates `localStorage` and service worker caches; every new key must use it. Dev has its own Firebase project (`public/firebase-config.dev.js`).
- `?sim=` (simulated server) only works in demo mode or on the dev site, never on the release with a real database.

## Secrets and supply chain

- The service account in `FIREBASE_SERVICE_ACCOUNT` bypasses the rules and can read and delete everything. It exists only as a GitHub secret, should have only the role *Firebase Realtime Database Admin* ([retention.md](retention.md)) and is revoked in the Cloud console if compromise is suspected. The cleanup job runs only for the production project, not for dev.
- Dependabot proposes new versions of the GitHub Actions weekly. prek hooks run locally and in CI; gitleaks deliberately scans only staged changes, so in CI it finds nothing.
- All actions are pinned to commit hashes (version tag as a comment, Dependabot updates both). In `cleanup.yml` only the two steps that need it get the secret `FIREBASE_SERVICE_ACCOUNT`, not the third-party actions; `checkout` runs there without a stored token.
- List codes come from `crypto.getRandomValues` (`store.js`), not from `Math.random`.
- `public/vendor/` (crypto-js, qrcode, zxing) is excluded from the checks. zxing is byte-identical to `umd/index.min.js` from the npm package `@zxing/library@0.21.3`; an update replaces the file from the npm package and compares the hash.

## Publishing the rules

The rules are published by hand, **dev first, then production** (projects `vg-korbjagd-dev` and `vg-korbjagd`; the ids keep the old name Korbjagd).

Before that: `npm run test:emulator` (`scripts/emulator-check.mjs`; Java 21+, `npx` fetches `firebase-tools`) loads `database.rules.json` into the Firebase emulator and runs the real `store.js` with the real adapter against it. The normal flow must go through; manipulated writes (overwriting a whole list, XSS key, wrong types, too long title, unknown field) must give `PERMISSION_DENIED`; deleting a list must be allowed. In addition there are concurrent accesses by two phones (the same item checked off at the same time: exactly one point; 20 deposit pieces at the same time: counter and points are right; too many concurrent withdrawals: points match the remaining pieces, never below zero), which the local adapter of the other tests cannot show. This complements `test/rules.test.js`, whose own evaluator is not a real rules interpreter. The test is not part of `npm test` (emulator download) but runs in GitHub Actions (`.github/workflows/emulator.yml`) whenever the rules, `store.js` or the test change. The emulator applies the rules only to the namespace `<project>-default-rtdb`.

1. Firebase console → project → **Realtime Database** → tab **Rules**.
2. Paste the content of `database.rules.json`.
3. Check in the **Rules Playground**: write to `lists/ABC234/items/a1`, `meta`, `activity` (allowed), delete `lists/ABC234` (allowed), overwrite `lists/ABC234` with data (rejected).
4. **Publish**, then create a list in the app, join it, create/check off/delete items.

## Open points

- **Plan:** the production project runs on the free **Spark** plan (confirmed by the maintainer). No costs can arise from that; when the quota is exceeded (among others about 100 concurrent connections) the service is throttled or stopped. **Budget alerts** exist only on the Blaze plan and are not needed here. The app copes with this (connection banner, outbox, cache, see [architecture.md](architecture.md)).
- **App Check:** status unknown (Firebase console: *Build → App Check*, tabs *Apps* and *APIs*). Not recommended and not planned for a family shopping list: it needs reCAPTCHA and could lock the app out if set up wrongly; the list code remains the access protection.
- No rate limit and no limit on the number of nodes in the rules (see above).
