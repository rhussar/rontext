/**
 * Skill shapes, split out from src/lib/skills.ts so client components can import
 * them. skills.ts pulls in node:fs at module scope; even a type-only import from
 * it is a trap waiting for someone to drop the `type` keyword and break the
 * client bundle. This module has no runtime imports at all.
 */

export type SkillGroup = "workflow" | "reference";

export type SkillSummary = {
  /** Directory name, which is also the invocable name: /messages-sync */
  name: string;
  /** The frontmatter description — what it does and when to reach for it. */
  description: string;
  group: SkillGroup;
};

/** A summary plus the full markdown body, everything after the frontmatter. */
export type Skill = SkillSummary & { body: string };
