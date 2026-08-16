---
name: messages-sync
description: >-
  Sync iMessage/SMS activity from this Mac into Rontext — per-person totals plus
  a monthly breakdown that shows on each contact's timeline. Use when the user
  asks to sync Messages, import texts, refresh texting activity, update who
  they've been talking to, or enable Messages as a data source.
---

# Sync Messages into Rontext

Reads a **copy** of `~/Library/Messages/chat.db` and writes counts and dates only.
No message text is ever read — that is enforced by the SQL in
`scripts/messages-reader.ts`, which never selects `message.text` or
`attributedBody`. Nothing about this sync sends anything to a third party.

All commands run from `web/`, and all of them need the env prefix — without it
the script dies with no `DATABASE_URL`.

## This now runs automatically (launchd agent)

Since 2026-08-15 a LaunchAgent (`com.rontext.sync`) runs
`scripts/mac-agent.ts` daily at 09:30 local (missed runs fire on wake). It
uses the same reader (`scripts/messages-reader.ts`) and writes a heartbeat to
`job_runs` (job `messages`, trigger `mac`), which Settings → Accounts →
Automation shows as the "Messages · on your Mac" row — green when it ran,
red with the reason when it failed, amber when it hasn't checked in.

```bash
scripts/install-mac-agent.sh            # install / refresh (--hour H --minute M)
scripts/install-mac-agent.sh --status   # loaded? last exit code, log tail
scripts/install-mac-agent.sh --uninstall
```

The one manual step is **Full Disk Access for the node binary launchd runs**
(the installer prints the exact path; System Settings → Privacy & Security →
Full Disk Access → + → ⌘⇧G → paste). launchd runs node directly, not through
a shell, precisely so the grant attaches to node. A Homebrew node upgrade
moves that path — re-grant and re-run the installer. Log:
`~/Library/Logs/rontext/mac-agent.log`.

The CLI below is still the way to preview (`--dry-run`) or take a wider
window (`--months 24`). Apple Contacts push (`push-apple-contact-names`) is
deliberately *not* on the schedule — it edits the address book and wants a
human reading the diff.

## Prerequisite: Full Disk Access

Whatever runs this (Terminal, Claude Code) needs **Full Disk Access** in
System Settings → Privacy & Security. Without it every read of chat.db fails:

```
Cannot read chat.db — grant Full Disk Access to this terminal in
System Settings → Privacy & Security → Full Disk Access, then retry.
```

The underlying SQLite error is `authorization denied` / `unable to open`. If you
see either, that's what it means — the file is there, the permission isn't.
Granting it requires the user; you cannot do it for them. Note that toggling
Full Disk Access **restarts the app you granted it to**.

## Running a sync

Always dry-run first, report the summary, and only run for real once the user
confirms.

```bash
set -a && source .env.local && set +a && npx tsx scripts/ingest-messages.ts --dry-run
```

Then, for real:

```bash
set -a && source .env.local && set +a && npx tsx scripts/ingest-messages.ts
```

## Flags

| Flag | Effect |
|---|---|
| `--dry-run` | Read and report, write nothing. |
| `--months N` | How far back to read (default 12). **Calendar** months — this month plus the N−1 before it, snapped to month boundaries. |

## What it writes

1. **`interactions`** — one lifetime row per person, `source='messages'`: total,
   sent, received, first and last date.
2. **`interaction_periods`** — one row per person per calendar month. This is
   what renders on the person's Timeline as `24 messages · 14 sent, 10 received`
   next to `JUL 2026`. Quiet months get no row, and the feed shows the 6 most
   recent.
3. **`contact_candidates`** — handles that didn't match anyone, for review in
   Settings → Discovered.
4. **`sync_runs`** — one row per run, feeding the Settings → Accounts card.

**What it never writes: message text.** Not bodies, not subjects, not
attachments. If a request would require reading message content, say so and stop
rather than widening the query — the no-text guarantee is the reason this
connector is safe to run at all.

## What it filters out

- **Group chats.** Only 1:1 conversations count, or a 30-person thread would
  credit you with talking to 29 people you've never addressed.
- **Tapbacks and system events** ("X renamed the group").
- **Shortcodes** (under 7 digits) — 2FA prompts, banks, delivery bots.
- **One-way traffic.** A correspondent needs ≥2 messages with ≥1 from you.

Nothing here ever creates a contact. Unmatched handles become candidates; the
only route to a new contact is accepting one in Settings → Discovered.

## After a sync

Check **Settings → Discovered** for new candidates. Accepting one carries its
monthly history across immediately — no re-sync needed.

Re-running is safe and idempotent: counts merge by taking the larger value, so
the same window twice is a no-op and a wider window only grows the numbers.

## Undoing a sync

```bash
set -a && source .env.local && set +a && npx tsx scripts/revert-connector.ts --connector messages --keep-dismissed
```

`--keep-dismissed` preserves the "not a person" decisions so a later re-sync
doesn't put those handles back in the queue. Drop it for a full wipe. The
script's header documents the complete teardown.

## Gotchas

- **Deletions don't propagate.** Delete a thread in Messages.app and its counts
  stay, because the merge only ever takes the larger value. Revert and re-sync
  to reset.
- **Totals can exceed the sum of the monthly buckets** for contacts synced
  before the buckets existed — earlier runs used a wider, unsnapped window.
  That's expected. Never present a number from `interactions` next to one
  derived from `interaction_periods`; revert and re-sync if they must agree.
- **International numbers** are keyed on the last 10 digits (NANP-biased). A
  collision fails to match and lands in the review queue, which is the safe
  direction to be wrong in.

## Related

- **Gmail sync:** `/gmail-sync` — same pipeline, same monthly buckets, for email.
- **LinkedIn sync:** `/linkedin-sync` — profile and headline changes.
- **Contact photos:** `/update-photos` — avatars via unavatar.io.
