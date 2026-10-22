# Evidence

Every claim a reviewer could doubt carries its proof in the doc.

- **Measured beats assumed.** A rate the doc depends on is measured on real data before any scenario table is written. The docs freshness cost section first priced a 2 to 10% flag rate; the measured rate from a 2,650-PR sweep was 0.04%, and the estimate dropped from about $2,000 to $6,500 a month to about $850. Show other rates only as sensitivity rows beneath the measured one.
- **Cost at real volume.** Price per unit times measured volume, at list prices, with the volume's date range. Include every downstream cost the unit triggers (retries, follow-up jobs, CI runs on the other repo) and exclude units that duplicate work, such as merge-queue copies of the same change, saying what was excluded and how much. Give one total first, then the table.
- **Cite the code.** A behavior claim names `path:line`. A claim you could not verify is marked unverified or removed.
- **Results with their denominator.** "Flagged 16 of 18", never "flagged most"; a precision claim names the sweep size and date range.
- **One number, one place.** When a number changes, update every section and tab that repeats it in the same pass; a stale total in a second tab is what a reviewer finds first.
