"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { listPeople, type PersonRow } from "@/lib/actions/contacts";
import { PersonAvatar } from "@/components/person-avatar";
import {
  CommandDialog,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";

export function SearchPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [people, setPeople] = useState<PersonRow[] | null>(null);

  useEffect(() => {
    if (open && people === null) {
      listPeople().then(setPeople);
    }
  }, [open, people]);

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Search people"
      description="Jump to a person"
    >
      <CommandInput placeholder="Search people…" />
      <CommandList>
        <CommandEmpty>
          {people === null ? "Loading…" : "No people found."}
        </CommandEmpty>
        {(people ?? [])
          .filter((p) => !p.archived)
          .map((p) => (
            <CommandItem
              key={p.id}
              value={`${p.fullName} ${p.company ?? ""} ${p.title ?? ""}`}
              onSelect={() => {
                onOpenChange(false);
                router.push(`/people?person=${p.id}`);
              }}
            >
              <PersonAvatar
                name={p.fullName}
                photoSrc={p.hasPhoto ? `/api/photos/${p.id}` : null}
                className="size-6"
                textClass="text-[10px]"
              />
              <span className="truncate">{p.fullName}</span>
              {p.company ? (
                <span className="ml-auto truncate pl-3 text-xs text-stone-400">
                  {p.title ? `${p.title} · ` : ""}
                  {p.company}
                </span>
              ) : null}
            </CommandItem>
          ))}
      </CommandList>
    </CommandDialog>
  );
}
