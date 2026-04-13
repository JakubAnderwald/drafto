---
name: SDLC improvements from desktop crash debugging session
description: Process improvements identified after 15+ TestFlight builds to fix macOS crash, data corruption, and review workflow issues
type: feedback
originSessionId: 2a82f59e-25b4-424a-93ef-3afd37541c07
---

Branch early, not late: don't accumulate changes on main even when iterating on a live bug. Create the branch before the first code change, not after 15 builds.
**Why:** This session had 15+ TestFlight builds from uncommitted changes on main, making the eventual commit/PR messy.
**How to apply:** At the start of any code change — even "quick fixes" — immediately create a branch. The CLAUDE.md worktree requirement exists for good reason.

Disable auto-save when adding a new content format bridge: if the load path for a new format isn't verified, auto-save can corrupt data by writing the wrong format back.
**Why:** Desktop auto-save wrote TipTap format to a DB expecting BlockNote, corrupting the user's note. The note had to be manually recovered.
**How to apply:** When implementing format conversion between editor formats, wire up and verify the SAVE path BEFORE the LOAD path. Or disable auto-save until both directions are confirmed working.

Fix local debug launch before iterating via TestFlight: each TestFlight round-trip costs ~6 minutes. Fixing the local launch issue first would have saved hours.
**Why:** macOS sandbox prevented local debug builds from launching. Every iteration required a full Fastlane build + TestFlight upload.
**How to apply:** Prioritize fixing `codesign -s -` / sandbox issues for local testing before doing remote builds.

Use pnpm patch instead of build-time monkey-patching: patching node_modules via Podfile/Fastfile is fragile and hard to verify.
**Why:** The RCTThirdPartyComponentsProvider nil crash required patching 19+ copies of a codegen template across node_modules at build time.
**How to apply:** For durable fixes to node_modules, use `pnpm patch <package>` which creates a tracked .patch file. Build-time patches should be last resort.

Always reply to reviewer follow-ups, not just top-level comments: review bots post follow-up replies that need acknowledgment before threads can be resolved.
**Why:** CodeRabbit replied to all 6 of our replies with follow-ups. The /push skill missed these because it only checked top-level comments.
**How to apply:** Updated /push skill to check for threads where a reviewer spoke last, and to explicitly resolve threads via GraphQL.
