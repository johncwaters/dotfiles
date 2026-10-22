# MVP spec

An MVP spec asks the team to comment on the smallest version worth shipping, with the evidence that it works and what it costs. It follows Google's mini design doc and a Shape Up pitch: one to three pages, appetite and no-gos stated.

## Sections, in order

1. **TLDR.** The answer beat: what it does, its state, where the code is.
2. **Feedback wanted.** The ask beat, as numbered questions with the number each one turns on.
3. **Problem.** What breaks today, with one real example.
4. **Where this fits.** The goals the MVP serves and the bigger picture from the doc's history, as a scope table: covered now, next, never.
5. **MVP scope.** What ships, and the no-gos.
6. **Design.** The infrastructure diagram and the guarantees (idempotency, retries, what is off by default), each with its `path:line`.
7. **Does it work.** Results on real cases with their denominators, misses included.
8. **Cost.** One total at measured volume, then the per-unit table (see evidence).
9. **Alternatives considered.** Each path not taken, with the reason it lost.
10. **Risks.** What fails, how you would know, and what limits the damage.
11. **Rollout.** Steps, each with the setting or switch that turns it on and the signal that gates the next.
12. **Open questions.** Only ones a reader can help answer.
13. **Appendix.** Raw tables, sweeps, and commit lists the sections above cite.

Omit a section with nothing true to say rather than filling it.
