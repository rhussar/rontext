import { listGroups } from "@/lib/actions/contacts";
import { AppShell } from "@/components/app-shell";

export const dynamic = "force-dynamic";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const groups = await listGroups();
  return <AppShell groups={groups}>{children}</AppShell>;
}
