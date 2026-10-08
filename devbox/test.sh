#!/usr/bin/env bash
set -euo pipefail

topicDirectory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repoRoot="$(cd -- "$topicDirectory/.." && pwd)"
export DOTFILES_PLATFORM=linux
source "$repoRoot/test/harness.sh"

startStubbedSandbox devbox
linkCoreUtilities bash env cat sed awk grep head tail tr mkdir rm cp mv ln readlink dirname chmod cmp hostname touch mktemp stat wc sleep ps
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
    cat > "$DOTFILES_TEST_STATE/pushed-script"
    printf '%s\n' "${CODER_SSH_DISABLE_AUTOSTART:-}" > "$DOTFILES_TEST_STATE/ssh-autostart-disabled"
    bash -c "set -- ${*:4}; printf '%s\\n' \"\$@\"" > "$DOTFILES_TEST_STATE/remote-arguments"
    [[ ! -f "$DOTFILES_TEST_STATE/ssh-failed" ]] || exit 1
    if [[ -f "$DOTFILES_TEST_STATE/provision-output" ]]; then
      cat "$DOTFILES_TEST_STATE/provision-output"
      exit 0
    fi
    printf '[present] fixture: provisioned\nhttps://fixture.invalid/\n'
    ;;
  *) exit 1 ;;
esac
STUB

runInstall() {
  runInStubbedSandbox "$sandbox" DOTFILES_PROFILE=work NO_COLOR=1 bash "$topicDirectory/install.sh"
}

runDevbox() {
  runInStubbedSandbox "$sandbox" bash -c 'source "$1/commands.bash"; shift; devbox "$@"' _ "$topicDirectory" "$@"
}

printf '\ndevbox topic\n'
printf 'running\n' > "$stubState/workspace-status"
missingCoderOutput="$(runInstall)"
check "absent Coder skips cleanly without a warning" outputLacks "$missingCoderOutput" '[warn]'
check "absent Coder explains the skip" outputHas "$missingCoderOutput" 'Coder CLI absent'
check "absent Coder never connects" logLacks 'coder ssh'

mkdir -p "$sandbox/.local/bin"
cp "$stubState/available/coder" "$sandbox/.local/bin/coder"
touch "$stubState/logged-out"
loggedOutOutput="$(runInstall)"
check "logged-out converge explains the skip" outputHas "$loggedOutOutput" 'not logged in'
check "logged-out converge does not warn" outputLacks "$loggedOutOutput" '[warn]'
check "logged-out converge never connects" logLacks 'coder ssh'
check "logged-out converge never starts a box" logLacks 'coder start'
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
rm -f "$stubState/no-workspace"

for workspaceStatus in stopped starting failed; do
  printf '%s\n' "$workspaceStatus" > "$stubState/workspace-status"
  : > "$commandLog"
  skippedOutput="$(runInstall)"
  check "$workspaceStatus workspace skips without warning" outputLacks "$skippedOutput" '[warn]'
  check "$workspaceStatus workspace names its status" outputHas "$skippedOutput" "is $workspaceStatus"
  check "$workspaceStatus workspace never connects" logLacks 'coder ssh'
  check "$workspaceStatus workspace never starts from converge" logLacks 'coder start'
done

printf 'running\n' > "$stubState/workspace-status"
: > "$commandLog"
runningOutput="$(runInstall)"
check "running converge pushes with the pinned release" logHas 'coder ssh devbox-fixture -- bash -s -- 0.29.1 provision'
check "running converge pipes the exact standalone script" cmp -s "$topicDirectory/provision.sh" "$stubState/pushed-script"
check "SSH cannot auto-start a box after a status race" grep -qx true "$stubState/ssh-autostart-disabled"
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
check "up waits through the default Coder ssh behavior" logHas 'coder ssh devbox-fixture -- bash -s -- 0.29.1 provision'
check "up pushes the exact standalone script" cmp -s "$topicDirectory/provision.sh" "$stubState/pushed-script"
check "up prints the dashboard URL" outputHas "$upOutput" 'https://fixture.invalid/'
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
check "affirmative confirmation requests the shared restart" logHas '0.29.1 restart'
: > "$commandLog"
runDevbox restart-glimmervoid --yes >/dev/null
check "explicit yes requests the shared restart" logHas '0.29.1 restart'

: > "$commandLog"
runDevbox pair "laptop's label; literal" >/dev/null
check "pair preserves a quoted label through the remote shell" \
  test "$(tail -1 "$stubState/remote-arguments")" = "laptop's label; literal"
check "pair sends exactly one label argument" test "$(wc -l < "$stubState/remote-arguments" | tr -d ' ')" -eq 6
runDevbox pair >/dev/null
check "pair defaults to the laptop hostname" test "$(tail -1 "$stubState/remote-arguments")" = "$(hostname)"
: > "$commandLog"
statusOutput="$(runDevbox status)"
check "status reports the workspace" outputHas "$statusOutput" 'workspace devbox-fixture: running'
check "status uses the shared remote status action" logHas '0.29.1 status'
check "status never starts a workspace" logLacks 'coder start'
printf 'stopped\n' > "$stubState/workspace-status"
: > "$commandLog"
stoppedStatusOutput="$(runDevbox status)"
check "stopped status does not connect" logLacks 'coder ssh'
check "stopped status prints the owner forwarding URL" outputHas "$stoppedStatusOutput" 'https://3457--dev--devbox-fixture--fixture.coder.dev.posthog.dev/'

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

rm -f "$sandbox/.glimmervoid/config.json"
export DOTFILES_TEST_NODE_PATH="$testNodePath"
writeStub node <<'STUB'
#!/usr/bin/env bash
case "${2:-}" in
  *snapshot.serverBuild*) printf '0.28.0\n'; exit ;;
esac
exec "$DOTFILES_TEST_NODE_PATH" "$@"
STUB
writeStub glimmervoid <<'STUB'
#!/usr/bin/env bash
printf 'glimmervoid %s\n' "$*" >> "$DOTFILES_TEST_LOG"
[[ "$1" == --version ]] || exit 1
cat "$DOTFILES_TEST_STATE/glimmervoid-version"
STUB
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
umask > "$DOTFILES_TEST_STATE/umask-at-start"
cp "$HOME/.glimmervoid/config.json" "$DOTFILES_TEST_STATE/config-at-start"
touch "$DOTFILES_TEST_STATE/listening-3456"
[[ ! -f "$DOTFILES_TEST_STATE/no-remote-listener" ]] || exit 0
touch "$DOTFILES_TEST_STATE/listening-3457"
STUB
writeContainedSudoStub
for stubName in node glimmervoid npm apt-get setsid; do
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
  logHas "setsid nohup glimmervoid --config $sandbox/.glimmervoid/config.json"
check "remote provision waits for both listeners" outputHas "$remoteOutput" 'both listeners ready'
check "remote provision prints the forwarding URL" outputHas "$remoteOutput" 'https://3457--dev--devbox-fixture--fixture.coder.dev.posthog.dev/'
check "remote provision writes an executable gh wrapper" test -x "$sandbox/.local/bin/gh"
check "gh wrapper acquires external auth only when invoked" grep -qF 'coder external-auth access-token primary-github' "$sandbox/.local/bin/gh"
check "provisioning never acquires a GitHub token" logLacks 'external-auth'
check "server log has mode 0600" test "$(fileModeOf "$sandbox/.glimmervoid/server.log")" = 600
check "glimmervoid starts with the box umask rather than a private one" test "$(cat "$stubState/umask-at-start")" = 0022
check "provisioned config still has mode 0600 under the box umask" test "$(fileModeOf "$sandbox/.glimmervoid/config.json")" = 600

cp "$sandbox/.local/bin/gh" "$stubState/original-wrapper"
: > "$commandLog"
rerunRemoteOutput="$(runRemoteProvision)"
check "remote rerun installs no npm package" logLacks 'npm install'
check "remote rerun installs no sandbox package" logLacks 'bubblewrap'
check "remote rerun preserves the gh wrapper" cmp -s "$sandbox/.local/bin/gh" "$stubState/original-wrapper"
check "remote rerun leaves the running server untouched" logLacks 'setsid'
check "remote rerun reports the running version rather than the upgraded CLI" outputHas "$rerunRemoteOutput" 'already running; 0.28.0; left running'
check "remote rerun reports no changes" outputLacks "$rerunRemoteOutput" '[installed]'

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

cat > "$stubState/glimmervoid-fixture-server" <<'SERVER'
#!/usr/bin/env bash
stateDirectory="$1"
sandboxHome="$2"
trap 'cp "$sandboxHome/.glimmervoid/config.json" "$stateDirectory/config-at-stop"; printf "fixture server stopped\n" >> "$stateDirectory/commands.log"; rm -f "$stateDirectory/listening-3456" "$stateDirectory/listening-3457"; exit 0' TERM
printf '%s\n' "$$" > "$stateDirectory/listener-pid"
while :; do sleep 0.1; done
SERVER
chmod +x "$stubState/glimmervoid-fixture-server"

startFixtureGlimmervoidServer() {
  touch "$stubState/listening-3456" "$stubState/listening-3457"
  printf '0.28.0\n' > "$stubState/glimmervoid-version"
  rm -f "$stubState/listener-pid" "$stubState/config-at-stop" "$stubState/config-at-start"
  ("$stubState/glimmervoid-fixture-server" "$stubState" "$sandbox" &)
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
check "restart starts a fresh detached server" logHas "setsid nohup glimmervoid --config $sandbox/.glimmervoid/config.json"
check "restart installs the pinned release after the server stops" \
  test "$(firstLogLineOf 'fixture server stopped')" -lt "$(firstLogLineOf "npm install -g --prefix $sandbox/.local glimmervoid@0.29.1")"
check "restart installs the pinned release before the server starts" \
  test "$(firstLogLineOf "npm install -g --prefix $sandbox/.local glimmervoid@0.29.1")" -lt "$(firstLogLineOf 'setsid nohup')"
check "restart confirms the pinned release is published before the server stops" \
  test "$(firstLogLineOf 'npm view glimmervoid@0.29.1 version')" -lt "$(firstLogLineOf 'fixture server stopped')"
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
check "restart with a failed install starts the previous release" logHas "setsid nohup glimmervoid --config $sandbox/.glimmervoid/config.json"
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
check "provision with a failed install starts the previous release" logHas "setsid nohup glimmervoid --config $sandbox/.glimmervoid/config.json"
check "provision with a failed install still prints the forwarding URL" \
  outputHas "$failedInstallProvisionOutput" 'https://3457--dev--devbox-fixture--fixture.coder.dev.posthog.dev/'
rm -f "$stubState/npm-install-failed"

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
