---
name: update-photos
description: >-
  Fill in missing contact profile photos by looking them up from LinkedIn via
  unavatar.io, keyed on each contact's linkedin_url. Use when the user asks to
  update, backfill, refresh, or fix contact photos / pictures / avatars /
  headshots, asks "why do some people have no photo", asks how many contacts are
  missing a picture, or wants to undo a previous photo backfill.
---

# Update missing contact photos

Backfills `contact_photos` from `https://unavatar.io/linkedin/<slug>`, resolved from
each contact's existing `linkedin_url`. No LinkedIn account is involved, so there is
zero account risk. Verified correct against hand-pasted ground truth: unavatar returned
the byte-identical image for 5 of 5 contacts.

**This costs real money** — $0.01 per lookup, including lookups that find nothing.
Never run it without showing the projected cost first.

All commands run from `web/`. Every invocation needs the env sourced:

```
set -a && source .env.local && set +a && npx tsx scripts/backfill-photos.ts [flags]
```

## Normal run

1. **Preflight.** Confirm `UNAVATAR_API_KEY` is in `web/.env.local`. If it's missing,
   stop and tell the user to get a PRO key at **https://unavatar.io/checkout** and add
   it as `UNAVATAR_API_KEY=...`. Do not create the account or enter payment details for
   them. The key belongs in `.env.local` only — never `vercel env add`, since the script
   never runs on Vercel.

2. **Dry run first, always.** It makes zero requests and costs nothing:

   ```
   set -a && source .env.local && set +a && npx tsx scripts/backfill-photos.ts --dry-run
   ```

   The header reports how many contacts are missing a photo and the projected spend.

3. **Show the user the projected cost and confirm before spending**, unless they already
   named a budget in this conversation. Typical incremental runs are a handful of new
   contacts — cents. A from-scratch run over ~1,400 contacts is ~$14.

4. **Run it.** Default spend cap is $15 and it is a hard ceiling — `--max-cost` above
   that is refused, not silently clamped. Pass a lower cap when the user names a budget:

   ```
   set -a && source .env.local && set +a && npx tsx scripts/backfill-photos.ts --max-cost 5
   ```

   Long runs should go in the background with output tee'd to a log, then monitor the
   ledger lines (printed every 25 completions) rather than polling blindly.

5. **Report** hits, misses, errors, and actual spend. Misses are normal — they mean that
   person has no photo on LinkedIn.

## Useful flags

| Flag | Effect |
|---|---|
| `--dry-run` | List targets and slugs, zero requests, zero cost |
| `--limit N` | First N targets only (ordered by contact id, so runs walk forward) |
| `--max-cost N` | Stop at $N. Default and hard ceiling are both $15 |
| `--ids 1,2,3` | Only these contact ids |
| `--recheck` | Re-look-up contacts previously confirmed to have no photo (re-pays) |
| `--force` | Overwrite existing photos. Requires `--ids` — refuses to run in bulk |
| `--revert` | Delete every `source='unavatar'` photo and clear its stamp. Honours `--dry-run` |
| `--concurrency N` | Parallel lookups, default 4 |

## How it protects itself

Don't re-implement or work around any of this:

- **Resumable and cheap to re-run.** `contacts.photoCheckedAt` is stamped on a hit *and*
  on a confirmed miss, so a repeat run only pays for genuinely new contacts. Transient
  errors are left unstamped so they retry next time.
- **Fill-gaps-only.** Never overwrites an existing photo, so hand-pasted ones are safe.
- **Hard spend cap** with pessimistic per-request budget reservation, plus a circuit
  breaker after 10 consecutive failures and an immediate abort on a rejected API key.

## Gotchas that matter

- **`?fallback=false` is NOT honored.** A contact with no LinkedIn photo comes back as
  **HTTP 200 with a ~451-byte `image/svg+xml`** — LinkedIn's grey ghost silhouette. The
  script classifies by content type, never status code, and also applies a 2KB size floor.
  If you ever touch that logic, keep it content-type-first or you'll store placeholders
  for hundreds of people.
- **SVG must stay rejected.** `/api/photos/[contactId]` serves photos same-origin, where
  an SVG can carry script. The raster-only allowlist in `src/lib/image-import.ts` is the
  guard, and it's also what makes the ghost detectable.
- **Contacts with no `linkedin_url` are unreachable** by this route (~394 of them). They
  keep their initials avatars. The only other photo source is the vCard uploader in
  Settings → Accounts, which reads embedded `PHOTO` data from an Apple/Google Contacts
  `.vcf` export the user uploads by hand.

## Undoing a run

```
set -a && source .env.local && set +a && npx tsx scripts/backfill-photos.ts --revert --dry-run
```

Reports how many backfilled photos would go and confirms photos from other sources are
untouched. Drop `--dry-run` to actually revert.

Do **not** use `scripts/revert-linkedin.ts --photos` for this — that flag only removes
`source='linkedin'` photos (from the scraper), not backfilled ones.

## Checking coverage without running anything

```sql
select
  (select count(*) from contacts where archived_at is null) as total,
  (select count(*) from contacts c join contact_photos p on p.contact_id = c.id
     where c.archived_at is null) as with_photo,
  (select count(*) from contacts where archived_at is null
     and linkedin_url is not null and photo_checked_at is null) as never_checked;
```
