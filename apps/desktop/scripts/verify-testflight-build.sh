#!/bin/bash
# End-to-end verification for the TestFlight desktop build.
# Checks that the installed app uses the production Supabase backend
# and that login works with production credentials.
#
# Usage: ./verify-testflight-build.sh <email>
#        (the password is read from $DRAFTO_VERIFY_PASSWORD, or prompted for)
#
# This authenticates against PRODUCTION. It requires the confirmation phrase
# "sign in to production" — typed at the prompt, or supplied unattended via
# $DRAFTO_VERIFY_CONFIRM.

set -euo pipefail

EMAIL="${1:-}"
# NOT an argv: process arguments are world-readable via `ps` and land in shell
# history. Env var for automation, silent prompt for humans.
PASSWORD="${DRAFTO_VERIFY_PASSWORD:-}"

if [[ -z "$EMAIL" ]]; then
  echo "Usage: $0 <email>   (password via \$DRAFTO_VERIFY_PASSWORD or prompt)"
  exit 1
fi
if [[ -z "$PASSWORD" ]]; then
  read -r -s -p "Password for $EMAIL (production): " PASSWORD
  echo ""
fi
if [[ -z "$PASSWORD" ]]; then
  echo "No password supplied — aborting."
  exit 1
fi
# One confirmation phrase, required on BOTH paths. A generic boolean flag
# (DRAFTO_VERIFY_YES=1) is too easy to set once in a shell profile and forget,
# after which unattended runs authenticate against production with no explicit
# acknowledgement of what they are doing.
PROD_CONFIRM_PHRASE="sign in to production"
if [[ "${DRAFTO_VERIFY_CONFIRM:-}" != "$PROD_CONFIRM_PHRASE" ]]; then
  if [[ -n "${DRAFTO_VERIFY_CONFIRM:-}" ]]; then
    echo "DRAFTO_VERIFY_CONFIRM is set but does not match the required phrase — aborting."
    exit 1
  fi
  if [[ ! -t 0 ]]; then
    echo "Refusing to sign in to production non-interactively."
    echo "Set DRAFTO_VERIFY_CONFIRM='$PROD_CONFIRM_PHRASE' to run unattended."
    exit 1
  fi
  # Name the exact target and operation, and require an unambiguous answer: a
  # bare "y" is too easy to hit reflexively for a real sign-in against prod.
  echo ""
  echo "  ⚠️  About to perform a REAL password sign-in against PRODUCTION:"
  echo "        project:   tbmjbxxseonkciqovnpl (drafto.eu production Supabase)"
  echo "        operation: POST /auth/v1/token?grant_type=password"
  echo "        account:   $EMAIL"
  echo "        using the password supplied via \$DRAFTO_VERIFY_PASSWORD / prompt"
  echo ""
  read -r -p "  Type '$PROD_CONFIRM_PHRASE' to continue: " REPLY
  [[ "$REPLY" == "$PROD_CONFIRM_PHRASE" ]] || { echo "Aborted."; exit 1; }
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
HEALTH=$(curl -s --max-time 15 -o /dev/null -w "%{http_code}" "$PROD_URL/auth/v1/health" \
  -H "apikey: $PROD_ANON_KEY" 2>/dev/null || echo "000")
if [[ "$HEALTH" == "200" ]]; then
  check "Production auth endpoint healthy (HTTP $HEALTH)" "pass"
else
  check "Production auth endpoint healthy (HTTP $HEALTH)" "fail"
fi

# --- Test 4: Login with production credentials ---
echo "4. Testing login with provided credentials..."
# Serialise with a real JSON encoder — a quote or backslash in the password
# would otherwise produce malformed JSON (or worse). The body goes in on stdin
# via @-, so the password never appears in this process's argv either.
LOGIN_BODY=$(EMAIL="$EMAIL" PASSWORD="$PASSWORD" python3 -c \
  'import json,os; print(json.dumps({"email": os.environ["EMAIL"], "password": os.environ["PASSWORD"]}))')
LOGIN_RESPONSE=$(printf '%s' "$LOGIN_BODY" | curl -s --max-time 20 \
  "$PROD_URL/auth/v1/token?grant_type=password" \
  -H "apikey: $PROD_ANON_KEY" \
  -H "Content-Type: application/json" \
  --data-binary @- 2>/dev/null || echo "")
unset LOGIN_BODY

if [[ -n "$LOGIN_RESPONSE" ]] && printf '%s' "$LOGIN_RESPONSE" | grep -q "access_token"; then
  check "Login succeeded on production backend" "pass"
  USER_ID=$(printf '%s' "$LOGIN_RESPONSE" | python3 -c \
    'import sys,json; print(json.load(sys.stdin)["user"]["id"])' 2>/dev/null || echo "unknown")
  echo "       User ID: $USER_ID"
else
  ERROR_MSG=$(printf '%s' "$LOGIN_RESPONSE" | python3 -c \
    'import sys,json; d=json.load(sys.stdin); print(d.get("error_description") or d.get("msg") or "unknown")' \
    2>/dev/null || echo "no/unparseable response")
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

# The app must NOT already be running: `open -a` on a running app just focuses
# it, so every check below would pass against the previous build without the new
# one ever starting — a false pass of the exact kind this script exists to stop.
WE_STARTED_IT=0
WAS_RUNNING_BEFORE=0
if pgrep -f "$APP_PATH/Contents/MacOS/" >/dev/null 2>&1; then
  WAS_RUNNING_BEFORE=1
  echo "       Drafto is already running — quitting it so this tests the INSTALLED build."
  osascript -e 'quit app "Drafto"' >/dev/null 2>&1 || true
  for _ in $(seq 1 10); do
    pgrep -f "$APP_PATH/Contents/MacOS/" >/dev/null 2>&1 || break
    sleep 1
  done
  if pgrep -f "$APP_PATH/Contents/MacOS/" >/dev/null 2>&1; then
    check "Drafto could be closed before the launch test" "fail"
    echo "       Still running — quit it by hand and re-run; test 6 was skipped."
    LAUNCH_SKIPPED=1
  fi
fi

if [[ "${LAUNCH_SKIPPED:-0}" -eq 0 ]]; then
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
  WE_STARTED_IT=1
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
fi

CRASHES_AFTER=$(ls -1 "$CRASH_DIR" 2>/dev/null | grep -c -i "drafto" || true)
if [[ "$CRASHES_AFTER" -gt "$CRASHES_BEFORE" ]]; then
  check "No new crash report" "fail"
  echo "       New crash report(s) in $CRASH_DIR — likely the React 19.2 fossil break."
else
  check "No new crash report" "pass"
fi

# Only quit what WE started. Quitting unconditionally would close an instance
# the operator had open — and the script has no way to restore it, so a
# "verification" run would silently take their editor away.
if [[ "${WE_STARTED_IT:-0}" -eq 1 ]]; then
  osascript -e 'quit app "Drafto"' >/dev/null 2>&1 || true
fi
if [[ "${WAS_RUNNING_BEFORE:-0}" -eq 1 ]]; then
  echo ""
  echo "ℹ️  Drafto was running before this script started; it was closed so the test"
  echo "    would exercise the installed build. Reopen it if you were using it."
fi

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
