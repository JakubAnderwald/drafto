# Support-email fixtures

Captured Zoho message JSON used for golden-run dry tests of the support agent.

## Format

Each `*.json` file is a JSON array shaped like the response of
`zoho-cli.mjs list-pending`. The array contains one or more thread entries.
Each entry MUST include:

- `threadId` — string, the Zoho thread identifier.
- `subject` — string.
- `from` / `fromAddress` — string, the customer email.
- `messages[]` — array of message objects (Zoho's nested message format).
- `headers` — object, parsed headers of the most recent message.
- `labels` — array (empty for a fresh inbound).

Each fixture has an adjacent `*.expected.json` describing the agent's expected
classification and action. Used by future Phase D–E test harnesses; not yet
asserted by Phase A's `support-agent.sh --dry-run`.

## Coverage

This is a starter set of 5 fixtures covering each intent category. The plan
calls for a fuller corpus (10 bugs, 5 features, 3 questions, 2 spam) once the
classifier is being tuned in Phase E. Add new fixtures as you encounter real
support email patterns that the agent should handle deterministically.

| File                             | Intent   | Notes                                                         |
| -------------------------------- | -------- | ------------------------------------------------------------- |
| `01-bug-pdf-export.json`         | bug      | Public sender; clear repro.                                   |
| `02-bug-sync-conflict.json`      | bug      | Allowlisted sender; should produce the "nightly agent" reply. |
| `03-feature-dark-mode.json`      | feature  | Public sender; vague request.                                 |
| `04-question-mobile-import.json` | question | Answerable from `docs/`.                                      |
| `05-spam-crypto.json`            | spam     | Should be moved to `Drafto/Support/Spam`.                     |

## Replaying

```bash
scripts/support-agent.sh --dry-run --fixture scripts/__fixtures__/support-emails/01-bug-pdf-export.json
```

The script prints the context bundle that would have been passed to Claude.
In Phase D+ the same command will additionally invoke Claude in a sandbox and
compare its action against `*.expected.json`.
