// The device lane's phase (b): the scenario's iOS / Android steps (ADR-0106
// decision 2), run by device-lane.mjs's supervisor after the repo flows, on
// the same booted device with the same app installed. Off unless
// FACTORY_DEVICE_SCENARIO=1, and only for a platform the In Test scenario has
// a section for.
//
// A guarded claude session translates the platform's scenario sections into
// Maestro YAML. It never touches the device and never sees the account:
//   - `claude -p --no-chrome --strict-mcp-config --setting-sources ""
//     --permission-mode dontAsk`, tools Bash, Read, Grep, Glob and Write,
//     under verify-guard.mjs's device-scenario mode (Write only to
//     flows/NN-<slug>.yaml, Bash only `device-run` and read-only commands,
//     everything only inside its own directory);
//   - the lane's allowlisted environment (verify-lane.mjs laneEnv): no GitHub
//     token, no password, no FACTORY_DEVICE_ACCOUNT_FILE;
//   - its directory, <runDir>/scenario-<platform>/, holds flows/ (its own
//     YAML), examples/ (a few repo flows, read-only references), helpers/
//     (the vetted sign-in helper and the supervisor's wrapper around it, the
//     only external files runFlow may name), requests/, iter-shots/ and bin/.
//
// `device-run flows/NN-<slug>.yaml` is bin/device-run, a wrapper that runs
// nothing: it drops requests/<n>.json and waits for <n>.result.json. The
// supervisor, the session's parent, serves each request outside the session:
// it snapshots the flow (and every run-local flow it runFlows) into private/,
// validates the snapshot (device-flow-validate.mjs), runs it with the lane's
// Maestro runner (the password only in Maestro's environment, a fresh RUN_ID,
// the adb-drop retry) and answers with the filtered JUnit lines, the
// validator's errors and the names of screenshots it took into iter-shots/,
// which only the session sees. At most FACTORY_DEVICE_SCENARIO_RUNS runs and
// FACTORY_DEVICE_SCENARIO_MIN minutes per session: past either, its process
// group is killed.
//
// The evidence is a final pass (ADR-0106 decision 8): once the session's
// process group is confirmed gone, every flows/*.yaml is validated again and
// re-run in order on a fresh app state, and only those runs' supervisor
// screenshots go to evidence/ and shots.json. Their rows join the platform's
// flows as `scenario: <file>`; the session's own summary (secret-scanned,
// capped) is platforms.<p>.scenarioSummary. A session that fails or times out
// never touches phase (a)'s rows.

import { randomUUID } from "node:crypto";
import * as nodeFs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  APP_ID,
  Interrupt,
  captureShot,
  flowSlug,
  avdExists,
  groupAlive,
  isAdbDrop,
  killGroup,
  makeMaestro,
  nextRunEpoch,
  platformVerdict,
  recordGroup,
  runFlowOnce,
  sanitizeLine,
  screencapTo,
  signInPreludeYaml,
} from "./device-lane.mjs";
import { E2E_DIR, flowNeedsSignIn, headingPlatforms, MOBILE_HEADING } from "./device-plan.mjs";
import { MAX_FLOW_BYTES, normaliseRef, validateFlow } from "./device-flow-validate.mjs";
import {
  DEVICE_FLOW_FILE_RE,
  DEVICE_RUN_BIN,
  DEVICE_SCENARIO_MODE,
  writeGuardFiles,
} from "./verify-guard.mjs";
import {
  DEVICE_SCENARIO_TOOL_LIST,
  assertSafeClaudeArgs,
  buildClaudeArgs,
  checkGuard,
  laneEnv,
  parseJson,
  readKnobs,
  readText,
  rmQuiet,
  writeJsonAtomic,
} from "./verify-lane.mjs";
import { scanLaneText } from "./verify-report.mjs";

const THIS_FILE = fileURLToPath(import.meta.url);
const LIB_DIR = path.dirname(THIS_FILE);
const DEVICE_LANE = path.join(LIB_DIR, "device-lane.mjs");
const RUN_CLAUDE = path.join(LIB_DIR, "run-claude.mjs");
export const PROMPT_FILE = path.resolve(LIB_DIR, "..", "factory-device-prompt.md");

const MINUTE_MS = 60_000;
// Time kept after a session for the final pass, out of the run's deadline.
const FINAL_RESERVE_MS = 20 * MINUTE_MS;
// Kept for each platform still to come after this one in the run.
const PLATFORM_RESERVE_MS = 60 * MINUTE_MS;
// A session with less than this left isn't worth starting.
const MIN_SESSION_MS = 10 * MINUTE_MS;
// After the run cap is reached the session may still write its summary.
const RUN_CAP_GRACE_MS = 2 * MINUTE_MS;
const POLL_MS = 1_000;
// The wrapper waits at most this long per call (the Bash tool's own cap is 10
// minutes); a longer run is waited for again with `device-run --wait <n>`.
const WRAPPER_WAIT_MAX_SEC = 540;
export const SUMMARY_MAX = 4096;
// Below the model's image limit (about 5 MB).
const SHOT_MAX_BYTES = 4.5 * 1024 * 1024;
const REQUEST_RE = /^([1-9][0-9]{0,3})\.json$/;
// A few repo flows, copied as read-only examples of the app's selectors.
export const EXAMPLE_FLOWS = Object.freeze([
  "02-create-notebook.yaml",
  "03-create-edit-note.yaml",
  "04-trash-restore.yaml",
  "search.yaml",
]);
export const SIGN_IN_HELPER = "helpers/sign-in-clean.yaml";
// The supervisor's wrapper around the vetted helper: it maps the account's
// variables onto the helper's, so a session's flow signs in with
// `runFlow: ../helpers/sign-in.yaml` and never names a credential.
export const SIGN_IN_WRAPPER = "helpers/sign-in.yaml";
const RUN_FLOW_HELPERS = Object.freeze([`../${SIGN_IN_WRAPPER}`, `../${SIGN_IN_HELPER}`]);

// ── scenario sections ───────────────────────────────────────────────────────

/** The sections that are <platform>'s steps (an iOS, Android or mobile heading). */
export function scenarioSectionsFor(sections, platform) {
  return (Array.isArray(sections) ? sections : []).filter((s) =>
    headingPlatforms(s?.heading).includes(platform),
  );
}

/**
 * `device-lane.mjs scenario-file`: the mobile sections of the factory's
 * scenario comment for exactly <sha> (factory-bundle.mjs's selectors), as a
 * mode-600 JSON file at <out>. Nothing is written when there are none.
 */
export async function writeScenarioFile({ commentsText, sha, out, fs = nodeFs }) {
  const { extractScenarioSections, selectScenarioComment } = await import("./factory-bundle.mjs");
  const comments = parseJson(commentsText, null);
  const scenario = selectScenarioComment(Array.isArray(comments) ? comments : [], sha);
  const sections = scenario
    ? extractScenarioSections(scenario.body).filter((s) => MOBILE_HEADING.test(s.heading))
    : [];
  rmQuiet(fs, out);
  if (!sections.length) return { written: false, sections: 0 };
  const tmp = `${out}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(sections)}\n`, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, out);
  return { written: true, sections: sections.length };
}

// ── the session's directory ─────────────────────────────────────────────────

/** The supervisor's wrapper around the vetted sign-in helper (helpers/sign-in.yaml). */
export function signInWrapperYaml() {
  // The prelude, pointed at the helper beside it: runFlow paths are relative
  // to the file that names them.
  return signInPreludeYaml().replace(
    `file: ${SIGN_IN_HELPER}`,
    `file: ${path.basename(SIGN_IN_HELPER)}`,
  );
}

/** A clean, signed-out app: the reset before each scenario flow. */
export function scenarioResetYaml(platform) {
  return [
    `appId: ${APP_ID}`,
    "---",
    "# Written by the device lane (device-scenario.mjs): a clean app before a scenario flow.",
    ...(platform === "android" ? ["- setAirplaneMode: disabled"] : []),
    "- clearKeychain",
    "- launchApp:",
    "    clearState: true",
    "- stopApp",
    "",
  ].join("\n");
}

/** bin/device-run: the session's only way to ask for a run. */
export function deviceRunScript({ nodePath, modulePath = DEVICE_LANE, dir, timeoutSec }) {
  for (const [label, p] of [
    ["node", nodePath],
    ["module", modulePath],
    ["dir", dir],
  ]) {
    if (!path.isAbsolute(p) || p.includes("'") || /[\u0000-\u001f]/.test(p)) {
      throw new Error(`device-run: unusable ${label} path`);
    }
  }
  if (!Number.isInteger(timeoutSec) || timeoutSec <= 0) throw new Error("device-run: bad timeout");
  return [
    "#!/bin/sh",
    "# Asks the device lane's supervisor to validate and run a flow (device-lane.mjs device-run).",
    `exec '${nodePath}' '${modulePath}' device-run --dir '${dir}' --timeout-sec ${timeoutSec} -- "$@"`,
    "",
  ].join("\n");
}

function copyIfFile(fs, from, to, maxBytes = MAX_FLOW_BYTES * 4) {
  try {
    const st = fs.lstatSync(from);
    if (!st.isFile() || st.size > maxBytes) return false;
    fs.writeFileSync(to, fs.readFileSync(from), { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/** The helpers a flow may runFlow, from the build root (the PR head), into <dir>/helpers. */
function writeHelpers(fs, root, dir) {
  const helpers = path.join(dir, "helpers");
  fs.mkdirSync(helpers, { recursive: true, mode: 0o700 });
  copyIfFile(fs, path.join(root, E2E_DIR, SIGN_IN_HELPER), path.join(dir, SIGN_IN_HELPER));
  fs.writeFileSync(path.join(dir, SIGN_IN_WRAPPER), signInWrapperYaml(), { mode: 0o600 });
}

/** <runDir>/scenario-<platform>/ and the session's files outside it. */
export function prepareScenarioDir(ctx, platform, root) {
  const { deps, meta, runDir } = ctx;
  const fs = deps.fs;
  const cwd = path.join(runDir, `scenario-${platform}`);
  const outside = path.join(runDir, "private", `scenario-${platform}`);
  rmQuiet(fs, cwd);
  rmQuiet(fs, outside);
  const dirs = {
    cwd,
    flows: path.join(cwd, "flows"),
    requests: path.join(cwd, "requests"),
    iterShots: path.join(cwd, "iter-shots"),
    examples: path.join(cwd, "examples"),
    bin: path.join(cwd, "bin"),
    outside,
    guard: path.join(outside, "guard"),
    ghEmpty: path.join(outside, "gh-empty"),
    snapshots: path.join(outside, "snapshots"),
    out: path.join(outside, "session-output.txt"),
    err: path.join(outside, "session-stderr.log"),
  };
  for (const d of [
    cwd,
    dirs.flows,
    dirs.requests,
    dirs.iterShots,
    dirs.examples,
    dirs.bin,
    outside,
    dirs.guard,
    dirs.ghEmpty,
    dirs.snapshots,
  ]) {
    fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  }
  const examples = EXAMPLE_FLOWS.filter((name) =>
    copyIfFile(fs, path.join(root, E2E_DIR, name), path.join(dirs.examples, name)),
  );
  writeHelpers(fs, root, cwd);
  const timeoutSec = meta.knobs.flowTimeoutMin * 60 * 3;
  fs.writeFileSync(
    path.join(dirs.bin, DEVICE_RUN_BIN),
    deviceRunScript({ nodePath: meta.bins.node, dir: cwd, timeoutSec }),
    { mode: 0o700 },
  );
  return { ...dirs, exampleNames: examples };
}

// ── validation of a flow and what it runFlows ───────────────────────────────

/** flows/ names a flow in flows/<from> may runFlow, relative to flows/. */
function runFlowAllowFor(names, self) {
  return [...names.filter((n) => n !== self), ...RUN_FLOW_HELPERS];
}

function listFlowNames(fs, flowsDir) {
  try {
    return fs
      .readdirSync(flowsDir)
      .filter((n) => DEVICE_FLOW_FILE_RE.test(n))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Copy flows/<name>, and every run-local flow it runFlows, into a fresh
 * snapshot dir beside a copy of the helpers, validating each copy. What runs
 * is the snapshot: the session can't change a file between the check and the
 * run. {ok, errors, dir, file, text}.
 */
export function snapshotFlow(ctx, { platform, dirs, root, name, tag }) {
  const fs = ctx.deps.fs;
  const snap = path.join(dirs.snapshots, tag);
  rmQuiet(fs, snap);
  fs.mkdirSync(path.join(snap, "flows"), { recursive: true, mode: 0o700 });
  writeHelpers(fs, root, snap);
  const names = listFlowNames(fs, dirs.flows);
  const errors = [];
  const texts = {};
  const visit = (n, stack) => {
    if (stack.includes(n)) {
      errors.push(`${[...stack, n].join(" → ")}: runFlow goes round in a circle`);
      return;
    }
    if (Object.hasOwn(texts, n)) return;
    const src = path.join(dirs.flows, n);
    let text;
    try {
      const st = fs.lstatSync(src);
      if (!st.isFile()) throw new Error("not a plain file");
      if (st.size > MAX_FLOW_BYTES) throw new Error(`larger than ${MAX_FLOW_BYTES / 1024} KB`);
      text = fs.readFileSync(src, "utf8");
    } catch (err) {
      errors.push(`flows/${n}: can't be read (${err.message})`);
      return;
    }
    texts[n] = text;
    const v = validateFlow(text, { platform, runFlowAllow: runFlowAllowFor(names, n) });
    for (const e of v.errors) errors.push(`flows/${n}: ${e}`);
    for (const ref of v.runFlows) {
      const local = normaliseRef(ref);
      if (local && !local.startsWith("../")) visit(local, [...stack, n]);
    }
  };
  if (!DEVICE_FLOW_FILE_RE.test(name) || !names.includes(name)) {
    return { ok: false, errors: [`flows/${name} doesn't exist`], dir: snap };
  }
  visit(name, []);
  if (errors.length) return { ok: false, errors: errors.slice(0, 20), dir: snap };
  for (const [n, text] of Object.entries(texts)) {
    fs.writeFileSync(path.join(snap, "flows", n), text, { mode: 0o600 });
  }
  return {
    ok: true,
    errors: [],
    dir: snap,
    file: path.join(snap, "flows", name),
    text: texts[name],
  };
}

// ── one scenario flow on the device ─────────────────────────────────────────

/**
 * One supervisor step (the reset, the sign-in) with the Android adb-drop
 * retry the flows get. true when it passed.
 */
async function runStepFlow(ctx, { platform, maestro, file, junit, log, epoch }) {
  let r = await maestro(file, junit, log, epoch);
  if (
    platform === "android" &&
    r.code !== 0 &&
    !r.timedOut &&
    isAdbDrop(readText(ctx.deps.fs, log))
  ) {
    ctx.log(`maestro: ${platform} ${path.basename(file)} lost the device (adb); retrying once`);
    rmQuiet(ctx.deps.fs, junit);
    r = await maestro(file, junit, log, epoch);
  }
  return r.code === 0 && !r.timedOut;
}

/**
 * Reset the app, sign in when the flow needs it (the vetted helper, through
 * its wrapper in the snapshot), then run the snapshot's flow. Each Maestro
 * call works in a directory of its own under <snapshot>/out/ (reset,
 * sign-in, flow-<attempt>): a flow's screenshots are then only that
 * attempt's. Returns {status, failure, lines, durationS, resetFailed,
 * shotsDir}. Throws Interrupt.
 */
async function runSnapshot(ctx, { platform, deviceId, account, snap, label, tag }) {
  const { deps } = ctx;
  const fs = deps.fs;
  const secrets = account ? { password: account.password } : {};
  const maestroIn = (sub) => {
    const dir = path.join(snap.dir, "out", sub);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // cwd and --test-output-dir both: Maestro 2.x writes takeScreenshot files
    // under the latter, older versions into the former.
    return { dir, run: makeMaestro(ctx, { deviceId, account, root: dir, rawDir: dir }) };
  };
  const started = deps.nowMs();
  const epoch = nextRunEpoch(ctx);
  const elapsed = () => Math.round((deps.nowMs() - started) / 1000);
  const io = (step) => [
    path.join(ctx.rawDir, `${tag}-${step}.junit.xml`),
    path.join(ctx.rawDir, `${tag}-${step}.log`),
  ];
  const fail = (failure, extra = {}) => ({
    status: "ERROR",
    failure,
    lines: [],
    durationS: elapsed(),
    shotsDir: null,
    ...extra,
  });
  const reset = path.join(snap.dir, ".reset.yaml");
  fs.writeFileSync(reset, scenarioResetYaml(platform), { mode: 0o600 });
  const [rj, rl] = io("reset");
  const resetOk = await runStepFlow(ctx, {
    platform,
    maestro: maestroIn("reset").run,
    file: reset,
    junit: rj,
    log: rl,
    epoch,
  });
  if (!resetOk) {
    return fail("the lane's reset before this flow failed", { resetFailed: true });
  }
  if (flowNeedsSignIn(snap.text)) {
    if (!account) return fail("needs a signed-in app, and the run has no account");
    ctx.log(`maestro: ${platform} signing in before ${label}`);
    const [sj, sl] = io("sign-in");
    const signedIn = await runStepFlow(ctx, {
      platform,
      maestro: maestroIn("sign-in").run,
      file: path.join(snap.dir, SIGN_IN_WRAPPER),
      junit: sj,
      log: sl,
      epoch,
    });
    if (!signedIn) return fail("the lane's sign-in before this flow failed");
  }
  const [junit, log] = io("flow");
  rmQuiet(fs, junit);
  // Each attempt (an adb-drop retry is a second one) has its own output dir
  // and draws its RUN_ID from the run's counter: the first one has <epoch>.
  let attempt = 0;
  let shotsDir = null;
  const flowMaestro = (file, j, l, e) => {
    attempt += 1;
    const m = maestroIn(`flow-${attempt}`);
    shotsDir = m.dir;
    return m.run(file, j, l, e);
  };
  const out = await runFlowOnce(ctx, {
    platform,
    maestro: flowMaestro,
    flowPath: snap.file,
    label,
    junit,
    log,
    epochFor: () => (attempt === 0 ? epoch : nextRunEpoch(ctx)),
    secrets,
  });
  return { ...out, durationS: elapsed(), shotsDir };
}

/**
 * A screenshot for the session, copied into iter-shots/ as <name>: at most
 * SHOT_MAX_BYTES (the model's image limit is about 5 MB). A bigger one is
 * scaled down with macOS's sips when it can be, else skipped. Returns
 * {name} or {skipped: reason}.
 */
async function offerShot(ctx, file, iterShots, name) {
  const fs = ctx.deps.fs;
  let size;
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile()) return { skipped: `${name}: not a file` };
    size = st.size;
  } catch {
    return { skipped: `${name}: missing` };
  }
  const to = path.join(iterShots, name);
  if (size <= SHOT_MAX_BYTES) {
    return copyIfFile(fs, file, to, SHOT_MAX_BYTES) ? { name } : { skipped: `${name}: unreadable` };
  }
  const sips = ctx.deps.sipsPath ?? "/usr/bin/sips";
  if (fs.existsSync(sips)) {
    const r = await ctx.deps.run(sips, ["-Z", "1600", file, "--out", to], {
      cwd: path.dirname(file),
      env: ctx.devEnv,
      timeoutMs: 30_000,
      capture: true,
      stderrFile: ctx.stepLog ?? null,
    });
    try {
      if (r.code === 0 && fs.statSync(to).size <= SHOT_MAX_BYTES) return { name };
    } catch {
      /* not written */
    }
    rmQuiet(fs, to);
  }
  return { skipped: `${name}: larger than ${Math.round(SHOT_MAX_BYTES / 1e5) / 10} MB` };
}

/**
 * The answering attempt's own screenshots (takeScreenshot, and Maestro's
 * failure shots), found under its output dir, as plain names for
 * iter-shots/. At most 10. [{file, name}].
 */
export function maestroShots(fs, shotsDir, prefix) {
  const found = [];
  const walk = (dir, depth) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((x, y) => x.name.localeCompare(y.name))) {
      if (found.length >= 10) return;
      const p = path.join(dir, e.name);
      if (e.isDirectory() && depth > 0) walk(p, depth - 1);
      else if (e.isFile() && /\.png$/i.test(e.name)) found.push(p);
    }
  };
  if (shotsDir) walk(shotsDir, 4);
  return found.map((file, k) => {
    const base =
      path
        .basename(file, path.extname(file))
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40) || "shot";
    return { file, name: `${prefix}-${k + 1}-${base}.png` };
  });
}

// ── the request loop ────────────────────────────────────────────────────────

/** Answer every new request in requests/. Throws Interrupt (from a flow). */
export async function serveRequests(ctx, platform, loop, { dirs, deviceId, account, root }) {
  const { deps, meta } = ctx;
  const fs = deps.fs;
  let names = [];
  try {
    names = fs.readdirSync(dirs.requests);
  } catch {
    return;
  }
  const pending = names
    .map((n) => REQUEST_RE.exec(n))
    .filter(Boolean)
    .map((m) => Number(m[1]))
    .filter((n) => !loop.seen.has(n))
    .sort((a, b) => a - b);
  for (const n of pending) {
    loop.seen.add(n);
    const req = parseJson(readText(fs, path.join(dirs.requests, `${n}.json`), 4096), null);
    const rel = typeof req?.flow === "string" ? req.flow.replace(/^\.\//, "") : "";
    const name = /^flows\/[^/]+$/.test(rel) ? rel.slice("flows/".length) : "";
    let result;
    if (!DEVICE_FLOW_FILE_RE.test(name)) {
      result = { status: "REJECTED", errors: ["name a flow as flows/NN-<slug>.yaml"] };
    } else if (loop.runs >= meta.knobs.scenarioRuns) {
      loop.capHitAt ??= deps.nowMs();
      result = {
        status: "REFUSED",
        errors: [
          `this session's ${meta.knobs.scenarioRuns} runs are used up; write your summary now`,
        ],
      };
    } else {
      const tag = `req-${n}`;
      const snap = snapshotFlow(ctx, { platform, dirs, root, name, tag });
      if (!snap.ok) {
        ctx.log(`scenario: ${platform} request ${n} (${name}) rejected by the validator`);
        result = { status: "REJECTED", errors: snap.errors };
      } else {
        loop.runs += 1;
        const out = await runSnapshot(ctx, {
          platform,
          deviceId,
          account,
          snap,
          label: `scenario try ${n}: ${name}`,
          tag: `scenario-${tag}`,
        });
        // The lane's own reset failing isn't the session's run: give it back.
        if (out.resetFailed) loop.runs -= 1;
        const prefix = `${n}-${flowSlug(name)}`;
        const shots = [];
        const skipped = [];
        const offer = async (file, shotName) => {
          const r = await offerShot(ctx, file, dirs.iterShots, shotName);
          if (r.name) shots.push(r.name);
          else skipped.push(r.skipped);
        };
        const screen = path.join(snap.dir, "out", "screen.png");
        if (await screencapTo(ctx, { platform, deviceId, file: screen })) {
          await offer(screen, `${prefix}.png`);
        }
        for (const shot of maestroShots(fs, out.shotsDir, prefix))
          await offer(shot.file, shot.name);
        result = {
          status: out.status,
          failure: out.failure ?? null,
          junit: out.lines ?? [],
          screenshots: shots.map((x) => `iter-shots/${x}`),
          ...(skipped.length ? { screenshotsSkipped: skipped } : {}),
        };
      }
    }
    writeJsonAtomic(fs, path.join(dirs.requests, `${n}.result.json`), {
      request: n,
      flow: rel,
      ...result,
      runsLeft: Math.max(0, meta.knobs.scenarioRuns - loop.runs),
    });
  }
}

// ── the session ─────────────────────────────────────────────────────────────

/** The session's prompt: the instructions, then this platform's sections as data. */
export function composeScenarioInput({ promptText, platform, sections, envelope, facts }) {
  const label = platform === "ios" ? "iOS" : "Android";
  return [
    String(promptText).trimEnd(),
    "",
    `## The scenario's ${label} steps`,
    "",
    ...sections.map((s) => envelope(`### ${s.heading}\n\n${s.text}`, "scenario-section")),
    "",
    "## Run-time facts",
    "",
    "```json",
    JSON.stringify({ platform, ...facts }, null, 2),
    "```",
    "",
  ].join("\n");
}

/** The session's summary as device-output.json may hold it: scanned, capped. */
export function sanitizeSummary(text, secrets = {}) {
  let t = String(text ?? "")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ")
    .trim();
  const pw = secrets.password;
  const hits = scanLaneText(t, { devicePassword: typeof pw === "string" ? pw : "" });
  if (typeof pw === "string" && pw.length >= 4 && t.includes(pw)) hits.push("password");
  if (hits.length) return `[withheld: matched ${[...new Set(hits)].join(", ")}]`;
  if (t.length > SUMMARY_MAX) t = `${t.slice(0, SUMMARY_MAX - 1)}…`;
  return t;
}

/**
 * Run one platform's scenario session, then the final pass. Writes
 * res.scenarioState ("done" | "timeout" | "error" | "skipped:time", or "stopped" when the run
 * itself was stopped), res.scenarioSummary and the final pass's rows into
 * res.flows. Never fails phase (a); an Interrupt still stops the run.
 */
export async function runScenario(ctx, platform, { deviceId, account, root, res }) {
  const { deps, meta } = ctx;
  const sections = scenarioSectionsFor(meta.scenario?.sections, platform);
  if (!meta.knobs.scenario || sections.length === 0) return;
  res.scenarioState = "running";
  ctx.save();
  let state = "error";
  let summary = null;
  try {
    const dirs = prepareScenarioDir(ctx, platform, root);
    const session = await runSession(ctx, platform, { dirs, sections, deviceId, account, root });
    state = session.state;
    summary = session.summary;
    if (session.finalPass) {
      const rows = await finalPass(ctx, platform, {
        dirs,
        deviceId,
        account,
        root,
        startIndex: res.flows.length,
        onRow: (row) => {
          res.flows.push(row);
          ctx.save();
        },
      });
      if (rows.length) res.verdict = platformVerdict(res.flows);
    }
  } catch (err) {
    if (err instanceof Interrupt) {
      res.scenarioState = "stopped";
      ctx.save();
      throw err;
    }
    ctx.log(`scenario: ${platform}: ${err.message}`);
    state = "error";
  }
  res.scenarioState = state;
  if (summary) res.scenarioSummary = summary;
  ctx.save();
}

/**
 * Whether platform <p>, still to come in the run, will build and run: the
 * plan didn't mark it unavailable, and runPlatform's own checks (the
 * simulator, the keystore and the AVD) will pass.
 */
function willRun(ctx, p) {
  const { meta, deps } = ctx;
  if (meta.platforms?.[p]?.unavailable) return false;
  if (p === "ios") return Boolean(meta.iosSimUdid);
  return deps.fs.existsSync(meta.knobs.keystore) && avdExists(meta.knobs, deps.fs);
}

async function runSession(ctx, platform, { dirs, sections, deviceId, account, root }) {
  const { deps, meta } = ctx;
  const fs = deps.fs;
  const log = (line) => ctx.log(`scenario: ${platform}: ${line}`);
  if (!meta.bins.claude || !meta.bins.perl) {
    log("claude or perl is missing; no session");
    return { state: "error", summary: null, finalPass: false };
  }
  // The run's time left, less this platform's final pass and an hour for
  // each platform still to come (their builds, flows and sessions).
  const order = Array.isArray(meta.order) ? meta.order : [platform];
  const later = order.slice(order.indexOf(platform) + 1).filter((p) => willRun(ctx, p)).length;
  const left =
    Date.parse(meta.deadlineAt) - deps.nowMs() - FINAL_RESERVE_MS - later * PLATFORM_RESERVE_MS;
  const capMs = Math.min(meta.knobs.scenarioMin * MINUTE_MS, left);
  if (capMs < MIN_SESSION_MS) {
    log("too little of the run is left for a session (raise FACTORY_DEVICE_RUN_MAX_MIN)");
    return { state: "skipped:time", summary: null, finalPass: false };
  }
  const guard = writeGuardFiles({
    runDir: dirs.cwd,
    worktree: dirs.cwd,
    repoRoot: meta.repoRoot,
    home: deps.env.HOME,
    perlPath: meta.bins.perl,
    nodePath: meta.bins.node,
    mode: DEVICE_SCENARIO_MODE,
    filesDir: dirs.guard,
    logDir: path.join(dirs.guard, "log"),
  });
  // From meta.json (start read the factory's env); the supervisor's is scrubbed.
  const vk = meta.claude ?? readKnobs(deps.env);
  const sessionId = (deps.randomUUID ?? randomUUID)();
  const args = buildClaudeArgs({
    settingsPath: guard.settingsPath,
    sessionId,
    effort: vk.effort,
    model: vk.model,
    tools: DEVICE_SCENARIO_TOOL_LIST,
  });
  assertSafeClaudeArgs(args, { tools: DEVICE_SCENARIO_TOOL_LIST });
  const env = laneEnv(deps.env, {
    binDirs: [dirs.bin, path.dirname(meta.bins.claude), path.dirname(meta.bins.node)],
    ghConfigDir: dirs.ghEmpty,
    extra: { CLAUDE_CALL_TIMEOUT_SEC: String(Math.ceil(capMs / 1000)) },
  });
  const { envelopeBody } = await import("./factory-bundle.mjs");
  const input = composeScenarioInput({
    promptText: fs.readFileSync(meta.paths.scenarioPrompt ?? PROMPT_FILE, "utf8"),
    platform,
    sections,
    envelope: envelopeBody,
    facts: {
      runs: meta.knobs.scenarioRuns,
      minutes: Math.floor(capMs / MINUTE_MS),
      examples: dirs.exampleNames.map((n) => `examples/${n}`),
      signIn: `../${SIGN_IN_WRAPPER}`,
    },
  });

  const loop = {
    seen: new Set(),
    runs: 0,
    capHitAt: null,
  };
  let child = null;
  let finished = false;
  let result = null;
  let killed = null;
  const started = deps.nowMs();
  log(
    `session ${sessionId} starting (${Math.floor(capMs / MINUTE_MS)} min, ${meta.knobs.scenarioRuns} runs)`,
  );
  let failed = null;
  const done = Promise.resolve()
    .then(() =>
      deps.run(meta.bins.node, [RUN_CLAUDE, ...args], {
        cwd: dirs.cwd,
        env,
        input,
        group: true,
        timeoutMs: capMs + MINUTE_MS,
        stdoutFile: dirs.out,
        stderrFile: dirs.err,
        onChild: (c) => {
          child = c;
          ctx.status.session = c;
          recordGroup(ctx, "scenario-session", c?.pid, "run-claude");
        },
      }),
    )
    .then(
      (r) => {
        finished = true;
        result = r;
        return r;
      },
      (err) => {
        finished = true;
        failed = err;
        return null;
      },
    );
  const kill = (why) => {
    if (killed) return;
    killed = why;
    log(`stopping the session (${why})`);
    killGroup(deps, child);
  };
  let interrupt = null;
  try {
    while (!finished) {
      await serveRequests(ctx, platform, loop, { dirs, deviceId, account, root });
      if (finished) break;
      const why = await ctx.interruptReason();
      if (why) {
        interrupt = why;
        break;
      }
      const now = deps.nowMs();
      if (now - started >= capMs) kill("time cap");
      else if (loop.capHitAt != null && now - loop.capHitAt >= RUN_CAP_GRACE_MS) kill("run cap");
      await deps.sleep(ctx.scenarioPollMs ?? POLL_MS);
    }
  } catch (err) {
    if (!(err instanceof Interrupt)) throw err;
    interrupt = err.state;
  } finally {
    if (!finished) kill(interrupt ? `run ${interrupt}` : "supervisor");
    await done;
    ctx.status.session = null;
  }
  // The final pass needs the session's whole process group gone (ADR-0106
  // decision 8): no claude process, and no device-run wrapper, alive.
  let dead = !child?.pid || !groupAlive(deps, child.pid);
  for (let i = 0; !dead && i < 3; i++) {
    await killGroup(deps, { pid: child.pid });
    dead = !groupAlive(deps, child.pid);
  }
  if (dead && child?.pid) recordGroup(ctx, "scenario-session", null);
  if (interrupt) throw new Interrupt(interrupt);
  if (failed) throw failed;
  const timedOut = killed === "time cap" || killed === "run cap" || Boolean(result?.timedOut);
  const state = timedOut ? "timeout" : result?.code === 0 ? "done" : "error";
  const guardOk = await (deps.checkGuard ?? checkGuard)(
    { paths: { guardConfig: guard.configPath }, sessionId },
    { env: deps.env, fs },
  );
  if (!guardOk?.ok) {
    log("the guard didn't cover the session; its flows aren't run");
    return { state: "error", summary: null, finalPass: false };
  }
  if (!dead) {
    log("the session's process group is still alive; no final pass");
    return { state: "error", summary: null, finalPass: false };
  }
  log(`session ended (${state}, exit ${result?.code ?? "none"}, ${loop.runs} runs)`);
  const raw = readText(fs, dirs.out, 64 * 1024);
  const summary = raw.trim()
    ? sanitizeSummary(raw, account ? { password: account.password } : {})
    : null;
  return { state, summary, finalPass: true };
}

// ── the final pass ──────────────────────────────────────────────────────────

/**
 * Every flows/*.yaml, validated again and re-run in order on a fresh app,
 * with the supervisor's screenshots as the evidence. Only called with the
 * session's process group gone. Returns the rows it added.
 */
export async function finalPass(
  ctx,
  platform,
  { dirs, deviceId, account, root, startIndex, onRow },
) {
  const fs = ctx.deps.fs;
  const rows = [];
  let index = startIndex;
  for (const name of listFlowNames(fs, dirs.flows)) {
    // A flow the session retired: `# device-lane: skip` on its first line.
    if (isRetired(fs, path.join(dirs.flows, name))) {
      ctx.log(`scenario: ${platform}: ${name} is marked skip; not run`);
      continue;
    }
    index += 1;
    const label = `scenario: ${name}`;
    const snap = snapshotFlow(ctx, { platform, dirs, root, name, tag: `final-${name}` });
    let row;
    if (!snap.ok) {
      row = {
        name: label,
        status: "ERROR",
        durationS: 0,
        failure: sanitizeLine(`rejected by the validator: ${snap.errors[0] ?? "invalid"}`),
      };
    } else {
      const out = await runSnapshot(ctx, {
        platform,
        deviceId,
        account,
        snap,
        label,
        tag: `scenario-final-${String(index).padStart(2, "0")}`,
      });
      row = {
        name: label,
        status: out.status,
        durationS: out.durationS ?? 0,
        failure: out.failure ?? null,
      };
      await captureShot(ctx, { platform, deviceId, index, flow: `scenario-${name}` });
    }
    rows.push(row);
    onRow?.(row);
  }
  return rows;
}

export const SKIP_MARK = /^#\s*device-lane:\s*skip\s*$/;

/** Whether a flow's first line retires it: `# device-lane: skip`. */
export function isRetired(fs, file) {
  try {
    if (!fs.lstatSync(file).isFile()) return false;
    const first = fs.readFileSync(file, "utf8").split(/\r?\n/, 1)[0] ?? "";
    return SKIP_MARK.test(first.trim());
  } catch {
    return false;
  }
}

// ── the wrapper's side (bin/device-run, inside the session) ─────────────────

function formatResult(n, r) {
  const lines = [`device-run: request ${n} (${r.flow ?? "?"}): ${r.status}`];
  if (r.failure) lines.push(`failure: ${r.failure}`);
  if (Array.isArray(r.errors) && r.errors.length) {
    lines.push("errors:", ...r.errors.map((e) => `- ${e}`));
  }
  if (Array.isArray(r.junit) && r.junit.length) lines.push("junit:", ...r.junit);
  if (Array.isArray(r.screenshots) && r.screenshots.length) {
    lines.push(
      "screenshots (Read them; they are for you only):",
      ...r.screenshots.map((s) => `- ${s}`),
    );
  }
  if (Array.isArray(r.screenshotsSkipped) && r.screenshotsSkipped.length) {
    lines.push("screenshots not shown:", ...r.screenshotsSkipped.map((s) => `- ${s}`));
  }
  if (Number.isInteger(r.runsLeft)) lines.push(`runs left: ${r.runsLeft}`);
  return `${lines.join("\n")}\n`;
}

/**
 * `device-lane.mjs device-run --dir D --timeout-sec N -- <flows/x.yaml | --wait n>`:
 * drop a request, wait for its result, print it. Runs nothing itself.
 */
export async function deviceRunMain(
  argv,
  {
    fs = nodeFs,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    nowMs = Date.now,
    pollMs = POLL_MS,
  } = {},
) {
  const sep = argv.indexOf("--");
  const head = sep === -1 ? argv : argv.slice(0, sep);
  const rest = sep === -1 ? [] : argv.slice(sep + 1);
  const opt = (name) => {
    const i = head.indexOf(name);
    return i === -1 ? null : head[i + 1];
  };
  const dir = opt("--dir");
  const timeoutSec = Number(opt("--timeout-sec"));
  const usage = {
    text: "usage: device-run flows/NN-<slug>.yaml | device-run --wait <n>\n",
    exitCode: 2,
  };
  if (!dir || !path.isAbsolute(dir) || !Number.isInteger(timeoutSec) || timeoutSec <= 0)
    return usage;
  const requests = path.join(dir, "requests");
  let n;
  if (rest.length === 2 && rest[0] === "--wait" && /^[1-9][0-9]{0,3}$/.test(rest[1])) {
    n = Number(rest[1]);
    if (!fs.existsSync(path.join(requests, `${n}.json`))) {
      return { text: `device-run: there is no request ${n}\n`, exitCode: 2 };
    }
  } else if (rest.length === 1) {
    const flow = rest[0].replace(/^\.\//, "");
    if (!/^flows\/[^/]+$/.test(flow) || !DEVICE_FLOW_FILE_RE.test(flow.slice(6))) return usage;
    if (!fs.existsSync(path.join(dir, flow))) {
      return { text: `device-run: ${flow} doesn't exist; Write it first\n`, exitCode: 2 };
    }
    // The number is taken with a hard link, which fails if it exists: two
    // calls at once never share one, and the supervisor never sees a
    // half-written request.
    const tmp = path.join(requests, `.tmp-${process.pid}-${Math.floor(nowMs())}`);
    fs.writeFileSync(tmp, JSON.stringify({ flow }), { mode: 0o600 });
    try {
      for (let k = 1; k < 10_000; k++) {
        try {
          fs.linkSync(tmp, path.join(requests, `${k}.json`));
          n = k;
          break;
        } catch (err) {
          if (err.code !== "EEXIST") throw err;
        }
      }
    } finally {
      rmQuiet(fs, tmp);
    }
    if (!n) return { text: "device-run: too many requests\n", exitCode: 2 };
  } else {
    return usage;
  }
  const resultFile = path.join(requests, `${n}.result.json`);
  const waitMs = Math.min(timeoutSec, WRAPPER_WAIT_MAX_SEC) * 1000;
  const t0 = nowMs();
  while (nowMs() - t0 < waitMs) {
    const r = parseJson(readText(fs, resultFile, 256 * 1024), null);
    if (r && typeof r.status === "string") {
      return { text: formatResult(n, r), exitCode: r.status === "PASS" ? 0 : 1 };
    }
    await sleep(pollMs);
  }
  return {
    text: `device-run: request ${n} is still running; run \`device-run --wait ${n}\` to keep waiting\n`,
    exitCode: 3,
  };
}
