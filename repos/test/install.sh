# shellcheck shell=bash
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

nodePtyList="$sandbox/node-pty-list.txt"
printf 'Projects/ptyuser=https://github.com/johncwaters/ptyuser\n' > "$nodePtyList"
makeExistingClone "Projects/ptyuser" "https://github.com/johncwaters/ptyuser"
printf '{"name":"ptyuser"}\n' > "$sandbox/Projects/ptyuser/package.json"
: > "$stubState/npm-installs-node-pty"
nodePtyOutput="$(runInstall "$nodePtyList")"
rm -f "$stubState/npm-installs-node-pty"
check "a prebuilt node-pty spawn-helper is executable after the install" \
  test -x "$sandbox/Projects/ptyuser/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper"
check "a compiled node-pty spawn-helper is executable after the install" \
  test -x "$sandbox/Projects/ptyuser/node_modules/node-pty/build/Release/spawn-helper"
check "the spawn-helper repair is reported" outputHas "$nodePtyOutput" "spawn-helper made executable"
nodePtyRerunOutput="$(runInstall "$nodePtyList")"
check "an already executable spawn-helper is not reported again" \
  outputLacks "$nodePtyRerunOutput" "spawn-helper made executable"

symlinkTargetPath="$sandbox/.ssh-like-secret"
: > "$symlinkTargetPath"
chmod 600 "$symlinkTargetPath"
symlinkPtyList="$sandbox/symlink-pty-list.txt"
printf 'Projects/ptysymlink=https://github.com/johncwaters/ptysymlink\n' > "$symlinkPtyList"
makeExistingClone "Projects/ptysymlink" "https://github.com/johncwaters/ptysymlink"
printf '{"name":"ptysymlink"}\n' > "$sandbox/Projects/ptysymlink/package.json"
mkdir -p "$sandbox/Projects/ptysymlink/node_modules/node-pty/build/Release"
ln -s "$symlinkTargetPath" "$sandbox/Projects/ptysymlink/node_modules/node-pty/build/Release/spawn-helper"
symlinkPtyOutput="$(runInstall "$symlinkPtyList")"
check "a symlinked spawn-helper is never chmod'd" \
  test "$(fileModeOf "$symlinkTargetPath")" = "600"
check "a symlinked spawn-helper is left as a symlink" \
  test -L "$sandbox/Projects/ptysymlink/node_modules/node-pty/build/Release/spawn-helper"
check "a symlinked spawn-helper is not reported as repaired" \
  outputLacks "$symlinkPtyOutput" "spawn-helper made executable"

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
