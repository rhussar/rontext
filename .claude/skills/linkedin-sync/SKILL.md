---
name: linkedin-sync
description: >-
  Sync headline and profile changes from LinkedIn into Mesh. Drives your logged-in
  Chrome to scrape profile data from a list of people, writes a JSON batch, then
  imports it via the CLI. Use when the user asks to sync LinkedIn, update profiles
  from LinkedIn, refresh LinkedIn data, or shows a batch of LinkedIn URLs to ingest.
---

# Sync LinkedIn data into Mesh

Scrapes headline, location, and role changes from LinkedIn profiles, then imports them
into the app as `contact_changes` rows — surfacing on the Home feed and person timelines
as "Recent updates". No LinkedIn account risk — this drives **your own logged-in browser**,
not an automated account.

## This now runs automatically (Chrome extension)

Since 2026-08-16 the **Rontext for LinkedIn** extension (`extension/` at the
repo root, see its README) does this continuously: it captures the top card of
every profile the owner browses (passive) and visits up to N due profiles a
day (N = Settings → General → "LinkedIn visits per day", default 15, enforced
by `/api/ext/linkedin/due`). Captures go through the same
`ingestLinkedinProfiles()` merge with `createMissing:false` — it never creates
a contact. Status: Settings → Accounts → LinkedIn ("Chrome extension · last
seen…") and Automation → "LinkedIn visits". Use this skill for a *batch* the
extension wouldn't do on its own (a curated list, connections-list scrapes
with `connectedOn`, or when the extension isn't installed on the machine in
front of you). The extension only reads what's in `main.innerText` — LinkedIn's
CSS classes are hashed, so if the top-card *order* changes, `content.js`'s
`extractProfile()` is what to fix.

All commands run from `web/`. The CLI import step is:

```bash
npx tsx scripts/ingest-linkedin.ts <batch.json> [--select N]
```

## Workflow

1. **Get a list of LinkedIn profile URLs.** They can be from a CSV, a Mesh group, a search result, whatever.
   The script accepts `/in/<slug>` URLs, shortened `linkedin.com/in/<slug>` URLs, or full profile URLs.

2. **Use the Claude Code skill** to drive your Chrome and scrape the profiles:
   - I open your logged-in Chrome, navigate through each profile, and extract current headline,
     location, and role into a JSON file.
   - Takes ~30s per person (LinkedIn's anti-bot measures add latency).
   - Stops on any auth error and tells you to re-login.

3. **Review the batch** before importing. The output looks like:

   ```json
   {
     "scraped": {
       "1234": { "headline": "VP of Engineering @ Acme", "location": "San Francisco, CA" },
       "5678": { "headline": "Product Manager @ Acme" }
     },
     "unreachable": ["9876"],
     "errors": [{ "id": "1111", "error": "Session expired" }]
   }
   ```

4. **Import from the CLI:**

   ```bash
   npx tsx scripts/ingest-linkedin.ts batch.json
   ```

   Then check Home — new `contact_changes` rows surface as "Recent updates" with a blue diff
   showing old → new for each field.

5. **Undo if needed:** `npx tsx scripts/revert-linkedin.ts` deletes all `contact_changes` rows
   created by the scraper, plus photos tagged `source='linkedin'`, and clears `linkedinScrapedAt`
   timestamps. Hand-uploaded photos and vCard imports are untouched.

## Flags

| Flag | Effect |
|---|---|
| `--select N` | Instead of importing, list the N people due for re-sync (ordered by `linkedin_scraped_at`). Shows who hasn't been checked in a while. |
| No args | Import all rows in the batch file. |

## How it protects itself

- **Your browser, your session.** No credential is stored in this app or Vercel — the skill drives
  Chrome using your logged-in session. If LinkedIn logs you out or detects bot-like activity, the
  script stops immediately.
- **Runnable resume.** Each person gets a `linkedinScrapedAt` timestamp on success, so a re-run
  only re-scrapes people you explicitly ask for (via `--select`), not everyone again.
- **Non-destructive import.** The batch file is separate from the database — you can review and
  modify it before importing, and re-run the import multiple times with the same file.
- **Undo is complete.** `revert-linkedin.ts` tracks provenance via `contact_changes.source='linkedin'`,
  so it leaves imported data from other sources (vCard, messages, manual edits) untouched.

## Gotchas

- **LinkedIn changes frequently.** If the scraper breaks, it's usually because LinkedIn added a new
  CSS class or reorganized the DOM. The script will error clearly; send the error and a screenshot.
- **Session expiry is real.** If your Chrome session expires mid-run (LinkedIn logs you out),
  the script stops. Re-login and re-run — it will retry the people it missed on the previous run.
- **`contact_changes` are immutable.** Once imported, they form the audit trail — they can't be
  edited or deleted individually. Use `revert-linkedin.ts` to wipe them all, or undo specific
  rows by hand in the database if needed.

## Related

- **Gmail sync:** `/gmail-sync` (import recent emails and attachments).
- **Messages sync:** built-in at Settings → Accounts (reads a local SQLite file).

