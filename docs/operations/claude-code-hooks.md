# Claude Code hooks

Five hooks are committed to this repo and wired in [`.claude/settings.json`](../../.claude/settings.json). They run automatically in any Claude Code session whose project is this repo.

| Hook                      | Event                              | Blocking? | What it does                                                                                                   |
| ------------------------- | ---------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------- |
| `sync-cloud-skills.sh`    | `SessionStart` (`startup\|resume`) | no        | Clones personal skills into `.claude/skills/` on cloud VMs only — see [cloud-sessions.md](./cloud-sessions.md) |
| `prevent-main-commit.sh`  | `PreToolUse` (Bash)                | **yes**   | Refuses a `git commit` that would land on `main`/`master`                                                      |
| `prevent-main-push.sh`    | `PreToolUse` (Bash)                | **yes**   | Refuses a `git push` that would land on `main`/`master`                                                        |
| `migration-stats-pre.sh`  | `PreToolUse` (Bash)                | no        | Row-count snapshot before a migration — see [migrations.md](./migrations.md)                                   |
| `migration-stats-post.sh` | `PostToolUse` (Bash)               | no        | Re-snapshot and diff after a migration                                                                         |

The two `prevent-main-*` guards enforce the "never commit or push directly to `main`" rule in `CLAUDE.md`. Everything else is observability.

## Hooks locate themselves — never a bare `$CLAUDE_PROJECT_DIR`

`CLAUDE_PROJECT_DIR` is pinned to the directory Claude Code was **launched** from and never follows a later `cd`. Start a session in `~/code` and then work in `~/code/drafto` and the project settings still load — they follow the cwd — but `$CLAUDE_PROJECT_DIR/.claude/hooks/…` points at `~/code/.claude/hooks/`, which has no scripts in it. Every hook then dies with `No such file or directory`. Those errors are non-blocking, so the tool call proceeds and **both guards fail open, for the whole session**. This happened: 735 such errors in one session, with nothing enforcing the `main` rule the entire time.

So every command in `.claude/settings.json` resolves the directory itself:

```sh
H="$CLAUDE_PROJECT_DIR/.claude/hooks"; [ -f "$H/<script>.sh" ] || H="$(git rev-parse --show-toplevel 2>/dev/null)/.claude/hooks"; bash "$H/<script>.sh"
```

Two details that matter:

- **It probes the script, not the directory.** `~/.claude/hooks/` exists on a normal dev machine, so a `[ -d "$H" ]` test is satisfied by a session launched from `$HOME` while still resolving to a tree containing none of these scripts.
- **The fallback is the git toplevel**, which is correct inside a worktree too, since `.claude/hooks/` is tracked.

Two more rules, because Claude Code treats **only exit 2** as blocking — a hook that exits 127 or 1 reads as "allow":

- **A guard that cannot run blocks.** If the script cannot be located, or `node` is missing, or `scripts/git-guard.mjs` is gone, the guards exit 2 and say so. Abstaining would run the git command unguarded, which is the failure this document exists to describe. The observability hooks do the opposite and exit 0 — they must never take a tool call down with them.
- **The fallback is constrained to the project tree.** Hooks run from the current working directory, so an unconstrained `git rev-parse --show-toplevel` could land in an unrelated repository and execute _its_ hook with your privileges. The fallback root is accepted only if it is inside `$CLAUDE_PROJECT_DIR`, with both paths canonicalised first (`pwd -P`) — git reports `/private/var/...` where the environment may say `/var/...`, and a raw prefix compare rejects a root that really is inside the project.

Scripts that need the repo root resolve it from their own location (`$0`), not from the environment — `migration-stats-*.sh` and both guards do this. The one exception is `sync-cloud-skills.sh`, which uses `${CLAUDE_PROJECT_DIR:-$(pwd)}`; it runs only on cloud session VMs (`CLAUDE_CODE_REMOTE=true`) and exits immediately everywhere else.

## The guards parse the command, they do not pattern-match it

Both guards are thin wrappers around [`scripts/git-guard.mjs`](../../scripts/git-guard.mjs). The wrapper does a cheap `*git*` prefilter — most Bash calls have nothing to do with git — and otherwise hands the payload to the parser.

Judging a shell command with a regex gets the interesting cases wrong in a different way each time, which is why this is a parser:

- **Structure, not text.** `cd ../elsewhere && git push` has to be seen; `echo "git push"` must not be. An earlier revision anchored on `^\s*git push` and so never examined the first. Its replacement matched separators textually and blocked the second — a `PreToolUse` hook exiting 2 kills the tool call outright, so a guard that fires on prose is worse than no guard.
- **Destination, not spelling.** `git push origin HEAD:main` targets `main`; `git push origin feat/x` does not. Each refspec is resolved to the branch it would land on — `+main`, `main:main`, `refs/heads/main`, `:main`, `HEAD:main` and a bare `main` all resolve to `main`; a push with no refspec resolves to the branch you are standing on.
- **Scope.** `--delete` applies to the invocation it appears in, so `git push origin main && git branch -d old` is still a push to main, while `git push origin --delete feat/x` is not. Deleting `main` itself is blocked.
- **Where it runs.** A `cd`, or `git -C <dir>`, moves the judgement to that directory. Judging the session's branch instead would be both wrong and unpredictable.
- **Heredocs are not commands.** Writing a doc that quotes `git push origin main` is documentation. Bodies of `<<EOF`, `<<'EOF'`, `<<"EOF"` and `<<-EOF` are dropped; `<<<` is a herestring and is not.

- **Expansion.** Bash expands `$( … )` and backticks inside double quotes and inside an _unquoted_ heredoc, so `cat <<EOF` / `$(git push origin main)` / `EOF` runs the push while the surrounding command is only `cat`. Those substitutions are parsed and judged too. Quoting the delimiter (`<<'EOF'`, `<<"EOF"`, `<<\EOF`) turns expansion off, and then the body really is inert.
- **Spelling.** A command word names a program by its basename, and quoting does not stop it running: `/usr/bin/git`, `"git"` and `\git` are all git.
- **Bulk modes.** `--all`, `--mirror` and `--branches` push every local branch whichever one you are standing on, so they are judged against the branch list, not the current branch.
- **The unknown.** `cd -`, a `cd` target carrying an unexpanded variable, and extra operands all leave the directory unresolved. Anything whose answer depends on that directory is blocked; anything decidable without it (`git push origin feat/x`) still decides normally.

Also handled: leading `VAR=value` assignments, an `env`/`command` prefix, `git -c k=v`, and a command hidden inside `sh -c "…"` / `bash -c "…"` / `eval`.

## The browser runner's guard: generated, not committed

The dark factory's browser runner ([ADR-0051](../adr/0051-factory-browser-runner.md)) has a sixth guard, `scripts/lib/browser-guard.mjs`. It isn't in `.claude/settings.json`: it must never apply to an ordinary session, and it must apply to the runner even though that session runs outside the repo. `run_browser_task` generates a settings file per run (`browser-guard.mjs config`, then `settings`) and passes it with `--settings`.

The file wires up three hooks:

- **SessionStart** writes a canary record.
- **PreToolUse on `mcp__claude-in-chrome__.*`** blocks with exit 2. It pins the browser device, keeps the session to its own tabs, enforces the run's exact target origin, blocks a tab that has drifted off that origin, and allows only plain keys (no chords, no function keys, no modified clicks). It runs under a perl `alarm` well inside its timeout, because a PreToolUse hook that times out counts as an allow. It also blocks while an earlier call's PostToolUse is still marked in flight.
- **PostToolUse** records the selected browser and each tab's current URL, and files screenshots.

The file also lists the always-denied Chrome tools under `permissions.deny`.

Every hook command uses absolute paths to node and the guard. Only the PreToolUse command ends in `|| exit 2`, so a pre guard that can't run blocks the call instead of letting it through. SessionStart and PostToolUse always exit 0. A missing SessionStart record is caught by `verify`. A failed post poisons the session or leaves its in-flight marker, and either one makes the next pre deny.

**`claude -p` drops a settings file that fails validation without saying so,** and would run the session with Chrome and no guard. The canary is the check. After each run, `browser-guard.mjs verify` looks for the SessionStart record. If it is missing, the factory turns the runner off until `factory:browser-reset`.

Tests: `cd scripts && node --test __tests__/browser-guard.test.mjs`.

## The verification lane's guard

The verification stage's shell lane ([ADR-0053](../adr/0053-pre-in-test-verification-stage.md)) has a seventh guard, `scripts/lib/verify-guard.mjs`, generated per run like the browser one. `verify-lane.mjs start` writes `guard-config.json` and `guard-settings.json` into the run's directory, and the supervisor passes the settings with `--settings` to a session started with `--setting-sources ""`, so the worktree's own `.claude/settings.json` (and any hook a PR adds to it) never loads. Measured on the Mac mini on 2026-10-21 (claude 2.1.305): the `--settings` hooks fire, the matcher `*` covers Bash, and a project hook in the session's working directory does not run.

The file wires up two hooks:

- **SessionStart** writes a canary record to `guard/<session>.jsonl`.
- **PreToolUse on every tool** (`*`) blocks with exit 2. Only Bash, Read, Grep and Glob are allowed at all. Read, Grep and Glob are kept out of `~/drafto-secrets`, the run's `private/` dir, `.env` files, `~/.config`, `~/.ssh`, `~/.claude`, the keychains and browser profiles under `~/Library`, and the factory's `logs/`, through symlinks too. A Bash command is tokenised (quotes, `$(…)`, backticks, heredocs, redirections) and each simple command checked: `gh`, `claude`, `vercel`, `supabase`, `fastlane`, `sudo`, `osascript`, `launchctl`, `security`, `env`, `printenv`, `npx` and other network or host tools are denied by name; git only with read-only verbs; pnpm / npm never install, publish or run a release-like script; `node scripts/…` only as `node --test`; curl only to localhost; a macOS in-test scenario only with `--preflight` (ADR-0043). Wrappers (`timeout`, `nice`, `xargs`, `find -exec`, `bash -c`, `pnpm exec`) are unwrapped first. Text it can't tokenise is denied. Like the browser guard it runs under a perl `alarm`, and its command ends in `|| exit 2`.

The file also lists `Edit`, `Write`, `NotebookEdit`, `WebFetch` and `WebSearch` under `permissions.deny`, on top of `--tools Bash,Read,Grep,Glob`.

It is defense in depth, not a sandbox. A shell can run a script it wrote to a file, which no pattern guard follows, and the PR's own code (its install scripts and the tests the lane runs) runs with the factory user's access, outside any hook, as it already does in the implement and fix stages. So a session set on misbehaving can read whatever the factory user can: `~/drafto-secrets`, the run's `private/` curl config, the gh credentials. The OS user is the only hard boundary, as it is for the implement stage, which runs with `--dangerously-skip-permissions`.

What the lane adds keeps secrets off its ordinary path: an allowlisted environment (no tokens), an empty `GH_CONFIG_DIR`, the bypass secret and session cookie handed to `preview-curl` through its config and never to the model as text, and the report composer's secret scan, which withholds a lane whose output carries a known secret. That scan matches literals, so a secret encoded on the way out would get past it. Moving the curl config into a supervisor-held proxy wouldn't change this, because the secret's source file stays readable by the same user. The bypass secret only unlocks this project's protected deployments (its previews), and it can be regenerated in the Vercel dashboard. A real wall would be a separate OS user, or a sandbox that denies those reads and limits the network to the preview host. That's a possible follow-up.

The canary check is stricter than the browser runner's: after the session, the supervisor reads `verify-guard.mjs`'s log and the session transcript. No SessionStart record, or tool calls in the transcript with no PreToolUse record, means the session ran unguarded. The lane then reports `unavailable:guard` and pauses itself for 24 hours (`factory:verify-resume` once fixed).

Tests: `cd scripts && node --test __tests__/verify-guard.test.mjs __tests__/verify-lane-supervisor.test.mjs`.

## Verifying

```bash
cd scripts && node --test __tests__/claude-hooks-guards.test.mjs
```

The suite pins the resolver chain in `settings.json`, the full block/allow matrix, every regression named here, and the launched-from-the-wrong-directory failure. It exercises `analyze()` directly with injected branch resolution for speed, plus end-to-end runs through the real hook scripts against temporary repositories.

**Silence does not prove a hook ran.** A hook that succeeds is silent and a hook that was never found used to be silent too — that is precisely how the failure above went unnoticed for a whole session. To check enforcement, provoke a block:

```bash
printf '%s' 'git commit -m x' | jq -Rs '{tool_input:{command:.}}' \
  | bash .claude/hooks/prevent-main-commit.sh; echo "exit=$?"
# On main: exit=2 with a "Blocked:" message. Anything else means it is not enforcing.
```
