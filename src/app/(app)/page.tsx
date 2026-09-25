import { Cake, Notebook, RefreshCw, UserPlus } from "lucide-react";
import {
  getHomePulse,
  listAllNotes,
  listGroups,
  listPeople,
  listRecentChanges,
  type ChangeFeedItem,
  type PersonRow,
} from "@/lib/actions/contacts";
import { HomePersonLink, HomeShell } from "@/components/home-shell";
import { ExpandableList } from "@/components/home-expand";
import { HomeAutoRefresh } from "@/components/home-auto-refresh";
import { listUpcomingReminders } from "@/lib/actions/reminders";
import { getSettings } from "@/lib/actions/settings";
import { HomeReminders } from "@/components/home-reminders";
import { HomeFollowUps } from "@/components/home-follow-ups";
import { SyncHealthBanner } from "@/components/sync-health-banner";
import { checkSyncs, TRACKED_SYNCS } from "@/lib/sync-health";
import { listHomeFollowUps } from "@/lib/follow-ups";
import { PersonAvatar } from "@/components/person-avatar";
import { HeadlineDiff } from "@/components/headline-diff";
import {
  ago,
  birthdayShort,
  daysUntilBirthday,
  displayName,
  noteDate,
  roleLine,
} from "@/lib/format";

/**
 * "Recently added" is its own section with NO time window on purpose. It used
 * to be folded into Recent updates behind a 14-day cutoff, which meant the
 * whole book (imported on one day) aged out of Home together and the section
 * silently emptied. Newest-first and capped is enough to keep a 1,800-row
 * import from becoming 1,800 rows.
 */
const MAX_ADDED_ROWS = 6;
/** How deep "Recently added" goes once View more is pressed. */
const MAX_ADDED_EXPANDED = 60;
const MAX_UPDATE_ROWS = 6;
/** Collapsed row counts for the sections that fold behind View more. */
const MAX_BIRTHDAY_ROWS = 8;
const MAX_NOTE_ROWS = 10;
/** Rows of the fold that a new phone number can always claim. */
const CONTACT_ROW_SLOTS = 2;
/** Matches the window `listRecentChanges()` already uses for changes. */
const VIEWED_WINDOW_DAYS = 14;

/**
 * The change fields Recent updates shows. Everything else contact_changes
 * records (company, title, location fills) belongs on the person, not here.
 * "added" is left out on purpose: new people have their own Recently added
 * section, and showing them in both put the same faces on Home twice.
 */
const FEED_FIELDS = new Set(["headline", "connected", "phone"]);

/** "manual" is deliberately absent: the Added badge already says as much. */
const ADDED_VIA: Record<string, string> = {
  import: "via import",
  contacts: "via Contacts",
  linkedin: "via LinkedIn",
  gmail: "via Gmail",
  messages: "via Messages",
  whatsapp: "via WhatsApp",
  calendar: "via Calendar",
};

type UpdateItem =
  | { kind: "headline"; at: string; person: PersonRow; change: ChangeFeedItem }
  | { kind: "connected"; at: string; person: PersonRow }
  | { kind: "phone"; at: string; person: PersonRow; numbers: string }
  | { kind: "viewed"; at: string; person: PersonRow };

export default async function HomePage({ searchParams }: PageProps<"/">) {
  const [
    allPeople,
    recentChanges,
    upcomingReminders,
    notes,
    settings,
    groups,
    params,
    pulse,
    followUps,
    syncHealth,
  ] = await Promise.all([
    listPeople(),
    listRecentChanges(VIEWED_WINDOW_DAYS, [...FEED_FIELDS]),
    listUpcomingReminders(),
    listAllNotes(),
    getSettings(),
    listGroups(),
    searchParams,
    getHomePulse(),
    listHomeFollowUps(),
    checkSyncs(TRACKED_SYNCS),
  ]);
  const initialPersonId =
    typeof params.person === "string" && /^\d+$/.test(params.person)
      ? Number(params.person)
      : undefined;
  const people = allPeople.filter((p) => !p.archived);
  const peopleById = new Map(people.map((p) => [p.id, p]));

  // Group changes per contact, newest contact first. Home only ever shows a
  // headline change or a new connection — other field edits are too noisy
  // for this feed, so they're dropped before grouping.
  const changesByContact: { person: PersonRow; items: ChangeFeedItem[] }[] = [];
  {
    const seen = new Map<number, ChangeFeedItem[]>();
    for (const ch of recentChanges) {
      // "phone" comes from the hourly Apple Contacts pass — a second number
      // on someone already here. Other field edits are too noisy for this feed.
      if (!FEED_FIELDS.has(ch.field)) continue;
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

  // One row per person: a headline change or a new connection, newest first.
  const changeUpdates: UpdateItem[] = changesByContact.map(
    ({ person, items }) => {
      // A headline change is the most interesting thing that can have happened
      // to a person, then a new way to reach them.
      const headline = items.find((i) => i.field === "headline");
      if (headline) {
        return { kind: "headline", at: headline.createdAt, person, change: headline };
      }
      const phone = items.find((i) => i.field === "phone");
      if (phone) {
        return { kind: "phone", at: phone.createdAt, person, numbers: phone.newValue ?? "" };
      }
      return { kind: "connected", at: items[0].createdAt, person };
    },
  );

  // Profiles you opened in Chrome. The extension captures every one of them,
  // but until now a capture was only *visible* here if something about the
  // person had changed — open someone who's already up to date and Home looked
  // asleep. A "Viewed" row makes the always-on capture legible, and because
  // only passive captures stamp `lastViewedAt`, the nightly batch can't fill
  // this with people you never looked at.
  const claimed = new Set(changeUpdates.map((u) => u.person.id));
  const viewedCutoff = Date.now() - VIEWED_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const viewedUpdates: UpdateItem[] = people
    .filter(
      (p) =>
        !claimed.has(p.id) &&
        p.lastViewedAt &&
        Date.parse(p.lastViewedAt) >= viewedCutoff,
    )
    .map((person) => ({ kind: "viewed", at: person.lastViewedAt!, person }));

  // Newest-first, but with slots held for the address book. A nightly LinkedIn
  // batch can write 80+ headline changes in two minutes, and straight
  // newest-first ordering lets one of those batches push every "Phone added"
  // row off the bottom of the feed — the number you saved on your phone
  // yesterday vanishes behind a robot's work. Reserving a few slots means an
  // address-book event is always visible; ordering within the feed is
  // still purely chronological.
  const byTime = [...changeUpdates, ...viewedUpdates].sort((a, b) =>
    b.at.localeCompare(a.at),
  );
  const reserved = byTime
    .filter((u) => u.kind === "phone")
    .slice(0, CONTACT_ROW_SLOTS);
  const held: Set<UpdateItem> = new Set(reserved);
  const shownUpdates = [
    ...reserved,
    ...byTime.filter((u) => !held.has(u)).slice(0, MAX_UPDATE_ROWS - reserved.length),
  ].sort((a, b) => b.at.localeCompare(a.at));
  // View more appends everything the cap (and its slot reservation) hid,
  // still newest-first. The fold keeps the reserved ordering; the tail is
  // purely chronological.
  const shownSet = new Set(shownUpdates);
  const allUpdates = [...shownUpdates, ...byTime.filter((u) => !shownSet.has(u))];

  // Additions are derived from `createdAt` rather than a logged change row on
  // purpose: every path that can create a contact (the manual dialog, CSV and
  // vCard imports, the Google/Gmail/Messages syncs, accepting a candidate)
  // stamps it, so none of them has to remember to write a feed entry — and
  // none can silently stop appearing here.
  //
  // Ties are broken by id because a bulk import gives every row the same
  // `createdAt` — without it the "newest" 6 out of 1,768 would be arbitrary.
  // Anyone Recent updates just announced is skipped here: the two sections sit
  // one above the other, and the same face twice reads as a bug.
  const inUpdates = new Set(shownUpdates.map((u) => u.person.id));
  const recentlyAdded = people
    .filter((p) => !inUpdates.has(p.id))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id)
    .slice(0, MAX_ADDED_EXPANDED);

  const birthdays = people
    .filter((p) => p.birthday)
    .map((p) => ({ p, days: daysUntilBirthday(p.birthday!) }))
    .filter((x) => x.days <= settings.birthdayWindowDays)
    .sort((a, b) => a.days - b.days);

  return (
    <HomeShell groups={groups} initialPersonId={initialPersonId}>
      <HomeAutoRefresh pulse={pulse} />
      <div className="border-b border-border px-5 pb-2.5 pt-3">
        <h1 className="text-[15px] font-semibold text-foreground">Home</h1>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pb-16">
        {/* Full-bleed rows, left aligned — matches People, Network and Notes */}
        <div className="flex flex-col gap-7 pt-5">
          {/* Only when Messages, WhatsApp, Gmail or Calendar has stopped
              landing — a broken sync should find you, not wait in Settings. */}
          <SyncHealthBanner syncs={syncHealth.syncs} />

          {/* What's owed inside conversations: promises, asks, overdue replies
              from others. First because it's the one list that goes stale by
              the day, and the one a count-based feed can't see. */}
          <HomeFollowUps followUps={followUps} />

          {/* Reminders you set — the only signal here you asked for explicitly */}
          <HomeReminders reminders={upcomingReminders} />

          {/* Job changes, new connections, and profiles you just looked at */}
          <ExpandableList
            icon={<RefreshCw />}
            label="Recent updates"
            limit={shownUpdates.length}
            empty={
              <EmptyNote>
                Browse a contact on LinkedIn or run a sync to see job changes,
                new connections and the profiles you viewed here.
              </EmptyNote>
            }
          >
            {allUpdates.map((u) => {
              // A headline change gets the full-width diff row; everything
              // else — a new number, a new connection, a profile you
              // viewed — gets a badge.
              if (u.kind === "headline") {
                return (
                  <HeadlineChangeRow
                    key={`headline-${u.person.id}`}
                    person={u.person}
                    change={u.change}
                  />
                );
              }
              if (u.kind === "phone") {
                return (
                  <HomeRow key={`phone-${u.person.id}`} person={u.person}>
                    {u.numbers ? (
                      <span className="text-[11.5px] text-muted-foreground">
                        {u.numbers}
                      </span>
                    ) : null}
                    <span className="rounded-full bg-amber-100 dark:bg-amber-950/50 px-2 py-0.5 text-[11px] font-semibold text-amber-700 dark:text-amber-300">
                      Phone added
                    </span>
                  </HomeRow>
                );
              }
              if (u.kind === "connected") {
                return (
                  <HomeRow key={`connected-${u.person.id}`} person={u.person}>
                    <span className="rounded-full bg-sky-100 dark:bg-sky-950/50 px-2 py-0.5 text-[11px] font-semibold text-sky-700 dark:text-sky-300">
                      New connection
                    </span>
                  </HomeRow>
                );
              }
              return (
                <HomeRow key={`viewed-${u.person.id}`} person={u.person}>
                  <span className="text-[11.5px] text-muted-foreground">
                    {ago(u.at)}
                  </span>
                  <span className="rounded-full bg-violet-100 dark:bg-violet-950/50 px-2 py-0.5 text-[11px] font-semibold text-violet-700 dark:text-violet-300">
                    Viewed
                  </span>
                </HomeRow>
              );
            })}
          </ExpandableList>

          {/* The newest people in the book — always present, never aged out */}
          <ExpandableList
            icon={<UserPlus />}
            label="Recently added"
            limit={MAX_ADDED_ROWS}
            empty={
              <EmptyNote>
                No one yet. Add someone or import your contacts and the newest
                people land here.
              </EmptyNote>
            }
          >
            {recentlyAdded.map((person) => (
              <HomeRow key={`added-${person.id}`} person={person}>
                {ADDED_VIA[person.source] ? (
                  <span className="text-[11.5px] text-muted-foreground">
                    {ADDED_VIA[person.source]}
                  </span>
                ) : null}
                <span className="rounded-full bg-emerald-100 dark:bg-emerald-950/50 px-2 py-0.5 text-[11px] font-semibold text-emerald-700 dark:text-emerald-300">
                  Added
                </span>
              </HomeRow>
            ))}
          </ExpandableList>

          {/* Birthdays */}
          <ExpandableList
            icon={<Cake />}
            label="Upcoming birthdays"
            limit={MAX_BIRTHDAY_ROWS}
            empty={
              <EmptyNote>
                No birthdays in the next 30 days. Add birthdays on a person&apos;s
                page and they&apos;ll show up here.
              </EmptyNote>
            }
          >
            {birthdays.map(({ p, days }) => (
              <HomeRow key={p.id} person={p}>
                <span className="text-[13px] font-medium text-muted-foreground">
                  {birthdayShort(p.birthday!)}
                </span>
                <span
                  className={
                    days === 0
                      ? "rounded-full bg-amber-100 dark:bg-amber-950/50 px-2 py-0.5 text-[11px] font-semibold text-amber-700 dark:text-amber-300"
                      : "text-[11.5px] text-muted-foreground"
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
          </ExpandableList>

          {/* Notes — the whole notes feed, moved here from its own page */}
          <ExpandableList
            icon={<Notebook />}
            label="Notes"
            limit={MAX_NOTE_ROWS}
            empty={
              <EmptyNote>
                No notes yet. Open a person and add your first note.
              </EmptyNote>
            }
          >
            {notes.map((n) => (
              <HomePersonLink
                key={n.id}
                personId={n.contactId}
                className="flex items-center gap-3 px-5 py-3 transition-colors hover:bg-muted/50"
              >
                <PersonAvatar
                  name={n.contactName}
                  photoSrc={n.hasPhoto ? `/api/photos/${n.contactId}` : null}
                  className="size-8"
                />
                <span className="w-32 shrink-0 truncate text-[14.5px] font-semibold text-foreground sm:w-44">
                  {displayName(n.contactName)}
                </span>
                <span className="min-w-0 flex-1 truncate text-[13.5px] text-muted-foreground">
                  {n.body}
                </span>
                <span className="shrink-0 pl-3 text-[10.5px] uppercase tracking-wide text-muted-foreground">
                  {noteDate(n.createdAt)}
                </span>
              </HomePersonLink>
            ))}
          </ExpandableList>
        </div>
      </div>
    </HomeShell>
  );
}

function EmptyNote({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-5 py-1.5 text-[13.5px] text-muted-foreground">{children}</p>
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
    <HomePersonLink
      personId={person.id}
      className="flex gap-3 px-5 py-3 transition-colors hover:bg-muted/50"
    >
      <PersonAvatar
        name={person.fullName}
        photoSrc={person.hasPhoto ? `/api/photos/${person.id}` : null}
        className="size-8"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <p className="truncate text-[14.5px] font-medium text-foreground">
            {displayName(person.fullName)}
          </p>
          <span className="ml-auto shrink-0 text-[11.5px] text-muted-foreground">
            {ago(change.createdAt)}
          </span>
        </div>
        <p className="pt-0.5 text-[10.5px] uppercase tracking-wider text-muted-foreground">
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
    </HomePersonLink>
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
    <HomePersonLink
      personId={person.id}
      className="flex items-center gap-3 px-5 py-2.5 transition-colors hover:bg-muted/50"
    >
      <PersonAvatar
        name={person.fullName}
        photoSrc={person.hasPhoto ? `/api/photos/${person.id}` : null}
        className="size-8"
      />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[14.5px] font-medium text-foreground">
          {person.fullName}
        </p>
        {person.company || person.title ? (
          <p className="truncate text-[12px] text-muted-foreground">
            {[person.title, person.company].filter(Boolean).join(" · ")}
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </HomePersonLink>
  );
}
