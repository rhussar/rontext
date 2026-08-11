/**
 * Deterministic normalization — the zero-token first pass.
 *
 * Runs before the LLM ever sees a string. Rules handle the mechanical cases
 * (legal suffixes, punctuation, duplicated country tokens) and a hand-seeded
 * alias table handles the clusters we already know are in this dataset:
 * the Syracuse family (33 distinct strings, 120 people) and the Big 4.
 *
 * Seeding the obvious aliases by hand is faster and far more reliable than
 * asking a model to rediscover them. The LLM only sees what's left over.
 */

import type { EntityType } from "@/db/schema";

/* ------------------------------------------------------------------ *
 * Generic string normalization
 * ------------------------------------------------------------------ */

/**
 * Legal-form suffixes only. Deliberately conservative — "Group", "Holdings"
 * and "International" are NOT stripped, since they distinguish real firms
 * ("Oxford Capital Group" vs "Oxford Capital"). Known exceptions are handled
 * by the seed table instead.
 */
const LEGAL_SUFFIXES = [
  "inc",
  "llc",
  "l l c",
  "llp",
  "l l p",
  "ltd",
  "limited",
  "corp",
  "corporation",
  "plc",
  "pllc",
  "pc",
  "lp",
  "gmbh",
  "s a",
  "n v",
  "b v",
  "ag",
  "pty",
];

/**
 * Canonical dedupe key for a company/school string.
 * "Oxford Capital Group, LLC" -> "oxford capital group"
 * "Beta Alpha Psi International (BAP)" -> "beta alpha psi international"
 */
export function normalizeOrgKey(raw: string): string {
  let s = raw.toLowerCase().trim();

  // Drop parentheticals — usually acronyms: "Beta Alpha Psi International (BAP)"
  s = s.replace(/\([^)]*\)/g, " ");

  // Normalize separators and symbols
  s = s.replace(/[&]/g, " and ");
  s = s.replace(/[''`]/g, "");
  s = s.replace(/[–—]/g, "-");
  s = s.replace(/[^a-z0-9-]+/g, " ");
  s = s.replace(/\s*-\s*/g, " - ");
  s = s.replace(/\s+/g, " ").trim();

  // Leading article
  s = s.replace(/^the\s+/, "");

  // Trailing legal suffixes, repeatedly ("Foo Holdings Inc, LLC")
  let changed = true;
  while (changed) {
    changed = false;
    for (const suf of LEGAL_SUFFIXES) {
      const re = new RegExp(`(?:\\s|^)${suf.replace(/ /g, "\\s")}$`);
      if (re.test(s)) {
        s = s.replace(re, "").trim();
        changed = true;
      }
    }
  }

  return s.replace(/\s+/g, " ").replace(/\s*-\s*$/, "").trim();
}

/* ------------------------------------------------------------------ *
 * Seeded aliases
 *
 * `match` patterns are tested against the NORMALIZED key. Order matters —
 * the first matching seed wins, so put specific entries before general ones
 * (Whitman before the generic Syracuse catch-all).
 * ------------------------------------------------------------------ */

export type OrgSeed = {
  /**
   * Canonical display name. Omit to keep the original string as its own entity
   * — used by catch-all seeds whose only job is to assign a parent. Merging
   * unrelated orgs under one name creates false hubs, so a catch-all must
   * never supply a name.
   */
  name?: string;
  type: EntityType;
  /** Canonical name of the parent entity, if this rolls up */
  parent?: string;
  /** Tested against the normalized key */
  match: RegExp;
  /** Coarse industry, when unambiguous — saves the LLM a call */
  industry?: string;
  /**
   * Primary web domain, used to fetch the company logo. Only needed for orgs
   * we never see an email address for — most of the recognizable brands here
   * are known by name only, so without this they'd have no logo.
   */
  domain?: string;
};

export const ORG_SEEDS: OrgSeed[] = [
  /* --- Syracuse family -------------------------------------------------
     33 distinct strings in this dataset, 120 people. Children stay as their
     own entities so pathfinding keeps the specific 10-person OVF link; the
     parent only adds the coarser cluster. */
  {
    name: "Syracuse University",
    domain: "syracuse.edu",
    type: "school",
    match: /^syracuse university$|^syracuse orange$|^syracuse university records$/,
    industry: "Education",
  },
  {
    name: "Whitman School of Management",
    domain: "whitman.syr.edu",
    type: "school",
    parent: "Syracuse University",
    match: /whitman/,
    industry: "Education",
  },
  {
    name: "Orange Value Fund",
    domain: "orangevaluefund.com",
    type: "group",
    parent: "Syracuse University",
    // "OVF" is how the user's own group is named — same org, must not fork
    match: /^orange value fund|^ovf$/,
    industry: "Investment Management",
  },
  {
    name: "Beta Alpha Psi",
    domain: "bap.org",
    type: "group",
    parent: "Syracuse University",
    match: /^beta alpha psi/,
    industry: "Accounting",
  },
  {
    name: "Delta Sigma Pi",
    domain: "deltasigmapi.org",
    type: "group",
    parent: "Syracuse University",
    match: /^delta sigma pi/,
  },
  {
    name: "The Daily Orange",
    domain: "dailyorange.com",
    type: "group",
    parent: "Syracuse University",
    match: /^daily orange$/,
    industry: "Media",
  },
  {
    name: "Syracuse University Athletics",
    type: "group",
    parent: "Syracuse University",
    match: /^syracuse university athletics/,
  },
  {
    name: "Maxwell School",
    type: "school",
    parent: "Syracuse University",
    match: /maxwell school/,
    industry: "Education",
  },
  {
    name: "Syracuse Engineering & Computer Science",
    type: "school",
    parent: "Syracuse University",
    match: /college of engineering and computer science/,
    industry: "Education",
  },
  /**
   * Catch-all for the ~20 remaining Syracuse clubs, offices and chapters.
   * No `name` — each keeps its own identity and only inherits the parent.
   * Collapsing them into one node would fuse Hillel, the Skateboarding Club
   * and the Interfraternity Council into a single 35-person hub and invent
   * hundreds of connections that don't exist.
   *
   * "City of Syracuse" is excluded — a municipality, not a university org.
   */
  {
    type: "group",
    parent: "Syracuse University",
    match: /^(?!city of syracuse)(.*syracuse|.*suny-esf|couri hatchery|mary ann shaw|kappa theta pi)/,
  },

  /* --- Big 4 + RSM (74 people) ----------------------------------------- */
  {
    name: "KPMG",
    domain: "kpmg.com",
    type: "company",
    match: /^kpmg\b/,
    industry: "Accounting",
  },
  {
    name: "Deloitte",
    domain: "deloitte.com",
    type: "company",
    match: /^deloitte\b/,
    industry: "Accounting",
  },
  {
    name: "PwC",
    domain: "pwc.com",
    type: "company",
    match: /^pwc\b|^pricewaterhouse/,
    industry: "Accounting",
  },
  {
    name: "EY",
    domain: "ey.com",
    type: "company",
    match: /^ey\b|^ernst and young/,
    industry: "Accounting",
  },
  {
    name: "RSM US",
    domain: "rsmus.com",
    type: "company",
    match: /^rsm\b/,
    industry: "Accounting",
  },
  {
    name: "Grant Thornton",
    domain: "grantthornton.com",
    type: "company",
    match: /^grant thornton/,
    industry: "Accounting",
  },
  {
    name: "BDO",
    domain: "bdo.com",
    type: "company",
    match: /^bdo\b/,
    industry: "Accounting",
  },

  /* --- Banks / finance -------------------------------------------------- */
  { name: "Goldman Sachs",
    domain: "goldmansachs.com", type: "company", match: /^goldman sachs/, industry: "Investment Banking" },
  { name: "Morgan Stanley",
    domain: "morganstanley.com", type: "company", match: /^morgan stanley/, industry: "Investment Banking" },
  { name: "J.P. Morgan",
    domain: "jpmorgan.com", type: "company", match: /^j ?p ?morgan|^jpmorgan|^chase\b/, industry: "Investment Banking" },
  { name: "Bank of America",
    domain: "bankofamerica.com", type: "company", match: /^bank of america|^bofa\b|^merrill lynch/, industry: "Investment Banking" },
  { name: "Citi",
    domain: "citi.com", type: "company", match: /^citi(group|bank)?$/, industry: "Investment Banking" },
  { name: "Fidelity Investments",
    domain: "fidelity.com", type: "company", match: /^fidelity\b/, industry: "Investment Management" },
  { name: "Lincoln International",
    domain: "lincolninternational.com", type: "company", match: /^lincoln international/, industry: "Investment Banking" },
  { name: "Oxford Capital Group",
    domain: "oxfordcapitalgroup.com", type: "company", match: /^oxford capital/, industry: "Real Estate" },

  /* --- Consulting ------------------------------------------------------- */
  { name: "McKinsey & Company",
    domain: "mckinsey.com", type: "company", match: /^mckinsey/, industry: "Consulting" },
  { name: "Bain & Company",
    domain: "bain.com", type: "company", match: /^bain and company|^bain$/, industry: "Consulting" },
  { name: "Boston Consulting Group",
    domain: "bcg.com", type: "company", match: /^boston consulting|^bcg$/, industry: "Consulting" },
  { name: "Accenture",
    domain: "accenture.com", type: "company", match: /^accenture/, industry: "Consulting" },
  { name: "Aon",
    domain: "aon.com", type: "company", match: /^aon\b/, industry: "Insurance" },

  /* --- Real estate / hospitality (a large slice of this network) --------- */
  { name: "JLL",
    domain: "jll.com", type: "company", match: /^jll\b|^jones lang lasalle/, industry: "Real Estate" },
  { name: "CBRE",
    domain: "cbre.com", type: "company", match: /^cbre\b/, industry: "Real Estate" },
  { name: "Cushman & Wakefield",
    domain: "cushmanwakefield.com", type: "company", match: /^cushman/, industry: "Real Estate" },
  { name: "Marriott",
    domain: "marriott.com", type: "company", match: /^marriott/, industry: "Hospitality" },
  { name: "Hilton",
    domain: "hilton.com", type: "company", match: /^hilton\b/, industry: "Hospitality" },

  /* --- Tech ------------------------------------------------------------- */
  { name: "Google",
    domain: "google.com", type: "company", match: /^google$|^alphabet$/, industry: "Technology" },
  { name: "Microsoft",
    domain: "microsoft.com", type: "company", match: /^microsoft/, industry: "Technology" },
  { name: "Amazon",
    domain: "amazon.com", type: "company", match: /^amazon(\s|$)|^aws$/, industry: "Technology" },
  { name: "Meta",
    domain: "meta.com", type: "company", match: /^meta$|^facebook$/, industry: "Technology" },
  { name: "Apple",
    domain: "apple.com", type: "company", match: /^apple$/, industry: "Technology" },
  { name: "SpaceX",
    domain: "spacex.com", type: "company", match: /^spacex$/, industry: "Aerospace" },
];

/**
 * Employment states that are not organizations. Two people who both wrote
 * "Self-employed" are not colleagues, so turning these into hubs invents
 * connections — the same false-hub failure the catch-all seed caused.
 */
const NON_ORGANIZATIONS = [
  /^self[\s-]?employed$/,
  /^freelance(r)?$/,
  /^stealth(\s+(mode|startup))?$/,
  /^retired$/,
  /^student$/,
  /^unemployed$/,
  /^none$/,
  /^n\s?\/?\s?a$/,
  /^independent(\s+consultant)?$/,
  /^various$/,
  /^multiple$/,
  /^confidential$/,
  /^private$/,
  /^open to work$/,
  /^seeking (new )?opportunities$/,
  /^looking for (work|opportunities)$/,
];

/** True when the string describes an employment state, not an employer. */
export function isNonOrganization(raw: string): boolean {
  const key = normalizeOrgKey(raw);
  if (!key) return true;
  return NON_ORGANIZATIONS.some((re) => re.test(key));
}

/** First matching seed for a raw org string, or null. */
export function matchOrgSeed(raw: string): OrgSeed | null {
  const key = normalizeOrgKey(raw);
  if (!key) return null;
  return ORG_SEEDS.find((s) => s.match.test(key)) ?? null;
}

/* ------------------------------------------------------------------ *
 * Locations
 *
 * Real strings look like "Chicago Illinois United States" — space-separated,
 * no delimiters, and some have a duplicated country ("Nashville Tennessee
 * United States United States"). We roll suburbs up to a metro.
 * ------------------------------------------------------------------ */

const METRO_SEEDS: { name: string; match: RegExp }[] = [
  { name: "Chicago", match: /^(chicago|greater chicago|naperville|glen ellyn|bensenville|cicero|evanston|oak park|schaumburg)/ },
  { name: "New York City", match: /^(new york|nyc|greater new york|westbury|pelham|huntington station|brooklyn|queens|bronx|manhattan|long island)/ },
  { name: "Syracuse", match: /^(syracuse|greater syracuse|fayetteville|skaneateles|liverpool|cicero new york)/ },
  { name: "Los Angeles", match: /^(los angeles|beverly hills|santa monica|pasadena|burbank|greater los angeles)/ },
  { name: "Boston", match: /^(boston|greater boston|cambridge|swampscott|somerville|brookline|newton)/ },
  { name: "Detroit", match: /^(detroit|greater detroit|southfield|livonia|dearborn|franklin michigan|troy michigan|ann arbor)/ },
  { name: "San Francisco Bay Area", match: /^(san francisco|bay area|palo alto|stanford|mountain view|san jose|oakland|berkeley|menlo park)/ },
  { name: "Washington DC", match: /^(washington|bethesda|rockville|arlington virginia|alexandria virginia|silver spring)/ },
  { name: "Philadelphia", match: /^(philadelphia|greater philadelphia|collegeville|king of prussia)/ },
  { name: "Raleigh-Durham", match: /^(raleigh|durham|chapel hill)/ },
  { name: "Seattle", match: /^(seattle|bellevue|redmond|greater seattle)/ },
  { name: "Miami", match: /^(miami|miami beach|fort lauderdale)/ },
  { name: "Atlanta", match: /^atlanta/ },
  { name: "Denver", match: /^denver/ },
  { name: "Nashville", match: /^nashville/ },
  { name: "Charlotte", match: /^charlotte/ },
  { name: "Connecticut", match: /^(greenwich|new haven|stamford|hartford)/ },
];

const COUNTRY_TOKENS = [
  "united states",
  "united kingdom",
  "india",
  "netherlands",
  "taiwan",
  "australia",
  "canada",
  "singapore",
  "germany",
  "france",
];

export type NormalizedPlace = {
  /** Metro-level canonical name, e.g. "Chicago" */
  metro: string;
  /** Country, when we could identify one */
  country: string | null;
  normalizedKey: string;
};

/**
 * "Greater Chicago Area United States" -> { metro: "Chicago", country: "United States" }
 * "Nashville Tennessee United States United States" -> { metro: "Nashville", ... }
 */
export function normalizePlace(raw: string): NormalizedPlace | null {
  let s = raw.toLowerCase().trim().replace(/[^a-z0-9- ]+/g, " ").replace(/\s+/g, " ");
  if (!s) return null;

  // Strip trailing country tokens, repeatedly — the data has duplicates
  let country: string | null = null;
  let stripped = true;
  while (stripped) {
    stripped = false;
    for (const c of COUNTRY_TOKENS) {
      if (s.endsWith(` ${c}`) || s === c) {
        country ??= c.replace(/\b\w/g, (m) => m.toUpperCase());
        s = s.slice(0, s.length - c.length).trim();
        stripped = true;
      }
    }
  }

  // "Greater X Area" / "X Metropolitan Area" -> X
  s = s.replace(/\bmetropolitan area\b/, "").replace(/\barea\b/, "").trim();

  if (!s) {
    // The whole string was a country, e.g. "Chandigarh India" -> handled above,
    // but a bare "United States" leaves nothing usable.
    return country ? { metro: country, country, normalizedKey: normalizeOrgKey(country) } : null;
  }

  const seed = METRO_SEEDS.find((m) => m.match.test(s));
  const metro = seed
    ? seed.name
    : // Fall back to the leading token(s) before a US state name, title-cased.
      s.replace(/\s+/g, " ").trim().replace(/\b\w/g, (m) => m.toUpperCase());

  return {
    metro,
    country: country ?? null,
    normalizedKey: normalizeOrgKey(metro),
  };
}

/* ------------------------------------------------------------------ *
 * Email domains -> company hints
 * ------------------------------------------------------------------ */

/** Free/consumer providers that say nothing about employment. */
const CONSUMER_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "ymail.com", "hotmail.com",
  "outlook.com", "live.com", "msn.com", "aol.com", "icloud.com", "me.com",
  "mac.com", "proton.me", "protonmail.com", "comcast.net", "verizon.net",
  "sbcglobal.net", "att.net", "gmx.com", "mail.com", "zoho.com",
]);

/**
 * Employer-ish domain from an email, or null for consumer providers.
 * "r.hussar@kpmg.com" -> "kpmg.com"; ".edu" domains are returned too since
 * they're a strong school signal.
 */
export function employerDomain(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at < 0) return null;
  const domain = email.slice(at + 1).toLowerCase().trim();
  if (!domain || !domain.includes(".")) return null;
  if (CONSUMER_DOMAINS.has(domain)) return null;
  return domain;
}

/** True when the domain is an academic one — maps to a school, not a company. */
export function isAcademicDomain(domain: string): boolean {
  return /\.edu$|\.ac\.[a-z]{2}$|\.edu\.[a-z]{2}$/.test(domain);
}

/* ------------------------------------------------------------------ *
 * Turning email domains into readable organizations
 * ------------------------------------------------------------------ */

/**
 * Domains whose organization can't be derived from the string itself.
 * Short or abbreviated domains ("syr.edu") never match by prefix, so they'd
 * otherwise stay on the canvas as raw hostnames.
 */
const DOMAIN_SEEDS: Record<string, string> = {
  "syr.edu": "Syracuse University",
  "yale.edu": "Yale University",
  "ohrllc.com": "Oxford Capital Group", // Oxford Hotels & Resorts
  "oxfordliving.ca": "Oxford Capital Group",
  "oxford-capital.com": "Oxford Capital Group",
};

/** Explicit domain → canonical org name, or null. */
export function seededDomainOrg(domain: string): string | null {
  return DOMAIN_SEEDS[domain.toLowerCase()] ?? null;
}

/**
 * The comparable core of a domain: no TLD, no punctuation, no legal suffix.
 * "hunterpasteurhomes.com" -> "hunterpasteurhomes", "norconinc.com" -> "norcon"
 */
export function domainBase(domain: string): string {
  let s = domain.toLowerCase().replace(/^www\./, "");
  s = s.replace(/\.[a-z.]{2,}$/, ""); // strip TLD (incl. .co.uk)
  s = s.replace(/[^a-z0-9]/g, "");
  s = s.replace(/(inc|llc|llp|corp|ltd|co)$/, "");
  return s;
}

/** Same compaction applied to an entity name, so the two are comparable. */
export function compactOrgKey(normalizedKey: string): string {
  return normalizedKey.replace(/[^a-z0-9]/g, "");
}

/**
 * Human-readable fallback when a domain matches no known organization.
 * Splits on separators and title-cases; short tokens are treated as acronyms.
 * "elkus-manfredi.com" -> "Elkus Manfredi", "gma-la.com" -> "GMA LA"
 *
 * Compound single-token domains ("godfreyhoteldetroit") can't be split without
 * a dictionary, so they title-case as one word — still better than showing a
 * raw hostname on the canvas.
 */
export function prettyDomainName(domain: string): string {
  const stem = domain.toLowerCase().replace(/^www\./, "").replace(/\.[a-z.]{2,}$/, "");
  return stem
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((t) => (t.length <= 3 ? t.toUpperCase() : t[0].toUpperCase() + t.slice(1)))
    .join(" ");
}
