# Archived Documentation

This directory holds historical planning documents — implementation roadmaps, migration plans, and early product thinking — that described work now shipped or superseded. Kept for context (why a choice was made, what options were considered), **not** as a current-state reference.

## Do not

- Link to these from new feature or architecture docs.
- Follow instructions inside them — commands, paths, and assumptions may be stale.
- Update them to "current" state — if an archived doc is wrong today, leave it alone and fix the living doc in [`../features/`](../features/), [`../architecture/`](../architecture/), or [`../operations/`](../operations/).

## If you need current information

- **What a feature does today** → [`../features/`](../features/)
- **How the system is wired** → [`../architecture/`](../architecture/)
- **How to run / build / deploy** → [`../operations/`](../operations/)
- **Why a decision was made** → [`../adr/`](../adr/README.md)

## Contents

| File                                 | What it was                                        | Superseded by                                                                                                                     |
| ------------------------------------ | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `PRD-v1.md`                          | Original product requirements (v1.0, 2026-02-24)   | [`../features/`](../features/) briefs (living state)                                                                              |
| `implementation-plan.md`             | Ralph Loop plan for the web app, all phases done   | Shipped code + [`../features/`](../features/)                                                                                     |
| `mobile_app.md`                      | Ralph Loop plan for iOS/Android, all phases done   | Shipped code + [`../features/mobile-desktop-apps.md`](../features/mobile-desktop-apps.md)                                         |
| `macos-desktop-app.md`               | Implementation plan for macOS app, all phases done | Shipped code + [`../features/mobile-desktop-apps.md`](../features/mobile-desktop-apps.md)                                         |
| `local-mobile-builds.md`             | Migration plan from EAS Build to local Fastlane    | [ADR 0016](../adr/0016-local-fastlane-builds.md) + [`../operations/builds-and-releases.md`](../operations/builds-and-releases.md) |
| `ui-redesign-plan.md`                | Phased plan for the Digital Atelier UI rewrite     | [ADR 0014](../adr/0014-digital-atelier-design-system.md) + [`../features/design-system.md`](../features/design-system.md)         |
| `digital-atelier-ui-rewrite.md`      | Component-level rewrite plan                       | [ADR 0014](../adr/0014-digital-atelier-design-system.md) + [`../features/design-system.md`](../features/design-system.md)         |
| `dev-prod-environment-separation.md` | Plan for splitting dev and prod Supabase projects  | [ADR 0006](../adr/0006-dev-prod-environment-separation.md) + [`../architecture/environments.md`](../architecture/environments.md) |
