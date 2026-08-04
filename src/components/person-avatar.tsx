import { cn } from "@/lib/utils";
import { avatarColor, initials } from "@/lib/format";

export function PersonAvatar({
  name,
  photoSrc,
  className,
  textClass,
}: {
  name: string;
  /** Pass only when the contact actually has a photo (e.g. `/api/photos/<id>`). */
  photoSrc?: string | null;
  className?: string;
  textClass?: string;
}) {
  if (photoSrc) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={photoSrc}
        alt={name}
        className={cn(
          "shrink-0 rounded-full object-cover",
          className ?? "size-8",
        )}
      />
    );
  }
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
