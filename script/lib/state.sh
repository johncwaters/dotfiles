# shellcheck shell=bash
# What a converge still owes is this account's state, not its config, so it lives in one
# directory instead of beside each file it tracks: some of those sit in root owned trees.
# The repo dependency key is shared with glimmervoid so its service waits for repos to finish.

dotfilesStateDirectoryLocation() {
  printf '%s\n' "${XDG_STATE_HOME:-$HOME/.local/state}/dotfiles"
}

readableDotfilesStateDirectory() {
  local stateDirectory
  stateDirectory="$(dotfilesStateDirectoryLocation)"
  dotfilesStateDirectoryPath=""
  if [[ -L "$stateDirectory" || ! -d "$stateDirectory" ]]; then
    return 1
  fi
  if [[ ! -r "$stateDirectory" || ! -x "$stateDirectory" ]]; then
    return 1
  fi
  dotfilesStateDirectoryPath="$stateDirectory"
}

dotfilesStateDirectory() {
  local stateDirectory
  local writabilityProbePath
  stateDirectory="$(dotfilesStateDirectoryLocation)"
  dotfilesStateDirectoryPath=""
  if [[ -L "$stateDirectory" || ( -e "$stateDirectory" && ! -d "$stateDirectory" ) ]]; then
    noteWarned "dotfiles state" "$stateDirectory is not a plain directory, leaving it alone"
    return 1
  fi
  if ! mkdir -p -- "$stateDirectory"; then
    noteWarned "dotfiles state" "$stateDirectory could not be created, leaving it alone"
    return 1
  fi
  if [[ -L "$stateDirectory" || ! -d "$stateDirectory" ]]; then
    noteWarned "dotfiles state" "$stateDirectory is not a plain directory, leaving it alone"
    return 1
  fi
  if [[ ! -w "$stateDirectory" ]]; then
    noteWarned "dotfiles state" "$stateDirectory is not writable, leaving it alone"
    return 1
  fi
  writabilityProbePath="$stateDirectory/.writability-probe.$$.$RANDOM"
  if ! (set -o noclobber; : > "$writabilityProbePath") 2>/dev/null; then
    noteWarned "dotfiles state" "$stateDirectory refused a probe file, leaving it alone"
    return 1
  fi
  if ! rm -f -- "$writabilityProbePath"; then
    noteWarned "dotfiles state" "$writabilityProbePath could not be removed, leaving it alone"
    return 1
  fi
  dotfilesStateDirectoryPath="$stateDirectory"
}

dotfilesStatePath() {
  dotfilesStatePathValue=""
  dotfilesStateDirectory || return 1
  dotfilesStatePathValue="$dotfilesStateDirectoryPath/$1"
}

repoDepsPendingStateNameForPath() {
  local relativeRepoPath="${1#"$HOME"/}"
  local repoPathHash
  local repoPathSlug="$relativeRepoPath"
  repoPathSlug="$(printf '%s' "$repoPathSlug" | sed -E 's/[^A-Za-z0-9]+/-/g; s/^-+//; s/-+$//')"
  repoPathSlug="${repoPathSlug:0:80}"
  if [[ -x /usr/bin/sha256sum ]]; then
    repoPathHash="$(printf '%s' "$relativeRepoPath" | /usr/bin/sha256sum)"
    repoPathHash="${repoPathHash%% *}"
    repoPathHash="${repoPathHash:0:12}"
    printf 'repos-%s-%s-deps-pending\n' "$repoPathSlug" "$repoPathHash"
    return 0
  fi
  repoPathHash="$(printf '%s' "$relativeRepoPath" | cksum)" || return 1
  repoPathHash="${repoPathHash%% *}"
  printf 'repos-%s-%s-deps-pending\n' "$repoPathSlug" "$repoPathHash"
}

readDotfilesState() {
  local stateValue
  local statePath
  readableDotfilesStateDirectory || return 1
  statePath="$dotfilesStateDirectoryPath/$1"
  if [[ -L "$statePath" || ! -f "$statePath" ]]; then
    return 1
  fi
  stateValue="$(cat -- "$statePath" 2>/dev/null)" || return 1
  printf '%s' "$stateValue"
}

# mv and cp -f write inside a directory and through a symlink, so every caller here asks this before it writes.
pathIsPlainFileOrAbsent() {
  if [[ -L "$1" ]]; then
    return 1
  fi
  [[ ! -e "$1" ]] || [[ -f "$1" ]]
}

# A redirect into an existing symlink truncates whatever it points at, so the write is staged beside the record and renamed over it.
# Warns rather than failing: every call site runs bare under set -e, and a refused record must not take the topic with it.
writeDotfilesState() {
  local statePath
  local stagedPath
  dotfilesStatePath "$1" || return 0
  statePath="$dotfilesStatePathValue"
  if ! pathIsPlainFileOrAbsent "$statePath"; then
    noteWarned "dotfiles state" "$statePath is not a regular file, leaving it alone"
    return 0
  fi
  stagedPath="$statePath.$$.tmp"
  if ! rm -f -- "$stagedPath"; then
    noteWarned "dotfiles state" "$stagedPath could not be prepared, leaving it alone"
    return 0
  fi
  if ! printf '%s\n' "$2" > "$stagedPath"; then
    noteWarned "dotfiles state" "$stagedPath could not be written, leaving it alone"
    return 0
  fi
  if mv -f -- "$stagedPath" "$statePath"; then
    return 0
  fi
  noteWarned "dotfiles state" "$statePath could not be replaced, leaving it alone"
  rm -f -- "$stagedPath" || true
  return 0
}

markDotfilesStatePending() {
  writeDotfilesState "$1" ""
}

clearDotfilesState() {
  local statePath
  dotfilesStatePath "$1" || return 0
  statePath="$dotfilesStatePathValue"
  if pathIsPlainFileOrAbsent "$statePath"; then
    if rm -f -- "$statePath"; then
      return 0
    fi
    noteWarned "dotfiles state" "$statePath could not be removed, leaving it alone"
    return 0
  fi
  noteWarned "dotfiles state" "$statePath is not a regular file, leaving it alone"
  return 0
}

dotfilesStateIsPending() {
  local statePath
  dotfilesStatePath "$1" || return 0
  statePath="$dotfilesStatePathValue"
  if [[ -L "$statePath" || ( -e "$statePath" && ! -f "$statePath" ) ]]; then
    noteWarned "dotfiles state" "$statePath is not a regular file, treating it as pending"
    return 0
  fi
  [[ -f "$statePath" ]]
}
