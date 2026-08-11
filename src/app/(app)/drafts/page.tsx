import { listGroups } from "@/lib/actions/contacts";
import { listOpenDrafts } from "@/lib/actions/drafts";
import { DraftsView } from "@/components/drafts-view";

export default async function DraftsPage({
  searchParams,
}: PageProps<"/drafts">) {
  const [drafts, groups, params] = await Promise.all([
    listOpenDrafts(),
    listGroups(),
    searchParams,
  ]);
  const person =
    typeof params.person === "string" && /^\d+$/.test(params.person)
      ? Number(params.person)
      : undefined;

  return <DraftsView drafts={drafts} groups={groups} initialPersonId={person} />;
}
