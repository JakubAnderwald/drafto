# 0065 — Gate Factory Cards on the Hosted Supabase Config

- **Status**: Accepted
- **Date**: 2026-11-01
- **Authors**: Jakub Anderwald, with Claude Code

## Context

Some of Drafto's auth configuration lives only in the hosted Supabase projects' dashboards, not in git: chiefly the Redirect URL allowlist (Authentication → URL Configuration). `supabase/config.toml` declares the same settings, but nothing applies it to dev (`huhzactreblzcogqkbsd`) or prod (`tbmjbxxseonkciqovnpl`). An operator adds each entry by hand.

#685 / PR #778 made mobile append `?sb_flow_id=…` to its auth redirects. Supabase matches allowlist entries against the whole URL, query included, so the PR needed `drafto://reset-password?sb_flow_id=*` and `drafto://auth/callback?sb_flow_id=*` in both projects. The plan, the PR body and the In Test comment all said so. Nothing enforced it:

- **The betas went out first.** The In Review → In Test promotion dispatched pre-merge betas (Android 64, iOS 57), which run against prod (ADR-0030). The In Test comment that advised checking the allowlist was written about three minutes later.
- **The merge wasn't gated either.** `--release`'s only operator gate was the migration gate (`supabase/migrations/**`).
- **Neither project had the entries.** An emulator test of the PR found them missing in dev and prod. A reset link from those betas, and every Apple sign-in on Android, would have fallen back to the Site URL, `https://drafto.eu`, instead of opening the app.

The failure is an advisory with no gate. The factory can't apply hosted config itself. The Management API needs a personal access token with full account access, and changing prod needs an explicit operator "yes" (CLAUDE.md). It can, however, check.

## Decision

A PR that changes `supabase/config.toml` passes a **hosted-config gate** (`hosted_config_gate` in `scripts/factory-agent.sh`, logic in `scripts/lib/hosted-config.mjs`) at three points:

1. **In Review**, as the last check before either promotion path, Testing (ADR-0053) or In Test. A held card gets no scenario and no beta, and the hold comment explains why.
2. **Every beta dispatch.** `intest_dispatch_betas`, which every pre-merge beta goes through, runs the gate for the head it is about to build. This also covers the In Test sweep building a head that was pushed while the card sat in In Test, and a card dragged past In Review by hand. A held lane is reported to the scenario writer as `hosted-config-hold`. It isn't recorded as started, so it is dispatched on a later tick once the gate passes, and the scenario offers no local build commands, which would hit the same gap.
3. **`--release`**, as the last check before the merge, after the conflict, CI and review-thread hand-backs, so those still run for a held card. This catches a hosted entry removed since the card was tested. The merge is pinned to the head SHA the gates read (`sha` on the merge call), so a commit pushed in between can't ride through.

**What is checked:**

- **The PR's own change.** The base is the merge base of the PR head and `main`, not `main`'s tip. Otherwise a branch that is behind would look as if it reverted whatever `main` gained since.
- **Redirect URLs are probed, without credentials.** GoTrue's `/verify` validates `redirect_to` before redirecting. A request with a junk token gets a `303` to the URL itself when the allowlist accepts it, and to the project's Site URL when it doesn't. For each Redirect URL the PR adds, the gate builds a concrete sample (`*` → `probe`, `**` → `probe/x`) and probes it on dev and prod, in parallel. Removed entries never block.
- **Controls first.** Each project is first probed with `drafto://factory-probe-not-allowlisted`, which must be rejected, and its redirect is taken as that project's Site URL. It is then probed with an exact entry already on `main`, which must be allowed. If either misbehaves, or a probe errors, the result is "unknown", not a false pass or hold. That also covers Supabase changing how `/verify` answers. The one exception is a PR with `hosted-config-applied`: there an inconclusive check passes, while a confirmed miss still holds (see below).
- **Everything else needs a label.** Some changes can't be probed:
  - a hosted setting outside `additional_redirect_urls`, such as rate limits, email templates or providers;
  - a Redirect URL with no valid sample, such as character classes, alternations or a `*` in a port.

  These need the `hosted-config-applied` PR label, which the operator adds once they have applied the change to both projects. Comments, spacing, and settings that only configure the local stack don't count: `[studio]`, `[inbucket]`, `[analytics]`, `[edge_runtime]`, `[db.migrations]`, `[db.seed]`, the local ports in `[db]`, and `project_id`. Every other table counts, including `[db.settings]` and `[db.network_restrictions]`, which `supabase config push` applies to a hosted project, and any table the gate doesn't recognise, so a gap in the list asks for the label instead of letting a change through.

- **The label vouches for one version of `config.toml`.** The gate records a hash of the file the label was first seen with, in the factory state field `hostedConfigVouched`. If a later commit changes the file, the factory removes the label and asks again.
- **The label can overrule an inconclusive check, never a confirmed miss.** It is the operator saying that the change is applied, and without it a probe that keeps failing would hold the card for good.

**Outcomes:**

- **Pass:** the card carries on.
- **Hold:** the card stays where it is, with one comment per column and head SHA (`<!-- drafto-factory-hosted-config-hold:<column>:<sha12> -->`, with column `in-review`, `beta` or `approved`). The comment lists each missing entry per project, with a dashboard link. It warns against `supabase config push`, which would push the whole file and overwrite settings that differ on prod, such as its SMTP.
- **Unknown:** when a probe or control fails, the gate holds too, with `<!-- drafto-factory-hosted-config-unverified:<column>:<sha12> -->`. Failing open is exactly what shipped the #778 betas. The CodeRabbit lane fails open (ADR-0036) because a missed review is advisory; a missing allowlist entry breaks sign-in on prod.
- **GitHub errors:** a failure to read the merge base or `config.toml` from GitHub holds the card for that tick without a comment, like the factory's other transient GitHub errors. A head that deleted `config.toml` counts as an empty file.

In every case the gate re-checks each cycle, so adding the entries is the whole fix: no label, no drag. `pnpm hosted-config:check` runs the same check on any branch, from its merge base with `origin/main`.

The plan and implement prompts tell the model to declare a new Redirect URL in `supabase/config.toml`, the file the gate reads, and never to change hosted config itself.

## Consequences

- **Positive**
  - A PR can no longer put a build on testers or merge while its auth redirects are missing on prod.
  - The hold names the exact entries per project, so the operator doesn't have to dig them out of a plan.
  - It clears itself.
  - The redirect check needs no secret on the Mac mini.
- **Negative**
  - The probe depends on GoTrue's error redirect. The controls turn a change there into a visible "unknown" hold, not a silent pass, but the gate would then need updating.
  - Each check sends a few unauthenticated `/verify` requests per project, which count toward its per-IP token-verification rate limit. A 429 or a timeout isn't retried within the check; it reads as unknown and is retried next cycle. Only PRs that add entries probe at all.
  - Pinning the merge to the checked SHA turns a push that races the merge into one "merge failed" comment. The next cycle checks and merges the new head.
  - A card that changes non-redirect settings waits for a human label, as the migration gate already does.
- **Neutral**
  - The gate trusts `config.toml` as the declaration. A PR that needs a hosted setting but doesn't declare it isn't caught. The prompts make declaring it the rule.

## Alternatives Considered

- **A label only, like `migration-approved`.** It's simpler, but it records an assertion rather than the state. On #778 the operator step was already written down three times and still missed. The probe checks the projects themselves, and the label remains only for what can't be probed.
- **Reading the config through the Management API.** That covers every setting, but it needs a personal access token with full account access in the factory's reach, for a read the probe does without one.
- **Applying the config automatically** (`supabase config push`, or a Management API PATCH). The factory must not change prod unattended. `config push` also pushes the whole file, which would switch off prod's Resend SMTP, because `config.toml` doesn't configure it.
- **A CI check.** A red required check sends the card into the `--watch` fix loop, which can't fix hosted config and would burn its attempts. A factory hold leaves the card alone and asks the right person.
- **Gating only the beta dispatch.** The card would reach In Test with a scenario that can't be tested. Holding In Review keeps the card where nothing is waiting on a human but this, and the dispatch check stays as the backstop for heads that reach a dispatch some other way.
