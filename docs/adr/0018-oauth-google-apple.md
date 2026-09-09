# 0018 — OAuth Authentication with Google and Apple

- **Status**: Accepted
- **Date**: 2026-04-12

## Context

Drafto currently supports only email+password authentication via Supabase Auth across all four platforms (web, iOS, Android, macOS). Social login was explicitly scoped out of v1. Users now expect frictionless sign-in options, and Apple requires "Sign in with Apple" if any other third-party login is offered on iOS/macOS (App Store Review Guideline 4.8). Adding Google OAuth necessitates adding Apple OAuth simultaneously.

The app has an approval gating flow — new users land in `is_approved=false` state regardless of how they sign up. The existing `handle_new_user()` trigger fires on `auth.users` INSERT, so OAuth-created users automatically get a profile row. No database changes are needed.

## Decision

### Web (Next.js)

Use Supabase `signInWithOAuth()` with PKCE flow. This redirects to Google/Apple, then returns to the existing `/auth/callback` route which already calls `exchangeCodeForSession()`.

### Mobile (iOS)

Use native SDKs — `expo-apple-authentication` for Apple Sign In and `@react-native-google-signin/google-signin` for Google — then pass the identity token to Supabase via `signInWithIdToken()`. This provides native UI (Apple's system sheet, Google's One Tap) and avoids opening a web browser.

### Mobile (Android)

Use `@react-native-google-signin/google-signin` for Google, and Supabase `signInWithOAuth()` via `expo-web-browser` for Apple (Apple does not provide a native Android SDK).

### Desktop (macOS)

Open the system browser via `Linking.openURL()` with the Supabase OAuth URL. Register a custom URL scheme (`eu.drafto.desktop`) in Info.plist for the callback. Listen for the URL scheme callback via React Native's `Linking.addEventListener`.

### Account Linking

Use Supabase automatic linking (default behavior). When a user signs up with email+password and later attempts OAuth with the same email, Supabase automatically links the identities if the email is verified on both sides. The user ends up with one account regardless of sign-in method.

## Consequences

**Positive:**

- Native feel on iOS/macOS with system authentication sheets
- No web browser popup on iOS
- Single identity for users who use both email and OAuth
- Approval flow is unaffected — OAuth users still require admin approval

**Negative:**

- Three distinct OAuth flows to maintain (web PKCE, native `signInWithIdToken`, desktop system browser)
- Native SDKs add build complexity on mobile (requires `expo prebuild` after adding plugins)

## Alternatives Considered

1. **`signInWithOAuth()` everywhere (web browser flow on all platforms)**: Simpler code but poor UX on mobile — opens Safari/Chrome, breaks the native feel. Rejected for iOS/Android.

2. **Native SDKs on desktop too**: macOS does not have well-supported React Native bindings for Google Sign-In. `Linking.openURL` with URL scheme callback is the standard macOS approach. Rejected as unnecessary complexity.

3. **Skip Apple, only add Google**: Violates App Store Guideline 4.8 — any app offering third-party login must also offer Sign in with Apple. Rejected.

## Clarification (2026-09-09) — the native Android Google leg needs a registered Android OAuth client

Append-only note. The status stays **Accepted** and the decision above is unchanged; this records a
runtime prerequisite the original text left implicit.

`@react-native-google-signin/google-signin` uses the legacy Google Sign-In for Android API. That API
authenticates the calling app by **package name + signing-certificate SHA-1** registered as an
**Android**-type OAuth 2.0 client in the Cloud project — not by any client ID compiled into the
build. `GoogleSignin.configure()` takes only `webClientId` and `iosClientId`; there is deliberately
no `androidClientId` parameter (v16 `console.error`s if one is passed), so nothing in the repo can
express the Android registration.

The consequence: if the Android client is missing, or its SHA-1 does not match the certificate the
installed build was signed with, the app **compiles, installs, and runs**, and only fails when a
user taps "Google" — with `ApiException` status **10** (`DEVELOPER_ERROR`). Because the beta and
production lanes upload an AAB and Play re-signs it, the SHA-1 that matters for store builds is the
**Play App Signing** key's, not the local upload key's. Green CI is therefore not evidence that
Android Google sign-in works.

Two things follow for anyone touching this code path:

- The registration steps live in
  [`docs/operations/builds-and-releases.md`](../operations/builds-and-releases.md#google-sign-in-android-oauth-client)
  and are Google-Cloud-Console work — they cannot be done from this repo.
- `signInWithGoogle()` (`apps/mobile/src/lib/oauth.ts`) surfaces the native status code in its
  error message and logs it under `[oauth][google] sign-in failed`, so this failure mode is
  identifiable from a screenshot rather than only from `adb logcat`.
