# Plan: Dev/Prod Environment Separation

## Context

Currently, **everything** (production at drafto.eu, Vercel preview deploys, local dev, CI E2E tests) shares a single Supabase project (`tbmjbxxseonkciqovnpl`). This means:

- E2E tests create/delete data in the production database
- Preview deployments can corrupt production data
- Destructive migration testing is impossible without risking production
- No safe place to experiment with schema changes

**Goal:** Two fully isolated environments — production Supabase for drafto.eu, a new development Supabase for everything else (previews, local dev, CI).

---

## Execution Order

All CLI tools are available: `supabase` v2.75.0, `vercel` v50.13.2, `gh` v2.86.0.

### Step 1: Create Supabase dev project (CLI)

```bash
supabase projects create drafto-dev \
  --org-id yswelkpfiwyuhhwujmqg \
  --region eu-west-1 \
  --db-password <generated-random>
```

Then capture the new project ref from output.

### Step 2: Get dev project credentials (CLI)

```bash
supabase projects api-keys --project-ref <dev-ref> -o json
```

Extract the `anon` key and construct the URL: `https://<dev-ref>.supabase.co`

### Step 3: Apply migrations to dev project (CLI)

```bash
supabase link --project-ref <dev-ref>
supabase db push
```

### Step 4: Create E2E test user in dev project (CLI)

```bash
# Use Supabase Management API via curl or supabase CLI
# Create user + approve via SQL
supabase --project-ref <dev-ref> sql "INSERT INTO auth.users ..."
```

**Note:** If the Supabase CLI doesn't support remote SQL easily, this step may need the dashboard. Will attempt CLI first, fall back to asking user to do it manually.

### Step 5: Configure dev Supabase auth settings (Manual — dashboard)

This is the **one step that requires the dashboard** — the Supabase CLI doesn't support remote auth config updates.

Auth settings needed on dev project:

- Site URL: `http://localhost:3000`
- Redirect URLs: `http://localhost:3000/**`, `http://127.0.0.1:3000/**`, `https://*-jakubanderwalds-projects.vercel.app/**`
- Email confirmations: enabled
- MFA TOTP: enabled, otp_length=8

### Step 6: Configure Vercel env vars (CLI)

```bash
# Scope existing Supabase vars to production-only, then add dev vars for preview+development
echo "<dev-url>" | vercel env add NEXT_PUBLIC_SUPABASE_URL preview --yes
echo "<dev-url>" | vercel env add NEXT_PUBLIC_SUPABASE_URL development --yes
echo "<dev-key>" | vercel env add NEXT_PUBLIC_SUPABASE_ANON_KEY preview --yes
echo "<dev-key>" | vercel env add NEXT_PUBLIC_SUPABASE_ANON_KEY development --yes

# Sentry environment tagging
echo "production" | vercel env add NEXT_PUBLIC_SENTRY_ENVIRONMENT production --yes
echo "preview" | vercel env add NEXT_PUBLIC_SENTRY_ENVIRONMENT preview --yes
echo "development" | vercel env add NEXT_PUBLIC_SENTRY_ENVIRONMENT development --yes
```

**Important:** Existing vars that currently apply to "all environments" need to be re-scoped to production-only first. Check current scoping with `vercel env ls` and adjust.

### Step 7: Update GitHub Actions secrets (CLI)

```bash
gh secret set NEXT_PUBLIC_SUPABASE_URL --body "<dev-url>"
gh secret set NEXT_PUBLIC_SUPABASE_ANON_KEY --body "<dev-key>"
gh secret set E2E_TEST_EMAIL --body "<dev-test-email>"
gh secret set E2E_TEST_PASSWORD --body "<dev-test-password>"
```

### Step 8: Update local `.env.local` (CLI)

Update the file to point to dev Supabase project.

### Step 9: Code changes (all files edited by Claude)

See "Code Changes" section below.

### Step 10: Verify

- `pnpm dev` — confirm dev Supabase URL in network tab
- `pnpm build` — confirm build succeeds
- `pnpm test` — confirm tests pass

---

## Code Changes (single PR)

### 1. Add `NEXT_PUBLIC_SENTRY_ENVIRONMENT` to env schema

**File:** `src/env.ts`

- Add `NEXT_PUBLIC_SENTRY_ENVIRONMENT: z.string().optional()` to `client`
- Add corresponding entry in `runtimeEnv`

### 2. Add Sentry environment tagging (3 files)

**Files:** `instrumentation-client.ts`, `sentry.server.config.ts`, `sentry.edge.config.ts`

Add to each `Sentry.init()`:

```typescript
environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ?? (process.env.NODE_ENV === "production" ? "production" : "development"),
```

### 3. Add PostHog environment tagging

**File:** `src/lib/posthog/client.ts`

After `posthog.init()`, add:

```typescript
posthog.register({
  environment: process.env.NODE_ENV === "production" ? "production" : "development",
});
```

### 4. Update `.env.local.example`

**File:** `.env.local.example`

- Add comments clarifying dev project usage
- Add `NEXT_PUBLIC_SENTRY_ENVIRONMENT` entry

### 5. Create ADR 0006

**File:** `docs/adr/0006-dev-prod-environment-separation.md` (new)

Document the decision, rationale (data isolation, safe migration testing), and trade-offs.

**File:** `docs/adr/README.md` — add row to index table

### 6. Update README.md

Add an "Environments" section with table showing prod vs dev.

### 7. Update CLAUDE.md

Add Environments section documenting both Supabase projects and migration workflow.

### 8. Add convenience scripts to `package.json`

```json
"supabase:link:dev": "supabase link --project-ref <dev-ref>",
"supabase:link:prod": "supabase link --project-ref tbmjbxxseonkciqovnpl",
"supabase:push": "supabase db push"
```

---

## Files Modified

| File                                               | Type     | Change                                |
| -------------------------------------------------- | -------- | ------------------------------------- |
| `src/env.ts`                                       | Modified | Add `NEXT_PUBLIC_SENTRY_ENVIRONMENT`  |
| `instrumentation-client.ts`                        | Modified | Add `environment` to Sentry.init      |
| `sentry.server.config.ts`                          | Modified | Add `environment` to Sentry.init      |
| `sentry.edge.config.ts`                            | Modified | Add `environment` to Sentry.init      |
| `src/lib/posthog/client.ts`                        | Modified | Add environment super property        |
| `.env.local.example`                               | Modified | Update comments + add new var         |
| `.env.local`                                       | Modified | Point to dev Supabase (not committed) |
| `docs/adr/0006-dev-prod-environment-separation.md` | New      | ADR                                   |
| `docs/adr/README.md`                               | Modified | Add ADR 0006 to index                 |
| `README.md`                                        | Modified | Add Environments section              |
| `CLAUDE.md`                                        | Modified | Add Environments section              |
| `package.json`                                     | Modified | Add supabase link/push scripts        |

---

## What's Automated vs Manual

| Step                        | Method                              | Tool                                            |
| --------------------------- | ----------------------------------- | ----------------------------------------------- |
| Create Supabase dev project | **CLI**                             | `supabase projects create`                      |
| Get API keys                | **CLI**                             | `supabase projects api-keys`                    |
| Apply migrations            | **CLI**                             | `supabase link` + `supabase db push`            |
| Create E2E test user        | **CLI attempt**, dashboard fallback | `supabase` or dashboard                         |
| Configure auth settings     | **Manual (dashboard)**              | Supabase CLI doesn't support remote auth config |
| Vercel env vars             | **CLI**                             | `vercel env add/rm`                             |
| GitHub secrets              | **CLI**                             | `gh secret set`                                 |
| Update .env.local           | **CLI**                             | File edit                                       |
| All code changes            | **CLI**                             | File edits                                      |

**Only 1-2 steps require dashboard access:** Supabase auth settings configuration, and possibly E2E test user creation.

---

## Key Decisions

- **Sentry:** Single project with environment tagging — avoids DSN management overhead
- **PostHog:** Same — environment super property, filter in dashboards
- **CI:** Secret values change (to dev), workflow file unchanged
- **Migration workflow:** `supabase link` + `supabase db push` to each project. Dev first, prod after verification

---

## Verification

1. **Local dev:** `pnpm dev`, confirm dev Supabase URL in network requests
2. **Build:** `pnpm build` succeeds
3. **Tests:** `pnpm test` passes
4. **Vercel preview:** Push branch, verify preview uses dev Supabase URL
5. **Production:** Verify drafto.eu still uses production Supabase URL
6. **Sentry:** Check `environment` tag in Sentry dashboard
