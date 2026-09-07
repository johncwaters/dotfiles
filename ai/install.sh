#!/usr/bin/env bash
# Links Claude Code and Codex config into place. Every destination under ~/.claude is
# named one by one so the runtime state living beside them is never touched.

if [[ -z "${dotfilesRepo:-}" ]]; then
  # shellcheck source=../script/lib/context.sh
  source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../script/lib" && pwd)/context.sh"
  requireAliasResolvesToRepo
fi

claudeHome="$HOME/.claude"
codexHome="$HOME/.codex"

linkEntry "AGENTS.md" "ai/AGENTS.md" "$claudeHome/AGENTS.md"
linkEntry "ROUTING.md" "ai/ROUTING.md" "$claudeHome/ROUTING.md"
linkEntry "tsconfig.json" "ai/tsconfig.json" "$claudeHome/tsconfig.json"
linkEntry "types" "ai/types" "$claudeHome/types"
linkEntry "agents" "ai/agents" "$claudeHome/agents"
linkEntry "workflows" "ai/workflows" "$claudeHome/workflows"
linkEntry "commands" "ai/commands" "$claudeHome/commands"
linkEntry "hooks" "ai/hooks" "$claudeHome/hooks"
linkEntry "hud" "ai/hud" "$claudeHome/hud"
linkEntry "skills" "ai/skills" "$claudeHome/skills"
linkEntry "Codex AGENTS.md" "ai/AGENTS.md" "$codexHome/AGENTS.md"

if [[ -z "${profileName:-}" ]]; then
  noteWarned "profile files" "no profile resolved, CLAUDE.md and settings.json skipped"
  finishTopic
fi

# Claude Code silently drops every @import in a memory file that is itself a symlink,
# so CLAUDE.md is the one entry copied real; the @AGENTS.md inside it still resolves
# through the AGENTS.md link above, which imports do follow.
copyEntry "CLAUDE.md" "profiles/$profileName/CLAUDE.md" "$claudeHome/CLAUDE.md"
renderJsonTemplate "settings.json" \
  "$dotfilesRepo/ai/render-settings.mjs" \
  "$dotfilesRepo/ai/settings.base.json" \
  "$dotfilesRepo/profiles/$profileName/settings.overlay.json" \
  "$claudeHome/settings.json"

finishTopic
