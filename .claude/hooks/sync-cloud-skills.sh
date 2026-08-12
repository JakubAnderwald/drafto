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

mkdir -p "$DEST"
INSTALLED=""
for skill in $SKILLS; do
  [ -f "$TMP/skills/$skill/SKILL.md" ] || continue
  rm -rf "$DEST/$skill"
  cp -R "$TMP/skills/$skill" "$DEST/$skill"
  # Project skills are model-invocable, so an autonomous cloud session (an
  # auto-fix PR run, a routine, a factory job) could load /merge on its own and
  # merge past the human gate. Require an explicit /push or /merge instead.
  if ! grep -q '^disable-model-invocation:' "$DEST/$skill/SKILL.md"; then
    awk 'NR==1 && $0 == "---" { print; print "disable-model-invocation: true"; next } { print }' \
      "$DEST/$skill/SKILL.md" >"$DEST/$skill/SKILL.md.tmp" &&
      mv "$DEST/$skill/SKILL.md.tmp" "$DEST/$skill/SKILL.md"
  fi
  INSTALLED="$INSTALLED /$skill"
done

[ -n "$INSTALLED" ] || exit 0

echo "Personal skills installed for this cloud session from $SKILLS_REPO:$INSTALLED (in .claude/skills/). If one is not in the / menu yet, read .claude/skills/<name>/SKILL.md and follow it directly."
exit 0
