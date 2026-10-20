#!/usr/bin/env bash
if [[ -z "${dotfilesRepo:-}" ]]; then
  # shellcheck source=../script/lib/context.sh
  source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../script/lib" && pwd)/context.sh"
  requireAliasResolvesToRepo
fi
# shellcheck source=../script/lib/packages.sh
source "$dotfilesRepo/script/lib/packages.sh"

convergeDefaultsValue() {
  local noteLabel="$1"
  local valueType="$2"
  local writtenValue="$3"
  local expectedReadBack="$4"
  local domainName="$5"
  local valueKey="$6"
  local hostScope=("${@:7}")
  if [[ "$(defaults "${hostScope[@]}" read "$domainName" "$valueKey" 2>/dev/null)" == "$expectedReadBack" ]]; then
    notePresent "$noteLabel" "$expectedReadBack"
    return 0
  fi
  if ! defaults "${hostScope[@]}" write "$domainName" "$valueKey" "$valueType" "$writtenValue"; then
    noteWarned "$noteLabel" "defaults write failed"
    return 1
  fi
  noteApplied "$noteLabel" "set to $expectedReadBack"
}

convergeAcDisplaySleep() {
  local wantedMinutes="$1"
  local acDisplaySleepMinutes
  acDisplaySleepMinutes="$(pmset -g custom | awk '/^AC Power:/ { onAcBlock = 1; next } /^[^ ]/ { onAcBlock = 0 } onAcBlock && $1 == "displaysleep" { print $2 }')"
  if [[ "$acDisplaySleepMinutes" == "$wantedMinutes" ]]; then
    notePresent "display sleep on power" "$wantedMinutes min"
    return 0
  fi
  if ! runPackageManagerCommand pmset -c displaysleep "$wantedMinutes" >/dev/null 2>&1; then
    noteWarned "display sleep on power" "run: sudo pmset -c displaysleep $wantedMinutes"
    return 0
  fi
  noteApplied "display sleep on power" "$wantedMinutes min"
}

if ! isDarwin; then
  finishTopic
fi

convergeDefaultsValue "reopen windows at login" -bool false 0 com.apple.loginwindow TALLogoutSavingState
convergeDefaultsValue "relaunch apps at login" -bool false 0 com.apple.loginwindow LoginwindowLaunchesRelaunchApps
convergeDefaultsValue "app window restore" -bool false 0 NSGlobalDomain NSQuitAlwaysKeepsWindows
convergeDefaultsValue "screensaver idle time" -int 600 600 com.apple.screensaver idleTime -currentHost
convergeAcDisplaySleep 60

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
