import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  chmodSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ALWAYS_DENY,
  AMBIGUOUS_URL,
  CHROME_PREFIX,
  COMPUTER_ACTIONS,
  COMPUTER_CLICK_ACTIONS,
  DEFAULT_PERL_PATH,
  HOOK_MATCHER,
  HOOK_TIMEOUTS,
  INFLIGHT_REASON,
  PERL_ALARM_SCRIPT,
  PRE_ALARM_SEC,
  RUNNER_TOOLS,
  UNKNOWN_URL,
  allowedToolsArg,
  applyPost,
  buildGuardSettings,
  computerVerdict,
  decidePre,
  emptyState,
  inflightToken,
  isAllowedNavigation,
  isNeutralUrl,
  keyVerdict,
  normaliseOrigin,
  parseAllowOrigin,
  parseAvailableTabsJson,
  parseTabContextBlock,
  redactUrl,
  screenshotSourceProblem,
  sessionPaths,
  validateConfig,
} from "../lib/browser-guard.mjs";

// Guards the browser runner's hook guard (ADR-0051). The runner drives the
// owner's own signed-in Chrome profile unattended, so every case below is a
// way the runner could reach a page, tab or browser it must not.

const here = dirname(fileURLToPath(import.meta.url));
const GUARD = realpathSync(resolve(here, "..", "lib", "browser-guard.mjs"));

const DEVICE = "9796912b-8977-4d74-9c08-d9bb283b9496";
const MACBOOK = "824e0089-2690-49e9-a40c-bf40bd67c90e";
const PREVIEW = "https://drafto-dc66i71t0-jakubanderwalds-projects.vercel.app";
const T = (short) => `${CHROME_PREFIX}${short}`;

const CONFIG = {
  deviceId: DEVICE,
  allowOrigins: [PREVIEW],
  logDir: "/x/log",
  stateDir: "/x/state",
  evidenceDir: "/x/evidence",
};

// Tab ids from the Wave 0 spike.
const NEW_TAB = 1264169910;
const OWN_TAB = 1264169916;

const selectedState = (tabs = { [OWN_TAB]: `${PREVIEW}/login` }) => ({ selected: true, tabs });

// ── Response texts exactly as the extension and Claude Code produce them ────

const text = (t) => ({ type: "text", text: t });
const image = { type: "image", data: "aGVsbG8=", mimeType: "image/jpeg" };

/** The extension's Tab Context block: title and url are JSON.stringify'd. */
const tabContext = (executedOn, tabs) =>
  `\n\nTab Context:${executedOn ? `\n- Executed on tabId: ${executedOn}` : ""}\n- Available tabs:\n` +
  tabs
    .map(([id, title, url]) => `  • tabId ${id}: ${JSON.stringify(title)} (${JSON.stringify(url)})`)
    .join("\n");

const SPIKE_TAB_CONTEXT =
  "\n\nTab Context:\n- Executed on tabId: 1264169916\n- Available tabs:\n" +
  '  • tabId 1264169916: "Log in — Drafto" ("https://drafto-dc66i71t0-jakubanderwalds-projects.vercel.app/login")';

const SPIKE_AVAILABLE_TABS_JSON =
  '{"availableTabs":[{"tabId":1264169910,"title":"New Tab","url":"chrome://newtab/"}],"tabGroupId":1943373469}';

const post = (tool, input, responseBlocks, state, extra = {}) =>
  applyPost({
    tool: T(tool),
    input,
    responseBlocks,
    config: CONFIG,
    state,
    now: "2026-10-17T10:00:00.000Z",
    ...extra,
  });

const pre = (tool, input, state) => decidePre({ tool: T(tool), input, config: CONFIG, state });

// ── Tool lists and settings ─────────────────────────────────────────────────

describe("browser-guard: tool lists", () => {
  test("allowedToolsArg is the comma-joined full names of RUNNER_TOOLS", () => {
    const arg = allowedToolsArg();
    assert.equal(arg, RUNNER_TOOLS.map(T).join(","));
    assert.ok(arg.startsWith("mcp__claude-in-chrome__list_connected_browsers,"));
    assert.equal(arg.split(",").length, 14);
  });

  test("no always-denied tool is on the runner list", () => {
    for (const t of ALWAYS_DENY) assert.ok(!RUNNER_TOOLS.includes(t), t);
    assert.ok(ALWAYS_DENY.includes("switch_browser"));
    assert.ok(ALWAYS_DENY.includes("javascript_tool"));
    assert.ok(ALWAYS_DENY.includes("browser_batch"));
  });
});

describe("browser-guard: buildGuardSettings", () => {
  const paths = {
    nodePath: "/opt/homebrew/bin/node",
    guardPath: "/Users/jakub/code/drafto/scripts/lib/browser-guard.mjs",
    configPath: "/Users/jakub/code/drafto/logs/browser-guard/run 1/config.json",
  };
  const settings = buildGuardSettings(paths);
  const only = (event) => {
    assert.equal(settings.hooks[event].length, 1);
    assert.equal(settings.hooks[event][0].hooks.length, 1);
    return { group: settings.hooks[event][0], hook: settings.hooks[event][0].hooks[0] };
  };
  const guardCall = (mode) =>
    `'${paths.nodePath}' '${paths.guardPath}' hook ${mode} --config '${paths.configPath}'`;

  test("is plain JSON with hooks enabled and the denied tools removed by full name", () => {
    assert.deepEqual(JSON.parse(JSON.stringify(settings)), settings);
    assert.equal(settings.disableAllHooks, false);
    assert.ok(Array.isArray(settings.permissions.deny));
    assert.deepEqual(settings.permissions.deny, ALWAYS_DENY.map(T));
    assert.deepEqual(Object.keys(settings.hooks).sort(), [
      "PostToolUse",
      "PreToolUse",
      "SessionStart",
    ]);
  });

  test("every hook is a command with a timeout and single-quoted absolute paths", () => {
    const expected = { SessionStart: 10, PreToolUse: 30, PostToolUse: 15 };
    for (const [event, timeout] of Object.entries(expected)) {
      const { hook } = only(event);
      assert.equal(hook.type, "command");
      assert.equal(hook.timeout, timeout, event);
      assert.ok(hook.command.includes(`'${paths.nodePath}' '${paths.guardPath}' hook `), event);
      assert.ok(hook.command.includes(`--config '${paths.configPath}'`), event);
    }
    assert.equal(only("SessionStart").hook.command, guardCall("session-start"));
    assert.equal(only("PostToolUse").hook.command, guardCall("post"));
  });

  // Measured 2026-10-17: a PreToolUse hook that outlives its timeout is an
  // ALLOW. The guard's own alarm has to fire first, with room to spare.
  test("the pre hook runs under a perl alarm well inside its timeout, then `|| exit 2`", () => {
    const { hook } = only("PreToolUse");
    assert.equal(
      hook.command,
      `'/usr/bin/perl' -e 'alarm shift; exec @ARGV or exit 2' ${PRE_ALARM_SEC} ` +
        `${guardCall("pre")} || exit 2`,
    );
    assert.equal(DEFAULT_PERL_PATH, "/usr/bin/perl");
    assert.ok(PERL_ALARM_SCRIPT.startsWith("alarm shift; exec @ARGV"));
    assert.ok(!PERL_ALARM_SCRIPT.includes("'"), "the script sits inside single quotes");
    assert.equal(PRE_ALARM_SEC, 20);
    assert.equal(HOOK_TIMEOUTS.pre, 30);
    assert.equal(hook.timeout, HOOK_TIMEOUTS.pre);
    assert.ok(PRE_ALARM_SEC > 0);
    assert.ok(
      HOOK_TIMEOUTS.pre - PRE_ALARM_SEC >= 5,
      `alarm ${PRE_ALARM_SEC}s is not well below the ${HOOK_TIMEOUTS.pre}s hook timeout`,
    );
  });

  test("perlPath is configurable and validated like the other paths", () => {
    const custom = buildGuardSettings({ ...paths, perlPath: "/opt/local/bin/perl" });
    assert.ok(custom.hooks.PreToolUse[0].hooks[0].command.startsWith("'/opt/local/bin/perl' -e "));
    assert.throws(() => buildGuardSettings({ ...paths, perlPath: "perl" }), /absolute/);
    assert.throws(() => buildGuardSettings({ ...paths, perlPath: "/x/it's/perl" }), /single quote/);
  });

  test("only the pre hook carries the wrapper and `|| exit 2`", () => {
    assert.ok(only("PreToolUse").hook.command.endsWith(" || exit 2"));
    for (const event of ["PostToolUse", "SessionStart"]) {
      assert.ok(!only(event).hook.command.includes("exit 2"), event);
      assert.ok(!only(event).hook.command.includes("perl"), event);
    }
  });

  test("refuses relative paths, single quotes and control characters", () => {
    assert.throws(() => buildGuardSettings({ ...paths, nodePath: "node" }), /absolute/);
    assert.throws(
      () => buildGuardSettings({ ...paths, guardPath: "scripts/lib/g.mjs" }),
      /absolute/,
    );
    assert.throws(
      () => buildGuardSettings({ ...paths, configPath: "/tmp/it's.json" }),
      /single quote/,
    );
    assert.throws(() => buildGuardSettings({ ...paths, configPath: "/tmp/a\nb.json" }), /control/);
    assert.throws(() => buildGuardSettings({ ...paths, nodePath: "" }), /required/);
  });
});

describe("browser-guard: in-flight post markers", () => {
  test("inflightToken keeps [A-Za-z0-9_-] and falls back to a random token", () => {
    assert.equal(inflightToken("toolu_01AbC-d_e"), "toolu_01AbC-d_e");
    assert.equal(inflightToken("../../etc/pass wd"), "etcpasswd");
    assert.match(inflightToken(undefined), /^anon-[0-9a-f]{16}$/);
    assert.match(inflightToken("/./"), /^anon-[0-9a-f]{16}$/);
    assert.notEqual(inflightToken(undefined), inflightToken(undefined));
  });

  test("the marker always lands in the state dir under the session's prefix", () => {
    const p = sessionPaths(CONFIG, "sid-1");
    assert.equal(p.inflight("toolu_9"), "/x/state/sid-1.post-toolu_9.inflight");
    assert.equal(p.inflight("../../tmp/x"), "/x/state/sid-1.post-tmpx.inflight");
    assert.equal(p.inflightPrefix, "sid-1.post-");
  });
});

// ── URLs ────────────────────────────────────────────────────────────────────

describe("browser-guard: normaliseOrigin", () => {
  const cases = [
    [`${PREVIEW}/login?x=1#y`, PREVIEW],
    ["drafto-dc66i71t0-jakubanderwalds-projects.vercel.app/notes", PREVIEW],
    ["HTTPS://Drafto-DC66I71T0-jakubanderwalds-projects.vercel.app", PREVIEW],
    ["http://127.0.0.1:3100/x", "http://127.0.0.1:3100"],
    ["https://example.com:443/", "https://example.com"],
    ["https://user:pw@example.com/", null],
    ["https://@example.com/", null],
    ["https://exa mple.com/", null],
    ["https:\\\\example.com", null],
    ["", null],
    [42, null],
    [undefined, null],
  ];
  for (const [input, want] of cases) {
    test(`${JSON.stringify(input)} → ${want}`, () => assert.equal(normaliseOrigin(input), want));
  }
});

describe("browser-guard: isAllowedNavigation", () => {
  const allow = [PREVIEW];
  const table = [
    [true, `${PREVIEW}/login`],
    [true, PREVIEW],
    [true, `${PREVIEW}/`],
    [true, `${PREVIEW}?next=/notes`],
    [true, `${PREVIEW}#top`],
    // no scheme defaults to https, exactly as the extension does
    [true, "drafto-dc66i71t0-jakubanderwalds-projects.vercel.app/notes"],
    [true, "HTTPS://DRAFTO-DC66I71T0-JAKUBANDERWALDS-PROJECTS.VERCEL.APP/notes"],
    // a different scheme or port is a different origin
    [false, "http://drafto-dc66i71t0-jakubanderwalds-projects.vercel.app/"],
    [false, `${PREVIEW}:8443/`],
    // the default port spelled out is refused rather than reasoned about
    [false, `${PREVIEW}:443/`],
    // userinfo, even empty
    [false, `https://user@drafto-dc66i71t0-jakubanderwalds-projects.vercel.app/`],
    [false, `https://user:pw@drafto-dc66i71t0-jakubanderwalds-projects.vercel.app/`],
    [false, `https://@drafto-dc66i71t0-jakubanderwalds-projects.vercel.app/`],
    [false, `https://drafto-dc66i71t0-jakubanderwalds-projects.vercel.app@evil.com/`],
    // the hosts the owner is signed in to for real
    [false, "https://vercel.com/jakubanderwalds-projects"],
    [false, "https://drafto.eu/"],
    [false, "https://www.drafto.eu/notes"],
    [false, "https://github.com/JakubAnderwald/drafto"],
    // look-alikes: sibling preview, subdomain, suffix, trailing dot
    [false, "https://drafto-zzzzzzzzz-jakubanderwalds-projects.vercel.app/"],
    [false, `https://evil.drafto-dc66i71t0-jakubanderwalds-projects.vercel.app/`],
    [false, `https://drafto-dc66i71t0-jakubanderwalds-projects.vercel.app.evil.com/`],
    [false, `https://drafto-dc66i71t0-jakubanderwalds-projects.vercel.app./`],
    // IDN homograph (Cyrillic а) and percent-encoded host
    [false, "https://drаfto-dc66i71t0-jakubanderwalds-projects.vercel.app/"],
    [false, "https://drafto%2Ddc66i71t0-jakubanderwalds-projects.vercel.app/"],
    // other schemes
    [false, "javascript:alert(document.cookie)"],
    [false, "javascript:1"],
    [false, "data:text/html,<h1>x</h1>"],
    [false, "file:///etc/passwd"],
    [false, "chrome://settings"],
    [false, "about:blank"],
    [false, "http:drafto-dc66i71t0-jakubanderwalds-projects.vercel.app"],
    // history
    [false, "back"],
    [false, "forward"],
    [false, "BACK"],
    // parser-differential characters
    [false, `${PREVIEW}\\@evil.com`],
    [false, `https:\\\\drafto-dc66i71t0-jakubanderwalds-projects.vercel.app`],
    [false, ` ${PREVIEW}/`],
    [false, `${PREVIEW}/a b`],
    [false, `\t${PREVIEW}`],
    [false, ""],
    [false, undefined],
  ];
  for (const [want, url] of table) {
    test(`${want ? "allows" : "denies"} ${JSON.stringify(url)}`, () => {
      assert.equal(isAllowedNavigation(url, allow), want);
    });
  }

  test("an IP allow origin matches its exact port only", () => {
    const local = ["http://127.0.0.1:3100"];
    assert.equal(isAllowedNavigation("http://127.0.0.1:3100/notes", local), true);
    assert.equal(isAllowedNavigation("http://127.0.0.1:3000/", local), false);
    assert.equal(isAllowedNavigation("https://127.0.0.1:3100/", local), false);
    assert.equal(isAllowedNavigation("http://localhost:3100/", local), false);
    // the same address spelled as a number: one parser's 127.0.0.1 is another's hostname
    assert.equal(isAllowedNavigation("http://2130706433:3100/", local), false);
    // the extension would load https://127.0.0.1:3100 — not the allowed origin
    assert.equal(isAllowedNavigation("127.0.0.1:3100/", local), false);
  });

  test("an empty allow list allows nothing", () => {
    assert.equal(isAllowedNavigation(`${PREVIEW}/`, []), false);
    assert.equal(isAllowedNavigation(`${PREVIEW}/`, undefined), false);
  });
});

describe("browser-guard: isNeutralUrl and redactUrl", () => {
  test("blank and new-tab pages are neutral; nothing else is", () => {
    for (const u of ["", "about:blank", "chrome://newtab/"]) assert.equal(isNeutralUrl(u), true, u);
    for (const u of [
      "chrome://newtab",
      "about:blank#x",
      PREVIEW,
      "chrome://settings/",
      undefined,
    ]) {
      assert.equal(isNeutralUrl(u), false, String(u));
    }
  });

  test("redactUrl keeps origin and path, drops query and fragment values", () => {
    assert.equal(
      redactUrl(`${PREVIEW}/auth/callback#access_token=eyJabc`),
      `${PREVIEW}/auth/callback#…`,
    );
    assert.equal(redactUrl(`${PREVIEW}/login?token=s3cret`), `${PREVIEW}/login?…`);
    assert.equal(redactUrl(`${PREVIEW}/notes`), `${PREVIEW}/notes`);
    assert.equal(redactUrl(undefined), null);
  });
});

// ── Config ──────────────────────────────────────────────────────────────────

describe("browser-guard: config validation", () => {
  test("accepts the runner's config and normalises it", () => {
    const cfg = validateConfig({ ...CONFIG, allowOrigins: [`${PREVIEW}/`, PREVIEW] });
    assert.deepEqual(cfg.allowOrigins, [PREVIEW]);
    assert.equal(cfg.deviceId, DEVICE);
  });

  test("an allow origin must be a bare canonical http(s) origin", () => {
    assert.equal(parseAllowOrigin("http://127.0.0.1:3100"), "http://127.0.0.1:3100");
    assert.equal(parseAllowOrigin("http://[::1]:3100"), "http://[::1]:3100");
    const bad = [
      `${PREVIEW}/login`,
      `${PREVIEW}?x=1`,
      `${PREVIEW}#x`,
      "drafto-dc66i71t0-jakubanderwalds-projects.vercel.app",
      "http://drafto-dc66i71t0-jakubanderwalds-projects.vercel.app",
      "http://localhost:3100",
      "https://drafto.eu",
      "https://www.drafto.eu",
      "https://vercel.com",
      "https://app.vercel.com",
      "https://user@example.vercel.app",
      "https://drаfto.vercel.app",
      "https://drafto%2Dx.vercel.app",
      "javascript:alert(1)",
      "",
    ];
    for (const value of bad) assert.throws(() => parseAllowOrigin(value), undefined, value);
  });

  test("rejects a bad device id, an empty allow list and relative directories", () => {
    assert.throws(() => validateConfig({ ...CONFIG, deviceId: "Browser 1" }), /deviceId/);
    assert.throws(() => validateConfig({ ...CONFIG, allowOrigins: [] }), /allowOrigins/);
    assert.throws(() => validateConfig({ ...CONFIG, logDir: "logs" }), /logDir/);
    assert.throws(() => validateConfig({ ...CONFIG, stateDir: undefined }), /stateDir/);
    assert.throws(() => validateConfig({ ...CONFIG, evidenceDir: "" }), /evidenceDir/);
    assert.throws(() => validateConfig(null), /object/);
  });
});

// ── decidePre ───────────────────────────────────────────────────────────────

describe("browser-guard: decidePre rules, in order", () => {
  const unselected = emptyState();
  const everything = selectedState({ [OWN_TAB]: `${PREVIEW}/login` });

  test("1. a non-Chrome tool is not this guard's business", () => {
    const d = decidePre({
      tool: "Bash",
      input: { command: "rm -rf /" },
      config: CONFIG,
      state: unselected,
    });
    assert.equal(d.allow, true);
  });

  test("1. a payload with no tool name is denied", () => {
    assert.equal(
      decidePre({ tool: undefined, input: {}, config: CONFIG, state: everything }).allow,
      false,
    );
  });

  test("2. always-denied tools are denied even with the gate open and an owned tab", () => {
    for (const tool of ALWAYS_DENY) {
      const d = pre(tool, { tabId: OWN_TAB, deviceId: DEVICE }, everything);
      assert.equal(d.allow, false, tool);
      assert.match(d.reason, /never allowed/);
    }
  });

  test("3. a Chrome tool that is not on the runner list is denied (new tools fail closed)", () => {
    const d = pre("new_shiny_tool", { tabId: OWN_TAB }, everything);
    assert.equal(d.allow, false);
    assert.match(d.reason, /not on the browser runner's tool list/);
  });

  test("4. list_connected_browsers is allowed before any select", () => {
    assert.equal(pre("list_connected_browsers", {}, unselected).allow, true);
  });

  test("4. select_browser is allowed only for the pinned device", () => {
    assert.equal(pre("select_browser", { deviceId: DEVICE }, unselected).allow, true);
    const mac = pre("select_browser", { deviceId: MACBOOK }, unselected);
    assert.equal(mac.allow, false);
    assert.match(mac.reason, new RegExp(DEVICE));
    assert.equal(pre("select_browser", {}, unselected).allow, false);
    assert.equal(
      pre("select_browser", { deviceId: DEVICE.toUpperCase() }, unselected).allow,
      false,
    );
  });

  test("5. nothing else runs until the pinned browser has been selected", () => {
    for (const tool of RUNNER_TOOLS.filter(
      (t) => !["list_connected_browsers", "select_browser"].includes(t),
    )) {
      const d = pre(
        tool,
        { tabId: OWN_TAB, url: `${PREVIEW}/`, createIfEmpty: true },
        {
          selected: false,
          tabs: { [OWN_TAB]: `${PREVIEW}/` },
        },
      );
      assert.equal(d.allow, false, tool);
      assert.match(d.reason, /select the pinned browser first/, tool);
    }
  });

  test("6. tabs_context_mcp and tabs_create_mcp are allowed once selected", () => {
    assert.equal(pre("tabs_context_mcp", { createIfEmpty: true }, selectedState({})).allow, true);
    assert.equal(pre("tabs_create_mcp", {}, selectedState({})).allow, true);
  });

  test("7. navigate needs a numeric tabId", () => {
    for (const input of [
      { url: `${PREVIEW}/` },
      { tabId: String(OWN_TAB), url: `${PREVIEW}/` },
      { tabId: 1.5, url: PREVIEW },
    ]) {
      const d = pre("navigate", input, everything);
      assert.equal(d.allow, false, JSON.stringify(input));
      assert.match(d.reason, /numeric tabId/);
    }
  });

  test("7. navigate needs a tab this session owns", () => {
    const d = pre("navigate", { tabId: 999, url: `${PREVIEW}/` }, everything);
    assert.equal(d.allow, false);
    assert.match(d.reason, /not one this session opened/);
  });

  test("7. navigate needs an allowed URL, and never back/forward", () => {
    assert.equal(
      pre("navigate", { tabId: OWN_TAB, url: `${PREVIEW}/notes` }, everything).allow,
      true,
    );
    for (const url of [
      "https://github.com/",
      "https://drafto.eu/",
      "back",
      "forward",
      "javascript:alert(1)",
    ]) {
      assert.equal(pre("navigate", { tabId: OWN_TAB, url }, everything).allow, false, url);
    }
  });

  test("8. other tab tools need an owned tab", () => {
    for (const tool of [
      "computer",
      "read_page",
      "find",
      "form_input",
      "get_page_text",
      "read_console_messages",
      "read_network_requests",
      "resize_window",
      "tabs_close_mcp",
    ]) {
      const own =
        tool === "computer" ? { tabId: OWN_TAB, action: "screenshot" } : { tabId: OWN_TAB };
      assert.equal(pre(tool, own, everything).allow, true, `${tool} on own tab`);
      assert.equal(pre(tool, { tabId: 4242 }, everything).allow, false, `${tool} on foreign tab`);
      assert.equal(pre(tool, {}, everything).allow, false, `${tool} without tabId`);
    }
  });

  test("8. a tab on a neutral page is usable", () => {
    for (const url of ["", "about:blank", "chrome://newtab/"]) {
      assert.equal(
        pre("computer", { tabId: NEW_TAB, action: "screenshot" }, selectedState({ [NEW_TAB]: url }))
          .allow,
        true,
        url,
      );
    }
  });

  test("8. a tab that drifted off the allowed origin is quarantined", () => {
    for (const url of [
      "https://vercel.com/login",
      "chrome-error://chromewebdata/",
      UNKNOWN_URL,
      AMBIGUOUS_URL,
    ]) {
      const st = selectedState({ [OWN_TAB]: url });
      const d = pre("get_page_text", { tabId: OWN_TAB }, st);
      assert.equal(d.allow, false, url);
      assert.match(d.reason, /has left the allowed origin/);
      assert.equal(
        pre("form_input", { tabId: OWN_TAB, ref: "ref_1", value: "x" }, st).allow,
        false,
        url,
      );
      // ...but it can still be closed, or sent back
      assert.equal(pre("tabs_close_mcp", { tabId: OWN_TAB }, st).allow, true, url);
      assert.equal(
        pre("navigate", { tabId: OWN_TAB, url: `${PREVIEW}/login` }, st).allow,
        true,
        url,
      );
      assert.equal(pre("navigate", { tabId: OWN_TAB, url: "back" }, st).allow, false, url);
    }
  });

  test("fails closed on a missing config or a malformed state", () => {
    assert.equal(
      decidePre({
        tool: T("list_connected_browsers"),
        input: {},
        config: undefined,
        state: emptyState(),
      }).allow,
      false,
    );
    assert.equal(
      decidePre({
        tool: T("tabs_create_mcp"),
        input: {},
        config: { ...CONFIG, allowOrigins: [] },
        state: everything,
      }).allow,
      false,
    );
    for (const state of [
      { selected: "yes", tabs: {} },
      { selected: true, tabs: [] },
      { selected: true, tabs: { abc: PREVIEW } },
      "nope",
    ]) {
      const d = pre("tabs_create_mcp", {}, state);
      assert.equal(d.allow, false, JSON.stringify(state));
      assert.match(d.reason, /failed to evaluate/);
    }
  });

  test("a non-object tool_input is treated as empty", () => {
    assert.equal(
      pre("select_browser", "9796912b-8977-4d74-9c08-d9bb283b9496", emptyState()).allow,
      false,
    );
    assert.equal(pre("computer", null, everything).allow, false);
  });
});

describe("browser-guard: computer actions (rule 9)", () => {
  const st = selectedState();
  const computer = (input) => pre("computer", { tabId: OWN_TAB, ...input }, st);
  const key = (text, extra = {}) => computer({ action: "key", text, ...extra });

  const allowedKeys = [
    "Enter",
    "Return",
    "Tab",
    "Escape",
    "Esc",
    "Backspace",
    "Delete",
    "Space",
    "ArrowUp",
    "ArrowDown",
    "ArrowLeft",
    "ArrowRight",
    "Up",
    "Down",
    "Left",
    "Right",
    "Home",
    "End",
    "PageUp",
    "PageDown",
    // case-insensitive
    "ENTER",
    "arrowleft",
    "pageDOWN",
    // a single printable character, no modifier
    "a",
    "Z",
    "7",
    "/",
    ".",
    "é",
    "€",
    // select all, to clear a field
    "cmd+a",
    "ctrl+a",
    "meta+a",
    "CMD+A",
    "Ctrl+A",
    // sequences
    "Backspace Backspace Delete",
    "cmd+a Backspace",
    "  Tab   Enter  ",
  ];
  for (const text of allowedKeys) {
    test(`key allows ${JSON.stringify(text)}`, () => {
      assert.equal(key(text).allow, true);
      assert.equal(keyVerdict(text).ok, true);
    });
  }

  test("key allows repeat", () => {
    assert.equal(key("Backspace", { repeat: 40 }).allow, true);
  });

  const deniedKeys = [
    // the omnibox and other browser accelerators
    ["cmd+l", /chord/],
    ["ctrl+l", /chord/],
    ["alt+d", /chord/],
    ["cmd+t", /chord/],
    ["ctrl+w", /chord/],
    ["cmd+n", /chord/],
    ["cmd+[", /chord/],
    ["alt+Left", /chord/],
    ["shift+Tab", /chord/],
    ["cmd+shift+a", /chord/],
    ["ctrl+a+l", /chord/],
    ["+", /chord/],
    // every function key
    ["F6", /function key/],
    ["f1", /function key/],
    ["F12", /function key/],
    ["F24", /function key/],
    // other key names and words
    ["F25", /key name/],
    ["PrintScreen", /key name/],
    ["Insert", /key name/],
    ["ab", /key name/],
    ["https://evil.example", /key name/],
    // one bad token spoils the sequence
    ["Enter cmd+l", /chord/],
    ["Tab F6", /function key/],
    // nothing to press
    ["", /needs the key/],
    ["   ", /needs the key/],
    [undefined, /needs the key/],
    [42, /needs the key/],
  ];
  for (const [text, reason] of deniedKeys) {
    test(`key denies ${JSON.stringify(text)}`, () => {
      const d = key(text);
      assert.equal(d.allow, false);
      assert.match(d.reason, reason);
      assert.match(d.reason, /use clicks on page elements instead/);
    });
  }

  test("a denied key's reason never repeats the key text (it goes to the log)", () => {
    for (const text of ["ctrl+hunter2SECRET", "hunter2SECRET", "Enter hunter2SECRET"]) {
      const d = key(text);
      assert.equal(d.allow, false);
      assert.ok(!d.reason.includes("hunter2SECRET"), d.reason);
    }
  });

  test("click-type actions are allowed plain and denied with any modifier", () => {
    assert.deepEqual([...COMPUTER_CLICK_ACTIONS].sort(), [
      "double_click",
      "hover",
      "left_click",
      "left_click_drag",
      "right_click",
      "scroll",
      "triple_click",
    ]);
    for (const action of COMPUTER_CLICK_ACTIONS) {
      assert.equal(computer({ action, coordinate: [10, 10] }).allow, true, action);
      assert.equal(computer({ action, coordinate: [10, 10], modifiers: "" }).allow, true, action);
      assert.equal(computer({ action, coordinate: [10, 10], modifiers: null }).allow, true, action);
      for (const modifiers of ["cmd", "ctrl", "shift", "alt", "meta", "ctrl+shift", "win", " "]) {
        const d = computer({ action, coordinate: [10, 10], modifiers });
        assert.equal(d.allow, false, `${action} + ${modifiers}`);
        assert.match(d.reason, /modifier keys/);
        assert.match(d.reason, /plain clicks on page elements/);
      }
      assert.equal(computer({ action, modifiers: ["cmd"] }).allow, false, `${action} + [cmd]`);
    }
  });

  test("no other action may carry modifiers either", () => {
    for (const action of ["key", "type", "screenshot", "zoom", "scroll_to", "wait"]) {
      assert.equal(computer({ action, text: "a", modifiers: "cmd" }).allow, false, action);
    }
  });

  test("every other known action is allowed, type included", () => {
    for (const action of ["screenshot", "wait", "zoom", "scroll_to"]) {
      assert.equal(computer({ action }).allow, true, action);
    }
    assert.equal(computer({ action: "type", text: "drafto-qa note title" }).allow, true);
    assert.equal(computer({ action: "type", text: "https://evil.example\n" }).allow, true);
    assert.equal(COMPUTER_ACTIONS.length, 13);
  });

  test("an unknown, missing or malformed action is denied", () => {
    for (const action of [
      "middle_click",
      "drag",
      "navigate",
      "LEFT_CLICK",
      "",
      undefined,
      3,
      null,
    ]) {
      const d = computer({ action, coordinate: [1, 1] });
      assert.equal(d.allow, false, String(action));
      assert.match(d.reason, /not one the guard allows/);
    }
    assert.ok(!computer({ action: "rm -rf hunter2SECRET" }).reason.includes("hunter2SECRET"));
  });

  test("ownership and quarantine are judged before the action", () => {
    const foreign = pre("computer", { tabId: 4242, action: "key", text: "cmd+l" }, st);
    assert.match(foreign.reason, /not one this session opened/);
    const drifted = selectedState({ [OWN_TAB]: "https://evil.example/" });
    const q = pre("computer", { tabId: OWN_TAB, action: "key", text: "Enter" }, drifted);
    assert.equal(q.allow, false);
    assert.match(q.reason, /has left the allowed origin/);
  });

  test("computerVerdict treats a non-object input as empty", () => {
    assert.equal(computerVerdict(null).ok, false);
    assert.equal(computerVerdict("key").ok, false);
  });
});

// ── applyPost ───────────────────────────────────────────────────────────────

describe("browser-guard: parsing the extension's responses", () => {
  test("parses the spike's Tab Context block", () => {
    const tabs = parseTabContextBlock(SPIKE_TAB_CONTEXT);
    assert.deepEqual([...tabs], [[String(OWN_TAB), `${PREVIEW}/login`]]);
  });

  test("parses the spike's availableTabs JSON", () => {
    const tabs = parseAvailableTabsJson(SPIKE_AVAILABLE_TABS_JSON);
    assert.deepEqual([...tabs], [[String(NEW_TAB), "chrome://newtab/"]]);
  });

  test("decodes JSON-escaped titles and URLs", () => {
    const block = tabContext(OWN_TAB, [
      [OWN_TAB, 'He said "hi" <b>', `${PREVIEW}/a?q=%22x%22`],
    ]).replace("<b>", "\\u003cb\\u003e");
    assert.deepEqual(
      [...parseTabContextBlock(block)],
      [[String(OWN_TAB), `${PREVIEW}/a?q=%22x%22`]],
    );
  });

  test("a title cannot pose as the URL", () => {
    const block = tabContext(OWN_TAB, [[OWN_TAB, `x" ("${PREVIEW}/")`, "https://evil.example/"]]);
    assert.equal(parseTabContextBlock(block).get(String(OWN_TAB)), "https://evil.example/");
  });

  test("a block that does not match line for line is not trusted", () => {
    const drifted = [
      `${SPIKE_TAB_CONTEXT}\n  extra line`,
      SPIKE_TAB_CONTEXT.replace("- Available tabs:", "- Tabs:"),
      SPIKE_TAB_CONTEXT.replace('("https', "(https").replace('login")', "login)"),
      `Title: Notes\nURL: ${PREVIEW}/\n${SPIKE_TAB_CONTEXT}`,
      "Tab Context:\n- Executed on tabId: 1",
      `${SPIKE_TAB_CONTEXT}\n- Available tabs:`,
    ];
    for (const block of drifted) assert.equal(parseTabContextBlock(block), null, block);
  });

  test("an empty group is a valid listing", () => {
    assert.equal(parseTabContextBlock("\n\nTab Context:\n- Available tabs:\n").size, 0);
  });

  test("availableTabs JSON with a broken entry is not trusted", () => {
    assert.equal(parseAvailableTabsJson('{"availableTabs":[{"tabId":"1","url":"x"}]}'), null);
    assert.equal(parseAvailableTabsJson('{"tabs":[]}'), null);
    assert.equal(parseAvailableTabsJson("not json"), null);
    assert.equal(parseAvailableTabsJson('{"availableTabs":[{"tabId":5}]}').get("5"), AMBIGUOUS_URL);
  });
});

describe("browser-guard: applyPost", () => {
  test("select_browser on the pinned device opens the gate", () => {
    const { state, events } = post(
      "select_browser",
      { deviceId: DEVICE },
      [text('Selected browser "Browser 1".')],
      emptyState(),
    );
    assert.equal(state.selected, true);
    assert.deepEqual(events, [{ selected: true }]);
  });

  test("any other select_browser outcome closes the gate", () => {
    const open = selectedState({});
    assert.equal(
      post("select_browser", { deviceId: MACBOOK }, [text('Selected browser "Browser 2".')], open)
        .state.selected,
      false,
    );
    assert.equal(
      post("select_browser", { deviceId: DEVICE }, [text("Browser not found.")], open).state
        .selected,
      false,
    );
    assert.equal(post("select_browser", { deviceId: DEVICE }, [], open).state.selected, false);
  });

  test("tabs_context_mcp adopts the session group's tabs (JSON + Tab Context)", () => {
    const { state, events } = post(
      "tabs_context_mcp",
      { createIfEmpty: true },
      [
        text(SPIKE_AVAILABLE_TABS_JSON),
        text(tabContext(null, [[NEW_TAB, "New Tab", "chrome://newtab/"]])),
      ],
      selectedState({}),
    );
    assert.deepEqual(state.tabs, { [NEW_TAB]: "chrome://newtab/" });
    assert.deepEqual(events, [{ adopted: NEW_TAB }]);
    assert.equal(pre("navigate", { tabId: NEW_TAB, url: `${PREVIEW}/login` }, state).allow, true);
  });

  test("tabs_create_mcp adopts the new tab", () => {
    const { state } = post(
      "tabs_create_mcp",
      {},
      [
        text("Created new tab. Tab ID: 1264169911"),
        text(
          tabContext(1264169911, [
            [NEW_TAB, "New Tab", "chrome://newtab/"],
            [1264169911, "New Tab", "chrome://newtab/"],
          ]),
        ),
      ],
      selectedState({ [NEW_TAB]: "chrome://newtab/" }),
    );
    assert.deepEqual(Object.keys(state.tabs).sort(), [String(NEW_TAB), "1264169911"]);
  });

  test("navigate records the tab's new URL", () => {
    const { state } = post(
      "navigate",
      { tabId: OWN_TAB, url: `${PREVIEW}/login` },
      [text(`Navigated to ${PREVIEW}/login`), text(SPIKE_TAB_CONTEXT)],
      selectedState({ [OWN_TAB]: "chrome://newtab/" }),
    );
    assert.equal(state.tabs[OWN_TAB], `${PREVIEW}/login`);
  });

  test("a page-reading tool never brings a new tab into ownership", () => {
    const { state } = post(
      "get_page_text",
      { tabId: OWN_TAB },
      [
        text(`Title: Log in\nURL: ${PREVIEW}/login\nSource element: <body>\n---\nhello`),
        text(
          tabContext(OWN_TAB, [
            [OWN_TAB, "Log in", `${PREVIEW}/login`],
            [777, "Popup", `${PREVIEW}/`],
          ]),
        ),
      ],
      selectedState(),
    );
    assert.deepEqual(Object.keys(state.tabs), [String(OWN_TAB)]);
  });

  test("an owned tab missing from the group listing is dropped", () => {
    const { state, events } = post(
      "computer",
      { tabId: OWN_TAB, action: "left_click" },
      [text("Clicked at (10, 10)"), text(SPIKE_TAB_CONTEXT)],
      selectedState({ [OWN_TAB]: `${PREVIEW}/login`, 555: `${PREVIEW}/` }),
    );
    assert.deepEqual(state.tabs, { [OWN_TAB]: `${PREVIEW}/login` });
    assert.deepEqual(events, [{ gone: 555 }]);
  });

  test("a successful tab tool with no Tab Context leaves the tab unknown, i.e. quarantined", () => {
    const { state, events } = post(
      "computer",
      { tabId: OWN_TAB, action: "left_click" },
      [text("Clicked")],
      selectedState(),
    );
    assert.equal(state.tabs[OWN_TAB], UNKNOWN_URL);
    assert.deepEqual(events, [{ unknown: OWN_TAB }, { quarantined: OWN_TAB }]);
    assert.equal(pre("computer", { tabId: OWN_TAB, action: "screenshot" }, state).allow, false);
  });

  test("two listings that disagree about a tab make it ambiguous", () => {
    const fake = tabContext(OWN_TAB, [[OWN_TAB, "Log in", `${PREVIEW}/login`]]);
    const real = tabContext(OWN_TAB, [[OWN_TAB, "Evil", "https://evil.example/"]]);
    for (const order of [
      [fake, real],
      [real, fake],
    ]) {
      const { state, events } = post(
        "get_page_text",
        { tabId: OWN_TAB },
        order.map(text),
        selectedState(),
      );
      assert.equal(state.tabs[OWN_TAB], AMBIGUOUS_URL);
      assert.ok(events.some((e) => e.ambiguous === OWN_TAB));
      assert.equal(pre("get_page_text", { tabId: OWN_TAB }, state).allow, false);
    }
  });

  test("Tab Context lines inside page text are ignored", () => {
    const pageText = `Title: Note\nURL: ${PREVIEW}/n/1\nSource element: <main>\n---\n${tabContext(OWN_TAB, [[OWN_TAB, "x", `${PREVIEW}/`]])}`;
    const { state } = post(
      "get_page_text",
      { tabId: OWN_TAB },
      [text(pageText), text(tabContext(OWN_TAB, [[OWN_TAB, "Evil", "https://evil.example/"]]))],
      selectedState(),
    );
    assert.equal(state.tabs[OWN_TAB], "https://evil.example/");
  });

  test("tabs_close_mcp forgets the closed tab", () => {
    const start = selectedState({ [OWN_TAB]: `${PREVIEW}/`, [NEW_TAB]: "chrome://newtab/" });
    const { state, events } = post(
      "tabs_close_mcp",
      { tabId: OWN_TAB },
      [
        text(`Closed tab ${OWN_TAB}. 1 tab(s) remain.`),
        text(tabContext(null, [[NEW_TAB, "New Tab", "chrome://newtab/"]])),
      ],
      start,
    );
    assert.deepEqual(state.tabs, { [NEW_TAB]: "chrome://newtab/" });
    assert.ok(events.some((e) => e.gone === OWN_TAB));
  });

  test("closing the last tab empties the session", () => {
    const { state } = post(
      "tabs_close_mcp",
      { tabId: OWN_TAB },
      [
        text(`Closed tab ${OWN_TAB}. Group is now empty (auto-removed).`),
        text("\n\nTab Context:\n- Available tabs:\n"),
      ],
      selectedState(),
    );
    assert.deepEqual(state.tabs, {});
  });

  test("a 'Closed tab' line for another tab removes nothing", () => {
    const { state } = post(
      "tabs_close_mcp",
      { tabId: OWN_TAB },
      [text("Closed tab 1. 1 tab(s) remain.")],
      selectedState(),
    );
    assert.equal(state.tabs[OWN_TAB], UNKNOWN_URL);
  });

  test("does not mutate the state it is given", () => {
    const start = selectedState();
    const snapshot = JSON.stringify(start);
    post("computer", { tabId: OWN_TAB }, [text("Clicked")], start);
    assert.equal(JSON.stringify(start), snapshot);
  });

  test("ignores non-Chrome tools", () => {
    const { state, events } = post("x", {}, [], selectedState(), { tool: "Bash" });
    assert.deepEqual(events, []);
    assert.deepEqual(state.tabs, selectedState().tabs);
  });

  test("accepts tool_response as a string or as {content}", () => {
    const viaString = applyPost({
      tool: T("select_browser"),
      input: { deviceId: DEVICE },
      responseBlocks: 'Selected browser "Browser 1".',
      config: CONFIG,
      state: emptyState(),
    });
    assert.equal(viaString.state.selected, true);
    const viaContent = applyPost({
      tool: T("navigate"),
      input: { tabId: OWN_TAB },
      responseBlocks: { content: [text(SPIKE_TAB_CONTEXT)] },
      config: CONFIG,
      state: selectedState({ [OWN_TAB]: "" }),
    });
    assert.equal(viaContent.state.tabs[OWN_TAB], `${PREVIEW}/login`);
  });

  test("throws on a malformed state (the CLI then poisons the session)", () => {
    assert.throws(() => post("computer", { tabId: 1 }, [], { selected: 1, tabs: {} }));
  });
});

describe("browser-guard: quarantine, end to end through decidePre/applyPost", () => {
  test("drift off the allowlist → only close/navigate back → recovered", () => {
    let st = selectedState({ [OWN_TAB]: `${PREVIEW}/notes` });
    assert.equal(
      pre("computer", { tabId: OWN_TAB, action: "left_click", coordinate: [1, 1] }, st).allow,
      true,
    );

    // the click followed a link off the preview
    st = post(
      "computer",
      { tabId: OWN_TAB, action: "left_click" },
      [
        text("Clicked at (1, 1)"),
        text(tabContext(OWN_TAB, [[OWN_TAB, "Vercel", "https://vercel.com/login?next=%2F"]])),
      ],
      st,
    ).state;
    for (const tool of [
      "computer",
      "read_page",
      "find",
      "form_input",
      "get_page_text",
      "read_console_messages",
      "read_network_requests",
      "resize_window",
    ]) {
      assert.equal(pre(tool, { tabId: OWN_TAB }, st).allow, false, tool);
    }
    assert.equal(pre("tabs_close_mcp", { tabId: OWN_TAB }, st).allow, true);
    assert.equal(pre("navigate", { tabId: OWN_TAB, url: "https://vercel.com/" }, st).allow, false);
    assert.equal(pre("navigate", { tabId: OWN_TAB, url: `${PREVIEW}/notes` }, st).allow, true);

    st = post(
      "navigate",
      { tabId: OWN_TAB, url: `${PREVIEW}/notes` },
      [
        text(`Navigated to ${PREVIEW}/notes`),
        text(tabContext(OWN_TAB, [[OWN_TAB, "Notes", `${PREVIEW}/notes`]])),
      ],
      st,
    ).state;
    assert.equal(pre("get_page_text", { tabId: OWN_TAB }, st).allow, true);
  });
});

describe("browser-guard: screenshots", () => {
  const ROOT = "/var/folders/ng/abc/T";
  const good = `${ROOT}/claude-chrome-screenshots-Xy12Ab/screenshot-1792223827264-0.jpg`;

  test("a computer screenshot yields a copy event", () => {
    const { events } = post(
      "computer",
      { tabId: OWN_TAB, action: "screenshot", save_to_disk: true, scale: 0.5 },
      [
        text(SPIKE_TAB_CONTEXT),
        image,
        text(`Screenshot saved to: ${good}`),
        text("Include the saved path(s) in your response so they can be attached for the user."),
      ],
      selectedState(),
      { tmpRoots: [ROOT] },
    );
    assert.deepEqual(events, [{ copy: good }]);
  });

  test("only computer's response is read for screenshot paths", () => {
    const { events } = post(
      "get_page_text",
      { tabId: OWN_TAB },
      [text(`Screenshot saved to: ${good}`), text(SPIKE_TAB_CONTEXT)],
      selectedState(),
      { tmpRoots: [ROOT] },
    );
    assert.deepEqual(events, []);
  });

  test("the source path is validated strictly", () => {
    const bad = [
      "screenshot-1-0.jpg",
      `${ROOT}/claude-chrome-screenshots-Xy12Ab/../../../../Users/jakub/.ssh/id_ed25519`,
      `${ROOT}/claude-chrome-screenshots-Xy12Ab/./screenshot-1-0.jpg`,
      `${ROOT}/claude-chrome-screenshots-Xy12Ab/screenshot-1-0.gif`,
      `${ROOT}/claude-chrome-screenshots-Xy12Ab/notes.png`,
      `${ROOT}/other-dir/screenshot-1-0.png`,
      `${ROOT}/screenshot-1-0.png`,
      `/Users/jakub/claude-chrome-screenshots-Xy12Ab/screenshot-1-0.png`,
      `${ROOT}/claude-chrome-screenshots-Xy12Ab/screenshot-1-0.png\u0000.txt`,
      "",
    ];
    for (const p of bad) assert.notEqual(screenshotSourceProblem(p, { tmpRoots: [ROOT] }), null, p);
    assert.equal(screenshotSourceProblem(good, { tmpRoots: [ROOT] }), null);
    assert.equal(screenshotSourceProblem(good.replace(".jpg", ".png"), { tmpRoots: [ROOT] }), null);
  });

  test("a rejected path is reported, not copied", () => {
    const { events } = post(
      "computer",
      { tabId: OWN_TAB, action: "screenshot" },
      [text(SPIKE_TAB_CONTEXT), text("Screenshot saved to: /etc/passwd")],
      selectedState(),
      { tmpRoots: [ROOT] },
    );
    assert.equal(events.length, 1);
    assert.ok(events[0].screenshotRejected);
  });

  test("the default temp roots include os.tmpdir()", () => {
    const p = join(tmpdir(), "claude-chrome-screenshots-abc123", "screenshot-1-0.png");
    assert.equal(screenshotSourceProblem(p), null);
  });
});

// ── CLI end to end ──────────────────────────────────────────────────────────

const runGuard = (args, input) =>
  spawnSync(process.execPath, [GUARD, ...args], { encoding: "utf8", input: input ?? "" });

const mode = (p) => statSync(p).mode & 0o777;

describe("browser-guard CLI: config → settings → hooks → verify", () => {
  const SID = "3f0c2a8e-6b1d-4c2e-9a7f-1d2e3f4a5b6c";
  let tmp;
  let dirs;
  let cfgPath;
  let settingsPath;
  let settings;
  let shotDir;
  const counts = { pre: 0, denied: 0, post: 0 };

  const payload = (event, extra) => ({
    session_id: SID,
    transcript_path: join(tmp, "t.jsonl"),
    cwd: tmp,
    hook_event_name: event,
    ...extra,
  });
  const toolPayload = (event, tool, input, response) =>
    payload(event, {
      tool_name: T(tool),
      tool_input: input,
      tool_use_id: "toolu_01",
      permission_mode: "dontAsk",
      effort: "high",
      prompt_id: "p1",
      mcp_server: { name: "claude-in-chrome", source: "dynamic" },
      ...(response === undefined ? {} : { tool_response: response, duration_ms: 42 }),
    });

  // Run the hook exactly as Claude Code would: the settings file's command
  // string through a shell, the payload on stdin.
  const hook = (event, body) =>
    spawnSync("sh", ["-c", settings.hooks[event][0].hooks[0].command], {
      encoding: "utf8",
      input: JSON.stringify(body),
    });
  const preHook = (tool, input) => {
    const r = hook("PreToolUse", toolPayload("PreToolUse", tool, input));
    counts.pre += 1;
    if (r.status === 2) counts.denied += 1;
    return r;
  };
  const postHook = (tool, input, response) => {
    const r = hook("PostToolUse", toolPayload("PostToolUse", tool, input, response));
    counts.post += 1;
    return r;
  };
  const state = () => JSON.parse(readFileSync(join(dirs.state, `${SID}.json`), "utf8"));

  before(() => {
    tmp = mkdtempSync(join(tmpdir(), "browser-guard-"));
    dirs = {
      log: join(tmp, "logs", "browser-guard"),
      state: join(tmp, "state"),
      evidence: join(tmp, "evidence", "run-1"),
    };
    cfgPath = join(tmp, "cfg", "config.json");
    settingsPath = join(tmp, "cfg", "settings.json");
    shotDir = mkdtempSync(join(tmpdir(), "claude-chrome-screenshots-"));
  });
  after(() => {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(shotDir, { recursive: true, force: true });
  });

  test("config writes a validated, private config file", () => {
    const r = runGuard([
      "config",
      "--out",
      cfgPath,
      "--device",
      DEVICE,
      "--allow-origin",
      PREVIEW,
      "--allow-origin",
      "http://127.0.0.1:3100",
      "--log-dir",
      dirs.log,
      "--state-dir",
      dirs.state,
      "--evidence-dir",
      dirs.evidence,
    ]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(mode(cfgPath), 0o600);
    assert.equal(mode(dirname(cfgPath)), 0o700);
    assert.deepEqual(JSON.parse(readFileSync(cfgPath, "utf8")), {
      deviceId: DEVICE,
      allowOrigins: [PREVIEW, "http://127.0.0.1:3100"],
      logDir: dirs.log,
      stateDir: dirs.state,
      evidenceDir: dirs.evidence,
    });
  });

  test("settings points every hook at this node and this guard by absolute path", () => {
    const r = runGuard(["settings", "--config", cfgPath, "--out", settingsPath]);
    assert.equal(r.status, 0, r.stderr);
    settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    assert.deepEqual(
      settings,
      buildGuardSettings({ nodePath: process.execPath, guardPath: GUARD, configPath: cfgPath }),
    );
  });

  test("session-start writes the canary and a fresh private state", () => {
    const r = hook("SessionStart", payload("SessionStart", { source: "startup" }));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "", "SessionStart stdout would be injected into the model's context");
    assert.equal(state().selected, false);
    assert.equal(mode(join(dirs.state, `${SID}.json`)), 0o600);
    assert.equal(mode(dirs.state), 0o700);
    assert.equal(mode(dirs.log), 0o700);
    assert.equal(mode(join(dirs.log, `${SID}.jsonl`)), 0o600);
  });

  test("pre: the select gate and the device pin", () => {
    assert.equal(preHook("list_connected_browsers", {}).status, 0);
    const early = preHook("tabs_context_mcp", { createIfEmpty: true });
    assert.equal(early.status, 2);
    assert.match(early.stderr, /select the pinned browser first/);
    assert.equal(early.stdout, "");
    assert.equal(preHook("switch_browser", {}).status, 2);
    assert.equal(preHook("select_browser", { deviceId: MACBOOK }).status, 2);
    assert.equal(preHook("select_browser", { deviceId: DEVICE }).status, 0);
    assert.equal(
      postHook("select_browser", { deviceId: DEVICE }, [text('Selected browser "Browser 1".')])
        .status,
      0,
    );
    assert.equal(state().selected, true);
  });

  test("pre/post: own tabs and the navigation allowlist", () => {
    assert.equal(preHook("tabs_context_mcp", { createIfEmpty: true }).status, 0);
    postHook("tabs_context_mcp", { createIfEmpty: true }, [
      text(
        `{"availableTabs":[{"tabId":${OWN_TAB},"title":"New Tab","url":"chrome://newtab/"}],"tabGroupId":1943373469}`,
      ),
      text(tabContext(null, [[OWN_TAB, "New Tab", "chrome://newtab/"]])),
    ]);
    assert.deepEqual(state().tabs, { [OWN_TAB]: "chrome://newtab/" });

    assert.equal(
      preHook("navigate", { url: `${PREVIEW}/login` }).status,
      2,
      "navigate without tabId",
    );
    assert.equal(
      preHook("navigate", { tabId: 1, url: `${PREVIEW}/login` }).status,
      2,
      "foreign tab",
    );
    const evil = preHook("navigate", { tabId: OWN_TAB, url: "https://drafto.eu/" });
    assert.equal(evil.status, 2);
    assert.match(evil.stderr, /not this run's allowed origin/);
    assert.equal(
      preHook("navigate", { tabId: OWN_TAB, url: `${PREVIEW}/login?next=%2Fsecret-token` }).status,
      0,
    );
    postHook("navigate", { tabId: OWN_TAB, url: `${PREVIEW}/login` }, [
      text(`Navigated to ${PREVIEW}/login`),
      text(SPIKE_TAB_CONTEXT),
    ]);
    assert.equal(state().tabs[OWN_TAB], `${PREVIEW}/login`);

    assert.equal(
      preHook("form_input", { tabId: OWN_TAB, ref: "ref_7", value: "hunter2-SECRET-VALUE" }).status,
      0,
    );
    const omnibox = preHook("computer", { tabId: OWN_TAB, action: "key", text: "cmd+l" });
    assert.equal(omnibox.status, 2);
    assert.match(omnibox.stderr, /use clicks on page elements instead/);
    assert.equal(
      preHook("computer", { tabId: OWN_TAB, action: "key", text: "ctrl+KEY-SECRET-TEXT" }).status,
      2,
    );
    assert.equal(
      preHook("computer", {
        tabId: OWN_TAB,
        action: "left_click",
        coordinate: [5, 5],
        modifiers: "cmd",
      }).status,
      2,
    );
    assert.equal(
      preHook("computer", { tabId: OWN_TAB, action: "key", text: "cmd+a Backspace" }).status,
      0,
    );
    assert.equal(
      preHook("computer", { tabId: OWN_TAB, action: "type", text: "typed-SECRET-TEXT" }).status,
      0,
    );
  });

  test("post: a screenshot is copied, not moved, into a private evidence dir", () => {
    const src = join(shotDir, "screenshot-1792223827264-0.jpg");
    writeFileSync(src, "fake-jpeg-bytes", { mode: 0o600 });
    const r = postHook("computer", { tabId: OWN_TAB, action: "screenshot", save_to_disk: true }, [
      text("Successfully captured screenshot"),
      text(SPIKE_TAB_CONTEXT),
      image,
      text(`Screenshot saved to: ${src}`),
    ]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(src), "the source must be left in place");
    const dest = join(dirs.evidence, "screenshot-1792223827264-0.jpg");
    assert.equal(readFileSync(dest, "utf8"), "fake-jpeg-bytes");
    assert.equal(mode(dest), 0o600);
    assert.equal(mode(dirs.evidence), 0o700);

    // the same name again gets a suffix instead of overwriting
    postHook("computer", { tabId: OWN_TAB, action: "screenshot" }, [
      text(SPIKE_TAB_CONTEXT),
      text(`Screenshot saved to: ${src}`),
    ]);
    assert.deepEqual(readdirSync(dirs.evidence).sort(), [
      "screenshot-1792223827264-0-1.jpg",
      "screenshot-1792223827264-0.jpg",
    ]);
  });

  test("post: a symlinked screenshot is not followed", () => {
    const secret = join(tmp, "secret.txt");
    writeFileSync(secret, "do not copy");
    symlinkSync(secret, join(shotDir, "screenshot-1-0.png"));
    postHook("computer", { tabId: OWN_TAB, action: "screenshot" }, [
      text(SPIKE_TAB_CONTEXT),
      text(`Screenshot saved to: ${join(shotDir, "screenshot-1-0.png")}`),
    ]);
    assert.ok(!existsSync(join(dirs.evidence, "screenshot-1-0.png")));
    const last = readFileSync(join(dirs.log, `${SID}.jsonl`), "utf8")
      .trim()
      .split("\n")
      .at(-1);
    assert.match(last, /copyFailed/);
  });

  test("pre/post: a tab that drifts off the allowlist is quarantined", () => {
    postHook("computer", { tabId: OWN_TAB, action: "left_click" }, [
      text("Clicked at (100, 200)"),
      text(tabContext(OWN_TAB, [[OWN_TAB, "GitHub", "https://github.com/JakubAnderwald/drafto"]])),
    ]);
    const blocked = preHook("get_page_text", { tabId: OWN_TAB });
    assert.equal(blocked.status, 2);
    assert.match(blocked.stderr, /has left the allowed origin/);
    assert.equal(preHook("navigate", { tabId: OWN_TAB, url: `${PREVIEW}/login` }).status, 0);
    assert.equal(preHook("tabs_close_mcp", { tabId: OWN_TAB }).status, 0);
  });

  test("every post in the run removed its in-flight marker", () => {
    assert.deepEqual(
      readdirSync(dirs.state).filter((n) => n.endsWith(".inflight")),
      [],
    );
  });

  test("the decision log has one line per hook call and no secret input values", () => {
    const log = readFileSync(join(dirs.log, `${SID}.jsonl`), "utf8");
    assert.ok(!log.includes("hunter2-SECRET-VALUE"), "form_input value leaked into the log");
    assert.ok(!log.includes("typed-SECRET-TEXT"), "computer text leaked into the log");
    assert.ok(!log.includes("KEY-SECRET-TEXT"), "computer key text leaked into the log");
    assert.ok(!log.includes("secret-token"), "navigate query leaked into the log");
    const lines = log
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    assert.equal(lines.length, 1 + counts.pre + counts.post);
    for (const l of lines) {
      assert.ok(
        typeof l.at === "string" && ["session-start", "pre", "post"].includes(l.event),
        JSON.stringify(l),
      );
      assert.ok("tool" in l && "allow" in l && "reason" in l, JSON.stringify(l));
    }
    const nav = lines.find((l) => l.event === "pre" && l.tool === T("navigate") && l.allow);
    assert.equal(nav.url, `${PREVIEW}/login?…`);
    assert.equal(nav.tabId, OWN_TAB);
    const formInput = lines.find((l) => l.tool === T("form_input"));
    assert.deepEqual(Object.keys(formInput).sort(), [
      "allow",
      "at",
      "event",
      "reason",
      "tabId",
      "tool",
    ]);
  });

  test("verify reports the canary and the counts", () => {
    const r = runGuard(["verify", "--config", cfgPath, "--session", SID]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { sessionStart: true, ...counts });
    assert.ok(counts.denied >= 6);
  });

  test("verify exits non-zero for a session whose hooks never loaded", () => {
    const r = runGuard([
      "verify",
      "--config",
      cfgPath,
      "--session",
      "00000000-0000-4000-8000-000000000000",
    ]);
    assert.equal(r.status, 1);
    assert.deepEqual(JSON.parse(r.stdout), { sessionStart: false, pre: 0, denied: 0, post: 0 });
  });

  test("allowed-tools prints the --allowedTools value", () => {
    const r = runGuard(["allowed-tools"]);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), allowedToolsArg());
  });
});

describe("browser-guard CLI: fails closed", () => {
  const SID = "a1b2c3d4-0000-4000-8000-00000000beef";
  let tmp;
  let cfgPath;
  let stateDir;
  let logDir;

  const prePayload = (tool, input, sid = SID) =>
    JSON.stringify({
      session_id: sid,
      hook_event_name: "PreToolUse",
      tool_name: T(tool),
      tool_input: input,
    });

  before(() => {
    tmp = mkdtempSync(join(tmpdir(), "browser-guard-fc-"));
    stateDir = join(tmp, "state");
    logDir = join(tmp, "log");
    cfgPath = join(tmp, "config.json");
    const r = runGuard([
      "config",
      "--out",
      cfgPath,
      "--device",
      DEVICE,
      "--allow-origin",
      PREVIEW,
      "--log-dir",
      logDir,
      "--state-dir",
      stateDir,
      "--evidence-dir",
      join(tmp, "ev"),
    ]);
    assert.equal(r.status, 0, r.stderr);
  });
  after(() => rmSync(tmp, { recursive: true, force: true }));

  const pre = (input, args = ["--config", cfgPath]) => runGuard(["hook", "pre", ...args], input);

  test("unparsable stdin", () => {
    const r = pre("{not json, form_input value hunter2");
    assert.equal(r.status, 2);
    assert.ok(!r.stderr.includes("hunter2"), "the payload must not be echoed back");
  });

  test("an empty payload, a non-object payload, a missing session id", () => {
    assert.equal(pre("").status, 2);
    assert.equal(pre("[]").status, 2);
    assert.equal(
      pre(JSON.stringify({ tool_name: T("list_connected_browsers"), tool_input: {} })).status,
      2,
    );
  });

  test("a session id that would escape the state dir", () => {
    assert.equal(pre(prePayload("list_connected_browsers", {}, "../../etc/x")).status, 2);
  });

  test("a missing or invalid config", () => {
    assert.equal(
      pre(prePayload("list_connected_browsers", {}), ["--config", join(tmp, "nope.json")]).status,
      2,
    );
    const broken = join(tmp, "broken.json");
    writeFileSync(
      broken,
      JSON.stringify({ deviceId: DEVICE, allowOrigins: ["https://drafto.eu"] }),
    );
    assert.equal(pre(prePayload("list_connected_browsers", {}), ["--config", broken]).status, 2);
    assert.equal(pre(prePayload("list_connected_browsers", {}), []).status, 2);
    assert.equal(
      runGuard(
        ["hook", "pre", "--config", cfgPath, "--bogus", "x"],
        prePayload("list_connected_browsers", {}),
      ).status,
      2,
    );
  });

  test("a corrupt state file", () => {
    const sid = "c0000000-0000-4000-8000-000000000001";
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, `${sid}.json`), "{selected: true");
    assert.equal(pre(prePayload("list_connected_browsers", {}, sid)).status, 2);
    writeFileSync(join(stateDir, `${sid}.json`), JSON.stringify({ selected: "true", tabs: {} }));
    assert.equal(pre(prePayload("list_connected_browsers", {}, sid)).status, 2);
  });

  test("an unwritable decision log denies", () => {
    const sid = "c0000000-0000-4000-8000-000000000002";
    mkdirSync(join(logDir, `${sid}.jsonl`), { recursive: true }); // a directory where the log file goes
    assert.equal(pre(prePayload("list_connected_browsers", {}, sid)).status, 2);
  });

  test("a missing guard file or node binary still blocks, via `|| exit 2`", () => {
    for (const paths of [
      { nodePath: process.execPath, guardPath: join(tmp, "moved-away.mjs"), configPath: cfgPath },
      // with the bare `exec @ARGV` perl would exit 0 here, i.e. allow
      { nodePath: join(tmp, "no-such-node"), guardPath: GUARD, configPath: cfgPath },
      {
        nodePath: process.execPath,
        guardPath: GUARD,
        configPath: cfgPath,
        perlPath: join(tmp, "no-such-perl"),
      },
    ]) {
      const command = buildGuardSettings(paths).hooks.PreToolUse[0].hooks[0].command;
      const r = spawnSync("sh", ["-c", command], {
        encoding: "utf8",
        input: prePayload("list_connected_browsers", {}),
      });
      assert.equal(r.status, 2, JSON.stringify(paths));
    }
  });

  // The real generated command with only the alarm shortened, around a guard
  // that never returns: perl's SIGALRM must turn the hang into a block.
  test("a hung pre guard is killed by the alarm and blocks", () => {
    const hang = join(tmp, "hang.mjs");
    writeFileSync(hang, "setTimeout(() => {}, 60_000);\n");
    const command = buildGuardSettings({
      nodePath: process.execPath,
      guardPath: hang,
      configPath: cfgPath,
    }).hooks.PreToolUse[0].hooks[0].command;
    const marker = `' ${PRE_ALARM_SEC} '`;
    assert.equal(command.split(marker).length, 2, command);
    const started = Date.now();
    const r = spawnSync("sh", ["-c", command.replace(marker, "' 1 '")], {
      encoding: "utf8",
      input: prePayload("list_connected_browsers", {}),
      timeout: 15_000,
    });
    assert.equal(r.status, 2, `status ${r.status} signal ${r.signal}`);
    assert.ok(Date.now() - started < 10_000, "the alarm, not the test timeout, ended it");
  });

  test("the alarm wrapper passes the guard's own verdict through", () => {
    const command = buildGuardSettings({
      nodePath: process.execPath,
      guardPath: GUARD,
      configPath: cfgPath,
    }).hooks.PreToolUse[0].hooks[0].command;
    const sid = "c0000000-0000-4000-8000-0000000000a1";
    const run = (tool, input) =>
      spawnSync("sh", ["-c", command], { encoding: "utf8", input: prePayload(tool, input, sid) });
    assert.equal(run("list_connected_browsers", {}).status, 0);
    const denied = run("switch_browser", {});
    assert.equal(denied.status, 2);
    assert.match(denied.stderr, /never allowed/);
  });

  test("settings refuses to write a file when perl is missing or not executable", () => {
    const out = join(tmp, "settings-noperl.json");
    const notExec = join(tmp, "perl-not-executable");
    writeFileSync(notExec, "#!/bin/sh\n", { mode: 0o644 });
    for (const perl of [join(tmp, "no-such-perl"), notExec, tmp, "perl"]) {
      const r = runGuard(["settings", "--config", cfgPath, "--out", out, "--perl", perl]);
      assert.equal(r.status, 1, perl);
      assert.match(r.stderr, /perl/, perl);
      assert.ok(!existsSync(out), perl);
    }
    const ok = runGuard(["settings", "--config", cfgPath, "--out", out, "--perl", "/usr/bin/perl"]);
    assert.equal(ok.status, 0, ok.stderr);
  });

  test("pre denies every call while an in-flight post marker exists for the session", () => {
    const sid = "c0000000-0000-4000-8000-0000000000b1";
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, `${sid}.json`), JSON.stringify(selectedState()));
    const marker = join(stateDir, `${sid}.post-toolu_01HANDMADE.inflight`);
    writeFileSync(marker, "x");
    for (const [tool, input] of [
      ["list_connected_browsers", {}],
      ["select_browser", { deviceId: DEVICE }],
      ["get_page_text", { tabId: OWN_TAB }],
    ]) {
      const r = pre(prePayload(tool, input, sid));
      assert.equal(r.status, 2, tool);
      assert.ok(r.stderr.includes(INFLIGHT_REASON), r.stderr);
    }
    // another session's marker is not this session's business
    const other = "c0000000-0000-4000-8000-0000000000b2";
    assert.equal(pre(prePayload("list_connected_browsers", {}, other)).status, 0);
    // and a post that never fired (an errored call) leaves nothing behind to wait for
    rmSync(marker);
    assert.equal(pre(prePayload("get_page_text", { tabId: OWN_TAB }, sid)).status, 0);
  });

  // Hold the session lock so the post blocks between marking itself in flight
  // and writing state, i.e. exactly where its timeout would kill it.
  const startHeldPost = (sid, toolUseId) => {
    const lock = join(stateDir, `${sid}.lock`);
    mkdirSync(lock, { recursive: true });
    const child = spawn(process.execPath, [GUARD, "hook", "post", "--config", cfgPath], {
      stdio: ["pipe", "ignore", "pipe"],
    });
    const exited = new Promise((done) =>
      child.on("exit", (code, signal) => done({ code, signal })),
    );
    child.stdin.end(
      JSON.stringify({
        session_id: sid,
        tool_use_id: toolUseId,
        tool_name: T("select_browser"),
        tool_input: { deviceId: DEVICE },
        tool_response: [text('Selected browser "Browser 1".')],
      }),
    );
    return { child, exited, lock };
  };
  const waitFor = async (pred, ms = 4000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (pred()) return true;
      await new Promise((r) => setTimeout(r, 20));
    }
    return pred();
  };

  test("post marks itself in flight first and removes the marker once state is written", async () => {
    const sid = "c0000000-0000-4000-8000-0000000000c1";
    const marker = join(stateDir, `${sid}.post-toolu_01HELD.inflight`);
    const { exited, lock } = startHeldPost(sid, "toolu_01HELD");
    try {
      assert.ok(await waitFor(() => existsSync(marker)), "no in-flight marker while post runs");
      const r = pre(prePayload("list_connected_browsers", {}, sid));
      assert.equal(r.status, 2);
      assert.ok(r.stderr.includes(INFLIGHT_REASON));
    } finally {
      rmSync(lock, { recursive: true, force: true });
    }
    assert.deepEqual(await exited, { code: 0, signal: null });
    assert.ok(!existsSync(marker), "the marker outlived a successful post");
    assert.equal(JSON.parse(readFileSync(join(stateDir, `${sid}.json`), "utf8")).selected, true);
    assert.equal(pre(prePayload("list_connected_browsers", {}, sid)).status, 0);
  });

  test("a SIGKILLed post leaves its marker, and the session stays denied until a fresh start", async () => {
    const sid = "c0000000-0000-4000-8000-0000000000d1";
    const marker = join(stateDir, `${sid}.post-toolu_01KILLED.inflight`);
    const { child, exited, lock } = startHeldPost(sid, "toolu_01KILLED");
    try {
      assert.ok(await waitFor(() => existsSync(marker)), "no in-flight marker while post runs");
      child.kill("SIGKILL");
      assert.equal((await exited).signal, "SIGKILL");
    } finally {
      rmSync(lock, { recursive: true, force: true });
    }
    assert.ok(existsSync(marker), "a killed post must leave its marker behind");
    assert.ok(!existsSync(join(stateDir, `${sid}.json`)), "the killed post wrote no state");
    // no staleness timeout: the marker holds however old it gets
    const old = new Date(Date.now() - 24 * 60 * 60 * 1000);
    utimesSync(marker, old, old);
    for (const tool of ["list_connected_browsers", "select_browser"]) {
      const r = pre(prePayload(tool, { deviceId: DEVICE }, sid));
      assert.equal(r.status, 2, tool);
      assert.ok(r.stderr.includes(INFLIGHT_REASON));
    }
    // a compaction does not clear it; only a fresh startup does
    runGuard(
      ["hook", "session-start", "--config", cfgPath],
      JSON.stringify({ session_id: sid, source: "compact" }),
    );
    assert.ok(existsSync(marker));
    runGuard(
      ["hook", "session-start", "--config", cfgPath],
      JSON.stringify({ session_id: sid, source: "startup" }),
    );
    assert.ok(!existsSync(marker));
    assert.equal(pre(prePayload("list_connected_browsers", {}, sid)).status, 0);
  });

  test("a post without a tool_use_id still marks itself, under a random token", async () => {
    const sid = "c0000000-0000-4000-8000-0000000000e1";
    const { exited, lock } = startHeldPost(sid, undefined);
    let names = [];
    try {
      assert.ok(
        await waitFor(() => {
          names = readdirSync(stateDir).filter((n) => n.startsWith(`${sid}.post-`));
          return names.length === 1;
        }),
      );
      assert.match(
        names[0],
        /^c0000000-0000-4000-8000-0000000000e1\.post-anon-[0-9a-f]{16}\.inflight$/,
      );
    } finally {
      rmSync(lock, { recursive: true, force: true });
    }
    await exited;
    assert.deepEqual(
      readdirSync(stateDir).filter((n) => n.startsWith(`${sid}.post-`)),
      [],
    );
  });

  test("a failed post update poisons the session; every later pre denies", () => {
    const sid = "c0000000-0000-4000-8000-000000000003";
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, `${sid}.json`), "garbage");
    const r = runGuard(
      ["hook", "post", "--config", cfgPath],
      JSON.stringify({
        session_id: sid,
        tool_name: T("computer"),
        tool_input: { tabId: 1 },
        tool_response: [],
      }),
    );
    assert.equal(r.status, 0, "post must never fail the tool call");
    assert.ok(existsSync(join(stateDir, `${sid}.poisoned`)));
    assert.deepEqual(
      readdirSync(stateDir).filter((n) => n.startsWith(`${sid}.post-`)),
      [],
      "a caught error removes the in-flight marker once the poison is written",
    );
    // even with the state repaired, the poison holds
    writeFileSync(join(stateDir, `${sid}.json`), JSON.stringify(emptyState()));
    const denied = pre(prePayload("list_connected_browsers", {}, sid));
    assert.equal(denied.status, 2);
    assert.match(denied.stderr, /lost track/);
  });

  test("post and session-start exit 0 on garbage", () => {
    assert.equal(runGuard(["hook", "post", "--config", cfgPath], "nope").status, 0);
    assert.equal(runGuard(["hook", "session-start", "--config", cfgPath], "nope").status, 0);
    assert.equal(runGuard(["hook", "post", "--config", join(tmp, "nope.json")], "{}").status, 0);
  });

  test("a stale lock left by a killed hook does not wedge the session", () => {
    const sid = "c0000000-0000-4000-8000-000000000004";
    const lock = join(stateDir, `${sid}.lock`);
    mkdirSync(lock, { recursive: true });
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    const r = runGuard(
      ["hook", "post", "--config", cfgPath],
      JSON.stringify({
        session_id: sid,
        tool_name: T("select_browser"),
        tool_input: { deviceId: DEVICE },
        tool_response: [text('Selected browser "Browser 1".')],
      }),
    );
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!existsSync(join(stateDir, `${sid}.poisoned`)));
    assert.equal(JSON.parse(readFileSync(join(stateDir, `${sid}.json`), "utf8")).selected, true);
  });

  test("session-start on startup resets a reused session and clears its poison", () => {
    const sid = "c0000000-0000-4000-8000-000000000005";
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, `${sid}.json`), JSON.stringify(selectedState()));
    writeFileSync(join(stateDir, `${sid}.poisoned`), "x");
    writeFileSync(join(stateDir, `${sid}.post-toolu_left.inflight`), "x");
    const r = runGuard(
      ["hook", "session-start", "--config", cfgPath],
      JSON.stringify({ session_id: sid, source: "startup" }),
    );
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(readFileSync(join(stateDir, `${sid}.json`), "utf8")).tabs, {});
    assert.ok(!existsSync(join(stateDir, `${sid}.poisoned`)));
    assert.ok(!existsSync(join(stateDir, `${sid}.post-toolu_left.inflight`)));

    // a compaction mid-run keeps what the session had
    writeFileSync(join(stateDir, `${sid}.json`), JSON.stringify(selectedState()));
    runGuard(
      ["hook", "session-start", "--config", cfgPath],
      JSON.stringify({ session_id: sid, source: "compact" }),
    );
    assert.equal(JSON.parse(readFileSync(join(stateDir, `${sid}.json`), "utf8")).selected, true);
  });

  test("a screenshot directory that is not private is refused", () => {
    const sid = "c0000000-0000-4000-8000-000000000006";
    const dir = mkdtempSync(join(tmpdir(), "claude-chrome-screenshots-"));
    try {
      chmodSync(dir, 0o755);
      const src = join(dir, "screenshot-5-0.png");
      writeFileSync(src, "png");
      runGuard(
        ["hook", "post", "--config", cfgPath],
        JSON.stringify({
          session_id: sid,
          tool_name: T("computer"),
          tool_input: { tabId: 1 },
          tool_response: [text(`Screenshot saved to: ${src}`)],
        }),
      );
      assert.ok(!existsSync(join(tmp, "ev", "screenshot-5-0.png")));
      const last = readFileSync(join(logDir, `${sid}.jsonl`), "utf8")
        .trim()
        .split("\n")
        .at(-1);
      assert.match(JSON.parse(last).events[0].copyFailed, /not a private directory/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("config refuses a bad origin; settings refuses a missing config", () => {
    const base = [
      "config",
      "--out",
      join(tmp, "c2.json"),
      "--device",
      DEVICE,
      "--log-dir",
      logDir,
      "--state-dir",
      stateDir,
      "--evidence-dir",
      tmp,
    ];
    assert.equal(runGuard([...base, "--allow-origin", "https://drafto.eu"]).status, 1);
    assert.equal(runGuard([...base, "--allow-origin", `${PREVIEW}/login`]).status, 1);
    assert.equal(runGuard(base).status, 1);
    assert.ok(!existsSync(join(tmp, "c2.json")));
    assert.equal(
      runGuard(["settings", "--config", join(tmp, "nope.json"), "--out", join(tmp, "s.json")])
        .status,
      1,
    );
    assert.ok(!existsSync(join(tmp, "s.json")));
  });

  test("an unknown subcommand prints usage and exits 1", () => {
    const r = runGuard(["frobnicate"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Usage:/);
  });
});
