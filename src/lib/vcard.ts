export type ParsedPerson = {
  fullName: string;
  firstName: string | null;
  lastName: string | null;
  emails: string[];
  phoneNumbers: string[];
  company: string | null;
  title: string | null;
  birthday: string | null; // YYYY-MM-DD
  location: string | null;
  note: string | null;
  linkedinUrl: string | null;
};

/** Unfold RFC 6350 continuation lines (a leading space/tab continues the previous line). */
function unfold(text: string): string[] {
  const raw = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const out: string[] = [];
  for (const line of raw) {
    if (/^[ \t]/.test(line) && out.length) {
      out[out.length - 1] += line.slice(1);
    } else {
      out.push(line);
    }
  }
  return out;
}

function decodeQuotedPrintable(s: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "=" && i + 2 < s.length) {
      const hex = s.slice(i + 1, i + 3);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        bytes.push(parseInt(hex, 16));
        i += 2;
        continue;
      }
    }
    bytes.push(s.charCodeAt(i));
  }
  try {
    return new TextDecoder("utf-8").decode(new Uint8Array(bytes));
  } catch {
    return s;
  }
}

/** vCard escapes , ; and \ inside values, and uses \n for newlines. */
function unescapeValue(s: string): string {
  return s
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");
}

/** Split on a delimiter that isn't backslash-escaped. */
function splitUnescaped(s: string, delim: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && i + 1 < s.length) {
      cur += s[i] + s[i + 1];
      i++;
    } else if (s[i] === delim) {
      out.push(cur);
      cur = "";
    } else {
      cur += s[i];
    }
  }
  out.push(cur);
  return out;
}

/**
 * Normalize the date shapes vCard actually ships: 1990-06-17, 19900617, and the
 * no-year forms Apple writes for "birthday without a year" (--0617, 1604-06-17).
 * Returns null for a missing year rather than inventing one.
 */
export function parseVcardDate(raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  // Apple's placeholder year for "no year given"
  m = /^1604-(\d{2})-(\d{2})/.exec(v);
  if (m) return `1604-${m[1]}-${m[2]}`;
  m = /^--(\d{2})-?(\d{2})$/.exec(v);
  if (m) return `1604-${m[1]}-${m[2]}`;
  return null;
}

type Prop = { name: string; params: Record<string, string>; value: string };

function parseLine(line: string): Prop | null {
  const colon = (() => {
    let inQuote = false;
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '"') inQuote = !inQuote;
      else if (line[i] === ":" && !inQuote) return i;
    }
    return -1;
  })();
  if (colon < 0) return null;

  const head = line.slice(0, colon);
  let value = line.slice(colon + 1);
  const segments = head.split(";");
  // Strip any group prefix ("item1.EMAIL" -> "EMAIL")
  const name = segments[0].split(".").pop()!.toUpperCase();

  const params: Record<string, string> = {};
  for (const seg of segments.slice(1)) {
    const eq = seg.indexOf("=");
    if (eq < 0) params[seg.toUpperCase()] = "";
    else
      params[seg.slice(0, eq).toUpperCase()] = seg
        .slice(eq + 1)
        .replace(/^"|"$/g, "");
  }

  if ((params.ENCODING ?? "").toUpperCase().includes("QUOTED-PRINTABLE")) {
    value = decodeQuotedPrintable(value);
  }
  return { name, params, value };
}

export function parseVcards(text: string): ParsedPerson[] {
  const lines = unfold(text);
  const people: ParsedPerson[] = [];
  let cur: ParsedPerson | null = null;

  const blank = (): ParsedPerson => ({
    fullName: "",
    firstName: null,
    lastName: null,
    emails: [],
    phoneNumbers: [],
    company: null,
    title: null,
    birthday: null,
    location: null,
    note: null,
    linkedinUrl: null,
  });

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^BEGIN:VCARD$/i.test(trimmed)) {
      cur = blank();
      continue;
    }
    if (/^END:VCARD$/i.test(trimmed)) {
      if (cur) {
        if (!cur.fullName) {
          cur.fullName =
            [cur.firstName, cur.lastName].filter(Boolean).join(" ") ||
            cur.emails[0] ||
            cur.phoneNumbers[0] ||
            "";
        }
        if (cur.fullName) people.push(cur);
      }
      cur = null;
      continue;
    }
    if (!cur) continue;

    const prop = parseLine(trimmed);
    if (!prop) continue;
    const value = unescapeValue(prop.value).trim();
    if (!value) continue;

    switch (prop.name) {
      case "FN":
        cur.fullName = value;
        break;
      case "N": {
        // Family;Given;Additional;Prefix;Suffix
        const parts = splitUnescaped(prop.value, ";").map((p) =>
          unescapeValue(p).trim(),
        );
        cur.lastName = parts[0] || null;
        cur.firstName = parts[1] || null;
        break;
      }
      case "EMAIL":
        if (!cur.emails.includes(value)) cur.emails.push(value);
        break;
      case "TEL":
        if (!cur.phoneNumbers.includes(value)) cur.phoneNumbers.push(value);
        break;
      case "ORG":
        cur.company = splitUnescaped(prop.value, ";")
          .map((p) => unescapeValue(p).trim())
          .filter(Boolean)[0] ?? null;
        break;
      case "TITLE":
        cur.title = value;
        break;
      case "BDAY":
        cur.birthday = parseVcardDate(value);
        break;
      case "ADR": {
        // PO;Ext;Street;Locality;Region;Postal;Country — city/region/country read best
        const parts = splitUnescaped(prop.value, ";").map((p) =>
          unescapeValue(p).trim(),
        );
        const loc = [parts[3], parts[4], parts[6]].filter(Boolean).join(", ");
        if (loc) cur.location = loc;
        break;
      }
      case "NOTE":
        cur.note = value;
        break;
      case "URL":
        if (/linkedin\.com/i.test(value)) cur.linkedinUrl = value;
        break;
    }
  }
  return people;
}

// ---------- Google Contacts CSV ----------

const pick = (row: Record<string, string>, ...names: string[]): string => {
  for (const n of names) {
    const v = row[n.toLowerCase()];
    if (v && v.trim()) return v.trim();
  }
  return "";
};

/** Collect every "E-mail 1 - Value", "E-mail 2 - Value", … column. */
function collectNumbered(
  row: Record<string, string>,
  pattern: RegExp,
): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(row)) {
    if (!v?.trim()) continue;
    if (pattern.test(k)) {
      for (const part of v.split(":::")) {
        const t = part.trim();
        if (t && !out.includes(t)) out.push(t);
      }
    }
  }
  return out;
}

export function isGoogleContactsCsv(headers: string[]): boolean {
  const h = headers.map((x) => x.toLowerCase());
  return (
    h.includes("given name") ||
    h.some((x) => /^e-?mail \d+ - value$/.test(x)) ||
    (h.includes("first name") && h.some((x) => /^e-?mail \d+ - value$/.test(x)))
  );
}

export function parseGoogleCsvRow(row: Record<string, string>): ParsedPerson {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(row)) lower[k.trim().toLowerCase()] = v;

  const first = pick(lower, "Given Name", "First Name");
  const last = pick(lower, "Family Name", "Last Name");
  const full =
    pick(lower, "Name", "Display Name") ||
    [first, last].filter(Boolean).join(" ");

  return {
    fullName: full,
    firstName: first || null,
    lastName: last || null,
    emails: collectNumbered(lower, /^e-?mail \d+ - value$/),
    phoneNumbers: collectNumbered(lower, /^phone \d+ - value$/),
    company: pick(lower, "Organization 1 - Name", "Organization Name") || null,
    title: pick(lower, "Organization 1 - Title", "Organization Title") || null,
    birthday: parseVcardDate(pick(lower, "Birthday")),
    location:
      [
        pick(lower, "Address 1 - City"),
        pick(lower, "Address 1 - Region"),
        pick(lower, "Address 1 - Country"),
      ]
        .filter(Boolean)
        .join(", ") || null,
    note: pick(lower, "Notes") || null,
    linkedinUrl:
      collectNumbered(lower, /^website \d+ - value$/).find((u) =>
        /linkedin\.com/i.test(u),
      ) ?? null,
  };
}
