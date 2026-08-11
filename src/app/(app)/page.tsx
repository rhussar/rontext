import Link from "next/link";
import { AlarmClock, Cake, Clock, PenLine, RefreshCw } from "lucide-react";
import {
  listPeople,
  listRecentChanges,
  type ChangeFeedItem,
  type PersonRow,
} from "@/lib/actions/contacts";
import { listUpcomingReminders } from "@/lib/actions/reminders";
import { listOpenDrafts } from "@/lib/actions/drafts";
import { getSettings } from "@/lib/actions/settings";
import { HomeReminders } from "@/components/home-reminders";
import { HomeDrafts } from "@/components/home-drafts";
import { PersonAvatar } from "@/components/person-avatar";
import { HeadlineDiff } from "@/components/headline-diff";
import {
  ago,
  birthdayShort,
  daysUntilBirthday,
  displayName,
  roleLine,
} from "@/lib/format";

export default async function HomePage() {
  const [allPeople, recentChanges, upcomingReminders, openDrafts, settings] =
    await Promise.all([
      listPeople(),
      listRecentChanges(),
      listUpcomingReminders(),
      listOpenDrafts(),
      getSettings(),
    ]);
  const people = allPeople.filter((p) => !p.archived);
  const peopleById = new Map(people.map((p) => [p.id, p]));

  // Group changes per contact, newest contact first. Home only ever shows a
  // headline change or a new connection — other field edits are too noisy
  // for this feed, so they're dropped before grouping.
  const changesByContact: { person: PersonRow; items: ChangeFeedItem[] }[] = [];
  {
    const seen = new Map<number, ChangeFeedItem[]>();
    for (const ch of recentChanges) {
      if (ch.field !== "headline" && ch.field !== "connected") continue;
      const person = peopleById.get(ch.contactId);
      if (!person) continue;
      const arr = seen.get(ch.contactId);
      if (arr) {
        arr.push(ch);
      } else {
        const items = [ch];
        seen.set(ch.contactId, items);
        changesByContact.push({ person, items });
      }
    }
  }

  const birthdays = people
    .filter((p) => p.birthday)
    .map((p) => ({ p, days: daysUntilBirthday(p.birthday!) }))
    .filter((x) => x.days <= settings.birthdayWindowDays)
    .sort((a, b) => a.days - b.days);

  // Anyone touched more recently than this isn't "out of touch" yet.
  const reconnectCutoff = new Date();
  reconnectCutoff.setMonth(
    reconnectCutoff.getMonth() - settings.reconnectAfterMonths,
  );
  const cutoffIso = reconnectCutoff.toISOString().slice(0, 10);

  const reconnect = people
    .filter(
      (p) =>
        p.lastInteractionDate &&
        p.lastInteractionDate < cutoffIso &&
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
        {/* Full-bleed rows, left aligned — matches People, Network and Notes */}
        <div className="flex flex-col gap-7 pt-5">
          {/* Reminders you set — the only signal here you asked for explicitly */}
          <section>
            <SectionHeader icon={AlarmClock} label="Reminders" />
            <HomeReminders reminders={upcomingReminders} />
          </section>

          {/* Messages you've written but not sent — the other thing you owe someone */}
          <section>
            <SectionHeader icon={PenLine} label="Unsent drafts" />
            <HomeDrafts drafts={openDrafts} />
          </section>

          {/* Recent LinkedIn updates */}
          <section>
            <SectionHeader icon={RefreshCw} label="Recent updates" />
            {changesByContact.length === 0 ? (
              <EmptyNote>
                Run a LinkedIn sync to see job changes and new connections here.
              </EmptyNote>
            ) : (
              <div>
                {changesByContact.slice(0, 15).map(({ person, items }) => {
                  // Only two shapes ever reach this feed (see the filter
                  // above): a headline change gets Mesh's full-width diff
                  // row, a new connection gets a badge.
                  const headline = items.find((i) => i.field === "headline");
                  if (headline) {
                    return (
                      <HeadlineChangeRow
                        key={person.id}
                        person={person}
                        change={headline}
                      />
                    );
                  }
                  return (
                    <HomeRow key={person.id} person={person}>
                      <span className="rounded-full bg-sky-100 px-2 py-0.5 text-[11px] font-semibold text-sky-700">
                        New connection
                      </span>
                    </HomeRow>
                  );
                })}
              </div>
            )}
          </section>

          {/* Birthdays */}
          <section>
            <SectionHeader icon={Cake} label="Upcoming birthdays" />
            {birthdays.length === 0 ? (
              <EmptyNote>
                No birthdays in the next 30 days. Add birthdays on a person&apos;s
                page and they&apos;ll show up here.
              </EmptyNote>
            ) : (
              <div>
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
            <SectionHeader icon={Clock} label="Haven't talked in a while" />
            {reconnect.length === 0 ? (
              <EmptyNote>
                Import your contacts to see who you&apos;re falling out of touch
                with.
              </EmptyNote>
            ) : (
              <div>
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

function SectionHeader({
  icon: Icon,
  label,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
}) {
  return (
    <div className="flex items-center gap-2 px-5 pb-1.5">
      <Icon className="size-4 text-stone-400" />
      <h2 className="text-[11px] font-semibold uppercase tracking-wider text-stone-400">
        {label}
      </h2>
    </div>
  );
}

function EmptyNote({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-5 py-1.5 text-[13.5px] text-stone-400">{children}</p>
  );
}

/** Mesh's headline-change row: meta line, then the diff on its own full-width line. */
function HeadlineChangeRow({
  person,
  change,
}: {
  person: PersonRow;
  change: ChangeFeedItem;
}) {
  return (
    <Link
      href={`/people?person=${person.id}`}
      className="flex gap-3 px-5 py-3 transition-colors hover:bg-stone-50"
    >
      <PersonAvatar
        name={person.fullName}
        photoSrc={person.hasPhoto ? `/api/photos/${person.id}` : null}
        className="size-8"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <p className="truncate text-[14.5px] font-medium text-stone-800">
            {displayName(person.fullName)}
          </p>
          <span className="ml-auto shrink-0 text-[11.5px] text-stone-400">
            {ago(change.createdAt)}
          </span>
        </div>
        <p className="pt-0.5 text-[10.5px] uppercase tracking-wider text-stone-400">
          Headline change
          {change.source === "linkedin" ? " · via LinkedIn" : ""}
        </p>
        <div className="pt-1.5">
          <HeadlineDiff
            oldValue={change.oldValue}
            newValue={change.newValue}
            previousRole={roleLine(person.title, person.company)}
          />
        </div>
      </div>
    </Link>
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
      className="flex items-center gap-3 px-5 py-2.5 transition-colors hover:bg-stone-50"
    >
      <PersonAvatar
        name={person.fullName}
        photoSrc={person.hasPhoto ? `/api/photos/${person.id}` : null}
        className="size-8"
      />
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
