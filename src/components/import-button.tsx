"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Upload } from "lucide-react";
import { importAnyFile, type AnyImportResult } from "@/lib/actions/import-any";
import { getImportHistory } from "@/lib/actions/import";
import { noteDate } from "@/lib/format";
import { Button } from "@/components/ui/button";

export function ImportButton() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [result, setResult] = useState<AnyImportResult | null>(null);
  const [lastImport, setLastImport] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    getImportHistory().then((h) =>
      setLastImport(h[0] ? `${h[0].filename} · ${noteDate(h[0].createdAt)}` : null),
    );
  }, []);

  function onPick(file: File) {
    const fd = new FormData();
    fd.set("file", file);
    setResult(null);
    startTransition(async () => {
      const r = await importAnyFile(fd);
      setResult(r);
      if (r.ok) router.refresh();
    });
  }

  return (
    <div className="rounded-xl border border-border p-4">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-[13.5px] font-semibold text-foreground">
            Import contacts
          </p>
          <p className="truncate pt-0.5 text-[12px] text-muted-foreground">
            {lastImport ? `Last import: ${lastImport}` : "vCard, Google CSV, or your Mesh export"}
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="h-8 shrink-0 text-[12.5px]"
          onClick={() => inputRef.current?.click()}
          disabled={pending}
        >
          {pending ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Upload className="size-3.5" />
          )}
          {pending ? "Importing…" : "Choose file"}
        </Button>
      </div>

      <input
        ref={inputRef}
        type="file"
        accept=".vcf,.csv,text/vcard,text/csv"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onPick(f);
          e.target.value = ""; // let the same file be re-picked
        }}
      />

      {result ? (
        <p
          className={
            result.ok
              ? "pt-2.5 text-[12px] text-emerald-700"
              : "pt-2.5 text-[12px] text-red-600"
          }
        >
          {result.ok ? result.message : result.error}
        </p>
      ) : null}
    </div>
  );
}
