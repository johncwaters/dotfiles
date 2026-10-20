#!/usr/bin/env bash
if [[ -z "${dotfilesRepo:-}" ]]; then
  # shellcheck source=../script/lib/context.sh
  source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../script/lib" && pwd)/context.sh"
  requireAliasResolvesToRepo
fi

disableDefaultsFlag() {
  local noteLabel="$1"
  local domainName="$2"
  local valueKey="$3"
  if [[ "$(defaults read "$domainName" "$valueKey" 2>/dev/null)" == "0" ]]; then
    notePresent "$noteLabel" "off"
    return 0
  fi
  if ! defaults write "$domainName" "$valueKey" -bool false; then
    noteWarned "$noteLabel" "defaults write failed"
    return 1
  fi
  noteApplied "$noteLabel" "turned off"
}

if ! isDarwin; then
  finishTopic
fi

disableDefaultsFlag "reopen windows at login" com.apple.loginwindow TALLogoutSavingState
disableDefaultsFlag "relaunch apps at login" com.apple.loginwindow LoginwindowLaunchesRelaunchApps
disableDefaultsFlag "app window restore" NSGlobalDomain NSQuitAlwaysKeepsWindows

wallpaperPath="$HOME/Pictures/Wallpapers/posthog-dynamic.heic"
linkEntry "wallpaper file" "desktop/posthog-dynamic.heic" "$wallpaperPath"
desktopPictures="$(osascript -e 'tell application "System Events" to get picture of every desktop' 2>/dev/null)"
if [[ -n "$desktopPictures" && "${desktopPictures//"$wallpaperPath"/}" =~ ^[,[:space:]]*$ ]]; then
  notePresent "wallpaper" "set"
  finishTopic
fi
if ! osascript -e "tell application \"System Events\" to tell every desktop to set picture to \"$wallpaperPath\"" >/dev/null; then
  noteWarned "wallpaper" "osascript set failed, allow Automation for System Events"
  finishTopic
fi
noteApplied "wallpaper" "set"
finishTopic
