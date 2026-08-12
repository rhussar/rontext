import { listGroups } from "@/lib/actions/contacts";
import { getSettings } from "@/lib/actions/settings";
import { getConnectionStatuses } from "@/lib/actions/connections";
import { getSetupStatus } from "@/lib/actions/setup";
import { listSkillSummaries } from "@/lib/skills";
import { themeInitScript } from "@/lib/theme";
import { AppShell } from "@/components/app-shell";

export const dynamic = "force-dynamic";

/**
 * AI drafting can take ~10s. Set on the layout rather than per page because a
 * server action POSTs to whatever route is in the address bar, and the draft
 * composer renders inside PersonDetail — which /people, /drafts and /graph all
 * mount. Page-level would be three edits and a silent miss on /graph.
 */
export const maxDuration = 60;

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [groups, settings, connections, setup] = await Promise.all([
    listGroups(),
    getSettings(),
    getConnectionStatuses(),
    getSetupStatus(),
  ]);
  // Synchronous disk read, so it stays out of the Promise.all above.
  const skills = listSkillSummaries();
  return (
    <>
      {/* Runs before the app below it paints, so the theme never flashes. */}
      <script
        dangerouslySetInnerHTML={{ __html: themeInitScript(settings.theme) }}
      />
      <AppShell
        groups={groups}
        settings={settings}
        connections={connections}
        setup={setup}
        skills={skills}
      >
        {children}
      </AppShell>
    </>
  );
}
