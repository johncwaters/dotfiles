#!/usr/bin/env bash
# One sandbox home per profile, because the seed a profile picks is the difference.

set -uo pipefail

topicDir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repoRoot="$(cd -- "$topicDir/.." && pwd)"
export DOTFILES_PLATFORM=linux
# shellcheck source=../test/harness.sh
source "$repoRoot/test/harness.sh"
# shellcheck source=../script/lib/state.sh
source "$repoRoot/script/lib/state.sh"

suiteSkipsTheRealHomeCheck=1

startStubbedSandbox "glimmervoid"
toolingHome="$sandbox"
startSandboxHome "glimmervoid-personal"
personalHome="$sandbox"
startSandboxHome "glimmervoid-server"
serverHome="$sandbox"
serverUnitPath="$serverHome/.config/systemd/user/glimmervoid.service"
startSandboxHome "glimmervoid-unauthed"
unauthedHome="$sandbox"
startSandboxHome "glimmervoid-optout"
optOutHome="$sandbox"
startSandboxHome "glimmervoid-symlinked"
symlinkedHome="$sandbox"
startSandboxHome "glimmervoid-broken"
brokenConfigHome="$sandbox"
startSandboxHome "glimmervoid-unowned"
unownedRouteHome="$sandbox"
startSandboxHome "glimmervoid-badstatus"
badStatusHome="$sandbox"
startSandboxHome "glimmervoid-unresolved"
unresolvedProfileHome="$sandbox"
startSandboxHome "glimmervoid-pending-deps"
pendingDepsHome="$sandbox"
startSandboxHome "glimmervoid-missing-app"
missingAppHome="$sandbox"
startSandboxHome "glimmervoid-invalid-app"
invalidAppHome="$sandbox"
startSandboxHome "glimmervoid-local-seed"
localSeedHome="$sandbox"
startSandboxHome "glimmervoid-work-darwin"
darwinWorkHome="$sandbox"

realHome="$HOME"
realNodePath="$(command -v node 2>/dev/null || true)"
if [[ -z "$realNodePath" ]]; then
  printf 'glimmervoid/test.sh needs node on PATH: the installer reads the dashboard config with it.\n' >&2
  exit 1
fi
isolatedWorkPort="$("$realNodePath" -e 'const server=require("net").createServer();server.listen(0,"127.0.0.1",()=>{console.log(server.address().port);server.close()})')"

sandboxTemp="$toolingHome/tmp"

mkdir -p "$sandboxTemp"

linkCoreUtilities bash sh env cat sed awk grep tail head cut tr find sort uniq wc mktemp rm \
  mkdir rmdir cp mv ln readlink basename dirname chmod cksum cmp id date stat touch true false \
  xargs od tee expr sleep printf test uname

# macOS ships no timeout, and serve.sh only runs on a Linux server, so a host without one gets a pass-through.
provideTimeout() {
  linkCoreUtilities timeout
  if [[ -e "$coreBin/timeout" ]]; then
    return 0
  fi
  printf '#!/usr/bin/env bash\nshift\nexec "$@"\n' > "$coreBin/timeout"
  chmod +x "$coreBin/timeout"
}
provideTimeout

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

for recordingOnlyCommand in claude glimmervoid npm; do
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
  "$localSeedHome" "$darwinWorkHome"; do
  mkdir -p "$machineHomePath/.local/bin"
  ln -sf "$stubBin/node" "$machineHomePath/.local/bin/node"
done

makeGlimmervoidApp() {
  local machineHome="$1"
  mkdir -p "$machineHome/Projects/glimmervoid/.git" \
    "$machineHome/Projects/glimmervoid/server" \
    "$machineHome/Projects/glimmervoid/dist/server" \
    "$machineHome/Projects/glimmervoid/dist/bin"
  : > "$machineHome/Projects/glimmervoid/server/main.ts"
  : > "$machineHome/Projects/glimmervoid/dist/server/index.js"
  : > "$machineHome/Projects/glimmervoid/dist/bin/glimmervoid.js"
  printf '{}\n' > "$machineHome/Projects/glimmervoid/package.json"
}

# The suite may itself be running under glimmervoid.service, and the real cgroup must never decide what a sandboxed run does.
outsideServiceCgroup="$sandboxTemp/outside-glimmervoid.cgroup"
printf '0::/user.slice/user-1000.slice/session-1.scope\n' > "$outsideServiceCgroup"

runInstall() {
  local machineHome="$1"
  local machineProfile="$2"
  local extraPathPrefix="${3:-}"
  local stdinPath="${4:-/dev/null}"
  local machinePlatform="${5:-linux}"
  local machineAccountName="${6:-sandboxaccount}"
  runInStubbedSandbox "$machineHome" \
    PATH="${extraPathPrefix:+$extraPathPrefix:}$stubBin:$coreBin" \
    TMPDIR="$sandboxTemp" \
    USER="$machineAccountName" \
    DOTFILES_PLATFORM="$machinePlatform" \
    DOTFILES_PROFILE="$machineProfile" \
    DOTFILES_MARKER_PATH="$machineHome/.machine-profile" \
    DOTFILES_TEST_MACHINE="$(basename -- "$machineHome")" \
    DOTFILES_TEST_REAL_NODE="$realNodePath" \
    DOTFILES_CGROUP_FILE="${DOTFILES_CGROUP_FILE:-$outsideServiceCgroup}" \
    NO_COLOR=1 \
    bash "$topicDir/install.sh" < "$stdinPath"
}

configValue() {
  "$realNodePath" -p "String($2)" "$1/.glimmervoid/config.json" 2>/dev/null
}

printf '\nglimmervoid topic\n'
[[ -s "$topicDir/test/install.sh" ]] || exit 1
# shellcheck source=./test/install.sh
source "$topicDir/test/install.sh" || exit 1

: > "$commandLog"
mkdir -p "$darwinWorkHome/.glimmervoid"
printf '{"port":%s}\n' "$isolatedWorkPort" > "$darwinWorkHome/.glimmervoid/config.json"
printf 'GLIMMERVOID_TELEGRAM_BOT_TOKEN=placeholder\nGLIMMERVOID_POSTHOG_API_KEY=placeholder\n' \
  > "$darwinWorkHome/.glimmervoid/secrets.env"
makeGlimmervoidApp "$darwinWorkHome"
writeStub launchctl <<'STUB'
#!/usr/bin/env bash
printf 'launchctl %s\n' "$*" >> "$DOTFILES_TEST_LOG"
[[ "${1:-}" == bootstrap ]]
STUB
provideCommand launchctl
darwinWorkStatus=0
darwinWorkOutput="$(runInstall "$darwinWorkHome" work "" /dev/null darwin)" || darwinWorkStatus=$?
check "the work profile applies shared settings on darwin" test "$darwinWorkStatus" -eq 0
check "darwin keeps the work profile config" test -f "$darwinWorkHome/.glimmervoid/config.json"
check "darwin serves glimmervoid as a launch agent" \
  logHas "launchctl bootstrap gui/$(id -u) $darwinWorkHome/Library/LaunchAgents/dev.dotfiles.glimmervoid.plist"
darwinGlimmervoidPlist="$darwinWorkHome/Library/LaunchAgents/dev.dotfiles.glimmervoid.plist"
check "the launch agent tells glimmervoid launchd supervises it" \
  grep -q '<string>launchd</string>' "$darwinGlimmervoidPlist"
check "the launch agent runs the work checkout" \
  grep -q "<string>$darwinWorkHome/Projects/glimmervoid</string>" "$darwinGlimmervoidPlist"
check "darwin never touches systemd" logLacks "systemctl "
check "darwin never touches tailscale serve" logLacks "tailscale serve"

[[ -s "$topicDir/test/service.sh" ]] || exit 1
# shellcheck source=./test/service.sh
source "$topicDir/test/service.sh" || exit 1
[[ -s "$topicDir/test/serve.sh" ]] || exit 1
# shellcheck source=./test/serve.sh
source "$topicDir/test/serve.sh" || exit 1

check "settings sync exercises apply, collect and a listening server" \
  "$realNodePath" "$topicDir/test/sync-settings.mjs" "$toolingHome/settings-sync"

reportTopicResults "glimmervoid"
