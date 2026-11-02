import fs from "node:fs";
import path from "node:path";
import type { TestInfo } from "@playwright/test";

/**
 * The run-end teardown list: every notebook a test creates is appended here, and
 * `cleanup-run.teardown.ts` deletes them once every test project has finished. Notebooks
 * aren't deleted mid-run, because the notebook `/` auto-selects is the most recently
 * created one, including another worker's.
 *
 * It lives in the projects' shared output directory (`test-results/`), which Playwright
 * empties at the start of every run, with one file per worker so parallel appends never
 * interleave.
 */
const RUN_NOTEBOOKS_DIR = ".e2e-run-notebooks";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type RecordingTestInfo = Pick<TestInfo, "workerIndex"> & {
  project: Pick<TestInfo["project"], "outputDir">;
};

function runNotebooksDir(outputDir: string): string {
  return path.join(outputDir, RUN_NOTEBOOKS_DIR);
}

export function recordRunNotebooks(testInfo: RecordingTestInfo, ids: readonly string[]): void {
  const valid = ids.filter((id) => UUID.test(id));
  if (valid.length === 0) return;
  const dir = runNotebooksDir(testInfo.project.outputDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(
    path.join(dir, `worker-${testInfo.workerIndex}.txt`),
    valid.map((id) => `${id}\n`).join(""),
  );
}

/** Records a notebook a test created over `request`, which the response capture in `test.ts` can't see. */
export function recordRunNotebook(testInfo: RecordingTestInfo, id: string): void {
  recordRunNotebooks(testInfo, [id]);
}

/** Every notebook id recorded so far in this run, across all workers. */
export function readRunNotebooks(outputDir: string): string[] {
  const dir = runNotebooksDir(outputDir);
  if (!fs.existsSync(dir)) return [];
  const ids = new Set<string>();
  for (const file of fs.readdirSync(dir)) {
    for (const line of fs.readFileSync(path.join(dir, file), "utf8").split("\n")) {
      const id = line.trim();
      if (UUID.test(id)) ids.add(id);
    }
  }
  return [...ids];
}

export function clearRunNotebooks(outputDir: string): void {
  fs.rmSync(runNotebooksDir(outputDir), { recursive: true, force: true });
}
