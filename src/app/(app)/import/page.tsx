import { desc } from "drizzle-orm";
import { getDb } from "@/db";
import { imports } from "@/db/schema";
import { ImportForm } from "@/components/import-form";
import { AddressBookImportForm } from "@/components/address-book-import-form";
import { noteDate } from "@/lib/format";

export default async function ImportPage() {
  const db = getDb();
  const history = await db
    .select()
    .from(imports)
    .orderBy(desc(imports.createdAt))
    .limit(20);

  return (
    <div className="flex h-full flex-col bg-white">
      <div className="border-b border-stone-200 px-5 pb-2.5 pt-3">
        <h1 className="text-[15px] font-semibold text-stone-800">Import</h1>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pb-16">
        <div className="mx-auto flex max-w-xl flex-col gap-8 px-5 pt-6">
          <section>
            <h2 className="pb-1 text-[13.5px] font-semibold text-stone-700">
              Phone or Google contacts
            </h2>
            <p className="pb-4 text-[13.5px] leading-relaxed text-stone-500">
              Upload a <code className="rounded bg-stone-100 px-1 py-0.5 text-[12px]">.vcf</code>{" "}
              (iPhone / Contacts.app) or a Google Contacts CSV export. This is
              where <strong>birthdays</strong> come from — LinkedIn never
              provides them. Matching is by email, then phone, then name, and it
              only fills fields you don&apos;t already have.
            </p>
            <AddressBookImportForm />
          </section>

          <section>
            <h2 className="pb-1 text-[13.5px] font-semibold text-stone-700">
              Mesh + LinkedIn CSV
            </h2>
            <p className="pb-4 text-[13.5px] leading-relaxed text-stone-500">
              Upload your <code className="rounded bg-stone-100 px-1 py-0.5 text-[12px]">combined_contacts.csv</code>{" "}
              (the merged Mesh + LinkedIn export). Re-uploading an updated file
              is safe — existing people are matched by LinkedIn URL, Mesh ID,
              then name, and only changed fields are updated. Nothing is ever
              deleted by an import.
            </p>
            <ImportForm />
          </section>

          {history.length > 0 ? (
            <section>
              <h2 className="pb-2 text-[11px] font-semibold uppercase tracking-wider text-stone-400">
                Past imports
              </h2>
              <div className="overflow-hidden rounded-xl border border-stone-200">
                {history.map((h) => (
                  <div
                    key={h.id}
                    className="flex items-center gap-3 border-b border-stone-100 px-4 py-2.5 text-[13px] last:border-0"
                  >
                    <span className="min-w-0 flex-1 truncate font-medium text-stone-700">
                      {h.filename}
                    </span>
                    <span className="shrink-0 text-stone-400">
                      +{h.createdCount} new · {h.updatedCount} updated
                    </span>
                    <span className="shrink-0 text-[10.5px] uppercase text-stone-400">
                      {noteDate(h.createdAt)}
                    </span>
                  </div>
                ))}
              </div>
            </section>
          ) : null}
        </div>
      </div>
    </div>
  );
}
