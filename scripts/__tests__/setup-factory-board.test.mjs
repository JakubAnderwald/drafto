// scripts/setup-factory-board.sh against a stubbed `gh` on PATH.
//
// The bug being pinned: the script used to send updateProjectV2Field the full
// Status option list WITHOUT option ids. GitHub treats an option sent without
// its id as a new option, which clears the Status of every card in the old
// one — so a re-run to add a column could wipe the whole board. Existing ids
// must be carried over, an unlisted option must not be dropped silently, and
// --dry-run must mutate nothing.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const boardPath = resolve(HERE, "..", "setup-factory-board.sh");
const labelsPath = resolve(HERE, "..", "setup-factory-labels.sh");
const agentPath = resolve(HERE, "..", "factory-agent.sh");
const boardScript = readFileSync(boardPath, "utf8");
const labelsScript = readFileSync(labelsPath, "utf8");
const agentScript = readFileSync(agentPath, "utf8");

const EXPECTED_ORDER = [
  "Backlog",
  "Ready",
  "Planning",
  "Plan Review",
  "In Progress",
  "In Review",
  "Testing",
  "In Test",
  "Approved",
  "Released",
  "Done",
  "Blocked",
];

// The live board before this change: eleven options, no Testing. Two carry a
// colour / description the script's defaults don't, to prove they're kept.
function liveOptions() {
  return [
    { id: "opt_backlog", name: "Backlog", color: "GRAY", description: "" },
    { id: "opt_ready", name: "Ready", color: "GREEN", description: "" },
    { id: "opt_planning", name: "Planning", color: "BLUE", description: "" },
    { id: "opt_plan_review", name: "Plan Review", color: "PURPLE", description: "" },
    { id: "opt_in_progress", name: "In Progress", color: "YELLOW", description: "" },
    { id: "opt_in_review", name: "In Review", color: "BLUE", description: "PR open" },
    { id: "opt_in_test", name: "In Test", color: "GREEN", description: "" },
    { id: "opt_approved", name: "Approved", color: "GREEN", description: "" },
    { id: "opt_released", name: "Released", color: "GREEN", description: "" },
    { id: "opt_done", name: "Done", color: "PINK", description: "" },
    { id: "opt_blocked", name: "Blocked", color: "RED", description: "" },
  ];
}

// A CommonJS `gh` stand-in: answers each GraphQL call the script makes from a
// fixture file and logs every call (args + stdin) as one JSON line.
const GH_STUB = `#!${process.execPath}
const fs = require("fs");
const args = process.argv.slice(2);
const fx = JSON.parse(fs.readFileSync(process.env.GH_STUB_FIXTURE, "utf8"));
const stdin = args.includes("--input") ? fs.readFileSync(0, "utf8") : "";
fs.appendFileSync(process.env.GH_STUB_LOG, JSON.stringify({ args, stdin }) + "\\n");
const text = (args.find((a) => a.startsWith("query=")) || "") + stdin;
function reply(obj) {
  fs.writeSync(1, JSON.stringify(obj));
  process.exit(0);
}
if (args[0] !== "api" || args[1] !== "graphql") {
  fs.writeSync(2, "unexpected gh call: " + args.join(" "));
  process.exit(1);
}
if (text.includes("updateProjectV2Field")) {
  if (fx.updateError) {
    // gh prints the body and exits 1 when the response carries errors.
    fs.writeSync(1, JSON.stringify({ errors: [{ message: fx.updateError }] }));
    fs.writeSync(2, "gh: " + fx.updateError);
    process.exit(1);
  }
  const body = JSON.parse(stdin);
  let n = 0;
  const options = body.variables.options.map((o) => ({
    id: fx.regenerateIds || !o.id ? "NEW_" + ++n : o.id,
    name: o.name,
  }));
  reply({ data: { updateProjectV2Field: { projectV2Field: { id: body.variables.fieldId, options } } } });
}
if (text.includes("createProjectV2")) {
  reply({ data: { createProjectV2: { projectV2: { id: "PVT_NEW", number: 9, title: "Drafto Factory" } } } });
}
if (text.includes("linkProjectV2ToRepository")) {
  reply({ data: { linkProjectV2ToRepository: { repository: { nameWithOwner: "tester/drafto" } } } });
}
if (text.includes("viewer")) reply({ data: { viewer: { id: "U_1", login: "tester" } } });
if (text.includes("projectsV2")) reply({ data: { user: { projectsV2: { nodes: fx.projects } } } });
if (text.includes("fields(first")) {
  reply({
    data: {
      node: {
        fields: {
          nodes: [
            { __typename: "ProjectV2Field" },
            { __typename: "ProjectV2SingleSelectField", id: "F_PRIORITY", name: "Priority", options: [] },
            { __typename: "ProjectV2SingleSelectField", id: "F_STATUS", name: "Status", options: fx.statusOptions },
          ],
        },
      },
    },
  });
}
if (text.includes("repository(owner")) reply({ data: { repository: { id: "R_1" } } });
fs.writeSync(2, "unmatched gh call: " + args.join(" "));
process.exit(1);
`;

function runBoard({
  statusOptions = liveOptions(),
  projects = [{ id: "PVT_1", number: 1, title: "Drafto Factory" }],
  regenerateIds = false,
  updateError = null,
  args = [],
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), "setup-factory-board-"));
  try {
    const gh = join(dir, "gh");
    writeFileSync(gh, GH_STUB);
    chmodSync(gh, 0o755);
    const fixture = join(dir, "fixture.json");
    writeFileSync(fixture, JSON.stringify({ statusOptions, projects, regenerateIds, updateError }));
    const logFile = join(dir, "gh.log");
    writeFileSync(logFile, "");
    const res = spawnSync("bash", [boardPath, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        GH_STUB_FIXTURE: fixture,
        GH_STUB_LOG: logFile,
      },
    });
    const calls = readFileSync(logFile, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const text = (c) => c.args.join(" ") + c.stdin;
    const updates = calls.filter((c) => text(c).includes("updateProjectV2Field"));
    const mutations = calls.filter((c) => /\bmutation\b/.test(text(c)));
    return {
      status: res.status,
      stdout: res.stdout,
      stderr: res.stderr,
      calls,
      updates,
      mutations,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function sentOptions(update) {
  return JSON.parse(update.stdin).variables.options;
}

describe("setup-factory-board.sh", () => {
  it("passes bash -n", () => {
    const r = spawnSync("bash", ["-n", boardPath], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  });

  it("--help prints the whole header and nothing past it", () => {
    const r = spawnSync("bash", [boardPath, "--help"], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /--dry-run/);
    assert.match(r.stdout, /--allow-drop/);
    assert.match(r.stdout, /Either must have `project`/);
    assert.doesNotMatch(r.stdout, /set -euo pipefail/);
  });

  it("carries every existing option id and inserts Testing between In Review and In Test", () => {
    const r = runBoard();
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.updates.length, 1, "exactly one field update");
    const sent = sentOptions(r.updates[0]);
    assert.deepEqual(
      sent.map((o) => o.name),
      EXPECTED_ORDER,
    );
    for (const live of liveOptions()) {
      const o = sent.find((s) => s.name === live.name);
      assert.equal(o.id, live.id, `${live.name} must keep its option id`);
      // An existing option keeps its colour + description, even off-default.
      assert.equal(o.color, live.color, `${live.name} colour`);
      assert.equal(o.description, live.description, `${live.name} description`);
    }
    const testing = sent.find((o) => o.name === "Testing");
    assert.equal(testing.id, undefined, "a new option is sent without an id");
    assert.equal(testing.color, "ORANGE");
    assert.equal(typeof testing.description, "string");
    // The link step still runs after a real update.
    assert.ok(r.calls.some((c) => c.args.join(" ").includes("linkProjectV2ToRepository")));
  });

  it("refuses to drop an option STATUS_OPTIONS doesn't list, and mutates nothing", () => {
    const r = runBoard({
      statusOptions: [
        ...liveOptions(),
        { id: "opt_icebox", name: "Icebox", color: "GRAY", description: "" },
      ],
    });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /Icebox/);
    assert.match(r.stderr, /--allow-drop/);
    assert.equal(r.mutations.length, 0, "no update, create or link on refusal");
  });

  it("refuses a duplicate-named option too (matched by id, not name)", () => {
    const r = runBoard({
      statusOptions: [
        ...liveOptions(),
        { id: "opt_done_2", name: "Done", color: "GRAY", description: "" },
      ],
    });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /Done/);
    assert.equal(r.mutations.length, 0);
  });

  it("--allow-drop deletes the unlisted option but still preserves the rest", () => {
    const r = runBoard({
      statusOptions: [
        ...liveOptions(),
        { id: "opt_icebox", name: "Icebox", color: "GRAY", description: "" },
      ],
      args: ["--allow-drop"],
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /--allow-drop: deleting Status option\(s\)[^\n]*Icebox/);
    const sent = sentOptions(r.updates[0]);
    assert.deepEqual(
      sent.map((o) => o.name),
      EXPECTED_ORDER,
    );
    assert.equal(sent.find((o) => o.name === "In Test").id, "opt_in_test");
  });

  it("--dry-run prints the payload with ids and performs no mutation", () => {
    const r = runBoard({ args: ["--dry-run"] });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.mutations.length, 0, "dry run must not mutate");
    assert.match(r.stdout, /"id": "opt_in_review"/);
    assert.match(r.stdout, /"id": "opt_in_test"/);
    assert.match(r.stdout, /"name": "Testing"/);
    assert.match(r.stdout, /"fieldId": "F_STATUS"/);
    assert.match(r.stdout, /nothing was created, updated or linked/);
  });

  it("--dry-run still refuses a drop", () => {
    const r = runBoard({
      statusOptions: [
        ...liveOptions(),
        { id: "opt_icebox", name: "Icebox", color: "GRAY", description: "" },
      ],
      args: ["--dry-run"],
    });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /Icebox/);
    assert.equal(r.mutations.length, 0);
  });

  it("--dry-run against a missing project creates nothing", () => {
    const r = runBoard({ projects: [], args: ["--dry-run"] });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /DRY-RUN: project 'Drafto Factory' does not exist/);
    assert.equal(r.mutations.length, 0);
  });

  it("sends no field update when the options already match", () => {
    const current = [
      ...liveOptions().slice(0, 6),
      { id: "opt_testing", name: "Testing", color: "ORANGE", description: "" },
      ...liveOptions().slice(6),
    ];
    const r = runBoard({ statusOptions: current });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.updates.length, 0);
    assert.match(r.stdout, /already match STATUS_OPTIONS/);
  });

  it("bootstraps a brand-new project, replacing GitHub's default options without --allow-drop", () => {
    // createProjectV2 seeds Status with Todo / In Progress / Done.
    const r = runBoard({
      projects: [],
      statusOptions: [
        { id: "def_todo", name: "Todo", color: "GREEN", description: "" },
        { id: "def_in_progress", name: "In Progress", color: "YELLOW", description: "" },
        { id: "def_done", name: "Done", color: "PURPLE", description: "" },
      ],
    });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.calls.some((c) => c.args.join(" ").includes("createProjectV2")));
    assert.match(r.stdout, /New project: replacing GitHub's default Status option\(s\)[^\n]*Todo/);
    const sent = sentOptions(r.updates[0]);
    assert.deepEqual(
      sent.map((o) => o.name),
      EXPECTED_ORDER,
    );
    assert.equal(sent.find((o) => o.name === "In Progress").id, "def_in_progress");
    assert.equal(sent.find((o) => o.name === "Done").id, "def_done");
  });

  it("reports a GraphQL error on the update instead of dying silently", () => {
    const r = runBoard({ updateError: "Invalid option color" });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /ERROR: updateProjectV2Field failed \(gh exit 1\)/);
    assert.match(r.stderr, /Invalid option color/);
    assert.match(r.stderr, /export-statuses/);
    assert.ok(!r.calls.some((c) => c.args.join(" ").includes("linkProjectV2ToRepository")));
  });

  it("fails loudly when GitHub hands back different option ids", () => {
    const r = runBoard({ regenerateIds: true });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /came back with a different id/);
    assert.match(r.stderr, /export-statuses/);
  });
});

describe("board options, status labels and factory-agent stay in sync", () => {
  const boardOptions = (() => {
    const m = boardScript.match(/^STATUS_OPTIONS=\(\n([\s\S]*?)\n\)/m);
    assert.ok(m, "could not find STATUS_OPTIONS");
    return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
  })();
  const repoLabels = [...labelsScript.matchAll(/"(status:[a-z-]+)\|/g)].map((x) => x[1]);
  const allStatusLabels = (() => {
    const m = agentScript.match(/^ALL_STATUS_LABELS="([^"]+)"/m);
    assert.ok(m, "could not find ALL_STATUS_LABELS");
    return m[1].split(",");
  })();
  const labelFor = (() => {
    const start = agentScript.indexOf("\nstatus_label_for() {");
    assert.ok(start !== -1, "could not find status_label_for");
    const fn = agentScript.slice(start + 1, agentScript.indexOf("\n}\n", start) + 2);
    const loop = boardOptions.map(
      (n) => `printf '%s=%s\\n' ${JSON.stringify(n)} "$(status_label_for ${JSON.stringify(n)})"`,
    );
    const r = spawnSync("bash", ["-c", [fn, ...loop].join("\n")], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return Object.fromEntries(
      r.stdout
        .trim()
        .split("\n")
        .map((l) => l.split("=")),
    );
  })();

  it("lists the expected columns in order", () => {
    assert.deepEqual(boardOptions, EXPECTED_ORDER);
  });

  it("maps every column but Backlog to a label in both label lists", () => {
    for (const name of boardOptions) {
      const label = labelFor[name];
      if (name === "Backlog") {
        assert.equal(label, "", "Backlog is the implicit no-label state");
        continue;
      }
      assert.ok(label, `${name} has no status_label_for mapping`);
      assert.ok(allStatusLabels.includes(label), `${label} missing from ALL_STATUS_LABELS`);
      assert.ok(repoLabels.includes(label), `${label} missing from setup-factory-labels.sh`);
    }
  });

  it("has no status label without a column", () => {
    const mapped = new Set(Object.values(labelFor).filter(Boolean));
    assert.deepEqual([...allStatusLabels].sort(), [...mapped].sort());
    assert.deepEqual([...repoLabels].sort(), [...mapped].sort());
  });

  it("maps Testing to status:testing", () => {
    assert.equal(labelFor.Testing, "status:testing");
    assert.match(
      labelsScript,
      /"status:testing\|D93F0B\|Factory is running automated verification before In Test\."/,
    );
  });
});
