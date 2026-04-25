# Architecture Decision Records (ADR)

This directory contains Architecture Decision Records for Drafto.

An ADR captures a significant architectural decision along with its context, reasoning, and consequences. They serve as a log of **why** the system is shaped the way it is.

## When to write an ADR

Create a new ADR when you make a decision that:

- Introduces or replaces a technology, library, or service
- Changes the project structure or module boundaries
- Defines a new pattern or convention for the codebase
- Affects data flow, storage, or API design
- Has trade-offs that future contributors should understand

## File naming

ADRs use sequential numbering with a kebab-case title:

```
NNNN-short-title.md
```

Examples: `0001-use-supabase-for-auth.md`, `0002-adopt-app-router.md`

## Template

Every ADR follows the template in [0000-adr-template.md](./0000-adr-template.md).

## Index

| #                                                        | Title                                          | Status             | Date       |
| -------------------------------------------------------- | ---------------------------------------------- | ------------------ | ---------- |
| [0000](./0000-adr-template.md)                           | ADR Template                                   | N/A                | 2026-02-24 |
| [0001](./0001-data-model-and-rls-strategy.md)            | Data Model and RLS Strategy                    | Accepted           | 2026-02-24 |
| [0002](./0002-api-route-conventions.md)                  | API Route Conventions                          | Accepted           | 2026-02-24 |
| [0003](./0003-blocknote-editor-configuration.md)         | BlockNote Editor Configuration                 | Accepted           | 2026-02-25 |
| [0004](./0004-design-system-css-variables.md)            | Design System with CSS Custom Properties       | Superseded by 0014 | 2026-03-03 |
| [0005](./0005-dark-mode-implementation.md)               | Dark Mode Implementation                       | Accepted           | 2026-03-04 |
| [0006](./0006-dev-prod-environment-separation.md)        | Dev/Prod Environment Separation                | Accepted           | 2026-03-04 |
| [0007](./0007-evernote-import.md)                        | Evernote Import                                | Accepted           | 2026-03-04 |
| [0008](./0008-production-data-safety-guardrails.md)      | Production Data Safety Guardrails              | Accepted           | 2026-03-07 |
| [0009](./0009-mobile-app-technology-choices.md)          | Mobile App Technology Choices                  | Accepted           | 2026-03-07 |
| [0010](./0010-offline-sync-strategy.md)                  | Offline Sync Strategy with WatermelonDB        | Accepted           | 2026-03-07 |
| [0011](./0011-app-store-deployment-strategy.md)          | App Store Deployment Strategy                  | Superseded by 0016 | 2026-03-08 |
| [0012](./0012-search-implementation.md)                  | Search Implementation                          | Accepted           | 2026-03-14 |
| [0013](./0013-automated-support-pipeline.md)             | Automated Support Pipeline                     | Accepted           | 2026-03-14 |
| [0014](./0014-digital-atelier-design-system.md)          | Digital Atelier Design System                  | Accepted           | 2026-03-19 |
| [0015](./0015-desktop-app-technology-choice.md)          | Desktop App Technology Choice                  | Accepted           | 2026-03-29 |
| [0016](./0016-local-fastlane-builds.md)                  | Local Fastlane Builds                          | Accepted           | 2026-03-31 |
| [0017](./0017-mcp-server-for-claude-cowork.md)           | MCP Server for Claude Cowork                   | Accepted           | 2026-04-11 |
| [0018](./0018-oauth-google-apple.md)                     | OAuth with Google and Apple                    | Accepted           | 2026-04-12 |
| [0019](./0019-email-infrastructure-and-approval-flow.md) | Email Infrastructure and Account Approval Flow | Accepted           | 2026-04-20 |
| [0020](./0020-email-design-tokens.md)                    | Email Design Tokens                            | Accepted           | 2026-04-21 |
| [0021](./0021-shared-design-tokens.md)                   | Shared Design Tokens in `@drafto/shared`       | Accepted           | 2026-04-21 |
| [0022](./0022-note-content-history.md)                   | Note Content History Table                     | Accepted           | 2026-04-25 |
