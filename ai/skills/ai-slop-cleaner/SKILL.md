---
name: ai-slop-cleaner
description: Cleans AI-generated code slop with a regression-safe, deletion-first workflow. Use when the carbon unit says deslop, anti-slop, or AI slop, or asks to clean up code that feels bloated, repetitive, over-abstracted, or weakly tested. Bounded cleanup, not feature work.
---

# AI Slop Cleaner

Clean AI-generated code slop without drifting scope or changing intended behavior. This is the bounded cleanup workflow for code that works but feels bloated, repetitive, weakly tested, or over-abstracted.

## When to Use

- The carbon unit explicitly says `deslop`, `anti-slop`, or `AI slop`
- The request is to clean up or refactor code that feels noisy, repetitive, or overly abstract
- Follow-up implementation left duplicate logic, dead code, wrapper layers, boundary leaks, or weak regression coverage
- The goal is simplification and cleanup, not new feature delivery

## When Not to Use

- The task is mainly a new feature build or product change
- The carbon unit wants a broad redesign instead of an incremental cleanup pass
- The request is a generic refactor with no simplification or anti-slop intent
- Behavior is too unclear to protect with tests or a concrete verification plan

## Execution Posture

- Preserve behavior unless the carbon unit explicitly asks for behavior changes.
- Lock behavior by running the existing tests and the code path; write a new test only as a regression test for a bug actually fixed or for an uncovered contract whose break would be silent.
- Prefer deletion over addition.
- Reuse existing utilities and patterns before introducing new ones.
- Add new dependencies only when the carbon unit explicitly requests them.
- Keep diffs small, reversible, and smell-focused.

## From /commit

Clean only the files /commit passes (preflight's `paths`). Edit existing files only, including tests; run existing tests only. Limit naming, error-handling cleanup, and low-value test removal to lines already changed. Return to `/commit` for review.

## Scoped File-List Usage

The pass can be bounded to an explicit file list or changed-file scope when the caller already knows the safe cleanup surface (for example, the files changed in the current commit).

- Good fit: `/ai-slop-cleaner src/auth/session.ts src/auth/token.ts`
- Preserve the same regression-safe workflow even when the scope is a short file list
- Keep a changed-file scope fixed. List broader cleanup opportunities in the report instead

## Workflow

1. **Protect current behavior first**
   - Identify what must stay the same.
   - Run the existing tests that cover it before editing; add one only for a fixed bug or an uncovered contract whose break would be silent.
   - If tests cannot come first, record the verification plan explicitly before touching code.

2. **Bound the pass**
   - Stay inside the requested files or feature area.
   - Order the work from safest deletion to riskier consolidation.

3. **Classify the slop before editing**
   - **Duplication**: repeated logic, copy-paste branches, redundant helpers
   - **Dead code**: unused code, unreachable branches, stale flags, debug leftovers
   - **Needless abstraction**: pass-through wrappers, speculative indirection, single-use helper layers
   - **Boundary violations**: hidden coupling, misplaced responsibilities, wrong-layer imports or side effects
   - **Low-value tests**: assertions mirroring the implementation, mocks of the unit under test, coverage-padding per-function cases, tests of constants or config shape; excluding regression tests for fixed bugs and tests of contracts whose break would be silent

4. **Run one smell-focused pass at a time**
   - **Pass 1: Dead code deletion**
   - **Pass 2: Duplicate removal**
   - **Pass 3: Naming and error-handling cleanup**
   - **Pass 4: Low-value test removal**, keeping regression tests for fixed bugs and tests of silent-break contracts
   - Re-run targeted verification after each pass.
   - Keep each edit set limited to related refactors.

5. **Run the quality gates**
   - Keep regression tests green.
   - Run the relevant lint, typecheck, and unit/integration tests for the touched area.
   - Run existing static or security checks when available.
   - If a gate fails, fix the issue or back out the risky cleanup instead of forcing it through. Keep gates active, with rules enabled, tests running, and code free of gate-silencing ignore comments.

6. **Close with an evidence-dense report**
   Always report:
   - **Changed files**
   - **Simplifications**
   - **Behavior lock / verification run**
   - **Remaining risks**
