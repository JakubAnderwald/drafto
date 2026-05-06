#!/bin/bash
# One-shot, idempotent factory Project v2 board bootstrap.
#
# Usage: scripts/setup-factory-board.sh [--owner <login>] [--title <title>]
#
# Defaults to the authenticated viewer / "Drafto Factory". Re-running is safe
# — the script checks for an existing project of the same title and only
# adds Status field options that are missing.
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
while [[ $# -gt 0 ]]; do
  case "$1" in
    --owner)
      OWNER="$2"; shift 2 ;;
    --title)
      TITLE="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,21p' "$0"; exit 0 ;;
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
# AND the parser in .github/workflows/factory-status-mirror.yml. Keep all
# three in sync.
STATUS_OPTIONS=(
  "Backlog"
  "Ready"
  "Planning"
  "Plan Review"
  "In Progress"
  "In Review"
  "In Test"
  "Approved"
  "Released"
  "Done"
  "Blocked"
)

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

if [[ -n "$PROJECT_ID" && "$PROJECT_ID" != "null" ]]; then
  echo "Project already exists: #$PROJECT_NUMBER ($PROJECT_ID)"
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
              options { id name }
            }
          }
        }
      }
    }
  }' -f projectId="$PROJECT_ID")
STATUS_FIELD_ID=$(echo "$FIELDS_JSON" | jq -r '
  .data.node.fields.nodes[]
  | select(.__typename == "ProjectV2SingleSelectField" and .name == "Status")
  | .id' | head -1)
if [[ -z "$STATUS_FIELD_ID" || "$STATUS_FIELD_ID" == "null" ]]; then
  echo "ERROR: project $PROJECT_NUMBER has no single-select field named 'Status'." >&2
  echo "       Rename or recreate the Status field via the project UI, then re-run." >&2
  exit 1
fi
EXISTING_OPTIONS=$(echo "$FIELDS_JSON" | jq -r '
  .data.node.fields.nodes[]
  | select(.__typename == "ProjectV2SingleSelectField" and .name == "Status")
  | .options[].name')
echo "Existing Status options: $(echo "$EXISTING_OPTIONS" | paste -sd, -)"

# Build the desired option list. Order matters in the UI, so we always set
# the full list (passing the same set twice is a server-side no-op).
DESIRED_JSON=$(printf '%s\n' "${STATUS_OPTIONS[@]}" \
  | jq -R '{name: ., color: "GRAY", description: ""}' \
  | jq -s '
    map(
      .color = (
        {
          "Backlog":     "GRAY",
          "Ready":       "GREEN",
          "Planning":    "BLUE",
          "Plan Review": "PURPLE",
          "In Progress": "YELLOW",
          "In Review":   "BLUE",
          "In Test":     "GREEN",
          "Approved":    "GREEN",
          "Released":    "GREEN",
          "Done":        "GRAY",
          "Blocked":     "RED"
        }[.name] // "GRAY"
      )
    )')

echo "Updating Status field options (idempotent)..."
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
UPDATE_RESP=$(echo "$UPDATE_BODY" | gh api graphql --input -)
if echo "$UPDATE_RESP" | jq -e '.errors' >/dev/null 2>&1; then
  echo "ERROR: updateProjectV2Field returned errors:" >&2
  echo "$UPDATE_RESP" | jq '.errors' >&2
  exit 1
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
echo "  1. Add to repo secrets:  FACTORY_PROJECT_TOKEN  (classic PAT, scopes: repo, project)."
echo "  2. Smoke test: file an issue (use Factory feature spec template), add to project, drag to Ready, watch Actions for 'Factory Status Mirror'."
