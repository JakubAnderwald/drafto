# 0078 — Tie `migration-approved` to the Migration SQL

- **Status**: Accepted
- **Date**: 2026-11-13
- **Authors**: Jakub Anderwald, with Claude Code

## Context

`--release` merges a factory PR that touches `supabase/migrations/**` only once the `migration-approved` label is on it (ADR-0026). The label is the operator's sign-off on the migration SQL, but it wasn't tied to that SQL. A commit that changed the migration after the label went on, such as a fix pass, a revision from In Test or a conflict resolution, merged on the old approval.

Two decisions shape the fix:

- [ADR 0077](./0077-factory-renumbers-migrations-mechanically.md) lets the factory rename a stale PR's migrations at merge time, in a commit a check proves is only that rename. The user decided that such a renumber keeps the approval, as an update-branch merge already does. A tie to the raw SQL would void the label on every renumber, because the renamed files carry their new version in their names and in the references the PR added.
- [ADR 0065](./0065-factory-hosted-config-gate.md) already ties `hosted-config-applied` to one version of `supabase/config.toml`: the hash it was first seen with. The same mechanism fits here.

## Decision

1. **The label vouches for a hash of the PR's migration SQL with its own versions left out.** `migrationSqlHash()` in `scripts/lib/migration-approval.mjs`:
   - covers the `*.sql` files directly under `supabase/migrations/` that the PR adds, changes or deletes, from its merge base with `main` to its head (`git diff --name-status --no-renames`), read at the head;
   - keys an added file by its name without the 14-digit version, and a changed or deleted file by its full name. Two added files with the same name get `#1`, `#2` in version order;
   - in every file's content, replaces each digit-bounded occurrence of a version the PR adds with `@<key>` of the file that has it. Where two added files share a version, the `_<name>` that follows picks the file;
   - takes the sha256 of the entries sorted by key, cut to 16 hex characters.

   A renumber changes only the PR's own versions, in file names and in lines the PR added, and keeps their order, so the hash stays the same. Any other change to the SQL changes it, and so does adding, deleting or renaming a migration file.

2. **`migration_approval_vouch`** in `scripts/factory-agent.sh` keeps the label and the hash in step, for a PR whose diff touches `supabase/migrations/`:
   - label present and no hash recorded: record the hash in the factory state field `migrationApprovedVouched`;
   - label present and a different hash: remove the label (`gh pr edit --remove-label`). The recorded hash is cleared only once the removal worked, so a failed removal is retried next tick. The issue gets one comment per new hash (`<!-- drafto-factory-migration-approval-void:<hash> -->`) that lists the PR's migration files and asks the operator to review them and add the label again;
   - label absent and a hash recorded: clear it, so the next label is vouched for afresh;
   - when the state or the hash can't be read, nothing changes that tick. It never voids on an error.

   It respects `--dry-run`, and hands its caller the label list without a label it voided.

3. **Where it runs.**
   - `--release`, right before the migration gate. A voided label reaches the gate as missing, so the card stays in Approved with the gate's existing hold comment. The hash is of the head the merge is pinned to.
   - The In Test sweep, after the conflict hand-back, so a label added while the card is tested is tied to the tested SQL, and a voided one comes off before the Approved drag. It reuses the PR view the sweep already fetches (with `labels` added) and its diff.

   The CLI (`node scripts/lib/migration-approval.mjs hash --pr <n> --head <sha>`) fetches `main` and `pull/<n>/head` into the factory checkout, as `migration-renumber.mjs` does, and only when the label is on the PR.

4. **First sight.** As with ADR-0065, the label vouches for the SQL the factory first sees it with. A commit pushed after the label was added and before the next tick is vouched for as if it had been reviewed. The window is one tick (5 minutes), and the In Test sweep narrows it further for a label added while the card is tested.

## Consequences

- **Positive**
  - SQL edited after the operator's sign-off no longer merges on it. The factory removes the label and says why.
  - A mechanical renumber (ADR-0077) and an update-branch merge keep the approval, so the clash between two factory migrations still costs no second sign-off.
  - Re-approving is the same action as approving: add the label.
- **Negative**
  - Each tick fetches `main` and the PR head once per In Test or Approved card that carries the label and touches migrations.
  - A merge of `main` that changes an existing migration this PR also changes alters the hash, so it voids the label. That is rare and fails safe.
  - A renumber also voids it in one rare, fail-safe case: an existing migration the PR changes has a line the PR didn't add that mentions one of the PR's own versions. The renumber leaves that line alone, so it no longer normalizes the same way.
  - The comment lists all the PR's migration files, not only the changed ones, because the state keeps one hash, not one per file.
- **Neutral**
  - The first-sight window ADR-0065 accepts applies here too.
  - The label stays the operator's to add. The factory only ever removes it.

## Alternatives Considered

- **Hash the raw migration files.** Rejected: every renumber would void the label and ask for a second sign-off on SQL nobody changed, the cost ADR-0077 removes.
- **Tie the label to the head SHA.** Rejected: every commit would void it, including an update-branch merge, a renumber and a change outside the migrations.
- **Remember the reviewed SQL itself and show a diff in the comment.** Clearer for the operator, but it stores migration text in the factory state. The PR's own history already shows what changed.
- **A required CI check.** Rejected for the same reason as in ADR-0065: a red check sends the card into the fix loop, which can't approve a migration.

## Related

- [ADR 0026: Dark Factory Pipeline](./0026-dark-factory-pipeline.md)
- [ADR 0065: Gate Factory Cards on the Hosted Supabase Config](./0065-factory-hosted-config-gate.md)
- [ADR 0077: The Factory Renumbers Stale Migrations Mechanically](./0077-factory-renumbers-migrations-mechanically.md)
