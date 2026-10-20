import { test as base, type BrowserContext, type TestInfo } from "@playwright/test";
import { deleteNotesById } from "./cleanup";
import { CreatedDataTracker, type CreatedData } from "./created-data-tracker";
import { lazyE2ESession, type LazyE2ESession } from "./e2e-supabase";
import { recordRunNotebooks } from "./run-notebooks";

export { expect } from "@playwright/test";

/** How long teardown waits for create calls still in flight when a test ends. */
const SETTLE_TIMEOUT_MS = 10_000;
/** How long cleanup waits for calls the closing context cut off to report back. */
const CLOSED_SETTLE_TIMEOUT_MS = 1_000;

interface TestFixtures {
  context: BrowserContext;
  /** Collects what the test creates in the browser, and cleans it up once the context has closed. */
  _e2eCreatedData: CreatedDataTracker;
}

interface WorkerFixtures {
  /** The E2E user's cleanup session, signed in on first use. */
  e2eSession: LazyE2ESession;
}

function describeTest(testInfo: TestInfo): string {
  return testInfo.titlePath.join(" › ");
}

function warn(testInfo: TestInfo, message: string): void {
  console.warn(`[e2e cleanup] ${describeTest(testInfo)}: ${message}`);
}

async function deleteCreatedNotes(
  session: LazyE2ESession,
  created: CreatedData,
  testInfo: TestInfo,
): Promise<void> {
  if (created.noteIds.length === 0) return;
  try {
    const result = await deleteNotesById(await session.get(), created.noteIds);
    if (result.failed.length > 0) {
      warn(
        testInfo,
        `could not delete notes ${result.failed.join(", ")} (${result.errors.join("; ")})`,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warn(testInfo, `could not delete notes ${created.noteIds.join(", ")} (${message})`);
  }
}

/**
 * Playwright's `test`, plus cleanup of what each test creates in the browser. Use it in
 * every spec that creates notebooks or notes as the E2E user.
 *
 * The `context` override watches the app's create calls (`created-data-tracker.ts`).
 * After each test, pass or fail, and once the browser context has closed,
 * `_e2eCreatedData` hard-deletes the notes the test created and records its notebooks
 * for the run-end teardown (`run-notebooks.ts`). Data created over
 * `request` isn't seen: record those notebooks with `recordRunNotebook`, or leave them to
 * the pre-run purge. Cleanup errors are logged, never thrown, so they can't fail a green
 * test, and a retry would only create more data.
 */
export const test = base.extend<TestFixtures, WorkerFixtures>({
  e2eSession: [
    async ({}, provide) => {
      const session = lazyE2ESession();
      await provide(session);
      await session.release();
    },
    { scope: "worker" },
  ],

  // The fixture callbacks are `provide`, not Playwright's usual `use`: the React hooks lint
  // rule reads a `use()` call as React's hook.
  _e2eCreatedData: async ({ e2eSession }, provide, testInfo) => {
    const tracker = new CreatedDataTracker();
    await provide(tracker);

    const created = await tracker.settle(CLOSED_SETTLE_TIMEOUT_MS);
    if (created.unsettled > 0) {
      warn(testInfo, `${created.unsettled} create call(s) still unanswered; left to the purge`);
    }
    for (const error of created.errors) warn(testInfo, error);

    try {
      recordRunNotebooks(testInfo, created.notebookIds);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warn(testInfo, `could not record notebooks ${created.notebookIds.join(", ")} (${message})`);
    }
    await deleteCreatedNotes(e2eSession, created, testInfo);
  },

  // `_e2eCreatedData` comes first, so Playwright sets it up before the browser context and
  // tears it down after the context has closed. The notes are then deleted only after
  // Playwright has captured a failed test's page snapshot and trace, which would otherwise
  // show the open editor reacting to its note vanishing.
  context: async ({ _e2eCreatedData, context }, provide) => {
    context.on("request", _e2eCreatedData.onRequest);
    await provide(context);
    // While the context is still open, so the responses of in-flight calls can be read.
    await _e2eCreatedData.settle(SETTLE_TIMEOUT_MS);
    context.off("request", _e2eCreatedData.onRequest);
  },
});
