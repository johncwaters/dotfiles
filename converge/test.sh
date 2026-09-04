#!/usr/bin/env bash

set -euo pipefail

topicDir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repoRoot="$(cd -- "$topicDir/.." && pwd)"
# shellcheck source=../test/harness.sh
source "$repoRoot/test/harness.sh"

startStubbedSandbox "converge"

linkCoreUtilities basename bash cat chmod cp dirname env grep head ln mkdir mv readlink rm \
  touch tr true

runInstall() {
  runInStubbedSandbox "$sandbox" \
    DOTFILES_PROFILE=server \
    NO_COLOR=1 \
    bash "$topicDir/install.sh"
}

writeStub systemctl <<'STUB'
#!/usr/bin/env bash
printf 'systemctl %s\n' "$*" >> "$DOTFILES_TEST_LOG"
enabledMarker="$DOTFILES_TEST_STATE/timer-enabled"
activeMarker="$DOTFILES_TEST_STATE/timer-active"
if [[ "${2:-}" == 'show' ]]; then
  exit 0
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
if [[ "${2:-}" == 'start' || "${2:-}" == 'restart' ]]; then
  touch "$activeMarker"
  exit 0
fi
exit 1
STUB
provideCommand systemctl

unitDirectory="$sandbox/.config/systemd/user"
servicePath="$unitDirectory/dotfiles-converge.service"
timerPath="$unitDirectory/dotfiles-converge.timer"

printf '\nconverge topic\n'

firstRunStatus=0
firstRunOutput="$(runInstall)" || firstRunStatus=$?
check "first install exits clean" test "$firstRunStatus" -eq 0
check "the service links through the alias" \
  test "$(readlink -- "$servicePath")" = "$sandbox/.dotfiles/converge/dotfiles-converge.service"
check "the timer links through the alias" \
  test "$(readlink -- "$timerPath")" = "$sandbox/.dotfiles/converge/dotfiles-converge.timer"
check "the timer is enabled and started once" \
  test "$(countLogLines '^systemctl --user enable --now dotfiles-converge.timer$')" -eq 1
check "the service runs dot through the alias" grep -qx 'ExecStart=%h/.dotfiles/bin/dot' "$servicePath"
check "the service is a oneshot" grep -qx 'Type=oneshot' "$servicePath"
check "a stalled converge is not left holding the unit" \
  grep -qx 'TimeoutStartSec=1h' "$servicePath"
check "the service carries a PATH that finds node without an ambient shell" \
  grep -q '^Environment=PATH=%h/.npm-global/bin:%h/.local/bin:' "$servicePath"
check "the service refuses to converge a stale checkout when origin is unreachable" \
  grep -qx 'Environment=DOTFILES_REQUIRE_ORIGIN=1' "$servicePath"
check "the service orders itself against no unit the user manager lacks" \
  test "$(grep -c 'network-online.target' "$servicePath" || true)" -eq 0
check "the timer fires nightly" grep -q '^OnCalendar=\*-\*-\* 04:00:00$' "$timerPath"
check "the timer retries once the machine has been up ten minutes" grep -qx 'OnBootSec=10min' "$timerPath"
check "the timer catches up after a missed night" grep -qx 'Persistent=true' "$timerPath"
check "the first run reports the enable" grep -q 'enabled and started' <<< "$firstRunOutput"

: > "$commandLog"
secondRunStatus=0
secondRunOutput="$(runInstall)" || secondRunStatus=$?
check "second install exits clean" test "$secondRunStatus" -eq 0
check "second install reports no changes" reportsNoChanges "$secondRunOutput"
check "second install reloads nothing" test "$(countLogLines '^systemctl --user daemon-reload$')" -eq 0

timerContentRecord="$sandbox/.local/state/dotfiles/systemd-dotfiles-converge.timer-record"
check "the timer content is fingerprinted" test -f "$timerContentRecord"
printf 'OnCalendar=*-*-* 03:00:00\n' > "$timerContentRecord"
: > "$commandLog"
changedTimerOutput="$(runInstall)" || true
check "a timer changed behind the link is reloaded" \
  test "$(countLogLines '^systemctl --user daemon-reload$')" -eq 1
check "a timer changed behind the link is restarted" \
  test "$(countLogLines '^systemctl --user restart dotfiles-converge.timer$')" -eq 1
check "the restart is reported" grep -q 'restarted' <<< "$changedTimerOutput"

withdrawCommand systemctl
: > "$commandLog"
noSystemctlStatus=0
noSystemctlOutput="$(runInstall)" || noSystemctlStatus=$?
check "a machine without systemctl warns" grep -q '\[warn\].*systemctl --user unavailable' <<< "$noSystemctlOutput"
check "a machine without systemctl fails the topic" test "$noSystemctlStatus" -eq 1

reportTopicResults "converge"
