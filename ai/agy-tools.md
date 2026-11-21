<agy_tools>
Skills name Claude Code tools. In agy, use these instead:
- WebSearch: `search_web`. WebFetch: `curl -fsSL <url>` through `run_command`, since agy has no page-reading tool.
- Agent or Task with a `subagent_type`, such as a qa-swarm or plan-challenge lane: call `define_subagent` once per type, with `Name` the type, `SystemPrompt` the body of `~/.claude/agents/<type>.md` below its frontmatter, and `EnableWriteTools` true, since the lanes run git through `run_command`. Then call `invoke_subagent` with that `TypeName`.
</agy_tools>
