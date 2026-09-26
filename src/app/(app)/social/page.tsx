import {
  getSocialDashboard,
  getSocialNotes,
  getSocialProfiles,
  listSocialPosts,
  listTrackedPosts,
} from "@/lib/actions/social";
import { SocialView } from "@/components/social-view";

export default async function SocialPage({
  searchParams,
}: PageProps<"/social">) {
  const [posts, dashboard, tracked, profiles, notes, params] =
    await Promise.all([
      listSocialPosts(),
      getSocialDashboard(),
      listTrackedPosts(),
      getSocialProfiles(),
      getSocialNotes(),
      searchParams,
    ]);
  const post =
    typeof params.post === "string" && /^\d+$/.test(params.post)
      ? Number(params.post)
      : undefined;

  return (
    <SocialView
      posts={posts}
      dashboard={dashboard}
      tracked={tracked}
      profiles={profiles}
      notes={notes}
      initialTab={params.tab === "posts" ? "posts" : "analytics"}
      initialPostId={post}
    />
  );
}
