# shellcheck shell=bash

refreshUserDesktopAssets() {
  if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database "$HOME/.local/share/applications" >/dev/null 2>&1 \
      || noteWarned "desktop database" "refresh failed"
  fi
  if command -v gtk-update-icon-cache >/dev/null 2>&1; then
    gtk-update-icon-cache -f -t "$HOME/.local/share/icons/hicolor" >/dev/null 2>&1 \
      || noteWarned "icon cache" "refresh failed"
  fi
}

copyExportedAsset() {
  local label="$1"
  local source="$2"
  local destination="$3"
  local stagedPath
  if ! pathIsPlainFileOrAbsent "$destination"; then
    noteWarned "$label" "not a regular file, leaving it alone: $destination"
    return 1
  fi
  # Backing up what this engine itself wrote grows a .bak per flatpak update, forever.
  if destinationHoldsHandEdits "$destination"; then
    local backupPath
    backupPath="$(nextBackupPath "$destination")"
    mv -- "$destination" "$backupPath"
    noteApplied "$label backup" "saved $(basename -- "$backupPath")"
  fi
  stagedPath="$(mktemp "$(dirname -- "$destination")/.dotfiles-export.XXXXXX")"
  cp -f -- "$source" "$stagedPath"
  mv -f -- "$stagedPath" "$destination"
  recordRenderedCopy "$label" "$destination"
}

exportFlatpakLauncherAssets() {
  local label="$1"
  local appId="$2"
  local exportShare="$HOME/.local/share/flatpak/exports/share"
  local desktopSource="$exportShare/applications/$appId.desktop"
  local desktopDestination="$HOME/.local/share/applications/$appId.desktop"
  local iconSource
  local iconDestination
  local iconRelativePath
  local hasExportedAsset=0
  if [[ ! -f "$desktopSource" ]]; then
    noteWarned "$label launcher" "flatpak desktop export missing"
    return 0
  fi
  mkdir -p -- "$HOME/.local/share/applications" "$HOME/.local/share/icons/hicolor"
  if pathIsPlainFileOrAbsent "$desktopDestination" \
    && filesAreIdentical "$desktopSource" "$desktopDestination"; then
    recordRenderedCopy "$label launcher" "$desktopDestination"
  fi
  if ! pathIsPlainFileOrAbsent "$desktopDestination" \
    || ! filesAreIdentical "$desktopSource" "$desktopDestination"; then
    if copyExportedAsset "$label launcher" "$desktopSource" "$desktopDestination"; then
      hasExportedAsset=1
    fi
  fi
  local iconRoot="$exportShare/icons/hicolor"
  local iconFiles=()
  mapfile -t iconFiles < <(find -L "$iconRoot" -type f -path "*/apps/$appId.*" 2>/dev/null)
  if ((${#iconFiles[@]} == 0)); then
    iconRoot="$HOME/.local/share/flatpak/app/$appId/current/active/files/share/icons/hicolor"
    mapfile -t iconFiles < <(find -L "$iconRoot" -type f -path "*/apps/$appId.*" 2>/dev/null)
  fi
  for iconSource in ${iconFiles[@]+"${iconFiles[@]}"}; do
    iconRelativePath="hicolor/${iconSource#"$iconRoot/"}"
    iconDestination="$HOME/.local/share/icons/$iconRelativePath"
    mkdir -p -- "$(dirname -- "$iconDestination")"
    if pathIsPlainFileOrAbsent "$iconDestination" && filesAreIdentical "$iconSource" "$iconDestination"; then
      recordRenderedCopy "$label icon" "$iconDestination"
      continue
    fi
    if copyExportedAsset "$label icon" "$iconSource" "$iconDestination"; then
      hasExportedAsset=1
    fi
  done
  if ((${#iconFiles[@]} == 0)); then
    noteWarned "$label icons" "flatpak icon export missing"
  fi
  refreshUserDesktopAssets
  if ((hasExportedAsset == 1)); then
    noteApplied "$label launcher" "exported"
    return 0
  fi
  notePresent "$label launcher" "already exported"
}

installFlatpakApp() {
  local label="$1"
  local appId="$2"
  if ! command -v flatpak >/dev/null 2>&1; then
    noteWarned "$label" "flatpak not on PATH, install manually"
    return 0
  fi
  if flatpak info --user "$appId" >/dev/null 2>&1; then
    notePresent "$label" "already installed"
    exportFlatpakLauncherAssets "$label" "$appId"
    return 0
  fi
  if flatpak info "$appId" >/dev/null 2>&1; then
    notePresent "$label" "installed system-wide, launcher export skipped"
    return 0
  fi
  noteStarting "$label" "installing via flatpak"
  if ! flatpak remote-add --user --if-not-exists flathub https://dl.flathub.org/repo/flathub.flatpakrepo >/dev/null 2>&1; then
    noteWarned "$label" "flathub remote setup failed"
    return 0
  fi
  if ! flatpak install --user -y flathub "$appId" >/dev/null 2>&1; then
    noteWarned "$label" "flatpak install failed"
    return 0
  fi
  noteInstalled "$label" "installed"
  exportFlatpakLauncherAssets "$label" "$appId"
}
