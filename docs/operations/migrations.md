# Database Migrations

Operational runbook for Supabase schema migrations and production data safety. Drafto uses two Supabase projects for full isolation — always apply migrations to dev first, verify, then prod.

See [ADR 0008: Production Data Safety Guardrails](../adr/0008-production-data-safety-guardrails.md) for the underlying rationale.

## Supabase projects

| Environment     | Project    | Ref                    | Used By                            |
| --------------- | ---------- | ---------------------- | ---------------------------------- |
| **Production**  | drafto.eu  | `tbmjbxxseonkciqovnpl` | Vercel production (drafto.eu)      |
| **Development** | drafto-dev | `huhzactreblzcogqkbsd` | Local dev, Vercel previews, CI/E2E |

## Migration workflow

1. Write the migration SQL under `supabase/migrations/`.
2. Scan for destructive patterns:

   ```bash
   pnpm migration:check
   ```

3. Verify the linked project ref:

   ```bash
   supabase projects list
   ```

4. Apply to **dev** first:

   ```bash
   pnpm supabase:link:dev && pnpm supabase:push
   ```

5. Verify on dev (run affected queries, check RLS, run E2E if relevant).
6. Apply to **prod** only after explicit user "yes":

   ```bash
   pnpm supabase:link:prod && pnpm supabase:push
   ```

When in doubt about which project is linked, re-link explicitly with `pnpm supabase:link:dev` or `pnpm supabase:link:prod`.

## Destructive SQL prevention

Never run any of the following against production:

- `DROP TABLE`
- `TRUNCATE`
- `DELETE FROM ...` without a `WHERE` clause
- `supabase db reset` (drops and recreates the entire database)

`pnpm migration:check` scans staged migrations for these patterns and blocks the push when it finds them. Run it before every migration push.

## Production operation confirmation rules

- Require explicit user "yes" before any production database operation.
- State the target project (`tbmjbxxseonkciqovnpl`), the operation, and the affected data before asking for confirmation.
- Never batch production operations — run one operation at a time with confirmation for each.

## Backups and recovery

- **Daily automatic backups**: provided by Supabase on all projects.
- **Point-in-Time Recovery (PITR)**: enabled on the Pro plan (production), allowing granular restore to any moment in the retention window.

If a destructive change lands in prod, use PITR via the Supabase dashboard to restore before proceeding with further changes.

## Related

- [ADR 0008: Production Data Safety Guardrails](../adr/0008-production-data-safety-guardrails.md)
- [ADR 0006: Dev/Prod Environment Separation](../adr/0006-dev-prod-environment-separation.md)
- [Local dev setup](./local-dev-setup.md) — installing the Supabase CLI
