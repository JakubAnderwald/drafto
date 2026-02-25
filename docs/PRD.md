# Drafto — Product Requirements Document

**Version:** 1.0
**Date:** 2026-02-24
**Author:** Jakub (with PM coaching from Claude)
**Status:** Draft

---

## 1. Product Vision

**Drafto** is a fast, simple note-taking web app for a small group of users who want the core Evernote experience — rich-text notes organized in notebooks — without the bloat and cost.

### One-liner

> Your notes, organized. Nothing more.

### North Star Principle

**No feature takes over screen space that should belong to your notes.** Every UI decision is measured against this: does it help the user write and find notes faster, or does it add clutter?

---

## 2. Problem Statement

Evernote is a capable note-taking tool, but:

- **It's expensive** for users who only need basic features (rich text, notebooks, search)
- **It's bloated** — the UI is crowded with features most users never touch (AI, tasks panels, integrations, widgets)
- **Your data is locked in** — migrating away is painful

Drafto solves this by providing the 20% of Evernote that covers 80% of daily use, self-hosted on free infrastructure, with full data ownership.

---

## 3. Target Users

### Primary (v1)

A small, known group: Jakub, his wife, and a few colleagues (~5-10 users).

**User profile:**

- Takes notes regularly for personal and/or work purposes
- Currently uses Evernote and finds it sufficient functionally but too expensive
- Wants: fast editor, notebook organization, access from any device
- Doesn't need: AI features, complex integrations, real-time collaboration, offline mode (yet)

### Future

If the core experience is solid, Drafto could expand to a broader audience of users who want a simpler, cheaper Evernote alternative.

---

## 4. Core Features (v1 Scope)

### 4.1 Authentication & User Management

| Requirement               | Detail                                                                                                                                                   |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Multi-user                | Each user has their own account with isolated data                                                                                                       |
| Open signup with approval | Anyone can create an account, but an admin must approve it before they can access the app                                                                |
| Auth provider             | Supabase Auth (email + password)                                                                                                                         |
| Session management        | Handled via middleware (already scaffolded)                                                                                                              |
| Approval flow             | New users see a "Waiting for approval" screen after signup. Admin approves via a simple admin view. RLS blocks unapproved users from accessing any data. |
| Password reset            | "Forgot password" email flow via Supabase Auth                                                                                                           |

**Out of scope for v1:** OAuth/social login, user roles/permissions beyond admin/user, public API.

### 4.2 Notebooks

| Requirement      | Detail                                                      |
| ---------------- | ----------------------------------------------------------- |
| Structure        | Flat list — no nesting, no stacks                           |
| CRUD             | Create, rename, delete notebooks                            |
| Default notebook | New notes go to a default "Notes" notebook if none selected |
| Notebook limits  | No hard limit, but UI optimized for ~5-20 notebooks         |
| Ownership        | Each notebook belongs to one user; no sharing in v1         |

**Out of scope for v1:** Nested notebooks, shared notebooks, notebook icons/colors.

### 4.3 Notes

| Requirement          | Detail                                                                                                                      |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Editor library       | **BlockNote** (built on TipTap/ProseMirror) — block-based editor where each line is a separate block with visual separation |
| Slash commands       | Type `/` to open a command menu for inserting block types (heading, to-do, list, etc.)                                      |
| Rich text formatting | Bold, italic, underline, strikethrough                                                                                      |
| Headings             | H1, H2, H3                                                                                                                  |
| Lists                | Bullet lists, numbered lists                                                                                                |
| Checkboxes           | To-do style checkboxes (check/uncheck)                                                                                      |
| Links                | Inline hyperlinks                                                                                                           |
| File attachments     | Upload and attach files to a note (images displayed inline, other files as download links). **Max 25MB per file.**          |
| Auto-save            | Notes save automatically as you type (debounced)                                                                            |
| Timestamps           | Created at, last modified at — visible on each note                                                                         |
| Title                | Each note has a title (first line or explicit title field)                                                                  |
| Content format       | Stored as BlockNote JSON in the database — portable, parseable, and compatible with future offline sync                     |

**Out of scope for v1:** Code blocks, tables, embedded media (video/audio), note history/versioning, markdown source editing, note templates.

### 4.4 Navigation & Organization

| Requirement        | Detail                                                                    |
| ------------------ | ------------------------------------------------------------------------- |
| Sidebar            | Left sidebar showing notebooks list                                       |
| Note list          | Selecting a notebook shows its notes in a list (sorted by last modified)  |
| Editor             | Selecting a note opens it in the main content area                        |
| Layout             | Three-panel: sidebar → note list → editor                                 |
| Move notes         | Ability to move a note from one notebook to another                       |
| Delete             | Soft delete (move to trash), with option to permanently delete or restore |
| Trash auto-cleanup | Trashed notes are permanently deleted after 30 days                       |

**Out of scope for v1:** Search, drag-and-drop reordering, pinned notes, favorites, sort options.

### 4.5 Responsive Design

| Requirement | Detail                                                                  |
| ----------- | ----------------------------------------------------------------------- |
| Desktop     | Full three-panel layout                                                 |
| Tablet      | Collapsible sidebar, two-panel (note list + editor)                     |
| Mobile      | Single-panel with navigation between views (notebooks → notes → editor) |

The app must be usable on mobile browsers from day one, even though a native app may come later.

---

## 5. Non-Functional Requirements

### 5.1 Performance

- **Note opening:** < 200ms from click to fully rendered content
- **Auto-save:** < 500ms debounce, save completes within 1s
- **Navigation:** No full-page reloads — client-side transitions between notebooks/notes
- **Initial load:** < 3s on 3G connection

### 5.2 Architecture Constraints

> **Critical:** Every architecture decision must preserve the path to offline-first and native apps (mobile + desktop) in the future.

This means:

- **Clean API layer** — all data access goes through well-defined API routes, not direct Supabase calls from components (enables swapping the backend later)
- **Separation of data and UI** — note content stored in a format that can be synced (not tied to a specific editor's internal state)
- **Portable content format** — notes stored as BlockNote JSON (ProseMirror-compatible) rather than raw HTML, enabling offline conflict resolution and cross-platform rendering
- **Stateless server** — no server-side session state beyond auth tokens; all note state lives in the database

### 5.3 Security

- Row-level security (RLS) in Supabase — users can only access their own notebooks and notes
- File uploads scoped to authenticated users with size limits
- No public access to any data without authentication

### 5.4 Data Model (High-Level)

```text
users (managed by Supabase Auth)
├── profiles
│   ├── id (uuid, fk → auth.users)
│   ├── is_approved (boolean)
│   ├── is_admin (boolean)
│   ├── display_name (text)
│   ├── created_at (timestamptz)
│   └── updated_at (timestamptz)
├── notebooks
│   ├── id (uuid)
│   ├── user_id (fk → auth.users)
│   ├── name (text)
│   ├── created_at (timestamptz)
│   └── updated_at (timestamptz)
└── notes
    ├── id (uuid)
    ├── notebook_id (fk → notebooks)
    ├── user_id (fk → auth.users)
    ├── title (text)
    ├── content (jsonb — editor JSON format)
    ├── is_trashed (boolean)
    ├── created_at (timestamptz)
    └── updated_at (timestamptz)

attachments
├── id (uuid)
├── note_id (fk → notes)
├── user_id (fk → auth.users)
├── file_name (text)
├── file_path (text — Supabase Storage path)
├── file_size (bigint)
├── mime_type (text)
├── created_at (timestamptz)
```

### 5.5 Deployment

| Component       | Service          | Tier            |
| --------------- | ---------------- | --------------- |
| Frontend + API  | Vercel           | Free / Hobby    |
| Database + Auth | Supabase         | Free tier       |
| File storage    | Supabase Storage | Free tier (1GB) |

---

## 6. User Flows (v1)

### 6.1 First-Time User

1. Visits drafto.eu and clicks "Sign up"
2. Creates account (email + password)
3. Sees "Waiting for approval" screen
4. Admin approves the account
5. On next visit, lands on app with a default "Notes" notebook
6. Creates their first note

### 6.2 Daily Usage

1. Opens drafto.eu → sees their notebooks in sidebar
2. Clicks a notebook → sees note list sorted by last modified
3. Clicks a note → edits in rich-text editor
4. Note auto-saves as they type
5. Creates new notes via a "+" button
6. Organizes by creating notebooks and moving notes between them

### 6.3 Cleanup

1. Deletes a note → moves to Trash
2. Opens Trash → restores or permanently deletes

---

## 7. What v1 Is NOT

To keep scope tight, these are **explicitly excluded** from v1:

- **Search** — will be one of the first post-v1 features
- **Sharing / collaboration** — each user's notes are private
- **Offline mode** — requires online connection
- **Native apps** — web-only (but architecture supports future native apps)
- **Import from Evernote** — manual migration for now (future feature)
- **AI features** — no summarization, smart search, etc.
- **Real-time collaboration** — no simultaneous editing
- **API for third parties** — internal use only
- **Note history / versioning** — no undo beyond the editor's built-in undo

---

## 8. Future Roadmap (Post-v1, Unordered)

These are potential future features, **not commitments**. Priority will be determined by actual usage.

| Feature            | Notes                                                       |
| ------------------ | ----------------------------------------------------------- |
| Full-text search   | Search across all notes and notebooks                       |
| Evernote import    | Import .enex files to migrate existing notes                |
| Offline mode       | Service worker + local DB for offline read/write with sync  |
| Native mobile app  | React Native or similar, sharing the same API               |
| Native desktop app | Electron/Tauri wrapper or similar                           |
| Sharing            | Share individual notes or notebooks with other Drafto users |
| Tags               | Optional tagging system alongside notebooks                 |
| Note templates     | Pre-defined templates for common note types                 |
| Dark mode          | System-aware dark/light theme                               |
| Web clipper        | Browser extension to save web pages as notes                |
| OAuth login        | Sign in with Google/GitHub                                  |

---

## 9. Success Metrics

Since this is a personal tool for a small group, success is simple:

1. **You and your wife stop using Evernote** — Drafto becomes the daily driver
2. **Zero data loss** — auto-save works reliably, no notes disappear
3. **< 5 seconds to start writing** — from opening the app to typing in a note
4. **Colleagues voluntarily adopt it** — they choose to use it without being pushed

---

## 10. Decisions Log

Decisions made during PRD creation:

| Decision     | Choice                                  | Rationale                                                                                                                                                                               |
| ------------ | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backend      | Supabase Cloud                          | Already scaffolded, standard Postgres (no lock-in), auth+DB+storage in one. Evaluated Firebase (more generous free tier but proprietary NoSQL lock-in) and self-hosted (more ops work). |
| Editor       | BlockNote                               | Block-based by default, slash commands built-in, JSON storage, ProseMirror foundation. Matches the desired Evernote-like block editing UX.                                              |
| File limit   | 25MB per file                           | Generous enough for PDFs and images. ~40 files before hitting 1GB free tier.                                                                                                            |
| Signup model | Open signup + admin approval            | Anyone can register, but admin must approve before they can use the app. Balances openness with cost control on free tier.                                                              |
| Trash policy | Auto-delete after 30 days               | Matches Evernote/Gmail behavior. Prevents trash buildup.                                                                                                                                |
| Deployment   | Vercel (app) + Supabase Cloud (backend) | Both free tier. Upgrade Supabase to Pro ($25/mo) when storage runs out.                                                                                                                 |

## 11. Further Backlog

Ideas surfaced during PRD creation that didn't make v1 but should be considered early:

| Idea                             | Why it matters                                                                                                                        | Priority suggestion                          |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Basic search (at least by title) | Without search, finding notes requires scrolling. Users with 50+ notes will feel the pain quickly.                                    | High — first post-v1 feature                 |
| Dark mode (system-aware)         | Mobile users at night, user preference. Small lift with Tailwind.                                                                     | Medium                                       |
| Keyboard shortcuts               | Power users (especially ex-Evernote) expect Ctrl+B, Ctrl+K, etc. BlockNote provides some by default.                                  | Medium                                       |
| Note pinning                     | Pin frequently accessed notes to the top of a notebook.                                                                               | Low                                          |
| Note sorting                     | Sort notes by title, created date, or modified date.                                                                                  | Low                                          |
| Drag-and-drop                    | Reorder notes, drag notes between notebooks.                                                                                          | Low                                          |
| Evernote import (.enex)          | Critical for migration but can be done manually for a small group initially.                                                          | Medium (when expanding beyond initial group) |
| Notebook sharing                 | Share a notebook with other Drafto users (read-only or read-write). Enables couples/teams to collaborate on shared lists, plans, etc. | Medium                                       |

## 12. Open Questions

_None remaining — all resolved during PRD creation._
