# Design

Settle the design as code the carbon unit reviews before any is written.

1. Draft design nodes from the decisions and the code they touch, one per piece a reviewer judges on its own:
   - `behavior`: the desired flow as a walkthrough, or an ASCII mockup for a UI.
   - `architecture`: the components, the contracts between them, and the data model.
   - `program`: types, function signatures, the call graph, and pseudocode for logic a signature leaves open, each with `at` naming its file.
   Write code in the repo's language, and pseudocode where that language adds only noise.
2. Each place the design could go more than one way is a branch; ask it through `ask.md`.
3. Run `render.ts <spec.json> design` and ask one approval round with its output as the preview: approve, or name the node to change. A named node returns to step 2.
4. Once approved, set status `grilled` and continue to `slice.md`. An approval round the carbon unit ends early leaves status `sketch`, so the next session resumes in grill and returns here.
