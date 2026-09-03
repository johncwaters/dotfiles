#!/usr/bin/env bash
# One sandbox home per profile, because the seed a profile picks is the difference.

set -uo pipefail

topicDir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repoRoot="$(cd -- "$topicDir/.." && pwd)"
# shellcheck source=../test/harness.sh
source "$repoRoot/test/harness.sh"
# shellcheck source=../script/lib/state.sh
source "$repoRoot/script/lib/state.sh"

suiteSkipsTheRealHomeCheck=1

startStubbedSandbox "glissa"
toolingHome="$sandbox"
startSandboxHome "glissa-personal"
personalHome="$sandbox"
startSandboxHome "glissa-server"
serverHome="$sandbox"
startSandboxHome "glissa-unauthed"
unauthedHome="$sandbox"
startSandboxHome "glissa-optout"
optOutHome="$sandbox"
startSandboxHome "glissa-symlinked"
symlinkedHome="$sandbox"
startSandboxHome "glissa-broken"
brokenConfigHome="$sandbox"
startSandboxHome "glissa-unowned"
unownedRouteHome="$sandbox"
startSandboxHome "glissa-badstatus"
badStatusHome="$sandbox"
startSandboxHome "glissa-unresolved"
unresolvedProfileHome="$sandbox"
startSandboxHome "glissa-pending-deps"
pendingDepsHome="$sandbox"
startSandboxHome "glissa-missing-app"
missingAppHome="$sandbox"
startSandboxHome "glissa-invalid-app"
invalidAppHome="$sandbox"
startSandboxHome "glissa-local-seed"
localSeedHome="$sandbox"

realHome="$HOME"
realNodePath="$(command -v node 2>/dev/null || true)"
if [[ -z "$realNodePath" ]]; then
  printf 'glissa/test.sh needs node on PATH: the installer reads the dashboard config with it.\n' >&2
  exit 1
fi

sandboxTemp="$toolingHome/tmp"

mkdir -p "$sandboxTemp"

linkCoreUtilities bash sh env cat sed awk grep tail head cut tr find sort uniq wc mktemp rm \
  mkdir rmdir cp mv ln readlink basename dirname chmod cksum cmp id date stat touch true false \
  xargs od tee expr sleep printf test timeout

writeStub systemctl <<'STUB'
#!/usr/bin/env bash
printf 'systemctl %s\n' "$*" >> "$DOTFILES_TEST_LOG"
stateDir="$DOTFILES_TEST_STATE/$DOTFILES_TEST_MACHINE"
mkdir -p "$stateDir"
if [[ -f "$stateDir/systemd-unreachable" ]]; then
  exit 1
fi
case "${2:-}" in
  is-enabled)
    [[ -f "$stateDir/unit-enabled" ]]
    exit $?
    ;;
  is-active)
    [[ -f "$stateDir/unit-active" ]]
    exit $?
    ;;
  enable)
    touch "$stateDir/unit-enabled" "$stateDir/unit-active"
    exit 0
    ;;
  start | restart)
    touch "$stateDir/unit-active"
    exit 0
    ;;
esac
exit 0
STUB
provideCommand systemctl

writeStub systemd-run <<'STUB'
#!/usr/bin/env bash
printf 'systemd-run %s\n' "$*" >> "$DOTFILES_TEST_LOG"
exit 0
STUB
provideCommand systemd-run

writeStub loginctl <<'STUB'
#!/usr/bin/env bash
printf 'loginctl %s\n' "$*" >> "$DOTFILES_TEST_LOG"
stateDir="$DOTFILES_TEST_STATE/$DOTFILES_TEST_MACHINE"
mkdir -p "$stateDir"
if [[ "${1:-}" == "--no-ask-password" ]]; then
  shift
fi
if [[ "${1:-}" == "show-user" ]]; then
  if [[ -f "$stateDir/linger-enabled" ]]; then
    printf 'yes\n'
    exit 0
  fi
  printf 'no\n'
  exit 0
fi
if [[ "${1:-}" == "enable-linger" ]]; then
  touch "$stateDir/linger-enabled"
  exit 0
fi
exit 0
STUB
provideCommand loginctl

# The account handed to loginctl must come from the passwd database, so the stub answers with a name USER never holds.
writeStub id <<'STUB'
#!/usr/bin/env bash
if [[ "${1:-}" == "-un" ]]; then
  printf 'sandboxaccount\n'
  exit 0
fi
exec "$DOTFILES_TEST_CORE_BIN/id" "$@"
STUB
provideCommand id

writeStub tailscale <<'STUB'
#!/usr/bin/env bash
printf 'tailscale %s\n' "$*" >> "$DOTFILES_TEST_LOG"
stateDir="$DOTFILES_TEST_STATE/$DOTFILES_TEST_MACHINE"
mkdir -p "$stateDir"
if [[ -f "$stateDir/tailscale-unauthed" ]]; then
  exit 1
fi
if [[ "${1:-}" == "status" && "${2:-}" == "--json" ]]; then
  printf '{"Self":{"DNSName":"testbox.tailnet-name.ts.net."}}\n'
  exit 0
fi
if [[ "${1:-}" == "status" ]]; then
  exit 0
fi
if [[ "${1:-}" == "serve" && "${2:-}" == "status" ]]; then
  if [[ -f "$stateDir/serve-status-fails" ]]; then
    exit 1
  fi
  if [[ -f "$stateDir/serve-malformed-status" ]]; then
    printf 'this is not the JSON you asked for\n'
    exit 0
  fi
  if [[ -f "$stateDir/serve-empty-status" ]]; then
    exit 0
  fi
  if [[ -f "$stateDir/serve-array-status" ]]; then
    printf '[]\n'
    exit 0
  fi
  if [[ ! -f "$stateDir/serve-port" ]]; then
    printf '{}\n'
    exit 0
  fi
  if [[ -f "$stateDir/serve-foreign-backend" ]]; then
    printf '{"Web":{"testbox.tailnet-name.ts.net:443":{"Handlers":{"/":{"Proxy":"http://10.0.0.9:8080"}}}}}\n'
    exit 0
  fi
  if [[ -f "$stateDir/serve-localhost-backend" ]]; then
    printf '{"Web":{"testbox.tailnet-name.ts.net:443":{"Handlers":{"/":{"Proxy":"http://localhost:%s"}}}}}\n' \
      "$(cat "$stateDir/serve-port")"
    exit 0
  fi
  printf '{"Web":{"testbox.tailnet-name.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:%s"}}}}}\n' \
    "$(cat "$stateDir/serve-port")"
  exit 0
fi
if [[ "${1:-}" == "serve" && "${2:-}" == "--bg" ]]; then
  if IFS= read -r -t 1 consentLine; then
    printf 'serve read stdin %s\n' "$consentLine" >> "$DOTFILES_TEST_LOG"
  fi
  if [[ -f "$stateDir/serve-bg-fails" ]]; then
    exit 1
  fi
fi
if [[ "${1:-}" == "serve" && "${*: -1}" == "off" ]]; then
  if [[ -f "$stateDir/serve-off-fails" ]]; then
    exit 1
  fi
  rm -f "$stateDir/serve-port"
  exit 0
fi
if [[ "${1:-}" == "serve" ]]; then
  printf '%s\n' "${*: -1}" > "$stateDir/serve-port"
  exit 0
fi
exit 0
STUB
provideCommand tailscale

writeStub curl <<'STUB'
#!/usr/bin/env bash
printf 'curl %s\n' "$*" >> "$DOTFILES_TEST_LOG"
probedUrl="${*: -1}"
stateDir="$DOTFILES_TEST_STATE/$DOTFILES_TEST_MACHINE"
# A port the config names while a restart is still owed is one the running process has no listener on.
if [[ -f "$stateDir/ports-with-no-listener" ]] && grep -qxF -- "$probedUrl" "$stateDir/ports-with-no-listener"; then
  printf '000'
  exit 0
fi
case "$probedUrl" in
  http://127.0.0.1:3000/) printf '200' ;;
  http://127.0.0.1:3001/) printf '401' ;;
  http://127.0.0.1:3010/) printf '200' ;;
  http://127.0.0.1:3020/) printf '200' ;;
  http://127.0.0.1:3021/) printf '401' ;;
  https://*) printf '200' ;;
  *) printf '000' ;;
esac
exit 0
STUB
provideCommand curl

writeStub node <<'STUB'
#!/usr/bin/env bash
printf 'node %s\n' "$*" >> "$DOTFILES_TEST_LOG"
exec "$DOTFILES_TEST_REAL_NODE" "$@"
STUB
provideCommand node

writeStub git <<'STUB'
#!/usr/bin/env bash
printf 'git %s\n' "$*" >> "$DOTFILES_TEST_LOG"
stateDir="$DOTFILES_TEST_STATE/$DOTFILES_TEST_MACHINE"
if [[ "${*: -1}" == "HEAD" && -f "$stateDir/app-head" ]]; then
  cat "$stateDir/app-head"
  exit 0
fi
exit 0
STUB
provideCommand git

for recordingOnlyCommand in claude glissa npm; do
  writeStub "$recordingOnlyCommand" <<STUB
#!/usr/bin/env bash
printf '$recordingOnlyCommand %s\n' "\$*" >> "\$DOTFILES_TEST_LOG"
exit 0
STUB
  provideCommand "$recordingOnlyCommand"
done

# The unit's interpreter comes from a fixed candidate list, not from the converging shell.
for machineHomePath in "$toolingHome" "$personalHome" "$serverHome" "$unauthedHome" \
  "$optOutHome" "$symlinkedHome" "$brokenConfigHome" "$unownedRouteHome" "$badStatusHome" \
  "$unresolvedProfileHome" "$pendingDepsHome" "$missingAppHome" "$invalidAppHome" \
  "$localSeedHome"; do
  mkdir -p "$machineHomePath/.local/bin"
  ln -sf "$stubBin/node" "$machineHomePath/.local/bin/node"
done

makeGlissaApp() {
  local machineHome="$1"
  mkdir -p "$machineHome/Projects/glissa/.git" \
    "$machineHome/Projects/glissa/server" \
    "$machineHome/Projects/glissa/dist/server"
  : > "$machineHome/Projects/glissa/server/main.ts"
  : > "$machineHome/Projects/glissa/dist/server/index.js"
  printf '{}\n' > "$machineHome/Projects/glissa/package.json"
}

# The suite may itself be running under glissa.service, and the real cgroup must never decide what a sandboxed run does.
outsideServiceCgroup="$sandboxTemp/outside-glissa.cgroup"
printf '0::/user.slice/user-1000.slice/session-1.scope\n' > "$outsideServiceCgroup"

runInstall() {
  local machineHome="$1"
  local machineProfile="$2"
  local extraPathPrefix="${3:-}"
  local stdinPath="${4:-/dev/null}"
  runInStubbedSandbox "$machineHome" \
    PATH="${extraPathPrefix:+$extraPathPrefix:}$stubBin:$coreBin" \
    TMPDIR="$sandboxTemp" \
    USER="sandboxaccount" \
    DOTFILES_PROFILE="$machineProfile" \
    DOTFILES_MARKER_PATH="$machineHome/.machine-profile" \
    DOTFILES_TEST_MACHINE="$(basename -- "$machineHome")" \
    DOTFILES_TEST_REAL_NODE="$realNodePath" \
    DOTFILES_CGROUP_FILE="${DOTFILES_CGROUP_FILE:-$outsideServiceCgroup}" \
    NO_COLOR=1 \
    bash "$topicDir/install.sh" < "$stdinPath"
}

configValue() {
  "$realNodePath" -p "String($2)" "$1/.glissa/config.json" 2>/dev/null
}

serverSeedMatchesPreviousExample() {
  "$realNodePath" - "$1/.glissa/config.json" "$1" <<'NODE'
const fs = require("fs");

const [configPath, home] = process.argv.slice(2);
const actual = JSON.parse(fs.readFileSync(configPath, "utf8"));
const expected = {
  port: 3000,
  attentionTimeoutSeconds: 60,
  waitingEscalationSeconds: 300,
  startingWatchdogSeconds: 30,
  autoRecoverSeconds: 3,
  inputGraceSeconds: 5,
  promptDetectionMs: 1500,
  notifyDebounceMs: 3000,
  repoRoots: [`${home}/Projects`],
  projects: [{
    id: "00000000-0000-4000-8000-000000000001",
    name: "glissa",
    path: `${home}/Projects/glissa`
  }],
  replayBufferKB: 512,
  scrollback: 50000,
  feedDebounceMs: 50,
  noFlicker: true,
  cursorBlink: false,
  debugMode: false,
  teams: [],
  hooks: [{
    id: "a2ef51b3-f8f3-4d9a-ac4b-785965a85560",
    name: "Block new code comments",
    event: "PreToolUse",
    type: "command",
    enabled: true,
    matcher: "Write|Edit|MultiEdit",
    command: `node ${home}/.claude/hooks/block-comments.mjs`
  }],
  editorCommand: "",
  headroomEasyStart: false,
  proxyBaseUrl: "http://127.0.0.1:8787",
  headroomPort: 8787,
  remote: {
    enabled: true,
    port: 3001,
    publicHost: "CHANGEME.your-tailnet.ts.net",
    allowedOrigins: ["https://CHANGEME.your-tailnet.ts.net"]
  }
};
const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
};
if (JSON.stringify(canonical(actual)) !== JSON.stringify(canonical(expected))) process.exit(1);
NODE
}

printf '\nglissa topic\n'

makeGlissaApp "$personalHome"
mkdir -p "$personalHome/.claude"
printf '{}\n' > "$personalHome/.claude/.credentials.json"
: > "$commandLog"
personalStatus=0
personalOutput="$(runInstall "$personalHome" personal)" || personalStatus=$?

check "a fresh personal home warns that the seed needs editing" \
  outputMatches "$personalOutput" '\[warn\].*seeding from config.example.json'
check "a seed that needs editing exits non-zero" test "$personalStatus" -eq 1
check "the personal config is seeded" test -f "$personalHome/.glissa/config.json"
check "the seed resolves the home token to this home" \
  test "$(configValue "$personalHome" 'require(process.argv[1]).repoRoots[0]')" = "$personalHome/Projects"
check "no placeholder survives the seed" \
  bash -c '! grep -q "{{HOME}}" "$1/.glissa/config.json"' _ "$personalHome"
check "the personal seed carries no remote block" \
  test "$(configValue "$personalHome" 'require(process.argv[1]).remote === undefined')" = "true"
check "the config directory is owner only" \
  test "$(stat -c '%a' "$personalHome/.glissa")" = "700"
check "the config file is owner only" \
  test "$(stat -c '%a' "$personalHome/.glissa/config.json")" = "600"
check "a personal machine installs the unit" test -f "$personalHome/.config/systemd/user/glissa.service"
check "a personal machine enables the service" logHas "systemctl --user enable --now glissa"
check "a config without a remote block is remote-disabled" \
  outputHas "$personalOutput" 'remote access disabled'
check "a personal machine publishes nothing on the tailnet" logLacks "serve --bg"
check "a personal machine probes only the local listener" logHas "http://127.0.0.1:3000/"
check "a personal machine never probes the remote listener" logLacks "http://127.0.0.1:3001/"

personalRerunStatus=0
personalRerunOutput="$(runInstall "$personalHome" personal)" || personalRerunStatus=$?
check "a second personal run reports no change" reportsNoChanges "$personalRerunOutput"
check "a second personal run exits clean" test "$personalRerunStatus" -eq 0

printf '{ "port": 3000, "editorCommand": "hand-edited" }\n' > "$personalHome/.glissa/config.json"
runInstall "$personalHome" personal > /dev/null || true
check "an existing config is never overwritten" \
  test "$(configValue "$personalHome" 'require(process.argv[1]).editorCommand')" = "hand-edited"

printf '%s\n' '{ "port": 3000, "remote": { "port": 3001, "publicHost": "testbox.tailnet-name.ts.net" } }' \
  > "$personalHome/.glissa/config.json"
: > "$commandLog"
keylessRemoteOutput="$(runInstall "$personalHome" personal)" || true
check "a remote block with no enabled key reads as disabled" \
  outputHas "$keylessRemoteOutput" 'remote access disabled'
check "a remote block with no enabled key publishes nothing on the tailnet" logLacks "serve --bg"

startSandboxHome "glissa-work"
workHome="$sandbox"
mkdir -p "$workHome/.local/bin"
ln -sf "$stubBin/node" "$workHome/.local/bin/node"
makeGlissaApp "$workHome"
: > "$commandLog"
workOutput="$(runInstall "$workHome" work)" || true
check "a profile that does not serve glissa says the service was skipped" \
  outputMatches "$workOutput" '\[ -- \].*glissa service.*skipped, profile does not serve glissa'
check "a non-serving machine installs no unit" test ! -e "$workHome/.config/systemd/user/glissa.service"
check "a non-serving machine never touches systemd" logLacks "systemctl "

unresolvedProfileStatus=0
unresolvedProfileOutput="$(runInstall "$unresolvedProfileHome" "")" || unresolvedProfileStatus=$?
check "an unresolved profile warns instead of choosing a seed" \
  outputMatches "$unresolvedProfileOutput" '\[warn\].*no profile resolved'
check "an unresolved profile seeds no config" test ! -e "$unresolvedProfileHome/.glissa/config.json"
check "an unresolved profile exits non-zero" test "$unresolvedProfileStatus" -eq 1

missingProfileOutput="$(runInstall "$unresolvedProfileHome" missingprofile)" || true
check "a missing profile settings warning prints the checkout path" \
  outputHas "$missingProfileOutput" "$repoRoot/profiles/missingprofile/glissa.json"

localSeedPath="$toolingHome/machine-local-glissa-seed.json"
printf '{ "port": 4100, "repoRoots": ["{{HOME}}/LocalProjects"], "projects": [] }\n' \
  > "$localSeedPath"
localSeedOutput="$(DOTFILES_GLISSA_SEED_PATH="$localSeedPath" \
  runInstall "$localSeedHome" personal)"
check "a machine-local seed is rendered without a missing profile overlay" \
  test "$(configValue "$localSeedHome" 'require(process.argv[1]).port')" = "4100"
check "a machine-local seed resolves its home token" \
  test "$(configValue "$localSeedHome" 'require(process.argv[1]).repoRoots[0]')" \
    = "$localSeedHome/LocalProjects"
check "a machine-local seed is reported from the selected input" \
  outputHas "$localSeedOutput" "seeded from config.json"

makeGlissaApp "$pendingDepsHome"
mkdir -p "$pendingDepsHome/.claude"
printf '{}\n' > "$pendingDepsHome/.claude/.credentials.json"
pendingDepsStateName="$(HOME="$pendingDepsHome" \
  repoDepsPendingStateNameForPath "$pendingDepsHome/Projects/glissa")"
pendingDepsMarker="$pendingDepsHome/.local/state/dotfiles/$pendingDepsStateName"
mkdir -p "$(dirname -- "$pendingDepsMarker")"
: > "$pendingDepsMarker"
: > "$commandLog"
pendingDepsStatus=0
pendingDepsOutput="$(runInstall "$pendingDepsHome" server)" || pendingDepsStatus=$?
check "pending app dependencies prevent a first service start" \
  logLacks "systemctl --user enable --now glissa"
check "a refused start names the pending app dependencies" \
  outputMatches "$pendingDepsOutput" '\[warn\].*dependencies or build are pending'
check "a refused start leaves the service input token unrecorded" \
  test ! -e "$pendingDepsHome/.local/state/dotfiles/glissa-service-inputs-record"
check "a refused start exits non-zero" test "$pendingDepsStatus" -eq 1

rm -f "$pendingDepsMarker"
: > "$commandLog"
runInstall "$pendingDepsHome" server > /dev/null
check "cleared app dependencies allow the first service start" \
  logHas "systemctl --user enable --now glissa"
check "a successful start records the service input token" \
  test -f "$pendingDepsHome/.local/state/dotfiles/glissa-service-inputs-record"

mkdir -p "$missingAppHome/.claude"
printf '{}\n' > "$missingAppHome/.claude/.credentials.json"
: > "$commandLog"
missingAppStatus=0
missingAppOutput="$(runInstall "$missingAppHome" server)" || missingAppStatus=$?
check "a missing app checkout exits non-zero" test "$missingAppStatus" -eq 1
check "a missing app checkout is named" \
  outputMatches "$missingAppOutput" '\[warn\].*~/Projects/glissa is not a Glissa checkout'
check "a missing app checkout installs no unit" \
  test ! -e "$missingAppHome/.config/systemd/user/glissa.service"
check "a missing app checkout performs no activation" logLacks "systemctl "
check "a missing app checkout publishes no route" logLacks "tailscale "

mkdir -p "$invalidAppHome/Projects/glissa" "$invalidAppHome/.claude"
printf '{}\n' > "$invalidAppHome/.claude/.credentials.json"
: > "$commandLog"
invalidAppStatus=0
invalidAppOutput="$(runInstall "$invalidAppHome" server)" || invalidAppStatus=$?
check "an arbitrary app directory exits non-zero" test "$invalidAppStatus" -eq 1
check "an arbitrary app directory is rejected as an invalid checkout" \
  outputHas "$invalidAppOutput" "is not a Glissa checkout"
check "an arbitrary app directory starts no service" logLacks "systemctl "

makeGlissaApp "$invalidAppHome"
rm -f "$invalidAppHome/Projects/glissa/server/main.ts" \
  "$invalidAppHome/Projects/glissa/dist/server/index.js"
: > "$invalidAppHome/Projects/glissa/server.js"
legacyAppOutput="$(runInstall "$invalidAppHome" server)" || true
check "a checkout from before the TypeScript migration is still a Glissa checkout" \
  outputMatches "$legacyAppOutput" '\[ -- \].*glissa app.*~/Projects/glissa'
check "a pre-migration checkout is told to update the checkout" \
  outputMatches "$legacyAppOutput" '\[warn\].*~/Projects/glissa predates the TypeScript migration'
check "a pre-migration checkout is never sent to npm install" \
  outputLacks "$legacyAppOutput" "run npm install there"

: > "$commandLog"
makeGlissaApp "$serverHome"
rm -rf "$serverHome/Projects/glissa/.git"
printf 'gitdir: %s\n' "$toolingHome/server-app-gitdir" > "$serverHome/Projects/glissa/.git"
mkdir -p "$serverHome/.claude"
printf '{}\n' > "$serverHome/.claude/.credentials.json"
serverStatus=0
serverOutput="$(runInstall "$serverHome" server)" || serverStatus=$?

check "a server home seeds from the server overlay" \
  outputMatches "$serverOutput" '\[warn\].*seeding from profiles/server/glissa.overlay.json'
check "the server overlay contains only the profile differences" \
  "$realNodePath" -e 'const overlay = require(process.argv[1]); const keys = Object.keys(overlay).sort().join(","); if (keys !== "debugMode,remote") process.exit(1)' \
  "$repoRoot/profiles/server/glissa.overlay.json"
check "the server seed carries a remote block" \
  test "$(configValue "$serverHome" 'require(process.argv[1]).remote.enabled')" = "true"
check "the detected tailnet name replaces CHANGEME" \
  test "$(configValue "$serverHome" 'require(process.argv[1]).remote.publicHost')" = "testbox.tailnet-name.ts.net"
check "the allowed origin follows the tailnet name" \
  test "$(configValue "$serverHome" 'require(process.argv[1]).remote.allowedOrigins[0]')" = "https://testbox.tailnet-name.ts.net"
check "no CHANGEME survives on a server" \
  bash -c '! grep -q "CHANGEME" "$1/.glissa/config.json"' _ "$serverHome"

serverUnitPath="$serverHome/.config/systemd/user/glissa.service"
check "the user unit is installed" test -f "$serverUnitPath"
check "the unit runs the node from the fixed candidate list, not the shell's" \
  grep -q "^ExecStart=$serverHome/.local/bin/node dist/server/index.js\$" "$serverUnitPath"
check "the unit skips itself rather than crash-looping on a wiped build" \
  grep -q "^ConditionPathExists=$serverHome/Projects/glissa/dist/server/index.js\$" "$serverUnitPath"
check "the unit works out of this home" grep -q "^WorkingDirectory=$serverHome/Projects/glissa\$" "$serverUnitPath"
check "the unit carries a rendered PATH" grep -q "^Environment=PATH=.\+\$" "$serverUnitPath"
check "no placeholder survives the render" \
  bash -c '! grep -qE "__(NODE|APP_DIR|HOME|PATH)__" "$1"' _ "$serverUnitPath"

check "the unit is enabled and started" logHas "systemctl --user enable --now glissa"
check "the manager reloads only for a new unit" logHas "systemctl --user daemon-reload"
check "linger is turned on without a password prompt" \
  logHas "loginctl --no-ask-password enable-linger sandboxaccount"
check "the local listener is probed" logHas "http://127.0.0.1:3000/"
check "the remote listener is probed" logHas "http://127.0.0.1:3001/"
check "the health probe announces its wait before polling" \
  outputMatches "$serverOutput" '\[ \.\. \].*glissa health.*waiting for HTTP 200'
check "the tailnet proxy targets the remote port" logHas "tailscale serve --bg 3001"
check "the tailnet proxy never targets the local port" logLacks "serve --bg 3000"
check "the public name is probed over TLS" logHas "https://testbox.tailnet-name.ts.net/"
check "the pairing checklist is a note, not a warning" \
  outputMatches "$serverOutput" '\[ -- \].*glissa pair once per device'
check "a checklist item keeps the topic non-zero" test "$serverStatus" -eq 1
check "the dashboard clone is never cloned here" logLacks "git clone"
check "the dashboard is never built here" logLacks "npm "
check "no pairing url is minted" logLacks "glissa pair"

mv "$serverHome/Projects/glissa/dist/server/index.js" "$serverHome/Projects/glissa/dist-index.parked"
# A freshly installed unit is what makes this run want to activate, so only the guard can stop it.
rm -f "$serverUnitPath" "$serverUnitPath.pre-dotfiles.rendered"
: > "$commandLog"
unbuiltOutput="$(runInstall "$serverHome" server)" || true
check "a checkout without a built dist warns instead of starting" \
  outputMatches "$unbuiltOutput" '\[warn\].*no built dist/server/index.js'
check "a checkout without a built dist enables nothing" logLacks "enable --now"
check "a checkout without a built dist reloads nothing" logLacks "daemon-reload"
check "a checkout without a built dist restarts nothing" logLacks "restart glissa"
mv "$serverHome/Projects/glissa/dist-index.parked" "$serverHome/Projects/glissa/dist/server/index.js"

unitFingerprintAfterFirstRun="$(cksum < "$serverUnitPath")"
localhostBackendState="$stubState/$(basename -- "$serverHome")/serve-localhost-backend"
touch "$localhostBackendState"
: > "$commandLog"
serverRerunOutput="$(runInstall "$serverHome" server)"
check "a second server run reports no change" reportsNoChanges "$serverRerunOutput"
check "the unit is unchanged on a second run" \
  test "$unitFingerprintAfterFirstRun" = "$(cksum < "$serverUnitPath")"
check "a second run enables nothing" logLacks "enable --now"
check "a second run reloads nothing" logLacks "daemon-reload"
check "a second run restarts nothing" logLacks "restart glissa"
check "a second run re-serves nothing" logLacks "serve --bg"
check "a localhost route is recognized as the current remote port" logLacks "serve --bg 3001"
check "a second run keeps linger alone" logLacks "enable-linger"

rm -f "$stubState/$(basename -- "$serverHome")/linger-enabled"
: > "$commandLog"
runInStubbedSandbox "$serverHome" \
  PATH="$stubBin:$coreBin" \
  TMPDIR="$sandboxTemp" \
  USER=root \
  DOTFILES_PROFILE=server \
  DOTFILES_MARKER_PATH="$serverHome/.machine-profile" \
  DOTFILES_TEST_MACHINE="$(basename -- "$serverHome")" \
  DOTFILES_TEST_REAL_NODE="$realNodePath" \
  NO_COLOR=1 \
  bash "$topicDir/install.sh" < /dev/null > /dev/null || true
check "the account handed to loginctl comes from id, not USER" \
  logHas "loginctl --no-ask-password enable-linger sandboxaccount"
check "the account USER named never reaches loginctl" logLacks "enable-linger root"
rm -f "$localhostBackendState"

extraPathDirectory="$toolingHome/extra-bin"
mkdir -p "$extraPathDirectory"
: > "$commandLog"
differentPathOutput="$(runInstall "$serverHome" server "$extraPathDirectory")"
check "a run from a different PATH renders the same unit" \
  test "$unitFingerprintAfterFirstRun" = "$(cksum < "$serverUnitPath")"
check "a run from a different PATH reports no change" reportsNoChanges "$differentPathOutput"
check "a run from a different PATH restarts nothing" logLacks "restart glissa"
check "the unit PATH holds nothing the ambient PATH added" \
  bash -c '! grep -qF "extra-bin" "$1"' _ "$serverUnitPath"
check "the unit PATH ends at the system directories" \
  grep -q '^Environment=PATH=.*:/usr/local/bin:/usr/bin:/bin$' "$serverUnitPath"
check "the unit PATH carries the npm global bin unconditionally" \
  grep -qF "$serverHome/.npm-global/bin" "$serverUnitPath"
check "the unit PATH carries the account bin unconditionally" \
  grep -qF "$serverHome/.local/bin" "$serverUnitPath"
check "the unit PATH never chases wherever claude happens to live" \
  bash -c '! grep -qF "$1/stub-bin" "$2"' _ "$toolingHome" "$serverUnitPath"

"$realNodePath" -e '
const fs = require("fs");
const configPath = process.argv[1];
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
config.editorCommand = "an edit only the config file records";
fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
' "$serverHome/.glissa/config.json"
: > "$commandLog"
editedConfigOutput="$(runInstall "$serverHome" server)"
check "a config edited by hand restarts nothing" logLacks "restart glissa"
check "a config edited by hand leaves the unit file alone" \
  test "$unitFingerprintAfterFirstRun" = "$(cksum < "$serverUnitPath")"
check "a config edited by hand reports no change" reportsNoChanges "$editedConfigOutput"

"$realNodePath" -e '
const fs = require("fs");
const configPath = process.argv[1];
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
config.port = 3010;
fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
' "$serverHome/.glissa/config.json"
: > "$commandLog"
bootOnlyEditOutput="$(runInstall "$serverHome" server)"
check "a hand edited boot only key restarts the service" logHas "systemctl --user restart glissa"
check "the boot only restart is reported" \
  outputMatches "$bootOnlyEditOutput" '\[ ok \].*glissa service.*restarted'
: > "$commandLog"
runInstall "$serverHome" server > /dev/null
check "a settled boot only key restarts nothing" logLacks "restart glissa"

serverStubState="$stubState/$(basename -- "$serverHome")"
printf 'b22b22b22b22b22b22b22b22b22b22b22b22b22b\n' > "$serverStubState/app-head"
insideServiceCgroup="$sandboxTemp/inside-glissa.cgroup"
printf '0::/user.slice/user-1000.slice/user@1000.service/app.slice/glissa.service\n' > "$insideServiceCgroup"
serviceRestartPendingMarker="$serverHome/.local/state/dotfiles/systemd-glissa-pending"
serveOwnershipRecord="$serverHome/.local/state/dotfiles/glissa-serve-owned"
check "the hosted run starts from a route on the old remote port" \
  grep -qx '3001' "$serverStubState/serve-port"
"$realNodePath" -e '
const fs = require("fs");
const configPath = process.argv[1];
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
config.port = 3020;
config.remote.port = 3021;
fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
' "$serverHome/.glissa/config.json"
printf 'http://127.0.0.1:3020/\nhttp://127.0.0.1:3021/\n' > "$serverStubState/ports-with-no-listener"
: > "$commandLog"
insideServiceStatus=0
insideServiceOutput="$(DOTFILES_CGROUP_FILE="$insideServiceCgroup" runInstall "$serverHome" server)" \
  || insideServiceStatus=$?
check "a run hosted by the service never restarts it" logLacks "restart glissa"
check "a run hosted by the service hands nothing to a detached unit" logLacks "systemd-run"
check "the owed restart is reported" \
  outputMatches "$insideServiceOutput" '\[ ok \].*glissa service.*restart owed'
check "the owed restart is recorded as pending state" test -f "$serviceRestartPendingMarker"
check "a run hosted by the service probes no port the owed restart has yet to open" \
  logLacks "http://127.0.0.1:3020/"
check "a run hosted by the service probes no remote port the owed restart has yet to open" \
  logLacks "http://127.0.0.1:3021/"
check "the skipped probe is reported on the health label" \
  outputMatches "$insideServiceOutput" '\[ -- \].*glissa health.*waits on the owed glissa restart'
check "a skipped probe blames the service for no missing local listener" \
  outputLacks "$insideServiceOutput" "no HTTP 200 from"
check "a skipped probe blames the service for no missing remote listener" \
  outputLacks "$insideServiceOutput" "no HTTP 401 from"
check "a run hosted by the service publishes no route" logLacks "serve --bg"
check "a route stranded on the old remote port is withdrawn" logHas "tailscale serve --https=443 off"
check "the stranded route withdrawal names the owed restart" \
  outputHas "$insideServiceOutput" 'route removed, the glissa restart is owed'
check "the withdrawn route is gone from serve status" test ! -f "$serverStubState/serve-port"
check "the withdrawn route leaves no ownership record behind" test ! -e "$serveOwnershipRecord"
check "the withheld route names the owed restart" \
  outputMatches "$insideServiceOutput" '\[warn\].*Tailscale serve.*owed'
check "the withheld route sends its owner to a run from outside the service" \
  outputHas "$insideServiceOutput" "run dot from outside the service rather than systemctl --user restart glissa"
check "a withheld route exits non-zero" test "$insideServiceStatus" -eq 1
rm -f "$serverStubState/ports-with-no-listener"
: > "$commandLog"
runInstall "$serverHome" server > /dev/null
check "the next run from outside the service pays the owed restart" \
  logHas "systemctl --user restart glissa"
check "a paid restart clears the pending state" test ! -e "$serviceRestartPendingMarker"
check "the run that pays the owed restart probes the local listener" \
  logHas "http://127.0.0.1:3020/"
check "the run that pays the owed restart probes the remote listener" \
  logHas "http://127.0.0.1:3021/"
check "the run that pays the owed restart publishes the route" \
  logHas "tailscale serve --bg 3021"
: > "$commandLog"
runInstall "$serverHome" server > /dev/null
check "a paid restart is not owed again on the next run" logLacks "restart glissa"

printf 'a11a11a11a11a11a11a11a11a11a11a11a11a11a\n' > "$stubState/$(basename -- "$serverHome")/app-head"
serverDepsPendingStateName="$(HOME="$serverHome" \
  repoDepsPendingStateNameForPath "$serverHome/Projects/glissa")"
serverDepsPendingMarker="$serverHome/.local/state/dotfiles/$serverDepsPendingStateName"
: > "$serverDepsPendingMarker"
: > "$commandLog"
pendingRestartStatus=0
pendingRestartOutput="$(runInstall "$serverHome" server)" || pendingRestartStatus=$?
check "pending app dependencies prevent a checkout restart" logLacks "restart glissa"
check "a refused restart reports the pending dependency state" \
  outputMatches "$pendingRestartOutput" '\[warn\].*dependencies or build are pending'
check "a refused restart exits non-zero" test "$pendingRestartStatus" -eq 1
check "a refused restart does not advance the service input token" \
  bash -c '! grep -q "a11a11a11a11" "$1"' _ \
  "$serverHome/.local/state/dotfiles/glissa-service-inputs-record"

rm -f "$serverDepsPendingMarker"
: > "$commandLog"
runInstall "$serverHome" server > /dev/null
check "cleared app dependencies allow the checkout restart" logHas "systemctl --user restart glissa"
check "the successful restart advances the service input token" \
  grep -q 'a11a11a11a11' "$serverHome/.local/state/dotfiles/glissa-service-inputs-record"

: > "$commandLog"
settledInputsOutput="$(runInstall "$serverHome" server)"
check "an unchanged config and checkout restart nothing" logLacks "restart glissa"
check "an unchanged config and checkout report no change" reportsNoChanges "$settledInputsOutput"
check "what the service was started from is recorded under the shared state directory" \
  test -f "$serverHome/.local/state/dotfiles/glissa-service-inputs-record"
check "nothing is recorded beside the unit systemd reads" \
  bash -c '! compgen -G "$(dirname -- "$1")/.*dotfiles*"' _ "$serverUnitPath"

serviceInputsRecord="$serverHome/.local/state/dotfiles/glissa-service-inputs-record"
serviceInputsRecordTarget="$toolingHome/service-inputs-record-target"
mv "$serviceInputsRecord" "$serviceInputsRecordTarget"
ln -s "$serviceInputsRecordTarget" "$serviceInputsRecord"
: > "$commandLog"
symlinkedServiceInputsStatus=0
symlinkedServiceInputsOutput="$(runInstall "$serverHome" server)" || symlinkedServiceInputsStatus=$?
check "a symlinked service input record counts as changed" logHas "systemctl --user restart glissa"
check "a symlinked service input record is refused when refreshed" \
  outputMatches "$symlinkedServiceInputsOutput" '\[warn\].*not a regular file'
check "a symlinked service input record makes the topic exit non-zero" \
  test "$symlinkedServiceInputsStatus" -eq 1
check "the service input record target is left unchanged" \
  test -s "$serviceInputsRecordTarget"
rm -f "$serviceInputsRecord"
mv "$serviceInputsRecordTarget" "$serviceInputsRecord"

mkdir -p "$stubState/$(basename -- "$unauthedHome")"
touch "$stubState/$(basename -- "$unauthedHome")/tailscale-unauthed"
makeGlissaApp "$unauthedHome"
: > "$commandLog"
unauthedStatus=0
unauthedOutput="$(runInstall "$unauthedHome" server)" || unauthedStatus=$?
check "an unauthenticated tailnet warns about the placeholder" \
  outputMatches "$unauthedOutput" '\[warn\].*publicHost still says CHANGEME'
check "the warning names the config to edit" outputHas "$unauthedOutput" 'remote.publicHost in ~/.glissa/config.json'
check "the serve step names the command to run" \
  outputMatches "$unauthedOutput" '\[warn\].*tailscale up once, then tailscale serve --bg 3001'
check "an unauthenticated tailnet is never served" logLacks "serve --bg"
check "a placeholder host is never probed over TLS" logLacks "https://"
check "a missing tailnet login exits non-zero" test "$unauthedStatus" -eq 1
check "the placeholder is left in place for its owner" \
  bash -c 'grep -q "CHANGEME" "$1/.glissa/config.json"' _ "$unauthedHome"
check "the merged server seed matches the previous example except for key order" \
  serverSeedMatchesPreviousExample "$unauthedHome"

unauthedRerunOutput="$(runInstall "$unauthedHome" server)"
check "a second unauthenticated run reports no change" reportsNoChanges "$unauthedRerunOutput"

printf '[Unit]\nDescription=hand written\n' > "$serverUnitPath"
: > "$commandLog"
handEditOutput="$(runInstall "$serverHome" server)"
check "a hand edited unit is backed up" \
  bash -c 'compgen -G "$1.pre-dotfiles.bak*" > /dev/null' _ "$serverUnitPath"
check "the backup keeps what was there" \
  bash -c 'grep -q "hand written" "$1".pre-dotfiles.bak' _ "$serverUnitPath"
check "the rendered unit replaces the hand edit" \
  grep -q "^ExecStart=$serverHome/.local/bin/node dist/server/index.js\$" "$serverUnitPath"
check "the re-rendered unit keeps its build-exists condition" \
  grep -q "^ConditionPathExists=$serverHome/Projects/glissa/dist/server/index.js\$" "$serverUnitPath"
check "replacing the unit restarts the service" outputMatches "$handEditOutput" '\[ ok \].*glissa service.*restarted'

: > "$commandLog"
mkdir -p "$stubState/$(basename -- "$serverHome")"
touch "$stubState/$(basename -- "$serverHome")/systemd-unreachable"
unreachableStatus=0
unreachableOutput="$(runInstall "$serverHome" server)" || unreachableStatus=$?
check "an unreachable user manager warns" \
  outputMatches "$unreachableOutput" '\[warn\].*user service manager not reachable'
check "an unreachable user manager starts nothing" logLacks "enable --now"
check "an unreachable user manager exits non-zero" test "$unreachableStatus" -eq 1
rm -f "$stubState/$(basename -- "$serverHome")/systemd-unreachable"

makeGlissaApp "$optOutHome"
mkdir -p "$optOutHome/.glissa" "$optOutHome/.claude"
printf '{}\n' > "$optOutHome/.claude/.credentials.json"
printf '%s\n' '{ "port": 3000, "remote": { "enabled": false, "port": 3001, "publicHost": "CHANGEME.ts.net" } }' \
  > "$optOutHome/.glissa/config.json"
optOutState="$stubState/$(basename -- "$optOutHome")"
mkdir -p "$optOutState"
printf '3001\n' > "$optOutState/serve-port"
touch "$optOutState/tailscale-unauthed"
: > "$commandLog"
optOutOutput="$(runInstall "$optOutHome" server)" || true
check "an explicit remote opt out is reported" \
  outputHas "$optOutOutput" 'remote access disabled'
check "an explicit remote opt out is never rewritten to enabled" \
  test "$(configValue "$optOutHome" 'require(process.argv[1]).remote.enabled')" = "false"
check "an opt out keeps the host its owner wrote" \
  test "$(configValue "$optOutHome" 'require(process.argv[1]).remote.publicHost')" = "CHANGEME.ts.net"
check "an opt out publishes nothing on the tailnet" logLacks "serve --bg"
check "an unauthenticated opt out withdraws no route it could not check first" \
  logLacks "serve --https=443 off"
check "an unauthenticated run owing no withdrawal never says the tailnet could not be asked" \
  outputLacks "$optOutOutput" "cannot be checked before withdrawal"
check "an unauthenticated run owing no withdrawal reports the serve step as skipped" \
  outputHas "$optOutOutput" "skipped, glissa remote disabled"
check "the route an unauthenticated run could not check survives" \
  test -f "$optOutState/serve-port"
optOutPendingState="$optOutHome/.local/state/dotfiles/glissa-serve-withdrawal-pending"
optOutOwnedRecord="$optOutHome/.local/state/dotfiles/glissa-serve-owned"
check "a withdrawal of a route this topic never published is never marked pending" \
  test ! -e "$optOutPendingState"
check "an opt out is never probed over TLS" logLacks "https://"
check "an opt out never probes the remote listener" logLacks "http://127.0.0.1:3001/"

mkdir -p "$(dirname -- "$optOutOwnedRecord")"
printf '3001\n' > "$optOutOwnedRecord"
: > "$commandLog"
owedUnauthedOutput="$(runInstall "$optOutHome" server)" || true
check "an unauthenticated withdrawal this topic owes says the tailnet could not be asked" \
  outputMatches "$owedUnauthedOutput" '\[warn\].*tailscale is not authenticated'
check "a withdrawal the tailnet could not confirm stays pending" test -f "$optOutPendingState"
check "an owed withdrawal takes down no route it could not check first" \
  logLacks "serve --https=443 off"
check "the route an owed withdrawal could not check survives" \
  test -f "$optOutState/serve-port"

printf '%s\n' '{ "port": 3000, "remote": { "enabled": false } }' \
  > "$optOutHome/.glissa/config.json"
: > "$commandLog"
portlessRemoteOutput="$(runInstall "$optOutHome" server)" || true
check "a disabled remote with no remote.port still probes the local listener" \
  logHas "http://127.0.0.1:3000/"
check "a disabled remote is never asked for a remote.port" \
  outputLacks "$portlessRemoteOutput" "set remote.port to 1-65535"
printf '%s\n' '{ "port": 3000, "remote": { "enabled": false, "port": 3001, "publicHost": "CHANGEME.ts.net" } }' \
  > "$optOutHome/.glissa/config.json"

rm -f "$optOutState/tailscale-unauthed" "$optOutOwnedRecord"
: > "$commandLog"
runInstall "$optOutHome" server > /dev/null || true
check "authentication does not let a pending withdrawal bypass ownership" \
  logLacks "tailscale serve --https=443 off"
check "a withdrawal with no ownership record stays pending" test -f "$optOutPendingState"
check "the unauthenticated route this topic never published stays up" \
  test -f "$optOutState/serve-port"

servePortState="$stubState/$(basename -- "$serverHome")/serve-port"
check "the server route is up before remote is turned off" test -f "$servePortState"
"$realNodePath" -e '
const fs = require("fs");
const configPath = process.argv[1];
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
config.remote.enabled = false;
config.remote.port = 3002;
fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
' "$serverHome/.glissa/config.json"
: > "$commandLog"
withdrawOutput="$(runInstall "$serverHome" server)" || true
check "turning remote off takes the published route down after the port changed" \
  logHas "tailscale serve --https=443 off"
check "the withdrawal is reported" \
  outputHas "$withdrawOutput" 'route removed, glissa remote disabled'
check "the route is gone from serve status" test ! -f "$servePortState"
check "turning remote off publishes nothing new" logLacks "serve --bg"

: > "$commandLog"
alreadyWithdrawnOutput="$(runInstall "$serverHome" server)" || true
check "a route already down is not taken down again" logLacks "serve --https"
check "a route already down reports no change" reportsNoChanges "$alreadyWithdrawnOutput"

foreignBackendState="$stubState/$(basename -- "$serverHome")/serve-foreign-backend"
printf '3001\n' > "$servePortState"
touch "$foreignBackendState"
: > "$commandLog"
foreignBackendStatus=0
foreignBackendOutput="$(runInstall "$serverHome" server)" || foreignBackendStatus=$?
check "a 443 route proxying somewhere else is left alone" logLacks "serve --https"
check "the refusal says what it found on 443" \
  outputHas "$foreignBackendOutput" "proxies something other than a local backend"
check "refusing to take down someone else's route exits non-zero" \
  test "$foreignBackendStatus" -eq 1
check "the route someone else published survives" test -f "$servePortState"
rm -f "$foreignBackendState" "$servePortState"

outsideConfigDirectory="$toolingHome/somewhere-else"
mkdir -p "$outsideConfigDirectory"
printf 'a config file this topic never chose\n' > "$outsideConfigDirectory/config.json"
chmod 755 "$outsideConfigDirectory"
chmod 644 "$outsideConfigDirectory/config.json"
ln -s "$outsideConfigDirectory" "$symlinkedHome/.glissa"
: > "$commandLog"
symlinkedDirectoryStatus=0
symlinkedDirectoryOutput="$(runInstall "$symlinkedHome" server)" || symlinkedDirectoryStatus=$?
check "a symlinked ~/.glissa is refused" \
  outputMatches "$symlinkedDirectoryOutput" '\[warn\].*is not a directory, move it aside first'
check "a symlinked ~/.glissa makes the topic exit non-zero" test "$symlinkedDirectoryStatus" -eq 1
check "a symlinked ~/.glissa is left where it was" test -L "$symlinkedHome/.glissa"
check "nothing is chmodded through a symlinked ~/.glissa" \
  test "$(stat -c '%a' "$outsideConfigDirectory")" = "755"
check "no config outside the home has its mode narrowed" \
  test "$(stat -c '%a' "$outsideConfigDirectory/config.json")" = "644"
check "no config outside the home is rewritten" \
  grep -qx 'a config file this topic never chose' "$outsideConfigDirectory/config.json"
check "a refused config directory stops before systemd work" logLacks "systemctl "
check "a refused config directory stops before Tailscale work" logLacks "tailscale "
check "a refused config directory stops before reading the config with node" logLacks "node -p"

rm -f "$symlinkedHome/.glissa"
mkdir -p "$symlinkedHome/.glissa"
ln -s "$symlinkedHome/.glissa/nothing-is-here" "$symlinkedHome/.glissa/config.json"
: > "$commandLog"
danglingConfigOutput="$(runInstall "$symlinkedHome" personal)" || true
check "a dangling config symlink is backed up before it is replaced" \
  bash -c 'compgen -G "$1.pre-dotfiles.bak*" > /dev/null' _ "$symlinkedHome/.glissa/config.json"
check "the replacement config is a regular file" \
  bash -c 'test -f "$1" && test ! -L "$1"' _ "$symlinkedHome/.glissa/config.json"
check "the backup of the dangling symlink is reported" \
  outputHas "$danglingConfigOutput" "glissa config backup"

makeGlissaApp "$brokenConfigHome"
mkdir -p "$brokenConfigHome/.glissa"
printf '{ "port": 3000, this is not json\n' > "$brokenConfigHome/.glissa/config.json"
: > "$commandLog"
brokenConfigStatus=0
brokenConfigOutput="$(runInstall "$brokenConfigHome" server)" || brokenConfigStatus=$?
check "a config that will not parse is named as such" \
  outputMatches "$brokenConfigOutput" '\[warn\].*is not valid JSON'
check "a config that will not parse never reads as remote disabled" \
  outputLacks "$brokenConfigOutput" "remote access disabled"
check "a config that will not parse exits non-zero" test "$brokenConfigStatus" -eq 1
check "a config that will not parse withdraws no route" logLacks "serve --https"
check "a config that will not parse installs no unit" \
  test ! -e "$brokenConfigHome/.config/systemd/user/glissa.service"
check "a config that will not parse starts no service" logLacks "systemctl "

writeRemoteConfig() {
  printf '{ "port": 3000, "remote": { "enabled": %s, "port": 3001, "publicHost": "testbox.tailnet-name.ts.net" } }\n' \
    "$2" > "$1/.glissa/config.json"
}

makeGlissaApp "$unownedRouteHome"
mkdir -p "$unownedRouteHome/.glissa"
writeRemoteConfig "$unownedRouteHome" false
unownedRouteState="$stubState/$(basename -- "$unownedRouteHome")"
mkdir -p "$unownedRouteState"
printf '9999\n' > "$unownedRouteState/serve-port"
: > "$commandLog"
unownedRouteOutput="$(runInstall "$unownedRouteHome" server)" || true
check "a local route on 443 this topic never published is left up" logLacks "serve --https"
check "the refusal names the missing ownership record" \
  outputHas "$unownedRouteOutput" "no record of publishing"
check "the route another tool published survives" test -f "$unownedRouteState/serve-port"

writeRemoteConfig "$unownedRouteHome" true
touch "$unownedRouteState/serve-foreign-backend"
: > "$commandLog"
foreignHandlerOutput="$(runInstall "$unownedRouteHome" server)" || true
check "an enabled config never publishes over a foreign handler on 443" logLacks "serve --bg"
check "the refusal to publish names the missing record" \
  outputHas "$foreignHandlerOutput" "no record of publishing"
check "the foreign handler on 443 survives an enabled config" \
  test -f "$unownedRouteState/serve-port"
rm -f "$unownedRouteState/serve-foreign-backend"

: > "$commandLog"
unownedLocalOutput="$(runInstall "$unownedRouteHome" server)" || true
check "an enabled config never publishes over a local backend this topic did not publish" \
  logLacks "serve --bg"
check "the refusal to publish over an unowned local backend names the missing record" \
  outputHas "$unownedLocalOutput" "no record of publishing"
check "the local backend another tool published survives" \
  grep -qx '9999' "$unownedRouteState/serve-port"

printf '3001\n' > "$unownedRouteState/serve-port"
writeRemoteConfig "$unownedRouteHome" true
: > "$commandLog"
matchingUnownedOutput="$(runInstall "$unownedRouteHome" server)" || true
matchingUnownedRecord="$unownedRouteHome/.local/state/dotfiles/glissa-serve-owned"
check "a matching pre-existing route is not republished" logLacks "serve --bg"
check "a matching pre-existing route is reported as present" \
  outputHas "$matchingUnownedOutput" "remote port 3001"
check "a matching pre-existing route is not recorded as owned" test ! -e "$matchingUnownedRecord"

writeRemoteConfig "$unownedRouteHome" false
: > "$commandLog"
matchingUnownedWithdrawalOutput="$(runInstall "$unownedRouteHome" server)" || true
check "an opt out does not withdraw a matching route this topic never published" \
  logLacks "serve --https=443 off"
check "the matching route another tool published survives the opt out" \
  grep -qx '3001' "$unownedRouteState/serve-port"
check "the matching route refusal names the missing record" \
  outputHas "$matchingUnownedWithdrawalOutput" "no record of publishing"

symlinkedOwnershipTarget="$toolingHome/glissa-ownership-target"
printf '3001\n' > "$symlinkedOwnershipTarget"
ln -s "$symlinkedOwnershipTarget" "$matchingUnownedRecord"
: > "$commandLog"
symlinkedOwnershipOutput="$(runInstall "$unownedRouteHome" server)" || true
check "a symlinked ownership record authorizes no withdrawal" logLacks "serve --https=443 off"
check "a symlinked ownership record reads as no ownership" \
  outputHas "$symlinkedOwnershipOutput" "no record of publishing"
check "the symlinked ownership record target is left unchanged" \
  grep -qx '3001' "$symlinkedOwnershipTarget"
check "the route covered only by a symlinked record survives" \
  grep -qx '3001' "$unownedRouteState/serve-port"
rm -f "$matchingUnownedRecord" "$symlinkedOwnershipTarget"

printf '%s\n' '{ "port": 3000, "remote": { "enabled": false } }' \
  > "$unownedRouteHome/.glissa/config.json"
printf '9999\n' > "$unownedRouteState/serve-port"
: > "$commandLog"
noRecordWithdrawalOutput="$(runInstall "$unownedRouteHome" server)" || true
check "a withdrawal with no port to own leaves the route up" logLacks "serve --https"
check "the withdrawal refusal names the missing record" \
  outputHas "$noRecordWithdrawalOutput" "no record of publishing"
check "the route no record covers survives the withdrawal" \
  grep -qx '9999' "$unownedRouteState/serve-port"

makeGlissaApp "$badStatusHome"
mkdir -p "$badStatusHome/.glissa"
writeRemoteConfig "$badStatusHome" false
badStatusState="$stubState/$(basename -- "$badStatusHome")"
mkdir -p "$badStatusState"
printf '3001\n' > "$badStatusState/serve-port"
touch "$badStatusState/serve-malformed-status"
badStatusPendingState="$badStatusHome/.local/state/dotfiles/glissa-serve-withdrawal-pending"
badStatusOwnedRecord="$badStatusHome/.local/state/dotfiles/glissa-serve-owned"
: > "$commandLog"
unowedStatusOutput="$(runInstall "$badStatusHome" server)" || true
check "a status query that fails marks nothing pending for a route this topic never published" \
  test ! -e "$badStatusPendingState"
check "a status query that fails is not reported when no withdrawal is owed" \
  outputLacks "$unowedStatusOutput" "serve status --json failed"
check "the route an unowed failed query could not check survives" \
  test -f "$badStatusState/serve-port"

mkdir -p "$(dirname -- "$badStatusOwnedRecord")"
printf '3001\n' > "$badStatusOwnedRecord"
: > "$commandLog"
malformedStatusOutput="$(runInstall "$badStatusHome" server)" || true
check "a serve status that will not parse is reported as a failed query" \
  outputMatches "$malformedStatusOutput" '\[warn\].*serve status --json failed'
check "a serve status that will not parse never reads as an absent route" \
  outputLacks "$malformedStatusOutput" "skipped, glissa remote disabled"
check "a serve status that will not parse leaves the route up" logLacks "serve --https"
check "a serve status that will not parse keeps an owed withdrawal pending" \
  test -f "$badStatusPendingState"

rm -f "$badStatusState/serve-malformed-status" "$badStatusPendingState"
touch "$badStatusState/serve-empty-status"
: > "$commandLog"
emptyStatusOutput="$(runInstall "$badStatusHome" server)" || true
check "an empty serve status is a failed query, not an absent route" \
  outputMatches "$emptyStatusOutput" '\[warn\].*serve status --json failed'
check "an empty serve status never reads as an absent route" \
  outputLacks "$emptyStatusOutput" "skipped, glissa remote disabled"
check "an empty serve status leaves the route up" logLacks "serve --https"
check "an empty serve status keeps the withdrawal pending" test -f "$badStatusPendingState"

rm -f "$badStatusState/serve-empty-status" "$badStatusPendingState"
touch "$badStatusState/serve-array-status"
: > "$commandLog"
arrayStatusOutput="$(runInstall "$badStatusHome" server)" || true
check "a serve status holding an array is a failed query, not an absent route" \
  outputMatches "$arrayStatusOutput" '\[warn\].*serve status --json failed'
check "a serve status holding an array leaves the route up" logLacks "serve --https"

rm -f "$badStatusState/serve-array-status" "$badStatusPendingState"
touch "$badStatusState/serve-status-fails"
writeRemoteConfig "$badStatusHome" true
: > "$commandLog"
failedStatusOutput="$(runInstall "$badStatusHome" server)" || true
check "a serve status query that fails never republishes the route" logLacks "serve --bg"
check "a serve status query that fails says which command failed" \
  outputMatches "$failedStatusOutput" '\[warn\].*serve status --json failed'

rm -f "$badStatusState/serve-status-fails" "$badStatusState/serve-port" "$badStatusOwnedRecord"
rm -f "$coreBin/timeout"
: > "$commandLog"
noTimeoutOutput="$(runInstall "$badStatusHome" server)" || true
check "a publication nothing can bound is refused rather than run unbounded" logLacks "serve --bg"
check "the missing timeout names the command to run by hand" \
  outputMatches "$noTimeoutOutput" '\[warn\].*timeout not on PATH'
check "a publication nothing can bound records no ownership" \
  test ! -e "$badStatusHome/.local/state/dotfiles/glissa-serve-owned"
linkCoreUtilities timeout

refusedOwnershipRecord="$badStatusHome/.local/state/dotfiles/glissa-serve-owned"
refusedOwnershipPending="$badStatusHome/.local/state/dotfiles/glissa-serve-withdrawal-pending"
refusedOwnershipTarget="$toolingHome/refused-glissa-ownership"
mkdir -p "$(dirname -- "$refusedOwnershipRecord")"
: > "$refusedOwnershipTarget"
ln -s "$refusedOwnershipTarget" "$refusedOwnershipRecord"
: > "$badStatusState/serve-off-fails"
: > "$commandLog"
refusedOwnershipOutput="$(runInstall "$badStatusHome" server)" || true
check "a failed ownership rollback attempts to withdraw the live route" \
  logHas "tailscale serve --https=443 off"
check "a failed ownership rollback leaves the route live" test -e "$badStatusState/serve-port"
check "a failed ownership rollback keeps withdrawal pending" test -f "$refusedOwnershipPending"
check "a failed ownership rollback warns that manual withdrawal is required" \
  outputHas "$refusedOwnershipOutput" "published route is live"
rm -f "$badStatusState/serve-off-fails" "$badStatusState/serve-port" \
  "$refusedOwnershipRecord" "$refusedOwnershipTarget" "$refusedOwnershipPending"

check "seed input selection receives both paths explicitly" \
  grep -q 'selectGlissaSeedInputs "$baseSeedPath" "$machineLocalSeed"' "$topicDir/install.sh"
check "seed input selection publishes named selection globals" \
  grep -q '^selectedGlissaSeedPath=' "$topicDir/install.sh"
check "seed input selection uses one description value" \
  bash -c '! grep -q "selectedGlissaAppliedDescription" "$1"' _ "$topicDir/install.sh"

consentInputPath="$toolingHome/serve-consent-input"
printf 'y\n' > "$consentInputPath"
: > "$commandLog"
runInstall "$badStatusHome" server "" "$consentInputPath" > /dev/null || true
check "publishing the route reaches the tailnet" logHas "tailscale serve --bg 3001"
check "publishing the route never reads the converge's stdin" logLacks "serve read stdin"
check "publishing the route records what this topic owns" \
  test "$(cat "$badStatusHome/.local/state/dotfiles/glissa-serve-owned")" = "3001"
check "a recorded publication owes no withdrawal" test ! -e "$badStatusPendingState"

writeRemoteConfig "$badStatusHome" false
: > "$commandLog"
ownedWithdrawalOutput="$(runInstall "$badStatusHome" server)" || true
check "the route this topic recorded as its own is withdrawn" logHas "tailscale serve --https=443 off"
check "the withdrawal of an owned route is reported" \
  outputHas "$ownedWithdrawalOutput" "route removed, glissa remote disabled"
check "a withdrawn route leaves no ownership record behind" \
  test ! -e "$badStatusHome/.local/state/dotfiles/glissa-serve-owned"

writeRemoteConfig "$badStatusHome" true
: > "$badStatusState/serve-bg-fails"
: > "$commandLog"
failedPublishOutput="$(runInstall "$badStatusHome" server)" || true
check "a publication that fails names the command to run by hand" \
  outputMatches "$failedPublishOutput" '\[warn\].*run: tailscale serve --bg 3001'
check "a publication that fails records no ownership" \
  test ! -e "$badStatusHome/.local/state/dotfiles/glissa-serve-owned"
check "a publication that fails keeps the withdrawal it cannot disprove pending" \
  test -f "$badStatusPendingState"
rm -f "$badStatusState/serve-bg-fails"

touch "$badStatusState/tailscale-unauthed"
: > "$commandLog"
unauthedAfterFailedPublishOutput="$(runInstall "$badStatusHome" server)" || true
check "an enabled converge that cannot ask the tailnet keeps the marker a failed publish left" \
  test -f "$badStatusPendingState"
check "an enabled converge that cannot ask the tailnet publishes nothing" logLacks "serve --bg"
check "an enabled converge that cannot ask the tailnet says so" \
  outputMatches "$unauthedAfterFailedPublishOutput" '\[warn\].*run sudo tailscale up once'
rm -f "$badStatusState/tailscale-unauthed"

: > "$commandLog"
runInstall "$badStatusHome" server > /dev/null || true
check "a converge that publishes the route clears the marker its failed publish left" \
  test ! -e "$badStatusPendingState"
check "the converge that cleared the marker owns the route it published" \
  test "$(cat "$badStatusHome/.local/state/dotfiles/glissa-serve-owned")" = "3001"

writeRemoteConfig "$badStatusHome" true
: > "$commandLog"
runInstall "$badStatusHome" server "" "$consentInputPath" > /dev/null || true
check "the route is published again before a stale marker is planted" \
  test -f "$badStatusState/serve-port"
: > "$badStatusPendingState"
: > "$commandLog"
stalePendingOutput="$(runInstall "$badStatusHome" server)" || true
check "an enabled config never acts on a withdrawal marker left by an earlier run" \
  logLacks "serve --https"
check "an enabled config that finds the live route already matching clears the stale marker" \
  test ! -e "$badStatusPendingState"
check "a live route is left up rather than torn down and republished" logLacks "serve --bg"
check "the live route survives the stale marker" test -f "$badStatusState/serve-port"
check "the run that cleared the stale marker reports the route as it found it" \
  outputHas "$stalePendingOutput" "remote port 3001"

printf '%s\n' '{ "port": 3000, "pairingNote": "CHANGEME once the device is paired", "remote": { "enabled": true, "port": 3001, "publicHost": "handset.tailnet-name.ts.net" } }' \
  > "$badStatusHome/.glissa/config.json"
: > "$commandLog"
handSetHostOutput="$(runInstall "$badStatusHome" server)" || true
check "a hand set publicHost survives a CHANGEME somewhere else in the config" \
  test "$(configValue "$badStatusHome" 'require(process.argv[1]).remote.publicHost')" \
    = "handset.tailnet-name.ts.net"
check "a hand set publicHost that differs from the tailnet is reported as drift" \
  outputMatches "$handSetHostOutput" '\[warn\].*but the tailnet reports'

check "no path in the real home is ever named" \
  commandLogNamesNoPathUnder "$realHome/.glissa" "$realHome/.config/systemd" \
  "$realHome/Projects/glissa"

reportTopicResults "glissa"
