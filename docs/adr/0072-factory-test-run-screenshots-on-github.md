# 0072 — Factory Test-Run Screenshots on GitHub

- **Status**: Accepted
- **Date**: 2026-11-10
- **Authors**: Jakub Anderwald, Claude

## Context

The browser runner ([ADR-0051](./0051-factory-browser-runner.md)) takes a screenshot at each step's expected result, and its report refers to them as "screenshot 1", "screenshot 2", and so on. The In Test report then says "Screenshots stay on the Mac mini (this repo is public)" and gives a local path. The verification report ([ADR-0053](./0053-pre-in-test-verification-stage.md)) does the same for its Web lane: "Local evidence stays on the Mac mini". ADR-0051 recorded this as a consequence: "Screenshots stay on the Mac mini. The repo is public, so they are never attached to GitHub."

The person at Testing or In Test reads the report on GitHub, often on a phone. They can't open `logs/factory/browser/` on the Mac mini, so a row whose evidence is "screenshot 3 shows the toast" can't be checked. The macOS harness ([ADR-0043](./0043-automated-macos-in-test-scenarios.md)) has the same gap: it captures the window at every step into `shots/`, and those files exist only on the Mac mini.

Forces at play:

- **GitHub has no attachment API.** The drag-and-drop upload in the web UI (`user-attachments`) needs a signed-in browser session. No REST or GraphQL endpoint takes an image for a comment.
- **The repo is public.** Whatever is published can be read by anyone, and can't be fully taken back.
- **Pixels bypass the text scan.** Every report is scanned for secrets before it's posted. A screenshot is an image, which that scan never reads.
- **The runner keeps its limits.** It has no files and no `gh`, and no Bash except for [ADR-0073](./0073-factory-verification-data-checks-live-tests-uploads-admin-js.md)'s `dev-inspect`, and only bash posts (ADR-0051). Publishing has to happen in the factory's own code, after the run.
- **Cost discipline.** No new service and no new monthly cost.

The guard already gives the browser runner's screenshots provenance. When the runner's `computer` tool saves a screenshot, the guard copies it into the run's evidence directory and logs the copy in its decision log, `logs/factory/browser-guard/<session>.jsonl`.

## Decision

Publish a test run's screenshots as git objects in this repo, and embed them in the run's report comment. Implementation: `scripts/lib/evidence-images.mjs` (what may be published), `scripts/lib/evidence-upload.mjs` (publishing and the selftest), `scripts/lib/evidence-embed.mjs` (the Markdown), `scripts/lib/evidence-post.mjs` (the macOS operator command), and the `evidence_*`, `browser_publish_screenshots` and `verify_publish_screenshots` functions in `scripts/factory-agent.sh`.

1. **Hosting: one parentless commit per run, on a ref that isn't a branch or a tag.**
   - The ref is `refs/factory-evidence/<issue>/<sha12>/<run-id>`, where `<sha12>` is the head commit the run tested. The commit holds only `<issue>/<sha12>/<run-id>/NN.png` (or `.jpg`).
   - A ref outside `refs/heads` and `refs/tags` isn't in the default fetch refspec, so a normal clone, a fetch and a CI checkout never download it. No workflow triggers on it: `ci.yml`'s only push trigger is `branches: [main]`. Vercel's Git integration builds pushed branches; the selftest (decision 4) checks on the real repo that it ignores this ref.
   - The comment shows each image as `<img width="480">` from `https://raw.githubusercontent.com/JakubAnderwald/drafto/<evidence-commit>/<path>`. The URL is pinned to the evidence commit, never a branch tip, so a later push can't change what a report shows.
   - The commit is built with git plumbing on a temp index (`hash-object --no-filters`, `update-index`, `write-tree`, `commit-tree`), like ADR-0071's probe commit. Nothing is checked out, no hook or `.gitattributes` filter runs, and the message is fixed: `chore(factory): test-run screenshots for #<n> (evidence, not for merge)`.
   - It's pushed with hooks off and a create-only lease (`--force-with-lease=<ref>:`), plan-probe.mjs's `pushRef`. So a ref that exists is never overwritten.
   - **The ref name is the idempotency key.** A retry for the same issue, head and run reuses the run's `upload.json`, or the commit already on the ref, and never pushes twice. If two pushes race, only a commit that is on the ref counts.
   - It runs in the factory's own node, after the runner has exited and after the report's secret scan. Never inside a claude session.

2. **What is published, and what never is.**
   - **The `intest` kind's report.** Each image goes under the result-table row that mentions it: image k is the runner's "screenshot k". A step with one image shows it inline; a step with several gets a collapsed `<details>`. Images no row mentions go under "Other screenshots".
   - **The verification report's Web lane.** The browser lane's screenshots go inside that lane's `<details>`, under their steps, and are never cut when the lane's text is truncated. Only a lane that reported shows any. The renderer is keyed by lane, so a device lane can add its own later; ADR-0053 decision 8 still defers those lanes. The `verify` kind publishes nothing at run time. Its screenshots are published when the verification report is composed.
   - **macOS harness runs, only by the operator.** `node scripts/lib/evidence-post.mjs macos --run-dir <dir> --issue <n>` lists what it would publish. Only `--yes` publishes and posts one comment (`<!-- drafto-factory-macos-run-report -->`). The factory never runs it.
   - **Never the shell lane's output.** That lane is a claude session with Bash. It can write any bytes into its run directory, so nothing there has provenance.
   - **Never the `plan` kind's.** The probe report keeps its screenshots on the Mac mini, as ADR-0071 says.

3. **The checks, for every image** (`evidence-images.mjs`):
   - **Provenance.** A browser run's candidates are exactly the files the guard copied into the run's evidence directory, in the order its decision log recorded them. `run_browser_task` writes the session id to the run directory (`session-id`), and bash finds the log from it. A copy the guard rejected or failed keeps its slot, so image k is still "screenshot k". The manifest is the guard's existing decision log, read after the run. The guard's only change is one field on each copy, `onOrigin`: whether the screenshotted tab was one of the session's own, on the preview's exact origin, by that call's own Tab Context. A copy without `onOrigin: true` (a neutral page such as the new-tab page, a page off the preview, or a log from before the field), and every copy logged in a call that also quarantined, lost or found ambiguous a tab, keeps its slot but is never published. A macOS run's candidates are its `shots/NN-<label>.png`. Nothing else in either directory is considered.
   - **The file.** Not a symlink. Its real path is strictly inside the evidence directory, which isn't a symlink either. A regular file, opened with `O_NOFOLLOW`, with the same device and inode as before the open. Not empty, and at most 5 MB. A `.png`, `.jpg` or `.jpeg` whose first bytes match the type. The bytes read here are the bytes scanned and the bytes pushed.
   - **An OCR secret scan.** Each image's text is read with the Vision helper from the macOS harness (`apps/desktop/e2e/in-test/lib/ocr.swift`, compiled with `swiftc` into `logs/factory/bin/ocr`). It's scanned with the report's secret patterns plus the test account's password. A hit keeps that image on the Mac mini. Without the helper, nothing is published.
   - **A per-comment cap.** At most 20 images and 20 MB per comment, in slot order. An image over the cap, one that fails a check, or one the guard's log holds back (a rejected, failed or off-preview copy) is listed under "Kept on the Mac mini" with its local path and why. A scan hit names the pattern, never the matched text.
   - **A withheld report withholds its images.** When the secret scan withholds a report, or the verification report's Web lane, or the composed body, nothing is uploaded. A render result that can't be read counts as withheld.
   - **What is rendered.** Only a `raw.githubusercontent.com` URL of this repo, pinned to the upload record's own commit, is ever put in a comment. Step labels come from model output, so they're capped and escaped, and the `drafto-factory` token is broken so a label can't spell a marker.

4. **A selftest gates it, and a switch turns it off.** `FACTORY_EVIDENCE_UPLOAD` is `1` by default. `0`, or any value other than `0` or `1`, keeps every screenshot on the Mac mini. Even with it on, nothing is published until the operator's one-time `evidence-upload.mjs selftest` has passed on the real repo. The selftest checks three things:
   - GitHub accepted a push to a `refs/factory-evidence/` ref;
   - `raw.githubusercontent.com` served the test image to a request with no credentials, with an `image/*` content type and the same bytes;
   - the Deployments API shows no Vercel deployment for the commit.

   Its record is `logs/factory/evidence-selftest.json`. A deployment check GitHub couldn't answer fails closed. A re-check a few minutes later (`--status 1`) turns it on once it sees no deployment, and off for good if one has appeared.

5. **The prompt's rule 7 changes.** It used to be "Screenshots stay on disk". It now says screenshots may be published with the report, so the runner must never take one while the page shows a secret: a newly created API key, a token, a sign-in link, or anything else rule 9 keeps out of the report. It must always save them to disk, number them in the order taken, and refer to them in the step's Evidence cell. It still never names a path or pastes an image into the report.

6. **A failure is a reason, never a block.** If anything stops the upload (the switch, the selftest, the helper, the account file, the push, GitHub), the report is posted as before, with "Screenshots stay on the Mac mini" and the reason. A failed upload never moves a card, never spends an attempt and never holds a report back.

## Consequences

- **Positive**:
  - The person at Testing or In Test sees each step's screenshot next to its row, without logging in to the Mac mini.
  - No new service or cost. GitHub already hosts the repo and its comments.
  - Pinned URLs mean a report shows the same images forever. A later push can't swap them.
  - A macOS harness run can be posted the same way with one command, after a look at what it would publish.
- **Negative**:
  - **Pixels bypass the text scan.** Four defences cover this, and none is complete on its own:
    - _Provenance._ Only files the guard copied are candidates. The guard lets the runner act only on its own tabs, and navigate only to the preview's exact origin. A tab that drifts off it is quarantined and can only be closed or navigated back. A click's navigation can show up one call late, so that one call can be a screenshot of the new page. Its response reports where the tab really was, so the guard logs that copy as off the preview (`onOrigin: false`, usually with a `quarantined` event), and it is never published. A `computer` screenshot is the page's viewport, so the omnibox, where the one-time sign-in link was opened, is never in one.
    - _The OCR scan._ It's partial. OCR can misread a character, and a `dk_` key of 48 hex characters with one misread character no longer matches the pattern.
    - _A withheld report withholds its images._
    - _Prompt rule 7._ The runner is told not to take a screenshot while a secret is on the page.
  - **What could still leak.** A `dk_` API key on the dev project that a scenario created and the OCR misread. The dev test account's email, which the report already names and the scan doesn't count as a secret. Both belong to the dev project. A browser run targets only a preview backed by dev Supabase, never `drafto.eu`. The profile is signed in to production, but a screenshot the guard didn't see taken on the preview is never published.
  - **A takedown doesn't unpublish.** Deleting the ref and editing the comment remove the link. But raw.githubusercontent.com keeps serving a commit whose SHA is known until GitHub garbage-collects it, and GitHub's image proxy (camo) caches the image. Only GitHub Support can purge it sooner. So the remedy for a leaked credential is to rotate it: revoke the key, or change the test account's password. Deleting is tidying up, not a fix.
  - **macOS shots are production.** The harness runs against production with a throwaway account. A run begins by signing the operator's own account out, so an early shot can show the operator's own notes. That's why a macOS post is never automatic. `evidence-post.mjs` lists the files and stops, and publishes only with `--yes`. It also refuses in an unattended session (`DRAFTO_UNATTENDED=1`), while the run's `state.env` exists, when `report.md` has no `Run:` line, when the report matches a secret pattern, and when the run was already posted.
  - **Storage.** About 2–5 MB per run, in the repo's object store. Normal clones and CI checkouts never fetch it, but `git clone --mirror` fetches every ref, and so every image. Pruning old refs is out of scope for now.
  - The OCR helper needs `swiftc` on the Mac mini. It's compiled on first use, with a 300-second cap, and again when `ocr.swift` changes.
- **Neutral**:
  - This supersedes ADR-0051's consequence "Screenshots stay on the Mac mini. The repo is public, so they are never attached to GitHub", and nothing else in it. The runner, its tools and `--no-chrome` / `--strict-mcp-config` everywhere else are unchanged. The guard decides exactly as before; it only logs `onOrigin` with each copy. ADR-0053's "Evidence stays on the Mac mini" now has one exception, the Web lane's screenshots. The shell lane's evidence still stays.
  - **Privacy policy: no change.** A published browser screenshot shows only the dedicated dev test account on dev data. A macOS shot shows a throwaway production account, and is published only after the operator has looked at it. No real user's data is published, so this adds no way for a user's data to leave Drafto. GitHub already hosts the repo and its comments, so no new processor receives anything.
  - No migration, no hosted Supabase config, and no change to the apps.

## Alternatives Considered

- **An orphan `factory-evidence` branch.** Simpler to look at in the GitHub UI. But Vercel builds any pushed branch (ADR-0071 measured it for a branch with no PR), so every upload would start a deployment. Every clone and fetch would also download every image, because branches are in the default refspec.
- **A tag prefix, `refs/tags/factory-evidence/…`.** It isn't a branch, but every evidence tag would be listed on the repo's Tags page, and `git fetch --tags` downloads them all. This is the fallback if GitHub rejects the custom namespace. It's one constant, `EVIDENCE_REF_PREFIX` in `evidence-upload.mjs`, and switching is the operator's call. The selftest would then have to pass again on the new prefix.
- **GitHub's own `user-attachments` upload.** That's what a drag and drop into a comment does. It has no API and needs a signed-in browser session. The runner would have to do it, which needs the file chooser (`file_upload` is denied) and a signed-in GitHub tab off the preview's origin. Both break ADR-0051.
- **An external image host** (an image-sharing site, S3, Vercel Blob…). It would be a new processor to list in the privacy policy and another credential on the Mac mini, and often a paid or rate-limited tier. That goes against the cost discipline.
- **Keep them on the Mac mini (status quo).** Nothing can leak, but the person who approves the card still can't see them.
