# Privacy policy

**Status:** shipped **Updated:** 2026-10-04

## What it is

The public privacy policy at [drafto.eu/privacy](https://drafto.eu/privacy). The App Store, Mac App Store and Google Play listings link to it, and Apple guideline 5.1.1(i) requires it to be reachable, so it must describe what every platform actually does. The page is static JSX and covers all four platforms. The mobile and desktop apps have no copy of their own.

## Current state

The page covers:

- the data controller (Jakub Anderwald, Warsaw, Poland, `support@drafto.eu`)
- the data collected: account and sign-in data, account approval, notes and note history, support emails, device and usage data, cookies, offline data
- the purposes and the GDPR legal basis for each
- the processor table
- support email handling (AI assistant, public GitHub issues)
- API keys and MCP
- international transfers
- storage and security
- user rights, including export (Evernote `.enex` from the web app) and correction (through `support@drafto.eu`)
- retention

`/privacy` and `/support` are in `PUBLIC_ROUTES`, so signed-out visitors and store reviewers can open them.

The policy text is not legal advice and has not been reviewed by a lawyer. The Terms of Service, a cookie banner and DPAs with the processors are open follow-ups.

## Processor inventory

| Processor   | What it does for Drafto                                                | Where it lives in code                                                                                                                                                                                                                                                                                      |
| ----------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Supabase    | Database, auth, file storage; West EU (Ireland)                        | `@supabase/*` in all three apps; `apps/web/src/lib/supabase/`, `apps/mobile/src/lib/supabase.ts`, `apps/desktop/src/lib/supabase.ts`; region in [`environments.md`](../architecture/environments.md)                                                                                                        |
| Vercel      | Hosts drafto.eu and its API routes                                     | Deployment platform; no SDK (no `@vercel/analytics` / `speed-insights`)                                                                                                                                                                                                                                     |
| Sentry      | Errors, 100% performance tracing, Session Replay (10% / 100%-on-error) | `@sentry/nextjs`; `apps/web/instrumentation-client.ts`, `apps/web/sentry.{server,edge}.config.ts`. Web only                                                                                                                                                                                                 |
| Resend      | Admin sign-up notice, approval email, Supabase Auth SMTP               | `resend`; `apps/web/src/lib/email/client.ts`; SMTP in the Supabase dashboard ([email-and-approval.md](./email-and-approval.md))                                                                                                                                                                             |
| Google      | Sign in with Google; NetInfo connectivity check on iOS and macOS       | `apps/{web,desktop}/src/components/auth/oauth-buttons.tsx`, `apps/mobile/src/lib/oauth.ts` (`@react-native-google-signin/google-signin`). `@react-native-community/netinfo` pings `clients3.google.com/generate_204` about every 60 s on iOS and macOS (default `reachabilityUrl`; Android checks natively) |
| Apple       | Sign in with Apple                                                     | Same files; `expo-apple-authentication` on iOS                                                                                                                                                                                                                                                              |
| Zoho Mail   | The `support@drafto.eu` mailbox (EU data centre)                       | `scripts/lib/zoho-*.mjs`, `scripts/support-agent.sh` ([support-agent.md](./support-agent.md))                                                                                                                                                                                                               |
| Anthropic   | Claude reads support email, auto-answers, drafts replies               | `scripts/support-agent.sh` → `scripts/lib/run-claude.mjs`; rules in `scripts/support-agent-prompt.md`                                                                                                                                                                                                       |
| GitHub      | Public issues from support email (reporter email in hidden footer)     | `scripts/support-agent-prompt.md` (issue footer, `support-attachments/` uploads)                                                                                                                                                                                                                            |
| _(PostHog)_ | **Not a processor.** The SDK ships but no key is configured            | `posthog-js` / `posthog-node`; `apps/web/src/lib/posthog/`. Inactive unless `NEXT_PUBLIC_POSTHOG_KEY` is set. The page says so in prose, not in the table                                                                                                                                                   |

Not processors, on purpose: Expo (builds are local Fastlane, OTA is off: `updates.enabled: false` in `apps/mobile/app.config.ts`), `expo-secure-store` and `react-native-keychain` (on-device storage; the desktop keychain adapter is unused), and Google Fonts (`next/font` self-hosts at build time).

## Code paths

| Concern                                         | Path                                                                   |
| ----------------------------------------------- | ---------------------------------------------------------------------- |
| Policy page                                     | `apps/web/src/app/privacy/page.tsx`                                    |
| Support page (contact block)                    | `apps/web/src/app/support/page.tsx`                                    |
| Account deletion explainer ("What may be kept") | `apps/web/src/app/account/delete/page.tsx`                             |
| Public routes allowlist                         | `apps/web/src/lib/supabase/middleware.ts` → `PUBLIC_ROUTES`            |
| Dependency → processor guard                    | `apps/web/__tests__/unit/privacy-policy-processors.test.tsx`           |
| Content assertions                              | `apps/web/__tests__/integration/legal-pages.test.tsx`                  |
| Signed-out reachability (unit)                  | `apps/web/__tests__/unit/middleware.test.ts`                           |
| Signed-out reachability (E2E)                   | `apps/web/e2e/legal-pages.spec.ts`                                     |
| Factory checks                                  | `scripts/factory-{plan,review}-prompt.md`, `scripts/factory-prompt.md` |

## Related ADRs

- [0039 — Privacy Policy Kept in Step with the Code](../adr/0039-privacy-policy-processor-guard.md)
- [0016 — Local Fastlane builds](../adr/0016-local-fastlane-builds.md): why Expo is not a processor
- [0018 — OAuth with Google and Apple](../adr/0018-oauth-google-apple.md)
- [0022 — Note content history](../adr/0022-note-content-history.md): the 30-day edit-history retention the page discloses
- [0024 — Real-time support agent](../adr/0024-realtime-support-agent.md): the Zoho, Anthropic and GitHub flows

## Cross-platform notes

- One page describes all four platforms. The store listings point to `https://drafto.eu/privacy` (`privacyUrl` in `apps/mobile/store/metadata/en-US.json`; the Mac App Store URL is set in App Store Connect). Neither native app links to it in-app.
- Session storage differs by platform and the page says so: cookies on the web, the iOS Keychain or Android Keystore on mobile (`expo-secure-store`), and AsyncStorage on macOS (`apps/desktop/src/lib/supabase.ts`, not the Keychain). Moving macOS to the Keychain is a separate change and triggers the maintenance rule.
- `apps/mobile/store/metadata/privacy-policy.md` is an older Markdown copy kept with the store metadata, and `apps/mobile/store/metadata/store-listing.md` still calls it the "source of truth". Both have pre-#648 text; the source of truth is `apps/web/src/app/privacy/page.tsx`. Sync or retire the copy, and fix the `store-listing.md` line, in a follow-up. Any change under `apps/mobile/` makes the factory queue a mobile beta build, which is why it was left out of #648.

## Modifying safely

**Maintenance checklist.** This is the rule in [`CLAUDE.md` → Privacy Policy Maintenance](../../CLAUDE.md#privacy-policy-maintenance). Update `apps/web/src/app/privacy/page.tsx`, and its "Last updated" date, in the same PR whenever a change:

1. adds, removes, or swaps a third-party service or SDK that receives user data (analytics, error tracking, email, AI, auth provider, hosting, storage)
2. collects a new category of personal data, or a new field on the user or account
3. changes where data is stored, how long it is kept, or how it is deleted (retention jobs, trash, account deletion)
4. adds a way for data to leave Drafto (export, sharing, API keys, integrations)
5. changes the auth or session-storage mechanism on any platform
6. sends user or support data to an AI model

Also: a route that must be reachable signed out (legal, support, store-review pages) goes into `PUBLIC_ROUTES` and `middleware.test.ts`.

- **Invariants:**
  - Every row in the sharing table is a service that actually receives data. A row for a service that receives nothing (Expo before #648, PostHog today) is as wrong as a missing one.
  - The first cell of each row is exactly the service name. The guard test matches on it.
  - The page must not say note content is used to train AI models, and must not claim more than the code does: no Keychain on macOS, no database backups (production is on the Supabase Free tier), no "anonymous" analytics.
  - `/privacy` and `/support` stay in `PUBLIC_ROUTES`. Prefix matching makes any `/privacy/*` or `/support/*` route public too, so keep those static.
- **Page structure:** the numbered sections and the "On this page" contents box both come from `SECTIONS` in `page.tsx`, so a new section is one entry there plus a `<NumberedSection {...section("id")}>` block (`apps/web/src/components/legal/`). Sharing-table rows come from `PROCESSORS`; a new processor is one entry there. The pages are styled by the `.doc-prose` class in `apps/web/src/app/globals.css`, not by Tailwind's `prose`: the typography plugin is not installed, so `prose` does nothing. See [design system → Long-form documents](./design-system.md#long-form-documents).
- **Guard test blind spots:** the dependency scan reads only the `package.json` files of `apps/web`, `apps/mobile`, `apps/desktop` and `packages/shared`. It cannot see:
  - a service called over plain `fetch` with no SDK
  - anything running from `scripts/` on the Mac mini: Zoho, Anthropic and GitHub in the support pipeline are pinned only by the test's `EXPECTED_ROWS`
  - a configuration flip, e.g. setting `NEXT_PUBLIC_POSTHOG_KEY` in Vercel would start sending analytics with no code change. Update the page **before** setting that key.
  - a change in what an existing processor receives, e.g. raising Sentry sample rates or adding `sendDefaultPii`
  - an already-named processor's SDK added to another platform, unless it is an analytics or crash-reporting SDK in a native app (`TELEMETRY`, which the test checks against the page's "no analytics or crash-reporting SDK" claim)

  A green guard test is not proof the policy is complete.

- **Resolving a guard failure:** if a new dependency matches a suspicious name and receives user data, add it to `PROCESSOR_FOR_DEPENDENCY` and give the processor a row in the sharing table (an entry in `PROCESSORS`). If it sends no user data, add it to `NOT_A_PROCESSOR` with the reason. A mapped processor that receives nothing until it is configured (PostHog today) is named in the page text instead of the table, and listed in `NAMED_IN_TEXT_ONLY` with the reason.
- **Files that must change together:** the policy page, `legal-pages.test.tsx`, and the "What may be kept" paragraph on `/account/delete` (it summarises the retention section). A new processor also needs a row in this doc's inventory table.

## Verify

```bash
# Unit + integration (guard test, middleware, page content)
cd apps/web && pnpm test -- privacy-policy-processors middleware legal-pages account-delete-page

# E2E: both pages render signed out
set -a && source apps/web/.env.local && set +a && cd apps/web && pnpm test:e2e -- legal-pages

# Prompt grounding (factory privacy check)
cd scripts && node --test __tests__/factory-plan-prompt-grounding.test.mjs __tests__/factory-implement-prompt-grounding.test.mjs

# Live: both should be 200, not 307 → /login
curl -sI https://drafto.eu/privacy | head -1 && curl -sI https://drafto.eu/support | head -1
```
