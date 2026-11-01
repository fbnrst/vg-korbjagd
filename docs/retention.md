# Retention and deleting lists

## What happens when

- **Delete it yourself:** in the app under *Share → Delete this list for everyone*. This removes the shared list permanently for all members (`store.deleteList`). Anyone who still has the list open lands on their local list again automatically.
- **Automatically after 30 days:** when a shared list is opened or changed, the app writes a timestamp `lists/<CODE>/activity` (at most once per hour). The workflow `.github/workflows/cleanup.yml` runs every week and deletes lists whose last activity (or creation, if there is no stamp) is older than 30 days. The comparison lives in `scripts/cleanup-lists.mjs` and is tested (`test/cleanup.test.js`).
- Local lists exist only on the phone and are never deleted by the server.

## Setup (one-off, only the maintainer can do this)

The cleanup job needs admin access to the database, because the rules deliberately do not allow listing or deleting other people's lists.

1. Firebase console → project `vg-korbjagd` → ⚙ *Project settings* → *Service accounts* → **Generate new private key**. Never check the JSON file in.
   - More economical than the default service account: in the Google Cloud console (*IAM & Admin → Service Accounts*) create a dedicated service account with only the role *Firebase Realtime Database Admin* and use its key.
2. GitHub → repository → *Settings → Secrets and variables → Actions → New repository secret*: name `FIREBASE_SERVICE_ACCOUNT`, value is the **complete content** of the JSON file. Then delete the file.
3. Publish the new rules: publish `database.rules.json` under *Realtime Database → Rules* (*Publish*); they now include `activity` and deleting whole lists. Check in the *Rules Playground* first, procedure in [security.md](security.md#publishing-the-rules).
4. Test run: GitHub → *Actions → Cleanup old lists → Run workflow* with **dry run** (the default): the log shows which lists would be deleted without deleting anything. After that the job runs weekly on its own.

As long as the secret is missing, the workflow **fails on purpose** (red badge, email from GitHub), because the privacy notice promises an automatic deletion.

## Notes

- The script never deletes lists without a timestamp (unknown age) and requires a limit of at least 14 days (`MAX_AGE_DAYS`).
- The limit is recorded in `cleanup.yml` (`MAX_AGE_DAYS`) and in the privacy notice (`public/privacy.html`, "30 days"); change both together.
- Anyone who knows a list code can delete the list (just as they could empty it). The app asks first.
- The service account key bypasses the rules; security notes on this are in [security.md](security.md#secrets-and-supply-chain).
