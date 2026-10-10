# 0043 — Automated macOS In-Test Scenarios

- **Status**: Accepted
- **Date**: 2026-10-10
- **Authors**: Jakub Anderwald (with Claude Code)

## Context

The dark factory moves a card to **In Test** with a written test scenario and, for macOS, a TestFlight build ([ADR-0030](./0030-in-test-scenarios-and-pre-merge-betas.md)). A person then works through the steps by hand. For #458 (PR #673, desktop sync gating) the scenario had 13 steps, and several of its key checks can't be seen by a person at all. "An unapproved user never pulls", for example, is invisible in the UI.

The repo already drove the desktop app from shell for E2E and store screenshots (`apps/desktop/e2e/lib/ax-helpers.sh`). That approach clicks with `cliclick` at elements found by AppleScript description, and it proved unreliable for a long, stateful run against the TestFlight build:

- clicks were dropped after typing;
- clicks dragged the window;
- `AXPress` is unsupported in React Native macOS 0.81.

The scenario also needs a production account in a state no tester has to hand: freshly signed up, unapproved, then approved mid-run.

## Decision

Automate macOS In-Test scenarios with a harness in `apps/desktop/e2e/in-test/`, documented in [`docs/operations/macos-in-test-automation.md`](../operations/macos-in-test-automation.md):

1. **Input without the mouse.** Controls are pressed by setting `AXFocused` on them, checking they report focus, and sending Space. Text fields are filled by focus and paste, then checked by length. A small Swift helper (`axq`) reads and focuses accessibility elements.
2. **Oracles beyond the UI:**
   - the app's local WatermelonDB, read-only from its sandbox container;
   - the production API as the throwaway user;
   - Vision OCR of window captures, for text not exposed to accessibility;
   - the app's JS console via `log stream`.
3. **A throwaway production account per run:**
   - signed up through the app;
   - e-mail-confirmed and approved by SQL through the Supabase Management API, scoped to that account's exact e-mail or id;
   - deleted at the end, by the app's own flow with a scoped SQL fallback in an `EXIT` trap.
4. **A person starts every full run in Terminal,** after preflight passes, by typing `YES`. Agents may write scenarios and run the read-only `--preflight` only.
5. **One scenario per In-Test card** in `scenarios/`, sharing `lib/`. A step records PASS, WARN (a known, unrelated bug, cited by issue) or FAIL (a regression in the change under test).

## Consequences

- **Positive:**
  - A 13-step macOS scenario runs in about 4 minutes with evidence per step: the report, screenshots, the SQL log and the app log.
  - Checks a person can't see, such as "no pull happened", become hard assertions.
  - The #458 runs found four app bugs that already existed on main (#675–#678).
- **Negative:**
  - Runs write to production: one account, a few rows, and one admin e-mail per run.
  - Scenarios that test reconnects take the whole Mac offline for under a minute.
  - The harness depends on Terminal's privacy permissions, an unlocked screen, the Supabase CLI's keychain token, and accessibility details of the current React Native macOS version, which may change when it is upgraded.
- **Neutral:**
  - It is not part of the test matrix or CI. The In-Test human gate stays: a person reads the report and decides whether to approve.

## Alternatives Considered

- **Keep testing by hand.** That's slow, it can't observe the local database or sync timing, and it would have missed the four bugs above.
- **Extend `ax-helpers.sh` (cliclick plus AppleScript descriptions).** Rejected for long runs because of the dropped clicks and window drags measured on build 59. That script still serves the short E2E suite and the screenshot generator.
- **Run against the dev Supabase project.** TestFlight builds are compiled against production, and In Test exists to check the build that will ship.
- **Admin SQL through `supabase db query`.** The CLI installed on the Mac mini (v2.75) doesn't have it. The Management API endpoint it wraps works with the same login.
- **Let an agent start full runs unattended.** Rejected: a run writes to production and changes the Mac's network settings, so a person confirms each one.
