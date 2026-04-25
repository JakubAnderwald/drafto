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

`pnpm migration:check` scans all `supabase/migrations/*.sql` files (or explicitly passed paths) for these patterns and blocks the push when it finds them. Run it before every migration push.

## Production operation confirmation rules

- Require explicit user "yes" before any production database operation.
- State the target project (`tbmjbxxseonkciqovnpl`), the operation, and the affected data before asking for confirmation.
- Never batch production operations — run one operation at a time with confirmation for each.

## Backups and recovery

Production is on the Supabase **Free** tier — there are **no daily automatic backups and no Point-in-Time Recovery**. The 2026-04-24 incident (PR #323) made the cost of relying on those backups concrete: a race-condition bug overwrote one note's content, and recovery only worked because a snapshot of the WatermelonDB WAL file was still on a developer's Mac. The defenses below are the ones we actually have.

- **Per-note content history (`note_content_history`)**: a BEFORE-UPDATE trigger on `notes` archives the prior `content` jsonb on every change. Retained 30 days, then nightly `pg_cron` cleanup. See `supabase/migrations/20260425000001_note_content_history.sql` and ADR 0022. **First-line defense for content overwrites.**
- **Soft delete for notes**: deletions set `is_trashed = true`; a `pg_cron` job purges rows trashed more than 30 days ago (`supabase/migrations/20260302000001_trash_auto_cleanup.sql`). Users can self-recover any accidentally deleted note within that window.
- **Local replicas**: mobile and desktop clients keep a full WatermelonDB SQLite copy per device. These are not a formal backup, but in a worst-case server loss they are the last surviving copy of a user's notes.
- **WAL recovery script**: `scripts/recover-from-wal.py` extracts pre-corruption row versions from a client-side WatermelonDB `.db-wal` file when no other copy survives. Last-resort tool — see section 5 below.

If/when production is upgraded to the Supabase Pro tier, daily backups and PITR become available; the runbook below already references both. The defenses above remain useful regardless.

### Recovery runbook

Pick the section that matches the blast radius. **Stop writing to the affected database before restoring** — PITR restores the whole DB to a point in time, so every write between the mistake and the restore is also lost.

#### 1. Mistake is local only (not pushed)

Edit or delete the offending migration file under `supabase/migrations/` and start over. No restore needed.

#### 2. Bad migration or query hit **dev** (`huhzactreblzcogqkbsd`)

Dev is meant to break — prefer the cheapest recovery:

- Fix the migration file and re-run `pnpm supabase:link:dev && pnpm supabase:push`, **or**
- Restore via the Supabase dashboard → dev project → Database → Backups, **or**
- If dev is throwaway, `pnpm supabase:link:dev` then `supabase db reset --linked` to wipe and re-apply all migrations on the linked dev project. **Never run `supabase db reset --linked` against prod.**

#### 3. Bad migration or query hit **prod** (`tbmjbxxseonkciqovnpl`)

1. **Stop the bleeding.** Do not run further migrations, queries, or deploys. Consider putting the app in read-only / maintenance mode if the bug is still actively corrupting data.
2. **Find the exact timestamp just before the mistake.** Check `git log` on the offending migration, CI run time, or Supabase logs (Dashboard → Logs).
3. **Open** Supabase dashboard → `drafto.eu` project (`tbmjbxxseonkciqovnpl`) → Database → Backups → **Point in Time Recovery**.
4. **Pick the timestamp** and trigger the restore. This restores the entire database — every write between the chosen timestamp and now is lost, including legitimate user activity. Accept this trade-off only if the damage is worse than the lost writes.
5. **Fix the root cause in git** — revert/repair the migration file so the next `supabase db push` does not reapply the same bad SQL.
6. **Post-mortem**: add a regression case to `pnpm migration:check` if the pattern wasn't caught, and record the incident in an ADR if the fix changes a process or convention.

#### 4. You only need to recover specific rows (e.g. a bad `DELETE FROM notes WHERE …`)

**For `notes.content` overwrites within the last 30 days, check the history table first** — it's almost always the right answer and doesn't disturb other user activity:

```sql
select content, content_updated_at, archived_at
  from public.note_content_history
 where note_id = '<id>'
 order by archived_at desc;

-- Restore the version you want:
update public.notes
   set content = (select content from public.note_content_history where id = '<history-id>'),
       updated_at = now()
 where id = '<note-id>';
```

If history isn't sufficient (older damage, deleted notes, or a different column), full PITR is overkill — it clobbers unrelated user activity. Preferred path on a paid plan:

1. In the Supabase dashboard, restore PITR **into a new temporary project** (not over prod).
2. `pg_dump` only the affected rows from the temp project.
3. `INSERT` them back into prod under transaction, with constraints disabled only if necessary and re-enabled after.
4. Delete the temporary project once verified.

If your plan tier does not expose "restore into a new project," contact Supabase support before touching prod — they can perform the side restore for you.

#### 5. Damage is older than the PITR retention window (or there is no PITR)

Production is on the Free tier today, so this is the _normal_ case for damage older than 30 days. Remaining options, in order of viability:

- **`note_content_history`** (≤ 30 days, content overwrites only): see section 4 above.
- **Mobile/desktop users**: their WatermelonDB SQLite files (`apps/mobile/src/db/`, same schema on desktop) still hold their notes. Two paths:
  - **Live DB still readable**: open the `.db` file with `sqlite3` and `SELECT content FROM notes WHERE remote_id = '...'`.
  - **Live DB already corrupted but `.db-wal` exists**: run `scripts/recover-from-wal.py` against the WAL file. It walks every commit group in the WAL and prints each pre-corruption version of the row. This is exactly how the 2026-04-24 incident was recovered.

  Example (the actual 2026-04-24 incident invocation):

  ```bash
  python3 scripts/recover-from-wal.py \
    --wal ~/Library/Containers/eu.drafto.mobile/Data/Documents/watermelon.db-wal \
    --db  ~/Library/Containers/eu.drafto.mobile/Data/Documents/watermelon.db \
    --note-id <supabase-uuid>
  # ...inspect candidates, then emit SQL for the right one:
  python3 scripts/recover-from-wal.py ... --emit-sql restore.sql --pick 1
  ```

  There is no automated re-ingest — reconstruction is manual per user.

- **Web-only users**: effectively unrecoverable. Communicate honestly with affected users.

### Preventative guardrails to lean on

- `pnpm migration:check` — inspects all `supabase/migrations/*.sql` files (or explicitly passed paths) and blocks `DROP TABLE`, `TRUNCATE`, and bare `DELETE`.
- `supabase projects list` before every prod push — confirms which ref is currently linked. Easy to forget when switching between dev and prod.
- Require explicit user "yes" before any prod database operation; state the project ref, operation, and affected data first.
- Apply every migration to dev first and verify before touching prod.

## Related

- [ADR 0008: Production Data Safety Guardrails](../adr/0008-production-data-safety-guardrails.md)
- [ADR 0006: Dev/Prod Environment Separation](../adr/0006-dev-prod-environment-separation.md)
- [Local dev setup](./local-dev-setup.md) — installing the Supabase CLI
