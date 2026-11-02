import { SettingsContent } from "@/components/settings/settings-content";
import { getBuildCommit } from "@/lib/build-info";

// Rendered per request, so the build line comes from the running deployment's environment
// rather than a value frozen into a page prerendered at build time.
export const dynamic = "force-dynamic";

export default function SettingsPage() {
  const buildCommit = getBuildCommit()?.slice(0, 7) ?? null;
  return <SettingsContent buildCommit={buildCommit} />;
}
