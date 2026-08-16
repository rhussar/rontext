import {
  getGithubTraffic,
  getSocialNotes,
  getSocialOverview,
  getSocialProfiles,
  listSocialPosts,
  listTrackedPosts,
} from "@/lib/actions/social";
import { SocialView } from "@/components/social-view";

export default async function SocialPage({
  searchParams,
}: PageProps<"/social">) {
  const [posts, overview, tracked, githubTraffic, profiles, notes, params] =
    await Promise.all([
      listSocialPosts(),
      getSocialOverview(),
      listTrackedPosts(),
      getGithubTraffic(),
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
      overview={overview}
      tracked={tracked}
      githubTraffic={githubTraffic}
      profiles={profiles}
      notes={notes}
      initialPostId={post}
    />
  );
}
