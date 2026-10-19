#!/usr/bin/env bash

set -euo pipefail

topicDir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repoRoot="$(cd -- "$topicDir/.." && pwd)"
# shellcheck source=../test/harness.sh
source "$repoRoot/test/harness.sh"

startStubbedSandbox "peripherals"

sandboxTemp="$sandbox/tmp"
udevRulesPath="$sandbox/udev/70-headset.rules"
pinnedCommit="a6e15cc8bc701a9c4dab8ae4e33363f3040628e9"

mkdir -p "$stubState/package-commands" \
  "$sandboxTemp" "$sandbox/udev"

coreUtilities=(
  bash sh env cat sed awk grep tail head cut tr find sort wc mktemp rm mkdir cp mv ln
  readlink basename dirname chmod cmp id stat touch true false printf test
)
linkCoreUtilities "${coreUtilities[@]}"

writeAptStubThatInstallsMappedCommands

writeContainedSudoStub

writeStub git <<'STUB'
#!/usr/bin/env bash
printf 'git %s\n' "$*" >> "$DOTFILES_TEST_LOG"
if [[ "${1:-}" == "clone" ]]; then
  printf 'clone-terminal-prompt %s\n' "${GIT_TERMINAL_PROMPT:-unset}" >> "$DOTFILES_TEST_LOG"
  mkdir -p "${*: -1}"
  exit 0
fi
if [[ "${3:-}" == "rev-parse" ]]; then
  cat "$DOTFILES_TEST_STATE/cloned-commit"
  exit 0
fi
exit 0
STUB

writeStub cmake <<'STUB'
#!/usr/bin/env bash
printf 'cmake %s\n' "$*" >> "$DOTFILES_TEST_LOG"
if [[ "${1:-}" == "--build" ]]; then
  cp "$DOTFILES_TEST_STATE/available/headsetcontrol" "$2/headsetcontrol"
  exit 0
fi
if [[ "${1:-}" == "--install" ]]; then
  cp "$DOTFILES_TEST_STATE/available/headsetcontrol" "$DOTFILES_TEST_STUB_BIN/headsetcontrol"
  exit 0
fi
buildDirectory=""
while (($# > 0)); do
  if [[ "$1" == "-B" ]]; then
    buildDirectory="$2"
  fi
  shift
done
if [[ -n "$buildDirectory" ]]; then
  mkdir -p "$buildDirectory"
fi
exit 0
STUB

writeStub headsetcontrol <<'STUB'
#!/usr/bin/env bash
printf 'headsetcontrol %s\n' "$*" >> "$DOTFILES_TEST_LOG"
if [[ "${1:-}" == "-u" ]]; then
  cat "$DOTFILES_TEST_STATE/generated-rules"
  exit 0
fi
exit 0
STUB

writeStub cp <<'STUB'
#!/usr/bin/env bash
printf 'cp %s\n' "$*" >> "$DOTFILES_TEST_LOG"
exec "$DOTFILES_TEST_CORE_BIN/cp" "$@"
STUB

writeStub install <<'STUB'
#!/usr/bin/env bash
printf 'install %s\n' "$*" >> "$DOTFILES_TEST_LOG"
destinationPath="${*: -1}"
sourcePath="${*: -2:1}"
mkdir -p "$(dirname -- "$destinationPath")"
cp -f -- "$sourcePath" "$destinationPath"
STUB

writeStub udevadm <<'STUB'
#!/usr/bin/env bash
printf 'udevadm %s\n' "$*" >> "$DOTFILES_TEST_LOG"
if [[ "${1:-}" == "control" && -f "$DOTFILES_TEST_STATE/udev-reload-fails" ]]; then
  printf 'udevadm: the daemon refused the reload\n' >&2
  exit 1
fi
exit 0
STUB

for recordingOnlyCommand in solaar ratbagd piper; do
  writeStub "$recordingOnlyCommand" <<STUB
#!/usr/bin/env bash
printf '$recordingOnlyCommand %s\n' "\$*" >> "\$DOTFILES_TEST_LOG"
exit 0
STUB
done

writeStub python3 <<'STUB'
#!/usr/bin/env bash
printf 'python3 %s\n' "$*" >> "$DOTFILES_TEST_LOG"
if [[ "$*" == "-m pip install "* ]]; then
  targetDirectory=""
  while (($# > 0)); do
    if [[ "$1" == "--target" ]]; then
      targetDirectory="$2"
    fi
    shift
  done
  mkdir -p "$targetDirectory/brother_ql_inventree-1.3.dist-info"
fi
exit 0
STUB

writeStub lpstat <<'STUB'
#!/usr/bin/env bash
[[ -f "$DOTFILES_TEST_STATE/print-queue-exists" ]]
STUB

writeStub lpadmin <<'STUB'
#!/usr/bin/env bash
printf 'lpadmin %s\n' "$*" >> "$DOTFILES_TEST_LOG"
touch "$DOTFILES_TEST_STATE/print-queue-exists"
STUB

for presentFromTheStart in apt-get sudo cp git install udevadm python3 lpstat lpadmin; do
  provideCommand "$presentFromTheStart"
done

mapPackageToCommands solaar "solaar"
mapPackageToCommands ratbagd "ratbagd"
mapPackageToCommands piper "piper"
mapPackageToCommands cmake "cmake"

printf 'KERNEL=="hidraw*", ATTRS{idVendor}=="1038", MODE="0666"\n' > "$stubState/generated-rules"
printf '%s\n' "$pinnedCommit" > "$stubState/cloned-commit"

runInstall() {
  local extraPathPrefix="${1:-}"
  runInStubbedSandbox "$sandbox" \
    PATH="${extraPathPrefix:+$extraPathPrefix:}$stubBin:$coreBin" \
    TMPDIR="$sandboxTemp" \
    DOTFILES_PROFILE=personal \
    DOTFILES_HEADSET_RULES_PATH="$udevRulesPath" \
    NO_COLOR=1 \
    bash "$topicDir/install.sh"
}


printf '\nperipherals topic\n'

installStatus=0
firstRunOutput="$(runInstall)" || installStatus=$?
check "install exits clean" test "$installStatus" -eq 0
check "install says what it did" test -n "$firstRunOutput"
check "the standalone installer leaves the bootstrap topic header alone" \
  bash -c '! grep -qx "  Peripherals" <<< "$1"' _ "$firstRunOutput"

check "Solaar is installed" logHas "install -y solaar"
check "ratbagd is installed" logHas "install -y ratbagd"
check "Piper is installed" logHas "install -y piper"
check "headsetcontrol build deps are installed" \
  logHas "install -y cmake libhidapi-dev pkg-config build-essential"
check "headsetcontrol is cloned at the pinned release tag" logHas "--branch 4.1.0"
check "headsetcontrol is never cloned at whatever HEAD is" logLacks "clone --quiet --depth 1 https"
check "the pinned commit is verified before the build" logHas "rev-parse HEAD"
check "the clone cannot sit on a credential prompt" logHas "clone-terminal-prompt 0"
check "headsetcontrol is built from source" logHas "cmake --build"
check "headsetcontrol is installed as root" \
  grep -qE -- '^sudo -n [^ ]*/cmake --install' "$commandLog"
check "the udev rule lands where udev reads it" test -f "$udevRulesPath"
check "the udev rule is the one the binary generated" \
  grep -q 'idVendor}=="1038"' "$udevRulesPath"
check "udev is reloaded" logHas "udevadm control --reload-rules"
check "no command was refused for reaching outside the stubs" logLacks "sudo refused"
check "the Brother QL library is pinned and kept out of the user site" \
  logHas "--target $sandbox/.local/share/dotfiles/brother-ql brother_ql_inventree==1.3"
check "the label printer gets a raw queue, since Brother's filter prints nothing" \
  logHas "lpadmin -p QL-1100 -E -v usb://Brother/QL-1100 -m raw"
check "ql-print is linked onto PATH" test -L "$sandbox/.local/bin/ql-print"

: > "$commandLog"
secondRunStatus=0
secondRunOutput="$(runInstall)" || secondRunStatus=$?
check "the second run exits clean" test "$secondRunStatus" -eq 0
check "second run reports no changes" reportsNoChanges "$secondRunOutput"
check "second run installs no system package" logLacks "install -y"
check "second run rebuilds nothing" logLacks "cmake --build"
check "second run reinstalls no udev rule" logLacks "udevadm control"
check "second run recreates no printer queue" logLacks "lpadmin"
check "second run reinstalls no Python library" logLacks "pip install"

rm -f "$udevRulesPath"
: > "$commandLog"
repairRunStatus=0
repairRunOutput="$(runInstall)" || repairRunStatus=$?
check "a missing udev rule is repaired without a reinstall" test -f "$udevRulesPath"
check "the repair run exits clean" test "$repairRunStatus" -eq 0
check "the repair reloads udev" logHas "udevadm control --reload-rules"
check "the repair rebuilds nothing" logLacks "cmake --build"
check "the repair says it wrote the rule" outputHas "$repairRunOutput" 'headsetcontrol udev'

printf 'an older rule someone wrote by hand\n' > "$udevRulesPath"
: > "$commandLog"
backupRunStatus=0
backupRunOutput="$(runInstall)" || backupRunStatus=$?
check "a differing rule run exits clean" test "$backupRunStatus" -eq 0
check "a differing rule is copied aside first" \
  grep -qx 'an older rule someone wrote by hand' "$udevRulesPath.pre-dotfiles.bak"
check "the backup is taken as root" \
  grep -qE -- '^sudo -n [^ ]*/cp -p --' "$commandLog"
check "the backup is reported" outputHas "$backupRunOutput" 'headsetcontrol udev backup'
check "the rule itself is replaced" grep -q 'idVendor}=="1038"' "$udevRulesPath"

printf 'a second hand written rule\n' > "$udevRulesPath"
runInstall > /dev/null || true
check "a second backup does not bury the first" \
  grep -qx 'an older rule someone wrote by hand' "$udevRulesPath.pre-dotfiles.bak"
check "the second backup takes the next number" \
  grep -qx 'a second hand written rule' "$udevRulesPath.pre-dotfiles.bak.2"

outsideRulesTarget="$sandbox/outside-udev-target"
printf 'a file udev never read\n' > "$outsideRulesTarget"
rm -f "$udevRulesPath"
ln -s "$outsideRulesTarget" "$udevRulesPath"
: > "$commandLog"
symlinkedRulesStatus=0
symlinkedRulesOutput="$(runInstall)" || symlinkedRulesStatus=$?
check "a symlinked rules path warns" \
  outputMatches "$symlinkedRulesOutput" '\[warn\].*not a regular file'
check "a symlinked rules path makes the topic exit non-zero" test "$symlinkedRulesStatus" -eq 1
check "a symlinked rules path is not written through" \
  grep -qx 'a file udev never read' "$outsideRulesTarget"
check "a symlinked rules path installs nothing" logLacks "install -m 0644"
check "a symlinked rules path is left where it was" test -L "$udevRulesPath"

rm -f "$udevRulesPath"
touch "$stubState/udev-reload-fails"
: > "$commandLog"
failedReloadStatus=0
failedReloadOutput="$(runInstall)" || failedReloadStatus=$?
check "a failed reload warns" outputMatches "$failedReloadOutput" '\[warn\].*reload failed'
check "a failed reload makes the topic exit non-zero" test "$failedReloadStatus" -eq 1
check "a failed reload still leaves the rule on disk" test -f "$udevRulesPath"
check "a failed reload never claims the rules were installed" \
  outputLacks "$failedReloadOutput" "rules installed"
check "what the failed reload still owes is recorded under the shared state directory" \
  test -f "$sandbox/.local/state/dotfiles/peripherals-headset-udev-pending"
check "nothing is recorded beside the root owned rule" \
  bash -c '! compgen -G "$(dirname -- "$1")/.*dotfiles*"' _ "$udevRulesPath"

rm -f "$stubState/udev-reload-fails"
: > "$commandLog"
retriedReloadOutput="$(runInstall)" || true
check "the run after a failed reload retries it even though the bytes match" \
  logHas "udevadm control --reload-rules"
check "the retried reload triggers udev too" logHas "udevadm trigger"
check "the retried reload is reported" outputHas "$retriedReloadOutput" "rules reloaded"
check "the retried reload clears what was owed" \
  test ! -e "$sandbox/.local/state/dotfiles/peripherals-headset-udev-pending"

: > "$commandLog"
settledRulesOutput="$(runInstall)" || true
check "the run after a retried reload reloads nothing" logLacks "udevadm control"
check "the run after a retried reload reports no change" reportsNoChanges "$settledRulesOutput"

hostilePathDirectory="$sandbox/hostile-bin"
mkdir -p "$hostilePathDirectory"
cat > "$hostilePathDirectory/headsetcontrol" <<'STUB'
#!/usr/bin/env bash
printf 'hostile headsetcontrol %s\n' "$*" >> "$DOTFILES_TEST_LOG"
printf 'KERNEL=="hidraw*", RUN+="/bin/sh -c :"\n'
exit 0
STUB
chmod +x "$hostilePathDirectory/headsetcontrol"

rm -f "$udevRulesPath"
: > "$commandLog"
runInstall "$hostilePathDirectory" > /dev/null || true
check "the rule generator is never taken from the account's own PATH" \
  logLacks "hostile headsetcontrol"
check "the rule installed is the one the packaged binary generated" \
  grep -q 'idVendor}=="1038"' "$udevRulesPath"
check "no rule that runs a program reaches the rules directory" \
  bash -c '! grep -q "RUN" "$1"' _ "$udevRulesPath"

printf 'KERNEL=="hidraw*", RUN+="/bin/sh -c :"\n' > "$stubState/generated-rules"
rm -f "$udevRulesPath"
: > "$commandLog"
runningRuleStatus=0
runningRuleOutput="$(runInstall)" || runningRuleStatus=$?
check "a generated rule that runs a program is refused" \
  outputMatches "$runningRuleOutput" '\[warn\].*refusing to install them'
check "a rule that runs a program never reaches the privileged install" \
  logLacks "install -m 0644"
check "a rule that runs a program never lands where udev reads it" test ! -e "$udevRulesPath"
check "a refused rule makes the topic exit non-zero" test "$runningRuleStatus" -eq 1

printf 'KERNEL=="hidraw*", ATTRS{idVendor}=="1038", MODE="0666"\n' > "$stubState/generated-rules"

rm -f "$udevRulesPath" "$udevRulesPath.pre-dotfiles.bak" "$udevRulesPath.pre-dotfiles.bak.2"
runInstall > /dev/null || true

rm -f "$stubBin/headsetcontrol" "$stubBin/cmake"
provideCommand cmake
printf 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n' > "$stubState/cloned-commit"
: > "$commandLog"
unpinnedStatus=0
unpinnedOutput="$(runInstall)" || unpinnedStatus=$?
check "a tag that moved off the recorded commit warns" \
  outputMatches "$unpinnedOutput" '\[warn\].*headsetcontrol'
check "the warning names the commit it wanted" outputHas "$unpinnedOutput" "$pinnedCommit"
check "a moved tag is never built" logLacks "cmake --build"
check "a moved tag is never installed as root" logLacks "cmake --install"
check "a moved tag makes the topic exit non-zero" test "$unpinnedStatus" -eq 1

writeStub brew <<'STUB'
#!/usr/bin/env bash
printf 'brew %s\n' "$*" >> "$DOTFILES_TEST_LOG"
caskMarker="$DOTFILES_TEST_STATE/cask-${3:-}-installed"
case "${1:-} ${2:-}" in
  "list --cask") [[ -f "$caskMarker" ]] ;;
  "uninstall --cask") rm -f "$caskMarker" ;;
esac
STUB
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
loadedMarker="$DOTFILES_TEST_STATE/linearmouse-agent-loaded"
case "${1:-}" in
  print) [[ -f "$loadedMarker" ]] ;;
  bootout) rm -f "$loadedMarker" ;;
  bootstrap) touch "$loadedMarker" ;;
esac
STUB
writeStub defaults <<'STUB'
#!/usr/bin/env bash
printf 'defaults %s\n' "$*" >> "$DOTFILES_TEST_LOG"
hostScope=any
if [[ "${1:-}" == "-currentHost" ]]; then
  hostScope=currentHost
  shift
fi
domainDirectory="$DOTFILES_TEST_STATE/defaults/$hostScope/$2"
case "$1" in
  export) printf '%s\n' "$domainDirectory" > "$3" ;;
  write) mkdir -p "$domainDirectory" && printf '%s\n' "$4" > "$domainDirectory/$3" ;;
  *) exit 1 ;;
esac
STUB
writeStub PlistBuddy <<'STUB'
#!/usr/bin/env bash
valueKey="${3#Print :}"
IFS= read -r domainDirectory < "$4"
[[ -f "$domainDirectory/$valueKey" ]] && cat "$domainDirectory/$valueKey"
STUB
writeStub pgrep <<'STUB'
#!/usr/bin/env bash
[[ -f "$DOTFILES_TEST_STATE/alt-tab-running" ]]
STUB
writeStub osascript <<'STUB'
#!/usr/bin/env bash
printf 'osascript %s\n' "$*" >> "$DOTFILES_TEST_LOG"
if [[ "$*" == *com.lwouis.alt-tab-macos* ]]; then
  rm -f "$DOTFILES_TEST_STATE/alt-tab-running"
fi
STUB
writeStub open <<'STUB'
#!/usr/bin/env bash
printf 'open %s\n' "$*" >> "$DOTFILES_TEST_LOG"
touch "$DOTFILES_TEST_STATE/alt-tab-running"
STUB
provideCommand brew
provideCommand id
provideCommand launchctl
for keyboardCommand in defaults pgrep osascript open; do
  provideCommand "$keyboardCommand"
done
touch "$stubState/alt-tab-running"
writeDarwinDirectoryServiceStub "$stubBin"

darwinHomebrewPrefix="$sandbox/homebrew"
linearmouseConfigPath="$sandbox/.config/linearmouse/linearmouse.json"
linearmouseAgentPath="$sandbox/Library/LaunchAgents/dev.dotfiles.linearmouse.plist"
mkdir -p "$(dirname -- "$linearmouseConfigPath")" \
  "$(dirname -- "$linearmouseAgentPath")"
ln -s "$sandbox/.dotfiles/peripherals/linearmouse.json" "$linearmouseConfigPath"
printf 'rendered agent\n' > "$linearmouseAgentPath"
touch "$stubState/linearmouse-agent-loaded" "$stubState/cask-linearmouse-installed"

runDarwinInstall() {
  runInStubbedSandbox "$sandbox" DOTFILES_PLATFORM=darwin DOTFILES_PROFILE=work \
    DOTFILES_TEST_HOMEBREW_PREFIX="$darwinHomebrewPrefix" \
    DOTFILES_TEST_PLISTBUDDY="$stubState/available/PlistBuddy" \
    NO_COLOR=1 bash "$topicDir/install.sh"
}

printf '\nperipherals topic on darwin\n'

: > "$commandLog"
darwinFirstStatus=0
darwinFirstOutput="$(runDarwinInstall)" || darwinFirstStatus=$?
check "darwin install exits clean" test "$darwinFirstStatus" -eq 0
check "darwin boots out the retired LinearMouse agent" \
  logHas "launchctl bootout gui/501 $linearmouseAgentPath"
check "darwin deletes the retired LinearMouse agent" test ! -e "$linearmouseAgentPath"
check "darwin removes the retired LinearMouse config link" \
  bash -c '[[ ! -e "$1" && ! -L "$1" ]]' _ "$linearmouseConfigPath"
check "darwin uninstalls the retired LinearMouse cask" logHas 'brew uninstall --cask linearmouse'
check "darwin skips Solaar" outputLacks "$darwinFirstOutput" 'Solaar'
check "darwin skips ratbagd" outputLacks "$darwinFirstOutput" 'ratbagd'
check "darwin skips Piper" outputLacks "$darwinFirstOutput" 'Piper'
check "darwin skips headsetcontrol" outputLacks "$darwinFirstOutput" 'headsetcontrol'
check "darwin never installs Linux packages" logLacks 'apt-get '
check "darwin never touches udev" logLacks 'udevadm '
check "darwin never creates a printer queue" logLacks 'lpadmin '
check "darwin swaps Control and Command on the Adv360 Pro only" \
  cmp -s "$stubState/defaults/currentHost/-g/com.apple.keyboard.modifiermapping.7504-24926-0" \
  "$topicDir/keyboard/kinesis-modifier-mapping.plist"
for altTabShortcutKey in holdShortcut; do
  check "darwin writes the captured AltTab $altTabShortcutKey" \
    cmp -s "$stubState/defaults/any/com.lwouis.alt-tab-macos/$altTabShortcutKey" \
    "$topicDir/keyboard/alt-tab/$altTabShortcutKey.plist"
done
altTabQuitBeforeWrites() {
  local quitLine
  local firstWriteLine
  quitLine="$(grep -nF -m1 -- 'com.lwouis.alt-tab-macos" to quit' "$commandLog" | cut -d: -f1)"
  firstWriteLine="$(grep -nF -m1 -- 'defaults write com.lwouis.alt-tab-macos' "$commandLog" | cut -d: -f1)"
  [[ -n "$quitLine" && -n "$firstWriteLine" ]] && ((quitLine < firstWriteLine))
}
check "darwin quits a running AltTab before writing its shortcuts" altTabQuitBeforeWrites
check "darwin relaunches AltTab after writing its shortcuts" logHas 'open -b com.lwouis.alt-tab-macos'

: > "$commandLog"
darwinSecondStatus=0
darwinSecondOutput="$(runDarwinInstall)" || darwinSecondStatus=$?
check "darwin second run exits clean" test "$darwinSecondStatus" -eq 0
check "darwin second run reports no changes" reportsNoChanges "$darwinSecondOutput"
check "darwin second run does not reinstall the cask" logLacks 'brew install --cask'
check "darwin second run uninstalls nothing" logLacks 'brew uninstall'
check "darwin second run does not boot out an agent" logLacks 'launchctl bootout'
check "darwin second run writes no defaults" logLacks ' write '
check "darwin second run leaves AltTab running" logLacks 'osascript '

printf 'local settings\n' > "$linearmouseConfigPath"
: > "$commandLog"
runDarwinInstall >/dev/null
check "darwin leaves a LinearMouse config it did not link" \
  grep -qx 'local settings' "$linearmouseConfigPath"

reportTopicResults "peripherals"
