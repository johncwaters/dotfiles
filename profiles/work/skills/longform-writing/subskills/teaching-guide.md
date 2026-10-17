# Teaching guide template

For pocket guides, tutorials, and docs pages that teach a product concept.

1. **Teach the mental model, not the setup tool.** Explain the concept so a reader who never ran the wizard, CLI, or template follows every page. Artifacts a setup tool created appear only as an optional, conditional example ("If you ran the wizard, …"), never as the frame or the running story.
2. **Follow the concept's lifecycle** (for example, create, roll out, kill, measure, retire) rather than the steps one tool performed.
3. **Open each page on the concept and the decision it serves.** The first sentence says plainly what the thing is or does, because the reader came looking for exactly that; a counterfactual ("Without a flag, …"), an aphorism, or a scene makes them wait for it. Headings and page titles say what the section is about ("Choose where a flag is evaluated"; "Server and client-side flags", not "Server and client").
4. **Structure around the reusable decision.** At each step, answer the questions the reader will face again: who is eligible, what signal to watch, when to raise the rollout and when to roll back. Decision criteria are concrete checks (error rate against the control group, new error issues, the target metric, how many carbon units were exposed), never only advice to write criteria down. A table of shapes or options also needs the rule for choosing among them: a decision tree or clear defaults.
5. **Give the full model before the shortcut.** Name every part a correct result needs (an experiment is hypothesis, eligible population, primary metric, and exposure moment, not only a flag with variants) so a partial setup does not read as the whole thing.
6. **Earn each heading.** A heading over one sentence either merges into its neighbor or grows a concrete example, a table, or an annotated visual.
7. **Open without overclaiming.** The opening never promises what a later section qualifies ("off is instant" followed by propagation delays).
8. **Stay consistent across pages.** A categorical claim ("every flag is debt") must agree with exceptions made elsewhere (permanent operational flags); separate the categories where they first appear.
9. **Captions stand alone.** A caption or code intro plainly says what the reader is looking at, with no assumed prior context.
10. **Native formatting first.** Code samples and tables use the platform's native Markdown. Custom figure components are only for visuals Markdown cannot render: annotated mock UI or diagrams. Size screenshots to the page, and prefer an annotated mock UI when it explains more than a raw screenshot.
