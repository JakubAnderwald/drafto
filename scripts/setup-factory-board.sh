#!/bin/bash
# One-shot, idempotent factory Project v2 board bootstrap.
#
# Usage: scripts/setup-factory-board.sh [--owner <login>] [--title <title>]
#                                       [--dry-run] [--allow-drop]
#
# Defaults to the authenticated viewer / "Drafto Factory". Re-running is safe
# — the script checks for an existing project of the same title and only
# adds Status field options that are missing. Existing options keep their
# option ids (and so every card keeps its Status), colour and description.
#
#   --dry-run     Print the updateProjectV2Field payload (options with ids)
#                 and exit. Creates, updates and links nothing.
#   --allow-drop  Delete existing Status options that aren't in
#                 STATUS_OPTIONS. Every card in a dropped column loses its
#                 Status. Without this flag the script refuses instead.
#
# Before a run that changes the options on the live board, follow the
# migration in docs/operations/factory-runbook.md (pause the factory,
# `factory-project.mjs export-statuses` backup, --dry-run, run, re-export and
# diff, resume).
#
# Auth requirements:
#   Uses GraphQL throughout (`gh api graphql`) so the token only needs the
#   `project` scope (or the fine-grained Projects: read+write equivalent).
#   The `gh project` CLI subcommands are deliberately avoided because they
#   additionally require `read:org` / `read:discussion`, which aren't on the
#   workflow's classic PAT.
#
# Token sources, in order:
#   1. $GH_TOKEN (set by the caller for one-shot use, e.g.
#      `GH_TOKEN=ghp_... scripts/setup-factory-board.sh`).
#   2. Whatever `gh auth status` is currently using.
# Either must have `project` (read+write) and the ability to call the v4 API.

set -euo pipefail

OWNER=""
TITLE="Drafto Factory"
DRY_RUN=0
ALLOW_DROP=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --owner)
      OWNER="$2"; shift 2 ;;
    --title)
      TITLE="$2"; shift 2 ;;
    --dry-run)
      DRY_RUN=1; shift ;;
    --allow-drop)
      ALLOW_DROP=1; shift ;;
    -h|--help)
      sed -n '2,35p' "$0"; exit 0 ;;
    *)
      echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

if ! command -v gh >/dev/null 2>&1; then
  echo "ERROR: gh CLI not found on PATH" >&2
  exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "ERROR: jq not found on PATH" >&2
  exit 1
fi

# Status options must match the labels created by setup-factory-labels.sh
# AND the status-name → label mapping (status_label_for / ALL_STATUS_LABELS)
# in scripts/factory-agent.sh. Keep all three in sync; the
# setup-factory-board test checks it.
#
# Testing is reserved for the pre-In-Test verification stage (ADR-0053).
STATUS_OPTIONS=(
  "Backlog"
  "Ready"
  "Planning"
  "Plan Review"
  "In Progress"
  "In Review"
  "Testing"
  "In Test"
  "Approved"
  "Released"
  "Done"
  "Blocked"
)

# Colour and description for an option the board doesn't have yet. An existing
# option keeps whatever it has on the board.
OPTION_COLORS_JSON='{
  "Backlog":     "GRAY",
  "Ready":       "GREEN",
  "Planning":    "BLUE",
  "Plan Review": "PURPLE",
  "In Progress": "YELLOW",
  "In Review":   "BLUE",
  "Testing":     "ORANGE",
  "In Test":     "GREEN",
  "Approved":    "GREEN",
  "Released":    "GREEN",
  "Done":        "GRAY",
  "Blocked":     "RED"
}'
OPTION_DESCRIPTIONS_JSON='{
  "Testing": "Factory is running automated verification before In Test."
}'

# Resolve viewer login + id from the same token we'll use for everything else.
echo "Resolving authenticated user..."
VIEWER_JSON=$(gh api graphql -f query='{ viewer { id login } }')
VIEWER_LOGIN=$(echo "$VIEWER_JSON" | jq -r '.data.viewer.login')
VIEWER_ID=$(echo "$VIEWER_JSON" | jq -r '.data.viewer.id')
if [[ -z "$VIEWER_LOGIN" || -z "$VIEWER_ID" ]]; then
  echo "ERROR: could not resolve viewer (auth missing or token lacks identity scopes)" >&2
  exit 1
fi
echo "Authenticated as $VIEWER_LOGIN"

if [[ -z "$OWNER" ]]; then
  OWNER="$VIEWER_LOGIN"
fi
if [[ "$OWNER" != "$VIEWER_LOGIN" ]]; then
  echo "WARN: --owner $OWNER differs from authenticated viewer $VIEWER_LOGIN — script only manages projects under the authenticated user." >&2
  echo "       Re-auth as $OWNER (or pass --owner $VIEWER_LOGIN) and re-run." >&2
  exit 1
fi

echo "Looking up existing project '$TITLE' under viewer..."
EXISTING_JSON=$(gh api graphql -f query='
  query($login: String!) {
    user(login: $login) {
      projectsV2(first: 100) {
        nodes { id number title }
      }
    }
  }' -f login="$VIEWER_LOGIN")
PROJECT_ID=$(echo "$EXISTING_JSON" | jq -r --arg title "$TITLE" \
  '.data.user.projectsV2.nodes[] | select(.title == $title) | .id' | head -1)
PROJECT_NUMBER=$(echo "$EXISTING_JSON" | jq -r --arg title "$TITLE" \
  '.data.user.projectsV2.nodes[] | select(.title == $title) | .number' | head -1)

CREATED_PROJECT=0
if [[ -n "$PROJECT_ID" && "$PROJECT_ID" != "null" ]]; then
  echo "Project already exists: #$PROJECT_NUMBER ($PROJECT_ID)"
elif [[ "$DRY_RUN" -eq 1 ]]; then
  echo "DRY-RUN: project '$TITLE' does not exist; a real run would create it with Status options: $(IFS=,; echo "${STATUS_OPTIONS[*]}")"
  exit 0
else
  echo "Creating project '$TITLE'..."
  CREATE_JSON=$(gh api graphql -f query='
    mutation($ownerId: ID!, $title: String!) {
      createProjectV2(input: { ownerId: $ownerId, title: $title }) {
        projectV2 { id number title }
      }
    }' -f ownerId="$VIEWER_ID" -f title="$TITLE")
  PROJECT_ID=$(echo "$CREATE_JSON" | jq -r '.data.createProjectV2.projectV2.id')
  PROJECT_NUMBER=$(echo "$CREATE_JSON" | jq -r '.data.createProjectV2.projectV2.number')
  if [[ -z "$PROJECT_ID" || "$PROJECT_ID" == "null" ]]; then
    echo "ERROR: createProjectV2 returned no id. Raw response:" >&2
    echo "$CREATE_JSON" >&2
    exit 1
  fi
  CREATED_PROJECT=1
  echo "Created project #$PROJECT_NUMBER ($PROJECT_ID)"
fi

PROJECT_URL="https://github.com/users/$VIEWER_LOGIN/projects/$PROJECT_NUMBER"
echo "Project URL: $PROJECT_URL"

# Find the Status single-select field. New projects ship with one named
# "Status"; if it's been renamed, we error out instead of guessing.
echo "Locating Status field..."
FIELDS_JSON=$(gh api graphql -f query='
  query($projectId: ID!) {
    node(id: $projectId) {
      ... on ProjectV2 {
        fields(first: 50) {
          nodes {
            __typename
            ... on ProjectV2SingleSelectField {
              id
              name
              options { id name color description }
            }
          }
        }
      }
    }
  }' -f projectId="$PROJECT_ID")
STATUS_FIELD_JSON=$(echo "$FIELDS_JSON" | jq -c '
  first(.data.node.fields.nodes[]
        | select(.__typename == "ProjectV2SingleSelectField" and .name == "Status"))
  // {}')
STATUS_FIELD_ID=$(echo "$STATUS_FIELD_JSON" | jq -r '.id // ""')
if [[ -z "$STATUS_FIELD_ID" ]]; then
  echo "ERROR: project $PROJECT_NUMBER has no single-select field named 'Status'." >&2
  echo "       Rename or recreate the Status field via the project UI, then re-run." >&2
  exit 1
fi
EXISTING_OPTIONS_JSON=$(echo "$STATUS_FIELD_JSON" | jq -c '.options // []')
echo "Existing Status options: $(echo "$EXISTING_OPTIONS_JSON" | jq -r '[.[].name] | join(",")')"

# Build the desired option list in STATUS_OPTIONS order. updateProjectV2Field
# REPLACES the field's whole option list, and an option sent without its `id`
# is a brand-new option: GitHub clears the Status of every card that was in
# the old one. So each option that already exists is sent with its `id` (plus
# its current colour + description); only a genuinely new name goes without.
DESIRED_JSON=$(printf '%s\n' "${STATUS_OPTIONS[@]}" | jq -R . | jq -s -c \
  --argjson existing "$EXISTING_OPTIONS_JSON" \
  --argjson colors "$OPTION_COLORS_JSON" \
  --argjson descriptions "$OPTION_DESCRIPTIONS_JSON" '
  map(
    . as $name
    | (first($existing[] | select(.name == $name)) // null) as $cur
    | if $cur != null then
        { id: $cur.id,
          name: $name,
          color: ($cur.color // $colors[$name] // "GRAY"),
          description: ($cur.description // "") }
      else
        { name: $name,
          color: ($colors[$name] // "GRAY"),
          description: ($descriptions[$name] // "") }
      end
  )')

# Every existing option whose id isn't carried over would be deleted, and the
# cards in it would lose their Status. Matched by id, not name, so a duplicate
# name on the board can't slip through.
DROPPED=$(jq -n -r \
  --argjson existing "$EXISTING_OPTIONS_JSON" \
  --argjson desired "$DESIRED_JSON" '
  [$desired[] | .id // empty] as $kept
  | [$existing[] | . as $o | select(($kept | any(. == $o.id)) | not) | .name]
  | join(", ")')
if [[ -n "$DROPPED" ]]; then
  if [[ "$CREATED_PROJECT" -eq 1 ]]; then
    # GitHub seeds a new project's Status with its own defaults (Todo, In
    # Progress, Done). No card can be in them yet, so replacing them is safe.
    echo "New project: replacing GitHub's default Status option(s) not in STATUS_OPTIONS: $DROPPED."
  elif [[ "$ALLOW_DROP" -eq 1 ]]; then
    echo "WARN: --allow-drop: deleting Status option(s) not in STATUS_OPTIONS: $DROPPED. Every card in them loses its Status." >&2
  else
    echo "ERROR: the board has Status option(s) that STATUS_OPTIONS doesn't list: $DROPPED." >&2
    echo "       Updating would delete them and clear the Status of every card in them." >&2
    echo "       Add them to STATUS_OPTIONS, or move their cards and re-run with --allow-drop." >&2
    exit 1
  fi
fi

EXISTING_NAMES=$(echo "$EXISTING_OPTIONS_JSON" | jq -c '[.[].name]')
DESIRED_NAMES=$(echo "$DESIRED_JSON" | jq -c '[.[].name]')
SKIP_UPDATE=0
if [[ "$EXISTING_NAMES" == "$DESIRED_NAMES" ]]; then
  SKIP_UPDATE=1
fi

# `gh api graphql -f` / `-F` can't bind a list variable, so build the full
# request body in jq and pipe via `--input -`.
UPDATE_QUERY='mutation($fieldId: ID!, $options: [ProjectV2SingleSelectFieldOptionInput!]!) {
  updateProjectV2Field(input: {
    fieldId: $fieldId
    singleSelectOptions: $options
  }) {
    projectV2Field {
      ... on ProjectV2SingleSelectField { id options { id name } }
    }
  }
}'
UPDATE_BODY=$(jq -n \
  --arg query "$UPDATE_QUERY" \
  --arg fieldId "$STATUS_FIELD_ID" \
  --argjson options "$DESIRED_JSON" \
  '{ query: $query, variables: { fieldId: $fieldId, options: $options } }')

if [[ "$DRY_RUN" -eq 1 ]]; then
  if [[ "$SKIP_UPDATE" -eq 1 ]]; then
    echo "DRY-RUN: Status options already match STATUS_OPTIONS; a real run sends no field update."
  else
    echo "DRY-RUN: a real run sends updateProjectV2Field with these variables (options without an id are new):"
    echo "$UPDATE_BODY" | jq '.variables'
  fi
  echo "DRY-RUN: nothing was created, updated or linked."
  exit 0
fi

if [[ "$SKIP_UPDATE" -eq 1 ]]; then
  echo "Status options already match STATUS_OPTIONS; no field update needed."
else
  echo "Updating Status field options (existing option ids preserved)..."
  # gh exits non-zero on a GraphQL error but still prints the body, so keep
  # going under `set -e` long enough to show it.
  UPDATE_RC=0
  UPDATE_RESP=$(echo "$UPDATE_BODY" | gh api graphql --input -) || UPDATE_RC=$?
  if [[ "$UPDATE_RC" -ne 0 ]] || echo "$UPDATE_RESP" | jq -e '.errors' >/dev/null 2>&1; then
    echo "ERROR: updateProjectV2Field failed (gh exit $UPDATE_RC):" >&2
    echo "$UPDATE_RESP" | jq '.errors // .' >&2 2>/dev/null || echo "$UPDATE_RESP" >&2
    echo "       Re-export with 'node scripts/lib/factory-project.mjs export-statuses' and diff it" >&2
    echo "       against your backup before re-running." >&2
    exit 1
  fi
  # Belt and braces: every option sent with an id must come back with it.
  CHANGED=$(jq -n -r \
    --argjson desired "$DESIRED_JSON" \
    --argjson resp "$UPDATE_RESP" '
    ($resp.data.updateProjectV2Field.projectV2Field.options // []) as $now
    | [$desired[]
       | select(.id != null)
       | . as $d
       | select((first($now[] | select(.name == $d.name) | .id) // null) != $d.id)
       | .name]
    | join(", ")')
  if [[ -n "$CHANGED" ]]; then
    echo "ERROR: these Status options came back with a different id: $CHANGED." >&2
    echo "       Cards in them may have lost their Status. Re-export with" >&2
    echo "       'node scripts/lib/factory-project.mjs export-statuses', diff it against" >&2
    echo "       your backup, and restore the moved cards." >&2
    exit 1
  fi
fi

echo "Status options now: $(IFS=,; echo "${STATUS_OPTIONS[*]}")"

# Add the drafto repo to the project so issues filed there can be added to
# the board (and so PRs can be auto-added by board workflows). Idempotent —
# if the link already exists the mutation just returns the same project.
REPO_NWO="$VIEWER_LOGIN/drafto"
echo "Linking $REPO_NWO to project..."
REPO_ID=$(gh api graphql -f query='
  query($owner: String!, $name: String!) {
    repository(owner: $owner, name: $name) { id }
  }' -f owner="$VIEWER_LOGIN" -f name="drafto" | jq -r '.data.repository.id')
if [[ -z "$REPO_ID" || "$REPO_ID" == "null" ]]; then
  echo "WARN: could not resolve repo id for $REPO_NWO; skipping link step." >&2
else
  gh api graphql -f query='
    mutation($projectId: ID!, $repoId: ID!) {
      linkProjectV2ToRepository(input: { projectId: $projectId, repositoryId: $repoId }) {
        repository { nameWithOwner }
      }
    }' -f projectId="$PROJECT_ID" -f repoId="$REPO_ID" >/dev/null \
    && echo "Linked $REPO_NWO to project #$PROJECT_NUMBER" \
    || echo "WARN: link mutation failed (already linked, or token lacks repo write)."
fi

echo
echo "Done."
echo "Project URL: $PROJECT_URL"
echo
echo "Next steps:"
echo "  1. On the Mac mini, ensure 'gh auth status' lists the 'project' scope (run 'gh auth refresh -s project' if not)."
echo "  2. Install the factory launchd job per docs/operations/factory-runbook.md, then smoke-test by filing an issue (Factory feature spec template), dragging the card to Ready, and tailing logs/launchd-factory-stdout.log."
