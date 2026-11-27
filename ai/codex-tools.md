<codex_tools>
Skills name Claude Code tools. In Codex, use these instead:
- Workflow({name, args}), such as qa-swarm or plan-challenge: write `args` as JSON to a temp file, run `node ~/.claude/workflows/agy/codex-workflow.mjs <name> <args file>` in the background with escalated permissions, outside your sandbox, since each lane is its own `codex exec` that needs `~/.codex` and the network, and read its stdout as the Workflow result; it runs each lane as a `codex exec` with the Claude lane body as its instructions and converges them by the workflow's own code, so never run the lanes or converge their findings by hand.
</codex_tools>
