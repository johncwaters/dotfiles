#!/usr/bin/env bash

if [[ -z "${dotfilesRepo:-}" ]]; then
  source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../script/lib" && pwd)/context.sh"
  requireAliasResolvesToRepo
fi
source "$dotfilesRepo/script/lib/packages.sh"

coderDeploymentUrl="https://coder.dev.posthog.dev"

coderReleaseVersion() {
  local versionOutput
  if ! versionOutput="$("$1" version 2>/dev/null)"; then
    return 0
  fi
  if [[ "$versionOutput" =~ v[0-9]+\.[0-9]+\.[0-9]+ ]]; then
    printf '%s\n' "${BASH_REMATCH[0]}"
  fi
}

installCoder() {
  local serverBuildInfo
  if ! serverBuildInfo="$(curl -fsSL --connect-timeout 5 --max-time 10 "$coderDeploymentUrl/api/v2/buildinfo" 2>/dev/null)"; then
    noteWarned "Coder CLI" "coder.dev.posthog.dev unreachable, connect to Tailscale and rerun"
    return 0
  fi
  local serverVersionPattern='"version"[[:space:]]*:[[:space:]]*"(v[0-9]+\.[0-9]+\.[0-9]+)(\+[^"[:space:]]+)?"'
  if [[ ! "$serverBuildInfo" =~ $serverVersionPattern ]]; then
    noteWarned "Coder CLI" "server buildinfo has no valid version"
    return 0
  fi
  local serverVersion="${BASH_REMATCH[1]}"
  local coderBinDirectory="$HOME/.local/bin"
  local ownedCoderPath="$coderBinDirectory/coder"
  refreshSessionPath
  if [[ "$(coderReleaseVersion "$ownedCoderPath")" == "$serverVersion" ]]; then
    notePresent "Coder CLI" "$serverVersion already installed"
    warnWhenPathShadowsOwnedCoder "$ownedCoderPath" "$serverVersion"
    reportCoderAuthStatus "$ownedCoderPath"
    return 0
  fi
  local coderOs
  if ! coderOs="$(platformName)"; then
    noteWarned "Coder CLI" "unsupported platform"
    return 0
  fi
  local machineArchitecture
  machineArchitecture="$(uname -m)"
  local coderArchitecture
  case "$machineArchitecture" in
    arm64 | aarch64) coderArchitecture=arm64 ;;
    x86_64 | amd64) coderArchitecture=amd64 ;;
    *)
      noteWarned "Coder CLI" "unsupported architecture: $machineArchitecture"
      return 0
      ;;
  esac
  if ! mkdir -p "$coderBinDirectory"; then
    noteWarned "Coder CLI" "cannot create ~/.local/bin"
    return 0
  fi
  local stagedCoderPath
  if ! stagedCoderPath="$(mktemp "$coderBinDirectory/.coder.XXXXXX")"; then
    noteWarned "Coder CLI" "cannot stage CLI download"
    return 0
  fi
  # The deployment serves its matching CLI; package managers can drift from its version.
  if ! curl -fsSL --connect-timeout 5 --max-time 120 \
    "$coderDeploymentUrl/bin/coder-$coderOs-$coderArchitecture" -o "$stagedCoderPath" \
    || ! chmod +x "$stagedCoderPath"; then
    rm -f -- "$stagedCoderPath"
    noteWarned "Coder CLI" "CLI download failed"
    return 0
  fi
  if [[ "$(coderReleaseVersion "$stagedCoderPath")" != "$serverVersion" ]]; then
    rm -f -- "$stagedCoderPath"
    noteWarned "Coder CLI" "downloaded CLI does not match server $serverVersion"
    return 0
  fi
  if ! mv -f -- "$stagedCoderPath" "$ownedCoderPath"; then
    rm -f -- "$stagedCoderPath"
    noteWarned "Coder CLI" "cannot install ~/.local/bin/coder"
    return 0
  fi
  persistUserLocalBinOnPath
  refreshSessionPath
  noteInstalled "Coder CLI" "$serverVersion installed"
  warnWhenPathShadowsOwnedCoder "$ownedCoderPath" "$serverVersion"
  reportCoderAuthStatus "$ownedCoderPath"
}

warnWhenPathShadowsOwnedCoder() {
  local ownedCoderPath="$1"
  local serverVersion="$2"
  local resolvedCoderPath
  resolvedCoderPath="$(type -P coder 2>/dev/null || true)"
  if [[ -z "$resolvedCoderPath" || "$resolvedCoderPath" == "$ownedCoderPath" ]]; then
    return 0
  fi
  if [[ "$(coderReleaseVersion "$resolvedCoderPath")" == "$serverVersion" ]]; then
    return 0
  fi
  noteWarned "Coder CLI" "$resolvedCoderPath shadows ~/.local/bin/coder on PATH and does not match server $serverVersion"
}

reportCoderAuthStatus() {
  if "$1" whoami >/dev/null 2>&1; then
    notePresent "Coder auth" "logged in"
    return 0
  fi
  noteWarned "Coder auth" "run coder login $coderDeploymentUrl"
}

installCoder

finishTopic
