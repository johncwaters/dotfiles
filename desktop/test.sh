#!/usr/bin/env bash

set -euo pipefail

topicDir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repoRoot="$(cd -- "$topicDir/.." && pwd)"
# shellcheck source=../test/harness.sh
source "$repoRoot/test/harness.sh"

startStubbedSandbox "desktop"
linkCoreUtilities bash dirname cat mkdir printf rm
writeStub defaults <<'STUB'
#!/usr/bin/env bash
printf 'defaults %s\n' "$*" >> "$DOTFILES_TEST_LOG"
valuePath="$DOTFILES_TEST_STATE/defaults/$2/$3"
case "$1" in
  read) [[ -f "$valuePath" ]] && cat "$valuePath" ;;
  write)
    [[ ! -f "$DOTFILES_TEST_STATE/defaults-write-fails" ]] || exit 1
    mkdir -p "${valuePath%/*}" && printf '0\n' > "$valuePath"
    ;;
  *) exit 1 ;;
esac
STUB
provideCommand defaults
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

: > "$commandLog"
checkRerunIsQuiet "a darwin rerun reports no changes" "$(runInstallOn darwin)"
check "a darwin rerun writes no defaults" logLacks ' write '

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
