#!/bin/bash
# Production access for the throwaway account only. Expects REPO, RUN_DIR.
#
# - As the throwaway user: GoTrue password grant + PostgREST (RLS applies).
# - Admin SQL: Supabase Management API /database/query with the Supabase CLI's
#   stored token (the installed CLI v2.75 has no `supabase db query`). Every
#   statement the harness sends is scoped to the throwaway user's exact id/email.
#
# Secrets go to 0600 header files under RUN_DIR (curl -H @file) so they never
# appear in argv or the log; harness.sh's EXIT trap deletes them.

PROD_REF=tbmjbxxseonkciqovnpl
ENV_FILE="$REPO/apps/desktop/.env.production"

prod_load_env() {
  SB_URL=$(grep -E '^SUPABASE_URL=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d "\"' ")
  SB_ANON=$(grep -E '^SUPABASE_ANON_KEY=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d "\"' ")
  [ "$SB_URL" = "https://$PROD_REF.supabase.co" ] || return 1
  [ -n "$SB_ANON" ] || return 1
  (
    umask 077
    printf 'apikey: %s\n' "$SB_ANON" > "$RUN_DIR/.hdr-anon"
  )
}

# sb_login — sets SB_TOKEN/SB_UID for QA_EMAIL/QA_PASSWORD, or SB_LOGIN_ERR.
sb_login() {
  local resp
  resp=$(jq -nc --arg e "$QA_EMAIL" --arg p "$QA_PASSWORD" '{email: $e, password: $p}' |
    curl -sS -X POST "$SB_URL/auth/v1/token?grant_type=password" \
      -H @"$RUN_DIR/.hdr-anon" -H 'Content-Type: application/json' --data-binary @-)
  SB_TOKEN=$(jq -r '.access_token // empty' <<< "$resp" 2> /dev/null)
  SB_UID=$(jq -r '.user.id // empty' <<< "$resp" 2> /dev/null)
  if [ -z "$SB_TOKEN" ]; then
    SB_LOGIN_ERR=$(jq -r '.error_description // .msg // .message // .error // "no response"' <<< "$resp" 2> /dev/null)
    return 1
  fi
  (
    umask 077
    printf 'apikey: %s\nAuthorization: Bearer %s\n' "$SB_ANON" "$SB_TOKEN" > "$RUN_DIR/.hdr-user"
  )
}

# sb_rest <METHOD> <path?query> [json] — PostgREST as the throwaway user.
# Prints the body; non-zero on HTTP >= 300. Re-logs in once on 401.
sb_rest() {
  local method=$1 path=$2 body=${3:-} out code attempt
  for attempt in 1 2; do
    out=$(printf '%s' "$body" | curl -sS -X "$method" "$SB_URL/rest/v1/$path" \
      -H @"$RUN_DIR/.hdr-user" -H 'Content-Type: application/json' \
      -H 'Prefer: return=representation' ${body:+--data-binary @-} -w '\n%{http_code}')
    code=${out##*$'\n'}
    if [ "$code" = 401 ] && [ "$attempt" = 1 ]; then
      sb_login || return 1
      continue
    fi
    printf '%s\n' "${out%$'\n'*}"
    [ "$code" -lt 300 ] 2> /dev/null
    return
  done
}

# Server-side counts and marker checks for the throwaway user (RLS-scoped).
sb_count() { sb_rest GET "$1?select=id" | jq 'length'; }
sb_has_marker() { sb_rest GET "notes?select=content" | jq -e --arg m "$1" 'any(.[]; (.content | tostring) | contains($m))' > /dev/null; }

# mgmt_init — load the Supabase CLI token (or SUPABASE_ACCESS_TOKEN).
mgmt_init() {
  local raw token=${SUPABASE_ACCESS_TOKEN:-}
  if [ -z "$token" ]; then
    raw=$(security find-generic-password -s "Supabase CLI" -a supabase -w 2> /dev/null) || return 1
    case $raw in
      go-keyring-base64:*) token=$(printf '%s' "${raw#go-keyring-base64:}" | base64 -D) ;;
      go-keyring-encoded:*) token=$(printf '%s' "${raw#go-keyring-encoded:}" | xxd -r -p) ;;
      *) token=$raw ;;
    esac
  fi
  [ -n "$token" ] || return 1
  (
    umask 077
    printf 'Authorization: Bearer %s\n' "$token" > "$RUN_DIR/.hdr-mgmt"
  )
}

# sb_sql <statement> — run on prod via the Management API; prints the JSON rows.
sb_sql() {
  local out code
  out=$(jq -nc --arg q "$1" '{query: $q}' |
    curl -sS -X POST "https://api.supabase.com/v1/projects/$PROD_REF/database/query" \
      -H @"$RUN_DIR/.hdr-mgmt" -H 'Content-Type: application/json' --data-binary @- \
      -w '\n%{http_code}')
  code=${out##*$'\n'}
  out=${out%$'\n'*}
  printf '%s >> %s\n' "$1" "$code" >> "$RUN_DIR/sql.log"
  if [ "$code" -ge 300 ] 2> /dev/null || [ -z "$code" ]; then
    log "   SQL failed ($code): $(head -c 300 <<< "$out")"
    return 1
  fi
  printf '%s\n' "$out"
}

sql_user_row() {
  sb_sql "select id, email_confirmed_at from auth.users where email = '$QA_EMAIL'" | jq -c 'first // empty'
}
