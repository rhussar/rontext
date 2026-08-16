---
name: gmail-sync
description: >-
  Sync recent email activity from Gmail into Rontext — who you corresponded with,
  how often, and when, shown on each person's timeline. Use when the user asks to
  sync Gmail, import emails, refresh email activity, or enable Gmail as a data
  source.
---

# Sync Gmail into Rontext

Reads message **metadata only** — sender, recipient and timestamp — and writes
counts and dates. Subjects and bodies are never requested: the API call uses
`format=metadata` with the header allowlist `From, To, Cc, List-Unsubscribe`,
so there is no code path by which message content reaches this app.

All commands run from `web/`, and all of them need the env prefix — without it
the script dies with no `DATABASE_URL`.

## This now runs automatically

Since 2026-08-15 Gmail syncs **daily on the Vercel cron** (`/api/cron/daily`,
job `gmail`, see `src/lib/jobs/gmail.ts`) using the Google grant stored in the
app (Settings → Accounts → Google). The daily window is calendar-aligned (from
the first of the previous month) so monthly buckets stay complete; a fresh
install's first run does a 12-month baseline. Settings → Accounts → Automation
shows the last run and has **Run now**. Only reach for the CLI below when you
need a wider window (`--months 24`) or a dry-run preview.

Connect / reconnect Google from **Settings → Accounts → Google → Connect**
(needs `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` in Setup — a *Web* OAuth
client with `<app-url>/api/oauth/google/callback` as an authorized redirect
URI). That flow grants Gmail + Calendar + Contacts (all read-only). The old
Mac pairing below still works for the CLI and was migrated into the app store
with `scripts/migrate-gmail-token.ts` (Gmail-only scope, Desktop client —
Reconnect through the app to add Calendar/Contacts).

## Legacy setup (Mac pairing, CLI only)

```bash
npx tsx scripts/pair-gmail.ts
```

Opens Google's consent screen, catches the redirect on a loopback listener, and
writes a **read-only refresh token** to `~/.mesh-replica/gmail.json` at mode
0600. `scripts/ingest-gmail.ts` prefers the app's grant and falls back to this
file.

It needs a Google Cloud OAuth client first; `scripts/pair-gmail.ts`'s header
documents the four steps. One of them is load-bearing: **publish the app**
("In production"). While it sits in Testing, Google expires refresh tokens for
Gmail scopes every 7 days and you'd re-pair weekly. Expect an "unverified app"
warning on the consent screen — Advanced → Go to app.

The scope is `gmail.readonly`. It cannot send, delete, or modify anything.
`scripts/gmail-auth.ts` is a **library** (token load/refresh), not something you
run.

## Running a sync

Always dry-run first, report the summary, and only run for real once the user
confirms.

```bash
set -a && source .env.local && set +a && npx tsx scripts/ingest-gmail.ts --dry-run
```

Then, for real:

```bash
set -a && source .env.local && set +a && npx tsx scripts/ingest-gmail.ts
```

## Flags

| Flag | Effect |
|---|---|
| `--dry-run` | Read and report, write nothing. |
| `--months N` | How far back to read (default 12). |
| `--max N` | Cap on messages fetched per pass (default 5000). |

## What it writes

1. **`interactions`** — one lifetime row per person, `source='email'`: total,
   sent, received, first and last date.
2. **`interaction_periods`** — one row per person per calendar month, rendering
   on the person's Timeline as `12 messages · 7 sent, 5 received` next to
   `JUL 2026`.
3. **`contact_changes`** — only when a matched person gains a new email address;
   this is not a per-message log.
4. **`contact_candidates`** — addresses that didn't match anyone, for review in
   Settings → Discovered.
5. **`sync_runs`** — one row per run, feeding the Settings → Accounts card.

**It does not log one row per email.** Individual messages are counted, never
stored.

## What it filters out

- **Automated senders** — no-reply, notifications, mailer-daemon and friends,
  by a local-part regex.
- **One-way traffic.** A correspondent needs ≥2 messages with ≥1 from you, so
  newsletters and receipts never reach the review queue.

Nothing here ever creates a contact. Unmatched addresses become candidates; the
only route to a new contact is accepting one in Settings → Discovered.

## The `--max` cap and monthly buckets

If a pass hits `--max`, the **oldest** mail in the window is silently dropped.
The script detects this and **suppresses the monthly buckets for that run**,
writing totals only — a month reading "3 emails" when there were 200 would be
frozen permanently, since counts merge by taking the larger value. You'll see a
note in the output when this happens. Re-run with a larger `--max` to get the
buckets.

## After a sync

Check **Settings → Discovered** for new candidates. Accepting one carries its
monthly history across immediately — no re-sync needed.

Re-running is safe and idempotent.

## Undoing a sync

```bash
set -a && source .env.local && set +a && npx tsx scripts/revert-connector.ts --connector gmail --keep-dismissed
```

`--keep-dismissed` preserves the "not a person" decisions so a later re-sync
doesn't put those addresses back in the queue. Drop it for a full wipe. This is
an exact revert — it restores the pre-connector interaction dates from
`contact_rollup_baseline`, which the rollup cannot recompute backwards. **Do not
hand-write SQL to undo a sync**; you would miss that restore.

To disconnect entirely: `rm -rf ~/.mesh-replica`, then revoke the app at
myaccount.google.com/permissions.

## Gotchas

- **Matching is by address, then by exact unambiguous name.** A name shared by
  two contacts matches neither.
- **Deletions don't propagate.** Counts only ever grow; revert and re-sync to
  reset.
- **Totals can exceed the sum of the monthly buckets** for contacts synced
  before the buckets existed, or through a truncated run. Expected — never
  present a number from `interactions` next to one derived from
  `interaction_periods`.
- **Bucket months are UTC here** and local time in the Messages connector, so a
  near-midnight message can land either side of a boundary. Harmless at this
  granularity.
- **A 401 means the token is dead** (password change or revoked access). Re-run
  `pair-gmail.ts`.

## Related

- **Messages sync:** `/messages-sync` — same pipeline for iMessage/SMS.
- **LinkedIn sync:** `/linkedin-sync` — profile and headline changes.
- **Contact photos:** `/update-photos` — avatars via unavatar.io.
