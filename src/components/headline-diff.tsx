import { cn } from "@/lib/utils";
import { diffWords } from "@/lib/diff-words";

/**
 * Mesh's headline-change rendering: one inline line where the old wording is
 * struck through and the new wording is highlighted, so the change reads at a
 * glance without showing two full headlines.
 */
export function HeadlineDiff({
  oldValue,
  newValue,
  previousRole,
  className,
}: {
  oldValue: string | null;
  newValue: string | null;
  /**
   * Fallback baseline for contacts imported with a title and company but no
   * headline: their first LinkedIn sync fills `headline` from empty, so the
   * change row has no oldValue and the diff below would have nothing to strike
   * through. The role already on file is what the new headline replaces, so
   * diffing against it is what makes the row read as a change at all.
   */
  previousRole?: string | null;
  className?: string;
}) {
  const before = oldValue ?? previousRole ?? null;

  // Genuinely nothing known before — a first-seen headline is just the new text
  if (!before) {
    return (
      <span className={cn("text-[13px] text-blue-600", className)}>
        {newValue ?? "—"}
      </span>
    );
  }

  const tokens = diffWords(before, newValue ?? "");

  return (
    <span className={cn("text-[13px] leading-relaxed", className)}>
      {tokens.map((t, i) => (
        <span
          key={i}
          // Both sides are highlighted, so the eye reads the swap as one
          // gesture. The trailing space stays inside the span on purpose —
          // it makes adjacent runs butt up against each other with no seam.
          className={
            t.type === "removed"
              ? "bg-stone-200/70 text-stone-500 line-through decoration-stone-400"
              : t.type === "added"
                ? "bg-blue-50 text-blue-600"
                : "text-stone-500"
          }
        >
          {t.text}
          {i < tokens.length - 1 ? " " : ""}
        </span>
      ))}
    </span>
  );
}
