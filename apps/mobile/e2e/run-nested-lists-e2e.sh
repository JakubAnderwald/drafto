#!/bin/bash
set -euo pipefail

# Nested-lists E2E runner (issue #465)
#
# Checks that nested lists written on web survive being opened and edited in
# the mobile app:
# 1. Playwright (web) seeds a note through the API: to-dos nested three deep,
#    and a bullet with a check child
# 2. Maestro opens the note, checks the nested items render, and types into
#    the deepest one (flow 08)
# 3. Playwright reads the note back through the API and checks the nesting,
#    the checked states and the edit
#
# Run it against a build from before the fix first: step 2 should fail at
# "Nested item B". Against a build with the fix, every step should pass.
#
# Usage: run-nested-lists-e2e.sh [ios|android]   (default: ios)
#
# Prerequisites:
#   - iOS Simulator (or Android Emulator) with Drafto installed and the E2E
#     user logged in
#   - Maestro CLI installed
#   - apps/web/.env.local with the E2E credentials and Supabase vars

PLATFORM="${1:-ios}"
if [[ "$PLATFORM" != "ios" && "$PLATFORM" != "android" ]]; then
  echo "Usage: $0 [ios|android]" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
WEB_DIR="$REPO_ROOT/apps/web"
MOBILE_DIR="$REPO_ROOT/apps/mobile"
MAESTRO="$HOME/.maestro/bin/maestro"

RUN_ID=$(date +%s)
echo "=== Nested Lists E2E Test ($PLATFORM) ==="
echo "RUN_ID: $RUN_ID"
echo ""

# Source env vars
set -a
source "$WEB_DIR/.env.local"
set +a
export XPLAT_RUN_ID="$RUN_ID"

# --- Step 1: Playwright seeds the note ---
echo "[Step 1] Seeding the nested-list note via Playwright..."
cd "$WEB_DIR"
PW_OUTPUT=$(npx playwright test e2e/cross-platform-sync.spec.ts \
  --project=chromium \
  --grep "create a nested-list note for mobile testing" 2>&1)
echo "$PW_OUTPUT" | tail -5

NOTEBOOK_NAME=$(echo "$PW_OUTPUT" | grep -o 'XPLAT_NOTEBOOK_NAME=.*' | cut -d= -f2- || echo "")
if [ -z "$NOTEBOOK_NAME" ]; then
  echo "ERROR: Could not extract notebook name from Playwright output"
  exit 1
fi

echo "[Step 1] ✓ Note 'XPlat Nested $RUN_ID' created in notebook '$NOTEBOOK_NAME'"
echo ""

# --- Step 2: Maestro opens the note, checks the nesting, edits the deepest item ---
echo "[Step 2] Running Maestro flow 08 on $PLATFORM..."
"$MAESTRO" test \
  -e RUN_ID="$RUN_ID" \
  -e NOTEBOOK_NAME="$NOTEBOOK_NAME" \
  --platform "$PLATFORM" \
  "$MOBILE_DIR/e2e/08-nested-lists.yaml" \
  2>&1 | tail -20

echo "[Step 2] ✓ $PLATFORM: nested items rendered and the deepest one was edited"
echo ""

# --- Step 3: Playwright checks the saved note ---
echo "[Step 3] Verifying the saved note via Playwright..."
cd "$WEB_DIR"
npx playwright test e2e/cross-platform-sync.spec.ts \
  --project=chromium \
  --grep "verify nested lists survive a mobile edit" \
  2>&1 | tail -5

echo "[Step 3] ✓ Nesting, checked states and the edit were saved"
echo ""
echo "=== Nested Lists E2E Test PASSED ==="
