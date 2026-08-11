import { listGroups } from "@/lib/actions/contacts";
import { getSettings } from "@/lib/actions/settings";
import { getConnectionStatuses } from "@/lib/actions/connections";
import { getSetupStatus } from "@/lib/actions/setup";
import { themeInitScript } from "@/lib/theme";
import { AppShell } from "@/components/app-shell";

export const dynamic = "force-dynamic";

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
      >
        {children}
      </AppShell>
    </>
  );
}
