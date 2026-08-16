---
name: push-apple-contact-names
description: >-
  Push corrected first/last name spellings from Rontext into Apple Contacts,
  matched by phone number. Use when the user asks to fix, correct, or sync
  contact name spellings to Apple Contacts / their iPhone / their address
  book, or push enriched names out of Rontext.
---

# Push corrected names to Apple Contacts

The only direction that existed before this was Contacts → Rontext (the
`.vcf` importer, `linkedin-sync`, etc.). This is the first connector that
writes to Apple Contacts. It is **narrow on purpose**: first/last name only,
nothing else, and never a two-way sync.

Matches an Apple Contacts person to a Rontext contact by phone number, and
where the spelling differs, **Rontext wins** — the assumption is that if the
phone numbers match and Rontext has the name, Rontext's spelling is correct.
That's the opposite policy of the vCard importer (`src/lib/contacts-import-core.ts`),
which only ever fills gaps and never overwrites.

All commands run from `web/`, and all of them need the env prefix — without it
the script dies with no `DATABASE_URL`.

## Prerequisite: Automation permission

Whatever runs this (Terminal, Claude Code) needs permission to control
Contacts, granted in System Settings → Privacy & Security → Automation. Without
it every call fails with:

```
Not authorized to control Contacts — grant Automation access to this
terminal/app in System Settings → Privacy & Security → Automation, then retry.
```

The underlying error is JXA's `-1743`. Granting it requires the user; you
cannot do it for them.

## Running a push

Always dry-run first, report the summary, and only run for real once the user
confirms.

```bash
set -a && source .env.local && set +a && npx tsx scripts/push-apple-contact-names.ts --dry-run
```

Then, for real:

```bash
set -a && source .env.local && set +a && npx tsx scripts/push-apple-contact-names.ts
```

## Flags

| Flag | Effect |
|---|---|
| `--dry-run` | List proposed changes, write nothing. |
| `--force` | Apply even if the change count is above the safety cap (30). |
| `--only P` | Restrict to a single phone number `P` (matched on last 10 digits). Good for proving a run against one contact before trusting it against everyone. |
| `--exclude I,I` | Skip these Rontext contact ids (comma-separated), even if they'd otherwise match and differ — for holding back a specific reviewed change. |
| `--undo P` | Preview restoring names from a previous run's log at path `P`. |
| `--confirm` | Required alongside `--undo` to actually write the restore. |

## What it writes

1. **Apple Contacts first/last name** on matched people only — nothing else.
2. **A full backup of the local Contacts data store**
   (`~/Library/Application Support/AddressBook`) to
   `~/.mesh-replica/contacts-backups/<timestamp>/`, made *before* the first
   write of any real run (push or undo). If the backup fails, the run aborts
   before touching anything.
3. **A safety log** at `~/.mesh-replica/contacts-push-log-<timestamp>.json` —
   one entry per applied change with the prior name. The path is printed at
   the end of a real run, along with the exact `--undo` command to reverse it.

Nothing lands in Postgres. This connector has no matching-in-reverse concept —
it never creates a Rontext contact, never touches `contact_changes`.

## What it never touches

- Any field other than first/last name (email, phone, company, notes, photo —
  all out of scope by design).
- Contacts that don't match an existing Apple contact by phone — this never
  creates a new Apple contact.
- A phone number that's ambiguous on either side (matches more than one
  contact), or that would push conflicting names onto the same Apple contact
  — both are skipped and counted, never guessed.

## Matching

Last-10-digit phone number, same convention as the vCard importer and every
other connector in this repo. Names are compared as the **combined, trimmed
display name** ("firstName lastName"), not field-by-field, and
**case-sensitive** — "macdonald" → "MacDonald" is exactly the kind of fix
this exists for, so case is never normalized away. Comparing the combined
name (rather than firstName/lastName separately) matters for title-style
entries — a contact named "Coach Hank Stephens" might be split
first="Coach Hank"/last="Stephens" in Apple but first="Coach"/last="Hank
Stephens" in Rontext. Same name, different field boundary, nothing actually
misspelled — comparing fields separately would flag that as a change and
reshuffle words across the boundary for no reason. Comparing the full name
skips it.

## Undoing a push

Prefer the printed undo command:

```bash
set -a && source .env.local && set +a && npx tsx scripts/push-apple-contact-names.ts --undo ~/.mesh-replica/contacts-push-log-<timestamp>.json --confirm
```

Drop `--confirm` first to preview what would be restored. Each entry is only
restored if the Apple contact's current name still matches what the log
expects — if it's been edited again since, that entry is skipped rather than
overwritten, and reported.

For anything the log can't fix (a bug that damaged more than the two name
fields), the raw backup is the last resort: quit Contacts.app, replace
`~/Library/Application Support/AddressBook` with the backed-up copy under
`~/.mesh-replica/contacts-backups/`, relaunch Contacts.app. This is a
local-disk restore only — it won't retroactively un-sync anything that already
reached iCloud or the user's other devices before the restore.

## Gotchas

- **Shared phone numbers** (a family landline, a shared work line) make a
  contact ambiguous on purpose — the safe direction to be wrong in is to skip
  it, not guess which person it is.
- **iCloud propagation isn't instant.** A change written here needs a moment
  to reach the user's other devices.
- **The 30-change safety cap** exists because this feature is meant to fix a
  handful of misspellings. A much larger diff on a normal run is more likely a
  matching bug than a batch of real corrections — investigate before
  `--force`.

## Related

- **Address-book import:** `contacts-import-core.ts` — the opposite direction
  and the opposite policy (fills gaps, never overwrites).
- **Messages sync:** the same phone-matching convention, now run nightly by the
  launchd agent (`scripts/mac-agent.ts`) rather than by a skill.

This is one of only two skills left. Everything else that used to be run by hand
— Gmail, LinkedIn, Messages, photos — is now a scheduled job, the Chrome
extension, or the Mac agent. This one stays manual deliberately: it *writes* to
the address book, and Ronan asked for a human on the diff.
