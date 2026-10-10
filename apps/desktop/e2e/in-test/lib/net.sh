#!/bin/bash
# Take this Mac offline and back, for steps that exercise the app's reconnect
# handling. Expects RUN_DIR; needs a cached sudo timestamp (harness.sh runs
# `sudo -v` and keeps it alive when the scenario sets TOGGLES_NETWORK=1).
#
# Restore is guaranteed three ways: net_on in the step itself, the EXIT trap
# (net_restore_if_needed), and a detached root watchdog that re-enables the same
# services after NET_WATCHDOG_S unless the step already restored them.

NET_WATCHDOG_S=${NET_WATCHDOG_S:-120}
NET_DISABLED_FILE="$RUN_DIR/net-disabled-services"
NET_RESTORED_FLAG="$RUN_DIR/net-restored"

# Enabled network services whose device currently has an IPv4 address.
net_active_services() {
  networksetup -listnetworkserviceorder |
    sed -nE 's/^\(Hardware Port: (.*), Device: (.*)\)$/\1|\2/p' |
    while IFS='|' read -r port dev; do
      [ -n "$dev" ] || continue
      ipconfig getifaddr "$dev" > /dev/null 2>&1 || continue
      # The service name can differ from the hardware port name; find the
      # service listed just above this "(Hardware Port: …)" line.
      networksetup -listnetworkserviceorder |
        grep -B1 -F "(Hardware Port: $port, Device: $dev)" | head -1 |
        sed -E 's/^\([0-9*]+\) //'
    done
}

# Things that should not lose the network mid-flight.
net_busy() { pgrep -f 'fastlane|xcodebuild|/gym |support-agent\.sh|nightly-(support|audit)\.sh' > /dev/null; }

net_wait_idle() {
  local end=$(($(date +%s) + ${1:-600}))
  while net_busy; do
    [ "$(date +%s)" -lt "$end" ] || return 1
    log "   waiting: a build or support run is active ($(pgrep -fl 'fastlane|xcodebuild|support-agent' | head -1 | cut -c1-80))"
    sleep 20
  done
}

net_off() {
  local services svc
  services=$(net_active_services)
  [ -n "$services" ] || return 1
  printf '%s\n' "$services" > "$NET_DISABLED_FILE"
  rm -f "$NET_RESTORED_FLAG"
  # Detached watchdog: survives this script dying or the terminal closing.
  local restore_cmds=""
  while IFS= read -r svc; do
    restore_cmds+="/usr/sbin/networksetup -setnetworkserviceenabled '$svc' on; "
  done <<< "$services"
  sudo -n -b nohup /bin/sh -c "sleep $NET_WATCHDOG_S; [ -f '$NET_RESTORED_FLAG' ] || { $restore_cmds }" \
    > /dev/null 2>&1 || return 1
  while IFS= read -r svc; do
    log "   network: disabling \"$svc\""
    sudo -n networksetup -setnetworkserviceenabled "$svc" off || return 1
  done <<< "$services"
}

net_on() {
  [ -s "$NET_DISABLED_FILE" ] || return 0
  local svc
  while IFS= read -r svc; do
    log "   network: enabling \"$svc\""
    sudo -n networksetup -setnetworkserviceenabled "$svc" on
  done < "$NET_DISABLED_FILE"
  touch "$NET_RESTORED_FLAG"
  rm -f "$NET_DISABLED_FILE"
}

net_restore_if_needed() {
  [ -s "$NET_DISABLED_FILE" ] || return 0
  log "Restoring the network (trap)"
  net_on
}

# Wait until the Supabase host answers again.
net_wait_online() {
  local end=$(($(date +%s) + ${1:-60}))
  while [ "$(date +%s)" -lt "$end" ]; do
    curl -s -o /dev/null -m 3 -H @"$RUN_DIR/.hdr-anon" "$SB_URL/auth/v1/health" && return 0
    sleep 1
  done
  return 1
}
