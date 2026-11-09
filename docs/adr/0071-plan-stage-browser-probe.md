# 0071 — Plan-Stage Browser Probe

- **Status**: Accepted
- **Date**: 2026-11-09
- **Authors**: Jakub Anderwald, Claude

## Context

The factory's planner can't look at a running app. It runs `--no-chrome` ([ADR-0051](./0051-factory-browser-runner.md)), and before a PR exists there is no preview to open. On #492, a change to the web app's Content Security Policy and security headers, the plan stayed at `medium` confidence with open questions that only a deployment could settle:

- how Vercel merges the headers the app sets with its own;
- whether the Vercel toolbar still loads under the CSP;
- whether a CSP nonce causes a hydration warning;
- which scripts Sign in with Apple loads.

The operator asked the planner to "use a browser to run the checks", and the factory had to answer that it can't.

ADR-0051 point 9 expected this: "reproducing bugs at plan time follow in later PRs as further kinds of the same runner". Its constraints still hold, and they shape the design:

- **One Chrome call.** Exactly one kind of claude call gets `--chrome`, the locked-down runner, and it has no shell, no files and no `gh`. The planner runs with `--dangerously-skip-permissions`, a shell and `gh`, so it can't be given Chrome.
- **The runner can't report headers.** Rule 9 of its prompt bars response headers from its report, and `read_network_requests` doesn't expose them anyway.
- **Previews sit behind Vercel Authentication.** The runner gets through with the Chrome profile's Vercel login. Bash has the protection-bypass secret that [ADR-0053](./0053-pre-in-test-verification-stage.md) adopted for the verification shell lane.

Two facts were checked by hand on 2026-11-09 before building:

- **Vercel builds a branch pushed with no PR.** A Preview deployment appeared for the pushed SHA and reached `success`. The repo has no `vercel.json`, so the project's Ignored Build Step setting is what decides this.
- **A failed build still reports a URL.** A deliberately broken build shows in GitHub's deployment statuses as `failure`, with an `environment_url` all the same. So a URL alone doesn't mean the preview is up.

## Decision

Add a **plan-stage browser probe**: the `plan` kind of the ADR-0051 runner. It's off by default (`FACTORY_PLAN_PROBE=0`). Implementation: `scripts/lib/plan-probe.mjs`; the `plan_probe_*` helpers in `scripts/factory-agent.sh`, including `plan_probe_browser_run`; the "Browser probe" section of `scripts/factory-plan-prompt.md`; and "Kind `plan`" in `scripts/factory-browser-prompt.md`.

1. **The planner decides, and only writes files.** Every plan and replan bundle carries `probe`: whether one is available and, if not, why (`phase`, `off`, `kind`, `browser-disabled`, `not-web`, `pending` or `cap`). A probe is available in Phase B and later when the switch and the `plan` kind are on, the runner isn't disabled, `web` is among the card's affected platforms, no probe is already queued, and the issue has rounds left (`FACTORY_PLAN_PROBE_MAX_ROUNDS`, 2). Bash then stages a dir, `logs/factory/plan-probe/<probeId>/`, and the planner may write into it:
   - `checks.md` (required): 1 to 15 numbered steps, each a hypothesis with the result that would confirm or refute it;
   - `headers.txt`: up to 5 same-origin paths whose response headers bash records;
   - `spike/…`: the complete new contents of the files a minimal spike of its change touches, at their repo paths.

   The planner requests a probe when its open questions need a deployment, or when an operator's comment asks for browser checks. It runs no git, pnpm or network command for it. Its plan and reply say a probe was **requested**, because bash may still reject it. While a probe is available, the planner's wall cap is the larger of the plan cap and `FACTORY_PLAN_PROBE_TIMEOUT_SEC` (900 s).

2. **Bash validates, scans and pushes, after the planner's run.** When the run produced a plan (`planned`, `replanned` or `noop`), `plan-probe.mjs finalize` does four things:
   - **Validates.** An unusable `checks.md` ends the round as `rejected:checks`. A bad `headers.txt` is ignored, with a note in the report. A spike may only touch `apps/web/src/**` and `apps/web/next.config.ts`. It may not touch `apps/web/src/env.ts` or the test sign-in route, and no `package.json`, lockfile, `.env*`, `vercel.*`, `.gitattributes` or `.gitmodules`. It may have at most 15 files and 400 changed lines, and no symlink, hard link or binary. Its added lines may not contain `process.env` (except `NODE_ENV` and `VERCEL_ENV`), a secret-like name, `child_process`, `eval`, `new Function`, `require(`, `sendBeacon`, `WebSocket`, or a `fetch` or `import()` of a remote URL. These are speed bumps, not a wall. A spike that breaks a rule is dropped, the probe runs on `main` alone, and the report says why. `FACTORY_PLAN_PROBE_SPIKE=0` drops every spike.
   - **Scans** the checks, the headers file and every spike file it kept (a refused file is never read, so it can't be pushed or posted). It looks for the test account's password, the bypass secret, the dev service-role key, every secret in `~/drafto-secrets` (`FACTORY_SECRETS_DIR`), and GitHub token, Anthropic key and private-key patterns. "Every secret" means each KEY=VALUE value under a secret-sounding key or shaped like a token, `name: value` lines in plain-text files, and long token runs; the test account's email, the operator allowlist and plain URLs are not secrets (a report names the account it ran as), while a URL with a credential in it is. A hit ends the round as `rejected:secret`, and nothing is pushed.
   - **Fails closed.** If the account file, the sign-in key file, the bypass file (when it exists) or anything in the secrets dir can't be read, the scan can't vouch for anything: the round ends as `rejected:secret-scan` and nothing is pushed. The report comment applies the same rule and posts only a withheld notice.
   - **Builds the commit with git plumbing.** It reads `main`'s tree into a temp index and adds the spike's files (`hash-object --no-filters`) plus a marker file, `apps/web/.factory-plan-probe`, that holds the probe id. The marker gives every probe a unique SHA and an `apps/web` change, so Vercel always builds it. Nothing is checked out, no hook or `.gitattributes` filter runs, and the commit message is fixed (`chore(factory): plan probe for #<n> (not for merge)`), so no planner text goes into the commit.
   - **Pushes** `factory/plan-probe-<issue>` with hooks off and `--force-with-lease`, and records the round as `queued`.

   Any other outcome (a failed or timed-out run, no summary line, `blocked`) discards the staging.

3. **The probe branch is never a PR.** It is never merged and never the implementer's starting point: `--implement` starts from `main`, as before. CI doesn't run on it, because `ci.yml` covers only `main` and PRs. Bash deletes the branch when the round ends, with `--force-with-lease` on the SHA it pushed, because the GitHub ref DELETE API has no compare-and-swap.

4. **`--browser` runs it, after the other kinds.** Queued probes come from the state file, not from `--watch`'s candidates file, and run after the Testing and In Test candidates; it's still one browser run per tick. For a card that is still in Plan Review, with no `factory-pause` or `support` label, `plan_probe_browser_run`:
   - checks with `git ls-remote` that the branch still points at the pushed SHA. Anything else ends the round as `failed:branch-moved`, since that code was never validated or scanned.
   - reads the preview's state from the GitHub Deployments API. Only a `vercel[bot]` status of `success` counts as ready. `failure` or `error` ends the round as `failed:build`. With no deployment yet it waits `FACTORY_PLAN_PROBE_PREVIEW_WAIT_MIN` (15 min) from the push, and with a build in progress three times that, before ending the round as `failed:no-preview`.
   - captures the headers (decision 6), once, before anything that needs Chrome.
   - runs the runner with `runKind: plan` and the checks enveloped in `<plan-checks>`, signed in as the dev test account through the same one-time link and sign-in lease as the other kinds.

   `plan_probe_browser_run` is a sibling of `browser_run`. It reuses that function's small helpers but leaves its code, and its tests, untouched. It keeps its own count of runner sessions (`planProbeAttempts`: two per probe commit, refunded when the browser is the problem) and never writes `browserRunSha` or `browserRunAttempts`. Its results feed the runner's health tracker like the other kinds, except `signin-failed`, which is the probe's own result: a spike that changes the middleware or auth can stop the sign-in link working.

5. **Still exactly one `--chrome` call.** The session is `run_browser_task`, with the same guard, prompt rules and secret scan as the other kinds. Its target is the probe preview's exact origin. `drafto.eu` is still never a target.

6. **Headers come from bash.** For each path in `headers.txt`, node runs curl against the probe preview: `https` only, no redirect followed, no cookie jar. It keeps an allowlist: the status, `Content-Security-Policy` and its report-only form, `Strict-Transport-Security`, `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, the `Cross-Origin-*-Policy` headers and `Content-Type`. A redirect's `Location` is kept only as a same-origin path, or as "off-origin". `Set-Cookie` and `x-vercel-*` headers are never kept. To get past preview protection, curl sends the Vercel bypass secret from `FACTORY_VERIFY_BYPASS_FILE`, which it reads in a config on stdin (`-K -`). The secret never appears in argv or a file, and no model sees it. This is the secret's second use, and a bash-only one. The file is read even with `FACTORY_VERIFY=0`. If it's missing, the report notes `no-bypass-secret` and the round goes on.

7. **One report comment per round, composed in node.** `plan-probe.mjs compose` builds it. It says what was built (`main`'s SHA, plus the spike's files with line counts or why the spike was dropped) and lists the headers, the runner's table and the checks. Every piece is defanged, and the whole body is scanned again. On a hit, only a "report withheld" notice is posted. The comment carries `<!-- drafto-factory-plan-probe-report:<probeId> -->`. The probe id, `<issue>-<epoch>`, is generated by bash and keys the staging dir, the state, the report marker and the ack, so an ack for one round can't close a later one. Screenshots and the runner's output stay on the Mac mini.

8. **The planner folds the result into the plan.** A round that ended (`reported`, `failed:*` or `rejected:*`) and isn't acked yet is a replan trigger on its own, with no comment to answer. The replan gets the report as `probe.results`, enveloped as data. It revises the plan and its Confidence and appends `<!-- drafto-factory-plan-probe-ack:<probeId> -->` to the plan comment. Bash reads acks only from OWNER comments that start with the plan marker, the rule the companion change #807 applied to the plan finders. It counts each fold attempt before the claude call, so a killed run still counts, and stops asking after 2 (`folded:gave-up`). The replan may request a second round.

9. **Housekeeping bounds every probe.** It runs at the top of every `--plan` tick, in every phase, before the rescue sweep:
   - A staging dir a killed planner run left behind is dropped. Nothing was pushed and no round is spent; the rescue sweep settles the card, and the planner can request the probe again on its next run.
   - A queued probe ends as `cancelled:off` when the switch or the `plan` kind is off. It ends as `cancelled:left-plan-review` when its card left Plan Review; a card in Planning is skipped, because the rescue sweep owns it. Otherwise it ends as `failed:expired` 120 minutes after it was queued, and its report carries whatever headers were captured.
   - A finished round whose card left Plan Review becomes `folded:left-plan-review`.
   - A `factory/plan-probe-*` branch that no queued probe owns is deleted, under a lease on the SHA it saw.
   - Probe dirs that no record names are removed after 30 days.

   A cancelled round posts nothing. A failed one posts its report.

10. **State.** Each issue gets flat `planProbe*` fields (`PLAN_PROBE_ISSUE_FIELDS` in `scripts/lib/factory-state.mjs`). Their statuses are `queued`, `reported`, `failed:(build|no-preview|push|branch-moved|expired|runner)`, `rejected:(checks|secret|secret-scan|cap)`, `cancelled:(off|left-plan-review)` and `folded[:gave-up|:left-plan-review]`. `factory:plan-probe-reset <n>` clears them and gives back the issue's rounds; it refuses while a probe is queued, so a branch on GitHub always has a record that makes housekeeping delete it.

## Consequences

- **Positive**:
  - A plan whose open questions need a deployment can get answers before a person approves it, which is what the plan-review gate is for.
  - The planner gets exact header values from bash, which the runner can't report.
  - No new service or cost: it uses the existing Vercel previews, GitHub and the existing runner.
  - Every probe is bounded: 2 rounds per issue, 2 runner sessions per probe commit, 2 fold attempts per round, and 120 minutes per round.
- **Negative**:
  - **Planner-written code runs before the plan is approved.** Vercel builds and serves a spike with the Preview environment's variables. That's the dev Supabase URL and anon key, plus any server-only secret set for Preview (the names in `turbo.json`'s `passThroughEnv`, such as `SUPABASE_SERVICE_ROLE_KEY` or `RESEND_API_KEY`). The runner then opens it in the operator's signed-in Chrome profile. That's ADR-0051's Chrome-profile residual risk, now for code no person has reviewed. The validation is a speed bump, not a sandbox. This is accepted because the planner already has an unrestricted shell and `gh` on the Mac mini and could push a branch itself. What's new is that the push is automated and a browser visit follows it.
  - Probe commits stay reachable by SHA on the public repo after the branch is deleted. Each also leaves Vercel and GitHub deployment records and a Sentry release behind. The secret scan and the fixed commit message are what keep them clean.
  - A preview isn't production. `drafto.eu` is never opened, and custom-domain behaviour (HSTS on the apex domain, how headers merge there, production-only settings) can differ.
  - A failed build comes back with no logs. The factory can't read Vercel's build log, so the report only says that the build failed.
  - The bypass secret has a second reader: bash, which reads it even while verification is off.
  - Probes compete with the other kinds for the one browser run per tick. They go last.
- **Neutral**:
  - The plan-approval gate is unchanged. A probe is evidence for the plan, not implementation.
  - `FACTORY_BROWSER_KINDS` now defaults to `intest,verify,plan`. `plan` is inert while `FACTORY_PLAN_PROBE=0`.
  - **Privacy policy: no change.** A probe uses only the dedicated dev test account, dev Supabase and a preview. Evidence stays on the Mac mini; only the scanned, defanged report reaches GitHub. No new third-party processor receives user data.

## Alternatives Considered

- **Probe `main` only, never a spike.** No model-written code would be built. But it can't show how a proposed change behaves, which was most of what #492 needed: how the new CSP and headers land on a deployment. `FACTORY_PLAN_PROBE_SPIKE=0` keeps this mode as a fallback.
- **Spikes only with an operator's opt-in**, such as a label or a comment per issue. The operator chose to let the planner decide, with validation, the secret scan and the bounds above as the checks.
- **Serve the spike locally on `127.0.0.1`.** The runner may type test credentials there. But it isn't Vercel, so it can't answer Vercel-specific questions such as how Vercel merges headers or whether its toolbar loads, which is what #492 needed.
- **Probe `drafto.eu`.** The guard hard-blocks it, and the Chrome profile is signed in to production, so a probe there would act as the operator on real data. It also can't carry a spike.
- **Give the planner `--chrome`.** Rejected for the reason in ADR-0051: the planner has a shell and `gh`, and the session that holds the operator's browser must have neither.
- **Let the runner read the headers.** Rule 9 of its prompt bars headers from its report, and `read_network_requests` doesn't expose them. Bash records an allowlist instead.
