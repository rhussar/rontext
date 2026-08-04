import Link from "next/link";
import { Cake, Clock } from "lucide-react";
import { listPeople, type PersonRow } from "@/lib/actions/contacts";
import { PersonAvatar } from "@/components/person-avatar";
import { ago, birthdayShort, daysUntilBirthday } from "@/lib/format";

export default async function HomePage() {
  const people = (await listPeople()).filter((p) => !p.archived);

  const birthdays = people
    .filter((p) => p.birthday)
    .map((p) => ({ p, days: daysUntilBirthday(p.birthday!) }))
    .filter((x) => x.days <= 30)
    .sort((a, b) => a.days - b.days);

  const reconnect = people
    .filter(
      (p) =>
        p.lastInteractionDate &&
        !/^\+?\d/.test(p.fullName) && // skip phone-number-only contacts
        (p.company || p.hasLinkedin || p.hasNotes || p.starred),
    )
    .sort((a, b) => a.lastInteractionDate!.localeCompare(b.lastInteractionDate!))
    .slice(0, 15);

  return (
    <div className="flex h-full flex-col bg-white">
      <div className="border-b border-stone-200 px-5 pb-2.5 pt-3">
        <h1 className="text-[15px] font-semibold text-stone-800">Home</h1>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pb-16">
        <div className="mx-auto flex max-w-2xl flex-col gap-8 px-5 pt-6">
          {/* Birthdays */}
          <section>
            <div className="flex items-center gap-2 pb-2">
              <Cake className="size-4 text-stone-400" />
              <h2 className="text-[11px] font-semibold uppercase tracking-wider text-stone-400">
                Upcoming birthdays
              </h2>
            </div>
            {birthdays.length === 0 ? (
              <p className="rounded-lg bg-stone-50 px-4 py-3 text-[13.5px] text-stone-400">
                No birthdays in the next 30 days. Add birthdays on a person&apos;s
                page and they&apos;ll show up here.
              </p>
            ) : (
              <div className="overflow-hidden rounded-xl border border-stone-200">
                {birthdays.map(({ p, days }) => (
                  <HomeRow key={p.id} person={p}>
                    <span className="text-[13px] font-medium text-stone-600">
                      {birthdayShort(p.birthday!)}
                    </span>
                    <span
                      className={
                        days === 0
                          ? "rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-700"
                          : "text-[11.5px] text-stone-400"
                      }
                    >
                      {days === 0
                        ? "Today 🎂"
                        : days === 1
                          ? "Tomorrow"
                          : `in ${days} days`}
                    </span>
                  </HomeRow>
                ))}
              </div>
            )}
          </section>

          {/* Reconnect */}
          <section>
            <div className="flex items-center gap-2 pb-2">
              <Clock className="size-4 text-stone-400" />
              <h2 className="text-[11px] font-semibold uppercase tracking-wider text-stone-400">
                Haven&apos;t talked in a while
              </h2>
            </div>
            {reconnect.length === 0 ? (
              <p className="rounded-lg bg-stone-50 px-4 py-3 text-[13.5px] text-stone-400">
                Import your contacts to see who you&apos;re falling out of touch
                with.
              </p>
            ) : (
              <div className="overflow-hidden rounded-xl border border-stone-200">
                {reconnect.map((p) => (
                  <HomeRow key={p.id} person={p}>
                    <span className="text-[11.5px] text-stone-400">
                      last touch {ago(p.lastInteractionDate)}
                    </span>
                  </HomeRow>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function HomeRow({
  person,
  children,
}: {
  person: PersonRow;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={`/people?person=${person.id}`}
      className="flex items-center gap-3 border-b border-stone-100 px-4 py-2.5 transition-colors last:border-0 hover:bg-stone-50"
    >
      <PersonAvatar name={person.fullName} className="size-8" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[14.5px] font-medium text-stone-800">
          {person.fullName}
        </p>
        {person.company || person.title ? (
          <p className="truncate text-[12px] text-stone-400">
            {[person.title, person.company].filter(Boolean).join(" · ")}
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </Link>
  );
}
