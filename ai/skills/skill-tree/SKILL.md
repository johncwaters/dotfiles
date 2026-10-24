---
name: skill-tree
description: Renders the shipped skills, agents, workflows, and registered hooks with their relationships and organization signals. Use for "show my skill tree", "skill graph", "map my skills", "which skill loads which", or "organize my skills".
---

# Skill tree

1. Run `node ~/.claude/skills/skill-tree/render.ts <scratch dir>` to create the graph and its portable HTML view.
2. Read `graph.json` and mention its `isolated` nodes and `cycles`, including when either list is empty. Use those signals to suggest organization changes grounded in the graph.
3. Declare `capabilities: {downloads: true}` on the artifact with `declare_capabilities` before publishing, since the viewer refuses page-started downloads and the share-image button saves through that capability. Publish `index.html` and `fonts/*` from the output directory with the `claude-artifacts` `publish_files` tool, preserving their relative paths. Set the title to "Skill tree" and the icon to "map". When the carbon unit already has a Skill tree artifact, republish to that same artifact.

## Scripts

- `extract.ts`: Extracts the relationship graph; imported by render.ts when rendering.
- `render.ts`: Builds graph.json and the portable HTML view; run before reading signals and publishing.
