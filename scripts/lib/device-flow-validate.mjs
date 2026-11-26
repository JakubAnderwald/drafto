// The device lane's validator for Maestro YAML a scenario session wrote
// (ADR-0106 decision 2). Pure: no IO.
//
// A guarded claude session translates a scenario's iOS / Android steps into
// Maestro flows in its own run directory. It can't run Maestro: the device
// supervisor runs a flow only after validateFlow passes it, and again, in a
// final pass, after the session is dead. The validator is an allowlist:
//
//   - the header is a mapping with exactly `appId: eu.drafto.mobile`, and
//     optionally `name` and `tags`; no `env`, no `onFlowStart` /
//     `onFlowComplete` hooks;
//   - only the commands in COMMANDS, each with only the keys it lists, for this
//     app; `runFlow` only to a file in <runFlowAllow> (the run's own flows and
//     the supervisor-copied sign-in helper), and a `when` condition only on
//     `platform` / `visible` / `notVisible`, never `true:` (JavaScript);
//   - no `${…}` but exactly `${RUN_ID}`: no JavaScript, and no credential
//     variable, so a session's flow can never type the account's password
//     (into a note, say, that a screenshot would then show);
//   - no YAML anchors, aliases or explicit tags, and no duplicate keys, so
//     Maestro's parser can't read the file differently from this one;
//   - at most MAX_FLOW_BYTES and MAX_COMMANDS commands, nested ones included.
//
// The vetted sign-in helper is reviewed in the repo, not validated here: it
// is the one YAML that reads the credential variables.

import path from "node:path";
import { isAlias, isMap, isScalar, isSeq, parseAllDocuments, visit } from "yaml";

export const APP_ID = "eu.drafto.mobile";
export const MAX_FLOW_BYTES = 20 * 1024;
export const MAX_COMMANDS = 200;
export const MAX_REPEAT_TIMES = 10;
export const MAX_RETRIES = 3;
export const MAX_TIMEOUT_MS = 120_000;
export const SCREENSHOT_NAME_RE = /^[a-z0-9-]{1,40}$/;
const TAG_RE = /^[A-Za-z0-9._-]{1,40}$/;
const MAX_ERRORS = 20;

// Named so a session learns why, not just "unknown".
export const DENIED_COMMANDS = Object.freeze({
  runScript: "runs JavaScript",
  evalScript: "runs JavaScript",
  clearKeychain: "is only for the vetted sign-in helper (use launchApp's clearKeychain: true)",
  addMedia: "adds files to the device",
  startRecording: "records the screen",
  stopRecording: "records the screen",
  travel: "moves the device's location",
  setLocation: "moves the device's location",
  clearState: "is only for the vetted sign-in helper (use launchApp's clearState: true)",
});

const DIRECTIONS = ["UP", "DOWN", "LEFT", "RIGHT"];
const KEYS = ["Enter", "Backspace", "Back", "Home", "Tab", "Escape", "Volume Up", "Volume Down"];

// Keys a selector mapping may carry; a relative one takes a selector itself.
const SELECTOR_SCALARS = {
  text: "string",
  id: "string",
  index: "index",
  point: "string",
  enabled: "boolean",
  checked: "boolean",
  focused: "boolean",
  selected: "boolean",
  width: "number",
  height: "number",
  tolerance: "number",
  traits: "string",
  label: "string",
  optional: "boolean",
};
const RELATIVE_SELECTORS = ["below", "above", "leftOf", "rightOf", "containsChild", "childOf"];
const TAP_EXTRA = {
  retryTapIfNoChange: "boolean",
  waitToSettleTimeoutMs: "timeout",
  repeat: "small",
  delay: "timeout",
};

function typeOf(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function isPlainObject(v) {
  return typeOf(v) === "object";
}

/** Every `${…}` in <s> must be exactly `${RUN_ID}`. Returns an error or null. */
export function variableProblem(s) {
  const text = String(s);
  if (!text.includes("${")) return null;
  const rest = text.split("${RUN_ID}").join("");
  if (rest.includes("${")) {
    return "only ${RUN_ID} may be used: no other variable and no JavaScript expression";
  }
  return null;
}

class Checker {
  constructor({ platform, runFlowAllow }) {
    this.platform = platform;
    this.allow = new Set((runFlowAllow ?? []).map((f) => normaliseRef(f)).filter(Boolean));
    this.errors = [];
    this.commands = 0;
    this.refs = [];
  }

  error(where, message) {
    if (this.errors.length < MAX_ERRORS) this.errors.push(`${where}: ${message}`);
  }

  scalar(where, v, kind) {
    const t = typeOf(v);
    switch (kind) {
      case "string":
        if (t !== "string") this.error(where, "must be a string");
        return undefined;
      case "boolean":
        if (t !== "boolean") this.error(where, "must be true or false");
        return undefined;
      case "number":
        if (t !== "number" || !Number.isFinite(v) || v < 0 || v > 10_000)
          this.error(where, "must be a number from 0 to 10000");
        return undefined;
      case "index":
        if (!Number.isInteger(v) || v < 0 || v > 1000)
          this.error(where, "must be a whole number from 0 to 1000");
        return undefined;
      case "timeout":
        if (!Number.isInteger(v) || v < 0 || v > MAX_TIMEOUT_MS)
          this.error(where, `must be a whole number of milliseconds up to ${MAX_TIMEOUT_MS}`);
        return undefined;
      case "small":
        if (!Number.isInteger(v) || v < 1 || v > 10)
          this.error(where, "must be a whole number from 1 to 10");
        return undefined;
      case "percent":
        if (!Number.isInteger(v) || v < 0 || v > 100)
          this.error(where, "must be a whole number from 0 to 100");
        return undefined;
      default:
        return this.error(where, `has an unchecked kind ${kind}`);
    }
  }

  // Variables are checked once, over every string of the file (checkStrings).
  text(where, s) {
    const why = variableProblem(s);
    if (why) this.error(where, why);
  }

  /** A mapping whose keys must all be in <spec> ({key: kind | fn}). */
  mapping(where, v, spec, { required = [] } = {}) {
    if (!isPlainObject(v)) return this.error(where, "must be a mapping");
    for (const key of required) {
      if (!Object.hasOwn(v, key)) this.error(where, `needs \`${key}\``);
    }
    for (const [key, value] of Object.entries(v)) {
      const kind = Object.hasOwn(spec, key) ? spec[key] : null;
      if (kind == null) {
        this.error(where, `\`${key}\` isn't allowed here`);
        continue;
      }
      if (typeof kind === "function") kind.call(this, `${where}.${key}`, value);
      else this.scalar(`${where}.${key}`, value, kind);
    }
    return undefined;
  }

  selector(where, v) {
    if (typeof v === "string") return undefined;
    const spec = { ...SELECTOR_SCALARS };
    for (const rel of RELATIVE_SELECTORS) spec[rel] = this.selector;
    spec.containsDescendants = (w, list) => {
      if (!Array.isArray(list) || list.length === 0 || list.length > 10)
        return this.error(w, "must be a list of 1 to 10 selectors");
      list.forEach((s, i) => this.selector(`${w}[${i}]`, s));
      return undefined;
    };
    return this.mapping(where, v, spec);
  }

  tapTarget(where, v) {
    if (typeof v === "string") return undefined;
    const spec = { ...SELECTOR_SCALARS, ...TAP_EXTRA };
    for (const rel of RELATIVE_SELECTORS) spec[rel] = this.selector;
    return this.mapping(where, v, spec);
  }

  appOnly(where, v) {
    if (v === null) return undefined;
    if (typeof v === "string") {
      if (v !== APP_ID) this.error(where, `may only name ${APP_ID}`);
      return undefined;
    }
    return this.mapping(where, v, { appId: this.appIdValue });
  }

  appIdValue(where, v) {
    if (v !== APP_ID) this.error(where, `must be ${APP_ID}`);
  }

  condition(where, v) {
    if (!isPlainObject(v)) return this.error(where, "must be a mapping");
    if (Object.hasOwn(v, "true")) {
      return this.error(where, "`true:` conditions are JavaScript and aren't allowed");
    }
    return this.mapping(where, v, {
      platform: (w, p) => {
        if (p !== "iOS" && p !== "Android") this.error(w, "must be iOS or Android");
      },
      visible: this.selector,
      notVisible: this.selector,
    });
  }

  commandList(where, list, depth) {
    if (!Array.isArray(list)) return this.error(where, "must be a list of commands");
    if (depth > 6) return this.error(where, "nests too deeply");
    list.forEach((item, i) => this.command(`${where}[${i}]`, item, depth));
    return undefined;
  }

  runFlowRef(where, file) {
    if (typeof file !== "string" || file === "") return this.error(where, "must be a file name");
    const ref = normaliseRef(file);
    if (!ref || !this.allow.has(ref)) {
      return this.error(
        where,
        `${JSON.stringify(file)} isn't one of the files runFlow may use (this run's flows/ files and ../helpers/sign-in.yaml)`,
      );
    }
    this.refs.push(ref);
    return undefined;
  }

  command(where, item, depth) {
    this.commands += 1;
    if (this.commands === MAX_COMMANDS + 1) {
      this.error(where, `the flow has more than ${MAX_COMMANDS} commands`);
    }
    let name;
    let arg;
    if (typeof item === "string") {
      name = item;
      arg = null;
    } else if (isPlainObject(item) && Object.keys(item).length === 1) {
      [[name, arg]] = Object.entries(item);
    } else {
      return this.error(where, "each command is a name or a one-key mapping");
    }
    const at = `${where} ${name}`;
    if (Object.hasOwn(DENIED_COMMANDS, name)) {
      return this.error(at, `isn't allowed: it ${DENIED_COMMANDS[name]}`);
    }
    const handler = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : null;
    if (!handler) return this.error(at, "isn't an allowed command");
    return handler.call(this, at, arg, depth);
  }
}

const COMMON = { label: "string", optional: "boolean" };

// name → (where, arg, depth). `this` is the Checker.
const COMMANDS = {
  launchApp(w, a) {
    if (a === null) return undefined;
    if (typeof a === "string") return this.appOnly(w, a);
    return this.mapping(w, a, {
      ...COMMON,
      appId: this.appIdValue,
      clearState: "boolean",
      clearKeychain: "boolean",
      stopApp: "boolean",
    });
  },
  stopApp(w, a) {
    return this.appOnly(w, a);
  },
  killApp(w, a) {
    return this.appOnly(w, a);
  },
  tapOn(w, a) {
    return this.tapTarget(w, a);
  },
  doubleTapOn(w, a) {
    return this.tapTarget(w, a);
  },
  longPressOn(w, a) {
    return this.tapTarget(w, a);
  },
  inputText(w, a) {
    if (typeof a !== "string") this.error(w, "must be a plain string");
    return undefined;
  },
  inputRandomText(w, a) {
    if (a === null) return undefined;
    return this.mapping(w, a, { ...COMMON, length: "small" });
  },
  eraseText(w, a) {
    if (a === null) return undefined;
    if (typeof a === "number") {
      if (!Number.isInteger(a) || a < 1 || a > 1000) this.error(w, "must erase 1 to 1000");
      return undefined;
    }
    return this.mapping(w, a, { ...COMMON, charactersToErase: "index" });
  },
  assertVisible(w, a) {
    return this.selector(w, a);
  },
  assertNotVisible(w, a) {
    return this.selector(w, a);
  },
  extendedWaitUntil(w, a) {
    if (!isPlainObject(a)) return this.error(w, "must be a mapping");
    if (!Object.hasOwn(a, "visible") && !Object.hasOwn(a, "notVisible")) {
      this.error(w, "needs `visible` or `notVisible`");
    }
    return this.mapping(w, a, {
      ...COMMON,
      visible: this.selector,
      notVisible: this.selector,
      timeout: "timeout",
    });
  },
  waitForAnimationToEnd(w, a) {
    if (a === null) return undefined;
    return this.mapping(w, a, { ...COMMON, timeout: "timeout" });
  },
  scroll(w, a) {
    if (a === null) return undefined;
    return this.mapping(w, a, COMMON);
  },
  scrollUntilVisible(w, a) {
    return this.mapping(
      w,
      a,
      {
        ...COMMON,
        element: this.selector,
        direction: (x, d) => {
          if (!DIRECTIONS.includes(d)) this.error(x, `must be one of ${DIRECTIONS.join(", ")}`);
        },
        timeout: "timeout",
        speed: "percent",
        visibilityPercentage: "percent",
        centerElement: "boolean",
      },
      { required: ["element"] },
    );
  },
  swipe(w, a) {
    return this.mapping(w, a, {
      ...COMMON,
      direction: (x, d) => {
        if (!DIRECTIONS.includes(d)) this.error(x, `must be one of ${DIRECTIONS.join(", ")}`);
      },
      start: "string",
      end: "string",
      duration: "timeout",
      from: this.selector,
    });
  },
  back(w, a) {
    if (a !== null) this.error(w, "takes no argument");
  },
  hideKeyboard(w, a) {
    if (a !== null) this.error(w, "takes no argument");
  },
  pasteText(w, a) {
    if (a !== null) this.error(w, "takes no argument");
  },
  pressKey(w, a) {
    if (!KEYS.includes(a)) this.error(w, `must be one of ${KEYS.join(", ")}`);
  },
  copyTextFrom(w, a) {
    return this.selector(w, a);
  },
  setAirplaneMode(w, a) {
    if (this.platform === "ios") return this.error(w, "isn't supported on the iOS simulator");
    if (a !== "enabled" && a !== "disabled") this.error(w, "must be enabled or disabled");
    return undefined;
  },
  toggleAirplaneMode(w, a) {
    if (this.platform === "ios") return this.error(w, "isn't supported on the iOS simulator");
    if (a !== null) this.error(w, "takes no argument");
    return undefined;
  },
  takeScreenshot(w, a) {
    if (typeof a !== "string" || !SCREENSHOT_NAME_RE.test(a)) {
      this.error(w, "needs a name of 1 to 40 lowercase letters, digits and dashes");
    }
  },
  openLink(w, a) {
    const link = isPlainObject(a) ? a.link : a;
    if (isPlainObject(a)) this.mapping(w, a, { ...COMMON, link: "string" });
    if (typeof link !== "string" || !/^drafto:\/\/[^\s]*$/.test(link)) {
      this.error(w, "may only open drafto:// links");
    }
  },
  repeat(w, a, depth) {
    if (!isPlainObject(a)) return this.error(w, "must be a mapping");
    if (!Number.isInteger(a.times) || a.times < 1 || a.times > MAX_REPEAT_TIMES) {
      this.error(w, `needs \`times\` from 1 to ${MAX_REPEAT_TIMES}`);
    }
    return this.mapping(
      w,
      a,
      {
        ...COMMON,
        times: () => {},
        while: this.condition,
        commands: (x, list) => this.commandList(x, list, depth + 1),
      },
      { required: ["commands"] },
    );
  },
  retry(w, a, depth) {
    if (!isPlainObject(a)) return this.error(w, "must be a mapping");
    if (
      Object.hasOwn(a, "maxRetries") &&
      (!Number.isInteger(a.maxRetries) || a.maxRetries < 0 || a.maxRetries > MAX_RETRIES)
    ) {
      this.error(w, `\`maxRetries\` must be 0 to ${MAX_RETRIES}`);
    }
    return this.mapping(
      w,
      a,
      {
        ...COMMON,
        maxRetries: () => {},
        commands: (x, list) => this.commandList(x, list, depth + 1),
      },
      { required: ["commands"] },
    );
  },
  runFlow(w, a, depth) {
    if (typeof a === "string") return this.runFlowRef(w, a);
    if (!isPlainObject(a)) return this.error(w, "must be a file name or a mapping");
    const hasFile = Object.hasOwn(a, "file");
    const hasCommands = Object.hasOwn(a, "commands");
    if (hasFile === hasCommands) this.error(w, "needs exactly one of `file` and `commands`");
    return this.mapping(w, a, {
      ...COMMON,
      file: this.runFlowRef,
      when: this.condition,
      commands: (x, list) => this.commandList(x, list, depth + 1),
    });
  },
};

/** A runFlow target as a normalised relative POSIX path, or null when it can't be one. */
export function normaliseRef(file) {
  const s = String(file ?? "");
  if (!s || s.includes("\\") || s.includes("\u0000") || path.posix.isAbsolute(s)) return null;
  const n = path.posix.normalize(s);
  return n === "." ? null : n;
}

function yamlShapeProblems(doc) {
  const out = [];
  for (const e of doc.errors) out.push(`YAML error: ${e.code ?? e.message}`);
  for (const e of doc.warnings) out.push(`YAML warning: ${e.code ?? e.message}`);
  visit(doc, {
    Node(_key, node) {
      if (isAlias(node)) out.push("YAML aliases aren't allowed");
      else if (node.anchor) out.push("YAML anchors aren't allowed");
      if ((isScalar(node) || isMap(node) || isSeq(node)) && node.tag) {
        out.push("explicit YAML tags aren't allowed");
      }
      return undefined;
    },
  });
  return out;
}

/** Every string in <v> (keys too) checked for variables. */
function checkStrings(checker, where, v) {
  if (typeof v === "string") return checker.text(where, v);
  if (Array.isArray(v)) return v.forEach((x, i) => checkStrings(checker, `${where}[${i}]`, x));
  if (isPlainObject(v)) {
    for (const [k, x] of Object.entries(v)) {
      checker.text(`${where} key`, k);
      checkStrings(checker, `${where}.${k}`, x);
    }
  }
  return undefined;
}

/**
 * Validate one Maestro flow a scenario session wrote.
 *
 * @param {string} text the file's content
 * @param {object} opts
 * @param {"android"|"ios"} opts.platform
 * @param {string[]} [opts.runFlowAllow] runFlow targets this flow may use,
 *   relative to the flow's own directory
 * @returns {{ok: boolean, errors: string[], runFlows: string[], commands: number}}
 *   runFlows: the normalised runFlow targets it uses (the caller validates
 *   the ones that are flows of the run too)
 */
export function validateFlow(text, { platform, runFlowAllow = [] } = {}) {
  const fail = (errors) => ({ ok: false, errors, runFlows: [], commands: 0 });
  if (typeof text !== "string") return fail(["the flow isn't text"]);
  if (Buffer.byteLength(text, "utf8") > MAX_FLOW_BYTES) {
    return fail([`the flow is larger than ${MAX_FLOW_BYTES / 1024} KB`]);
  }
  if (platform !== "android" && platform !== "ios") return fail(["unknown platform"]);
  let docs;
  try {
    docs = parseAllDocuments(text, { uniqueKeys: true, merge: false, prettyErrors: false });
  } catch (err) {
    return fail([`YAML can't be read: ${err.message}`]);
  }
  if (!Array.isArray(docs) || docs.length !== 2) {
    return fail([
      "a flow is a header (appId: eu.drafto.mobile), a `---` line, then a list of commands",
    ]);
  }
  const shape = docs.flatMap(yamlShapeProblems);
  if (shape.length) return fail([...new Set(shape)].slice(0, MAX_ERRORS));
  let header;
  let body;
  try {
    header = docs[0].toJS({ maxAliasCount: 0 });
    body = docs[1].toJS({ maxAliasCount: 0 });
  } catch (err) {
    return fail([`YAML can't be read: ${err.message}`]);
  }
  const c = new Checker({ platform, runFlowAllow });
  checkStrings(c, "header", header);
  if (!isPlainObject(header)) {
    c.error("header", "must be a mapping");
  } else {
    if (header.appId !== APP_ID) c.error("header", `needs exactly \`appId: ${APP_ID}\``);
    for (const key of Object.keys(header)) {
      if (key === "appId") continue;
      if (key === "name") {
        if (typeof header.name !== "string" || header.name.length > 120)
          c.error("header.name", "must be a short string");
      } else if (key === "tags") {
        if (
          !Array.isArray(header.tags) ||
          header.tags.length > 10 ||
          !header.tags.every((t) => typeof t === "string" && TAG_RE.test(t))
        ) {
          c.error("header.tags", "must be a short list of plain tags");
        }
      } else {
        c.error("header", `\`${key}\` isn't allowed in the header (only appId, name and tags)`);
      }
    }
  }
  checkStrings(c, "commands", body);
  if (!Array.isArray(body) || body.length === 0) c.error("commands", "must be a list of commands");
  else c.commandList("commands", body, 0);
  return {
    ok: c.errors.length === 0,
    errors: c.errors,
    runFlows: [...new Set(c.refs)],
    commands: c.commands,
  };
}
