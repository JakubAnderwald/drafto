#!/usr/bin/env bash
# Manual screenshot capture helper for the Google Play listing.
# Run with an Android Emulator running. App Store (iOS/iPadOS) screenshots are
# fully automated by generate-ios.sh — this script defers to it for "ios".
#
# Prerequisites:
#   - Maestro CLI installed: brew install maestro
#   - Dev client running on the emulator
#   - Logged into test account in the app
#
# Usage:
#   ./capture.sh ios    # Runs generate-ios.sh (automated App Store screenshots)
#   ./capture.sh android # Capture Android screenshots

set -euo pipefail

PLATFORM="${1:-ios}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

SCREENSHOTS=(
  "01-notebooks"
  "02-notes"
  "03-editor"
  "04-dark-mode"
  "05-offline"
)

if [ "$PLATFORM" = "ios" ]; then
  exec bash "$SCRIPT_DIR/generate-ios.sh"
elif [ "$PLATFORM" = "android" ]; then
  OUT_DIR="$SCRIPT_DIR/android-phone"
else
  echo "Usage: $0 [ios|android]"
  exit 1
fi

echo "Capturing $PLATFORM screenshots to $OUT_DIR..."

for name in "${SCREENSHOTS[@]}"; do
  echo "  -> $name"
  maestro screenshot "$OUT_DIR/$name.png"
  echo "     Saved. Navigate to the next screen and press Enter."
  read -r
done

echo "Done. Screenshots saved to $OUT_DIR/"
