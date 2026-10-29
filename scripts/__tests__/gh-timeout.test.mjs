// Every gh call the factory makes is capped (#748: one `gh issue comment`
// sat idle for 2+ days and froze the whole factory). Covers the shared knob
// (lib/gh-timeout.mjs), the node runners that pass it to execFile, and
// factory-agent.sh's gh() wrapper, run for real in bash against a fake gh.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GH_TIMEOUT_SEC_DEFAULT, ghTimeoutMs } from "../lib/gh-timeout.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const scriptsDir = resolve(__dirname, "..");
const agentPath = join(scriptsDir, "factory-agent.sh");

describe("ghTimeoutMs", () => {
  it("defaults to 120 s when FACTORY_GH_TIMEOUT_SEC is unset", () => {
    assert.equal(GH_TIMEOUT_SEC_DEFAULT, 120);
    assert.equal(ghTimeoutMs({}), 120_000);
  });

  it("uses a valid override", () => {
    assert.equal(ghTimeoutMs({ FACTORY_GH_TIMEOUT_SEC: "45" }), 45_000);
    assert.equal(ghTimeoutMs({ FACTORY_GH_TIMEOUT_SEC: "99999" }), 99_999_000);
  });

  // 100000+ is refused: from 2147484 s node's timer overflows to 1 ms.
  for (const bad of ["", "0", "-5", "1.5", "abc", "12s", " 30", "100000", "2147484"]) {
    it(`falls back to the default for ${JSON.stringify(bad)}`, () => {
      assert.equal(ghTimeoutMs({ FACTORY_GH_TIMEOUT_SEC: bad }), 120_000);
    });
  }
});

// The fake execFile records its options, then fails with a non-transient error
// so runGh throws at once and no response shape is needed.
async function execFileOptsFor(modulePath, call) {
  const lib = await import(`${modulePath}?t=${Date.now()}-${Math.random()}`);
  const seen = [];
  lib._setSleepForTests(async () => {});
  lib._setExecFileForTests(async (cmd, args, opts) => {
    seen.push({ cmd, opts });
    throw new Error("boom");
  });
  await assert.rejects(() => call(lib), /boom/);
  return seen;
}

describe("factory-project runGh passes the cap to execFile", () => {
  it("sets timeout and a SIGKILL killSignal", async () => {
    const seen = await execFileOptsFor("../lib/factory-project.mjs", (lib) =>
      lib.getStatusFieldMeta("PVT_x"),
    );
    assert.equal(seen.length, 1);
    assert.equal(seen[0].cmd, "gh");
    assert.equal(seen[0].opts.timeout, ghTimeoutMs());
    assert.equal(seen[0].opts.killSignal, "SIGKILL");
  });
});

// The real deps.gh against a fake gh that never returns, with a 1 s cap.
async function withHungGhOnPath(fn) {
  const saved = { PATH: process.env.PATH, cap: process.env.FACTORY_GH_TIMEOUT_SEC };
  const dir = mkdtempSync(join(tmpdir(), "gh-timeout-deps-"));
  try {
    writeFileSync(join(dir, "gh"), "#!/bin/bash\nexec sleep 60\n");
    chmodSync(join(dir, "gh"), 0o755);
    process.env.PATH = `${dir}:${saved.PATH}`;
    process.env.FACTORY_GH_TIMEOUT_SEC = "1";
    return await fn();
  } finally {
    process.env.PATH = saved.PATH;
    if (saved.cap == null) delete process.env.FACTORY_GH_TIMEOUT_SEC;
    else process.env.FACTORY_GH_TIMEOUT_SEC = saved.cap;
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("createDeps().gh is capped", () => {
  for (const mod of ["coderabbit-cli", "verify-lane"]) {
    it(`${mod}: a hung gh is killed at the cap`, async () => {
      const { createDeps } = await import(`../lib/${mod}.mjs`);
      const started = Date.now();
      const res = await withHungGhOnPath(() => createDeps().gh(["api", "user"]));
      assert.equal(res.code, 124);
      assert.equal(res.timedOut, true);
      assert.ok(Date.now() - started < 15_000, `took ${Date.now() - started}ms`);
    });
  }
});

function extract(awkProgram) {
  return `eval "$(awk '${awkProgram}' "${agentPath}")"`;
}

const GH_FN = extract("/^gh\\(\\)/{f=1} f{print} f&&/^}/{exit}");
const KNOB = extract(
  "/^FACTORY_GH_TIMEOUT_SEC=/{f=1} f{print} /^export FACTORY_GH_TIMEOUT_SEC$/{exit}",
);

function withFakeGh(body, fn) {
  const dir = mkdtempSync(join(tmpdir(), "gh-timeout-"));
  try {
    const ghPath = join(dir, "gh");
    writeFileSync(ghPath, `#!/bin/bash\n${body}\n`);
    chmodSync(ghPath, 0o755);
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runBash(script, { binDir, env = {}, input } = {}) {
  return spawnSync("bash", ["-c", script], {
    encoding: "utf8",
    input,
    env: {
      ...process.env,
      PATH: binDir ? `${binDir}:${process.env.PATH}` : process.env.PATH,
      SCRIPT_DIR: scriptsDir,
      ...env,
    },
  });
}

describe("factory-agent.sh gh() wrapper", () => {
  it("passes args, stdin, stdout and the exit code through", () => {
    withFakeGh('printf "args:%s\\n" "$*"; printf "stdin:%s\\n" "$(cat)"; exit 3', (binDir) => {
      const res = runBash(`${GH_FN}\nprintf hello | gh issue comment 9 --body-file -`, {
        binDir,
        env: { FACTORY_GH_TIMEOUT_SEC: "30" },
      });
      assert.equal(res.status, 3, res.stderr);
      assert.equal(res.stdout, "args:issue comment 9 --body-file -\nstdin:hello\n");
    });
  });

  it("kills a hung gh at the cap and exits 124", () => {
    withFakeGh("exec sleep 60", (binDir) => {
      const started = Date.now();
      const res = runBash(`${GH_FN}\ngh issue comment 748 --body-file x`, {
        binDir,
        env: { FACTORY_GH_TIMEOUT_SEC: "1" },
      });
      const elapsedMs = Date.now() - started;
      assert.equal(res.status, 124, res.stderr);
      assert.match(res.stderr, /wall-time cap reached/);
      // Names the subcommand, never the later args (they can carry bodies).
      assert.match(res.stderr, /WARNING: gh issue comment timed out after 1s\n/);
      assert.doesNotMatch(res.stderr, /748/);
      assert.ok(elapsedMs < 15_000, `took ${elapsedMs}ms`);
    });
  });

  it("is what $(…) capture calls too", () => {
    withFakeGh('echo "from-fake:$1"', (binDir) => {
      const res = runBash(`${GH_FN}\nout=$(gh api)\necho "got:$out"`, {
        binDir,
        env: { FACTORY_GH_TIMEOUT_SEC: "30" },
      });
      assert.equal(res.status, 0, res.stderr);
      assert.equal(res.stdout, "got:from-fake:api\n");
    });
  });
});

describe("FACTORY_GH_TIMEOUT_SEC validation in factory-agent.sh", () => {
  const show = `${KNOB}\necho "$FACTORY_GH_TIMEOUT_SEC"; bash -c 'echo "child:$FACTORY_GH_TIMEOUT_SEC"'`;

  it("defaults to 120 and exports it", () => {
    const env = { ...process.env };
    delete env.FACTORY_GH_TIMEOUT_SEC;
    const res = spawnSync("bash", ["-c", show], { encoding: "utf8", env });
    assert.equal(res.stdout, "120\nchild:120\n");
  });

  it("keeps a valid override", () => {
    const res = runBash(show, { env: { FACTORY_GH_TIMEOUT_SEC: "45" } });
    assert.equal(res.stdout, "45\nchild:45\n");
  });

  for (const bad of ["2m", "100000"]) {
    it(`warns and falls back to 120 on ${JSON.stringify(bad)}`, () => {
      const res = runBash(show, { env: { FACTORY_GH_TIMEOUT_SEC: bad } });
      assert.equal(res.stdout, "120\nchild:120\n");
      assert.match(
        res.stderr,
        new RegExp(`invalid FACTORY_GH_TIMEOUT_SEC='${bad}'; defaulting to 120`),
      );
    });
  }
});

// The gh() function satisfies `command -v gh`, so a check for the binary must
// use `type -P`.
describe("factory-agent.sh gh binary checks", () => {
  const code = readFileSync(agentPath, "utf8")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"));

  it("never tests for gh with `command -v gh`", () => {
    assert.deepEqual(
      code.filter((line) => /command -v gh\b/.test(line)),
      [],
    );
  });

  it("checks every `for required in …` loop that lists gh with type -P", () => {
    const loops = code
      .map((line, i) => ({ line, next: code[i + 1] ?? "" }))
      .filter(({ line }) => /^\s*for required in .*\bgh\b/.test(line));
    assert.ok(loops.length > 0, "expected the pre-flight loop over gh");
    for (const { next } of loops) {
      assert.match(next, /type -P "\$required"/);
      assert.doesNotMatch(next, /command -v/);
    }
  });
});
