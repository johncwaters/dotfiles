#!/usr/bin/env bash

set -euo pipefail

topicDir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repoRoot="$(cd -- "$topicDir/.." && pwd)"
# shellcheck source=../test/harness.sh
source "$repoRoot/test/harness.sh"

startStubbedSandbox "dictation"

linkCoreUtilities basename bash cat chmod cp dirname env grep head ln mkdir mv readlink rm \
  touch tr true

runInstall() {
  runInStubbedSandbox "$sandbox" \
    DOTFILES_PROFILE=personal \
    USER=dictator \
    NO_COLOR=1 \
    bash "$topicDir/install.sh"
}

writeAptStubThatInstallsMappedCommands
provideCommand apt-get
mapPackageToCommands ydotool "ydotool"
mapPackageToCommands ydotoold "ydotoold"
mapPackageToCommands wl-clipboard "wl-copy"

for packagedCommand in ydotool ydotoold wl-copy; do
  writeStub "$packagedCommand" <<STUB
#!/usr/bin/env bash
printf '$packagedCommand %s\n' "\$*" >> "\$DOTFILES_TEST_LOG"
exit 0
STUB
done

writeContainedSudoStub

writeStub usermod <<'STUB'
#!/usr/bin/env bash
printf 'usermod %s\n' "$*" >> "$DOTFILES_TEST_LOG"
printf '%s\n' "$2" >> "$DOTFILES_TEST_STATE/groups-of-$3"
STUB
provideCommand usermod

# usermod writes the account database, never the groups this process started with, so an installer asking for its own groups sees the old set.
writeStub id <<'STUB'
#!/usr/bin/env bash
printf 'id %s\n' "$*" >> "$DOTFILES_TEST_LOG"
if [[ "${1:-}" == '-un' ]]; then
  printf 'dictator\n'
  exit 0
fi
if [[ "${1:-}" != '-nG' ]]; then
  exit 1
fi
if [[ -z "${2:-}" ]]; then
  printf 'wheel\n'
  exit 0
fi
accountGroupsPath="$DOTFILES_TEST_STATE/groups-of-$2"
printf 'wheel'
if [[ -f "$accountGroupsPath" ]]; then
  while IFS= read -r groupName; do
    printf ' %s' "$groupName"
  done < "$accountGroupsPath"
fi
printf '\n'
STUB
provideCommand id

writeStub systemctl <<'STUB'
#!/usr/bin/env bash
printf 'systemctl %s\n' "$*" >> "$DOTFILES_TEST_LOG"
enabledMarker="$DOTFILES_TEST_STATE/unit-enabled"
activeMarker="$DOTFILES_TEST_STATE/unit-active"
if [[ "${2:-}" == 'show' ]]; then
  [[ ! -f "$DOTFILES_TEST_STATE/user-manager-unreachable" ]]
  exit $?
fi
if [[ "${2:-}" == 'is-enabled' ]]; then
  [[ -f "$enabledMarker" ]]
  exit $?
fi
if [[ "${2:-}" == 'is-active' ]]; then
  [[ -f "$activeMarker" ]]
  exit $?
fi
if [[ "${2:-}" == 'daemon-reload' ]]; then
  exit 0
fi
if [[ "${2:-}" == 'enable' && "${3:-}" == '--now' ]]; then
  touch "$enabledMarker" "$activeMarker"
  exit 0
fi
if [[ "${2:-}" == 'restart' && -f "$DOTFILES_TEST_STATE/restart-fails" ]]; then
  exit 1
fi
if [[ "${2:-}" == 'start' || "${2:-}" == 'restart' ]]; then
  touch "$activeMarker"
  exit 0
fi
exit 1
STUB
provideCommand systemctl

servicePath="$sandbox/.config/systemd/user/ydotoold.service"
mkdir -p "$(dirname -- "$servicePath")"
printf 'foreign service\n' > "$servicePath"

printf '\ndictation topic\n'

firstRunStatus=0
firstRunOutput="$(runInstall)" || firstRunStatus=$?
check "first install exits clean" test "$firstRunStatus" -eq 0
check "the standalone installer leaves the bootstrap topic header alone" \
  bash -c '! grep -qx "  Dictation" <<< "$1"' _ "$firstRunOutput"
check "ydotool is installed through apt-get" logHas "apt-get -o DPkg::Lock::Timeout=180 install -y ydotool"
check "wl-clipboard is installed through apt-get" logHas "apt-get -o DPkg::Lock::Timeout=180 install -y wl-clipboard"
check "ydotoold is installed through apt-get" logHas "apt-get -o DPkg::Lock::Timeout=180 install -y ydotoold"
check "the service is enabled and started once" test "$(countLogLines '^systemctl --user enable --now ydotoold$')" -eq 1
check "the input group is added once" test "$(countLogLines '^usermod -aG input dictator$')" -eq 1
check "the input group notice requests a new login" grep -q 'log out and back in' <<< "$firstRunOutput"
check "group membership is read from the account, not this process" logHas "id -nG dictator"

check "the service is a symlink" test -L "$servicePath"
check "the service points through the alias" \
  test "$(readlink -- "$servicePath")" = "$sandbox/.dotfiles/dictation/ydotoold.service"
check "the service resolves through the alias" test -e "$servicePath"
check "a foreign service is backed up" test -f "$servicePath.pre-dotfiles.bak"
check "the service backup keeps its content" grep -qx 'foreign service' "$servicePath.pre-dotfiles.bak"

: > "$commandLog"
secondRunStatus=0
secondRunOutput="$(runInstall)" || secondRunStatus=$?
check "second install exits clean" test "$secondRunStatus" -eq 0
check "second install reports no changes" reportsNoChanges "$secondRunOutput"
check "second install does not enable the service" \
  test "$(countLogLines '^systemctl --user enable --now ydotoold$')" -eq 0
check "second install does not start the service" \
  test "$(countLogLines '^systemctl --user start ydotoold$')" -eq 0
check "second install does not add the input group" test "$(countLogLines '^usermod ' )" -eq 0

rm -f "$stubState/unit-enabled"
: > "$commandLog"
runningButDisabledStatus=0
runningButDisabledOutput="$(runInstall)" || runningButDisabledStatus=$?
check "a running but disabled unit still exits clean" test "$runningButDisabledStatus" -eq 0
check "a running but disabled unit gets enabled" \
  test "$(countLogLines '^systemctl --user enable --now ydotoold$')" -eq 1
check "a running but disabled unit reports the change" \
  grep -q 'enabled and started' <<< "$runningButDisabledOutput"

rm -f "$servicePath"
printf 'a unit from somewhere else\n' > "$servicePath"
: > "$commandLog"
relinkedStatus=0
relinkedOutput="$(runInstall)" || relinkedStatus=$?
check "a replaced unit exits clean" test "$relinkedStatus" -eq 0
check "a replaced unit is reloaded" test "$(countLogLines '^systemctl --user daemon-reload$')" -eq 1
check "a replaced unit restarts the running process" \
  test "$(countLogLines '^systemctl --user restart ydotoold$')" -eq 1
check "a replaced unit reports the restart" grep -q 'restarted' <<< "$relinkedOutput"

unitContentRecord="$sandbox/.local/state/dotfiles/systemd-ydotoold.service-record"
check "the linked unit's content is fingerprinted" test -f "$unitContentRecord"
printf 'a fingerprint from the unit file this repo used to ship\n' > "$unitContentRecord"
: > "$commandLog"
changedBehindLinkOutput="$(runInstall)" || true
check "a unit changed behind an unchanged link is reloaded" \
  test "$(countLogLines '^systemctl --user daemon-reload$')" -eq 1
check "a unit changed behind an unchanged link is restarted" \
  test "$(countLogLines '^systemctl --user restart ydotoold$')" -eq 1
check "the reload behind the link is reported" grep -q 'restarted' <<< "$changedBehindLinkOutput"
check "the new content is fingerprinted in turn" \
  bash -c '! grep -q "used to ship" "$1"' _ "$unitContentRecord"

: > "$commandLog"
refingerprintedOutput="$(runInstall)" || true
check "the run after a content change reports no change" reportsNoChanges "$refingerprintedOutput"
check "the run after a content change reloads nothing" \
  test "$(countLogLines '^systemctl --user daemon-reload$')" -eq 0

rm -f "$servicePath" "$stubState/unit-enabled"
printf 'a unit that is running but no longer enabled\n' > "$servicePath"
: > "$commandLog"
runInstall > /dev/null || true
check "a changed unit that is running but disabled is enabled" \
  test "$(countLogLines '^systemctl --user enable --now ydotoold$')" -eq 1
check "a changed unit that is running but disabled is also restarted" \
  test "$(countLogLines '^systemctl --user restart ydotoold$')" -eq 1

touch "$stubState/restart-fails"
rm -f "$servicePath"
printf 'a unit whose restart will fail\n' > "$servicePath"
: > "$commandLog"
failedRestartStatus=0
failedRestartOutput="$(runInstall)" || failedRestartStatus=$?
check "a failed restart warns" grep -q '\[warn\].*restart failed' <<< "$failedRestartOutput"
check "a failed restart makes the topic fail" test "$failedRestartStatus" -eq 1

rm -f "$stubState/restart-fails"
: > "$commandLog"
retriedRestartOutput="$(runInstall)" || true
check "the run after a failed restart retries it" \
  test "$(countLogLines '^systemctl --user restart ydotoold$')" -eq 1
check "the retried restart is reported" grep -q 'restarted' <<< "$retriedRestartOutput"

: > "$commandLog"
settledOutput="$(runInstall)" || true
check "the run after a retried restart reports no change" reportsNoChanges "$settledOutput"
check "the run after a retried restart restarts nothing" \
  test "$(countLogLines '^systemctl --user restart ydotoold$')" -eq 0

touch "$stubState/user-manager-unreachable"
: > "$commandLog"
unreachableStatus=0
unreachableOutput="$(runInstall)" || unreachableStatus=$?
check "an unreachable user manager warns" grep -q '\[warn\].*systemctl --user unavailable' <<< "$unreachableOutput"
check "an unreachable user manager makes the topic fail" test "$unreachableStatus" -eq 1
check "an unreachable user manager keeps the service linked" test -L "$servicePath"
check "an unreachable user manager does not enable the service" \
  test "$(countLogLines '^systemctl --user enable --now ydotoold$')" -eq 0

rm -f "$stubState/groups-of-dictator" "$stubState/user-manager-unreachable"
: > "$commandLog"
namelessStatus=0
namelessOutput="$(env -u USER HOME="$sandbox" PATH="$stubBin:$coreBin" \
  DOTFILES_PROFILE=personal DOTFILES_TEST_LOG="$commandLog" DOTFILES_TEST_STATE="$stubState" \
  DOTFILES_TEST_STUB_BIN="$stubBin" DOTFILES_TEST_CORE_BIN="$coreBin" NO_COLOR=1 \
  bash "$topicDir/install.sh")" || namelessStatus=$?
check "an unset USER does not abort the topic" test "$namelessStatus" -eq 0
check "an unset USER falls back to the account name id reports" \
  test "$(countLogLines '^usermod -aG input dictator$')" -eq 1

rm -f "$stubState/groups-of-dictator"
: > "$commandLog"
impostorUserStatus=0
runInStubbedSandbox "$sandbox" USER=root DOTFILES_PROFILE=personal NO_COLOR=1 \
  bash "$topicDir/install.sh" > /dev/null || impostorUserStatus=$?
check "a USER naming another account does not abort the topic" test "$impostorUserStatus" -eq 0
check "the account handed to usermod comes from id, not USER" \
  test "$(countLogLines '^usermod -aG input dictator$')" -eq 1
check "the account USER named never reaches usermod" logLacks "usermod -aG input root"

danglingUnitPath="$sandbox/.config/systemd/user/never-linked.service"
ln -s "$sandbox/.config/systemd/user/nothing-is-here" "$danglingUnitPath"
readsDanglingUnitWithoutAborting() {
  runInStubbedSandbox "$sandbox" PATH="$PATH" bash -c '
    set -euo pipefail
    source "$1/script/lib/state.sh"
    source "$1/script/lib/systemd.sh"
    linkedUnitContentChanged "$2"
    recordLinkedUnitContent "$2"
  ' _ "$repoRoot" "$danglingUnitPath"
}
check "a unit link pointing nowhere counts as changed instead of aborting" \
  readsDanglingUnitWithoutAborting
check "a unit link pointing nowhere is never fingerprinted" \
  test ! -e "$sandbox/.local/state/dotfiles/systemd-never-linked.service-record"

check "no command was refused for reaching outside the stubs" logLacks "sudo refused"

reportTopicResults "dictation"
