# Review

Before the doc goes to the team, a fresh reviewer reads it cold, outside the drafting context.

1. Fill [templates/review-brief.md](../templates/review-brief.md): the doc text verbatim, the code and data paths it rests on, and the author's stated worries. Keep your own verdict out of the brief; a reviewer handed a conclusion returns it confirmed.
2. Send the brief to a Claude agent with `model: "fable"`. Update the id when `~/.claude/ROUTING.md` names a newer top tier.
3. Check each claimed contradiction against the code yourself before acting on it.
4. Show the carbon unit the gaps and the top edits, and apply only the ones they pick.
