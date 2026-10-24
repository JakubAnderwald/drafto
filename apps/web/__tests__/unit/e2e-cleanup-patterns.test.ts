/**
 * @vitest-environment node
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import config from "../../playwright.config";
import {
  STALE_AFTER_MS,
  isE2EName,
  isE2ENotebook,
  selectStale,
  type NoteRow,
  type NotebookRow,
} from "../../e2e/helpers/e2e-patterns";

/**
 * Guards the web E2E suite's data hygiene (#724): every timestamped name a spec creates
 * must be one the stale purge recognises, and the cleanup must stay wired in. The
 * original cleanup helper had neither: its patterns missed names the specs used, and
 * nothing called it, so the dev account piled up 1,800 notebooks.
 */

const E2E_DIR = path.resolve(__dirname, "../../e2e");
const REPO_ROOT = path.resolve(__dirname, "../../../..");

/** A `Date.now()` value and a `date +%s` value, the two timestamp shapes E2E names carry. */
const SAMPLE_MS = "1760000000000";
const SAMPLE_S = "1760000000";

function filesUnder(dir: string, extensions: readonly string[]): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return filesUnder(full, extensions);
    return extensions.some((extension) => entry.name.endsWith(extension)) ? [full] : [];
  });
}

function e2eSourceFiles(): string[] {
  return filesUnder(E2E_DIR, [".ts"]);
}

function specFiles(): string[] {
  return e2eSourceFiles().filter((file) => file.endsWith(".spec.ts"));
}

/**
 * Every `` `<Name> ${timestamp}` `` template literal in a source file, with a sample
 * timestamp substituted. A timestamp is `Date.now()` itself, a variable assigned
 * `Date.now()` (13 digits), or one assigned the cross-platform runner's
 * `XPLAT_RUN_ID` (`date +%s`, 10 digits).
 */
function timestampedNames(source: string): string[] {
  const samples = new Map<string, string>([["Date.now()", SAMPLE_MS]]);
  for (const [, name, value] of source.matchAll(
    /\b(?:const|let)\s+(\w+)\s*=\s*(Date\.now\(\)|process\.env\.XPLAT_RUN_ID)/g,
  )) {
    samples.set(name, value === "Date.now()" ? SAMPLE_MS : SAMPLE_S);
  }

  const names: string[] = [];
  for (const [, prefix, expression] of source.matchAll(/`([^`$]+) \$\{\s*([\w.()]+)\s*\}`/g)) {
    const sample = samples.get(expression);
    if (sample) names.push(`${prefix} ${sample}`);
  }
  return names;
}

/** Typed with a run id, but into a note's body rather than a name. */
const NOT_NAMES = new Set(["Body"]);

/**
 * The names the other E2E runners type into the same dev account, with a sample
 * `date +%s` timestamp substituted: every `inputText: "<Name> ${RUN_ID}"` in the Maestro
 * flows, and every `"<Name> $(date +%s)"` in the mobile and macOS runner scripts.
 */
function runnerNames(): Array<{ file: string; name: string }> {
  const sources = [
    ...filesUnder(path.join(REPO_ROOT, "apps/mobile/e2e"), [".yaml", ".yml", ".sh"]),
    ...filesUnder(path.join(REPO_ROOT, "apps/desktop/e2e"), [".sh"]),
  ];
  return sources.flatMap((file) => {
    const source = readFileSync(file, "utf8");
    const prefixes = [
      ...source.matchAll(/inputText:\s*"([^"$]+) \$\{RUN_ID\}"/g),
      ...source.matchAll(/"([^"$]+) \$\(date \+%s\)"/g),
    ].map(([, prefix]) => prefix);
    return prefixes
      .filter((prefix) => !NOT_NAMES.has(prefix))
      .map((prefix) => ({ file: path.relative(REPO_ROOT, file), name: `${prefix} ${SAMPLE_S}` }));
  });
}

describe("E2E name patterns", () => {
  const names = e2eSourceFiles().flatMap((file) =>
    timestampedNames(readFileSync(file, "utf8")).map((name) => ({
      file: path.relative(E2E_DIR, file),
      name,
    })),
  );

  it("finds the timestamped names the specs create", () => {
    const found = names.map(({ name }) => name);
    expect(found).toEqual(
      expect.arrayContaining([
        `Target ${SAMPLE_MS}`,
        `Export NB ${SAMPLE_MS}`,
        `Import NB ${SAMPLE_MS}`,
        `SSR NB ${SAMPLE_MS}`,
        `Move Source ${SAMPLE_MS}`,
        `XPlat NB ${SAMPLE_S}`,
        `XPlat Sync Edited ${SAMPLE_MS}`,
      ]),
    );
  });

  it("covers every timestamped name under apps/web/e2e", () => {
    const unmatched = names.filter(({ name }) => !isE2EName(name));
    // A failure here names a spec that creates data the purge can't recognise: add its
    // prefix to E2E_NAME_PREFIXES in e2e/helpers/e2e-patterns.ts.
    expect(unmatched).toEqual([]);
  });

  it("covers the Maestro and macOS runner names that land in the same account", () => {
    const found = runnerNames();
    expect(found.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        `RENAMED ${SAMPLE_S}`,
        `NB2R ${SAMPLE_S}`,
        `E2E Notebook ${SAMPLE_S}`,
      ]),
    );
    // A failure here names a flow or script that creates data the purge can't recognise:
    // add its prefix to E2E_NAME_PREFIXES in e2e/helpers/e2e-patterns.ts.
    expect(found.filter(({ name }) => !isE2EName(name))).toEqual([]);
  });

  it("only matches a whole name ending in a 10–13 digit timestamp", () => {
    expect(isE2EName(`Target ${SAMPLE_MS}`)).toBe(true);
    expect(isE2EName(`Target ${SAMPLE_S}`)).toBe(true);
    expect(isE2EName("Target 123")).toBe(false);
    expect(isE2EName("Target")).toBe(false);
    expect(isE2EName(`My Target ${SAMPLE_MS}`)).toBe(false);
    expect(isE2EName(`Target ${SAMPLE_MS} copy`)).toBe(false);
    expect(isE2EName(`target ${SAMPLE_MS}`)).toBe(false);
    expect(isE2EName(`Target  ${SAMPLE_MS}`)).toBe(false);
    expect(isE2EName(`XPlat ${SAMPLE_MS}`)).toBe(false);
  });

  it("leaves the seed notebook and untimestamped names alone", () => {
    for (const name of ["Notes", "sample", "Untitled", "Evernote Import", "Second Note"]) {
      expect(isE2EName(name)).toBe(false);
    }
    // The factory browser runner tags its data `factory-<n>-<sha>`, in a separate account.
    expect(isE2EName("factory-724-0a1b2c3 notebook")).toBe(false);
  });
});

describe("selectStale", () => {
  const now = new Date("2026-10-20T12:00:00.000Z");
  const cutoff = new Date(now.getTime() - STALE_AFTER_MS);
  const old = "2026-10-18T12:00:00.000000+00:00";
  const recent = "2026-10-20T11:00:00.000000+00:00";

  function notebook(id: string, name: string, updated_at: string): NotebookRow {
    return { id, name, updated_at };
  }
  function note(id: string, notebook_id: string, title: string, updated_at: string): NoteRow {
    return { id, notebook_id, title, updated_at };
  }

  it("selects E2E-named notebooks and notes untouched since the cutoff", () => {
    const result = selectStale(
      {
        notebooks: [notebook("nb-old", `Target ${SAMPLE_MS}`, old)],
        notes: [note("n-old", "seed", `E2E Test Note ${SAMPLE_MS}`, old)],
      },
      cutoff,
    );
    expect(result).toEqual({
      e2eNotebookIds: ["nb-old"],
      e2eNoteIds: ["n-old"],
      notebookIds: ["nb-old"],
      noteIds: ["n-old"],
    });
  });

  it("keeps rows touched within the cutoff, even when they were created long ago", () => {
    const result = selectStale(
      {
        // `updated_at` is bumped by every update, so a recent value means the row is live.
        notebooks: [notebook("nb-recent", `Target ${SAMPLE_MS}`, recent)],
        notes: [note("n-recent", "seed", `Move Me ${SAMPLE_MS}`, recent)],
      },
      cutoff,
    );
    expect(result).toEqual({
      e2eNotebookIds: ["nb-recent"],
      e2eNoteIds: ["n-recent"],
      notebookIds: [],
      noteIds: [],
    });
  });

  it("keeps a stale notebook that holds a recently updated note, whatever its title", () => {
    const result = selectStale(
      {
        notebooks: [notebook("nb", `XPlat NB ${SAMPLE_S}`, old)],
        notes: [
          note("n-live", "nb", "Untitled", recent),
          note("n-stale", "nb", `XPlat Sync ${SAMPLE_S}`, old),
        ],
      },
      cutoff,
    );
    expect(result.notebookIds).toEqual([]);
    // The notebook stays, but its own stale E2E-named note still goes.
    expect(result.noteIds).toEqual(["n-stale"]);
  });

  it("leaves the notes of a purged notebook to the cascade", () => {
    const result = selectStale(
      {
        notebooks: [notebook("nb", `Export NB ${SAMPLE_MS}`, old)],
        notes: [note("n", "nb", `Export Test Note ${SAMPLE_MS}`, old)],
      },
      cutoff,
    );
    expect(result).toMatchObject({ notebookIds: ["nb"], noteIds: [] });
  });

  it("never selects rows whose name doesn't match, however old", () => {
    const result = selectStale(
      {
        notebooks: [notebook("seed", "Notes", old), notebook("import", "Evernote Import", old)],
        notes: [note("untitled", "seed", "Untitled", old)],
      },
      cutoff,
    );
    expect(result).toEqual({ e2eNotebookIds: [], e2eNoteIds: [], notebookIds: [], noteIds: [] });
  });

  it("purges the old import spec's `sample` notebooks while they hold only its kind of notes", () => {
    const result = selectStale(
      {
        notebooks: [
          notebook("empty", "sample", old),
          notebook("fixture", "sample", old),
          notebook("mixed", "sample", old),
          notebook("user", "sample", old),
          notebook("fresh", "sample", recent),
        ],
        notes: [
          note("f1", "fixture", "Welcome to Drafto", old),
          note("f2", "fixture", "Second Note", old),
          note("m1", "mixed", "Untitled", old),
          note("m2", "mixed", `E2E Test Note ${SAMPLE_MS}`, old),
          note("u1", "user", "Welcome to Drafto", old),
          note("u2", "user", "Shopping list", old),
        ],
      },
      cutoff,
    );
    expect(result.e2eNotebookIds).toEqual(["empty", "fixture", "mixed", "fresh"]);
    expect(result.notebookIds).toEqual(["empty", "fixture", "mixed"]);
    // The fixture's titles aren't E2E names on their own: in any other notebook they stay.
    expect(result.noteIds).toEqual([]);
  });

  it("only treats the exact name `sample` as the legacy import notebook", () => {
    expect(isE2ENotebook("sample", ["Welcome to Drafto"])).toBe(true);
    expect(isE2ENotebook("Sample", [])).toBe(false);
    expect(isE2ENotebook("sample 2", [])).toBe(false);
    expect(isE2ENotebook(`Target ${SAMPLE_MS}`, ["Shopping list"])).toBe(true);
  });

  it("treats an unparseable timestamp as live", () => {
    const result = selectStale(
      { notebooks: [notebook("nb", `Target ${SAMPLE_MS}`, "not a date")], notes: [] },
      cutoff,
    );
    expect(result.notebookIds).toEqual([]);
  });

  it("uses a one-day cutoff", () => {
    expect(STALE_AFTER_MS).toBe(24 * 60 * 60 * 1000);
  });
});

describe("E2E cleanup wiring", () => {
  const projects = config.projects ?? [];
  const byName = new Map(projects.map((project) => [project.name, project]));

  it("registers the stale purge with the run-end teardown", () => {
    expect(byName.get("purge-stale")).toMatchObject({
      testMatch: /purge\.setup\.ts/,
      teardown: "cleanup-run",
    });
    expect(byName.get("cleanup-run")).toMatchObject({ testMatch: /cleanup-run\.teardown\.ts/ });
  });

  it("makes every project that signs in as the E2E user depend on the purge", () => {
    const e2eUserProjects = projects.filter(
      (project) => project.use?.storageState === "e2e/.auth/user.json",
    );
    expect(e2eUserProjects.map((project) => project.name)).toEqual(
      expect.arrayContaining(["chromium", "Mobile Chrome", "Mobile Safari", "Tablet"]),
    );
    for (const project of e2eUserProjects) {
      expect(project.dependencies).toEqual(expect.arrayContaining(["setup", "purge-stale"]));
    }
  });

  it("has every spec that creates data in the browser use the cleanup test fixture", () => {
    const creating = specFiles().filter((file) =>
      /name: "New note"|name: "New notebook"|start-import-button/.test(readFileSync(file, "utf8")),
    );
    expect(creating.length).toBeGreaterThan(0);
    for (const file of creating) {
      const source = readFileSync(file, "utf8");
      expect(source, path.basename(file)).toMatch(
        /import \{[^}]*\btest\b[^}]*\} from "\.\/helpers\/test"/,
      );
      expect(source, path.basename(file)).not.toMatch(
        /import \{[^}]*\btest\b[^}]*\} from "@playwright\/test"/,
      );
    }
  });

  it("has every spec that creates notebooks over `request` record them for the teardown", () => {
    const creating = specFiles().filter((file) =>
      /\.post\(\s*"\/api\/notebooks",\s*\{\s*data:\s*\{\s*name:\s*[A-Za-z_]/.test(
        readFileSync(file, "utf8"),
      ),
    );
    expect(creating.map((file) => path.basename(file))).toEqual(
      expect.arrayContaining(["cross-platform-sync.spec.ts", "note-sync.spec.ts", "notes.spec.ts"]),
    );
    for (const file of creating) {
      expect(readFileSync(file, "utf8"), path.basename(file)).toMatch(/recordRunNotebook\(/);
    }
  });
});
