---
name: gmail-sync
description: >-
  Sync recent emails from Gmail into Mesh — emails from/to contacts get tagged
  with them and surface on the person's timeline. Use when the user asks to sync
  Gmail, import emails, refresh email activity, or enable Gmail as a data source.
---

# Sync Gmail into Mesh

Pulls recent emails from your Gmail inbox, matches them to contacts (by email address),
and logs them as `contact_changes` rows — surfacing on Home's activity feed and each
person's timeline. Works read-only via the Gmail API; no messages are modified or deleted.

All commands run from `web/`. The full workflow is:

```bash
# One-time: set up Gmail API access (opens your browser)
npx tsx scripts/gmail-auth.ts

# Then, sync whenever you want
npx tsx scripts/ingest-gmail.ts [--limit 100] [--since 7d]
```

## Setup (one-time)

```bash
npx tsx scripts/gmail-auth.ts
```

This opens your browser, asks you to sign in to Gmail, and saves a **read-only refresh token**
to `~/.mesh-replica/gmail_token.json` on your Mac. The token is stored on the machine, not in
this app or Vercel.

It requests only `gmail.readonly` — read access to your inbox. It cannot send, delete, or
modify any messages.

**Why not use Vercel env vars?** Because the token is personal and long-lived, it belongs on
the machine with everything else that's not a shared secret — like `.env.local`. The script
never runs on Vercel, only locally.

## Running syncs

```bash
npx tsx scripts/ingest-gmail.ts [--limit 100] [--since 7d]
```

- `--limit N` (default 100): fetch the last N messages from your inbox.
- `--since Nd` (default 7d): only include messages from the last N days (1d, 7d, 30d, etc.).

The script:
1. Fetches messages from your inbox matching the filters.
2. Extracts senders/recipients and matches them to contacts by email address.
3. Logs each matching message as a `contact_changes` row, tagged `source='gmail'`.
4. Surfaces on Home as "Recent updates" and on each person's timeline in the **Timeline** tab.

## Flags

| Flag | Effect |
|---|---|
| `--limit N` | Fetch the last N messages (default 100). |
| `--since Nd` | Only messages from the last N days (default 7d). Use 30d for a monthly sync. |
| `--dry-run` | Show what would be imported without storing anything. |

## How it protects itself

- **Read-only.** The Gmail API scope is `gmail.readonly` — messages can never be deleted, modified,
  or sent via this script. It is purely informational.
- **Token on the machine.** The refresh token lives in `~/.mesh-replica/gmail_token.json`, not in
  git, not on Vercel, not in .env files — same as the local-only unavatar key.
- **Email addresses only.** The script extracts sender/recipient email addresses and matches them
  to existing contacts. It does NOT import message bodies, attachments, or any content beyond
  the sender/recipient and timestamp. No sensitive data leaves your machine.
- **Non-destructive import.** Emails are logged as `contact_changes` with `source='gmail'` — they
  form an audit trail on each person's timeline. They can be reviewed before any action is taken.

## Matching logic

Emails are matched to contacts by comparing the sender/recipient email address against the
`contacts.email` field (and secondary emails if they exist). A match must be exact — partial
matches and aliases are not supported.

Unmatched emails are logged as "couldn't find a contact for this email address" and are skipped.

## Undoing a sync

Gmail imports are tagged with `contact_changes.source='gmail'`, so you can filter and delete them
directly in SQL if needed:

```sql
DELETE FROM contact_changes WHERE source = 'gmail';
```

There's no CLI undo command yet; use SQL if you need to remove a batch.

## Gotchas

- **Gmail API quota.** Google's free tier gives 1 million requests/day per user. A typical sync
  uses ~N+1 requests (one per message, one for auth). This is not a practical concern for
  personal use, but bulk re-syncing old dates many times over could hit the limit.
- **First sync takes longer.** If you run `--since 30d` on a fresh install, it fetches ~3000
  messages (more if you get a lot of email). Subsequent runs with `--since 7d` are much faster.
- **Token refresh is automatic.** If your Gmail password changes or you revoke access, the
  refresh token becomes invalid and the script will fail with a 401 error — just run
  `gmail-auth.ts` again.

## Related

- **LinkedIn sync:** `/linkedin-sync` (scrape profile changes from LinkedIn).
- **Messages sync:** built-in at Settings → Accounts (reads a local SQLite file).
- **Contact photos:** `/update-photos` (fill in avatars from LinkedIn via unavatar.io).

