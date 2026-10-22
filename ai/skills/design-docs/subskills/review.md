# Review

Before the doc goes to the team, two reviewers from different model families read it cold.

1. Fill [templates/review-brief.md](../templates/review-brief.md): the doc text verbatim, the code and data paths it rests on, and the author's stated worries. Never include your own verdict on the doc; a reviewer handed a conclusion returns it confirmed.
2. Send the brief in parallel to Codex with `codex exec -s read-only -m gpt-6-astra -c model_reasoning_effort="high" < brief.md` (run in the background) and to a Claude agent with `model: "fable"`. Update the ids when `~/.claude/ROUTING.md` names a newer top tier.
3. Merge the two reports. A gap both found goes first. Check each claimed contradiction against the code yourself before acting on it.
4. Show the carbon unit the merged gaps and the top edits, and apply only the ones they pick.
