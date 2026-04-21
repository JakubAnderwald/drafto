# 0020 — Email Design Tokens

- **Status**: Accepted
- **Date**: 2026-04-21
- **Authors**: Jakub Anderwald

## Context

Drafto sends transactional emails through Resend (see [ADR 0019](./0019-email-infrastructure-and-approval-flow.md)). The HTML for these emails is assembled in `apps/web/src/lib/email/templates.ts` and rendered with inline styles because email clients (Gmail, Outlook, Apple Mail) strip `<style>` blocks and cannot resolve CSS custom properties — Drafto's design tokens live in `apps/web/src/app/globals.css` as CSS variables and therefore cannot be referenced directly from email HTML.

Before this decision, email templates used a generic palette: a blue accent (`#2563eb`), cool-grey surfaces (`#f4f4f5`, `#fafafa`), and Zinc-style muted text colors (`#52525b`, `#71717a`, `#a1a1aa`). None of these matched the [Digital Atelier Design System](./0014-digital-atelier-design-system.md), which defines Drafto's brand as warm neutrals (stone) with an indigo primary (`#3525cd`). This mismatch meant the first touchpoint a new user saw — the approval email — did not look like the product.

We also lacked a shared layout for emails: each template duplicated its own `<!doctype>`, `<body>`, and container scaffolding, and there was no footer branding.

## Decision

Introduce two patterns in `apps/web/src/lib/email/templates.ts`:

1. **`EMAIL_COLORS` constant** — a single source of truth for the email palette. Values are hard-coded hex strings that mirror the corresponding tokens in `globals.css`:

   | Role       | Hex       | CSS token             |
   | ---------- | --------- | --------------------- |
   | `primary`  | `#3525cd` | `--color-primary-600` |
   | `fg`       | `#1f1b17` | `--color-neutral-900` |
   | `fgMuted`  | `#6b6360` | `--color-neutral-500` |
   | `fgSubtle` | `#9c9590` | `--color-neutral-400` |
   | `bg`       | `#fff8f5` | `--color-neutral-50`  |
   | `bgSubtle` | `#fcf2eb` | `--color-neutral-100` |
   | `border`   | `#eae1da` | `--color-neutral-300` |

2. **`renderEmailLayout({ title, bodyHtml })` helper** — all email templates route their outer shell through this helper. It emits the `<!doctype>`, warm-neutral body background, container, title `<h1>`, slot for body HTML, horizontal rule, and a branded footer (`Drafto · drafto.eu`). Individual templates only compose the inner body.

A comment in `globals.css` (above the palette definitions) points readers to `EMAIL_COLORS` as a downstream manually-synced consumer of these tokens.

Out-of-code Supabase Auth email templates (Confirm signup, Reset password, Magic link, Reauthentication), which live in the Supabase Dashboard and cannot be edited from this repo, are covered by a companion runbook at `apps/web/src/lib/email/SUPABASE_TEMPLATES.md`.

## Consequences

- **Positive**: Email rendering now matches Drafto's brand (indigo primary, warm neutrals). A single `EMAIL_COLORS` object is the one place to change when the palette evolves. New email templates inherit a consistent header and footer via `renderEmailLayout`, cutting boilerplate. Snapshot/regression tests can assert on known hex values.
- **Negative**: `EMAIL_COLORS` must be updated by hand whenever `globals.css` palette tokens change — there is no automatic link between the two. The comment in `globals.css` is the mitigation, but it still relies on human discipline. Supabase Dashboard templates remain out-of-code and must be updated via the runbook.
- **Neutral**: Code-rendered email templates gain a footer that did not previously exist; plaintext alternatives are unchanged.

## Alternatives Considered

1. **React Email / MJML** — rich email framework with components, responsive layouts, and a preview server. Rejected for now: it adds a non-trivial dependency (and build-time rendering) for only two code-rendered templates. Worth revisiting if we grow past 5+ distinct templates.
2. **Build-time codegen from CSS** — parse `globals.css` at build time and emit a TS constant. Rejected: brittle (depends on the CSS file shape), adds tooling, and the synchronisation problem is small enough that a code comment suffices.
3. **`<style>` tag with CSS classes** — would let us reuse the same token names. Rejected: Gmail and Outlook on Windows strip or rewrite `<style>` blocks, so inline styles are the only reliable approach for transactional email.
4. **Embed a web view / iframe pointing at drafto.eu** — rejected outright; email clients do not execute JS and iframe support is inconsistent, and this breaks accessibility and deliverability.
