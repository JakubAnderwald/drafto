// Tests for scripts/lib/device-flow-validate.mjs — the allowlist a scenario
// session's Maestro YAML must pass before the device lane runs it (ADR-0106
// decision 2). One case per allowed and per denied construct.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  MAX_COMMANDS,
  MAX_FLOW_BYTES,
  normaliseRef,
  validateFlow,
  variableProblem,
} from "../lib/device-flow-validate.mjs";

const HEADER = "appId: eu.drafto.mobile\n---\n";
const ALLOW = ["02-other.yaml", "../helpers/sign-in.yaml", "../helpers/sign-in-clean.yaml"];

function check(body, { platform = "android", header = HEADER, runFlowAllow = ALLOW } = {}) {
  return validateFlow(`${header}${body}`, { platform, runFlowAllow });
}

function ok(body, opts) {
  const r = check(body, opts);
  assert.equal(r.ok, true, `${body}\n${r.errors.join("\n")}`);
  return r;
}

function bad(body, pattern, opts) {
  const r = check(body, opts);
  assert.equal(r.ok, false, `expected a denial for:\n${body}`);
  assert.ok(
    r.errors.some((e) => pattern.test(e)),
    `${pattern} not in:\n${r.errors.join("\n")}`,
  );
  return r;
}

describe("validateFlow: the header", () => {
  it("needs exactly appId: eu.drafto.mobile, and allows name and tags", () => {
    ok("- back\n", { header: "appId: eu.drafto.mobile\nname: x\ntags:\n  - qa\n---\n" });
    bad("- back\n", /appId: eu\.drafto\.mobile/, { header: "appId: com.android.settings\n---\n" });
    bad("- back\n", /appId/, { header: "name: x\n---\n" });
  });

  it("denies env and the onFlow hooks", () => {
    for (const key of ["env:\n  X: y", "onFlowStart:\n  - back", "onFlowComplete:\n  - back"]) {
      bad("- back\n", /isn't allowed in the header/, {
        header: `appId: eu.drafto.mobile\n${key}\n---\n`,
      });
    }
  });

  it("needs a header, a --- line and a list of commands", () => {
    assert.equal(validateFlow("- back\n", { platform: "ios" }).ok, false);
    assert.equal(validateFlow(`${HEADER}`, { platform: "ios" }).ok, false);
    assert.equal(validateFlow(`${HEADER}tapOn: x\n`, { platform: "ios" }).ok, false);
    assert.equal(validateFlow(`${HEADER}- back\n---\n- back\n`, { platform: "ios" }).ok, false);
  });
});

describe("validateFlow: allowed commands", () => {
  const allowed = {
    launchApp: ["- launchApp\n", "- launchApp:\n    clearState: true\n    clearKeychain: true\n"],
    stopApp: ["- stopApp\n", "- stopApp: eu.drafto.mobile\n"],
    killApp: ["- killApp\n"],
    tapOn: ['- tapOn: "Notebooks"\n', '- tapOn:\n    id: "new-notebook"\n    index: 0\n'],
    doubleTapOn: ['- doubleTapOn: "Note"\n'],
    longPressOn: ['- longPressOn:\n    text: "Note"\n    below: "Header"\n'],
    inputText: ['- inputText: "NB ${RUN_ID}"\n', "- inputText: plain\n"],
    inputRandomText: ["- inputRandomText\n", "- inputRandomText:\n    length: 8\n"],
    eraseText: ["- eraseText\n", "- eraseText: 20\n"],
    assertVisible: ['- assertVisible: "Notebooks"\n', '- assertVisible:\n    id: "x"\n'],
    assertNotVisible: ['- assertNotVisible: "Error"\n'],
    extendedWaitUntil: ['- extendedWaitUntil:\n    visible: "Notebooks"\n    timeout: 30000\n'],
    waitForAnimationToEnd: ["- waitForAnimationToEnd\n"],
    scroll: ["- scroll\n"],
    scrollUntilVisible: ['- scrollUntilVisible:\n    element: "Trash"\n    direction: DOWN\n'],
    swipe: ['- swipe:\n    direction: LEFT\n    from:\n      id: "row"\n'],
    back: ["- back\n"],
    hideKeyboard: ["- hideKeyboard\n"],
    pressKey: ["- pressKey: Enter\n"],
    copyTextFrom: ['- copyTextFrom:\n    id: "title"\n'],
    pasteText: ["- pasteText\n"],
    setAirplaneMode: ["- setAirplaneMode: enabled\n"],
    toggleAirplaneMode: ["- toggleAirplaneMode\n"],
    takeScreenshot: ["- takeScreenshot: after-create\n"],
    openLink: ["- openLink: drafto://notes/1\n", "- openLink:\n    link: drafto://x\n"],
    repeat: ["- repeat:\n    times: 10\n    commands:\n      - scroll\n"],
    retry: ["- retry:\n    maxRetries: 3\n    commands:\n      - back\n"],
    runFlow: [
      "- runFlow: 02-other.yaml\n",
      "- runFlow: ../helpers/sign-in.yaml\n",
      "- runFlow:\n    when:\n      platform: Android\n    commands:\n      - back\n",
      '- runFlow:\n    when:\n      visible: "Log In"\n    file: ../helpers/sign-in.yaml\n',
      '- runFlow:\n    when:\n      notVisible: "Notebooks"\n    commands:\n      - back\n',
    ],
  };
  for (const [name, bodies] of Object.entries(allowed)) {
    it(`allows ${name}`, () => {
      for (const body of bodies) ok(body);
    });
  }

  it("reports the runFlow targets it uses, normalised", () => {
    const r = ok("- runFlow: ./02-other.yaml\n- runFlow: ../helpers/sign-in.yaml\n");
    assert.deepEqual(r.runFlows, ["02-other.yaml", "../helpers/sign-in.yaml"]);
  });
});

describe("validateFlow: denied constructs", () => {
  it("denies runScript, evalScript and the other named commands", () => {
    bad("- runScript: x.js\n", /runScript: isn't allowed: it runs JavaScript/);
    bad("- evalScript: ${1+1}\n", /evalScript: isn't allowed/);
    bad("- clearKeychain\n", /clearKeychain: isn't allowed/);
    bad("- clearState\n", /clearState: isn't allowed/);
    bad("- addMedia:\n    - x.png\n", /addMedia: isn't allowed/);
    bad("- startRecording: x\n", /startRecording: isn't allowed/);
    bad("- stopRecording\n", /stopRecording: isn't allowed/);
    bad("- travel:\n    points: []\n", /travel: isn't allowed/);
    bad("- setLocation:\n    latitude: 1\n", /setLocation: isn't allowed/);
  });

  it("denies an unknown command", () => {
    bad("- tapOnEverything\n", /isn't an allowed command/);
    bad("- inputRandomEmail\n", /isn't an allowed command/);
  });

  it("denies another app", () => {
    bad("- launchApp: com.android.settings\n", /may only name eu\.drafto\.mobile/);
    bad("- launchApp:\n    appId: com.apple.Preferences\n", /must be eu\.drafto\.mobile/);
    bad("- killApp: com.android.chrome\n", /may only name/);
    bad("- stopApp:\n    appId: com.x\n", /must be eu\.drafto\.mobile/);
    bad("- launchApp:\n    arguments:\n      x: y\n", /`arguments` isn't allowed/);
  });

  it("denies ${E2E_TEST_PASSWORD} and ${MAESTRO_E2E_TEST_PASSWORD}", () => {
    bad("- inputText: ${E2E_TEST_PASSWORD}\n", /only \$\{RUN_ID\}/);
    bad("- inputText: ${MAESTRO_E2E_TEST_PASSWORD}\n", /only \$\{RUN_ID\}/);
    bad('- inputText: "pw ${E2E_TEST_EMAIL}"\n', /only \$\{RUN_ID\}/);
    // …anywhere at all, not only in inputText.
    bad("- assertVisible: ${MAESTRO_E2E_TEST_PASSWORD}\n", /only \$\{RUN_ID\}/);
    bad("- tapOn:\n    id: ${SIGN_IN_PASSWORD}\n", /only \$\{RUN_ID\}/);
  });

  it("denies JavaScript expressions", () => {
    bad("- inputText: ${RUN_ID + 1}\n", /only \$\{RUN_ID\}/);
    bad("- inputText: \"${typeof E2E_TEST_PASSWORD !== 'undefined' ? 1 : 2}\"\n", /only/);
    bad("- inputText: ${output.x}\n", /only/);
    bad("- inputText: ${RUN_ID\n", /only/);
  });

  it("denies inputText of anything but a plain string", () => {
    bad("- inputText:\n    text: x\n", /must be a plain string/);
    bad("- inputText: 12345\n", /must be a plain string/);
    bad("- inputText:\n    - a\n", /must be a plain string/);
  });

  it("denies a runFlow outside the allowlist", () => {
    bad("- runFlow: ../../e2e/05-cross-platform-sync.yaml\n", /isn't one of the files runFlow/);
    bad("- runFlow: /etc/hosts\n", /isn't one of the files runFlow/);
    bad("- runFlow: ../examples/02-create-notebook.yaml\n", /isn't one of the files runFlow/);
    bad("- runFlow:\n    file: 03-missing.yaml\n", /isn't one of the files runFlow/);
    bad("- runFlow:\n    file: ../helpers/sign-in.yaml\n    env:\n      X: y\n", /`env`/);
    bad("- runFlow:\n    file: 02-other.yaml\n    commands:\n      - back\n", /exactly one/);
  });

  it("denies a when: true: condition, and any other condition key", () => {
    bad(
      "- runFlow:\n    when:\n      true: ${1 == 1}\n    commands:\n      - back\n",
      /JavaScript/,
    );
    bad("- runFlow:\n    when:\n      true: yes\n    commands:\n      - back\n", /JavaScript/);
    bad(
      "- runFlow:\n    when:\n      platform: Web\n    commands:\n      - back\n",
      /iOS or Android/,
    );
    bad(
      "- repeat:\n    times: 2\n    while:\n      true: x\n    commands:\n      - back\n",
      /JavaScript/,
    );
  });

  it("checks commands nested in repeat, retry and runFlow", () => {
    bad("- repeat:\n    times: 2\n    commands:\n      - runScript: x.js\n", /runScript/);
    bad("- retry:\n    commands:\n      - inputText: ${E2E_TEST_PASSWORD}\n", /only/);
    bad(
      "- runFlow:\n    commands:\n      - repeat:\n          times: 1\n          commands:\n            - evalScript: x\n",
      /evalScript/,
    );
  });

  it("caps repeat at 10 and retry at 3, nested too", () => {
    bad("- repeat:\n    times: 11\n    commands:\n      - back\n", /times/);
    bad("- repeat:\n    times: 0\n    commands:\n      - back\n", /times/);
    bad("- retry:\n    maxRetries: 4\n    commands:\n      - back\n", /maxRetries/);
    bad(
      "- repeat:\n    times: 2\n    commands:\n      - retry:\n          maxRetries: 9\n          commands:\n            - back\n",
      /maxRetries/,
    );
    bad(
      "- retry:\n    commands:\n      - repeat:\n          times: 50\n          commands:\n            - back\n",
      /times/,
    );
    bad("- retry:\n    file: x.yaml\n    commands:\n      - back\n", /`file` isn't allowed/);
  });

  it("allows openLink to drafto:// only", () => {
    ok("- openLink: drafto://auth-callback\n");
    bad("- openLink: https://evil.example/x\n", /drafto:\/\//);
    bad("- openLink: http://drafto.eu\n", /drafto:\/\//);
    bad("- openLink:\n    link: https://x\n", /drafto:\/\//);
    bad("- openLink: tel:123\n", /drafto:\/\//);
  });

  it("names screenshots plainly", () => {
    bad("- takeScreenshot: ../../evidence/x\n", /lowercase/);
    bad("- takeScreenshot: Shot\n", /lowercase/);
    bad("- takeScreenshot:\n    path: x\n", /lowercase/);
  });

  it("denies airplane mode on iOS, where the simulator has none", () => {
    bad("- setAirplaneMode: enabled\n", /iOS simulator/, { platform: "ios" });
    bad("- toggleAirplaneMode\n", /iOS simulator/, { platform: "ios" });
  });

  it("denies a timeout past two minutes and unknown keys", () => {
    bad('- extendedWaitUntil:\n    visible: "x"\n    timeout: 999999\n', /milliseconds/);
    bad('- tapOn:\n    text: "x"\n    script: y\n', /`script` isn't allowed/);
    bad("- pressKey: Power\n", /must be one of/);
  });

  it("denies YAML anchors, aliases, tags and duplicate keys", () => {
    bad('- tapOn: &a "x"\n- tapOn: *a\n', /aliases|anchors/);
    bad("- inputText: !!str 5\n", /tags/);
    bad("- tapOn: !custom x\n", /tags|warning/);
    bad('- tapOn:\n    text: "x"\n    text: "y"\n', /DUPLICATE_KEY/);
  });

  it("denies an oversize file and more than 200 commands", () => {
    const big = `- inputText: "${"x".repeat(MAX_FLOW_BYTES)}"\n`;
    bad(big, /larger than 20 KB/);
    const many = "- back\n".repeat(MAX_COMMANDS + 1);
    bad(many, /more than 200 commands/);
    ok("- back\n".repeat(MAX_COMMANDS));
    // Nested commands count too.
    const nested = `- repeat:\n    times: 2\n    commands:\n${"      - back\n".repeat(MAX_COMMANDS)}`;
    bad(nested, /more than 200 commands/);
  });

  it("refuses garbage input and an unknown platform", () => {
    assert.equal(validateFlow(null, { platform: "ios" }).ok, false);
    assert.equal(validateFlow(`${HEADER}- back\n`, { platform: "web" }).ok, false);
    assert.equal(validateFlow(`${HEADER}- "unclosed\n`, { platform: "ios" }).ok, false);
  });
});

describe("helpers", () => {
  it("variableProblem allows only ${RUN_ID}", () => {
    assert.equal(variableProblem("NB ${RUN_ID} ${RUN_ID}"), null);
    assert.match(variableProblem("${RUN_IDX}"), /only/);
  });

  it("normaliseRef refuses absolute and backslash paths", () => {
    assert.equal(normaliseRef("./a/../b.yaml"), "b.yaml");
    assert.equal(normaliseRef("/etc/x"), null);
    assert.equal(normaliseRef("a\\b"), null);
    assert.equal(normaliseRef("."), null);
  });
});
