#!/usr/bin/env bash

set -euo pipefail

topicDir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repoRoot="$(cd -- "$topicDir/.." && pwd)"
# shellcheck source=../test/harness.sh
source "$repoRoot/test/harness.sh"

startStubbedSandbox "desktop"
linkCoreUtilities awk bash dirname cat mkdir mv ln readlink printf rm
writeStub defaults <<'STUB'
#!/usr/bin/env bash
printf 'defaults %s\n' "$*" >> "$DOTFILES_TEST_LOG"
[[ "$1" != "-currentHost" ]] || shift
valuePath="$DOTFILES_TEST_STATE/defaults/$2/$3"
case "$1" in
  read) [[ -f "$valuePath" ]] && cat "$valuePath" ;;
  write)
    [[ ! -f "$DOTFILES_TEST_STATE/defaults-write-fails" ]] || exit 1
    storedValue="$5"
    if [[ "$4" == "-bool" ]]; then
      case "$5" in
        true | yes) storedValue=1 ;;
        false | no) storedValue=0 ;;
        *) exit 1 ;;
      esac
    fi
    mkdir -p "${valuePath%/*}" && printf '%s\n' "$storedValue" > "$valuePath"
    ;;
  *) exit 1 ;;
esac
STUB
writeStub osascript <<'STUB'
#!/usr/bin/env bash
printf 'osascript %s\n' "$*" >> "$DOTFILES_TEST_LOG"
picturePath="$DOTFILES_TEST_STATE/desktop-picture"
if [[ "$2" == *"get picture"* ]]; then
  [[ -f "$picturePath" ]] && cat "$picturePath"
  exit 0
fi
[[ "$2" =~ set\ picture\ to\ \"([^\"]+)\" ]] || exit 1
printf '%s, %s\n' "${BASH_REMATCH[1]}" "${BASH_REMATCH[1]}" > "$picturePath"
STUB
writeStub pmset <<'STUB'
#!/usr/bin/env bash
printf 'pmset %s\n' "$*" >> "$DOTFILES_TEST_LOG"
if [[ "$1" == "-g" ]]; then
  printf 'Battery Power:\n displaysleep         2\n sleep                1\nAC Power:\n displaysleep         %s\n sleep                %s\n' \
    "$(cat "$DOTFILES_TEST_STATE/ac-displaysleep")" "$(cat "$DOTFILES_TEST_STATE/ac-sleep")"
  exit 0
fi
printf '%s\n' "$3" > "$DOTFILES_TEST_STATE/ac-$2"
STUB
writeStub plutil <<'STUB'
#!/usr/bin/env bash
printf 'plutil %s\n' "$*" >> "$DOTFILES_TEST_LOG"
valuePath="$DOTFILES_TEST_STATE/plutil/$2"
case "$1" in
  -create) : > "$3" ;;
  -insert) (($# < 5)) || printf '%s=%s\n' "$2" "$4" >> "$5" ;;
  -extract)
    if [[ "${@: -1}" == - ]]; then
      sed -n "s|^$2=||p"
      exit 0
    fi
    [[ -f "$valuePath" ]] && cat "$valuePath"
    ;;
  -replace) mkdir -p "${valuePath%/*}" && printf '%s\n' "$4" > "$valuePath" ;;
  *) exit 1 ;;
esac
STUB
writeStub killall <<'STUB'
#!/usr/bin/env bash
printf 'killall %s\n' "$*" >> "$DOTFILES_TEST_LOG"
STUB
provideCommand defaults
provideCommand osascript
provideCommand pmset
provideCommand plutil
provideCommand killall
linkCoreUtilities base64 mktemp sed cp cmp chmod
wallpaperStorePath="$sandbox/Library/Application Support/com.apple.wallpaper/Store/Index.plist"
mkdir -p "${wallpaperStorePath%/*}"
: > "$wallpaperStorePath"
idleChoiceState="$stubState/plutil/AllSpacesAndDisplays.Idle.Content.Choices.0"
writeContainedSudoStub
writeDarwinDirectoryServiceStub "$stubBin"
printf '10\n' > "$stubState/ac-displaysleep"
printf '0\n' > "$stubState/ac-sleep"
mkdir -p "$stubState/defaults/com.apple.loginwindow"
printf '1\n' > "$stubState/defaults/com.apple.loginwindow/TALLogoutSavingState"

runInstallOn() {
  runInStubbedSandbox "$sandbox" DOTFILES_PLATFORM="$1" DOTFILES_PROFILE=work NO_COLOR=1 \
    bash "$topicDir/install.sh"
}

printf '\ndesktop topic\n'

firstRunStatus=0
runInstallOn darwin >/dev/null || firstRunStatus=$?
check "darwin install exits clean" test "$firstRunStatus" -eq 0
for disabledFlag in com.apple.loginwindow/TALLogoutSavingState \
  com.apple.loginwindow/LoginwindowLaunchesRelaunchApps NSGlobalDomain/NSQuitAlwaysKeepsWindows; do
  check "darwin turns off $disabledFlag" grep -qx 0 "$stubState/defaults/$disabledFlag"
done
wallpaperPath="$sandbox/Pictures/Wallpapers/posthog-clock.heic"
check "darwin copies the wallpaper as a plain file" bash -c 'test -f "$1" && ! test -L "$1"' _ "$wallpaperPath"
check "darwin sets the wallpaper on every desktop" \
  grep -qx "$wallpaperPath, $wallpaperPath" "$stubState/desktop-picture"
check "darwin shows the wallpaper as the screensaver" \
  grep -qx com.apple.wallpaper.choice.image "$idleChoiceState.Provider"
check "darwin points the screensaver at the copied wallpaper" \
  bash -c 'base64 -d < "$1" | grep -qxF "url.relative=file://$2"' _ "$idleChoiceState.Configuration" "$wallpaperPath"
check "darwin starts the screensaver after 10 minutes" \
  grep -qx 600 "$stubState/defaults/com.apple.screensaver/idleTime"
check "darwin sets display sleep on power to 60 minutes as root" \
  grep -qE -- '^sudo -n [^ ]*/pmset -c displaysleep 60$' "$commandLog"
check "darwin lets the Mac sleep on power once the display sleeps, as root" \
  grep -qE -- '^sudo -n [^ ]*/pmset -c sleep 1$' "$commandLog"

: > "$commandLog"
checkRerunIsQuiet "a darwin rerun reports no changes" "$(runInstallOn darwin)"
check "a darwin rerun writes no defaults" logLacks ' write '
check "a darwin rerun sets no wallpaper" logLacks 'set picture'
check "a darwin rerun runs no sudo" logLacks 'sudo '
check "a darwin rerun restarts no WallpaperAgent" logLacks 'killall'

rm -f "$wallpaperPath"
ln -s "$topicDir/posthog-clock.heic" "$wallpaperPath"
: > "$commandLog"
runInstallOn darwin >/dev/null
check "replacing the old wallpaper symlink restarts WallpaperAgent" logHas 'killall WallpaperAgent'
check "replacing the old wallpaper symlink leaves a plain file" bash -c 'test -f "$1" && ! test -L "$1"' _ "$wallpaperPath"

rm -f "$stubState/defaults/NSGlobalDomain/NSQuitAlwaysKeepsWindows"
: > "$stubState/defaults-write-fails"
failedWriteStatus=0
runInstallOn darwin >/dev/null || failedWriteStatus=$?
check "a failed defaults write fails the topic" test "$failedWriteStatus" -ne 0
rm -f "$stubState/defaults-write-fails"

: > "$commandLog"
checkRerunIsQuiet "linux reports no changes" "$(runInstallOn linux)"
check "linux never touches defaults" logLacks 'defaults '

reportTopicResults "desktop"
