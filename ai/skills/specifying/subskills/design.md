# Design

Settle the design as code before any is written.

1. Draft design nodes from the decisions and the code they touch, one per piece a reviewer judges on its own:
   - `behavior`: the desired flow as a walkthrough, or an ASCII mockup for a UI.
   - `architecture`: the components, the contracts between them, and the data model.
   - `program`: types, function signatures, the call graph, and pseudocode for logic a signature leaves open, each with `at` naming its file.
   Write code in the repo's language, and pseudocode where that language adds only noise.
2. Each place the design could go more than one way is a branch; ask it through `ask.md`.
3. Once those branches close, set status `grilled` and continue to `slice.md`.
