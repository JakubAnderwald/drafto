# 0045 — Mobile Auth Uses the PKCE Flow

- **Status**: Accepted
- **Date**: 2026-10-10
- **Authors**: Jakub Anderwald, Claude

## Context

The mobile client in `apps/mobile/src/lib/supabase.ts` never set `flowType`, so supabase-js used its default, the **implicit** flow. Two flows on mobile hand Supabase a `drafto://` redirect:

- **Password reset** ([ADR-0034](./0034-password-recovery-deep-links-on-mobile-and-desktop.md)). `resetPasswordForEmail` targets `drafto://reset-password`. Under the implicit flow the link arrives with real session tokens in the fragment, and `completeRecoveryFromUrl` passed them to `supabase.auth.setSession`.
- **Apple sign-in on Android** ([ADR-0018](./0018-oauth-google-apple.md)). `signInWithOAuth` plus `WebBrowser.openAuthSessionAsync`, returning to `drafto://auth/callback`.

Both were wrong:

1. **Session injection.** Any website or app can open `drafto://reset-password#access_token=…&refresh_token=…`. The app trusted those tokens, so it could be signed into an account the link's author chose. The user then sees a reset screen for that account, and any notes they create can sync into it. The app has no way to tell whose tokens a link carries, so the only fix is to stop treating tokens in a URL as credentials. [ADR-0044](./0044-desktop-auth-web-handoff.md) closed the same hole on desktop, which already ran PKCE.
2. **Apple sign-in on Android was likely broken.** The callback handler only looks for a `?code=`. The implicit flow never sends one, so a completed sign-in fell into the "user cancelled" branch and signed nobody in, with no error. This could not be confirmed without a device, but the code path admits no other outcome.

Google sign-in on both platforms and Apple sign-in on iOS use `signInWithIdToken`, which no `flowType` affects.

## Decision

Set `flowType: "pkce"` on the mobile client, matching desktop and web.

- Every redirect into the app now carries a one-time `code`. Only the `code_verifier` that supabase-js wrote to this device's SecureStore when the flow started can redeem it.
- `apps/mobile/src/lib/auth-recovery.ts` accepts only that `code`. It no longer reads `access_token`/`refresh_token`, and never calls `setSession`. A token-only link gets the "missing its credentials" error.
- `createRecoveryLinkHandler` drops any link it has already handled for the life of the handler, because re-exchanging a spent code would replace a working reset form with an error. A throwing callback no longer leaves its queue rejected.
- Apple-on-Android parses its callback with the shared hand-rolled parser in `apps/mobile/src/lib/app-deep-link.ts`, because React Native's `URL` is unreliable with a custom scheme. An `error_description` on the callback is now shown instead of being treated as a cancel.

## Consequences

- **Positive**:
  - No platform accepts session tokens from a deep link any more.
  - Apple sign-in on Android should now complete. It still needs a check on a real device.
  - `apps/mobile/e2e/06-forgot-password.yaml` opens a forged token link and asserts it signs no one in, so the fix is exercised on-device.
- **Negative**:
  - A reset link only completes on the phone that asked for it, because the `code_verifier` lives there. The request screen already said "Open it on this device", so users are told the same thing as before.
  - A reset requested before this release, and opened after updating, carries tokens and now fails with the missing-credentials error. The user requests a new link.
- **Neutral**:
  - Mobile signup sets no `emailRedirectTo`, so the confirmation link ends on the Site URL (`https://drafto.eu`) under either flow. The email is confirmed either way, and the user signs in on the phone. Nothing changes here.
  - supabase-js uses `crypto.subtle` for an S256 challenge when the runtime has it and falls back to `plain` otherwise. A `plain` challenge still ties the code to the verifier in this device's storage, which is the property that closes the hole.
  - The verifier keys (`sb-<ref>-auth-token-code-verifier` and the per-flow slot and index keys) use only letters, digits, `.`, `-` and `_`, and their values are well under SecureStore's size limit, so `secure-store-adapter.ts` needs no change.

## Alternatives Considered

- **Keep the implicit flow and validate the tokens.** Rejected: a forged link carries perfectly valid tokens, just for the wrong account. The app cannot tell whose they are.
- **Keep the implicit flow and drop the `setSession` branch only.** Rejected: under the implicit flow tokens are the only credential, so password reset would stop working altogether.
- **Native Sign in with Apple on Android.** Rejected: Apple ships no Android SDK, which is why the browser flow exists ([ADR-0018](./0018-oauth-google-apple.md)).
