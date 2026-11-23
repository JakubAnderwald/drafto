# Maestro E2E Tests

End-to-end tests for the Drafto mobile app using [Maestro](https://maestro.mobile.dev/).

## Prerequisites

1. Install Maestro CLI:

   ```bash
   brew install maestro
   ```

2. Have a dev client running on iOS Simulator or Android Emulator:

   ```bash
   cd apps/mobile && npx expo start --dev-client
   ```

3. Set environment variables for test credentials:

   ```bash
   export E2E_TEST_EMAIL="your-test-email@example.com"
   export E2E_TEST_PASSWORD="your-test-password"
   ```

4. For `ios-only/07-attach-image.yaml`, grant the app photo access on the simulator first. The system's permission prompt isn't always visible to Maestro and would block the picker:
   ```bash
   xcrun simctl privacy booted grant photos eu.drafto.mobile
   ```
   The flow adds its own photo (`fixtures/attachment-photo.jpg`) with `addMedia`, so the library needs no setup.

## Running Tests

### Combined flows (recommended for full regression)

```bash
# Android — runs all core flows (login, notebooks, notes, navigation) in one session
maestro test apps/mobile/e2e/android-all.yaml --platform android -e RUN_ID=$(date +%s)

# iOS — runs all core flows in one session
maestro test apps/mobile/e2e/ios-all.yaml --platform ios -e RUN_ID=$(date +%s)
```

### Individual flows (cross-platform)

Flows 01-04 and 05-cross-platform-sync work on both platforms:

```bash
maestro test apps/mobile/e2e/01-login.yaml --platform ios
maestro test apps/mobile/e2e/02-create-notebook.yaml --platform ios -e RUN_ID=$(date +%s)
```

### Platform-specific flows

```bash
# Android-only (uses pressKey: back, toggleAirplaneMode)
maestro test apps/mobile/e2e/android-only/ --platform android -e RUN_ID=$(date +%s)

# iOS-only (uses header back buttons, swipe-to-dismiss modals)
maestro test apps/mobile/e2e/ios-only/ --platform ios -e RUN_ID=$(date +%s)
```

A folder run also picks up the report 10668 flows below. Their pass/fail is a host check the folder run doesn't do, and the iOS offline ones need the Mac offline between phases, so add `--exclude-tags qa-10668,requires-host-offline` and run them through their runner.

### PrimeTestLab report 10668 flows

The flows tagged `qa-10668` (09–11 above and the platform `08`–`11` ones) cover the fixes for PrimeTestLab report 10668. The layout ones only set the scene: Maestro's `tapOn` and `below:` pass on a half-covered button, so the pass/fail is a host check on `maestro hierarchy`, `dumpsys window` and a screenshot. Run them through their runner, which also guards that the installed build is dev-backed:

```bash
# Android: a dev-backed release APK built with EXPO_PUBLIC_E2E_PROBES=1 (airplane-mode legs)
bash apps/mobile/e2e/run-qa-10668-e2e.sh android

# iOS: skips the offline legs, which take the whole Mac offline (sudo)
bash apps/mobile/e2e/run-qa-10668-e2e.sh ios

# iOS with the offline legs
bash apps/mobile/e2e/run-qa-10668-e2e.sh ios --allow-host-offline

# --before: against a build without the fixes, every report check must reproduce
bash apps/mobile/e2e/run-qa-10668-e2e.sh android --before
```

See [testing.md](../../../docs/architecture/testing.md#report-10668-runner-and-host-layout-checks) for the checks, and its "Offline flows on Android" and "E2E probe builds" sections for the build.

### Web-seeded flows

Flows 05 and 08 open a note that a Playwright test seeds through the web API. Run them through their runner scripts, which seed the note, run the flow, then check the saved note through the API:

```bash
# Flow 05 on iOS, then Android: a formatted web note, edited on mobile
bash apps/mobile/e2e/run-cross-platform-e2e.sh

# Flow 08 on iOS (or pass android): nested to-dos survive a mobile edit
bash apps/mobile/e2e/run-nested-lists-e2e.sh
```

## Test Flows

### Cross-platform (both iOS and Android)

| Flow                          | Description                                                    |
| ----------------------------- | -------------------------------------------------------------- |
| `01-login.yaml`               | Login with email/password, verify Notebooks screen             |
| `02-create-notebook.yaml`     | Create, rename, cancel notebooks; a taken name is refused      |
| `03-create-edit-note.yaml`    | Create notes, open editor, rename via long press               |
| `04-trash-restore.yaml`       | Tab navigation between Notebooks and Trash                     |
| `05-cross-platform-sync.yaml` | Open a note created by web E2E, edit on mobile                 |
| `06-forgot-password.yaml`     | Request a reset link, open the recovery deep link              |
| `07-delete-account.yaml`      | Open Delete account, check DELETE gating, cancel               |
| `08-nested-lists.yaml`        | Open a web note with nested to-dos, edit the deepest one       |
| `09-password-visibility.yaml` | Show/hide password toggle on Log In and Sign up (S-01)         |
| `10-swipe-hint.yaml`          | One-time swipe hints on each list, Trash tap menu (S-03)       |
| `11-sign-out-confirm.yaml`    | Sign Out asks first; Cancel (and Android back) stays in (S-02) |
| `search.yaml`                 | Open search, type query, dismiss                               |

### Android-only

| Flow                                         | Description                                                                          |
| -------------------------------------------- | ------------------------------------------------------------------------------------ |
| `android-all.yaml`                           | Combined flow: password toggle + login + notebooks + notes + nav + sign-out cancel   |
| `android-only/05-offline-mode.yaml`          | Airplane mode, offline note creation, sync on reconnect                              |
| `android-only/06-offline-notebook-sync.yaml` | Offline notebook + note creation, sync verification                                  |
| `android-only/07-auth-callback-link.yaml`    | Apple callback link is claimed, warm and cold, not routed                            |
| `android-only/08-fab-above-nav-bar.yaml`     | Notebook "+" above the 3-button nav bar (M-01, host check)                           |
| `android-only/09-offline-image.yaml`         | Attached images show offline, cold start included (M-02, host check)                 |
| `android-only/10-offline-banner-header.yaml` | Offline banner below the header; Back works offline (M-03, host check)               |
| `android-only/11-dark-nav-bar.yaml`          | Nav bar follows the in-app theme, cases A/B/C (M-04, host check)                     |
| `android-only/12-delete-dialog-nav-bar.yaml` | Nav bar keeps the in-app theme with the delete-account dialog open, cases D/E (#862) |

### iOS-only

| Flow                                        | Description                                                                        |
| ------------------------------------------- | ---------------------------------------------------------------------------------- |
| `ios-all.yaml`                              | Combined flow: password toggle + login + notebooks + notes + nav + sign-out cancel |
| `ios-only/05-offline-mode.yaml`             | Offline note creation, cold start, sync on reconnect; phased, Mac offline          |
| `ios-only/06-offline-notebook-sync.yaml`    | Offline notebook + note creation, sync verification; phased, Mac offline           |
| `ios-only/search.yaml`                      | Search, a result's sheet, and both close buttons                                   |
| `ios-only/07-attach-image.yaml`             | iPhone: attach a photo, toast below header, "All synced"                           |
| `ios-only/08-fab-above-home-indicator.yaml` | Notebook "+" above the home indicator (M-01, host check)                           |
| `ios-only/09-attach-image-offline.yaml`     | Images show offline and attach offline; phased, Mac offline (M-02, host check)     |
| `ios-only/10-offline-banner-header.yaml`    | Offline banner below the header; phased, Mac offline (M-03, host check)            |

## Platform differences

The main navigation difference between platforms:

- **Android**: Uses `pressKey: back` (hardware back button) to navigate between screens
- **iOS**: Uses `tapOn: "Notes"` / `tapOn: "Notebooks"` to tap the header back button. "Notebooks" is the tabs screen's title; "Notes" is the editor's fixed `headerBackTitle` (`app/_layout.tsx`), because the notebook screen itself is titled with the notebook's name. Search is a sheet with a close button (`tapOn: { id: "search-close" }`); a note opened from it is a sheet of its own, closed with `tapOn: { id: "note-sheet-close" }`. Assert `notVisible` on the button afterwards: the screen beneath the sheet is still in the view hierarchy, so a `visible` check on it passes even if the sheet didn't close
- **Editor keyboard check**: `03-create-edit-note.yaml`, `ios-all.yaml` and `android-all.yaml` tap into the note body, type a line, and save an `editor-keyboard-up` screenshot. Look at it after a run: the body text has a side gutter and the formatting toolbar sits directly on the keyboard, with no blank band above it

## Notes

- Tests are designed to run **sequentially** (each builds on state from the previous flow)
- Flow 01 clears app state and logs in fresh; flows 02+ assume prior login
- Flow 06 is the exception: it clears state and runs **signed out**, so run it on its own
  (`maestro test apps/mobile/e2e/06-forgot-password.yaml --platform ios`, no `-e` vars)
  rather than in the middle of the sequence. It requests the reset for an address with no account,
  because dev's mailer won't send to the E2E account (see
  [environments.md](../../../docs/architecture/environments.md#supabase-projects))
- `android-only/07-auth-callback-link.yaml` also clears state and runs signed out, so run it on its own
  too (`maestro test apps/mobile/e2e/android-only/07-auth-callback-link.yaml --platform android`)
- `11-sign-out-confirm.yaml` only cancels by default, and `ios-all.yaml` and `android-all.yaml` run it
  (Cancel only) at their end. Its `-e SIGN_OUT_CONFIRM=1` leg confirms the sign-out, which the app
  makes global (every session of the account ends). So that leg first switches the device to a
  **dedicated dev account** with `helpers/sign-in-clean.yaml` (a clean start, which drops the local
  session without signing the shared user out anywhere) and signs that account out, never the shared
  E2E user whose session web CI's Playwright run uses. Pass `-e E2E_SIGNOUT_EMAIL` and
  `-e E2E_SIGNOUT_PASSWORD` from `apps/web/.env.local`; `run-qa-10668-e2e.sh` does this when
  `SIGN_OUT_CONFIRM=1` is set (and for `--before`, where a build without the fix signs out at the first
  tap) and refuses without them. The device ends signed out, so run `01-login.yaml` before other flows.
  Don't run the confirm leg on two devices at once: they share the dedicated account, and one's sign-out
  ends the other's session. `09-password-visibility.yaml` runs signed out, so both combined
  flows run it first
- Flow 07 only ever **cancels** the account-deletion dialog — it must never tap an enabled
  confirm, because the flows share one real E2E account. It is also inlined at the end of
  `ios-all.yaml` and `android-all.yaml`
- Maestro E2E tests are **local-only** — they do not run in CI
- Run the full suite on both iOS Simulator and Android Emulator before any release
- Minimum timeout tier is 10s to avoid flakiness on slow emulators

## App Store screenshots

`../store/screenshots/app-store.yaml` is not part of this suite. It is the Maestro flow behind `pnpm store:screenshots:ios`, which signs in as the App Review demo account. See `docs/operations/builds-and-releases.md` → "App Store screenshots".
