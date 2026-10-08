#!/usr/bin/env bash
set -euo pipefail

topicDirectory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
pinnedGlimmervoidVersion="$(sed -n 's/^devboxGlimmervoidVersion="\(.*\)"$/\1/p' "$topicDirectory/lib.sh")"
repoRoot="$(cd -- "$topicDirectory/.." && pwd)"
export DOTFILES_PLATFORM=linux
source "$repoRoot/test/harness.sh"

startStubbedSandbox devbox
linkCoreUtilities basename bash env cat sed awk grep head tail tr mkdir rm cp mv ln readlink dirname chmod cmp hostname touch mktemp stat wc sleep ps nohup tar cut od date
testNodePath="$(type -P node || true)"
if [[ -n "$testNodePath" ]]; then
  linkCoreUtilities node
fi

writeStub coder <<'STUB'
#!/usr/bin/env bash
printf 'coder %s\n' "$*" >> "$DOTFILES_TEST_LOG"
case "$1" in
  whoami)
    [[ ! -f "$DOTFILES_TEST_STATE/logged-out" ]] || exit 1
    printf '[{"url":"https://coder.example","username":"fixture"}]\n'
    ;;
  list)
    if [[ -f "$DOTFILES_TEST_STATE/list-failed" ]]; then exit 1; fi
    if [[ -f "$DOTFILES_TEST_STATE/no-workspace" ]]; then printf '[]\n'; exit; fi
    printf '[{"name":"devbox-fixture","owner_name":"fixture","latest_build":{"status":"%s"}}]\n' \
      "$(cat "$DOTFILES_TEST_STATE/workspace-status")"
    ;;
  start) printf 'running\n' > "$DOTFILES_TEST_STATE/workspace-status" ;;
  ssh)
    printf '%s %s\n' "${CODER_SSH_DISABLE_AUTOSTART:-}" "${CODER_SSH_USAGE_APP:-}" >> "$DOTFILES_TEST_STATE/ssh-safety"
    [[ ! -f "$DOTFILES_TEST_STATE/ssh-failed" ]] || exit 1
    if [[ "${*:4}" == *snapshot-status ]]; then
      cat > /dev/null
      if [[ -f "$DOTFILES_TEST_STATE/execute-snapshot" ]]; then
        HOME="$DOTFILES_TEST_STATE/remote-home" bash "$DOTFILES_TEST_STATE/remote-provision.sh" 0.29.1 snapshot-status
        exit
      fi
      cat "$DOTFILES_TEST_STATE/snapshot-commit"
      exit
    fi
    if [[ "${5:-}" == -c ]]; then
      printf 'snapshot transfer\n' >> "$DOTFILES_TEST_LOG"
      DOTFILES_TEST_REMOTE_SNAPSHOT=1 HOME="$DOTFILES_TEST_STATE/remote-home" bash -c "${*:4}"
      exit
    fi
    cat > "$DOTFILES_TEST_STATE/pushed-script"
    printf '%s\n' "${CODER_SSH_DISABLE_AUTOSTART:-}" > "$DOTFILES_TEST_STATE/ssh-autostart-disabled"
    printf '%s\n' "${CODER_SSH_USAGE_APP:-}" > "$DOTFILES_TEST_STATE/ssh-usage-app"
    bash -c "set -- ${*:4}; printf '%s\\n' \"\$@\"" > "$DOTFILES_TEST_STATE/remote-arguments"
    [[ ! -f "$DOTFILES_TEST_STATE/ssh-failed" ]] || exit 1
    if [[ -f "$DOTFILES_TEST_STATE/execute-provision" ]]; then
      HOME="$DOTFILES_TEST_STATE/remote-home" CODER_WORKSPACE_AGENT_NAME=dev CODER_WORKSPACE_NAME=devbox-fixture \
        CODER_WORKSPACE_OWNER_NAME=fixture bash "$DOTFILES_TEST_STATE/provision-with-test-listeners.sh" "${@:7}"
      exit
    fi
    if [[ -f "$DOTFILES_TEST_STATE/provision-output" ]]; then
      cat "$DOTFILES_TEST_STATE/provision-output"
      exit 0
    fi
    printf '[present] fixture: provisioned\nhttps://fixture.invalid/\n'
    ;;
  *) exit 1 ;;
esac
STUB

testGitPath="$(type -P git)"
export DOTFILES_TEST_GIT_PATH="$testGitPath"
snapshotFixtureRepo="$stubState/snapshot-repo"
mkdir -p "$snapshotFixtureRepo/script" "$snapshotFixtureRepo/profiles/work-server" "$snapshotFixtureRepo/snapshot-probe"
cp -R "$repoRoot/script/." "$snapshotFixtureRepo/script/"
printf '{"platform":"linux","topics":["snapshot-probe"]}\n' > "$snapshotFixtureRepo/profiles/work-server/profile.json"
cat > "$snapshotFixtureRepo/snapshot-probe/install.sh" <<'TOPIC'
#!/usr/bin/env bash
printf 'bootstrap %s\n' "$DOTFILES_PROFILE" >> "$DOTFILES_TEST_LOG"
printf '%s\n' "$PATH" > "$DOTFILES_TEST_STATE/bootstrap-path"
if [[ -e "$HOME/dotfiles-snapshot/.snapshot-commit" ]]; then touch "$DOTFILES_TEST_STATE/marker-during-bootstrap"; fi
[[ ! -f "$DOTFILES_TEST_STATE/bootstrap-failed" ]] || exit 1
mkdir -p "$HOME/.claude/hooks"
ln -sf "$HOME/.dotfiles/snapshot-probe/hook.mjs" "$HOME/.claude/hooks/snapshot-probe.mjs"
TOPIC
printf 'committed hook\n' > "$snapshotFixtureRepo/snapshot-probe/hook.mjs"
"$testGitPath" -C "$snapshotFixtureRepo" init -q -b main
"$testGitPath" -C "$snapshotFixtureRepo" add .
"$testGitPath" -C "$snapshotFixtureRepo" -c user.name=fixture -c user.email=fixture@example.invalid commit -qm snapshot
"$testGitPath" -C "$snapshotFixtureRepo" rev-parse HEAD > "$stubState/snapshot-commit"
printf 'uncommitted hook\n' > "$snapshotFixtureRepo/snapshot-probe/hook.mjs"
printf 'untracked secret\n' > "$snapshotFixtureRepo/untracked-secret"
writeStub git <<'STUB'
#!/usr/bin/env bash
printf 'git %s\n' "$*" >> "$DOTFILES_TEST_LOG"
if [[ "${DOTFILES_TEST_REMOTE_SNAPSHOT:-}" == 1 ]]; then
  exec "$DOTFILES_TEST_GIT_PATH" "$@"
fi
exec "$DOTFILES_TEST_GIT_PATH" -C "$DOTFILES_TEST_STATE/snapshot-repo" "${@:3}"
STUB
provideCommand git

runInstall() {
  runInStubbedSandbox "$sandbox" DOTFILES_PROFILE=work NO_COLOR=1 bash "$topicDirectory/install.sh"
}

runDevbox() {
  runInStubbedSandbox "$sandbox" bash -c 'source "$1/commands.bash"; shift; devbox "$@"' _ "$topicDirectory" "$@"
}

snapshotCheckSitsBetweenPrepareAndProvision() {
  [[ "$(sed -nE 's/^coder ssh .* (prepare|provision|snapshot-status)$/\1/p' "$commandLog" | tr '\n' ' ')" == 'prepare snapshot-status provision ' ]]
}

printf '\ndevbox topic\n'
printf 'running\n' > "$stubState/workspace-status"
missingCoderOutput="$(runInstall)"
check "absent Coder skips cleanly without a warning" outputLacks "$missingCoderOutput" '[warn]'
check "absent Coder explains the skip" outputHas "$missingCoderOutput" 'Coder CLI absent'
check "absent Coder never connects" logLacks 'coder ssh'
missingCoderEnsureStatus=0
missingCoderEnsureOutput="$(runDevbox ensure 2>&1)" || missingCoderEnsureStatus=$?
check "ensure without Coder exits cleanly" test "$missingCoderEnsureStatus" -eq 0
check "ensure without Coder prints one informational line" \
  test "$(wc -l <<< "$missingCoderEnsureOutput" | tr -d ' ')" -eq 1
check "ensure without Coder names the skip" outputHas "$missingCoderEnsureOutput" 'devbox ensure: skipped; Coder CLI absent'
check "ensure without Coder never connects or starts" logLacks 'coder '

mkdir -p "$sandbox/.local/bin"
cp "$stubState/available/coder" "$sandbox/.local/bin/coder"
touch "$stubState/logged-out"
loggedOutStatus=0
loggedOutOutput="$(runInstall)" || loggedOutStatus=$?
check "a failing coder whoami warns in converge" outputHas "$loggedOutOutput" '[warn] devbox'
check "a failing coder whoami names the login fix in converge" \
  outputHas "$loggedOutOutput" 'coder whoami failed; run coder login https://coder.dev.posthog.dev'
check "a failing coder whoami yields a nonzero converge status" test "$loggedOutStatus" -eq 1
check "logged-out converge never connects" logLacks 'coder ssh'
check "logged-out converge never starts a box" logLacks 'coder start'
loggedOutEnsureStatus=0
loggedOutEnsureError="$(runDevbox ensure 2>&1 >/dev/null)" || loggedOutEnsureStatus=$?
check "a failing coder whoami fails ensure" test "$loggedOutEnsureStatus" -ne 0
check "a failing coder whoami tells the ensure log how to log in" \
  outputHas "$loggedOutEnsureError" 'devbox ensure: coder whoami failed; run coder login https://coder.dev.posthog.dev'
check "logged-out ensure never connects" logLacks 'coder ssh'
check "logged-out ensure never starts a box" logLacks 'coder start'
rm -f "$stubState/logged-out"

if [[ -z "$testNodePath" ]]; then
  printf '  skip workspace and config checks: node is unavailable on the test machine\n'
  reportTopicResults devbox
fi

touch "$stubState/no-workspace"
: > "$commandLog"
missingWorkspaceOutput="$(runInstall)"
check "missing workspace skips cleanly" outputLacks "$missingWorkspaceOutput" '[warn]'
check "missing workspace names the expected workspace" outputHas "$missingWorkspaceOutput" 'no workspace named devbox-fixture'
check "missing workspace never connects" logLacks 'coder ssh'
check "missing workspace never starts a box" logLacks 'coder start'
missingWorkspaceEnsureStatus=0
missingWorkspaceEnsureOutput="$(runDevbox ensure 2>&1)" || missingWorkspaceEnsureStatus=$?
check "ensure without a workspace exits cleanly" test "$missingWorkspaceEnsureStatus" -eq 0
check "ensure without a workspace prints one informational line" \
  test "$(wc -l <<< "$missingWorkspaceEnsureOutput" | tr -d ' ')" -eq 1
check "ensure without a workspace names the skip" \
  outputHas "$missingWorkspaceEnsureOutput" 'devbox ensure: skipped; no workspace named devbox-fixture'
check "ensure without a workspace never connects" logLacks 'coder ssh'
check "ensure without a workspace never starts a box" logLacks 'coder start'
rm -f "$stubState/no-workspace"

for workspaceStatus in stopped starting failed; do
  printf '%s\n' "$workspaceStatus" > "$stubState/workspace-status"
  : > "$commandLog"
  skippedOutput="$(runInstall)"
  check "$workspaceStatus workspace skips without warning" outputLacks "$skippedOutput" '[warn]'
  check "$workspaceStatus workspace names its status" outputHas "$skippedOutput" "is $workspaceStatus"
  check "$workspaceStatus workspace never connects" logLacks 'coder ssh'
  check "$workspaceStatus workspace never starts from converge" logLacks 'coder start'
  runDevbox ensure >/dev/null
  check "ensure skips $workspaceStatus without connecting" logLacks 'coder ssh'
  check "ensure never starts a $workspaceStatus workspace" logLacks 'coder start'
done

printf 'running\n' > "$stubState/workspace-status"
: > "$commandLog"
rm -f "$stubState/ssh-usage-app"
runningOutput="$(runInstall)"
check "running converge pushes with the pinned release" logHas "coder ssh devbox-fixture -- bash -s -- $pinnedGlimmervoidVersion provision"
check "running converge pipes the exact standalone script" cmp -s "$topicDirectory/provision.sh" "$stubState/pushed-script"
check "SSH cannot auto-start a box after a status race" grep -qx true "$stubState/ssh-autostart-disabled"
check "converge SSH never reports workspace activity" grep -qx disable "$stubState/ssh-usage-app"
check "matching snapshot hash skips archive and bootstrap" logLacks 'archive --format=tar'
check "matching snapshot hash reports dotfiles present" outputHas "$runningOutput" '[present] dotfiles'
check "converge checks the snapshot after prepare and before provision" snapshotCheckSitsBetweenPrepareAndProvision
check "running converge does not start a workspace" logLacks 'coder start'
check "an unchanged provision reports no laptop changes" reportsNoChanges "$runningOutput"
check "an unchanged provision reports the devbox as present" outputMatches "$runningOutput" '\[ -- \] devbox +devbox-fixture provisioned'

printf '[installed] config: merged; runtime records preserved\nhttps://fixture.invalid/\n' > "$stubState/provision-output"
installedOutput="$(runInstall)"
check "a provision that changed the box reports an install" outputHas "$installedOutput" '[ ++ ] devbox'
check "a provision that changed the box does not warn" outputLacks "$installedOutput" '[warn]'

printf '[installed] glimmervoid: 0.29.1\n[warned] config: changes pending; run devbox restart-glimmervoid\nhttps://fixture.invalid/\n' > "$stubState/provision-output"
warnedStatus=0
warnedOutput="$(runInstall)" || warnedStatus=$?
check "a remote warning yields a nonzero converge status" test "$warnedStatus" -eq 1
check "a remote warning is counted as a laptop warning" outputHas "$warnedOutput" '[warn] devbox'
check "a remote warning outranks a remote install" outputLacks "$warnedOutput" '[ ++ ] devbox'
rm -f "$stubState/provision-output"

: > "$commandLog"
rm -f "$stubState/ssh-usage-app"
runDevbox ensure >/dev/null
check "ensure provisions a running workspace with the pinned release" \
  logHas "coder ssh devbox-fixture -- bash -s -- $pinnedGlimmervoidVersion provision"
check "ensure pushes the exact standalone script" cmp -s "$topicDirectory/provision.sh" "$stubState/pushed-script"
check "ensure disables SSH autostart after a status race" grep -qx true "$stubState/ssh-autostart-disabled"
check "ensure SSH never reports workspace activity" grep -qx disable "$stubState/ssh-usage-app"
check "ensure checks the snapshot after prepare and before provision" snapshotCheckSitsBetweenPrepareAndProvision
check "ensure never starts a running workspace" logLacks 'coder start'

for failureMarker in list-failed ssh-failed; do
  touch "$stubState/$failureMarker"
  ensureFailureStatus=0
  runDevbox ensure >/dev/null 2>&1 || ensureFailureStatus=$?
  check "ensure propagates $failureMarker" test "$ensureFailureStatus" -ne 0
  rm -f "$stubState/$failureMarker"
done

ensureUsageStatus=0
runDevbox ensure extra >/dev/null 2>&1 || ensureUsageStatus=$?
check "ensure rejects extra arguments" test "$ensureUsageStatus" -ne 0

writeStub id <<'STUB'
#!/usr/bin/env bash
if [[ "${1:-}" == -u ]]; then printf '501\n'; fi
STUB
writeStub launchctl <<'STUB'
#!/usr/bin/env bash
printf 'launchctl %s\n' "$*" >> "$DOTFILES_TEST_LOG"
loadedMarker="$DOTFILES_TEST_STATE/devbox-agent-loaded"
case "${1:-}" in
  print) [[ -f "$loadedMarker" ]] ;;
  bootout) rm -f "$loadedMarker" ;;
  bootstrap)
    [[ ! -f "$DOTFILES_TEST_STATE/launch-bootstrap-fails" ]] || exit 1
    touch "$loadedMarker"
    ;;
  *) exit 1 ;;
esac
STUB
provideCommand id
provideCommand launchctl
writeDarwinDirectoryServiceStub "$stubBin"

darwinHomebrewPrefix="$sandbox/homebrew"
launchAgentPath="$sandbox/Library/LaunchAgents/dev.dotfiles.devbox.ensure.plist"
launchAgentPending="$sandbox/.local/state/dotfiles/launchd-dev.dotfiles.devbox.ensure-pending"
runDarwinInstall() {
  runInStubbedSandbox "$sandbox" DOTFILES_PLATFORM=darwin \
    DOTFILES_TEST_HOMEBREW_PREFIX="$darwinHomebrewPrefix" \
    DOTFILES_PROFILE=work NO_COLOR=1 bash "$topicDirectory/install.sh"
}

: > "$commandLog"
runInstall >/dev/null
check "linux never renders the devbox launch agent" test ! -e "$launchAgentPath"
check "linux never calls launchctl" logLacks 'launchctl '

touch "$stubState/logged-out"
: > "$commandLog"
loggedOutDarwinStatus=0
loggedOutDarwinOutput="$(runDarwinInstall)" || loggedOutDarwinStatus=$?
check "darwin installs the poller while logged out" test -f "$launchAgentPath"
check "a logged-out darwin install warns only about the login" \
  test "$(grep -c '\[warn\]' <<< "$loggedOutDarwinOutput")" -eq 1
check "a logged-out darwin install exits with its login warning" test "$loggedOutDarwinStatus" -eq 1
check "darwin uses the converge label namespace" grep -qF '<string>dev.dotfiles.devbox.ensure</string>' "$launchAgentPath"
check "darwin invokes Homebrew bash" grep -qF "<string>$darwinHomebrewPrefix/bin/bash</string>" "$launchAgentPath"
check "darwin invokes devbox through the dotfiles alias" \
  grep -qF "<string>$sandbox/.dotfiles/devbox/commands.bash</string>" "$launchAgentPath"
check "darwin invokes the ensure action" grep -qF '<string>ensure</string>' "$launchAgentPath"
check "darwin polls every ten minutes" \
  bash -c 'grep -A1 "<key>StartInterval</key>" "$1" | grep -q "<integer>600</integer>"' _ "$launchAgentPath"
check "darwin runs the poller at load" \
  bash -c 'grep -A1 "<key>RunAtLoad</key>" "$1" | grep -q "<true/>"' _ "$launchAgentPath"
check "darwin uses no calendar schedule" \
  bash -c '! grep -q StartCalendarInterval "$1"' _ "$launchAgentPath"
check "darwin logs stdout under converge state" \
  grep -qF "$sandbox/.local/state/dotfiles/devbox-ensure.stdout.log" "$launchAgentPath"
check "darwin logs stderr under converge state" \
  grep -qF "$sandbox/.local/state/dotfiles/devbox-ensure.stderr.log" "$launchAgentPath"
check "darwin supplies a PATH with Homebrew and Coder" \
  grep -qF "$darwinHomebrewPrefix/bin:$darwinHomebrewPrefix/sbin:$sandbox/.npm-global/bin:$sandbox/.local/bin:/usr/local/bin:/usr/bin:/bin" "$launchAgentPath"
check "darwin protects the rendered plist" test "$(fileModeOf "$launchAgentPath")" = 600
check "darwin probes the poller" logHas 'launchctl print gui/501/dev.dotfiles.devbox.ensure'
check "darwin bootstraps the poller" logHas "launchctl bootstrap gui/501 $launchAgentPath"
check "installing a logged-out poller never connects" logLacks 'coder ssh'

: > "$commandLog"
secondDarwinStatus=0
secondDarwinOutput="$(runDarwinInstall)" || secondDarwinStatus=$?
check "unchanged darwin install reports no changes" reportsNoChanges "$secondDarwinOutput"
check "unchanged logged-out darwin install exits with its login warning" test "$secondDarwinStatus" -eq 1
check "unchanged darwin install probes the poller" logHas 'launchctl print gui/501/dev.dotfiles.devbox.ensure'
check "unchanged darwin install never boots out" logLacks 'launchctl bootout'
check "unchanged darwin install never bootstraps" logLacks 'launchctl bootstrap'
rm -f "$stubState/logged-out"

launchAgentArguments=()
while IFS= read -r launchAgentArgument; do
  launchAgentArguments+=("$launchAgentArgument")
done < <(sed -n '/<key>ProgramArguments<\/key>/,/<\/array>/p' "$launchAgentPath" \
  | sed -n 's|^ *<string>\(.*\)</string>$|\1|p')
launchAgentArguments[0]="$(type -P bash)"
: > "$commandLog"
runInStubbedSandbox "$sandbox" "${launchAgentArguments[@]}" >/dev/null
check "rendered program arguments provision through ensure" \
  logHas "coder ssh devbox-fixture -- bash -s -- $pinnedGlimmervoidVersion provision"
check "rendered launchd ensure checks the snapshot" logHas "snapshot-status"
check "rendered program arguments never start a workspace" logLacks 'coder start'

printf 'hand edit\n' >> "$launchAgentPath"
: > "$commandLog"
runDarwinInstall >/dev/null
check "changed darwin install boots out the old poller" logHas "launchctl bootout gui/501 $launchAgentPath"
check "changed darwin install loads the refreshed poller" logHas "launchctl bootstrap gui/501 $launchAgentPath"
check "changed darwin install preserves hand edits" test -f "$launchAgentPath.pre-dotfiles.bak"

rm -f "$stubState/devbox-agent-loaded"
touch "$stubState/launch-bootstrap-fails"
: > "$commandLog"
failedAgentStatus=0
failedAgentOutput="$(runDarwinInstall)" || failedAgentStatus=$?
check "failed poller load fails install" test "$failedAgentStatus" -ne 0
check "failed poller load remains owed" test -f "$launchAgentPending"
check "failed poller load still provisions the box" \
  logHas "coder ssh devbox-fixture -- bash -s -- $pinnedGlimmervoidVersion provision"
check "failed poller load is reported as a launch agent warning" outputHas "$failedAgentOutput" '[warn] devbox launch agent'
check "darwin provisions the box before it loads the poller" \
  outputMatches "$(grep -E 'coder ssh|launchctl bootstrap' "$commandLog" | head -1)" '^coder ssh'
rm -f "$stubState/launch-bootstrap-fails"
runDarwinInstall >/dev/null
check "a later install clears the owed poller load" test ! -e "$launchAgentPending"

printf 'hand edit\n' >> "$launchAgentPath"
: > "$commandLog"
reloadOwedStatus=0
reloadOwedOutput="$(DOTFILES_CONVERGE_AGENT=1 runDarwinInstall)" || reloadOwedStatus=$?
check "an owed reload under the converge agent fails install" test "$reloadOwedStatus" -ne 0
check "an owed reload under the converge agent is reported" outputHas "$reloadOwedOutput" 'reload owed'
check "an owed reload under the converge agent still provisions the box" \
  logHas "coder ssh devbox-fixture -- bash -s -- $pinnedGlimmervoidVersion provision"
check "an owed reload under the converge agent never boots out its poller" logLacks 'launchctl bootout'
runDarwinInstall >/dev/null
check "a later install pays the owed reload" test ! -e "$launchAgentPending"

for failureMarker in list-failed ssh-failed; do
  touch "$stubState/$failureMarker"
  failedStatus=0
  failedOutput="$(runInstall 2>&1)" || failedStatus=$?
  check "$failureMarker yields a nonzero converge status" test "$failedStatus" -eq 1
  check "$failureMarker reports a warning" outputHas "$failedOutput" '[warn]'
  rm -f "$stubState/$failureMarker"
done

printf 'stopped\n' > "$stubState/workspace-status"
: > "$commandLog"
upOutput="$(runDevbox up)"
check "up starts a stopped workspace" logHas 'coder start devbox-fixture --yes'
check "up waits through the default Coder ssh behavior" logHas "coder ssh devbox-fixture -- bash -s -- $pinnedGlimmervoidVersion provision"
check "up pushes the exact standalone script" cmp -s "$topicDirectory/provision.sh" "$stubState/pushed-script"
check "up prints the dashboard URL" outputHas "$upOutput" 'https://fixture.invalid/'
check "up checks the snapshot after prepare and before provision" snapshotCheckSitsBetweenPrepareAndProvision
check "up starts before it connects" outputMatches "$(grep -E 'coder start|coder ssh' "$commandLog" | head -1)" '^coder start'
: > "$commandLog"
runDevbox up >/dev/null
check "up does not start a running workspace" logLacks 'coder start'

: > "$commandLog"
restartStatus=0
restartOutput="$(runDevbox restart-glimmervoid < /dev/null 2>&1)" || restartStatus=$?
check "restart refuses EOF without confirmation" test "$restartStatus" -ne 0
check "restart cancellation makes no connection" logLacks 'coder ssh'
check "restart cancellation names the consequence in its prompt" outputHas "$restartOutput" 'end all agent sessions'
restartStatus=0
printf 'n\n' | runDevbox restart-glimmervoid >/dev/null 2>&1 || restartStatus=$?
check "restart refuses a negative confirmation" test "$restartStatus" -ne 0
check "negative confirmation makes no connection" logLacks 'coder ssh'
printf 'y\n' | runDevbox restart-glimmervoid >/dev/null 2>&1
check "affirmative confirmation requests the shared restart" logHas "$pinnedGlimmervoidVersion restart"
: > "$commandLog"
runDevbox restart-glimmervoid --yes >/dev/null
check "explicit yes requests the shared restart" logHas "$pinnedGlimmervoidVersion restart"

: > "$commandLog"
runDevbox pair "laptop's label; literal" >/dev/null
check "pair preserves a quoted label through the remote shell" \
  test "$(tail -1 "$stubState/remote-arguments")" = "laptop's label; literal"
check "pair sends exactly one label argument" test "$(wc -l < "$stubState/remote-arguments" | tr -d ' ')" -eq 6
runDevbox pair >/dev/null
check "pair defaults to the laptop hostname" test "$(tail -1 "$stubState/remote-arguments")" = "$(hostname)"
: > "$commandLog"
rm -f "$stubState/ssh-usage-app"
statusOutput="$(runDevbox status)"
check "status reports the workspace" outputHas "$statusOutput" 'workspace devbox-fixture: running'
check "status SSH never reports workspace activity" grep -qx disable "$stubState/ssh-usage-app"
check "status uses the shared remote status action" logHas "$pinnedGlimmervoidVersion status"
check "status never starts a workspace" logLacks 'coder start'
printf 'stopped\n' > "$stubState/workspace-status"
: > "$commandLog"
stoppedStatusOutput="$(runDevbox status)"
check "stopped status does not connect" logLacks 'coder ssh'
check "stopped status prints the owner forwarding URL" outputHas "$stoppedStatusOutput" 'https://3457--dev--devbox-fixture--fixture.coder.dev.posthog.dev/'

writeStub flock <<'STUB'
#!/usr/bin/env bash
printf 'flock %s\n' "$*" >> "$DOTFILES_TEST_LOG"
[[ ! -f "$DOTFILES_TEST_STATE/provision-lock-held" ]]
STUB
provideCommand flock

remoteSnapshotHome="$stubState/remote-home"
remoteSnapshotMarker="$remoteSnapshotHome/dotfiles-snapshot/.snapshot-commit"
remoteBootstrapLog="$remoteSnapshotHome/.local/state/dotfiles/devbox-bootstrap.log"
cp "$topicDirectory/provision.sh" "$stubState/remote-provision.sh"
printf 'running\n' > "$stubState/workspace-status"

startEmptyRemoteHome() {
  rm -rf "$remoteSnapshotHome"
  mkdir -p "$remoteSnapshotHome"
  touch "$remoteSnapshotHome/.dotfiles-test-sandbox"
}

remoteSnapshotWasPushed() {
  grep -qx 'snapshot transfer' "$commandLog"
}

firstLineNumberMatching() {
  grep -nE -- "$1" "$commandLog" | head -1 | cut -d: -f1
}

snapshotTransferSitsBetweenPrepareAndProvision() {
  local prepareLine transferLine provisionLine
  prepareLine="$(firstLineNumberMatching "^coder ssh .* $pinnedGlimmervoidVersion prepare$")"
  transferLine="$(firstLineNumberMatching '^snapshot transfer$')"
  provisionLine="$(firstLineNumberMatching "^coder ssh .* $pinnedGlimmervoidVersion provision$")"
  [[ -n "$prepareLine" && -n "$transferLine" && -n "$provisionLine" ]] \
    && ((prepareLine < transferLine && transferLine < provisionLine))
}

startEmptyRemoteHome
touch "$stubState/execute-snapshot" "$stubState/bootstrap-failed"
: > "$commandLog"
firstFailedSnapshotStatus=0
firstFailedSnapshotOutput="$(runDevbox ensure 2>&1)" || firstFailedSnapshotStatus=$?
check "a failed first bootstrap leaves ensure succeeding on its provision" test "$firstFailedSnapshotStatus" -eq 0
check "a failed first bootstrap reports dotfiles warned" outputHas "$firstFailedSnapshotOutput" '[warned] dotfiles'
check "a failed first bootstrap still provisions after the snapshot" snapshotTransferSitsBetweenPrepareAndProvision
check "a failed first bootstrap places the committed tree" \
  grep -qx 'committed hook' "$remoteSnapshotHome/dotfiles-snapshot/snapshot-probe/hook.mjs"
check "a failed first bootstrap records no snapshot commit" test ! -e "$remoteSnapshotMarker"
: > "$commandLog"
runDevbox ensure >/dev/null 2>&1
check "the ensure after a failed first bootstrap pushes the snapshot again" remoteSnapshotWasPushed
check "the ensure after a failed first bootstrap still records no snapshot commit" test ! -e "$remoteSnapshotMarker"

startEmptyRemoteHome
mkdir -p "$remoteSnapshotHome/dotfiles-snapshot" "$remoteSnapshotHome/dotfiles-snapshot.old" "$remoteSnapshotHome/dotfiles-snapshot.new"
printf 'old-commit\n' > "$remoteSnapshotMarker"
printf 'old snapshot\n' > "$remoteSnapshotHome/dotfiles-snapshot/old-content"
printf 'stale previous\n' > "$remoteSnapshotHome/dotfiles-snapshot.old/stale-previous"
printf 'stale staged\n' > "$remoteSnapshotHome/dotfiles-snapshot.new/stale-staged"
ln -s "$remoteSnapshotHome/dotfiles-snapshot" "$remoteSnapshotHome/.dotfiles"
printf 'Coder PATH setup\n' > "$remoteSnapshotHome/.bashrc"
rm -f "$stubState/marker-during-bootstrap"
: > "$commandLog"
failedSnapshotStatus=0
failedSnapshotOutput="$(runDevbox ensure 2>&1)" || failedSnapshotStatus=$?
check "a failed bootstrap leaves ensure succeeding on its provision" test "$failedSnapshotStatus" -eq 0
check "a failed bootstrap reports dotfiles warned" outputHas "$failedSnapshotOutput" '[warned] dotfiles'
check "a failed bootstrap still provisions after the snapshot" snapshotTransferSitsBetweenPrepareAndProvision
check "stale previous and staged snapshots never block a run" remoteSnapshotWasPushed
check "a stale previous snapshot is cleared" test ! -e "$remoteSnapshotHome/dotfiles-snapshot.old"
check "a stale staged snapshot is cleared rather than shipped" \
  bash -c '[[ ! -e "$1/dotfiles-snapshot.new" && ! -e "$1/dotfiles-snapshot/stale-staged" ]]' _ "$remoteSnapshotHome"
check "a failed bootstrap keeps the new tree instead of rolling back" \
  grep -qx 'committed hook' "$remoteSnapshotHome/dotfiles-snapshot/snapshot-probe/hook.mjs"
check "a failed bootstrap drops the previous tree" test ! -e "$remoteSnapshotHome/dotfiles-snapshot/old-content"
check "a failed bootstrap records no snapshot commit" test ! -e "$remoteSnapshotMarker"
check "bootstrap never sees a snapshot commit recorded ahead of it" test ! -e "$stubState/marker-during-bootstrap"
check "a failed bootstrap leaves the dotfiles alias usable" test -d "$remoteSnapshotHome/.dotfiles"
check "snapshot bootstrap holds the provision lock" logHas 'flock -w 120 9'
check "bootstrap failure evidence is in the private log" \
  grep -q 'snapshot-probe.*install.sh exited 1' "$remoteBootstrapLog"
: > "$commandLog"
failedSnapshotConvergeStatus=0
failedSnapshotConvergeOutput="$(runInstall 2>&1)" || failedSnapshotConvergeStatus=$?
check "snapshot failure maps to a laptop converge warning" outputHas "$failedSnapshotConvergeOutput" '[warn] devbox'
check "snapshot failure fails laptop converge" test "$failedSnapshotConvergeStatus" -eq 1
check "the converge after a failed bootstrap retries it against a fresh push" remoteSnapshotWasPushed
touch "$stubState/provision-lock-held"
: > "$commandLog"
heldSnapshotOutput="$(runDevbox ensure 2>&1)"
check "a held provision lock reports dotfiles warned" outputHas "$heldSnapshotOutput" '[warned] dotfiles: cannot read remote snapshot commit'
check "a held provision lock transfers no snapshot" logLacks 'snapshot transfer'
check "a held provision lock records no snapshot commit" test ! -e "$remoteSnapshotMarker"
rm -f "$stubState/provision-lock-held"
rm -f "$stubState/bootstrap-failed" "$stubState/marker-during-bootstrap"
: > "$commandLog"
snapshotOutput="$(runDevbox ensure)"
check "a retried bootstrap that succeeds reports dotfiles installed" outputHas "$snapshotOutput" '[installed] dotfiles'
check "pushed snapshot records committed HEAD" \
  cmp -s "$stubState/snapshot-commit" "$remoteSnapshotMarker"
check "the snapshot commit is recorded only after bootstrap exits" test ! -e "$stubState/marker-during-bootstrap"
check "the snapshot commit is private" test "$(fileModeOf "$remoteSnapshotMarker")" = 600
check "the snapshot commit leaves no staged copy behind" test ! -e "$remoteSnapshotMarker.new"
check "archive pins the recorded HEAD hash" logHas "archive --format=tar $(cat "$stubState/snapshot-commit")"
check "pushed snapshot contains only committed content" \
  grep -qx 'committed hook' "$remoteSnapshotHome/dotfiles-snapshot/snapshot-probe/hook.mjs"
check "pushed snapshot excludes untracked secrets" test ! -e "$remoteSnapshotHome/dotfiles-snapshot/untracked-secret"
check "pushed snapshot has no git directory or repo credentials" test ! -e "$remoteSnapshotHome/dotfiles-snapshot/.git"
check "plain snapshot convergence records no git revision" \
  grep -q '^unknown work-server ' "$sandbox/.local/state/dotfiles/converged"
check "snapshot runs work-server bootstrap" logHas 'bootstrap work-server'
check "snapshot bootstrap makes lasting links through the alias" \
  test -f "$remoteSnapshotHome/.claude/hooks/snapshot-probe.mjs"
check "snapshot bootstrap preserves Coder shell setup" grep -qx 'Coder PATH setup' "$remoteSnapshotHome/.bashrc"
check "snapshot bootstrap includes Coder and local commands on PATH" \
  grep -qF "/tmp/coder-script-data/bin:$remoteSnapshotHome/.local/bin:" "$stubState/bootstrap-path"
check "bootstrap log has mode 0600" test "$(fileModeOf "$remoteBootstrapLog")" = 600
check "successful snapshot removes the old directory" test ! -e "$remoteSnapshotHome/dotfiles-snapshot.old"
check "snapshot bootstrap finishes before provision" \
  test "$(firstLineNumberMatching '^bootstrap work-server$')" -lt \
       "$(firstLineNumberMatching "^coder ssh .* $pinnedGlimmervoidVersion provision$")"
mv "$remoteSnapshotHome/dotfiles-snapshot" "$remoteSnapshotHome/dotfiles-snapshot.old"
: > "$commandLog"
runDevbox ensure >/dev/null
check "a swap interrupted between its renames is repaired by a fresh push" remoteSnapshotWasPushed
check "the repaired swap records committed HEAD" cmp -s "$stubState/snapshot-commit" "$remoteSnapshotMarker"
check "the repaired swap clears the stranded previous tree" test ! -e "$remoteSnapshotHome/dotfiles-snapshot.old"
check "the repaired swap leaves the dotfiles alias resolving" \
  grep -qx 'committed hook' "$remoteSnapshotHome/.dotfiles/snapshot-probe/hook.mjs"
: > "$commandLog"
matchingSnapshotOutput="$(runDevbox ensure)"
check "next ensure skips a matching snapshot" outputHas "$matchingSnapshotOutput" '[present] dotfiles'
check "next ensure transfers no archive" logLacks 'archive --format=tar'
check "next ensure does not bootstrap" logLacks 'bootstrap work-server'
check "every automated SSH disables autostart and activity reporting" \
  bash -c '! grep -vx "true disable" "$1"' _ "$stubState/ssh-safety"

rm -rf "$snapshotFixtureRepo"
mkdir -p "$snapshotFixtureRepo"
cp -R "$repoRoot/." "$snapshotFixtureRepo"
rm -rf "$snapshotFixtureRepo/.git"
"$testGitPath" -C "$snapshotFixtureRepo" init -q -b main
"$testGitPath" -C "$snapshotFixtureRepo" add -A
"$testGitPath" -C "$snapshotFixtureRepo" -c user.name=fixture -c user.email=fixture@example.invalid \
  -c commit.gpgsign=false commit -qm work-server
"$testGitPath" -C "$snapshotFixtureRepo" rev-parse HEAD > "$stubState/work-server-commit"
startEmptyRemoteHome
remoteLocalBin="$remoteSnapshotHome/.local/bin"
mkdir -p "$remoteLocalBin"
ln -s "$BASH" "$remoteLocalBin/bash"
cat > "$remoteLocalBin/claude" <<'STUB'
#!/usr/bin/env bash
printf 'claude %s\n' "$*" >> "$DOTFILES_TEST_LOG"
STUB
cat > "$remoteLocalBin/npm" <<'STUB'
#!/usr/bin/env bash
printf 'npm %s in %s\n' "$*" "$PWD" >> "$DOTFILES_TEST_LOG"
mkdir -p node_modules/.bin
printf '{}\n' > node_modules/.package-lock.json
printf '#!/usr/bin/env bash\nprintf "playwright-core %%s\\n" "$*" >> "$DOTFILES_TEST_LOG"\n' > node_modules/.bin/playwright-core
chmod +x node_modules/.bin/playwright-core
STUB
chmod +x "$remoteLocalBin/claude" "$remoteLocalBin/npm"
cat > "$remoteSnapshotHome/.gitconfig" <<'GITCONFIG'
[user]
	name = Devbox Author
	email = devbox@example.invalid
GITCONFIG
: > "$commandLog"
workServerSnapshotStatus=0
workServerSnapshotOutput="$(runDevbox ensure 2>&1)" || workServerSnapshotStatus=$?
check "the real work-server profile bootstraps a fresh box through ensure" test "$workServerSnapshotStatus" -eq 0
check "the real work-server profile bootstraps with zero warnings" \
  bash -c '[[ -s "$2" ]] && ! grep -qF "[warn" <<< "$1" && ! grep -qF "[warn]" "$2"' _ "$workServerSnapshotOutput" "$remoteBootstrapLog"
check "the real work-server bootstrap resolves npm on the box rather than the test host" logHas 'npm ci --omit=dev in '
check "the real work-server profile records its snapshot commit" \
  cmp -s "$stubState/work-server-commit" "$remoteSnapshotMarker"
check "every hook script the real work-server settings run exists on the box" \
  node -e '
const settings = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const hookScriptPaths = Object.values(settings.hooks).flat().flatMap(entry => entry.hooks)
  .map(hook => hook.command.match(/^node (\S+\.mjs)/)?.[1]).filter(Boolean);
const missingScriptPaths = hookScriptPaths.filter(scriptPath => !require("fs").existsSync(scriptPath));
if (hookScriptPaths.length === 0 || missingScriptPaths.length > 0) { console.error(missingScriptPaths); process.exit(1); }
' "$remoteSnapshotHome/.claude/settings.json"
check "the real work-server profile leaves the glimmervoid config to the provisioner" \
  test ! -e "$remoteSnapshotHome/.glimmervoid/config.json"
check "the real work-server bootstrap runs between prepare and provision" snapshotTransferSitsBetweenPrepareAndProvision
rm -f "$stubState/execute-snapshot"

mergeConfig() {
  runInStubbedSandbox "$sandbox" CODER_WORKSPACE_AGENT_NAME=dev CODER_WORKSPACE_NAME=devbox-fixture \
    CODER_WORKSPACE_OWNER_NAME=fixture bash -s -- 0.29.1 config-only < "$topicDirectory/provision.sh"
}

mergeConfigWithoutWorkspaceName() {
  runInStubbedSandbox "$sandbox" CODER_WORKSPACE_AGENT_NAME=dev CODER_WORKSPACE_OWNER_NAME=fixture \
    env -u CODER_WORKSPACE_NAME bash -s -- 0.29.1 config-only < "$topicDirectory/provision.sh"
}

mkdir -p "$sandbox/.glimmervoid"
cat > "$sandbox/.glimmervoid/config.json" <<'JSON'
{"projects":[{"id":"existing","name":"kept","path":"/another/project"}],"sessions":[{"id":"active","transcript":"keep me"}],"unrelated":{"keep":true},"port":3000,"remote":{"ownerLogin":"retired"}}
JSON
cp "$sandbox/.glimmervoid/config.json" "$stubState/original-config"
mergeOutput="$(mergeConfig)"
check "config merge reports a change" outputHas "$mergeOutput" '[installed] config'
check "config merge has mode 0600" test "$(fileModeOf "$sandbox/.glimmervoid/config.json")" = 600
check "config merge preserves state and installs the requested remote settings" \
  "$testNodePath" - "$sandbox/.glimmervoid/config.json" <<'JS'
const assert = require("node:assert/strict");
const config = require(process.argv[2]);
assert.deepEqual(config.sessions, [{id: "active", transcript: "keep me"}]);
assert.deepEqual(config.unrelated, {keep: true});
assert.equal(config.projects[0].path, "/another/project");
assert.equal(config.projects[1].id, "bcea0337-5a86-4f96-beb3-ea0ea1fcdcf7");
assert.equal(config.port, 3456);
assert.equal(config.checkForUpdates, false);
assert.deepEqual(config.remote, {enabled: true, port: 3457, publicHost: "3457--dev--devbox-fixture--fixture.coder.dev.posthog.dev", allowedOrigins: ["https://3457--dev--devbox-fixture--fixture.coder.dev.posthog.dev"]});
assert.equal(config.coder, undefined);
JS
backups=("$sandbox/.glimmervoid"/config.json.*.bak)
check "config merge backs up the original bytes" cmp -s "$stubState/original-config" "${backups[0]}"
check "config backup has mode 0600" test "$(fileModeOf "${backups[0]}")" = 600
check "config-only waits a bounded time for the provision lock" grep -qx 'flock -w 120 9' "$commandLog"
cp "$sandbox/.glimmervoid/config.json" "$stubState/config-before-held-lock"
touch "$stubState/provision-lock-held"
heldLockMergeStatus=0
heldLockMergeOutput="$(mergeConfig)" || heldLockMergeStatus=$?
check "config-only refuses while another run holds the provision lock" test "$heldLockMergeStatus" -ne 0
check "config-only names the run holding the provision lock" \
  outputHas "$heldLockMergeOutput" '[warned] provision: another run is in progress'
check "config-only under a held lock keeps the config bytes" \
  cmp -s "$stubState/config-before-held-lock" "$sandbox/.glimmervoid/config.json"
rm -f "$stubState/provision-lock-held"
secondMergeOutput="$(mergeConfig)"
check "second config merge reports present" outputHas "$secondMergeOutput" '[present] config'
check "second config merge does not duplicate projects" \
  "$testNodePath" -e 'const config=require(process.argv[1]);process.exit(config.projects.filter((project)=>project.path==="/home/coder/posthog").length===1?0:1)' "$sandbox/.glimmervoid/config.json"
secondBackups=("$sandbox/.glimmervoid"/config.json.*.bak)
check "unchanged merge creates no new backup" test "${#secondBackups[@]}" -eq 1
cp "$sandbox/.glimmervoid/config.json" "$stubState/config-before-missing-host"
missingHostMergeStatus=0
mergeConfigWithoutWorkspaceName >/dev/null 2>&1 || missingHostMergeStatus=$?
check "config-only without a Coder workspace variable fails" test "$missingHostMergeStatus" -ne 0
check "config-only without a Coder workspace variable keeps the config bytes" \
  cmp -s "$stubState/config-before-missing-host" "$sandbox/.glimmervoid/config.json"
missingHostBackups=("$sandbox/.glimmervoid"/config.json.*.bak)
check "config-only without a Coder workspace variable writes no backup" test "${#missingHostBackups[@]}" -eq 1
"$testNodePath" -e '
  const fs = require("node:fs");
  const config = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const { sessions, ...rest } = config;
  fs.writeFileSync(process.argv[1], JSON.stringify({ sessions, ...rest }, null, 2));
' "$sandbox/.glimmervoid/config.json"
cp "$sandbox/.glimmervoid/config.json" "$stubState/server-saved-config"
serverSavedMergeOutput="$(mergeConfig)"
check "a server save without a trailing newline merges as present" outputHas "$serverSavedMergeOutput" '[present] config'
check "a server save without a trailing newline keeps its bytes" cmp -s "$stubState/server-saved-config" "$sandbox/.glimmervoid/config.json"
serverSavedBackups=("$sandbox/.glimmervoid"/config.json.*.bak)
check "a server save without a trailing newline creates no backup" test "${#serverSavedBackups[@]}" -eq 1
printf '{"projects":null,"sessions":["kept"]}\n' > "$sandbox/.glimmervoid/config.json"
mergeConfig >/dev/null
check "a non-array projects value becomes an array without losing sessions" \
  "$testNodePath" -e 'const config=require(process.argv[1]);process.exit(Array.isArray(config.projects)&&config.sessions[0]==="kept"?0:1)' "$sandbox/.glimmervoid/config.json"
printf 'invalid JSON\n' > "$sandbox/.glimmervoid/config.json"
invalidConfigStatus=0
mergeConfig >/dev/null 2>&1 || invalidConfigStatus=$?
check "invalid runtime config fails instead of being replaced" test "$invalidConfigStatus" -ne 0
check "invalid runtime config preserves its bytes" grep -qx 'invalid JSON' "$sandbox/.glimmervoid/config.json"

mkdir -p "$sandbox/dotfiles-snapshot/glimmervoid"
cp "$repoRoot/glimmervoid/config.example.json" "$sandbox/dotfiles-snapshot/glimmervoid/config.example.json"
cp "$stubState/server-saved-config" "$sandbox/.glimmervoid/config.json"
"$testNodePath" - "$sandbox/.glimmervoid/config.json" "$sandbox/dotfiles-snapshot/glimmervoid/config.example.json" <<'JS'
const fs = require("node:fs");
const config = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const defaults = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
config.skipPermissionsByDefault = false;
config.postTurnChecks = { mode: "check", custom: true };
config.branchGc = null;
config.hooks = [{ ...defaults.hooks[0], command: "custom command", enabled: false }, { id: "local-hook", command: "keep me" }];
config.teams = [{ id: "local-team" }];
config.repoRoots = ["/local/root"];
config.sessionRecords = { active: { transcript: "kept" } };
defaults.hooks.push({ id: "new-hook", command: "node {{HOME}}/.claude/hooks/new.mjs" });
defaults.hooks.push({ id: "new-hook", command: "duplicate must be ignored" });
fs.writeFileSync(process.argv[2], JSON.stringify(config));
fs.writeFileSync(process.argv[3], JSON.stringify(defaults));
JS
printf 'live session record\n' > "$sandbox/.glimmervoid/session-record"
cp "$sandbox/.glimmervoid/config.json" "$stubState/config-before-defaults"
defaultsOutput="$(mergeConfig)"
check "operator defaults add missing hooks by id without overwriting live values" \
  "$testNodePath" - "$sandbox/.glimmervoid/config.json" "$stubState/config-before-defaults" "$sandbox" <<'JS'
const assert = require("node:assert/strict");
const fs = require("node:fs");
const config = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const previous = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
for (const settingName of Object.keys(previous)) {
  if (settingName === "hooks") continue;
  assert.deepEqual(config[settingName], previous[settingName]);
}
assert.deepEqual(config.hooks.slice(0, previous.hooks.length), previous.hooks);
assert.deepEqual(config.hooks.slice(previous.hooks.length), [{ id: "new-hook", command: `node ${process.argv[4]}/.claude/hooks/new.mjs` }]);
assert.equal(config.hooks.filter(hook => hook.id === "new-hook").length, 1);
assert.equal(config.autoRecoverSeconds, undefined);
JS
check "operator defaults preserve session record files" grep -qx 'live session record' "$sandbox/.glimmervoid/session-record"
secondDefaultsOutput="$(mergeConfig)"
check "operator defaults are idempotent" outputHas "$secondDefaultsOutput" '[present] config'
importedDefaultsLedger="$sandbox/.glimmervoid/devbox-imported-defaults.json"
check "imported defaults are recorded with mode 0600" test "$(fileModeOf "$importedDefaultsLedger")" = 600
check "imported defaults record every default key and hook id once" \
  "$testNodePath" - "$importedDefaultsLedger" "$sandbox/dotfiles-snapshot/glimmervoid/config.example.json" <<'JS'
const assert = require("node:assert/strict");
const fs = require("node:fs");
const ledger = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const defaults = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
const defaultKeys = ["skipPermissionsByDefault", "postTurnChecks", "branchGc"].filter(settingName => Object.hasOwn(defaults, settingName));
assert.deepEqual([...ledger.keys].sort(), defaultKeys.sort());
assert.deepEqual([...ledger.hookIds].sort(), [...new Set(defaults.hooks.map(hook => hook.id))].sort());
JS
"$testNodePath" - "$sandbox/.glimmervoid/config.json" <<'JS'
const fs = require("node:fs");
const config = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
delete config.skipPermissionsByDefault;
delete config.postTurnChecks;
delete config.branchGc;
config.hooks = config.hooks.filter(hook => hook.id !== "new-hook");
fs.writeFileSync(process.argv[2], JSON.stringify(config));
JS
cp "$sandbox/.glimmervoid/config.json" "$stubState/config-after-operator-removal"
removedDefaultsOutput="$(mergeConfig)"
check "operator-removed defaults report the config current" outputHas "$removedDefaultsOutput" '[present] config'
check "operator-removed defaults and hooks are never imported again" \
  cmp -s "$stubState/config-after-operator-removal" "$sandbox/.glimmervoid/config.json"
rm -f "$importedDefaultsLedger"
mergeConfig >/dev/null
check "defaults never recorded as imported fill only missing settings and hooks from the snapshot" \
  "$testNodePath" - "$sandbox/.glimmervoid/config.json" "$repoRoot/glimmervoid/config.example.json" <<'JS'
const assert = require("node:assert/strict");
const config = require(process.argv[2]);
const defaults = require(process.argv[3]);
for (const settingName of ["skipPermissionsByDefault", "postTurnChecks", "branchGc"]) {
  assert.deepEqual(config[settingName], defaults[settingName]);
}
assert.equal(config.hooks.filter(hook => hook.id === "new-hook").length, 1);
JS
cp "$repoRoot/glimmervoid/config.example.json" "$sandbox/dotfiles-snapshot/glimmervoid/config.example.json"

rm -f "$sandbox/.glimmervoid/config.json" "$importedDefaultsLedger"
export DOTFILES_TEST_NODE_PATH="$testNodePath"
writeStub node <<'STUB'
#!/usr/bin/env bash
case "${2:-}" in
  *snapshot.serverBuild*) printf '0.28.0\n'; exit ;;
esac
exec "$DOTFILES_TEST_NODE_PATH" "$@"
STUB
glimmervoidScriptPath="$sandbox/.local/lib/node_modules/glimmervoid/dist/cli.js"
mkdir -p "${glimmervoidScriptPath%/*}"
cat > "$glimmervoidScriptPath" <<'JS'
#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const stateDirectory = process.env.DOTFILES_TEST_STATE;
fs.appendFileSync(process.env.DOTFILES_TEST_LOG, `glimmervoid ${process.argv.slice(2).join(" ")}\n`);
if (process.argv[2] === "--version") {
  process.stdout.write(fs.readFileSync(path.join(stateDirectory, "glimmervoid-version")));
  process.exit(0);
}
fs.appendFileSync(process.env.DOTFILES_TEST_LOG, `glimmervoid-path ${process.env.PATH}\n`);
fs.writeFileSync(path.join(stateDirectory, "listening-3456"), "");
if (fs.existsSync(path.join(stateDirectory, "no-remote-listener"))) process.exit(0);
fs.writeFileSync(path.join(stateDirectory, "listening-3457"), "");
JS
chmod +x "$glimmervoidScriptPath"
ln -s "$glimmervoidScriptPath" "$stubBin/glimmervoid"
glimmervoidScriptPath="$(readlink -f "$glimmervoidScriptPath")"
writeStub codex <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
writeStub bwrap <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
writeStub socat <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
writeStub npm <<'STUB'
#!/usr/bin/env bash
printf 'npm %s\n' "$*" >> "$DOTFILES_TEST_LOG"
if [[ "$1" == view ]]; then
  [[ ! -f "$DOTFILES_TEST_STATE/npm-view-failed" ]] || exit 1
  printf '%s\n' "${2#glimmervoid@}"
  exit 0
fi
case "$*" in
  *glimmervoid@*)
    [[ ! -f "$DOTFILES_TEST_STATE/npm-install-failed" ]] || exit 1
    printf '%s\n' "${!#}" | sed 's/^glimmervoid@//' > "$DOTFILES_TEST_STATE/glimmervoid-version"
    ;;
  *@openai/codex*) cp "$DOTFILES_TEST_STATE/available/codex" "$DOTFILES_TEST_STUB_BIN/codex" ;;
  *) exit 1 ;;
esac
STUB
writeStub apt-get <<'STUB'
#!/usr/bin/env bash
printf 'apt-get %s\n' "$*" >> "$DOTFILES_TEST_LOG"
case "$*" in
  *bubblewrap*)
    [[ ! -f "$DOTFILES_TEST_STATE/sandbox-install-failed" ]] || exit 1
    cp "$DOTFILES_TEST_STATE/available/bwrap" "$DOTFILES_TEST_STUB_BIN/bwrap"
    ;;
  *socat*) cp "$DOTFILES_TEST_STATE/available/socat" "$DOTFILES_TEST_STUB_BIN/socat" ;;
esac
STUB
writeStub setsid <<'STUB'
#!/usr/bin/env bash
printf 'setsid %s\n' "$*" >> "$DOTFILES_TEST_LOG"
if [[ -e /dev/fd/9 ]]; then touch "$DOTFILES_TEST_STATE/server-inherited-lock"; fi
umask > "$DOTFILES_TEST_STATE/umask-at-start"
cp "$HOME/.glimmervoid/config.json" "$DOTFILES_TEST_STATE/config-at-start"
exec "$@"
STUB
writeContainedSudoStub
writeStub uname <<'STUB'
#!/usr/bin/env bash
printf 'x86_64\n'
STUB
for stubName in node npm apt-get setsid uname; do
  provideCommand "$stubName"
done

instrumentedProvisionPath="$stubState/provision-with-test-listeners.sh"
hasProcCommandLines=0
if [[ -r /proc/self/cmdline ]]; then hasProcCommandLines=1; fi
awk -v hasProcCommandLines="$hasProcCommandLines" '
  $0 == "case \"$devboxAction\" in" {
    print "devboxPortListens() { [[ -f \"$DOTFILES_TEST_STATE/listening-$1\" ]]; }"
    if (hasProcCommandLines == 0) print "devboxProcessCommandLine() { ps -o args= -p \"$1\"; }"
  }
  { print }
' "$topicDirectory/provision.sh" > "$instrumentedProvisionPath"

runRemoteProvision() {
  runInStubbedSandbox "$sandbox" CODER_WORKSPACE_AGENT_NAME=dev CODER_WORKSPACE_NAME=devbox-fixture \
    CODER_WORKSPACE_OWNER_NAME=fixture bash "$instrumentedProvisionPath" 0.29.1 "${1:-provision}"
}

runRemoteProvisionWithoutWorkspaceName() {
  runInStubbedSandbox "$sandbox" CODER_WORKSPACE_AGENT_NAME=dev CODER_WORKSPACE_OWNER_NAME=fixture \
    env -u CODER_WORKSPACE_NAME bash "$instrumentedProvisionPath" 0.29.1 "${1:-provision}"
}

printf '0.28.0\n' > "$stubState/glimmervoid-version"
: > "$commandLog"
remoteOutput="$( (umask 022; runRemoteProvision) )"
check "remote provision installs the requested npm version under the box home" \
  logHas "npm install -g --prefix $sandbox/.local glimmervoid@0.29.1"
check "remote provision installs missing Codex under the box home" logHas "npm install -g --prefix $sandbox/.local @openai/codex"
check "remote provision installs both sandbox packages" bash -c 'grep -q bubblewrap "$1" && grep -q socat "$1"' _ "$commandLog"
check "remote provision detaches the CLI with nohup and its explicit config" \
  logHas "setsid nohup $stubBin/node $glimmervoidScriptPath --config $sandbox/.glimmervoid/config.json"
check "remote provision without a flox environment never calls flox" logLacks 'flox activate'
check "remote provision without a flox environment leaves PATH unchanged" \
  bash -c '! grep -E "^glimmervoid-path .*\.flox" "$1" >/dev/null' _ "$commandLog"
check "remote provision without flox does not report activation" outputLacks "$remoteOutput" 'flox env posthog'
check "remote provision waits for both listeners" outputHas "$remoteOutput" 'both listeners ready'
check "remote provision prints the forwarding URL" outputHas "$remoteOutput" 'https://3457--dev--devbox-fixture--fixture.coder.dev.posthog.dev/'
check "remote provision writes an executable gh wrapper" test -x "$sandbox/.local/bin/gh"
check "gh wrapper acquires external auth only when invoked" grep -qF 'coder external-auth access-token primary-github' "$sandbox/.local/bin/gh"
check "provisioning never acquires a GitHub token" logLacks 'external-auth'
check "server log has mode 0600" test "$(fileModeOf "$sandbox/.glimmervoid/server.log")" = 600
check "glimmervoid starts with the box umask rather than a private one" test "$(cat "$stubState/umask-at-start")" = 0022
check "provisioned config still has mode 0600 under the box umask" test "$(fileModeOf "$sandbox/.glimmervoid/config.json")" = 600
check "provision waits a bounded time for the provision lock" logHas 'flock -w 120 9'
check "the started server never holds the provision lock" test ! -e "$stubState/server-inherited-lock"

rm -f "$stubState/listening-3456" "$stubState/listening-3457"
printf '0.28.0\n' > "$stubState/glimmervoid-version"
touch "$stubState/provision-lock-held"
: > "$commandLog"
heldLockProvisionStatus=0
heldLockProvisionOutput="$(runRemoteProvision)" || heldLockProvisionStatus=$?
check "an overlapping provision fails" test "$heldLockProvisionStatus" -ne 0
check "an overlapping provision names the run in progress" \
  outputHas "$heldLockProvisionOutput" '[warned] provision: another run is in progress'
check "an overlapping provision installs nothing" logLacks 'npm install'
check "an overlapping provision installs no system package" logLacks 'apt-get'
check "an overlapping provision starts no server" logLacks 'setsid'
touch "$stubState/listening-3456" "$stubState/listening-3457"
: > "$commandLog"
heldLockStatusOutput="$(runRemoteProvision status)"
check "status reads the box while a provision holds the lock" outputHas "$heldLockStatusOutput" 'glimmervoid server'
check "status never takes the provision lock" logLacks 'flock'
rm -f "$stubState/provision-lock-held"
printf '0.29.1\n' > "$stubState/glimmervoid-version"

floxBinDirectory="$sandbox/posthog/.flox/run/x86_64-linux.posthog-dev/bin"
mkdir -p "$floxBinDirectory" "$sandbox/posthog/.flox/run/x86_64-linux.posthog-run/bin"
rm -f "$stubState/listening-3456" "$stubState/listening-3457"
: > "$commandLog"
floxRemoteOutput="$(runRemoteProvision)"
check "remote provision launches the captured node and resolved script directly with the flox env present" \
  logHas "setsid nohup $stubBin/node $glimmervoidScriptPath --config $sandbox/.glimmervoid/config.json"
check "remote provision appends the flox bin directory to the server PATH" \
  bash -c 'grep -E "^glimmervoid-path .*:$1\$" "$2" >/dev/null' _ "$floxBinDirectory" "$commandLog"
check "remote provision never appends the run link bin directory" \
  bash -c '! grep -E "^glimmervoid-path .*posthog-run" "$1" >/dev/null' _ "$commandLog"
check "remote provision never activates flox" logLacks 'flox activate'
check "remote provision reports both listeners and the flox environment" \
  outputHas "$floxRemoteOutput" 'both listeners ready; flox env posthog'
rm -rf "$sandbox/posthog/.flox/run"

mkdir -p "$sandbox/posthog/.flox/run/x86_64-linux.first-dev/bin" "$sandbox/posthog/.flox/run/x86_64-linux.second-dev/bin"
rm -f "$stubState/listening-3456" "$stubState/listening-3457"
: > "$commandLog"
ambiguousFloxOutput="$(runRemoteProvision)"
check "ambiguous flox env leaves the server PATH unchanged" \
  bash -c '! grep -E "^glimmervoid-path .*\.flox" "$1" >/dev/null' _ "$commandLog"
check "ambiguous flox env is noted in the status line" outputHas "$ambiguousFloxOutput" 'flox env posthog not on PATH'
rm -rf "$sandbox/posthog/.flox/run"

mkdir -p "$sandbox/posthog/.flox/run/aarch64-linux.posthog-dev/bin" "$sandbox/posthog/.flox/run/aarch64-linux.posthog-run/bin"
rm -f "$stubState/listening-3456" "$stubState/listening-3457"
: > "$commandLog"
otherSystemFloxOutput="$(runRemoteProvision)"
check "flox links for another system leave the server PATH unchanged" \
  bash -c '! grep -E "^glimmervoid-path .*\.flox" "$1" >/dev/null' _ "$commandLog"
check "flox links for another system are noted in the status line" \
  outputHas "$otherSystemFloxOutput" 'flox env posthog not on PATH'
rm -rf "$sandbox/posthog/.flox"

cp "$sandbox/.local/bin/gh" "$stubState/original-wrapper"
: > "$commandLog"
rerunRemoteOutput="$(runRemoteProvision)"
check "remote rerun installs no npm package" logLacks 'npm install'
check "remote rerun installs no sandbox package" logLacks 'bubblewrap'
check "remote rerun preserves the gh wrapper" cmp -s "$sandbox/.local/bin/gh" "$stubState/original-wrapper"
check "remote rerun leaves the running server untouched" logLacks 'setsid'
check "remote rerun reports the running version rather than the upgraded CLI" outputHas "$rerunRemoteOutput" 'already running; 0.28.0; left running'
check "remote rerun reports no changes" outputLacks "$rerunRemoteOutput" '[installed]'

"$testNodePath" - "$sandbox/.glimmervoid/config.json" <<'JS'
const fs = require("node:fs");
const config = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
delete config.postTurnChecks;
config.hooks = [];
fs.writeFileSync(process.argv[2], JSON.stringify(config));
JS
cp "$sandbox/.glimmervoid/config.json" "$stubState/config-after-removal-while-running"
: > "$commandLog"
removedWhileRunningOutput="$(runRemoteProvision)"
check "operator-removed defaults raise no pending warning while the server runs" \
  outputLacks "$removedWhileRunningOutput" '[warned] config'
check "operator-removed defaults stay removed while the server runs" \
  cmp -s "$stubState/config-after-removal-while-running" "$sandbox/.glimmervoid/config.json"
rm -f "$importedDefaultsLedger"
cp "$sandbox/.glimmervoid/config.json" "$stubState/config-before-pending-defaults"
: > "$commandLog"
pendingDefaultsOutput="$(runRemoteProvision)"
check "defaults never imported are pending while the server runs" outputHas "$pendingDefaultsOutput" '[warned] config: changes pending'
check "pending defaults are not recorded as imported" test ! -e "$importedDefaultsLedger"
check "pending defaults leave live config bytes untouched" \
  cmp -s "$stubState/config-before-pending-defaults" "$sandbox/.glimmervoid/config.json"
check "pending defaults never restart the server" logLacks 'setsid'
rm -f "$stubState/listening-3456" "$stubState/listening-3457"
runRemoteProvision >/dev/null
check "not-running provision applies pending defaults before starting" \
  "$testNodePath" - "$stubState/config-at-start" "$repoRoot/glimmervoid/config.example.json" <<'JS'
const assert = require("node:assert/strict");
const fs = require("node:fs");
const config = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const defaults = require(process.argv[3]);
assert.deepEqual(config.postTurnChecks, defaults.postTurnChecks);
assert.equal(config.hooks[0].id, defaults.hooks[0].id);
JS
check "applied defaults are recorded as imported" test -f "$importedDefaultsLedger"

rm -f "$stubState/listening-3457"
: > "$commandLog"
missingRemoteOutput="$(runRemoteProvision)"
check "a running server without its remote listener warns without restarting" outputHas "$missingRemoteOutput" 'run devbox restart-glimmervoid'
check "a running server without its remote listener stays running" logLacks 'setsid'

withdrawCommand bwrap
touch "$stubState/sandbox-install-failed"
optionalFailureOutput="$(runRemoteProvision)"
check "optional sandbox failure does not fail provision" outputHas "$optionalFailureOutput" '[warned] bwrap'
rm -f "$stubState/sandbox-install-failed"

touch "$stubState/listening-3456" "$stubState/listening-3457"
printf '0.28.0\n' > "$stubState/glimmervoid-version"
printf '{"port":3000,"sessions":["live"]}' > "$sandbox/.glimmervoid/config.json"
rm -f "$importedDefaultsLedger"
cp "$sandbox/.glimmervoid/config.json" "$stubState/live-config"
backupsBeforePending=("$sandbox/.glimmervoid"/config.json.*.bak)
: > "$commandLog"
pendingOutput="$(runRemoteProvision)"
check "a running server is never reinstalled under itself" logLacks 'glimmervoid@'
check "a running server names the pending release" \
  outputHas "$pendingOutput" '[warned] glimmervoid: 0.28.0 running, 0.29.1 pending; run devbox restart-glimmervoid'
check "a running server keeps its config bytes" cmp -s "$stubState/live-config" "$sandbox/.glimmervoid/config.json"
backupsAfterPending=("$sandbox/.glimmervoid"/config.json.*.bak)
check "a pending config writes no backup" test "${#backupsAfterPending[@]}" -eq "${#backupsBeforePending[@]}"
check "a running server names the pending config" outputHas "$pendingOutput" '[warned] config: changes pending; run devbox restart-glimmervoid'
check "a running server with pending changes is left running" logLacks 'setsid'

writeStub ss <<'STUB'
#!/usr/bin/env bash
printf 'ss %s\n' "$*" >> "$DOTFILES_TEST_LOG"
printf 'State  Recv-Q Send-Q Local Address:Port Peer Address:Port Process\n'
[[ -f "$DOTFILES_TEST_STATE/listener-pid" ]] || exit 0
printf 'LISTEN 0      511        127.0.0.1:3456      0.0.0.0:*    users:(("node",pid=%s,fd=21))\n' "$(cat "$DOTFILES_TEST_STATE/listener-pid")"
STUB
provideCommand ss
: > "$commandLog"
unknownListenerStatus=0
unknownListenerOutput="$(runRemoteProvision restart)" || unknownListenerStatus=$?
check "restart refuses to stop an unidentified listener" test "$unknownListenerStatus" -ne 0
check "restart explains why an unidentified listener stays running" outputHas "$unknownListenerOutput" 'cannot identify listener PID; left running'
check "restart does not start a second server over an unidentified listener" logLacks 'setsid'

fixtureListenerPids=()
stopFixtureListeners() {
  local fixturePid
  for fixturePid in ${fixtureListenerPids[@]+"${fixtureListenerPids[@]}"}; do
    kill -TERM "$fixturePid" 2>/dev/null || true
  done
}
registerCleanup stopFixtureListeners

waitForListenerPid() {
  local attempt
  for attempt in {1..50}; do
    if [[ -s "$stubState/listener-pid" ]]; then
      cat "$stubState/listener-pid"
      return 0
    fi
    sleep 0.1
  done
  return 1
}

firstLogLineOf() {
  grep -nF -- "$1" "$commandLog" | head -1 | cut -d: -f1
}

fixtureGlimmervoidScript="$sandbox/.local/lib/node_modules/glimmervoid/dist/fixture-server.js"
cat > "$fixtureGlimmervoidScript" <<'JS'
const fs = require("node:fs");
const path = require("node:path");
const stateDirectory = process.argv[2];
const sandboxHome = process.argv[3];
process.on("SIGTERM", () => {
  fs.copyFileSync(path.join(sandboxHome, ".glimmervoid/config.json"), path.join(stateDirectory, "config-at-stop"));
  fs.appendFileSync(path.join(stateDirectory, "commands.log"), "fixture server stopped\n");
  fs.unlinkSync(path.join(stateDirectory, "listening-3456"));
  fs.unlinkSync(path.join(stateDirectory, "listening-3457"));
  process.exit(0);
});
fs.writeFileSync(path.join(stateDirectory, "listener-pid"), String(process.pid));
setInterval(() => {}, 100);
JS

startFixtureGlimmervoidServer() {
  touch "$stubState/listening-3456" "$stubState/listening-3457"
  printf '0.28.0\n' > "$stubState/glimmervoid-version"
  rm -f "$stubState/listener-pid" "$stubState/config-at-stop" "$stubState/config-at-start"
  ("$testNodePath" "$fixtureGlimmervoidScript" "$stubState" "$sandbox" --config "$sandbox/.glimmervoid/config.json" &)
  glimmervoidListenerPid="$(waitForListenerPid)"
  fixtureListenerPids+=("$glimmervoidListenerPid")
}

startFixtureGlimmervoidServer
: > "$commandLog"
glimmervoidRestartStatus=0
glimmervoidRestartOutput="$(runRemoteProvision restart)" || glimmervoidRestartStatus=$?
check "restart of an identified glimmervoid listener succeeds" test "$glimmervoidRestartStatus" -eq 0
check "restart reads the listener PID from ss" logHas "ss -ltnp sport = :3456"
check "restart terminates the identified glimmervoid listener" bash -c '! kill -0 "$1" 2>/dev/null' _ "$glimmervoidListenerPid"
check "restart reports the old server stopped" outputHas "$glimmervoidRestartOutput" '[installed] glimmervoid server: stopped'
check "restart starts a fresh detached server" logHas "setsid nohup $stubBin/node $glimmervoidScriptPath --config $sandbox/.glimmervoid/config.json"
check "restart installs the pinned release after the server stops" \
  test "$(firstLogLineOf 'fixture server stopped')" -lt "$(firstLogLineOf "npm install -g --prefix $sandbox/.local glimmervoid@0.29.1")"
check "restart installs the pinned release before the server starts" \
  test "$(firstLogLineOf "npm install -g --prefix $sandbox/.local glimmervoid@0.29.1")" -lt "$(firstLogLineOf 'setsid nohup')"
check "restart confirms the pinned release is published before the server stops" \
  test "$(firstLogLineOf 'npm view glimmervoid@0.29.1 version')" -lt "$(firstLogLineOf 'fixture server stopped')"
check "restart leaves the config unmerged while the server runs" grep -q '"port":3000' "$stubState/config-at-stop"
check "restart applies operator defaults after stopping and before starting" \
  "$testNodePath" - "$stubState/config-at-stop" "$stubState/config-at-start" "$repoRoot/glimmervoid/config.example.json" <<'JS'
const assert = require("node:assert/strict");
const fs = require("node:fs");
const before = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const after = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
const defaults = require(process.argv[4]);
assert.equal(before.postTurnChecks, undefined);
assert.deepEqual(after.postTurnChecks, defaults.postTurnChecks);
assert.equal(after.hooks[0].id, defaults.hooks[0].id);
assert.deepEqual(after.sessions, before.sessions);
JS
check "restart merges the config before the server starts" \
  "$testNodePath" -e 'process.exit(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).port === 3456 ? 0 : 1)' "$stubState/config-at-start"

startFixtureGlimmervoidServer
cp "$sandbox/.glimmervoid/config.json" "$stubState/config-before-missing-host-restart"
backupsBeforeMissingHostRestart=("$sandbox/.glimmervoid"/config.json.*.bak)
: > "$commandLog"
missingHostRestartStatus=0
missingHostRestartOutput="$(runRemoteProvisionWithoutWorkspaceName restart 2>&1)" || missingHostRestartStatus=$?
check "restart without a Coder workspace variable fails" test "$missingHostRestartStatus" -ne 0
check "restart without a Coder workspace variable explains the refusal" outputHas "$missingHostRestartOutput" '[warned] devbox host'
check "restart without a Coder workspace variable kills nothing" kill -0 "$glimmervoidListenerPid"
check "restart without a Coder workspace variable installs nothing" logLacks 'npm'
check "restart without a Coder workspace variable starts nothing" logLacks 'setsid'
check "restart without a Coder workspace variable keeps the config bytes" \
  cmp -s "$stubState/config-before-missing-host-restart" "$sandbox/.glimmervoid/config.json"
backupsAfterMissingHostRestart=("$sandbox/.glimmervoid"/config.json.*.bak)
check "restart without a Coder workspace variable writes no backup" \
  test "${#backupsAfterMissingHostRestart[@]}" -eq "${#backupsBeforeMissingHostRestart[@]}"

touch "$stubState/provision-lock-held"
: > "$commandLog"
heldLockRestartStatus=0
heldLockRestartOutput="$(runRemoteProvision restart)" || heldLockRestartStatus=$?
check "restart waits behind a running ensure or provision" test "$heldLockRestartStatus" -ne 0
check "restart names the run holding the provision lock" \
  outputHas "$heldLockRestartOutput" '[warned] provision: another run is in progress'
check "restart behind a held lock kills nothing" kill -0 "$glimmervoidListenerPid"
check "restart behind a held lock installs nothing" logLacks 'npm'
check "restart behind a held lock starts nothing" logLacks 'setsid'
rm -f "$stubState/provision-lock-held"

printf '{"port":3000,}\n' > "$sandbox/.glimmervoid/config.json"
cp "$sandbox/.glimmervoid/config.json" "$stubState/config-before-invalid-restart"
: > "$commandLog"
invalidConfigRestartStatus=0
invalidConfigRestartOutput="$(runRemoteProvision restart 2>&1)" || invalidConfigRestartStatus=$?
check "restart with invalid config JSON fails" test "$invalidConfigRestartStatus" -ne 0
check "restart with invalid config JSON explains the refusal" \
  outputHas "$invalidConfigRestartOutput" '[warned] config: config.json is invalid JSON; left unchanged; left running'
check "restart with invalid config JSON leaves the server running" kill -0 "$glimmervoidListenerPid"
check "restart with invalid config JSON installs nothing" logLacks 'npm install'
check "restart with invalid config JSON starts nothing" logLacks 'setsid'
check "restart with invalid config JSON keeps the config bytes" \
  cmp -s "$stubState/config-before-invalid-restart" "$sandbox/.glimmervoid/config.json"
cp "$stubState/config-before-missing-host-restart" "$sandbox/.glimmervoid/config.json"

touch "$stubState/npm-view-failed"
: > "$commandLog"
unpublishedRestartStatus=0
unpublishedRestartOutput="$(runRemoteProvision restart)" || unpublishedRestartStatus=$?
check "restart of an unpublished release fails" test "$unpublishedRestartStatus" -ne 0
check "restart of an unpublished release explains the refusal" \
  outputHas "$unpublishedRestartOutput" '[warned] glimmervoid: 0.29.1 not found on the npm registry; server left running'
check "restart of an unpublished release leaves the server running" kill -0 "$glimmervoidListenerPid"
check "restart of an unpublished release installs nothing" logLacks 'npm install'
check "restart of an unpublished release starts nothing" logLacks 'setsid'
rm -f "$stubState/npm-view-failed"

touch "$stubState/npm-install-failed"
: > "$commandLog"
failedInstallRestartStatus=0
failedInstallRestartOutput="$(runRemoteProvision restart)" || failedInstallRestartStatus=$?
check "restart with a failed install fails" test "$failedInstallRestartStatus" -ne 0
check "restart with a failed install names the fallback release" \
  outputHas "$failedInstallRestartOutput" '[warned] glimmervoid: install of 0.29.1 failed; starting installed 0.28.0 instead'
check "restart with a failed install still stops the old server first" bash -c '! kill -0 "$1" 2>/dev/null' _ "$glimmervoidListenerPid"
check "restart with a failed install starts the previous release" logHas "setsid nohup $stubBin/node $glimmervoidScriptPath --config $sandbox/.glimmervoid/config.json"
check "restart with a failed install brings both listeners up" outputHas "$failedInstallRestartOutput" 'both listeners ready'
rm -f "$stubState/npm-install-failed"

touch "$stubState/listening-3456" "$stubState/listening-3457"
printf '0.28.0\n' > "$stubState/glimmervoid-version"
cp "$sandbox/.glimmervoid/config.json" "$stubState/config-before-foreign-restart"
rm -f "$stubState/listener-pid"
(sleep 300 & printf '%s\n' "$!" > "$stubState/listener-pid")
foreignListenerPid="$(waitForListenerPid)"
fixtureListenerPids+=("$foreignListenerPid")
: > "$commandLog"
foreignRestartStatus=0
foreignRestartOutput="$(runRemoteProvision restart)" || foreignRestartStatus=$?
check "restart refuses a listener that is not glimmervoid" test "$foreignRestartStatus" -ne 0
check "restart explains why a foreign listener stays running" outputHas "$foreignRestartOutput" 'listener is not glimmervoid; left running'
check "restart never signals a foreign listener" kill -0 "$foreignListenerPid"
check "restart does not start a server over a foreign listener" logLacks 'setsid'
check "restart installs nothing while a foreign listener holds the port" logLacks 'npm install'
check "restart leaves the config alone while a foreign listener holds the port" \
  cmp -s "$stubState/config-before-foreign-restart" "$sandbox/.glimmervoid/config.json"
kill -TERM "$foreignListenerPid" 2>/dev/null || true
rm -f "$stubState/listener-pid"

rm -f "$stubState/listening-3456" "$stubState/listening-3457"
printf '0.28.0\n' > "$stubState/glimmervoid-version"
touch "$stubState/npm-install-failed"
: > "$commandLog"
failedInstallProvisionStatus=0
failedInstallProvisionOutput="$(runRemoteProvision)" || failedInstallProvisionStatus=$?
check "provision with a failed install fails" test "$failedInstallProvisionStatus" -ne 0
check "provision with a failed install names the fallback release" \
  outputHas "$failedInstallProvisionOutput" '[warned] glimmervoid: install of 0.29.1 failed; starting installed 0.28.0 instead'
check "provision with a failed install starts the previous release" logHas "setsid nohup $stubBin/node $glimmervoidScriptPath --config $sandbox/.glimmervoid/config.json"
check "provision with a failed install still prints the forwarding URL" \
  outputHas "$failedInstallProvisionOutput" 'https://3457--dev--devbox-fixture--fixture.coder.dev.posthog.dev/'
rm -f "$stubState/npm-install-failed"

rm -rf "$snapshotFixtureRepo"
mkdir -p "$snapshotFixtureRepo/script" "$snapshotFixtureRepo/profiles/work-server" \
  "$snapshotFixtureRepo/fresh-box-probe" "$snapshotFixtureRepo/glimmervoid"
cp -R "$repoRoot/script/." "$snapshotFixtureRepo/script/"
printf '{"platform":"linux","topics":["fresh-box-probe"]}\n' > "$snapshotFixtureRepo/profiles/work-server/profile.json"
printf '#!/usr/bin/env bash\nexit 0\n' > "$snapshotFixtureRepo/fresh-box-probe/install.sh"
cp "$repoRoot/glimmervoid/config.example.json" "$snapshotFixtureRepo/glimmervoid/config.example.json"
"$testGitPath" -C "$snapshotFixtureRepo" init -q -b main
"$testGitPath" -C "$snapshotFixtureRepo" add .
"$testGitPath" -C "$snapshotFixtureRepo" -c user.name=fixture -c user.email=fixture@example.invalid \
  -c commit.gpgsign=false commit -qm fresh-box
startEmptyRemoteHome
rm -f "$stubState/listening-3456" "$stubState/listening-3457" "$stubState/config-at-start"
printf '0.28.0\n' > "$stubState/glimmervoid-version"
touch "$stubState/execute-snapshot" "$stubState/execute-provision"
: > "$commandLog"
freshBoxStatus=0
freshBoxOutput="$(runDevbox ensure 2>&1)" || freshBoxStatus=$?
check "a fresh box ensure through the real provision phases succeeds" test "$freshBoxStatus" -eq 0
check "a fresh box bootstraps the snapshot between prepare and provision" snapshotTransferSitsBetweenPrepareAndProvision
check "a fresh box starts its server exactly once" test "$(countLogLines '^setsid nohup ')" -eq 1
check "a fresh box reports no pending config" outputLacks "$freshBoxOutput" 'changes pending'
check "a fresh box starts its server with the imported operator defaults" \
  "$testNodePath" - "$stubState/config-at-start" "$repoRoot/glimmervoid/config.example.json" "$remoteSnapshotHome" <<'JS'
const assert = require("node:assert/strict");
const fs = require("node:fs");
const config = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const defaults = JSON.parse(fs.readFileSync(process.argv[3], "utf8"), (_key, value) =>
  typeof value === "string" ? value.replaceAll("{{HOME}}", process.argv[4]) : value);
for (const settingName of ["skipPermissionsByDefault", "postTurnChecks", "branchGc"]) {
  assert.deepEqual(config[settingName], defaults[settingName]);
}
assert.deepEqual(config.hooks, defaults.hooks);
JS
: > "$commandLog"
freshBoxSecondEnsureOutput="$(runDevbox ensure 2>&1)"
check "the ensure after a fresh box prints no pending config warning" outputLacks "$freshBoxSecondEnsureOutput" 'changes pending'
check "the ensure after a fresh box finds the config current" outputHas "$freshBoxSecondEnsureOutput" '[present] config: current'
check "the ensure after a fresh box leaves its server running" logLacks 'setsid'
rm -f "$stubState/execute-snapshot" "$stubState/execute-provision"
printf '0.28.0\n' > "$stubState/glimmervoid-version"

writeStub sleep <<'STUB'
#!/usr/bin/env bash
printf 'sleep %s\n' "$*" >> "$DOTFILES_TEST_LOG"
STUB
provideCommand sleep
rm -f "$stubState/listening-3456" "$stubState/listening-3457"
touch "$stubState/no-remote-listener"
: > "$commandLog"
startupFailureStatus=0
startupFailureOutput="$(runRemoteProvision restart)" || startupFailureStatus=$?
check "startup fails when both listeners do not become ready" test "$startupFailureStatus" -ne 0
check "startup failure names the server log" outputHas "$startupFailureOutput" 'listeners not ready after 15s; see ~/.glimmervoid/server.log'
check "startup readiness waits are bounded to 15 seconds" test "$(countLogLines '^sleep 0.5$')" -eq 30

reportTopicResults devbox
