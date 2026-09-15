#!/usr/bin/env bash

set -euo pipefail

topicDir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repoRoot="$(cd -- "$topicDir/.." && pwd)"
# shellcheck source=../test/harness.sh
source "$repoRoot/test/harness.sh"

startStubbedSandbox "converge"

linkCoreUtilities basename bash cat chmod cmp cp dirname env grep head ln mkdir mktemp mv readlink rm \
  sed touch tr true

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

writeStub id <<'STUB'
#!/usr/bin/env bash
printf 'id %s\n' "$*" >> "$DOTFILES_TEST_LOG"
if [[ "${1:-}" == "-u" ]]; then
  printf '501\n'
fi
STUB
writeStub launchctl <<'STUB'
#!/usr/bin/env bash
printf 'launchctl %s\n' "$*" >> "$DOTFILES_TEST_LOG"
loadedMarker="$DOTFILES_TEST_STATE/launch-agent-loaded"
case "${1:-}" in
  print)
    [[ -f "$loadedMarker" ]]
    ;;
  bootout)
    rm -f "$loadedMarker"
    ;;
  bootstrap)
    if [[ -f "$DOTFILES_TEST_STATE/launch-bootstrap-fails" ]]; then
      exit 1
    fi
    touch "$loadedMarker"
    ;;
esac
STUB
provideCommand id
provideCommand launchctl
writeDarwinDirectoryServiceStub "$stubBin"

darwinHomebrewPrefix="$sandbox/homebrew"
launchAgentPath="$sandbox/Library/LaunchAgents/dev.dotfiles.converge.plist"
launchAgentPending="$sandbox/.local/state/dotfiles/launchd-dev.dotfiles.converge-pending"

runDarwinInstall() {
  runInStubbedSandbox "$sandbox" DOTFILES_PLATFORM=darwin \
    DOTFILES_TEST_HOMEBREW_PREFIX="$darwinHomebrewPrefix" \
    DOTFILES_PROFILE=work NO_COLOR=1 bash "$topicDir/install.sh"
}

: > "$commandLog"
darwinFirstStatus=0
darwinFirstOutput="$(runDarwinInstall)" || darwinFirstStatus=$?
check "the first darwin install exits clean" test "$darwinFirstStatus" -eq 0
check "darwin renders a launch agent instead of systemd links" test -f "$launchAgentPath"
check "darwin runs dot with Homebrew bash" \
  grep -qF "<string>$darwinHomebrewPrefix/bin/bash</string>" "$launchAgentPath"
check "darwin runs dot through the relocatable alias" \
  grep -qF "<string>$sandbox/.dotfiles/bin/dot</string>" "$launchAgentPath"
check "the launch agent fires at hour four" \
  bash -c 'grep -A1 "<key>Hour</key>" "$1" | grep -q "<integer>4</integer>"' _ "$launchAgentPath"
check "the launch agent fires at minute zero" \
  bash -c 'grep -A1 "<key>Minute</key>" "$1" | grep -q "<integer>0</integer>"' _ "$launchAgentPath"
check "the launch agent does not run immediately when loaded" \
  bash -c 'grep -A1 "<key>RunAtLoad</key>" "$1" | grep -q "<false/>"' _ "$launchAgentPath"
check "the launch agent PATH contains Homebrew and the systemd unit entries" \
  grep -qF "$darwinHomebrewPrefix/bin:$darwinHomebrewPrefix/sbin:$sandbox/.npm-global/bin:$sandbox/.local/bin:/usr/local/bin:/usr/bin:/bin" \
    "$launchAgentPath"
check "the launch agent tells the converge it runs as the agent" \
  bash -c 'grep -A1 "<key>DOTFILES_CONVERGE_AGENT</key>" "$1" | grep -q "<string>1</string>"' _ "$launchAgentPath"
check "the launch agent writes stdout under dotfiles state" \
  grep -qF "$sandbox/.local/state/dotfiles/converge.stdout.log" "$launchAgentPath"
check "the launch agent writes stderr under dotfiles state" \
  grep -qF "$sandbox/.local/state/dotfiles/converge.stderr.log" "$launchAgentPath"
check "the template names launchd's missing timer semantics" \
  grep -qF 'launchd has no equivalents' "$topicDir/dotfiles-converge.plist.template"
check "darwin probes the agent before loading it" \
  test "$(grep '^launchctl ' "$commandLog" | head -n 1)" = 'launchctl print gui/501/dev.dotfiles.converge'
check "darwin bootstraps the launch agent" \
  logHas "launchctl bootstrap gui/501 $launchAgentPath"
check "darwin never calls systemctl" logLacks 'systemctl '
check "the first darwin load is reported" outputHas "$darwinFirstOutput" 'loaded'

: > "$commandLog"
darwinSecondOutput="$(runDarwinInstall)"
check "a settled launch agent rerun reports no changes" reportsNoChanges "$darwinSecondOutput"
check "a settled launch agent is probed" \
  logHas 'launchctl print gui/501/dev.dotfiles.converge'
check "a settled launch agent is not booted out" logLacks 'launchctl bootout'
check "a settled launch agent is not bootstrapped again" logLacks 'launchctl bootstrap'

printf 'hand edit\n' >> "$launchAgentPath"
: > "$commandLog"
changedDarwinOutput="$(runDarwinInstall)"
check "changed launch agent content is booted out" \
  logHas "launchctl bootout gui/501 $launchAgentPath"
check "changed launch agent content is bootstrapped again" \
  logHas "launchctl bootstrap gui/501 $launchAgentPath"
check "a changed launch agent is reported as reloaded" outputHas "$changedDarwinOutput" 'reloaded'
check "a hand-edited launch agent is backed up" test -f "$launchAgentPath.pre-dotfiles.bak"

rm -f "$stubState/launch-agent-loaded"
touch "$stubState/launch-bootstrap-fails"
: > "$commandLog"
failedDarwinStatus=0
failedDarwinOutput="$(runDarwinInstall)" || failedDarwinStatus=$?
check "a launchctl bootstrap failure fails the topic" test "$failedDarwinStatus" -eq 1
check "a launchctl bootstrap failure is reported" outputHas "$failedDarwinOutput" 'launchctl bootstrap failed'
check "a failed launchctl bootstrap remains owed" test -f "$launchAgentPending"
rm -f "$stubState/launch-bootstrap-fails"
: > "$commandLog"
retriedDarwinStatus=0
runDarwinInstall > /dev/null || retriedDarwinStatus=$?
check "a later darwin run retries owed launchctl work" test "$retriedDarwinStatus" -eq 0
check "the retry bootstraps the launch agent" \
  logHas "launchctl bootstrap gui/501 $launchAgentPath"
check "a successful retry clears launchd debt" test ! -e "$launchAgentPending"

printf 'hand edit inside the agent\n' >> "$launchAgentPath"
: > "$commandLog"
insideAgentStatus=0
insideAgentOutput="$(runInStubbedSandbox "$sandbox" DOTFILES_PLATFORM=darwin \
  DOTFILES_CONVERGE_AGENT=1 DOTFILES_TEST_HOMEBREW_PREFIX="$darwinHomebrewPrefix" \
  DOTFILES_PROFILE=work NO_COLOR=1 bash "$topicDir/install.sh")" || insideAgentStatus=$?
check "a converge running as the agent never boots itself out" logLacks 'launchctl bootout'
check "a converge running as the agent loads nothing either" logLacks 'launchctl bootstrap'
check "a converge running as the agent says the reload is owed" \
  outputHas "$insideAgentOutput" 'run dot by hand to reload it'
check "a converge running as the agent fails the topic" test "$insideAgentStatus" -eq 1
check "a converge running as the agent leaves the reload owed" test -f "$launchAgentPending"

: > "$commandLog"
handReloadStatus=0
runDarwinInstall > /dev/null || handReloadStatus=$?
check "a hand run pays the reload the agent could not" \
  logHas "launchctl bootout gui/501 $launchAgentPath"
check "the hand run loads the agent again" \
  logHas "launchctl bootstrap gui/501 $launchAgentPath"
check "the hand run clears the owed reload" test ! -e "$launchAgentPending"
check "the hand run exits clean" test "$handReloadStatus" -eq 0

unusableStateHome="$sandbox/unusable-state-home"
mkdir -p "$unusableStateHome/.local/state" "$unusableStateHome/Library/LaunchAgents"
ln -s "$testRepoRoot" "$unusableStateHome/.dotfiles"
: > "$unusableStateHome/.dotfiles-test-sandbox"
ln -s "$unusableStateHome/no-such-state" "$unusableStateHome/.local/state/dotfiles"
: > "$commandLog"
unusableStateStatus=0
unusableStateOutput="$(runInStubbedSandbox "$unusableStateHome" DOTFILES_PLATFORM=darwin \
  DOTFILES_TEST_HOMEBREW_PREFIX="$darwinHomebrewPrefix" \
  DOTFILES_PROFILE=work NO_COLOR=1 bash "$topicDir/install.sh")" || unusableStateStatus=$?
check "a launch agent that could not be rendered names why" \
  outputHas "$unusableStateOutput" 'is not a plain directory'
check "a launch agent that could not be rendered fails the topic" test "$unusableStateStatus" -eq 1
check "a launch agent that could not be rendered reaches no launchctl" logLacks 'launchctl '
check "a launch agent that could not be rendered is never written" \
  test ! -e "$unusableStateHome/Library/LaunchAgents/dev.dotfiles.converge.plist"

reportTopicResults "converge"
