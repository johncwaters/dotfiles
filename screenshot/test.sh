#!/usr/bin/env bash

set -euo pipefail

topicDir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repoRoot="$(cd -- "$topicDir/.." && pwd)"
# shellcheck source=../test/harness.sh
source "$repoRoot/test/harness.sh"

startStubbedSandbox "screenshot"

temporaryDirectory="$sandbox/tmp"
mkdir -p "$temporaryDirectory"

linkCoreUtilities awk basename bash cat chmod cp dirname env grep head ln mkdir mktemp mv \
  readlink rm sed true

runInstall() {
  runInStubbedSandbox "$sandbox" \
    TMPDIR="$temporaryDirectory" \
    DOTFILES_PROFILE=personal \
    NO_COLOR=1 \
    bash "$topicDir/install.sh"
}

countShortcutLines() {
  grep -cF -- "$1" "$customShortcutsPath" || true
}

reportsOnlyPresentState() {
  ! grep -qvE '^[[:space:]]*($|Screenshot|\[ -- \] .+)$' <<< "$1"
}

writeAptStubThatInstallsMappedCommands
provideCommand apt-get
mapPackageToCommands flameshot "flameshot"
mapPackageToCommands wl-clipboard "wl-copy"

writeContainedSudoStub

writeStub flameshot <<'STUB'
#!/usr/bin/env bash
printf 'flameshot %s\n' "$*" >> "$DOTFILES_TEST_LOG"
STUB

writeStub wl-copy <<'STUB'
#!/usr/bin/env bash
printf 'wl-copy %s\n' "$*" >> "$DOTFILES_TEST_LOG"
STUB

foreignWrapperPath="$sandbox/.local/bin/flameshot-save-path"
foreignDesktopPath="$sandbox/.config/autostart/Flameshot.desktop"
customShortcutsPath="$sandbox/.config/cosmic/com.system76.CosmicSettings.Shortcuts/v1/custom"
mkdir -p "$(dirname -- "$foreignWrapperPath")" "$(dirname -- "$foreignDesktopPath")" \
  "$(dirname -- "$customShortcutsPath")"
printf 'foreign wrapper\n' > "$foreignWrapperPath"
printf 'foreign desktop\n' > "$foreignDesktopPath"
printf '{\n    (modifiers: [Alt], key: "x"): Spawn("keep this shortcut"),\n}\n' > "$customShortcutsPath"
chmod 600 "$customShortcutsPath"

printf '\nscreenshot topic\n'

firstRunStatus=0
firstRunOutput="$(runInstall)" || firstRunStatus=$?
check "first install exits clean" test "$firstRunStatus" -eq 0
check "the standalone installer leaves the bootstrap topic header alone" \
  bash -c '! grep -qx "  Screenshot" <<< "$1"' _ "$firstRunOutput"
check "Flameshot is installed through apt-get" \
  grep -qF 'apt-get -o DPkg::Lock::Timeout=180 install -y flameshot' "$commandLog"
check "wl-clipboard is installed through apt-get" \
  grep -qF 'apt-get -o DPkg::Lock::Timeout=180 install -y wl-clipboard' "$commandLog"

for linkedPath in "$foreignWrapperPath" "$foreignDesktopPath"; do
  if [[ ! -L "$linkedPath" ]]; then
    fail "$(basename -- "$linkedPath") is a symlink"
    continue
  fi
  linkedTarget="$(readlink -- "$linkedPath")"
  case "$linkedTarget" in
    "$sandbox/.dotfiles"/*) pass "$(basename -- "$linkedPath") links through the alias" ;;
    *) fail "$(basename -- "$linkedPath") links through the alias" ;;
  esac
done

check "the wrapper backup keeps its foreign content" \
  grep -qx 'foreign wrapper' "$foreignWrapperPath.pre-dotfiles.bak"
check "the desktop backup keeps its foreign content" \
  grep -qx 'foreign desktop' "$foreignDesktopPath.pre-dotfiles.bak"
check "the existing COSMIC shortcut remains" grep -qF 'keep this shortcut' "$customShortcutsPath"
check "the existing COSMIC shortcut mode remains owner only" \
  test "$(stat -c '%a' "$customShortcutsPath")" = "600"
check "the clipboard shortcut is added once" \
  test "$(countShortcutLines '(modifiers: [], key: "Print")')" -eq 1
check "the save-path shortcut is added once" \
  test "$(countShortcutLines '(modifiers: [Ctrl], key: "g")')" -eq 1

: > "$commandLog"
secondRunStatus=0
secondRunOutput="$(runInstall)" || secondRunStatus=$?
check "second install exits clean" test "$secondRunStatus" -eq 0
check "second install reports no changes" reportsNoChanges "$secondRunOutput"
check "second install emits only present markers" reportsOnlyPresentState "$secondRunOutput"
check "the clipboard shortcut remains singular" \
  test "$(countShortcutLines '(modifiers: [], key: "Print")')" -eq 1
check "the save-path shortcut remains singular" \
  test "$(countShortcutLines '(modifiers: [Ctrl], key: "g")')" -eq 1
check "second install does not invoke apt-get" test ! -s "$commandLog"

outsideTargetPath="$sandbox/outside-cosmic-target"
printf 'a file COSMIC never wrote\n' > "$outsideTargetPath"
rm -f "$customShortcutsPath"
ln -s "$outsideTargetPath" "$customShortcutsPath"
: > "$commandLog"
symlinkRunStatus=0
symlinkRunOutput="$(runInstall)" || symlinkRunStatus=$?
check "a symlinked shortcuts file exits clean" test "$symlinkRunStatus" -eq 0
check "a symlinked shortcuts file is not written through" \
  grep -qx 'a file COSMIC never wrote' "$outsideTargetPath"
check "the symlink itself was moved aside" \
  test -L "$customShortcutsPath.pre-dotfiles.bak"
check "the moved aside symlink is named in the report" \
  grep -q 'COSMIC screenshot shortcuts backup' <<< "$symlinkRunOutput"
check "a fresh shortcuts file took the name" test -f "$customShortcutsPath"
check "the fresh file is not a symlink" test ! -L "$customShortcutsPath"
check "the fresh file holds the clipboard shortcut" \
  test "$(countShortcutLines '(modifiers: [], key: "Print")')" -eq 1
check "the fresh file holds the save-path shortcut" \
  test "$(countShortcutLines '(modifiers: [Ctrl], key: "g")')" -eq 1

printf '{\n    (modifiers: [Alt], key: "x"): Spawn("a field with no trailing comma")\n}\n' \
  > "$customShortcutsPath"
: > "$commandLog"
uncommaRunStatus=0
runInstall > /dev/null || uncommaRunStatus=$?
check "merging into a file with no trailing comma exits clean" test "$uncommaRunStatus" -eq 0
check "the field before the insert is comma terminated" \
  grep -qF 'Spawn("a field with no trailing comma"),' "$customShortcutsPath"
check "no line in the merged map is left without its comma" \
  bash -c '! grep -qE "^[[:space:]]*\(modifiers.*[^,[:space:]][[:space:]]*$" "$1"' _ "$customShortcutsPath"
check "the shortcut that was already there survives the merge" \
  grep -qF 'a field with no trailing comma' "$customShortcutsPath"
check "the clipboard shortcut is added to an uncommaed file once" \
  test "$(countShortcutLines '(modifiers: [], key: "Print")')" -eq 1

: > "$commandLog"
uncommaRerunOutput="$(runInstall)" || true
check "a merged uncommaed file needs no second merge" reportsNoChanges "$uncommaRerunOutput"

writeStub awk <<'STUB'
#!/usr/bin/env bash
printf 'awk refused to merge\n' >&2
exit 2
STUB
provideCommand awk
printf '{\n    (modifiers: [Alt], key: "x"): Spawn("keep this shortcut"),\n}\n' \
  > "$customShortcutsPath"
: > "$commandLog"
noAwkStatus=0
noAwkOutput="$(runInstall)" || noAwkStatus=$?
withdrawCommand awk
check "a merge whose awk fails warns" \
  outputMatches "$noAwkOutput" '\[warn\].*merge failed, custom file left alone'
check "a merge whose awk fails makes the topic exit non-zero" test "$noAwkStatus" -eq 1
check "a merge whose awk fails leaves the custom file alone" \
  grep -qxF '    (modifiers: [Alt], key: "x"): Spawn("keep this shortcut"),' "$customShortcutsPath"
check "a merge whose awk fails writes no empty custom file" test -s "$customShortcutsPath"

check "no command was refused for reaching outside the stubs" logLacks "sudo refused"

reportTopicResults "screenshot"
