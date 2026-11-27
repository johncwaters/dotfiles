import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { agyStep, codexPatchCall, codexRolloutLines, makeRepository, removeAll, runHook } from "./harness.mjs";

const sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), "guard-workflow-home-"));
const repository = makeRepository();
const BACKGROUND_TASKS_ENABLED = { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "", CLAUDE_CODE_SIMPLE: "" };
const ATTENDED = { CLAUDE_CODE_SESSION_ATTENDED: "1", HOME: sandboxHome, ...BACKGROUND_TASKS_ENABLED };

after(() => removeAll(sandboxHome, repository));

function prompt(text) {
  return { type: "user", message: { role: "user", content: text } };
}

function toolUse(name, input) {
  return { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: `tool-${name}`, name, input }] } };
}

function assistantText(text) {
  return { type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } };
}

function toolResult(text, { toolUseId = "tool-x", isError = true } = {}) {
  return { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, is_error: isError, content: text }] } };
}

function skillRun(skillName) {
  const launchResult = { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-Skill", content: `Launching skill: ${skillName}` }] } };
  return [toolUse("Skill", { skill: skillName }), launchResult];
}

function writeTranscript(entries) {
  const transcriptPath = path.join(fs.mkdtempSync(path.join(sandboxHome, "transcript-")), "session.jsonl");
  fs.writeFileSync(transcriptPath, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");
  return transcriptPath;
}

function decisionFor(payload, env = ATTENDED) {
  const processResult = runHook("guard-workflow.mjs", payload, env);
  assert.equal(processResult.status, 0, processResult.stderr);
  if (processResult.stdout === "") return { decision: "allow", reason: "" };
  const { permissionDecision, permissionDecisionReason } = JSON.parse(processResult.stdout).hookSpecificOutput;
  return { decision: permissionDecision, reason: permissionDecisionReason };
}

function bashCall(command, transcriptPath, extra = {}) {
  return { tool_name: "Bash", tool_input: { command }, transcript_path: transcriptPath, ...extra };
}

function editCall(filePath, transcriptPath) {
  return { tool_name: "Edit", tool_input: { file_path: filePath, old_string: "a", new_string: "b" }, transcript_path: transcriptPath };
}

test("raw git commit and push outside /landing are denied in every command position", () => {
  const transcriptPath = writeTranscript([prompt("fix the typo")]);
  for (const command of [
    "git commit -m x",
    "git add -A && git commit -q -m wip --no-verify && git status",
    "env -u GH_TOKEN git push origin HEAD:refs/heads/someone/branch",
    "git -C /repo commit -F -",
    "cd /repo; /usr/bin/git push",
    "bash -c 'git commit -m x'",
    "GIT_EDITOR=true git commit",
    "HUSKY=0 git push",
    "GIT_DIR=.git git commit -m x",
    'sh -c "git push"',
    "git --git-dir .git commit -m x",
    "git --work-tree . push",
    "git -c alias.ci=commit ci -m x",
    `git -c "alias.ci=!git commit" ci`,
    `git -c 'alias.ci=!git commit' ci`,
    "eval 'git push origin'",
    `echo "don't" && git commit -m 'a b'`,
    "bash <<'EOF'\ngit commit -m x\nEOF",
    "cat <<EOF\n$(git push)\nEOF",
    "cat <<'EOF' | bash\ngit commit -m x\nEOF",
    "cat <<'EOF' > /tmp/s.sh && bash /tmp/s.sh\ngit commit -m x\nEOF",
    "cat <<EOF | sh\ngit push origin main\nEOF",
    `node -e 'require("child_process").execSync("git commit -m x")'`,
    `perl -e 'system("git commit -m x")'`,
  ]) {
    const { decision, reason } = decisionFor(bashCall(command, transcriptPath));
    assert.equal(decision, "deny", command);
    assert.match(reason, /\/landing/);
  }
});

test("outside /landing a commit into a throwaway temp repository and a dry-run push are allowed while a commit that may reach a real repository stays denied", () => {
  const transcriptPath = writeTranscript([prompt("try and break it")]);
  const hookTemporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "guard-workflow-tmpdir-"));
  const hookEnvironment = { ...ATTENDED, TMPDIR: hookTemporaryRoot };
  const temporaryRepository = fs.mkdtempSync(path.join(hookTemporaryRoot, "probe-"));
  fs.mkdirSync(path.join(temporaryRepository, ".git"));
  fs.mkdirSync(path.join(temporaryRepository, "empty"));
  const temporaryRepositoryWithCommonDirectory = fs.mkdtempSync(path.join(hookTemporaryRoot, "common-"));
  fs.mkdirSync(path.join(temporaryRepositoryWithCommonDirectory, ".git"));
  fs.writeFileSync(path.join(temporaryRepositoryWithCommonDirectory, ".git", "commondir"), `${repository}/.git\n`);
  const temporaryWorktree = fs.mkdtempSync(path.join(hookTemporaryRoot, "worktree-"));
  fs.writeFileSync(path.join(temporaryWorktree, ".git"), `gitdir: ${repository}/.git/worktrees/x\n`);
  const temporaryLinkToRepository = path.join(hookTemporaryRoot, "repo-link");
  fs.symlinkSync(repository, temporaryLinkToRepository);
  after(() => removeAll(hookTemporaryRoot));
  for (const command of [
    `git -C ${temporaryRepository} commit --allow-empty -m x`,
    `git -C ${temporaryRepository} -c user.name=a commit -q --allow-empty -m 'a b'`,
    "git push --dry-run origin HEAD",
    "git push -n origin main",
    "git push -n -u -v origin HEAD:main",
  ]) {
    assert.equal(decisionFor(bashCall(command, transcriptPath), hookEnvironment).decision, "allow", command);
  }
  for (const command of [
    `git -C ${repository} commit -m x`,
    "T=$(mktemp -d); git init -q $T/Repo; git -C $T/Repo commit -q --allow-empty -m x",
    'T=$(mktemp -d); git -C "${T}/Repo" commit -m x',
    `X=$(mktemp -d); printf -v $'\\x58' '%s' '/ -C ${repository}'; git -C $X commit -am y`,
    `DIRSTACK=$(mktemp -d); cd ${repository}; git -C $DIRSTACK commit --allow-empty -m x`,
    `cd ${repository}; git -C ${temporaryRepository} commit -m x`,
    `git -C ${repository} worktree add ${hookTemporaryRoot}/w && git -C ${hookTemporaryRoot}/w commit -m x`,
    `git init -q ${hookTemporaryRoot}/fresh && git -C ${hookTemporaryRoot}/fresh commit --allow-empty -m x`,
    `git -C ${hookTemporaryRoot} commit -m x`,
    `git -C ${repository} worktree add ${temporaryRepository}/empty && git -C ${temporaryRepository}/empty commit -m x`,
    `git -C ${temporaryRepository}/empty init --separate-git-dir ${repository}/.git && git -C ${temporaryRepository}/empty commit -m x`,
    `git -C ${temporaryRepository}/empty commit -m x`,
    `git -C ${temporaryRepositoryWithCommonDirectory} commit -m x`,
    `git -C ${repository} status && git -C ${temporaryRepository} commit -m x`,
    `git -C ${temporaryRepository} commit -m '<<EOF\n'; git push origin main; echo '\nEOF\n'`,
    `git -C ${temporaryRepository} commit -m "<<EOF\n"; git -C ${repository} commit -am y; echo "\nEOF\n"`,
    `git -C ${temporaryWorktree} commit -m x`,
    `git -C ${temporaryLinkToRepository} commit -m x`,
    `git -C ${temporaryRepository} -C ${repository} commit -m x`,
    "T=$(mktemp -d); cd $T && git commit -m x",
    "T=$(mktemp -d); git -C $T/Repo commit -m x && git commit -m y",
    "T=$(mktemp -d ./probe.XXXX); git -C $T commit -m x",
    "T=$(mktemp -d); T=.; git -C $T commit -m x",
    "T=$(mktemp -d); git -C $T --git-dir .git commit -m x",
    "T=$(mktemp -d); GIT_DIR=.git git -C $T commit -m x",
    "export TMPDIR=.; T=$(mktemp -d); git -C $T commit -m x",
    `T=$(mktemp -d); ln -s ${repository} $T/r; git -C $T/r commit -m x`,
    "T=$(mktemp -d); bash <<'EOF'\ngit -C $T commit -m x\nEOF",
    "git push --dry-run origin main && git push origin main",
    "git push --dry-run --no-dry-run origin main",
    `T=$(mktemp -d); git clone -q ${repository} $T/r; git -C $T/r push origin HEAD:main`,
    `git -C ${temporaryRepository} push origin HEAD:main`,
    'git push --dry-run origin "$(git push origin main)"',
    `git -C ${temporaryRepository} commit -m "$(git -C ${repository} commit -am y)"`,
    "T=$(mktemp -d); cd /; git -C ./$T commit -m x",
    `git -C ${path.relative(process.cwd(), temporaryRepository)} commit -m x`,
    "git push -o -n origin HEAD:main",
    "git push -n --no-dry origin HEAD:main",
    'git push --dry-run "--no-dry-run" origin HEAD:main',
    "git push --dry-run '--no-dry-run' origin HEAD:main",
    "git push --dry-run origin ${ git push origin main; }",
    "git push --dry-run origin ${| git push origin main; }",
    "FLAG=--no-dry-run; git push -n $FLAG origin HEAD:main",
    "git push -n -{n,-no-dry-run} origin HEAD:main",
    "git push -n {--no-dry-run,origin} HEAD:main",
    "git push -n --receive-pack=git push",
    "git push --dry-run --receiv=git push",
    "git push --dry-run --exec=git push",
    "git push -n --repo=origin",
    "git -C {.,commit,--allow-empty,-m} push -n",
    "git -c {a.b=c,commit,--allow-empty,-m} push -n",
    'T=". commit --allow-empty -m"; git -C $T push -n',
    `T="${temporaryRepository} -C ${repository}"; git -C $T commit -m x`,
    `T=$(mktemp -d); git init -q $T; X='$(git push origin main)'; git -C $T commit --allow-empty -m "\${X@P}"`,
    `git -C ${temporaryRepository} commit -m \${ git -C ${repository} commit -am y; }`,
    `git -C ${temporaryRepository} commit -m \${| git -C ${repository} commit -am y; }`,
    `git -C ${temporaryRepository} -c Alias.ci=commit commit -m x`,
    `T=$(mktemp -d); IFS=:; U=$T:-C:${repository}; git -C $U commit -am y`,
    `IFS=@; D=$(mktemp -d); git init -q $D; X=$D@-C@${repository}; git -C $X commit --allow-empty -m y`,
    `PWD=$(mktemp -d); cd ${repository}; git -C $PWD commit --allow-empty -m x`,
    `_=$(mktemp -d); true ${repository}; git -C $_ commit --allow-empty -m x`,
    `OLDPWD=$(mktemp -d); cd ${repository}; cd /; git -C "\${OLDPWD}" commit --allow-empty -m x`,
    "T=$(mktemp -d -t probe); git -C \"$T\" commit -m x",
  ]) {
    assert.equal(decisionFor(bashCall(command, transcriptPath), hookEnvironment).decision, "deny", command);
  }
  const missingTemporaryRoot = { ...ATTENDED, TMPDIR: path.join(hookTemporaryRoot, "gone") };
  assert.equal(decisionFor(bashCall(`git -C ${repository} commit -m x`, transcriptPath), missingTemporaryRoot).decision, "deny");
});

test("git commands that neither commit nor push are allowed", () => {
  const transcriptPath = writeTranscript([prompt("look around")]);
  for (const command of ["git status", "git log --grep commit", "git commit-tree HEAD^{tree}", "echo git commit", "git push-not-a-command"]) {
    assert.equal(decisionFor(bashCall(command, transcriptPath)).decision, "allow", command);
  }
});

test("git commit or push inside quoted search text or a literal heredoc body is allowed", () => {
  const transcriptPath = writeTranscript([prompt("look around")]);
  for (const command of [
    "grep -n 'Raw git commit; git push' hooks/guard.mjs",
    "node land.ts --promote <<'MSG'\nfix: thing\n\ngit commit and git push stay denied\nMSG",
    "cat <<EOF\ngit push is denied\nEOF",
  ]) {
    assert.equal(decisionFor(bashCall(command, transcriptPath)).decision, "allow", command);
  }
});

test("a long build, suite, install, or converge in the foreground is denied for every agent and allowed in the background", () => {
  const transcriptPath = writeTranscript([prompt("run the suite")]);
  const longCommands = [
    "bash test/run-all.sh",
    "cd /repo && ./test/run-all.sh 2>&1 | tail",
    "npm ci",
    "timeout 600 pnpm install --frozen-lockfile",
    "sudo apt-get install -y jq",
    "brew bundle --file Brewfile",
    "~/.dotfiles/script/bootstrap",
    "dot",
    "sudo apt-get -y install jq",
    "pnpm -C web install",
    "npm --prefix ui ci",
    "yarn",
    "npm it",
    "sh -c 'npm ci'",
    'bash -c "pnpm install"',
    "bash -x test/run-all.sh",
    "cd test && ./run-all.sh",
  ];
  for (const command of longCommands) {
    assert.equal(decisionFor(bashCall(command, transcriptPath)).decision, "deny", command);
    assert.equal(decisionFor(bashCall(command, transcriptPath, { agent_id: "agent-1" }), BACKGROUND_TASKS_ENABLED).decision, "deny", command);
    const backgroundCall = { tool_name: "Bash", tool_input: { command, run_in_background: true }, transcript_path: transcriptPath };
    assert.equal(decisionFor(backgroundCall).decision, "allow", command);
  }
  for (const command of ["dot status", "dot --help", "npm test -- export", "yarn test", "grep -n 'npm install' README.md", "bash ai/test.sh", "echo dotfiles", "cat ~/.dotfiles/AGENTS.md"]) {
    assert.equal(decisionFor(bashCall(command, transcriptPath)).decision, "allow", command);
  }
  assert.equal(decisionFor(bashCall("npm ci", transcriptPath), { ...ATTENDED, CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1" }).decision, "allow");
});

test("a kill by a pattern that matches its own Bash call is denied", () => {
  const transcriptPath = writeTranscript([prompt("stop the server")]);
  for (const command of [
    'pkill -f "node server.js"',
    "pkill -9 -f vite",
    "sleep 1; pkill -fx vite",
    "kill $(pgrep -f vite)",
    "kill -9 `pgrep -f vite`",
    "pgrep -f vite | xargs -r kill",
    "npm run dev & sleep 1; pkill -f '[n]pm run dev'",
    "node bin/glimmervoid.ts packs preview & sleep 2; kill $(pgrep -f 'glimmervoid.ts [p]acks preview')",
    "pkill -f 'vite('",
    "pgrep -f 'vite|esbuild' | xargs kill",
    "pgrep -f vite | grep -v grep | xargs kill",
    "for pid in $(pgrep -f vite); do kill $pid; done",
    "pkill -f '\\<vite\\>'",
    'node server.js & sleep 1; pkill -f "node\\s+server"',
    "true zzqvite & sleep 1; pkill -fi '[Z]ZQVITE'",
    "true zzqvite\nsleep 1\npkill -f '[z]zqvite.*[s]leep'",
    "pkill -f $'vite'",
    "pkill -f '[s]hell-snapshots'",
  ]) {
    const { decision, reason } = decisionFor(bashCall(command, transcriptPath));
    assert.equal(decision, "deny", command);
    assert.match(reason, /its own Bash call/);
  }
  for (const command of [
    "pkill -f '[v]ite'",
    "pkill -f '[n]ode server'",
    'pkill -f "[n]ode server"',
    "pkill -f '[v]ite' 2>/dev/null",
    "pkill -f '[v]ite' > /dev/null 2>&1",
    "pkill -f '[v]ite' -u john",
    "pkill -HUP -f '[v]ite'",
    "kill $(pgrep -f '[v]ite')",
    "pgrep -f '[v]ite' | xargs kill",
    "pkill -f '[v]ite('",
    `pkill -f '(a+)+[!]'; echo ${"a".repeat(40)}`,
    "pkill vite",
    "pgrep -f vite",
  ]) {
    assert.equal(decisionFor(bashCall(command, transcriptPath)).decision, "allow", command);
  }
});

test("a /landing or /opening-prs run allows raw commits until the next carbon-unit prompt, except ones that skip the repo hooks", () => {
  const commitSkillRun = writeTranscript([prompt("ship it"), ...skillRun("landing")]);
  assert.equal(decisionFor(bashCall('git commit -m "WIP set-aside"', commitSkillRun)).decision, "allow");
  const slashRun = writeTranscript([prompt("<command-name>/landing</command-name>\n<command-message>landing</command-message>")]);
  assert.equal(decisionFor(bashCall("git push", slashRun)).decision, "allow");
  const nextPrompt = writeTranscript([prompt("ship it"), ...skillRun("landing"), prompt("now change the colour")]);
  assert.equal(decisionFor(bashCall("git commit -m x", nextPrompt)).decision, "deny");
  const openPullRequestRun = writeTranscript([prompt("open a PR"), ...skillRun("opening-prs")]);
  assert.equal(decisionFor(bashCall('git add -A && git commit -m "WIP set-aside"', openPullRequestRun)).decision, "allow");
  const rejectedRun = writeTranscript([prompt("ship it"), toolUse("Skill", { skill: "landing" }), toolResult("The tool use was rejected.", { toolUseId: "tool-Skill" })]);
  assert.equal(decisionFor(bashCall("git commit -m x", rejectedRun)).decision, "deny");
  const hookBypasses = [
    "git commit --no-verify -m x",
    "git commit -nm x",
    "git -C repo push --no-verify origin main",
    "cd repo && git commit -an -m x",
    "git commit -m \"$(cat <<'EOF'\nmsg\n\nbody\nEOF\n)\" --no-verify",
    "git commit -m x \\\n  --no-verify",
    "git commit -m \"a;b\" --no-verify",
    "git push --no-verif origin main",
    "git -c core.hooksPath=/dev/null commit -m x",
    "HUSKY=0 git commit -m x",
  ];
  for (const hookBypass of hookBypasses) {
    const { decision, reason } = decisionFor(bashCall(hookBypass, commitSkillRun));
    assert.equal(decision, "deny", hookBypass);
    assert.match(reason, /--no-verify/);
  }
  assert.equal(decisionFor(bashCall("git push -n origin main", commitSkillRun)).decision, "allow");
  assert.equal(decisionFor(bashCall("git commit -m 'skip --no-verify talk'", commitSkillRun)).decision, "allow");
  assert.equal(decisionFor(bashCall('git commit -m "feat: deny --no-verify and -n flags"', commitSkillRun)).decision, "allow");
});

test("subagents and malformed input are never gated, and unattended or transcriptless sessions are gated only on raw commits", () => {
  const transcriptPath = writeTranscript([prompt("fix it")]);
  assert.equal(decisionFor(bashCall("git push", transcriptPath, { agent_id: "agent-1" })).decision, "allow");
  const unattended = { CLAUDE_CODE_SESSION_ATTENDED: "0", HOME: sandboxHome };
  assert.equal(decisionFor(bashCall("git push", transcriptPath), unattended).decision, "deny");
  assert.equal(decisionFor(bashCall("pkill -f node", transcriptPath), unattended).decision, "allow");
  assert.equal(decisionFor(bashCall("git push", path.join(sandboxHome, "missing.jsonl")), unattended).decision, "deny");
  assert.equal(decisionFor(bashCall("ls", path.join(sandboxHome, "missing.jsonl"))).decision, "allow");
  const malformed = runHook("guard-workflow.mjs", "not json", ATTENDED);
  assert.equal(malformed.status, 0);
  assert.equal(malformed.stdout, "");
});

test("the first repo edit of a session without /specifying is denied once", () => {
  const repoFile = path.join(repository, "a.txt");
  const fresh = writeTranscript([prompt("add an export button")]);
  const { decision, reason } = decisionFor(editCall(repoFile, fresh));
  assert.equal(decision, "deny");
  const deniedEdit = [prompt("add an export button"), toolUse("Edit", { file_path: repoFile }), toolResult(`PreToolUse:Edit hook error: ${reason}`, { toolUseId: "tool-Edit" })];
  const afterDenial = writeTranscript([...deniedEdit, assistantText("The carbon unit dictated this edit verbatim, so retrying.")]);
  assert.equal(decisionFor(editCall(repoFile, afterDenial)).decision, "allow");
  const unstatedRetry = decisionFor(editCall(repoFile, writeTranscript(deniedEdit)));
  assert.equal(unstatedRetry.decision, "deny");
  assert.match(unstatedRetry.reason, /no reply naming a case/);
  const specClaimEntries = [...deniedEdit, assistantText("Let me check the log first."), toolUse("Bash", { command: "git log -1" }), assistantText("The task list entry is my spec, so this resumes from it.")];
  const specClaimRetry = decisionFor(editCall(repoFile, writeTranscript(specClaimEntries)));
  assert.equal(specClaimRetry.decision, "deny");
  assert.match(specClaimRetry.reason, /~\/\.agents\/specs/);
  const harnessReply = { type: "assistant", isApiErrorMessage: true, message: { role: "assistant", model: "<synthetic>", content: [{ type: "text", text: "API Error: the carbon unit dictated nothing" }] } };
  assert.equal(decisionFor(editCall(repoFile, writeTranscript([...deniedEdit, harnessReply]))).decision, "deny");
  const restatedAfterClaim = [...specClaimEntries, toolUse("Edit", { file_path: repoFile }), toolResult(`PreToolUse:Edit hook error: ${specClaimRetry.reason}`, { toolUseId: "tool-Edit" }), assistantText("The carbon unit said to skip /specifying for this one.")];
  assert.equal(decisionFor(editCall(repoFile, writeTranscript(restatedAfterClaim))).decision, "allow");
  assert.equal(decisionFor(editCall(repoFile, writeTranscript([...deniedEdit, assistantText("No spec needed: a typo fix.")]))).decision, "allow");
  const hookSource = fs.readFileSync(path.resolve(import.meta.dirname, "../guard-workflow.mjs"), "utf8");
  const afterReadingSource = writeTranscript([prompt("add an export button"), toolUse("Read", { file_path: "guard-workflow.mjs" }), toolResult(hookSource, { toolUseId: "tool-Read", isError: false })]);
  assert.equal(decisionFor(editCall(repoFile, afterReadingSource)).decision, "deny");
  const outsideRepository = path.join(sandboxHome, "elsewhere");
  for (const [command, cwd] of [
    ["sed -i 's/one/two/' a.txt", repository],
    ["perl -pi -e 's/one/two/' a.txt", repository],
    ["cat > a.txt <<'EOF'\nfrom > to\nEOF", repository],
    ["echo two >> a.txt", repository],
    ["echo two | tee -a a.txt", repository],
    [`cd ${repository} && sed -i s/one/two/ a.txt`, outsideRepository],
    ["printf two > \"$TARGET\"", repository],
    ["grep -l one -r . | xargs sed -i 's/one/two/'", repository],
    ["find . -name '*.txt' -exec sed -i 's/one/two/' {} +", repository],
    ["git -C . apply x.patch", repository],
    ["sed -i 's/\"/x/' a.txt; echo \"z\"", repository],
    ["sed -i --expression=s/one/two/ a.txt", repository],
    ["sed -i '' 's/one/two/' a.txt", repository],
    [`sed -i 's/one two/three/' a.txt ${path.join(sandboxHome, "scratch.txt")}`, repository],
    [`cd ${outsideRepository} && sed -i 's/one two/three/' ${path.join(repository, "a.txt")}`, repository],
    [`cd ${outsideRepository} && sed -n -i '' ${path.join(repository, "a.txt")}`, repository],
    ["perl -0pi -e 's/one/two/' a.txt", repository],
    [`(cd ${repository} && sed -i s/one/two/ a.txt)`, outsideRepository],
    [`cd ${repository}\nsed -i s/one/two/ a.txt`, outsideRepository],
    ["bash -c \"sed -i s/one/two/ a.txt\"", repository],
    ["bash -c 'sed -i s/one/two/ a.txt'", repository],
    [`S=${repository}; cat > $S/a.txt <<'EOF'\ntwo\nEOF`, outsideRepository],
    [`cat > $S/a.txt; S=${sandboxHome}`, repository],
    [`S=${sandboxHome}; declare S=${repository}; echo x > $S/a.txt`, repository],
    [`S=${repository}; (S=${sandboxHome}); echo x > $S/a.txt`, repository],
    [`true || S=${sandboxHome}; echo x > $S/a.txt`, repository],
    [`S=${sandboxHome} echo x > $S/a.txt`, repository],
    [`echo "x;S=${sandboxHome}"; echo x > $S/a.txt`, repository],
    [`# ;S=${sandboxHome}\necho x > $S/a.txt`, repository],
    ['S="my notes"; printf x > "$S/a.txt"', repository],
    [`for f in a; do :; done; S=${sandboxHome}; echo x > $S/a.txt`, repository],
    [`S=${sandboxHome}; (cd $S); echo x > a.txt`, repository],
    [`S=${sandboxHome}; if false; then :; cd $S; fi; echo x > a.txt`, repository],
    [`S=${sandboxHome}; . <(printf x); echo x > $S/a.txt`, repository],
    ['echo "$(date>a.txt)"', repository],
    ["bash -lc 'date>a.txt'", repository],
    [`cd '${repository}/dir<x>' && echo x > f.txt`, outsideRepository],
    [`for i in 1 2; do echo x > ${repository}/run$i.log; done`, outsideRepository],
    [`for d in a; do echo x > ${sandboxHome}/$d/a.txt; done`, repository],
    [`for f in ../x/a.txt; do echo x > ${sandboxHome}/$f; done`, repository],
    [`f=$(printf ../x/a.txt); echo x | tee ${sandboxHome}/$f`, repository],
    [`test -d /nonexistent && D=${sandboxHome}/; echo x > \${D}b.txt`, repository],
  ]) {
    assert.equal(decisionFor(bashCall(command, fresh, { cwd })).decision, "deny", command);
  }
  for (const command of ["sed -n 1p a.txt", "grep -o 'x>y' a.txt", "ls 2>&1 >/dev/null", 'grep -rn "a > b" .', `sed -i s/one/two/ ${path.join(sandboxHome, "scratch.txt")}`, `sed -i '' 's#one#two#' ${path.join(sandboxHome, "scratch.txt")}`, `sed -i 's/one two/three/' ${path.join(sandboxHome, "scratch.txt")}`, "git diff | tee", `export S=${sandboxHome}; D="$S/notes"; cat > "$D/scratch.txt"`, `S=${sandboxHome}; cat > $S/tl.py <<'EOF'\nfor row in rows:  # (each)\n    print(row)\nEOF`, `S=${sandboxHome}; mkdir -p $S/libs && cd $S/libs\necho x > gbm.c`, `S=${sandboxHome}; cd $S && cat > a.md <<'EOF'\nx\nEOF\nfor f in $S/*.md; do echo $f; done`, `S=${sandboxHome}\nfor f in a; do :; done\necho x > $S/a.txt`, `cd ${repository} && S=${sandboxHome}; echo x > $S/a.txt`, `S=${sandboxHome}; for i in 1 2; do echo x > $S/run$i.log; done`]) {
    assert.equal(decisionFor(bashCall(command, fresh, { cwd: repository })).decision, "allow", command);
  }
  assert.equal(decisionFor(bashCall("sed -i s/one/two/ a.txt", afterDenial, { cwd: repository })).decision, "allow");
});

test("Codex and agy edits hit the spec gate once, and a codex exec turn is unattended", () => {
  const repoFile = path.join(repository, "a.txt");
  const patch = "*** Begin Patch\n*** Update File: a.txt\n@@\n-two\n+three\n*** End Patch";
  const codexEdit = (transcriptPath) => ({ tool_name: "apply_patch", cwd: repository, tool_input: { command: patch }, transcript_path: transcriptPath });
  const codexDecision = (transcriptPath) => {
    const hookProcess = runHook("guard-workflow.mjs", codexEdit(transcriptPath), { HOME: sandboxHome }, process.cwd(), ["--agent=codex"]);
    return hookProcess.stdout === "" ? "allow" : JSON.parse(hookProcess.stdout).hookSpecificOutput.permissionDecision;
  };
  const interactiveTurn = writeTranscript(codexRolloutLines("codex-tui", "add an export button"));
  assert.equal(codexDecision(interactiveTurn), "deny");
  assert.equal(codexDecision(writeTranscript(codexRolloutLines("codex_exec", "add an export button"))), "allow");
  const reason = JSON.parse(runHook("guard-workflow.mjs", codexEdit(interactiveTurn), { HOME: sandboxHome }, process.cwd(), ["--agent=codex"]).stdout).hookSpecificOutput.permissionDecisionReason;
  const denialOutput = { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "c1", output: reason } };
  assert.equal(codexDecision(writeTranscript([...codexRolloutLines("codex-tui", "add an export button"), codexPatchCall("c1", patch), denialOutput])), "allow");
  const echoedDenial = { type: "response_item", payload: { type: "custom_tool_call", name: "exec", call_id: "c2", input: `text(await tools.exec_command({cmd:"echo denied"}))` } };
  assert.equal(codexDecision(writeTranscript([...codexRolloutLines("codex-tui", "add an export button"), echoedDenial, { ...denialOutput, payload: { ...denialOutput.payload, call_id: "c2" } }])), "deny");
  const outsideFirstPatch = `*** Begin Patch\n*** Add File: ${path.join(sandboxHome, "scratch.txt")}\n+x\n*** Update File: a.txt\n@@\n-two\n+three\n*** End Patch`;
  const outsideFirstProcess = runHook("guard-workflow.mjs", { ...codexEdit(interactiveTurn), tool_input: { command: outsideFirstPatch } }, { HOME: sandboxHome }, process.cwd(), ["--agent=codex"]);
  assert.equal(JSON.parse(outsideFirstProcess.stdout).hookSpecificOutput.permissionDecision, "deny");
  const agyTranscript = writeTranscript([agyStep(0, "USER_INPUT", "<USER_REQUEST>\nadd an export button\n</USER_REQUEST>")]);
  const agyPayload = { toolCall: { name: "write_file", args: { Path: repoFile, Content: "three\n" } }, transcriptPath: agyTranscript, conversationId: "agy-1" };
  const agyProcess = runHook("guard-workflow.mjs", agyPayload, { HOME: sandboxHome }, process.cwd(), ["--agent=agy"]);
  assert.equal(JSON.parse(agyProcess.stdout).decision, "deny");
  const agyDecision = (steps) => {
    const hookProcess = runHook("guard-workflow.mjs", { ...agyPayload, transcriptPath: writeTranscript(steps) }, { HOME: sandboxHome }, process.cwd(), ["--agent=agy"]);
    return hookProcess.stdout === "" ? "allow" : JSON.parse(hookProcess.stdout).decision;
  };
  const agyDeniedWrite = [
    agyStep(0, "USER_INPUT", "<USER_REQUEST>\nadd an export button\n</USER_REQUEST>"),
    agyStep(1, "PLANNER_RESPONSE", "", [{ name: "write_file", args: { Path: repoFile, Content: "three\n" } }]),
    agyStep(2, "GENERIC", `tool call denied by pre-tool hook: ${JSON.parse(agyProcess.stdout).reason}`, [], "ERROR"),
  ];
  assert.equal(agyDecision(agyDeniedWrite), "deny");
  assert.equal(agyDecision([...agyDeniedWrite, agyStep(3, "PLANNER_RESPONSE", "The carbon unit dictated this edit verbatim; retrying.")]), "allow");
});

test("running /specifying or a review gate or reading a design spec clears the spec gate", () => {
  const repoFile = path.join(repository, "a.txt");
  const specRun = writeTranscript([prompt("add an export button"), ...skillRun("specifying")]);
  assert.equal(decisionFor(editCall(repoFile, specRun)).decision, "allow");
  for (const gate of ["gating-reviews"]) {
    const gateRun = writeTranscript([prompt(`/${gate}`), ...skillRun(gate)]);
    assert.equal(decisionFor(editCall(repoFile, gateRun)).decision, "allow");
  }
  const intentRead = writeTranscript([prompt("build it"), toolUse("Read", { file_path: path.join(sandboxHome, ".agents/specs/repo/export.intent.json") })]);
  assert.equal(decisionFor(editCall(repoFile, intentRead)).decision, "allow");
});

test("a repo edit is denied while the design spec this session's /specifying run wrote is below challenged, except for git-ignored files", (context) => {
  const repoFile = path.join(repository, "a.txt");
  const specPath = path.join(sandboxHome, ".agents/specs/repo/export.json");
  const ignoreFile = path.join(repository, ".gitignore");
  context.after(() => fs.rmSync(ignoreFile, { force: true }));
  fs.writeFileSync(ignoreFile, ".glimmervoid/\n");
  fs.mkdirSync(path.dirname(specPath), { recursive: true });
  const writeSpecAt = (status, nodes = []) => fs.writeFileSync(specPath, JSON.stringify({ status, nodes }));
  const specWritten = writeTranscript([prompt("add an export button"), ...skillRun("specifying"), toolUse("Write", { file_path: specPath })]);
  const specWrittenByShell = writeTranscript([prompt("add an export button"), ...skillRun("specifying"), toolUse("Bash", { command: `cat > "$HOME/.agents/specs/repo/export.json" <<'EOF'\n{}\nEOF` })]);

  writeSpecAt("grilled");
  const denial = decisionFor(editCall(repoFile, specWritten));
  assert.equal(denial.decision, "deny");
  assert.match(denial.reason, /export\.json is at grilled.*subskills\/slice\.md/);
  assert.equal(decisionFor(bashCall("echo x > a.txt", specWrittenByShell, { cwd: repository })).decision, "deny");
  assert.equal(decisionFor(editCall(path.join(repository, ".glimmervoid/harness.html"), specWritten)).decision, "allow");
  fs.mkdirSync(path.join(repository, ".glimmervoid"), { recursive: true });
  assert.equal(decisionFor(bashCall('echo x > "$(printf ../a.txt)"', specWritten, { cwd: path.join(repository, ".glimmervoid") })).decision, "deny");
  assert.equal(decisionFor(editCall(repoFile, writeTranscript([prompt("add an export button"), ...skillRun("specifying")]))).decision, "allow");
  assert.equal(decisionFor(editCall(repoFile, writeTranscript([prompt("add an export button"), ...skillRun("specifying"), toolUse("Write", { file_path: specPath }), ...skillRun("gating-reviews")]))).decision, "allow");

  writeSpecAt("sketch", [{ id: "B1", kind: "branch" }]);
  assert.match(decisionFor(editCall(repoFile, specWritten)).reason, /subskills\/grill\.md/);
  writeSpecAt("sketch");
  assert.match(decisionFor(editCall(repoFile, specWritten)).reason, /subskills\/design\.md/);

  writeSpecAt("challenged");
  assert.equal(decisionFor(editCall(repoFile, specWritten)).decision, "allow");
  fs.rmSync(specPath);
  assert.equal(decisionFor(editCall(repoFile, specWritten)).decision, "allow");
});

test("edits outside a git worktree or under ~/.claude skip the spec gate", () => {
  const transcriptPath = writeTranscript([prompt("note this")]);
  assert.equal(decisionFor(editCall(path.join(sandboxHome, "scratch/notes.md"), transcriptPath)).decision, "allow");
  fs.mkdirSync(path.join(sandboxHome, ".claude"), { recursive: true });
  assert.equal(decisionFor(editCall(path.join(sandboxHome, ".claude/projects/memory/fact.md"), transcriptPath)).decision, "allow");
  assert.equal(decisionFor(bashCall("echo note > notes.md", transcriptPath, { cwd: sandboxHome })).decision, "allow");
  assert.equal(decisionFor(bashCall("echo fact > ~/.claude/projects/memory/fact.md", transcriptPath, { cwd: repository })).decision, "allow");
});

function questionRound(...questions) {
  return { tool_name: "AskUserQuestion", tool_input: { questions } };
}

function question(text, optionLabels) {
  return { question: text, header: text.slice(0, 12), multiSelect: false, options: optionLabels.map((label) => ({ label, description: `pick ${label}` })) };
}

test("a /specifying question round is denied until every question weighs a change at the source", () => {
  const specifyingRun = writeTranscript([prompt("spec this"), ...skillRun("specifying")]);
  const ask = (...questions) => decisionFor({ ...questionRound(...questions), transcript_path: specifyingRun });
  const bare = question("Which store?", ["Redis", "Postgres"]);
  const denial = ask(bare, question("Which risk?\nUpstream: none: risk is the carbon unit's call", ["Medium", "High"]));
  assert.equal(denial.decision, "deny");
  assert.match(denial.reason, /Which store\? \(it has no `Upstream:` clause/);
  assert.doesNotMatch(denial.reason, /Which risk/);
  assert.equal(ask(question("Which store? Upstream: share the cache, ruled out by cache.ts:12", ["Redis", "Postgres"])).decision, "allow");
  assert.equal(ask(question("Which store?\nUpstream: share the cache ruled out by cache.ts:12", ["Redis", "Postgres"])).decision, "allow");
  assert.match(ask(question("Which store?\nUpstream: share the existing cache", ["Redis", "Postgres"])).reason, /names no `ruled out by <evidence>`/);
  assert.equal(ask(question("Which store?\nUpstream: share the existing cache, ruled out by cache.ts:12", ["Redis", "Postgres"])).decision, "allow");
  assert.equal(ask(question("Which store?", ["Fix the cache (change at the source)", "Redis"])).decision, "allow");
  for (const evasiveUpstream of ["none", "n/a", "-", "nothing"]) {
    const evasiveDenial = ask(question(`Which store?\nUpstream: ${evasiveUpstream}`, ["Redis", "Postgres"]));
    assert.equal(evasiveDenial.decision, "deny", evasiveUpstream);
    assert.match(evasiveDenial.reason, evasiveUpstream === "none" ? /needs `none: <reason>`/ : /names no `ruled out by/, evasiveUpstream);
  }
  const describedOnly = { ...bare, options: [{ label: "Redis", description: "does not change at the source" }, { label: "Postgres", description: "fast" }] };
  assert.equal(ask(describedOnly).decision, "deny");
});

test("a /specifying question round is denied when a change-at-the-source option is not the first option", () => {
  const misordered = question("Pin how?\nUpstream: none: placement behavior is new", ["Pin on drag (Recommended)", "Make near a placing hint (change at the source)"]);
  const specifyingRun = writeTranscript([prompt("spec this"), ...skillRun("specifying")]);
  const denial = decisionFor({ ...questionRound(misordered), transcript_path: specifyingRun });
  assert.equal(denial.decision, "deny");
  assert.match(denial.reason, /Pin how\?/);
  assert.match(denial.reason, /first/);
  const sourceFirst = question("Pin how?", ["Make near a placing hint (change at the source)", "Pin on drag (Recommended)"]);
  assert.equal(decisionFor({ ...questionRound(sourceFirst), transcript_path: specifyingRun }).decision, "allow");
  assert.equal(decisionFor({ ...questionRound(misordered), transcript_path: writeTranscript([prompt("pick one")]) }).decision, "allow");
});

test("a /specifying question round stays gated through its own challenge, utility commands and the carbon unit's replies, until a review, landing or pull request skill runs or the spec is archived", () => {
  const bare = question("Which store?", ["Redis", "Postgres"]);
  const roundAfter = (entries) => decisionFor({ ...questionRound(bare), transcript_path: writeTranscript(entries) }).decision;
  assert.equal(roundAfter([prompt("spec this"), ...skillRun("specifying"), ...skillRun("challenging-plans")]), "deny");
  assert.equal(roundAfter([prompt("spec this"), ...skillRun("specifying"), prompt("the answer to Q1 is yes")]), "deny");
  assert.equal(roundAfter([prompt("spec this"), ...skillRun("specifying"), ...skillRun("caveman"), prompt("go on")]), "deny");
  assert.equal(decisionFor({ ...questionRound(question("Which store?", ["Fix the cache (change at the source) (Recommended)", "Redis"])), transcript_path: writeTranscript([prompt("spec this"), ...skillRun("specifying")]) }).decision, "allow");
  assert.equal(roundAfter([prompt("spec this"), ...skillRun("specifying"), ...skillRun("opening-prs")]), "allow");
  assert.equal(roundAfter([prompt("ship it"), ...skillRun("landing")]), "allow");
  const archiveCall = (command) => toolUse("Bash", { command });
  const archiveCommand = "node ~/.claude/skills/specifying/archive.ts ~/.agents/specs/repo/export.json abandoned";
  assert.equal(roundAfter([prompt("spec this"), ...skillRun("specifying"), archiveCall(archiveCommand), toolResult('{"outcome":"ARCHIVED"}', { toolUseId: "tool-Bash", isError: false }), ...skillRun("running-retros")]), "allow");
  assert.equal(roundAfter([prompt("spec this"), ...skillRun("specifying"), archiveCall(archiveCommand), toolResult('{"outcome":"REFUSED"}', { toolUseId: "tool-Bash" })]), "deny");
  assert.equal(roundAfter([prompt("spec this"), ...skillRun("specifying"), archiveCall("cat ~/.claude/skills/specifying/archive.ts"), toolResult("source", { toolUseId: "tool-Bash", isError: false })]), "deny");
});

test("posting prose with gh is denied until writing-in-voice has run in the session, attended or not", () => {
  const withoutVoice = writeTranscript([prompt("open a PR")]);
  const publishingCommands = [
    'gh pr create --title "Fix" --body-file body.md',
    "gh issue comment 12 --body-file reply.md",
    "gh pr review 7 --comment --body-file review.md",
    "cd repo && gh pr edit 7 --body-file body.md",
    "gh -R o/r pr create --title T --body-file b.md",
    "gh --repo=o/r issue comment 1 -b x",
    '"gh" pr create -b x',
    "\\gh pr create -b x",
    "gh api repos/o/r/issues/7/comments \\\n  -f body=hi",
    "gh pr edit 7 \\\n  --body-file b.md",
    "gh api repos/o/r/pulls/7/comments -fbody=hi",
    "gh api -X POST repos/o/r/pulls/7/reviews --input review.json",
    "gh api -X PATCH repos/o/r/pulls/7 -F body=@b.md",
    "gh api repos/o/r/issues -f title=x -f body=y",
    "gh api graphql -f query='mutation{addComment}'",
    'gh issue close 7 --comment "done"',
    "gh pr merge 7 --body hi",
    "gh release create v1 --notes hi",
    "bash -c 'gh pr comment 1 -b x'",
    'sh -c "gh pr comment 1 -b x"',
    "eval 'gh pr comment 1 -b x'",
  ];
  for (const command of publishingCommands) {
    assert.equal(decisionFor(bashCall(command, withoutVoice)).decision, "deny", command);
    assert.equal(decisionFor(bashCall(command, withoutVoice), { CLAUDE_CODE_SESSION_ATTENDED: "0", HOME: sandboxHome }).decision, "deny", `unattended: ${command}`);
  }
  assert.match(decisionFor(bashCall(publishingCommands[0], withoutVoice)).reason, /writing-in-voice/);
  const readingCommands = [
    "gh pr view 7 --comments",
    "gh -R o/r pr list --state open",
    "gh api repos/o/r/pulls/7/comments",
    "gh api -X GET repos/o/r/pulls/7/comments -f per_page=100",
    "gh api --method GET repos/o/r/issues/7/comments -F since=2026-01-01",
    "gh auth status",
    "gh search prs --author @me",
    "rg 'gh pr create' docs",
    "cat <<'EOF'\ngh pr create --body x\nEOF",
  ];
  for (const command of readingCommands) assert.equal(decisionFor(bashCall(command, withoutVoice)).decision, "allow", command);
  const withVoice = writeTranscript([prompt("open a PR"), ...skillRun("writing-in-voice"), prompt("now post it")]);
  const commentCommands = [
    "gh issue comment 12 --body-file reply.md",
    "gh pr review 7 --comment --body-file review.md",
    "gh --repo=o/r issue comment 1 -b x",
    "gh api repos/o/r/issues/7/comments \\\n  -f body=hi",
    "gh api repos/o/r/pulls/7/comments -fbody=hi",
    "gh api -X POST repos/o/r/pulls/7/reviews --input review.json",
    "gh api graphql -f query='mutation{addComment}'",
    'gh issue close 7 --comment "done"',
    "bash -c 'gh pr comment 1 -b x'",
    'sh -c "gh pr comment 1 -b x"',
    "eval 'gh pr comment 1 -b x'",
    "gh api -X POST repos/o/r/pulls/7/comments/99/replies -F body=@reply.md",
  ];
  for (const command of publishingCommands.filter((command) => !commentCommands.includes(command))) {
    assert.equal(decisionFor(bashCall(command, withVoice)).decision, "allow", command);
  }
  const footerOnlyCommands = [
    "gh api graphql -f query='mutation { addPullRequestReviewThreadReply(input: {pullRequestReviewThreadId: \"PRRT_1\", body: \"Fixed.\"}) { comment { id } } }'",
    "gh api graphql -f query='mutation{submitPullRequestReview(input:{pullRequestReviewId:\"X\",event:COMMENT,body:\"hi\"}){clientMutationId}}'",
    "gh api -X POST repos/o/r/pulls/7/reviews/55/events -f event=COMMENT -f body=hi",
    'gh issue reopen 7 --comment "reopening"',
    'gh api -X POST repos/o/r/pulls/7/comments/99/replies -f body="Fixed. Not written by a human" && gh api -X POST repos/o/r/pulls/7/comments/100/replies -f body="Also fixed."',
  ];
  for (const command of [...commentCommands, ...footerOnlyCommands]) {
    const footerDecision = decisionFor(bashCall(command, withVoice));
    assert.equal(footerDecision.decision, "deny", `no footer: ${command}`);
    assert.match(footerDecision.reason, /Glimmervoid footer.*Automated review by \[Glimmervoid\]\(https:\/\/glimmervoid\.dev\)\. Not written by a human/);
  }
  assert.equal(decisionFor(bashCall("gh pr comment 1 -b 'Fixed.\n\n<sub>Automated review by [Glimmervoid](https://glimmervoid.dev). Not written by a human</sub>'", withVoice)).decision, "allow");
  const footerDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "footer-"));
  fs.writeFileSync(path.join(footerDirectory, "reply.md"), "Fixed.\n\n<sub>Automated review by [Glimmervoid](https://glimmervoid.dev). Not written by a human</sub>\n");
  for (const command of ["gh issue comment 12 --body-file reply.md", "gh api -X POST repos/o/r/pulls/7/comments/99/replies -F body=@reply.md"]) {
    assert.equal(decisionFor(bashCall(command, withVoice, { cwd: footerDirectory })).decision, "allow", `footer file: ${command}`);
  }
  fs.rmSync(footerDirectory, { recursive: true, force: true });
  for (const command of ["gh pr review 7 --approve", "gh api repos/o/r/pulls/7/comments", "gh pr create --title T --body-file b.md", "gh api -X DELETE repos/o/r/issues/comments/123", 'gh api -X POST repos/o/r/pulls/7/reviews --input "$BODY"']) {
    assert.doesNotMatch(decisionFor(bashCall(command, withVoice)).reason ?? "", /Glimmervoid footer/, command);
  }
});
