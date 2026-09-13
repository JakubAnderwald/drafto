import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  cpSync,
  readFileSync,
  renameSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { analyze, parseSegments } from "../git-guard.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const HOOKS = join(REPO_ROOT, ".claude", "hooks");
const SETTINGS = join(REPO_ROOT, ".claude", "settings.json");

const ON_MAIN = "/repo-on-main";
const ON_BRANCH = "/feature-repo";
const ON_BRANCH_SOLO = "/feature-only-repo";

// Hermetic branch resolution. A path that is not one of these is not a repo, so
// it has no branch — the same "" a real `git branch --show-current` returns.
// Do NOT collapse this into "anything unknown is main": that is what hid two of
// the fail-open cases below when they were first checked.
const BRANCHES = { [ON_MAIN]: "main", [ON_BRANCH]: "feat/x", [ON_BRANCH_SOLO]: "feat/x" };
const LOCAL = {
  [ON_MAIN]: ["main", "feat/x"],
  [ON_BRANCH]: ["main", "feat/x"],
  [ON_BRANCH_SOLO]: ["feat/x"],
};
const resolveBranch = (dir) => BRANCHES[dir] ?? "";
const listBranches = (dir) => LOCAL[dir] ?? [];

const verdict = (action, command, cwd = ON_MAIN) =>
  analyze(command, { cwd, resolveBranch, listBranches, action }).blocked;

/** Declare a table of [shouldBlock, command, cwd?] cases. */
function table(action, cases) {
  for (const [want, command, cwd] of cases) {
    test(`${want ? "blocks" : "allows"}: ${command.replace(/\n/g, "\\n").slice(0, 78)}`, () => {
      assert.equal(verdict(action, command, cwd), want);
    });
  }
}

describe("git-guard: commands that reach a protected branch", () => {
  table("commit", [
    [true, "git commit -m x"],
    [true, "git add -A; git commit -m x"],
    [true, "git status && git commit -m x"],
    [true, "FOO=1 git commit -m x"],
    [true, "env FOO=1 git commit -m x"],
    [true, "git -c user.name=x commit -m y"],
    [false, "git commit -m x", ON_BRANCH],
  ]);
  table("push", [
    [true, "git push"],
    [true, "git push origin main"],
    [true, "git push origin"],
    [false, "git push", ON_BRANCH],
    [false, "git push origin feat/x"],
    [false, "git push --force-with-lease", ON_BRANCH],
    [false, "git push -u origin HEAD", ON_BRANCH],
  ]);
});

// The hole the change set out to close: the old guards anchored on
// /^\s*git (commit|push)/, so anything that cd'd first was never examined.
describe("git-guard: a command is judged where it actually runs", () => {
  table("commit", [
    [true, `cd ${ON_MAIN} && git commit -m x`, ON_BRANCH],
    [true, `git status && cd ${ON_MAIN} && git commit -m x`, ON_BRANCH],
    [true, `git -C ${ON_MAIN} commit -m x`, ON_BRANCH],
    [false, `cd ${ON_BRANCH} && git commit -m x`, ON_MAIN],
    // A path we cannot expand is not a path we can follow, and "no branch found"
    // must not read as "not protected" — see the unresolvable-directory suite.
    [true, "cd $TARGET && git commit -m x", ON_MAIN],
    [true, 'cd "$(mktemp -d)" && git commit -m x', ON_MAIN],
    [false, `git -C ${ON_BRANCH} commit -m x`, ON_MAIN],
  ]);
  table("push", [
    [true, `cd ${ON_MAIN} && git push origin main`, ON_BRANCH],
    [true, `git -C ${ON_MAIN} push`, ON_BRANCH],
    [true, 'sh -c "git push"'],
    [true, `bash -c "cd ${ON_MAIN} && git push origin main"`, ON_BRANCH],
    [false, `cd ${ON_BRANCH} && git push`, ON_MAIN],
  ]);
});

// Regression: an earlier revision of this change allowed every one of these.
// It matched the whole command string with a regex whose negative half carried a
// trailing word boundary, so `HEAD` followed by `:` stopped matching and the
// "names another ref" allowance fired instead.
describe("git-guard: a refspec is judged by its destination, not its spelling", () => {
  table("push", [
    [true, "git push origin HEAD:main"],
    [true, "git push origin main:main"],
    [true, "git push --force origin HEAD:main"],
    [true, "git push --force-with-lease origin HEAD:main"],
    [true, "git push origin main:refs/heads/main"],
    [true, "git push origin +main"],
    [true, "git push origin refs/heads/main"],
    [true, "git push origin feat/x main"],
    [true, "git push origin :main"],
    [true, "git push origin HEAD:main", ON_BRANCH],
    [false, "git push origin HEAD:feat/x"],
    [false, "git push origin feat/x:feat/x"],
  ]);
});

// Regression: an earlier revision scanned the entire command line for --delete,
// so any `-d` anywhere after the word "push" disarmed the guard — and
// `git push origin --delete main` was allowed outright.
describe("git-guard: --delete is scoped to its own invocation", () => {
  table("push", [
    [false, "git push origin --delete feat/x"],
    [false, "git push origin -d feat/x"],
    [true, "git push origin --delete main"],
    [true, "git push origin main && git branch -d old-feat"],
    [true, "git push origin main; git branch -d x"],
  ]);
});

// Regression: an earlier revision blocked these. A guard that fires on prose is
// worse than useless — a PreToolUse hook exiting 2 kills the tool call outright.
describe("git-guard: quoting and heredocs are not commands", () => {
  table("commit", [
    [false, 'echo "git commit"'],
    [false, 'echo "git add -A; git commit -m x"'],
    [false, "grep -n 'git commit' file"],
    [false, 'gh issue create --body "run: git commit && git push"'],
    [false, "cat > d.md <<'EOF'\ngit commit -m x\nEOF"],
    [false, 'cat > d.md <<"EOF"\ngit commit -m x\nEOF'],
    [false, "cat > d.md <<-EOF\n\tgit commit -m x\n\tEOF"],
  ]);
  table("push", [
    [false, 'echo "then git push"'],
    [false, "cat > d.md <<'EOF'\ngit push origin main\nEOF"],
    [false, 'cat > d.md <<"EOF"\ngit push origin main\nEOF'],
    [false, 'grep x <<< "$v" && echo ok'],
    [false, "git log --oneline 2>&1 | head"],
    // a heredoc whose terminator never arrives must not swallow the rest
    [true, "cat <<'EOF'\nsome text\nEOF\ngit push origin main"],
  ]);
});

// Every case below is a bypass or fail-open that CodeRabbit found on PR #628
// after it had already been merged. Each one is named so it cannot come back.
describe("git-guard: a command word is a program, however it is spelled", () => {
  table("push", [
    [true, "/usr/bin/git push origin main"],
    [true, '"git" push origin main'],
    [true, "\\git push origin main"],
    [true, '"/bin/sh" -c "git push origin main"'],
    [true, "/usr/local/bin/git push"],
  ]);
  table("commit", [
    [true, "/usr/bin/git commit -m x"],
    [true, '"git" commit -m x'],
    [false, "/usr/bin/git status"],
  ]);
});

// --all and --mirror push every local branch, whichever one you are standing on,
// so the current-branch fallback never saw them.
describe("git-guard: bulk push modes", () => {
  table("push", [
    [true, "git push --all origin", ON_BRANCH],
    [true, "git push --mirror origin", ON_BRANCH],
    [true, "git push --branches origin", ON_BRANCH],
    // nothing protected exists locally, so there is nothing to protect
    [false, "git push --all origin", ON_BRANCH_SOLO],
  ]);
});

// bash expands $( ) and backticks inside double quotes and inside an UNQUOTED
// heredoc, so the guard saw only `cat` while the push ran.
describe("git-guard: substitutions the shell would expand", () => {
  table("push", [
    [true, "cat <<EOF\n$(git push origin main)\nEOF"],
    [true, "cat <<EOF\n`git push origin main`\nEOF"],
    [true, 'echo "$(git push origin main)"'],
    [true, "echo `git push origin main`"],
    [true, "echo $(git push origin main)"],
    // quoting the delimiter turns expansion off for the whole body
    [false, "cat <<'EOF'\n$(git push origin main)\nEOF"],
    [false, 'cat <<"EOF"\n$(git push origin main)\nEOF'],
    [false, "echo 'git push origin main'"],
  ]);
});

// An unresolvable directory used to resolve to no branch at all, which read as
// "not protected" and let the command through.
describe("git-guard: an unresolvable directory blocks what depends on it", () => {
  table("commit", [
    [true, "cd - && git commit -m x", ON_BRANCH],
    [true, "cd $TARGET && git commit -m x", ON_BRANCH],
    [true, 'cd "$(mktemp -d)" && git commit -m x', ON_BRANCH],
    [true, "cd /a /b && git commit -m x", ON_BRANCH],
    [true, "git -C $TARGET commit -m x", ON_BRANCH],
  ]);
  table("push", [
    [true, "cd $TARGET && git push", ON_BRANCH],
    // ...but a destination that is knowable without the directory still decides it
    [false, "cd $TARGET && git push origin feat/x", ON_BRANCH],
    [true, "cd $TARGET && git push origin main", ON_BRANCH],
  ]);
});

describe("git-guard: parseSegments", () => {
  test("splits on unquoted separators only", () => {
    const segs = parseSegments('echo "a; b" && git push');
    assert.equal(segs.length, 2);
    assert.deepEqual(
      segs[1].map((t) => t.text),
      ["git", "push"],
    );
  });

  test("keeps 2>&1 out of the separator logic", () => {
    const segs = parseSegments("git log 2>&1");
    assert.equal(segs.length, 1);
  });

  test("marks quoted tokens so they cannot be read as a command", () => {
    const [seg] = parseSegments('"git" push');
    assert.equal(seg[0].quoted, true);
  });
});

describe("hook path resolution", () => {
  const GUARDS = ["prevent-main-commit.sh", "prevent-main-push.sh"];
  const commands = () => {
    const cfg = JSON.parse(readFileSync(SETTINGS, "utf8"));
    return Object.entries(cfg.hooks).flatMap(([event, groups]) =>
      groups.flatMap((g) => g.hooks.map((h) => ({ event, command: h.command }))),
    );
  };

  test("every hook probes the script it is about to run, then falls back", () => {
    const all = commands();
    assert.ok(all.length >= 5, `expected at least 5 hook commands, got ${all.length}`);
    for (const { event, command } of all) {
      const script = command.match(/bash "\$H\/([\w.-]+\.sh)"$/)?.[1];
      assert.ok(script, `${event}: command does not end in a resolved bash call: ${command}`);
      // Probing the directory is not enough — ~/.claude/hooks exists on a dev
      // machine, so a session launched from $HOME satisfied a -d test and still
      // resolved to a tree with none of these scripts in it.
      assert.ok(
        command.includes(`[ -f "$H/${script}" ] ||`),
        `${event}: probes something other than ${script}`,
      );
      assert.ok(
        command.includes("git rev-parse --show-toplevel"),
        `${event}: has no git-toplevel fallback`,
      );
    }
  });

  // Hooks run from the cwd, so an unconstrained fallback can pick an unrelated
  // repository and execute ITS hook with the user's privileges (CWE-426).
  test("the fallback is constrained to the project tree, with both paths canonicalised", () => {
    for (const { event, command } of commands()) {
      assert.ok(
        command.includes('case "$T/" in "${P%/}"/*)'),
        `${event}: fallback is not constrained`,
      );
      assert.ok(command.includes("pwd -P"), `${event}: does not canonicalise before comparing`);
    }
  });

  // A guard that cannot be located must block. Claude Code treats only exit 2 as
  // blocking, so exiting 127 for a missing script runs the command unguarded.
  test("a guard that cannot be located exits 2; an observability hook does not", () => {
    for (const { command } of commands()) {
      const script = command.match(/bash "\$H\/([\w.-]+\.sh)"$/)[1];
      if (GUARDS.includes(script)) {
        assert.match(
          command,
          /refusing to run unguarded[^;]*; exit 2; \}/,
          `${script} should fail closed`,
        );
      } else {
        assert.ok(
          command.includes("|| exit 0;"),
          `${script} should fail open, not take the tool call down`,
        );
      }
    }
  });
});

describe("hooks end to end", () => {
  let tmp;
  const repos = {};

  before(() => {
    tmp = mkdtempSync(join(tmpdir(), "drafto-hooks-"));
    for (const [name, branch] of [
      ["onMain", "main"],
      ["onBranch", "feat/x"],
    ]) {
      const dir = join(tmp, name);
      mkdirSync(dir, { recursive: true });
      const git = (...a) => execFileSync("git", a, { cwd: dir, stdio: "pipe" });
      git("init", "-q", "-b", "main");
      git(
        "-c",
        "user.email=t@t",
        "-c",
        "user.name=t",
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        "init",
      );
      if (branch !== "main") git("checkout", "-q", "-b", branch);
      // the resolver falls back to the git toplevel, so the fixture needs both
      // the hooks and the guard they delegate to
      mkdirSync(join(dir, ".claude"), { recursive: true });
      cpSync(HOOKS, join(dir, ".claude", "hooks"), { recursive: true });
      mkdirSync(join(dir, "scripts"), { recursive: true });
      cpSync(join(REPO_ROOT, "scripts", "git-guard.mjs"), join(dir, "scripts", "git-guard.mjs"));
      repos[name] = dir;
    }
  });
  after(() => rmSync(tmp, { recursive: true, force: true }));

  const runSettingsCommand = (script, cwd, command, env = {}) => {
    const cfg = JSON.parse(readFileSync(SETTINGS, "utf8"));
    const entry = Object.values(cfg.hooks)
      .flat()
      .flatMap((g) => g.hooks)
      .find((h) => h.command.includes(script));
    return spawnSync("bash", ["-c", entry.command], {
      cwd,
      input: JSON.stringify({ tool_input: { command } }),
      encoding: "utf8",
      env: { ...process.env, ...env },
    }).status;
  };

  test("blocks a real commit on main through the wired-up hook", () => {
    assert.equal(
      runSettingsCommand("prevent-main-commit.sh", repos.onMain, "git commit -m x", {
        CLAUDE_PROJECT_DIR: repos.onMain,
      }),
      2,
    );
  });

  test("allows a real commit on a feature branch", () => {
    assert.equal(
      runSettingsCommand("prevent-main-commit.sh", repos.onBranch, "git commit -m x", {
        CLAUDE_PROJECT_DIR: repos.onBranch,
      }),
      0,
    );
  });

  // The failure this whole change exists to fix: Claude Code pins
  // CLAUDE_PROJECT_DIR to its launch directory and never follows a later cd, so
  // a session started one level up ran every hook against a path with no scripts
  // in it — 735 non-blocking "No such file or directory" errors in one session,
  // with both guards failing open the entire time.
  test("guard still runs when CLAUDE_PROJECT_DIR points outside the repo", () => {
    const bogus = mkdtempSync(join(tmpdir(), "not-the-project-"));
    try {
      assert.equal(
        runSettingsCommand("prevent-main-commit.sh", repos.onMain, "git commit -m x", {
          CLAUDE_PROJECT_DIR: bogus,
        }),
        2,
      );
    } finally {
      rmSync(bogus, { recursive: true, force: true });
    }
  });

  // A directory probe was not enough: ~/.claude/hooks exists on a dev machine,
  // so launching from $HOME passed `[ -d "$H" ]` and still resolved wrongly.
  test("guard still runs when CLAUDE_PROJECT_DIR is a dir that has a .claude/hooks of its own", () => {
    const decoy = mkdtempSync(join(tmpdir(), "decoy-"));
    mkdirSync(join(decoy, ".claude", "hooks"), { recursive: true });
    try {
      assert.equal(
        runSettingsCommand("prevent-main-commit.sh", repos.onMain, "git commit -m x", {
          CLAUDE_PROJECT_DIR: decoy,
        }),
        2,
      );
    } finally {
      rmSync(decoy, { recursive: true, force: true });
    }
  });

  test("guard still runs when CLAUDE_PROJECT_DIR is unset", () => {
    const env = { ...process.env };
    delete env.CLAUDE_PROJECT_DIR;
    const cfg = JSON.parse(readFileSync(SETTINGS, "utf8"));
    const entry = Object.values(cfg.hooks)
      .flat()
      .flatMap((g) => g.hooks)
      .find((h) => h.command.includes("prevent-main-commit.sh"));
    const res = spawnSync("bash", ["-c", entry.command], {
      cwd: repos.onMain,
      input: JSON.stringify({ tool_input: { command: "git commit -m x" } }),
      encoding: "utf8",
      env,
    });
    assert.equal(res.status, 2);
  });

  // Claude Code treats ONLY exit 2 as blocking. A missing dependency exits 127
  // or 1, which reads as "allow" — so every one of these used to run the git
  // command with no guard at all.
  test("a missing node blocks instead of waving the command through", () => {
    const bin = mkdtempSync(join(tmpdir(), "nonode-"));
    // Everything the wrapper needs EXCEPT node, so `command -v node` is the only
    // thing that fails. bash is invoked by absolute path because it would not be
    // on this PATH either.
    const bash =
      spawnSync("sh", ["-c", "command -v bash"], { encoding: "utf8" }).stdout.trim() || "/bin/bash";
    for (const tool of ["cat", "dirname", "pwd", "printf", "git"]) {
      const real = spawnSync("sh", ["-c", `command -v ${tool}`], {
        encoding: "utf8",
      }).stdout.trim();
      if (real) symlinkSync(real, join(bin, tool));
    }
    try {
      const res = spawnSync(bash, [join(HOOKS, "prevent-main-commit.sh")], {
        cwd: repos.onMain,
        input: JSON.stringify({ tool_input: { command: "git commit -m x" } }),
        encoding: "utf8",
        env: { ...process.env, PATH: bin },
      });
      assert.equal(res.status, 2, `expected a block, got ${res.status}: ${res.stderr}`);
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });

  test("a missing git-guard.mjs blocks instead of waving the command through", () => {
    const moved = join(repos.onMain, "scripts", "git-guard.mjs");
    const stash = `${moved}.bak`;
    renameSync(moved, stash);
    try {
      const res = spawnSync("bash", [join(HOOKS, "prevent-main-commit.sh")], {
        cwd: repos.onMain,
        input: JSON.stringify({ tool_input: { command: "git commit -m x" } }),
        encoding: "utf8",
      });
      assert.equal(res.status, 2, `expected a block, got ${res.status}: ${res.stderr}`);
    } finally {
      renameSync(stash, moved);
    }
  });

  test("a guard that cannot be located anywhere blocks", () => {
    const bogus = mkdtempSync(join(tmpdir(), "no-project-"));
    try {
      assert.equal(
        runSettingsCommand("prevent-main-commit.sh", bogus, "git commit -m x", {
          CLAUDE_PROJECT_DIR: bogus,
        }),
        2,
      );
    } finally {
      rmSync(bogus, { recursive: true, force: true });
    }
  });

  // Hooks run from the cwd, so an unconstrained `git rev-parse --show-toplevel`
  // would execute an unrelated repository's hook with the user's privileges.
  test("the fallback refuses a repo outside CLAUDE_PROJECT_DIR rather than running its hook", () => {
    const outside = mkdtempSync(join(tmpdir(), "outside-"));
    try {
      // cwd IS a repo with hooks, but it is not inside the declared project tree
      assert.equal(
        runSettingsCommand("prevent-main-commit.sh", repos.onMain, "git commit -m x", {
          CLAUDE_PROJECT_DIR: outside,
        }),
        2,
      );
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  // ...while the parent-of-the-repo case, which is the original bug, must still work.
  test("the fallback accepts a repo inside CLAUDE_PROJECT_DIR even across a symlinked tmp path", () => {
    assert.equal(
      runSettingsCommand("prevent-main-commit.sh", repos.onMain, "git commit -m x", {
        CLAUDE_PROJECT_DIR: tmp,
      }),
      2,
    );
  });

  test("a payload with no command is not blocked", () => {
    const res = spawnSync("bash", [join(HOOKS, "prevent-main-push.sh")], {
      cwd: repos.onMain,
      input: JSON.stringify({ tool_input: {} }),
      encoding: "utf8",
    });
    assert.equal(res.status, 0);
  });

  test("malformed json is not blocked", () => {
    const res = spawnSync("bash", [join(HOOKS, "prevent-main-push.sh")], {
      cwd: repos.onMain,
      input: "{not json, git push",
      encoding: "utf8",
    });
    assert.equal(res.status, 0);
  });
});
