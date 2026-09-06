# shellcheck shell=bash
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

check "the user unit is installed" test -f "$serverUnitPath"
check "the unit runs the node from the fixed candidate list, not the shell's" \
  grep -q "^ExecStart=$serverHome/.local/bin/node dist/server/index.js\$" "$serverUnitPath"
check "the unit rebuilds dist before starting, with the npm beside the resolved node" \
  grep -q "^ExecStartPre=$serverHome/.local/bin/npm run build\$" "$serverUnitPath"
check "the unit no longer conditions on a built dist, the build step heals it instead" \
  bash -c '! grep -q "^ConditionPathExists=" "$1"' _ "$serverUnitPath"
check "the unit works out of this home" grep -q "^WorkingDirectory=$serverHome/Projects/glissa\$" "$serverUnitPath"
check "the unit carries a rendered PATH" grep -q "^Environment=PATH=.\+\$" "$serverUnitPath"
check "no placeholder survives the render" \
  bash -c '! grep -qE "__(NODE|NPM|APP_DIR|HOME|PATH)__" "$1"' _ "$serverUnitPath"

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

printf '[Unit]\nDescription=hand written\n' > "$serverUnitPath"
: > "$commandLog"
handEditOutput="$(runInstall "$serverHome" server)"
check "a hand edited unit is backed up" \
  bash -c 'compgen -G "$1.pre-dotfiles.bak*" > /dev/null' _ "$serverUnitPath"
check "the backup keeps what was there" \
  bash -c 'grep -q "hand written" "$1".pre-dotfiles.bak' _ "$serverUnitPath"
check "the rendered unit replaces the hand edit" \
  grep -q "^ExecStart=$serverHome/.local/bin/node dist/server/index.js\$" "$serverUnitPath"
check "the re-rendered unit keeps its build step" \
  grep -q "^ExecStartPre=$serverHome/.local/bin/npm run build\$" "$serverUnitPath"
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
