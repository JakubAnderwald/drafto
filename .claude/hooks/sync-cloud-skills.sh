#!/bin/bash
# Hook: SessionStart — make the personal skills repo available in cloud sessions.
#
# Cloud sessions (claude.ai/code, the Claude mobile app, routines) start from a
# fresh clone of this repo on an Anthropic VM and never read ~/.claude/skills,
# so the skills in github.com/JakubAnderwald/claude-skills are missing there.
# This hook clones them into .claude/skills/ (gitignored) at the start of every
# cloud session, so a session always gets the latest committed version.
#
# Local sessions exit immediately: this machine already has ~/.claude/skills
# symlinked to the skills checkout, and personal skills override project ones.
#
# The skills repo must be reachable from the session VM. Either make it public,
# or set SKILLS_REPO_TOKEN (a read-only fine-grained PAT scoped to that one
# repo) in the cloud environment's variables at claude.ai/code — the VM's
# proxy-injected git credential only covers repos attached to the session.
# See docs/operations/cloud-sessions.md.

set -uo pipefail

# CLAUDE_CODE_REMOTE is "true" on cloud session VMs and unset everywhere else.
[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0

SKILLS_REPO="${DRAFTO_SKILLS_REPO:-JakubAnderwald/claude-skills}"
# /watch is deliberately excluded: it needs ffmpeg and a local whisper.cpp model
# the session VM does not have.
SKILLS="push merge"

DEST="${CLAUDE_PROJECT_DIR:-$(pwd)}/.claude/skills"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Never prompt for credentials: a prompt would hang until the hook times out.
export GIT_TERMINAL_PROMPT=0

# Feed the token through a credential helper rather than the clone URL, so it
# cannot leak into git's error output (which this hook prints on failure).
# The empty value first clears inherited helpers, so the token wins instead of
# queueing behind the VM's proxy helper. The helper reads the token from the
# environment, so it must be exported for git's subshell to see it.
GIT_ARGS=()
if [ -n "${SKILLS_REPO_TOKEN:-}" ]; then
  export SKILLS_REPO_TOKEN
  GIT_ARGS=(
    -c "credential.helper="
    -c "credential.helper=!f() { printf 'username=x-access-token\npassword=%s\n' \"\$SKILLS_REPO_TOKEN\"; }; f"
  )
fi

if ! CLONE_ERR=$(git ${GIT_ARGS[@]+"${GIT_ARGS[@]}"} clone --depth 1 --quiet \
  "https://github.com/$SKILLS_REPO.git" "$TMP/skills" 2>&1); then
  echo "Personal skills repo ($SKILLS_REPO) could not be cloned, so /push and /merge are not available in this session. Fix: make the repo public, or add SKILLS_REPO_TOKEN to this cloud environment (docs/operations/cloud-sessions.md). Carry on without them. git said: $CLONE_ERR"
  exit 0
fi

if ! mkdir -p "$DEST" 2>/dev/null; then
  echo "Could not create $DEST, so /push and /merge are not available in this session. Carry on without them."
  exit 0
fi

INSTALLED=""
FAILED=""
for skill in $SKILLS; do
  # Clear first, unconditionally: a skill deleted or renamed upstream must not
  # survive in a resumed session as a stale copy of what it used to be.
  rm -rf "$DEST/$skill"
  if [ ! -f "$TMP/skills/$skill/SKILL.md" ]; then
    # Named, not skipped: this means the list above has gone stale.
    FAILED="$FAILED /$skill"
    continue
  fi

  # Force disable-model-invocation: true, overwriting whatever value the source
  # set. Project skills are model-invocable, so an autonomous cloud session (an
  # auto-fix PR run, a routine, a factory job) could load /merge on its own and
  # merge past the human gate. Explicit /push and /merge still work.
  #
  # The rewrite happens in the clone, not in .claude/skills/, so no half-built
  # directory is ever visible to Claude Code's skill watcher.
  SRC="$TMP/skills/$skill"
  if awk '
      NR == 1 {
        if ($0 == "---") { print; print "disable-model-invocation: true"; in_fm = 1 }
        else { print "---"; print "disable-model-invocation: true"; print "---"; print }
        next
      }
      in_fm && $0 == "---" { in_fm = 0; print; next }
      in_fm && /^disable-model-invocation:/ { next }
      { print }
    ' "$SRC/SKILL.md" >"$SRC/SKILL.md.guarded" &&
    mv "$SRC/SKILL.md.guarded" "$SRC/SKILL.md" &&
    cp -R "$SRC" "$DEST/$skill" 2>/dev/null &&
    grep -q '^disable-model-invocation: true$' "$DEST/$skill/SKILL.md"; then
    INSTALLED="$INSTALLED /$skill"
  else
    # Never report a skill as installed unless its guarded SKILL.md is in place.
    rm -rf "$DEST/$skill"
    FAILED="$FAILED /$skill"
  fi
done

if [ -n "$FAILED" ]; then
  echo "Personal skills that could not be installed in this cloud session:$FAILED (from $SKILLS_REPO — missing SKILL.md, or a filesystem error). Do not use them here."
fi

[ -n "$INSTALLED" ] || exit 0

echo "Personal skills installed for this cloud session from $SKILLS_REPO:$INSTALLED (in .claude/skills/). If one is not in the / menu yet, read .claude/skills/<name>/SKILL.md and follow it directly."
exit 0
