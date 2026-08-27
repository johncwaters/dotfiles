# shellcheck shell=bash

filesAreIdentical() {
  if [[ ! -f "$1" || ! -f "$2" ]]; then
    return 1
  fi
  cmp -s -- "$1" "$2"
}

# mv onto a directory or a symlink writes inside it or through it, so anything that is
# not a plain file has to leave before the rendered file can take the name.
clearDestinationForRender() {
  local label="$1"
  local destination="$2"
  if [[ ! -L "$destination" ]] && { [[ ! -e "$destination" ]] || [[ -f "$destination" ]]; }; then
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
  if ! clearDestinationForRender "$label sidecar" "$copyPath"; then
    return 0
  fi
  local stagedPath
  stagedPath="$(mktemp "$(dirname -- "$copyPath")/.dotfiles-sidecar.XXXXXX")"
  cp -f -- "$destination" "$stagedPath"
  chmod 600 -- "$stagedPath"
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
  if [[ -L "$copyPath" ]] || { [[ -e "$copyPath" ]] && [[ ! -f "$copyPath" ]]; }; then
    return 0
  fi
  ! filesAreIdentical "$destination" "$copyPath"
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
  if ! clearDestinationForRender "$label" "$destination"; then
    rm -f -- "$renderedPath"
    return 0
  fi
  if filesAreIdentical "$renderedPath" "$destination"; then
    rm -f -- "$renderedPath"
    chmod 600 -- "$destination"
    recordRenderedCopy "$label" "$destination"
    notePresent "$label" "up to date"
    return 0
  fi
  if destinationHoldsHandEdits "$destination"; then
    local backupPath
    backupPath="$(nextBackupPath "$destination")"
    cp -f -- "$destination" "$backupPath"
    noteApplied "$label backup" "saved $(basename -- "$backupPath")"
  fi
  mv -f -- "$renderedPath" "$destination"
  chmod 600 -- "$destination"
  recordRenderedCopy "$label" "$destination"
  noteApplied "$label" "rendered"
}
