#!/bin/bash
set -euo pipefail

# Cross-Platform E2E Test Runner
#
# Orchestrates a full cross-platform data consistency test:
# 1. Playwright (web) creates a formatted note via API
# 2. Maestro (iOS) opens the note, verifies content, edits it
# 3. Playwright verifies the iOS edit via API
# 4. Maestro (Android) opens the same note, verifies iOS edit, edits again
# 5. Playwright verifies the Android edit via API
#
# Prerequisites:
#   - iOS Simulator with Drafto app installed and user logged in
#   - Android Emulator with Drafto app installed and user logged in
#   - Maestro CLI installed
#   - .env.local sourced (E2E_TEST_EMAIL, E2E_TEST_PASSWORD, SUPABASE vars)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
WEB_DIR="$REPO_ROOT/apps/web"
MOBILE_DIR="$REPO_ROOT/apps/mobile"
MAESTRO="$HOME/.maestro/bin/maestro"
ADB="/Users/jakub/Library/Android/sdk/platform-tools/adb"

RUN_ID=$(date +%s)
echo "=== Cross-Platform E2E Test ==="
echo "RUN_ID: $RUN_ID"
echo ""

# Source env vars
set -a
source "$WEB_DIR/.env.local"
set +a
export XPLAT_RUN_ID="$RUN_ID"

# --- Step 1: Playwright creates a note with formatted content ---
echo "[Step 1] Creating note on web via Playwright..."
cd "$WEB_DIR"
PW_OUTPUT=$(npx playwright test e2e/cross-platform-sync.spec.ts \
  --project=chromium \
  --grep "create a shared note for mobile testing" 2>&1)
echo "$PW_OUTPUT" | tail -5

# Extract notebook name from Playwright output
NOTEBOOK_NAME=$(echo "$PW_OUTPUT" | grep -o 'XPLAT_NOTEBOOK_NAME=.*' | cut -d= -f2- || echo "")
if [ -z "$NOTEBOOK_NAME" ]; then
  echo "ERROR: Could not extract notebook name from Playwright output"
  exit 1
fi

echo "[Step 1] ✓ Note 'XPlat Sync $RUN_ID' created in notebook '$NOTEBOOK_NAME'"
echo ""

# --- Step 2: Maestro iOS — open, verify, edit ---
echo "[Step 2] Running Maestro on iOS Simulator..."
"$MAESTRO" test \
  -e RUN_ID="$RUN_ID" \
  -e NOTEBOOK_NAME="$NOTEBOOK_NAME" \
  --platform ios \
  "$MOBILE_DIR/e2e/05-cross-platform-sync.yaml" \
  2>&1 | tail -20

echo "[Step 2] ✓ iOS: content verified and edited"
echo ""

# --- Step 3: Playwright verifies iOS edit ---
echo "[Step 3] Verifying iOS edit via Playwright API test..."
cd "$WEB_DIR"
npx playwright test e2e/cross-platform-sync.spec.ts \
  --project=chromium \
  --grep "verify mobile edits are persisted" \
  2>&1 | tail -5

echo "[Step 3] ✓ iOS edit verified on web"
echo ""

# --- Step 4: Maestro Android — open, verify iOS edit, edit again ---
echo "[Step 4] Running Maestro on Android Emulator..."
"$MAESTRO" test \
  -e RUN_ID="$RUN_ID" \
  -e NOTEBOOK_NAME="$NOTEBOOK_NAME" \
  --platform android \
  "$MOBILE_DIR/e2e/05-cross-platform-sync.yaml" \
  2>&1 | tail -20

echo "[Step 4] ✓ Android: content verified and edited"
echo ""

# --- Step 5: Playwright final verification ---
echo "[Step 5] Final verification via Playwright..."
cd "$WEB_DIR"
npx playwright test e2e/cross-platform-sync.spec.ts \
  --project=chromium \
  --grep "verify mobile edits are persisted" \
  2>&1 | tail -5

echo "[Step 5] ✓ All edits verified on web"
echo ""
echo "=== Cross-Platform E2E Test PASSED ==="
echo "Note 'XPlat Sync $RUN_ID' was successfully:"
echo "  1. Created on web with formatted content (BlockNote)"
echo "  2. Opened and edited on iOS (TipTap → BlockNote conversion)"
echo "  3. Opened and edited on Android (TipTap → BlockNote conversion)"
echo "  4. Verified on web with all edits intact"
