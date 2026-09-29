Run a single scoped workstream against this repo, following `CLAUDE.md` throughout.

**Objective**: {{objective}}
**Acceptance criteria**: {{acceptance_criteria}}
**In scope**: {{in_scope}}
**Out of scope**: {{out_of_scope}}
**Allowed actions**: {{allowed_actions}}
**Required stopping point**: {{stopping_point}}

Steps:

1. Read `CLAUDE.md` and `CURRENT_WORK.md`.
2. Restate the requested outcome in one sentence.
3. State: acceptance criteria, risk tier (per `CLAUDE.md`) with a one-line reason, the files/surfaces to inspect, allowed external actions, and the stopping point.
4. Inspect the complete relevant surface before editing.
5. Implement the entire scoped batch — do not split it into piecemeal edits or check-ins.
6. Run the tests required by the risk tier, as defined in `CLAUDE.md`.
7. Review the full scoped diff once; if issues remain, correct them in one consolidated pass, then do one final review.
8. Update `CURRENT_WORK.md` if the workstream's state materially changed.
9. Return the response in the fixed format from `CLAUDE.md` (Outcome / Files changed / Verification / Risks or unresolved items / Current git/action status and exact stopping point).

When a placeholder above is left blank or ambiguous, state the safe assumption you're using and proceed — do not stop to ask unless the missing information is genuinely blocking (e.g. a required credential, an authorization only the user can give, or a real ambiguity between two materially different scopes).
