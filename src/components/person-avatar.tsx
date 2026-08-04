import { cn } from "@/lib/utils";
import { avatarColor, initials } from "@/lib/format";

export function PersonAvatar({
  name,
  className,
  textClass,
}: {
  name: string;
  className?: string;
  textClass?: string;
}) {
  return (
    <div
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full text-white",
        avatarColor(name),
        className ?? "size-8",
      )}
    >
      <span className={cn("font-medium leading-none", textClass ?? "text-[12px]")}>
        {initials(name)}
      </span>
    </div>
  );
}
