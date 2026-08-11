import { getGraphData } from "@/lib/actions/graph";
import { listGroups } from "@/lib/actions/contacts";
import { GraphView } from "@/components/graph-view";

export default async function GraphPage() {
  // Groups feed the embedded full-profile panel (its group chips section)
  const [data, groups] = await Promise.all([getGraphData(), listGroups()]);
  return <GraphView data={data} groups={groups} />;
}
