#!/bin/bash
# Reads the App Store review demo account (the one given to App Review in App
# Store Connect) from a local secrets file, so the store screenshots show
# exactly what reviewers will see. Sourced, not executed.
#
# File: ${APPREVIEW_ACCOUNT_FILE:-~/drafto-secrets/app-review-account.txt}, with
# `email: …` and `password: …` lines (other lines are ignored). It must never
# be committed or echoed.
#
# Sets APPREVIEW_EMAIL and APPREVIEW_PASSWORD, or exits with an error.

load_app_review_account() {
  local file="${APPREVIEW_ACCOUNT_FILE:-$HOME/drafto-secrets/app-review-account.txt}"
  if [ ! -r "$file" ]; then
    echo "Error: review account file not found: $file" >&2
    echo "Create it with 'email: …' and 'password: …' lines (see docs/operations/builds-and-releases.md)." >&2
    exit 1
  fi
  APPREVIEW_EMAIL=$(awk -F': *' 'tolower($1)=="email" { print $2; exit }' "$file")
  APPREVIEW_PASSWORD=$(awk -F': *' 'tolower($1)=="password" { sub(/^[^:]*: */, ""); print; exit }' "$file")
  if [ -z "$APPREVIEW_EMAIL" ] || [ -z "$APPREVIEW_PASSWORD" ]; then
    echo "Error: $file must contain 'email:' and 'password:' lines." >&2
    exit 1
  fi
}

# Exits unless the PNG at $1 is exactly one of the sizes listed after it
# ("WIDTHxHEIGHT"). App Store Connect rejects any other size.
assert_png_size() {
  local file=$1
  shift
  local w h
  w=$(sips -g pixelWidth "$file" | awk '/pixelWidth/ { print $2 }')
  h=$(sips -g pixelHeight "$file" | awk '/pixelHeight/ { print $2 }')
  local size
  for size in "$@"; do
    if [ "${w}x${h}" = "$size" ]; then
      echo "  ✓ $(basename "$file") ${w}x${h}"
      return 0
    fi
  done
  echo "Error: $file is ${w}x${h}, expected one of: $*" >&2
  exit 1
}
