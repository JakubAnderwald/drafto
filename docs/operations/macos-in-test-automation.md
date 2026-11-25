# macOS In-Test automation

A harness that runs a dark-factory **In Test** scenario against the installed macOS TestFlight build and **production**, with no one clicking. It reads the app through the accessibility API, the app's local WatermelonDB, the production API and OCR of window captures. It signs up a throwaway account, approves it with scoped SQL, and deletes it at the end. Decision record: [ADR-0043](../adr/0043-automated-macos-in-test-scenarios.md).

- Code: [`apps/desktop/e2e/in-test/`](../../apps/desktop/e2e/in-test/)
- First scenario: [`scenarios/458-sync-gating.sh`](../../apps/desktop/e2e/in-test/scenarios/458-sync-gating.sh), for #458 / PR #673. Its first green run was on 2026-10-10 against build 0.4.1 (59): 14 checks (step 0, the scenario's steps and an extra A1b check), 11 PASS, 3 WARN. The WARNs were #675, #676 and a sign-out check that now reads the local database instead of the indicator.
- [`scenarios/677-pending-indicator.sh`](../../apps/desktop/e2e/in-test/scenarios/677-pending-indicator.sh), for #677 / PR #772. A background sampler records the indicator's `AXHelp` and `db_pending` about every 0.3 s, and each step judges that timeline (`timeline-<step>.tsv` in the run directory). On 2026-11-01 the scenario's first version passed P0–P4 on build 0.4.4 (73), and its negative control on build 72 (`ISSUE= PR=`) failed P1 and P4. The review hardening that followed (P4's Trash-based count, P0's before-sync rule, baseline checks) hasn't been run end to end yet.
- [`scenarios/861-native-appearance.sh`](../../apps/desktop/e2e/in-test/scenarios/861-native-appearance.sh), for #861. It checks that the title bar and the sign-out sheet follow View → Appearance rather than macOS (it records the View menu's shade but doesn't judge it, since menu-bar menus follow macOS), and that System follows a live macOS switch ([ADR-0089](../adr/0089-macos-native-appearance-follows-in-app-theme.md)). It needs no account and writes nothing to production, so it doesn't source `lib/harness.sh` (see [Writing a scenario](#writing-a-scenario)). It switches macOS between Light and Dark and puts the setting back on exit. Its steps judge brightness with `bin/luma` rather than text.

It is not part of the [test matrix](../architecture/testing.md), because it writes to production. Nothing runs it in CI or before a push.

## Who starts a run

**A person, in Terminal.** A full run:

- signs the app out of whatever account it is using;
- creates, approves and deletes a production account;
- for scenarios that set `TOGGLES_NETWORK=1`, takes the Mac offline with `sudo`, which cuts off the factory and support agent too.

It asks for a typed `YES` and the sudo password before it changes anything.

An agent may write or adapt a scenario and run `--preflight`, which is read-only. The one thing it presses is TestFlight's first-launch Continue, which changes no data (see [Getting the build from TestFlight](#getting-the-build-from-testflight)). It never starts the full run itself.

## One-time setup (the Mac mini already has it)

- **Terminal's privacy permissions** (System Settings → Privacy & Security): Accessibility, Screen Recording, Full Disk Access (for the app's sandbox container), and Automation → System Events.
- **Tools:** `cliclick`, `jq`, `sqlite3`, `gh`, `swiftc` (Xcode command-line tools), and the `supabase` CLI logged in (`supabase login`). Its keychain token authorises the admin SQL.
- **Config:** `apps/desktop/.env.production` in the checkout you run from. In a worktree, run `bash scripts/worktree-bootstrap.sh`.
- **App:** the TestFlight build under test installed at `/Applications/Drafto.app` and running.
- **Session:** the screen unlocked, because a locked console can't be driven or captured.

The Swift helpers (`axq`, `ocr`, `luma`) are compiled into `apps/desktop/e2e/in-test/bin/` (gitignored) on first use.

## Getting the build from TestFlight

- **TestFlight swaps the bundle in when Drafto quits.** It downloads an update while the app runs and installs it the moment the app exits. So the build on disk can change between two runs. Read it with PlistBuddy (`app_plist CFBundleVersion`).
- **Install time is the receipt's mtime** (`Contents/_MASReceipt/receipt`). `Info.plist` keeps the mtime it had at build time, so preflight compares the process start with the receipt. It falls back to `Info.plist` only when the receipt's mtime can't be read.
- **A build that won't open** fails in four ways at once. `open` fails with `-10673`. A dialog says "The beta app … is no longer available. The provisioning profile is invalid". `taskgated-helper` logs `Profile does not have matching hash` and `Disallowing: eu.drafto.mobile`. On 2026-11-01 this happened to build 73 after TestFlight's install-on-quit.
  - Fix: install another build in TestFlight, then reinstall the one you want from **Previous builds**. Each reinstall registers that build's profile.
  - Don't retry `open`. Each failure queues one more dialog, and a launch made while they're queued stays suspended (`ps` state `T`). Dismiss them all, kill the suspended process, then open the app again.
- **A new build's first launch stops at TestFlight's pages.** The first time a build opens, macOS shows its "What to Test" notes, then a "Share feedback" page, each with **Continue** (Polish: **Dalej**) on the right. `CoreServicesUIAgent` owns these windows, not Drafto. Until the last Continue is pressed, Drafto runs with no window, so anything that reads Drafto's window finds nothing or waits forever.
  - Preflight presses Continue through them (`preflight_testflight_pages` in `lib/app.sh`), and so does `run-e2e.sh`. Both use `dismiss_testflight_notes` in `apps/desktop/e2e/lib/testflight-notes.sh`.
  - It acts only while Drafto has no window, or on a page that names Drafto: one left over from an earlier launch can sit over the window, where a click would land on it. The pages' button titles aren't exposed to accessibility, so it finds Continue by position, as the right-hand of the two buttons.
- **TestFlight can be driven:** `bin/axq <TestFlight pid> press <path>` works on its buttons. Unlike in Drafto, AXPress is supported there. Find the paths with `bin/axq <pid> dump`.

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
- TestFlight's first-launch pages, if they are up, are dismissed so Drafto gets its window;
- the running Drafto is that installed bundle and was started after it was installed, since a TestFlight update replaces the bundle under a still-running old process;
- the accessibility tree, OCR, the local database and production auth are all reachable;
- the Supabase CLI token is available.

Once a card has shipped, the card checks fail by design. To re-run its scenario as a regression check, clear them: `ISSUE= PR= bash apps/desktop/e2e/in-test/scenarios/458-sync-gating.sh`.

Each run writes to `~/Library/Logs/drafto-in-test/<scenario>/<timestamp>/`:

- `report.md` (also printed at the end) and `results.jsonl`: one row per step with PASS / WARN / FAIL / SKIP and the evidence. The report's `Run:` line says whether every step ran. A run that stops outside a step's own check (Ctrl-C, an error) gets an ABORTED row for the step it was in, so it can't pass for a shorter green run;
- `log.txt`, `shots/` (a window capture per step), `app.log` (the app's JS console via `log stream`) and `sql.log` (every admin statement);
- once the run is posted (see "Posting a run on the issue" below), `upload.json` and `posted.json`.

`state.env` holds the throwaway credentials (mode 600). A full run deletes it once it has deleted the account. `--cleanup-only` doesn't. `latest` points to the newest run that got as far as creating credentials, which is the run `--cleanup-only` cleans up. Sign back in to your own account afterwards.

## Posting a run on the issue

A finished run's report and screenshots can be posted on the card's issue, with each step's shots under it ([ADR-0096](../adr/0096-factory-test-run-screenshots-on-github.md)). It's an operator command. The factory never runs it, because the shots are of production.

1. **Finish the run first.** The command refuses while the run's `state.env` exists, because the throwaway account may still be live. If the run stopped early, clean it up:
   - `--cleanup-only` cleans up the run `latest` points to, which may not be this one. So first check that `readlink ~/Library/Logs/drafto-in-test/<scenario>/latest` prints this run's `<timestamp>` directory.
   - If it does, run the scenario with `--cleanup-only`. Once that logs `Deleted <n> auth user(s)` for this run's throwaway email, delete the run's `state.env` yourself, because `--cleanup-only` leaves it in place.
   - If `latest` names a newer run, stop. Don't run `--cleanup-only`, which would clean up the newer run instead. This run's account can only be deleted by hand, with the fallback the run printed when it started (`delete from auth.users where email = '<that exact e-mail>'`, the `QA_EMAIL` in its `state.env`). Until that is done and its `state.env` is gone, don't post the run.
2. **List what it would publish.** From the factory checkout:

   ```bash
   cd /Volumes/DraftoFactory/drafto-factory
   node scripts/lib/evidence-post.mjs macos --run-dir ~/Library/Logs/drafto-in-test/<scenario>/<timestamp> --issue <n>
   ```

   You can list `<scenario>/latest`: the command resolves the link and lists the run it points to under that run's own id, `macos-<timestamp>`. `--yes` (step 4) refuses a link and names the run's own directory: pass the `<timestamp>` path the listing printed. The harness moves `latest` to the next run as soon as that run has credentials, so a later `--yes` through the link could post shots you never looked at.

   It prints each shot it would publish and each one it would keep on the Mac mini (with why), then the report as it would be posted. Nothing is published yet.

3. **Look at each shot it lists.** In a harness run, an early one can show your own account's notes, because the run starts by signing that account out. A scenario that needs no account (`backend: none` in its report, such as `861-native-appearance.sh`) signs nothing out, so every shot shows the account the app is signed in to, likely yours. The listing says which it is: it treats a run as a throwaway-account run only when `report.md` says `backend: production` and `log.txt` has the harness's `throwaway account` line, and the comment's footer says the same. If one shouldn't go out, move it out of `shots/` (only what's there is published) and list again, or don't post the run. Once an earlier `--yes` has published the shots (say its comment post failed), moving a file no longer changes anything: the listing shows what is already published, which is what a retry posts. It then names each image by its commit-pinned URL, with the local file it came from after it. Look at each image at that URL, not at the local file, which may have changed since it was published. To withdraw a shot then, take it down first (the runbook's "Taking a screenshot down"), delete the run's `upload.json`, and list again. If the run's comment is already on the issue, the listing says so instead.
4. **Post it** by running the command again with `--yes --sha <40-hex>`, on the `<timestamp>` path the listing printed. The listing's last line gives that `--sha`, so the post names the commit the listing showed (see `--sha` below). Until something is published, `--yes` publishes what `shots/` holds when you run it, checked and OCR-scanned again, not a copy of the listing. So after any change to `shots/`, moving a shot out included, list again and look at what it lists before `--yes`. Moving one out can bring in a shot the last listing kept back: one over the per-comment cap, or a second shot with the same number. It publishes the shots as one parentless commit on `refs/factory-evidence/<issue>/<sha12>/macos-<timestamp>`, then posts one comment, **🏭 macOS run — the In-Test harness on this Mac mini** (marker `<!-- drafto-factory-macos-run-report -->`). The comment has the report, then each step's shots, matched by name (`NN-step-<id>-<STATUS>.png`) to the step in `results.jsonl`. Shots with other names go under "Other screenshots". The comment never moves the card.

The shots go through the same checks as the browser runner's (see the factory runbook's "Test-run screenshots on GitHub"):

- the same file checks;
- an OCR secret scan of each one, except for email addresses: the sidebar shows the signed-in account's on every screen, so a browser screenshot's email check would hold back every shot;
- at most 20 shots and 20 MB per comment;
- the one-time publishing selftest, and `FACTORY_EVIDENCE_UPLOAD`.

Only files in `shots/` named `NN-<label>.png` are considered, so `preflight-window.png` and `tmp-ocr.png` never are. One shot is published per `NN`. A second file with the same number is kept on the Mac mini.

Flags:

- `--sha <40-hex>`: the commit the run tested. Pin it: check that the commit the listing's last line gives is the one whose build the run tested, then pass that same `--sha` on every later run of the command for this run: the `--yes`, and any retry after a failed push or post. Without `--sha`, the command takes the commit an earlier `--yes` of the same run recorded in its `upload.json`, else the newest `drafto-factory-scenario-sha` marker on the issue's own (OWNER) comments. That marker moves when a newer head's scenario is posted, and deleting `upload.json` (step 3) loses the record, so an unpinned run could change which commit the run names, and which ref it looks for.
- `--log-dir <dir>`: where the factory keeps `evidence-selftest.json`. The default is `<repo-root>/logs/factory`, where `<repo-root>` is the checkout the script is in (`--repo-root` overrides it). So run it from the factory checkout, or pass `--log-dir /Volumes/DraftoFactory/drafto-factory/logs/factory`.
- `--ocr <bin>`: the OCR helper. The default is `<log-dir>/bin/ocr`, else the harness's own `apps/desktop/e2e/in-test/bin/ocr`.

It refuses, with exit 1 and nothing published, in these cases:

- in an unattended session (`DRAFTO_UNATTENDED=1`);
- with `--yes`, when `--run-dir` is a link to the run (such as `latest`) rather than the run's own directory;
- while the run's `state.env` exists;
- when `report.md` is missing or has no `Run:` line, so the run didn't finish writing it;
- when the report matches a secret pattern, or the comment's own text does (its run line, or the local path in its footer);
- when the run was already posted (`posted.json` in the run dir has the comment's URL);
- when publishing isn't set up: the switch is off, the selftest hasn't passed, or there's no OCR helper;
- when there's no scenario-sha marker on the issue and no `--sha`;
- when the issue's comments can't be read, or GitHub can't say what is already published for the run. Run it again.

If publishing fails, nothing is posted. If the composed comment still matches a secret pattern once its screenshots are published, it isn't posted, and the error says the screenshots are already public and on which commit. Run the command again to retry: it reuses the run's `upload.json`, or the commit already on its ref, so it never publishes twice. If the comment post fails or times out, run it again too. Before posting, `--yes` looks for the run's comment on the issue: the factory's own (OWNER) comment with the marker and the run's `Run` line. If a timed-out post did land, it records that comment in `posted.json` and doesn't post a second one. To take a posted run down, follow the runbook's "Taking a screenshot down".

## Layout

| File                    | What it does                                                                                                                                 |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/harness.sh`        | Entry point a scenario sources: modes, run directory, preflight, the production confirmation, throwaway credentials, the cleanup `EXIT` trap |
| `lib/ax.sh`             | Find, press, fill and read controls; window capture and OCR; `build_helpers` compiles the Swift helpers                                      |
| `lib/app.sh`            | Drafto screens and flows: `on_main_screen`, `log_in`, `sign_out_via_menu`, `confirm_sign_out`, `settle`, `poll_synced`, …                    |
| `lib/db.sh`             | Read-only queries on the app's WatermelonDB                                                                                                  |
| `lib/prod.sh`           | REST as the throwaway user; admin SQL through the Supabase Management API                                                                    |
| `lib/net.sh`            | Take the Mac offline and back, with a detached root watchdog                                                                                 |
| `lib/common.sh`         | Logging, steps (`step_begin` / `step_end` / `fail_step`), screenshots, the report                                                            |
| `lib/axq.swift`         | Accessibility tree dump, `AXFocused`, window id, key window                                                                                  |
| `lib/ocr.swift`         | Vision text recognition on a PNG, optionally locating one string                                                                             |
| `lib/luma.swift`        | Mean brightness of a region of a PNG, for checks on colour (dark or light chrome)                                                            |
| `scenarios/<issue>-…sh` | One file per In-Test scenario                                                                                                                |

## Writing a scenario

Copy `458-sync-gating.sh`. Set `SCENARIO`, `SCENARIO_TITLE`, `QA_TAG`, `ISSUE`, `PR`, `TOGGLES_NETWORK` and `PRODUCTION_SUMMARY`, source `lib/harness.sh`, then write the steps, ending with `RUN_COMPLETE=1`. Rules that the first scenario taught:

- **Verify every press by its effect.** Use `press_until <timeout> <check> …` with a predicate that is true only once the press did what it should. Never assume an input landed.
- **Prefer independent results over UI text.** Good evidence is the local database (`db_last_pulled`, `db_count`, `db_pending`, `db_has_marker`) and the server as the throwaway user (`sb_count`, `sb_has_marker`). The UI can be wrong, as #676 and #677 show.
- **Record WARN for a known, unrelated bug** (cite the issue) and FAIL for a regression in the change under test. Keep checking what the change is responsible for even when a step's UI expectation can't be met. The #458 A2 step still asserts "no pull while unapproved".
- **Take baselines before the action that could break.** For example, the "never pulls while unapproved" baseline is recorded after sign-out, before sign-up.
- **Scope every production write** to the throwaway account's exact e-mail or user id. Never use a pattern or an unqualified `DELETE` ([production data safety](./migrations.md)).
- **A scenario that needs no account can skip `lib/harness.sh`.** The harness always creates a production throwaway account. `861-native-appearance.sh` sources only `common.sh`, `ax.sh` and `app.sh` and supplies its own preflight, confirmation and `EXIT` trap. It restores what it changed, the app theme and macOS's appearance, in that trap.

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
- **Native alerts accept AXPress.** `Alert.alert` is an NSAlert sheet on the main window, and its buttons are AppKit `NSButton`s in the order given. They label themselves through `AXTitle`, not the `AXDescription` that RN views use, and unlike RN views they accept `AXPress` (`ax_native_press`). Every sign-out asks "Sign out?" first. `confirm_sign_out` finds the "Sign out" or "Sign out anyway" button by title, with the description as a fallback, presses it with `AXPress` and falls back to `press_el`, then waits for the Log In screen. It records which copy the dialog showed in `SIGN_OUT_COPY`. It reads that copy only from inside the confirmation (the confirm button's nearest `AXSheet` or dialog-window ancestor), so background text cannot pass for it; the OCR fallback reads the whole window, so there the loss wordings win. By default (`synced` mode, for steps that settled first) it confirms only the synced copy: a dialog that warns of a loss (the unsynced or unknown copy, or a "Sign out anyway" button) or whose copy it could not read gets Cancel, and the step fails. Only a caller that accepts losing unsynced changes passes `any`, as the cleanup does before deleting the throwaway account. Cancel is the first button and so the default, so never answer the dialog with Return. `menu_open` treats only an element without that title as the menu's "Sign out" item, so the open dialog never reads as an open menu.
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
- **Read pending state from the database.** Builds without the #677 fix refresh the indicator's pending count only after a sync attempt. With it, the count refreshes about 0.5 s after a local edit, but shows for only about 1 s online before "Syncing...". Either way `db_pending` is the reliable signal.
  - `db_pending` also counts attachments whose file hasn't uploaded. The push skips those rows but still marks them synced, and sign-out deletes local attachment files.
  - It is the guard before a scenario signs out your own account.
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

## Shell gotchas

- **macOS bash is 3.2:** no associative arrays, no `${var,,}`.
- **Numbers follow the locale.** Under pl_PL, `awk 'BEGIN { printf "%.4f", x }'` prints `0,0037`, which the Swift helpers can't parse. `lib/common.sh` exports `LC_NUMERIC=C` for every scenario and unsets `LC_ALL`, which would override it, after copying it into `LC_CTYPE` (and into `LANG` if `LANG` is unset). The rest of the locale stays, because matching the `✓` menu checkmark needs UTF-8.
- **`pipefail` breaks `cmd | grep -q`:** `grep -q` exits early, the writer gets SIGPIPE, and the pipeline fails. Match on captured output instead.
- **A function named `log` shadows `/usr/bin/log`.** Call the binary by its path.
- **zsh treats `"$var:a…"` as a path modifier.** In `git show "origin/$B:apps/…"` the `:a` expands. Write `${B}`.
- **The network watchdog** is a detached `sudo -n -b nohup` shell. It re-enables the same services after 120 s unless the run already did, so a killed run can't leave the Mac offline.
