import { listGroups, listPeople } from "@/lib/actions/contacts";
import { listCandidates } from "@/lib/actions/candidates";
import { listCleanupItems, listDuplicatePairs } from "@/lib/actions/duplicates";
import { CandidatesView } from "@/components/candidates-view";
import { CleanupView } from "@/components/cleanup-view";
import { DuplicatesView } from "@/components/duplicates-view";
import { PeopleView } from "@/components/people-view";

export default async function PeoplePage({ searchParams }: PageProps<"/people">) {
  const params = await searchParams;
  const tab = typeof params.tab === "string" ? params.tab : undefined;

  if (tab === "discovered") {
    return <CandidatesView items={await listCandidates()} />;
  }
  if (tab === "duplicates") {
    return <DuplicatesView pairs={await listDuplicatePairs()} />;
  }
  if (tab === "cleanup") {
    return <CleanupView items={await listCleanupItems()} />;
  }

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
      archived={tab === "archive"}
    />
  );
}
