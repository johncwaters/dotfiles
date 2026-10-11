#!/usr/bin/env bash
set -euo pipefail

glimmervoidVersion="${1:-${GLIMMERVOID_VERSION:-}}"
devboxAction="${2:-provision}"
export PATH="$HOME/.local/bin:$PATH"
glimmervoidDirectory="$HOME/.glimmervoid"
hasUpdatedApt=0
hasFailedGlimmervoidInstall=0
devboxPublicHostName=""

reportDevboxItem() {
  printf '[%s] %s: %s\n' "$1" "$2" "$3"
}

devboxPublicHost() {
  printf '3457--%s--%s--%s.coder.dev.posthog.dev' \
    "${CODER_WORKSPACE_AGENT_NAME:?missing Coder agent name}" \
    "${CODER_WORKSPACE_NAME:?missing Coder workspace name}" \
    "${CODER_WORKSPACE_OWNER_NAME:?missing Coder owner name}"
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
  local snapshotDirectory="$HOME/dotfiles-snapshot"
  local syncLog="$HOME/.local/state/dotfiles/devbox-repos.log"
  if [[ ! -f "$snapshotDirectory/repos/install.sh" || ! -f "$snapshotDirectory/profiles/work-server/repos.txt" ]]; then
    return 0
  fi
  linkDevboxTemplateRepository
  mkdir -p -- "${syncLog%/*}"
  touch "$syncLog"
  chmod 600 "$syncLog"
  if DOTFILES_PROFILE=work-server bash "$snapshotDirectory/repos/install.sh" > "$syncLog" 2>&1 < /dev/null 9>&-; then
    reportDevboxItem present repos "synced"
    return 0
  fi
  reportDevboxItem warned repos "sync failed; retried next run; see $syncLog"
  return 1
}

installDevboxSnapshot() (
  snapshotCommit="$1"
  snapshotDirectory="$HOME/dotfiles-snapshot"
  stagedDirectory="$HOME/dotfiles-snapshot.new"
  previousDirectory="$HOME/dotfiles-snapshot.old"
  snapshotMarker="$snapshotDirectory/.snapshot-commit"
  bootstrapLog="$HOME/.local/state/dotfiles/devbox-bootstrap.log"
  holdDevboxProvisionLock
  reportFailedDevboxSnapshot() {
    if (($? == 0)); then
      return 0
    fi
    reportDevboxItem warned dotfiles "snapshot or bootstrap failed; retried next run; see $bootstrapLog"
  }
  trap reportFailedDevboxSnapshot EXIT
  umask 077
  rm -rf -- "$stagedDirectory" "$previousDirectory"
  if [[ "$(cat "$snapshotMarker" 2>/dev/null || true)" == "$snapshotCommit" ]]; then
    cat > /dev/null
    reportDevboxItem present dotfiles "$snapshotCommit"
    return 0
  fi
  mkdir -p -- "${bootstrapLog%/*}"
  touch "$bootstrapLog"
  chmod 600 "$bootstrapLog"
  if [[ -L "$snapshotDirectory" || ( -e "$snapshotDirectory" && ! -d "$snapshotDirectory" ) ]]; then
    reportDevboxItem warned dotfiles "~/dotfiles-snapshot is not a directory; left unchanged"
    return 1
  fi
  mkdir -p -- "$stagedDirectory"
  tar -xf - -C "$stagedDirectory" >> "$bootstrapLog" 2>&1
  if [[ -d "$snapshotDirectory" ]]; then
    mv -- "$snapshotDirectory" "$previousDirectory"
  fi
  mv -- "$stagedDirectory" "$snapshotDirectory"
  rm -rf -- "$previousDirectory"
  linkDevboxTemplateRepository
  local convergedRecord="${XDG_STATE_HOME:-$HOME/.local/state}/dotfiles/converged"
  rm -f -- "$convergedRecord"
  PATH="/tmp/coder-script-data/bin:$HOME/.local/bin:$PATH" \
    bash "$snapshotDirectory/script/bootstrap" --profile work-server >> "$bootstrapLog" 2>&1 < /dev/null 9>&-
  local convergeOutcome
  convergeOutcome="$(awk '{ print $4 }' "$convergedRecord" 2>/dev/null || true)"
  if [[ "$convergeOutcome" != "clean" ]]; then
    reportDevboxItem warned dotfiles "work-server bootstrap ${convergeOutcome:-left no converge record}; retried next run; see $bootstrapLog"
    return 0
  fi
  printf '%s\n' "$snapshotCommit" > "$snapshotMarker.new"
  mv -f -- "$snapshotMarker.new" "$snapshotMarker"
  reportDevboxItem installed dotfiles "$snapshotCommit; work-server bootstrapped"
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

requireDevboxReleaseVersion() {
  if [[ "$glimmervoidVersion" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    return 0
  fi
  printf 'devbox: a release version is required\n' >&2
  exit 1
}

installedDevboxGlimmervoidVersion() {
  if command -v glimmervoid >/dev/null 2>&1; then
    glimmervoid --version
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

requireDevboxReleaseOnRegistry() {
  if devboxGlimmervoidMeetsMinimum "$(installedDevboxGlimmervoidVersion)"; then
    return 0
  fi
  local publishedVersion
  publishedVersion="$(npm view "glimmervoid@$glimmervoidVersion" version 2>> "$glimmervoidDirectory/provision.log")" || publishedVersion=""
  if [[ "$publishedVersion" == "$glimmervoidVersion" ]]; then
    return 0
  fi
  reportDevboxItem warned glimmervoid "$glimmervoidVersion not found on the npm registry; server left running; see ~/.glimmervoid/provision.log"
  exit 1
}

installDevboxGlimmervoid() {
  local installedVersion
  installedVersion="$(installedDevboxGlimmervoidVersion)"
  if devboxGlimmervoidMeetsMinimum "$installedVersion"; then
    reportDevboxItem present glimmervoid "$installedVersion"
    return 0
  fi
  if [[ -n "$installedVersion" ]] && devboxPortListens 3456; then
    reportDevboxItem warned glimmervoid "$installedVersion running, $glimmervoidVersion pending; run devbox restart-glimmervoid"
    return 0
  fi
  if npm install -g --prefix "$HOME/.local" "glimmervoid@$glimmervoidVersion" >> "$glimmervoidDirectory/provision.log" 2>&1 \
    && [[ "$(installedDevboxGlimmervoidVersion)" == "$glimmervoidVersion" ]]; then
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
  reportDevboxItem warned glimmervoid "install of $glimmervoidVersion failed; starting installed $fallbackVersion instead; see ~/.glimmervoid/provision.log"
}

installDevboxGlobals() {
  installDevboxGlimmervoid
  if command -v codex >/dev/null 2>&1; then
    reportDevboxItem present Codex "on PATH"
    return 0
  fi
  npm install -g --prefix "$HOME/.local" @openai/codex >> "$glimmervoidDirectory/provision.log" 2>&1
  reportDevboxItem installed Codex "on PATH"
}

installDevboxSandboxTools() {
  local toolName
  local packageName
  for toolName in bwrap socat; do
    if command -v "$toolName" >/dev/null 2>&1; then
      reportDevboxItem present "$toolName" "on PATH"
      continue
    fi
    packageName="$toolName"
    if [[ "$toolName" == bwrap ]]; then packageName=bubblewrap; fi
    if installDevboxAptPackages "$packageName"; then
      reportDevboxItem installed "$toolName" "on PATH"
      continue
    fi
    reportDevboxItem warned "$toolName" "optional sandbox tool unavailable; see ~/.glimmervoid/provision.log"
  done
}

installDevboxGhWrapper() {
  if [[ ! -x /usr/bin/gh ]]; then
    installDevboxAptPackages gh
  fi
  mkdir -p "$HOME/.local/bin"
  local wrapperPath="$HOME/.local/bin/gh"
  local stagedWrapperPath
  stagedWrapperPath="$(mktemp "$HOME/.local/bin/.gh.XXXXXX")"
  cat > "$stagedWrapperPath" <<'WRAPPER'
#!/usr/bin/env bash
set -euo pipefail
targetRepo=""
arguments=("$@")
for ((index = 0; index < ${#arguments[@]}; index++)); do
  case "${arguments[index]}" in
    -R | --repo) targetRepo="${arguments[index + 1]:-}"; break ;;
    --repo=*) targetRepo="${arguments[index]#--repo=}"; break ;;
    -R?*) targetRepo="${arguments[index]#-R}"; break ;;
  esac
done
if [[ -z "$targetRepo" && "${arguments[0]:-}" == api ]]; then
  for apiArgument in "${arguments[@]:1}"; do
    apiPath="${apiArgument#/}"
    [[ "$apiPath" == repos/*/* ]] || continue
    apiPath="${apiPath#repos/}"
    apiOwner="${apiPath%%/*}"
    apiName="${apiPath#*/}"
    targetRepo="$apiOwner/${apiName%%[/?#]*}"
    break
  done
fi
if [[ -z "$targetRepo" && "${arguments[0]:-}" == repo && ( "${arguments[1]:-}" == clone || "${arguments[1]:-}" == view ) ]]; then
  for repoArgument in "${arguments[@]:2}"; do
    [[ "$repoArgument" != -* ]] || continue
    if [[ "$repoArgument" == */* ]]; then targetRepo="$repoArgument"; fi
    break
  done
fi
if [[ -z "$targetRepo" ]]; then
  targetRepo="$(git remote get-url origin 2>/dev/null || true)"
fi
targetRepo="${targetRepo#https://github.com/}"
targetRepo="${targetRepo#http://github.com/}"
targetRepo="${targetRepo#ssh://git@github.com/}"
targetRepo="${targetRepo#git@github.com:}"
targetRepo="${targetRepo#github.com/}"
while [[ "$targetRepo" == */ ]]; do targetRepo="${targetRepo%/}"; done
targetRepo="${targetRepo%.git}"
if [[ "${targetRepo,,}" == johncwaters/dotfiles ]]; then
  printf 'gh: dotfiles access is excluded on the box\n' >&2
  exit 1
fi
if [[ -n "${GH_PERSONAL_TOKEN:-}" && "${targetRepo,,}" == johncwaters/* ]]; then
  export GH_TOKEN="$GH_PERSONAL_TOKEN"
fi
if [[ -z "${GH_PERSONAL_TOKEN:-}" || "${targetRepo,,}" != johncwaters/* ]]; then
  GH_TOKEN="$(coder external-auth access-token primary-github)"
  export GH_TOKEN
fi
exec /usr/bin/gh "$@"
WRAPPER
  if cmp -s "$stagedWrapperPath" "$wrapperPath"; then
    rm -f "$stagedWrapperPath"
    chmod 700 "$wrapperPath"
    reportDevboxItem present gh "Coder external auth wrapper"
    return 0
  fi
  chmod 700 "$stagedWrapperPath"
  mv -f "$stagedWrapperPath" "$wrapperPath"
  reportDevboxItem installed gh "Coder external auth wrapper"
}

installDevboxPersonalGitAuth() {
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
case "${repoPath,,}" in
  johncwaters/dotfiles | johncwaters/dotfiles.git | johncwaters/dotfiles/* | johncwaters/dotfiles.git/*) exit 0 ;;
esac
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
  if [[ -z "${GH_PERSONAL_TOKEN:-}" && "$devboxAction" != prepare ]]; then
    reportDevboxItem warned "personal GitHub token" "GH_PERSONAL_TOKEN not set; johncwaters repos will 403"
  fi
  if [[ -n "${GH_PERSONAL_TOKEN:-}" && "$devboxAction" != prepare ]]; then
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
    200) reportDevboxItem warned "personal GitHub token" "can read johncwaters/dotfiles; recreate it without that repo" ;;
    403 | 404) reportDevboxItem present "personal GitHub token" "cannot read johncwaters/dotfiles" ;;
    *) reportDevboxItem warned "personal GitHub token" "dotfiles access check got HTTP $dotfilesStatusCode" ;;
  esac
}

installDevboxPrerequisites() {
  touch "$glimmervoidDirectory/provision.log"
  chmod 600 "$glimmervoidDirectory/provision.log"
  installDevboxNode
  installDevboxGlobals
  installDevboxSandboxTools
  installDevboxGhWrapper
  installDevboxPersonalGitAuth
}

mergeDevboxConfig() {
  DEVBOX_CONFIG_MODE="$1" DEVBOX_PUBLIC_HOST="$2" node --input-type=module -e '
    import { createRequire } from "node:module";
    const require = createRequire(`${process.env.HOME}/dotfiles-snapshot/package.json`);
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
    const ledgerPath = path.join(directory, "devbox-imported-defaults.json");
    const hasLedger = fs.existsSync(ledgerPath);
    if (hasLedger && !fs.lstatSync(ledgerPath).isFile()) throw new Error("devbox-imported-defaults.json must be a regular file");
    let ledger;
    try {
      ledger = hasLedger ? JSON.parse(fs.readFileSync(ledgerPath, "utf8")) : { keys: [], hookIds: [] };
    } catch {
      throw new Error("devbox-imported-defaults.json is invalid JSON; left unchanged");
    }
    if (!Array.isArray(ledger?.keys) || !Array.isArray(ledger?.hookIds)) throw new Error("devbox-imported-defaults.json must list keys and hookIds; left unchanged");
    const importedKeys = new Set(ledger.keys);
    const importedHookIds = new Set(ledger.hookIds);
    const settingsPath = path.join(process.env.HOME, "dotfiles-snapshot", "profiles/work/glimmervoid.settings.json");
    const syncPath = path.join(process.env.HOME, "dotfiles-snapshot", "glimmervoid/sync-settings.mjs");
    let settingsPlan;
    let settingsSync;
    const basePath = path.join(directory, "dotfiles-settings-base.json");
    if (fs.existsSync(settingsPath)) {
      settingsSync = await import(syncPath);
      config = settingsSync.withoutProvisionerUpdateDefault(config, ledger);
      const wanted = settingsSync.translateHome(settingsSync.settingsFrom(settingsSync.readJson(settingsPath)), process.env.HOME, "render");
      settingsPlan = settingsSync.planApply(config, wanted, settingsSync.readJson(basePath));
      config = settingsPlan.config;
    }
    const defaultsPath = path.join(process.env.HOME, "dotfiles-snapshot", "glimmervoid", "config.example.json");
    if (!fs.existsSync(settingsPath) && !ledger.checkForUpdatesMigration && !importedKeys.has("checkForUpdates") && config.checkForUpdates === false) delete config.checkForUpdates;
    if (!fs.existsSync(settingsPath) && fs.existsSync(defaultsPath)) {
      const defaults = JSON.parse(fs.readFileSync(defaultsPath, "utf8"), (_key, value) =>
        typeof value === "string" ? value.replaceAll("{{HOME}}", process.env.HOME) : value);
      for (const settingName of ["skipPermissionsByDefault", "postTurnChecks", "branchGc"]) {
        if (!Object.hasOwn(defaults, settingName) || importedKeys.has(settingName)) continue;
        if (!Object.hasOwn(config, settingName)) config[settingName] = defaults[settingName];
        importedKeys.add(settingName);
      }
      if (Array.isArray(defaults.hooks) && defaults.hooks.some(hook => hook?.id && !importedHookIds.has(hook.id))) {
        if (!Object.hasOwn(config, "hooks")) config.hooks = [];
        if (!Array.isArray(config.hooks)) throw new Error("config.hooks must contain an array; left unchanged");
        const installedHookIds = new Set(config.hooks.map(hook => hook?.id));
        for (const hook of defaults.hooks) {
          if (!hook?.id || importedHookIds.has(hook.id)) continue;
          if (!installedHookIds.has(hook.id)) config.hooks.push(hook);
          installedHookIds.add(hook.id);
          importedHookIds.add(hook.id);
        }
      }
    }
    if (process.env.DEVBOX_CONFIG_MODE === "check") process.exit(0);
    const nextLedger = { ...ledger, keys: [...importedKeys], hookIds: [...importedHookIds], checkForUpdatesMigration: true };
    const isLedgerCurrent = hasLedger && isDeepStrictEqual(ledger, nextLedger);
    const writeLedger = () => {
      if (settingsPlan) settingsSync.writeJson(basePath, settingsPlan.base);
      if (isLedgerCurrent) return;
      const stagedLedgerPath = path.join(directory, `.devbox-imported-defaults.${crypto.randomUUID()}`);
      try {
        fs.writeFileSync(stagedLedgerPath, JSON.stringify(nextLedger, null, 2) + "\n", { mode: 0o600, flag: "wx" });
        fs.renameSync(stagedLedgerPath, ledgerPath);
      } finally {
        fs.rmSync(stagedLedgerPath, { force: true });
      }
    };
    if (!Array.isArray(config.projects)) config.projects = [];
    if (!config.projects.some((project) => project?.path === "/home/coder/posthog")) {
      config.projects.push({ id: "bcea0337-5a86-4f96-beb3-ea0ea1fcdcf7", name: "posthog", path: "/home/coder/posthog" });
    }
    config.port = 3456;
    config.repoRoots = [path.join(process.env.HOME, "Projects")];
    config.remote = { enabled: true, port: 3457, publicHost: process.env.DEVBOX_PUBLIC_HOST, allowedOrigins: [`https://${process.env.DEVBOX_PUBLIC_HOST}`] };
    const merged = JSON.stringify(config, null, 2) + "\n";
    if (hasConfig && isDeepStrictEqual(parsedOriginal, config)) {
      fs.chmodSync(configPath, 0o600);
      writeLedger();
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
    writeLedger();
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
  local systemNode glimmervoidScript
  # node-pty is built against system Node, so the flox bin directory is appended after it, never prepended.
  systemNode="$(command -v node)"
  glimmervoidScript="$(readlink -f "$(command -v glimmervoid)")"
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
  PATH="$launchPath" setsid nohup "$systemNode" "$glimmervoidScript" --config "$glimmervoidDirectory/config.json" \
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
  listenerPid="$(ss -ltnp 'sport = :3456' | sed -n 's/.*pid=\([0-9]*\).*/\1/p')"
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
  snapshot-status)
    holdDevboxProvisionLock
    if [[ -f "$HOME/dotfiles-snapshot/.snapshot-commit" ]]; then
      cat "$HOME/dotfiles-snapshot/.snapshot-commit"
    fi
    exit
    ;;
  snapshot) installDevboxSnapshot "${3:?missing snapshot commit}"; exit ;;
  sync-repos) holdDevboxProvisionLock; syncDevboxRepositories; exit ;;
  config-only) requireDevboxPublicHost; holdDevboxProvisionLock; convergeDevboxConfig "$devboxPublicHostName"; exit ;;
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
    requireDevboxReleaseVersion
    requireDevboxPublicHost
    holdDevboxProvisionLock
    requireDevboxReleaseOnRegistry
    requireMergeableDevboxConfig "$devboxPublicHostName"
    stopDevboxGlimmervoid
    installDevboxGlimmervoid
    mergeDevboxConfig apply "$devboxPublicHostName"
    startDevboxGlimmervoid
    printf 'https://%s/\n' "$devboxPublicHostName"
    exit "$hasFailedGlimmervoidInstall"
    ;;
  prepare)
    requireDevboxReleaseVersion
    requireDevboxPublicHost
    holdDevboxProvisionLock
    installDevboxPrerequisites
    linkDevboxTemplateRepository
    exit 0
    ;;
  provision) ;;
  *) printf 'devbox: unknown remote action\n' >&2; exit 1 ;;
esac

requireDevboxReleaseVersion
requireDevboxPublicHost
holdDevboxProvisionLock
installDevboxPrerequisites
linkDevboxTemplateRepository
convergeDevboxConfig "$devboxPublicHostName"
startDevboxGlimmervoid
printf 'https://%s/\n' "$devboxPublicHostName"
exit "$hasFailedGlimmervoidInstall"
