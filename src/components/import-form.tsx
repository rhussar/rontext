"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, FileSpreadsheet, UploadCloud, XCircle } from "lucide-react";
import { importCombinedCsv, type ImportSummary } from "@/lib/actions/import";
import { Button } from "@/components/ui/button";

export function ImportForm() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [pending, startTransition] = useTransition();
  const [dragOver, setDragOver] = useState(false);

  function run() {
    if (!file) return;
    const fd = new FormData();
    fd.set("file", file);
    setSummary(null);
    startTransition(async () => {
      const result = await importCombinedCsv(fd);
      setSummary(result);
      if (result.ok) {
        setFile(null);
        router.refresh();
      }
    });
  }

  return (
    <div className="flex flex-col gap-4">
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
        className={`flex flex-col items-center gap-2 rounded-xl border-2 border-dashed px-6 py-10 transition-colors ${
          dragOver
            ? "border-blue-400 bg-blue-50/50"
            : "border-stone-200 bg-stone-50 hover:border-stone-300"
        }`}
      >
        {file ? (
          <>
            <FileSpreadsheet className="size-8 text-emerald-500" />
            <p className="text-[14px] font-medium text-stone-700">{file.name}</p>
            <p className="text-[12px] text-stone-400">
              {(file.size / 1024).toFixed(0)} KB — ready to import
            </p>
          </>
        ) : (
          <>
            <UploadCloud className="size-8 text-stone-300" />
            <p className="text-[14px] font-medium text-stone-600">
              Drop your CSV here or click to browse
            </p>
            <p className="text-[12px] text-stone-400">combined_contacts.csv</p>
          </>
        )}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept=".csv,text/csv"
        className="hidden"
        onChange={(e) => setFile(e.target.files?.[0] ?? null)}
      />

      <Button onClick={run} disabled={!file || pending} className="h-10">
        {pending ? "Importing… this takes a few seconds" : "Import contacts"}
      </Button>

      {summary ? (
        summary.ok ? (
          <div className="flex flex-col gap-1.5 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-[13.5px] text-emerald-900">
            <p className="flex items-center gap-1.5 font-semibold">
              <CheckCircle2 className="size-4" /> Import complete
            </p>
            <p>
              {summary.rowCount.toLocaleString()} rows processed —{" "}
              {summary.created.toLocaleString()} people created,{" "}
              {summary.updated.toLocaleString()} updated,{" "}
              {summary.skipped.toLocaleString()} unchanged.
            </p>
            {summary.notesCreated > 0 ? (
              <p>{summary.notesCreated} Mesh notes carried over.</p>
            ) : null}
            {summary.groupsCreated.length > 0 ? (
              <p>New groups: {summary.groupsCreated.join(", ")}</p>
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
