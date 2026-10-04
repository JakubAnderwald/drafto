# 0039 — Privacy Policy Kept in Step with the Code

- **Status**: Accepted
- **Date**: 2026-10-04
- **Authors**: Drafto dark factory (issue [#648](https://github.com/JakubAnderwald/drafto/issues/648))

## Context

The privacy policy at `drafto.eu/privacy` is the URL the App Store and Play listings point to, and Apple guideline 5.1.1(i) requires it to be reachable. By September 2026 it had two problems.

- **Nobody signed out could open it.** `/privacy` and `/support` were missing from `PUBLIC_ROUTES` in the web middleware, so store reviewers and visitors got a `307 → /login`.
- **It no longer described the app.** It listed Expo (EAS) as a processor, although builds moved to local Fastlane (ADR-0016) and OTA updates are disabled. It described PostHog analytics as active, although no PostHog key is configured. It also left out Google and Apple sign-in, Resend, the support pipeline (Zoho Mail, Anthropic, GitHub), Sentry Session Replay, API keys and MCP, the 30-day trash purge, and the GDPR Article 13 basics (controller, legal basis, international transfers).

Nothing tied a change in the code to the policy, so every new SDK, retention job or integration could silently make the policy false. Code review did not catch these changes, because a diff that adds a dependency never touches `privacy/page.tsx`.

## Decision

Treat the privacy page as code that must change in the same PR as the behaviour it describes, and enforce that in four places:

1. **A maintenance rule in `CLAUDE.md`** ("Privacy Policy Maintenance"), next to the MCP maintenance rules. It lists six triggers: a new or swapped data-receiving service or SDK, a new category of personal data, a change to storage, retention or deletion, a new way for data to leave Drafto, an auth or session-storage change, and user or support data sent to an AI model.
2. **A guard test**, `apps/web/__tests__/unit/privacy-policy-processors.test.tsx`. It reads the app `package.json` files and maps known data-processing dependencies to processor names (`@sentry/*` → Sentry, `posthog-*` → PostHog, `resend` → Resend, `@react-native-google-signin/*` → Google, `expo-apple-authentication` → Apple, `@supabase/*` → Supabase). It fails when a mapped dependency is present but its processor is not named on the rendered page. It also fails when a dependency matches a "suspicious" name pattern (analytics, crash reporting, AI, messaging) but is not in the map, which forces a decision about the policy. Because the page says the native apps ship no analytics or crash-reporting SDK, any such SDK in `apps/mobile` or `apps/desktop` fails too, even when the page already names its processor for the web app. The same file asserts that every processor row in the sharing table renders.
3. **Factory prompts.** The planner (`scripts/factory-plan-prompt.md`) must ask whether the rule is triggered and put the privacy page into "Files to touch". The implementer (`scripts/factory-prompt.md`) checks it among the CLAUDE.md rules, and the code-review stage (`scripts/factory-review-prompt.md`, item 11) reports a triggered rule with no policy update as a finding.
4. **Public legal routes.** `/privacy` and `/support` are in `PUBLIC_ROUTES`, and the middleware unit test plus a signed-out Playwright spec keep them there. Any future route that must be reachable signed out follows the same pattern.

The processor table stays inline JSX on the page. The guard test renders the page rather than importing a shared data module.

## Consequences

- **Positive**: Adding an SDK such as `@sentry/react-native`, `@vercel/analytics` or `openai` turns the web test suite red until someone decides how the policy describes it. Factory runs get the same prompt at plan, implement and review time, so a factory PR that triggers the rule without updating the policy is caught before merge. Store reviewers can open the policy.
- **Negative**: The guard sees only npm dependencies. It cannot see a service reached over plain `fetch`, a script on the Mac mini (the support pipeline's Zoho, Anthropic and GitHub use is invisible to it), or a configuration flip such as setting `NEXT_PUBLIC_POSTHOG_KEY` in Vercel. Those rely on the `CLAUDE.md` rule and on review. A green guard test does not prove the policy is complete.
- **Negative**: The suspicious-name list can produce false positives (`segment` also matches UI packages). The test's failure message says how to resolve one, but each costs a small edit.
- **Neutral**: The policy wording is not legal advice and has not been reviewed by a lawyer. The test pins the structure and the processor list, not legal sufficiency.

## Alternatives Considered

- **A shared processor data module rendered by the page and imported by the test.** Rejected: the test already renders the page, so a data module adds an abstraction with a single consumer and makes the legal text harder to edit as prose.
- **Scan `pnpm-lock.yaml` for transitive dependencies.** Rejected: it is far too noisy (hundreds of packages, many with telemetry-sounding names that send nothing), and the decision that matters is made when a direct dependency is added.
- **A hosted policy generator (Termly, iubenda, etc.).** Rejected under the infrastructure cost discipline in `CLAUDE.md`, and a generator still cannot see what the code does.
- **A rule in `CLAUDE.md` only, with no test.** Rejected: the policy already drifted under review, and a rule with no failing check relies on everyone remembering it.
