---
name: social-sync
description: >-
  Pull the owner's own social media analytics — follower counts, profile views,
  post impressions — from LinkedIn, X and Instagram into Rontext's Social
  section. Drives your logged-in Chrome to read your own dashboards, writes a
  JSON batch, then imports it via the CLI. Use when the user asks to sync
  social stats, refresh social analytics, update follower counts, or pull post
  performance. GitHub stats have their own path: scripts/sync-github.ts.
---

# Sync social analytics into Rontext

Reads the owner's **own** analytics pages in their logged-in Chrome — never anyone
else's profile — and lands the numbers in `social_account_metrics` /
`social_post_metrics`, which feed the tiles and per-post performance blocks on
`/social`. No credential is stored anywhere; if a login wall appears, stop and say so.

All commands run from `web/`. The import step is:

```bash
npx tsx scripts/ingest-social.ts <batch.json> [--dry-run]
```

## Workflow

1. **Confirm handles.** LinkedIn slug, X handle, Instagram handle — ask once and
   remember them in the conversation. Only ever open the owner's own pages.

2. **Scrape, per platform** (skip any platform the owner doesn't care about today):

   - **LinkedIn** — open `https://www.linkedin.com/dashboard` (creator hub):
     followers, profile views (90d), post impressions (7d — record it in
     `impressions`). Then `https://www.linkedin.com/in/<slug>/recent-activity/all/`:
     for the ~10 most recent posts, the author-visible impression count, reactions,
     comments, reposts, the permalink (Copy link to post), and the first ~100 chars
     as `excerpt`.
   - **X** — open `https://x.com/<handle>`: followers, following, post count from
     the profile header. Scroll the owner's own timeline: for the ~10 most recent
     posts, the view count shown on each post, likes, reposts, replies (as
     `comments`), bookmarks if visible, and the `/status/<id>` permalink.
     Do **not** use analytics.x.com — it's Premium-gated and errors uselessly.
   - **Instagram** — open `https://www.instagram.com/<handle>/`: posts, followers,
     following from the header. Personal accounts have **no insights**; per-post
     likes/comments are only worth collecting if the owner explicitly asks
     (open individual recent posts — slow, and Instagram is the most
     automation-hostile of the three, so default to header counts only).

3. **Write the batch** to a JSON file (e.g. `social-batch.json` in the scratchpad),
   then show it to the owner before importing:

   ```json
   {
     "capturedAt": "2026-08-11T18:00:00Z",
     "accounts": [
       { "platform": "linkedin", "followers": 2140, "profileViews": 312, "impressions": 15400 },
       { "platform": "x", "followers": 812, "following": 301, "postCount": 1543 },
       { "platform": "instagram", "followers": 640, "following": 512, "postCount": 88 }
     ],
     "posts": [
       {
         "platform": "x",
         "postUrl": "https://x.com/handle/status/1234567890",
         "postedAt": "2026-08-08",
         "excerpt": "Shipping the network graph…",
         "impressions": 4200, "likes": 31, "comments": 4, "reposts": 6
       }
     ]
   }
   ```

   Every count field is optional — omit what a platform doesn't show rather than
   writing 0 (0 means "measured zero", absent means "not shown").

4. **Import:**

   ```bash
   npx tsx scripts/ingest-social.ts social-batch.json --dry-run   # counts only
   npx tsx scripts/ingest-social.ts social-batch.json             # for real
   ```

   Post URLs are normalized (twitter.com → x.com, query strings stripped) and
   matched against posts written in the app, which then show a Performance block.
   Unmatched URLs still show under "Tracked elsewhere".

5. **Undo if needed:**

   ```bash
   npx tsx scripts/revert-social.ts [--platform x] [--dry-run]
   ```

## Flags

| Command | Flag | Effect |
|---|---|---|
| ingest-social | `--dry-run` | Validate and count; write nothing. |
| revert-social | `--platform <p>` | Limit the revert to one platform. |
| revert-social | `--dry-run` | Show what would be deleted. |

## How it protects itself

- **Your browser, your session, your pages only.** Reads dashboards you can
  already see; never visits other people's profiles; stops at any login wall.
- **Reviewable batch.** Nothing touches Postgres until the CLI import, and the
  JSON file is the whole interface — edit it freely first.
- **Import once per batch.** The metrics tables are append-only time series;
  importing the same file twice records a duplicate capture (harmless, noisy).
- **Provenance-scoped undo.** Scraped rows carry `source='scrape'`;
  revert-social.ts never touches the GitHub API rows (`source='api'`).

## Gotchas

- **The dashboards move.** LinkedIn especially reshuffles its creator hub; read
  what's on screen rather than trusting exact selectors, and record what the
  page actually labels the number (7d vs 28d impressions changes over time —
  whatever it is, it goes in `impressions`).
- **X view counts are public-page numbers**, not analytics-grade; that's the
  accepted tradeoff of the free path.
- **Instagram personal accounts** show header counts only. If the owner
  converts to a Creator account later, insights open up — extend the batch's
  `extra` field rather than inventing new top-level fields.
- **Cadence:** weekly is plenty. LinkedIn's impressions window is rolling, so
  captures more frequent than the window just re-measure the same period.

## Related

- **GitHub and X:** both run automatically now — Settings → Connections, or the
  daily job runner. This skill is only needed for LinkedIn and Instagram, which
  expose no analytics API.
- **Other people's LinkedIn profiles:** a different thing entirely, and handled
  by the Chrome extension in `extension/`, not by a skill.
