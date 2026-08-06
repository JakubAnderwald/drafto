#!/bin/bash
# End-to-end verification for the TestFlight desktop build.
# Checks that the installed app uses the production Supabase backend
# and that login works with production credentials.
#
# Usage: ./verify-testflight-build.sh <email> <password>

set -euo pipefail

EMAIL="${1:-}"
PASSWORD="${2:-}"

if [[ -z "$EMAIL" || -z "$PASSWORD" ]]; then
  echo "Usage: $0 <email> <password>"
  exit 1
fi

PROD_URL="https://tbmjbxxseonkciqovnpl.supabase.co"
PROD_ANON_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRibWpieHhzZW9ua2NpcW92bnBsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzIwNDk0NDQsImV4cCI6MjA4NzYyNTQ0NH0.v9G0SdLJ6vFfjW6PyDPBX7s-nzB3mbP4nqi5fbGlbBk"
DEV_URL="https://huhzactreblzcogqkbsd.supabase.co"

PASS=0
FAIL=0

check() {
  local name="$1" result="$2"
  if [[ "$result" == "pass" ]]; then
    echo "  ✅ $name"
    PASS=$((PASS + 1))
  else
    echo "  ❌ $name"
    FAIL=$((FAIL + 1))
  fi
}

echo ""
echo "=== Drafto Desktop — TestFlight Build Verification ==="
echo ""

# --- Test 1: App is installed ---
echo "1. Checking installed app..."
APP_PATH="/Applications/Drafto.app"
if [[ ! -d "$APP_PATH" ]]; then
  # TestFlight apps may be in a different location
  APP_PATH=$(mdfind "kMDItemCFBundleIdentifier == 'eu.drafto.mobile'" 2>/dev/null | head -1)
fi
if [[ -d "$APP_PATH" ]]; then
  check "App found at $APP_PATH" "pass"
else
  echo "  ❌ Drafto.app not found. Install it from TestFlight first."
  exit 1
fi

# --- Test 2: Bundle contains production Supabase URL ---
echo "2. Checking JS bundle for Supabase URL..."
BUNDLE="$APP_PATH/Contents/Resources/main.jsbundle"
if [[ -f "$BUNDLE" ]]; then
  if strings "$BUNDLE" | grep -q "tbmjbxxseonkciqovnpl"; then
    check "Production Supabase URL found in bundle" "pass"
  else
    check "Production Supabase URL found in bundle (found dev URL instead)" "fail"
  fi

  if strings "$BUNDLE" | grep -q "huhzactreblzcogqkbsd"; then
    check "Dev Supabase URL absent from bundle" "fail"
  else
    check "Dev Supabase URL absent from bundle" "pass"
  fi
else
  check "JS bundle exists at $BUNDLE" "fail"
fi

# --- Test 3: Production Supabase auth endpoint responds ---
echo "3. Testing production Supabase auth endpoint..."
HEALTH=$(curl -s -o /dev/null -w "%{http_code}" "$PROD_URL/auth/v1/health" \
  -H "apikey: $PROD_ANON_KEY" 2>/dev/null)
if [[ "$HEALTH" == "200" ]]; then
  check "Production auth endpoint healthy (HTTP $HEALTH)" "pass"
else
  check "Production auth endpoint healthy (HTTP $HEALTH)" "fail"
fi

# --- Test 4: Login with production credentials ---
echo "4. Testing login with provided credentials..."
LOGIN_RESPONSE=$(curl -s "$PROD_URL/auth/v1/token?grant_type=password" \
  -H "apikey: $PROD_ANON_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"email\": \"$EMAIL\", \"password\": \"$PASSWORD\"}" 2>/dev/null)

if echo "$LOGIN_RESPONSE" | grep -q "access_token"; then
  check "Login succeeded on production backend" "pass"
  USER_ID=$(echo "$LOGIN_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin)['user']['id'])" 2>/dev/null || echo "unknown")
  echo "       User ID: $USER_ID"
else
  ERROR_MSG=$(echo "$LOGIN_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('error_description', json.load(sys.stdin).get('msg', 'unknown')))" 2>/dev/null || echo "$LOGIN_RESPONSE")
  check "Login succeeded on production backend (error: $ERROR_MSG)" "fail"
fi

# --- Test 5: Info.plist has category ---
echo "5. Checking Info.plist metadata..."
CATEGORY=$(defaults read "$APP_PATH/Contents/Info" LSApplicationCategoryType 2>/dev/null || echo "missing")
if [[ "$CATEGORY" == "public.app-category.productivity" ]]; then
  check "LSApplicationCategoryType set ($CATEGORY)" "pass"
else
  check "LSApplicationCategoryType set ($CATEGORY)" "fail"
fi

VERSION=$(defaults read "$APP_PATH/Contents/Info" CFBundleShortVersionString 2>/dev/null || echo "unknown")
BUILD=$(defaults read "$APP_PATH/Contents/Info" CFBundleVersion 2>/dev/null || echo "unknown")
echo "       Version: $VERSION (build $BUILD)"

# --- Test 6: The app actually launches and stays up ---
#
# This is the fossil check. Everything above passes on a build that dies the
# instant it opens: react-native-macos@0.81 against React 19.2 compiles cleanly
# and then crashes at startup (Hermes EXC_BAD_ACCESS). Test 4's "login" is a
# curl against Supabase, not the app signing in, so none of it touches the
# failure mode this script exists to catch.
echo "6. Launching the app (fossil smoke test)..."
CRASH_DIR="$HOME/Library/Logs/DiagnosticReports"
CRASHES_BEFORE=$(ls -1 "$CRASH_DIR" 2>/dev/null | grep -c -i "drafto" || true)

open -a "$APP_PATH" 2>/dev/null || true

# Wait for the app to appear before judging it. `open -a` returns immediately,
# so sampling straight away sees "not running" and would fail a healthy build.
LAUNCH_OK="fail"
APPEARED=0
for _ in $(seq 1 20); do
  sleep 1
  if pgrep -f "$APP_PATH/Contents/MacOS/" >/dev/null 2>&1; then
    APPEARED=1
    break
  fi
done
if [[ "$APPEARED" -eq 0 ]]; then
  check "App appeared in the process table within 20s" "fail"
else
  check "App appeared in the process table" "pass"
  # Now the real test: does it STAY up? A fossil break dies within seconds of
  # launch, so require it to survive a continuous window.
  LAUNCH_OK="pass"
  for _ in $(seq 1 15); do
    sleep 1
    if ! pgrep -f "$APP_PATH/Contents/MacOS/" >/dev/null 2>&1; then
      LAUNCH_OK="fail"   # died after starting — that IS the fossil failure
      break
    fi
  done
  check "App still running 15s after launch (did not crash)" "$LAUNCH_OK"
fi

CRASHES_AFTER=$(ls -1 "$CRASH_DIR" 2>/dev/null | grep -c -i "drafto" || true)
if [[ "$CRASHES_AFTER" -gt "$CRASHES_BEFORE" ]]; then
  check "No new crash report" "fail"
  echo "       New crash report(s) in $CRASH_DIR — likely the React 19.2 fossil break."
else
  check "No new crash report" "pass"
fi

# Leave the machine as we found it.
osascript -e 'quit app "Drafto"' >/dev/null 2>&1 || true

# --- Summary ---
echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
echo ""
echo "⚠️  This script cannot prove the app RENDERS. A blank window is a healthy"
echo "    process, so a fossil break that shows an empty screen still passes."
echo "    Before trusting a desktop build root, open the app and open a note."
if [[ $FAIL -gt 0 ]]; then
  echo "⚠️  Some checks failed. See above for details."
  exit 1
else
  echo "🎉 All checks passed!"
  exit 0
fi
