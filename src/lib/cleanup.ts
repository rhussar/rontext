const PARTICLES = new Set(["de", "la", "van", "von", "del", "der", "di", "da"]);

const ROLE_ADDRESSES =
  /^(info|hello|contact|admin|support|sales|team|no-?reply|help|office|billing|careers)$/i;

/**
 * "aaron.black@godfreyhoteldetroit.com" -> "Aaron Black". Returns null when the
 * local part carries no usable name — initials, digit soup, or a role address.
 */
export function nameFromEmail(email: string): string | null {
  const local = email.split("@")[0] ?? "";
  if (!local || ROLE_ADDRESSES.test(local)) return null;

  const tokens = local
    // Digits often stand in for a separator ("alexa5anastasi"), so split on them too.
    .replace(/\d+/g, " ")
    .split(/[._\-+\s]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 1);
  if (tokens.length < 2) return null;

  return tokens.map(capitalize).join(" ");
}

function capitalize(token: string): string {
  const lower = token.toLowerCase();
  if (PARTICLES.has(lower)) return lower;
  // "mccurry" -> "McCurry", "obrien" stays put (too ambiguous to guess)
  if (/^mc[a-z]{2,}$/.test(lower)) {
    return "Mc" + lower[2].toUpperCase() + lower.slice(3);
  }
  if (/^o'[a-z]{2,}$/.test(lower)) {
    return "O'" + lower[2].toUpperCase() + lower.slice(3);
  }
  return lower[0].toUpperCase() + lower.slice(1);
}
