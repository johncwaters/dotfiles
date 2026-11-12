# Evidence

Every claim a reviewer could doubt carries its proof in the doc.

- **Measured beats assumed.** A rate the doc depends on is measured on real data before any scenario table is written. Show other rates only as sensitivity rows beneath the measured one.
- **Cost at real volume.** Price per unit times measured volume, at list prices, with the volume's date range. Include every downstream cost the unit triggers (retries, follow-up jobs, CI runs on the other repo) and exclude units that duplicate work, such as merge-queue copies of the same change, saying what was excluded and how much. Give one total first, then the table.
- **Cite the code.** A behavior claim names `path:line`. A claim you could not verify is marked unverified or removed.
- **Results with their denominator.** Use "Flagged 16 of 18" in place of "flagged most"; a precision claim names the sweep size and date range.
- **One number, one place.** When a number changes, update every section and tab that repeats it in the same pass; a stale total in a second tab is what a reviewer finds first.
