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
 */

import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PROTECTED = new Set(["main", "master"]);

/** Shell metacharacters that end one simple command and begin the next. */
const SEPARATORS = new Set([";", "&&", "||", "|", "&", "\n", "(", ")", "{", "}"]);

/** git subcommands whose options take a value in the FOLLOWING token. */
const GIT_GLOBAL_VALUE_OPTS = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--exec-path",
  "--namespace",
]);
const PUSH_VALUE_OPTS = new Set(["-o", "--push-option", "--repo", "--receive-pack", "--exec"]);

/**
 * Split a command string into simple commands, honouring quoting and dropping
 * heredoc bodies.
 *
 * Returns an array of segments; each segment is an array of
 * `{ text, quoted }` tokens. `quoted` marks a token that came from inside
 * quotes, so it can never be read as an operator or a command name.
 */
export function parseSegments(command) {
  const segments = [];
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

    // --- heredoc bodies: skip from the newline to the terminator line ---
    if (ch === "\n" && pendingHeredocs.length) {
      endSegment();
      i += 1;
      while (pendingHeredocs.length) {
        const { delimiter, stripTabs } = pendingHeredocs.shift();
        for (;;) {
          const nl = command.indexOf("\n", i);
          const line = command.slice(i, nl === -1 ? command.length : nl);
          const candidate = stripTabs ? line.replace(/^\t+/, "") : line;
          i = nl === -1 ? command.length : nl + 1;
          if (candidate === delimiter || nl === -1) break;
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
      i += 1;
      continue;
    }

    // --- heredoc introducer: << or <<-, but never the <<< herestring ---
    if (ch === "<" && command[i + 1] === "<" && command[i + 2] !== "<") {
      let j = i + 2;
      let stripTabs = false;
      if (command[j] === "-") {
        stripTabs = true;
        j += 1;
      }
      while (j < command.length && /\s/.test(command[j]) && command[j] !== "\n") j += 1;
      let delimiter = "";
      if (command[j] === "'" || command[j] === '"') {
        const q = command[j];
        const end = command.indexOf(q, j + 1);
        delimiter = command.slice(j + 1, end === -1 ? command.length : end);
        j = end === -1 ? command.length : end + 1;
      } else {
        while (j < command.length && /[^\s;&|<>()]/.test(command[j])) {
          if (command[j] === "\\") j += 1;
          delimiter += command[j];
          j += 1;
        }
      }
      if (delimiter) {
        pendingHeredocs.push({ delimiter, stripTabs });
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
  return segments;
}

/** Strip leading `VAR=value` assignments and an `env`/`command` prefix. */
function stripCommandPrefix(tokens) {
  let i = 0;
  for (;;) {
    const t = tokens[i];
    if (!t || t.quoted) break;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t.text)) {
      i += 1;
      continue;
    }
    if (t.text === "env" || t.text === "command" || t.text === "nohup") {
      i += 1;
      continue;
    }
    break;
  }
  return tokens.slice(i);
}

/**
 * If a segment is `git ...`, return its subcommand, its arguments, and any
 * directory the `-C` global option redirects it to.
 */
function asGitInvocation(tokens) {
  const rest = stripCommandPrefix(tokens);
  if (!rest.length || rest[0].text !== "git" || rest[0].quoted) return null;

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
  dst = dst.replace(/^refs\/heads\//, "");
  return dst;
}

/** Split `git push` arguments into its option flags and positional arguments. */
function parsePushArgs(args) {
  const positionals = [];
  let deleting = false;
  for (let i = 0; i < args.length; i += 1) {
    const t = args[i].text;
    if (t.startsWith("-") && !args[i].quoted) {
      const name = t.includes("=") ? t.slice(0, t.indexOf("=")) : t;
      if (name === "--delete" || name === "-d") {
        deleting = true;
        continue;
      }
      if (PUSH_VALUE_OPTS.has(name) && !t.includes("=")) i += 1;
      continue;
    }
    positionals.push(t);
  }
  return { remote: positionals[0] ?? null, refspecs: positionals.slice(1), deleting };
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

/**
 * Judge a command.
 *
 * `resolveBranch(dir)` is injectable so tests do not need real repositories.
 * Returns `{ blocked, reason }`.
 */
export function analyze(
  command,
  { cwd = process.cwd(), resolveBranch = currentBranch, action } = {},
) {
  const segments = parseSegments(command);
  let dir = cwd;

  for (const tokens of segments) {
    const plain = stripCommandPrefix(tokens);

    // Follow `cd` so a command is judged where it actually runs.
    if (plain[0] && !plain[0].quoted && plain[0].text === "cd" && plain[1]) {
      const target = plain[1].text.replace(/^~(?=$|\/)/, process.env.HOME ?? "~");
      // An unexpanded variable or substitution is not a path we can follow.
      // Keep judging the directory we already know rather than walking into a
      // made-up one, which would resolve to no branch at all and fail open.
      if (!/[$`]/.test(target)) {
        dir = target.startsWith("/") ? target : `${dir}/${target}`;
      }
      continue;
    }

    // `sh -c "…"` / `eval "…"` hide a command inside a string argument.
    if (plain[0] && !plain[0].quoted && ["sh", "bash", "zsh", "eval"].includes(plain[0].text)) {
      for (const arg of plain.slice(1)) {
        if (!arg.quoted && arg.text.startsWith("-")) continue;
        const inner = analyze(arg.text, { cwd: dir, resolveBranch, action });
        if (inner.blocked) return inner;
      }
      continue;
    }

    const git = asGitInvocation(tokens);
    if (!git) continue;

    const target = git.dir ? (git.dir.startsWith("/") ? git.dir : `${dir}/${git.dir}`) : dir;

    if (action === "commit" && git.subcommand === "commit") {
      const branch = resolveBranch(target);
      if (PROTECTED.has(branch)) {
        return { blocked: true, reason: `committing on ${branch} in ${target}` };
      }
    }

    if (action === "push" && git.subcommand === "push") {
      const { refspecs, deleting } = parsePushArgs(git.args);

      // With no refspec, git pushes the branch you are standing on.
      if (!refspecs.length) {
        const branch = resolveBranch(target);
        if (PROTECTED.has(branch)) {
          return { blocked: true, reason: `pushing ${branch} from ${target}` };
        }
        continue;
      }

      for (const spec of refspecs) {
        let dst = refspecDestination(spec);
        if (dst === "HEAD" || (deleting && !spec.includes(":"))) {
          // `--delete main` names the branch directly; HEAD means the current one.
          dst = dst === "HEAD" ? resolveBranch(target) : dst;
        }
        if (dst && PROTECTED.has(dst)) {
          const verb = deleting ? "deleting remote" : "pushing to";
          return { blocked: true, reason: `${verb} ${dst} from ${target}` };
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
// silent fail-open this whole change exists to remove.
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

  const { blocked, reason } = analyze(command, { action });
  if (!blocked) process.exit(0);
  console.error(
    `Blocked: ${reason}. CLAUDE.md requires the worktree/branch workflow. ` +
      `Create a branch with 'git checkout -b fix/description', or ask the user to authorise this directly.`,
  );
  process.exit(2);
}
