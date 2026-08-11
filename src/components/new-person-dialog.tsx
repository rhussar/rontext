"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, Plus, X } from "lucide-react";
import { toast } from "sonner";
import { createContact, type ContactInput } from "@/lib/actions/contacts";
import {
  importContactPhotoFromUrl,
  uploadContactPhoto,
} from "@/lib/actions/photos";
import type { ClipboardImage } from "@/lib/clipboard-image";
import type { GroupWithCount } from "@/components/app-shell";
import { PhotoPicker } from "@/components/photo-picker";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

const OPTIONAL_FIELDS = [
  { key: "email", label: "Email" },
  { key: "phone", label: "Phone" },
  { key: "company", label: "Company" },
  { key: "title", label: "Title" },
  { key: "linkedin", label: "LinkedIn URL" },
  { key: "birthday", label: "Birthday" },
  { key: "location", label: "Location" },
  { key: "groups", label: "Groups" },
] as const;

type FieldKey = (typeof OPTIONAL_FIELDS)[number]["key"];

export function NewPersonDialog({
  open,
  onOpenChange,
  groups,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groups: GroupWithCount[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [visible, setVisible] = useState<FieldKey[]>([]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [groupIds, setGroupIds] = useState<number[]>([]);
  const [fieldPickerOpen, setFieldPickerOpen] = useState(false);
  // There's no contact id to attach a photo to until Save, so the pick waits
  // here and gets uploaded straight after createContact returns one.
  const [photo, setPhoto] = useState<ClipboardImage | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);

  function previewFor(image: ClipboardImage | null): string | null {
    return image === null
      ? null
      : image.kind === "file"
        ? URL.createObjectURL(image.file)
        : image.url;
  }

  function setPendingPhoto(image: ClipboardImage | null) {
    setPhotoPreview((prev) => {
      if (prev?.startsWith("blob:")) URL.revokeObjectURL(prev);
      return previewFor(image);
    });
    setPhoto(image);
  }

  const remaining = useMemo(
    () => OPTIONAL_FIELDS.filter((f) => !visible.includes(f.key)),
    [visible],
  );

  function set(key: string, v: string) {
    setValues((prev) => ({ ...prev, [key]: v }));
  }

  function reset() {
    setVisible([]);
    setValues({});
    setGroupIds([]);
    setPendingPhoto(null);
  }

  function submit() {
    const first = values.firstName?.trim();
    const last = values.lastName?.trim();
    if (!first && !last && !values.email?.trim() && !values.phone?.trim()) {
      toast.error("Give this person at least a name, email, or phone.");
      return;
    }
    const input: ContactInput = {
      firstName: first,
      lastName: last,
      company: values.company,
      title: values.title,
      emails: values.email ? values.email.split(/[,;]/).map((s) => s.trim()).filter(Boolean) : [],
      phoneNumbers: values.phone ? values.phone.split(/[,;]/).map((s) => s.trim()).filter(Boolean) : [],
      linkedinUrl: values.linkedin,
      birthday: values.birthday || null,
      location: values.location,
      groupIds,
    };
    startTransition(async () => {
      const id = await createContact(input);
      if (photo) {
        let result;
        if (photo.kind === "file") {
          const fd = new FormData();
          fd.set("file", photo.file);
          result = await uploadContactPhoto(id, fd);
        } else {
          result = await importContactPhotoFromUrl(id, photo.url);
        }
        // The person is already saved at this point, so a bad image is a
        // warning, not a failure — they can retry from the profile.
        if (!result.ok) toast.error(`Photo didn't stick: ${result.error}`);
      }
      toast.success(`${[first, last].filter(Boolean).join(" ") || "Person"} added`);
      reset();
      onOpenChange(false);
      router.push(`/people?person=${id}`);
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-lg gap-0 overflow-hidden p-0"
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submit();
        }}
      >
        <div className="border-b border-stone-200 bg-stone-50 px-5 py-3.5">
          <DialogTitle className="text-[15px] font-semibold text-stone-800">
            New Person
          </DialogTitle>
        </div>

        <div className="flex max-h-[60vh] flex-col gap-4 overflow-y-auto p-5">
          <PhotoPicker
            name={[values.firstName, values.lastName].filter(Boolean).join(" ")}
            src={photoPreview}
            onPicked={setPendingPhoto}
            onRemoved={() => setPendingPhoto(null)}
            className="size-20"
            textClass="text-[24px]"
          />

          <div className="grid grid-cols-2 gap-3">
            <Input
              placeholder="First name"
              value={values.firstName ?? ""}
              onChange={(e) => set("firstName", e.target.value)}
              autoFocus
              className="h-11 bg-stone-100 border-transparent text-[15px]"
            />
            <Input
              placeholder="Last name"
              value={values.lastName ?? ""}
              onChange={(e) => set("lastName", e.target.value)}
              className="h-11 bg-stone-100 border-transparent text-[15px]"
            />
          </div>

          {visible.map((key) => {
            const label = OPTIONAL_FIELDS.find((f) => f.key === key)!.label;
            if (key === "groups") {
              return (
                <div key={key}>
                  <FieldLabel label="Groups" onRemove={() => {
                    setVisible((v) => v.filter((k) => k !== key));
                    setGroupIds([]);
                  }} />
                  <div className="flex flex-wrap gap-1.5">
                    {groups.map((g) => {
                      const on = groupIds.includes(g.id);
                      return (
                        <button
                          key={g.id}
                          type="button"
                          onClick={() =>
                            setGroupIds((ids) =>
                              on ? ids.filter((i) => i !== g.id) : [...ids, g.id],
                            )
                          }
                          className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12.5px] font-medium transition-colors ${
                            on
                              ? "border-stone-400 bg-stone-100 text-stone-800"
                              : "border-stone-200 text-stone-500 hover:border-stone-300"
                          }`}
                        >
                          <span
                            className="size-1.5 rounded-full"
                            style={{ backgroundColor: g.color }}
                          />
                          {g.name}
                          {on ? <Check className="size-3" /> : null}
                        </button>
                      );
                    })}
                    {groups.length === 0 ? (
                      <span className="text-[13px] text-stone-400">
                        No groups yet — create one from the sidebar.
                      </span>
                    ) : null}
                  </div>
                </div>
              );
            }
            return (
              <div key={key}>
                <FieldLabel
                  label={label}
                  onRemove={() => {
                    setVisible((v) => v.filter((k) => k !== key));
                    set(key, "");
                  }}
                />
                <Input
                  type={key === "birthday" ? "date" : "text"}
                  placeholder={
                    key === "email"
                      ? "Email address"
                      : key === "phone"
                        ? "Phone number"
                        : key === "linkedin"
                          ? "https://www.linkedin.com/in/…"
                          : label
                  }
                  value={values[key] ?? ""}
                  onChange={(e) => set(key, e.target.value)}
                  className="h-10 bg-stone-100 border-transparent"
                />
              </div>
            );
          })}
        </div>

        <div className="flex items-center justify-between border-t border-stone-200 px-5 py-3">
          {/* A plain-button Popover, not the Menu component — Menu's items track
              press-and-drag for native-style selection, which on touch means a
              quick tap gets read as an outside press and closes the menu before
              the tap registers. Buttons in a Popover just take a normal click. */}
          <Popover open={fieldPickerOpen} onOpenChange={setFieldPickerOpen}>
            <PopoverTrigger
              render={
                <button
                  className="flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wider text-stone-500 hover:text-stone-700 disabled:opacity-40"
                  disabled={remaining.length === 0}
                >
                  <Plus className="size-4" /> Add field
                </button>
              }
            />
            <PopoverContent align="start" side="top" className="w-44 p-1">
              {remaining.map((f) => (
                <button
                  key={f.key}
                  type="button"
                  className="flex w-full items-center rounded-md px-2 py-1.5 text-left text-[13px] text-stone-700 hover:bg-stone-100"
                  onClick={() => {
                    setVisible((v) => [...v, f.key]);
                    setFieldPickerOpen(false);
                  }}
                >
                  {f.label}
                </button>
              ))}
            </PopoverContent>
          </Popover>

          <div className="flex items-center gap-2 text-[11px] text-stone-400">
            <kbd className="rounded bg-stone-100 px-1.5 py-0.5">⌘</kbd>
            <kbd className="rounded bg-stone-100 px-1.5 py-0.5">Enter</kbd>
            <Button
              size="icon"
              className="ml-1 size-8 rounded-full"
              onClick={submit}
              disabled={pending}
              aria-label="Save person"
            >
              <Check className="size-4" />
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function FieldLabel({
  label,
  onRemove,
}: {
  label: string;
  onRemove: () => void;
}) {
  return (
    <div className="mb-1 flex items-center justify-between">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-stone-400">
        {label}
      </span>
      <button
        type="button"
        onClick={onRemove}
        className="text-stone-300 hover:text-stone-500"
        aria-label={`Remove ${label}`}
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}
