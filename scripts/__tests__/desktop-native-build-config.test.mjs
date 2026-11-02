import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The macOS build config after #558 (ADR-0067). Desktop runs react-native-macos
// 0.83 on the monorepo's single React 19.2 and react-native 0.83, installed by a
// plain `pnpm install`. None of this can be checked by CI, which never builds
// macOS, so these are source-level invariants:
//
//   - The build reads rnm's scripts from the hoisted node_modules/react-native-macos,
//     never from a per-app apps/desktop/node_modules/react-native (which a clean
//     install does not create, so the Hermes phase failed to find with-environment.sh).
//   - rnm is exact-pinned, and its native fixes live in a pnpm patch under a range
//     key, not in a runtime swizzle compiled into the app (ADR-0063, retired).
//   - The Fastfile refuses a stale dependency graph and a stale NODE_BINARY before
//     CocoaPods runs.
//   - rnm, react-native and desktop's @react-native/* tooling share one Dependabot
//     group, outside minor-and-patch: the peer check below fails when they disagree.
//     That group's PR is how rnm releases are tracked.

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (path) => readFileSync(resolve(root, path), "utf8");
const readJson = (path) => JSON.parse(read(path));

const PODFILE = "apps/desktop/macos/Podfile";
const PBXPROJ = "apps/desktop/macos/Drafto.xcodeproj/project.pbxproj";
const KEYBOARD_GUARD_MM = "apps/desktop/macos/Drafto-macOS/DraftoKeyboardEventGuard.mm";
const FASTFILE = "apps/desktop/fastlane/Fastfile";
const DEPENDABOT = ".github/dependabot.yml";

const desktop = readJson("apps/desktop/package.json");
const mobile = readJson("apps/mobile/package.json");
const rootPkg = readJson("package.json");

const depOf = (pkg, name) => pkg.dependencies?.[name] ?? pkg.devDependencies?.[name];
const EXACT = /^\d+\.\d+\.\d+$/;

// `~X.Y.Z` covers V when V has the same major.minor and a patch >= Z.
function tildeCovers(range, version) {
  const r = /^~(\d+)\.(\d+)\.(\d+)$/.exec(range);
  const v = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!r || !v) return false;
  return r[1] === v[1] && r[2] === v[2] && Number(v[3]) >= Number(r[3]);
}

// Dependabot's dependency-name / exclude-patterns glob: `*` matches any run of characters.
const globMatches = (pattern, name) =>
  new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\/]/g, "\\$&").replace(/\*/g, ".*")}$`).test(name);

// The lines indented deeper than the first line matching `header`, i.e. its YAML block.
function yamlBlock(text, header) {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => header.test(line));
  assert.notEqual(start, -1, `no ${header} block in ${DEPENDABOT}`);
  const indent = lines[start].search(/\S/);
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    if (line.search(/\S/) <= indent) break;
    body.push(line);
  }
  return body;
}

const unquote = (s) => s.trim().replace(/^["']|["']$/g, "");

describe("desktop native build reads the hoisted react-native-macos", () => {
  it("the Podfile passes rnm's path to react_native_post_install", () => {
    assert.match(
      read(PODFILE),
      /react_native_post_install\(\s*installer\s*,\s*'\.\.\/\.\.\/\.\.\/node_modules\/react-native-macos'\s*\)/,
      "a no-arg react_native_post_install defaults REACT_NATIVE_PATH to apps/desktop/node_modules/react-native",
    );
  });

  it("every REACT_NATIVE_PATH in Drafto.xcodeproj points at node_modules/react-native-macos", () => {
    const values = [...read(PBXPROJ).matchAll(/REACT_NATIVE_PATH = "?([^";\n]+)"?;/g)].map(
      (m) => m[1],
    );
    assert.ok(values.length >= 2, `expected Debug and Release REACT_NATIVE_PATH, got ${values}`);
    for (const value of values) {
      assert.equal(value, "${PODS_ROOT}/../../../../node_modules/react-native-macos");
    }
  });

  it("nothing references the per-app node_modules/react-native", () => {
    for (const path of [PODFILE, PBXPROJ]) {
      // Ruby comments may name the old default to explain the change; code may not.
      const code = read(path)
        .split("\n")
        .filter((line) => !line.trim().startsWith("#"))
        .join("\n");
      assert.ok(
        !/\$\{PODS_ROOT\}\/\.\.\/\.\.\/node_modules\/react-native(?!-)/.test(code),
        `${path} still references \${PODS_ROOT}/../../node_modules/react-native`,
      );
    }
  });
});

describe("desktop's React Native dependency set", () => {
  it("desktop's react-native equals mobile's", () => {
    assert.ok(depOf(desktop, "react-native"), "desktop declares no react-native");
    assert.equal(depOf(desktop, "react-native"), depOf(mobile, "react-native"));
  });

  it("react-native and the @react-native/* tooling match the react-native rnm peers", () => {
    // The lockfile's packages entry for the pinned rnm carries its exact react-native
    // peer. A group bump that moves react-native or one @react-native/* package alone
    // would otherwise build a mixed graph that CI can't catch (CI doesn't build macOS).
    const rnm = depOf(desktop, "react-native-macos");
    const lock = read("pnpm-lock.yaml");
    const entry = lock.match(
      new RegExp(
        `^  react-native-macos@${rnm.replaceAll(".", "\\.")}:\\n((?:    .*\\n|      .*\\n)+)`,
        "m",
      ),
    );
    assert.ok(entry, `pnpm-lock.yaml has no packages entry for react-native-macos@${rnm}`);
    const peer = entry[1].match(/^      react-native: (\S+)$/m)?.[1];
    assert.ok(peer, `react-native-macos@${rnm} declares no react-native peer`);
    assert.equal(depOf(desktop, "react-native"), peer);
    const tooling = Object.keys({ ...desktop.dependencies, ...desktop.devDependencies }).filter(
      (name) => name.startsWith("@react-native/"),
    );
    assert.ok(tooling.length > 0, "desktop declares no @react-native/* tooling");
    for (const name of tooling) assert.equal(depOf(desktop, name), peer, `${name} must be ${peer}`);
  });

  it("react-native-macos is an exact pin", () => {
    assert.match(depOf(desktop, "react-native-macos") ?? "", EXACT);
  });

  it("@react-native-community/cli and cli-platform-ios are exact pins of one version", () => {
    const cli = depOf(desktop, "@react-native-community/cli");
    const ios = depOf(desktop, "@react-native-community/cli-platform-ios");
    assert.match(cli ?? "", EXACT, "@react-native-community/cli must be an exact pin");
    assert.match(ios ?? "", EXACT, "@react-native-community/cli-platform-ios must be an exact pin");
    assert.equal(cli, ios, "the CLI core and cli-platform-ios move together, never one alone");
  });
});

describe("react-native-macos native fixes are a pnpm patch, not a runtime swizzle", () => {
  const patched = rootPkg.pnpm?.patchedDependencies ?? {};
  const keys = Object.keys(patched).filter((key) => key.startsWith("react-native-macos@"));

  it("has exactly one react-native-macos patch, under a range key covering the pinned version", () => {
    assert.equal(keys.length, 1, `expected one react-native-macos patch key, got ${keys}`);
    const range = keys[0].slice("react-native-macos@".length);
    assert.match(
      range,
      /^~/,
      `the key must be a ~ range so a patch release reapplies it: ${range}`,
    );
    const pinned = depOf(desktop, "react-native-macos");
    assert.ok(tildeCovers(range, pinned), `${range} does not cover the pinned ${pinned}`);
  });

  it("the patch file exists and guards handleKeyboardEvent in React/Views/RCTView.m", () => {
    assert.equal(keys.length, 1);
    const file = patched[keys[0]];
    assert.ok(existsSync(resolve(root, file)), `${file} is missing`);
    const patch = read(file);
    assert.match(patch, /^diff --git a\/React\/Views\/RCTView\.m b\/React\/Views\/RCTView\.m$/m);
    assert.match(patch, /handleKeyboardEvent/);
    assert.match(patch, /^\+.*self\.reactTag == nil/m, "the patch must add the nil-reactTag guard");
  });

  it("the DraftoKeyboardEventGuard swizzle is gone", () => {
    assert.ok(!existsSync(resolve(root, KEYBOARD_GUARD_MM)), `${KEYBOARD_GUARD_MM} still exists`);
    assert.ok(
      !read(PBXPROJ).includes("DraftoKeyboardEventGuard"),
      "project.pbxproj still references DraftoKeyboardEventGuard",
    );
  });
});

describe("Fastfile build_and_submit preflight", () => {
  const src = read(FASTFILE);

  function laneBody() {
    const start = src.indexOf("private_lane :build_and_submit do");
    assert.notEqual(start, -1, "no build_and_submit lane");
    const next = src.slice(start + 1).search(/^\s*(private_)?lane :/m);
    return next === -1 ? src.slice(start) : src.slice(start, start + 1 + next);
  }

  it("runs the dependency preflight and the .xcode.env.local step before cocoapods", () => {
    const lane = laneBody();
    const pods = lane.indexOf("cocoapods(");
    const preflight = lane.indexOf("assert_desktop_dependencies!");
    const nodeBinary = lane.indexOf("ensure_xcode_env_local_node_binary");
    assert.notEqual(pods, -1, "build_and_submit no longer runs cocoapods");
    assert.notEqual(preflight, -1, "build_and_submit does not run the dependency preflight");
    assert.notEqual(nodeBinary, -1, "build_and_submit does not derive NODE_BINARY");
    assert.ok(preflight < pods, "the dependency preflight must run before cocoapods");
    assert.ok(nodeBinary < pods, "NODE_BINARY must be derived before cocoapods");
  });

  it("the preflight compares installed rnm with the declared one, needs React 19.2 and says to install", () => {
    const def = src.slice(src.indexOf("def assert_desktop_dependencies!"));
    assert.ok(src.includes("def assert_desktop_dependencies!"), "preflight helper is not defined");
    const body = def.slice(0, def.indexOf("\nend\n"));
    assert.match(body, /installed_package_version\(root, "react-native-macos"\)/);
    assert.match(body, /installed_package_version\(root, "react"\)/);
    assert.match(body, /dig\("dependencies", "react-native-macos"\)/);
    assert.match(body, /run `pnpm install`/);
    assert.match(src, /DESKTOP_REACT_LINE = \/\\A19\\\.2\\\./);
  });

  it("the NODE_BINARY step rewrites .xcode.env.local from node's execPath", () => {
    const def = src.slice(src.indexOf("def ensure_xcode_env_local_node_binary"));
    assert.ok(
      src.includes("def ensure_xcode_env_local_node_binary"),
      "NODE_BINARY helper is not defined",
    );
    const body = def.slice(0, def.indexOf("\nend\n"));
    assert.match(body, /\.xcode\.env\.local/);
    assert.match(body, /File\.executable\?/);
    assert.match(body, /node -p process\.execPath/);
    assert.match(body, /export NODE_BINARY=/);
  });

  it("checks after cocoapods that the component-provider template the Podfile patches is nil-safe", () => {
    // The provider that gets compiled is regenerated by the ReactCodegen pod's
    // "Generate Specs" phase from rnm's template, after the Podfile's post_install
    // patched it. A text patch that stops matching does nothing without an error,
    // so the lane checks the template itself.
    const lane = laneBody();
    const pods = lane.indexOf("cocoapods(");
    const check = lane.indexOf("assert_nil_safe_component_provider!");
    assert.notEqual(check, -1, "build_and_submit does not check the component-provider template");
    assert.ok(
      pods < check,
      "the check must run after cocoapods, whose post_install patches the template",
    );
    const def = src.slice(src.indexOf("def assert_nil_safe_component_provider!"));
    assert.ok(src.includes("def assert_nil_safe_component_provider!"), "the check is not defined");
    const body = def.slice(0, def.indexOf("\nend\n"));
    assert.match(
      body,
      /"node_modules", "react-native-macos", "scripts", "codegen", "templates", "RCTThirdPartyComponentsProviderMM\.template"/,
    );
    assert.match(body, /include\?\("thirdPartyComponents = @\{"\)/);
    assert.match(body, /UI\.user_error!/);
    // The Podfile patch rewrites the same literal the check looks for.
    const podfile = read(PODFILE);
    assert.match(podfile, /RCTThirdPartyComponentsProviderMM\.template/);
    assert.match(podfile, /content\.include\?\('thirdPartyComponents = @\{'\)/);
  });
});

describe("Dependabot moves react-native-macos with react-native, in a group of their own", () => {
  const text = read(DEPENDABOT);

  const ignoreEntries = () =>
    yamlBlock(text, /^\s*ignore:\s*$/)
      .map((line) => /-\s*dependency-name:\s*(.+)$/.exec(line))
      .filter(Boolean)
      .map((m) => unquote(m[1]));

  // The `- item` entries under `key:` in a group's lines; [] when the key is absent.
  function listIn(lines, key) {
    const start = lines.findIndex((line) => new RegExp(`^\\s*${key}:\\s*$`).test(line));
    if (start === -1) return [];
    const indent = lines[start].search(/\S/);
    const items = [];
    for (const line of lines.slice(start + 1)) {
      if (line.search(/\S/) <= indent) break;
      const m = /^\s*-\s*(.+)$/.exec(line);
      if (m) items.push(unquote(m[1]));
    }
    return items;
  }

  // The groups in file order, which is the order Dependabot tries them in.
  function groups() {
    const body = yamlBlock(text, /^\s*groups:\s*$/);
    const indent = body[0].search(/\S/);
    const out = [];
    for (const line of body) {
      if (line.search(/\S/) === indent) {
        const m = /^\s*([\w-]+):\s*$/.exec(line);
        assert.ok(m, `unexpected line under groups: ${line}`);
        out.push({ name: m[1], lines: [] });
      } else {
        out.at(-1).lines.push(line);
      }
    }
    return out.map(({ name, lines }) => ({
      name,
      patterns: listIn(lines, "patterns"),
      exclude: listIn(lines, "exclude-patterns"),
    }));
  }

  // Dependabot puts a dependency in the first group that matches it: a group with no
  // `patterns` matches every dependency, and `exclude-patterns` takes names back out.
  const groupOf = (name) =>
    groups().find(
      (g) =>
        (g.patterns.length === 0 || g.patterns.some((p) => globMatches(p, name))) &&
        !g.exclude.some((p) => globMatches(p, name)),
    )?.name;

  // What the peer check above ties together: rnm, react-native and desktop's tooling.
  const train = [
    "react-native-macos",
    "react-native",
    ...Object.keys({ ...desktop.dependencies, ...desktop.devDependencies }).filter((name) =>
      name.startsWith("@react-native/"),
    ),
  ];

  it("has no ignore entry covering react-native-macos", () => {
    const covering = ignoreEntries().filter((name) => globMatches(name, "react-native-macos"));
    assert.deepEqual(covering, [], "an ignore entry would silence rnm releases");
  });

  it("puts react-native-macos, react-native and desktop's @react-native/* tooling in one group", () => {
    const names = train.map(groupOf);
    assert.ok(names[0], "react-native-macos falls in no Dependabot group");
    assert.notEqual(names[0], "minor-and-patch", "rnm must stay out of the weekly group");
    for (const [i, name] of names.entries()) {
      assert.equal(name, names[0], `${train[i]} is in group ${name}, not ${names[0]}`);
    }
  });

  it("leaves the native modules, the CLI pair and mobile's jest-preset in minor-and-patch", () => {
    // jest-preset is mobile's alone and isn't pinned to rnm's react-native peer.
    for (const name of [
      "@react-native/jest-preset",
      "react-native-screens",
      "react-native-webview",
      "@react-native-community/cli",
      "@react-native-community/cli-platform-ios",
      "@react-native-community/netinfo",
    ]) {
      assert.equal(groupOf(name), "minor-and-patch", `${name} left the minor-and-patch group`);
    }
  });

  it("minor-and-patch also excludes them, so the group order alone doesn't hold them out", () => {
    const weekly = groups().find((g) => g.name === "minor-and-patch");
    assert.ok(weekly, "no minor-and-patch group");
    for (const name of train) {
      assert.ok(
        weekly.exclude.some((p) => globMatches(p, name)),
        `minor-and-patch exclude-patterns ${JSON.stringify(weekly.exclude)} miss ${name}`,
      );
    }
  });

  it("suppresses CLI majors for the core and cli-platform-ios, but not netinfo", () => {
    const names = ignoreEntries();
    for (const pkg of ["@react-native-community/cli", "@react-native-community/cli-platform-ios"]) {
      assert.ok(
        names.some((n) => globMatches(n, pkg)),
        `no ignore entry covers ${pkg}`,
      );
    }
    assert.ok(
      !names.some((n) => globMatches(n, "@react-native-community/netinfo")),
      "a CLI ignore pattern also matches @react-native-community/netinfo",
    );
  });
});
