# Dev/Prod Environment Separation — Implementation Plan (Ralph Loop Edition)

## Context

Currently, everything (production at drafto.eu, Vercel preview deploys, local dev, CI E2E tests) shares a single Supabase project (`tbmjbxxseonkciqovnpl`). This means E2E tests create/delete data in production, preview deployments can corrupt production data, and destructive migration testing is impossible.

**Goal:** Two fully isolated environments — production Supabase for drafto.eu, a new development Supabase for everything else (previews, local dev, CI). Plus proper environment tagging in Sentry and PostHog.

**Prerequisites (manual, before starting the loop):**

1. Create Supabase dev project via CLI (`supabase projects create drafto-dev`)
2. Get dev project credentials (`supabase projects api-keys`)
3. Apply migrations to dev (`supabase link` + `supabase db push`)
4. Create E2E test user in dev project
5. Configure dev Supabase auth settings in dashboard (Site URL, redirects, email confirmations, MFA)
6. Configure Vercel env vars via CLI (scope prod vars to production, add dev vars for preview+development)
7. Update GitHub Actions secrets via `gh secret set`
8. Update local `.env.local` to point to dev Supabase

The Ralph loop handles only the **code changes** — infrastructure setup above must be done first.

---

**RALPH LOOP RULES (STRICT):**
You are running in an autonomous, unattended loop. On every single execution, you MUST follow these exact steps in order:

1. **Identify:** Scan the Progress Tracker below and find the _first_ unchecked task `[ ]`.
2. **Scope:** DO NOT attempt multiple tasks. Focus ONLY on that single task.
3. **Implement:** Write the code to satisfy the task's requirements.
4. **Test**: Run the full test suite strictly in CI mode to prevent interactive prompts or watch-mode hangs. Execute exactly this chain: CI=true pnpm test -- --run && CI=true pnpm test:e2e && pnpm lint && pnpm exec tsc --noEmit.
5. **Fix:** If _any_ test or check fails, you must debug, fix the code, and re-run the suite until it is 100% green. Do not proceed until all tests pass.
6. **Record:** Check off the task in this file by changing `[ ]` to `[x]`.
7. **Commit:** Commit and push your changes to git with a descriptive message using the /push protocol. Merge changes to main if CI checks are all resolved and comments replied to.
8. **Exit:** EXIT immediately so the loop can restart with a fresh context window. DO NOT start the next task.

---

## Progress Tracker

### Phase 1: Environment Tagging (Sentry + PostHog)

- [x] 1.1 — Add `NEXT_PUBLIC_SENTRY_ENVIRONMENT` to env schema + all Sentry init files
- [ ] 1.2 — Add PostHog environment super property
- [ ] 1-CP — **Checkpoint**: full suite green
- [ ] 1-PUSH — **Push**: `/push` to PR

### Phase 2: Documentation & Config

- [ ] 2.1 — Update `.env.local.example` with new env var + dev project comments
- [ ] 2.2 — Add convenience scripts to `package.json`
- [ ] 2.3 — Create ADR 0006 + update ADR index
- [ ] 2.4 — Update README.md with Environments section
- [ ] 2.5 — Update CLAUDE.md with Environments section
- [ ] 2-CP — **Checkpoint**: full suite green
- [ ] 2-PUSH — **Push**: `/push` to PR

---

## Key Architectural Decisions

- **Sentry:** Single project, environment tagging via `NEXT_PUBLIC_SENTRY_ENVIRONMENT` — avoids managing multiple DSNs
- **PostHog:** Same approach — environment super property, filter in dashboards
- **CI:** Only secret values change (to dev credentials), workflow files unchanged
- **Migration workflow:** `supabase link --project-ref <ref>` + `supabase db push` — dev first, prod after verification

---

## Phase 1: Environment Tagging (Sentry + PostHog)

**Goal:** Tag all Sentry and PostHog events with the correct environment.

### 1.1 — Add `NEXT_PUBLIC_SENTRY_ENVIRONMENT` to env schema + all Sentry init files

**Files:** `src/env.ts`, `instrumentation-client.ts`, `sentry.server.config.ts`, `sentry.edge.config.ts`

**`src/env.ts`** — Add to `client` schema:

```typescript
NEXT_PUBLIC_SENTRY_ENVIRONMENT: z.string().optional(),
```

Add to `runtimeEnv`:

```typescript
NEXT_PUBLIC_SENTRY_ENVIRONMENT: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT,
```

**`instrumentation-client.ts`** — Add to `Sentry.init()`:

```typescript
environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ?? (process.env.NODE_ENV === "production" ? "production" : "development"),
```

**`sentry.server.config.ts`** — Same `environment` line in `Sentry.init()`.

**`sentry.edge.config.ts`** — Same `environment` line in `Sentry.init()`.

**Tests:**

- Unit: env schema validates with/without the new optional var
- Existing tests must still pass (no breaking changes)

### 1.2 — Add PostHog environment super property

**File:** `src/lib/posthog/client.ts`

After `posthog.init()` call, add:

```typescript
posthog.register({
  environment: process.env.NODE_ENV === "production" ? "production" : "development",
});
```

**Tests:**

- Existing PostHog tests must still pass

---

## Phase 2: Documentation & Config

**Goal:** Update all documentation and config files to reflect the two-environment setup.

### 2.1 — Update `.env.local.example`

**File:** `.env.local.example`

- Add comment: `# These should point to the DEV Supabase project for local development`
- Add `NEXT_PUBLIC_SENTRY_ENVIRONMENT=development` entry under Sentry section

### 2.2 — Add convenience scripts to `package.json`

**File:** `package.json`

Add to scripts:

```json
"supabase:link:dev": "supabase link --project-ref <dev-ref>",
"supabase:link:prod": "supabase link --project-ref tbmjbxxseonkciqovnpl",
"supabase:push": "supabase db push"
```

**Note:** Replace `<dev-ref>` with the actual dev project ref once the Supabase dev project is created (from prerequisites).

### 2.3 — Create ADR 0006 + update ADR index

**Files:** `docs/adr/0006-dev-prod-environment-separation.md` (new), `docs/adr/README.md`

Create ADR documenting:

- **Context:** Single shared Supabase project risks data corruption
- **Decision:** Separate dev and prod Supabase projects, environment tagging in Sentry/PostHog
- **Consequences:** Safer testing, migration workflow requires linking to correct project
- **Alternatives:** Local Supabase (rejected: doesn't cover previews/CI)

Update `docs/adr/README.md` index table — add row for 0006.

### 2.4 — Update README.md with Environments section

**File:** `README.md`

Add "Environments" section with table:

| Environment | Supabase               | Sentry Tag    | Usage                   |
| ----------- | ---------------------- | ------------- | ----------------------- |
| Production  | `tbmjbxxseonkciqovnpl` | `production`  | drafto.eu               |
| Development | `<dev-ref>`            | `development` | Local dev, previews, CI |

### 2.5 — Update CLAUDE.md with Environments section

**File:** `CLAUDE.md`

Add section documenting:

- Both Supabase project refs
- Migration workflow: link to target project, then `supabase db push`
- Dev project used for local dev, previews, CI
- Prod project used only for drafto.eu

---

## Verification

After all phases complete:

1. `pnpm dev` — confirm dev Supabase URL in network tab
2. `pnpm build` — succeeds
3. `pnpm test` — all pass
4. `pnpm lint && pnpm exec tsc --noEmit` — clean
5. Push branch → verify Vercel preview uses dev Supabase URL
6. Check Sentry dashboard for `environment` tag on test events
