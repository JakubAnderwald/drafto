// Unit tests for scripts/lib/device-plan.mjs — what the device lane runs for a
// PR (ADR-0099). Pure: diff files and scenario headings in, a plan out.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ANDROID_HEADING,
  DESTRUCTIVE_FLOWS,
  IOS_HEADING,
  MOBILE_HEADING,
  deriveDevicePlan,
  flowName,
  isDestructiveFlow,
  parseFlowTags,
  stripComment,
} from "../lib/device-plan.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const E2E = "apps/mobile/e2e";

describe("deriveDevicePlan", () => {
  it("PR #926 (ios-all.yaml + the e2e README) runs iOS only, with ios-all.yaml", () => {
    const plan = deriveDevicePlan({
      diffFiles: [`${E2E}/ios-all.yaml`, `${E2E}/README.md`],
    });
    assert.equal(plan.applicable, true);
    assert.deepEqual(plan.platforms, { ios: { flows: [`${E2E}/ios-all.yaml`] } });
  });

  it("a shared-package change runs both smoke flows", () => {
    const plan = deriveDevicePlan({
      diffFiles: ["packages/shared/src/editor/markdown-converter.ts"],
    });
    assert.equal(plan.applicable, true);
    assert.deepEqual(plan.platforms, {
      android: { flows: [`${E2E}/android-all.yaml`] },
      ios: { flows: [`${E2E}/ios-all.yaml`] },
    });
  });

  it("app code selects both platforms", () => {
    const plan = deriveDevicePlan({ diffFiles: ["apps/mobile/src/components/note-editor.tsx"] });
    assert.deepEqual(Object.keys(plan.platforms), ["android", "ios"]);
  });

  it("android-only flows select Android and add the changed flow", () => {
    const plan = deriveDevicePlan({ diffFiles: [`${E2E}/android-only/11-dark-nav-bar.yaml`] });
    assert.deepEqual(plan.platforms, {
      android: { flows: [`${E2E}/android-all.yaml`, `${E2E}/android-only/11-dark-nav-bar.yaml`] },
    });
  });

  it("a changed numbered flow runs on both platforms after the smoke flow", () => {
    const plan = deriveDevicePlan({ diffFiles: [`${E2E}/10-swipe-hint.yaml`] });
    assert.deepEqual(plan.platforms.ios.flows, [
      `${E2E}/ios-all.yaml`,
      `${E2E}/10-swipe-hint.yaml`,
    ]);
    assert.deepEqual(plan.platforms.android.flows, [
      `${E2E}/android-all.yaml`,
      `${E2E}/10-swipe-hint.yaml`,
    ]);
  });

  it("destructive flows, runner scripts and helpers are never added", () => {
    const plan = deriveDevicePlan({
      diffFiles: [
        `${E2E}/07-delete-account.yaml`,
        `${E2E}/05-cross-platform-sync.yaml`,
        `${E2E}/run-qa-10668-e2e.sh`,
        `${E2E}/helpers/sign-in-clean.yaml`,
      ],
    });
    assert.equal(plan.applicable, true);
    assert.deepEqual(plan.platforms.ios.flows, [`${E2E}/ios-all.yaml`]);
    assert.deepEqual(plan.platforms.android.flows, [`${E2E}/android-all.yaml`]);
    assert.ok(plan.reasons.some((r) => /07-delete-account\.yaml skipped/.test(r)));
    assert.ok(plan.reasons.some((r) => /05-cross-platform-sync\.yaml skipped/.test(r)));
  });

  it("a web-seeded flow and a host-offline flow are skipped", () => {
    const plan = deriveDevicePlan({
      diffFiles: [`${E2E}/08-nested-lists.yaml`, `${E2E}/ios-only/05-offline-mode.yaml`],
      flowTags: { [`${E2E}/ios-only/05-offline-mode.yaml`]: ["qa-10668", "requires-host-offline"] },
    });
    assert.deepEqual(plan.platforms.ios.flows, [`${E2E}/ios-all.yaml`]);
    assert.ok(plan.reasons.some((r) => /08-nested-lists\.yaml skipped .*runner/.test(r)));
    assert.ok(plan.reasons.some((r) => /tagged requires-host-offline/.test(r)));
  });

  it("README-only, web-only and store-only diffs are not applicable", () => {
    for (const diffFiles of [
      [`${E2E}/README.md`],
      ["apps/mobile/README.md"],
      ["apps/web/src/app/page.tsx"],
      ["apps/mobile/store/screenshots/generate-ios.sh"],
      [],
    ]) {
      const plan = deriveDevicePlan({ diffFiles });
      assert.equal(plan.applicable, false, JSON.stringify(diffFiles));
      assert.deepEqual(plan.platforms, {});
    }
  });

  it("a deleted flow still makes the PR applicable but is never run", () => {
    const plan = deriveDevicePlan({
      diffFiles: [`${E2E}/10-swipe-hint.yaml`, `${E2E}/ios-only/search.yaml`],
      deletedFiles: [`${E2E}/10-swipe-hint.yaml`, `${E2E}/ios-only/search.yaml`],
    });
    assert.equal(plan.applicable, true);
    assert.deepEqual(plan.platforms.ios.flows, [`${E2E}/ios-all.yaml`]);
    assert.deepEqual(plan.platforms.android.flows, [`${E2E}/android-all.yaml`]);
    assert.ok(plan.reasons.some((r) => /ios-only\/search\.yaml is deleted/.test(r)));
  });

  it("a deleted smoke flow makes its platform unavailable, not a missing file to run", () => {
    const plan = deriveDevicePlan({
      diffFiles: [`${E2E}/ios-all.yaml`, "apps/mobile/src/app.tsx"],
      deletedFiles: [`${E2E}/ios-all.yaml`],
    });
    assert.deepEqual(plan.platforms.ios, { flows: [], unavailable: "no-smoke-flow" });
    assert.deepEqual(plan.platforms.android, { flows: [`${E2E}/android-all.yaml`] });
    assert.ok(
      plan.reasons.some((r) => /ios-all\.yaml is deleted by the PR: nothing to run on ios/.test(r)),
    );
  });

  it("an ineligible smoke flow makes its platform unavailable", () => {
    const ios = `${E2E}/ios-all.yaml`;
    const android = `${E2E}/android-all.yaml`;
    const plan = deriveDevicePlan({
      diffFiles: [ios, android],
      flowTags: { [ios]: ["requires-host-offline"], [android]: null },
    });
    assert.deepEqual(plan.platforms.ios, { flows: [], unavailable: "smoke-flow-needs-host" });
    assert.deepEqual(plan.platforms.android, { flows: [], unavailable: "smoke-flow-unreadable" });
    const ok = deriveDevicePlan({ diffFiles: [ios], flowTags: { [ios]: ["qa-10668"] } });
    assert.deepEqual(ok.platforms.ios, { flows: [ios] });
  });

  it("a flow with inline host-offline tags, or tags it can't read, isn't run", () => {
    const inline = `${E2E}/ios-only/10-offline-banner-header.yaml`;
    const odd = `${E2E}/ios-only/search.yaml`;
    const plan = deriveDevicePlan({
      diffFiles: [inline, odd],
      flowTags: {
        [inline]: parseFlowTags("appId: x\ntags: [qa-10668, requires-host-offline]\n---\n"),
        [odd]: parseFlowTags("appId: x\ntags: {a: b}\n---\n"),
      },
    });
    assert.deepEqual(plan.platforms.ios.flows, [`${E2E}/ios-all.yaml`]);
    assert.ok(plan.reasons.some((r) => /tagged requires-host-offline/.test(r)));
    assert.ok(
      plan.reasons.some((r) => /search\.yaml skipped on ios: its tags couldn't be read/.test(r)),
    );
  });

  it("an e2e runner script alone is applicable to nothing", () => {
    assert.equal(
      deriveDevicePlan({ diffFiles: [`${E2E}/run-cross-platform-e2e.sh`] }).applicable,
      false,
    );
  });

  it("scenario headings add platforms, but never make a web diff applicable", () => {
    const ios = deriveDevicePlan({ diffFiles: [`${E2E}/ios-all.yaml`] });
    assert.deepEqual(Object.keys(ios.platforms), ["ios"]);
    const withAndroid = deriveDevicePlan({
      diffFiles: [`${E2E}/ios-all.yaml`],
      scenarioSections: [{ heading: "Android", text: "…" }],
    });
    assert.deepEqual(Object.keys(withAndroid.platforms), ["android", "ios"]);
    const generic = deriveDevicePlan({
      diffFiles: [`${E2E}/android-all.yaml`],
      scenarioSections: [{ heading: "iOS / Android" }],
    });
    assert.deepEqual(Object.keys(generic.platforms), ["android", "ios"]);
    const mobile = deriveDevicePlan({
      diffFiles: [`${E2E}/android-all.yaml`],
      scenarioSections: [{ heading: "Mobile" }],
    });
    assert.deepEqual(Object.keys(mobile.platforms), ["android", "ios"]);
    const iphone = deriveDevicePlan({
      diffFiles: [`${E2E}/android-all.yaml`],
      scenarioSections: [{ heading: "iPhone" }, { heading: "Web" }],
    });
    assert.deepEqual(Object.keys(iphone.platforms), ["android", "ios"]);
    const web = deriveDevicePlan({
      diffFiles: ["apps/web/src/app/page.tsx"],
      scenarioSections: [{ heading: "iOS" }],
    });
    assert.equal(web.applicable, false);
  });
});

describe("headings and helpers", () => {
  it("heading patterns", () => {
    assert.ok(IOS_HEADING.test("iOS"));
    assert.ok(IOS_HEADING.test("On the iPad"));
    assert.ok(!IOS_HEADING.test("Android"));
    assert.ok(ANDROID_HEADING.test("Android (emulator)"));
    assert.ok(MOBILE_HEADING.test("Mobile"));
    assert.ok(!MOBILE_HEADING.test("Web"));
  });

  it("isDestructiveFlow matches the list and nothing else", () => {
    assert.equal(DESTRUCTIVE_FLOWS.length, 4);
    assert.ok(isDestructiveFlow(`${E2E}/07-delete-account.yaml`));
    assert.ok(isDestructiveFlow(`${E2E}/run-anything.sh`));
    assert.ok(isDestructiveFlow(`${E2E}/helpers/a/b.yaml`));
    assert.ok(!isDestructiveFlow(`${E2E}/ios-only/05-offline-mode.yaml`));
    assert.ok(!isDestructiveFlow(`${E2E}/ios-all.yaml`));
  });

  it("flowName is the path under apps/mobile/e2e", () => {
    assert.equal(flowName(`${E2E}/ios-only/search.yaml`), "ios-only/search.yaml");
  });

  it("parseFlowTags reads block lists, flow sequences and comments; null when unreadable", () => {
    assert.deepEqual(parseFlowTags("appId: x\ntags: [a, 'b', \"c\"] # note\n---\n"), [
      "a",
      "b",
      "c",
    ]);
    assert.deepEqual(parseFlowTags("appId: x\ntags: []\n---\n"), []);
    assert.deepEqual(
      parseFlowTags("appId: x\ntags:\n  - a # first\n\n  - b\nenv:\n  X: 1\n---\n"),
      ["a", "b"],
    );
    assert.equal(parseFlowTags("appId: x\ntags: a\n---\n"), null);
    assert.equal(parseFlowTags("appId: x\ntags:\n  a: b\n---\n"), null);
    assert.equal(parseFlowTags("appId: x\ntags: [a b]\n---\n"), null);
  });

  it("stripComment keeps a # inside quotes", () => {
    assert.equal(stripComment('- inputText: "a # b" # c'), '- inputText: "a # b"');
    assert.equal(stripComment("- tapOn: x#y"), "- tapOn: x#y");
    assert.equal(stripComment("# whole"), "");
  });

  it("parseFlowTags reads a real flow's header", () => {
    const text = readFileSync(path.join(REPO, E2E, "ios-only/05-offline-mode.yaml"), "utf8");
    assert.ok(parseFlowTags(text).includes("requires-host-offline"));
    assert.deepEqual(parseFlowTags("appId: x\n---\n- launchApp\n"), []);
    assert.deepEqual(parseFlowTags("appId: x\ntags:\n  - a\n  - 'b'\n---\ntags:\n  - c\n"), [
      "a",
      "b",
    ]);
  });
});
