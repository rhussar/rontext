/**
 * Run the entity-resolution pass from the command line:
 *   set -a && source .env.local && set +a && npx tsx scripts/enrich.ts
 *
 * Phase 1 is rules-only — deterministic, zero tokens, safe to re-run.
 */
import {
  parentRollups,
  resetDerivedGraph,
  runRulesPass,
  topEntities,
} from "../src/lib/graph/enrich-core";

async function main() {
  const started = Date.now();

  if (process.argv.includes("--reset")) {
    console.log("Resetting derived entities and links…");
    await resetDerivedGraph();
  }

  const summary = await runRulesPass();

  console.log("\n=== Rules pass ===");
  console.log(`  contacts scanned          ${summary.contactsScanned}`);
  console.log(`  entities created          ${summary.entitiesCreated}`);
  console.log(`  entities total            ${summary.entitiesTotal}`);
  console.log(`  links created             ${summary.linksCreated}`);
  console.log(`  links total               ${summary.linksTotal}`);
  console.log(
    `  contacts with >=1 edge    ${summary.contactsWithAtLeastOneEdge}` +
      ` (${((summary.contactsWithAtLeastOneEdge / summary.contactsScanned) * 100).toFixed(1)}%)`,
  );
  console.log(`  company strings, seed-matched  ${"—"}`);
  console.log(`  company strings, generic only  ${summary.genericOnlyCompanies}`);
  console.log(`  company strings, unresolved    ${summary.unresolvedCompanies}`);

  console.log("\n=== Top 30 entities by member count ===");
  for (const e of await topEntities(30)) {
    const parent = e.parentId ? ` (child of #${e.parentId})` : "";
    console.log(`  ${String(e.memberCount).padStart(4)}  [${e.type}] ${e.name}${parent}`);
  }

  console.log("\n=== Roll-ups (parent + children combined) ===");
  for (const r of await parentRollups()) {
    console.log(`  ${String(r.people).padStart(4)}  [${r.type}] ${r.name}`);
  }

  console.log(`\nDone in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
