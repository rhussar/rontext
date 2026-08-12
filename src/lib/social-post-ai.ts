/**
 * Generates a first-draft social post from an owner-typed topic.
 *
 * Deliberately NOT a `"use server"` module — the action in
 * `lib/actions/social.ts` is a thin wrapper over this, same split as
 * `draft-ai.ts` and `lib/photos.ts`.
 *
 * Same invariants as draft-ai.ts:
 *   1. Nothing here writes to the database. Generated text lands in the
 *      composer textarea; only an explicit save creates a row.
 *   2. The topic is owner-typed and trusted. If scraped text (post excerpts,
 *      comments) is ever fed in as context, it must go inside delimiters with
 *      length caps and a data-not-instructions system line, like <contact>
 *      in draft-ai.ts.
 */

import Anthropic from "@anthropic-ai/sdk";
import { desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { socialPosts, type SocialPostPlatform } from "@/db/schema";
import { PLATFORM_LABELS } from "@/lib/social";
import { getSecret } from "@/lib/secrets";

export const MODEL = "claude-opus-5";

/** Independent of draft-ai's — the prompts evolve separately. */
export const PROMPT_VERSION = 1;

const VOICE_EXAMPLES = 5;

export type GeneratedPost = {
  body: string;
  model: string;
  promptVersion: number;
};

export type GeneratePostResult =
  | ({ ok: true } & GeneratedPost)
  | { ok: false; error: string };

/**
 * The owner's own posts as style few-shots: manual-only for the same honesty
 * reason as draft-ai's voiceExamples (AI-written rows would teach the model
 * its own voice back). Same platform first — an X voice and a LinkedIn voice
 * are legitimately different — backfilled from the other platforms when the
 * same-platform corpus is thin.
 */
async function voiceExamples(platform: SocialPostPlatform): Promise<string[]> {
  // One query, partitioned in JS — the table is small and this keeps the
  // platform-priority rule readable.
  const rows = await getDb()
    .select({ body: socialPosts.body, platform: socialPosts.platform })
    .from(socialPosts)
    .where(eq(socialPosts.source, "manual"))
    .orderBy(desc(socialPosts.updatedAt))
    .limit(25);
  const cleaned = rows
    .map((r) => ({ body: r.body.trim(), platform: r.platform }))
    .filter((r) => r.body.length > 0);
  const preferred = cleaned.filter((r) => r.platform === platform);
  const rest = cleaned.filter((r) => r.platform !== platform);
  return [...preferred, ...rest].slice(0, VOICE_EXAMPLES).map((r) => r.body);
}

const PLATFORM_RULES: Record<SocialPostPlatform, string> = {
  x: `This is a post for X (Twitter). Hard limit: 280 characters — stay under it. One idea, stated plainly. No hashtags unless one is genuinely load-bearing. No threads.`,
  linkedin: `This is a LinkedIn post. 2–6 short paragraphs, single-sentence paragraphs are fine. Write like a person, not a thought leader: no "I'm humbled", no engagement-bait questions bolted on the end, no hashtag spam (at most 2–3, only if natural).`,
  instagram: `This is an Instagram caption. A short, punchy caption first. If hashtags help discovery, put up to 5 of them on a separate last line, never inline.`,
};

const SYSTEM = `You draft social media posts on behalf of the person using this app ("the owner"), writing in their voice.

You will be given the owner's topic — what they want to post about — and examples of their own past posts inside <voice_examples> tags. Match the cadence, warmth, and level of formality in the examples. Do not reuse their specific stories or facts, only their manner.

Rules:
- Never invent facts, numbers, links, or events. Work only with what the topic gives you; if it's thin, write something short and honest.
- No em-dashes. No filler. No "excited to announce" unless the owner's own examples talk that way.
- Return only the post text, ready to publish as-is.`;

function buildContext(
  platform: SocialPostPlatform,
  topic: string,
  examples: string[],
): string {
  const voice = examples.length
    ? `<voice_examples>\n${examples.map((e) => `---\n${e}`).join("\n")}\n</voice_examples>`
    : `<voice_examples>\n(none yet — the owner hasn't written posts here. Use a plain, direct, unfussy tone.)\n</voice_examples>`;

  return [
    voice,
    PLATFORM_RULES[platform],
    `The owner wants to post about: ${topic.trim()}`,
    `Write the ${PLATFORM_LABELS[platform]} post.`,
  ].join("\n\n");
}

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    body: { type: "string", description: "The post text, ready to publish." },
  },
  required: ["body"],
  additionalProperties: false,
} as const;

export async function generateSocialPostFor(
  platform: SocialPostPlatform,
  topic: string,
): Promise<GeneratePostResult> {
  // Explicit apiKey, not the SDK's implicit env read — the key can come from
  // the database (Settings → Setup) and `new Anthropic()` would silently lose
  // a DB-stored value to a stale or absent env var.
  const apiKey = await getSecret("ANTHROPIC_API_KEY");
  if (!apiKey) {
    return { ok: false, error: "No Anthropic API key configured." };
  }
  if (!topic.trim()) {
    return { ok: false, error: "Say what the post should be about." };
  }

  const client = new Anthropic({ apiKey });
  const examples = await voiceExamples(platform);

  let res;
  try {
    res = await client.messages.create(
      {
        model: MODEL,
        // Not 2000: thinking is on by default on this model, and max_tokens
        // caps thinking *plus* visible text together. Too low truncates the
        // JSON mid-object.
        max_tokens: 8000,
        system: SYSTEM,
        output_config: {
          effort: "low",
          format: { type: "json_schema", schema: OUTPUT_SCHEMA },
        },
        messages: [
          { role: "user", content: buildContext(platform, topic, examples) },
        ],
      },
      // The SDK default is 10 minutes, which outlives the function's own
      // 60s budget — without this a slow call dies as a 504, not a toast.
      { timeout: 45_000 },
    );
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) {
      return { ok: false, error: "Anthropic rejected the API key." };
    }
    if (err instanceof Anthropic.RateLimitError) {
      return { ok: false, error: "Rate limited by Anthropic. Try again shortly." };
    }
    if (err instanceof Anthropic.APIConnectionTimeoutError) {
      return { ok: false, error: "Drafting timed out. Try again." };
    }
    return { ok: false, error: "Couldn't reach Anthropic." };
  }

  // Branch on stop_reason *before* touching content: a refusal returns HTTP
  // 200 with an empty content array, and max_tokens leaves half-written JSON.
  if (res.stop_reason === "refusal") {
    return { ok: false, error: "The model declined to draft this one." };
  }
  if (res.stop_reason === "max_tokens") {
    return { ok: false, error: "Draft ran long and was cut off. Try again." };
  }

  const text = res.content.find((b) => b.type === "text")?.text;
  if (!text) return { ok: false, error: "The model returned nothing." };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: "The model returned an unreadable draft." };
  }

  const obj = parsed as { body?: unknown };
  const body = typeof obj.body === "string" ? obj.body.trim() : "";
  if (!body) return { ok: false, error: "The model returned an empty draft." };

  // No length enforcement here on purpose: the prompt asks for ≤280 on X, but
  // over-limit output still lands in the textarea where the counter flags it —
  // the owner decides, not this code.
  return { ok: true, body, model: MODEL, promptVersion: PROMPT_VERSION };
}
