# 0062 — Desktop PKCE Draws From a Native CSPRNG

- **Status**: Accepted
- **Date**: 2026-10-25
- **Authors**: Jakub Anderwald, Claude

## Context

The macOS app signs in with PKCE (`apps/desktop/src/lib/supabase.ts`, [ADR-0044](./0044-desktop-auth-web-handoff.md)). The `code_verifier` that supabase-js writes to this Mac's storage is what binds an OAuth or password-reset code to the device.

Hermes on react-native-macos has no global `crypto`. auth-js (2.101.1 in the fossil build) checks `typeof crypto === 'undefined'` and, when it is, builds the verifier from `Math.random()`. With no `crypto.subtle` it also sends the verifier itself as a `plain` challenge. `Math.random` is not a cryptographic source, so the verifier is guessable in principle.

The fossil's Hermes (react-native-macos 0.81.6) does have `TextEncoder`, `btoa` and `atob` natively. It has no `crypto` and no `TextDecoder`, and nothing in React Native's JS setup or the app's import chain adds them. So `crypto` is the only missing piece of the S256 path.

[ADR-0015](./0015-desktop-app-technology-choice.md) planned `react-native-get-random-values` as desktop's replacement for `expo-crypto`, but it was never installed. Mobile fixed the same gap with expo-crypto ([ADR-0045](./0045-mobile-auth-uses-pkce.md), `apps/mobile/src/lib/crypto-random.ts`). Desktop can't: it builds only from the primary checkout's fossil `node_modules` ([ADR-0027](./0027-desktop-react-version-locked-to-react-native-macos.md)), so no npm package with native code can be added. Adding one means a `pnpm install`, which destroys the fossil.

## Decision

Add a small Objective-C module, `DraftoCrypto`, to the macOS app target (`apps/desktop/macos/Drafto-macOS/DraftoCrypto.{h,mm}`, wired into `project.pbxproj`), next to `DraftoMenuManager`. It is compiled from the Xcode project and never comes from `node_modules`, so the fossil is untouched. **This is the pattern for any native capability desktop needs while the fossil stands.**

- `randomBytes(length)` is a `RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD` backed by `SecRandomCopyBytes`. It returns `nil` (`null` in JS) for a length outside 1–65536 or when `SecRandomCopyBytes` fails. It never returns unfilled bytes.
- `sha256(bytes)` is a promise method backed by CommonCrypto `CC_SHA256`. It checks every element is a byte, and always resolves or rejects. It never raises, because an exception on a method queue crashes the app.
- Bytes cross the bridge as plain arrays of numbers. Payloads are a few hundred bytes, so neither side needs a base64 codec. A typed array would arrive natively as a dictionary, not an array.
- The app runs bridgeless, so the module goes through the TurboModule interop layer, like `DraftoMenuManager`. `RCT_EXPORT_MODULE()` and the pbxproj entry are all it needs: no codegen spec, Podfile change or `pod install`. In the installed react-native-macos 0.81.6, the interop layer treats a method returning `id` as synchronous and runs it inline on the JS thread. It turns `nil` into `null`, and an `NSArray` of `NSNumber`s into a JS array of numbers. `Security.framework` is already linked through the Pods xcconfig, and CommonCrypto is part of libSystem.

`apps/desktop/src/lib/crypto-random.ts` installs `crypto.getRandomValues` from it before `createClient` runs, and `crypto.subtle.digest("SHA-256")` a moment later, once a native SHA-256 self-test passes (see the install rules below). `apps/desktop/src/lib/supabase.ts` keeps the install's promise as `cryptoReady`, and every call that starts a PKCE flow awaits it first. auth-js then draws the verifier (56 `Uint32` words, 224 bytes) from the CSPRNG and sends an S256 challenge. `apps/desktop/src/lib/native/crypto-module.ts` is the typed accessor, and returns `null` when the module isn't linked.

**Synchronous, not pre-seeded.** WebCrypto's `getRandomValues` is synchronous, and auth-js fills its array and reads it on the next line, so the bytes must be in hand when the JS call returns. The two ways to do that are a blocking synchronous native method, or a pool of bytes fetched asynchronously at startup and handed out from JS. We chose the synchronous method:

- A pool needs refill logic and a byte budget, and has to decide what happens when a burst drains it.
- A pool keeps secret bytes that haven't been used yet on the JS heap.
- A synchronous call costs one JS-thread round trip per sign-in, which is negligible.

**Install rules:**

- Each missing member is installed on its own. A runtime that already has `crypto.getRandomValues` or `crypto.subtle` keeps it. An existing `crypto` object is extended in place rather than copied, because a WebIDL-style object keeps its methods on the prototype.
- At install time, a one-byte probe call checks that the synchronous method answers. If the module is absent (Jest, CI) or the probe fails, nothing is installed. auth-js keeps its old behaviour, so sign-in still works. A failed probe logs a `console.warn`.
- `getRandomValues` is installed at once. `subtle` is added a moment later, and only after the async `sha256` hashes the FIPS 180-2 `"abc"` test vector correctly. auth-js stops falling back to `plain` as soon as `crypto.subtle` exists, so a broken digest would otherwise block every PKCE flow. If the self-test fails, the verifier still comes from the CSPRNG and the challenge stays `plain`, with a `console.warn`.
- The three desktop calls that start a PKCE flow (`signInWithOAuth` in `oauth.ts`, `signUp` and `resetPasswordForEmail` in their screens) first await `cryptoReady`. Without that, a sign-in started in the first moments after launch, before the self-test settles, would get `plain`. Because sign-in waits on it, the self-test gives up after 5 seconds (`SELF_TEST_TIMEOUT_MS`) and counts as failed, so a native promise that never settles leaves the challenge `plain` instead of holding sign-in. The install promise never rejects.
- `subtle` is installed only when `TextEncoder` and `btoa` both exist. auth-js checks for `TextEncoder` before hashing, but calls `btoa` on the S256 path without checking, so `subtle` without `btoa` would throw in the middle of a sign-in.
- After installation, `getRandomValues` **fails closed**. A null, short or out-of-range native result throws, and the array is left untouched. That blocks the sign-in attempt rather than producing a weak verifier. It never falls back to `Math.random`.
- `getRandomValues` accepts integer typed arrays only (`TypeError` otherwise) and enforces WebCrypto's 65536-byte quota (`QuotaExceededError`). `digest` accepts `SHA-256` only (`NotSupportedError` otherwise).

## Consequences

- **Positive**:
  - The desktop PKCE verifier now comes from the OS CSPRNG, and the challenge is S256, matching web.
  - Desktop has a fossil-safe way to add native capability: an in-project module plus a pbxproj entry, with no npm dependency.
  - `apps/desktop/__tests__/lib/pkce-challenge.test.ts` runs the real supabase-js `signInWithOAuth` against the installer and a Node-backed fake of the module, and checks `code_challenge_method=s256` and the challenge against the stored verifier.
- **Negative**:
  - **The native code is first compiled by the beta build.** CI never builds the macOS target, and a worktree build isn't trusted (ADR-0027). A green Jest, `tsc` and lint run proves nothing about `DraftoCrypto.mm` or the pbxproj entry. Only a fossil TestFlight build that signs in with Google, plus an `auth.flow_state` row reading `s256`, proves the native path. The steps are in [testing](../architecture/testing.md#manual-only-coverage) ("The desktop OAuth leg").
  - Most native failures degrade quietly:
    - If the synchronous call doesn't work through the new-architecture interop layer, the probe fails. The app keeps the old `Math.random` verifier and `plain` challenge.
    - If `sha256` fails its self-test, the challenge stays `plain`.
    - In both cases, only the `console.warn` and the `flow_state` row show it.
  - Two failures after a successful install block a sign-in attempt instead:
    - A `randomBytes` call failing after the probe has passed, because `getRandomValues` fails closed.
    - A `sha256` call failing after the self-test has passed, because auth-js no longer falls back to `plain` once `subtle` exists. The self-test only proves the native method worked once.

    Neither is expected, and blocking is intended: a weak verifier is worse than a retry. `signInWithOAuthBrowser` shows both as "Failed to open sign-in" and logs no cause.

  - `apps/desktop/src/lib/generate-id.ts` already uses `crypto.getRandomValues` when it exists. Note, notebook and attachment IDs now come from the native CSPRNG instead of `Math.random`, at one synchronous call per ID. The same fail-closed rule applies, so a native failure after installation makes that create throw instead of falling back. `SecRandomCopyBytes` is not expected to fail once the probe has passed.
  - `subtle` has `digest` only. auth-js's `getClaims()` treats any `crypto.subtle` as full WebCrypto, and for an asymmetric JWT would call `subtle.importKey` and throw. The desktop app never calls `getClaims()`. Add `importKey` and `verify` before it does.
  - The module's Objective-C has no unit tests. The JS side is tested against a mock.
- **Neutral**:
  - Supabase records the challenge method per flow, so a `plain` flow started before an update still exchanges after it.
  - WatermelonDB's record IDs come from its own native module (`randomId.native.js`) and react-navigation uses `nanoid/non-secure`, so neither is affected.
  - `SecRandomCopyBytes` is not one of Apple's required-reason APIs, so `PrivacyInfo.xcprivacy` is unchanged. No data leaves the device, so the privacy policy is unchanged too.
  - Jest runs a newer supabase-js (2.116) than the fossil (2.101.1). Their verifier and challenge code is the same; 2.116 also draws a 16-byte flow id from `getRandomValues`.

## Alternatives Considered

- **An npm CSPRNG package with native code** (`react-native-get-random-values`, `expo-crypto`, `react-native-quick-crypto`). Rejected: installing it means a `pnpm install` in the fossil, which ADR-0027 forbids.
- **A pure-JS CSPRNG or seeding from `Date.now()`/`Math.random()`.** Rejected: there is no cryptographic entropy source in Hermes to seed it from.
- **A pre-seeded pool of random bytes.** Rejected; see "Synchronous, not pre-seeded" above.
- **`getRandomValues` only, keeping the `plain` challenge, as mobile does.** Rejected: once the module exists, SHA-256 is a few lines of CommonCrypto, and S256 means the challenge sent through the browser no longer reveals the verifier.
- **Upgrading react-native-macos, React or auth-js.** Out of scope, and blocked by the fossil (ADR-0027).
