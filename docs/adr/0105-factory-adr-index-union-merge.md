# 0105 — The Factory Union-Merges the ADR Index and Allocates ADR Numbers

- **Status**: Accepted
- **Date**: 2026-11-25
- **Authors**: Jakub Anderwald, with Claude Code

## Context

Every PR that adds an ADR takes the next free number in `docs/adr/` and adds a row to the index table in `docs/adr/README.md`. Two PRs written while the other was still open take the same number, and both append their row at the end of the table. Once one merges, the other conflicts with `main` on that one line of the index.

[ADR 0061](./0061-factory-resolves-merge-conflicts.md) gave the factory a conflict pass for this. Bash merges `main` into the PR branch, and pushes the merge itself when git merges cleanly. Otherwise a Claude run resolves the conflict and renumbers the PR's ADR. The factory audit of 506 sessions (2026-11-25) found that 21 of the 34 conflict passes in 30 days were ADR index rows and number clashes. Each one was a paid Claude run for a merge a script could have made.

Two facts shape the fix:

- An index row conflict is almost always two rows appended at the same place. Keeping both lines resolves it. Git's built-in `union` merge driver does exactly that.
- The number clash is the root cause, and it is the same race [ADR 0079](./0079-factory-allocates-migration-versions.md) closed for migration versions: the implementer picks a number from `main` alone, without looking at the open PRs.

## Decision

1. **The conflict pass merges the index with the union driver.** `worktree-cli.mjs merge-main` runs `git -c core.attributesFile=<scripts/lib/adr-index.gitattributes> merge`. That file holds one rule, `docs/adr/README.md merge=union`. It is passed on the command line and resolved next to the module, so the factory checkout's copy applies to every PR branch. A repo `.gitattributes` would only reach branches cut after it merged, and the conflicts come from branches that are already open. Two appended rows now merge cleanly, and bash pushes the merge with no Claude run and no attempt spent, as it already does for any clean merge.
   - The driver applies to the whole file, not only the table. On a line both sides changed outside the rows (the intro, the "when to write an ADR" list, the table's header and separator, which a re-padded table rewrites) it would quietly keep both wordings, and nothing would look at that clean merge before bash pushed it. So merge-main first previews the merge of the index: `git merge-file --diff3` of the merge base's, the PR's and main's versions. It passes the attributes file only when every line of every conflicting hunk, on all three sides, is an index row (`conflictsOnlyOnIndexRows` in `adr-numbers.mjs`). Otherwise it merges without it, the README conflicts as any file does, and the conflict pass settles it, as before this ADR.
   - The preview also gives the union result it expects. If the real merge's index differs (another diff or conflict style, or a criss-cross merge base), merge-main drops that merge, which never left the worktree, and merges again without the driver.
   - The result reports `adrIndexUnion`: whether the driver merged the index.
2. **Merge-main puts the rows back in number order.** The union driver keeps the PR's lines and main's in the order git met them, so a PR that took 0100 while `main` merged 0099 would list 0100 first. When both sides' index rows were in number order, the merged rows are one unbroken block and no ADR is listed twice, merge-main sorts them. On a clean merge it amends the sorted index into the merge commit it just made (`--no-verify`, because the worktree's hooks need `node_modules` and the merge isn't installed yet). On a merge stopped by another file it stages the sorted index for the conflict pass to commit. It reports `adrIndexReordered`. Any failure leaves the index as git merged it.
3. **An ADR listed twice is a clash.** The union driver also keeps both versions of a row that both sides edited, such as a status change on each side. (A row whose title widened a column makes Prettier re-pad every row and the header, so the preview in item 1 sends that table to an ordinary conflict.) The merged index then lists one ADR on two rows. Merge-main reports these as `adrIndexDuplicates: [{number, rows}]`, leaving out any duplicate `main`'s own index already has. Bash counts them with `adrCollisions` in `ADR_CLASHES`, so such a merge goes to the existing Claude conflict pass instead of being pushed. `merge-check` refuses a resolution whose `HEAD` still lists an ADR twice. The watch prompt's conflict-pass recipe says how to reconcile the rows.
4. **The implement bundle carries the ADR number to use.** When the approved plan mentions `docs/adr` or `ADR-`, `build_implement_bundle` runs `node scripts/lib/adr-allocate.mjs next-adr`, with `--own-pr <n>` on a revision. It fetches `main` and lists every open PR's added or renamed `docs/adr/NNNN-*.md` files with ADR 0079's `claimedVersions()` sweep, now given a path pattern. It prints `{mainNewest, next, own, claimed, skipped}`.
   - `next` is one past the highest number that `main`, another open PR or the card's own PR uses (`allocateAdrNumber` in `adr-numbers.mjs`). A gap below the highest is never reused, because a stale PR may still hold it.
   - The own PR's ADRs aren't claims. They raise the floor, so a revision's second ADR never reuses the first one's number. If the own PR's files can't be listed, `next-adr` fails, because the floor would be unknown. The sweep runs under ADR 0079's 60-second budget.
   - The bundle field is `adr: {mainNewest, next, own, claimed: [{pr, file, number}]}`. `factory-bundle.mjs` keeps only claims with a strict `NNNN-<slug>.md` name, because other PRs' file names reach the model, and caps them at 100. The field is null when the plan doesn't mention an ADR, when `next` isn't a four-digit number past main's newest, or when the lookup fails. A failure logs a warning and never fails the implement.
   - The migration versions and the ADR number go into one rebuild of the bundle. If it fails, the first bundle is used, with a warning for each field.
5. **The implement prompt uses it.** With `bundle.adr` set, a new ADR is `docs/adr/<next>-<slug>.md`, and a second one takes the number after it. With `null`, the old rule applies: the number after the highest on `origin/main`. The prompt also asks for the index row in number order, and for a link and title no wider than the widest already in their columns, so that the row doesn't make Prettier re-pad the table, which the union merge can't reconcile.

The mechanical ADR renumberer, which would rename a clashing ADR in a commit a check proves is only that rename (as ADR 0077 does for migrations), is deferred. With allocation, clashes should be rare enough that the Claude conflict pass is an acceptable fallback.

## Consequences

- **Positive**:
  - Two PRs that each added an index row merge with `main` with no Claude run. That was the commonest conflict pass.
  - The merged index stays in number order.
  - Two factory cards implemented while the other's PR is open no longer pick the same ADR number.
- **Negative**:
  - An implement run whose plan mentions an ADR costs a `git fetch` and one gh call per open PR, even when the plan only cites an existing ADR. The gate is a text match on the plan, because the spec has no ADR field.
  - Two implement runs that start before either PR is open can still take the same number. The conflict pass catches that at merge time, through `adrCollisions`, as before.
  - The union driver can't reconcile a row both sides changed. That comes back as `adrIndexDuplicates` and still costs a Claude pass. So does a table Prettier re-padded, or any other line of the README both sides changed: the preview finds it and the README conflicts as before.
  - Each merge-main whose index both sides changed costs a `git merge-base` and two `git merge-file` runs on temporary copies of the index.
- **Neutral**:
  - The union rule applies only to merges `merge-main` runs. A person merging `main` by hand, and GitHub's update-branch, still see an index conflict as before.
  - A clean merge that merge-main sorted is amended once, before it is pushed. `merge-abort --to` still rolls it back, because the merge never reached `origin`.

## Alternatives Considered

1. **A repo-wide `.gitattributes` with `merge=union`.** Rejected as the only mechanism: branches that are already open don't carry it, and those are the ones that conflict. It would also apply union silently to people's own merges and rebases, where nothing checks for a duplicated row.
2. **A custom merge driver that rebuilds the table.** Rejected for now. It needs a driver registered with `merge.<name>.driver` and a script that parses and re-pads the table, which is more to keep working than union plus a sort. Union handles the common case; the rest goes to the conflict pass.
3. **Generate the index from the ADR files.** Rejected. The index carries a status and a date for each ADR that live only there. Generating it would mean a front-matter convention for every past ADR, and a CI check that the index matches.
4. **Reserve numbers in factory state.** Rejected for the reason ADR 0079 gives for versions: only the Mac mini would see the reservations, and an abandoned card would hold its number until someone cleared it.

## Related

- [ADR 0061: The Factory Resolves Merge Conflicts With Main](./0061-factory-resolves-merge-conflicts.md)
- [ADR 0079: The Factory Allocates Migration Versions Clear of Open PRs](./0079-factory-allocates-migration-versions.md)
- [ADR 0077: The Factory Renumbers Stale Migrations Mechanically](./0077-factory-renumbers-migrations-mechanically.md)
