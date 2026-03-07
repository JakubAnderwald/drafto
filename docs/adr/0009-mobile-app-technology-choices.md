# 0009 — Mobile App Technology Choices

- **Status**: Accepted
- **Date**: 2026-03-07
- **Authors**: Jakub

## Context

Drafto is a note-taking web app built with Next.js, TypeScript, and Supabase. Users have requested native mobile access with offline support. The app needs to work on both iOS and Android, share types and logic with the existing web codebase, and support offline-first editing with background sync to Supabase.

Key requirements:

- Cross-platform (iOS + Android) from a single codebase
- Offline-first with local storage and background sync
- Rich text editing compatible with the web app's BlockNote editor
- Code and type sharing with the existing TypeScript/React web app
- App store distribution (Apple App Store + Google Play)

## Decision

We adopt the following technology stack for the mobile app:

1. **React Native with Expo (SDK 53+)** as the mobile framework
2. **Expo Router** for file-based navigation (mirrors Next.js App Router conventions)
3. **WatermelonDB** for offline-first local SQLite storage with sync
4. **10tap-editor** for rich text editing (ProseMirror-based, compatible with BlockNote)
5. **pnpm workspaces + Turborepo** for monorepo orchestration
6. **`@supabase/supabase-js`** with `expo-secure-store` for auth and direct database access
7. **Maestro** for local-only E2E testing (no CI E2E — too expensive for mobile emulators)

The mobile app communicates directly with Supabase (not through Next.js API routes). The same RLS policies protect data on both platforms.

The repo structure becomes:

- `apps/web/` — existing Next.js web app
- `apps/mobile/` — new Expo mobile app
- `packages/shared/` — shared types (`Database`, API types) and constants

## Consequences

- **Positive**: Maximum code reuse — shared TypeScript types, constants, and eventually a format converter between BlockNote and TipTap. React Native skills transfer directly from existing React/TypeScript expertise.
- **Positive**: Expo simplifies builds (EAS Build), OTA updates, and app store submission. No need to maintain native Xcode/Android Studio build configurations manually.
- **Positive**: WatermelonDB provides a mature, free, offline-first solution with a well-documented sync protocol. No vendor lock-in or recurring costs for offline storage.
- **Positive**: Monorepo with Turborepo enables shared tooling, single CI pipeline, and atomic changes across web and mobile.
- **Negative**: WatermelonDB's sync adapter requires a custom implementation for Supabase (pull changes by `updated_at`, push dirty rows). This adds complexity but is well-scoped.
- **Negative**: 10tap-editor requires a format converter between BlockNote blocks and TipTap JSON. Format fidelity must be validated with round-trip tests.
- **Negative**: No CI E2E tests for mobile — Maestro runs locally only. This trades CI coverage for cost savings (macOS runners for iOS simulation are expensive).
- **Neutral**: The mobile app uses direct Supabase calls instead of the web's API routes. This is more efficient for mobile but means some business logic may diverge if not kept in shared packages.

## Alternatives Considered

### Flutter (Dart)

Rejected because it requires learning Dart and cannot share code with the existing TypeScript/React codebase. No type sharing with `@drafto/shared`. Would create a parallel codebase with no synergy.

### React Native without Expo (bare workflow)

Rejected because Expo provides significant developer experience improvements (EAS Build, OTA updates, managed native modules) with minimal trade-offs. The managed workflow covers all our needs (secure storage, image picker, document picker, file system access).

### PWA (Progressive Web App) instead of native

Rejected because PWAs have limited offline storage reliability on iOS (WebKit purges IndexedDB under storage pressure), no push notification parity, and inferior native feel. A native app with WatermelonDB provides reliable offline storage via SQLite.

### SQLite directly (without WatermelonDB)

Rejected because WatermelonDB provides the sync protocol, observable queries for reactive UI updates, and lazy loading out of the box. Building these features on raw SQLite would be significantly more work with no clear benefit.

### Detox for E2E testing

Rejected in favor of Maestro. Detox requires complex native build integration and is harder to set up. Maestro uses simple YAML flows, supports both iOS Simulator and Android Emulator, and is easier to maintain. Both are local-only (no CI) for mobile, so Maestro's simplicity wins.

### Going through Next.js API routes from mobile

Rejected because direct Supabase access is more efficient (fewer network hops), works better with WatermelonDB's sync adapter pattern, and the same RLS policies provide identical security guarantees. API routes would add latency and an unnecessary dependency on the web server.
