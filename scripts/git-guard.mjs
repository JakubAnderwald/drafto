#!/usr/bin/env node
/**
 * Decide whether a Bash command would commit to, or push to, a protected branch.
 *
 * Used by the `prevent-main-commit` / `prevent-main-push` PreToolUse hooks. The
 * hooks are thin wrappers; all the judgement lives here so it can be unit tested
 * without spawning a shell.
 *
 * Why a parser and not a regex: the thing being judged is a shell command, and
 * every interesting case is about structure, not text. `cd elsewhere && git push`
 * has to be seen, `echo "git push"` must not be, `git push origin HEAD:main`
 * targets main while `git push origin feat/x` does not, and a heredoc that
 * documents a command is not that command. A regex gets each of those wrong in a
 * different way.
 *
 * It errs toward blocking. Where the command cannot be resolved well enough to
 * answer "does this land on a protected branch", the answer is yes.
 */

import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PROTECTED = new Set(["main", "master"]);

/** A directory we could not resolve. Anything that depends on it is blocked. */
const UNKNOWN_DIR = Symbol("unknown-dir");

/** Shell metacharacters that end one simple command and begin the next. */
const SEPARATORS = new Set([";", "&&", "||", "|", "&", "\n", "(", ")", "{", "}"]);

const GIT_GLOBAL_VALUE_OPTS = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--exec-path",
  "--namespace",
]);
const PUSH_VALUE_OPTS = new Set(["-o", "--push-option", "--repo", "--receive-pack", "--exec"]);

/** `git push` modes that push every branch, not just the named refspecs. */
const BULK_PUSH_OPTS = new Set(["--all", "--mirror", "--branches"]);

const SHELL_COMMANDS = new Set(["sh", "bash", "zsh", "dash", "ksh", "eval"]);

const MAX_DEPTH = 5;

/**
 * A command word identifies a program by its basename, and quoting does not stop
 * it running: `/usr/bin/git`, `"git"` and `\git` all execute git.
 */
function commandName(token) {
  if (!token) return "";
  const text = token.text;
  const slash = text.lastIndexOf("/");
  return slash === -1 ? text : text.slice(slash + 1);
}

/**
 * Pull the command substitutions out of a string that the shell would expand.
 *
 * Applies to double-quoted strings and to unquoted heredoc bodies — bash expands
 * `$(...)` and backticks in both, so `cat <<EOF` … `$(git push origin main)` … `EOF`
 * runs the push while the surrounding command is only `cat`.
 */
export function extractSubstitutions(text) {
  const found = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "\\") {
      i += 1;
      continue;
    }
    if (text[i] === "`") {
      const end = text.indexOf("`", i + 1);
      if (end === -1) break;
      found.push(text.slice(i + 1, end));
      i = end;
      continue;
    }
    // $( … ) but not $(( … )), which is arithmetic and runs nothing.
    if (text[i] === "$" && text[i + 1] === "(" && text[i + 2] !== "(") {
      let depth = 1;
      let j = i + 2;
      while (j < text.length && depth > 0) {
        if (text[j] === "(") depth += 1;
        else if (text[j] === ")") depth -= 1;
        j += 1;
      }
      found.push(text.slice(i + 2, j - 1));
      i = j - 1;
    }
  }
  return found;
}

/**
 * Split a command string into simple commands, honouring quoting and dropping
 * heredoc bodies.
 *
 * Each segment is an array of `{ text, quoted }` tokens. Commands hidden inside
 * expandable strings and heredocs are parsed too and appended as further
 * segments, because the shell will run them.
 */
export function parseSegments(command, depth = 0) {
  const segments = [];
  const expandable = [];
  let segment = [];
  let token = null;
  const pendingHeredocs = [];

  const endToken = () => {
    if (token !== null) {
      segment.push(token);
      token = null;
    }
  };
  const endSegment = () => {
    endToken();
    if (segment.length) segments.push(segment);
    segment = [];
  };
  const push = (ch, quoted) => {
    if (token === null) token = { text: "", quoted: false };
    token.text += ch;
    if (quoted) token.quoted = true;
  };

  let i = 0;
  let afterRedirect = false;

  while (i < command.length) {
    const ch = command[i];

    if (ch === "\n" && pendingHeredocs.length) {
      endSegment();
      i += 1;
      while (pendingHeredocs.length) {
        const { delimiter, stripTabs, expands } = pendingHeredocs.shift();
        const bodyStart = i;
        for (;;) {
          const nl = command.indexOf("\n", i);
          const line = command.slice(i, nl === -1 ? command.length : nl);
          const candidate = stripTabs ? line.replace(/^\t+/, "") : line;
          if (candidate === delimiter) {
            if (expands) expandable.push(command.slice(bodyStart, i));
            i = nl === -1 ? command.length : nl + 1;
            break;
          }
          if (nl === -1) {
            if (expands) expandable.push(command.slice(bodyStart));
            i = command.length;
            break;
          }
          i = nl + 1;
        }
      }
      continue;
    }

    if (ch === "\\") {
      if (i + 1 < command.length) {
        push(command[i + 1], true);
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }

    if (ch === "'") {
      const end = command.indexOf("'", i + 1);
      const body = command.slice(i + 1, end === -1 ? command.length : end);
      if (token === null) token = { text: "", quoted: true };
      token.text += body;
      token.quoted = true;
      i = end === -1 ? command.length : end + 1;
      continue;
    }

    if (ch === '"') {
      i += 1;
      const start = i;
      if (token === null) token = { text: "", quoted: true };
      token.quoted = true;
      while (i < command.length && command[i] !== '"') {
        if (command[i] === "\\" && i + 1 < command.length) {
          token.text += command[i + 1];
          i += 2;
        } else {
          token.text += command[i];
          i += 1;
        }
      }
      // The shell expands what is inside double quotes.
      expandable.push(command.slice(start, i));
      i += 1;
      continue;
    }

    // Unquoted command substitutions. `$( … )` happens to split on the paren
    // separator anyway, but backticks do not, so handle both explicitly rather
    // than relying on that accident.
    if (ch === "`") {
      const end = command.indexOf("`", i + 1);
      if (end !== -1) {
        expandable.push(command.slice(i, end + 1));
        endToken();
        i = end + 1;
        continue;
      }
    }
    if (ch === "$" && command[i + 1] === "(" && command[i + 2] !== "(") {
      let depth = 1;
      let j = i + 2;
      while (j < command.length && depth > 0) {
        if (command[j] === "(") depth += 1;
        else if (command[j] === ")") depth -= 1;
        j += 1;
      }
      expandable.push(command.slice(i, j));
      endToken();
      i = j;
      continue;
    }

    // Heredoc introducer: << or <<-, but never the <<< herestring.
    if (ch === "<" && command[i + 1] === "<" && command[i + 2] !== "<") {
      let j = i + 2;
      let stripTabs = false;
      if (command[j] === "-") {
        stripTabs = true;
        j += 1;
      }
      while (j < command.length && /\s/.test(command[j]) && command[j] !== "\n") j += 1;
      let delimiter = "";
      // Any quoting of the delimiter turns expansion off for the whole body.
      let expands = true;
      if (command[j] === "'" || command[j] === '"') {
        const q = command[j];
        const end = command.indexOf(q, j + 1);
        delimiter = command.slice(j + 1, end === -1 ? command.length : end);
        expands = false;
        j = end === -1 ? command.length : end + 1;
      } else {
        while (j < command.length && /[^\s;&|<>()]/.test(command[j])) {
          if (command[j] === "\\") {
            expands = false;
            j += 1;
          }
          delimiter += command[j];
          j += 1;
        }
      }
      if (delimiter) {
        pendingHeredocs.push({ delimiter, stripTabs, expands });
        endToken();
        i = j;
        continue;
      }
    }

    if (ch === ">" || ch === "<") {
      endToken();
      afterRedirect = true;
      i += 1;
      continue;
    }

    // `2>&1` — the & belongs to the redirect, it is not a separator.
    if (ch === "&" && afterRedirect) {
      i += 1;
      continue;
    }

    const two = command.slice(i, i + 2);
    if (two === "&&" || two === "||") {
      endSegment();
      i += 2;
      afterRedirect = false;
      continue;
    }

    if (SEPARATORS.has(ch)) {
      endSegment();
      i += 1;
      afterRedirect = false;
      continue;
    }

    if (/\s/.test(ch)) {
      endToken();
      i += 1;
      continue;
    }

    push(ch, false);
    afterRedirect = false;
    i += 1;
  }

  endSegment();

  if (depth < MAX_DEPTH) {
    for (const text of expandable) {
      for (const inner of extractSubstitutions(text)) {
        segments.push(...parseSegments(inner, depth + 1));
      }
    }
  }

  return segments;
}

/** Strip leading `VAR=value` assignments and an `env`/`command` prefix. */
function stripCommandPrefix(tokens) {
  let i = 0;
  for (;;) {
    const t = tokens[i];
    if (!t) break;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t.text)) {
      i += 1;
      continue;
    }
    const name = commandName(t);
    if (name === "env" || name === "command" || name === "nohup") {
      i += 1;
      continue;
    }
    break;
  }
  return tokens.slice(i);
}

/**
 * If a segment invokes git, return its subcommand, its arguments, and any
 * directory the `-C` global option redirects it to.
 */
function asGitInvocation(tokens) {
  const rest = stripCommandPrefix(tokens);
  if (!rest.length || commandName(rest[0]) !== "git") return null;

  let i = 1;
  let dir = null;
  while (i < rest.length) {
    const t = rest[i].text;
    if (!t.startsWith("-")) break;
    const [name, inlineValue] = t.includes("=")
      ? [t.slice(0, t.indexOf("=")), t.slice(t.indexOf("=") + 1)]
      : [t, null];
    if (name === "-C") {
      dir = inlineValue ?? rest[i + 1]?.text ?? null;
      i += inlineValue === null ? 2 : 1;
      continue;
    }
    if (GIT_GLOBAL_VALUE_OPTS.has(name) && inlineValue === null) {
      i += 2;
      continue;
    }
    i += 1;
  }
  if (i >= rest.length) return null;
  return { subcommand: rest[i].text, args: rest.slice(i + 1), dir };
}

/** The branch a `git push` refspec would land on, or null if it names no branch. */
function refspecDestination(refspec) {
  let spec = refspec;
  if (spec.startsWith("+")) spec = spec.slice(1);
  const colon = spec.indexOf(":");
  let dst = colon === -1 ? spec : spec.slice(colon + 1);
  if (!dst) return null;
  return dst.replace(/^refs\/heads\//, "");
}

/** Split `git push` arguments into its flags and positional arguments. */
function parsePushArgs(args) {
  const positionals = [];
  let deleting = false;
  let bulk = false;
  for (let i = 0; i < args.length; i += 1) {
    const t = args[i].text;
    if (t.startsWith("-")) {
      const name = t.includes("=") ? t.slice(0, t.indexOf("=")) : t;
      if (name === "--delete" || name === "-d") {
        deleting = true;
        continue;
      }
      if (BULK_PUSH_OPTS.has(name)) {
        bulk = true;
        continue;
      }
      if (PUSH_VALUE_OPTS.has(name) && !t.includes("=")) i += 1;
      continue;
    }
    positionals.push(t);
  }
  return { remote: positionals[0] ?? null, refspecs: positionals.slice(1), deleting, bulk };
}

/**
 * Resolve the directory a `cd` moves to.
 *
 * Returns UNKNOWN_DIR for anything we cannot follow: `cd -`, a target carrying an
 * unexpanded variable or substitution, a missing operand, or extra operands.
 * Guessing would resolve to no branch at all and let the command through.
 */
function resolveCd(tokens, dir) {
  const operands = tokens.slice(1).filter((t) => !/^-[LPe@]+$/.test(t.text));
  if (operands.length !== 1) return UNKNOWN_DIR;
  const target = operands[0].text.replace(/^~(?=$|\/)/, process.env.HOME ?? "~");
  if (target === "-" || /[$`]/.test(target)) return UNKNOWN_DIR;
  if (dir === UNKNOWN_DIR) return target.startsWith("/") ? target : UNKNOWN_DIR;
  return target.startsWith("/") ? target : `${dir}/${target}`;
}

function currentBranch(dir) {
  try {
    return execFileSync("git", ["branch", "--show-current"], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function localBranches(dir) {
  try {
    return execFileSync("git", ["branch", "--format=%(refname:short)"], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split("\n")
      .map((b) => b.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Judge a command. `resolveBranch` / `listBranches` are injectable so tests do
 * not need real repositories. Returns `{ blocked, reason }`.
 */
export function analyze(
  command,
  { cwd = process.cwd(), resolveBranch = currentBranch, listBranches = localBranches, action } = {},
) {
  const segments = parseSegments(command);
  let dir = cwd;

  const where = (d) => (d === UNKNOWN_DIR ? "an unresolved directory" : d);
  const branchOf = (d) => (d === UNKNOWN_DIR ? UNKNOWN_DIR : resolveBranch(d));

  for (const tokens of segments) {
    const plain = stripCommandPrefix(tokens);

    if (plain.length && commandName(plain[0]) === "cd") {
      dir = resolveCd(plain, dir);
      continue;
    }

    // `sh -c "…"` / `eval "…"` hide a command inside a string argument. The
    // string itself is already parsed as an expandable, but an unquoted one is
    // not, so analyse the argument directly too.
    if (plain.length && SHELL_COMMANDS.has(commandName(plain[0]))) {
      for (const arg of plain.slice(1)) {
        if (arg.text.startsWith("-")) continue;
        const inner = analyze(arg.text, { cwd: dir, resolveBranch, listBranches, action });
        if (inner.blocked) return inner;
      }
      continue;
    }

    const git = asGitInvocation(tokens);
    if (!git) continue;

    let target = dir;
    if (git.dir) {
      if (/[$`]/.test(git.dir)) target = UNKNOWN_DIR;
      else if (git.dir.startsWith("/")) target = git.dir;
      else target = dir === UNKNOWN_DIR ? UNKNOWN_DIR : `${dir}/${git.dir}`;
    }

    if (action === "commit" && git.subcommand === "commit") {
      const branch = branchOf(target);
      if (branch === UNKNOWN_DIR) {
        return {
          blocked: true,
          reason: `committing in ${where(target)}, so the branch cannot be checked`,
        };
      }
      if (PROTECTED.has(branch)) {
        return { blocked: true, reason: `committing on ${branch} in ${target}` };
      }
    }

    if (action === "push" && git.subcommand === "push") {
      const { refspecs, deleting, bulk } = parsePushArgs(git.args);

      // --all / --mirror push every local branch, whichever one you are on.
      if (bulk) {
        if (target === UNKNOWN_DIR) {
          return { blocked: true, reason: `pushing all branches from ${where(target)}` };
        }
        const protectedLocal = listBranches(target).filter((b) => PROTECTED.has(b));
        if (protectedLocal.length) {
          return {
            blocked: true,
            reason: `pushing all branches from ${target}, which includes ${protectedLocal.join(", ")}`,
          };
        }
        continue;
      }

      // With no refspec, git pushes the branch you are standing on.
      if (!refspecs.length) {
        const branch = branchOf(target);
        if (branch === UNKNOWN_DIR) {
          return {
            blocked: true,
            reason: `pushing from ${where(target)}, so the branch cannot be checked`,
          };
        }
        if (PROTECTED.has(branch)) {
          return { blocked: true, reason: `pushing ${branch} from ${target}` };
        }
        continue;
      }

      for (const spec of refspecs) {
        let dst = refspecDestination(spec);
        if (dst === "HEAD") {
          const branch = branchOf(target);
          if (branch === UNKNOWN_DIR) {
            return {
              blocked: true,
              reason: `pushing HEAD from ${where(target)}, so the branch cannot be checked`,
            };
          }
          dst = branch;
        }
        if (dst && PROTECTED.has(dst)) {
          const verb = deleting ? "deleting remote" : "pushing to";
          return { blocked: true, reason: `${verb} ${dst} from ${where(target)}` };
        }
      }
    }
  }

  return { blocked: false, reason: "" };
}

// --- CLI: reads the hook payload on stdin, exits 2 to block. ---
//
// Compare real paths, not the raw strings. On macOS a temp dir is handed out as
// /var/... while import.meta.url resolves to /private/var/..., and any symlinked
// checkout does the same — a string compare then quietly decides this is not the
// main module, the CLI never runs, and the hook exits 0. That is the exact
// silent fail-open this guard exists to remove.
const invokedDirectly = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  const action = process.argv[2];
  if (action !== "commit" && action !== "push") {
    console.error("usage: git-guard.mjs <commit|push>   (hook payload on stdin)");
    process.exit(1);
  }
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  let command = "";
  try {
    command = JSON.parse(Buffer.concat(chunks).toString("utf8"))?.tool_input?.command ?? "";
  } catch {
    process.exit(0); // not a payload we understand — never block on a parse failure
  }
  if (!command) process.exit(0);

  let result;
  try {
    result = analyze(command, { action });
  } catch (err) {
    // A guard that crashes must not wave the command through.
    console.error(`Blocked: the ${action} guard failed to evaluate this command (${err.message}).`);
    process.exit(2);
  }
  if (!result.blocked) process.exit(0);
  console.error(
    `Blocked: ${result.reason}. CLAUDE.md requires the worktree/branch workflow. ` +
      `Create a branch with 'git checkout -b fix/description', or ask the user to authorise this directly.`,
  );
  process.exit(2);
}
