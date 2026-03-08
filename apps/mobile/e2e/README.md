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

Run all flows sequentially:

```bash
maestro test apps/mobile/e2e/
```

Run a single flow:

```bash
maestro test apps/mobile/e2e/01-login.yaml
```

Target a specific platform:

```bash
# iOS Simulator
maestro test apps/mobile/e2e/ --platform ios

# Android Emulator
maestro test apps/mobile/e2e/ --platform android
```

## Test Flows

| Flow                       | Description                                                         |
| -------------------------- | ------------------------------------------------------------------- |
| `01-login.yaml`            | Login with email/password, verify Notebooks screen                  |
| `02-create-notebook.yaml`  | Create a new notebook, verify it appears                            |
| `03-create-edit-note.yaml` | Create a note, open editor, rename, verify auto-save                |
| `04-trash-restore.yaml`    | Swipe to trash a note, restore from Trash tab                       |
| `05-offline-mode.yaml`     | Toggle airplane mode, create note offline, verify sync on reconnect |

## Notes

- Tests are designed to run **sequentially** (each builds on state from the previous flow)
- Flow 01 clears app state and logs in fresh; flows 02-05 assume prior login
- Maestro E2E tests are **local-only** — they do not run in CI (too expensive for iOS/Android emulators)
- Run the full suite on both iOS Simulator and Android Emulator before any release
