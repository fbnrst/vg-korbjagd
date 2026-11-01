# Retention and deleting lists

## What happens when

- **Delete it yourself:** in the app under *Share → Delete this list for everyone*. This removes the shared list permanently for all members (`store.deleteList`). Anyone who still has the list open lands on their local list again automatically.
- **Automatically after 30 days:** when a shared list is opened or changed, the app writes a timestamp `lists/<CODE>/activity` (at most once per hour; the server fills in its own time, so a wrong clock on a phone does not matter). The workflow `.github/workflows/cleanup.yml` runs every week and deletes lists whose last activity (or creation, if there is no stamp) is older than 30 days. It runs once for the production database and once for the dev database (dev only when its secret is set, see below). The comparison lives in `scripts/cleanup-lists.mjs` and is tested (`test/cleanup.test.js`).
- **Garbage:** the job also deletes lists whose `activity` or `meta.created` lies more than 24 h in the future (written under older rules that did not bound `created`) and lists with neither stamp (the current rules require `meta.created`, so no client can create them). Both are logged as such; a dry run only lists them.
- Local lists exist only on the phone and are never deleted by the server.

## Setup (one-off, only the maintainer can do this)

The cleanup job needs admin access to the database, because the rules deliberately do not allow listing or deleting other people's lists.

1. Firebase console → project `vg-korbjagd` → ⚙ *Project settings* → *Service accounts* → **Generate new private key**. Never check the JSON file in.
   - More economical than the default service account: in the Google Cloud console (*IAM & Admin → Service Accounts*) create a dedicated service account with only the role *Firebase Realtime Database Admin* and use its key.
2. GitHub → repository → *Settings → Secrets and variables → Actions → New repository secret*: name `FIREBASE_SERVICE_ACCOUNT`, value is the **complete content** of the JSON file. Then delete the file.
3. Publish the new rules: publish `database.rules.json` under *Realtime Database → Rules* (*Publish*); they now include `activity` and deleting whole lists. Check in the *Rules Playground* first, procedure in [security.md](security.md#publishing-the-rules).
4. Test run: GitHub → *Actions → Cleanup old lists → Run workflow* with **dry run** (the default): the log shows which lists would be deleted without deleting anything. After that the job runs weekly on its own.

As long as the secret is missing, the production job **fails on purpose** (red badge, email from GitHub), because the privacy notice promises an automatic deletion.

### Dev database (optional, recommended)

The dev site (`/dev/`) uses its own Firebase project `vg-korbjagd-dev` (`public/firebase-config.dev.js`). The same workflow cleans it with a separate key; without it the dev job only prints a notice and is skipped (green, not failed).

1. Firebase console → project `vg-korbjagd-dev` → ⚙ *Project settings* → *Service accounts* → **Generate new private key** (or, as above, a dedicated service account in the Google Cloud console under *IAM & Admin → Service Accounts* of the **dev** project with only the role *Firebase Realtime Database Admin*). Never use the production key for dev.
2. GitHub → repository → *Settings → Secrets and variables → Actions → New repository secret*: name `FIREBASE_SERVICE_ACCOUNT_DEV`, value is the complete content of the dev JSON file. Then delete the file.
3. Test run with **dry run** as above; the log of the job *cleanup (dev)* shows what would be deleted.

The database URLs of both projects are written in `cleanup.yml` (`database_url` in the matrix); they are public like the web configuration.

## Notes

- The script requires a limit of at least 14 days (`MAX_AGE_DAYS`). It handles 6-character (old) and 8-character (new) list codes alike.
- Robustness: every read and delete is tried twice; a list that still fails is skipped and the run goes on. The failed codes are listed at the end and the job then fails (red), so the next run (or a manual one) catches up. Right before deleting, the script reads the list's stamps again and keeps it if it was opened meanwhile.
- The limit is recorded in `cleanup.yml` (`MAX_AGE_DAYS`) and in the privacy notice (`public/privacy.html`, "30 days"); change both together.
- Anyone who knows a list code can delete the list (just as they could empty it). The app asks first.
- The service account key bypasses the rules; security notes on this are in [security.md](security.md#secrets-and-supply-chain).
