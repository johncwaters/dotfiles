#!/usr/bin/env bash

set -euo pipefail

topicDir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repoRoot="$(cd -- "$topicDir/.." && pwd)"
export DOTFILES_PLATFORM=linux
# shellcheck source=../test/harness.sh
source "$repoRoot/test/harness.sh"

startStubbedSandbox "tailscale"

sandboxTemp="$sandbox/tmp"

mkdir -p "$sandboxTemp"

coreUtilities=(
  bash sh env cat sed awk grep tail head cut tr find sort wc mktemp rm mkdir cp mv ln
  readlink basename dirname chmod cmp id stat touch true false printf test
)
linkCoreUtilities "${coreUtilities[@]}"

writeAptStubThatInstallsMappedCommands

writeContainedSudoStub

writeStub curl <<'STUB'
#!/usr/bin/env bash
printf 'curl %s\n' "$*" >> "$DOTFILES_TEST_LOG"
requestedUrl=""
outputPath=""
while (($# > 0)); do
  if [[ "$1" == "-o" ]]; then
    outputPath="$2"
    shift 2
    continue
  fi
  if [[ "$1" == http* ]]; then
    requestedUrl="$1"
  fi
  shift
done
if [[ "$requestedUrl" != *tailscale.com/install.sh ]]; then
  exit 1
fi
if [[ -z "$outputPath" ]]; then
  printf 'curl stub: refusing to write an installer to stdout\n' >> "$DOTFILES_TEST_LOG"
  exit 1
fi
printf 'cp "$DOTFILES_TEST_STATE/available/tailscale" "$DOTFILES_TEST_STUB_BIN/tailscale"\n' \
  > "$outputPath"
STUB

writeStub tailscale <<'STUB'
#!/usr/bin/env bash
printf 'tailscale-path %s\n' "$0" >> "$DOTFILES_TEST_LOG"
printf 'tailscale %s\n' "$*" >> "$DOTFILES_TEST_LOG"
[[ ! -f "$DOTFILES_TEST_STATE/tailscale-logged-out" ]]
exit $?
STUB

for presentFromTheStart in apt-get sudo curl; do
  provideCommand "$presentFromTheStart"
done

runInstall() {
  runInStubbedSandbox "$sandbox" \
    TMPDIR="$sandboxTemp" \
    DOTFILES_PROFILE=personal \
    NO_COLOR=1 \
    bash "$topicDir/install.sh"
}


printf '\ntailscale topic\n'

installStatus=0
firstRunOutput="$(runInstall)" || installStatus=$?
check "install exits clean" test "$installStatus" -eq 0
check "install says what it did" test -n "$firstRunOutput"
check "the standalone installer leaves the bootstrap topic header alone" \
  bash -c '! grep -qx "  Tailscale" <<< "$1"' _ "$firstRunOutput"
check "the installer is downloaded to a file" logHas "curl -fsSL https://tailscale.com/install.sh -o"
check "the installer is never piped into a shell" logLacks "refusing to write an installer to stdout"
check "the downloaded installer runs through the gated sudo" \
  grep -qE -- '^sudo -n [^ ]*/sh ' "$commandLog"
check "the dpkg lock is taken before the vendor installer" logHas "apt-get -o DPkg::Lock::Timeout=180 check"
check "tailscale lands on PATH" test -x "$stubBin/tailscale"
check "auth is checked once it is installed" logHas "tailscale status"
check "no command was refused for reaching outside the stubs" logLacks "sudo refused"

: > "$commandLog"
secondRunStatus=0
secondRunOutput="$(runInstall)" || secondRunStatus=$?
check "the second run exits clean" test "$secondRunStatus" -eq 0
check "second run reports no changes" reportsNoChanges "$secondRunOutput"
check "second run downloads no installer" logLacks "curl"

touch "$stubState/tailscale-logged-out"
loggedOutStatus=0
loggedOutOutput="$(runInstall)" || loggedOutStatus=$?
check "a machine that never authenticated warns" \
  outputMatches "$loggedOutOutput" '\[warn\].*Tailscale auth'
check "the warning says how to authenticate" outputHas "$loggedOutOutput" 'tailscale up'
check "a warning makes the topic exit non-zero" test "$loggedOutStatus" -eq 1

rm -f "$stubState/tailscale-logged-out"
withdrawCommand tailscale
darwinApplicationsDirectory="$sandbox/Applications"
darwinTailscaleCli="$darwinApplicationsDirectory/Tailscale.app/Contents/MacOS/Tailscale"
writeStub brew <<'STUB'
#!/usr/bin/env bash
printf 'brew %s\n' "$*" >> "$DOTFILES_TEST_LOG"
mkdir -p "$DOTFILES_TEST_APPLICATIONS_DIRECTORY/Tailscale.app/Contents/MacOS"
cp "$DOTFILES_TEST_STATE/available/tailscale" \
  "$DOTFILES_TEST_APPLICATIONS_DIRECTORY/Tailscale.app/Contents/MacOS/Tailscale"
STUB
provideCommand brew
writeDarwinDirectoryServiceStub "$stubBin" "$realHomeOutsideTheSandbox"
: > "$commandLog"
darwinStatus=0
darwinOutput="$(runInStubbedSandbox "$sandbox" TMPDIR="$sandboxTemp" DOTFILES_PLATFORM=darwin \
  DOTFILES_TEST_APPLICATIONS_DIRECTORY="$darwinApplicationsDirectory" \
  DOTFILES_PROFILE=work NO_COLOR=1 bash "$topicDir/install.sh")" || darwinStatus=$?
check "darwin installs and checks Tailscale cleanly" test "$darwinStatus" -eq 0
check "darwin installs the Tailscale GUI cask" logHas 'brew install --cask tailscale-app'
check "darwin does not run Homebrew through sudo" logLacks 'sudo '
check "darwin skips the vendor installer" logLacks 'tailscale.com/install.sh'
check "darwin checks auth through the bundled CLI" logHas "tailscale-path $darwinTailscaleCli"
check "darwin reports no missing CLI" outputLacks "$darwinOutput" 'not on PATH'

: > "$commandLog"
darwinRerunOutput="$(runInStubbedSandbox "$sandbox" TMPDIR="$sandboxTemp" DOTFILES_PLATFORM=darwin \
  DOTFILES_TEST_APPLICATIONS_DIRECTORY="$darwinApplicationsDirectory" \
  DOTFILES_PROFILE=work NO_COLOR=1 bash "$topicDir/install.sh")"
check "a darwin rerun reports no changes" reportsNoChanges "$darwinRerunOutput"
check "a darwin rerun does not invoke Homebrew" logLacks 'brew '

touch "$stubState/tailscale-logged-out"
darwinLoggedOutStatus=0
darwinLoggedOutOutput="$(runInStubbedSandbox "$sandbox" TMPDIR="$sandboxTemp" DOTFILES_PLATFORM=darwin \
  DOTFILES_TEST_APPLICATIONS_DIRECTORY="$darwinApplicationsDirectory" \
  DOTFILES_PROFILE=work NO_COLOR=1 bash "$topicDir/install.sh")" || darwinLoggedOutStatus=$?
check "darwin warns when the app is signed out" test "$darwinLoggedOutStatus" -eq 1
check "darwin tells the carbon unit to sign in through the app" \
  outputHas "$darwinLoggedOutOutput" 'open the Tailscale app and sign in'
check "darwin does not suggest the Linux auth command" outputLacks "$darwinLoggedOutOutput" 'tailscale up'

reportTopicResults "tailscale"
