import { getGraphData } from "@/lib/actions/graph";
import { GraphView } from "@/components/graph-view";

export default async function GraphPage() {
  const data = await getGraphData();
  return <GraphView data={data} />;
}
