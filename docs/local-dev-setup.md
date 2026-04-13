# Local Dev Setup

After cloning and running `pnpm install`, ensure these CLI tools are also installed:

1. **Playwright browsers**: `pnpm exec playwright install` — required for E2E tests
2. **Vercel CLI**: `pnpm i -g vercel` ([install docs](https://vercel.com/docs/cli)) — used to pull env vars (`vercel env pull`)
3. **Supabase CLI**: `brew install supabase/tap/supabase` (macOS) or see [install docs](https://supabase.com/docs/guides/cli/getting-started) for other platforms — used for migrations and DB management
4. **Ruby + Fastlane**: `brew install rbenv ruby-build && rbenv install 3.3.7 && rbenv global 3.3.7` then `cd apps/mobile && bundle install` and `cd apps/desktop && bundle install` — required for mobile and desktop builds and store submission via Fastlane
5. **Claude Code memory symlink**: Link the repo-tracked memory to Claude Code's expected path so project context persists across machines:
   ```bash
   mkdir -p ~/.claude/projects/-Users-$(whoami)-code-drafto
   ln -sf "$(pwd)/.claude/memory" ~/.claude/projects/-Users-$(whoami)-code-drafto/memory
   ```

Without these, E2E tests will fail and environment/database workflows won't work.
