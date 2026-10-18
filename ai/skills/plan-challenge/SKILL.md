---
name: plan-challenge
description: Adversarial simplification gate for a freshly written plan. Spawns three read-only challenger subagents that argue against every step with the expressed goal of making the plan simpler — one lane argues each step should not exist, one that it should be smaller, and one that its algorithmic bound should be as low as the operation admits — then the caller judges the verdicts, revises the plan, and stamps it with a CHALLENGE line. Runs from the spec skill's challenge step; also invocable directly on any drafted plan.
---

# Plan Challenge

Every step is guilty until justified. Three challengers press necessity, leverage, and scale; the output is a plan the same size or smaller, never larger.

## Contract with the caller

**Required input.** The draft plan with numbered steps, the goal it serves in one or two sentences, and the repo path.

**Guaranteed output.** A revised plan whose final line is the stamp:

```
CHALLENGE: <kept> kept, <shrunk> shrunk, <cut> cut
```

The spec skill stores that line as the design spec's `challengeStamp`, and its validator refuses a stamp that does not cover the units ready for work, which is what makes this skill part of the process rather than a suggestion. Writing the stamp without running the challengers defeats the gate and is a violation.

**Never.** Challengers never edit files, never rewrite the plan, and never add work. A challenge that proposes a new step is out of order and dropped: the only legal moves are cut, shrink, merge, keep. A scale SHRINK swaps a step's approach for a lower-order one and never adds a step. A lowering that needs new infrastructure the plan lacks — an index, a cache layer, a pagination contract — is out of the challenger's power and comes back as a KEEP naming that infrastructure, which Step 3 carries into the step text rather than into a new step. The `plan-challenger` agent definition withholds Edit and Write, so the file-editing tools are structurally absent; the ban on writing through Bash is part of the lane brief the challenger honors.

## Step 1: Run the workflow

Call `Workflow({name: 'plan-challenge', args: { goal, planText, repoPath }})`. `lanes` holds the surviving lanes only, each one's `text` being the challenger output to judge; a lane whose verdicts do not cover every numbered step is dropped rather than returned, so a plan text with no detectable numbered step returns nothing. Read `survivingLanes` for the `(lanes: <comma-separated names>)` stamp suffix whenever fewer than all three lanes survive. A plan written as prose or headings has no detectable step, so before calling, restate it as a numbered list (`1.`, `2.`, one line per step at column zero) and pass that text. Always call by `name`: the `Workflow(plan-challenge)` allow rule in settings.base.json matches named runs only, and `scriptPath` fails anyway because the tool checks the symlink-resolved path.

Workflow tool absent in this session: read `~/.claude/workflows/plan-challenge.js`, spawn the lane set it names in one message with multiple calls, as before, and converge by the rules in that script.

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

## Step 2: Converge and judge

The caller judges; challengers only argue. Per step, start from the most aggressive verdict any lane returned (CUT beats SHRINK beats KEEP). A step survives a CUT or escapes a SHRINK only through a rebuttal naming the concrete failure that occurs without it; "might need it later", "best practice", and "small anyway" all lose. A scale SHRINK is escaped only by a rebuttal naming the fact that bounds the input (an enum, a config cap, a fixed list) and where it lives; "it will be small" loses. `unverified` evidence loses to verified evidence pointing the other way.

Overriding more than a third of the aggressive verdicts means the challengers misread the goal: fix the goal statement and respawn rather than bulk-rebutting.

No lane surviving is not a thinner challenge but no challenge at all: return the plan to its caller unstamped.

## Step 3: Revise and stamp

Apply the surviving verdicts, merge and renumber, append the `CHALLENGE:` stamp as the last line, and hand the revised plan to whatever comes next — usually the spec skill, which records the stamp. Every step whose work survives carries a bound in its revised text: a step a scale SHRINK rewrote carries the lowered bound that SHRINK named, never the bound of the approach the rewrite replaced; a step merged into another hands its bound to the absorbing step, which carries both; only a cut step drops its bound. A kept bound appears in the revised step text in the form `(O(n) in rows)` or, when a scale KEEP named the infrastructure a lowering would need, `(O(n²) in rows; O(n log n) needs an index on created_at)`, so the carbon unit approving the plan sees the cost being approved and what would lower it. Counts in the stamp refer to the original steps: a step merged into another counts as shrunk.

## Token discipline

- Plans are small: paste the plan text into each prompt. Never paste repo contents; the lanes read the repo themselves.
- Three lanes is the fleet. A hard disagreement is settled by the caller's judgment at convergence, not by a fourth agent.
