export type DiffToken = {
  text: string;
  type: "same" | "removed" | "added";
};

/**
 * Word-level diff used to render headline changes the way Mesh does:
 * removed words struck through, added words highlighted, shared words plain.
 *
 * Comparison is case-sensitive on purpose — "pensive" → "Pensive" is a real
 * edit worth showing, and treating it as unchanged would hide the rewrite.
 */
export function diffWords(before: string, after: string): DiffToken[] {
  const a = tokenize(before);
  const b = tokenize(after);

  // Longest common subsequence table over words
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] =
        a[i] === b[j]
          ? lcs[i + 1][j + 1] + 1
          : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const out: DiffToken[] = [];
  const push = (text: string, type: DiffToken["type"]) => {
    const last = out[out.length - 1];
    // Merge runs so "product engineer" is one strikethrough, not two
    if (last && last.type === type) last.text += ` ${text}`;
    else out.push({ text, type });
  };

  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      push(a[i], "same");
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      push(a[i], "removed");
      i++;
    } else {
      push(b[j], "added");
      j++;
    }
  }
  while (i < a.length) push(a[i++], "removed");
  while (j < b.length) push(b[j++], "added");

  return out;
}

function tokenize(s: string): string[] {
  return (s ?? "").trim().split(/\s+/).filter(Boolean);
}
