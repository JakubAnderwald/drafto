# 0031 — Personal Skills in Cloud Sessions

- **Status**: Accepted
- **Date**: 2026-08-12
- **Authors**: Jakub Anderwald

## Context

Personal skills live in their own repo, [`JakubAnderwald/claude-skills`](https://github.com/JakubAnderwald/claude-skills), symlinked into place as `~/.claude/skills`. That covers every local session on the Mac and the Mac mini, including the dark factory.

It does not cover cloud sessions. Working on drafto from the Claude mobile app runs a cloud session: a fresh clone of this repo on an Anthropic-managed VM that, by design, never reads `~/.claude/` from any personal machine. `/push` and `/merge` — the two skills that matter most for reviewing and shipping from a phone — were simply absent there.

Claude Code offers three documented ways into a cloud session: files in the repo clone, plugins declared in the repo's `.claude/settings.json`, and skills enabled on the claude.ai account. Two further constraints shaped the choice:

- The skills repo is private, and a cloud session's git credential is proxied and scoped to repositories attached to the session, so cloning a second private repo does not work without a token supplied through the environment.
- Skill discovery watches a top-level `.claude/skills/` directory that existed when the session started; a directory created after launch needs a restart.

## Decision

Clone the wanted skills into `.claude/skills/` at the start of every cloud session, from a `SessionStart` hook committed to this repo (`.claude/hooks/sync-cloud-skills.sh`, matcher `startup|resume`).

The hook is cloud-only: it exits immediately unless `CLAUDE_CODE_REMOTE=true`, so local sessions keep using the symlink. It copies `push/` and `merge/` (not `watch/`, which needs ffmpeg and a local whisper.cpp model) and forces `disable-model-invocation: true` into each copy's frontmatter — overwriting any value the source set, rather than only filling in a missing field — so an autonomous cloud session cannot auto-load `/merge` and merge past the human gate. It always exits 0: a clone failure prints a one-line diagnosis and the session continues.

The guard is only worth as much as its reporting, so a skill counts as installed only after its guarded `SKILL.md` is verified in place, and each destination is cleared before the copy so a skill deleted upstream cannot survive as a stale copy in a resumed session.

Two supporting commitments come with it: `.claude/skills/.gitkeep` is tracked so the directory exists at launch and the watcher picks up what the hook adds, and `.gitignore` keeps `.claude/skills/*` ignored so `/push`'s `git add -A` never commits the clone.

Reachability is configured once, outside the repo: either `claude-skills` becomes public, or a read-only fine-grained PAT scoped to it is set as `SKILLS_REPO_TOKEN` in the cloud environment. Operator instructions live in [`../operations/cloud-sessions.md`](../operations/cloud-sessions.md).

## Consequences

- **Positive**: the skills repo stays the single source of truth, with no copies to keep in sync — every cloud session clones the latest commit. Local behaviour is unchanged. The pattern ports to another repo by copying four small pieces.
- **Negative**: needs a one-time reachability decision (public repo or a PAT in an environment that has no secrets store). Adds a shallow clone to cloud session startup. Skills arrive after Claude Code launches, so discovery leans on live change detection and the tracked placeholder; if that ever regresses, the skills are still readable as files and the session-start note says so.
- **Neutral**: cloud sessions carry a gitignored `.claude/skills/` working copy. Skills reaching cloud sessions are project-scoped there and personal-scoped locally, which is why the copies are stamped non-model-invocable rather than trusted to behave identically.

## Alternatives Considered

- **Commit the skills into `.claude/skills/`**: guaranteed to work with no reachability question, but duplicates the skills into this repo, needs a sync step on every skills change, and makes drafto-unrelated personal workflow part of the repo history.
- **Declare `claude-skills` as a plugin marketplace in `.claude/settings.json`**: the most elegant fit — repo-declared plugins install at session start — but the marketplace source must be reachable, so it requires making the repo public anyway, and it buys nothing over the hook once that is true while adding plugin-manifest scaffolding to the skills repo.
- **Enable the skills on the claude.ai account**: the only option that also covers Cowork and every other repo, and worth doing independently. Rejected as the mechanism here because uploads accept only the six Agent Skills spec frontmatter fields — `user-invocable`, `argument-hint` and friends are hard errors — so it needs a packaging step and a manual re-upload per change, which is exactly the drift the hook avoids.
- **A cloud environment setup script instead of a hook**: runs before Claude Code launches, which would sidestep the discovery timing question, but setup scripts are skipped when a cached environment exists, freezing the skills at cache-build time. It also lives in environment config rather than the repo, so it is invisible to anyone reading the codebase.
