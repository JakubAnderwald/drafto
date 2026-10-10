# macOS In-Test automation

A harness that runs a dark-factory **In Test** scenario against the installed macOS TestFlight build and **production**, with no one clicking. It reads the app through the accessibility API, the app's local WatermelonDB, the production API and OCR of window captures. It signs up a throwaway account, approves it with scoped SQL, and deletes it at the end. Decision record: [ADR-0043](../adr/0043-automated-macos-in-test-scenarios.md).

- Code: [`apps/desktop/e2e/in-test/`](../../apps/desktop/e2e/in-test/)
- First scenario: [`scenarios/458-sync-gating.sh`](../../apps/desktop/e2e/in-test/scenarios/458-sync-gating.sh), for #458 / PR #673. Its first green run was on 2026-10-10 against build 0.4.1 (59): 13 steps, 11 PASS, 3 WARN, the WARNs being the pre-existing bugs listed below.

It is not part of the [test matrix](../architecture/testing.md), because it writes to production. Nothing runs it in CI or before a push.

## Who starts a run

**A person, in Terminal.** A full run:

- signs the app out of whatever account it is using;
- creates, approves and deletes a production account;
- for scenarios that set `TOGGLES_NETWORK=1`, takes the Mac offline with `sudo`, which cuts off the factory and support agent too.

It asks for a typed `YES` and the sudo password before it changes anything.

An agent may write or adapt a scenario and run `--preflight`, which is read-only. It never starts the full run itself.

## One-time setup (the Mac mini already has it)

- **Terminal's privacy permissions** (System Settings → Privacy & Security): Accessibility, Screen Recording, Full Disk Access (for the app's sandbox container), and Automation → System Events.
- **Tools:** `cliclick`, `jq`, `sqlite3`, `gh`, `swiftc` (Xcode command-line tools), and the `supabase` CLI logged in (`supabase login`). Its keychain token authorises the admin SQL.
- **Config:** `apps/desktop/.env.production` in the checkout you run from. In a worktree, run `bash scripts/worktree-bootstrap.sh`.
- **App:** the TestFlight build under test installed at `/Applications/Drafto.app` and running.
- **Session:** the screen unlocked, because a locked console can't be driven or captured.

The Swift helpers (`axq`, `ocr`) are compiled into `apps/desktop/e2e/in-test/bin/` (gitignored) on first use.

## Running a scenario

```bash
bash apps/desktop/e2e/in-test/scenarios/458-sync-gating.sh --preflight     # read-only checks
bash apps/desktop/e2e/in-test/scenarios/458-sync-gating.sh                 # full run, ~4 min
bash apps/desktop/e2e/in-test/scenarios/458-sync-gating.sh --cleanup-only  # delete the last run's account, restore the network
```

Preflight checks:

- the installed build equals the `drafto-factory-intest-build:macos:<n>` marker on the issue;
- the PR head equals `drafto-factory-scenario-sha`;
- the issue still has `status:in-test`;
- the accessibility tree, OCR, the local database and production auth are all reachable;
- the Supabase CLI token is available.

Each run writes to `~/Library/Logs/drafto-in-test/<scenario>/<timestamp>/` (`latest` points to the newest):

- `report.md` (also printed at the end) and `results.jsonl`: one row per step with PASS / WARN / FAIL / SKIP and the evidence;
- `log.txt`, `shots/` (a window capture per step), `app.log` (the app's JS console via `log stream`) and `sql.log` (every admin statement).

`state.env` holds the throwaway credentials (mode 600). It is deleted once the account has been deleted. Sign back in to your own account afterwards.

## Layout

| File                    | What it does                                                                                                                                 |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/harness.sh`        | Entry point a scenario sources: modes, run directory, preflight, the production confirmation, throwaway credentials, the cleanup `EXIT` trap |
| `lib/ax.sh`             | Find, press, fill and read controls; window capture and OCR                                                                                  |
| `lib/app.sh`            | Drafto screens and flows: `on_main_screen`, `log_in`, `sign_out_via_menu`, `settle`, `poll_synced`, …                                        |
| `lib/db.sh`             | Read-only queries on the app's WatermelonDB                                                                                                  |
| `lib/prod.sh`           | REST as the throwaway user; admin SQL through the Supabase Management API                                                                    |
| `lib/net.sh`            | Take the Mac offline and back, with a detached root watchdog                                                                                 |
| `lib/common.sh`         | Logging, steps (`step_begin` / `step_end` / `fail_step`), screenshots, the report                                                            |
| `lib/axq.swift`         | Accessibility tree dump, `AXFocused`, window id, key window                                                                                  |
| `lib/ocr.swift`         | Vision text recognition on a PNG, optionally locating one string                                                                             |
| `scenarios/<issue>-…sh` | One file per In-Test scenario                                                                                                                |

## Writing a scenario

Copy `458-sync-gating.sh`. Set `SCENARIO`, `SCENARIO_TITLE`, `QA_TAG`, `ISSUE`, `PR`, `TOGGLES_NETWORK` and `PRODUCTION_SUMMARY`, source `lib/harness.sh`, then write the steps. Rules that the first scenario taught:

- **Verify every press by its effect.** Use `press_until <timeout> <check> …` with a predicate that is true only once the press did what it should. Never assume an input landed.
- **Prefer independent results over UI text.** Good evidence is the local database (`db_last_pulled`, `db_count`, `db_pending`, `db_has_marker`) and the server as the throwaway user (`sb_count`, `sb_has_marker`). The UI can be wrong, as #676 and #677 show.
- **Record WARN for a known, unrelated bug** (cite the issue) and FAIL for a regression in the change under test. Keep checking what the change is responsible for even when a step's UI expectation can't be met. The #458 A2 step still asserts "no pull while unapproved".
- **Take baselines before the action that could break.** For example, the "never pulls while unapproved" baseline is recorded after sign-out, before sign-up.
- **Scope every production write** to the throwaway account's exact e-mail or user id. Never use a pattern or an unqualified `DELETE` ([production data safety](./migrations.md)).

## Driving the app: what works on RN macOS 0.81

These are measured behaviours of the TestFlight build, not guesses:

- **Synthetic mouse clicks are unreliable.** After text is typed into a React Native text field, the next two clicks on controls are dropped. Clicks can also drag the window off-screen, because RN views default to `mouseDownCanMoveWindow`. `AXPress` is unsupported: every RN view returns `-25206`.
- **Press controls without the mouse:** set `AXFocused` on the control, check it reports `focused`, then send Space. RN macOS `Pressable`s fire `onPress` on Space/Enter. `press_el` does this and falls back to a click only when focusing fails.
  - Check focus before sending Space. Otherwise the space lands in whichever text field still has focus.
- **Text fields:**
  - focus them through `AXFocused`, select all and delete, then paste with ⌘V;
  - verify the value's length, which secure fields still report (`fill_field`);
  - per-character typing drops keys;
  - clear the clipboard afterwards.
- **Submit forms by pressing their button** with the same verified focus-and-Space press. Return is used only where there is no button, such as the new-notebook name field.
- **Activation is an event.** Bringing Drafto to the front fires AppState `active`, which triggers a sync. `ensure_front` activates only when Drafto isn't already frontmost, and fixes a window that isn't key without the mouse (`axq makekey`).
- **The editor** is a web view: AX-focus the `AXTextArea` inside the `AXWebArea` "RichTextEditor", press ⌘↓, then paste. `type_marker` confirms the text reached the local database.

## Oracles: how a step knows it passed

- **Accessibility attributes:**
  - `testID` surfaces as `AXIdentifier`, `accessibilityLabel` as `AXDescription`, and `accessibilityHint` as `AXHelp`;
  - the sync indicator's hint (`sync_help`) reads `Syncing...` / `Offline` / `N pending` / `Synced`.
- **The local database:** `~/Library/Containers/eu.drafto.mobile/Data/Documents/watermelon.db`, opened read-only. `local_storage.__watermelon_last_pulled_at` tells exactly whether and when a pull happened. Desktop sign-out resets the database.
- **OCR:** `screencapture -l<window id>` works even when the window is covered. Vision OCR reads text that isn't in the accessibility tree, such as the "Just now" / "Never" sync text and error boxes.
- **Reload detection:** a screen re-rendered from scratch drops keyboard focus. #458's A2 step detects its press this way, because the message it should show is lost (#676).
- **Production as the throwaway user:** GoTrue password grant plus PostgREST, so RLS applies.
- **The app's JS console:** `log stream --predicate 'subsystem == "com.facebook.react.log"'`, captured as `app.log`.

## Timing

- **Sync triggers:**
  - the desktop periodic sync ticks every 30 s, but only syncs when something is pending;
  - window activation and network reconnect each trigger a sync;
  - so does the manual indicator button.
- **The 30 s timer runs on a fixed beat** from when the account became approved. That's how the 2026-10-10 run proved its sign-out flush: the last edit and the sign-out both fell between two ticks.
- **Read pending state from the database.** The indicator's pending count only refreshes after a sync attempt (#677), so `db_pending` is the reliable signal.
- **`poll` takes whole seconds** (`date +%s` arithmetic).

## Production specifics

- **Sign-ups need e-mail confirmation in prod.** The harness confirms the e-mail with scoped SQL in place of the link, then logs in through the UI.
- **Throwaway accounts** are named `jakub+draftoe2e-<tag>-<timestamp>@anderwald.info`, the same prefix as `apps/web/e2e/regression/account-approval/`. Each run deletes its own account by exact e-mail, and each sign-up sends one "New Drafto signup" e-mail.
- **Admin SQL** goes through `POST https://api.supabase.com/v1/projects/<ref>/database/query` with the Supabase CLI's keychain token:
  - the keychain item is `"Supabase CLI"` / `supabase`, its value prefixed `go-keyring-base64:` or `go-keyring-encoded:`;
  - `SUPABASE_ACCESS_TOKEN` overrides it;
  - the CLI on the Mac mini (v2.75) has **no `supabase db query`**, so the account-approval cleanup script's command fails on it;
  - every statement is appended to `sql.log`.
- **The Management API's log query endpoint can't be relied on.** `analytics/endpoints/logs.all` has been removed. Its replacement, `analytics/endpoints/logs`, uses a ClickHouse `logs` table, and on 2026-10-10 every query that touched that table returned "Backend error". Don't build an oracle on it.
- **Secrets** live in mode-600 header files passed with `curl -H @file`, never in argv or the log.

## Known app bugs that change expected results

Remove a line once its fix ships, and turn the WARN back into a PASS/FAIL check.

| Issue | Effect on a scenario                                                                                                                   |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------- |
| #675  | After Sign up with e-mail confirmation on, the app shows no feedback and stays on the form                                             |
| #676  | "Check approval status" never shows "still pending approval": the screen is replaced by a spinner during the check and loses its state |
| #677  | The indicator reads "Synced" while local edits are unsynced, and shows "N pending" only after a failed sync                            |
| #678  | Every first sync runs as incremental, and the app logs one `[Sync] Server wants client to update record …` error per pulled record     |

## Shell gotchas

- **macOS bash is 3.2:** no associative arrays, no `${var,,}`.
- **`pipefail` breaks `cmd | grep -q`:** `grep -q` exits early, the writer gets SIGPIPE, and the pipeline fails. Match on captured output instead.
- **A function named `log` shadows `/usr/bin/log`.** Call the binary by its path.
- **zsh treats `"$var:a…"` as a path modifier.** In `git show "origin/$B:apps/…"` the `:a` expands. Write `${B}`.
- **The network watchdog** is a detached `sudo -n -b nohup` shell. It re-enables the same services after 120 s unless the run already did, so a killed run can't leave the Mac offline.
