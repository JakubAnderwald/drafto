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

## Test Flows

### Cross-platform (both iOS and Android)

| Flow                          | Description                                        |
| ----------------------------- | -------------------------------------------------- |
| `01-login.yaml`               | Login with email/password, verify Notebooks screen |
| `02-create-notebook.yaml`     | Create, rename, cancel notebooks                   |
| `03-create-edit-note.yaml`    | Create notes, open editor, rename via long press   |
| `04-trash-restore.yaml`       | Tab navigation between Notebooks and Trash         |
| `05-cross-platform-sync.yaml` | Open a note created by web E2E, edit on mobile     |
| `search.yaml`                 | Open search, type query, dismiss                   |

### Android-only

| Flow                                         | Description                                             |
| -------------------------------------------- | ------------------------------------------------------- |
| `android-all.yaml`                           | Combined flow: login + notebooks + notes + nav          |
| `android-only/05-offline-mode.yaml`          | Airplane mode, offline note creation, sync on reconnect |
| `android-only/06-offline-notebook-sync.yaml` | Offline notebook + note creation, sync verification     |

### iOS-only

| Flow                                     | Description                                             |
| ---------------------------------------- | ------------------------------------------------------- |
| `ios-all.yaml`                           | Combined flow: login + notebooks + notes + nav          |
| `ios-only/05-offline-mode.yaml`          | Airplane mode, offline note creation, sync on reconnect |
| `ios-only/06-offline-notebook-sync.yaml` | Offline notebook + note creation, sync verification     |
| `ios-only/search.yaml`                   | Search with modal dismiss (swipe down)                  |

## Platform differences

The main navigation difference between platforms:

- **Android**: Uses `pressKey: back` (hardware back button) to navigate between screens
- **iOS**: Uses `tapOn: "Notes"` / `tapOn: "Notebooks"` to tap the header back button (label comes from the previous screen's title). The search screen is a modal dismissed with `swipe: { direction: DOWN }`

## Notes

- Tests are designed to run **sequentially** (each builds on state from the previous flow)
- Flow 01 clears app state and logs in fresh; flows 02+ assume prior login
- Maestro E2E tests are **local-only** — they do not run in CI
- Run the full suite on both iOS Simulator and Android Emulator before any release
- Minimum timeout tier is 10s to avoid flakiness on slow emulators
