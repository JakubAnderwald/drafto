# 0073 — Factory Verification: Data Checks, Live Tests, Uploads, Admin Steps and Page JS

- **Status**: Accepted
- **Date**: 2026-11-11
- **Authors**: Jakub Anderwald (with Claude Code)

## Context

To test #794 (the per-user storage quota, PR #802), an interactive session had to do five things that the factory's verification stage ([ADR-0053](./0053-pre-in-test-verification-stage.md)) and its browser runner ([ADR-0051](./0051-factory-browser-runner.md)) can't do:

1. **Run the dev live tests** (`pnpm test:live:supabase`). They hold the dev service-role key, so the runner refuses unattended sessions and the shell lane's guard denies it by name.
2. **Check the dev database and Storage after a step**, for example "the refused upload left no attachment row and no object" or "the deleted note's file is gone". The lanes have no database access at all.
3. **Upload files in the browser.** The runner denies `file_upload`.
4. **Do steps as an admin**, such as setting a user's quota on `/admin`. The runner signs in only as the factory's test account.
5. **Run JavaScript in the page**, to wait for an element or read a class name. The runner denies `javascript_tool`.

Each of these limits was chosen on purpose, to keep secrets and arbitrary code away from an unattended model. This ADR loosens each one narrowly, behind its own switch, while keeping the rule that **the model never sees a secret**.

## Decision

Each capability is **off by default**, has its own kill switch in the factory's launchd plist, and is turned on one at a time.

### 1. Dev data checks: `dev-inspect` (`FACTORY_DEV_INSPECT=1`)

`scripts/lib/dev-inspect.mjs` is a read-only inspector of the dev project (`huhzactreblzcogqkbsd`), scoped to one of the factory's own accounts.

- **The key stays out of the session.** The shell lane's supervisor writes `private/dev-inspect.cfg` (mode 600, a name the guard protects). It holds only the _paths_ of the key file and the account file. `bin/dev-inspect` runs `verify-lane.mjs dev-inspect` in a fresh process, which reads that config. It never reads `meta.json`, which the session can write to.
- **A fixed set of commands:** `whoami`, `profile`, `usage`, `orphans`, `objects [--note <id>]` and `rows <table> [--note <id>] [--notebook <id>]`.
  - The table is one of the user-owned tables.
  - Every filter is a uuid.
  - Every query is also filtered to the account's own user id.
  - Requests are GETs, the Storage listing, and the read-only RPCs in `READ_RPCS`.
- **Output** is one JSON line of counts, ids, object names and sizes. Output that would contain the key is withheld.

### 2. Dev live tests: `live-tests` (`FACTORY_VERIFY_LIVE_TESTS=1`)

The shell lane's supervisor runs the scenario's `### Live tests` **before the claude session starts**. For each name it runs the PR head's own `scripts/run-dev-live-tests.mjs --only <name> --key-file … --env-local …` (`scripts/lib/lane-live-tests.mjs`), and it stores the filtered results in `private/lane-tests.cfg`. During the session, `bin/live-tests [<name>]` only prints those stored results.

- **Why before the session:** during the session the model can write to the worktree and its `node_modules`. A test run it could start would run whatever it wrote there, and an encoded key would get past any output filter. Before the session, the checkout holds exactly the commit and its install, so nothing the model does changes the code that runs with the key.
- **Environment:** each test runs in a scrubbed process, without `DRAFTO_UNATTENDED`, in its own process group, which is killed whole on timeout. The key reaches only the live test, as it does in an interactive run, never the session.
- **A name the commit doesn't have** is reported as "not a live test at this commit", together with that commit's `LIVE_TESTS`.
- **The anon key** comes from the factory checkout's `apps/web/.env.local`, since the verify worktree has no env files.
- **The model sees filtered output only:**
  - result lines (node:test spec and TAP, vitest `✓`/`×`, the totals, the runner's summary), each cut to 200 characters, at most 200 of them;
  - assertion messages and stack traces are dropped;
  - if what's left matches a secret pattern or the key itself, all of it is withheld.
- **The runner itself stays operator-only.** The guard still denies `test:live` and `run-dev-live-tests` by name, so a session can't run the runner itself.
- **The tests run the PR's code.** That's the point: a PR's new or changed live tests are what need running. It also means a PR's test code runs with the key, as it would in an interactive run of the same PR. The output filter and the report's secret scan keep the key out of the transcript. Neither stops a PR's code from sending the key elsewhere. The same is true today for the browser runner's sign-in minting and the shell lane's PR-head tests, which run as the same OS user, which can read `~/drafto-secrets` (ADR-0053's 2026-10-21 update). Factory PRs come from plans the owner approved and pass CI and the code review before Testing.
- **Migrations:** the lane can't tell whether a PR's migration is on dev. When the PR changes `supabase/migrations/` and a live test fails, the lane says so and lists "push the migration to dev" as a step for the person.

### 3. Uploads in the browser (`FACTORY_BROWSER_UPLOADS=1`)

Implemented in a follow-up PR.

- **Fixtures:** the scenario's `### Fixtures` section names files by size and type, and bash generates them into the run's own `fixtures/` directory before the session. `file_upload` is allowed only for regular files inside that directory, never through a symlink.
- `upload_image` stays denied.

### 4. Admin steps (`FACTORY_BROWSER_ADMIN=1`)

Implemented in a follow-up PR.

- **Which account:** the runner can sign in as the CI E2E admin account on dev, with a one-time magic link minted like the test account's. No password is involved, so CI's password sign-in is unaffected.
- **Where its email lives:** the admin's email is in `~/drafto-secrets/browser-admin-account.env`, and each email has its own sign-in lease.
- **What it may do:** the runner acts as admin only on the factory test account's row and on accounts its run created.
- **Data checks:** `dev-inspect --as admin` reads the admin account's data.

### 5. JavaScript in the page (`FACTORY_BROWSER_JS=1`)

Implemented in a follow-up PR.

- **What's allowed:** `javascript_tool` is allowed on an owned tab on the preview's origin.
- **What the guard denies:**
  - code that touches cookies or Web Storage;
  - code that navigates or opens a window;
  - code that reaches anything but a relative path;
  - `eval`, `Function` and `import()`;
  - code over 4 KB.
- **This is defence in depth.** The app's CSP (ADR-0069), the guard's off-origin tab quarantine and the report's secret scan are the backstops.

### The browser runner's one shell command

Implemented in a follow-up PR. With `FACTORY_DEV_INSPECT=1`, the runner also gets Bash, and its guard allows exactly `dev-inspect` with plain arguments: no pipes, no `;`, no redirects. This is the only change to ADR-0051's "no tools but Chrome".

## Consequences

- **Positive**:
  - A scenario like #794's runs end to end in the factory: data checks, the live tests that cover a migration, uploads, admin steps.
  - Each capability can be switched off on its own, without touching the others.
- **Negative**:
  - The factory reads the dev service-role key for more than minting sign-in links.
  - PR-head live tests run with it, as described above.
  - The guard's denylist for page JavaScript can be bypassed by obfuscated code; the CSP and the scans are what actually limit it.
- **Neutral**:
  - Scenarios gain three forms: `### Live tests`, `dev-inspect` data checks in a step, and (with the follow-up) `### Fixtures` and steps marked `(admin)`.
  - With a switch off, the scenario's step for it is SKIP and becomes a manual step, as before.

## Alternatives Considered

- **Running the live tests from the factory's `main` checkout only.** No PR code would ever run with the key, but a PR's new or changed live tests, the ones that matter, wouldn't be covered until after the merge.
- **Data checks only at the end of the run, from the shell lane.** The browser runner would keep Chrome alone, but a check could only describe the final state, not what one step did.
- **A dedicated dev admin account created by a setup script.** That would mean one more account to look after. The CI E2E admin is dev-only already, and a magic-link sign-in leaves its password alone.
- **Giving the session the key and relying on the report's scan.** Rejected: the scan matches literals, and the rule that the model never holds a secret is what keeps it simple to reason about.
