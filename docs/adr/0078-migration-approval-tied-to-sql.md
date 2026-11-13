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

1. **The label vouches for a hash of the PR's migration files with its own versions left out, but not their order.** `migrationSqlHash()` in `scripts/lib/migration-approval.mjs`:
   - covers every file under `supabase/migrations/` (any depth, any extension) that the PR adds, changes or deletes, from its merge base with `main` to its head (`git diff --name-status --no-renames`), read at the head;
   - keys each versioned migration the PR adds (`<digits>_<name>` directly in the folder, read with `check-migration-order.mjs`'s `directMigrationNames` and `versionOf`) by its rank among the PR's added versioned migrations in version order and its name without the version: `1:create_table.sql`. Every other file, a changed or deleted migration, a file in a subfolder or a file that isn't a migration, is keyed by its full path;
   - in every text file's content, replaces each digit-bounded occurrence of a version the PR adds, of any length, with `@<key>` of the file that has it. Where two added files share a version, the `_<name>` that follows picks the file;
   - takes the sha256 of the entries sorted by key, cut to 16 hex characters.

   A renumber changes only the PR's own versions, in file names and in lines the PR added, and keeps their order, so the hash stays the same. That holds for a version that wasn't 14 digits too. Any other change to those files changes it, and so does adding, deleting or renaming one. So does swapping the versions of two of the PR's migrations, because that changes the order they run in.

2. **`migration_approval_vouch`** in `scripts/factory-agent.sh` keeps the label and the record in step, for a PR whose diff touches `supabase/migrations/`. The factory state field `migrationApprovedVouched` holds `<PR>:<head sha>:<hash>`. A value for another PR (the card's earlier PR) counts as nothing recorded, and so does a value that isn't that shape, with a log line.
   - label present and the recorded head is this head: nothing to do. The SQL can't have changed, so there is no fetch and no hash;
   - label present and nothing recorded: record this PR, head and hash;
   - label present and the same hash at a new head: record the new head;
   - label present and a different hash: first make sure the issue has the comment (`<!-- drafto-factory-migration-approval-void:<hash> -->`) that lists the PR's migration files and asks the operator to review them and add the label again. The lookup (`issue_marker_check`) tells comments that couldn't be fetched apart from a missing comment. Only then remove the label (`gh pr edit --remove-label`), and only once the removal worked clear the record. A failed lookup, comment or removal keeps the label and the record, so the next tick retries from where it stopped, and the operator never finds the label gone without the reason;
   - label absent and anything recorded: clear it, so the next label is vouched for afresh;
   - when the state, the diff or the hash can't be read, nothing changes that tick. It never voids on an error.

   It respects `--dry-run`, and hands its caller the label list without a label it voided, even when the removal hasn't worked yet.

3. **Where it runs: every column the factory processes with the PR, every tick.**
   - `--watch`, In Review: early in the per-card loop, from the PR view the loop already fetches (head and labels).
   - `--watch`, Testing: in `verify_sweep_card`, from its PR view (with `labels` added).
   - `--watch`, In Test: in the sweep, after the conflict hand-back, from its PR view (with `labels` added) and its diff.
   - `--implement`: before Claude runs on a card that came back to In Progress with an open PR (a revision from In Test, a retry), from one PR view.
   - `--release`: right before the migration gate. A voided label reaches the gate as missing, so the card stays in Approved with the gate's existing hold comment. The hash is of the head the merge is pinned to.

   None of these changes what happens to the card, except that the label comes off. Where the caller has no list of changed files, the vouch fetches it only when the label is on and the head isn't the one recorded. The CLI (`node scripts/lib/migration-approval.mjs hash --pr <n> --head <sha>`) fetches `main` and `pull/<n>/head` into the factory checkout, as `migration-renumber.mjs` does, only then too.

4. **First sight.** As with ADR-0065, the label vouches for the SQL the factory first sees it with. A commit pushed after the label was added and before the factory next processes the card is vouched for as if it had been reviewed. While the card is in a column the factory processes, that window is at most one tick (5 minutes). A push while the card sits in a column the factory doesn't process, such as Blocked, or while the factory or the card is paused, isn't seen until the card is processed again. Once something is recorded, such a push is still caught then, before any merge, because `--release` checks first; the longer window only applies to a label added while the card isn't being processed.

## Consequences

- **Positive**
  - SQL edited after the operator's sign-off no longer merges on it. The factory says why, then removes the label, at most a tick after the push.
  - A mechanical renumber (ADR-0077) and an update-branch merge keep the approval, so the clash between two factory migrations still costs no second sign-off.
  - Re-approving is the same action as approving: add the label.
- **Negative**
  - Each tick reads the factory state once per card in the columns above. `main` and the PR head are fetched and hashed only when a PR that carries the label and touches migrations has a new head.
  - A merge of `main` that changes an existing migration this PR also changes alters the hash, so it voids the label. That is rare and fails safe.
  - A renumber also voids it in one rare, fail-safe case: an existing migration the PR changes has a line the PR didn't add that mentions one of the PR's own versions. The renumber leaves that line alone, so it no longer normalizes the same way.
  - An edit to a file under `supabase/migrations/` that isn't a migration, such as a README, voids the label too. It fails safe.
  - The comment lists all the PR's files under `supabase/migrations/`, not only the changed ones, because the state keeps one hash, not one per file.
- **Neutral**
  - The first-sight window ADR-0065 accepts applies here too.
  - The label stays the operator's to add. The factory only ever removes it.

## Alternatives Considered

- **Hash the raw migration files.** Rejected: every renumber would void the label and ask for a second sign-off on SQL nobody changed, the cost ADR-0077 removes.
- **Key added migrations by name only, without their rank.** Rejected: swapping the versions of two of the PR's migrations changes the order they run in, and with name keys it kept the hash.
- **Tie the label to the head SHA.** Rejected: every commit would void it, including an update-branch merge, a renumber and a change outside the migrations.
- **Remember the reviewed SQL itself and show a diff in the comment.** Clearer for the operator, but it stores migration text in the factory state. The PR's own history already shows what changed.
- **A required CI check.** Rejected for the same reason as in ADR-0065: a red check sends the card into the fix loop, which can't approve a migration.
- **One helper shared with the `hosted-config-applied` vouch (ADR-0065).** Considered, since both tie a label to the hash it was first seen with. Not done: that vouch sits inside a gate that has already fetched `config.toml` and whose own hold comment explains the hold, while this one keys its record per PR and head, skips the fetch while the head is unchanged, and comments before it removes the label, so a shared helper would mostly carry options only one caller uses.

## Related

- [ADR 0026: Dark Factory Pipeline](./0026-dark-factory-pipeline.md)
- [ADR 0065: Gate Factory Cards on the Hosted Supabase Config](./0065-factory-hosted-config-gate.md)
- [ADR 0077: The Factory Renumbers Stale Migrations Mechanically](./0077-factory-renumbers-migrations-mechanically.md)
