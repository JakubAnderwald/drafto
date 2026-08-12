# Cloud sessions (claude.ai/code, mobile app, routines)

Cloud sessions run Claude Code on an Anthropic-managed VM instead of this Mac. They are what you get from [claude.ai/code](https://claude.ai/code), the Claude mobile app, `claude --cloud`, and [routines](https://code.claude.com/docs/en/routines). Rationale for the setup below: [ADR-0031](../adr/0031-personal-skills-in-cloud-sessions.md).

## What reaches a cloud session

A cloud session starts from a fresh clone of this repo. Everything it knows comes from that clone, from plugins declared in the repo's `.claude/settings.json`, or from skills enabled on your claude.ai account. Nothing from `~/.claude/` on a local machine travels with it.

| Carried over                                                                  | Not carried over                                          |
| ----------------------------------------------------------------------------- | --------------------------------------------------------- |
| `CLAUDE.md`, `.claude/settings.json` hooks, `.mcp.json`                       | `~/.claude/CLAUDE.md`                                     |
| Tracked files under `.claude/skills/`, `.claude/agents/`, `.claude/commands/` | `~/.claude/skills/` — including the symlinked skills repo |
| Plugins declared in the repo's `.claude/settings.json`                        | Plugins enabled only in user settings                     |
| —                                                                             | Local secrets (`~/drafto-secrets/`), SSO, MDM settings    |

Full reference: [What carries over from your setup](https://code.claude.com/docs/en/cloud-environments#what-carries-over-from-your-setup).

## Personal skills in cloud sessions

`~/.claude/skills` on this Mac is a symlink to the [`claude-skills`](https://github.com/JakubAnderwald/claude-skills) checkout, so `/push` and `/merge` are missing from any cloud session by default.

`.claude/hooks/sync-cloud-skills.sh` fixes that. It runs as a `SessionStart` hook on `startup|resume` and:

1. Exits immediately unless `CLAUDE_CODE_REMOTE=true`, so local sessions are untouched (the symlink already serves them, and personal skills override project ones).
2. Shallow-clones `claude-skills` and copies `push/` and `merge/` into `.claude/skills/`. `watch/` is excluded — it needs ffmpeg and a local whisper.cpp model the VM does not have.
3. Forces `disable-model-invocation: true` into each copied `SKILL.md`'s frontmatter, overwriting any value the source set. Project skills are model-invocable, and an autonomous cloud session (auto-fix PR, routine, factory job) could otherwise load `/merge` on its own and merge past the human gate. Typing `/push` or `/merge` still works.
4. Reports honestly. A skill counts as installed only once its guarded `SKILL.md` is verified in place; anything that fails to copy or rewrite is named as unavailable rather than silently claimed. A skill deleted or renamed upstream is cleared from `.claude/skills/` even when the replacement cannot be installed, so a resumed session never keeps a stale copy.
5. Exits 0 no matter what. A non-zero hook would not block the session, but a clone failure prints a one-line explanation instead of failing silently.

Because the clone happens on every session, cloud sessions always get the latest committed skills with no sync step.

Two supporting pieces are easy to break:

- **`.claude/skills/.gitkeep` is tracked on purpose.** Claude Code only watches a top-level skills directory that existed when the session started. Without the placeholder, skills the hook drops in would need a session restart to be discovered.
- **`.gitignore` keeps `.claude/skills/*` ignored.** `/push` runs `git add -A`, so an un-ignored clone would end up committed into this repo.

### Reachability: the skills repo is public

**Current state: `claude-skills` is public, so no token is configured and none is needed.** If it ever goes private again, the hook stops finding it and every cloud session prints the failure note until a token is added.

The session VM's git credential is proxied and scoped to repositories attached to the session, so a private `claude-skills` is not clonable by default. The two options:

| Option                                 | How                                                                                                                                                                       |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Make `claude-skills` public (simplest) | `gh repo edit JakubAnderwald/claude-skills --visibility public`. The hook needs no token; github.com is on the Trusted network allowlist.                                 |
| Keep it private, add a token           | Create a fine-grained PAT with read-only **Contents** on `claude-skills` only, then add `SKILLS_REPO_TOKEN=<pat>` to the cloud environment's variables at claude.ai/code. |

Cloud environments have no secrets store — anyone who can use the environment can read its variables — so scope the PAT to that one repo and nothing else.

### Verify from the phone

Open a cloud session on this repo and ask it to run:

```bash
echo "$CLAUDE_CODE_REMOTE" && ls .claude/skills/
```

`true` plus `merge` and `push` means the hook worked. If the skills repo was unreachable, the session start note says so and names the fix. If `/push` is absent from the `/` menu but the directory is populated, the skill still works — read `.claude/skills/push/SKILL.md` and follow it.

### Change which skills travel

Edit `SKILLS` in `.claude/hooks/sync-cloud-skills.sh`. Point the hook at a different repo with `DRAFTO_SKILLS_REPO=<owner>/<repo>`.

To reuse this in another repo, copy `.claude/hooks/sync-cloud-skills.sh`, the `SessionStart` block from `.claude/settings.json`, the `.claude/skills/` `.gitignore` lines, and the `.gitkeep` placeholder.

## Related

- [`../adr/0031-personal-skills-in-cloud-sessions.md`](../adr/0031-personal-skills-in-cloud-sessions.md) — why a hook rather than committed skills or a plugin marketplace
- [Configure cloud environments](https://code.claude.com/docs/en/cloud-environments) — network access levels, environment variables, setup scripts
- [`../features/dark-factory.md`](../features/dark-factory.md) — the factory runs locally on the Mac mini, so this hook is a no-op there
