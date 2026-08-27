# shellcheck shell=bash

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

moveExistingAside() {
  local label="$1"
  local destination="$2"
  local backupPath
  backupPath="$(nextBackupPath "$destination")"
  mv -- "$destination" "$backupPath"
  noteApplied "$label backup" "saved $(basename -- "$backupPath")"
}

symlinkPointsIntoThisRepo() {
  case "$1" in
    "$dotfilesAlias" | "$dotfilesAlias"/* | "$dotfilesRepo" | "$dotfilesRepo"/*) return 0 ;;
  esac
  return 1
}

linkEntry() {
  local label="$1"
  local repoRelativeSource="$2"
  local destination="$3"
  local sourcePath="$dotfilesRepo/$repoRelativeSource"
  if [[ ! -e "$sourcePath" ]]; then
    noteWarned "$label" "not in repo: $repoRelativeSource"
    return 0
  fi
  local wantedTarget
  wantedTarget="$(aliasTargetFor "$repoRelativeSource")"
  if [[ -L "$destination" ]] && [[ "$(symlinkTargetOf "$destination")" == "$wantedTarget" ]]; then
    notePresent "$label" "linked"
    return 0
  fi
  mkdir -p -- "$(dirname -- "$destination")"
  if [[ -L "$destination" ]] && symlinkPointsIntoThisRepo "$(symlinkTargetOf "$destination")"; then
    rm -f -- "$destination"
  fi
  if [[ -e "$destination" || -L "$destination" ]]; then
    moveExistingAside "$label" "$destination"
  fi
  ln -s -- "$wantedTarget" "$destination"
  noteApplied "$label" "linked"
}
