# shellcheck shell=bash
makeGlimmervoidApp "$personalHome"
mkdir -p "$personalHome/.claude"
printf '{}\n' > "$personalHome/.claude/.credentials.json"
mkdir -p "$personalHome/.glimmervoid"
printf 'GLIMMERVOID_TELEGRAM_BOT_TOKEN=placeholder\nGLIMMERVOID_POSTHOG_API_KEY=placeholder\n' \
  > "$personalHome/.glimmervoid/secrets.env"
chmod 644 "$personalHome/.glimmervoid/secrets.env"
printf '#!/usr/bin/env bash\nexec %s %s "$@"\n' "$personalHome/.local/bin/node" "$personalHome/Projects/glimmervoid/dist/bin/glimmervoid.js" \
  > "$personalHome/.local/bin/glimmervoid"
chmod 755 "$personalHome/.local/bin/glimmervoid"
: > "$commandLog"
personalStatus=0
personalOutput="$(runInstall "$personalHome" personal)" || personalStatus=$?

check "a fresh personal home warns that the seed needs editing" \
  outputMatches "$personalOutput" '\[warn\].*seeding from config.example.json'
check "a seed that needs editing exits non-zero" test "$personalStatus" -eq 1
check "the personal config is seeded" test -f "$personalHome/.glimmervoid/config.json"
check "no placeholder survives the seed" \
  bash -c '! grep -q "{{HOME}}" "$1/.glimmervoid/config.json"' _ "$personalHome"
check "the personal seed carries no remote block" \
  test "$(configValue "$personalHome" 'require(process.argv[1]).remote === undefined')" = "true"
check "the config directory is owner only" \
  test "$(fileModeOf "$personalHome/.glimmervoid")" = "700"
check "the config file is owner only" \
  test "$(fileModeOf "$personalHome/.glimmervoid/config.json")" = "600"
check "the secrets file is owner only" \
  test "$(fileModeOf "$personalHome/.glimmervoid/secrets.env")" = "600"
check "a secrets file carrying every variable draws no warning" \
  outputLacks "$personalOutput" "write GLIMMERVOID_"
check "a personal machine installs the release binary" test -x "$personalHome/.glimmervoid/bin/glimmervoid"
check "the release installer runs with shell rc edits turned off" logHas "glimmervoid installer GLIMMERVOID_NO_MODIFY_PATH=1"
check "the dotfiles node shim is retired once the binary is installed" test ! -e "$personalHome/.local/bin/glimmervoid"
check "a personal machine installs the unit" test -f "$personalHome/.config/systemd/user/glimmervoid.service"
check "the unit loads the secrets file without requiring it" \
  grep -qxF 'EnvironmentFile=-%h/.glimmervoid/secrets.env' "$personalHome/.config/systemd/user/glimmervoid.service"
check "a personal machine enables the service" logHas "systemctl --user enable --now glimmervoid"
check "a config without a remote block is remote-disabled" \
  outputHas "$personalOutput" 'remote access disabled'
check "a personal machine publishes nothing on the tailnet" logLacks "serve --bg"
check "a personal machine probes only the local listener" logHas "http://127.0.0.1:3000/"
check "a personal machine never probes the remote listener" logLacks "http://127.0.0.1:3001/"

"$realNodePath" -e 'const fs=require("fs");const config=require(process.argv[1]);config.port=Number(process.argv[2]);fs.writeFileSync(process.argv[1], JSON.stringify(config))' \
  "$personalHome/.glimmervoid/config.json" "$isolatedWorkPort"
runInstall "$personalHome" personal > /dev/null || true
check "a personal machine converges the shared glimmervoid hooks" \
  test "$(configValue "$personalHome" 'require(process.argv[1]).hooks.map(hook => hook.command).join(" ")')" = "node $personalHome/.claude/hooks/block-comments.mjs node $personalHome/.claude/hooks/block-else.mjs"
check "the shared settings resolve the home token to this home" \
  test "$(configValue "$personalHome" 'require(process.argv[1]).repoRoots[0]')" = "$personalHome/Projects"
"$realNodePath" -e 'const fs=require("fs");const config=require(process.argv[1]);config.port=3000;fs.writeFileSync(process.argv[1], JSON.stringify(config))' \
  "$personalHome/.glimmervoid/config.json"
runInstall "$personalHome" personal > /dev/null || true
: > "$commandLog"
personalRerunStatus=0
personalRerunOutput="$(runInstall "$personalHome" personal)" || personalRerunStatus=$?
check "a second personal run reports no change" reportsNoChanges "$personalRerunOutput"
check "a second personal run exits clean" test "$personalRerunStatus" -eq 0
check "a second personal run downloads no installer" logLacks "glimmervoid installer"

printf '#!/bin/sh\necho hand-written\n' > "$personalHome/.local/bin/glimmervoid"
foreignShimOutput="$(runInstall "$personalHome" personal)" || true
check "a glimmervoid in ~/.local/bin that is not the dotfiles shim is kept" \
  grep -q hand-written "$personalHome/.local/bin/glimmervoid"
check "a kept foreign glimmervoid is warned about" \
  outputMatches "$foreignShimOutput" '\[warn\].*not the dotfiles shim'
rm -f "$personalHome/.local/bin/glimmervoid"

printf 'GLIMMERVOID_TELEGRAM_BOT_TOKEN=\nGLIMMERVOID_POSTHOG_API_KEY=placeholder\n' \
  > "$personalHome/.glimmervoid/secrets.env"
emptyAssignmentOutput="$(runInstall "$personalHome" personal)" || true
check "a variable assigned no value is named as still missing" \
  outputMatches "$emptyAssignmentOutput" '\[warn\].*write GLIMMERVOID_TELEGRAM_BOT_TOKEN into'
check "a variable assigned a value beside an empty one is left out of the warning" \
  outputLacks "$emptyAssignmentOutput" "GLIMMERVOID_POSTHOG_API_KEY"

printf 'GLIMMERVOID_TELEGRAM_BOT_TOKEN=""\nGLIMMERVOID_POSTHOG_API_KEY=placeholder\n' \
  > "$personalHome/.glimmervoid/secrets.env"
emptyDoubleQuotedOutput="$(runInstall "$personalHome" personal)" || true
check "a variable assigned empty double quotes is named as still missing" \
  outputMatches "$emptyDoubleQuotedOutput" '\[warn\].*write GLIMMERVOID_TELEGRAM_BOT_TOKEN into'

printf "GLIMMERVOID_TELEGRAM_BOT_TOKEN=''\nGLIMMERVOID_POSTHOG_API_KEY=placeholder\n" \
  > "$personalHome/.glimmervoid/secrets.env"
emptySingleQuotedOutput="$(runInstall "$personalHome" personal)" || true
check "a variable assigned empty single quotes is named as still missing" \
  outputMatches "$emptySingleQuotedOutput" '\[warn\].*write GLIMMERVOID_TELEGRAM_BOT_TOKEN into'

printf 'GLIMMERVOID_TELEGRAM_BOT_TOKEN="placeholder"\nGLIMMERVOID_POSTHOG_API_KEY=placeholder\n' \
  > "$personalHome/.glimmervoid/secrets.env"
quotedValueOutput="$(runInstall "$personalHome" personal)" || true
check "a variable assigned a quoted value draws no warning" \
  outputLacks "$quotedValueOutput" "write GLIMMERVOID_"

printf 'GLIMMERVOID_TELEGRAM_BOT_TOKEN=placeholder\nGLIMMERVOID_POSTHOG_API_KEY=placeholder\n' \
  > "$personalHome/.glimmervoid/secrets.env"

printf '{ "port": 3000, "editorCommand": "hand-edited" }\n' > "$personalHome/.glimmervoid/config.json"
runInstall "$personalHome" personal > /dev/null || true
check "an existing config is never overwritten" \
  test "$(configValue "$personalHome" 'require(process.argv[1]).editorCommand')" = "hand-edited"

printf '%s\n' '{ "port": 3000, "remote": { "port": 3001, "publicHost": "testbox.tailnet-name.ts.net" } }' \
  > "$personalHome/.glimmervoid/config.json"
: > "$commandLog"
keylessRemoteOutput="$(runInstall "$personalHome" personal)" || true
check "a remote block with no enabled key reads as disabled" \
  outputHas "$keylessRemoteOutput" 'remote access disabled'
check "a remote block with no enabled key publishes nothing on the tailnet" logLacks "serve --bg"

startSandboxHome "glimmervoid-offline"
offlineHome="$sandbox"
mkdir -p "$offlineHome/.local/bin" "$offlineHome/.glimmervoid" "$stubState/$(basename -- "$offlineHome")"
ln -sf "$stubBin/node" "$offlineHome/.local/bin/node"
printf '{"port":%s}\n' "$isolatedWorkPort" > "$offlineHome/.glimmervoid/config.json"
printf '#!/usr/bin/env bash\nexec %s %s "$@"\n' "$offlineHome/.local/bin/node" "$offlineHome/Projects/glimmervoid/dist/bin/glimmervoid.js" \
  > "$offlineHome/.local/bin/glimmervoid"
cp "$offlineHome/.local/bin/glimmervoid" "$sandboxTemp/offline-shim-before-install"
makeGlimmervoidApp "$offlineHome"
mkdir -p "$offlineHome/.config/systemd/user"
printf '[Service]\nExecStart=old checkout unit\n' > "$offlineHome/.config/systemd/user/glimmervoid.service"
touch "$stubState/$(basename -- "$offlineHome")/installer-unreachable"
: > "$commandLog"
offlineOutput="$(runInstall "$offlineHome" server)" || true
check "an unreachable installer is warned about" \
  outputMatches "$offlineOutput" '\[warn\].*glimmervoid binary.*installer download failed'
check "an unreachable installer leaves the shim byte-identical" \
  cmp -s "$sandboxTemp/offline-shim-before-install" "$offlineHome/.local/bin/glimmervoid"
check "an unreachable installer leaves the old unit in place" \
  grep -qx "ExecStart=old checkout unit" "$offlineHome/.config/systemd/user/glimmervoid.service"
check "an unreachable installer touches no running service" logLacks "systemctl "

startSandboxHome "glimmervoid-work"
workHome="$sandbox"
mkdir -p "$workHome/.local/bin"
ln -sf "$stubBin/node" "$workHome/.local/bin/node"
makeGlimmervoidApp "$workHome"
mkdir -p "$workHome/.glimmervoid"
cp "$repoRoot/glimmervoid/config.example.json" "$workHome/.glimmervoid/config.json"
"$realNodePath" -e 'const fs=require("fs");const config=require(process.argv[1]);config.port=Number(process.argv[2]);fs.writeFileSync(process.argv[1], JSON.stringify(config))' \
  "$workHome/.glimmervoid/config.json" "$isolatedWorkPort"
: > "$commandLog"
runInstall "$workHome" work > /dev/null || true

workSoundsDirectory="$workHome/.glimmervoid/sounds"
for bundledSoundName in coins.ogg tears-of-guthix.ogg; do
  check "$bundledSoundName lands in the glimmervoid home sounds directory as a regular file" \
    bash -c '[[ -f "$1" && ! -L "$1" ]]' _ "$workSoundsDirectory/$bundledSoundName"
  check "$bundledSoundName matches the repo copy" \
    cmp -s "$repoRoot/glimmervoid/sounds/$bundledSoundName" "$workSoundsDirectory/$bundledSoundName"
done
printf 'operator sound\n' > "$workSoundsDirectory/operator-added.mp3"
coinsInodeBeforeRerun="$(ls -i "$workSoundsDirectory/coins.ogg")"
soundsRerunOutput="$(runInstall "$workHome" work)" || true
check "a second run leaves the copied sounds untouched" \
  test "$(ls -i "$workSoundsDirectory/coins.ogg")" = "$coinsInodeBeforeRerun"
check "a second run reports every sound up to date" \
  outputLacks "$soundsRerunOutput" "copied"
check "a second run keeps a sound the operator added" test -f "$workSoundsDirectory/operator-added.mp3"

startSandboxHome "glimmervoid-work-broken-config"
brokenConfigWorkHome="$sandbox"
mkdir -p "$brokenConfigWorkHome/.local/bin" "$brokenConfigWorkHome/.glimmervoid"
ln -sf "$stubBin/node" "$brokenConfigWorkHome/.local/bin/node"
makeGlimmervoidApp "$brokenConfigWorkHome"
printf '{ "port": %s, not json\n' "$isolatedWorkPort" > "$brokenConfigWorkHome/.glimmervoid/config.json"
cp "$brokenConfigWorkHome/.glimmervoid/config.json" "$sandboxTemp/broken-config-before-install"
: > "$commandLog"
brokenConfigWorkOutput="$(runInstall "$brokenConfigWorkHome" work 2>&1)" || true
check "a shared settings sync failure warns with a one-line reason" \
  outputMatches "$brokenConfigWorkOutput" '\[warn\].*glimmervoid settings.*not applied: .*JSON'
check "a shared settings sync failure prints no stack trace" outputLacks "$brokenConfigWorkOutput" "sync-settings.mjs:"
check "a shared settings sync failure leaves the config bytes alone" \
  cmp -s "$sandboxTemp/broken-config-before-install" "$brokenConfigWorkHome/.glimmervoid/config.json"
check "a shared settings sync failure still copies the sounds" test -f "$brokenConfigWorkHome/.glimmervoid/sounds/coins.ogg"
check "a shared settings sync failure still installs the binary" test -x "$brokenConfigWorkHome/.glimmervoid/bin/glimmervoid"

startSandboxHome "glimmervoid-homebrew-node"
homebrewNodeHome="$sandbox"
homebrewNodePrefix="$homebrewNodeHome/homebrew"
mkdir -p "$homebrewNodePrefix/bin"
mkdir -p "$homebrewNodeHome/.glimmervoid"
printf '{"port":%s}\n' "$isolatedWorkPort" > "$homebrewNodeHome/.glimmervoid/config.json"
ln -sf "$stubBin/node" "$homebrewNodePrefix/bin/node"
makeGlimmervoidApp "$homebrewNodeHome"
: > "$commandLog"
# The homebrew prefix seam refuses an account the passwd database cannot answer for, so this case runs under the real one.
writeDarwinDirectoryServiceStub "$stubBin"
DOTFILES_TEST_HOMEBREW_PREFIX="$homebrewNodePrefix" \
  runInstall "$homebrewNodeHome" work "" /dev/null darwin "$(id -un)" > /dev/null || true
rm -f "$stubBin/dscl" "$stubBin/.dscl-account-home" "$stubBin/.dscl-login-shell"
check "node reachable only at the homebrew prefix still applies shared settings" \
  test "$(configValue "$homebrewNodeHome" 'require(process.argv[1]).rtk')" = true
check "node reachable only at the homebrew prefix still installs the binary" \
  test -x "$homebrewNodeHome/.glimmervoid/bin/glimmervoid"

unresolvedProfileStatus=0
unresolvedProfileOutput="$(runInstall "$unresolvedProfileHome" "")" || unresolvedProfileStatus=$?
check "an unresolved profile warns instead of choosing a seed" \
  outputMatches "$unresolvedProfileOutput" '\[warn\].*no profile resolved'
check "an unresolved profile seeds no config" test ! -e "$unresolvedProfileHome/.glimmervoid/config.json"
check "an unresolved profile exits non-zero" test "$unresolvedProfileStatus" -eq 1

missingProfileOutput="$(runInstall "$unresolvedProfileHome" missingprofile)" || true
check "a missing profile settings warning prints the checkout path" \
  outputHas "$missingProfileOutput" "$repoRoot/profiles/missingprofile/glimmervoid.json"

localSeedPath="$toolingHome/machine-local-glimmervoid-seed.json"
printf '{ "port": 4100, "repoRoots": ["{{HOME}}/LocalProjects"], "projects": [] }\n' \
  > "$localSeedPath"
localSeedOutput="$(DOTFILES_GLIMMERVOID_SEED_PATH="$localSeedPath" \
  runInstall "$localSeedHome" personal)"
check "a machine-local seed is rendered without a missing profile overlay" \
  test "$(configValue "$localSeedHome" 'require(process.argv[1]).port')" = "4100"
check "a machine-local seed resolves its home token" \
  test "$(configValue "$localSeedHome" 'require(process.argv[1]).repoRoots[0]')" \
    = "$localSeedHome/LocalProjects"
check "a machine-local seed is reported from the selected input" \
  outputHas "$localSeedOutput" "seeded from config.json"

makeGlimmervoidApp "$firstServeHome"
mkdir -p "$firstServeHome/.claude"
printf '{}\n' > "$firstServeHome/.claude/.credentials.json"
: > "$commandLog"
firstServeOutput="$(runInstall "$firstServeHome" server)" || true
check "a first serving run starts the service" logHas "systemctl --user enable --now glimmervoid"
check "a successful start records the service input token" \
  test -f "$firstServeHome/.local/state/dotfiles/glimmervoid-service-inputs-record"
check "the service input token no longer follows the source checkout" \
  bash -c '! grep -q "^checkout " "$1"' _ "$firstServeHome/.local/state/dotfiles/glimmervoid-service-inputs-record"
check "a serving machine with no secrets file names the file to write" \
  outputMatches "$firstServeOutput" '\[warn\].*~/\.glimmervoid/secrets\.env'
check "the missing secrets warning names every variable the unit loads" \
  outputHas "$firstServeOutput" "GLIMMERVOID_TELEGRAM_BOT_TOKEN and GLIMMERVOID_POSTHOG_API_KEY"

mkdir -p "$noCheckoutHome/.claude"
printf '{}\n' > "$noCheckoutHome/.claude/.credentials.json"
: > "$commandLog"
runInstall "$noCheckoutHome" server > /dev/null || true
check "a serving machine with no source checkout still serves the binary" \
  logHas "systemctl --user enable --now glimmervoid"
check "a serving machine with no source checkout installs the unit" \
  test -f "$noCheckoutHome/.config/systemd/user/glimmervoid.service"
