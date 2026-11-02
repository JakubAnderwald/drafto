# check-migration-grants.awk — the Data API grants rule of `pnpm migration:check`.
#
# From 2026-10-30 Supabase no longer auto-grants anon / authenticated / service_role on
# new objects in `public` (ADR 0052), so a table nobody GRANTs is unreachable from
# supabase-js. This replays the checked migrations in order, statement by statement,
# tracking which API roles hold a grant on each public table and view, and reports:
#   - a table / view left with no grant to authenticated or service_role
#   - a view without security_invoker = true (it would bypass RLS on what it reads)
#   - a serial column (its sequence needs a grant of its own)
# One finding per line on stdout: "<file>:<line>\t<message>\t<statement>".
#
# Pattern-based like the rest of the check (ADR 0008): strings, comments and
# dollar-quoted bodies are lexed out, so DDL issued from a DO block goes unseen.
# `-- safety:ignore` inside a CREATE or REVOKE statement skips that object.
#
# Usage: awk -f check-migration-grants.awk <migration.sql>...   (in apply order)

BEGIN { nobj = 0 }

FNR == 1 {
  if (NR > 1) statement()
  cur = FILENAME
  mode = ""; stmt = ""; start = 0; ignored = 0
}

# Lexer: build one statement at a time, skipping comments, string contents' syntax
# and dollar-quoted bodies, and hand each complete statement to handle().
{
  n = length($0)
  for (i = 1; i <= n; i++) {
    c = substr($0, i, 1)
    if (mode == "block") {
      p = index(substr($0, i), "*/")
      if (p == 0) break
      i += p; mode = ""; continue
    }
    if (mode == "dollar") {
      p = index(substr($0, i), tag)
      if (p == 0) break
      i += p + length(tag) - 2; mode = ""; continue
    }
    if (mode == "quote") {
      add(c)
      if (c == "'") mode = ""
      continue
    }
    if (c == "-" && substr($0, i + 1, 1) == "-") {
      if (start && substr($0, i) ~ /safety:ignore/) ignored = 1
      break
    }
    if (c == "/" && substr($0, i + 1, 1) == "*") { mode = "block"; i++; continue }
    if (c == "'") { add(c); mode = "quote"; continue }
    if (c == "$" && match(substr($0, i), /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/)) {
      tag = substr($0, i, RLENGTH); mode = "dollar"; add(" ")
      i += RLENGTH - 1; continue
    }
    if (c == ";") { statement(); continue }
    add(c)
  }
  add(" ")
}

END {
  statement()
  for (j = 1; j <= nobj; j++) {
    name = order[j]
    if (!live[name] || (name in skip)) continue
    if (name in noinvoker)
      report(noinvoker[name], "view public." tolower(name) " lacks security_invoker = true (it would bypass RLS on the tables it reads)")
    if (!reachable(name))
      report(where[name] "\t" text[name], "public." tolower(name) " has no GRANT to authenticated or service_role (unreachable from the Data API)")
  }
}

function add(ch) {
  if (!start && ch !~ /[ \t\r]/) start = FNR
  if (start) stmt = stmt ch
}

function statement() {
  if (start) handle(stmt, cur ":" start)
  stmt = ""; start = 0; ignored = 0
}

# finding = "<loc>\t<statement>"; printed as "<loc>\t<message>\t<statement>".
function report(finding, message,   tab) {
  tab = index(finding, "\t")
  print substr(finding, 1, tab - 1) "\t" message "\t" substr(finding, tab + 1)
}

function handle(raw, loc,   s, snip, head, rest, name, keep, p, q, r, privs) {
  s = toupper(raw)
  gsub(/"/, "", s)
  gsub(/[ \t\r\n]+/, " ", s)
  sub(/ $/, "", s)
  snip = raw
  gsub(/[ \t\r\n]+/, " ", snip)
  if (length(snip) > 100) snip = substr(snip, 1, 97) "..."

  if (match(s, /^CREATE (OR REPLACE )?((GLOBAL |LOCAL )?(TEMP|TEMPORARY) |UNLOGGED )?(RECURSIVE )?(MATERIALIZED )?(TABLE|VIEW) /)) {
    head = substr(s, 1, RLENGTH); rest = substr(s, RLENGTH + 1)
    # Temp tables live outside public; partitions are reached through their parent;
    # a materialized view ignores RLS, so it stays off the API (no grant needed).
    if (head ~ /TEMP|MATERIALIZED/ || s ~ / PARTITION OF /) return
    # OR REPLACE / IF NOT EXISTS keep an existing object's grants.
    keep = (head ~ /OR REPLACE/)
    if (sub(/^IF NOT EXISTS /, "", rest)) keep = 1
    name = objname(rest)
    if (name == "") return
    if (!live[name] || !keep) newobj(name, loc "\t" snip)
    if (ignored) { skip[name] = 1; return }
    if (head ~ /VIEW $/) {
      if (invoker(s)) delete noinvoker[name]
      else noinvoker[name] = loc "\t" snip
    } else if (s ~ /[ (,](SMALL|BIG)?SERIAL[248]?[ ,)]/) {
      report(loc "\t" snip, "public." tolower(name) " has a serial column, whose sequence needs a GRANT of its own (use uuid or an identity column)")
    }
    return
  }

  if (s ~ /^GRANT / && (p = index(s, " ON ")) && (q = index(s, " TO ")) && q > p) {
    r = substr(s, q + 4)
    sub(/ WITH GRANT OPTION.*$/, "", r); sub(/ GRANTED BY.*$/, "", r)
    # A column-level grant reaches those columns, so it counts like a table grant.
    privs = substr(s, 7, p - 7); gsub(/\([^)]*\)/, "", privs)
    objects(substr(s, p + 4, q - p - 4), "grant", r, apiprivs(privs), loc "\t" snip)
    return
  }

  # GRANT OPTION FOR keeps the privilege; a column-level REVOKE doesn't remove a
  # table-level grant, so neither changes reachability.
  if (s ~ /^REVOKE / && s !~ /^REVOKE GRANT OPTION FOR / && (p = index(s, " ON ")) && (q = index(s, " FROM ")) && q > p) {
    privs = substr(s, 8, p - 8)
    if (privs ~ /\(/) return
    r = substr(s, q + 6)
    sub(/ (CASCADE|RESTRICT)$/, "", r); sub(/ GRANTED BY.*$/, "", r)
    objects(substr(s, p + 4, q - p - 4), "revoke", r, apiprivs(privs), loc "\t" snip)
    return
  }

  if (s ~ /^ALTER VIEW / && invoker(s)) {
    rest = s; sub(/^ALTER VIEW (IF EXISTS )?/, "", rest)
    name = objname(rest)
    if (name != "") delete noinvoker[name]
    return
  }

  # A dropped table loses its grants; a later CREATE starts from nothing.
  if (match(s, /^DROP (TABLE|VIEW) (IF EXISTS )?/)) {
    q = split(substr(s, RLENGTH + 1), parts, ",")
    for (p = 1; p <= q; p++) {
      rest = parts[p]; sub(/^ /, "", rest)
      name = objname(rest)
      if (name != "") live[name] = 0
    }
  }
}

function newobj(name, finding) {
  if (!(name in known)) { known[name] = 1; order[++nobj] = name }
  live[name] = 1
  where[name] = substr(finding, 1, index(finding, "\t") - 1)
  text[name] = substr(finding, index(finding, "\t") + 1)
  delete skip[name]
  delete noinvoker[name]
  setprivs(name, "ANON,AUTHENTICATED,SERVICE_ROLE,PUBLIC", "SELECT INSERT UPDATE DELETE", 0)
}

# "PUBLIC.FOO (" / "FOO AS" -> "FOO"; "" for objects in other schemas.
function objname(rest,   q) {
  if (!match(rest, /^[A-Z0-9_$.]+/)) return ""
  q = substr(rest, 1, RLENGTH)
  if (q ~ /^PUBLIC\./) q = substr(q, 8)
  if (q ~ /\./) return ""
  return q
}

function invoker(s) {
  return s ~ /SECURITY_INVOKER ?= ?'?(TRUE|ON|YES|1)'?[ ,)]/ || s ~ /SECURITY_INVOKER ?[,)]/
}

# The Data API reaches a table through SELECT / INSERT / UPDATE / DELETE; TRUNCATE,
# REFERENCES, TRIGGER and MAINTAIN don't count. "ALL [PRIVILEGES]" means all four.
function apiprivs(list,   n, parts, k, out) {
  gsub(/ /, "", list)
  if (list == "ALL" || list == "ALLPRIVILEGES") return "SELECT INSERT UPDATE DELETE"
  out = ""
  n = split(list, parts, ",")
  for (k = 1; k <= n; k++)
    if (parts[k] ~ /^(SELECT|INSERT|UPDATE|DELETE)$/) out = out " " parts[k]
  return out
}

function reachable(name,   rs, ps, i, j) {
  split("AUTHENTICATED SERVICE_ROLE PUBLIC", rs, " ")
  split("SELECT INSERT UPDATE DELETE", ps, " ")
  for (i = 1; i <= 3; i++)
    for (j = 1; j <= 4; j++)
      if ((name, rs[i], ps[j]) in has) return 1
  return 0
}

# Sets (on = 1) or clears (on = 0) each privilege for each comma-separated role.
function setprivs(name, roles, privs, on,   nr, rs, np, ps, i, j) {
  nr = split(roles, rs, ",")
  np = split(privs, ps, " ")
  for (i = 1; i <= nr; i++) {
    gsub(/ /, "", rs[i])
    for (j = 1; j <= np; j++) {
      if (on) has[name, rs[i], ps[j]] = 1
      else delete has[name, rs[i], ps[j]]
    }
  }
}

# Applies a GRANT / REVOKE to its object list ("ALL TABLES IN SCHEMA public" covers
# only the tables created so far, as in Postgres).
function objects(list, action, roles, privs, finding,   n, parts, k, name, j, schemas) {
  if (privs == "") return
  if (list ~ /^ALL TABLES IN SCHEMA /) {
    schemas = "," substr(list, 22) ","
    gsub(/ /, "", schemas)
    if (index(schemas, ",PUBLIC,") == 0) return
    for (j = 1; j <= nobj; j++)
      if (live[order[j]]) apply(order[j], action, roles, privs, finding)
    return
  }
  if (list ~ /^(ALL|FUNCTION|FUNCTIONS|SEQUENCE|SCHEMA|ROUTINE|PROCEDURE|TYPE|DOMAIN|LANGUAGE|LARGE|FOREIGN|DATABASE|TABLESPACE|PARAMETER) /) return
  sub(/^TABLE /, "", list)
  n = split(list, parts, ",")
  for (k = 1; k <= n; k++) {
    name = parts[k]
    gsub(/ /, "", name)
    if (name ~ /^PUBLIC\./) name = substr(name, 8)
    if (name ~ /\./ || !live[name]) continue
    apply(name, action, roles, privs, finding)
  }
}

function apply(name, action, roles, privs, finding,   before) {
  if (action == "grant") {
    setprivs(name, roles, privs, 1)
    return
  }
  before = reachable(name)
  setprivs(name, roles, privs, 0)
  if (ignored) skip[name] = 1
  # Report a table that lost its last API grant at the REVOKE, not at its CREATE.
  if (before && !reachable(name)) {
    where[name] = substr(finding, 1, index(finding, "\t") - 1)
    text[name] = substr(finding, index(finding, "\t") + 1)
  }
}
