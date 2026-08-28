#!/usr/bin/env bash

set -euo pipefail

topicDir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repoRoot="$(cd -- "$topicDir/.." && pwd)"
# shellcheck source=../test/harness.sh
source "$repoRoot/test/harness.sh"
# shellcheck source=../script/lib/state.sh
source "$repoRoot/script/lib/state.sh"

startStubbedSandbox "repos"

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
  runInStubbedSandbox "$sandbox" \
    PATH="$stubBin:/usr/bin:/bin" \
    DOTFILES_PROFILE=personal \
    NO_COLOR=1 \
    DOTFILES_MARKER_PATH="$sandbox/.machine-profile" \
    DOTFILES_REPOS_FILE="$listPath" \
    bash "$topicDir/install.sh" < "$stdinPath"
}

gitNeverRewroteATree() {
  test "$(countLogLines '^git (-C [^ ]+ )?(reset|checkout|stash|clean|restore|switch|rm)( |$)')" -eq 0
}

collectedListLacks() {
  ! grep -qF -- "$1" "$collectList"
}

printf '\nrepos topic\n'

mainList="$sandbox/main-list.txt"
cat > "$mainList" <<LIST
# a comment line is skipped
Projects/alpha=https://github.com/johncwaters/alpha
Projects\\beta=https://github.com/johncwaters/beta
Projects/gamma=https://github.com/johncwaters/gamma nodeps
Projects/delta=https://github.com/johncwaters/delta
Projects/theirs=https://github.com/someoneelse/theirs
LIST

makeExistingClone "Projects/gamma" "https://github.com/johncwaters/gamma"
printf '{"name":"gamma"}\n' > "$sandbox/Projects/gamma/package.json"
makeExistingClone "Projects/delta" "https://github.com/johncwaters/delta"
printf '{"name":"delta"}\n' > "$sandbox/Projects/delta/package.json"

installStatus=0
firstRunOutput="$(runInstall "$mainList")" || installStatus=$?
check "install exits clean" test "$installStatus" -eq 0
check "install says what it did" test -n "$firstRunOutput"

check "a missing repo is cloned" test -d "$sandbox/Projects/alpha/.git"
check "the clone uses the entry's url" \
  grep -qx 'https://github.com/johncwaters/alpha' "$sandbox/Projects/alpha/.git/origin-url"
check "the clone lands at the entry's path" \
  logHas "git clone -q -- https://github.com/johncwaters/alpha $sandbox/Projects/alpha"

check "a backslash path is translated" test -d "$sandbox/Projects/beta/.git"
check "no directory is named with a literal backslash" \
  test ! -e "$sandbox/Projects\\beta"
check "nothing was cloned into a backslashed name" \
  logLacks 'git Projects\beta'

check "a present repo is pulled" logHas "git -C $sandbox/Projects/gamma pull --ff-only -q"
check "a present repo is not recloned" \
  logLacks "git clone -q -- https://github.com/johncwaters/gamma"

check "a nodeps entry installs nothing" logLacks "npm $sandbox/Projects/gamma "
check "an entry without nodeps installs deps" logHas "npm $sandbox/Projects/delta install"

check "your own repo gets develop created from the remote default branch" \
  logHas "git -C $sandbox/Projects/alpha branch -q develop origin/main"
check "your own repo gets develop pushed" logHas "git -C $sandbox/Projects/alpha push -q -u origin develop"
check "someone else's repo is cloned" test -d "$sandbox/Projects/theirs/.git"
check "someone else's repo is never branched" logLacks "git -C $sandbox/Projects/theirs branch"
check "someone else's repo is never pushed" logLacks "git -C $sandbox/Projects/theirs push"

failingDepsList="$sandbox/failing-deps-list.txt"
printf 'Projects/failing=https://github.com/johncwaters/failing\n' > "$failingDepsList"
makeExistingClone "Projects/failing" "https://github.com/johncwaters/failing"
printf '{"name":"failing"}\n' > "$sandbox/Projects/failing/package.json"
failingDepsPendingStateName="$(HOME="$sandbox" \
  repoDepsPendingStateNameForPath "$sandbox/Projects/failing")"
failingDepsPendingPath="$sandbox/.local/state/dotfiles/$failingDepsPendingStateName"
printf '%s\n' "$failingDepsPendingPath" > "$stubState/expected-deps-pending-path"
: > "$stubState/npm-install-fails"
: > "$commandLog"
failingDepsStatus=0
failingDepsOutput="$(runInstall "$failingDepsList")" || failingDepsStatus=$?
check "the dependency marker exists before npm runs" logLacks "npm missing deps pending marker"
check "a failed dependency install warns" \
  outputMatches "$failingDepsOutput" '\[warn\].*npm install failed'
check "a failed dependency install exits non-zero" test "$failingDepsStatus" -eq 1
check "a failed dependency install leaves its convergence marker pending" \
  test -f "$failingDepsPendingPath"

rm -f "$stubState/npm-install-fails"
: > "$commandLog"
runInstall "$failingDepsList" > /dev/null
check "a successful dependency install clears its convergence marker" \
  test ! -e "$failingDepsPendingPath"
rm -f "$stubState/expected-deps-pending-path"

normalizedOriginList="$sandbox/normalized-origin-list.txt"
printf 'Projects/normalized=https://github.com/johncwaters/normalized\n' > "$normalizedOriginList"
makeExistingClone "Projects/normalized" "https://GITHUB.COM/johncwaters/normalized.git/"
: > "$commandLog"
normalizedOriginOutput="$(runInstall "$normalizedOriginList")"
check "origin comparison lowercases the host and strips git suffixes" \
  logHas "git -C $sandbox/Projects/normalized pull --ff-only -q"
check "a normalized matching origin is not warned about" \
  outputLacks "$normalizedOriginOutput" "origin does not match"

linkedWorktreeList="$sandbox/linked-worktree-list.txt"
printf 'Projects/linked=https://github.com/johncwaters/linked\n' > "$linkedWorktreeList"
makeExistingLinkedWorktree "Projects/linked" "https://github.com/johncwaters/linked"
: > "$commandLog"
linkedWorktreeOutput="$(runInstall "$linkedWorktreeList")"
check "install accepts a linked worktree with a regular .git file" \
  logHas "git -C $sandbox/Projects/linked pull --ff-only -q"
check "a linked worktree is not warned about as a non-repo" \
  outputLacks "$linkedWorktreeOutput" "is not a git repo"

nestedRepoList="$sandbox/nested-repo-list.txt"
printf 'Projects/parent/nested=https://github.com/johncwaters/nested\n' > "$nestedRepoList"
makeExistingClone "Projects/parent" "https://github.com/johncwaters/parent"
mkdir -p "$sandbox/Projects/parent/nested"
: > "$commandLog"
nestedRepoStatus=0
nestedRepoOutput="$(runInstall "$nestedRepoList")" || nestedRepoStatus=$?
check "install rejects a directory nested inside another repository" test "$nestedRepoStatus" -eq 1
check "a nested directory is reported as not being a repository root" \
  outputHas "$nestedRepoOutput" "exists but is not a git repo"
check "a nested directory is never pulled as a repository" \
  logLacks "git -C $sandbox/Projects/parent/nested pull"

mismatchedOriginList="$sandbox/mismatched-origin-list.txt"
printf 'Projects/mismatched=https://github.com/johncwaters/listed\n' > "$mismatchedOriginList"
makeExistingClone "Projects/mismatched" "https://github.com/johncwaters/actual"
printf '{"name":"mismatched"}\n' > "$sandbox/Projects/mismatched/package.json"
: > "$commandLog"
mismatchedOriginStatus=0
mismatchedOriginOutput="$(runInstall "$mismatchedOriginList")" || mismatchedOriginStatus=$?
check "a mismatched origin warns" \
  outputMatches "$mismatchedOriginOutput" '\[warn\].*origin does not match repos.txt'
check "a mismatched origin makes the topic exit non-zero" test "$mismatchedOriginStatus" -eq 1
check "a mismatched origin is not pulled" logLacks "git -C $sandbox/Projects/mismatched pull"
check "a mismatched origin gets no develop sync" logLacks "git -C $sandbox/Projects/mismatched branch"
check "a mismatched origin gets no dependency install" logLacks "npm $sandbox/Projects/mismatched "

depsConsentInput="$sandbox/deps-consent-input"
printf 'y\n' > "$depsConsentInput"
: > "$commandLog"
runInstall "$mainList" "$depsConsentInput" > /dev/null
check "the deps install cannot sit on a credential prompt" \
  logHas "npm-environment GIT_TERMINAL_PROMPT=0"
check "the deps install cannot sit on an ssh prompt either" \
  logHas "GIT_SSH_COMMAND=ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new"
check "the deps install never reads the converge's stdin" logLacks "npm read stdin"

bomInstallList="$sandbox/bom-install.txt"
printf '\xEF\xBB\xBFProjects/bom=https://github.com/johncwaters/bom nodeps\r\n' > "$bomInstallList"
: > "$commandLog"
runInstall "$bomInstallList" > /dev/null
check "install normalizes a BOM and carriage return before parsing" \
  test -d "$sandbox/Projects/bom/.git"
check "normalization keeps the nodeps flag attached to the entry" \
  logLacks "npm $sandbox/Projects/bom "

sideList="$sandbox/side-list.txt"
printf 'Projects/side=https://github.com/johncwaters/side\n' > "$sideList"
makeExistingClone "Projects/side" "https://github.com/johncwaters/side"
rm -f "$sandbox/Projects/side/.git/local-develop" "$sandbox/Projects/side/.git/remote-develop"
printf 'feature-branch\n' > "$sandbox/Projects/side/.git/head-branch"
sideRunOutput="$(runInstall "$sideList")"
check "a HEAD off the default branch does not publish develop" \
  outputHas "$sideRunOutput" "HEAD is not on main"
check "a HEAD off the default branch creates no develop" \
  logLacks "git -C $sandbox/Projects/side branch"
check "a HEAD off the default branch pushes nothing" \
  logLacks "git -C $sandbox/Projects/side push"

secondRunStatus=0
secondRunOutput="$(runInstall "$mainList")" || secondRunStatus=$?
check "the second run exits clean" test "$secondRunStatus" -eq 0
check "second run reports no changes" reportsNoChanges "$secondRunOutput"

dirtyList="$sandbox/dirty-list.txt"
printf 'Projects/dirty=https://github.com/johncwaters/dirty\n' > "$dirtyList"
makeExistingClone "Projects/dirty" "https://github.com/johncwaters/dirty"
printf '{"name":"dirty"}\n' > "$sandbox/Projects/dirty/package.json"
: > "$sandbox/Projects/dirty/.dirty"
printf 'unfinished work\n' > "$sandbox/Projects/dirty/work-in-progress.txt"

dirtyRunStatus=0
dirtyRunOutput="$(runInstall "$dirtyList")" || dirtyRunStatus=$?
check "a dirty tree is left alone rather than converged" test "$dirtyRunStatus" -eq 0
check "the skip names the repo it left alone" outputHas "$dirtyRunOutput" "Projects/dirty"
check "a dirty tree is never pulled" logLacks "git -C $sandbox/Projects/dirty pull"
check "a dirty tree never has its lockfile rewritten" logLacks "npm $sandbox/Projects/dirty "
check "the dirty work survives" grep -q 'unfinished work' "$sandbox/Projects/dirty/work-in-progress.txt"
check "a dirty repo is never branched" logLacks "git -C $sandbox/Projects/dirty branch"

lockfileList="$sandbox/lockfile-list.txt"
cat > "$lockfileList" <<LIST
Projects/nolock=https://github.com/johncwaters/nolock
Projects/npmlock=https://github.com/johncwaters/npmlock
Projects/yarnlock=https://github.com/johncwaters/yarnlock
Projects/pnpmlock=https://github.com/johncwaters/pnpmlock
LIST
for lockfileRepoName in nolock npmlock yarnlock pnpmlock; do
  makeExistingClone "Projects/$lockfileRepoName" "https://github.com/johncwaters/$lockfileRepoName"
  printf '{"name":"%s"}\n' "$lockfileRepoName" > "$sandbox/Projects/$lockfileRepoName/package.json"
done
printf '{}\n' > "$sandbox/Projects/npmlock/package-lock.json"
printf 'lockfileVersion: 1\n' > "$sandbox/Projects/yarnlock/yarn.lock"
printf 'lockfileVersion: 6.0\n' > "$sandbox/Projects/pnpmlock/pnpm-lock.yaml"
: > "$commandLog"
runInstall "$lockfileList" > /dev/null
check "a repo tracking no lockfile is installed without writing one" \
  logHas "npm $sandbox/Projects/nolock install --no-package-lock"
check "a repo tracking no lockfile still has none afterwards" \
  test ! -e "$sandbox/Projects/nolock/package-lock.json"
check "a repo with a package-lock is installed from it rather than resolving anew" \
  logHas "npm $sandbox/Projects/npmlock ci"
check "a repo with a package-lock never runs a plain npm install" \
  logLacks "npm $sandbox/Projects/npmlock install"
check "a yarn repo is installed against its frozen lockfile" \
  logHas "yarn $sandbox/Projects/yarnlock install --frozen-lockfile"
check "a pnpm repo is installed against its frozen lockfile" \
  logHas "pnpm $sandbox/Projects/pnpmlock install --frozen-lockfile"

divergedList="$sandbox/diverged-list.txt"
printf 'Projects/diverged=https://github.com/johncwaters/diverged\n' > "$divergedList"
makeExistingClone "Projects/diverged" "https://github.com/johncwaters/diverged"
: > "$sandbox/Projects/diverged/.diverged"

divergedRunStatus=0
divergedRunOutput="$(runInstall "$divergedList")" || divergedRunStatus=$?
check "a tree that cannot fast forward warns" test "$divergedRunStatus" -eq 1
check "the warning says to resolve it by hand" outputHas "$divergedRunOutput" "resolve manually"
check "no run ever reset, stashed or discarded" gitNeverRewroteATree

noGhList="$sandbox/no-gh-list.txt"
printf 'Projects/epsilon=https://github.com/johncwaters/epsilon\n' > "$noGhList"
withdrawCommand gh
noGhStatus=0
noGhOutput="$(runInstall "$noGhList")" || noGhStatus=$?
provideCommand gh
check "a missing gh warns" outputHas "$noGhOutput" "gh could not name your GitHub account"
check "a missing gh still clones" test -d "$sandbox/Projects/epsilon/.git"
check "a missing gh skips develop instead of guessing" \
  logLacks "git -C $sandbox/Projects/epsilon branch"
check "a warning makes the topic exit non-zero" test "$noGhStatus" -eq 1

missingListStatus=0
missingListOutput="$(runInstall "$sandbox/not-a-list.txt")" || missingListStatus=$?
check "a missing repos.txt warns" test "$missingListStatus" -eq 1
check "the missing list warning names the example" outputHas "$missingListOutput" "repos.example.txt"

escapeList="$sandbox/escape-list.txt"
cat > "$escapeList" <<'LIST'
.=https://github.com/johncwaters/home
../escaped=https://github.com/johncwaters/escaped
/etc/escaped=https://github.com/johncwaters/absolute
Projects/nourl=
LIST
escapeStatus=0
escapeOutput="$(runInstall "$escapeList")" || escapeStatus=$?
check "a path outside home is refused" test "$escapeStatus" -eq 1
check "no refusal echoes the clone url beside the path" \
  outputLacks "$escapeOutput" 'escaped=https://'
check "the refusal names the home directory rule" \
  outputHas "$escapeOutput" "must stay under the home directory"
check "nothing was written beside the sandbox" test ! -e "$(dirname -- "$sandbox")/escaped"
check "an entry with no url is refused" outputHas "$escapeOutput" "no clone url"
check "the home directory itself is not a repo entry" \
  outputHas "$escapeOutput" "must stay under the home directory: ."
check "no repo was cloned from a refused list" test ! -d "$sandbox/Projects/nourl"

dashUrlList="$sandbox/dash-url.txt"
printf 'Projects/dashed=--upload-pack=touch /dev/null\n' > "$dashUrlList"
: > "$commandLog"
dashUrlStatus=0
dashUrlOutput="$(runInstall "$dashUrlList")" || dashUrlStatus=$?
check "a clone url that reads as an option is refused" test "$dashUrlStatus" -eq 1
check "the refusal says a url may not start with a dash" \
  outputHas "$dashUrlOutput" "must not start with a dash"
check "a clone url that reads as an option is never cloned" logLacks "git clone"

collectList="$sandbox/collected.txt"
runCollect() {
  runInStubbedSandbox "$sandbox" \
    PATH="$stubBin:/usr/bin:/bin" \
    NO_COLOR=1 \
    DOTFILES_REPOS_FILE="${1:-$collectList}" \
    bash "$topicDir/collect.sh"
}

collectWithoutGlissaStatus=0
runCollect > /dev/null 2>&1 || collectWithoutGlissaStatus=$?
check "collect without glissa exits clean" test "$collectWithoutGlissaStatus" -eq 0
check "collect without glissa writes nothing" test ! -e "$collectList"

mkdir -p "$sandbox/.glissa" "$sandbox/.git"
printf 'https://github.com/johncwaters/home\n' > "$sandbox/.git/origin-url"
makeExistingLinkedWorktree "Projects/collected-linked" \
  "https://github.com/johncwaters/collected-linked"
mkdir -p "$sandbox/Projects/gamma/nested"
cat > "$sandbox/.glissa/config.json" <<CONFIG
{ "projects": [
  { "path": "$sandbox/Projects/gamma" },
  { "path": "$sandbox/Projects/alpha" },
  { "path": "$sandbox/Projects/collected-linked" },
  { "path": "$sandbox/Projects/gamma/nested" },
  { "path": "$sandbox" },
  { "path": "$sandbox/" },
  { "path": "/elsewhere/outside-home" }
] }
CONFIG
collectOutput="$(runCollect 2>&1)"
check "collect writes the list" test -s "$collectList"
check "collect records a path relative to home" \
  grep -qx 'Projects/alpha=https://github.com/johncwaters/alpha' "$collectList"
check "collect accepts a linked worktree with a regular .git file" \
  grep -qx 'Projects/collected-linked=https://github.com/johncwaters/collected-linked' \
    "$collectList"
check "collect leaves out a directory nested inside another repository" \
  collectedListLacks 'Projects/gamma/nested='
check "collect sorts the list" sort -c "$collectList"
check "collect leaves out a project outside home" collectedListLacks "outside-home"
check "collect leaves out the home directory itself" \
  collectedListLacks '.=https://github.com/johncwaters/home'
check "collect warns before an empty relative path reaches an associative array" \
  outputHas "$collectOutput" 'home directory is not a repo entry'

mergedList="$sandbox/merged.txt"
cat > "$mergedList" <<'LIST'
# a hand written header
Projects/gamma=https://github.com/johncwaters/gamma nodeps
Projects/handpicked=https://github.com/johncwaters/handpicked
LIST
runCollect "$mergedList" > /dev/null 2>&1
check "a merge keeps the hand written comment" grep -qx '# a hand written header' "$mergedList"
check "a merge keeps a nodeps flag" \
  grep -qx 'Projects/gamma=https://github.com/johncwaters/gamma nodeps' "$mergedList"
check "a merge keeps an entry glissa never reported" \
  grep -qx 'Projects/handpicked=https://github.com/johncwaters/handpicked' "$mergedList"
check "a merge adds what glissa did report" \
  grep -qx 'Projects/alpha=https://github.com/johncwaters/alpha' "$mergedList"
check "a merge lists each path once" \
  bash -c 'test "$(grep -c "^Projects/gamma=" "$1")" -eq 1' _ "$mergedList"

unterminatedList="$sandbox/unterminated.txt"
printf 'Projects/gamma=https://github.com/johncwaters/gamma nodeps\n' > "$unterminatedList"
printf 'Projects/handadded=https://github.com/johncwaters/handadded' >> "$unterminatedList"
runCollect "$unterminatedList" > /dev/null 2>&1
check "a merge keeps a last line with no trailing newline" \
  grep -qF 'Projects/handadded=https://github.com/johncwaters/handadded' "$unterminatedList"
check "a merge still adds what glissa reported to an unterminated list" \
  grep -qx 'Projects/alpha=https://github.com/johncwaters/alpha' "$unterminatedList"

tabFlagList="$sandbox/tab-flag.txt"
printf 'Projects/gamma=https://github.com/johncwaters/gamma\tnodeps\n' > "$tabFlagList"
runCollect "$tabFlagList" > /dev/null 2>&1
check "a merge keeps a tab separated flag" \
  grep -qF 'https://github.com/johncwaters/gamma nodeps' "$tabFlagList"
check "a tab separated flag is not spliced into the url" \
  bash -c '! grep -qF "gamma\tnodeps" "$1"' _ "$tabFlagList"

spacedList="$sandbox/spaced-equals.txt"
printf 'Projects/gamma = https://github.com/johncwaters/stale nodeps\n' > "$spacedList"
runCollect "$spacedList" > /dev/null 2>&1
check "a spaced separator keeps the entry's flag" grep -qF 'nodeps' "$spacedList"
check "a spaced separator does not turn the url into a flag" \
  bash -c '! grep -qF "https://github.com/johncwaters/stale" "$1"' _ "$spacedList"
check "a spaced separator collects one entry, not two" \
  bash -c 'test "$(grep -c "gamma" "$1")" -eq 1' _ "$spacedList"

bomMergeList="$sandbox/bom-merge.txt"
printf '\xEF\xBB\xBFProjects/gamma=https://github.com/johncwaters/stale nodeps\r\n' > "$bomMergeList"
runCollect "$bomMergeList" > /dev/null 2>&1
check "collect matches a BOM prefixed entry instead of duplicating it" \
  bash -c 'test "$(grep -c "^Projects/gamma=" "$1")" -eq 1' _ "$bomMergeList"
check "collect keeps a BOM prefixed entry's nodeps flag" \
  grep -qx 'Projects/gamma=https://github.com/johncwaters/gamma nodeps' "$bomMergeList"

emptyPathList="$sandbox/empty-path.txt"
printf '=https://github.com/johncwaters/empty\n' > "$emptyPathList"
emptyPathStatus=0
emptyPathOutput="$(runCollect "$emptyPathList" 2>&1)" || emptyPathStatus=$?
check "collect survives an empty existing list path without aborting" test "$emptyPathStatus" -eq 0
check "collect warns about an empty existing list path" \
  outputHas "$emptyPathOutput" 'empty list path, keeping it as it was'
check "a line collect could not key on is kept exactly as its owner wrote it" \
  grep -qx -- '=https://github.com/johncwaters/empty' "$emptyPathList"

symlinkedListTarget="$sandbox/a-list-outside-the-repo.txt"
printf 'Projects/gamma=https://github.com/johncwaters/gamma\n' > "$symlinkedListTarget"
symlinkedList="$sandbox/symlinked-repos.txt"
ln -s "$symlinkedListTarget" "$symlinkedList"
symlinkedListStatus=0
symlinkedListOutput="$(runCollect "$symlinkedList" 2>&1)" || symlinkedListStatus=$?
check "collect refuses a list path that is a symlink" test "$symlinkedListStatus" -eq 1
check "the refusal names the file to move aside" \
  outputHas "$symlinkedListOutput" 'is not a regular file, move it aside first'
check "a symlinked list path is left as a symlink" test -L "$symlinkedList"
check "the file the list pointed at is left alone" \
  bash -c 'test "$(wc -l < "$1")" -eq 1' _ "$symlinkedListTarget"
check "collect sources the shared state path predicate" \
  grep -q 'script/lib/state.sh' "$topicDir/collect.sh"
check "collect loads logging before state failure paths" \
  awk '/script\/lib\/log.sh/ { logLine = NR } /script\/lib\/state.sh/ { stateLine = NR } END { exit !(logLine && stateLine && logLine < stateLine) }' \
    "$topicDir/collect.sh"
check "collect uses the shared plain file predicate" \
  grep -q 'pathIsPlainFileOrAbsent "$repoListPath"' "$topicDir/collect.sh"

check "install and collect resolve one list path" \
  bash -c 'grep -q "reposListPath" "$1/install.sh" && grep -q "reposListPath" "$1/collect.sh"' \
  _ "$topicDir"
check "the example list is tracked" test -f "$topicDir/repos.example.txt"
check "the machine list is ignored" grep -qx 'repos/repos.txt' "$repoRoot/.gitignore"

reportTopicResults "repos"
