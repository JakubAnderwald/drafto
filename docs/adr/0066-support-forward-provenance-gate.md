# 0066 — Support Forwards Need an Allowlisted Marker

- **Status**: Accepted
- **Date**: 2026-11-01
- **Authors**: Jakub Anderwald, with Claude Code (dark factory, issue #469)

## Context

The dark factory turns issue comments into work. In **Plan Review**, a new comment replans the card in place. In **In Test**, a comment rolls the card back to **In Progress**, and the comment becomes `revisionComments` for an implementer run under `--dangerously-skip-permissions`. In **Testing**, it cuts verification short. In In Test, it also stops a beta from being dispatched. Two detectors in `scripts/factory-agent.sh` decide which comments count, and both checked only `authorAssociation == "OWNER"`: `unacked_owner_comments` (the replan sweep) and `owner_comments_since` (the revision pickup, the In Test sweep and `has_actionable_feedback`).

`OWNER` doesn't prove the operator wrote a comment. When a customer replies on a support thread that's already linked to an issue, step 4.5 of `scripts/support-agent-prompt.md` posts the reply on that issue. It posts under the Mac mini's `gh` identity, so the comment is `OWNER` too, whoever sent the email. The code comments presented this as intended ("the email-replan path still works without a separate check"). In practice, anyone who could reply to a linked support thread could replan a card, or roll an In Test card back and have their text handed to the implementer. `SUPPORT_ALLOWLIST` reached the bundles only as data (`config.allowlist`), and nothing in bash enforced it on these transitions. Only the final merge and ship were gated.

The two sides of a forward don't share a process. The support agent runs from the primary checkout (`/Users/jakub/code/drafto`), where `logs/support-state.json` lives. The factory runs from its own volume ([ADR-0060](./0060-dedicated-factory-build-volume.md)), which has no support state. The comment itself is the only channel between them.

## Decision

**A forward carries a provenance marker, and the factory gates every trigger on it.**

1. **The marker.** Step 4.5 writes each forward as the bold `**Customer replied via support@drafto.eu:**` line, then `<!-- drafto-support-forward sender:<email> -->` on its own unquoted line, then the customer's text with every line `> `-quoted, blank lines included. `<email>` is the bare, lower-cased address from the latest message's `fromAddress`, never from the text. The body still starts with the bold prefix that the implementer prompt's "forwarded customer text never triggers a run" rule keys on.

2. **The gate.** The two detectors filter `OWNER` comments as before. Their result then goes through `gate_support_forwards`, which runs `support_forward_filter`, a pure jq pass, and logs each comment it drops. Gating inside the detectors, not at each call site, covers every path that reads them: the replan sweep, the revision pickup, the In Test sweep and its pre-beta check, and the Testing sweep. A comment is a **forward** if it mentions `drafto-support-forward` or `Customer replied via support@` anywhere, in any case. A forward is kept only if all of these hold:
   - exactly one line not starting with `>` mentions `drafto-support-forward`, and that line is the whole marker with an address in it;
   - the address is in `SUPPORT_ALLOWLIST`;
   - the issue's `reporterEmail` in the support state is empty or allowlisted too. This is the defense-in-depth check that [ADR-0025](./0025-support-allowlist-from-zoho-sender.md) makes the trust anchor for support issues. The factory reads it with `state-cli.mjs get-reporter-email <issue> --state-file "$SUPPORT_STATE_FILE"`. That file defaults to the primary checkout's `logs/support-state.json` and can be overridden with `DRAFTO_SUPPORT_STATE_FILE`. A leading `~/` in the override is expanded, because a launchd plist doesn't expand it.

   Everything else is denied: no marker, a marker only inside the quote, a malformed marker, two markers, or a non-allowlisted sender or reporter. A comment that isn't a forward passes through unchanged, so the operator's own board comments work exactly as before.

3. **Logging.** Each dropped comment gets one line in the factory log, with its id and the reason, once per daily log file. The detectors run on every tick, so a forward that stays dropped would otherwise repeat until it filled the log tail that the failure notice posts. A new comment, or a new reason for an old one, is logged straight away. The line never includes the body or the sender: the failure notice posts the log's tail to a public issue. The support state is read only when a comment looks like a forward, so an ordinary tick costs nothing extra. If the state can't be read, the gate logs a warning, also once per daily log file, and checks the marker alone, which still denies a forward by default.

4. **Forwarding is unchanged.** Every customer reply still reaches the issue for anyone to read. The planner bundle's `comments` still carry it as context, the implementer bundle still picks up its screenshots, and the implementer can still read the whole thread. Only the factory's decision to act on it is gated: a dropped forward is never `revisionComments` or a replan trigger.

## Consequences

- **Positive**: A stranger who replies to a support thread can no longer replan a card, roll back an In Test card, cut verification short, hold back a beta, or have their text handed to the implementer as a change request. An allowlisted reporter's email reply still works as before. The check is in bash, so a model's reading of `config.allowlist` no longer decides anything here.
- **Positive**: Deny by default. A forward the agent wrote without a marker, from before this change or by mistake, is ignored, not trusted.
- **Negative**: The marker comes from an email `From` header, written down by a model. A spoofed `From`, or a prompt injection that gets the agent to write an unquoted allowlisted marker, still passes on a card with no recorded reporter, such as one created on the board. The recorded-reporter check blocks both on issues a customer filed. This closes the unauthenticated-stranger path, not spoofing. Two follow-ups are out of this change's scope: checking DMARC / `Authentication-Results`, and having `support-agent.sh` write the marker from the bundle's sender instead of the model.
- **Negative**: The operator's own comment is dropped if it quotes a forward, that is if it contains `drafto-support-forward` or `Customer replied via support@`. The log line shows why. Paraphrase instead.
- **Negative**: Until the updated prompt reaches the primary checkout, forwards from allowlisted reporters carry no marker and are ignored. This fails safe.
- **Negative**: The gate recognises a forward only by the prefix or the marker, both of which the model writes. If the agent posts customer-influenced text with neither, the gate treats it as an ordinary `OWNER` comment, so it skips the marker check and the recorded-reporter check. This change doesn't close that gap. Having `support-agent.sh` compose the whole forward instead of the model is a follow-up outside this change's scope.
- **Neutral**: A dropped forward in Plan Review is never acked, so the gate drops it again on every tick while the card waits. It logs the drop once a day and never writes anything on GitHub.

## Alternatives Considered

- **Gate in `fetch_issue_comments`.** This would also hide forwards from the planner bundle's comments and the implementer bundle's screenshot sources, where they're useful context, and from the marker and idempotency checks that read the same list. Rejected.
- **Gate each call site.** There are five call sites, plus `has_actionable_feedback`, and a future sixth would forget. Gating in the two detectors covers every caller. Rejected.
- **Stop forwarding non-allowlisted replies.** Customers' follow-ups are legitimate context for the operator and for comment-sync. The problem is the factory treating them as instructions, not that they're visible. Out of scope, and rejected.
- **Trust the sender from the bundle's support state alone.** `reporterEmail` names who filed the issue, not who sent a later reply. Board-created cards have no entry at all. The state is a cross-check, not the gate.
