# shellcheck shell=bash
makeGlissaApp "$personalHome"
mkdir -p "$personalHome/.claude"
printf '{}\n' > "$personalHome/.claude/.credentials.json"
mkdir -p "$personalHome/.glissa"
printf 'GLISSA_TELEGRAM_BOT_TOKEN=placeholder\nGLISSA_POSTHOG_API_KEY=placeholder\n' \
  > "$personalHome/.glissa/secrets.env"
chmod 644 "$personalHome/.glissa/secrets.env"
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
check "the secrets file is owner only" \
  test "$(stat -c '%a' "$personalHome/.glissa/secrets.env")" = "600"
check "a secrets file carrying every variable draws no warning" \
  outputLacks "$personalOutput" "write GLISSA_"
check "a personal machine installs the unit" test -f "$personalHome/.config/systemd/user/glissa.service"
check "the unit loads the secrets file without requiring it" \
  grep -qxF 'EnvironmentFile=-%h/.glissa/secrets.env' "$personalHome/.config/systemd/user/glissa.service"
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

printf 'GLISSA_TELEGRAM_BOT_TOKEN=\nGLISSA_POSTHOG_API_KEY=placeholder\n' \
  > "$personalHome/.glissa/secrets.env"
emptyAssignmentOutput="$(runInstall "$personalHome" personal)" || true
check "a variable assigned no value is named as still missing" \
  outputMatches "$emptyAssignmentOutput" '\[warn\].*write GLISSA_TELEGRAM_BOT_TOKEN into'
check "a variable assigned a value beside an empty one is left out of the warning" \
  outputLacks "$emptyAssignmentOutput" "GLISSA_POSTHOG_API_KEY"

printf 'GLISSA_TELEGRAM_BOT_TOKEN=""\nGLISSA_POSTHOG_API_KEY=placeholder\n' \
  > "$personalHome/.glissa/secrets.env"
emptyDoubleQuotedOutput="$(runInstall "$personalHome" personal)" || true
check "a variable assigned empty double quotes is named as still missing" \
  outputMatches "$emptyDoubleQuotedOutput" '\[warn\].*write GLISSA_TELEGRAM_BOT_TOKEN into'

printf "GLISSA_TELEGRAM_BOT_TOKEN=''\nGLISSA_POSTHOG_API_KEY=placeholder\n" \
  > "$personalHome/.glissa/secrets.env"
emptySingleQuotedOutput="$(runInstall "$personalHome" personal)" || true
check "a variable assigned empty single quotes is named as still missing" \
  outputMatches "$emptySingleQuotedOutput" '\[warn\].*write GLISSA_TELEGRAM_BOT_TOKEN into'

printf 'GLISSA_TELEGRAM_BOT_TOKEN="placeholder"\nGLISSA_POSTHOG_API_KEY=placeholder\n' \
  > "$personalHome/.glissa/secrets.env"
quotedValueOutput="$(runInstall "$personalHome" personal)" || true
check "a variable assigned a quoted value draws no warning" \
  outputLacks "$quotedValueOutput" "write GLISSA_"

printf 'GLISSA_TELEGRAM_BOT_TOKEN=placeholder\nGLISSA_POSTHOG_API_KEY=placeholder\n' \
  > "$personalHome/.glissa/secrets.env"

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
check "a serving machine with no secrets file names the file to write" \
  outputMatches "$pendingDepsOutput" '\[warn\].*~/\.glissa/secrets\.env'
check "the missing secrets warning names every variable the unit loads" \
  outputHas "$pendingDepsOutput" "GLISSA_TELEGRAM_BOT_TOKEN and GLISSA_POSTHOG_API_KEY"

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

check "seed input selection receives both paths explicitly" \
  grep -q 'selectGlissaSeedInputs "$baseSeedPath" "$machineLocalSeed"' "$topicDir/install.sh"
check "seed input selection publishes named selection globals" \
  grep -q '^selectedGlissaSeedPath=' "$topicDir/install.sh"
check "seed input selection uses one description value" \
  bash -c '! grep -q "selectedGlissaAppliedDescription" "$1"' _ "$topicDir/install.sh"
