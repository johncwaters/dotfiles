#!/usr/bin/env bash
if [[ -z "${dotfilesRepo:-}" ]]; then
  # shellcheck source=../script/lib/context.sh
  source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../script/lib" && pwd)/context.sh"
  requireAliasResolvesToRepo
fi
# shellcheck source=../script/lib/packages.sh
source "$dotfilesRepo/script/lib/packages.sh"

flameshotSavePathWrapper="$HOME/.local/bin/flameshot-save-path"

cosmicScreenshotShortcutLine() {
  case "$1" in
    clipboard)
      printf '    (modifiers: [], key: "Print"): Spawn("env XDG_CURRENT_DESKTOP=sway flameshot gui --accept-on-select --clipboard"),\n'
      return 0
      ;;
    save-path)
      printf '    (modifiers: [Ctrl], key: "g"): Spawn("%s"),\n' "$flameshotSavePathWrapper"
      return 0
      ;;
  esac
  return 1
}

cosmicShortcutExists() {
  local customShortcutsPath="$1"
  local shortcutPrefix="$2"
  local shortcutLine
  local shortcutLineWithoutIndent
  while IFS= read -r shortcutLine || [[ -n "$shortcutLine" ]]; do
    shortcutLineWithoutIndent="${shortcutLine#"${shortcutLine%%[![:space:]]*}"}"
    if [[ "$shortcutLineWithoutIndent" == "$shortcutPrefix"* ]]; then
      return 0
    fi
  done < "$customShortcutsPath"
  return 1
}

# A redirect onto a symlink writes through it, so the shortcuts file is staged and renamed.
commitShortcutsFile() {
  local stagedPath="$1"
  local customShortcutsPath="$2"
  if [[ -e "$customShortcutsPath" ]]; then
    local existingMode
    existingMode="$(stat -c %a -- "$customShortcutsPath" 2>/dev/null || stat -f %Lp -- "$customShortcutsPath")"
    chmod "$existingMode" "$stagedPath"
    mv -f -- "$stagedPath" "$customShortcutsPath"
    return 0
  fi
  chmod 644 "$stagedPath"
  mv -f -- "$stagedPath" "$customShortcutsPath"
}

writeCosmicScreenshotShortcuts() {
  local customShortcutsPath="$1"
  local stagedPath
  stagedPath="$(mktemp "$(dirname -- "$customShortcutsPath")/.dotfiles-shortcuts.XXXXXX")"
  {
    printf '{\n'
    cosmicScreenshotShortcutLine clipboard
    cosmicScreenshotShortcutLine save-path
    printf '}\n'
  } > "$stagedPath"
  commitShortcutsFile "$stagedPath" "$customShortcutsPath"
  noteApplied "COSMIC screenshot shortcuts" "created"
}

mergeCosmicScreenshotShortcuts() {
  local customShortcutsPath="$1"
  local shouldAddClipboard=0
  local shouldAddSavePath=0
  local temporaryShortcutsPath
  local clipboardLine
  local savePathLine
  if ! cosmicShortcutExists "$customShortcutsPath" '(modifiers: [], key: "Print")'; then
    shouldAddClipboard=1
  fi
  if ! cosmicShortcutExists "$customShortcutsPath" '(modifiers: [Ctrl], key: "g")'; then
    shouldAddSavePath=1
  fi
  if ((shouldAddClipboard == 0 && shouldAddSavePath == 0)); then
    notePresent "COSMIC screenshot shortcuts" "already present"
    return 0
  fi
  if ! grep -Eq '^[[:space:]]*}[[:space:]]*$' "$customShortcutsPath"; then
    noteWarned "COSMIC screenshot shortcuts" "custom file has no closing brace"
    return 0
  fi
  clipboardLine="$(cosmicScreenshotShortcutLine clipboard)"
  savePathLine="$(cosmicScreenshotShortcutLine save-path)"
  temporaryShortcutsPath="$(mktemp "${TMPDIR:-/tmp}/dotfiles-cosmic-shortcuts.XXXXXX")"
  # RON leaves the last comma optional, so appending after one turns the map into a syntax error.
  if ! awk -v shouldAddClipboard="$shouldAddClipboard" -v shouldAddSavePath="$shouldAddSavePath" \
    -v clipboardLine="$clipboardLine" -v savePathLine="$savePathLine" '
    inserted == 1 { print; next }
    /^[[:space:]]*}[[:space:]]*$/ {
      lastFieldIndex = 0
      for (lineIndex = 1; lineIndex <= bufferedCount; lineIndex++) {
        if (bufferedLines[lineIndex] ~ /[^[:space:]]/ && bufferedLines[lineIndex] !~ /^[[:space:]]*\/\//) {
          lastFieldIndex = lineIndex
        }
      }
      if (lastFieldIndex > 0 && bufferedLines[lastFieldIndex] !~ /[,{][[:space:]]*$/) {
        bufferedLines[lastFieldIndex] = bufferedLines[lastFieldIndex] ","
      }
      for (lineIndex = 1; lineIndex <= bufferedCount; lineIndex++) print bufferedLines[lineIndex]
      if (shouldAddClipboard == 1) print clipboardLine
      if (shouldAddSavePath == 1) print savePathLine
      inserted = 1
      print
      next
    }
    { bufferedLines[++bufferedCount] = $0 }
    END {
      if (inserted == 0) {
        for (lineIndex = 1; lineIndex <= bufferedCount; lineIndex++) print bufferedLines[lineIndex]
      }
    }
  ' "$customShortcutsPath" > "$temporaryShortcutsPath"; then
    noteWarned "COSMIC screenshot shortcuts" "merge failed, custom file left alone"
    rm -f -- "$temporaryShortcutsPath"
    return 0
  fi
  commitShortcutsFile "$temporaryShortcutsPath" "$customShortcutsPath"
  noteApplied "COSMIC screenshot shortcuts" "merged"
}

installCosmicScreenshotShortcuts() {
  local cosmicConfigDirectory="$HOME/.config/cosmic"
  local shortcutDirectory="$cosmicConfigDirectory/com.system76.CosmicSettings.Shortcuts/v1"
  local customShortcutsPath="$shortcutDirectory/custom"
  if [[ ! -d "$cosmicConfigDirectory" ]]; then
    notePresent "COSMIC screenshot shortcuts" "COSMIC unavailable"
    return 0
  fi
  mkdir -p -- "$shortcutDirectory"
  if ! clearDestinationIfNotPlainFile "COSMIC screenshot shortcuts" "$customShortcutsPath"; then
    return 0
  fi
  if [[ ! -f "$customShortcutsPath" ]]; then
    writeCosmicScreenshotShortcuts "$customShortcutsPath"
    return 0
  fi
  mergeCosmicScreenshotShortcuts "$customShortcutsPath"
}

installPackageTool "Flameshot" "flameshot" "flameshot"
installPackageTool "wl-clipboard" "wl-copy" "wl-clipboard"
linkEntry "flameshot save-path wrapper" "screenshot/flameshot-save-path" "$flameshotSavePathWrapper"
linkEntry "Flameshot autostart" "screenshot/Flameshot.desktop" "$HOME/.config/autostart/Flameshot.desktop"
installCosmicScreenshotShortcuts

finishTopic
