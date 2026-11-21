# Local Dev Setup

After cloning and running `pnpm install`, ensure these CLI tools are also installed:

1. **Playwright browsers**: `pnpm exec playwright install` — required for E2E tests
2. **Vercel CLI**: `pnpm i -g vercel` ([install docs](https://vercel.com/docs/cli)) — used to pull env vars (`vercel env pull`)
3. **Supabase CLI**: `brew install supabase/tap/supabase` (macOS) or see [install docs](https://supabase.com/docs/guides/cli/getting-started) for other platforms — used for migrations and DB management
4. **Ruby + Fastlane**: `brew install rbenv ruby-build && rbenv install 3.3.7 && rbenv global 3.3.7` then `cd apps/mobile && bundle install` and `cd apps/desktop && bundle install` — required for mobile and desktop builds and store submission via Fastlane

Without these, E2E tests will fail and environment/database workflows won't work.

## `apps/web/AGENTS.md` (written by Next.js)

`next dev` (Next 16) writes `apps/web/AGENTS.md` when it detects an AI coding agent such as Claude Code. The file holds one managed block telling agents that this Next.js differs from their training data and that the version-matched docs are in `node_modules/next/dist/docs/`. The repo commits it, so `next dev` finds it current and leaves the working tree clean. Claude Code itself loads `CLAUDE.md`, not this file; it is for other agent tools.

Don't edit the block by hand. A Next.js upgrade can rewrite it: commit that diff with the upgrade. `agentRules: false` in `next.config` would stop Next writing it.
