// Maestro runs the flows of a folder (`maestro test apps/mobile/e2e/android-only/`)
// in no fixed order, and some of them leave the device signed out:
// android-only/07-auth-callback-link.yaml starts clean and stays on Log In. A
// platform flow that only launches the app and waits for the Notebooks screen
// then fails whenever it runs after one of those (#870). So every flow in
// android-only/ and ios-only/ must set up its own auth state before it uses the
// app: through helpers/sign-in-if-needed.yaml, with a clean start of its own
// (clearState), with its own sign-in branch on Log In, or by running a sibling
// flow that does one of these.
//
// Maestro itself never runs in CI, so this static check is what catches a new
// flow that forgets. The flows are read with Node's fs through jest, because the
// mobile tsconfig has no Node types (as in app-links-config.test.ts). They live in
// this package, so turbo's default test inputs already cover them.
interface ReadFs {
  readFileSync(path: string, encoding: "utf8"): string;
  readdirSync(path: string): string[];
  existsSync(path: string): boolean;
}

const fs = jest.requireActual<ReadFs>("fs");

const E2E_DIR = (expect.getState().testPath ?? "").replace(/__tests__\/.*$/, "e2e");
const PLATFORM_DIRS = ["android-only", "ios-only"] as const;
const HELPER = "helpers/sign-in-if-needed.yaml";

const LAUNCH = /^\s*-\s*launchApp\b/;
// `- clearState`, or `clearState: true` under `- launchApp:`.
const CLEAR_STATE = /^\s*(-\s*clearState\b|clearState:\s*true\s*$)/;
// `- runFlow: <file>`, or `file: <file>` under `- runFlow:`.
const RUNS_HELPER =
  /^\s*(-\s*runFlow|file):\s*["']?\.\.\/helpers\/sign-in-if-needed\.yaml["']?\s*$/;
const RUNS_SIBLING = /^\s*(?:-\s*runFlow|file):\s*["']?([\w.-]+\.yaml)["']?\s*$/;
// The first step that needs the signed-in app.
const USES_SESSION = /id:\s*"search-button"|visible:\s*"Notebooks"/;
const WHEN = /^\s*when:\s*$/;
const VISIBLE_LOG_IN = /^\s*visible:\s*"Log In"\s*$/;
const LOGIN_BUTTON = /^\s*id:\s*"login-button"\s*$/;

// The flow's commands only: the flows' comments name these commands too, and
// the config header above `---` holds hooks such as onFlowComplete, which run
// after the flow, not before it.
function commandLines(source: string): string[] {
  const lines = source.split("\n");
  const separator = lines.findIndex((line) => line.trim() === "---");
  return lines
    .slice(separator + 1)
    .filter((line) => !line.trim().startsWith("#"))
    .map((line) => line.replace(/\s+#\s.*$/, ""));
}

function firstIndex(lines: string[], pattern: RegExp): number {
  return lines.findIndex((line) => pattern.test(line));
}

const indent = (line: string) => line.length - line.trimStart().length;

// `- launchApp:` whose own options (the lines indented under it) include clearState: true.
function launchClearsState(lines: string[], launch: number): boolean {
  if (launch === -1 || !/launchApp:\s*$/.test(lines[launch])) return false;
  const options = [];
  for (const line of lines.slice(launch + 1)) {
    if (line.trim() !== "" && indent(line) <= indent(lines[launch])) break;
    options.push(line);
  }
  return options.some((line) => CLEAR_STATE.test(line));
}

function signInBranchIndex(lines: string[]): number {
  const branch = lines.findIndex(
    (line, i) => WHEN.test(line) && VISIBLE_LOG_IN.test(lines[i + 1] ?? ""),
  );
  return branch !== -1 && lines.slice(branch).some((line) => LOGIN_BUTTON.test(line)) ? branch : -1;
}

function hasOwnSignInBranch(lines: string[]): boolean {
  return signInBranchIndex(lines) !== -1;
}

type ReadFlow = (name: string) => string | null;

// Why the flow starts from a known auth state, or null when it doesn't.
function authSetup(source: string, readSibling: ReadFlow, seen = new Set<string>()): string | null {
  const lines = commandLines(source);
  const launch = firstIndex(lines, LAUNCH);
  const firstUse = firstIndex(lines, USES_SESSION);
  const aheadOfUse = (index: number) => firstUse === -1 || index < firstUse;
  // Setup counts only ahead of both the first launch and the first step that
  // needs a session: a flow without a launchApp can still wait for Notebooks.
  const before = (index: number) =>
    index !== -1 && (launch === -1 || index < launch) && aheadOfUse(index);

  if (before(firstIndex(lines, RUNS_HELPER))) return "runs the sign-in helper first";
  if (
    before(firstIndex(lines, CLEAR_STATE)) ||
    (launchClearsState(lines, launch) && aheadOfUse(launch))
  ) {
    return "starts clean (clearState)";
  }

  // Its own sign-in: after the launch, before the first step that needs a session.
  const branch = signInBranchIndex(lines);
  if (launch !== -1 && branch > launch && aheadOfUse(branch)) {
    return "signs in on Log In itself";
  }

  for (const [index, line] of lines.entries()) {
    const sibling = RUNS_SIBLING.exec(line)?.[1];
    if (!before(index)) continue;
    if (!sibling || seen.has(sibling)) continue;
    seen.add(sibling);
    const siblingSource = readSibling(sibling);
    const reason = siblingSource === null ? null : authSetup(siblingSource, readSibling, seen);
    if (reason) return `runs ${sibling}, which ${reason}`;
  }
  return null;
}

function platformFlows(): { dir: string; file: string }[] {
  return PLATFORM_DIRS.flatMap((dir) =>
    fs
      .readdirSync(`${E2E_DIR}/${dir}`)
      .filter((file) => file.endsWith(".yaml"))
      .sort()
      .map((file) => ({ dir, file })),
  );
}

function readFlow(dir: string, file: string): string | null {
  const path = `${E2E_DIR}/${dir}/${file}`;
  return fs.existsSync(path) ? fs.readFileSync(path, "utf8") : null;
}

describe("platform E2E flows start from a known auth state (#870)", () => {
  it("finds the platform flows", () => {
    const flows = platformFlows();
    expect(flows.some((f) => f.dir === "android-only")).toBe(true);
    expect(flows.some((f) => f.dir === "ios-only")).toBe(true);
  });

  it.each(platformFlows().map((f) => [`${f.dir}/${f.file}`, f] as const))(
    "%s signs in when needed or starts clean",
    (_name, { dir, file }) => {
      const source = readFlow(dir, file) ?? "";
      const reason = authSetup(source, (sibling) => readFlow(dir, sibling));
      if (reason === null) {
        throw new Error(
          `${dir}/${file} uses the app without setting up its auth state, so it fails when ` +
            "a folder run puts it after a flow that signs out. Start it with " +
            `\`- runFlow: ../${HELPER}\` instead of a bare launchApp.`,
        );
      }
      expect(reason).toEqual(expect.any(String));
    },
  );
});

describe(HELPER, () => {
  const source = fs.readFileSync(`${E2E_DIR}/${HELPER}`, "utf8");
  const lines = commandLines(source);
  const indexOf = (pattern: RegExp) => firstIndex(lines, pattern);

  it("launches the app as its first command", () => {
    const commands = lines.slice(lines.findIndex((line) => line.trim() === "---") + 1);
    const first = commands.find((line) => line.trim() !== "");
    expect(first).toMatch(LAUNCH);
  });

  it("never drops the session the device already has", () => {
    expect(indexOf(CLEAR_STATE)).toBe(-1);
    expect(indexOf(/^\s*-\s*clearKeychain\b/)).toBe(-1);
  });

  it("waits for either screen before it decides", () => {
    expect(source).toMatch(/visible:\s*"Log In\|Notebooks"/);
  });

  it("checks the credentials only on Log In, before typing them", () => {
    expect(hasOwnSignInBranch(lines)).toBe(true);
    const branch = lines.findIndex(
      (line, i) => WHEN.test(line) && VISIBLE_LOG_IN.test(lines[i + 1] ?? ""),
    );
    const guard = indexOf(/^\s*-\s*assertTrue:\s*$/);
    const email = indexOf(/inputText:\s*\$\{E2E_TEST_EMAIL\}/);
    expect(branch).toBeGreaterThan(indexOf(LAUNCH));
    expect(guard).toBeGreaterThan(branch);
    expect(email).toBeGreaterThan(guard);
    expect(lines[guard + 1]).toMatch(/typeof E2E_TEST_EMAIL !== 'undefined'/);
    expect(lines[guard + 1]).toMatch(/typeof MAESTRO_E2E_TEST_PASSWORD !== 'undefined'/);
    // An empty `-e E2E_TEST_EMAIL=` must fail the guard too.
    expect(lines[guard + 1]).toMatch(/E2E_TEST_EMAIL !== ''/);
  });

  it("finds each field by id and erases it before typing, so a retry starts from empty fields", () => {
    const email = indexOf(/inputText:\s*\$\{E2E_TEST_EMAIL\}/);
    const password = indexOf(/inputText:\s*".*E2E_TEST_PASSWORD/);
    for (const [input, id] of [
      [email, "email-input"],
      [password, "password-input"],
    ] as const) {
      expect(lines[input - 1]).toMatch(/^\s*-\s*eraseText\s*$/);
      expect(lines[input - 2]).toMatch(new RegExp(`^\\s*id:\\s*"${id}"\\s*$`));
      expect(lines[input - 3]).toMatch(/^\s*-\s*tapOn:\s*$/);
    }
  });

  it("takes the password from -e or from MAESTRO_E2E_TEST_PASSWORD", () => {
    expect(source).toContain(
      "${typeof E2E_TEST_PASSWORD !== 'undefined' && E2E_TEST_PASSWORD !== '' ? E2E_TEST_PASSWORD : MAESTRO_E2E_TEST_PASSWORD}",
    );
  });

  it("retries the sign-in a bounded number of times", () => {
    expect(indexOf(/^\s*-\s*retry:\s*$/)).toBeGreaterThan(-1);
    expect(source).toMatch(/maxRetries:\s*2\b/);
  });

  it("ends on the Notebooks tab", () => {
    const searchButton = lines.findIndex((line) => /id:\s*"search-button"/.test(line));
    expect(searchButton).toBeGreaterThan(indexOf(/^\s*-\s*retry:\s*$/));
  });
});

describe("authSetup", () => {
  const noSiblings: ReadFlow = () => null;

  it("rejects a flow that only launches the app and waits for the Notebooks screen", () => {
    const flow = [
      "appId: eu.drafto.mobile",
      "---",
      "# clearState is only mentioned in this comment",
      "- launchApp",
      "- extendedWaitUntil:",
      "    visible:",
      '      id: "search-button"',
      "    timeout: 30000",
    ].join("\n");
    expect(authSetup(flow, noSiblings)).toBeNull();
  });

  it("ignores setup in the config header, which runs after the flow", () => {
    const flow = [
      "appId: eu.drafto.mobile",
      "onFlowComplete:",
      "  - clearState",
      `  - runFlow: ../${HELPER}`,
      "---",
      "- launchApp",
    ].join("\n");
    expect(authSetup(flow, noSiblings)).toBeNull();
  });

  it("rejects a sign-in branch or a sibling flow that comes only after the app is used", () => {
    const lateBranch = [
      "---",
      "- launchApp",
      "- extendedWaitUntil:",
      "    visible:",
      '      id: "search-button"',
      "- runFlow:",
      "    when:",
      '      visible: "Log In"',
      "    commands:",
      "      - tapOn:",
      '          id: "login-button"',
    ].join("\n");
    expect(authSetup(lateBranch, noSiblings)).toBeNull();
    const cleanSibling: ReadFlow = () => "---\n- clearState\n- launchApp";
    expect(authSetup("---\n- launchApp\n- runFlow: a.yaml", cleanSibling)).toBeNull();
  });

  it("accepts the long forms: launchApp with clearState, runFlow with file", () => {
    expect(authSetup("---\n- launchApp:\n    clearState: true", noSiblings)).toBe(
      "starts clean (clearState)",
    );
    expect(authSetup(`---\n- runFlow:\n    file: ../${HELPER} # signs in`, noSiblings)).toBe(
      "runs the sign-in helper first",
    );
  });

  it("rejects setup that comes only after the app is used, in a flow without a launchApp", () => {
    const waitThen = (setup: string) =>
      ["---", "- extendedWaitUntil:", "    visible:", '      id: "search-button"', setup].join(
        "\n",
      );
    expect(authSetup(waitThen(`- runFlow: ../${HELPER}`), noSiblings)).toBeNull();
    expect(authSetup(waitThen("- clearState"), noSiblings)).toBeNull();
    const cleanSibling: ReadFlow = () => "---\n- clearState\n- launchApp";
    expect(authSetup(waitThen("- runFlow: a.yaml"), cleanSibling)).toBeNull();
  });

  it("rejects a helper that runs only after a bare launch", () => {
    const flow = ["---", "- launchApp", `- runFlow: ../${HELPER}`].join("\n");
    expect(authSetup(flow, noSiblings)).toBeNull();
  });

  it("accepts the helper, a clean start and an own sign-in branch", () => {
    expect(
      authSetup(["---", `- runFlow: ../${HELPER}`, "- launchApp"].join("\n"), noSiblings),
    ).toBe("runs the sign-in helper first");
    expect(authSetup(["---", "- clearState", "- launchApp"].join("\n"), noSiblings)).toBe(
      "starts clean (clearState)",
    );
    const ownBranch = [
      "---",
      "- launchApp",
      "- runFlow:",
      "    when:",
      '      visible: "Log In"',
      "    commands:",
      "      - tapOn:",
      '          id: "login-button"',
    ].join("\n");
    expect(authSetup(ownBranch, noSiblings)).toBe("signs in on Log In itself");
  });

  it("accepts a flow that runs a sibling which starts clean, and stops on a cycle", () => {
    const siblings: Record<string, string> = {
      "a.yaml": ["---", "- clearState", "- launchApp"].join("\n"),
      "b.yaml": ["---", "- runFlow: c.yaml"].join("\n"),
      "c.yaml": ["---", "- runFlow: b.yaml"].join("\n"),
    };
    const read: ReadFlow = (name) => siblings[name] ?? null;
    expect(authSetup("---\n- runFlow: a.yaml", read)).toBe(
      "runs a.yaml, which starts clean (clearState)",
    );
    expect(authSetup("---\n- runFlow: b.yaml", read)).toBeNull();
    expect(authSetup("---\n- runFlow: missing.yaml", read)).toBeNull();
  });
});
