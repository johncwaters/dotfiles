<agy_tools>
Skills name Claude Code tools. In agy, use these instead:
- WebSearch: `search_web`. WebFetch: `curl -fsSL <url>` through `run_command`, since agy has no page-reading tool.
- Agent or Task with a `subagent_type`, such as a qa-swarm or plan-challenge lane: call `invoke_subagent` with that `TypeName`; every lane is installed as an agy subagent, so never `define_subagent` one.
- Workflow({name, args}), such as qa-swarm or plan-challenge: call `run_workflow` with `ScriptPath` `~/.claude/workflows/agy/claude-workflow.py` and `Args` `{"workflow": name, "args": args}`, then read its JSON result from `Output:` as the Workflow result; never run the lanes or converge their findings by hand.
</agy_tools>
