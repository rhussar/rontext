"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, ChevronsUpDown } from "lucide-react";
import { toast } from "sonner";
import { addNote, listPeople, type PersonRow } from "@/lib/actions/contacts";
import { PersonAvatar } from "@/components/person-avatar";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";

export function NewNoteDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [people, setPeople] = useState<PersonRow[] | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [person, setPerson] = useState<PersonRow | null>(null);
  const [body, setBody] = useState("");
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (open && people === null) listPeople().then(setPeople);
  }, [open, people]);

  function submit() {
    if (!person || !body.trim()) return;
    startTransition(async () => {
      await addNote(person.id, body);
      toast.success(`Note added for ${person.fullName}`);
      setBody("");
      setPerson(null);
      onOpenChange(false);
      router.push(`/people?person=${person.id}`);
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>New note</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
            <PopoverTrigger
              render={
                <Button
                  variant="outline"
                  className="justify-start gap-2 font-normal"
                >
                  {person ? (
                    <>
                      <PersonAvatar
                        name={person.fullName}
                        className="size-5"
                        textClass="text-[9px]"
                      />
                      {person.fullName}
                    </>
                  ) : (
                    <span className="text-stone-400">Choose a person…</span>
                  )}
                  <ChevronsUpDown className="ml-auto size-4 text-stone-400" />
                </Button>
              }
            />
            <PopoverContent className="w-[var(--anchor-width)] p-0" align="start">
              <Command>
                <CommandInput placeholder="Search people…" />
                <CommandList className="max-h-56">
                  <CommandEmpty>
                    {people === null ? "Loading…" : "No people found."}
                  </CommandEmpty>
                  {(people ?? [])
                    .filter((p) => !p.archived)
                    .map((p) => (
                      <CommandItem
                        key={p.id}
                        value={`${p.fullName} ${p.company ?? ""}`}
                        onSelect={() => {
                          setPerson(p);
                          setPickerOpen(false);
                        }}
                      >
                        <PersonAvatar
                          name={p.fullName}
                          className="size-5"
                          textClass="text-[9px]"
                        />
                        <span className="truncate">{p.fullName}</span>
                        {p.id === person?.id ? (
                          <Check className="ml-auto size-4" />
                        ) : null}
                      </CommandItem>
                    ))}
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>

          <Textarea
            placeholder={
              person
                ? `What do you want to remember about ${person.firstName ?? person.fullName}?`
                : "Write your note…"
            }
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={5}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submit();
            }}
          />
          <Button onClick={submit} disabled={pending || !person || !body.trim()}>
            {pending ? "Saving…" : "Save note"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
