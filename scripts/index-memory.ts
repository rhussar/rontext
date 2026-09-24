/**
 * Build or refresh the find_people index from the command line:
 *   set -a && source .env.local && set +a && npx tsx scripts/index-memory.ts
 *
 * Idempotent — only changed chunks are rewritten, only unembedded chunks are
 * sent to Voyage. The first run embeds everything (~2.5k chunks, a few
 * minutes, well under a dollar); later runs are near-instant.
 *
 *   --search "query"   run a find_people query afterwards, to eyeball results
 */
import { refreshMemory } from "../src/lib/memory/sync";
import { findPeople } from "../src/lib/memory/search";

async function main() {
  const started = Date.now();
  // No serverless clock here; an hour is "until done".
  const r = await refreshMemory(Date.now() + 60 * 60_000);

  console.log("=== Memory index ===");
  console.log(`  chunks     ${r.chunks}`);
  console.log(`  inserted   ${r.inserted}`);
  console.log(`  changed    ${r.changed}`);
  console.log(`  relinked   ${r.relinked}`);
  console.log(`  deleted    ${r.deleted}`);
  console.log(
    r.configured
      ? `  embedded   ${r.embedded} (${r.pending} pending)`
      : "  embedded   — VOYAGE_API_KEY not set, keyword-only",
  );
  if (r.error) console.log(`  ERROR      ${r.error}`);

  const i = process.argv.indexOf("--search");
  if (i > 0 && process.argv[i + 1]) {
    const q = process.argv[i + 1];
    const res = await findPeople(q, {}, 10);
    console.log(`\n=== find_people "${q}" (${res.mode}) ===`);
    if (res.note) console.log(`  note: ${res.note}`);
    for (const p of res.people) {
      console.log(`  ${p.score.toFixed(2)}  ${p.fullName}  [#${p.id}]  ${p.headline ?? ""}`);
      for (const e of p.evidence) {
        console.log(`          ${e.kind}: ${e.snippet.replace(/\s+/g, " ").slice(0, 160)}`);
      }
    }
  }

  console.log(`\nDone in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
