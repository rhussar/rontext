"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, Contact, UploadCloud, XCircle } from "lucide-react";
import {
  importAddressBook,
  type ContactsImportSummary,
} from "@/lib/actions/contacts-import";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";

export function AddressBookImportForm() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [createMissing, setCreateMissing] = useState(false);
  const [summary, setSummary] = useState<ContactsImportSummary | null>(null);
  const [pending, startTransition] = useTransition();
  const [dragOver, setDragOver] = useState(false);

  function run() {
    if (!file) return;
    const fd = new FormData();
    fd.set("file", file);
    if (createMissing) fd.set("createMissing", "on");
    setSummary(null);
    startTransition(async () => {
      const result = await importAddressBook(fd);
      setSummary(result);
      if (result.ok) {
        setFile(null);
        router.refresh();
      }
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const f = e.dataTransfer.files?.[0];
          if (f) setFile(f);
        }}
        className={`flex flex-col items-center gap-2 rounded-xl border-2 border-dashed px-6 py-8 transition-colors ${
          dragOver
            ? "border-blue-400 bg-blue-50/50"
            : "border-stone-200 bg-stone-50 hover:border-stone-300"
        }`}
      >
        {file ? (
          <>
            <Contact className="size-7 text-emerald-500" />
            <p className="text-[14px] font-medium text-stone-700">{file.name}</p>
            <p className="text-[12px] text-stone-400">
              {(file.size / 1024).toFixed(0)} KB — ready to import
            </p>
          </>
        ) : (
          <>
            <UploadCloud className="size-7 text-stone-300" />
            <p className="text-[14px] font-medium text-stone-600">
              Drop a .vcf or Google CSV here
            </p>
            <p className="text-[12px] text-stone-400">
              iPhone: Contacts → select all → Share. Google: contacts.google.com
              → Export
            </p>
          </>
        )}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept=".vcf,.csv,text/vcard,text/csv"
        className="hidden"
        onChange={(e) => setFile(e.target.files?.[0] ?? null)}
      />

      <div className="flex items-center gap-2">
        <Checkbox
          id="createMissing"
          checked={createMissing}
          onCheckedChange={(v) => setCreateMissing(v === true)}
        />
        <Label htmlFor="createMissing" className="text-[13px] text-stone-600">
          Also add people who aren&apos;t in Mesh yet
        </Label>
      </div>

      <Button onClick={run} disabled={!file || pending} className="h-10">
        {pending ? "Importing…" : "Import contacts"}
      </Button>

      {summary ? (
        summary.ok ? (
          <div className="flex flex-col gap-1.5 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-[13.5px] text-emerald-900">
            <p className="flex items-center gap-1.5 font-semibold">
              <CheckCircle2 className="size-4" /> Import complete
            </p>
            <p>
              {summary.parsed.toLocaleString()} contacts read —{" "}
              {summary.matched.toLocaleString()} matched to existing people
              {summary.created > 0
                ? `, ${summary.created.toLocaleString()} added`
                : ""}
              .
            </p>
            {summary.birthdaysAdded > 0 ? (
              <p className="font-medium">
                🎂 {summary.birthdaysAdded} birthdays added.
              </p>
            ) : (
              <p className="text-emerald-800">
                No new birthdays found in this file.
              </p>
            )}
            {summary.emailsAdded + summary.phonesAdded > 0 ? (
              <p>
                {summary.emailsAdded} emails and {summary.phonesAdded} phone
                numbers filled in.
              </p>
            ) : null}
            {summary.unmatched > 0 && !summary.created ? (
              <p className="text-emerald-800">
                {summary.unmatched.toLocaleString()} weren&apos;t in Mesh — tick
                the box above to add them.
              </p>
            ) : null}
          </div>
        ) : (
          <div className="flex items-start gap-1.5 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-[13.5px] text-red-800">
            <XCircle className="mt-0.5 size-4 shrink-0" />
            {summary.error}
          </div>
        )
      ) : null}
    </div>
  );
}
