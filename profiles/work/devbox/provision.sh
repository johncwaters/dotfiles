#!/usr/bin/env bash
set -euo pipefail

glimmervoidVersion="latest"
devboxAction="${1:-provision}"
devboxWorkspaceDomain="${2:-}"
export PATH="$HOME/.glimmervoid/bin:$HOME/.local/bin:$PATH"
glimmervoidDirectory="$HOME/.glimmervoid"
glimmervoidBinaryPath="$glimmervoidDirectory/bin/glimmervoid"
glimmervoidReleasesUrl="https://github.com/johncwaters/glimmervoid/releases"
hasUpdatedApt=0
hasFailedGlimmervoidInstall=0
devboxFallbackReleaseStatus=75
devboxPublicHostName=""

reportDevboxItem() {
  printf '[%s] %s: %s\n' "$1" "$2" "$3"
}

devboxPublicHost() {
  printf '3457--%s--%s--%s.%s' \
    "${CODER_WORKSPACE_AGENT_NAME:?missing Coder agent name}" \
    "${CODER_WORKSPACE_NAME:?missing Coder workspace name}" \
    "${CODER_WORKSPACE_OWNER_NAME:?missing Coder owner name}" \
    "${devboxWorkspaceDomain:?missing Coder workspace domain}"
}

requireDevboxPublicHost() {
  if devboxPublicHostName="$(devboxPublicHost)"; then
    return 0
  fi
  reportDevboxItem warned "devbox host" "Coder workspace variables missing; nothing changed"
  exit 1
}

holdDevboxProvisionLock() {
  mkdir -p -m 700 "$glimmervoidDirectory"
  exec 9>> "$glimmervoidDirectory/provision.lock"
  local lockStatus=0
  flock -w 120 9 || lockStatus=$?
  if ((lockStatus == 0)); then
    return 0
  fi
  if ((lockStatus == 1)); then
    reportDevboxItem warned provision "another run is in progress"
    exit 1
  fi
  reportDevboxItem warned provision "cannot take ~/.glimmervoid/provision.lock; flock exited $lockStatus"
  exit 1
}

linkDevboxTemplateRepository() {
  local projectPath="$HOME/Projects/posthog"
  if [[ -e "$projectPath" || -L "$projectPath" || ! -d "$HOME/posthog" ]]; then
    return 0
  fi
  mkdir -p -- "$HOME/Projects"
  ln -s -- "$HOME/posthog" "$projectPath"
  reportDevboxItem installed "posthog project" "linked to template checkout"
}

syncDevboxRepositories() {
  local dotfilesAlias="$HOME/.dotfiles"
  local syncLog="$HOME/.local/state/dotfiles/devbox-repos.log"
  if [[ ! -f "$dotfilesAlias/repos/install.sh" || ! -f "$dotfilesAlias/profiles/work-server/repos.txt" ]]; then
    return 0
  fi
  linkDevboxTemplateRepository
  mkdir -p -- "${syncLog%/*}"
  touch "$syncLog"
  chmod 600 "$syncLog"
  if DOTFILES_PROFILE=work-server bash "$dotfilesAlias/repos/install.sh" > "$syncLog" 2>&1 < /dev/null 9>&-; then
    reportDevboxItem present repos "synced"
    return 0
  fi
  reportDevboxItem warned repos "sync failed; retried next run; see $syncLog"
  return 1
}

devboxWorkbenchStateDirectory="$HOME/.local/state/dotfiles/devbox-workbench"
devboxWorkbenchLog="$HOME/.local/state/dotfiles/devbox-workbench.log"
devboxWorkbenchFailedBuildRetryMinutes="${DEVBOX_WORKBENCH_FAILED_BUILD_RETRY_MINUTES:-360}"

installDevboxPhrocs() {
  if command -v phrocs >/dev/null 2>&1; then
    reportDevboxItem present phrocs "on PATH"
    return 0
  fi
  local checksumVerifyingInstallerFromTemplateCheckout="$HOME/posthog/tools/phrocs/install.sh"
  if [[ -f "$checksumVerifyingInstallerFromTemplateCheckout" ]] \
    && bash "$checksumVerifyingInstallerFromTemplateCheckout" >> "$devboxWorkbenchLog" 2>&1 < /dev/null 9>&- \
    && command -v phrocs >/dev/null 2>&1; then
    reportDevboxItem installed phrocs "checksum-verified release"
    return 0
  fi
  reportDevboxItem warned phrocs "install from ~/posthog/tools/phrocs/install.sh failed; see ~/.local/state/dotfiles/devbox-workbench.log"
}

installDevboxPnpm() {
  if command -v pnpm >/dev/null 2>&1; then
    reportDevboxItem present pnpm "on PATH"
    return 0
  fi
  if npm install -g --prefix "$HOME/.local" pnpm@10 >> "$devboxWorkbenchLog" 2>&1 < /dev/null 9>&-; then
    reportDevboxItem installed pnpm "on PATH"
    return 0
  fi
  reportDevboxItem warned pnpm "install failed; workbench builds skipped; see ~/.local/state/dotfiles/devbox-workbench.log"
  return 1
}

writeDevboxWorkbenchGatewayToken() {
  local tokenPath="$HOME/.config/posthog/wizard-gateway-token"
  local stagedTokenPath
  mkdir -p -m 700 -- "${tokenPath%/*}"
  stagedTokenPath="$(mktemp "${tokenPath%/*}/.wizard-gateway-token.XXXXXX")"
  printf '%s' "$WIZARD_WORKBENCH_GATEWAY_TOKEN" > "$stagedTokenPath"
  if cmp -s "$stagedTokenPath" "$tokenPath"; then
    rm -f -- "$stagedTokenPath"
    chmod 600 "$tokenPath"
    reportDevboxItem present "wizard gateway token" "current"
    return 0
  fi
  chmod 600 "$stagedTokenPath"
  mv -f -- "$stagedTokenPath" "$tokenPath"
  reportDevboxItem installed "wizard gateway token" "written from WIZARD_WORKBENCH_GATEWAY_TOKEN"
}

writeDevboxWorkbenchEnvironmentFile() {
  local environmentPath="$HOME/Projects/wizard-workbench/.env"
  if [[ -e "$environmentPath" || -L "$environmentPath" ]]; then
    reportDevboxItem present "workbench .env" "kept as is"
    return 0
  fi
  local stagedEnvironmentPath
  stagedEnvironmentPath="$(mktemp "$devboxWorkbenchStateDirectory/.env.XXXXXX")"
  cat > "$stagedEnvironmentPath" <<ENVIRONMENT
CONTEXT_MILL_PATH=$HOME/Projects/context-mill
COMMANDMENTS_PATH=$HOME/Projects/context-mill/context/commandments.yaml
WIZARD_PATH=$HOME/Projects/wizard
MCP_PATH=$HOME/posthog/services/mcp
POSTHOG_PERSONAL_API_KEY=$WIZARD_WORKBENCH_POSTHOG_API_KEY
POSTHOG_REGION=us
POSTHOG_WIZARD_PROJECT_ID=483112
POSTHOG_WIZARD_LOCAL_CONTEXT_MILL=true
WIZARD_CI_GATEWAY_TOKEN_FILE=$HOME/.config/posthog/wizard-gateway-token
ENVIRONMENT
  chmod 600 "$stagedEnvironmentPath"
  mv -f -- "$stagedEnvironmentPath" "$environmentPath"
  reportDevboxItem installed "workbench .env" "written from WIZARD_WORKBENCH_POSTHOG_API_KEY"
}

writeDevboxWorkbenchSecrets() {
  local missingSecretNames=()
  if [[ -z "${WIZARD_WORKBENCH_POSTHOG_API_KEY:-}" ]]; then missingSecretNames+=(WIZARD_WORKBENCH_POSTHOG_API_KEY); fi
  if [[ -z "${WIZARD_WORKBENCH_GATEWAY_TOKEN:-}" ]]; then missingSecretNames+=(WIZARD_WORKBENCH_GATEWAY_TOKEN); fi
  if ((${#missingSecretNames[@]} > 0)); then
    reportDevboxItem warned "workbench secrets" "${missingSecretNames[*]} not set; nothing written; on the laptop run hogli devbox:secret:set NAME --file PATH for each, restart the workspace, then rerun"
    return 0
  fi
  writeDevboxWorkbenchGatewayToken
  writeDevboxWorkbenchEnvironmentFile
}

buildDevboxWorkbenchRepository() {
  local repositoryName="$1"
  local buildCommand="$2"
  local repositoryPath="$HOME/Projects/$repositoryName"
  local builtCommitPath="$devboxWorkbenchStateDirectory/$repositoryName.built"
  local headCommit builtRecord
  headCommit="$(git -C "$repositoryPath" rev-parse HEAD 2>/dev/null)" || headCommit=""
  if [[ -z "$headCommit" ]]; then
    reportDevboxItem warned "$repositoryName build" "~/Projects/$repositoryName is not cloned; retried next run"
    return 0
  fi
  builtRecord="$(cat "$builtCommitPath" 2>/dev/null)" || builtRecord=""
  if [[ -d "$repositoryPath/node_modules" && "$builtRecord" == "$headCommit" ]]; then
    reportDevboxItem present "$repositoryName build" "${headCommit:0:12}"
    return 0
  fi
  local failedBuildWarning="$buildCommand failed; retried on a new commit or after $devboxWorkbenchFailedBuildRetryMinutes minutes; see ~/.local/state/dotfiles/devbox-workbench.log"
  local failedBuildRecord="failed $headCommit $buildCommand"
  if [[ "$builtRecord" == "$failedBuildRecord" && -n "$(find "$builtCommitPath" -mmin "-$devboxWorkbenchFailedBuildRetryMinutes" 2>/dev/null)" ]]; then
    reportDevboxItem warned "$repositoryName build" "$failedBuildWarning"
    return 0
  fi
  if (cd -- "$repositoryPath" && bash -c "$buildCommand") >> "$devboxWorkbenchLog" 2>&1 < /dev/null 9>&-; then
    printf '%s\n' "$headCommit" > "$builtCommitPath"
    reportDevboxItem installed "$repositoryName build" "${headCommit:0:12}"
    return 0
  fi
  printf '%s\n' "$failedBuildRecord" > "$builtCommitPath"
  reportDevboxItem warned "$repositoryName build" "$failedBuildWarning"
}

installDevboxWizardWorkbench() {
  if [[ ! -d "$HOME/Projects/wizard-workbench/.git" ]]; then
    return 0
  fi
  mkdir -p -m 700 -- "$devboxWorkbenchStateDirectory"
  touch "$devboxWorkbenchLog"
  chmod 600 "$devboxWorkbenchLog"
  installDevboxPhrocs
  writeDevboxWorkbenchSecrets
  installDevboxPnpm || return 0
  local wizardCiBuildThatAcceptsRunnerLocalFlags='pnpm install --frozen-lockfile && pnpm build:ci'
  buildDevboxWorkbenchRepository wizard-workbench 'pnpm install --frozen-lockfile'
  buildDevboxWorkbenchRepository wizard "$wizardCiBuildThatAcceptsRunnerLocalFlags"
  buildDevboxWorkbenchRepository context-mill 'pnpm install --frozen-lockfile && pnpm run build'
}

devboxPathsResolveAlike() {
  local firstResolvedPath secondResolvedPath
  firstResolvedPath="$(cd -- "$1" 2>/dev/null && pwd -P)" || return 1
  secondResolvedPath="$(cd -- "$2" 2>/dev/null && pwd -P)" || return 1
  [[ "$firstResolvedPath" == "$secondResolvedPath" ]]
}

returnDevboxCheckoutToMain() {
  local clonePath="$1" strayBranch
  strayBranch="$(git -C "$clonePath" branch --show-current 2>/dev/null)" || return 0
  [[ -n "$strayBranch" && "$strayBranch" != main ]] || return 0
  [[ -z "$(git -C "$clonePath" status --porcelain 2>/dev/null)" ]] || return 0
  # bin/dot fetches only after its mainline guard, so a merged branch would otherwise stay stuck behind a stale origin/main.
  git -C "$clonePath" fetch --quiet origin 2>/dev/null || true
  git -C "$clonePath" merge-base --is-ancestor HEAD origin/main 2>/dev/null || return 0
  git -C "$clonePath" switch --quiet main 2>/dev/null || return 0
  reportDevboxItem installed dotfiles "left $strayBranch for main; it held no commits beyond origin/main"
}


installDevboxDotfiles() (
  clonePath="$HOME/Projects/dotfiles"
  dotfilesAlias="$HOME/.dotfiles"
  bootstrapLog="$HOME/.local/state/dotfiles/devbox-bootstrap.log"
  convergedRecord="${XDG_STATE_HOME:-$HOME/.local/state}/dotfiles/converged"
  holdDevboxProvisionLock
  reportFailedDevboxDotfiles() {
    if (($? == 0)); then
      return 0
    fi
    reportDevboxItem warned dotfiles "clone or converge failed; retried next run; see $bootstrapLog"
  }
  trap reportFailedDevboxDotfiles EXIT
  umask 077
  mkdir -p -- "${bootstrapLog%/*}"
  touch "$bootstrapLog"
  chmod 600 "$bootstrapLog"
  if [[ ! -d "$clonePath/.git" ]]; then
    mkdir -p -- "${clonePath%/*}"
    git clone --quiet -- https://github.com/johncwaters/dotfiles.git "$clonePath" >> "$bootstrapLog" 2>&1 < /dev/null
  fi
  returnDevboxCheckoutToMain "$clonePath" < /dev/null
  if devboxPathsResolveAlike "$dotfilesAlias" "$clonePath" && bash "$clonePath/bin/dot" status > /dev/null 2>&1 < /dev/null; then
    reportDevboxItem present dotfiles "$(git -C "$clonePath" rev-parse HEAD)"
    return 0
  fi
  if [[ -L "$dotfilesAlias" ]] && ! devboxPathsResolveAlike "$dotfilesAlias" "$clonePath"; then
    rm -f -- "$dotfilesAlias"
  fi
  linkDevboxTemplateRepository
  local recordBeforeConverge recordAfterConverge convergeOutcome
  recordBeforeConverge="$(cat "$convergedRecord" 2>/dev/null || true)"
  mkdir -p -- "$HOME/.local/lib/node_modules"
  # The server launch PATH carries ~/.local/bin, not ~/.npm-global/bin, so npm globals install there.
  PATH="/tmp/coder-script-data/bin:$HOME/.local/bin:$PATH" DOTFILES_REQUIRE_ORIGIN=1 NPM_CONFIG_PREFIX="$HOME/.local" \
    bash "$clonePath/bin/dot" --profile work-server >> "$bootstrapLog" 2>&1 < /dev/null 9>&-
  recordAfterConverge="$(cat "$convergedRecord" 2>/dev/null || true)"
  convergeOutcome="$(awk '{ print $4 }' <<< "$recordAfterConverge")"
  if [[ "$recordAfterConverge" == "$recordBeforeConverge" ]]; then
    convergeOutcome=""
  fi
  if [[ "$convergeOutcome" != "clean" ]]; then
    reportDevboxItem warned dotfiles "work-server converge ${convergeOutcome:-left no new converge record}; retried next run; see $bootstrapLog"
    return 0
  fi
  reportDevboxItem installed dotfiles "$(git -C "$clonePath" rev-parse HEAD); work-server converged"
)

devboxPortListens() {
  (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null
}

installDevboxAptPackages() {
  if ((hasUpdatedApt == 0)); then
    sudo -n apt-get update >> "$glimmervoidDirectory/provision.log" 2>&1 || return
    hasUpdatedApt=1
  fi
  sudo -n apt-get install -y "$@" >> "$glimmervoidDirectory/provision.log" 2>&1
}

installDevboxNode() {
  if command -v node >/dev/null 2>&1 && node -e '
    const [major, minor] = process.versions.node.split(".").map(Number);
    process.exit(major > 22 || (major === 22 && minor >= 18) ? 0 : 1);
  '; then
    reportDevboxItem present Node "$(node --version)"
    return 0
  fi
  local nodeSetupPath
  nodeSetupPath="$(mktemp "$glimmervoidDirectory/.nodesource.XXXXXX")"
  curl -fsSL https://deb.nodesource.com/setup_22.x -o "$nodeSetupPath"
  sudo -n bash "$nodeSetupPath" >> "$glimmervoidDirectory/provision.log" 2>&1
  rm -f "$nodeSetupPath"
  installDevboxAptPackages nodejs
  reportDevboxItem installed Node "$(node --version)"
}

# Only the release binary counts, so the retired npm copy at the same version never passes for installed.
installedDevboxGlimmervoidVersion() {
  if [[ -x "$glimmervoidBinaryPath" ]]; then
    "$glimmervoidBinaryPath" --version
  fi
}

devboxGlimmervoidMeetsMinimum() {
  node -e '
    const parseVersion = text => /^(\d+)\.(\d+)\.(\d+)(?:-([^+]+))?(?:\+.*)?$/.exec(text.trim());
    const installed = parseVersion(process.argv[1]);
    const minimum = parseVersion(process.argv[2]);
    if (!installed || !minimum) process.exit(1);
    for (let index = 1; index <= 3; index++) {
      if (+installed[index] > +minimum[index]) process.exit(0);
      if (+installed[index] < +minimum[index]) process.exit(1);
    }
    process.exit(installed[4] ? 1 : 0);
  ' "$1" "$glimmervoidVersion"
}

resolveDevboxLatestGlimmervoid() {
  [[ "$glimmervoidVersion" == latest ]] || return 0
  local latestReleaseUrl latestVersion
  latestReleaseUrl="$(curl -fsSL -o /dev/null -w '%{url_effective}' "$glimmervoidReleasesUrl/latest" 2>> "$glimmervoidDirectory/provision.log")" || latestReleaseUrl=""
  latestVersion="${latestReleaseUrl##*/tag/v}"
  [[ "$latestVersion" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || return 1
  glimmervoidVersion="$latestVersion"
}

installDevboxGlimmervoidRelease() {
  local installerPath installerStatus=0
  installerPath="$(mktemp "$glimmervoidDirectory/.glimmervoid-installer.XXXXXX")"
  if ! curl -fsSL "$glimmervoidReleasesUrl/download/v$glimmervoidVersion/glimmervoid-installer.sh" -o "$installerPath" \
    >> "$glimmervoidDirectory/provision.log" 2>&1; then
    rm -f -- "$installerPath"
    return 1
  fi
  # Overrides cleared so an inherited install dir cannot divert the binary away from the path this script runs.
  GLIMMERVOID_INSTALL_DIR= CARGO_DIST_FORCE_INSTALL_DIR= GLIMMERVOID_UNMANAGED_INSTALL= GLIMMERVOID_NO_MODIFY_PATH=1 \
    sh "$installerPath" >> "$glimmervoidDirectory/provision.log" 2>&1 < /dev/null 9>&- || installerStatus=$?
  rm -f -- "$installerPath"
  return "$installerStatus"
}

devboxListenerPid() {
  ss -ltnp "sport = :$1" | sed -n 's/.*pid=\([0-9]*\).*/\1/p'
}

devboxProcessExecutable() {
  readlink -f "/proc/$1/exe"
}

# The binary relaunches through the PATH glimmervoid whose realpath is itself, so any other executable on 3456 is an npm server.
devboxListenerRunsReleaseBinary() {
  local listenerPid
  listenerPid="$(devboxListenerPid 3456)"
  [[ "$listenerPid" =~ ^[0-9]+$ ]] || return 1
  [[ "$(devboxProcessExecutable "$listenerPid")" == "$(readlink -f "$glimmervoidBinaryPath")" ]]
}

# A live npm server's hook relays resolve into its package directory, so it is only removed once no server runs from it.

installDevboxGlimmervoid() {
  local installedVersion keptVersion
  installedVersion="$(installedDevboxGlimmervoidVersion)"
  if ! resolveDevboxLatestGlimmervoid; then
    keptVersion="${installedVersion:-$(glimmervoid --version 2>/dev/null || true)}"
    if [[ -z "$keptVersion" ]]; then
      reportDevboxItem warned glimmervoid "cannot read the latest release from GitHub; nothing installed; see ~/.glimmervoid/provision.log"
      exit 1
    fi
    reportDevboxItem warned glimmervoid "cannot read the latest release from GitHub; keeping $keptVersion"
    return 0
  fi
  if devboxGlimmervoidMeetsMinimum "$installedVersion"; then
    reportDevboxItem present glimmervoid "$installedVersion"
    return 0
  fi
  if [[ -n "$installedVersion" ]] && devboxPortListens 3456; then
    reportDevboxItem warned glimmervoid "$installedVersion running, $glimmervoidVersion pending; run devbox restart-glimmervoid"
    return 0
  fi
  if installDevboxGlimmervoidRelease && [[ "$(installedDevboxGlimmervoidVersion)" == "$glimmervoidVersion" ]]; then
    reportDevboxItem installed glimmervoid "$glimmervoidVersion"
    return 0
  fi
  hasFailedGlimmervoidInstall=1
  local fallbackVersion
  fallbackVersion="$(glimmervoid --version 2>/dev/null)" || fallbackVersion=""
  if [[ -z "$fallbackVersion" ]]; then
    reportDevboxItem warned glimmervoid "install of $glimmervoidVersion failed; no previous version to start; see ~/.glimmervoid/provision.log"
    exit 1
  fi
  reportDevboxItem warned glimmervoid "install of $glimmervoidVersion failed; keeping installed $fallbackVersion instead; see ~/.glimmervoid/provision.log"
}






removeRetiredDevboxGhWrapper() {
  local wrapperPath="$HOME/.local/bin/gh"
  [[ -f "$wrapperPath" ]] || return 0
  case "$(cksum < "$wrapperPath")" in
    "4189254777 138" | "3555087348 1747" | "926693648 1876" | "3280277471 1956" | "2934243630 2011") ;;
    *) return 0 ;;
  esac
  rm -f "$wrapperPath"
  reportDevboxItem installed gh "retired Coder external auth wrapper removed"
}

installDevboxPersonalGitAuth() {
  mkdir -p "$HOME/.local/bin"
  local helperPath="$HOME/.local/bin/git-credential-personal"
  local stagedHelperPath
  stagedHelperPath="$(mktemp "$HOME/.local/bin/.git-credential-personal.XXXXXX")"
  cat > "$stagedHelperPath" <<'HELPER'
#!/usr/bin/env bash
set -euo pipefail
[[ "${1:-}" == get && -n "${GH_PERSONAL_TOKEN:-}" ]] || exit 0
protocol="" host="" repoPath=""
while IFS='=' read -r key value; do
  [[ -n "$key" ]] || break
  case "$key" in
    protocol) protocol="$value" ;;
    host) host="$value" ;;
    path) repoPath="$value" ;;
  esac
done
[[ "$protocol" == https && "$host" == github.com && "${repoPath,,}" == johncwaters/* ]] || exit 0
printf 'username=x-access-token\npassword=%s\n' "$GH_PERSONAL_TOKEN"
HELPER
  chmod 700 "$stagedHelperPath"
  if cmp -s "$helperPath" "$stagedHelperPath"; then
    rm -f "$stagedHelperPath"
  fi
  if [[ -f "$stagedHelperPath" ]]; then
    mv -f "$stagedHelperPath" "$helperPath"
  fi
  git config --global --replace-all credential.https://github.com/johncwaters/.helper ""
  git config --global --add credential.https://github.com/johncwaters/.helper "$helperPath"
  git config --global credential.https://github.com/johncwaters/.useHttpPath true
  if [[ -z "${GH_PERSONAL_TOKEN:-}" ]]; then
    reportDevboxItem warned "personal GitHub token" "GH_PERSONAL_TOKEN not set; johncwaters repos will 403"
  fi
  if [[ -n "${GH_PERSONAL_TOKEN:-}" ]]; then
    probeDevboxPersonalTokenDotfilesAccess
  fi
}

probeDevboxPersonalTokenDotfilesAccess() {
  local dotfilesStatusCode
  if ! dotfilesStatusCode="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 -H @- \
    https://api.github.com/repos/johncwaters/dotfiles 2>/dev/null <<< "Authorization: Bearer $GH_PERSONAL_TOKEN")"; then
    reportDevboxItem warned "personal GitHub token" "cannot reach GitHub to check dotfiles access"
    return 0
  fi
  case "$dotfilesStatusCode" in
    200) reportDevboxItem present "personal GitHub token" "can read johncwaters/dotfiles" ;;
    403 | 404) reportDevboxItem warned "personal GitHub token" "cannot read johncwaters/dotfiles; grant the fine-grained token Contents read and write on that repo" ;;
    *) reportDevboxItem warned "personal GitHub token" "dotfiles access check got HTTP $dotfilesStatusCode" ;;
  esac
}

devboxGitSupportsNoLazyFetch() {
  local gitVersionText
  gitVersionText="$(git --version 2>/dev/null)" || return 1
  [[ "$gitVersionText" =~ ([0-9]+)\.([0-9]+) ]] || return 1
  local majorVersion="${BASH_REMATCH[1]}"
  local minorVersion="${BASH_REMATCH[2]}"
  # GIT_NO_LAZY_FETCH, which docaudit sets, first shipped in git 2.45; noble ships 2.43.
  ((majorVersion > 2 || (majorVersion == 2 && minorVersion >= 45)))
}

installDevboxModernGit() {
  if devboxGitSupportsNoLazyFetch; then
    reportDevboxItem present git "$(git --version)"
    return 0
  fi
  if sudo -n add-apt-repository -y ppa:git-core/ppa >> "$glimmervoidDirectory/provision.log" 2>&1 \
    && installDevboxAptPackages git && devboxGitSupportsNoLazyFetch; then
    reportDevboxItem installed git "$(git --version)"
    return 0
  fi
  reportDevboxItem warned git "older than 2.45 and the git-core PPA install failed; see ~/.glimmervoid/provision.log"
}

installDevboxDocauditSchedule() {
  local docauditHome="$HOME/docaudit"
  if [[ ! -x "$docauditHome/run.sh" ]]; then
    return 0
  fi
  local currentCrontab
  currentCrontab="$(crontab -l 2>/dev/null)" || currentCrontab=""
  if grep -qF "docaudit/run.sh" <<< "$currentCrontab"; then
    reportDevboxItem present docaudit "cron entry"
    return 0
  fi
  local scheduleLine="0 15 * * 1-5 flock -n $docauditHome/.lock $docauditHome/run.sh >> $docauditHome/docaudit.log 2>&1"
  if { [[ -z "$currentCrontab" ]] || printf '%s\n' "$currentCrontab"; printf '%s\n' "$scheduleLine"; } | crontab -; then
    reportDevboxItem installed docaudit "cron entry, weekdays 15:00 UTC"
    return 0
  fi
  reportDevboxItem warned docaudit "could not write the cron entry"
}

installDevboxPrerequisites() {
  touch "$glimmervoidDirectory/provision.log"
  chmod 600 "$glimmervoidDirectory/provision.log"
  installDevboxNode
  installDevboxGlimmervoid
  removeRetiredDevboxGhWrapper
  installDevboxPersonalGitAuth
  installDevboxModernGit
  installDevboxDocauditSchedule
}

mergeDevboxConfig() {
  DEVBOX_CONFIG_MODE="$1" DEVBOX_PUBLIC_HOST="$2" node --input-type=module -e '
    import { createRequire } from "node:module";
    const require = createRequire(`${process.env.HOME}/.dotfiles/package.json`);
    const fs = require("node:fs");
    const path = require("node:path");
    const crypto = require("node:crypto");
    const { isDeepStrictEqual } = require("node:util");
    process.umask(0o077);
    const directory = path.join(process.env.HOME, ".glimmervoid");
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const configPath = path.join(directory, "config.json");
    const hasConfig = fs.existsSync(configPath);
    if (hasConfig && !fs.lstatSync(configPath).isFile()) throw new Error("config.json must be a regular file");
    const original = hasConfig ? fs.readFileSync(configPath, "utf8") : "{}";
    let config;
    try {
      config = JSON.parse(original);
    } catch {
      throw new Error("config.json is invalid JSON; left unchanged");
    }
    const parsedOriginal = structuredClone(config);
    if (!config || Array.isArray(config) || typeof config !== "object") throw new Error("config.json must contain an object");
    const settingsPath = path.join(process.env.HOME, ".dotfiles", "glimmervoid/settings.json");
    const syncPath = path.join(process.env.HOME, ".dotfiles", "glimmervoid/sync-settings.mjs");
    const settingsSync = await import(syncPath);
    const basePath = path.join(directory, "dotfiles-settings-base.json");
    const wanted = settingsSync.translateHome(settingsSync.settingsFrom(settingsSync.readJson(settingsPath)), process.env.HOME, "render");
    const settingsPlan = settingsSync.planApply(config, wanted, settingsSync.readJson(basePath));
    config = settingsPlan.config;
    if (process.env.DEVBOX_CONFIG_MODE === "check") process.exit(0);
    if (!Array.isArray(config.projects)) config.projects = [];
    if (!config.projects.some((project) => project?.path === "/home/coder/posthog")) {
      config.projects.push({ id: settingsSync.provisionerManagedProjectId, name: "posthog", path: "/home/coder/posthog" });
    }
    config.port = 3456;
    config.repoRoots = [path.join(process.env.HOME, "Projects")];
    config.remote = { port: 3457, publicHost: process.env.DEVBOX_PUBLIC_HOST, allowedOrigins: [`https://${process.env.DEVBOX_PUBLIC_HOST}`] };
    const merged = JSON.stringify(config, null, 2) + "\n";
    if (hasConfig && isDeepStrictEqual(parsedOriginal, config)) {
      fs.chmodSync(configPath, 0o600);
      settingsSync.writeJson(basePath, settingsPlan.base);
      console.log("[present] config: current; runtime records preserved");
      process.exit(0);
    }
    if (process.env.DEVBOX_CONFIG_MODE !== "apply") {
      console.log("[warned] config: changes pending; run devbox restart-glimmervoid");
      process.exit(0);
    }
    const suffix = crypto.randomUUID();
    if (hasConfig) fs.writeFileSync(`${configPath}.${suffix}.bak`, original, { mode: 0o600, flag: "wx" });
    const stagedPath = path.join(directory, `.config.${suffix}`);
    try {
      fs.writeFileSync(stagedPath, merged, { mode: 0o600, flag: "wx" });
      if (hasConfig && fs.readFileSync(configPath, "utf8") !== original) throw new Error("config changed during merge; rerun provisioning");
      fs.renameSync(stagedPath, configPath);
    } finally {
      fs.rmSync(stagedPath, { force: true });
    }
    settingsSync.writeJson(basePath, settingsPlan.base);
    console.log("[installed] config: merged; runtime records preserved");
  '
}

requireMergeableDevboxConfig() {
  local failureOutput failureReason
  if failureOutput="$(mergeDevboxConfig check "$1" 2>&1)"; then
    return 0
  fi
  failureReason="$(printf '%s\n' "$failureOutput" | sed -n 's/^Error: //p' | head -1)"
  reportDevboxItem warned config "${failureReason:-config.json cannot be merged}; left running"
  return 1
}

convergeDevboxConfig() {
  if devboxPortListens 3456; then
    mergeDevboxConfig pending "$1"
    return
  fi
  mergeDevboxConfig apply "$1"
}

reportRunningDevboxGlimmervoid() {
  local runningVersion="unknown"
  if ! runningVersion="$(node -e '
    const timeout = setTimeout(() => process.exit(1), 2000);
    async function readServerBuild() {
      const response = await fetch("http://127.0.0.1:3456/control-token");
      if (!response.ok) process.exit(1);
      const { token } = await response.json();
      const socket = new WebSocket(`ws://127.0.0.1:3456/control?token=${encodeURIComponent(token)}`, { headers: { Origin: "http://127.0.0.1:3456" } });
      socket.addEventListener("error", () => process.exit(1));
      socket.addEventListener("message", (event) => {
        const snapshot = JSON.parse(event.data);
        if (snapshot.type !== "snapshot") return;
        const version = snapshot.serverBuild?.split("+")[0];
        if (!version || !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version)) process.exit(1);
        console.log(version);
        clearTimeout(timeout);
        socket.close();
        process.exit(0);
      });
    }
    readServerBuild().catch(() => process.exit(1));
  ' 2>/dev/null)"; then
    runningVersion="unknown"
    reportDevboxItem warned "glimmervoid version" "running server did not report its version"
  fi
  reportDevboxItem present "glimmervoid server" "already running; $runningVersion; left running"
  if ! devboxPortListens 3457; then
    reportDevboxItem warned "remote listener" "not listening; run devbox restart-glimmervoid to apply config"
  fi
}

startDevboxGlimmervoid() {
  if devboxPortListens 3456; then
    reportRunningDevboxGlimmervoid
    return 0
  fi
  touch "$glimmervoidDirectory/server.log"
  chmod 600 "$glimmervoidDirectory/server.log"
  local glimmervoidExecutable
  glimmervoidExecutable="$(command -v glimmervoid)"
  # Appended without activating: PostHog's on-activate hook runs uv sync, pnpm and builds.
  local launchPath="$PATH" environmentDescription="" floxBinCandidate nixSystem
  local floxBinDirectories=()
  if [[ -d "$HOME/posthog/.flox" ]]; then
    case "$(uname -m)" in
      arm64 | aarch64) nixSystem="aarch64-linux" ;;
      *) nixSystem="$(uname -m)-linux" ;;
    esac
    for floxBinCandidate in "$HOME/posthog/.flox/run/${nixSystem}."*-dev/bin; do
      if [[ -d "$floxBinCandidate" ]]; then
        floxBinDirectories+=("$floxBinCandidate")
      fi
    done
    environmentDescription="; flox env posthog not on PATH (expected one .flox/run/${nixSystem}.*-dev/bin, found ${#floxBinDirectories[@]})"
  fi
  if [[ ${#floxBinDirectories[@]} -eq 1 ]]; then
    launchPath="$PATH:${floxBinDirectories[0]}"
    environmentDescription="; flox env posthog"
  fi
  PATH="$launchPath" setsid nohup "$glimmervoidExecutable" --config "$glimmervoidDirectory/config.json" \
    >> "$glimmervoidDirectory/server.log" 2>&1 < /dev/null 9>&- &
  local attempt
  for attempt in {1..30}; do
    if devboxPortListens 3456 && devboxPortListens 3457; then
      reportDevboxItem installed "glimmervoid server" "$(glimmervoid --version); both listeners ready$environmentDescription"
      return 0
    fi
    sleep 0.5
  done
  reportDevboxItem warned "glimmervoid server" "listeners not ready after 15s; see ~/.glimmervoid/server.log"
  return 1
}

devboxProcessCommandLine() {
  tr '\0' ' ' < "/proc/$1/cmdline"
}

stopDevboxGlimmervoid() {
  if ! devboxPortListens 3456; then
    return 0
  fi
  local listenerPid
  listenerPid="$(devboxListenerPid 3456)"
  if [[ ! "$listenerPid" =~ ^[0-9]+$ ]]; then
    reportDevboxItem warned "glimmervoid server" "cannot identify listener PID; left running"
    return 1
  fi
  local listenerCommand
  listenerCommand="$(devboxProcessCommandLine "$listenerPid")"
  case "$listenerCommand" in
    *glimmervoid* | *dist/server/index.js*) ;;
    *) reportDevboxItem warned "glimmervoid server" "listener is not glimmervoid; left running"; return 1 ;;
  esac
  kill -TERM "$listenerPid"
  local attempt
  for attempt in {1..30}; do
    if ! kill -0 "$listenerPid" 2>/dev/null && ! devboxPortListens 3456 && ! devboxPortListens 3457; then
      reportDevboxItem installed "glimmervoid server" "stopped"
      return 0
    fi
    sleep 0.5
  done
  reportDevboxItem warned "glimmervoid server" "still shutting down; start deferred"
  return 1
}

case "$devboxAction" in
  dotfiles) installDevboxDotfiles; exit ;;
  sync-repos)
    holdDevboxProvisionLock
    repositorySyncStatus=0
    syncDevboxRepositories || repositorySyncStatus=$?
    installDevboxWizardWorkbench
    exit "$repositorySyncStatus"
    ;;
  status)
    if devboxPortListens 3456; then
      reportRunningDevboxGlimmervoid
    fi
    if ! devboxPortListens 3456; then
      reportDevboxItem present "glimmervoid server" "stopped"
    fi
    printf 'https://%s/\n' "$(devboxPublicHost)"
    exit
    ;;
  pair) exec glimmervoid pair --config "$glimmervoidDirectory/config.json" --name "${3:?missing pairing label}" ;;
  restart)
    requireDevboxPublicHost
    holdDevboxProvisionLock
    requireMergeableDevboxConfig "$devboxPublicHostName"
    stopDevboxGlimmervoid
    installDevboxGlimmervoid
    mergeDevboxConfig apply "$devboxPublicHostName"
    startDevboxGlimmervoid
    printf 'https://%s/\n' "$devboxPublicHostName"
    exit "$hasFailedGlimmervoidInstall"
    ;;
  prepare)
    requireDevboxPublicHost
    holdDevboxProvisionLock
    installDevboxPrerequisites
    linkDevboxTemplateRepository
    ((hasFailedGlimmervoidInstall == 0)) || exit "$devboxFallbackReleaseStatus"
    exit 0
    ;;
  provision) ;;
  *) printf 'devbox: unknown remote action\n' >&2; exit 1 ;;
esac

requireDevboxPublicHost
holdDevboxProvisionLock
linkDevboxTemplateRepository
convergeDevboxConfig "$devboxPublicHostName"
startDevboxGlimmervoid
printf 'https://%s/\n' "$devboxPublicHostName"
exit "$hasFailedGlimmervoidInstall"
