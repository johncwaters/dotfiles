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

convergeAcPowerSetting() {
  local noteLabel="$1"
  local settingKey="$2"
  local wantedMinutes="$3"
  local currentMinutes
  currentMinutes="$(pmset -g custom | awk -v settingKey="$settingKey" '/^AC Power:/ { onAcBlock = 1; next } /^[^ ]/ { onAcBlock = 0 } onAcBlock && $1 == settingKey { print $2 }')"
  if [[ "$currentMinutes" == "$wantedMinutes" ]]; then
    notePresent "$noteLabel" "$wantedMinutes min"
    return 0
  fi
  if ! runPackageManagerCommand pmset -c "$settingKey" "$wantedMinutes" >/dev/null 2>&1; then
    noteWarned "$noteLabel" "run: sudo pmset -c $settingKey $wantedMinutes"
    return 0
  fi
  noteApplied "$noteLabel" "$wantedMinutes min"
}

imageChoiceConfigurationBase64() {
  local configurationPath
  configurationPath="$(mktemp)"
  plutil -create binary1 "$configurationPath" &&
    plutil -insert type -string imageFile "$configurationPath" &&
    plutil -insert url -dictionary "$configurationPath" &&
    plutil -insert url.relative -string "file://$1" "$configurationPath" &&
    base64 < "$configurationPath"
  local buildStatus=$?
  rm -f "$configurationPath"
  return "$buildStatus"
}

# The idle entry for all displays is what ScreenSaverEngine shows; macOS rewrites the per-display ones itself.
convergeScreensaverPicture() {
  local wallpaperStorePath="$HOME/Library/Application Support/com.apple.wallpaper/Store/Index.plist"
  local idleChoiceKeyPath="AllSpacesAndDisplays.Idle.Content.Choices.0"
  local wantedConfiguration
  if [[ ! -f "$wallpaperStorePath" ]]; then
    noteWarned "screensaver picture" "no wallpaper store yet; rerun after logging in once"
    return 0
  fi
  # WallpaperAgent re-encodes the configuration blob, so compare its decoded url, never its bytes.
  if [[ "$(plutil -extract "$idleChoiceKeyPath.Provider" raw -o - "$wallpaperStorePath" 2>/dev/null)" == com.apple.wallpaper.choice.image &&
    "$(plutil -extract "$idleChoiceKeyPath.Configuration" raw -o - "$wallpaperStorePath" 2>/dev/null |
      base64 -d | plutil -extract url.relative raw -o - - 2>/dev/null)" == "file://$1" ]]; then
    notePresent "screensaver picture" "wallpaper"
    return 0
  fi
  if ! wantedConfiguration="$(imageChoiceConfigurationBase64 "$1")"; then
    noteWarned "screensaver picture" "plutil could not build the image choice"
    return 0
  fi
  if ! plutil -replace "$idleChoiceKeyPath.Provider" -string com.apple.wallpaper.choice.image "$wallpaperStorePath" ||
    ! plutil -replace "$idleChoiceKeyPath.Configuration" -data "$wantedConfiguration" "$wallpaperStorePath"; then
    noteWarned "screensaver picture" "plutil could not edit $wallpaperStorePath"
    return 0
  fi
  wallpaperAgentNeedsRestart=1
  noteApplied "screensaver picture" "wallpaper"
}

if ! isDarwin; then
  finishTopic
fi

convergeDefaultsValue "reopen windows at login" -bool false 0 com.apple.loginwindow TALLogoutSavingState
convergeDefaultsValue "relaunch apps at login" -bool false 0 com.apple.loginwindow LoginwindowLaunchesRelaunchApps
convergeDefaultsValue "app window restore" -bool false 0 NSGlobalDomain NSQuitAlwaysKeepsWindows
convergeDefaultsValue "screensaver idle time" -int 600 600 com.apple.screensaver idleTime -currentHost
convergeAcPowerSetting "display sleep on power" displaysleep 60
convergeAcPowerSetting "system sleep on power" sleep 1

wallpaperPath="$HOME/Pictures/Wallpapers/posthog-clock.heic"
wallpaperAgentNeedsRestart=0
if [[ -L "$wallpaperPath" ]] || ! filesAreIdentical "$dotfilesRepo/desktop/posthog-clock.heic" "$wallpaperPath"; then
  wallpaperAgentNeedsRestart=1
fi
# WallpaperImageExtension ignores the h24 schedule of a symlinked HEIC and shows frame 0 all day.
copyEntry "wallpaper file" "desktop/posthog-clock.heic" "$wallpaperPath"
convergeScreensaverPicture "$wallpaperPath"
if ((wallpaperAgentNeedsRestart == 1)); then
  killall WallpaperAgent 2>/dev/null || true
fi
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
