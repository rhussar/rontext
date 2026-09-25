/**
 * The agents that work on Rontext from outside it — the registry behind the
 * Agents page.
 *
 * Rontext runs no models itself. Agents are Claude sessions (scheduled tasks
 * in the Claude desktop app on the Mac today) that use the MCP tools and the
 * Mac scripts, then check in with `report_agent_run`. This list gives the
 * known ones a name, a home and an expected cadence; an agent that reports
 * under a key not listed here still appears, as "Unlisted".
 *
 * Client-safe: constants only.
 */

export type AgentDef = {
  /** The key the agent reports under. */
  key: string;
  name: string;
  /** One line: what it does for you. */
  description: string;
  /** Where it runs and what starts it. */
  runsOn: string;
  schedule: string;
  /** A last successful run older than this is flagged as overdue. */
  expectEveryHours: number;
  /** The skill or task prompt that defines it, for the curious. */
  definedBy: string;
  /** Rontext tools it writes with — the blast radius, at a glance. */
  writes: string[];
};

export const AGENTS: AgentDef[] = [
  {
    key: "text-summaries",
    name: "Text summaries",
    description:
      "Reads new 1:1 texts on the Mac and saves a short summary per contact — what you talk about, open loops, their news — for drafting and search",
    runsOn: "Mac · Claude desktop scheduled task",
    schedule: "Daily at 6:30am",
    expectEveryHours: 36,
    definedBy: "skill summarize-threads · task rontext-text-summaries",
    writes: ["save_conversation_summary"],
  },
  {
    key: "follow-ups",
    name: "Follow-ups",
    description:
      "Reads your recent 1:1 email threads and lists what's still owed on Home — what you promised, what people asked you, and who to nudge when something they promised is late — and drafts each reply in Drafts, ready for the Gmail button",
    runsOn: "Claude scheduled task · Gmail connector",
    schedule: "Daily at 6:45am",
    expectEveryHours: 36,
    definedBy: "skill follow-ups · task rontext-follow-ups",
    writes: ["save_follow_ups", "create_draft"],
  },
  {
    key: "wispr-meetings",
    name: "Wispr meetings",
    description:
      "Pushes finished Wispr Flow notetaker meetings into Rontext and attaches them to the person they were with",
    runsOn: "Mac · Claude desktop scheduled task",
    schedule: "Hourly",
    expectEveryHours: 6,
    definedBy: "task wispr-meetings-to-rontext",
    writes: ["add_meeting"],
  },
];

export const AGENT_BY_KEY = new Map(AGENTS.map((a) => [a.key, a]));
