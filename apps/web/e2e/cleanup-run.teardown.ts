import { test as teardown } from "@playwright/test";
import { deleteNotebooksById } from "./helpers/cleanup";
import { signInAsE2EUser, signOutE2EUser, type E2ESession } from "./helpers/e2e-supabase";
import { clearRunNotebooks, readRunNotebooks } from "./helpers/run-notebooks";

/**
 * Deletes the notebooks this run created, with their notes, once every test project has
 * finished, pass or fail. It's the `teardown` of the `purge-stale` project.
 *
 * It deletes exactly the ids the run recorded (`helpers/run-notebooks.ts`) and never by
 * name: factory slots and pull-request CI share one dev account, and a delete by pattern
 * would take a concurrent run's data with it. Errors are logged, not thrown. Anything
 * left behind is purged once it has sat untouched for a day.
 */

teardown("delete the notebooks this run created", async ({}, testInfo) => {
  const outputDir = testInfo.project.outputDir;
  const ids = readRunNotebooks(outputDir);
  if (ids.length === 0) {
    console.log("[e2e cleanup] run-end teardown: no notebooks recorded");
    return;
  }

  let session: E2ESession | undefined;
  try {
    session = await signInAsE2EUser();
    const result = await deleteNotebooksById(session, ids);
    const alreadyGone = ids.length - result.failed.length - result.deleted;
    const failed =
      result.failed.length > 0
        ? `; could not delete ${result.failed.join(", ")} (${result.errors.join("; ")})`
        : "";
    console.log(
      `[e2e cleanup] run-end teardown: deleted ${result.deleted} of ${ids.length} recorded ` +
        `notebook(s), ${alreadyGone} already gone${failed}`,
    );
    if (result.failed.length === 0) clearRunNotebooks(outputDir);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `[e2e cleanup] run-end teardown: could not delete notebooks ${ids.join(", ")} (${message})`,
    );
  } finally {
    if (session) await signOutE2EUser(session).catch(() => {});
  }
});
