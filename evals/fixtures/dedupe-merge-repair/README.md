# dedupe-merge-repair

`mergeById(left, right)` and `summarize(left, right)` share record merging. The merge
currently concatenates without de-duplicating, so a record id present in both lists is
counted twice and `summarize` double-counts its amount.

Correct behaviour (see the prompt):

- `mergeById(left, right)` returns records with **unique `id`**s. When the same id appears
  in both, the record from `right` wins. Order is the first appearance in `left`, then any
  new ids from `right`.
- `summarize(left, right)` reports `{ count, total }` over the merged unique records, where
  `total` sums `amount` (missing/non-numeric amounts count as 0).
- Neither input array nor its records are mutated.

Run the checks with `npm test`.
