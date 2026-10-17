#!/usr/bin/env bash

set -euo pipefail

topicDir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repoRoot="$(cd -- "$topicDir/.." && pwd)"
# shellcheck source=../test/harness.sh
source "$repoRoot/test/harness.sh"

startStubbedSandbox "vscodium"
stageTopicWithLinuxAccountLookup
if [[ "$repoRoot" != "$sandbox/"* ]]; then
  mkdir -p "$sandbox/repo"
  cp -R "$repoRoot/script" "$repoRoot/packages" "$repoRoot/profiles" "$repoRoot/README.md" "$topicDir" "$sandbox/repo/"
  repoRoot="$sandbox/repo"
  topicDir="$repoRoot/vscodium"
  rm "$sandbox/.dotfiles"
  ln -s "$repoRoot" "$sandbox/.dotfiles"
fi

realHome="$HOME"
realHomePathsNoStubMayName=(
  "$realHome/.dotfiles"
  "$realHome/.vscode-oss"
)
realNodePath="$(command -v node 2>/dev/null || true)"
if [[ -z "$realNodePath" ]]; then
  printf 'vscodium/test.sh needs node on PATH for JSON parser coverage.\n' >&2
  exit 1
fi
installedExtensionsFile="$stubState/installed-extensions"
sandboxTemp="$sandbox/tmp"
codiumUserDirectory="$sandbox/.config/VSCodium/User"

mkdir -p "$sandboxTemp" "$codiumUserDirectory"
: > "$installedExtensionsFile"

coreUtilities=(
  bash sh env cat sed awk grep tail head cut tr find sort uniq wc mktemp rm mkdir
  rmdir cp mv ln readlink basename dirname chmod cmp id date stat touch true false xargs
  od tee expr sleep printf test
)
linkCoreUtilities "${coreUtilities[@]}"

writeStub codium <<'STUB'
#!/usr/bin/env bash
printf 'codium %s\n' "$*" >> "$DOTFILES_TEST_LOG"
extensionsFile="$DOTFILES_TEST_STATE/installed-extensions"
if [[ "${1:-}" == "--list-extensions" ]]; then
  if [[ -f "$DOTFILES_TEST_STATE/list-extensions-fails" ]]; then
    printf 'codium: the extension host never came up\n' >&2
    exit 1
  fi
  cat "$extensionsFile"
  exit 0
fi
if [[ "${1:-}" == "--install-extension" ]]; then
  printf '%s\n' "$2" >> "$extensionsFile"
  exit 0
fi
if [[ "${1:-}" == "--uninstall-extension" ]]; then
  grep -vxF -- "$2" "$extensionsFile" > "$extensionsFile.next" || true
  mv "$extensionsFile.next" "$extensionsFile"
  exit 0
fi
exit 0
STUB

writeStub apt-get <<'STUB'
#!/usr/bin/env bash
printf 'apt-get %s\n' "$*" >> "$DOTFILES_TEST_LOG"
if [[ -f "$DOTFILES_TEST_STATE/apt-install-fails" ]]; then
  printf 'E: Unable to locate the package this run needed\n' >&2
  exit 100
fi
for argument in "$@"; do
  if [[ "$argument" == *.deb ]]; then
    cp "$DOTFILES_TEST_STATE/available/codium" "$DOTFILES_TEST_STUB_BIN/codium"
  fi
done
exit 0
STUB

writeContainedSudoStub

writeStub node <<'STUB'
#!/usr/bin/env bash
exec "$DOTFILES_TEST_REAL_NODE" "$@"
STUB
provideCommand node

writeStub dpkg <<'STUB'
#!/usr/bin/env bash
printf 'dpkg %s\n' "$*" >> "$DOTFILES_TEST_LOG"
if [[ "${1:-}" == "--print-architecture" ]]; then
  cat "$DOTFILES_TEST_STATE/architecture"
  exit 0
fi
exit 0
STUB

writeStub curl <<'STUB'
#!/usr/bin/env bash
printf 'curl %s\n' "$*" >> "$DOTFILES_TEST_LOG"
stubbedFileMode() {
  "$DOTFILES_TEST_REAL_NODE" -e 'console.log((require("node:fs").statSync(process.argv[1]).mode & 0o777).toString(8))' "$1"
}

requestedUrl=""
outputPath=""
while (($# > 0)); do
  if [[ "$1" == "-o" ]]; then
    outputPath="$2"
    shift 2
    continue
  fi
  if [[ "$1" == "--config" ]]; then
    if grep -q '^header = "Authorization: Bearer ' "$2"; then
      configMode="$(stubbedFileMode "$2")"
      printf 'curl was handed an authorization header in mode %s\n' "$configMode" \
        >> "$DOTFILES_TEST_LOG"
    fi
    shift 2
    continue
  fi
  if [[ "$1" == http* ]]; then
    requestedUrl="$1"
  fi
  shift
done
emitBody() {
  case "$requestedUrl" in
    *api.github.com/repos/VSCodium/vscodium/releases/latest)
      printf '  "assets": [\n'
      printf '    { "browser_download_url": "%s" },\n' \
        "https://github.com/VSCodium/vscodium/releases/download/1.99.0/codium_1.99.0_arm64.deb"
      printf '    { "browser_download_url": "%s" },\n' \
        "https://github.com/VSCodium/vscodium/releases/download/1.99.0/codium_1.99.0_amd64.deb"
      printf '  ]\n'
      ;;
    *codium_1.99.0_amd64.deb)
      printf 'fake deb payload\n'
      ;;
    *)
      return 1
      ;;
  esac
}
if [[ -n "$outputPath" ]]; then
  emitBody > "$outputPath"
  exit $?
fi
emitBody
STUB

writeStub dnf <<'STUB'
#!/usr/bin/env bash
printf 'dnf %s\n' "$*" >> "$DOTFILES_TEST_LOG"
exit 0
STUB

printf 'amd64\n' > "$stubState/architecture"
for presentFromTheStart in apt-get sudo dpkg curl; do
  provideCommand "$presentFromTheStart"
done

retiredExtensionName="fixture.retired-extension"
printf '%s\n' "$retiredExtensionName" > "$topicDir/extensions-remove.txt"

printf 'aaron-bond.better-comments\n' > "$installedExtensionsFile"
printf 'nosuch.extension\n' >> "$installedExtensionsFile"
printf 'someone.unpublished-tool\n' >> "$installedExtensionsFile"
printf '%s\n' "$retiredExtensionName" >> "$installedExtensionsFile"

installedExtensionManifest() {
  local manifestDirectory="$sandbox/.vscode-oss/extensions/$1"
  mkdir -p "$manifestDirectory"
  printf '{ "name": "%s", "private": %s }\n' "$1" "$2" > "$manifestDirectory/package.json"
}

mkdir -p "$sandbox/.vscode-oss/extensions/someone.unpublished-tool-1.2.0"
cat > "$sandbox/.vscode-oss/extensions/someone.unpublished-tool-1.2.0/package.json" <<'MANIFEST'
{
  "name": "someone.unpublished-tool",
  "private"
  : true
}
MANIFEST
installedExtensionManifest "nosuch.extension-0.1.0" false

printf 'pre-existing editor settings\n' > "$codiumUserDirectory/settings.json"

probeGitHubToken="ghp_neverBelongsInAnArgumentVector"

runInstall() {
  runInStubbedSandbox "$sandbox" \
    TMPDIR="$sandboxTemp" \
    DOTFILES_PROFILE="${1:-personal}" \
    GITHUB_TOKEN="$probeGitHubToken" \
    DOTFILES_TEST_REAL_NODE="$realNodePath" \
    NO_COLOR=1 \
    bash "$topicDir/install.sh"
}

check "platform keybindings keep the same non-removal commands" \
  "$realNodePath" -e '
    const fs = require("fs");
    const nonRemovalCommands = path => new Set(
      JSON.parse(fs.readFileSync(path, "utf8"))
        .map(binding => binding.command)
        .filter(command => !command.startsWith("-"))
    );
    const linuxCommands = [...nonRemovalCommands(process.argv[1])].sort();
    const darwinCommands = [...nonRemovalCommands(process.argv[2])].sort();
    if (JSON.stringify(linuxCommands) !== JSON.stringify(darwinCommands)) {
      process.exit(1);
    }
  ' "$topicDir/keybindings.json" "$topicDir/keybindings.darwin.json"

wantedExtensionCount="$(grep -cve '^[[:space:]]*$' "$topicDir/extensions.txt")"

printf '\nvscodium topic\n'

installStatus=0
firstRunOutput="$(runInstall)" || installStatus=$?
check "install exits clean" test "$installStatus" -eq 0

check "the release list is read from the VSCodium repo" \
  logHas "https://api.github.com/repos/VSCodium/vscodium/releases/latest"
check "the architecture decides the asset" logHas "dpkg --print-architecture"
check "the GitHub token never reaches an argument vector" logLacks "$probeGitHubToken"
check "the token is handed over as an owner-only config file" \
  logHas "curl was handed an authorization header in mode 600"
check "the asset matching this architecture is downloaded" logHas "codium_1.99.0_amd64.deb"
check "the .deb is installed through apt-get by absolute path" \
  test "$(countLogLines "^apt-get .*install -y $sandboxTemp/dotfiles-vscodium\..*/codium_1\.99\.0_amd64\.deb$")" -eq 1
check "every package manager call goes through sudo" \
  test "$(countLogLines '^sudo -n [^ ]*/apt-get ')" -eq "$(countLogLines '^apt-get ')"

linkedDestinations=(
  ".config/VSCodium/User/settings.json"
  ".config/VSCodium/User/keybindings.json"
)
for destination in "${linkedDestinations[@]}"; do
  fullPath="$sandbox/$destination"
  if [[ ! -L "$fullPath" ]]; then
    fail "$destination is a symlink"
    continue
  fi
  linkTarget="$(readlink -- "$fullPath")"
  case "$linkTarget" in
    "$sandbox/.dotfiles"/*) ;;
    *)
      fail "$destination points through ~/.dotfiles (got $linkTarget)"
      continue
      ;;
  esac
  if [[ ! -e "$fullPath" ]]; then
    fail "$destination resolves to something that exists"
    continue
  fi
  pass "$destination linked through the alias"
done
check "linux links the control-based keybindings" \
  test "$(readlink "$codiumUserDirectory/keybindings.json")" \
    = "$sandbox/.dotfiles/vscodium/keybindings.json"

check "the displaced settings.json was backed up" \
  test -f "$codiumUserDirectory/settings.json.pre-dotfiles.bak"
check "the backup keeps the old content" \
  grep -q 'pre-existing editor settings' "$codiumUserDirectory/settings.json.pre-dotfiles.bak"

check "every extension the list names but the machine lacks is installed once" \
  test "$(countLogLines '^codium --install-extension ')" -eq "$((wantedExtensionCount - 1))"
check "an extension already installed is left alone" \
  logLacks "--install-extension aaron-bond.better-comments"
check "exact sync uninstalls an extension the list does not name" \
  logHas "--uninstall-extension nosuch.extension"
check "the uninstalled extension is gone from the machine" \
  bash -c '! grep -qx "nosuch.extension" "$1"' _ "$installedExtensionsFile"
check "exact sync keeps an unpublished extension the list does not name" \
  logLacks "--uninstall-extension someone.unpublished-tool"
check "the unpublished extension is still on the machine" \
  grep -qx 'someone.unpublished-tool' "$installedExtensionsFile"
check "a multiline private property is parsed as unpublished" \
  logLacks "--uninstall-extension someone.unpublished-tool"
check "keeping an unpublished extension is a note, not a warning" \
  outputMatches "$firstRunOutput" '\[ -- \].*someone.unpublished-tool.*unpublished'
check "a retired extension that is present is uninstalled" \
  logHas "--uninstall-extension $retiredExtensionName"
check "the list names no extension no marketplace serves" \
  bash -c '! grep -qx "johnwaters.glimmervoid-visions" "$1"' _ "$topicDir/extensions.txt"
check "the vsix install nobody can automate is written down" \
  grep -q 'install-extension <path>.vsix' "$repoRoot/README.md"

check "no command was refused for reaching outside the stubs" logLacks "sudo refused"

: > "$commandLog"
secondRunOutput="$(runInstall)"
check "second run reports no changes" reportsNoChanges "$secondRunOutput"
check "second run installs no extension" logLacks "--install-extension"
check "second run uninstalls no extension" logLacks "--uninstall-extension"
check "a retired extension that is absent is left alone" \
  outputMatches "$secondRunOutput" '\[ -- \].*extension removals.*none present'
check "second run downloads nothing" logLacks "curl"
check "second run installs no package" logLacks "apt-get"

printf 'nosuch.extension\n' >> "$installedExtensionsFile"
: > "$commandLog"
additiveRunStatus=0
additiveRunOutput="$(runInstall work)" || additiveRunStatus=$?
check "a profile that syncs additively exits clean" test "$additiveRunStatus" -eq 0
check "additive sync keeps an extension the list does not name" logLacks "--uninstall-extension"
check "additive sync says what it kept" outputHas "$additiveRunOutput" 'kept (additive sync)'

check "the kept extension is still on the machine" \
  grep -qx "nosuch.extension" "$installedExtensionsFile"

unreadableManifestName="someone.unreadable-manifest"
unreadableManifestDirectory="$sandbox/.vscode-oss/extensions/$unreadableManifestName-2.0.0"
mkdir -p "$unreadableManifestDirectory"
printf '{ "name": "%s", "private" }\n' "$unreadableManifestName" \
  > "$unreadableManifestDirectory/package.json"
printf '%s\n' "$unreadableManifestName" >> "$installedExtensionsFile"
: > "$commandLog"
unreadableManifestStatus=0
unreadableManifestOutput="$(runInstall)" || unreadableManifestStatus=$?
check "an extension whose manifest will not parse is never uninstalled" \
  logLacks "--uninstall-extension $unreadableManifestName"
check "a manifest that will not parse is reported as unread, not as published" \
  outputMatches "$unreadableManifestOutput" "\\[warn\\].*$unreadableManifestName.*could not be read"
check "an unreadable manifest makes the topic exit non-zero" \
  test "$unreadableManifestStatus" -eq 1
check "the extension with an unreadable manifest is still on the machine" \
  grep -qx "$unreadableManifestName" "$installedExtensionsFile"
removeMatchingLines "^$unreadableManifestName\$" "$installedExtensionsFile"
rm -rf -- "$unreadableManifestDirectory"

nestedProfile="$repoRoot/profiles/nested-vscodium"
mkdir -p "$nestedProfile"
removeNestedProfile() {
  rm -rf -- "$nestedProfile"
}
registerCleanup removeNestedProfile
printf '{ "nested": { "extensionSync": "exact" } }\n' > "$nestedProfile/vscodium.json"
printf '%s\n' 'strayextension.nested-setting' >> "$installedExtensionsFile"
installedExtensionManifest "strayextension.nested-setting-1.0.0" false
: > "$commandLog"
nestedStatus=0
nestedOutput="$(runInstall nested-vscodium)" || nestedStatus=$?
check "a nested extensionSync is not read as a top level setting" \
  outputMatches "$nestedOutput" '\[warn\].*no readable extensionSync'
check "a nested extensionSync makes the topic exit non-zero" test "$nestedStatus" -eq 1
check "a nested extensionSync prunes nothing" \
  logLacks "--uninstall-extension strayextension.nested-setting"
check "the extension survives a nested exact value" \
  grep -qx 'strayextension.nested-setting' "$installedExtensionsFile"

printf '%s\n' 'someone.fallback-private' >> "$installedExtensionsFile"
installedExtensionManifest "someone.fallback-private-1.0.0" false
withdrawCommand node
: > "$commandLog"
noNodeOutput="$(runInstall)" || true
check "a manifest no node read is never pruned as published" \
  logLacks "--uninstall-extension someone.fallback-private"
check "a manifest no node read is reported as unread" \
  outputMatches "$noNodeOutput" '\[warn\].*someone.fallback-private.*could not be read'
check "the extension whose manifest went unread is left installed" \
  grep -qx 'someone.fallback-private' "$installedExtensionsFile"
provideCommand node

unparseableProfile="$repoRoot/profiles/unparseable-vscodium"
mkdir -p "$unparseableProfile"
removeUnparseableProfile() {
  rm -rf -- "$unparseableProfile"
}
registerCleanup removeUnparseableProfile
printf '{ "extensionSync": }\n' > "$unparseableProfile/vscodium.json"
printf '%s\n' 'strayextension.that-is-not-listed' >> "$installedExtensionsFile"
installedExtensionManifest "strayextension.that-is-not-listed-1.0.0" false
: > "$commandLog"
unparseableStatus=0
unparseableOutput="$(runInstall unparseable-vscodium)" || unparseableStatus=$?
check "an unparseable extensionSync warns" \
  outputMatches "$unparseableOutput" '\[warn\].*no readable extensionSync'
check "an unparseable extensionSync makes the topic exit non-zero" test "$unparseableStatus" -eq 1
check "an unparseable extensionSync prunes nothing" logLacks "--uninstall-extension"
check "an unparseable extensionSync leaves the extra extension installed" \
  grep -qx 'strayextension.that-is-not-listed' "$installedExtensionsFile"

trailingCommaProfile="$repoRoot/profiles/trailing-comma-vscodium"
mkdir -p "$trailingCommaProfile"
removeTrailingCommaProfile() {
  rm -rf -- "$trailingCommaProfile"
}
registerCleanup removeTrailingCommaProfile
printf '{ "extensionSync": "exact", }\n' > "$trailingCommaProfile/vscodium.json"
: > "$commandLog"
trailingCommaStatus=0
trailingCommaOutput="$(runInstall trailing-comma-vscodium)" || trailingCommaStatus=$?
check "a trailing comma is not read as exact sync" \
  outputMatches "$trailingCommaOutput" '\[warn\].*no readable extensionSync'
check "a trailing comma makes the topic exit non-zero" test "$trailingCommaStatus" -eq 1
check "a trailing comma prunes nothing" logLacks "--uninstall-extension"
check "a trailing comma leaves the extra extension installed" \
  grep -qx 'strayextension.that-is-not-listed' "$installedExtensionsFile"

unknownModeProfile="$repoRoot/profiles/unknown-mode-vscodium"
mkdir -p "$unknownModeProfile"
removeUnknownModeProfile() {
  rm -rf -- "$unknownModeProfile"
}
registerCleanup removeUnknownModeProfile
printf '{ "extensionSync": "prune-everything" }\n' > "$unknownModeProfile/vscodium.json"
: > "$commandLog"
unknownModeStatus=0
unknownModeOutput="$(runInstall unknown-mode-vscodium)" || unknownModeStatus=$?
check "an extensionSync value this topic does not know warns" \
  outputMatches "$unknownModeOutput" '\[warn\].*extensionSync to prune-everything'
check "an unknown extensionSync makes the topic exit non-zero" test "$unknownModeStatus" -eq 1
check "an unknown extensionSync prunes nothing" logLacks "--uninstall-extension"
check "an unknown extensionSync leaves the extra extension installed" \
  grep -qx 'strayextension.that-is-not-listed' "$installedExtensionsFile"

noProfileFileProfile="$repoRoot/profiles/no-vscodium-file"
mkdir -p "$noProfileFileProfile"
removeNoProfileFileProfile() {
  rm -rf -- "$noProfileFileProfile"
}
registerCleanup removeNoProfileFileProfile
: > "$commandLog"
noProfileFileStatus=0
runInstall no-vscodium-file > /dev/null || noProfileFileStatus=$?
check "a profile with no vscodium.json exits clean" test "$noProfileFileStatus" -eq 0
check "a profile with no vscodium.json still prunes" logHas "--uninstall-extension"
check "the extra extension is gone under the default mode" \
  bash -c '! grep -qx "strayextension.that-is-not-listed" "$1"' _ "$installedExtensionsFile"

# A vsix installed outside the extensions directory has no manifest to read, and pruning it is not reversible by rerunning this topic.
manifestlessExtensionName="someone.no-manifest-anywhere"
printf '%s\n' "$manifestlessExtensionName" >> "$installedExtensionsFile"
: > "$commandLog"
manifestlessStatus=0
manifestlessOutput="$(runInstall no-vscodium-file)" || manifestlessStatus=$?
check "an extension with no manifest to read is never pruned as published" \
  logLacks "--uninstall-extension $manifestlessExtensionName"
check "an extension with no manifest is reported as unread" \
  outputMatches "$manifestlessOutput" "\\[warn\\].*$manifestlessExtensionName.*could not be read"
check "an extension with no manifest makes the topic exit non-zero" \
  test "$manifestlessStatus" -eq 1
check "the extension with no manifest is still on the machine" \
  grep -qx "$manifestlessExtensionName" "$installedExtensionsFile"
removeMatchingLines "^$manifestlessExtensionName\$" "$installedExtensionsFile"

listingFailureExtension="someone.listed-only-when-codium-answers"
printf '%s\n' "$listingFailureExtension" >> "$installedExtensionsFile"
touch "$stubState/list-extensions-fails"
: > "$commandLog"
listingFailureStatus=0
listingFailureOutput="$(runInstall no-vscodium-file)" || listingFailureStatus=$?
check "a listing that failed is reported rather than read as an empty machine" \
  outputMatches "$listingFailureOutput" '\[warn\].*list-extensions failed'
check "a listing that failed makes the topic exit non-zero" test "$listingFailureStatus" -eq 1
check "a listing that failed reinstalls nothing" logLacks "--install-extension"
check "a listing that failed prunes nothing" logLacks "--uninstall-extension"
check "the extension the failed listing never saw is still on the machine" \
  grep -qx "$listingFailureExtension" "$installedExtensionsFile"
rm -f "$stubState/list-extensions-fails"
removeMatchingLines "^$listingFailureExtension\$" "$installedExtensionsFile"

rm -f "$stubBin/codium"
touch "$stubState/apt-install-fails"
: > "$commandLog"
failedInstallStatus=0
failedInstallOutput="$(runInstall)" || failedInstallStatus=$?
check "a failed .deb install warns" test "$failedInstallStatus" -eq 1
check "the warning carries the reason apt-get gave" \
  outputHas "$failedInstallOutput" 'Unable to locate the package this run needed'
rm -f "$stubState/apt-install-fails"
provideCommand codium
: > "$commandLog"
runInstall > /dev/null || true

rm -f "$codiumUserDirectory/settings.json" "$codiumUserDirectory/keybindings.json" \
  "$codiumUserDirectory/mcp.json"
withdrawCommand codium
withdrawCommand apt-get
withdrawCommand curl
provideCommand dnf
: > "$commandLog"
noCodiumStatus=0
noCodiumOutput="$(runInstall)" || noCodiumStatus=$?
check "a machine with no VSCodium package is pointed at the manual install" \
  outputHas "$noCodiumOutput" 'https://vscodium.com/#install'
check "a machine without codium warns instead of syncing extensions" \
  outputHas "$noCodiumOutput" 'not on PATH, skipping extensions'
check "a machine without codium runs no extension command" logLacks "codium "
check "the warnings still make the topic exit non-zero" test "$noCodiumStatus" -eq 1
for destination in "${linkedDestinations[@]}"; do
  check "$destination is still linked without codium" test -L "$sandbox/$destination"
done

runInstallWithoutProfile() {
  runInStubbedSandbox "$sandbox" \
    TMPDIR="$sandboxTemp" \
    DOTFILES_PROFILE="" \
    GITHUB_TOKEN="$probeGitHubToken" \
    DOTFILES_TEST_REAL_NODE="$realNodePath" \
    NO_COLOR=1 \
    bash "$topicDir/install.sh"
}

provideCommand codium
printf '%s\n' 'strayextension.with-no-profile-resolved' >> "$installedExtensionsFile"
: > "$commandLog"
noProfileStatus=0
noProfileOutput="$(runInstallWithoutProfile)" || noProfileStatus=$?
check "a run with no profile resolved says so" \
  outputMatches "$noProfileOutput" '\[warn\].*no profile resolved'
check "a run with no profile resolved prunes nothing" logLacks "--uninstall-extension"
check "the extra extension survives a run with no profile resolved" \
  grep -qx 'strayextension.with-no-profile-resolved' "$installedExtensionsFile"
check "a run with no profile resolved exits non-zero" test "$noProfileStatus" -eq 1

darwinApplicationsDirectory="$sandbox/Applications"
darwinCodiumDirectory="$darwinApplicationsDirectory/VSCodium.app/Contents/Resources/app/bin"
darwinUserDirectory="$sandbox/Library/Application Support/VSCodium/User"
writeStub brew <<'STUB'
#!/usr/bin/env bash
printf 'brew %s\n' "$*" >> "$DOTFILES_TEST_LOG"
mkdir -p "$DOTFILES_TEST_APPLICATIONS_DIRECTORY/VSCodium.app/Contents/Resources/app/bin"
cp "$DOTFILES_TEST_STATE/available/codium" \
  "$DOTFILES_TEST_APPLICATIONS_DIRECTORY/VSCodium.app/Contents/Resources/app/bin/codium"
STUB
writeStub dscl <<STUB
#!/usr/bin/env bash
printf 'dscl %s\n' "\$*" >> "\$DOTFILES_TEST_LOG"
printf 'NFSHomeDirectory: %s\n' "$realHome"
STUB
provideCommand brew
provideCommand dscl
withdrawCommand codium
: > "$commandLog"
darwinStatus=0
darwinOutput="$(runInStubbedSandbox "$sandbox" TMPDIR="$sandboxTemp" DOTFILES_PLATFORM=darwin DOTFILES_TEST_HOMEBREW_PREFIX="$sandbox/homebrew" \
  DOTFILES_TEST_APPLICATIONS_DIRECTORY="$darwinApplicationsDirectory" \
  DOTFILES_PROFILE=work GITHUB_TOKEN="$probeGitHubToken" DOTFILES_TEST_REAL_NODE="$realNodePath" \
  NO_COLOR=1 bash "$topicDir/install.sh")" || darwinStatus=$?
check "darwin installs and configures VSCodium cleanly" test "$darwinStatus" -eq 0
check "darwin installs VSCodium as a Homebrew cask" logHas 'brew install --cask vscodium'
check "darwin does not run Homebrew through sudo" logLacks 'sudo '
check "darwin uses the CLI inside the application bundle" logHas 'codium --list-extensions'
for configurationFile in settings.json keybindings.json mcp.json; do
  check "darwin links $configurationFile into Application Support" \
    test -L "$darwinUserDirectory/$configurationFile"
done
check "work owns VSCodium MCP configuration" \
  test "$(readlink "$darwinUserDirectory/mcp.json")" = "$sandbox/.dotfiles/profiles/work/vscodium-mcp.json"
check "darwin links the command-based keybindings" \
  test "$(readlink "$darwinUserDirectory/keybindings.json")" \
    = "$sandbox/.dotfiles/vscodium/keybindings.darwin.json"
check "darwin reports no missing codium CLI" outputLacks "$darwinOutput" 'not on PATH'
checkRerunIsQuiet "a darwin rerun reports no config changes" \
  "$(runInStubbedSandbox "$sandbox" TMPDIR="$sandboxTemp" DOTFILES_PLATFORM=darwin DOTFILES_TEST_HOMEBREW_PREFIX="$sandbox/homebrew" \
    DOTFILES_TEST_APPLICATIONS_DIRECTORY="$darwinApplicationsDirectory" \
    DOTFILES_PROFILE=work GITHUB_TOKEN="$probeGitHubToken" DOTFILES_TEST_REAL_NODE="$realNodePath" \
    NO_COLOR=1 bash "$topicDir/install.sh")"

installedExtensionManifest "strayextension.with-no-profile-resolved-1.0.0" false

check "personal editor convergence succeeds" runInStubbedSandbox "$sandbox" TMPDIR="$sandboxTemp" DOTFILES_PLATFORM=darwin DOTFILES_TEST_HOMEBREW_PREFIX="$sandbox/homebrew" \
  DOTFILES_TEST_APPLICATIONS_DIRECTORY="$darwinApplicationsDirectory" \
  DOTFILES_PROFILE=personal GITHUB_TOKEN="$probeGitHubToken" DOTFILES_TEST_REAL_NODE="$realNodePath" \
  NO_COLOR=1 bash "$topicDir/install.sh"
check "personal retires the work MCP link" test ! -L "$darwinUserDirectory/mcp.json"
printf '{"servers":{"foreign":{}}}\n' > "$darwinUserDirectory/mcp.json"
check "personal editor convergence succeeds" runInStubbedSandbox "$sandbox" TMPDIR="$sandboxTemp" DOTFILES_PLATFORM=darwin DOTFILES_TEST_HOMEBREW_PREFIX="$sandbox/homebrew" \
  DOTFILES_TEST_APPLICATIONS_DIRECTORY="$darwinApplicationsDirectory" \
  DOTFILES_PROFILE=personal GITHUB_TOKEN="$probeGitHubToken" DOTFILES_TEST_REAL_NODE="$realNodePath" \
  NO_COLOR=1 bash "$topicDir/install.sh"
check "personal preserves foreign MCP configuration" grep -q foreign "$darwinUserDirectory/mcp.json"

reportTopicResults "vscodium"
