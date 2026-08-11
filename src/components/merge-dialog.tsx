"use client";

import { useTransition } from "react";
import { Check } from "lucide-react";
import { toast } from "sonner";
import { mergeContacts } from "@/lib/actions/duplicates";
import type { PersonRow } from "@/lib/actions/contacts";
import { displayName } from "@/lib/format";
import { PersonAvatar } from "@/components/person-avatar";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * Ad-hoc merge for two people picked by hand in the list (⌘-click), as opposed
 * to the scored pairs the Duplicates tab proposes. Same server action either
 * way — and same one-way trip: `mergeContacts` hard-deletes the loser, so
 * "Keep this one" is the point of no return, not a staging step.
 */
export function MergeDialog({
  a,
  b,
  open,
  onOpenChange,
  onMerged,
}: {
  a: PersonRow;
  b: PersonRow;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onMerged: (keeperId: number) => void;
}) {
  const [pending, startTransition] = useTransition();

  function merge(keeper: PersonRow, loser: PersonRow) {
    startTransition(async () => {
      await mergeContacts(keeper.id, loser.id);
      toast.success(`Merged into ${displayName(keeper.fullName)}`);
      onMerged(keeper.id);
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Merge these two people?</DialogTitle>
        </DialogHeader>

        {/* grid-cols-1 spelled out for its minmax(0,1fr): an implicit track is
            min-content, which `truncate`'s nowrap would blow past. */}
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <MergeCard
            person={a}
            disabled={pending}
            onKeep={() => merge(a, b)}
          />
          <MergeCard
            person={b}
            disabled={pending}
            onKeep={() => merge(b, a)}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}

function MergeCard({
  person,
  onKeep,
  disabled,
}: {
  person: PersonRow;
  onKeep: () => void;
  disabled: boolean;
}) {
  const details = [
    person.hasLinkedin ? "LinkedIn" : null,
    person.hasNotes ? "Notes" : null,
    person.birthday ? "Birthday" : null,
  ].filter(Boolean) as string[];

  return (
    <div className="flex min-w-0 flex-col gap-2.5 rounded-lg border border-border p-3">
      <div className="flex items-center gap-2.5">
        <PersonAvatar
          name={person.fullName}
          photoSrc={person.hasPhoto ? `/api/photos/${person.id}` : null}
          className="size-9"
        />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[14.5px] font-semibold text-foreground">
            {displayName(person.fullName)}
          </p>
          <p className="truncate text-[12px] text-muted-foreground">
            {[person.title, person.company].filter(Boolean).join(" · ") ||
              "No company on file"}
          </p>
        </div>
      </div>

      {details.length > 0 ? (
        <p className="truncate text-[12px] text-muted-foreground">
          {details.join(" · ")}
        </p>
      ) : null}

      <Button
        size="sm"
        variant="outline"
        className="mt-auto h-8 text-[12.5px]"
        onClick={onKeep}
        disabled={disabled}
      >
        <Check className="size-3.5" />
        Keep this one
      </Button>
    </div>
  );
}
