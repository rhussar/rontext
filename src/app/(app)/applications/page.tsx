import { listApplications } from "@/lib/actions/applications";
import { ApplicationsView } from "@/components/applications-view";

export default async function ApplicationsPage() {
  const items = await listApplications();
  return <ApplicationsView items={items} />;
}
