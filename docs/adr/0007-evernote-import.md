# 0007 — Evernote Import

- **Status**: Accepted
- **Date**: 2026-03-04
- **Authors**: Jakub Anderwald

## Context

Users migrating from Evernote need a way to import their existing notes into Drafto. Evernote exports notes as `.enex` files — an XML format containing notes with ENML (Evernote Markup Language) content, metadata, and base64-encoded attachments.

Key constraints:

- Vercel has a 4.5MB request body limit, making single-request upload of large `.enex` files impossible
- ENML is a non-standard HTML dialect with custom tags (`<en-note>`, `<en-todo>`, `<en-media>`) that must be converted to BlockNote blocks
- Server-side DOM parsing is needed for ENML conversion, but `jsdom` (already a devDependency) is too heavy for production Edge/Serverless runtime

## Decision

We implement a client-side parsing + batched API approach:

1. **Client-side XML parsing**: The browser's native `DOMParser` parses the `.enex` XML, extracting notes and their base64-encoded attachments
2. **Batched API calls**: Notes are sent in batches of up to 5 to `POST /api/import/evernote`, staying within Vercel's body size limit and enabling progress feedback
3. **Server-side ENML conversion**: `linkedom` (~40KB, lightweight server-side DOM parser) converts ENML to BlockNote blocks on the server
4. **Partial failure tolerance**: Failed notes within a batch are skipped with errors reported; the import continues with remaining notes
5. **App menu**: A new app menu (dropdown in sidebar footer) houses the "Import from Evernote" action alongside "Log out" and theme toggle, replacing the standalone ThemeToggle

## Consequences

- **Positive**: Users can migrate from Evernote with full content and attachment preservation; batching enables progress UI and avoids body size limits; `linkedom` adds minimal bundle weight
- **Negative**: Large imports (hundreds of notes) may take time due to sequential batch processing; ENML conversion is best-effort — complex formatting or unusual ENML tags may lose fidelity
- **Neutral**: The app menu pattern establishes a location for future settings and actions

## Alternatives Considered

1. **Single-request upload with file streaming**: Would exceed Vercel body limits for large exports; no progress feedback possible
2. **Client-side ENML conversion**: Would require bundling a DOM parser in the client; BlockNote block construction is better suited to server-side processing
3. **jsdom for ENML parsing**: Already a devDependency but ~2MB, too heavy for production serverless; `linkedom` achieves the same with ~40KB
4. **Drag-and-drop upload to storage first**: Adds complexity (storage as staging area, background processing) without clear benefit for the expected import sizes
