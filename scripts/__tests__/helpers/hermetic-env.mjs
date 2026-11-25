// The environment for a child process that runs factory code (a function
// extracted from factory-agent.sh, a factory lib CLI) under test.
//
// The factory runs this suite with its own knobs exported: its launchd plist
// sets FACTORY_BROWSER_UPLOADS=1, FACTORY_DEV_INSPECT=1, FACTORY_BROWSER_MODEL
// and more, and a factory session inherits them. A harness that spreads
// process.env would hand those to the code under test, which then takes a path
// the test never set up, and the test fails on the Mac mini but not in CI
// (23 wasted watch passes in the 2026-11 factory audit). This keeps everything
// else the caller has (PATH, HOME, TMPDIR…), drops every FACTORY_* key, then
// applies `extra`, so a test still sets the knobs it means to.
//
// Only FACTORY_* is scrubbed. Other keys a factory session exports, such as
// DRAFTO_UNATTENDED=1, pass through on purpose: factory-env-hermetic.test.mjs
// runs the converted files with it exported, and a harness whose code under
// test branches on it sets or clears it through `extra`.
export function hermeticEnv(extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("FACTORY_")) env[key] = value;
  }
  return { ...env, ...extra };
}
