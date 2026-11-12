---
name: cleaning-ai-slop
description: Cleans AI-generated code slop with a regression-safe, deletion-first workflow. Use when the carbon unit says deslop, anti-slop, or AI slop, or asks to clean up code that feels bloated, repetitive, over-abstracted, weakly tested, or bolted on. Bounded cleanup, not feature work.
---

# AI Slop Cleaner

Clean AI-generated code slop without drifting scope or changing its observable output. This is the bounded cleanup workflow for code that works but feels bloated, repetitive, weakly tested, or over-abstracted.

## When to Use

- The carbon unit explicitly says `deslop`, `anti-slop`, or `AI slop`
- The request is to clean up or refactor code that feels noisy, repetitive, or overly abstract
- Follow-up implementation left duplicate logic, dead code, wrapper layers, boundary leaks, or weak regression coverage
- A finished feature was layered on with special cases, flags, or variant copies instead of reshaping the code around it
- The goal is simplification and cleanup, not new feature delivery

## When Not to Use

- The task is mainly a new feature build or product change
- The carbon unit wants a broad redesign instead of an incremental cleanup pass
- The request is a generic refactor with no simplification or anti-slop intent
- Behavior is too unclear to protect with tests or a concrete verification plan

## Execution Posture

- Behavior is observable output: what callers, carbon units, and stored data see. Internals such as types, branches, files, and helpers are free to reshape.
- Change output only when the carbon unit asks, or to fix a wrong output the cleanup exposes at its source inside the bounded scope, named in the report.
- Tests, reuse, scope, and failing gates follow `~/.claude/AGENTS.md`'s `<tests>`, `<reuse_before_create>`, `<scope_boundary>`, and `<research_not_assume>`.
- Prefer deletion over addition.
- Add new dependencies only when the carbon unit explicitly requests them.
- Keep diffs small, reversible, and smell-focused.

## Scoped File-List Usage

The pass can be bounded to an explicit file list or changed-file scope when the caller already knows the safe cleanup surface (for example, the files changed in the current commit).

- Good fit: `/cleaning-ai-slop src/auth/session.ts src/auth/token.ts`
- Preserve the same regression-safe workflow even when the scope is a short file list
- Keep a changed-file scope fixed. List broader cleanup opportunities in the report instead

## Workflow

1. **Protect current behavior first**
   - Identify the observable output that must stay the same.
   - Run the existing tests that cover it before editing.
   - If tests cannot come first, record the verification plan explicitly before touching code.

2. **Bound the pass**
   - Stay inside the requested files or feature area.
   - Order the work from safest deletion to riskier consolidation.

3. **Classify the slop before editing**
   - **Duplication**: repeated logic, copy-paste branches, redundant helpers
   - **Dead code**: unused code, unreachable branches, stale flags, debug leftovers
   - **Needless abstraction**: pass-through wrappers, speculative indirection, single-use helper layers
   - **Boundary violations**: hidden coupling, misplaced responsibilities, wrong-layer imports or side effects
   - **Bolted-on shape**: a feature layered onto code built before it, such as an `if (newKind)` branch in code that already dispatches on kind, a near-copy file or component for one variant, a flag repeating what a type already says, an optional parameter only one caller passes, or a second system beside one that already owns the concern. This class covers feature code; a bug fix stays the smallest change that fixes it.
   - **Low-value tests**: the kinds `~/.claude/AGENTS.md`'s `<tests>` rules out

4. **Run one smell-focused pass at a time**
   - **Pass 1: Dead code deletion**. Before deleting a path that production could still reach, check the repo's telemetry read-only when a tool for it is connected (PostHog, logs, error tracking), and keep that data out of the diff and commit message.
   - **Pass 2: Duplicate and bolted-on shape removal**. For bolted-on shape, ask how the code would look had the feature been in the original design, reshape the existing types, dispatch, and systems to that, delete the workaround, and grep its removed symbols for leftovers.
   - **Pass 3: Naming and error-handling cleanup**
   - **Pass 4: Low-value test removal**, including tests that only prove a removed workaround survived
   - Re-run targeted verification after each pass.
   - Keep each edit set limited to related refactors.

5. **Run the quality gates**
   - Keep regression tests green.
   - Run the relevant lint, typecheck, and unit/integration tests for the touched area.
   - Run existing static or security checks when available.
   - If a gate fails, fix the issue or back out the risky cleanup instead of forcing it through.

6. **Close with an evidence-dense report**
   Always report:
   - **Changed files**
   - **Simplifications**
   - **Behavior lock / verification run**
   - **Output changes**: each wrong output fixed or left for a source outside scope, and that source
   - **Remaining risks**
