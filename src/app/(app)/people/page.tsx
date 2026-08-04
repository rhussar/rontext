import { listGroups, listPeople } from "@/lib/actions/contacts";
import { PeopleView } from "@/components/people-view";

export default async function PeoplePage({ searchParams }: PageProps<"/people">) {
  const params = await searchParams;
  const [people, groups] = await Promise.all([listPeople(), listGroups()]);
  const group = typeof params.group === "string" ? params.group : undefined;
  const person =
    typeof params.person === "string" && /^\d+$/.test(params.person)
      ? Number(params.person)
      : undefined;
  return (
    <PeopleView
      people={people}
      groups={groups}
      groupParam={group}
      initialPersonId={person}
      archived={params.tab === "archive"}
    />
  );
}
