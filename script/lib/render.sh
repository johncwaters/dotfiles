# shellcheck shell=bash

filesAreIdentical() {
  if [[ ! -f "$1" || ! -f "$2" ]]; then
    return 1
  fi
  cmp -s -- "$1" "$2"
}

# An unterminated last line swallows whatever gets appended into the value it holds.
terminateFinalLine() {
  local filePath="$1"
  if [[ -s "$filePath" ]] && [[ -n "$(tail -c 1 -- "$filePath")" ]]; then
    printf '\n' >> "$filePath"
  fi
}

clearDestinationIfNotPlainFile() {
  local label="$1"
  local destination="$2"
  if pathIsPlainFileOrAbsent "$destination"; then
    return 0
  fi
  local displacedPath
  displacedPath="$(nextBackupPath "$destination")"
  if ! mv -- "$destination" "$displacedPath" 2>/dev/null; then
    noteWarned "$label" "cannot move aside $destination"
    return 1
  fi
  noteApplied "$label backup" "saved $(basename -- "$displacedPath")"
}

# The sidecar keeps what this engine last wrote, so only a hand edit earns a backup.
renderedCopyPath() {
  printf '%s\n' "$1.pre-dotfiles.rendered"
}

recordRenderedCopy() {
  local label="$1"
  local destination="$2"
  local copyPath
  copyPath="$(renderedCopyPath "$destination")"
  if ! clearDestinationIfNotPlainFile "$label sidecar" "$copyPath"; then
    return 0
  fi
  local stagedPath
  stagedPath="$(mktemp "$(dirname -- "$copyPath")/.dotfiles-sidecar.XXXXXX")"
  cp -f -- "$destination" "$stagedPath"
  chmod 600 "$stagedPath"
  mv -f -- "$stagedPath" "$copyPath"
}

# A sidecar that is not a plain file proves nothing, so the destination counts as edited.
destinationHoldsHandEdits() {
  local destination="$1"
  if [[ ! -f "$destination" ]]; then
    return 1
  fi
  local copyPath
  copyPath="$(renderedCopyPath "$destination")"
  if ! pathIsPlainFileOrAbsent "$copyPath"; then
    return 0
  fi
  ! filesAreIdentical "$destination" "$copyPath"
}

# Renames only when the staged file differs, so an unchanged destination keeps its inode; zero means the destination changed.
commitRenderedFile() {
  local label="$1"
  local stagedPath="$2"
  local destination="$3"
  if filesAreIdentical "$stagedPath" "$destination"; then
    rm -f -- "$stagedPath"
    recordRenderedCopy "$label" "$destination"
    return 1
  fi
  if destinationHoldsHandEdits "$destination"; then
    local backupPath
    backupPath="$(nextBackupPath "$destination")"
    cp -f -- "$destination" "$backupPath"
    noteApplied "$label backup" "saved $(basename -- "$backupPath")"
  fi
  mv -f -- "$stagedPath" "$destination"
  recordRenderedCopy "$label" "$destination"
}

# Sets stagedFileChangedDestination rather than returning it, so a set -e caller survives an unchanged file.
commitStagedFile() {
  local label="$1"
  local stagedPath="$2"
  local destination="$3"
  local appliedVerb="$4"
  stagedFileChangedDestination=0
  if commitRenderedFile "$label" "$stagedPath" "$destination"; then
    stagedFileChangedDestination=1
  fi
  chmod 600 "$destination"
  if ((stagedFileChangedDestination == 1)); then
    noteApplied "$label" "$appliedVerb"
    return 0
  fi
  notePresent "$label" "up to date"
}

copyEntry() {
  local label="$1"
  local repoRelativeSource="$2"
  local destination="$3"
  local sourcePath="$dotfilesRepo/$repoRelativeSource"
  if [[ ! -f "$sourcePath" ]]; then
    noteWarned "$label" "not in repo: $repoRelativeSource"
    return 0
  fi
  mkdir -p -- "$(dirname -- "$destination")"
  if pathIsLinkIntoThisRepo "$destination"; then
    rm -f -- "$destination"
  fi
  if ! clearDestinationIfNotPlainFile "$label" "$destination"; then
    return 0
  fi
  local stagedPath
  stagedPath="$(mktemp "$(dirname -- "$destination")/.dotfiles-copy.XXXXXX")"
  cp -f -- "$sourcePath" "$stagedPath"
  commitStagedFile "$label" "$stagedPath" "$destination" "copied"
}

renderJsonTemplate() {
  local label="$1"
  local rendererPath="$2"
  local basePath="$3"
  local overlayPath="$4"
  local destination="$5"
  if ! command -v node >/dev/null 2>&1; then
    noteWarned "$label" "node not on PATH"
    return 0
  fi
  local missingInput
  for missingInput in "$rendererPath" "$basePath" "$overlayPath"; do
    if [[ ! -f "$missingInput" ]]; then
      noteWarned "$label" "missing input: $missingInput"
      return 0
    fi
  done
  local renderedPath
  local renderErrorPath
  renderedPath="$(mktemp "${TMPDIR:-/tmp}/dotfiles-render.XXXXXX")"
  renderErrorPath="$(mktemp "${TMPDIR:-/tmp}/dotfiles-render-err.XXXXXX")"
  if ! node "$rendererPath" "$basePath" "$overlayPath" "$renderedPath" 2>"$renderErrorPath"; then
    local firstErrorLine
    firstErrorLine="$(head -n 1 "$renderErrorPath" 2>/dev/null || true)"
    rm -f -- "$renderedPath" "$renderErrorPath"
    noteWarned "$label" "render failed${firstErrorLine:+: $firstErrorLine}"
    return 0
  fi
  rm -f -- "$renderErrorPath"
  mkdir -p -- "$(dirname -- "$destination")"
  if ! clearDestinationIfNotPlainFile "$label" "$destination"; then
    rm -f -- "$renderedPath"
    return 0
  fi
  commitStagedFile "$label" "$renderedPath" "$destination" "rendered"
}
