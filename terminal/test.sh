#!/usr/bin/env bash

set -euo pipefail

topicDir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repoRoot="$(cd -- "$topicDir/.." && pwd)"
# shellcheck source=../test/harness.sh
source "$repoRoot/test/harness.sh"

startStubbedSandbox "terminal"

temporaryDirectory="$sandbox/tmp"
aptSourcesDirectory="$sandbox/etc/apt/sources.list.d"
aptPreferencesDirectory="$sandbox/etc/apt/preferences.d"
ghosttyPinPath="$aptPreferencesDirectory/ghostty-ppa"
systemActionsPath="$sandbox/usr/share/cosmic/system_actions"
userSystemActionsPath="$sandbox/.config/cosmic/com.system76.CosmicSettings.Shortcuts/v1/system_actions"
ghosttyConfigPath="$sandbox/.config/ghostty/config"
mkdir -p "$temporaryDirectory" "$aptSourcesDirectory" "$aptPreferencesDirectory" \
  "$(dirname -- "$systemActionsPath")" "$(dirname -- "$userSystemActionsPath")"

linkCoreUtilities awk basename bash cat chmod cmp cp dirname env grep head ln mkdir mktemp \
  mv readlink rm sed tail true

runInstall() {
  runInStubbedSandbox "$sandbox" \
    TMPDIR="$temporaryDirectory" \
    DOTFILES_PROFILE=personal \
    DOTFILES_APT_SOURCES_PATH="$aptSourcesDirectory" \
    DOTFILES_APT_PREFERENCES_PATH="$aptPreferencesDirectory" \
    DOTFILES_COSMIC_SYSTEM_ACTIONS="$systemActionsPath" \
    NO_COLOR=1 \
    bash "$topicDir/install.sh"
}

writeSystemActions() {
  local webBrowserCommand="$1"
  cat > "$systemActionsPath" <<SYSTEM_ACTIONS
{
    /// Opens the application library
    AppLibrary: "cosmic-app-library",
    /// Opens the system default terminal
    Terminal: "cosmic-term",
    /// Opens the system default web browser
    WebBrowser: "$webBrowserCommand",
}
SYSTEM_ACTIONS
}

writeAptStubThatInstallsMappedCommands
provideCommand apt-get
mapPackageToCommands ghostty "ghostty"

# The real add-apt-repository writes the source file, and that file is what makes the next converge a no-op.
writeStub add-apt-repository <<'STUB'
#!/usr/bin/env bash
printf 'add-apt-repository %s\n' "$*" >> "$DOTFILES_TEST_LOG"
for argument in "$@"; do
  case "$argument" in
    ppa:*)
      ppaName="${argument#ppa:}"
      mkdir -p "$DOTFILES_APT_SOURCES_PATH"
      printf 'Types: deb\nURIs: https://ppa.launchpadcontent.net/%s/ubuntu/\nSuites: noble\nComponents: main\n' \
        "$ppaName" > "$DOTFILES_APT_SOURCES_PATH/${ppaName//\//-}-noble.sources"
      ;;
  esac
done
STUB
provideCommand add-apt-repository

writeStub ghostty <<'STUB'
#!/usr/bin/env bash
printf 'ghostty %s\n' "$*" >> "$DOTFILES_TEST_LOG"
STUB

writeStub install <<'STUB'
#!/usr/bin/env bash
printf 'install %s\n' "$*" >> "$DOTFILES_TEST_LOG"
destinationPath="${*: -1}"
sourcePath="${*: -2:1}"
mkdir -p "$(dirname -- "$destinationPath")"
cp -f -- "$sourcePath" "$destinationPath"
STUB
provideCommand install

expectedPinPath="$temporaryDirectory/expected-ghostty-pin"
cat > "$expectedPinPath" <<'PIN'
Package: *
Pin: release o=LP-PPA-mkasberg-ghostty-ubuntu
Pin-Priority: 1

Package: ghostty
Pin: release o=LP-PPA-mkasberg-ghostty-ubuntu
Pin-Priority: 500
PIN

writeContainedSudoStub

writeSystemActions "xdg-open http://"
printf 'a map COSMIC shipped before dotfiles arrived\n' > "$userSystemActionsPath"

printf '\nterminal topic\n'

firstRunStatus=0
runInstall > /dev/null || firstRunStatus=$?
check "first install exits clean" test "$firstRunStatus" -eq 0
check "the PPA is added once" \
  test "$(countLogLines '^add-apt-repository .*ppa:mkasberg/ghostty-ubuntu')" -eq 1
check "the PPA is added before the package index is read" \
  bash -c 'test "$(grep -n "^add-apt-repository" "$1" | head -n 1 | cut -d: -f1)" -lt "$(grep -n "^apt-get .* update" "$1" | head -n 1 | cut -d: -f1)"' \
  _ "$commandLog"
check "Ghostty is installed through apt-get" \
  grep -qF 'apt-get -o DPkg::Lock::Timeout=180 install -y ghostty' "$commandLog"
check "the PPA is pinned so only ghostty comes from it" cmp -s "$expectedPinPath" "$ghosttyPinPath"

check "the Ghostty config is a symlink" test -L "$ghosttyConfigPath"
check "the Ghostty config links through the alias" \
  bash -c 'case "$(readlink -- "$1")" in "$2"/*) exit 0 ;; esac; exit 1' _ "$ghosttyConfigPath" "$sandbox/.dotfiles"

check "the user action map points Terminal at ghostty" \
  grep -qxF '    Terminal: "ghostty",' "$userSystemActionsPath"
check "the user action map keeps the actions it does not change" \
  bash -c 'grep -qxF "    AppLibrary: \"cosmic-app-library\"," "$1" && grep -qxF "    WebBrowser: \"xdg-open http://\"," "$1"' \
  _ "$userSystemActionsPath"
check "the user action map carries every line of the system map" \
  test "$(wc -l < "$userSystemActionsPath")" -eq "$(wc -l < "$systemActionsPath")"
check "the map COSMIC shipped is moved aside" \
  grep -qx 'a map COSMIC shipped before dotfiles arrived' "$userSystemActionsPath.pre-dotfiles.bak"

: > "$commandLog"
secondRunStatus=0
secondRunOutput="$(runInstall)" || secondRunStatus=$?
check "second install exits clean" test "$secondRunStatus" -eq 0
check "second install reports no changes" reportsNoChanges "$secondRunOutput"
check "second install does not re-add the PPA" logLacks "add-apt-repository"
check "second install does not invoke apt-get" logLacks "apt-get"
check "second install does not rewrite the pin" logLacks "install -m 0644"

rm -f "$aptSourcesDirectory"/*.sources
printf 'deb https://ppa.launchpadcontent.net/mkasberg/ghostty-ubuntu/ubuntu noble main\n' \
  > "$aptSourcesDirectory/ghostty.list"
withdrawCommand ghostty
: > "$commandLog"
listedPpaOutput="$(runInstall)" || true
check "a PPA listed the classic way is not added again" logLacks "add-apt-repository"
check "a listed PPA is reported as present" \
  outputMatches "$listedPpaOutput" '\[ -- \] Ghostty PPA +already listed'
check "Ghostty is still installed when the PPA was already listed" \
  grep -qF 'apt-get -o DPkg::Lock::Timeout=180 install -y ghostty' "$commandLog"

rm -f "$aptSourcesDirectory"/*
printf '# deb https://ppa.launchpadcontent.net/mkasberg/ghostty-ubuntu/ubuntu noble main\n' \
  > "$aptSourcesDirectory/ghostty.list"
printf 'deb https://ppa.launchpadcontent.net/mkasberg/ghostty-ubuntu/ubuntu noble main\n' \
  > "$aptSourcesDirectory/ghostty.list.save"
: > "$commandLog"
runInstall > /dev/null || true
check "a commented out entry and a .list.save do not count as listed" \
  test "$(countLogLines '^add-apt-repository .*ppa:mkasberg/ghostty-ubuntu')" -eq 1

withdrawCommand ghostty
withdrawCommand sudo
cp -p "$userSystemActionsPath" "$temporaryDirectory/map-before-missing-ghostty"
writeSystemActions "a browser only the system map names"
: > "$commandLog"
missingGhosttyOutput="$(runInstall)" || true
check "no ghostty leaves the user action map alone" \
  cmp -s "$temporaryDirectory/map-before-missing-ghostty" "$userSystemActionsPath"
check "a missing ghostty is reported instead of pointing Super+T at nothing" \
  outputMatches "$missingGhosttyOutput" '\[warn\] COSMIC default terminal +ghostty is not installed'
provideCommand sudo
provideCommand ghostty

writeSystemActions "cosmic-web"
: > "$commandLog"
changedMapOutput="$(runInstall)" || true
check "a changed system map is derived again" \
  grep -qxF '    WebBrowser: "cosmic-web",' "$userSystemActionsPath"
check "the re-derived map still points Terminal at ghostty" \
  grep -qxF '    Terminal: "ghostty",' "$userSystemActionsPath"
check "re-deriving the map is reported as a change" \
  outputMatches "$changedMapOutput" '\[ ok \] COSMIC default terminal +set to ghostty'

outsideTargetPath="$sandbox/outside-cosmic-target"
printf 'a file COSMIC never wrote\n' > "$outsideTargetPath"
rm -f "$userSystemActionsPath"
ln -s "$outsideTargetPath" "$userSystemActionsPath"
: > "$commandLog"
symlinkRunStatus=0
symlinkRunOutput="$(runInstall)" || symlinkRunStatus=$?
check "a symlinked action map exits clean" test "$symlinkRunStatus" -eq 0
check "a symlinked action map is not written through" \
  grep -qx 'a file COSMIC never wrote' "$outsideTargetPath"
check "the moved aside symlink is named in the report" \
  outputHas "$symlinkRunOutput" 'COSMIC default terminal backup'
check "a fresh action map took the name" \
  bash -c 'test -f "$1" && test ! -L "$1"' _ "$userSystemActionsPath"
check "the fresh action map points Terminal at ghostty" \
  grep -qxF '    Terminal: "ghostty",' "$userSystemActionsPath"

rm -f "$systemActionsPath"
: > "$commandLog"
noSystemMapStatus=0
noSystemMapOutput="$(runInstall)" || noSystemMapStatus=$?
check "a missing system map warns" \
  outputMatches "$noSystemMapOutput" '\[warn\] COSMIC default terminal +no system action map'
check "a missing system map makes the topic exit non-zero" test "$noSystemMapStatus" -eq 1

check "no command was refused for reaching outside the stubs" logLacks "sudo refused"

reportTopicResults "terminal"
