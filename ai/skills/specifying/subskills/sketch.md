# Sketch

Give the questions something concrete to attack.

1. Name the repo. `<repo>` is `basename "$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")"`, the main checkout's name from any worktree; outside git, the working directory's name.
2. Resume the design spec in `~/.agents/specs/<repo>/` whose request and goal match this feature, once the carbon unit confirms the match, and set its `repoRoot` to the current checkout; a `challenged` one with a different request is a different feature. A new feature gets `<slug>.json`: two to five kebab-case words, new to that directory.
3. Read the repo: instruction files, prior art by behavior and synonym, the code the feature touches, and `git log -20` on those paths for the decisions behind it. Record what the repo settles as decisions with source `read` and their `evidence`. For a bug, record which layer owns the defect as a branch for the carbon unit to answer, even when the code nearest the symptom looks like the obvious place for the fix.
4. Write the graph at status `sketch`: `request`, `repoRoot`, the goal, the non-goals, the `read` decisions, and one branch per guess with its leaning, each joined by a `blocks` edge to the branches it precedes.
5. Tell the carbon unit the goal as understood and the branch count, then continue to `grill.md`.
