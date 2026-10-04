#!/bin/bash
# Generates App Store screenshots for iPhone 6.9" and iPad 13" into
# apps/mobile/fastlane/screenshots/en-US/ (the layout
# `fastlane ios upload_screenshots` uploads), signed in as the App Review demo
# account so they show exactly what reviewers will see.
#
# 1. Builds a Release simulator .app pointed at PROD (.env.production), unless
#    --skip-build. Needs a node_modules with the mobile React version, i.e. a
#    worktree or the mobile build root — not the primary checkout's desktop
#    fossil install.
# 2. For each simulator: light appearance, 9:41 status bar, install, run
#    app-store.yaml with Maestro, check every PNG's size.
#
# Usage: bash apps/mobile/store/screenshots/generate-ios.sh [--skip-build]
#   SCREENSHOT_NOTEBOOK  notebook to open   (default "Getting Started")
#   SCREENSHOT_NOTE      note to open       (default "Welcome to Drafto")
#   SCREENSHOT_SEARCH    search query       (default "note")
#
# Requires Xcode, the "iPhone 17 Pro Max" and "iPad Pro 13-inch (M5)"
# simulators, and Maestro (~/.maestro/bin).
set -euo pipefail
trap 'echo "Error: ${BASH_SOURCE[0]}:${LINENO}: \"${BASH_COMMAND}\" failed." >&2' ERR

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MOBILE_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
REPO_ROOT="$(cd "$MOBILE_DIR/../.." && pwd)"
OUT_DIR="$MOBILE_DIR/fastlane/screenshots/en-US"
DERIVED_DATA="$MOBILE_DIR/build/screenshots"
APP_PATH="$DERIVED_DATA/Build/Products/Release-iphonesimulator/Drafto.app"
PROD_REF="tbmjbxxseonkciqovnpl"

# "Simulator name|expected PNG size|file prefix". Native resolutions match the
# App Store Connect 6.9" iPhone and 13" iPad display types exactly.
DEVICES=(
  "iPhone 17 Pro Max|1320x2868|iphone"
  "iPad Pro 13-inch (M5)|2064x2752|ipad"
)

SKIP_BUILD=false
[ "${1:-}" = "--skip-build" ] && SKIP_BUILD=true

export PATH="$HOME/.maestro/bin:$PATH"
command -v maestro > /dev/null || {
  echo "Error: Maestro is required (curl -Ls https://get.maestro.mobile.dev | bash)." >&2
  exit 1
}

# shellcheck source=../../../../scripts/lib/app-review-account.sh
source "$REPO_ROOT/scripts/lib/app-review-account.sh"
load_app_review_account
# Maestro exposes MAESTRO_* environment variables to flows, which keeps the
# password out of the command line.
export MAESTRO_APPREVIEW_EMAIL="$APPREVIEW_EMAIL"
export MAESTRO_APPREVIEW_PASSWORD="$APPREVIEW_PASSWORD"

if [ "$SKIP_BUILD" = false ]; then
  echo "→ Building a Release simulator app against prod (~20 min)"
  cd "$MOBILE_DIR"
  set -a
  # shellcheck source=/dev/null
  . ./.env.production
  set +a
  CI=1 npx expo prebuild --platform ios --clean --no-install
  (cd ios && pod install)
  # "Sign to Run Locally" (identity "-", no team or profile). It must be signed:
  # the simulator reads entitlements that Xcode embeds at link time, and an
  # unsigned build has no keychain access, so SecureStore (and with it auth)
  # fails with ERR_KEY_CHAIN and the app never leaves its loading spinner.
  xcodebuild -workspace ios/Drafto.xcworkspace -scheme Drafto -configuration Release \
    -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
    -derivedDataPath "$DERIVED_DATA" build -quiet \
    CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM= PROVISIONING_PROFILE_SPECIFIER=
fi

[ -d "$APP_PATH" ] || {
  echo "Error: $APP_PATH not found — run without --skip-build." >&2
  exit 1
}
# The Supabase URL is baked into the embedded Expo config; refuse to capture
# from a build that points anywhere but prod.
grep -q "$PROD_REF" "$APP_PATH/EXConstants.bundle/app.config" || {
  echo "Error: $APP_PATH is not a prod build (no $PROD_REF in its Expo config)." >&2
  exit 1
}

mkdir -p "$OUT_DIR"
rm -f "$OUT_DIR"/iphone-*.png "$OUT_DIR"/ipad-*.png

for device in "${DEVICES[@]}"; do
  IFS='|' read -r name size prefix <<< "$device"
  udid=$(xcrun simctl list devices available -j |
    node -e 'const n=process.argv[1];const d=Object.values(JSON.parse(require("fs").readFileSync(0)).devices).flat().find(x=>x.name===n);process.stdout.write(d?d.udid:"")' "$name")
  [ -n "$udid" ] || {
    echo "Error: simulator '$name' not found (Xcode → Settings → Components)." >&2
    exit 1
  }

  echo "→ $name ($udid)"
  # English system UI, so system sheets (e.g. "Save Password?") match the flow
  # and nothing localised leaks into the shots. Takes effect on boot.
  xcrun simctl shutdown "$udid" 2> /dev/null || true
  xcrun simctl boot "$udid"
  xcrun simctl spawn "$udid" defaults write -g AppleLanguages -array en
  xcrun simctl spawn "$udid" defaults write -g AppleLocale en_US
  xcrun simctl shutdown "$udid"
  xcrun simctl boot "$udid"
  xcrun simctl bootstatus "$udid" -b > /dev/null
  xcrun simctl ui "$udid" appearance light
  xcrun simctl status_bar "$udid" override --time "9:41" --dataNetwork wifi --wifiMode active \
    --wifiBars 3 --cellularMode active --cellularBars 4 --batteryState charged --batteryLevel 100
  xcrun simctl install "$udid" "$APP_PATH"

  maestro --device "$udid" test "$SCRIPT_DIR/app-store.yaml" \
    -e OUT="$OUT_DIR/$prefix" \
    -e NOTEBOOK="${SCREENSHOT_NOTEBOOK:-Getting Started}" \
    -e NOTE="${SCREENSHOT_NOTE:-Welcome to Drafto}" \
    -e QUERY="${SCREENSHOT_SEARCH:-note}"

  xcrun simctl status_bar "$udid" clear
  xcrun simctl shutdown "$udid"

  for png in "$OUT_DIR/$prefix"-*.png; do
    assert_png_size "$png" "$size"
  done
done

echo "Done: $(ls "$OUT_DIR"/iphone-*.png "$OUT_DIR"/ipad-*.png | wc -l | tr -d ' ') screenshots in $OUT_DIR"
