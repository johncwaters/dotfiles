#!/usr/bin/env bash
# Per-entry links preserve the runtime state beside them in ~/.claude (AGENTS.md).

if [[ -z "${dotfilesRepo:-}" ]]; then
  # shellcheck source=../script/lib/context.sh
  source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../script/lib" && pwd)/context.sh"
  requireAliasResolvesToRepo
fi

claudeHome="$HOME/.claude"
codexHome="$HOME/.codex"
claudeSkillsDirectory="$claudeHome/skills"
repoSkillsDirectory="$dotfilesRepo/ai/skills"
skillsStagingDirectory="$claudeHome/.skills-cutover"

resolvedDirectoryPath() {
  cd -- "$1" 2> /dev/null && pwd -P
}

repoSkillsIndexIsReadable() {
  local trackedSkillPaths
  command -v git > /dev/null 2>&1 || return 1
  trackedSkillPaths="$(git -C "$dotfilesRepo" ls-files -- ai/skills 2> /dev/null)" || return 1
  [[ -n "$trackedSkillPaths" ]]
}

repoSkillEntryIsTracked() {
  local trackedSkillPaths
  trackedSkillPaths="$(git -C "$dotfilesRepo" ls-files -- "ai/skills/$1" 2> /dev/null)" || return 1
  [[ -n "$trackedSkillPaths" ]]
}

claudeSkillsLinkPointsOutsideRepoSkills() {
  local linkedDirectory
  local repoSkillsPath
  pathIsLinkIntoThisRepo "$claudeSkillsDirectory" || return 1
  linkedDirectory="$(resolvedDirectoryPath "$claudeSkillsDirectory" || true)"
  repoSkillsPath="$(resolvedDirectoryPath "$repoSkillsDirectory" || true)"
  [[ -z "$repoSkillsPath" || "$linkedDirectory" != "$repoSkillsPath" ]]
}

stageForeignSkillEntriesOutOfTheRepo() {
  local repoSkillEntries=()
  local repoSkillEntry
  local skillName
  shopt -s dotglob nullglob
  repoSkillEntries=("$repoSkillsDirectory"/*)
  shopt -u dotglob nullglob
  for repoSkillEntry in "${repoSkillEntries[@]}"; do
    skillName="$(basename -- "$repoSkillEntry")"
    if repoSkillEntryIsTracked "$skillName"; then
      continue
    fi
    mkdir -p -- "$skillsStagingDirectory"
    mv -- "$repoSkillEntry" "$skillsStagingDirectory/$skillName"
  done
}

cutOverLegacySkillsDirectoryLink() {
  pathIsLinkIntoThisRepo "$claudeSkillsDirectory" || return 0
  if ! repoSkillsIndexIsReadable; then
    noteWarned "skills directory" "git cannot name the tracked skills, cutover skipped"
    return 1
  fi
  stageForeignSkillEntriesOutOfTheRepo
  rm -f -- "$claudeSkillsDirectory"
}

adoptStagedSkillEntries() {
  local stagedEntries=()
  local stagedEntry
  local skillName
  [[ -d "$skillsStagingDirectory" ]] || return 0
  shopt -s dotglob nullglob
  stagedEntries=("$skillsStagingDirectory"/*)
  shopt -u dotglob nullglob
  for stagedEntry in "${stagedEntries[@]}"; do
    skillName="$(basename -- "$stagedEntry")"
    if [[ -e "$claudeSkillsDirectory/$skillName" || -L "$claudeSkillsDirectory/$skillName" ]]; then
      noteWarned "skill $skillName" "already in ~/.claude/skills, left in $skillsStagingDirectory"
      continue
    fi
    mv -- "$stagedEntry" "$claudeSkillsDirectory/$skillName"
    noteApplied "skill $skillName" "moved out of repo"
  done
  rmdir -- "$skillsStagingDirectory" 2> /dev/null || true
}

removeRetiredSkillLinks() {
  local installedSkillPath
  local skillName
  shopt -s nullglob
  for installedSkillPath in "$claudeSkillsDirectory"/*; do
    skillName="$(basename -- "$installedSkillPath")"
    if [[ -e "$repoSkillsDirectory/$skillName" ]]; then
      continue
    fi
    case "$(symlinkTargetOf "$installedSkillPath")" in
      "$dotfilesAlias/ai/skills/"* | "$dotfilesRepo/ai/skills/"*)
        rm -f -- "$installedSkillPath"
        noteApplied "skill $skillName" "retired link removed"
        ;;
    esac
  done
  shopt -u nullglob
}

linkRepoSkills() {
  local repoSkillPath
  local skillName
  shopt -s nullglob
  for repoSkillPath in "$repoSkillsDirectory"/*; do
    skillName="$(basename -- "$repoSkillPath")"
    linkEntry "skill $skillName" "ai/skills/$skillName" "$claudeSkillsDirectory/$skillName"
  done
  shopt -u nullglob
}

moveSkillsPathAsideUnlessItIsAPlainDirectory() {
  if [[ ! -L "$claudeSkillsDirectory" ]] && [[ ! -e "$claudeSkillsDirectory" || -d "$claudeSkillsDirectory" ]]; then
    return 0
  fi
  moveExistingAside "skills directory" "$claudeSkillsDirectory"
}

installRepoSkills() {
  if claudeSkillsLinkPointsOutsideRepoSkills; then
    noteWarned "skills directory" "links into the repo outside ai/skills, move it aside by hand"
    return 0
  fi
  cutOverLegacySkillsDirectoryLink || return 0
  moveSkillsPathAsideUnlessItIsAPlainDirectory
  mkdir -p -- "$claudeSkillsDirectory"
  adoptStagedSkillEntries
  removeRetiredSkillLinks
  linkRepoSkills
}

installRepoSkills

linkEntry "AGENTS.md" "ai/AGENTS.md" "$claudeHome/AGENTS.md"
linkEntry "ROUTING.md" "ai/ROUTING.md" "$claudeHome/ROUTING.md"
linkEntry "tsconfig.json" "ai/tsconfig.json" "$claudeHome/tsconfig.json"
linkEntry "types" "ai/types" "$claudeHome/types"
linkEntry "agents" "ai/agents" "$claudeHome/agents"
linkEntry "workflows" "ai/workflows" "$claudeHome/workflows"
linkEntry "commands" "ai/commands" "$claudeHome/commands"
linkEntry "hooks" "ai/hooks" "$claudeHome/hooks"
linkEntry "hud" "ai/hud" "$claudeHome/hud"
linkEntry "Codex AGENTS.md" "ai/AGENTS.md" "$codexHome/AGENTS.md"

if [[ -z "${profileName:-}" ]]; then
  noteWarned "profile files" "no profile resolved, CLAUDE.md and settings.json skipped"
  finishTopic
fi

# CLAUDE.md must be a copy for Claude Code to follow its @AGENTS.md import (AGENTS.md).
copyEntry "CLAUDE.md" "profiles/$profileName/CLAUDE.md" "$claudeHome/CLAUDE.md"
renderJsonTemplate "settings.json" \
  "$dotfilesRepo/ai/render-settings.mjs" \
  "$dotfilesRepo/ai/settings.base.json" \
  "$dotfilesRepo/profiles/$profileName/settings.overlay.json" \
  "$claudeHome/settings.json"

finishTopic
