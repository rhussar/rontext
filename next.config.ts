import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * The Claude Code skills are read off disk at request time by
   * src/lib/skills.ts, but nothing *imports* them, so Next's file tracer has no
   * reason to put them in the serverless bundle. Without this they resolve fine
   * in `next dev` and return an empty list in production — a difference that
   * only surfaces after a deploy.
   *
   * Both paths are listed because two of the skills are committed as symlinks
   * (.claude/skills/neon → ../../.agents/skills/neon) and a glob will not
   * reliably walk through a symlink to collect the target.
   */
  outputFileTracingIncludes: {
    // The layout reads these for the settings panel, so every route needs them,
    // not just /skills.
    "/*": ["./.claude/skills/**/SKILL.md", "./.agents/skills/**/SKILL.md"],
  },
};

export default nextConfig;
