---
name: plan-challenge
description: Challenges a fresh plan with three read-only subagents to simplify every step. One argues for cutting it, one for shrinking it, and one for the lowest algorithmic bound the operation admits. The caller judges the verdicts, revises the plan, and stamps it with a CHALLENGE line. Use when the spec skill reaches its challenge step or a drafted plan needs a direct challenge.
---

# Plan Challenge

Every step is guilty until justified. Three challengers press necessity, leverage, and scale; the output is a plan at most the original size.

## Input

**Required input.** The draft plan with numbered steps, the goal it serves in one or two sentences, and the repo path. When the caller knows what the goal tolerates (stale reads, a lost write, one writer, tail latency), the goal names it: an unstated tolerance cannot cut the step that guards against it.

## Output

**Guaranteed output.** A revised plan whose final line is the stamp:

```
CHALLENGE: <kept> kept, <shrunk> shrunk, <cut> cut
```

The spec skill stores that line as the design spec's `challengeStamp`, and its validator refuses a stamp that does not cover the units ready for work, which is what makes this skill part of the process rather than a suggestion. Writing the stamp without running the challengers defeats the gate and is a violation.

**Boundaries.** Challengers argue without editing files, rewriting the plan, or adding work. A challenge that proposes a new step is out of order and dropped: the only legal moves are cut, shrink, merge, keep. A scale SHRINK replaces only a step's approach with a lower-order one. A lowering that needs new infrastructure the plan lacks — an index, a cache layer, a pagination contract — is out of the challenger's power and comes back as a KEEP naming that infrastructure, which Step 3 carries into the step text rather than into a new step. The `plan-challenger` agent definition withholds Edit and Write, so the file-editing tools are structurally absent; the ban on writing through Bash is part of the lane brief the challenger honors.

## Step 1: Run the workflow

Call `Workflow({name: 'plan-challenge', args: { goal, planText, repoPath }})`. `lanes` holds the surviving lanes only, each one's `text` being the challenger output to judge; a lane whose verdicts leave any numbered step uncovered is dropped rather than returned, so a plan text with no detectable numbered step returns nothing. Read `survivingLanes` for the `(lanes: <comma-separated names>)` stamp suffix whenever fewer than all three lanes survive. A plan written as prose or headings has no detectable step, so before calling, restate it as a numbered list (`1.`, `2.`, one line per step at column zero) and pass that text. Always call by `name`: the `Workflow(plan-challenge)` allow rule in settings.base.json matches named runs only, and `scriptPath` fails anyway because the tool checks the symlink-resolved path.

Workflow tool absent in this session: read `~/.claude/workflows/plan-challenge.js`, spawn the lane set it names in one message with multiple calls, as before, and converge by the rules in that script.

## Step 2: Converge and judge

The caller judges; challengers only argue. Per step, start from the most aggressive verdict any lane returned (CUT beats SHRINK beats KEEP). A step survives a CUT or escapes a SHRINK only through a rebuttal naming the concrete failure that occurs without it; "might need it later", "best practice", and "small anyway" all lose. A scale SHRINK is escaped only by a rebuttal naming the fact that bounds the input (an enum, a config cap, a fixed list) and where it lives; "it will be small" loses. `unverified` evidence loses to verified evidence pointing the other way.

Overriding more than a third of the aggressive verdicts means the challengers misread the goal: fix the goal statement and respawn rather than bulk-rebutting.

No lane surviving is not a thinner challenge but no challenge at all: return the plan to its caller unstamped.

## Step 3: Revise and stamp

Apply the surviving verdicts, merge and renumber, append the `CHALLENGE:` stamp as the last line, and hand the revised plan to whatever comes next — usually the spec skill, which records the stamp. Every step whose work survives carries a bound in its revised text: a step a scale SHRINK rewrote carries only the lowered bound that SHRINK named; a step merged into another hands its bound to the absorbing step, which carries both; only a cut step drops its bound. A kept bound appears in the revised step text in the form `(O(n) in rows)` or, when a scale KEEP named the infrastructure a lowering would need, `(O(n²) in rows; O(n log n) needs an index on created_at)`, so the carbon unit approving the plan sees the cost being approved and what would lower it. Counts in the stamp refer to the original steps: a step merged into another counts as shrunk.

## Challenger output format

Each lane ends its response with:

```
STEP_VERDICTS:
- step: <n> | verdict: <CUT|SHRINK|KEEP> | because: <one sentence> | evidence: <file:line, command output, or "unverified">
- step: ...

PLAN_SUMMARY:
<one paragraph: the plan's weakest step and the single biggest simplification available>
```

Every numbered step gets exactly one verdict line. One verdict per line, no bare `|` inside a field.

## Token discipline

- Plans are small: paste the plan text into each prompt. Keep repo contents out of prompts; the lanes read the repo themselves.
- Three lanes is the fleet. A hard disagreement is settled by the caller's judgment at convergence, not by a fourth agent.
