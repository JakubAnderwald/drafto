# 0077 — The Factory Renumbers Stale Migrations Mechanically

- **Status**: Accepted
- **Date**: 2026-11-13
- **Authors**: Jakub Anderwald, with Claude Code

## Context

PRs #802 (storage quota, issue #794) and #829 (product metrics, issue #820) were open at the same time, and both added a migration at version `20261111000001`. The implement prompt names migrations `<today>000001_<name>.sql`, so any two cards implemented on the same day get the same version.

`pnpm migration:check` ([ADR 0057](./0057-new-migrations-sort-after-base.md)) compares a PR only with the main it is merged onto. It can't see the clash while both PRs are open, which ADR 0057 accepted. Once #829 merged, #802 would have gone like this:

- `--release` updates the branch, and CI goes red on the order check.
- The CI gate sends the card back to In Review. The fix loop spends an LLM pass, and probably an attempt, on a rename the check had already spelled out as `git mv` lines.
- The new head is reviewed again, goes back to In Test, and needs a **second Approved drag** for a change that is only a rename.

Two smaller holes showed up on the way:

- `--release` updated a branch only when `mergeStateStatus` was literally `BEHIND`. Right after main moves it reads `UNKNOWN`, and that fell through to an owner-token merge, which can bypass `strict` branch protection.
- A clean merge of main by the conflict pass could carry a migration-order error that git doesn't see, and it was pushed.

ADR 0057 rejected "rename at merge time with a bot" (its alternative 4) because "a rename at merge time still leaves dev holding the old version".

## Decision

1. **The factory renumbers a PR's migrations itself, and proves it only renamed them.** `scripts/lib/migration-renumber.mjs`:
   - **Plans** with `checkMigrationOrder()`, fed the file set the merge with main would hold, `(main − (mb − head)) ∪ (head − mb)` with `mb` the merge base. Feeding it only the head's files would report a duplicate as a renamed main migration. Suggestions skip the versions every other open PR uses (`claimedVersions`, from `gh pr diff --name-only`, which has no file cap), through a new optional `extraTaken` argument. CI and the CLI don't pass it, so their output is unchanged.
   - **Builds commit R on the PR's head**, never on a tree merged with main. It uses a temporary `GIT_INDEX_FILE` in the factory checkout and makes no worktree. R renames each mapped file. It rewrites only lines the PR added (`git diff -U0 <mb> <head>`). In those lines it replaces the full stem `<old>_<name>` first, then a bare digit-bounded `<old>` only when the merge base's tree never mentions it and no other file keeps it. The whole map is applied in one pass.
   - **Verifies R** before pushing it, and again before a review carries over. Every changed path must be a mapped rename of a migration the PR adds, or a file the PR already changes. Every changed line must be one the PR added and must map back to its old text exactly under the inverse map. No new version may occur in the old tree.
   - **Pushes R** to `factory/issue-<n>` as `Drafto factory <factory@drafto.eu>`, never forced. It refuses any other branch name. A branch that moved rejects the push, and `ls-remote` tells a lost response from a rejection.
2. **The bash gate `migration_renumber_gate`** runs only for a PR that changes `supabase/migrations/*.sql`:
   - On a fixable plan it pushes R, records `renumberFrom`, `renumberTo` and `renumberMap`, and calls `update_pr_branch <pr> R`, so GitHub adds its own merge of main (M). CI's cancel-in-progress drops R's run.
   - It comments once per R with the old → new map and the dev repair (point 5).
   - It never spends `attempts`, `branchUpdates` or `ciRerun`. It counts renumbers in `migrationRenumbers`, capped by `FACTORY_MAX_MIGRATION_RENUMBERS` (default 3). Past the cap, or when the count can't be read, it renumbers nothing and posts a comment (point 7 says what happens then).
   - It respects `--dry-run`, and it won't renumber past commits a worktree or kept branch has that the PR lacks.
3. **Where it runs.**
   - `--release`, after the migration-label and conflict gates and before the CI gate. A renumbered card **stays in Approved** and merges once CI is green on M.
   - `--watch`: in the behind-main gate before `update_pr_branch`, and at the fix loop's entry when CI is red or the PR conflicts, before the conflict pass's `merge-main` and before any attempt is spent.
   - Only a renumber holds the card, waiting for CI on the new head. An error holds an Approved card for the tick, so a lookup blip can't cost a second Approved drag; in `--watch` it goes on as before.
4. **The review and the approval carry over.** `carry_across_branch_update` also accepts R itself, or a web-flow `Merge branch 'main' into …` commit whose first parent is R. It requires that the commit R renamed (or R) was the last one reviewed, and that `verify` passes. The Approved drag stays valid: the decision with the user was that a verified mechanical renumber keeps it, as an update-branch merge already does ([ADR 0070](./0070-factory-in-test-frees-slot-and-updates-behind-prs.md)).
5. **Dev gets an exact repair in the comment.** It is `supabase migration repair --status reverted <old>`, then `--status applied <new>`, needed only if dev applied the old version. When the old version is also one of main's migrations, the comment says to check which file dev actually ran first. This answers ADR 0057's alternative 4: the rename still leaves dev holding the old version, but the factory now says exactly what to run, and only edits to dev's migration history are needed.
6. **Prod is pushed only from main, after the merge.** A merge-time renumber therefore never touches prod: prod only ever sees the new versions. This invariant is what makes a renumber before the merge safe.
7. **Some cases the factory leaves to the fix loop, with one comment per head.** The card isn't held: it goes on as it did before this decision, so with CI red for migration order the watch prompt's "Migration order" recipe renumbers it in In Review (from Approved, the CI gate hands it back there first, and the card needs approval again). Holding it instead would park it for good. The comment names the reason, so the person approving checks the rename. The cases:
   - a version that isn't 14 digits, or a renamed main migration;
   - a flagged file that isn't one the PR adds;
   - an object overlap: the PR's added migrations create, alter or drop a function, table, view, policy, trigger, type, index or sequence (schema-qualified, case-insensitive) that one of main's migrations added since the merge base also touches. Renumbering changes which definition runs last;
   - a bare version in a PR line that could mean another migration.
8. **Two adjacent fixes.**
   - `--release` updates a PR when `pr_behind_main` is above 0 or `mergeStateStatus` is `BEHIND`, and waits on `UNKNOWN` instead of merging. This applies to every PR.
   - `worktree-cli.mjs merge-main` and `merge-check` report `migrationErrors`. A clean merge that has them reaches the conflict pass only when the gate couldn't rename them (point 7), so it isn't pushed as it stands: the agent gets it, like an ADR clash, and renumbers on top of the merge. Rolling it back every tick would loop with nothing spent. An agent's conflict resolution that leaves one doesn't count as resolved.

## Consequences

- **Positive**:
  - A migration clash between two factory PRs costs one CI run on the second PR, with no LLM pass, no re-review and no second Approved drag.
  - The rename is checked by code, not by trust in an agent: `verify` rejects any commit that changes more than migration names in lines the PR added.
  - Two stale PRs can't both be moved to the same version, because the plan skips every version another open PR uses.
  - `--release` can no longer merge a stale head while GitHub still reads `UNKNOWN`.
- **Negative**:
  - Dev may still need a manual `supabase migration repair` per renamed version. The comment gives the commands, but nothing runs them.
  - Every `--release` tick fetches main and the PR head for each Approved migration card, and a fixable plan lists the open PRs' files with one `gh pr diff` per PR.
  - The object-overlap rule is conservative. Two migrations that alter different columns of the same table go to the fix loop, and a second Approved drag, although a mechanical renumber would be harmless.
  - `--release` waits a tick or more when GitHub reads `UNKNOWN`, and serializes merges behind update-branch, as `strict` protection already asks.
- **Neutral**:
  - A PR written by hand still collides on dev the way ADR 0057 describes. The factory renumbers only factory branches (`factory/issue-<n>`).
  - The watch prompt's "Migration order" recipe stays as the fallback for the cases point 7 lists and for a spent cap.
  - Comments from CodeRabbit on R or M go through the existing thread hand-back.

## Alternatives Considered

1. **Let the fix loop rename, as ADR 0057 decided.** Rejected for this case: it costs an LLM pass, a re-review and a second Approved drag for a change the check already spells out, and its result can't be proven to be only a rename.
2. **Renumber on the tree merged with main.** Rejected: the commit would carry main's changes, so it couldn't be checked against the PR's own lines. Building R on the head and letting GitHub's update-branch add main keeps each commit's purpose separate.
3. **Rewrite every occurrence of the old version in the repo.** Rejected: main's own files may use the same version (the #802/#829 case), and rewriting them would rename the wrong migration. Only lines the PR added are rewritten.
4. **Allocate versions centrally when the migration is written.** Not rejected; it is planned next. It avoids most clashes between factory PRs, but not a stale PR or one written by hand, so the merge-time renumber is still needed.
5. **Require a fresh Approved drag after a renumber.** Rejected with the user: a renumber proven to be mechanical changes no SQL the operator approved, just as an update-branch merge doesn't.

## Related

- [ADR 0026: Dark Factory Pipeline](./0026-dark-factory-pipeline.md)
- [ADR 0057: New Migrations Must Sort After the Base Branch](./0057-new-migrations-sort-after-base.md)
- [ADR 0061: The Factory Resolves Merge Conflicts](./0061-factory-resolves-merge-conflicts.md)
- [ADR 0070: In Test Frees Its Slot; Behind PRs Get Updated](./0070-factory-in-test-frees-slot-and-updates-behind-prs.md)
