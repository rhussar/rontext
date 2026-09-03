---
name: push-apple-contact-names
description: >-
  Push corrected first/last name spellings from Rontext into Apple Contacts,
  matched by phone number, and optionally create Apple contacts for Rontext
  people (or a whole Rontext group) who aren't in the address book yet. Use
  when the user asks to fix, correct, or sync contact name spellings to Apple
  Contacts / their iPhone / their address book, push enriched names out of
  Rontext, or export a group's contacts to their phone.
---

# Push corrected names to Apple Contacts

The only direction that existed before this was Contacts → Rontext (the
`.vcf` importer, `linkedin-sync`, etc.). This is the first connector that
writes to Apple Contacts. It is **narrow on purpose**: first/last name only,
nothing else, and never a two-way sync. The one exception is `--create`
(below), which adds people who aren't in the address book at all — a created
contact gets its phone numbers too, because a contact created without one
would be permanently unmatchable by every connector in this repo, this
script's own rename pass included.

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
| `--create` | Also **create** an Apple contact for each scoped Rontext contact that has a usable phone number and no Apple match. Off by default — without it the script only ever renames. Never merges into or edits an existing contact. |
| `--group N` | Restrict to members of the Rontext group named `N` (exact match, e.g. `--group "Silver Scholar"`). Applies to renames and creations alike. An unknown name errors and lists the real groups rather than falling back to everyone. |
| `--force` | Apply even if the change count is above the safety cap (30). |
| `--only P` | Restrict to a single phone number `P` (matched on last 10 digits). Good for proving a run against one contact before trusting it against everyone. |
| `--exclude I,I` | Skip these Rontext contact ids (comma-separated), even if they'd otherwise match and differ — for holding back a specific reviewed change. |
| `--undo P` | Preview restoring names from a previous run's log at path `P`. |
| `--confirm` | Required alongside `--undo` to actually write the restore. |

## Exporting a group to Apple Contacts

The common case — put everyone in a Rontext group into the address book,
skipping anyone without a number:

```bash
set -a && source .env.local && set +a && npx tsx scripts/push-apple-contact-names.ts --group "Silver Scholar" --create --dry-run
```

Drop `--dry-run` to apply. The creation summary counts every skip reason
separately (`skippedNoUsablePhone`, `alreadyInApple`, `skippedArchived`,
`skippedNoName`, `ambiguousWithinBatch`) so a smaller-than-expected batch is
explained rather than silent.

Creation deliberately skips anyone whose number already reaches an Apple
contact — that person is a rename candidate, not a creation, and the two
passes never touch the same contact in one run.

## What it writes

1. **Apple Contacts first/last name** on matched people only — nothing else.
2. **New Apple contacts** (only with `--create`): first name, last name, and
   phone numbers, labelled `mobile`. No email, company, notes, or photo. Each
   creation is written to the safety log as it lands, so an interrupted run is
   still fully undoable.
3. **A full backup of the local Contacts data store**
   (`~/Library/Application Support/AddressBook`) to
   `~/.mesh-replica/contacts-backups/<timestamp>/`, made *before* the first
   write of any real run (push or undo). If the backup fails, the run aborts
   before touching anything.
4. **A safety log** at `~/.mesh-replica/contacts-push-log-<timestamp>.json` —
   one entry per applied change with the prior name, and one per creation with
   the name and phones written. The path is printed at
   the end of a real run, along with the exact `--undo` command to reverse it.

Nothing lands in Postgres. This connector has no matching-in-reverse concept —
it never creates a Rontext contact, never touches `contact_changes`.

## What it never touches

- Any field other than first/last name (email, phone, company, notes, photo —
  all out of scope by design).
- Contacts that don't match an existing Apple contact by phone — the rename
  pass never creates. Creating them is opt-in via `--create`, and even then it
  only ever *adds* a new person, never merges into or edits an existing one.
- Archived Rontext contacts, and Rontext contacts with no name — never created.
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

**Undoing a `--create` run deletes the contacts it created**, which is the
only place this script deletes anything. The bar is higher than for a rename:
a created contact is only removed while it still looks exactly as created —
same name, same phone set, and no email, address, company, or note added
since. Anything edited in the meantime is partly the user's work now, so it's
kept and reported for them to delete by hand if they still want it gone. A
contact already deleted by hand is a no-op, not an error.

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
- **The 30-change safety cap** counts renames plus creations together. It
  exists because this feature is meant to fix a handful of misspellings. A
  much larger diff on a normal run is more likely a matching bug than a batch
  of real corrections — investigate before `--force`. A genuinely large group
  export is the one legitimate reason to reach for `--force`.
- **Rontext is not always right.** The rename pass assumes Rontext's spelling
  wins, and that assumption is only as good as the data — a full-database
  dry-run has surfaced Rontext typos that would overwrite correct Apple names
  ("Cameron" → "Cameronn"), and a blank-name Rontext record that would have
  written a phone number into the name field. Scope runs with `--group` or
  `--only` and read the diff; don't run it database-wide unreviewed.
- **Non-US numbers** still match on the last 10 digits, which is weaker for
  numbers whose national part is shorter. Creation writes every phone number
  verbatim, so nothing is lost, but be aware when reviewing matches.

## Related

- **Address-book import:** `contacts-import-core.ts` — the opposite direction
  and the opposite policy (fills gaps, never overwrites).
- **Messages sync:** the same phone-matching convention, now run nightly by the
  launchd agent (`scripts/mac-agent.ts`) rather than by a skill.

This is one of only two skills left. Everything else that used to be run by hand
— Gmail, LinkedIn, Messages, photos — is now a scheduled job, the Chrome
extension, or the Mac agent. This one stays manual deliberately: it *writes* to
the address book, and the owner wants a human on the diff.
