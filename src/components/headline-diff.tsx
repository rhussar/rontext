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
  className,
}: {
  oldValue: string | null;
  newValue: string | null;
  className?: string;
}) {
  // Nothing to diff against — a first-seen headline is just the new text
  if (!oldValue) {
    return (
      <span className={cn("text-[13px] text-blue-600", className)}>
        {newValue ?? "—"}
      </span>
    );
  }

  const tokens = diffWords(oldValue, newValue ?? "");

  return (
    <span className={cn("text-[13px] leading-relaxed", className)}>
      {tokens.map((t, i) => (
        <span
          key={i}
          className={
            t.type === "removed"
              ? "bg-stone-100 text-stone-400 line-through decoration-stone-400"
              : t.type === "added"
                ? "text-blue-600"
                : "text-stone-700"
          }
        >
          {t.text}
          {i < tokens.length - 1 ? " " : ""}
        </span>
      ))}
    </span>
  );
}
