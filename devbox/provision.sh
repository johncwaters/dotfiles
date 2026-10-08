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

requireDevboxReleaseOnRegistry() {
  if [[ "$(installedDevboxGlimmervoidVersion)" == "$glimmervoidVersion" ]]; then
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
  if [[ "$installedVersion" == "$glimmervoidVersion" ]]; then
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
GH_TOKEN="$(coder external-auth access-token primary-github)"
export GH_TOKEN
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

mergeDevboxConfig() {
  DEVBOX_CONFIG_MODE="$1" DEVBOX_PUBLIC_HOST="$2" node -e '
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
    if (process.env.DEVBOX_CONFIG_MODE === "check") process.exit(0);
    if (!Array.isArray(config.projects)) config.projects = [];
    if (!config.projects.some((project) => project?.path === "/home/coder/posthog")) {
      config.projects.push({ id: "bcea0337-5a86-4f96-beb3-ea0ea1fcdcf7", name: "posthog", path: "/home/coder/posthog" });
    }
    config.port = 3456;
    config.checkForUpdates = false;
    config.remote = { enabled: true, port: 3457, publicHost: process.env.DEVBOX_PUBLIC_HOST, allowedOrigins: [`https://${process.env.DEVBOX_PUBLIC_HOST}`] };
    const merged = JSON.stringify(config, null, 2) + "\n";
    if (hasConfig && isDeepStrictEqual(parsedOriginal, config)) {
      fs.chmodSync(configPath, 0o600);
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
      const socket = new WebSocket(`ws://127.0.0.1:3456/control?token=${encodeURIComponent(token)}`);
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
  setsid nohup glimmervoid --config "$glimmervoidDirectory/config.json" \
    >> "$glimmervoidDirectory/server.log" 2>&1 < /dev/null &
  local attempt
  for attempt in {1..30}; do
    if devboxPortListens 3456 && devboxPortListens 3457; then
      reportDevboxItem installed "glimmervoid server" "$(glimmervoid --version); both listeners ready"
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
  config-only) requireDevboxPublicHost; mergeDevboxConfig apply "$devboxPublicHostName"; exit ;;
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
    mkdir -p -m 700 "$glimmervoidDirectory"
    requireDevboxReleaseOnRegistry
    requireMergeableDevboxConfig "$devboxPublicHostName"
    stopDevboxGlimmervoid
    installDevboxGlimmervoid
    mergeDevboxConfig apply "$devboxPublicHostName"
    startDevboxGlimmervoid
    printf 'https://%s/\n' "$devboxPublicHostName"
    exit "$hasFailedGlimmervoidInstall"
    ;;
  provision) ;;
  *) printf 'devbox: unknown remote action\n' >&2; exit 1 ;;
esac

requireDevboxReleaseVersion
requireDevboxPublicHost
mkdir -p -m 700 "$glimmervoidDirectory"
touch "$glimmervoidDirectory/provision.log"
chmod 600 "$glimmervoidDirectory/provision.log"
installDevboxNode
installDevboxGlobals
installDevboxSandboxTools
installDevboxGhWrapper
convergeDevboxConfig "$devboxPublicHostName"
startDevboxGlimmervoid
printf 'https://%s/\n' "$devboxPublicHostName"
exit "$hasFailedGlimmervoidInstall"
