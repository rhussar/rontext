/**
 * Draft provenance, shared by the server actions, the MCP route and the UI.
 *
 * Rontext no longer writes drafts itself — agents do, through MCP
 * `create_draft`, and those rows are tagged source = "ai" with the text they
 * arrived with. That original is what lets "you edited this" be *derived*
 * rather than stored. Not a "use server" module, so client components can
 * import isEdited().
 */

export type DraftOrigin = {
  generatedBody: string;
  generatedSubject: string | null;
  model: string;
  promptVersion: number;
};

/** True when the owner has changed anything the agent wrote. */
export function isEdited(d: {
  source: string;
  body: string;
  subject: string | null;
  generatedBody: string | null;
  generatedSubject: string | null;
}): boolean {
  if (d.source !== "ai" || d.generatedBody === null) return false;
  if (d.body.trim() !== d.generatedBody.trim()) return true;
  return (d.subject ?? "").trim() !== (d.generatedSubject ?? "").trim();
}
