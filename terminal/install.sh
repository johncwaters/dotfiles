#!/usr/bin/env bash
if [[ -z "${dotfilesRepo:-}" ]]; then
  # shellcheck source=../script/lib/context.sh
  source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../script/lib" && pwd)/context.sh"
  requireAliasResolvesToRepo
fi
# shellcheck source=../script/lib/packages.sh
source "$dotfilesRepo/script/lib/packages.sh"

# Ubuntu 24.04 ships no ghostty, so the noble builds come from this community PPA.
ghosttyPpaName="ppa:mkasberg/ghostty-ubuntu"
ghosttyTerminalActionLine='    Terminal: "ghostty",'
# Root owned path this reads, so a test run inside a marked sandbox home points it elsewhere; outside one the redirect is ignored.
cosmicSystemActionsPath="$(sandboxRedirectedPath "${DOTFILES_COSMIC_SYSTEM_ACTIONS:-}" \
  /usr/share/cosmic/com.system76.CosmicSettings.Shortcuts/v1/system_actions)"

# cosmic-config reads the whole map from the user file when it exists, so the override carries every action.
deriveSystemActionsWithGhostty() {
  sed -E 's|^[[:space:]]*Terminal:.*|'"$ghosttyTerminalActionLine"'|' "$cosmicSystemActionsPath"
}

installCosmicDefaultTerminal() {
  local cosmicConfigDirectory="$HOME/.config/cosmic"
  local shortcutDirectory="$cosmicConfigDirectory/com.system76.CosmicSettings.Shortcuts/v1"
  local userSystemActionsPath="$shortcutDirectory/system_actions"
  local stagedPath
  if [[ ! -d "$cosmicConfigDirectory" ]]; then
    notePresent "COSMIC default terminal" "COSMIC unavailable"
    return 0
  fi
  refreshSessionPath
  # Pointing the shortcut at a terminal this machine lacks leaves Super+T opening nothing at all.
  if ! command -v ghostty >/dev/null 2>&1; then
    noteWarned "COSMIC default terminal" "ghostty is not installed"
    return 0
  fi
  if [[ ! -f "$cosmicSystemActionsPath" ]]; then
    noteWarned "COSMIC default terminal" "no system action map at $cosmicSystemActionsPath"
    return 0
  fi
  mkdir -p -- "$shortcutDirectory"
  if ! clearDestinationIfNotPlainFile "COSMIC default terminal" "$userSystemActionsPath"; then
    return 0
  fi
  # A redirect onto a symlink writes through it, so the map is staged and renamed.
  stagedPath="$(mktemp "$shortcutDirectory/.dotfiles-system-actions.XXXXXX")"
  if ! deriveSystemActionsWithGhostty > "$stagedPath"; then
    rm -f -- "$stagedPath"
    noteWarned "COSMIC default terminal" "could not read the system action map"
    return 0
  fi
  if ! grep -qxF -- "$ghosttyTerminalActionLine" "$stagedPath"; then
    rm -f -- "$stagedPath"
    noteWarned "COSMIC default terminal" "the system action map names no Terminal action"
    return 0
  fi
  commitStagedFile "COSMIC default terminal" "$stagedPath" "$userSystemActionsPath" "set to ghostty"
}

ensureAptRepository "Ghostty PPA" "$ghosttyPpaName" "ghostty"
installPackageTool "Ghostty" "ghostty" "ghostty" "https://ghostty.org"
linkEntry "Ghostty config" "terminal/ghostty.config" "$HOME/.config/ghostty/config"
installCosmicDefaultTerminal

finishTopic
