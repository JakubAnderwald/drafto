import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildFactoryPlanBundle, parsePlanSize } from "../lib/factory-bundle.mjs";

// The plan size marker (ADR-0083): every plan ends with
// <!-- drafto-factory-plan-size:<class>:<estLines> -->, and bash reads it
// through plan-size.mjs to keep the factory-oversize label in step.

const cli = resolve(dirname(fileURLToPath(import.meta.url)), "..", "lib", "plan-size.mjs");

describe("parsePlanSize", () => {
  it("reads the size marker as a class and a line estimate", () => {
    assert.deepEqual(parsePlanSize("## Plan\n\n<!-- drafto-factory-plan-size:XL:1800 -->\n"), {
      sizeClass: "XL",
      estLines: 1800,
    });
    assert.deepEqual(parsePlanSize("<!--drafto-factory-plan-size:S:40-->"), {
      sizeClass: "S",
      estLines: 40,
    });
  });

  it("takes the last marker, so a plan quoting an older one reads as its own", () => {
    const body =
      "> <!-- drafto-factory-plan-size:XL:3000 -->\n\n<!-- drafto-factory-plan-size:M:300 -->";
    assert.deepEqual(parsePlanSize(body), { sizeClass: "M", estLines: 300 });
  });

  it("returns null with no marker or a malformed one", () => {
    for (const body of [
      "",
      "## Plan without a marker",
      "<!-- drafto-factory-plan-size:xl:1800 -->",
      "<!-- drafto-factory-plan-size:XXL:1800 -->",
      "<!-- drafto-factory-plan-size:L:1,100 -->",
      "<!-- drafto-factory-plan-size:L:900-1300 -->",
      "<!-- drafto-factory-plan-size:L: -->",
      "drafto-factory-plan-size:L:1100",
      null,
      42,
    ]) {
      assert.equal(parsePlanSize(body), null, String(body));
    }
  });
});

describe("plan-size.mjs CLI", () => {
  it("prints the marker as JSON, or null", () => {
    const hit = spawnSync(process.execPath, [cli], {
      input: "x\n<!-- drafto-factory-plan-size:XL:2400 -->\n",
      encoding: "utf8",
    });
    assert.equal(hit.status, 0, hit.stderr);
    assert.deepEqual(JSON.parse(hit.stdout), { sizeClass: "XL", estLines: 2400 });
    const miss = spawnSync(process.execPath, [cli], { input: "no marker", encoding: "utf8" });
    assert.equal(miss.status, 0, miss.stderr);
    assert.equal(miss.stdout.trim(), "null");
  });
});

describe("factory_plan bundle: no split directory", () => {
  it("never passes a split dir to the planner: the factory files no sub-issues", () => {
    const replyDir = "/Users/x/drafto/logs/factory/replies/issue-7";
    const { replan } = buildFactoryPlanBundle({
      issue: { number: 7, title: "t", body: "", labels: [] },
      config: { phase: "C" },
      repo: { nameWithOwner: "JakubAnderwald/drafto", headRef: "main" },
      replan: { planCommentId: "1", planCommentBody: "p", replyDir, splitDir: `${replyDir}/split` },
    });
    assert.equal(replan.replyDir, replyDir);
    assert.equal(Object.hasOwn(replan, "splitDir"), false);
  });
});
