#!/usr/bin/env bash

set -euo pipefail

topicDir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repoRoot="$(cd -- "$topicDir/.." && pwd)"
export DOTFILES_PLATFORM=linux
source "$repoRoot/test/harness.sh"

startStubbedSandbox "coder"
linkCoreUtilities bash env cat sed awk grep tail head cut tr mktemp rm mkdir cp mv ln readlink dirname chmod

printf 'v2.37.1+22f4284\n' > "$stubState/server-version"
printf 'x86_64\n' > "$stubState/architecture"

writeStub uname <<'STUB'
#!/usr/bin/env bash
[[ "$1" == -m ]] || exit 1
cat "$DOTFILES_TEST_STATE/architecture"
STUB

writeStub curl <<'STUB'
#!/usr/bin/env bash
printf 'curl %s\n' "$*" >> "$DOTFILES_TEST_LOG"
requestedUrl=""
outputPath=""
while (($# > 0)); do
  if [[ "$1" == -o ]]; then
    outputPath="$2"
    shift 2
    continue
  fi
  if [[ "$1" == https://* ]]; then
    requestedUrl="$1"
  fi
  shift
done
case "$requestedUrl" in
  https://coder.dev.posthog.dev/api/v2/buildinfo)
    [[ ! -f "$DOTFILES_TEST_STATE/server-unreachable" ]] || exit 7
    if [[ -f "$DOTFILES_TEST_STATE/invalid-buildinfo" ]]; then
      printf '{"version":"unknown"}\n'
      exit 0
    fi
    printf '{"version": "%s", "external_url": "https://example.invalid/v9.9.9"}\n' \
      "$(cat "$DOTFILES_TEST_STATE/server-version")"
    exit 0
    ;;
  https://coder.dev.posthog.dev/bin/coder-*)
    [[ -n "$outputPath" ]] || exit 1
    if [[ -f "$DOTFILES_TEST_STATE/download-failed" ]]; then
      printf 'partial download\n' > "$outputPath"
      exit 22
    fi
    binaryVersion="$(cat "$DOTFILES_TEST_STATE/server-version")"
    if [[ -f "$DOTFILES_TEST_STATE/wrong-binary-version" ]]; then
      binaryVersion=v0.0.1
    fi
    printf '#!/usr/bin/env bash\ninstalledVersion=%q\n' "$binaryVersion" > "$outputPath"
    cat >> "$outputPath" <<'BINARY'
printf 'coder %s\n' "$*" >> "$DOTFILES_TEST_LOG"
case "$1" in
  version) printf 'Coder %s\n' "$installedVersion" ;;
  whoami) [[ ! -f "$DOTFILES_TEST_STATE/coder-logged-out" ]] ;;
  *) exit 1 ;;
esac
BINARY
    exit 0
    ;;
esac
exit 1
STUB

provideCommand curl
provideCommand uname

runInstall() {
  runInStubbedSandbox "$sandbox" DOTFILES_PROFILE=work NO_COLOR=1 \
    DOTFILES_PLATFORM="${1:-linux}" bash "$topicDir/install.sh"
}

printf '\ncoder topic\n'

installStatus=0
firstRunOutput="$(runInstall)" || installStatus=$?
check "fresh install exits clean" test "$installStatus" -eq 0
check "fresh install downloads the Linux amd64 CLI from the deployment" \
  logHas 'https://coder.dev.posthog.dev/bin/coder-linux-amd64 -o'
check "fresh install leaves an executable CLI in the sandbox home" test -x "$sandbox/.local/bin/coder"
check "fresh install verifies and reports the server release" outputHas "$firstRunOutput" 'v2.37.1 installed'
check "buildinfo uses short connection and total timeouts" \
  logHas '--connect-timeout 5 --max-time 10 https://coder.dev.posthog.dev/api/v2/buildinfo'
check "local bin persists on PATH" grep -qF '.local/bin' "$sandbox/.bashrc"
check "logged-in auth is reported" outputHas "$firstRunOutput" 'logged in'
check "logged-in auth needs no login hint" outputLacks "$firstRunOutput" 'run coder login'
check "auth is checked once" test "$(countLogLines '^coder whoami$')" -eq 1

: > "$commandLog"
printf 'v2.37.1+different-sha\n' > "$stubState/server-version"
secondRunOutput="$(runInstall)"
check "matching version rerun reports no changes" reportsNoChanges "$secondRunOutput"
check "matching release ignores build SHA and downloads no binary" logLacks '/bin/coder-'
check "matching version rerun checks auth" logHas 'coder whoami'

: > "$commandLog"
printf 'v2.38.0+new-sha\n' > "$stubState/server-version"
mismatchOutput="$(runInstall)"
check "a version mismatch downloads the matching CLI" logHas '/bin/coder-linux-amd64'
check "a version mismatch reports the replacement" outputHas "$mismatchOutput" 'v2.38.0 installed'
installedVersionOutput="$(runInStubbedSandbox "$sandbox" "$sandbox/.local/bin/coder" version)"
check "a version mismatch replaces the executable" outputHas "$installedVersionOutput" 'v2.38.0'

: > "$commandLog"
touch "$stubState/server-unreachable"
unreachableStatus=0
unreachableOutput="$(runInstall)" || unreachableStatus=$?
check "unreachable server warns with non-zero topic status" test "$unreachableStatus" -eq 1
check "unreachable server gives the Tailscale hint" \
  outputHas "$unreachableOutput" 'coder.dev.posthog.dev unreachable, connect to Tailscale and rerun'
check "unreachable server downloads no binary" logLacks '/bin/coder-'
check "unreachable server finishes before auth" logLacks 'coder whoami'
rm -f "$stubState/server-unreachable"

touch "$stubState/coder-logged-out"
loggedOutStatus=0
loggedOutOutput="$(runInstall)" || loggedOutStatus=$?
check "logged-out auth warns with non-zero topic status" test "$loggedOutStatus" -eq 1
check "logged-out auth gives the deployment login hint" \
  outputHas "$loggedOutOutput" 'run coder login https://coder.dev.posthog.dev'
rm -f "$stubState/coder-logged-out"

for platformArchitecture in darwin:arm64 darwin:x86_64 linux:aarch64; do
  testPlatform="${platformArchitecture%%:*}"
  printf '%s\n' "${platformArchitecture#*:}" > "$stubState/architecture"
  expectedArchitecture=arm64
  if [[ "$platformArchitecture" == darwin:x86_64 ]]; then
    expectedArchitecture=amd64
  fi
  rm -f "$sandbox/.local/bin/coder"
  : > "$commandLog"
  platformOutput="$(runInstall "$testPlatform")"
  check "$platformArchitecture downloads the matching platform binary" \
    logHas "/bin/coder-$testPlatform-$expectedArchitecture -o"
  check "$platformArchitecture installs an executable" test -x "$sandbox/.local/bin/coder"
done

printf 'v2.39.0\n' > "$stubState/server-version"
for failureMarker in download-failed wrong-binary-version invalid-buildinfo; do
  touch "$stubState/$failureMarker"
  failureStatus=0
  failureOutput="$(runInstall)" || failureStatus=$?
  check "$failureMarker produces a warning status" test "$failureStatus" -eq 1
  check "$failureMarker reports a CLI warning" outputMatches "$failureOutput" '\[warn\].*Coder CLI'
  preservedVersionOutput="$(runInStubbedSandbox "$sandbox" "$sandbox/.local/bin/coder" version)"
  check "$failureMarker preserves the previous executable" outputHas "$preservedVersionOutput" 'v2.38.0'
  stagedDownloads=("$sandbox/.local/bin"/.coder.*)
  check "$failureMarker leaves no staged downloads" test ! -e "${stagedDownloads[0]}"
  rm -f "$stubState/$failureMarker"
done

writeStub coder <<'STUB'
#!/usr/bin/env bash
printf 'shadowing coder %s\n' "$*" >> "$DOTFILES_TEST_LOG"
case "$1" in
  version) printf 'Coder %s\n' "$(cat "$DOTFILES_TEST_STATE/shadow-version")" ;;
  *) exit 1 ;;
esac
STUB

runInstallWithShadowingCoder() {
  runInStubbedSandbox "$sandbox" PATH="$stubBin:$sandbox/.local/bin:$coreBin" \
    DOTFILES_PROFILE=work NO_COLOR=1 DOTFILES_PLATFORM=linux bash "$topicDir/install.sh"
}

provideCommand coder
printf 'v2.30.0\n' > "$stubState/shadow-version"
printf 'x86_64\n' > "$stubState/architecture"

: > "$commandLog"
shadowedInstallStatus=0
shadowedInstallOutput="$(runInstallWithShadowingCoder)" || shadowedInstallStatus=$?
check "a stale owned CLI behind a shadowing CLI is replaced" logHas '/bin/coder-linux-amd64 -o'
check "a replaced owned CLI behind a shadowing CLI reports the install" \
  outputHas "$shadowedInstallOutput" 'v2.39.0 installed'
check "a shadowing CLI after install warns with non-zero topic status" test "$shadowedInstallStatus" -eq 1
check "a shadowing CLI after install is named in the warning" \
  outputHas "$shadowedInstallOutput" "$stubBin/coder shadows"

: > "$commandLog"
shadowedStatus=0
shadowedOutput="$(runInstallWithShadowingCoder)" || shadowedStatus=$?
check "a matching owned CLI behind a shadowing CLI downloads nothing" logLacks '/bin/coder-'
check "a matching owned CLI behind a shadowing CLI reports present" \
  outputHas "$shadowedOutput" 'v2.39.0 already installed'
check "a mismatched shadowing CLI warns with non-zero topic status" test "$shadowedStatus" -eq 1
check "a mismatched shadowing CLI is named in the warning" outputHas "$shadowedOutput" "$stubBin/coder shadows"
check "auth asks the owned CLI" logHas 'coder whoami'
check "auth never asks the shadowing CLI" logLacks 'shadowing coder whoami'
check "a logged-in owned CLI behind a shadowing CLI needs no login hint" \
  outputLacks "$shadowedOutput" 'run coder login'

printf 'v2.39.0\n' > "$stubState/shadow-version"
: > "$commandLog"
matchingShadowStatus=0
matchingShadowOutput="$(runInstallWithShadowingCoder)" || matchingShadowStatus=$?
check "a matching shadowing CLI exits clean" test "$matchingShadowStatus" -eq 0
check "a matching shadowing CLI downloads nothing" logLacks '/bin/coder-'
check "a matching shadowing CLI is not named in a warning" \
  outputLacks "$matchingShadowOutput" "$stubBin/coder shadows"
check "a matching shadowing CLI raises no warning" outputLacks "$matchingShadowOutput" '[warn]'
check "a matching shadowing CLI reports the owned CLI present" \
  outputHas "$matchingShadowOutput" 'v2.39.0 already installed'

withdrawCommand coder

reportTopicResults "coder"
