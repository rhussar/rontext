import Link from "next/link";
import { listAllNotes } from "@/lib/actions/contacts";
import { PersonAvatar } from "@/components/person-avatar";
import { noteDate } from "@/lib/format";

export default async function NotesPage() {
  const notes = await listAllNotes();

  return (
    <div className="flex h-full flex-col bg-white">
      <div className="border-b border-stone-200 px-5 pb-2.5 pt-3">
        <h1 className="text-[15px] font-semibold text-stone-800">Notes</h1>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-10">
        {notes.length === 0 ? (
          <div className="px-6 pt-16 text-center text-[13.5px] text-stone-400">
            No notes yet. Open a person and add your first note.
          </div>
        ) : (
          notes.map((n) => (
            <Link
              key={n.id}
              href={`/people?person=${n.contactId}`}
              className="flex items-center gap-3 px-5 py-3 transition-colors hover:bg-stone-50"
            >
              <PersonAvatar name={n.contactName} className="size-8" />
              <span className="w-32 shrink-0 truncate text-[14.5px] font-semibold text-stone-800 sm:w-44">
                {n.contactName}
              </span>
              <span className="min-w-0 flex-1 truncate text-[13.5px] text-stone-500">
                {n.body}
              </span>
              <span className="shrink-0 pl-3 text-[10.5px] uppercase tracking-wide text-stone-400">
                {noteDate(n.createdAt)}
              </span>
            </Link>
          ))
        )}
      </div>
    </div>
  );
}
