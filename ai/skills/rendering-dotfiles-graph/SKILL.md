---
name: rendering-dotfiles-graph
description: Renders the dotfiles repo as a graph of profiles, topics, shared libs, profile files, package groups, shell fragments, and the $HOME paths each topic links, copies, stubs, or renders, with organization signals. Use for "graph my dotfiles", "dotfiles graph", "map my dotfiles", "which topic links what", or "what does each profile run".
---

# Dotfiles graph

1. Run `node ~/.claude/skills/rendering-dotfiles-graph/render.ts <scratch dir>` to create the graph and its portable HTML view.
2. Read `graph.json` and mention every list under `signals` (`unrunTopics`, `unsourcedLibs`, `unreferencedFiles`, `sourceCycles`), including when a list is empty. Use those signals to suggest organization changes grounded in the graph.
3. Declare `capabilities: {downloads: true}` on the artifact with `declare_capabilities` before publishing, since the viewer refuses page-started downloads and the share-image button saves through that capability. Publish `index.html` and `fonts/*` from the output directory with the `claude-artifacts` `publish_files` tool, preserving their relative paths. Set the title to "Dotfiles graph" and the icon to "map". When the carbon unit already has a Dotfiles graph artifact, republish to that same artifact.

## Scripts

- `extract.ts`: Extracts the dotfiles graph by reading the repo's files as text; imported by render.ts when rendering.
- `render.ts`: Builds graph.json and the portable HTML view; run before reading signals and publishing.
