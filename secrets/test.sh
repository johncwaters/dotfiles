#!/usr/bin/env bash

set -euo pipefail

topicDir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repoRoot="$(cd -- "$topicDir/.." && pwd)"
export DOTFILES_PLATFORM=linux
unset GH_CONFIG_DIR
source "$repoRoot/test/harness.sh"

startStubbedSandbox "secrets"

sandboxTemp="$sandbox/tmp"
darwinHomebrewPrefix="$sandbox/homebrew"
agentConfigPath="$sandbox/.gnupg/gpg-agent.conf"
ptraceDropInPath="$sandbox/sysctl.d/10-ptrace.conf"
ptraceLivePath="$sandbox/proc/ptrace_scope"

mkdir -p "$sandboxTemp" "$sandbox/sysctl.d" "$sandbox/proc"
printf '0\n' > "$ptraceLivePath"

coreUtilities=(
  bash sh env cat sed awk grep tail head cut tr find sort wc mktemp rm mkdir cp mv ln
  readlink basename dirname chmod cmp id stat touch true false printf test tty
)
linkCoreUtilities "${coreUtilities[@]}"

writeAptStubThatInstallsMappedCommands
writeContainedSudoStub

for recordingOnlyCommand in gpg gpgconf pinentry-curses pinentry-mac; do
  writeStub "$recordingOnlyCommand" <<STUB
#!/usr/bin/env bash
printf '$recordingOnlyCommand %s\n' "\$*" >> "\$DOTFILES_TEST_LOG"
exit 0
STUB
done

writeStub pass <<'STUB'
#!/usr/bin/env bash
printf 'pass %s\n' "$*" >> "$DOTFILES_TEST_LOG"
printf 'pass gpg opts %s\n' "${PASSWORD_STORE_GPG_OPTS:-}" >> "$DOTFILES_TEST_LOG"
if [[ -f "$DOTFILES_TEST_STATE/pass-locked" ]]; then
  printf 'gpg: decryption failed: No secret key\n' >&2
  exit 2
fi
gpg --decrypt "$2" >/dev/null
cat "${PASSWORD_STORE_DIR:-$HOME/.password-store}/$2.gpg"
STUB

writeStub planted-gpg <<'STUB'
#!/usr/bin/env bash
printf 'planted gpg %s\n' "$*" >> "$DOTFILES_TEST_LOG"
exit 0
STUB

writeStub planted-sed <<'STUB'
#!/usr/bin/env bash
if [[ -p /dev/stdin ]]; then
  capturedStandardInput="$DOTFILES_TEST_STATE/planted-sed-last-stdin"
  "$DOTFILES_TEST_CORE_BIN/cat" > "$capturedStandardInput"
  "$DOTFILES_TEST_CORE_BIN/cat" "$capturedStandardInput" >> "$DOTFILES_TEST_STATE/planted-sed-stdin"
  exec "$DOTFILES_TEST_CORE_BIN/sed" "$@" < "$capturedStandardInput"
fi
exec "$DOTFILES_TEST_CORE_BIN/sed" "$@"
STUB

writeStub gh <<'STUB'
#!/usr/bin/env bash
if [[ " $* " == *" --help "* ]]; then
  if [[ -f "$DOTFILES_TEST_STATE/gh-before-2.40" ]]; then
    printf 'Usage:  gh auth %s [flags]\n  -h, --hostname string\n' "${2:-}"
    exit 0
  fi
  printf 'Usage:  gh auth %s [flags]\n  -a, --active\n      --insecure-storage\n' "${2:-}"
  exit 0
fi
printf 'gh %s\n' "$*" >> "$DOTFILES_TEST_LOG"
hostsFilePath="$XDG_CONFIG_HOME/gh/hosts.yml"
if [[ "${1:-}" == "auth" && "${2:-}" == "status" ]]; then
  if [[ -f "$DOTFILES_TEST_STATE/gh-unauthed" ]]; then
    exit 1
  fi
  if [[ -f "$DOTFILES_TEST_STATE/gh-inactive-keyring-expired" && " $* " != *" --active "* ]]; then
    printf 'github.com\n  Logged in to github.com account sandbox (%s)\n  Failed to log in to github.com account stale (keyring)\n' "$hostsFilePath"
    exit 1
  fi
  tokenStorage="$hostsFilePath"
  if [[ -f "$DOTFILES_TEST_STATE/gh-keyring" ]]; then
    tokenStorage="keyring"
  fi
  printf 'github.com\n  Logged in to github.com account sandbox (%s)\n' "$tokenStorage"
  exit 0
fi
if [[ "${1:-}" == "auth" && "${2:-}" == "login" ]]; then
  if [[ -f "$hostsFilePath" ]]; then
    stat -c %a "$hostsFilePath" > "$DOTFILES_TEST_STATE/gh-hosts-mode-at-login" 2>/dev/null \
      || stat -f %Lp "$hostsFilePath" > "$DOTFILES_TEST_STATE/gh-hosts-mode-at-login"
  fi
  cat > "$DOTFILES_TEST_STATE/gh-received-token"
  if [[ ! -s "$DOTFILES_TEST_STATE/gh-received-token" ]]; then
    exit 1
  fi
  rm -f "$DOTFILES_TEST_STATE/gh-unauthed"
  if [[ " $* " != *" --insecure-storage "* ]]; then
    touch "$DOTFILES_TEST_STATE/gh-keyring"
    exit 0
  fi
  rm -f "$DOTFILES_TEST_STATE/gh-keyring"
  mkdir -p "${hostsFilePath%/*}"
  printf 'github.com:\n    oauth_token: %s\n' "$(cat "$DOTFILES_TEST_STATE/gh-received-token")" > "$hostsFilePath"
  chmod 644 "$hostsFilePath"
  exit 0
fi
exit 0
STUB

writeStub brew <<'STUB'
#!/usr/bin/env bash
printf 'brew %s\n' "$*" >> "$DOTFILES_TEST_LOG"
mkdir -p "$DOTFILES_TEST_HOMEBREW_PREFIX/bin"
for packageName in "${@:2}"; do
  for commandName in $(cat "$DOTFILES_TEST_STATE/package-commands/$packageName"); do
    cp "$DOTFILES_TEST_STATE/available/$commandName" "$DOTFILES_TEST_HOMEBREW_PREFIX/bin/$commandName"
  done
done
STUB

writeStub dnf <<'STUB'
#!/usr/bin/env bash
printf 'dnf %s\n' "$*" >> "$DOTFILES_TEST_LOG"
for argument in "$@"; do
  mappingFile="$DOTFILES_TEST_STATE/package-commands/$argument"
  if [[ ! -f "$mappingFile" ]]; then
    continue
  fi
  for commandName in $(cat "$mappingFile"); do
    cp "$DOTFILES_TEST_STATE/available/$commandName" "$DOTFILES_TEST_STUB_BIN/$commandName"
  done
done
STUB

writeStub install <<'STUB'
#!/usr/bin/env bash
printf 'install %s\n' "$*" >> "$DOTFILES_TEST_LOG"
cp -f -- "${*: -2:1}" "${*: -1}"
STUB

writeStub cp <<'STUB'
#!/usr/bin/env bash
exec "$DOTFILES_TEST_CORE_BIN/cp" "$@"
STUB

writeStub sysctl <<'STUB'
#!/usr/bin/env bash
printf 'sysctl %s\n' "$*" >> "$DOTFILES_TEST_LOG"
if [[ -f "$DOTFILES_TEST_STATE/sysctl-applies-nothing" ]]; then
  exit 0
fi
if grep -q 'ptrace_scope = 1' "$DOTFILES_PTRACE_SYSCTL_PATH" 2>/dev/null; then
  printf '1\n' > "$DOTFILES_PTRACE_SCOPE_PATH"
fi
STUB

writePasswordWantingSudoStub() {
  writeStub sudo <<'STUB'
#!/usr/bin/env bash
printf 'sudo %s\n' "$*" >> "$DOTFILES_TEST_LOG"
printf 'sudo: a password is required\n' >&2
exit 1
STUB
  provideCommand sudo
}

for presentFromTheStart in apt-get sudo cp install sysctl; do
  provideCommand "$presentFromTheStart"
done

mapPackageToCommands pass "pass"
mapPackageToCommands gnupg "gpg gpgconf"
mapPackageToCommands pinentry-curses "pinentry-curses"
mapPackageToCommands pinentry-mac "pinentry-mac"
mapPackageToCommands gnupg2 "gpg gpgconf"
mapPackageToCommands pinentry "pinentry-curses"

runInstall() {
  runInStubbedSandbox "$sandbox" \
    TMPDIR="$sandboxTemp" \
    DOTFILES_PROFILE=personal \
    DOTFILES_PTRACE_SYSCTL_PATH="$ptraceDropInPath" \
    DOTFILES_PTRACE_SCOPE_PATH="$ptraceLivePath" \
    XDG_CONFIG_HOME="$sandbox/.config" \
    NO_COLOR=1 \
    "$@" \
    bash "$topicDir/install.sh"
}

runDarwinInstall() {
  runInStubbedSandbox "$sandbox" \
    TMPDIR="$sandboxTemp" \
    DOTFILES_PLATFORM=darwin \
    DOTFILES_PROFILE=work \
    DOTFILES_TEST_HOMEBREW_PREFIX="$darwinHomebrewPrefix" \
    DOTFILES_PTRACE_SYSCTL_PATH="$ptraceDropInPath" \
    DOTFILES_PTRACE_SCOPE_PATH="$ptraceLivePath" \
    XDG_CONFIG_HOME="$sandbox/.config" \
    NO_COLOR=1 \
    bash "$topicDir/install.sh"
}

printf '\nsecrets topic\n'

firstRunStatus=0
firstRunOutput="$(runInstall)" || firstRunStatus=$?
check "linux installs pass through apt" logHas "apt-get -o DPkg::Lock::Timeout=180 install -y pass"
check "linux installs gnupg through apt" logHas "apt-get -o DPkg::Lock::Timeout=180 install -y gnupg"
check "linux installs the curses pinentry through apt" \
  logHas "apt-get -o DPkg::Lock::Timeout=180 install -y pinentry-curses"
check "linux installs through the gated sudo" grep -qE -- '^sudo -n [^ ]*/apt-get ' "$commandLog"
check "linux never reaches for Homebrew" logLacks "brew "
check "pass is reported installed" outputMatches "$firstRunOutput" '\[ \+\+ \].*pass'
check "GnuPG is reported installed" outputMatches "$firstRunOutput" '\[ \+\+ \].*GnuPG'
check "the pinentry is reported installed" outputMatches "$firstRunOutput" '\[ \+\+ \].*pinentry'
check "~/.gnupg is owner only" test "$(fileModeOf "$sandbox/.gnupg")" = "700"
check "the agent config is owner only" test "$(fileModeOf "$agentConfigPath")" = "600"
check "linux points the agent at the curses pinentry it resolved" \
  grep -qxF "pinentry-program $stubBin/pinentry-curses" "$agentConfigPath"
check "the agent caches a passphrase for a minute" grep -qxF 'default-cache-ttl 60' "$agentConfigPath"
check "the agent forgets a passphrase after five minutes" grep -qxF 'max-cache-ttl 300' "$agentConfigPath"
check "a changed agent config reloads the agent" logHas "gpgconf --kill gpg-agent"
check "an uninitialized store warns" outputMatches "$firstRunOutput" '\[warn\].*password store'
check "the warning names the key generation command" \
  outputHas "$firstRunOutput" "gpg --quick-generate-key '<email>' default default never"
check "the warning names the store init command" outputHas "$firstRunOutput" "pass init '<email>'"
check "an uninitialized store exits non-zero" test "$firstRunStatus" -eq 1
check "no command was refused for reaching outside the stubs" logLacks "sudo refused"
check "an absent ptrace drop-in is written as root" \
  grep -qE -- "^sudo -n [^ ]*/install -m 0644 .* $ptraceDropInPath\$" "$commandLog"
check "the drop-in raises ptrace scope to 1" grep -qxF 'kernel.yama.ptrace_scope = 1' "$ptraceDropInPath"
check "the new drop-in is applied as root" grep -qE -- '^sudo -n [^ ]*/sysctl --system$' "$commandLog"
check "the live ptrace scope is reported raised" outputMatches "$firstRunOutput" 'ptrace scope.*live scope now 1'

mkdir -p "$sandbox/.password-store"
printf 'you@example.com\n' > "$sandbox/.password-store/.gpg-id"
: > "$commandLog"
secondRunStatus=0
secondRunOutput="$(runInstall)" || secondRunStatus=$?
check "a converged machine exits clean" test "$secondRunStatus" -eq 0
check "a second run reports no changes" reportsNoChanges "$secondRunOutput"
check "a second run installs nothing" logLacks "install -y"
check "an unchanged agent config leaves the agent running" logLacks "gpgconf --kill"
check "an initialized store draws no warning" outputLacks "$secondRunOutput" "[warn]"
check "a persisted ptrace scope is not reapplied" logLacks "sysctl --system"

printf '0\n' > "$ptraceLivePath"
: > "$commandLog"
unappliedOutput="$(runInstall)" || true
check "a present drop-in with a live scope of 0 is applied again" logHas "sysctl --system"
check "a present drop-in is not rewritten" logLacks "install -m 0644"
check "the reapplied scope is reported" outputMatches "$unappliedOutput" 'ptrace scope.*live scope now 1'

printf '0\n' > "$ptraceLivePath"
touch "$stubState/sysctl-applies-nothing"
stillZeroStatus=0
stillZeroOutput="$(runInstall)" || stillZeroStatus=$?
check "a live scope still 0 after the drop-in warns" outputMatches "$stillZeroOutput" '\[warn\].*ptrace scope'
check "the warning names the reload command" outputHas "$stillZeroOutput" "sudo sysctl --system"
check "a live scope still 0 exits non-zero" test "$stillZeroStatus" -eq 1
rm -f "$stubState/sysctl-applies-nothing"

rm -f "$ptraceDropInPath"
printf '1\n' > "$ptraceLivePath"
: > "$commandLog"
liveOnlyOutput="$(runInstall)" || true
check "a live scope of 1 without a drop-in is still persisted" \
  grep -qxF 'kernel.yama.ptrace_scope = 1' "$ptraceDropInPath"
check "a live scope of 1 needs no reload" logLacks "sysctl --system"
check "persisting a live scope of 1 is reported" outputMatches "$liveOnlyOutput" 'ptrace scope.*persisted'

for stricterScope in 2 3; do
  rm -f "$ptraceDropInPath"
  printf '%s\n' "$stricterScope" > "$ptraceLivePath"
  : > "$commandLog"
  stricterStatus=0
  stricterOutput="$(runInstall)" || stricterStatus=$?
  check "a live scope of $stricterScope without a drop-in is persisted for the next boot" \
    grep -qxF 'kernel.yama.ptrace_scope = 1' "$ptraceDropInPath"
  check "a live scope of $stricterScope runs no sysctl" logLacks "sysctl --system"
  check "a live scope of $stricterScope exits clean" test "$stricterStatus" -eq 0
  check "a live scope of $stricterScope is reported persisted" \
    outputMatches "$stricterOutput" "ptrace scope.*live scope $stricterScope, persisted"
done

printf 'kernel.yama.ptrace_scope = 2\n' > "$ptraceDropInPath"
printf '3\n' > "$ptraceLivePath"
: > "$commandLog"
stricterPersistedOutput="$(runInstall)" || true
check "a live scope of 3 over a current drop-in rewrites nothing" logLacks "install -m 0644"
check "a live scope of 3 over a current drop-in is reported persisted" \
  outputMatches "$stricterPersistedOutput" "ptrace scope.*live scope 3, persisted"

printf 'kernel.yama.ptrace_scope = 0\n' > "$ptraceDropInPath"
printf '0\n' > "$ptraceLivePath"
: > "$commandLog"
laxDropInOutput="$(runInstall)" || true
check "a drop-in setting scope 0 is backed up" \
  grep -qxF 'kernel.yama.ptrace_scope = 0' "$ptraceDropInPath.pre-dotfiles.bak"
check "a drop-in setting scope 0 is replaced" grep -qxF 'kernel.yama.ptrace_scope = 1' "$ptraceDropInPath"
check "the drop-in backup is taken as root" grep -qE -- '^sudo -n [^ ]*/cp -p --' "$commandLog"
check "the drop-in backup is reported" outputMatches "$laxDropInOutput" 'ptrace scope backup'

printf 'kernel.yama.ptrace_scope = 2\n' > "$ptraceDropInPath"
printf '1\n' > "$ptraceLivePath"
: > "$commandLog"
runInstall > /dev/null || true
check "a drop-in already restricting ptrace is left as it is" \
  grep -qxF 'kernel.yama.ptrace_scope = 2' "$ptraceDropInPath"

rm -f "$ptraceDropInPath"
printf '0\n' > "$ptraceLivePath"
writePasswordWantingSudoStub
: > "$commandLog"
nonRootStatus=0
nonRootOutput="$(runInstall)" || nonRootStatus=$?
check "without root or passwordless sudo the drop-in is not written" test ! -e "$ptraceDropInPath"
check "without root the ptrace scope warns" outputMatches "$nonRootOutput" '\[warn\].*ptrace scope.*needs root'
check "the warning names the exact command" \
  outputHas "$nonRootOutput" "echo 'kernel.yama.ptrace_scope = 1' | sudo tee $ptraceDropInPath && sudo sysctl --system"
check "without root nothing prompts, sudo is only ever run non-interactively" \
  bash -c '! grep -E "^sudo " "$1" | grep -vqE "^sudo -n "' _ "$commandLog"
check "without root the topic exits non-zero" test "$nonRootStatus" -eq 1

for restrictiveScope in 1 2; do
  rm -f "$ptraceDropInPath"
  printf '%s\n' "$restrictiveScope" > "$ptraceLivePath"
  : > "$commandLog"
  unpersistedStatus=0
  unpersistedOutput="$(runInstall)" || unpersistedStatus=$?
  check "without root a live scope of $restrictiveScope writes no drop-in" test ! -e "$ptraceDropInPath"
  check "without root a live scope of $restrictiveScope draws no warning" outputLacks "$unpersistedOutput" "[warn]"
  check "without root a live scope of $restrictiveScope exits clean" test "$unpersistedStatus" -eq 0
  check "without root a live scope of $restrictiveScope notes it is not persisted" \
    outputMatches "$unpersistedOutput" "ptrace scope.*live scope $restrictiveScope, not persisted"
  check "the live scope $restrictiveScope note names the exact persist command" \
    outputHas "$unpersistedOutput" "to persist run: echo 'kernel.yama.ptrace_scope = 1' | sudo tee $ptraceDropInPath"
  check "without root a live scope of $restrictiveScope runs no sysctl" logLacks "sysctl"
done
writeContainedSudoStub
printf '1\n' > "$ptraceLivePath"
runInstall > /dev/null || true

mv "$sandbox/.password-store" "$sandbox/relocated-store"
relocatedStoreStatus=0
runInstall PASSWORD_STORE_DIR="$sandbox/relocated-store" > /dev/null || relocatedStoreStatus=$?
check "a store under PASSWORD_STORE_DIR counts as initialized" test "$relocatedStoreStatus" -eq 0
mv "$sandbox/relocated-store" "$sandbox/.password-store"

printf 'pinentry-program /usr/bin/pinentry-gnome3\nallow-loopback-pinentry\n' > "$agentConfigPath"
: > "$commandLog"
handEditedOutput="$(runInstall)" || true
check "an operator edit is backed up before the render replaces it" \
  grep -qxF 'allow-loopback-pinentry' "$agentConfigPath.pre-dotfiles.bak"
check "the backup is reported" outputMatches "$handEditedOutput" 'gpg-agent config backup'
check "the render replaces the operator edit" \
  grep -qxF "pinentry-program $stubBin/pinentry-curses" "$agentConfigPath"
check "replacing an operator edit reloads the agent" logHas "gpgconf --kill gpg-agent"

withdrawCommand pinentry-curses
mkdir -p "$sandbox/.local/bin"
cp "$stubState/available/pinentry-curses" "$sandbox/.local/bin/pinentry-curses"
systemPinentryPath="$(PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin type -P pinentry-curses || true)"
: > "$commandLog"
plantedPinentryStatus=0
plantedPinentryOutput="$(runInstall)" || plantedPinentryStatus=$?
check "a pinentry only in a home-writable PATH dir is never pinned" \
  bash -c '! grep -qF "$1" "$2"' _ "$sandbox/.local/bin" "$agentConfigPath"
if [[ -z "$systemPinentryPath" ]]; then
  check "a pinentry only in a home-writable PATH dir is refused" \
    outputMatches "$plantedPinentryOutput" "\[warn\].*gpg-agent config.*refusing $sandbox/.local/bin/pinentry-curses"
  check "a refused pinentry leaves the agent running" logLacks "gpgconf --kill"
  check "a refused pinentry exits non-zero" test "$plantedPinentryStatus" -eq 1
fi
rm -rf "$sandbox/.local/bin"
provideCommand pinentry-curses
runInstall > /dev/null || true

for aptOnlyCommand in pass gpg gpgconf pinentry-curses apt-get; do
  withdrawCommand "$aptOnlyCommand"
done
provideCommand dnf
: > "$commandLog"
dnfRunOutput="$(runInstall)" || true
check "dnf installs pass" grep -qE -- '^dnf install -y pass$' "$commandLog"
check "dnf installs GnuPG as gnupg2" grep -qE -- '^dnf install -y gnupg2$' "$commandLog"
check "dnf installs the curses pinentry from the pinentry package" grep -qE -- '^dnf install -y pinentry$' "$commandLog"
check "dnf never says to install by hand" outputLacks "$dnfRunOutput" "install manually"
check "dnf still pins the curses pinentry" grep -qxF "pinentry-program $stubBin/pinentry-curses" "$agentConfigPath"
withdrawCommand dnf
provideCommand apt-get

githubTokenValue="ghp_sandboxTokenThatMustNeverBeLogged"
ghHostsFilePath="$sandbox/.config/gh/hosts.yml"
mkdir -p "$sandbox/.password-store/github"
printf '%s\nlogin: sandbox\n' "$githubTokenValue" > "$sandbox/.password-store/github/token.gpg"
provideCommand gh

: > "$commandLog"
authedWithEntryOutput="$(runInstall)" || true
check "an authenticated gh is left alone even with a token entry" logLacks "gh auth login"
check "an authenticated gh never decrypts the token entry" logLacks "pass show"
check "an authenticated gh reports logged in" outputMatches "$authedWithEntryOutput" 'GitHub auth.*logged in'
check "a gh token already in hosts.yml never runs pass" logLacks "pass "

touch "$stubState/gh-keyring"
rm -f "$stubState/gh-received-token"
: > "$commandLog"
keyringMigrationStatus=0
keyringMigrationOutput="$(runInstall)" || keyringMigrationStatus=$?
check "a keyring token is logged in again from github/token" logHas "pass show github/token"
check "the keyring migration stores the token in plain text" \
  grep -qE -- '^gh auth login --with-token --insecure-storage$' "$commandLog"
check "the keyring migration hands gh the first line of the entry" \
  test "$(cat "$stubState/gh-received-token")" = "$githubTokenValue"
check "the keyring migration checks gh auth status again afterwards" \
  test "$(countLogLines '^gh auth status --active --hostname github.com$')" -eq 2
check "the keyring migration leaves hosts.yml owner only" test "$(fileModeOf "$ghHostsFilePath")" = "600"
check "the keyring migration is reported as a change" \
  outputMatches "$keyringMigrationOutput" '\[ ok \].*GitHub auth.*hosts\.yml'
check "the keyring migration never shows the token" outputLacks "$keyringMigrationOutput" "$githubTokenValue"
check "the keyring migration never logs the token" logLacks "$githubTokenValue"
check "the keyring migration exits clean" test "$keyringMigrationStatus" -eq 0
rm -f "$ghHostsFilePath"

touch "$stubState/gh-unauthed"
: > "$commandLog"
passLoginStatus=0
passLoginOutput="$(runInstall)" || passLoginStatus=$?
check "an unauthenticated gh logs in from the github/token entry" \
  grep -qE -- '^gh auth login --with-token --insecure-storage$' "$commandLog"
check "a pass login leaves hosts.yml owner only" test "$(fileModeOf "$ghHostsFilePath")" = "600"
check "the login is reported as a change" outputMatches "$passLoginOutput" '\[ ok \].*GitHub auth.*github/token'
check "gh receives only the first line of the entry" \
  test "$(cat "$stubState/gh-received-token")" = "$githubTokenValue"
check "the login is checked again afterwards" test "$(countLogLines '^gh auth status')" -eq 2
check "the token entry is decrypted without a pinentry prompt" logHas "pass gpg opts --pinentry-mode error"
check "the token never appears in the converge output" outputLacks "$passLoginOutput" "$githubTokenValue"
check "the token never appears in any logged command line" logLacks "$githubTokenValue"
check "a pass login leaves no warning" outputLacks "$passLoginOutput" "[warn]"
check "a pass login exits clean" test "$passLoginStatus" -eq 0

chmod 644 "$ghHostsFilePath"
touch "$stubState/gh-unauthed"
rm -f "$stubState/gh-hosts-mode-at-login"
: > "$commandLog"
runInstall > /dev/null || true
check "a world-readable hosts.yml is owner only before gh writes the token" \
  test "$(cat "$stubState/gh-hosts-mode-at-login" 2>/dev/null)" = "600"

rm -f "$ghHostsFilePath" "$stubState/gh-received-token"
symlinkedHostsTarget="$sandbox/symlinked-hosts-target"
: > "$symlinkedHostsTarget"
ln -s "$symlinkedHostsTarget" "$ghHostsFilePath"
touch "$stubState/gh-unauthed"
: > "$commandLog"
symlinkedHostsOutput="$(runInstall)" || true
check "a symlinked hosts.yml refuses the login" logLacks "gh auth login"
check "a symlinked hosts.yml never runs pass" logLacks "pass show"
check "a symlinked hosts.yml draws a warning" outputMatches "$symlinkedHostsOutput" '\[warn\].*GitHub auth.*not a regular file'
check "a symlinked hosts.yml target receives no token" test ! -s "$symlinkedHostsTarget"
rm -f "$ghHostsFilePath" "$symlinkedHostsTarget" "$stubState/gh-unauthed"

symlinkedGhConfigTarget="$sandbox/symlinked-gh-config-target"
mkdir -p "$symlinkedGhConfigTarget"
rm -rf "$sandbox/.config/gh"
ln -s "$symlinkedGhConfigTarget" "$sandbox/.config/gh"
touch "$stubState/gh-unauthed"
: > "$commandLog"
symlinkedGhConfigOutput="$(runInstall)" || true
check "a symlinked gh config dir refuses the login" logLacks "gh auth login"
check "a symlinked gh config dir never runs pass" logLacks "pass show"
check "a symlinked gh config dir warning names the resolved path" \
  outputMatches "$symlinkedGhConfigOutput" "\[warn\].*GitHub auth.*symlink to $symlinkedGhConfigTarget"
check "a symlinked gh config dir target receives no token" test ! -e "$symlinkedGhConfigTarget/hosts.yml"
rm -f "$sandbox/.config/gh" "$stubState/gh-unauthed"
rm -rf "$symlinkedGhConfigTarget"
mkdir -p "$sandbox/.config/gh"

touch "$stubState/gh-unauthed" "$stubState/gh-before-2.40"
rm -f "$stubState/gh-received-token"
: > "$commandLog"
legacyGhStatus=0
legacyGhOutput="$(runInstall)" || legacyGhStatus=$?
check "a gh before 2.40 never runs pass" logLacks "pass "
check "a gh before 2.40 is never logged in" logLacks "gh auth login"
check "a gh before 2.40 is never probed with --active" logLacks "gh auth status --active"
check "a gh before 2.40 names the minimum version" outputMatches "$legacyGhOutput" 'GitHub auth.*gh 2\.40 or newer'
check "a gh before 2.40 draws no warning" outputLacks "$legacyGhOutput" "[warn]"
check "a gh before 2.40 exits clean" test "$legacyGhStatus" -eq 0
rm -f "$stubState/gh-unauthed" "$stubState/gh-before-2.40"

touch "$stubState/gh-inactive-keyring-expired"
: > "$commandLog"
inactiveKeyringOutput="$(runInstall)" || true
check "an inactive keyring account beside an active hosts.yml account never runs pass" logLacks "pass "
check "an inactive keyring account beside an active hosts.yml account is not logged in again" logLacks "gh auth login"
check "an inactive keyring account beside an active hosts.yml account reports logged in" \
  outputMatches "$inactiveKeyringOutput" 'GitHub auth.*logged in'
rm -f "$stubState/gh-inactive-keyring-expired"

touch "$stubState/gh-unauthed" "$stubState/pass-locked"
rm -f "$stubState/gh-received-token"
: > "$commandLog"
lockedPassStatus=0
lockedPassOutput="$(runInstall)" || lockedPassStatus=$?
check "a locked store warns about GitHub auth" outputMatches "$lockedPassOutput" '\[warn\].*GitHub auth'
check "a locked store names the unlock command" outputHas "$lockedPassOutput" "pass show github/token >/dev/null"
check "a locked store hands gh no token" test ! -s "$stubState/gh-received-token"
check "a locked store exits non-zero" test "$lockedPassStatus" -eq 1
rm -f "$stubState/pass-locked"

rm -f "$sandbox/.password-store/github/token.gpg"
: > "$commandLog"
missingEntryStatus=0
missingEntryOutput="$(runInstall)" || missingEntryStatus=$?
check "a missing token entry never attempts a login" logLacks "gh auth login"
check "a missing token entry never runs pass" logLacks "pass show"
check "a missing token entry names the pass insert command" outputHas "$missingEntryOutput" "pass insert github/token"
check "a missing token entry leaves the auth warning to the packages topic" test "$missingEntryStatus" -eq 0

rm -f "$stubState/gh-unauthed"
touch "$stubState/gh-keyring"
: > "$commandLog"
keyringWithoutEntryStatus=0
keyringWithoutEntryOutput="$(runInstall)" || keyringWithoutEntryStatus=$?
check "a keyring token without an entry is not logged in again" logLacks "gh auth login"
check "a keyring token without an entry never runs pass" logLacks "pass show"
check "a keyring token without an entry names the pass insert command" \
  outputMatches "$keyringWithoutEntryOutput" 'GitHub auth.*keyring.*pass insert github/token'
check "a keyring token without an entry draws no warning" outputLacks "$keyringWithoutEntryOutput" "[warn]"
check "a keyring token without an entry exits clean" test "$keyringWithoutEntryStatus" -eq 0
rm -f "$stubState/gh-keyring"
touch "$stubState/gh-unauthed"

relocatedTokenStore="$sandbox/relocated-token-store"
cp -R "$sandbox/.password-store" "$relocatedTokenStore"
mkdir -p "$relocatedTokenStore/github"
printf '%s\n' "$githubTokenValue" > "$relocatedTokenStore/github/token.gpg"
: > "$commandLog"
relocatedLoginStatus=0
runInstall PASSWORD_STORE_DIR="$relocatedTokenStore" > /dev/null || relocatedLoginStatus=$?
check "a token entry under PASSWORD_STORE_DIR logs gh in" logHas "gh auth login --with-token"
check "a login from a relocated store exits clean" test "$relocatedLoginStatus" -eq 0
rm -rf "$relocatedTokenStore"

systemCommandPath() {
  PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin type -P "$1" || true
}

printf '%s\n' "$githubTokenValue" > "$sandbox/.password-store/github/token.gpg"
touch "$stubState/gh-unauthed"
mkdir -p "$sandbox/.local/bin"
if [[ -z "$(systemCommandPath gh)" ]]; then
  withdrawCommand gh
  cp "$stubState/available/gh" "$sandbox/.local/bin/gh"
  : > "$commandLog"
  plantedGhOutput="$(runInstall)" || true
  check "a gh only in a home-writable PATH dir is never executed" logLacks "gh auth"
  check "a refused gh never decrypts the token entry" logLacks "pass show"
  check "a gh only in a home-writable PATH dir is refused" \
    outputMatches "$plantedGhOutput" "\[warn\].*GitHub auth.*refusing $sandbox/.local/bin/gh"
  rm -f "$sandbox/.local/bin/gh"
  provideCommand gh
fi

if [[ -z "$(systemCommandPath pass)" ]]; then
  withdrawCommand pass
  cp "$stubState/available/pass" "$sandbox/.local/bin/pass"
  : > "$commandLog"
  plantedPassOutput="$(runInstall)" || true
  check "a pass only in a home-writable PATH dir is never executed" logLacks "pass show"
  check "a refused pass hands gh no token" logLacks "gh auth login"
  check "a pass only in a home-writable PATH dir is refused" \
    outputMatches "$plantedPassOutput" "\[warn\].*GitHub auth.*refusing $sandbox/.local/bin/pass"
  provideCommand pass
fi

cp "$stubState/available/planted-sed" "$sandbox/.local/bin/sed"
cp "$stubState/available/planted-gpg" "$sandbox/.local/bin/gpg"
touch "$stubState/gh-unauthed"
rm -f "$stubState/gh-received-token" "$stubState/planted-sed-stdin"
: > "$commandLog"
runInstall > /dev/null || true
check "with sed and gpg planted the token entry is still decrypted" logHas "pass show github/token"
check "a sed in a home-writable PATH dir never receives the token" \
  bash -c '! grep -qF "$1" "$2" 2>/dev/null' _ "$githubTokenValue" "$stubState/planted-sed-stdin"
check "a gpg in a home-writable PATH dir is never executed by pass" logLacks "planted gpg"
check "pass reaches gpg only through the system and Homebrew prefixes" logHas "gpg --decrypt github/token"
check "with sed planted gh still receives the token" \
  test "$(cat "$stubState/gh-received-token" 2>/dev/null)" = "$githubTokenValue"
rm -rf "$sandbox/.local/bin"
rm -f "$sandbox/.password-store/github/token.gpg" "$stubState/gh-unauthed"

withdrawCommand gh
if [[ -z "$(systemCommandPath gh)" ]]; then
  : > "$commandLog"
  noGhStatus=0
  noGhOutput="$(runInstall)" || noGhStatus=$?
  check "an absent gh never runs pass" logLacks "pass show"
  check "an absent gh says nothing about GitHub auth" outputLacks "$noGhOutput" "GitHub auth"
  check "an absent gh never fails the topic" test "$noGhStatus" -eq 0
fi

check "GPG_TTY stays unset in a shell with no terminal" \
  env -i PATH="$coreBin" bash -c 'source "$1"; [[ -z "${GPG_TTY:-}" ]]' _ "$topicDir/gpg-tty.bash" < /dev/null

for linuxOnlyCommand in pass gpg gpgconf pinentry-curses apt-get; do
  withdrawCommand "$linuxOnlyCommand"
done
provideCommand brew
writeDarwinDirectoryServiceStub "$stubBin" "$realHomeOutsideTheSandbox"
rm -f "$agentConfigPath" "$agentConfigPath.pre-dotfiles.rendered"
: > "$commandLog"
darwinStatus=0
darwinOutput="$(runDarwinInstall)" || darwinStatus=$?
check "darwin converges cleanly" test "$darwinStatus" -eq 0
check "darwin installs pass through Homebrew" logHas "brew install pass"
check "darwin installs gnupg through Homebrew" logHas "brew install gnupg"
check "darwin installs the mac pinentry through Homebrew" logHas "brew install pinentry-mac"
check "darwin never runs Homebrew through sudo" logLacks "sudo "
check "darwin points the agent at the Homebrew pinentry-mac" \
  grep -qxF "pinentry-program $darwinHomebrewPrefix/bin/pinentry-mac" "$agentConfigPath"
check "darwin reloads the agent for the new config" logHas "gpgconf --kill gpg-agent"
check "darwin never touches ptrace scope" logLacks "sysctl --system"
check "darwin says nothing about ptrace scope" outputLacks "$darwinOutput" "ptrace"

: > "$commandLog"
darwinRerunOutput="$(runDarwinInstall)"
check "a darwin rerun reports no changes" reportsNoChanges "$darwinRerunOutput"
check "a darwin rerun does not invoke Homebrew" logLacks "brew "

reportTopicResults "secrets"
