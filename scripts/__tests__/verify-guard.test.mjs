// Tests for scripts/lib/verify-guard.mjs — the PreToolUse guard of the
// verification stage's shell lane (ADR-0053). Three layers: the deny/allow
// matrix over decidePre (pure but for realpath lookups), the generated
// settings file, and the hook CLI run the way Claude Code runs it (the
// settings' own command strings through /bin/sh, payload on stdin).

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ALWAYS_DENY_TOOLS,
  DENY_COMMANDS,
  HOOK_MATCHER,
  HOOK_TIMEOUTS,
  LANE_TOOLS,
  PERL_ALARM_SCRIPT,
  PRE_ALARM_SEC,
  READ_ONLY_GIT_VERBS,
  allowedToolsArg,
  buildGuardSettings,
  decidePre,
  protectedPathReason,
  redactForLog,
  splitCommands,
  validateConfig,
  verifySession,
  writeGuardFiles,
} from "../lib/verify-guard.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GUARD = path.resolve(HERE, "..", "lib", "verify-guard.mjs");

let tmp;
let config;
let home;

before(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "verify-guard-test-"));
  home = path.join(tmp, "home");
  const repoRoot = path.join(tmp, "factory");
  const runDir = path.join(
    repoRoot,
    "logs",
    "factory",
    "verify",
    "7-aaaaaaaaaaaa-20261021T000000Z",
  );
  const worktree = path.join(repoRoot, "worktrees", "verify-7-aaaaaaaaaaaa");
  for (const d of [path.join(home, "drafto-secrets"), runDir, worktree, path.join(home, "work")]) {
    mkdirSync(d, { recursive: true });
  }
  writeFileSync(path.join(home, "drafto-secrets", "vercel-bypass.env"), "X=1\n");
  // A symlink into the secrets dir, from somewhere innocent-looking.
  symlinkSync(path.join(home, "drafto-secrets"), path.join(home, "work", "innocent"));
  config = validateConfig({ runDir, worktree, repoRoot, home });
});

after(() => rmSync(tmp, { recursive: true, force: true }));

const bash = (command) => decidePre({ tool: "Bash", input: { command }, config });

describe("decidePre: Bash deny/allow matrix", () => {
  const allowed = [
    "pnpm --filter @drafto/web test -- --maxWorkers=2 src/notes",
    "cd scripts && node --test __tests__/verify-lane.test.mjs",
    "git status --porcelain",
    "git log --oneline -5",
    "git diff HEAD~1 -- apps/web",
    "git branch --contains abc123",
    "git worktree list",
    "FOO=1 pnpm test",
    "pnpm exec jest src/x.test.ts",
    "npm test",
    "curl -s http://localhost:3000/api/health",
    "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/",
    "preview-curl /api/health -s -w '%{http_code}'",
    'preview-curl -X POST /api/api-keys --json \'{"name":"factory-shell-7-aaaaaaa"}\' > "$D/key.json"',
    `${config.binDir}/preview-curl /api/health`,
    "bash apps/desktop/e2e/in-test/scenarios/458-sync-gating.sh --preflight",
    "ISSUE= PR= bash apps/desktop/e2e/in-test/scenarios/458-sync-gating.sh --preflight",
    "cat apps/web/.env.local.example",
    "ls /private/tmp && echo ok",
    "export FOO=bar",
    "sleep 5; kill %1",
    "node apps/web/x.js",
    "node -e 'console.log(1)'",
    'cat > /tmp/b.json <<\'EOF\'\n{"a": "don\'t"}\nEOF',
    "timeout 120 pnpm test",
    "grep -rn 'process.env' apps/web/src",
    "D=$(mktemp -d) && echo $D",
    "for f in a b; do echo $f; done",
    "if [ -f x ]; then echo y; fi",
  ];
  for (const command of allowed) {
    it(`allows ${JSON.stringify(command).slice(0, 80)}`, () => {
      const d = bash(command);
      assert.equal(d.allow, true, d.reason);
    });
  }

  const denied = [
    ["gh pr list", /gh isn't available/],
    ["claude -p hi", /claude isn't available/],
    ["vercel curl /api", /vercel isn't available/],
    ["supabase db push", /supabase/],
    ["fastlane beta", /fastlane/],
    ["sudo ls", /sudo/],
    ["osascript -e 'x'", /osascript/],
    ["launchctl list", /launchctl/],
    ["security find-generic-password -s x", /security/],
    ["env", /env isn't available/],
    ["printenv HOME", /printenv/],
    ["set", /printing the environment/],
    ["export -p", /printing the environment/],
    ["npx jest", /npx/],
    ["wget https://x", /wget/],
    ["open https://example.com", /open/],
    ['eval "$X"', /eval/],
    [">/tmp/x gh pr list", /gh isn't available/],
    ["if gh pr list; then echo; fi", /gh isn't available/],
    ["echo $(gh auth token)", /gh isn't available/],
    ["echo `gh auth token`", /gh isn't available/],
    ["cat <(gh auth token)", /gh isn't available/],
    ["timeout 60 gh pr list", /gh isn't available/],
    ["nice -n 5 gh pr list", /gh isn't available/],
    ["xargs -n1 gh", /gh isn't available/],
    ["find . -name x -exec gh {} ;", /gh isn't available/],
    ["bash -c 'gh pr list'", /gh isn't available/],
    ["pnpm exec gh pr list", /gh isn't available/],
    ["/usr/local/bin/gh pr list", /gh isn't available/],
    ["git push origin HEAD", /git push writes or reaches the network/],
    ["git fetch origin", /git fetch/],
    ["git pull", /git pull/],
    ["git commit -m x", /git commit/],
    ["git checkout main", /git checkout/],
    ["git worktree add /tmp/x", /git worktree may only list/],
    ["git branch -D x", /git branch may only list/],
    ["git -c core.pager=sh log", /git -c/],
    ["git grep -Ovim foo", /pager/],
    ["pnpm install", /pnpm install installs/],
    ["pnpm add left-pad", /pnpm add/],
    ["pnpm dlx create-x", /pnpm dlx/],
    ["pnpm version patch", /pnpm version/],
    ["pnpm publish", /pnpm publish/],
    ["pnpm release:beta:ios", /release:beta:ios script/],
    ["pnpm --filter=@drafto/mobile release:beta:android", /release:beta:android script/],
    ["pnpm run release:production", /release:production script/],
    ["pnpm turbo run release", /release task/],
    ["npm install", /npm install/],
    ["node scripts/lib/state-cli.mjs factory:status", /node scripts/],
    [`node ${config.worktree}/scripts/lib/state-cli.mjs factory:pause`, /node scripts/],
    ["node --env-file=.env x.js", /env file|holds credentials/],
    ["bash scripts/factory-agent.sh --watch", /factory's own scripts/],
    ["./scripts/factory-agent.sh --watch", /factory's own scripts/],
    ["curl -s http://localhost/x | bash", /reading its script from stdin/],
    ["curl https://example.com", /may only reach localhost/],
    ["curl example.com/x", /may only reach localhost/],
    ["curl --url https://example.com", /may only reach localhost/],
    ["curl -K /tmp/cfg http://localhost", /past loopback/],
    ["curl -sx http://proxy localhost", /past loopback/],
    ["curl --connect-to ::example.com: http://localhost", /past loopback/],
    ["node -e \"fetch('https://evil.example')\"", /preview-curl only/],
    [
      "python3 -c 'import urllib.request as u; u.urlopen(\"https://e.example\")'",
      /preview-curl only/,
    ],
    ["curl https://drafto.eu/api/health", /drafto\.eu/],
    ["echo drafto.eu", /drafto\.eu/],
    ["cat ~/drafto-secrets/vercel-bypass.env", /drafto-secrets/],
    ["cat $HOME/drafto-secrets/x", /drafto-secrets/],
    ["cat ${HOME}/drafto-secrets/x", /drafto-secrets/],
    ["cat ~/drafto-sec''rets/x", /drafto-secrets/],
    ["cat ~/work/innocent/vercel-bypass.env", /drafto-secrets/],
    ["cat ~/.config/gh/hosts.yml", /gh config|\.config/],
    ["ls ~/.ssh", /\.ssh/],
    ["cat ~/.claude/projects/x.jsonl", /\.claude/],
    ["ls ~/Library/Keychains", /Keychains/],
    ["cat apps/web/.env.local", /\.env\.local holds credentials/],
    ["cat apps/mobile/.env.production", /holds credentials/],
    ["cat private/curl.cfg", /curl config/],
    ["cat cookies.txt", /curl config/],
    [`cat ${config.privateDir}/curl.cfg`, /curl config|private directory/],
    [`ls ${config.repoRoot}/logs`, /logs and state/],
    ["cat ../../logs/factory-state.json", /logs and state/],
    ["ls ../../logs/factory", /logs and state/],
    ["bash apps/desktop/e2e/in-test/scenarios/458-sync-gating.sh", /--preflight/],
    ["bash apps/desktop/e2e/in-test/scenarios/458-sync-gating.sh --cleanup-only", /--preflight/],
    ["cat apps/desktop/e2e/in-test/scenarios/458-sync-gating.sh", /--preflight/],
    ["echo 'unbalanced", /couldn't parse/],
    ["cat <<EOF\n$(gh auth token)\nEOF", /gh isn't available/],
  ];
  for (const [command, why] of denied) {
    it(`denies ${JSON.stringify(command).slice(0, 80)}`, () => {
      const d = bash(command);
      assert.equal(d.allow, false, `allowed: ${command}`);
      assert.match(d.reason, why);
    });
  }

  it("denies every DENY_COMMANDS word as a command, by basename too", () => {
    for (const name of DENY_COMMANDS) {
      assert.equal(bash(`${name} --help`).allow, false, name);
      assert.equal(bash(`/some/dir/${name} --help`).allow, false, `/some/dir/${name}`);
    }
  });

  it("allows every read-only git verb and nothing it doesn't list", () => {
    for (const verb of READ_ONLY_GIT_VERBS) assert.equal(bash(`git ${verb}`).allow, true, verb);
    for (const verb of [
      "push",
      "fetch",
      "clone",
      "remote",
      "config",
      "stash",
      "reset",
      "rebase",
      "merge",
      "tag",
      "am",
      "apply",
      "clean",
      "submodule",
      "ls-remote",
    ]) {
      assert.equal(bash(`git ${verb}`).allow, false, verb);
    }
  });

  it("denies an empty command and a non-string one", () => {
    assert.equal(bash("   ").allow, false);
    assert.equal(decidePre({ tool: "Bash", input: { command: 7 }, config }).allow, false);
  });
});

describe("decidePre: tools and paths", () => {
  it("denies every tool but Bash, Read, Grep and Glob", () => {
    for (const tool of [
      "Write",
      "Edit",
      "NotebookEdit",
      "WebFetch",
      "WebSearch",
      "Task",
      "Agent",
      "mcp__x__y",
    ]) {
      const d = decidePre({ tool, input: {}, config });
      assert.equal(d.allow, false, tool);
      assert.match(d.reason, /isn't available/);
    }
    assert.equal(decidePre({ tool: undefined, input: {}, config }).allow, false);
  });

  it("lets Read, Grep and Glob reach the worktree and the temp dir", () => {
    for (const [tool, input] of [
      ["Read", { file_path: "apps/web/src/app/page.tsx" }],
      ["Read", { file_path: path.join(config.worktree, "package.json") }],
      ["Grep", { pattern: "process.env", path: "apps/web" }],
      ["Glob", { pattern: "apps/**/*.test.ts" }],
      ["Read", { file_path: "/tmp/x.json" }],
      ["Read", { file_path: "apps/desktop/e2e/in-test/scenarios/458-sync-gating.sh" }],
    ]) {
      const d = decidePre({ tool, input, config });
      assert.equal(d.allow, true, `${tool} ${JSON.stringify(input)}: ${d.reason}`);
    }
  });

  it("keeps Read, Grep and Glob out of every protected path, through a symlink too", () => {
    for (const [tool, input, why] of [
      ["Read", { file_path: "~/drafto-secrets/vercel-bypass.env" }, /drafto-secrets/],
      [
        "Read",
        { file_path: path.join(home, "work", "innocent", "vercel-bypass.env") },
        /drafto-secrets/,
      ],
      ["Read", { file_path: path.join(config.privateDir, "curl.cfg") }, /private|curl config/],
      ["Read", { file_path: "apps/web/.env.local" }, /holds credentials/],
      [
        "Read",
        { file_path: path.join(config.repoRoot, "logs", "factory-state.json") },
        /logs and state/,
      ],
      ["Glob", { pattern: path.join(home, ".ssh", "*") }, /\.ssh/],
      ["Glob", { pattern: "**/*", path: path.join(home, ".config") }, /\.config/],
      [
        "Grep",
        { pattern: "token", path: path.join(home, "Library", "Application Support") },
        /Application Support/,
      ],
      ["Grep", { pattern: "x", glob: "~/drafto-secrets/*" }, /drafto-secrets/],
    ]) {
      const d = decidePre({ tool, input, config });
      assert.equal(d.allow, false, `${tool} ${JSON.stringify(input)}`);
      assert.match(d.reason, why);
    }
  });

  it("protectedPathReason lets the run's bin/ through but nothing else under logs/", () => {
    assert.equal(protectedPathReason(path.join(config.binDir, "preview-curl"), config), null);
    assert.match(protectedPathReason(path.join(config.runDir, "meta.json"), config), /logs/);
  });
});

describe("splitCommands", () => {
  it("splits on operators and keeps redirection targets apart", () => {
    const { commands } = splitCommands("a 1 && b 2 > out.txt; c | d 2>&1 &");
    assert.deepEqual(
      commands.map((c) => c.words),
      [["a", "1"], ["b", "2"], ["c"], ["d"]],
    );
    assert.deepEqual(commands[1].targets, ["out.txt"]);
    assert.deepEqual(commands[3].targets, []);
  });

  it("splits command substitutions out, inside double quotes too", () => {
    const { commands } = splitCommands('echo "x $(gh auth token) y" `id`');
    assert.deepEqual(
      commands.map((c) => c.words[0]),
      ["gh", "id", "echo"],
    );
  });

  it("treats a quoted heredoc as data and expands an unquoted one's substitutions", () => {
    const quoted = splitCommands("cat <<'EOF'\ngh is great; don't\nEOF\necho done");
    assert.deepEqual(
      quoted.commands.map((c) => c.words[0]),
      ["cat", "echo"],
    );
    assert.equal(quoted.heredocs[0].body, "gh is great; don't");
    const open = splitCommands("cat <<EOF\n$(gh auth token)\nEOF");
    assert.ok(open.commands.some((c) => c.words[0] === "gh"));
  });

  it("throws on unbalanced quotes and unterminated heredocs", () => {
    assert.throws(() => splitCommands("echo 'x"), /unbalanced/);
    assert.throws(() => splitCommands('echo "x'), /unbalanced/);
    assert.throws(() => splitCommands("cat <<EOF\nno end"), /heredoc/);
    assert.throws(() => splitCommands("echo $(date"), /unterminated/);
  });
});

describe("settings", () => {
  const settings = buildGuardSettings({
    nodePath: "/opt/node/bin/node",
    guardPath: "/repo/scripts/lib/verify-guard.mjs",
    configPath: "/run/guard-config.json",
  });

  it("is the shape the lane depends on: canary, alarmed pre hook, fail closed", () => {
    assert.equal(settings.disableAllHooks, false);
    assert.deepEqual(settings.permissions.deny, [...ALWAYS_DENY_TOOLS]);
    const start = settings.hooks.SessionStart[0].hooks[0];
    assert.equal(start.timeout, HOOK_TIMEOUTS.sessionStart);
    assert.match(
      start.command,
      /'\/opt\/node\/bin\/node' '\/repo\/scripts\/lib\/verify-guard\.mjs' hook session-start --config '\/run\/guard-config\.json'/,
    );
    const preGroup = settings.hooks.PreToolUse[0];
    assert.equal(preGroup.matcher, HOOK_MATCHER);
    assert.equal(HOOK_MATCHER, "*", "every tool goes through the guard");
    const pre = preGroup.hooks[0];
    assert.equal(pre.timeout, HOOK_TIMEOUTS.pre);
    assert.ok(
      PRE_ALARM_SEC < HOOK_TIMEOUTS.pre,
      "the alarm fires before Claude Code's own timeout (an allow)",
    );
    assert.ok(
      pre.command.startsWith(`'/usr/bin/perl' -e '${PERL_ALARM_SCRIPT}' ${PRE_ALARM_SEC} `),
    );
    assert.ok(
      pre.command.endsWith(" || exit 2"),
      "a crash, a missing node or the alarm must block",
    );
    assert.equal(Object.keys(settings.hooks).sort().join(","), "PreToolUse,SessionStart");
  });

  it("only lists tools every claude version knows in permissions.deny", () => {
    for (const t of settings.permissions.deny) assert.match(t, /^[A-Z][A-Za-z]+$/);
    assert.ok(!settings.permissions.deny.some((t) => LANE_TOOLS.includes(t)));
  });

  it("refuses paths that would need shell escaping", () => {
    assert.throws(
      () => buildGuardSettings({ nodePath: "/a'b/node", guardPath: "/g", configPath: "/c" }),
      /single quote/,
    );
    assert.throws(
      () => buildGuardSettings({ nodePath: "node", guardPath: "/g", configPath: "/c" }),
      /absolute/,
    );
  });

  it("names exactly the lane's four tools for --tools / --allowedTools", () => {
    assert.equal(allowedToolsArg(), "Bash,Read,Grep,Glob");
    assert.deepEqual([...LANE_TOOLS], ["Bash", "Read", "Grep", "Glob"]);
  });
});

describe("hook CLI, run as Claude Code runs it", () => {
  let files;
  before(() => {
    files = writeGuardFiles({
      runDir: config.runDir,
      worktree: config.worktree,
      repoRoot: config.repoRoot,
      home,
    });
  });

  const settings = () => JSON.parse(readFileSync(files.settingsPath, "utf8"));
  const runHook = (command, payload) =>
    spawnSync("/bin/sh", ["-c", command], { input: JSON.stringify(payload), encoding: "utf8" });

  it("writes valid JSON settings pointing at this guard and the run's config", () => {
    const s = settings();
    assert.ok(s.hooks.PreToolUse[0].hooks[0].command.includes(GUARD));
    assert.ok(s.hooks.PreToolUse[0].hooks[0].command.includes(files.configPath));
    const cfg = JSON.parse(readFileSync(files.configPath, "utf8"));
    assert.equal(cfg.runDir, config.runDir);
    assert.equal(cfg.logDir, path.join(config.runDir, "guard"));
  });

  it("session-start writes the canary that verifySession reads", () => {
    const sid = "11111111-2222-3333-4444-555555555555";
    const r = runHook(settings().hooks.SessionStart[0].hooks[0].command, {
      session_id: sid,
      source: "startup",
    });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(verifySession({ configPath: files.configPath, session: sid }), {
      sessionStart: true,
      pre: 0,
      denied: 0,
    });
  });

  it("pre exits 0 to allow and 2 with the reason to deny, and logs both (redacted)", () => {
    const sid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const cmd = settings().hooks.PreToolUse[0].hooks[0].command;
    const ok = runHook(cmd, {
      session_id: sid,
      tool_name: "Bash",
      tool_input: { command: "git status" },
    });
    assert.equal(ok.status, 0, ok.stderr);
    const key = `dk_${"ab".repeat(24)}`;
    const no = runHook(cmd, {
      session_id: sid,
      tool_name: "Bash",
      tool_input: { command: `gh api -H "Authorization: Bearer ${key}" /user` },
    });
    assert.equal(no.status, 2);
    assert.match(no.stderr, /Blocked by the factory verify guard: gh isn't available/);
    const log = readFileSync(path.join(config.runDir, "guard", `${sid}.jsonl`), "utf8");
    assert.ok(!log.includes(key), "an API key never reaches the decision log");
    assert.deepEqual(verifySession({ configPath: files.configPath, session: sid }), {
      sessionStart: false,
      pre: 2,
      denied: 1,
    });
  });

  it("pre fails closed on a garbage payload, a missing config and a missing guard", () => {
    const cmd = settings().hooks.PreToolUse[0].hooks[0].command;
    assert.equal(runHook(cmd, "not json").status, 2);
    assert.equal(spawnSync("/bin/sh", ["-c", cmd], { input: "{", encoding: "utf8" }).status, 2);
    const noConfig = cmd.replace(files.configPath, path.join(tmp, "nope.json"));
    assert.equal(
      runHook(noConfig, { session_id: "x1", tool_name: "Bash", tool_input: { command: "ls" } })
        .status,
      2,
    );
    const noGuard = cmd.replace(GUARD, path.join(tmp, "missing-guard.mjs"));
    assert.equal(
      runHook(noGuard, { session_id: "x2", tool_name: "Bash", tool_input: { command: "ls" } })
        .status,
      2,
    );
  });

  it("verify exits 1 for a session with no canary", () => {
    const r = spawnSync(
      process.execPath,
      [
        GUARD,
        "verify",
        "--config",
        files.configPath,
        "--session",
        "99999999-0000-0000-0000-000000000000",
      ],
      { encoding: "utf8" },
    );
    assert.equal(r.status, 1);
    assert.deepEqual(JSON.parse(r.stdout), { sessionStart: false, pre: 0, denied: 0 });
  });

  it("the CLI writes config and settings and prints the tool list", () => {
    const dir = path.join(tmp, "cli");
    mkdirSync(dir);
    const cfg = path.join(dir, "cfg.json");
    const out = path.join(dir, "settings.json");
    let r = spawnSync(
      process.execPath,
      [
        GUARD,
        "config",
        "--out",
        cfg,
        "--run-dir",
        path.join(dir, "run"),
        "--worktree",
        path.join(dir, "wt"),
        "--repo-root",
        dir,
        "--home",
        home,
      ],
      { encoding: "utf8" },
    );
    assert.equal(r.status, 0, r.stderr);
    r = spawnSync(process.execPath, [GUARD, "settings", "--config", cfg, "--out", out], {
      encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(out));
    r = spawnSync(process.execPath, [GUARD, "allowed-tools"], { encoding: "utf8" });
    assert.equal(r.stdout.trim(), "Bash,Read,Grep,Glob");
  });
});

describe("redactForLog", () => {
  it("redacts keys, bearer tokens and JWTs, and truncates", () => {
    const s = redactForLog(
      `a dk_${"0".repeat(48)} Bearer abcdefghijkl eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig ${"x".repeat(500)}`,
    );
    assert.ok(!s.includes("0".repeat(20)));
    assert.match(s, /Bearer \[redacted\]/);
    assert.match(s, /\[jwt redacted\]/);
    assert.ok(s.length <= 401);
  });
});
