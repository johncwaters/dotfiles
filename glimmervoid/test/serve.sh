# shellcheck shell=bash
mkdir -p "$stubState/$(basename -- "$unauthedHome")"
touch "$stubState/$(basename -- "$unauthedHome")/tailscale-unauthed"
makeGlimmervoidApp "$unauthedHome"
: > "$commandLog"
unauthedStatus=0
unauthedOutput="$(runInstall "$unauthedHome" server)" || unauthedStatus=$?
check "an unauthenticated tailnet warns about the placeholder" \
  outputMatches "$unauthedOutput" '\[warn\].*publicHost still says CHANGEME'
check "the warning names the config to edit" outputHas "$unauthedOutput" 'remote.publicHost in ~/.glimmervoid/config.json'
check "the serve step names the command to run" \
  outputMatches "$unauthedOutput" '\[warn\].*tailscale up once, then tailscale serve --bg 3001'
check "an unauthenticated tailnet is never served" logLacks "serve --bg"
check "a placeholder host is never probed over TLS" logLacks "--max-time 10 https://"
check "a missing tailnet login exits non-zero" test "$unauthedStatus" -eq 1
check "the placeholder is left in place for its owner" \
  bash -c 'grep -q "CHANGEME" "$1/.glimmervoid/config.json"' _ "$unauthedHome"

check "the server seed matches the real example plus the profile overlay" \
  "$realNodePath" - "$unauthedHome" "$repoRoot" <<'NODE'
const assert = require("node:assert/strict");
const fs = require("node:fs");
const [home, repository] = process.argv.slice(2);
const readSettingsFile = filePath => JSON.parse(fs.readFileSync(filePath, "utf8"), (_key, value) =>
  typeof value === "string" ? value.replaceAll("{{HOME}}", home) : value);
assert.deepEqual(readSettingsFile(`${home}/.glimmervoid/config.json`), {
  ...readSettingsFile(`${repository}/glimmervoid/config.example.json`),
  ...readSettingsFile(`${repository}/profiles/server/glimmervoid.overlay.json`),
});
NODE

unauthedRerunOutput="$(runInstall "$unauthedHome" server)"
check "a second unauthenticated run reports no change" reportsNoChanges "$unauthedRerunOutput"

makeGlimmervoidApp "$optOutHome"
mkdir -p "$optOutHome/.glimmervoid" "$optOutHome/.claude"
printf '{}\n' > "$optOutHome/.claude/.credentials.json"
printf '%s\n' '{ "port": 3000, "remote": { "port": 3001 } }' \
  > "$optOutHome/.glimmervoid/config.json"
optOutState="$stubState/$(basename -- "$optOutHome")"
mkdir -p "$optOutState"
printf '3001\n' > "$optOutState/serve-port"
touch "$optOutState/tailscale-unauthed"
: > "$commandLog"
optOutOutput="$(runInstall "$optOutHome" server)" || true
check "a config with no publicHost is reported as not published" \
  outputHas "$optOutOutput" 'not published on the tailnet'
check "an opt out publishes nothing on the tailnet" logLacks "serve --bg"
check "an unauthenticated opt out withdraws no route it could not check first" \
  logLacks "serve --https=443 off"
check "an unauthenticated run owing no withdrawal never says the tailnet could not be asked" \
  outputLacks "$optOutOutput" "cannot be checked before withdrawal"
check "an unauthenticated run owing no withdrawal reports the serve step as skipped" \
  outputHas "$optOutOutput" "skipped, glimmervoid not published on the tailnet"
check "the route an unauthenticated run could not check survives" \
  test -f "$optOutState/serve-port"
optOutPendingState="$optOutHome/.local/state/dotfiles/glimmervoid-serve-withdrawal-pending"
optOutOwnedRecord="$optOutHome/.local/state/dotfiles/glimmervoid-serve-owned"
check "a withdrawal of a route this topic never published is never marked pending" \
  test ! -e "$optOutPendingState"
check "an opt out is never probed over TLS" logLacks "--max-time 10 https://"
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

printf '%s\n' '{ "port": 3000, "remote": {} }' \
  > "$optOutHome/.glimmervoid/config.json"
: > "$commandLog"
portlessRemoteOutput="$(runInstall "$optOutHome" server)" || true
check "an unpublished remote with no remote.port still probes the local listener" \
  logHas "http://127.0.0.1:3000/"
check "an unpublished remote is never asked for a remote.port" \
  outputLacks "$portlessRemoteOutput" "set remote.port to 1-65535"
printf '%s\n' '{ "port": 3000, "remote": { "port": 3001 } }' \
  > "$optOutHome/.glimmervoid/config.json"

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
delete config.remote.publicHost;
config.remote.port = 3002;
fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
' "$serverHome/.glimmervoid/config.json"
: > "$commandLog"
withdrawOutput="$(runInstall "$serverHome" server)" || true
check "turning remote off takes the published route down after the port changed" \
  logHas "tailscale serve --https=443 off"
check "the withdrawal is reported" \
  outputHas "$withdrawOutput" 'route removed, glimmervoid not published on the tailnet'
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
ln -s "$outsideConfigDirectory" "$symlinkedHome/.glimmervoid"
: > "$commandLog"
symlinkedDirectoryStatus=0
symlinkedDirectoryOutput="$(runInstall "$symlinkedHome" server)" || symlinkedDirectoryStatus=$?
check "a symlinked ~/.glimmervoid is refused" \
  outputMatches "$symlinkedDirectoryOutput" '\[warn\].*is not a directory, move it aside first'
check "a symlinked ~/.glimmervoid makes the topic exit non-zero" test "$symlinkedDirectoryStatus" -eq 1
check "a symlinked ~/.glimmervoid is left where it was" test -L "$symlinkedHome/.glimmervoid"
check "nothing is chmodded through a symlinked ~/.glimmervoid" \
  test "$(fileModeOf "$outsideConfigDirectory")" = "755"
check "no config outside the home has its mode narrowed" \
  test "$(fileModeOf "$outsideConfigDirectory/config.json")" = "644"
check "no config outside the home is rewritten" \
  grep -qx 'a config file this topic never chose' "$outsideConfigDirectory/config.json"
check "a refused config directory stops before systemd work" logLacks "systemctl "
check "a refused config directory stops before Tailscale work" logLacks "tailscale "
check "a refused config directory stops before reading the config with node" logLacks "node -p"

rm -f "$symlinkedHome/.glimmervoid"
mkdir -p "$symlinkedHome/.glimmervoid"
ln -s "$symlinkedHome/.glimmervoid/nothing-is-here" "$symlinkedHome/.glimmervoid/config.json"
: > "$commandLog"
danglingConfigOutput="$(runInstall "$symlinkedHome" personal)" || true
check "a dangling config symlink is backed up before it is replaced" \
  bash -c 'compgen -G "$1.pre-dotfiles.bak*" > /dev/null' _ "$symlinkedHome/.glimmervoid/config.json"
check "the replacement config is a regular file" \
  bash -c 'test -f "$1" && test ! -L "$1"' _ "$symlinkedHome/.glimmervoid/config.json"
check "the backup of the dangling symlink is reported" \
  outputHas "$danglingConfigOutput" "glimmervoid config backup"

makeGlimmervoidApp "$brokenConfigHome"
mkdir -p "$brokenConfigHome/.glimmervoid"
printf '{ "port": 3000, this is not json\n' > "$brokenConfigHome/.glimmervoid/config.json"
: > "$commandLog"
brokenConfigStatus=0
brokenConfigOutput="$(runInstall "$brokenConfigHome" server)" || brokenConfigStatus=$?
check "a config that will not parse is named as such" \
  outputMatches "$brokenConfigOutput" '\[warn\].*is not valid JSON'
check "a config that will not parse never reads as unpublished" \
  outputLacks "$brokenConfigOutput" "not published on the tailnet"
check "a config that will not parse exits non-zero" test "$brokenConfigStatus" -eq 1
check "a config that will not parse withdraws no route" logLacks "serve --https"
check "a config that will not parse installs no unit" \
  test ! -e "$brokenConfigHome/.config/systemd/user/glimmervoid.service"
check "a config that will not parse starts no service" logLacks "systemctl "

writeRemoteConfig() {
  local publicHostField=""
  if [[ "$2" == true ]]; then
    publicHostField=', "publicHost": "testbox.tailnet-name.ts.net"'
  fi
  printf '{ "port": 3000, "remote": { "port": 3001%s } }\n' "$publicHostField" > "$1/.glimmervoid/config.json"
}

makeGlimmervoidApp "$unownedRouteHome"
mkdir -p "$unownedRouteHome/.glimmervoid"
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
matchingUnownedRecord="$unownedRouteHome/.local/state/dotfiles/glimmervoid-serve-owned"
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

symlinkedOwnershipTarget="$toolingHome/glimmervoid-ownership-target"
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

printf '%s\n' '{ "port": 3000, "remote": {} }' \
  > "$unownedRouteHome/.glimmervoid/config.json"
printf '9999\n' > "$unownedRouteState/serve-port"
: > "$commandLog"
noRecordWithdrawalOutput="$(runInstall "$unownedRouteHome" server)" || true
check "a withdrawal with no port to own leaves the route up" logLacks "serve --https"
check "the withdrawal refusal names the missing record" \
  outputHas "$noRecordWithdrawalOutput" "no record of publishing"
check "the route no record covers survives the withdrawal" \
  grep -qx '9999' "$unownedRouteState/serve-port"

makeGlimmervoidApp "$badStatusHome"
mkdir -p "$badStatusHome/.glimmervoid"
writeRemoteConfig "$badStatusHome" false
badStatusState="$stubState/$(basename -- "$badStatusHome")"
mkdir -p "$badStatusState"
printf '3001\n' > "$badStatusState/serve-port"
touch "$badStatusState/serve-malformed-status"
badStatusPendingState="$badStatusHome/.local/state/dotfiles/glimmervoid-serve-withdrawal-pending"
badStatusOwnedRecord="$badStatusHome/.local/state/dotfiles/glimmervoid-serve-owned"
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
  outputLacks "$malformedStatusOutput" "skipped, glimmervoid not published on the tailnet"
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
  outputLacks "$emptyStatusOutput" "skipped, glimmervoid not published on the tailnet"
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
  test ! -e "$badStatusHome/.local/state/dotfiles/glimmervoid-serve-owned"
provideTimeout

refusedOwnershipRecord="$badStatusHome/.local/state/dotfiles/glimmervoid-serve-owned"
refusedOwnershipPending="$badStatusHome/.local/state/dotfiles/glimmervoid-serve-withdrawal-pending"
refusedOwnershipTarget="$toolingHome/refused-glimmervoid-ownership"
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

consentInputPath="$toolingHome/serve-consent-input"
printf 'y\n' > "$consentInputPath"
: > "$commandLog"
runInstall "$badStatusHome" server "" "$consentInputPath" > /dev/null || true
check "publishing the route reaches the tailnet" logHas "tailscale serve --bg 3001"
check "publishing the route never reads the converge's stdin" logLacks "serve read stdin"
check "publishing the route records what this topic owns" \
  test "$(cat "$badStatusHome/.local/state/dotfiles/glimmervoid-serve-owned")" = "3001"
check "a recorded publication owes no withdrawal" test ! -e "$badStatusPendingState"

writeRemoteConfig "$badStatusHome" false
: > "$commandLog"
ownedWithdrawalOutput="$(runInstall "$badStatusHome" server)" || true
check "the route this topic recorded as its own is withdrawn" logHas "tailscale serve --https=443 off"
check "the withdrawal of an owned route is reported" \
  outputHas "$ownedWithdrawalOutput" "route removed, glimmervoid not published on the tailnet"
check "a withdrawn route leaves no ownership record behind" \
  test ! -e "$badStatusHome/.local/state/dotfiles/glimmervoid-serve-owned"

writeRemoteConfig "$badStatusHome" true
: > "$badStatusState/serve-bg-fails"
: > "$commandLog"
failedPublishOutput="$(runInstall "$badStatusHome" server)" || true
check "a publication that fails names the command to run by hand" \
  outputMatches "$failedPublishOutput" '\[warn\].*run: tailscale serve --bg 3001'
check "a publication that fails records no ownership" \
  test ! -e "$badStatusHome/.local/state/dotfiles/glimmervoid-serve-owned"
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
  test "$(cat "$badStatusHome/.local/state/dotfiles/glimmervoid-serve-owned")" = "3001"

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

printf '%s\n' '{ "port": 3000, "pairingNote": "CHANGEME once the device is paired", "remote": { "port": 3001, "publicHost": "handset.tailnet-name.ts.net" } }' \
  > "$badStatusHome/.glimmervoid/config.json"
: > "$commandLog"
handSetHostOutput="$(runInstall "$badStatusHome" server)" || true
check "a hand set publicHost survives a CHANGEME somewhere else in the config" \
  test "$(configValue "$badStatusHome" 'require(process.argv[1]).remote.publicHost')" \
    = "handset.tailnet-name.ts.net"
check "a hand set publicHost that differs from the tailnet is reported as drift" \
  outputMatches "$handSetHostOutput" '\[warn\].*but the tailnet reports'

check "no path in the real home is ever named" \
  commandLogNamesNoPathUnder "$realHome/.glimmervoid" "$realHome/.config/systemd" \
  "$realHome/Projects/glimmervoid"
