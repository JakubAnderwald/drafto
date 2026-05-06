#!/bin/bash
# One-shot, idempotent factory Project v2 board bootstrap.
#
# Usage: scripts/setup-factory-board.sh [--owner <user-or-org>] [--title <title>]
#
# Defaults to JakubAnderwald / "Drafto Factory". Re-running is safe — the
# script checks for an existing project of the same title before creating one
# and only adds Status field options that are missing.
#
# Requires:
#   gh auth status with `project` scope. If gh complains "missing scope",
#   run: gh auth refresh -s project,read:project
#
# After this script returns successfully, configure the
# .github/workflows/factory-status-mirror.yml workflow with a PAT in the
# FACTORY_PROJECT_TOKEN repository secret (PAT scope: project, repo).

set -euo pipefail

OWNER="JakubAnderwald"
TITLE="Drafto Factory"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --owner)
      OWNER="$2"; shift 2 ;;
    --title)
      TITLE="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,17p' "$0"; exit 0 ;;
    *)
      echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

if ! command -v gh >/dev/null 2>&1; then
  echo "ERROR: gh CLI not found on PATH" >&2
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

echo "Looking up existing project '$TITLE' under owner '$OWNER'..."
EXISTING_NUMBER=$(gh project list --owner "$OWNER" --format json --limit 100 \
  | jq -r --arg title "$TITLE" '.projects[] | select(.title == $title) | .number' \
  | head -1)

if [[ -n "$EXISTING_NUMBER" ]]; then
  echo "Project already exists: #$EXISTING_NUMBER"
  PROJECT_NUMBER="$EXISTING_NUMBER"
else
  echo "Creating project '$TITLE'..."
  PROJECT_NUMBER=$(gh project create --owner "$OWNER" --title "$TITLE" --format json \
    | jq -r '.number')
  echo "Created project #$PROJECT_NUMBER"
fi

PROJECT_URL="https://github.com/users/$OWNER/projects/$PROJECT_NUMBER"
echo "Project URL: $PROJECT_URL"

# Find the Status single-select field. New projects ship with one named
# "Status" already; if it's been renamed, we error out instead of guessing.
echo "Locating Status field..."
FIELDS_JSON=$(gh project field-list "$PROJECT_NUMBER" --owner "$OWNER" --format json --limit 100)
STATUS_FIELD=$(echo "$FIELDS_JSON" \
  | jq -r '.fields[] | select(.name == "Status" and .type == "ProjectV2SingleSelectField")')
if [[ -z "$STATUS_FIELD" ]]; then
  echo "ERROR: project $PROJECT_NUMBER has no single-select field named 'Status'." >&2
  echo "       Rename or recreate the Status field, then re-run this script." >&2
  exit 1
fi
STATUS_FIELD_ID=$(echo "$STATUS_FIELD" | jq -r '.id')

EXISTING_OPTIONS=$(echo "$STATUS_FIELD" | jq -r '.options[].name')
echo "Existing Status options: $(echo "$EXISTING_OPTIONS" | paste -sd, -)"

# Compute the union of existing + desired option names. Order matters in the
# UI, so we always set the full list (not just additions). This is also
# idempotent: passing the same set twice is a no-op server-side.
DESIRED_JSON=$(printf '%s\n' "${STATUS_OPTIONS[@]}" \
  | jq -R '{name: ., color: "GRAY", description: ""}' \
  | jq -s '.')

# Colour each option to roughly mirror the labels.
COLOURED_JSON=$(echo "$DESIRED_JSON" | jq '
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
gh api graphql -f query='
  mutation($fieldId: ID!, $options: [ProjectV2SingleSelectFieldOptionInput!]!) {
    updateProjectV2Field(input: {
      fieldId: $fieldId
      singleSelectOptions: $options
    }) {
      projectV2Field {
        ... on ProjectV2SingleSelectField {
          id
          options { id name }
        }
      }
    }
  }' \
  -f fieldId="$STATUS_FIELD_ID" \
  -F options="$COLOURED_JSON" >/dev/null

echo "Status options now: $(IFS=,; echo "${STATUS_OPTIONS[*]}")"
echo
echo "Next steps:"
echo "  1. Add this repo as a project source: gh project link $PROJECT_NUMBER --owner $OWNER --repo $OWNER/drafto"
echo "  2. Add to repo secrets:  FACTORY_PROJECT_TOKEN  (PAT with scopes: project, repo)"
echo "  3. Smoke test: file an issue, drag to Ready, watch factory-status-mirror.yml apply status:ready."
