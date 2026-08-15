import { redirect } from "next/navigation";

/**
 * The graph moved under People as the Network tab. Kept as a redirect rather
 * than deleted: /graph was the URL for the whole life of the feature, so
 * bookmarks and any older link should still land somewhere real.
 */
export default function GraphPage() {
  redirect("/people?tab=network");
}
