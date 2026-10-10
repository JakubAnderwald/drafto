# shellcheck shell=bash
# Shared beta build-root helpers — SOURCED, never executed.
#
# Used by scripts/factory-agent.sh (pre-merge In Test betas, Phase-D post-merge
# betas) and scripts/nightly-support.sh (Phase 4: ship merged support fixes, see
# ADR-0042). Both point at the SAME two persistent build roots, so the pid-file
# lock below is what keeps one of them from hard-resetting a root while the
# other's lane is building in it.
#
# Caller contract. Sourcing defines functions and the three root paths only;
# nothing runs. Before CALLING any function the caller must define:
#   REPO_ROOT            the checkout new build roots are created from
#                        (`git worktree add`), the mobile root's node_modules is
#                        seeded from, and the gitignored env files are copied from
#   SCRIPT_DIR           "$REPO_ROOT/scripts" (for lib/run-with-timeout.mjs)
#   LOG_FILE             the caller's log file
#   INSTALL_TIMEOUT_SEC  wall-clock cap (seconds) for each pnpm / bundle install
#   log()                timestamped line → stdout AND $LOG_FILE
#   logerr()             timestamped line → $LOG_FILE ONLY. ensure_beta_build_root's
#                        stdout is its return value (the root path), so it must
#                        never write anything else there.
#
# Defined here, each overridable from the environment (the factory's launchd
# plist sets the two build-root knobs explicitly):
#   DESKTOP_FOSSIL_ROOT  DRAFTO_DESKTOP_FOSSIL_ROOT  (default /Users/jakub/code/drafto)
#   BETA_MOBILE_ROOT     DRAFTO_BETA_MOBILE_ROOT
#   BETA_DESKTOP_ROOT    DRAFTO_DESKTOP_BUILD_ROOT
#   BETA_BUILDS_VOLUME_DIR  DRAFTO_BUILDS_VOLUME_DIR
#   BETA_FETCH_TIMEOUT_SEC  DRAFTO_BETA_FETCH_TIMEOUT_SEC  (default 300)
#   BETA_BUNDLE_CHECK_TIMEOUT_SEC  DRAFTO_BETA_BUNDLE_CHECK_TIMEOUT_SEC  (default 120)
#
# The DESKTOP root defaults to the external build volume when it is mounted
# (that is where the Mac mini keeps it), else beside the checkouts in ~/code.
# The MOBILE root always defaults to ~/code/drafto-beta-mobile: its iOS lane
# cannot build from a path with non-ASCII bytes. React Native 0.83's CocoaPods
# scripts (rncore.rb / rndependencies.rb) build file URLs with URI::File.build,
# which rejects them ("bad component(expected absolute path component)"), so
# `pod install` fails on the volume's "Zewnętrzny" mount point. That is what
# broke the first nightly iOS beta (#658, 2026-10-09); ensure_beta_build_root
# refuses such a mobile root outright (see ADR-0042).
#
# macOS /bin/bash 3.2 compatible: no ${VAR,,}, no declare -A, no mapfile.

# Where the fossil lives (React 19.1.x, never reinstalled) and the dedicated,
# persistent build roots the beta lanes run in. The mobile root is seeded from
# $REPO_ROOT; the desktop root is a clonefile replica of the fossil and must
# NEVER be `pnpm install`ed — dispatch-release.mjs asserts React 19.1.x before it
# will spawn the lane. See docs/operations/desktop-build-fossil.md and ADR-0027.
#
# The build roots are DEDICATED and disposable: ensure_beta_build_root hard-resets
# them to the commit being built. They must never be the fossil itself or the
# caller's checkout — ensure_beta_build_root refuses to touch either, because a
# `reset --hard` there would destroy the operator's working tree and any
# uncommitted edits in it.
BETA_BUILDS_VOLUME_DIR="${DRAFTO_BUILDS_VOLUME_DIR:-/Volumes/Zewnętrzny/drafto-builds}"
DESKTOP_FOSSIL_ROOT="${DRAFTO_DESKTOP_FOSSIL_ROOT:-/Users/jakub/code/drafto}"
# Wall-clock cap for the one network call made while a build-root lock is held.
BETA_FETCH_TIMEOUT_SEC="${DRAFTO_BETA_FETCH_TIMEOUT_SEC:-300}"
# Wall-clock cap for `bundle check`. It normally takes a second; a cap of its own
# keeps a wedged ruby from holding the build-root lock (see ensure_beta_build_root).
BETA_BUNDLE_CHECK_TIMEOUT_SEC="${DRAFTO_BETA_BUNDLE_CHECK_TIMEOUT_SEC:-120}"

# (Re)compute BETA_MOBILE_ROOT / BETA_DESKTOP_ROOT. Runs once at source time; a
# long-running caller re-runs it right before preparing a root, because "is the
# build volume mounted" can change between the two (nightly-support.sh sources
# at 00:03 and reaches its builds hours later).
resolve_beta_build_roots() {
  local parent
  if [[ -d "$BETA_BUILDS_VOLUME_DIR" ]]; then
    parent="$BETA_BUILDS_VOLUME_DIR"
  else
    parent="/Users/jakub/code"
  fi
  # Mobile never follows the volume: iOS pods need an ASCII path (see header).
  BETA_MOBILE_ROOT="${DRAFTO_BETA_MOBILE_ROOT:-/Users/jakub/code/drafto-beta-mobile}"
  BETA_DESKTOP_ROOT="${DRAFTO_DESKTOP_BUILD_ROOT:-$parent/drafto-beta-desktop}"
}
resolve_beta_build_roots

# Copy the gitignored env files CLAUDE.md lists into a fresh worktree. Phase B
# is web-only so the mobile/desktop envs are usually absent — copy what exists,
# never fail the run on a missing optional file.
copy_worktree_env() {
  local wt="$1"
  local f
  # google-play-service-account.json is required by the Android Fastlane lane
  # (json_key_path defaults to it) — without it a beta build from any non-primary
  # checkout fails at upload. worktree-bootstrap.sh copies it for humans.
  for f in \
    apps/web/.env.local apps/web/.env.production \
    apps/mobile/.env apps/mobile/.env.production \
    apps/mobile/google-play-service-account.json \
    apps/desktop/.env apps/desktop/.env.production; do
    if [[ -f "$REPO_ROOT/$f" ]]; then
      mkdir -p "$wt/$(dirname "$f")"
      cp "$REPO_ROOT/$f" "$wt/$f" 2>>"$LOG_FILE" || log "WARNING: failed to copy $f into worktree"
    fi
  done
  if [[ -f "$REPO_ROOT/apps/mobile/android/local.properties" ]]; then
    mkdir -p "$wt/apps/mobile/android"
    cp "$REPO_ROOT/apps/mobile/android/local.properties" \
      "$wt/apps/mobile/android/local.properties" 2>>"$LOG_FILE" || true
  fi
}

# Seed a fresh worktree's node_modules from the main checkout via APFS clonefile
# (`cp -c`: O(1), copy-on-write, same volume). The pnpm store lives on an
# external volume on the Mac mini, so a cold `pnpm install` cross-device-copies
# ~2000 packages and ran for 3.5+ hours on #451. Cloning the main checkout's
# already-materialized trees turns the subsequent install into a fast offline
# reconcile that adds ~0 bytes. Best-effort: on any failure the partial dir is
# removed and `pnpm install` repopulates it normally. Only the pnpm workspace
# roots (repo root + apps/* + packages/*) are seeded — never the factory's own
# worktrees/ checkouts.
seed_worktree_node_modules() {
  # $2 (optional) overrides the source checkout. The desktop beta root seeds
  # from the FOSSIL checkout, not $REPO_ROOT — see the fossil note on
  # BETA_DESKTOP_ROOT. Defaults to $REPO_ROOT so existing callers are unchanged.
  local wt="$1" src rel
  local src_root="${2:-$REPO_ROOT}"
  for src in "$src_root"/node_modules "$src_root"/apps/*/node_modules "$src_root"/packages/*/node_modules; do
    [[ -d "$src" ]] || continue
    rel="${src#"$src_root"/}"
    [[ -e "$wt/$rel" ]] && continue
    mkdir -p "$wt/$(dirname "$rel")"
    if ! cp -c -R "$src" "$wt/$rel" 2>>"$LOG_FILE"; then
      log "WARNING: clonefile seed of $rel failed; pnpm install will repopulate it"
      # Guard the cleanup: only remove a non-empty, worktree-relative path so a
      # malformed $wt / $rel can never expand toward / (shellcheck SC2115).
      if [[ -n "$wt" && -d "$wt" && -n "$rel" ]]; then
        rm -rf -- "$wt/$rel" 2>/dev/null || true
      fi
    fi
  done
}

# Install deps in a worktree with a wall-clock cap (run-with-timeout.mjs, exit
# 124 on cap) so a hung install can't hold the implement lock for hours (#451).
# Ladder: fast offline reconcile (node_modules already seeded) → frozen online
# (fetch only drifted tarballs, keep the lockfile) → unfrozen online as a last
# resort for genuine lockfile drift. Returns 0 on the first attempt that
# succeeds, non-zero if all fail / time out.
run_pnpm_install() {
  local wt="$1"
  ( cd "$wt" && node "$SCRIPT_DIR/lib/run-with-timeout.mjs" "$INSTALL_TIMEOUT_SEC" \
      pnpm install --frozen-lockfile --offline --prefer-offline >>"$LOG_FILE" 2>&1 ) && return 0
  log "WARNING: offline reconcile failed/timed out; retrying frozen online"
  ( cd "$wt" && node "$SCRIPT_DIR/lib/run-with-timeout.mjs" "$INSTALL_TIMEOUT_SEC" \
      pnpm install --frozen-lockfile >>"$LOG_FILE" 2>&1 ) && return 0
  log "WARNING: frozen install failed/timed out; retrying unfrozen online"
  ( cd "$wt" && node "$SCRIPT_DIR/lib/run-with-timeout.mjs" "$INSTALL_TIMEOUT_SEC" \
      pnpm install >>"$LOG_FILE" 2>&1 )
}

# Make <sha> available to `git -C <dir>` without letting a stalled remote hold
# the build-root lock forever. Skips the network when the commit is already in
# the object store (the usual case: build roots are worktrees of $REPO_ROOT and
# share its objects), otherwise fetches under a wall-clock cap. Best-effort: a
# failed or capped fetch only warns, and the `worktree add` / `reset --hard`
# that follows fails loudly if the sha is still missing. $1 dir, $2 sha.
_beta_root_fetch() {
  local dir="$1" sha="$2"
  git -C "$dir" cat-file -e "${sha}^{commit}" 2>/dev/null && return 0
  node "$SCRIPT_DIR/lib/run-with-timeout.mjs" "$BETA_FETCH_TIMEOUT_SEC" \
    git -C "$dir" fetch origin >>"$LOG_FILE" 2>&1 \
    || logerr "WARNING: fetch failed or timed out in $dir"
}

# Prepare a dedicated, persistent build root checked out at <sha>, printing its
# path (empty on failure).
#
# Why a dedicated root rather than the issue's worktree: that worktree is live
# (the next --watch tick may pnpm install and let Claude edit files in it) and
# the cleanup sweep deletes it the moment the card leaves In Test — either would
# happen mid-build. A fixed root also keeps ios/Pods and the Gradle cache warm.
#
# Why detached: factory/issue-<n> is already checked out in the issue worktree
# and git refuses a second checkout of the same branch. Pinning the SHA is also
# more precise — it is exactly what CI went green on.
#
# The desktop root's node_modules is a clonefile replica of the FOSSIL checkout
# and must NEVER be installed into; dispatch-release.mjs asserts React 19.1.x
# before it will spawn the lane. $1 platform (mobile|desktop), $2 sha.
ensure_beta_build_root() {
  local platform="$1" sha="$2" root src_root
  case "$platform" in
    mobile)  root="$BETA_MOBILE_ROOT";  src_root="$REPO_ROOT" ;;
    desktop) root="$BETA_DESKTOP_ROOT"; src_root="$DESKTOP_FOSSIL_ROOT" ;;
    *) logerr "ERROR: ensure_beta_build_root: unknown platform '$platform'"; return 1 ;;
  esac
  [[ -n "$sha" ]] || { logerr "ERROR: ensure_beta_build_root: empty sha"; return 1; }

  # Hard safety rail. This function hard-resets and cleans $root, so a
  # misconfigured knob pointing it at the operator's checkout (or the fossil we
  # clone FROM) would destroy real work. Refuse, loudly, rather than proceed.
  local canon_root canon_repo canon_fossil
  canon_root=$(cd "$root" 2>/dev/null && pwd -P || echo "$root")
  canon_repo=$(cd "$REPO_ROOT" 2>/dev/null && pwd -P || echo "$REPO_ROOT")
  canon_fossil=$(cd "$DESKTOP_FOSSIL_ROOT" 2>/dev/null && pwd -P || echo "$DESKTOP_FOSSIL_ROOT")
  if [[ "$canon_root" == "$canon_repo" || "$canon_root" == "$canon_fossil" ]]; then
    logerr "ERROR: refusing to use $root as a $platform beta build root — it is the caller's own checkout ($REPO_ROOT) or the fossil, and this function resets it. Set DRAFTO_BETA_MOBILE_ROOT / DRAFTO_DESKTOP_BUILD_ROOT to a dedicated path."
    return 1
  fi

  # The mobile lane builds iOS, whose React Native 0.83 pods cannot handle a
  # non-ASCII path (see the header). Fail before touching anything rather than
  # spend a full Android build only to die in `pod install`.
  if [[ "$platform" == "mobile" ]] && printf '%s' "$root" | LC_ALL=C grep -q '[^ -~]'; then
    logerr "ERROR: refusing mobile beta build root $root — it contains non-ASCII characters, and React Native 0.83's iOS pods reject non-ASCII paths (URI::File.build). Set DRAFTO_BETA_MOBILE_ROOT to an ASCII path, e.g. /Users/jakub/code/drafto-beta-mobile."
    return 1
  fi

  # The roots are single fixed paths shared by every card, every mode AND two
  # schedulers (the factory and nightly-support.sh), and this function
  # hard-resets + cleans them. Resetting one while a detached lane is still
  # building there corrupts that build. Hold a pid-file lock for the lifetime of
  # the lane; a stale lock (pid gone) is reaped.
  #
  # The lock is taken HERE, with this process's pid, before anything is touched
  # — not only by claim_beta_build_root once the lane has spawned. Preparing a
  # root takes minutes (fetch, reset, install), and without an early lock a
  # second caller could pass the same stale check meanwhile and reset the tree
  # under the first. claim_beta_build_root then hands the lock to the lane's pid;
  # every failure return below drops it; release_beta_build_root drops it when a
  # caller ends up dispatching nothing.
  local lock="$root.lock"
  _beta_root_lock "$platform" "$root" || return 1

  if [[ ! -d "$root/.git" && ! -f "$root/.git" ]]; then
    logerr "Creating $platform beta build root at $root (detached at ${sha:0:12})"
    # The sha can come from the GitHub API (nightly: origin/main's head) and so
    # need not exist locally yet. A fetch only moves remote-tracking refs, never
    # the checkout's working tree — safe in the fossil checkout too.
    _beta_root_fetch "$REPO_ROOT" "$sha"
    if ! git -C "$REPO_ROOT" worktree add --detach "$root" "$sha" >>"$LOG_FILE" 2>&1; then
      logerr "ERROR: could not create beta build root $root"; rm -f "$lock"; return 1
    fi
  else
    _beta_root_fetch "$root" "$sha"
    if ! git -C "$root" reset --hard "$sha" >>"$LOG_FILE" 2>&1; then
      logerr "ERROR: could not reset $root to ${sha:0:12}"; rm -f "$lock"; return 1
    fi
    # Keep node_modules and the warm native build dirs; drop everything else so
    # a previous build's stray files can't leak into this one.
    #
    # The exclude paths must be the REAL ones. `-e` takes gitignore-style
    # patterns: a pattern containing a slash is anchored to the repo root, so
    # `-e macos/Pods` protects only `<root>/macos/Pods` — not
    # `apps/desktop/macos/Pods`, which is where they actually live. Getting this
    # wrong silently nukes Pods and DerivedData on every dispatch, forcing a full
    # `pod install` + cold build each time (verified with `git clean -ndx`).
    # `ios` / `android` have no slash so they match at any depth, but spell those
    # out too rather than rely on the distinction.
    git -C "$root" clean -fdx \
      -e node_modules \
      -e apps/desktop/macos/Pods -e apps/desktop/macos/build \
      -e apps/mobile/ios -e apps/mobile/android \
      >>"$LOG_FILE" 2>&1 || logerr "WARNING: clean failed in $root"
  fi

  # This function's stdout IS its return value (the root path), but these
  # helpers report through log(), which writes to stdout — a single warning (a
  # failed clonefile seed, a missing .env) would otherwise be captured as part of
  # the path and passed to --repo-root as a mangled multi-word argument. Pin
  # their output to stderr; it still reaches $LOG_FILE via log()'s tee.
  seed_worktree_node_modules "$root" "$src_root" >&2
  copy_worktree_env "$root" >&2
  if [[ "$platform" == "mobile" ]]; then
    run_pnpm_install "$root" >&2 || logerr "WARNING: install failed/timed out in $root; the lane may fail"
    # Ruby gems are global (no per-checkout bundle path), so this is a cheap
    # reconcile. Restore Gemfile.lock if it drifted — the root must stay clean
    # for the `git clean` guard above to mean anything.
    # Bounded like the pnpm install above: intest_dispatch_betas runs
    # SYNCHRONOUSLY inside the --watch tick, so an unbounded `bundle install`
    # hanging on RubyGems would block the whole tick and stall every other card.
    # `bundle check` is capped too: on 2026-10-09 one launched by the nightly
    # job blocked for 5 hours in ruby's startup getcwd() on the build volume,
    # holding the mobile root's lock the whole time. A capped check just falls
    # through to the capped install.
    ( cd "$root/apps/mobile" && ( node "$SCRIPT_DIR/lib/run-with-timeout.mjs" "$BETA_BUNDLE_CHECK_TIMEOUT_SEC" \
          bundle check >/dev/null 2>&1 \
        || node "$SCRIPT_DIR/lib/run-with-timeout.mjs" "$INSTALL_TIMEOUT_SEC" bundle install ) ) >>"$LOG_FILE" 2>&1 \
      || logerr "WARNING: bundle install failed/timed out in $root/apps/mobile; the lane may fail"
    git -C "$root" checkout -- apps/mobile/Gemfile.lock 2>/dev/null || true
  fi

  # Every file that ends up inside a .app must be readable by non-root users, or
  # App Store Connect rejects the whole upload (ITMS-90255, see laneShellScript).
  # Setting umask on the lane fixes what the BUILD generates; this fixes what the
  # build COPIES IN. git, pnpm and CocoaPods all ran under the caller's
  # `umask 077` (factory and nightly alike), so the checked-out fonts/assets
  # and the Pods resource bundles are mode 600 on disk and land in the bundle
  # that way.
  #
  # Normalising the inputs here — rather than chmod-ing the built .app later —
  # keeps the fix clear of the code signature: build_mac_app signs the bundle, and
  # mutating a signed .app is a good way to trade one upload rejection for
  # another. `go+rX` adds read for group/other and directory-traverse only where
  # execute already exists, so it never makes a data file executable.
  #
  # The credentials seeded into this root are PRUNED FROM THE TRAVERSAL, not
  # widened and then re-restricted: a build root is ~100k files, so "widen
  # everything, put the secrets back" leaves them world-readable for as long as
  # the walk takes. Never make a secret readable at all, not even briefly.
  # `.env*` alone is not the whole set — google-play-service-account.json is a
  # Play publishing credential, and the signing material is matched here too so
  # that adding a keystore later can't silently start leaking it.
  local -a secrets=(
    -name '.env*'
    -o -name 'google-play-service-account.json'
    -o -name '*.keystore' -o -name '*.jks' -o -name '*.p12'
    -o -name '*.mobileprovision' -o -name '*.cer' -o -name '*.pem'
  )
  find "$root" \( "${secrets[@]}" \) -prune -o -exec chmod go+rX {} + 2>/dev/null || true
  # Defence in depth: whatever the traversal did, the secrets end up owner-only.
  find "$root" -type f \( "${secrets[@]}" \) -exec chmod go-rwx {} + 2>/dev/null || true
  echo "$root"
}

# Claim a build root for a lane's lifetime: hand the lock ensure_beta_build_root
# took for this process over to the lane's pid. Written after the spawn succeeds
# so the lock outlives this process exactly as long as the lane does.
claim_beta_build_root() {
  local platform="$1" pid="$2" root
  case "$platform" in
    mobile)  root="$BETA_MOBILE_ROOT" ;;
    desktop) root="$BETA_DESKTOP_ROOT" ;;
    *) return 0 ;;
  esac
  [[ -n "$pid" && "$pid" != "?" ]] || return 0
  echo "$pid" > "$root.lock" 2>/dev/null || true
}

# Drop a build-root lock this process no longer needs: one still holding OUR pid
# (ensure_beta_build_root prepared the root but no lane was claimed onto it), or
# one whose holder has exited (a finished lane). A lock held by any other live
# process — a lane still building, the other scheduler mid-prepare — is left
# alone, so this is always safe to call, including after a successful claim.
release_beta_build_root() {
  local platform="$1" root lock lock_pid
  case "$platform" in
    mobile)  root="$BETA_MOBILE_ROOT" ;;
    desktop) root="$BETA_DESKTOP_ROOT" ;;
    *) return 0 ;;
  esac
  lock="$root.lock"
  [[ -f "$lock" ]] || return 0
  lock_pid=$(tr -cd '0-9' <"$lock" 2>/dev/null || true)
  if [[ -z "$lock_pid" || "$lock_pid" == "$$" ]] || ! kill -0 "$lock_pid" 2>/dev/null; then
    _beta_root_reap "$lock" "$lock_pid"
  fi
  return 0
}

# Delete <lock> only if it still holds <seen> — the pid the caller just judged
# dead (or its own). Read-then-rm is not atomic on its own: two callers can both
# see the same dead pid, the first reaps it and takes the lock, and the second's
# rm then deletes that fresh lock, so both "win" and reset the same root. A
# mkdir guard serialises the compare-and-delete, so the second caller re-reads,
# finds the first one's pid, and leaves it. Acquisition itself stays the atomic
# `ln` in _beta_root_lock. A guard left behind by a crash inside this (tiny)
# section is cleared once it is a minute old. $1 lock, $2 the pid seen.
_beta_root_reap() {
  local lock="$1" seen="$2" guard="$1.reap" now_pid try
  for try in 1 2 3 4 5; do
    if mkdir "$guard" 2>/dev/null; then
      now_pid=$(tr -cd '0-9' <"$lock" 2>/dev/null || true)
      [[ "$now_pid" == "$seen" ]] && rm -f "$lock" 2>/dev/null
      rmdir "$guard" 2>/dev/null || true
      return 0
    fi
    if [[ -n "$(find "$guard" -maxdepth 0 -mmin +1 2>/dev/null)" ]]; then
      rmdir "$guard" 2>/dev/null || true
    fi
    sleep 1
  done
  return 0
}

# Take <root>.lock for this process ($$ — the top-level script, also from inside
# a $(…) subshell). Atomic: the pid is written to a private temp file first and
# hard-linked into place, so the lock never exists without its pid and two
# callers can't both win. `ln` fails if the lock exists; the holder is then
# checked. Our own pid is re-entrant (a caller may prepare the same root twice in
# one run); a live foreign pid refuses; a dead one is reaped (compare-and-delete,
# see _beta_root_reap) and the take retried. A filesystem without hard links
# falls back to a noclobber create.
_beta_root_lock() {
  local platform="$1" root="$2" lock tmp lock_pid try
  lock="$root.lock"
  tmp="$lock.$$.tmp"
  mkdir -p "$(dirname "$lock")" 2>/dev/null || true
  if ! printf '%s\n' "$$" >"$tmp" 2>/dev/null; then
    logerr "ERROR: cannot write the $platform build-root lock beside $root"
    return 1
  fi
  for try in 1 2 3; do
    if ln "$tmp" "$lock" 2>/dev/null; then
      rm -f "$tmp"; return 0
    fi
    if [[ ! -e "$lock" ]] && ( set -o noclobber; cat "$tmp" >"$lock" ) 2>/dev/null; then
      rm -f "$tmp"; return 0
    fi
    lock_pid=$(tr -cd '0-9' <"$lock" 2>/dev/null || true)
    if [[ -z "$lock_pid" && -e "$lock" ]]; then
      # Empty: only the noclobber fallback can leave that, for the instant
      # between create and write. Look once more before calling it stale.
      sleep 1
      lock_pid=$(tr -cd '0-9' <"$lock" 2>/dev/null || true)
    fi
    if [[ "$lock_pid" == "$$" ]]; then
      rm -f "$tmp"; return 0
    fi
    if [[ -n "$lock_pid" ]] && kill -0 "$lock_pid" 2>/dev/null; then
      rm -f "$tmp"
      logerr "ERROR: $platform beta build root $root is in use by pid $lock_pid; refusing to reset it"
      return 1
    fi
    # The holder is gone: reap — but only the lock we judged, never one another
    # caller has taken since.
    _beta_root_reap "$lock" "$lock_pid"
  done
  rm -f "$tmp"
  logerr "ERROR: could not take $lock (attempt $try); refusing to reset $root"
  return 1
}
