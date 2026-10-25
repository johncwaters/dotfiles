<routing>
Main session loop only; subagents skip per `<scope>`. This section overrides the `<routing>` rules injected from `~/.claude/ROUTING.md` per their precedence rule: apply them as written, amended for a work machine as follows.
- Claude and Codex models only. Never dispatch to Gemini or another non-Claude, non-Codex model CLI because work code may go only to company-sanctioned providers. Rule 1b may route only among Claude and Codex.
- The enforce-spawn-model PreToolUse hook denies any spawn with a missing model, so every spawn names its tier deliberately.
</routing>

<worktree>
Prefer working in a dedicated git worktree; if the session did not start in one, move to one before making changes. Once in a worktree, stay there: do not switch to another worktree or change the working directory out of it mid-task.
</worktree>

<posthog_writing>
Writing or editing PostHog prose (posthog.com docs, handbook, tutorials, blog, changelog, RFCs, PR descriptions), even mid-coding-task: load the `writing-longform` skill (`~/.claude/skills/writing-longform/SKILL.md`) before the first draft, because its description alone misses edits that arrive inside a code task.
</posthog_writing>
