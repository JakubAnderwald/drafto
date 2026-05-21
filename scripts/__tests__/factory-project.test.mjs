import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

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
