# Ask

Run one question round and write its answers. Every stage asks through here.

When the carbon unit has handed the answers to the agent (no carbon unit input, answer the questions yourself), skip AskUserQuestion in every round, the hand off rounds included: close each question on its recommendation as an `assumed` decision whose `why` is the recommendation's reason, take the review gate the carbon unit named or else `gating-reviews`, then cut and build.

1. Ask with AskUserQuestion: up to four mutually independent questions, each offering two to four real alternatives with their costs, the recommended one first, marked `(Recommended)`, with its reason.
2. Show what is being chosen. When an option is a type, signature, call graph, pseudocode, flow, or mockup, put it in the option's `preview` so the alternatives sit side by side.
3. Write every answer into the graph right away. A chosen option or a settling free-text answer becomes a `decided` decision, or the chosen code of a design node, whether it closed a branch or a slice or approval question, so a later challenge that undoes it shows at hand off. A partial answer records what it settled and returns as a narrower branch. A redirecting answer rewrites the goal, the non-goals, and the affected branches first.
