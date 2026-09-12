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

If both fail, the hook errors and the tool call proceeds — a non-blocking failure, visible in the transcript but not enforced. That visibility is the only signal, which is why the regression test below exists.

Scripts that need the repo root resolve it from their own location (`$0`), not from the environment — `migration-stats-*.sh` and both guards do this. The one exception is `sync-cloud-skills.sh`, which uses `${CLAUDE_PROJECT_DIR:-$(pwd)}`; it runs only on cloud session VMs (`CLAUDE_CODE_REMOTE=true`) and exits immediately everywhere else.

## The guards parse the command, they do not pattern-match it

Both guards are thin wrappers around [`scripts/git-guard.mjs`](../../scripts/git-guard.mjs). The wrapper does a cheap `*git*` prefilter — most Bash calls have nothing to do with git — and otherwise hands the payload to the parser.

Judging a shell command with a regex gets the interesting cases wrong in a different way each time, which is why this is a parser:

- **Structure, not text.** `cd ../elsewhere && git push` has to be seen; `echo "git push"` must not be. An earlier revision anchored on `^\s*git push` and so never examined the first. Its replacement matched separators textually and blocked the second — a `PreToolUse` hook exiting 2 kills the tool call outright, so a guard that fires on prose is worse than no guard.
- **Destination, not spelling.** `git push origin HEAD:main` targets `main`; `git push origin feat/x` does not. Each refspec is resolved to the branch it would land on — `+main`, `main:main`, `refs/heads/main`, `:main`, `HEAD:main` and a bare `main` all resolve to `main`; a push with no refspec resolves to the branch you are standing on.
- **Scope.** `--delete` applies to the invocation it appears in, so `git push origin main && git branch -d old` is still a push to main, while `git push origin --delete feat/x` is not. Deleting `main` itself is blocked.
- **Where it runs.** A `cd`, or `git -C <dir>`, moves the judgement to that directory. Judging the session's branch instead would be both wrong and unpredictable.
- **Heredocs are not commands.** Writing a doc that quotes `git push origin main` is documentation. Bodies of `<<EOF`, `<<'EOF'`, `<<"EOF"` and `<<-EOF` are dropped; `<<<` is a herestring and is not.

Also handled: leading `VAR=value` assignments, an `env`/`command` prefix, `git -c k=v`, and a command hidden inside `sh -c "…"` / `bash -c "…"` / `eval`.

## Verifying

```bash
cd scripts && node --test __tests__/claude-hooks-guards.test.mjs
```

The suite pins the resolver chain in `settings.json`, the full block/allow matrix, every regression named above, and the launched-from-the-wrong-directory failure. It exercises `analyze()` directly with an injected branch resolver for speed, plus a handful of end-to-end runs through the real hook scripts against temporary repositories.

To check the hooks are alive in a running session, run any Bash command and look for hook errors. Silence means they ran.
