/**
 * Text embeddings for the memory index, via Voyage AI.
 *
 * Voyage rather than Anthropic because Anthropic's API has no embeddings
 * endpoint; Voyage is the provider Anthropic's own docs point to. Plain fetch,
 * no SDK — it is one POST with one response shape, and a dependency would
 * outweigh it.
 *
 * Not a "use server" module: it reads a secret, so it must have no
 * client-callable surface. Server code and scripts import it directly.
 *
 * Privacy note, same class as ANTHROPIC_API_KEY: every chunk this embeds
 * (profiles, notes, meeting summaries) is sent to Voyage. The Setup entry says
 * so, and an unset key simply leaves the index keyword-only.
 */

import { EMBEDDING_DIMENSIONS } from "@/db/schema";
import { getSecret } from "@/lib/secrets";

export const EMBEDDING_MODEL = "voyage-4";

const ENDPOINT = "https://api.voyageai.com/v1/embeddings";

/**
 * Voyage allows 1,000 inputs and 320K tokens per request. 128 chunks of at
 * most ~2,000 characters stays far under the token cap with room for a
 * surprise, and keeps one failed request cheap to retry.
 */
export const EMBED_BATCH = 128;

export type EmbedInputType = "document" | "query";

export class EmbeddingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbeddingError";
  }
}

export async function embeddingKey(): Promise<string | null> {
  return getSecret("VOYAGE_API_KEY");
}

/**
 * Embed up to EMBED_BATCH texts. Returns vectors in input order.
 *
 * `inputType` matters: Voyage prepends a different instruction for queries
 * and documents, and mixing them up measurably hurts retrieval.
 */
export async function embed(
  apiKey: string,
  texts: string[],
  inputType: EmbedInputType,
  timeoutMs = 20_000,
): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (texts.length > EMBED_BATCH) {
    throw new EmbeddingError(`embed() takes at most ${EMBED_BATCH} texts`);
  }

  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        input: texts,
        input_type: inputType,
        output_dimension: EMBEDDING_DIMENSIONS,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new EmbeddingError(
      err instanceof Error && err.name === "TimeoutError"
        ? "Voyage timed out"
        : "Couldn't reach Voyage",
    );
  }

  if (res.status === 401 || res.status === 403) {
    throw new EmbeddingError("Voyage rejected the API key");
  }
  if (res.status === 429) throw new EmbeddingError("Rate limited by Voyage");
  if (!res.ok) throw new EmbeddingError(`Voyage returned HTTP ${res.status}`);

  const body = (await res.json()) as {
    data?: { embedding: number[]; index: number }[];
  };
  const data = body.data ?? [];
  if (data.length !== texts.length) {
    throw new EmbeddingError("Voyage returned the wrong number of vectors");
  }
  // Sorted by index, not trusted to arrive in order.
  const out: number[][] = new Array(texts.length);
  for (const d of data) out[d.index] = d.embedding;
  return out;
}

/** pgvector's text input form: "[0.1,0.2,…]". */
export function toVectorLiteral(v: number[]): string {
  return `[${v.join(",")}]`;
}
