# shellcheck shell=bash

lastBackupPath=""

aliasTargetFor() {
  printf '%s/%s\n' "$dotfilesAlias" "$1"
}

symlinkTargetOf() {
  readlink -- "$1" 2>/dev/null || true
}

# Never reuses a backup path, so no run can bury what an earlier one preserved.
nextBackupPath() {
  local destination="$1"
  local candidate="$destination$backupSuffix"
  local attempt=2
  while [[ -e "$candidate" || -L "$candidate" ]]; do
    candidate="$destination$backupSuffix.$attempt"
    attempt=$((attempt + 1))
  done
  printf '%s\n' "$candidate"
}

# A displaced rc or gitconfig can hold a token, so every backup is sealed here, not per topic.
moveExistingAside() {
  local label="$1"
  local destination="$2"
  local backupPath
  backupPath="$(nextBackupPath "$destination")"
  mv -- "$destination" "$backupPath"
  if [[ -f "$backupPath" && ! -L "$backupPath" ]]; then
    chmod 600 "$backupPath"
  fi
  lastBackupPath="$backupPath"
  noteApplied "$label backup" "saved $(basename -- "$backupPath")"
}

symlinkPointsIntoThisRepo() {
  case "$1" in
    "$dotfilesAlias" | "$dotfilesAlias"/* | "$dotfilesRepo" | "$dotfilesRepo"/*) return 0 ;;
  esac
  return 1
}

linkIsCurrent() {
  local repoRelativeSource="$1"
  local destination="$2"
  local wantedTarget="${3:-$(aliasTargetFor "$repoRelativeSource")}"
  [[ -L "$destination" ]] || return 1
  [[ "$(symlinkTargetOf "$destination")" == "$wantedTarget" ]]
}

# The outcome goes to a variable the caller names, so two links in one process cannot read each other's result.
recordLinkOutcome() {
  local outcomeVariableName="$1"
  if [[ -z "$outcomeVariableName" ]]; then
    return 0
  fi
  printf -v "$outcomeVariableName" '%s' "$2"
}

# A chained link counts as ours when any hop lands in the repo.
pathIsLinkIntoThisRepo() {
  local path="$1"
  [[ -L "$path" ]] || return 1
  symlinkPointsIntoThisRepo "$(symlinkTargetOf "$path")" && return 0
  local resolvedPath physicalRepo
  resolvedPath="$(readlink -f -- "$path" 2>/dev/null || true)"
  symlinkPointsIntoThisRepo "$resolvedPath" && return 0
  physicalRepo="$(readlink -f -- "$dotfilesRepo" 2>/dev/null || true)"
  [[ -n "$physicalRepo" && "$resolvedPath" == "$physicalRepo"/* ]]
}

fileHoldsLine() {
  [[ -f "$1" && ! -L "$1" ]] || return 1
  grep -qxF -- "$2" "$1"
}

# This repo put the destination there: either a link into the checkout or a stub we wrote.
destinationIsOurs() {
  pathIsLinkIntoThisRepo "$1" && return 0
  fileHoldsLine "$1" "$2"
}

ensureStubFile() {
  local label="$1"
  local destination="$2"
  local markerLine="$3"
  local content
  content="$(cat)"
  lastBackupPath=""
  if ! grep -qxF -- "$markerLine" <<< "$content"; then
    noteWarned "$label" "stub content lacks its marker line"
    return 0
  fi
  if fileHoldsLine "$destination" "$markerLine"; then
    notePresent "$label" "stub in place"
    return 0
  fi
  mkdir -p -- "$(dirname -- "$destination")"
  if destinationIsOurs "$destination" "$markerLine"; then
    rm -f -- "$destination"
  fi
  if [[ -e "$destination" || -L "$destination" ]]; then
    moveExistingAside "$label" "$destination"
  fi
  printf '%s\n' "$content" > "$destination"
  noteApplied "$label" "stub written"
}

linkEntry() {
  local label="$1"
  local repoRelativeSource="$2"
  local destination="$3"
  local outcomeVariableName="${4:-}"
  local wantedTarget="${5:-$(aliasTargetFor "$repoRelativeSource")}"
  local sourcePath="$dotfilesRepo/$repoRelativeSource"
  recordLinkOutcome "$outcomeVariableName" current
  lastBackupPath=""
  if [[ ! -e "$sourcePath" ]]; then
    noteWarned "$label" "not in repo: $repoRelativeSource"
    return 0
  fi
  if linkIsCurrent "$repoRelativeSource" "$destination" "$wantedTarget"; then
    notePresent "$label" "linked"
    return 0
  fi
  mkdir -p -- "$(dirname -- "$destination")"
  if pathIsLinkIntoThisRepo "$destination"; then
    rm -f -- "$destination"
  fi
  if [[ -e "$destination" || -L "$destination" ]]; then
    moveExistingAside "$label" "$destination"
  fi
  ln -s -- "$wantedTarget" "$destination"
  recordLinkOutcome "$outcomeVariableName" changed
  noteApplied "$label" "linked"
}

convergeProfileLink() {
  local label="$1"
  local profileRelativeSource="$2"
  local destination="$3"
  [[ -n "${profileName:-}" ]] || return 0
  local profileSource="${4:-profiles/$profileName/$profileRelativeSource}"
  if [[ -e "$dotfilesRepo/$profileSource" ]]; then
    linkEntry "$label" "$profileSource" "$destination"
    return 0
  fi
  pathIsLinkIntoThisRepo "$destination" || return 0
  rm -f -- "$destination"
  noteApplied "$label" "retired link removed"
}
