/**
 * The Claude Code skills committed under web/.claude/skills, read off disk.
 *
 * These are the operating manual for everything in this app that a human or an
 * agent has to *run* rather than click — the connectors, the photo backfill, the
 * social sync. Surfacing them in the app means someone (or something) working on
 * this CRM can find out how it is fed without cloning the repo.
 *
 * Read from disk rather than transcribed into a constant. The previous static
 * list had already drifted: its comment said "three entries" while it listed
 * six, and it never gained `messages-sync`. A directory scan cannot drift.
 *
 * The files are not in the serverless bundle by default — nothing imports them,
 * so Next's tracer has no reason to include them. `outputFileTracingIncludes` in
 * next.config.ts pulls them in explicitly; without that this returns [] in
 * production while working perfectly in dev, which is the sort of difference
 * that only shows up after a deploy.
 *
 * Not a "use server" module, so the /skills page and the settings panel can both
 * use it directly.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Skill, SkillSummary } from "@/lib/skill-types";

export type { Skill, SkillSummary, SkillGroup } from "@/lib/skill-types";

const SKILLS_DIR = join(process.cwd(), ".claude", "skills");

/**
 * Skills that arrived with a vendor plugin rather than being written for this
 * repo. Listed by exception on purpose: anything *not* named here is treated as
 * a project workflow skill, so a new skill written for this app shows up in the
 * right group with no edit here. A new vendor plugin needs one line added.
 */
const REFERENCE_SKILLS = new Set(["neon", "neon-postgres"]);

/**
 * Pull `name` and `description` out of the YAML frontmatter.
 *
 * Hand-rolled rather than pulling in a YAML parser: every SKILL.md here uses the
 * same two keys, and `description` is always a folded `>-` block, which means
 * continuation lines are indented and join with single spaces. A real YAML
 * dependency would be a lot of surface area for two fields.
 */
function parseFrontmatter(raw: string): { description: string; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!match) return { description: "", body: raw.trim() };

  const body = raw.slice(match[0].length).trim();
  const lines = match[1].split(/\r?\n/);

  let description = "";
  for (let i = 0; i < lines.length; i++) {
    const key = /^description:\s*(.*)$/.exec(lines[i]);
    if (!key) continue;

    const inline = key[1].trim();
    // A plain scalar sits on the same line; `>-` and `|` defer to the indented
    // block beneath.
    if (inline && inline !== ">-" && inline !== ">" && inline !== "|" && inline !== "|-") {
      description = inline.replace(/^["']|["']$/g, "");
      break;
    }
    const folded: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      if (!/^\s/.test(lines[j])) break; // dedent ends the block
      folded.push(lines[j].trim());
    }
    description = folded.join(" ").trim();
    break;
  }

  return { description, body };
}

/**
 * Every skill on disk, workflow group first, alphabetical within each.
 *
 * Returns [] rather than throwing when the directory is missing — a deployment
 * that failed to bundle the files should render an honest empty state, not a
 * 500 on the settings dialog.
 */
export function listSkills(): Skill[] {
  let dirs: string[];
  try {
    // Deliberately NOT filtered on isDirectory(): plugin-provided skills are
    // committed as *symlinks* (neon → ../../.agents/skills/neon), and a Dirent
    // for a symlink reports isSymbolicLink(), not isDirectory(). Filtering on
    // directories silently dropped them. Reading SKILL.md below follows the
    // link and its try/catch skips anything that isn't a skill anyway.
    dirs = readdirSync(SKILLS_DIR).sort();
  } catch {
    return [];
  }

  const skills: Skill[] = [];
  for (const name of dirs) {
    let raw: string;
    try {
      raw = readFileSync(join(SKILLS_DIR, name, "SKILL.md"), "utf8");
    } catch {
      continue; // a directory without a SKILL.md isn't a skill
    }
    const { description, body } = parseFrontmatter(raw);
    skills.push({
      name,
      description,
      body,
      group: REFERENCE_SKILLS.has(name) ? "reference" : "workflow",
    });
  }

  return skills.sort((a, b) =>
    a.group === b.group
      ? a.name.localeCompare(b.name)
      : a.group === "workflow"
        ? -1
        : 1,
  );
}

/**
 * Name + description only — what the settings panel lists.
 *
 * Bodies are dropped rather than passed and ignored: the panel renders inside a
 * client component, so every byte here crosses the server/client boundary in the
 * RSC payload on *every* page load. The seven bodies are ~54KB, and /skills is
 * the place that actually needs them.
 */
export function listSkillSummaries(): SkillSummary[] {
  return listSkills().map((s) => ({
    name: s.name,
    description: s.description,
    group: s.group,
  }));
}
