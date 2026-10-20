import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

let lib;
let execCalls;

beforeEach(async () => {
  // Re-import so module-level shims (_execFileForTests, _cachedViewerLogin,
  // _metaCache) start from zero per test.
  lib = await import(`../lib/factory-project.mjs?t=${Date.now()}-${Math.random()}`);
  execCalls = [];
  lib._setSleepForTests(async () => {});
});

function makeExecFile(handlers) {
  return async (cmd, args) => {
    execCalls.push({ cmd, args });
    for (const { match, response } of handlers) {
      if (match(cmd, args)) {
        return typeof response === "function" ? await response(cmd, args) : response;
      }
    }
    throw new Error(`unmatched exec: ${cmd} ${args.join(" ")}`);
  };
}

function ghResp(payload) {
  return { stdout: JSON.stringify(payload) };
}

describe("shapeItems (pure)", () => {
  it("drops items whose content isn't an Issue", () => {
    const nodes = [
      { id: "I1", content: { __typename: "DraftIssue" } },
      { id: "I2", content: null },
      {
        id: "I3",
        content: {
          __typename: "Issue",
          number: 42,
          title: "ok",
          url: "u",
          state: "OPEN",
          repository: { nameWithOwner: "JakubAnderwald/drafto" },
          labels: { nodes: [{ name: "status:ready" }] },
        },
        fieldValues: {
          nodes: [
            {
              __typename: "ProjectV2ItemFieldSingleSelectValue",
              field: { name: "Status" },
              optionId: "OPT1",
              name: "Ready",
            },
          ],
        },
      },
    ];
    const out = lib.shapeItems(nodes, { statusName: "Ready" });
    assert.equal(out.length, 1);
    assert.equal(out[0].issueNumber, 42);
    assert.equal(out[0].status, "Ready");
    assert.deepEqual(out[0].labels, ["status:ready"]);
  });

  it("filters out items whose Status doesn't match", () => {
    const nodes = [
      {
        id: "I1",
        content: {
          __typename: "Issue",
          number: 1,
          title: "p",
          url: "u",
          state: "OPEN",
          repository: { nameWithOwner: "JakubAnderwald/drafto" },
          labels: { nodes: [] },
        },
        fieldValues: {
          nodes: [
            {
              __typename: "ProjectV2ItemFieldSingleSelectValue",
              field: { name: "Status" },
              optionId: "OPT1",
              name: "Planning",
            },
          ],
        },
      },
    ];
    assert.equal(lib.shapeItems(nodes, { statusName: "Ready" }).length, 0);
    // Case-insensitive on the status filter (defensive).
    assert.equal(lib.shapeItems(nodes, { statusName: "planning" }).length, 1);
  });

  it("filters out items whose repo doesn't match (cross-repo board defence)", () => {
    const nodes = [
      {
        id: "I1",
        content: {
          __typename: "Issue",
          number: 1,
          title: "p",
          url: "u",
          state: "OPEN",
          repository: { nameWithOwner: "Other/Repo" },
          labels: { nodes: [] },
        },
        fieldValues: { nodes: [] },
      },
    ];
    assert.equal(lib.shapeItems(nodes, { repo: "JakubAnderwald/drafto" }).length, 0);
  });

  it("returns items with Status = null when no Status field value is set (when no filter is applied)", () => {
    const nodes = [
      {
        id: "I1",
        content: {
          __typename: "Issue",
          number: 1,
          title: "x",
          url: "u",
          state: "OPEN",
          repository: { nameWithOwner: "JakubAnderwald/drafto" },
          labels: { nodes: [] },
        },
        fieldValues: { nodes: [] },
      },
    ];
    const out = lib.shapeItems(nodes, {});
    assert.equal(out.length, 1);
    assert.equal(out[0].status, null);
  });
});

describe("findProject (mocked gh)", () => {
  it("returns the matching project metadata", async () => {
    lib._setExecFileForTests(
      makeExecFile([
        {
          match: (cmd, args) =>
            cmd === "gh" &&
            args[0] === "api" &&
            args[1] === "graphql" &&
            args.includes("login=alice"),
          response: ghResp({
            data: {
              user: {
                projectsV2: {
                  nodes: [
                    { id: "PVT_xyz", number: 5, title: "Drafto Factory" },
                    { id: "PVT_abc", number: 6, title: "Something else" },
                  ],
                },
              },
            },
          }),
        },
      ]),
    );
    const r = await lib.findProject({ owner: "alice", title: "Drafto Factory" });
    assert.equal(r.projectId, "PVT_xyz");
    assert.equal(r.projectNumber, 5);
    assert.match(r.projectUrl, /\/users\/alice\/projects\/5$/);
  });

  it("returns null when the project is missing", async () => {
    lib._setExecFileForTests(
      makeExecFile([
        {
          match: (cmd, args) => cmd === "gh" && args[0] === "api",
          response: ghResp({ data: { user: { projectsV2: { nodes: [] } } } }),
        },
      ]),
    );
    const r = await lib.findProject({ owner: "alice", title: "Drafto Factory" });
    assert.equal(r, null);
  });

  it("falls back to the authenticated viewer login when no owner is passed", async () => {
    lib._setExecFileForTests(
      makeExecFile([
        {
          match: (cmd, args) =>
            cmd === "gh" &&
            args[0] === "api" &&
            args[1] === "graphql" &&
            args.some((a) => a.includes("viewer { login }")),
          response: ghResp({ data: { viewer: { login: "bob" } } }),
        },
        {
          match: (cmd, args) => cmd === "gh" && args.includes("login=bob"),
          response: ghResp({
            data: {
              user: {
                projectsV2: { nodes: [{ id: "PVT_1", number: 1, title: "Drafto Factory" }] },
              },
            },
          }),
        },
      ]),
    );
    const r = await lib.findProject({ title: "Drafto Factory" });
    assert.equal(r.projectId, "PVT_1");
    assert.match(r.projectUrl, /\/users\/bob\/projects\/1$/);
  });
});

describe("getStatusFieldMeta (mocked gh)", () => {
  it("returns the Status field id + options map", async () => {
    lib._setExecFileForTests(
      makeExecFile([
        {
          match: (cmd, args) => cmd === "gh" && args[0] === "api",
          response: ghResp({
            data: {
              node: {
                fields: {
                  nodes: [
                    { __typename: "ProjectV2Field", id: "F1", name: "Title" },
                    {
                      __typename: "ProjectV2SingleSelectField",
                      id: "F2",
                      name: "Status",
                      options: [
                        { id: "O_BACKLOG", name: "Backlog" },
                        { id: "O_READY", name: "Ready" },
                        { id: "O_PLANNING", name: "Planning" },
                      ],
                    },
                  ],
                },
              },
            },
          }),
        },
      ]),
    );
    const meta = await lib.getStatusFieldMeta("PVT_xyz");
    assert.equal(meta.statusFieldId, "F2");
    assert.equal(meta.optionsByName.Ready, "O_READY");
    assert.equal(meta.optionsByName.Planning, "O_PLANNING");
    assert.equal(meta.options.length, 3);
  });

  it("throws if no Status field is configured", async () => {
    lib._setExecFileForTests(
      makeExecFile([
        {
          match: (cmd, args) => cmd === "gh" && args[0] === "api",
          response: ghResp({ data: { node: { fields: { nodes: [] } } } }),
        },
      ]),
    );
    await assert.rejects(
      () => lib.getStatusFieldMeta("PVT_xyz"),
      /no single-select field named "Status"/,
    );
  });
});

describe("queryStatusItems (mocked gh)", () => {
  it("paginates and aggregates items matching the requested status", async () => {
    let call = 0;
    lib._setExecFileForTests(async (cmd, args) => {
      execCalls.push({ cmd, args });
      call += 1;
      if (call === 1) {
        return ghResp({
          data: {
            node: {
              items: {
                pageInfo: { hasNextPage: true, endCursor: "CUR_A" },
                nodes: [
                  {
                    id: "ITEM_1",
                    content: {
                      __typename: "Issue",
                      id: "I_1",
                      number: 10,
                      title: "a",
                      url: "u1",
                      state: "OPEN",
                      repository: { nameWithOwner: "JakubAnderwald/drafto" },
                      labels: { nodes: [] },
                    },
                    fieldValues: {
                      nodes: [
                        {
                          __typename: "ProjectV2ItemFieldSingleSelectValue",
                          field: { name: "Status" },
                          name: "Ready",
                        },
                      ],
                    },
                  },
                ],
              },
            },
          },
        });
      }
      return ghResp({
        data: {
          node: {
            items: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  id: "ITEM_2",
                  content: {
                    __typename: "Issue",
                    id: "I_2",
                    number: 11,
                    title: "b",
                    url: "u2",
                    state: "OPEN",
                    repository: { nameWithOwner: "JakubAnderwald/drafto" },
                    labels: { nodes: [] },
                  },
                  fieldValues: {
                    nodes: [
                      {
                        __typename: "ProjectV2ItemFieldSingleSelectValue",
                        field: { name: "Status" },
                        name: "Planning",
                      },
                    ],
                  },
                },
              ],
            },
          },
        },
      });
    });
    const items = await lib.queryStatusItems("PVT_xyz", "Ready");
    assert.equal(items.length, 1);
    assert.equal(items[0].issueNumber, 10);
    // Two pages requested (cursor flowed through).
    assert.equal(execCalls.length, 2);
    // Second call included the cursor token from the first.
    assert.ok(execCalls[1].args.some((a) => a === "cursor=CUR_A"));
  });
});

describe("setItemStatus / setItemStatusByName (mocked gh)", () => {
  it("setItemStatus posts the right mutation variables", async () => {
    lib._setExecFileForTests(
      makeExecFile([
        {
          match: (cmd, args) => cmd === "gh" && args[0] === "api",
          response: ghResp({
            data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: "ITEM_1" } } },
          }),
        },
      ]),
    );
    const r = await lib.setItemStatus({
      projectId: "PVT_xyz",
      itemId: "ITEM_1",
      statusFieldId: "F2",
      optionId: "O_READY",
    });
    assert.equal(r.id, "ITEM_1");
    const args = execCalls[0].args;
    assert.ok(args.includes("projectId=PVT_xyz"));
    assert.ok(args.includes("itemId=ITEM_1"));
    assert.ok(args.includes("fieldId=F2"));
    assert.ok(args.includes("optionId=O_READY"));
  });

  it("setItemStatusByName caches the field meta so the second call doesn't re-fetch", async () => {
    lib._clearMetaCacheForTests();
    let metaCalls = 0;
    let mutationCalls = 0;
    lib._setExecFileForTests(async (cmd, args) => {
      execCalls.push({ cmd, args });
      const isMeta = args.some(
        (a) => typeof a === "string" && a.includes("ProjectV2SingleSelectField"),
      );
      const isMutation = args.some(
        (a) => typeof a === "string" && a.includes("updateProjectV2ItemFieldValue"),
      );
      if (isMeta) {
        metaCalls += 1;
        return ghResp({
          data: {
            node: {
              fields: {
                nodes: [
                  {
                    __typename: "ProjectV2SingleSelectField",
                    id: "F2",
                    name: "Status",
                    options: [
                      { id: "O_READY", name: "Ready" },
                      { id: "O_PLANNING", name: "Planning" },
                    ],
                  },
                ],
              },
            },
          },
        });
      }
      if (isMutation) {
        mutationCalls += 1;
        return ghResp({
          data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: "ITEM_1" } } },
        });
      }
      throw new Error("unexpected call");
    });
    await lib.setItemStatusByName({
      projectId: "PVT_xyz",
      itemId: "ITEM_1",
      statusName: "Planning",
    });
    await lib.setItemStatusByName({ projectId: "PVT_xyz", itemId: "ITEM_2", statusName: "Ready" });
    assert.equal(metaCalls, 1, "meta fetched once across two calls");
    assert.equal(mutationCalls, 2);
  });

  it("setItemStatusByName throws when the requested status doesn't exist", async () => {
    lib._clearMetaCacheForTests();
    lib._setExecFileForTests(
      makeExecFile([
        {
          match: (cmd, args) => cmd === "gh" && args[0] === "api",
          response: ghResp({
            data: {
              node: {
                fields: {
                  nodes: [
                    {
                      __typename: "ProjectV2SingleSelectField",
                      id: "F2",
                      name: "Status",
                      options: [{ id: "O_READY", name: "Ready" }],
                    },
                  ],
                },
              },
            },
          }),
        },
      ]),
    );
    await assert.rejects(
      () =>
        lib.setItemStatusByName({ projectId: "PVT_xyz", itemId: "ITEM_1", statusName: "MadeUp" }),
      /Status "MadeUp" not found/,
    );
  });
});

describe("runGh retry behaviour", () => {
  it("retries on HTTP 504 and returns the eventual success", async () => {
    let calls = 0;
    lib._setExecFileForTests(async (cmd, args) => {
      execCalls.push({ cmd, args });
      calls += 1;
      if (calls === 1) {
        const e = new Error("HTTP 504: Gateway Timeout");
        e.stderr = "HTTP 504: Gateway Timeout";
        throw e;
      }
      return ghResp({ data: { user: { projectsV2: { nodes: [] } } } });
    });
    const r = await lib.findProject({ owner: "x", title: "Drafto Factory" });
    assert.equal(r, null);
    assert.equal(execCalls.length, 2);
  });

  it("does NOT retry on permanent errors (HTTP 404)", async () => {
    lib._setExecFileForTests(async (cmd, args) => {
      execCalls.push({ cmd, args });
      const e = new Error("HTTP 404: Not Found");
      e.stderr = "HTTP 404: Not Found";
      throw e;
    });
    await assert.rejects(() => lib.findProject({ owner: "x" }), /404/);
    assert.equal(execCalls.length, 1);
  });
});

function statusMeta(options) {
  return ghResp({
    data: {
      node: {
        fields: {
          nodes: [{ __typename: "ProjectV2SingleSelectField", id: "F2", name: "Status", options }],
        },
      },
    },
  });
}

describe("hasStatusOption (mocked gh)", () => {
  const options = [
    { id: "O_REVIEW", name: "In Review" },
    { id: "O_TEST", name: "In Test" },
  ];

  it("is true when the Status field has the option", async () => {
    lib._setExecFileForTests(
      makeExecFile([{ match: (cmd) => cmd === "gh", response: statusMeta(options) }]),
    );
    assert.equal(await lib.hasStatusOption("PVT_xyz", "In Test"), true);
  });

  it("is false when it doesn't (exact name, no case folding)", async () => {
    lib._setExecFileForTests(
      makeExecFile([{ match: (cmd) => cmd === "gh", response: statusMeta(options) }]),
    );
    assert.equal(await lib.hasStatusOption("PVT_xyz", "Testing"), false);
    assert.equal(await lib.hasStatusOption("PVT_xyz", "in test"), false);
    assert.equal(await lib.hasStatusOption("PVT_xyz", "constructor"), false);
  });

  it("reads fresh meta rather than the set-status cache", async () => {
    // A column added by setup-factory-board.sh mid-process must be seen.
    let calls = 0;
    lib._setExecFileForTests(async () => {
      calls += 1;
      return statusMeta(calls === 1 ? options : [...options, { id: "O_T", name: "Testing" }]);
    });
    assert.equal(await lib.hasStatusOption("PVT_xyz", "Testing"), false);
    assert.equal(await lib.hasStatusOption("PVT_xyz", "Testing"), true);
  });

  it("rejects a missing name", async () => {
    await assert.rejects(() => lib.hasStatusOption("PVT_xyz", ""), /requires an option name/);
  });
});

// EXPORT_QUERY reads the Status by field name (aliased `status`), so a node
// carries it directly instead of in a fieldValues page.
function itemNode(id, content, status) {
  return {
    id,
    content,
    status: status
      ? { __typename: "ProjectV2ItemFieldSingleSelectValue", name: status, optionId: `O_${status}` }
      : null,
  };
}

describe("shapeStatusExport (pure)", () => {
  it("keeps every item: issues, PRs, drafts, and items with no Status", () => {
    const rows = lib.shapeStatusExport([
      itemNode("PVTI_1", { __typename: "Issue", number: 12 }, "In Test"),
      itemNode("PVTI_2", { __typename: "PullRequest", number: 34 }, "In Review"),
      itemNode("PVTI_3", { __typename: "DraftIssue" }, "Backlog"),
      itemNode("PVTI_4", { __typename: "Issue", number: 56 }, null),
      null,
      { content: { __typename: "Issue", number: 1 } },
      // A non-single-select value under the alias is not a Status.
      { id: "PVTI_5", content: null, status: { __typename: "ProjectV2ItemFieldTextValue" } },
    ]);
    assert.deepEqual(rows, [
      { itemId: "PVTI_1", issueNumber: 12, status: "In Test", type: "Issue" },
      { itemId: "PVTI_2", issueNumber: 34, status: "In Review", type: "PullRequest" },
      { itemId: "PVTI_3", issueNumber: null, status: "Backlog", type: "DraftIssue" },
      { itemId: "PVTI_4", issueNumber: 56, status: null, type: "Issue" },
      { itemId: "PVTI_5", issueNumber: null, status: null, type: null },
    ]);
  });

  it("asks for the Status by field name, not a capped fieldValues page", async () => {
    let query = "";
    lib._setExecFileForTests(async (cmd, args) => {
      query = args.find((a) => a.startsWith("query=")) ?? "";
      return ghResp({
        data: { node: { items: { pageInfo: { hasNextPage: false }, nodes: [] } } },
      });
    });
    await lib.exportStatuses("PVT_xyz");
    assert.match(query, /status: fieldValueByName\(name: "Status"\)/);
    assert.doesNotMatch(query, /fieldValues\(first/);
  });

  it("tolerates a missing node list", () => {
    assert.deepEqual(lib.shapeStatusExport(undefined), []);
  });
});

describe("exportStatuses (mocked gh)", () => {
  function page(nodes, endCursor) {
    return ghResp({
      data: {
        node: {
          items: {
            pageInfo: { hasNextPage: endCursor != null, endCursor },
            nodes,
          },
        },
      },
    });
  }

  it("paginates the whole board and sorts by number, then itemId", async () => {
    const pages = [
      page(
        [
          itemNode("PVTI_c", { __typename: "Issue", number: 30 }, "Done"),
          itemNode("PVTI_d", { __typename: "DraftIssue" }, "Backlog"),
        ],
        "CUR_1",
      ),
      page(
        [
          itemNode("PVTI_a", { __typename: "Issue", number: 7 }, "In Review"),
          itemNode("PVTI_b", { __typename: "DraftIssue" }, null),
        ],
        null,
      ),
    ];
    lib._setExecFileForTests(async (cmd, args) => {
      execCalls.push({ cmd, args });
      return pages[execCalls.length - 1];
    });
    const rows = await lib.exportStatuses("PVT_xyz");
    assert.deepEqual(
      rows.map((r) => r.itemId),
      ["PVTI_a", "PVTI_c", "PVTI_b", "PVTI_d"],
    );
    assert.equal(execCalls.length, 2);
    assert.ok(execCalls[1].args.includes("cursor=CUR_1"));
    // Read-only: only a query is ever sent.
    for (const { args } of execCalls) {
      assert.ok(!args.some((a) => /\bmutation\b/.test(a)), "export must not mutate");
    }
  });

  it("throws on GraphQL errors instead of returning a partial backup", async () => {
    lib._setExecFileForTests(async () => ghResp({ errors: [{ message: "boom" }] }));
    await assert.rejects(() => lib.exportStatuses("PVT_xyz"), /exportStatuses failed/);
  });

  it("throws when the project has no items connection", async () => {
    lib._setExecFileForTests(async () => ghResp({ data: { node: null } }));
    await assert.rejects(() => lib.exportStatuses("PVT_xyz"), /no items connection/);
  });

  it("refuses to return a truncated list past the page cap", async () => {
    let n = 0;
    lib._setExecFileForTests(async () => {
      n += 1;
      return page([itemNode(`PVTI_${n}`, { __typename: "Issue", number: n }, "Done")], `C${n}`);
    });
    await assert.rejects(() => lib.exportStatuses("PVT_xyz"), /refusing to return an incomplete/);
  });

  it("requires a project id", async () => {
    await assert.rejects(() => lib.exportStatuses(""), /requires projectId/);
  });
});

describe("factory-project.mjs CLI (stubbed gh on PATH)", () => {
  const cliPath = fileURLToPath(new URL("../lib/factory-project.mjs", import.meta.url));

  // Answers the Status-field query and a one-page items query; logs each call.
  const GH_STUB = `#!${process.execPath}
const fs = require("fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.GH_STUB_LOG, JSON.stringify(args) + "\\n");
const q = args.find((a) => a.startsWith("query=")) || "";
let out;
if (q.includes("fields(first")) {
  out = { data: { node: { fields: { nodes: [{ __typename: "ProjectV2SingleSelectField", id: "F2", name: "Status",
    options: [{ id: "O_REVIEW", name: "In Review" }, { id: "O_TEST", name: "In Test" }] }] } } } };
} else if (q.includes("items(first")) {
  out = { data: { node: { items: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [
    { id: "PVTI_2", content: { __typename: "Issue", number: 9 },
      status: { __typename: "ProjectV2ItemFieldSingleSelectValue", name: "In Test" } },
    { id: "PVTI_1", content: { __typename: "Issue", number: 3 }, status: null }] } } } };
} else {
  fs.writeSync(2, "unmatched gh call");
  process.exit(1);
}
fs.writeSync(1, JSON.stringify(out));
`;

  function runCli(cliArgs) {
    const dir = mkdtempSync(join(tmpdir(), "factory-project-cli-"));
    try {
      const gh = join(dir, "gh");
      writeFileSync(gh, GH_STUB);
      chmodSync(gh, 0o755);
      const logFile = join(dir, "gh.log");
      writeFileSync(logFile, "");
      const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, GH_STUB_LOG: logFile };
      delete env.FACTORY_PROJECT_ID;
      const res = spawnSync(process.execPath, [cliPath, ...cliArgs], { encoding: "utf8", env });
      const calls = readFileSync(logFile, "utf8").split("\n").filter(Boolean).map(JSON.parse);
      return { status: res.status, stdout: res.stdout, stderr: res.stderr, calls };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("has-status-option exits 0 and reports present when the option exists", () => {
    const r = runCli(["has-status-option", "--name", "In Test", "--project-id", "PVT_1"]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { name: "In Test", present: true });
  });

  it("has-status-option exits 1 and reports absent when it doesn't", () => {
    const r = runCli(["has-status-option", "--name", "Testing", "--project-id", "PVT_1"]);
    assert.equal(r.status, 1);
    assert.deepEqual(JSON.parse(r.stdout), { name: "Testing", present: false });
  });

  it("has-status-option without --name fails before calling gh", () => {
    const r = runCli(["has-status-option", "--project-id", "PVT_1"]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /requires --name/);
    assert.equal(r.calls.length, 0);
  });

  it("export-statuses prints every item as sorted JSON and sends no mutation", () => {
    const r = runCli(["export-statuses", "--project-id", "PVT_1"]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), [
      { itemId: "PVTI_1", issueNumber: 3, status: null, type: "Issue" },
      { itemId: "PVTI_2", issueNumber: 9, status: "In Test", type: "Issue" },
    ]);
    assert.equal(r.calls.length, 1);
    assert.ok(!r.calls[0].some((a) => /\bmutation\b/.test(a)));
  });
});
