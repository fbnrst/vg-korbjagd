# Security

This document describes the threat model, the trust boundaries and the operation of Kober's security measures. It is meant for the maintainer and for agents who change the rules, `store.js` or the rendering. Reports from outside go through [SECURITY.md](../SECURITY.md); the rules themselves are in `database.rules.json`, this document only says what they are for.

## Threat model

- There is no login. The **list code** is the only secret (a capability). New lists get 8 characters drawn from 32 characters (32^8 = 2^40 ≈ 1.1·10^12, about 40 bits); lists created before November 2026 have 6 characters (32^6 = 2^30 ≈ 10^9) and stay valid. The rules accept `^[A-Z0-9]{6,8}$`. Whoever knows the code reads, changes and deletes the list. This is intended (shopping list within a family or flat share).
- The root is locked, lists cannot be enumerated. A code can only be guessed by probing individual paths. The rules have **no rate limit**.
- The Firebase web configuration (`public/firebase-config.js`) is public and not a secret. Whoever knows it can create new lists and so burden storage and quota of the free plan. The weekly cleanup job (30 days without activity, [retention.md](retention.md)) limits storage but does not prevent the flood.
- The number of items, users and deposit entries per list cannot be limited in the rules (they cannot count children); whoever knows the code can fill a list. **Accepted residual risk.** Mitigation on the client: live snapshots and the cache go through `sanitize` in `cache.js`, which keeps at most `MAX_ITEMS` (1000) items, so a flooded list does not freeze the phones of the other members. Remedy for the members: create a new list.
- Each value is bounded, and so is each container: `items`, `scores`, `deposit` and `deposit/<type>` must be objects (`newData.hasChildren()`). Without that a single primitive (for example `items = "<10 MB string>"`) skipped the per-child checks, which only live on the wildcard children.
- Timestamps that decide the cleanup are bounded: `activity` and `meta.created` at most now + 24 h. An unbounded `created` (for example `9e15`) made a list immune to the 30-day cleanup; the cleanup script also treats a stamp later than now + 24 h as garbage and deletes such a list (lists written under the old rules).

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
| `lists/$code` | code `^[A-Z0-9]{6,8}$` (old lists 6, new lists 8 characters), `meta` required, writes at list level only as deletion |
| `meta` | only `created` (number, at most now + 24 h), writable once |
| `activity` | number, at most now + 24 h |
| `items`, `scores`, `deposit`, `deposit/$typ` | objects only (no primitive in place of the container); `$typ` matches `^[A-Za-z0-9_-]{1,20}$` |
| `items/$id` | fixed fields, lengths and number ranges, ID ≤ 40 characters, no extra fields |
| `scores`, `deposit` | integers (0 and 1 to 100000 respectively) |
| User key | `"<emoji> <name>"`, ≤ 60 characters, none of the characters < > & " ' and backtick |

**Claims:** `items/<id>/claimedBy` ("I'll get this") is an optional user key, validated like `checkedBy`. It is a plain label without authority: anybody who knows the code may set or replace it (last tap wins), so it carries no security meaning. It is rendered through `esc()` like every user key and sanitised in `cache.js`. **Publish the updated rules (both projects, dev first) before this client reaches a site:** under the old rules the unknown field `claimedBy` is rejected by `$other` and the whole item write fails.

**Manual order:** `items/<id>/pos` is an optional number (-1e9 … 1e13), the position of an open item (see `public/order.js`). It is a plain sort key without authority; anybody who knows the code may change it, it is sanitised in `cache.js` and the outbox. **Publish the updated rules (both projects, dev first) before this client reaches a site:** under the old rules the unknown field `pos` is rejected by `$other` and the item write (also an ordinary move) fails.

Deleting (`null`) is not validated; an empty object counts as a deletion in the Realtime Database, so emptying `items`, `scores` or `deposit` stays allowed (clear the list, last item, new round). The rules only check new writes, not data that is already stored. `store.js` validates the mirror image (`isUserKey`, `userKey()`, `isId`) so that legitimate clients never write data that would be rejected; both must be changed together.

## Trust boundaries

- **Not trustworthy:** everything from the database, from `localStorage` (the user can write to it, including the outbox `NS + 'kober-outbox'` and the cache `NS + 'kober-cache:<code>'`; both are validated on load) and product data from VG and Open Food Facts.
- **Escaping is mandatory:** each of these values goes into HTML through `esc()`. User keys are created through `userKey()`. The rules are the second layer, the escaping is the actual protection (the rules do not act on old data).
- **Invariant:** `esc()` (`public/app.js`) escapes `& < > "`, **not** `'`. Attributes must therefore always be in double quotes. An automatic test for this was not added because it cannot be written reliably (template strings, nested calls); check it in review when the rendering changes.

## Third parties, data flow and browser

- Connections go to the Firebase database (`store.js`), to the VG endpoints (`vg.js`) and to Open Food Facts (`app.js`, only when scanning unknown codes). zxing (scanner on iPhones) has lived in `public/vendor/` since November 2026, and the Firebase SDK (`public/vendor/firebase/`) too: all code is served from our own origin, there is no CDN any more (`test/firebase-version.test.js` fails if `gstatic.com` reappears outside `vendor/`). Everything is listed in `public/privacy.html`.
- **Content Security Policy** as a `<meta>` in all three pages (GitHub Pages sets no headers): scripts only from the own site and `*.firebasedatabase.app` (the database's long-polling fallback, hence also `frame-src`), no inline scripts (the help and privacy pages use `docs/help.js` and `privacy.js` for that), `connect-src` only Firebase, VG and Open Food Facts. It is the second layer behind `esc()`. `test/csp.test.js` checks the policy against the hosts in the code; whoever talks to a new host must add it in `public/index.html`. `frame-ancestors` does not work through `<meta>`. Accepted residual risk: `*.firebasedatabase.app` in `script-src` is a host anyone can create a project under, so it would let an attacker's long-poll script run if an HTML injection ever got past `esc()` (inline scripts injected through `innerHTML` do not run anyway). It cannot be narrowed to the two database hosts: the database hands the client over to internal shard hosts of the same domain (`s-<shard>.europe-west1.firebasedatabase.app`) for the WebSocket and the long-poll fallback, and a CSP with only the named hosts would cut the connection.
- The list code sits in the link `?list=CODE`. All three pages set `<meta name="referrer" content="no-referrer">` (`test/referrer.test.js`) so that it is not sent along in requests to third parties.
- Release and `/dev/` share one origin. The prefix `NS` separates `localStorage` and service worker caches; every new key must use it. Dev has its own Firebase project (`public/firebase-config.dev.js`).
- `?sim=` (simulated server) only works in demo mode or on the dev site, never on the release with a real database.

## Secrets and supply chain

- The service account in `FIREBASE_SERVICE_ACCOUNT` bypasses the rules and can read and delete everything. It exists only as a GitHub secret, should have only the role *Firebase Realtime Database Admin* ([retention.md](retention.md)) and is revoked in the Cloud console if compromise is suspected. The dev database has its own service account in `FIREBASE_SERVICE_ACCOUNT_DEV` (a key of the project `vg-korbjagd-dev`, never the production key); the dev cleanup is skipped while that secret is not set.
- Dependabot proposes new versions of the GitHub Actions weekly. prek hooks run locally and in CI; gitleaks deliberately scans only staged changes, so in CI it finds nothing.
- All actions are pinned to commit hashes (version tag as a comment, Dependabot updates both). In `cleanup.yml` only the two steps that need it get the secret (`FIREBASE_SERVICE_ACCOUNT` or `FIREBASE_SERVICE_ACCOUNT_DEV`), not the third-party actions; `checkout` runs there without a stored token.
- List codes come from `crypto.getRandomValues` (`store.js`), not from `Math.random`. 8 bytes map onto 32 characters with `b % 32`, which is unbiased because 256 is a multiple of 32.
- `public/vendor/` (qrcode, zxing, Firebase SDK) is excluded from the checks. zxing is byte-identical to `umd/index.min.js` from the npm package `@zxing/library@0.21.3`; an update replaces the file from the npm package and compares the hash. The Firebase SDK (10.14.1) is `firebase-app.js` and `firebase-database.js` as served under `https://www.gstatic.com/firebasejs/10.14.1/`, with one change: the import of `firebase-app.js` in `firebase-database.js` points to `./firebase-app.js` (`LICENSE.txt` there names source and version). `firebase-app.js` still contains its gstatic URL as a plain string (component and logger name), nothing loads it. Updating the SDK means re-vendoring: download both files of the new version, inspect them, rewrite that import, update `LICENSE.txt`, the comment in `store.js` and `firebase` in `package.json` (`test/firebase-version.test.js` checks that they agree).

## Publishing the rules

**Automatically (GitHub Actions, `.github/workflows/rules.yml`, `scripts/publish-rules.mjs`):** a push to `main` that changes `database.rules.json` publishes the rules to the **dev** database (the dev site follows `main`). **Production is published when a release is published** (`gh release create vX.Y.Z`; the rules of that tag go to dev, then production) **or on purpose:** *Actions → Publish database rules → Run workflow*, target `production` (or `both`: dev first, then production; production only runs when dev succeeded or was not part of the run). Wait for the release run to be green before `gh workflow run pages.yml`, so the rules are live before the new client reaches the release site. *dry run* checks the file and the access and publishes nothing. The script PUTs the file to `/.settings/rules.json` and reads the rules back to compare. Before any publish, `test/rules.test.js` runs. The workflow uses the same secrets as the cleanup (`FIREBASE_SERVICE_ACCOUNT_DEV`, `FIREBASE_SERVICE_ACCOUNT`); the dev job only warns and skips while its secret is missing, the production job fails without its secret.

**One-off setup:** the service account must be allowed to change the rules. The role *Firebase Realtime Database Admin* should be enough (it includes `firebasedatabase.instances.update`); if the first run answers `PERMISSION_DENIED`/403 on the PUT, add the role *Firebase Admin* (or a custom role with that permission) to the account of that project. Note that this makes the key more powerful than the cleanup needs: it can now replace the rules, i.e. open the database. It exists only as a GitHub secret; the workflow gives it to the one publish step only, never to third-party actions, and a push to `main` only reaches dev, and production only changes on a published release or a manual run. If you prefer not to grant that, keep publishing by hand (below) and leave the secrets as they are: the workflow's dev job then fails with the permission message, which is harmless.

By hand (also the fallback), **dev first, then production** (projects `vg-korbjagd-dev` and `vg-korbjagd`; the ids keep the old name Korbjagd).

**Order for the 8-character codes:** the rules that accept `^[A-Z0-9]{6,8}$` must be published in **both** projects (dev first, then production) **before** a client that creates 8-character codes reaches that site. Under the old rules (`{6}`) creating a list with an 8-character code is rejected, so sharing would fail for everyone on the new client. The dev site follows `main`, so publish to dev before the client change is pushed (or right after, accepting a short gap on dev), and to production before the release is tagged.

Before that: `npm run test:emulator` (`scripts/emulator-check.mjs`; Java 21+, `npx` fetches `firebase-tools`) loads `database.rules.json` into the Firebase emulator and runs the real `store.js` with the real adapter against it. The normal flow must go through; manipulated writes (overwriting a whole list, XSS key, wrong types, too long title, unknown field, a primitive on `items`/`scores`/`deposit`/`deposit/<type>`, a bad deposit type, `created` in the far future, codes of 5 or 9 characters) must give `PERMISSION_DENIED`; codes of 6 to 8 characters, emptying `items`/`scores`/`deposit` and deleting a list must be allowed. In addition there are concurrent accesses by two phones (the same item checked off at the same time: exactly one point; 20 deposit pieces at the same time: counter and points are right; too many concurrent withdrawals: points match the remaining pieces, never below zero), which the local adapter of the other tests cannot show. This complements `test/rules.test.js`, whose own evaluator is not a real rules interpreter. The test is not part of `npm test` (emulator download) but runs in GitHub Actions (`.github/workflows/emulator.yml`) whenever the rules, `store.js` or the test change. The emulator applies the rules only to the namespace `<project>-default-rtdb`.

1. Firebase console → project → **Realtime Database** → tab **Rules**.
2. Paste the content of `database.rules.json`.
3. Check in the **Rules Playground**: write to `lists/ABC234/items/a1`, `meta`, `activity` (allowed), write `lists/ABCD2345/meta` with `{"created": 1}` (allowed: 8-character code), write `lists/ABC234/items` with the string `"x"` (rejected), delete `lists/ABC234` (allowed), overwrite `lists/ABC234` with data (rejected).
4. **Publish**, then create a list in the app, join it, create/check off/delete items.

## Open points

- **Plan:** the production project runs on the free **Spark** plan (confirmed by the maintainer). No costs can arise from that; when the quota is exceeded (among others about 100 concurrent connections) the service is throttled or stopped. **Budget alerts** exist only on the Blaze plan and are not needed here. The app copes with this (connection banner, outbox, cache, see [architecture.md](architecture.md)).
- **App Check:** status unknown (Firebase console: *Build → App Check*, tabs *Apps* and *APIs*). Not recommended and not planned for a family shopping list: it needs reCAPTCHA and could lock the app out if set up wrongly; the list code remains the access protection.
- No rate limit and no limit on the number of nodes in the rules (see above; accepted, mitigated on the client by `MAX_ITEMS`).
