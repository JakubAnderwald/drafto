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
  realpathSync,
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
  DEVICE_SCENARIO_MODE,
  HOOK_MATCHER,
  HOOK_TIMEOUTS,
  LANE_TOOLS,
  PERL_ALARM_SCRIPT,
  PRE_ALARM_SEC,
  READ_ONLY_GIT_VERBS,
  allowedToolsArg,
  buildGuardSettings,
  decidePre,
  dynamicPathReason,
  globSegmentRegex,
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
  // An innocuous name, so only the symlink's real path can give it away.
  writeFileSync(path.join(home, "drafto-secrets", "notes.txt"), "x\n");
  // A symlink into the secrets dir, from somewhere innocent-looking.
  symlinkSync(path.join(home, "drafto-secrets"), path.join(home, "work", "innocent"));
  config = validateConfig({ runDir, worktree, repoRoot, home });
});

after(() => rmSync(tmp, { recursive: true, force: true }));

const bash = (command) => decidePre({ tool: "Bash", input: { command }, config });

describe("decidePre: Bash deny/allow matrix", () => {
  const allowed = [
    "pnpm --filter @drafto/web test -- --maxWorkers=2 src/notes",
    // The prompt's targeted-test commands (factory-verify-prompt.md, rule 1).
    "pnpm --filter @drafto/web exec vitest run __tests__/unit/health.test.ts --maxWorkers=2",
    "pnpm --filter @drafto/shared exec vitest run src/editor/__tests__/x.test.ts --maxWorkers=2",
    "pnpm --filter @drafto/mobile exec jest --maxWorkers=2 __tests__/unit/x.test.ts",
    "pnpm --filter @drafto/desktop exec jest --maxWorkers=2 __tests__/unit/x.test.ts",
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
    // The opt-in wrappers (ADR-0073), by name and by full path.
    "dev-inspect rows attachments --note d5f8208d-cb04-4be0-8102-5f7a28df2ff7",
    `${config.binDir}/dev-inspect usage`,
    "live-tests storage-quota",
    `${config.binDir}/live-tests profile-guard`,
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
    // Globs and variables that can't reach anything protected.
    "ls apps/web/src/*.ts",
    "cd scripts && node --test __tests__/*.test.mjs",
    // The dev live-test runner's own unit tests use fixtures only.
    "cd scripts && node --test __tests__/run-dev-live-tests.test.mjs",
    "cd scripts && node --test __tests__/delete-users.test.mjs",
    "cd scripts && node --test __tests__/user-stats.test.mjs",
    "node --test scripts/__tests__/product-metrics.test.mjs",
    'rm -rf "$D"/*',
    "awk '{print $1}' f.txt",
    "grep -E '^[a-z]+$' x.ts",
    "cat *.json",
    "echo $((1 + 2))",
  ];
  for (const command of allowed) {
    it(`allows ${JSON.stringify(command).slice(0, 80)}`, () => {
      const d = bash(command);
      assert.equal(d.allow, true, d.reason);
    });
  }

  const denied = [
    // Words the shell still expands: globs, variables, brace expansion.
    ["cat ~/drafto-secr*/x", /drafto-secrets/],
    ["cat ~/.ss?/id_rsa", /\.ssh|id_rsa/],
    ["cat apps/web/.env*", /could name \.env/],
    ["cat /Users/jakub/code/drafto/apps/web/.e*", /could name \.env/],
    ["D=drafto-sec; cat ~/${D}rets/x", /off limits/],
    ["cat ~/drafto-$X/vercel-bypass.env", /drafto-secrets|vercel-bypass\.env/],
    ["cat ~/.{ssh,aws}/config", /off limits/],
    ["S=~/drafto-sec*; ls $S", /drafto-secrets/],
    ["cat $S/.ssh/config", /\.ssh/],
    ["cat $X.env", /could name \.env/],
    ["ls ~/*", /off limits/],
    ["ls ../../l*", /logs and state|private directory/],
    ["find . -name '.env*'", /could name \.env/],
    ["cat ~/.config/g?/hosts.yml", /\.config/],
    ["cat [c]url.cfg", /could name curl\.cfg/],
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
    // The dev live tests run with the dev service-role key: operator-only.
    ["pnpm test:live:supabase", /dev live tests .* interactive sessions/],
    ["pnpm run test:live:supabase", /dev live tests .* interactive sessions/],
    ["pnpm run test:live:supabase -- --only profile-guard", /dev live tests/],
    ["pnpm --filter=drafto test:live:supabase", /dev live tests/],
    ["node scripts/run-dev-live-tests.mjs --dry-run", /dev live tests/],
    // A file run by node --test is its own main module.
    ["node --test scripts/run-dev-live-tests.mjs", /dev live tests/],
    ["node --test --test-isolation=none scripts/run-dev-live-tests.mjs", /dev live tests/],
    ["pnpm exec node --test scripts/run-dev-live-tests.mjs", /dev live tests/],
    ["cd scripts && node run-dev-live-tests.mjs", /dev live tests/],
    // Account deletion uses the service-role keys: operator-only.
    ["pnpm users:delete -- --project dev x@y.z", /deleting user accounts/],
    ["node scripts/delete-users.mjs --help", /deleting user accounts/],
    // The product metrics read a service-role key: operator-only.
    ["pnpm users:stats -- --project prod", /product metrics \(pnpm users:stats\)/],
    ["pnpm run users:stats -- --project dev --json", /product metrics/],
    ["node scripts/user-stats.mjs --help", /product metrics/],
    ["cd scripts && node user-stats.mjs --project dev", /product metrics/],
    ["node --test scripts/user-stats.mjs", /product metrics/],
    ["node -e \"import('./scripts/user-stats.mjs')\"", /product metrics/],
    ["cd scripts && node --test ./run-dev-live-test''s.mjs", /dev live tests/],
    ["bash -c 'node scripts/run-dev-live-tests.mjs'", /dev live tests/],
    ["node <<'EOF'\nimport('./scripts/run-dev-live-tests.mjs')\nEOF", /dev live tests/],
    // Globs that could expand to the runner.
    ["cd scripts && node run-*.mjs", /could name the dev live-test runner/],
    ["node --test 'scripts/run-*.mjs'", /could name the dev live-test runner/],
    ["node --test scripts/*live*", /could name the dev live-test runner/],
    ["cd scripts && node delete-*.mjs", /account-deletion script/],
    ["node --test 'scripts/*-users.mjs'", /account-deletion script/],
    ["cd scripts && node user-*.mjs", /product-metrics script/],
    ["node 'scripts/*-stats.mjs'", /product-metrics script/],
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
    ["curl file:///etc/passwd", /only fetch http\(s\)/],
    ["curl -s FILE:///etc/hosts", /only fetch http\(s\)/],
    ["curl file:/etc/passwd", /only fetch http\(s\)/],
    ["curl --url file:///etc/passwd", /only fetch http\(s\)/],
    ["curl --url=file:///etc/passwd", /only fetch http\(s\)/],
    ["curl gopher://localhost:6379/_INFO", /only fetch http\(s\)/],
    ["curl http:///x", /may only reach localhost \(no host\)/],
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
    ["cat ~/work/innocent/notes.txt", /drafto-secrets/],
    ["cat ~/.config/gh/hosts.yml", /gh config|\.config/],
    ["ls ~/.ssh", /\.ssh/],
    ["cat ~/.claude/projects/x.jsonl", /\.claude/],
    ["ls ~/Library/Keychains", /Keychains/],
    ["cat apps/web/.env.local", /\.env\.local holds credentials/],
    ["cat apps/mobile/.env.production", /holds credentials/],
    ["cat private/curl.cfg", /curl config/],
    // The signed-out config carries the same bypass header.
    ["cat private/curl-signed-out.cfg", /curl config/],
    ["find .. -name curl-signed-out.cfg -exec cat {} +", /curl config/],
    ["cat $(find ../.. -name curl-signed-out.cfg)", /curl config/],
    ["cat cookies.txt", /curl config/],
    // The opt-in wrappers' configs name the dev key file (ADR-0073).
    ["cat private/dev-inspect.cfg", /curl config|holds credentials/],
    ["cat $(find ../.. -name lane-tests.cfg)", /curl config|holds credentials/],
    ["cat ../*/dev-insp*", /holds credentials|private directory|logs and state/],
    // The wrappers don't open a way to the runner itself.
    ["live-tests storage-quota; pnpm test:live:supabase", /dev live tests/],
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
      ["Grep", { pattern: "x", path: "apps/web", glob: "**/*.ts" }],
      ["Glob", { pattern: "*.json", path: "apps/web" }],
    ]) {
      const d = decidePre({ tool, input, config });
      assert.equal(d.allow, true, `${tool} ${JSON.stringify(input)}: ${d.reason}`);
    }
  });

  it("keeps Read, Grep and Glob out of every protected path, through a symlink too", () => {
    for (const [tool, input, why] of [
      ["Read", { file_path: "~/drafto-secrets/vercel-bypass.env" }, /drafto-secrets/],
      ["Read", { file_path: path.join(home, "work", "innocent", "notes.txt") }, /drafto-secrets/],
      ["Read", { file_path: path.join(config.privateDir, "curl.cfg") }, /private|curl config/],
      [
        "Read",
        { file_path: path.join(config.privateDir, "curl-signed-out.cfg") },
        /private|curl config/,
      ],
      ["Grep", { pattern: "x", path: config.repoRoot, glob: "curl-signed-out.cfg" }, /./],
      ["Glob", { pattern: "**/curl-sig*.cfg" }, /./],
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
      // A Grep glob and a Glob pattern are matched under the tool's path.
      ["Grep", { pattern: "x", path: home, glob: "drafto-sec*/*" }, /drafto-secrets/],
      ["Grep", { pattern: "x", path: "apps/web", glob: ".env*" }, /\.env/],
      ["Glob", { pattern: ".s*/*", path: home }, /off limits/],
      ["Glob", { pattern: "**/.env*" }, /could name \.env/],
      ["Read", { file_path: "~/drafto-secr*/vercel-bypass.env" }, /drafto-secrets|vercel-bypass/],
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

describe("globSegmentRegex / dynamicPathReason", () => {
  it("reads a glob segment the way the shell would, dotfile rule included", () => {
    const m = (g, name) => globSegmentRegex(g).regex.test(name);
    assert.ok(m(".env*", ".env.local"));
    assert.ok(m(".e*", ".env"));
    assert.ok(m("[c]url.cfg", "curl.cfg"));
    assert.ok(m("$X.env", ".env"));
    assert.ok(m("{curl,x}.cfg", "curl.cfg"));
    assert.ok(!m("*", ".env"), "a leading wildcard never matches a dotfile");
    assert.ok(!m("*.ts", "curl.cfg"));
    assert.equal(globSegmentRegex("*").literal, 0);
    assert.equal(globSegmentRegex(".e*").literal, 2);
  });

  it("names the protected root a word's literal prefix could reach", () => {
    assert.match(dynamicPathReason("~/drafto-sec*", config), /drafto-secrets/);
    assert.match(dynamicPathReason("$HOME/.ss?/x", config), /\.ssh/);
    assert.match(dynamicPathReason("KEY=~/drafto-*", config), /drafto-secrets/);
    assert.equal(dynamicPathReason('"$D/key.json"'.replace(/"/g, ""), config), null);
    assert.equal(dynamicPathReason("apps/web/src/*.ts", config), null);
    assert.equal(dynamicPathReason("plain-word", config), null);
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

// ── Device scenario mode (ADR-0106, device-scenario.mjs) ────────────────────

describe("device-scenario mode", () => {
  let dtmp;
  let dcfg;
  let cwd;
  const pre = (tool, input) => decidePre({ tool, input, config: dcfg });
  const sh = (command) => pre("Bash", { command });

  before(() => {
    dtmp = mkdtempSync(path.join(tmpdir(), "verify-guard-device-"));
    const repoRoot = path.join(dtmp, "factory");
    const runDir = path.join(repoRoot, "logs", "factory", "device", "runs", "7-a-20261126T000000Z");
    cwd = path.join(runDir, "scenario-ios");
    for (const d of ["flows", "bin", "examples", "iter-shots", "requests"]) {
      mkdirSync(path.join(cwd, d), { recursive: true });
    }
    writeFileSync(path.join(runDir, "meta.json"), "{}\n");
    writeFileSync(path.join(cwd, "examples", "02-create-notebook.yaml"), "appId: x\n");
    symlinkSync(path.join(runDir, "meta.json"), path.join(cwd, "examples", "leak.yaml"));
    symlinkSync(path.join(runDir, "meta.json"), path.join(cwd, "flows", "09-link.yaml"));
    dcfg = validateConfig({
      runDir: cwd,
      worktree: cwd,
      repoRoot,
      home: path.join(dtmp, "home"),
      mode: DEVICE_SCENARIO_MODE,
    });
  });
  after(() => rmSync(dtmp, { recursive: true, force: true }));

  it("Write: only flows/NN-<slug>.yaml in the run's dir, plain files, under 20 KB", () => {
    const content = "appId: eu.drafto.mobile\n---\n- back\n";
    assert.equal(
      pre("Write", { file_path: path.join(cwd, "flows", "01-x.yaml"), content }).allow,
      true,
    );
    assert.equal(pre("Write", { file_path: "flows/02-make-note.yaml", content }).allow, true);
    for (const file_path of [
      `${cwd}/flows/../flows/01-x.yaml`,
      path.join(cwd, "examples", "01-x.yaml"),
      path.join(cwd, "bin", "device-run"),
      path.join(cwd, "requests", "1.result.json"),
      path.join(cwd, "flows", "x.yaml"),
      path.join(cwd, "flows", "01-X.yaml"),
      path.join(cwd, "flows", "01-x.yml"),
      path.join(cwd, "flows", "sub", "01-x.yaml"),
      path.join(cwd, "01-x.yaml"),
      "/tmp/01-x.yaml",
      path.join(cwd, "flows", "09-link.yaml"),
    ]) {
      assert.equal(pre("Write", { file_path, content }).allow, false, file_path);
    }
    const big = "x".repeat(20 * 1024 + 1);
    assert.equal(pre("Write", { file_path: "flows/01-x.yaml", content: big }).allow, false);
    assert.equal(pre("Write", { file_path: "flows/01-x.yaml" }).allow, false);
  });

  it("Write is refused when flows/ is a symlink out of the dir", () => {
    const other = path.join(dtmp, "other");
    const cwd2 = path.join(dtmp, "scenario-android");
    mkdirSync(other, { recursive: true });
    mkdirSync(cwd2, { recursive: true });
    symlinkSync(other, path.join(cwd2, "flows"));
    const cfg2 = validateConfig({ ...dcfg, runDir: cwd2, worktree: cwd2 });
    const r = decidePre({
      tool: "Write",
      input: { file_path: path.join(cwd2, "flows", "01-x.yaml"), content: "x" },
      config: cfg2,
    });
    assert.equal(r.allow, false);
  });

  it("Edit, NotebookEdit, WebFetch, WebSearch and unknown tools stay denied", () => {
    for (const tool of ["Edit", "NotebookEdit", "WebFetch", "WebSearch", "Task", "MultiEdit"]) {
      assert.equal(pre(tool, { file_path: "flows/01-x.yaml" }).allow, false, tool);
    }
  });

  it("Bash: only device-run on a flow, or --wait, exactly", () => {
    for (const command of [
      "device-run flows/01-x.yaml",
      "device-run flows/02-create-notebook.yaml",
      "device-run --wait 3",
    ]) {
      assert.equal(sh(command).allow, true, command);
    }
  });

  it("Bash: every other command and any shell syntax is denied", () => {
    for (const command of [
      // Read-only commands are gone too: the session reads with Read/Grep/Glob.
      "ls -la flows",
      "cat flows/01-x.yaml",
      "grep -rn tapOn examples",
      // The review's escapes.
      "sort --compress-program sh flows/01-x.yaml",
      "sort --files0-from=flows/01-x.yaml",
      "sort --out=bin/device-run flows/01-x.yaml",
      "grep -r . .{.,}/private",
      "ls ../*",
      // device-run, but not exactly.
      "device-run ./flows/01-x.yaml",
      `${path.join(cwd, "bin", "device-run")} flows/01-x.yaml`,
      "device-run  flows/01-x.yaml",
      " device-run flows/01-x.yaml",
      "device-run flows/01-x.yaml ",
      "device-run flows/01-x.yaml\n",
      "device-run flows/01-x.yaml; ls",
      "device-run flows/01-x.yaml && ls",
      "device-run flows/01-x.yaml | cat",
      "device-run flows/01-x.yaml > /dev/null",
      "device-run flows/01-x.yaml #",
      "device-run 'flows/01-x.yaml'",
      "device-run flows/0?-x.yaml",
      "device-run flows/*.yaml",
      "device-run flows/{01,02}-x.yaml",
      "device-run $(echo flows/01-x.yaml)",
      "device-run flows/01-x.yaml extra",
      "device-run examples/02-create-notebook.yaml",
      "device-run flows/../../meta.json",
      "device-run flows/sub/01-x.yaml",
      "device-run --wait 0",
      "device-run --wait 3 4",
      "device-run",
      // Device tools, the network, ps.
      "maestro test flows/01-x.yaml",
      "adb shell input tap 1 1",
      "xcrun simctl io booted screenshot x.png",
      "emulator -list-avds",
      "gradle tasks",
      "xcodebuild -list",
      "curl https://example.com",
      "ps eww",
      "env",
    ]) {
      assert.equal(sh(command).allow, false, JSON.stringify(command));
    }
  });

  it("Read, Grep and Glob only inside flows/, examples/, helpers/ and iter-shots/", () => {
    assert.equal(pre("Read", { file_path: path.join(cwd, "flows", "01-x.yaml") }).allow, true);
    assert.equal(pre("Read", { file_path: "iter-shots/1-01-x.png" }).allow, true);
    assert.equal(pre("Read", { file_path: "examples/02-create-notebook.yaml" }).allow, true);
    assert.equal(pre("Grep", { pattern: "tapOn", path: "examples" }).allow, true);
    assert.equal(pre("Grep", { pattern: "tapOn", path: "examples", glob: "*.yaml" }).allow, true);
    assert.equal(pre("Glob", { pattern: "flows/*.yaml" }).allow, true);
    assert.equal(pre("Glob", { pattern: "**/*.yaml", path: "examples" }).allow, true);
    assert.equal(pre("Glob", { pattern: `${cwd}/iter-shots/*.png` }).allow, true);
    for (const [tool, input] of [
      ["Read", { file_path: path.join(cwd, "..", "meta.json") }],
      ["Read", { file_path: "../meta.json" }],
      ["Read", { file_path: "/etc/hosts" }],
      // A symlink out, a brace expansion, the supervisor's own dirs.
      ["Read", { file_path: "examples/leak.yaml" }],
      ["Read", { file_path: ".{.,}/private/x" }],
      ["Read", { file_path: "private/curl.cfg" }],
      ["Read", { file_path: "requests/1.result.json" }],
      ["Read", { file_path: "bin/device-run" }],
      ["Read", { file_path: "flows" + "/../../meta.json" }],
      ["Read", { file_path: "~/drafto-secrets/x" }],
      ["Read", { file_path: "$HOME/x" }],
      ["Grep", { pattern: "x", path: "/" }],
      ["Grep", { pattern: "x" }],
      ["Grep", { pattern: "x", path: "requests" }],
      ["Grep", { pattern: "x", path: "examples", glob: "../*" }],
      ["Grep", { pattern: "x", path: "examples", glob: "{a,b}" }],
      ["Glob", { pattern: "../**" }],
      ["Glob", { pattern: "**/../*" }],
      ["Glob", { pattern: "flows/**/../../private/*" }],
      ["Glob", { pattern: ".{.,}/private/*" }],
      ["Glob", { pattern: "**/*.yaml" }],
      ["Glob", { pattern: "*" }],
      ["Glob", { pattern: "private/*" }],
      ["Glob", { pattern: "/Users/*" }],
    ]) {
      assert.equal(pre(tool, input).allow, false, `${tool} ${JSON.stringify(input)}`);
    }
  });

  it("Write accepts the directory's real path too", () => {
    const real = realpathSync(cwd);
    const content = "appId: eu.drafto.mobile\n---\n- back\n";
    assert.equal(
      pre("Write", { file_path: path.join(real, "flows", "03-real.yaml"), content }).allow,
      true,
    );
    assert.equal(
      pre("Write", { file_path: path.join(real, "examples", "03-real.yaml"), content }).allow,
      false,
    );
  });

  it("the settings keep every tool but Write removed", () => {
    const s = buildGuardSettings({
      nodePath: "/n",
      guardPath: "/g",
      configPath: "/c",
      mode: DEVICE_SCENARIO_MODE,
    });
    assert.deepEqual(
      s.permissions.deny,
      ALWAYS_DENY_TOOLS.filter((t) => t !== "Write"),
    );
    assert.ok(s.permissions.deny.includes("Edit"));
    assert.throws(() =>
      buildGuardSettings({ nodePath: "/n", guardPath: "/g", configPath: "/c", mode: "x" }),
    );
  });

  it("an unknown mode is refused; the shell lane's config has none", () => {
    assert.throws(() => validateConfig({ ...dcfg, mode: "anything" }), /mode/);
    assert.equal(Object.hasOwn(config, "mode"), false);
    assert.equal(dcfg.mode, DEVICE_SCENARIO_MODE);
  });

  it("shell mode is unchanged: Write and device-run get the shell lane's answers", () => {
    assert.equal(
      decidePre({ tool: "Write", input: { file_path: "x", content: "y" }, config }).allow,
      false,
    );
    assert.deepEqual(
      buildGuardSettings({ nodePath: "/n", guardPath: "/g", configPath: "/c" }).permissions.deny,
      [...ALWAYS_DENY_TOOLS],
    );
    // The shell lane's own rules, not the scenario mode's allowlist.
    assert.equal(bash("ls ~/work").allow, true);
    assert.equal(bash("maestro test x.yaml").allow, false);
    assert.equal(bash("adb devices").allow, false);
  });

  it("writeGuardFiles writes a scenario session's files where it is told", () => {
    const filesDir = path.join(dtmp, "guard-files");
    mkdirSync(filesDir, { recursive: true });
    const r = writeGuardFiles({
      runDir: cwd,
      worktree: cwd,
      repoRoot: dcfg.repoRoot,
      home: dcfg.home,
      mode: DEVICE_SCENARIO_MODE,
      filesDir,
      logDir: path.join(filesDir, "log"),
    });
    assert.equal(path.dirname(r.configPath), filesDir);
    const written = JSON.parse(readFileSync(r.configPath, "utf8"));
    assert.equal(written.mode, DEVICE_SCENARIO_MODE);
    assert.equal(written.logDir, path.join(filesDir, "log"));
    const settings = JSON.parse(readFileSync(r.settingsPath, "utf8"));
    assert.equal(settings.permissions.deny.includes("Write"), false);
  });
});
