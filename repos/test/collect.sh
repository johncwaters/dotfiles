# shellcheck shell=bash
collectWithoutGlimmervoidStatus=0
runCollect > /dev/null 2>&1 || collectWithoutGlimmervoidStatus=$?
check "collect without glimmervoid exits clean" test "$collectWithoutGlimmervoidStatus" -eq 0
check "collect without glimmervoid writes nothing" test ! -e "$collectList"

mkdir -p "$sandbox/.glimmervoid" "$sandbox/.git"
printf 'https://github.com/johncwaters/home\n' > "$sandbox/.git/origin-url"
makeExistingLinkedWorktree "Projects/collected-linked" \
  "https://github.com/johncwaters/collected-linked"
mkdir -p "$sandbox/Projects/gamma/nested"
cat > "$sandbox/.glimmervoid/config.json" <<CONFIG
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
check "a merge keeps an entry glimmervoid never reported" \
  grep -qx 'Projects/handpicked=https://github.com/johncwaters/handpicked' "$mergedList"
check "a merge adds what glimmervoid did report" \
  grep -qx 'Projects/alpha=https://github.com/johncwaters/alpha' "$mergedList"
check "a merge lists each path once" \
  bash -c 'test "$(grep -c "^Projects/gamma=" "$1")" -eq 1' _ "$mergedList"

unterminatedList="$sandbox/unterminated.txt"
printf 'Projects/gamma=https://github.com/johncwaters/gamma nodeps\n' > "$unterminatedList"
printf 'Projects/handadded=https://github.com/johncwaters/handadded' >> "$unterminatedList"
runCollect "$unterminatedList" > /dev/null 2>&1
check "a merge keeps a last line with no trailing newline" \
  grep -qF 'Projects/handadded=https://github.com/johncwaters/handadded' "$unterminatedList"
check "a merge still adds what glimmervoid reported to an unterminated list" \
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
