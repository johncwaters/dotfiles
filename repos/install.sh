#!/usr/bin/env bash
# Nothing here resets, stashes or discards: a tree that cannot fast forward is left alone.

if [[ -z "${dotfilesRepo:-}" ]]; then
  # shellcheck source=../script/lib/context.sh
  source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../script/lib" && pwd)/context.sh"
  requireAliasResolvesToRepo
fi

# shellcheck source=../script/lib/packages.sh
source "$dotfilesRepo/script/lib/packages.sh"
# shellcheck source=./paths.sh
source "$dotfilesRepo/repos/paths.sh"

repoListPath="$(reposListPath)"
operatorGitHubOwner=""

parseGitHubOwner() {
  local cloneUrl="$1"
  if [[ "$cloneUrl" =~ ^(https://github\.com/|ssh://git@github\.com/|git@github\.com:)([^/]+)/. ]]; then
    printf '%s\n' "${BASH_REMATCH[2]}"
    return 0
  fi
  return 1
}

resolveOperatorGitHubOwner() {
  if ! command -v gh >/dev/null 2>&1; then
    return 1
  fi
  local signedInLogin
  signedInLogin="$(gh api user --jq .login 2>/dev/null)" || return 1
  if [[ -z "$signedInLogin" ]]; then
    return 1
  fi
  printf '%s\n' "$signedInLogin"
}

remoteDefaultBranch() {
  local repoPath="$1"
  local defaultRef
  defaultRef="$(git -C "$repoPath" symbolic-ref --short -q refs/remotes/origin/HEAD)" || return 1
  if [[ -z "$defaultRef" ]]; then
    return 1
  fi
  printf '%s\n' "${defaultRef#origin/}"
}

# Branching develop off whatever HEAD points at publishes a side branch as the shared one.
createDevelopFromDefaultBranch() {
  local label="$1"
  local repoPath="$2"
  local defaultBranch
  if ! defaultBranch="$(remoteDefaultBranch "$repoPath")"; then
    noteDetail "$label develop" "skipped, origin names no default branch"
    return 0
  fi
  if [[ "$(git -C "$repoPath" symbolic-ref --short -q HEAD)" != "$defaultBranch" ]]; then
    noteDetail "$label develop" "skipped, HEAD is not on $defaultBranch"
    return 0
  fi
  if ! git -C "$repoPath" branch -q develop "origin/$defaultBranch"; then
    noteWarned "$label develop" "could not create develop from origin/$defaultBranch"
    return 0
  fi
  if ! runGitNetworkCommand -C "$repoPath" push -q -u origin develop; then
    noteWarned "$label develop" "created locally, push failed"
    return 0
  fi
  noteInstalled "$label develop" "created from origin/$defaultBranch and pushed"
}

syncDevelopBranch() {
  local label="$1"
  local repoPath="$2"
  local hasLocalDevelopBranch=0
  local hasRemoteDevelopBranch=0
  local repoOwner
  # An earlier installer pushed develop to two repos that merely happened to be clonable.
  if [[ -z "$operatorGitHubOwner" ]]; then
    noteDetail "$label develop" "skipped, no GitHub account resolved"
    return 0
  fi
  repoOwner="$(parseGitHubOwner "$(git -C "$repoPath" remote get-url origin 2>/dev/null)")" || repoOwner=""
  if [[ "$repoOwner" != "$operatorGitHubOwner" ]]; then
    notePresent "$label develop" "skipped, not your repo"
    return 0
  fi
  # A fresh clone of an empty repo has an unborn HEAD, and branching against it exits 128.
  if ! git -C "$repoPath" rev-parse --verify -q HEAD >/dev/null 2>&1; then
    noteWarned "$label develop" "no commits yet, branch sync skipped"
    return 0
  fi
  if git -C "$repoPath" rev-parse --verify -q refs/heads/develop >/dev/null; then
    hasLocalDevelopBranch=1
  fi
  if git -C "$repoPath" rev-parse --verify -q refs/remotes/origin/develop >/dev/null; then
    hasRemoteDevelopBranch=1
  fi
  if ((hasLocalDevelopBranch == 0)) && ((hasRemoteDevelopBranch == 1)); then
    if ! git -C "$repoPath" branch -q --track develop origin/develop; then
      noteWarned "$label develop" "could not track origin/develop"
      return 0
    fi
    noteInstalled "$label develop" "tracking origin/develop"
    return 0
  fi
  if ((hasLocalDevelopBranch == 0)); then
    createDevelopFromDefaultBranch "$label" "$repoPath"
    return 0
  fi
  if ((hasRemoteDevelopBranch == 0)); then
    if ! runGitNetworkCommand -C "$repoPath" push -q -u origin develop; then
      noteWarned "$label develop" "local only, push failed"
      return 0
    fi
    noteApplied "$label develop" "pushed to origin"
    return 0
  fi
  if [[ "$(git -C "$repoPath" symbolic-ref --short -q HEAD)" == "develop" ]]; then
    return 0
  fi
  if ! runGitNetworkCommand -C "$repoPath" fetch -q origin develop:develop; then
    noteWarned "$label develop" "diverged from origin, resolve manually"
  fi
}

installElectronBinary() {
  local label="$1"
  local electronDirectory="$2"
  if [[ -f "$electronDirectory/dist/electron" ]]; then
    return 0
  fi
  if ! command -v node >/dev/null 2>&1; then
    noteWarned "$label electron" "node not on PATH"
    return 1
  fi
  noteStarting "$label electron" "downloading binary"
  if node "$electronDirectory/install.js" >/dev/null && [[ -f "$electronDirectory/dist/electron" ]]; then
    noteInstalled "$label electron" "binary installed"
    return 0
  fi
  noteWarned "$label electron" "binary download failed, run: node node_modules/electron/install.js"
  return 1
}

nodePackageManagerFor() {
  local repoPath="$1"
  if [[ -f "$repoPath/yarn.lock" ]]; then
    printf 'yarn\n'
    return 0
  fi
  if [[ -f "$repoPath/pnpm-lock.yaml" ]]; then
    printf 'pnpm\n'
    return 0
  fi
  printf 'npm\n'
}

repoHasNpmLockfile() {
  [[ -f "$1/package-lock.json" || -f "$1/npm-shrinkwrap.json" ]]
}

# A lockfile written where the repo tracks none leaves the tree dirty, and this topic skips a dirty tree forever after, so every mode here installs without writing one.
installArgumentsFor() {
  local nodePackageManager="$1"
  local repoPath="$2"
  case "$nodePackageManager" in
    pnpm)
      printf '%s\n' install --frozen-lockfile --reporter=silent
      return 0
      ;;
    yarn)
      printf '%s\n' install --frozen-lockfile --silent
      return 0
      ;;
  esac
  if repoHasNpmLockfile "$repoPath"; then
    printf '%s\n' ci --no-audit --no-fund --loglevel=error
    return 0
  fi
  printf '%s\n' install --no-package-lock --no-audit --no-fund --loglevel=error
}

# npm 12 blocks dependency install scripts, so node-pty's macOS spawn-helper lands 0644 and every pty spawn dies with posix_spawnp.
restoreNodePtySpawnHelpers() {
  local label="$1"
  local repoPath="$2"
  local helperPath
  local hasRepairedHelper=0
  for helperPath in "$repoPath"/node_modules/node-pty/build/{Release,Debug}/spawn-helper \
    "$repoPath"/node_modules/node-pty/prebuilds/darwin-*/spawn-helper; do
    if [[ ! -f "$helperPath" || -x "$helperPath" || -L "$helperPath" ]]; then
      continue
    fi
    if ! chmod 755 "$helperPath"; then
      noteWarned "$label node-pty" "chmod 755 $helperPath failed"
      return 0
    fi
    hasRepairedHelper=1
  done
  if ((hasRepairedHelper == 0)); then
    return 0
  fi
  noteApplied "$label node-pty" "spawn-helper made executable"
}

installRepoDeps() {
  local label="$1"
  local repoPath="$2"
  local depsPendingStateName
  local nodePackageManager
  local installArguments=()
  depsPendingStateName="$(repoDepsPendingStateNameForPath "$repoPath")"
  if [[ ! -f "$repoPath/package.json" ]]; then
    clearDotfilesState "$depsPendingStateName"
    return 0
  fi
  markDotfilesStatePending "$depsPendingStateName"
  nodePackageManager="$(nodePackageManagerFor "$repoPath")"
  if ! command -v "$nodePackageManager" >/dev/null 2>&1; then
    noteWarned "$label deps" "$nodePackageManager not on PATH"
    return 0
  fi
  mapfile -t installArguments < <(installArgumentsFor "$nodePackageManager" "$repoPath")
  noteStarting "$label deps" "$nodePackageManager ${installArguments[0]}"
  if ! (cd "$repoPath" && runBatchNetworkCommand "$nodePackageManager" "${installArguments[@]}" >/dev/null); then
    noteWarned "$label deps" "$nodePackageManager install failed"
    return 0
  fi
  notePresent "$label deps" "installed"
  restoreNodePtySpawnHelpers "$label" "$repoPath"
  if [[ ! -d "$repoPath/node_modules/electron" ]]; then
    clearDotfilesState "$depsPendingStateName"
    return 0
  fi
  if ! installElectronBinary "$label" "$repoPath/node_modules/electron"; then
    return 0
  fi
  clearDotfilesState "$depsPendingStateName"
}

repoEntryWantsDeps() {
  local label="$1"
  shift
  local entryFlag
  local sawNoDepsFlag=0
  for entryFlag in "$@"; do
    if [[ "$entryFlag" == "nodeps" ]]; then
      sawNoDepsFlag=1
      continue
    fi
    noteWarned "$label" "unknown repos.txt flag ignored: $entryFlag"
  done
  ((sawNoDepsFlag == 0))
}

installRepoDepsUnlessSkipped() {
  local label="$1"
  local repoPath="$2"
  shift 2
  if ! repoEntryWantsDeps "$label" "$@"; then
    clearDotfilesState "$(repoDepsPendingStateNameForPath "$repoPath")"
    notePresent "$label deps" "skipped (nodeps)"
    return 0
  fi
  installRepoDeps "$label" "$repoPath"
}

repoEntryPathLabel() {
  local pathField
  pathField="$(normalizeListPath "${1%%=*}")"
  if [[ -z "$pathField" ]]; then
    printf 'entry with no path\n'
    return 0
  fi
  printf '%s\n' "$pathField"
}

repoEntryDestination() {
  local relativePath="$1"
  case "$relativePath" in
    "" | . | ./ | /* | ~*) return 1 ;;
    .. | ../* | */.. | */../*) return 1 ;;
  esac
  printf '%s/%s\n' "$HOME" "$relativePath"
}

cloneMissingRepo() {
  local label="$1"
  local cloneUrl="$2"
  local destination="$3"
  noteStarting "$label" "cloning"
  if ! mkdir -p -- "$(dirname -- "$destination")"; then
    noteWarned "$label" "could not create parent directory"
    return 1
  fi
  if ! runGitNetworkCommand clone -q -- "$cloneUrl" "$destination"; then
    noteWarned "$label" "clone failed"
    return 1
  fi
  noteInstalled "$label" "cloned"
}

normalizeRepoUrl() {
  local normalizedUrl="$1"
  local schemePrefix
  local authority
  local pathSuffix
  local accountPrefix=""
  local hostAndPort
  while [[ "$normalizedUrl" == */ ]]; do
    normalizedUrl="${normalizedUrl%/}"
  done
  if [[ "$normalizedUrl" == *.git ]]; then
    normalizedUrl="${normalizedUrl%.git}"
  fi
  while [[ "$normalizedUrl" == */ ]]; do
    normalizedUrl="${normalizedUrl%/}"
  done
  if [[ "$normalizedUrl" =~ ^([^:]+://)([^/]+)(/.*)$ ]]; then
    schemePrefix="${BASH_REMATCH[1]}"
    authority="${BASH_REMATCH[2]}"
    pathSuffix="${BASH_REMATCH[3]}"
    if [[ "$authority" == *@* ]]; then
      accountPrefix="${authority%@*}@"
      hostAndPort="${authority##*@}"
      printf '%s%s%s%s\n' "$schemePrefix" "$accountPrefix" "${hostAndPort,,}" "$pathSuffix"
      return 0
    fi
    printf '%s%s%s\n' "$schemePrefix" "${authority,,}" "$pathSuffix"
    return 0
  fi
  if [[ "$normalizedUrl" =~ ^([^@:/]+@)([^:]+)(:.*)$ ]]; then
    printf '%s%s%s\n' "${BASH_REMATCH[1]}" "${BASH_REMATCH[2],,}" "${BASH_REMATCH[3]}"
    return 0
  fi
  printf '%s\n' "$normalizedUrl"
}

repoOriginMatchesListedUrl() {
  local repoPath="$1"
  local listedUrl="$2"
  local originUrl
  originUrl="$(git -C "$repoPath" remote get-url origin 2>/dev/null)" || return 1
  [[ "$(normalizeRepoUrl "$originUrl")" == "$(normalizeRepoUrl "$listedUrl")" ]]
}

syncOneRepo() {
  local repoLine="$1"
  local relativePath
  local entryFields=()
  local entryFlags=()
  local cloneUrl
  local destination
  local label
  relativePath="$(normalizeListPath "${repoLine%%=*}")"
  mapfile -t entryFields < <(entryFieldsOf "$repoLine")
  cloneUrl="${entryFields[0]:-}"
  if ((${#entryFields[@]} > 1)); then
    entryFlags=("${entryFields[@]:1}")
  fi
  if [[ -z "$cloneUrl" ]]; then
    noteWarned "repos" "entry has no clone url: $(repoEntryPathLabel "$repoLine")"
    return 1
  fi
  # A url git reads as an option runs whatever --upload-pack names.
  if [[ "$cloneUrl" == -* ]]; then
    noteWarned "repos" "clone url must not start with a dash: $(repoEntryPathLabel "$repoLine")"
    return 1
  fi
  if ! destination="$(repoEntryDestination "$relativePath")"; then
    noteWarned "repos" "entry path must stay under the home directory: $(repoEntryPathLabel "$repoLine")"
    return 1
  fi
  label="$(basename -- "$destination")"
  if [[ ! -e "$destination" ]]; then
    cloneMissingRepo "$label" "$cloneUrl" "$destination" || return 1
    syncDevelopBranch "$label" "$destination"
    installRepoDepsUnlessSkipped "$label" "$destination" ${entryFlags[@]+"${entryFlags[@]}"}
    return 0
  fi
  if ! pathIsRepositoryRoot "$destination"; then
    noteWarned "$label" "exists but is not a git repo"
    return 1
  fi
  if ! repoOriginMatchesListedUrl "$destination" "$cloneUrl"; then
    noteWarned "$label" "origin does not match repos.txt, sync skipped"
    return 1
  fi
  if [[ -n "$(git -C "$destination" status --porcelain 2>/dev/null)" ]]; then
    noteDetail "$label" "skipped, $relativePath holds uncommitted work"
    return 0
  fi
  if ! runGitNetworkCommand -C "$destination" pull --ff-only -q; then
    noteWarned "$label" "pull failed (diverged), resolve manually"
    return 1
  fi
  notePresent "$label" "synced"
  syncDevelopBranch "$label" "$destination"
  installRepoDepsUnlessSkipped "$label" "$destination" ${entryFlags[@]+"${entryFlags[@]}"}
}

if [[ ! -f "$repoListPath" ]]; then
  noteWarned "repos" "no repos.txt, copy repos/repos.example.txt and list your own"
  finishTopic
fi

refreshSessionPath

if ! command -v git >/dev/null 2>&1; then
  noteWarned "repos" "git not on PATH"
  finishTopic
fi

operatorGitHubOwner="$(resolveOperatorGitHubOwner)" || operatorGitHubOwner=""
if [[ -z "$operatorGitHubOwner" ]]; then
  noteWarned "repos" "gh could not name your GitHub account, develop sync skipped everywhere"
fi

# Read up front: git and npm inherit stdin, and one prompt would swallow the rest.
repoLines=()
mapfile -t repoLines < "$repoListPath"

for repoLine in ${repoLines[@]+"${repoLines[@]}"}; do
  repoLine="$(normalizeListLine "$repoLine")"
  if ! listLineIsAnEntry "$repoLine"; then
    continue
  fi
  warningsBeforeEntry="$(warningCountSoFar)"
  if ! syncOneRepo "$repoLine" && (($(warningCountSoFar) == warningsBeforeEntry)); then
    noteWarned "repos" "entry failed, continuing: $(repoEntryPathLabel "$repoLine")"
  fi
done

finishTopic
