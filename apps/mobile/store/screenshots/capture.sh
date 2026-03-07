#!/usr/bin/env bash
# Screenshot capture helper for App Store / Google Play listings.
# Run on macOS with iOS Simulator or Android Emulator running.
#
# Prerequisites:
#   - Maestro CLI installed: brew install maestro
#   - Dev client running on simulator/emulator
#   - Logged into test account in the app
#
# Usage:
#   ./capture.sh ios    # Capture iOS screenshots
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
  OUT_DIR="$SCRIPT_DIR/ios-6.7"
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
