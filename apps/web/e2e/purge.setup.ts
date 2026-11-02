import { test as setup } from "@playwright/test";
import { purgeStaleE2EData, type PurgeTableReport } from "./helpers/cleanup";
import { signInAsE2EUser, signOutE2EUser } from "./helpers/e2e-supabase";

/**
 * Deletes the E2E user's E2E-named notebooks and notes that nothing has touched for a
 * day, before any test runs. It catches what the per-test and run-end cleanup can't: a
 * run that was killed before its teardown, and data created over `request`.
 *
 * Runs in the `purge-stale` project, which every E2E-user test project depends on. An
 * error fails it, which skips the suite the same way a failed `auth.setup` does: a purge
 * that silently never ran is how the dev account piled up 1,800 notebooks (#724).
 */

function describe(table: string, report: PurgeTableReport): string {
  return `${table}: ${report.purged} purged, ${report.kept} E2E-named kept, ${report.scanned} scanned`;
}

setup("purge stale E2E data", async () => {
  // A purge of a large backlog pages through every row the E2E user owns.
  setup.setTimeout(5 * 60_000);

  const session = await signInAsE2EUser();
  try {
    const report = await purgeStaleE2EData(session);
    console.log(
      `[e2e cleanup] stale purge (untouched since ${report.cutoff}) — ` +
        `${describe("notebooks", report.notebooks)}; ${describe("notes", report.notes)}`,
    );
  } finally {
    await signOutE2EUser(session).catch(() => {});
  }
});
