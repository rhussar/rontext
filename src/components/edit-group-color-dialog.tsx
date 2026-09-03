"use client";

import { useTransition } from "react";
import { Plus } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { updateGroupColor } from "@/lib/actions/contacts";
import { GROUP_COLORS } from "@/lib/format";
import type { GroupWithCount } from "@/components/app-shell";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export function EditGroupColorDialog({
  group,
  open,
  onOpenChange,
}: {
  group: GroupWithCount | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [, startTransition] = useTransition();

  function apply(color: string) {
    if (!group) return;
    startTransition(() => updateGroupColor(group.id, color));
    toast.success(`${group.name} is now ${color}`);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xs">
        <DialogHeader>
          <DialogTitle>{group ? `${group.name} color` : "Group color"}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-wrap gap-2 pt-1">
          {GROUP_COLORS.map((color) => (
            <button
              key={color}
              type="button"
              aria-label={color}
              title={color}
              onClick={() => apply(color)}
              className={cn(
                "size-8 rounded-full ring-offset-2 ring-offset-background transition-transform hover:scale-110",
                group?.color === color && "ring-2 ring-blue-500",
              )}
              style={{ backgroundColor: color }}
            />
          ))}
          <label
            className="relative flex size-8 shrink-0 items-center justify-center rounded-full border border-dashed border-muted-foreground/40 text-muted-foreground transition-transform hover:scale-110"
            title="Custom color"
          >
            <input
              type="color"
              defaultValue={group?.color ?? "#f59e0b"}
              onChange={(e) => apply(e.target.value)}
              className="absolute inset-0 size-full cursor-pointer opacity-0"
            />
            <Plus className="size-3.5" />
          </label>
        </div>
      </DialogContent>
    </Dialog>
  );
}
