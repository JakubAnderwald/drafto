# 0074 — App Links and Universal Links Verify on the Apex Only

- **Status**: Accepted
- **Date**: 2026-11-11
- **Authors**: Jakub Anderwald, Claude

## Context

Play Console → Deep links reported **2 unverified domains** and **4 broken web links**. The mobile app's `autoVerify` intent filter (`apps/mobile/app.config.ts`) claimed `/notebooks` and `/notes` on both `drafto.eu` and `www.drafto.eu`. That's two hosts × two paths, which are the four links. Google's Digital Asset Links API gave a different error for each host:

- `drafto.eu`: `ERROR_CODE_MALFORMED_CONTENT`. `apps/web/public/.well-known/assetlinks.json` still had the `REPLACE_WITH_SHA256_FINGERPRINT` placeholder it shipped with.
- `www.drafto.eu`: `ERROR_CODE_REDIRECT`. `www` is a redirect domain in the Vercel project's settings, so it answers with a 308 to the apex ([seo-and-indexing.md](../features/seo-and-indexing.md)). The verifier won't follow redirects.

iOS had the same problems. `apple-app-site-association` still had `REPLACE_WITH_TEAM_ID`, and `associatedDomains` listed `applinks:www.drafto.eu`, which Apple's CDN also can't fetch through a redirect. Universal Links had never worked. [ADR-0034](./0034-password-recovery-deep-links-on-mobile-and-desktop.md) records this as the reason password recovery uses custom schemes.

On Android < 12, one host that fails verification makes the whole `autoVerify` filter fail, so the www entries also broke the apex.

## Decision

**Only `https://drafto.eu` is associated with the apps. `www` is not.**

- `assetlinks.json` lists two SHA-256 fingerprints:
  - the **Play App Signing key**, which Play re-signs every AAB with, so it is the certificate on every device that installs from Play
  - the **upload key** (`~/drafto-secrets/drafto-release.keystore`), which covers release APKs built locally and installed by hand
- `apple-app-site-association` names `4J2USPSG2U.eu.drafto.mobile` (Team ID from `apps/mobile/fastlane/Appfile`).
- The Android intent filter and iOS `associatedDomains` list the apex only.
- Guard tests stop the old state from coming back:
  - `apps/web/__tests__/unit/app-association-files.test.ts`: no placeholders, well-formed fingerprints, the right package and app IDs
  - `apps/mobile/__tests__/unit/app-links-config.test.ts`: apex-only hosts, and the same paths and IDs in `app.config.ts` and the association files
  - `apps/web/e2e/seo.spec.ts`: `assetlinks.json` is served as a direct 200

## Consequences

- **Positive**: App Links and Universal Links for `/notebooks/*` and `/notes/*` verify on both platforms, and the Play Console errors clear. Changing the web files alone fixes Play Console's `drafto.eu` check. Devices pick it up when they next verify, which Android does on install and update. On Android < 12, a build that still lists www keeps failing the whole filter until it's replaced. Apple's CDN refreshes its copy of the iOS file on its own.
- **Negative**: A `www.drafto.eu/notes/...` link opens the website and redirects there, not in the app. Nothing Drafto generates uses `www`, because the apex is canonical everywhere ([environments.md](../architecture/environments.md)).
- **Neutral**: Removing www needs a new Android and iOS build. Play Console keeps listing www until a build without it is on the track it reports on. If Play ever rotates the app signing key, or the upload key is reset, `assetlinks.json` must get the new fingerprint (Play Console → Test and release → Setup → App signing shows a ready-made snippet).

## Alternatives Considered

- **Serve www directly and do the www → apex redirect in `next.config.ts`, excluding `/.well-known/*`.** This keeps www app links, but it means changing a working Vercel domain setting by hand and moving the SEO redirect (see [ADR-0059](./0059-keep-login-page-out-of-search-index.md)) into app code. That's a lot of moving parts for a host no link uses.
- **Upload-key fingerprint only.** It would verify the hand-installed APKs and nothing that comes from Play. Users run Play builds, so the app signing key is required.
- **Moving password recovery to Universal Links now that they verify.** That's a separate change to ADR-0034's flow, and it's left for later.
