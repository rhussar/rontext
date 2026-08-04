export type DupCandidate = {
  id: number;
  fullName: string;
  company: string | null;
  title: string | null;
  linkedinUrl: string | null;
  emails: string[];
  phoneNumbers: string[];
  location: string | null;
  createdAt: string;
  noteCount: number;
  hasPhoto: boolean;
};

export type DupReason =
  | "identical"
  | "homoglyph"
  | "typo1"
  | "typo2"
  | "middle-name"
  | "shared-email"
  | "shared-phone";

export type DupPair = {
  a: DupCandidate;
  b: DupCandidate;
  score: number;
  reasons: string[];
  primary: DupReason;
};

const SUFFIXES = /,?\s*\b(cfa|cpa|mba|phd|jr|sr|ii|iii|iv|esq|md|rn|pe)\b\.?/gi;

export function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(SUFFIXES, " ")
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Collapses characters that look alike in common fonts: I/l/1, O/0. */
function foldLookalikes(s: string): string {
  return s.replace(/[l1]/g, "i").replace(/0/g, "o");
}

function normalizeCompany(s: string | null): string {
  if (!s) return "";
  return s
    .toLowerCase()
    .replace(/\b(inc|llc|ltd|corp|corporation|co|company|group|plc|lp|llp)\b\.?/g, "")
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function levenshtein(a: string, b: string, cap = 3): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      rowMin = Math.min(rowMin, cur[j]);
    }
    if (rowMin > cap) return cap + 1;
    prev = cur;
  }
  return prev[b.length];
}

const digits = (s: string) => s.replace(/\D/g, "");

/** A row carrying almost nothing — merging one of these away loses little. */
function isShell(c: DupCandidate): boolean {
  return (
    !c.company &&
    !c.title &&
    !c.linkedinUrl &&
    c.emails.length === 0 &&
    c.phoneNumbers.length === 0 &&
    c.noteCount === 0
  );
}

/**
 * Blocking keys keep this from being a 1.6M-comparison sweep: two records are
 * only compared if they agree on some cheap key. A typo late in the name is
 * caught by the name prefix, one early on by the surname token.
 */
function blockingKeys(c: DupCandidate): string[] {
  const n = normalizeName(c.fullName);
  if (!n) return [];
  const parts = n.split(" ");
  const keys = [`p:${foldLookalikes(n.slice(0, 4))}`];
  if (parts.length > 1) keys.push(`s:${foldLookalikes(parts[parts.length - 1])}`);
  for (const e of c.emails) {
    const v = e.trim().toLowerCase();
    if (v) keys.push(`e:${v}`);
  }
  for (const p of c.phoneNumbers) {
    const d = digits(p);
    if (d.length >= 10) keys.push(`t:${d.slice(-10)}`);
  }
  return keys;
}

function comparePair(a: DupCandidate, b: DupCandidate): DupPair | null {
  const na = normalizeName(a.fullName);
  const nb = normalizeName(b.fullName);
  if (!na || !nb) return null;

  const reasons: string[] = [];
  let primary: DupReason | null = null;
  let score = 0;

  const sharedEmail = a.emails.some((e) =>
    b.emails.some((f) => e.trim().toLowerCase() === f.trim().toLowerCase() && e.trim()),
  );
  const sharedPhone = a.phoneNumbers.some((p) =>
    b.phoneNumbers.some(
      (q) => digits(p).length >= 10 && digits(p).slice(-10) === digits(q).slice(-10),
    ),
  );

  if (sharedEmail) {
    primary = "shared-email";
    score = 100;
    reasons.push("Same email address");
  } else if (sharedPhone) {
    primary = "shared-phone";
    score = 85;
    reasons.push("Same phone number");
  } else if (na === nb) {
    primary = "identical";
    score = 70;
    reasons.push("Identical name");
  } else if (foldLookalikes(na) === foldLookalikes(nb)) {
    primary = "homoglyph";
    score = 78;
    reasons.push("Name differs only by look-alike characters (I/l/0)");
  } else {
    const aParts = na.split(" ");
    const bParts = nb.split(" ");
    const sameEnds =
      aParts.length !== bParts.length &&
      aParts[0] === bParts[0] &&
      aParts[aParts.length - 1] === bParts[bParts.length - 1] &&
      Math.min(aParts.length, bParts.length) >= 2;
    if (sameEnds) {
      primary = "middle-name";
      score = 58;
      reasons.push("Same first and last name, extra middle name");
    } else {
      const d = levenshtein(na, nb);
      if (d === 1 && na.length > 6) {
        primary = "typo1";
        score = 46;
        reasons.push("Names differ by one character");
      } else if (d === 2 && na.length > 12) {
        primary = "typo2";
        score = 24;
        reasons.push("Names differ by two characters");
      }
    }
  }

  if (!primary) return null;

  // Two distinct LinkedIn profiles is the strongest evidence these are simply
  // different people — that column is unique, so they can't be one record.
  if (a.linkedinUrl && b.linkedinUrl && a.linkedinUrl !== b.linkedinUrl) {
    score -= 45;
    reasons.push("Both have their own LinkedIn profile — likely different people");
  }

  const ca = normalizeCompany(a.company);
  const cb = normalizeCompany(b.company);
  if (ca && cb) {
    if (ca === cb) {
      score += 22;
      reasons.push("Same company");
    } else {
      score -= 18;
      reasons.push("Different companies");
    }
  }

  if (isShell(a) || isShell(b)) {
    score += 18;
    reasons.push("One record is nearly empty");
  }

  if (a.location && b.location && a.location === b.location) {
    score += 8;
    reasons.push("Same location");
  }

  score = Math.max(0, Math.min(100, score));
  return { a, b, score, reasons, primary };
}

export const DUP_MIN_SCORE = 25;

export function findDuplicates(
  contacts: DupCandidate[],
  dismissed: Set<string> = new Set(),
): DupPair[] {
  const buckets = new Map<string, DupCandidate[]>();
  for (const c of contacts) {
    for (const key of blockingKeys(c)) {
      const arr = buckets.get(key);
      if (arr) arr.push(c);
      else buckets.set(key, [c]);
    }
  }

  const seen = new Set<string>();
  const pairs: DupPair[] = [];
  for (const group of buckets.values()) {
    if (group.length < 2 || group.length > 60) continue; // huge buckets are noise
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const [a, b] =
          group[i].id < group[j].id ? [group[i], group[j]] : [group[j], group[i]];
        const key = `${a.id}-${b.id}`;
        if (seen.has(key) || dismissed.has(key)) continue;
        seen.add(key);
        const pair = comparePair(a, b);
        if (pair && pair.score >= DUP_MIN_SCORE) pairs.push(pair);
      }
    }
  }
  return pairs.sort((x, y) => y.score - x.score);
}

export function confidenceLabel(score: number): "high" | "medium" | "low" {
  if (score >= 70) return "high";
  if (score >= 45) return "medium";
  return "low";
}
