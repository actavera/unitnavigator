# CLAUDE.md — Unit Navigator efficiency rules

## Work execution

- Inspect the complete relevant surface before editing.
- Establish scope, acceptance criteria, risk tier, allowed actions, and stopping point once, up front.
- Batch related edits instead of presenting or fixing them one at a time.
- Keep narration minimal; report only decisions, blockers, material discoveries, and final results.
- Do not repeatedly inspect unchanged files or rerun successful checks without a concrete reason.
- Never stage, commit, push, merge, deploy, contact providers, or mutate production unless the current instruction explicitly authorizes that action.
- Preserve unrelated working-tree changes.

## Risk-based testing

Three tiers, defined by impact — **not** by line count or diff size:

- **Low risk**: documentation, comments, non-executable workflow files. Run syntax/format/link checks applicable to the changed files; no full suite unless behavior could be affected.
- **Medium risk**: isolated UI behavior, ordinary business logic, scripts, migrations, or provider scaffolding that does not alter authentication, tenancy, uploads, network security, or production data handling. Run focused tests during implementation and one full suite at the final checkpoint.
- **High risk**: authentication/authorization, multi-tenant isolation, uploads/path handling, SSRF/network boundaries, secrets, database integrity, destructive cleanup, signing/provider requests, deployment configuration, or production migrations. Run focused tests after the completed edit batch, then one full suite at the final checkpoint. Add targeted regression tests for the failure mode. Repeat suites only to investigate instability or verify a previously-failing test.

Change size does not determine risk. A one-line change to auth or tenancy logic is high risk; a large documentation rewrite is low risk.

## Review gate

Before handing work back:

- Review the entire scoped diff once.
- Check for accidental files, secrets, generated artifacts, database/PDF files, and unrelated changes.
- Confirm acceptance criteria and the declared stopping point were met.
- Return one consolidated correction list if problems remain — do not drip-feed issues one at a time.
- After correcting that list, perform one final review and the tests required by the risk tier.
- Do not create artificial revert-and-restore demonstrations unless specifically requested or necessary to prove a subtle regression test.

## Response format

Every completed workstream ends with this compact format, and nothing else:

1. Outcome
2. Files changed
3. Verification
4. Risks or unresolved items
5. Current git/action status and exact stopping point

No chronological play-by-play, no repeated code excerpts, no repeated diff summaries, no commentary about every command run.

## CURRENT_WORK.md

Update `CURRENT_WORK.md` whenever a workstream materially changes state (checkpoint reached, blocked, branch changed, next action changes). Keep it short — it replaces stale state, it does not accumulate a diary. It must never contain secrets, customer data, signing links, credentials, or temporary tokens.
