#!/usr/bin/env bash

set -euo pipefail

topicDir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repoRoot="$(cd -- "$topicDir/.." && pwd)"
export DOTFILES_PLATFORM=linux
# shellcheck source=../test/harness.sh
source "$repoRoot/test/harness.sh"
# shellcheck source=../script/lib/state.sh
source "$repoRoot/script/lib/state.sh"

startStubbedSandbox "repos"
sandbox="$(cd -- "$sandbox" && pwd)"
linkCoreUtilities bash env cat sed grep sort dirname realpath basename mkdir rm cp mv ln readlink chmod cmp touch mktemp stat wc tr awk cksum
writeDarwinDirectoryServiceStub "$stubBin"

writeStub git <<'GITSHIM'
#!/usr/bin/env bash
set -uo pipefail
printf 'git %s\n' "$*" >> "$DOTFILES_TEST_LOG"

repoPath=""
if [[ "${1:-}" == "-C" ]]; then
  repoPath="$2"
  shift 2
fi
subcommand="${1:-}"
if (($# > 0)); then
  shift
fi

gitMetadataPath() {
  if [[ -f "$repoPath/.git" ]]; then
    sed -n 's/^gitdir: //p' "$repoPath/.git"
    return 0
  fi
  printf '%s/.git\n' "$repoPath"
}

markerPath() {
  printf '%s/%s\n' "$(gitMetadataPath)" "$1"
}

exitFromMarker() {
  if [[ -f "$1" ]]; then
    exit 0
  fi
  exit 1
}

repositoryTopLevel() {
  local candidatePath="$repoPath"
  local parentPath
  while [[ -n "$candidatePath" ]]; do
    if [[ -d "$candidatePath/.git" || -f "$candidatePath/.git" ]]; then
      printf '%s\n' "$candidatePath"
      return 0
    fi
    parentPath="$(dirname -- "$candidatePath")"
    if [[ "$parentPath" == "$candidatePath" ]]; then
      return 1
    fi
    candidatePath="$parentPath"
  done
  return 1
}

case "$subcommand" in
  reset | checkout | stash | clean | restore | switch | rm)
    printf 'git shim: refused %s\n' "$subcommand" >&2
    exit 9
    ;;
  clone)
    cloneUrl=""
    destination=""
    for argument in "$@"; do
      case "$argument" in
        -*) continue ;;
      esac
      if [[ -z "$cloneUrl" ]]; then
        cloneUrl="$argument"
        continue
      fi
      destination="$argument"
    done
    if [[ "$cloneUrl" == *unreachable* ]]; then
      printf 'git shim: clone refused\n' >&2
      exit 128
    fi
    mkdir -p "$destination/.git"
    printf '%s\n' "$cloneUrl" > "$destination/.git/origin-url"
    printf 'main\n' > "$destination/.git/head-branch"
    : > "$destination/.git/has-commits"
    printf 'main\n' > "$destination/.git/origin-head"
    exit 0
    ;;
  remote | config)
    cat "$(markerPath origin-url)" 2>/dev/null
    exit $?
    ;;
  rev-parse)
    for argument in "$@"; do
      case "$argument" in
        --show-toplevel)
          repositoryTopLevel
          exit $?
          ;;
        --git-dir)
          if [[ -d "$repoPath/.git" || -f "$repoPath/.git" ]]; then
            gitMetadataPath
            exit 0
          fi
          exit 1
          ;;
        HEAD) exitFromMarker "$(markerPath has-commits)" ;;
        refs/heads/develop) exitFromMarker "$(markerPath local-develop)" ;;
        refs/remotes/origin/develop) exitFromMarker "$(markerPath remote-develop)" ;;
      esac
    done
    exit 1
    ;;
  status)
    if [[ -f "$repoPath/.dirty" ]]; then
      printf ' M work-in-progress.txt\n'
    fi
    exit 0
    ;;
  pull)
    if [[ -f "$repoPath/.diverged" ]]; then
      printf 'git shim: refusing to pull a diverged tree\n' >&2
      exit 1
    fi
    exit 0
    ;;
  branch)
    : > "$(markerPath local-develop)"
    exit 0
    ;;
  push)
    : > "$(markerPath remote-develop)"
    exit 0
    ;;
  symbolic-ref)
    for argument in "$@"; do
      case "$argument" in
        refs/remotes/origin/HEAD)
          if [[ ! -f "$(markerPath origin-head)" ]]; then
            exit 1
          fi
          printf 'origin/%s\n' "$(cat "$(markerPath origin-head)")"
          exit 0
          ;;
      esac
    done
    cat "$(markerPath head-branch)" 2>/dev/null
    exit 0
    ;;
esac
exit 0
GITSHIM

writeStub gh <<'GHSHIM'
#!/usr/bin/env bash
set -uo pipefail
printf 'gh %s\n' "$*" >> "$DOTFILES_TEST_LOG"
[[ ! -f "$DOTFILES_TEST_STATE/gh-logged-out" ]] || exit 1
if [[ "$*" == "api user --jq .login" ]]; then
  cat "$DOTFILES_TEST_STATE/github-owner"
  exit 0
fi
exit 1
GHSHIM

writeStub npm <<'NPMSHIM'
#!/usr/bin/env bash
set -uo pipefail
printf 'npm %s %s\n' "$PWD" "$*" >> "$DOTFILES_TEST_LOG"
printf 'npm-environment GIT_TERMINAL_PROMPT=%s GIT_SSH_COMMAND=%s\n' \
  "${GIT_TERMINAL_PROMPT:-unset}" "${GIT_SSH_COMMAND:-unset}" >> "$DOTFILES_TEST_LOG"
if IFS= read -r -t 1 promptAnswer; then
  printf 'npm read stdin %s\n' "$promptAnswer" >> "$DOTFILES_TEST_LOG"
fi
if [[ -f "$DOTFILES_TEST_STATE/expected-deps-pending-path" ]]; then
  expectedDepsPendingPath="$(cat "$DOTFILES_TEST_STATE/expected-deps-pending-path")"
  if [[ ! -f "$expectedDepsPendingPath" ]]; then
    printf 'npm missing deps pending marker %s\n' "$expectedDepsPendingPath" >> "$DOTFILES_TEST_LOG"
    exit 2
  fi
fi
if [[ -f "$DOTFILES_TEST_STATE/npm-install-fails" ]]; then
  exit 1
fi
if [[ -f "$DOTFILES_TEST_STATE/npm-installs-node-pty" ]]; then
  for helperDirectory in build/Release prebuilds/darwin-arm64; do
    mkdir -p "node_modules/node-pty/$helperDirectory"
    : > "node_modules/node-pty/$helperDirectory/spawn-helper"
    chmod 644 "node_modules/node-pty/$helperDirectory/spawn-helper"
  done
fi
exit 0
NPMSHIM

for lockfileAwarePackageManager in yarn pnpm; do
  writeStub "$lockfileAwarePackageManager" <<STUB
#!/usr/bin/env bash
printf '$lockfileAwarePackageManager %s %s\n' "\$PWD" "\$*" >> "\$DOTFILES_TEST_LOG"
exit 0
STUB
done

for presentFromTheStart in git gh npm yarn pnpm; do
  provideCommand "$presentFromTheStart"
done
printf 'johncwaters\n' > "$stubState/github-owner"

makeExistingClone() {
  local relativePath="$1"
  local cloneUrl="$2"
  local clonePath="$sandbox/$relativePath"
  mkdir -p "$clonePath/.git"
  printf '%s\n' "$cloneUrl" > "$clonePath/.git/origin-url"
  printf 'main\n' > "$clonePath/.git/head-branch"
  : > "$clonePath/.git/has-commits"
  printf 'main\n' > "$clonePath/.git/origin-head"
  : > "$clonePath/.git/local-develop"
  : > "$clonePath/.git/remote-develop"
}

makeExistingLinkedWorktree() {
  local relativePath="$1"
  local cloneUrl="$2"
  local clonePath="$sandbox/$relativePath"
  local metadataPath="$sandbox/worktree-metadata/$(basename -- "$relativePath")"
  mkdir -p "$clonePath" "$metadataPath"
  printf 'gitdir: %s\n' "$metadataPath" > "$clonePath/.git"
  printf '%s\n' "$cloneUrl" > "$metadataPath/origin-url"
  printf 'main\n' > "$metadataPath/head-branch"
  : > "$metadataPath/has-commits"
  printf 'main\n' > "$metadataPath/origin-head"
  : > "$metadataPath/local-develop"
  : > "$metadataPath/remote-develop"
}

runInstall() {
  local listPath="$1"
  local stdinPath="${2:-/dev/null}"
  local machinePlatform="${3:-linux}"
  runInStubbedSandbox "$sandbox" \
    PATH="$stubBin:$coreBin" \
    DOTFILES_PLATFORM="$machinePlatform" \
    DOTFILES_TEST_HOMEBREW_PREFIX="$sandbox/homebrew" \
    DOTFILES_PROFILE=personal \
    NO_COLOR=1 \
    DOTFILES_MARKER_PATH="$sandbox/.machine-profile" \
    DOTFILES_REPOS_FILE="$listPath" \
    bash "$topicDir/install.sh" < "$stdinPath"
}

collectList="$sandbox/collected.txt"
runCollect() {
  runInStubbedSandbox "$sandbox" \
    PATH="$stubBin:$coreBin" \
    NO_COLOR=1 \
    DOTFILES_REPOS_FILE="${1:-$collectList}" \
    bash "$topicDir/collect.sh"
}

gitNeverRewroteATree() {
  test "$(countLogLines '^git (-C [^ ]+ )?(reset|checkout|stash|clean|restore|switch|rm)( |$)')" -eq 0
}

collectedListLacks() {
  ! grep -qF -- "$1" "$collectList"
}

printf '\nrepos topic\n'
[[ -s "$topicDir/test/install.sh" ]] || exit 1
# shellcheck source=./test/install.sh
source "$topicDir/test/install.sh" || exit 1

darwinList="$sandbox/darwin-list.txt"
printf 'Projects/darwin=https://github.com/johncwaters/darwin nodeps\n' > "$darwinList"
: > "$commandLog"
darwinInstallStatus=0
darwinInstallOutput="$(runInstall "$darwinList" /dev/null darwin)" || darwinInstallStatus=$?
check "repos converges on darwin" test "$darwinInstallStatus" -eq 0
check "darwin clones the listed repo" test -d "$sandbox/Projects/darwin/.git"
check "darwin reports no platform warning" outputLacks "$darwinInstallOutput" "unsupported platform"

[[ -s "$topicDir/test/collect.sh" ]] || exit 1
# shellcheck source=./test/collect.sh
source "$topicDir/test/collect.sh" || exit 1

profileFixtureRepo="$sandbox/profile-repo"
mkdir -p "$profileFixtureRepo/repos" "$profileFixtureRepo/profiles/declared" \
  "$profileFixtureRepo/profiles/fallback"
profileFixtureRepo="$(cd -- "$profileFixtureRepo" && pwd)"
cp "$topicDir/paths.sh" "$topicDir/install.sh" "$topicDir/collect.sh" "$profileFixtureRepo/repos/"
cp -R "$repoRoot/script" "$profileFixtureRepo/"
profileFixtureList="$profileFixtureRepo/profiles/declared/repos.txt"
printf 'Projects/profile-clone=https://github.com/PostHog/profile-clone nodeps\n' > "$profileFixtureList"
printf 'Projects/fallback-clone=https://github.com/PostHog/fallback-clone nodeps\n' > "$profileFixtureRepo/repos/repos.txt"
rm "$sandbox/.dotfiles"
ln -s "$profileFixtureRepo" "$sandbox/.dotfiles"

resolveFixtureList() {
  runInStubbedSandbox "$sandbox" DOTFILES_PROFILE="$1" \
    DOTFILES_REPOS_FILE="${2:-}" bash -c 'source "$1/repos/paths.sh"; reposListPath' _ "$profileFixtureRepo"
}

check "an active profile resolves its declared list" \
  test "$(resolveFixtureList declared)" = "$profileFixtureList"
check "the override wins over a profile-declared list" \
  test "$(resolveFixtureList declared "$mainList")" = "$mainList"
check "profiles without a declared list use the machine list" \
  test "$(resolveFixtureList fallback)" = "$profileFixtureRepo/repos/repos.txt"
printf 'declared\n' > "$DOTFILES_MARKER_PATH"
check "the marker resolves the profile list without an environment selection" \
  test "$(resolveFixtureList '')" = "$profileFixtureList"

: > "$commandLog"
profileInstallOutput="$(runInStubbedSandbox "$sandbox" DOTFILES_PROFILE=declared \
  DOTFILES_REPOS_FILE= NO_COLOR=1 bash "$profileFixtureRepo/repos/install.sh")"
check "a profile-declared list clones its repository" test -d "$sandbox/Projects/profile-clone/.git"
check "a profile-declared nodeps entry installs no dependencies" logLacks 'npm '
check "profile install does not read the machine fallback" test ! -e "$sandbox/Projects/fallback-clone"

cp "$profileFixtureList" "$stubState/profile-list-before-collect"
profileCollectOutput="$(runInStubbedSandbox "$sandbox" DOTFILES_PROFILE=declared \
  DOTFILES_REPOS_FILE= bash "$profileFixtureRepo/repos/collect.sh")"
check "collect leaves a profile-declared list byte-identical" \
  cmp -s "$profileFixtureList" "$stubState/profile-list-before-collect"
check "collect explains why a declared list is not collected" outputHas "$profileCollectOutput" 'profile-declared list'
runInStubbedSandbox "$sandbox" DOTFILES_PROFILE=fallback DOTFILES_REPOS_FILE="$profileFixtureList" \
  bash "$profileFixtureRepo/repos/collect.sh" >/dev/null
check "collect cannot overwrite a declared list through the override" \
  cmp -s "$profileFixtureList" "$stubState/profile-list-before-collect"
runInStubbedSandbox "$sandbox" DOTFILES_PROFILE=declared DOTFILES_REPOS_FILE="$collectList" \
  bash "$profileFixtureRepo/repos/collect.sh" >/dev/null 2>&1
check "collect still merges an explicit machine list for a declared profile" \
  grep -qx 'Projects/alpha=https://github.com/johncwaters/alpha' "$collectList"
runInStubbedSandbox "$sandbox" DOTFILES_PROFILE=fallback DOTFILES_REPOS_FILE= \
  bash "$profileFixtureRepo/repos/collect.sh" >/dev/null 2>&1
check "collect still merges the machine fallback for an undeclared profile" \
  grep -qx 'Projects/alpha=https://github.com/johncwaters/alpha' "$profileFixtureRepo/repos/repos.txt"

reportTopicResults "repos"
