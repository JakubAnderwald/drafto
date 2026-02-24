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

| #                              | Title        | Status | Date       |
| ------------------------------ | ------------ | ------ | ---------- |
| [0000](./0000-adr-template.md) | ADR Template | N/A    | 2026-02-24 |
