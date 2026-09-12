#!/usr/bin/env bash
# Merges rather than replaces: flags, comments and entries glimmervoid never reported are the machine owner's, not this script's.

set -euo pipefail

topicDirectory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./paths.sh
source "$topicDirectory/paths.sh"
# shellcheck source=../script/lib/log.sh
source "$topicDirectory/../script/lib/log.sh"
# shellcheck source=../script/lib/state.sh
source "$topicDirectory/../script/lib/state.sh"
repoListPath="$(reposListPath)"
glimmervoidConfigPath="$HOME/.glimmervoid/config.json"

if [[ ! -f "$glimmervoidConfigPath" ]]; then
  printf 'repos: no %s, nothing to collect\n' "$glimmervoidConfigPath" >&2
  exit 0
fi

if ! command -v git >/dev/null 2>&1; then
  printf 'repos: git not on PATH, nothing to collect\n' >&2
  exit 0
fi

glimmervoidProjectPaths() {
  grep -o '"path"[[:space:]]*:[[:space:]]*"[^"]*"' "$glimmervoidConfigPath" \
    | sed 's/^[^"]*"path"[[:space:]]*:[[:space:]]*"//; s/"$//' \
    | sort -u
}

# The home directory itself is not a repo entry, whatever glimmervoid reports.
pathRelativeToHome() {
  local projectPath="$1"
  if [[ "$projectPath" != "$HOME/"* ]]; then
    return 1
  fi
  printf '%s\n' "${projectPath#"$HOME/"}"
}

# Everything after the url is a flag the owner set by hand; collecting must not drop it.
entryFlagSuffix() {
  local entryFields=()
  mapfile -t entryFields < <(entryFieldsOf "$1")
  if ((${#entryFields[@]} < 2)); then
    return 0
  fi
  printf ' %s\n' "${entryFields[*]:1}"
}

mergeCollectedEntries() {
  local existingPath="$1"
  local collectedPath="$2"
  local mergedPath="$3"
  local entryLine
  local entryPath
  declare -A collectedUrlByPath=()
  declare -A rewrittenPaths=()
  while IFS= read -r entryLine || [[ -n "$entryLine" ]]; do
    entryLine="$(normalizeListLine "$entryLine")"
    entryPath="$(normalizeListPath "${entryLine%%=*}")"
    if [[ -z "$entryPath" ]]; then
      printf 'repos: empty list path, skipping: %s\n' "$entryLine" >&2
      continue
    fi
    collectedUrlByPath["$entryPath"]="${entryLine#*=}"
  done < "$collectedPath"
  while IFS= read -r entryLine || [[ -n "$entryLine" ]]; do
    entryLine="$(normalizeListLine "$entryLine")"
    if ! listLineIsAnEntry "$entryLine"; then
      printf '%s\n' "$entryLine" >> "$mergedPath"
      continue
    fi
    entryPath="$(normalizeListPath "${entryLine%%=*}")"
    if [[ -z "$entryPath" ]]; then
      printf 'repos: empty list path, keeping it as it was: %s\n' "$entryLine" >&2
      printf '%s\n' "$entryLine" >> "$mergedPath"
      continue
    fi
    if [[ -z "${collectedUrlByPath[$entryPath]+listed}" ]]; then
      printf '%s\n' "$entryLine" >> "$mergedPath"
      continue
    fi
    rewrittenPaths["$entryPath"]=1
    printf '%s=%s%s\n' "${entryLine%%=*}" "${collectedUrlByPath[$entryPath]}" \
      "$(entryFlagSuffix "$entryLine")" >> "$mergedPath"
  done < "$existingPath"
  while IFS= read -r entryLine || [[ -n "$entryLine" ]]; do
    entryLine="$(normalizeListLine "$entryLine")"
    entryPath="$(normalizeListPath "${entryLine%%=*}")"
    if [[ -z "$entryPath" ]]; then
      printf 'repos: empty list path, skipping: %s\n' "$entryLine" >&2
      continue
    fi
    if [[ -n "${rewrittenPaths[$entryPath]+rewritten}" ]]; then
      continue
    fi
    printf '%s\n' "$entryLine"
  done < "$collectedPath" | sort >> "$mergedPath"
}

collectedEntries="$(mktemp "${TMPDIR:-/tmp}/dotfiles-repos.XXXXXX")"
mergedEntries="$(mktemp "${TMPDIR:-/tmp}/dotfiles-repos-merged.XXXXXX")"
trap 'rm -f -- "$collectedEntries" "$mergedEntries"' EXIT

while IFS= read -r projectPath; do
  if ! pathIsRepositoryRoot "$projectPath"; then
    continue
  fi
  if ! relativeProjectPath="$(pathRelativeToHome "$projectPath")"; then
    printf 'repos: not a path under the home directory, skipping: %s\n' "$projectPath" >&2
    continue
  fi
  if [[ -z "$relativeProjectPath" ]]; then
    printf 'repos: home directory is not a repo entry, skipping: %s\n' "$projectPath" >&2
    continue
  fi
  originUrl="$(git -C "$projectPath" config --get remote.origin.url || true)"
  if [[ -z "$originUrl" ]]; then
    printf 'repos: no origin remote, skipping: %s\n' "$projectPath" >&2
    continue
  fi
  printf '%s=%s\n' "$relativeProjectPath" "$originUrl" >> "$collectedEntries"
done < <(glimmervoidProjectPaths)

# An empty probe means glimmervoid changed its config shape, not that the machine has no repos.
if [[ ! -s "$collectedEntries" ]]; then
  printf 'repos: no glimmervoid projects found, keeping the existing repos.txt\n' >&2
  exit 0
fi

# mv replaces a symlink rather than writing through it, so a list its owner pointed elsewhere is refused instead of converted to a regular file.
if ! pathIsPlainFileOrAbsent "$repoListPath"; then
  printf 'repos: %s is not a regular file, move it aside first; nothing collected\n' \
    "$repoListPath" >&2
  exit 1
fi

sort -o "$collectedEntries" "$collectedEntries"
mkdir -p -- "$(dirname -- "$repoListPath")"
if [[ -f "$repoListPath" ]]; then
  mergeCollectedEntries "$repoListPath" "$collectedEntries" "$mergedEntries"
  collectedCount="$(wc -l < "$collectedEntries")"
  mv -f -- "$mergedEntries" "$repoListPath"
  trap - EXIT
  rm -f -- "$collectedEntries"
  printf 'repos: merged %s collected entries into %s\n' "$collectedCount" "$repoListPath"
  exit 0
fi

mv -f -- "$collectedEntries" "$repoListPath"
trap - EXIT
rm -f -- "$mergedEntries"
printf 'repos: collected %s entries into %s\n' "$(wc -l < "$repoListPath")" "$repoListPath"
