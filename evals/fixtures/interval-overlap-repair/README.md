# interval-overlap-repair

`overlaps(a, b)` decides whether two closed intervals `[start, end]` share any point. It
currently uses strict `<`, so intervals that merely touch at an endpoint are treated as
disjoint, and it does not validate its inputs.

Correct behaviour (see the prompt):

- Intervals are closed: touching at an endpoint counts as overlapping
  (`[1,5]` and `[5,9]` overlap).
- Ordinary overlap and containment overlap; genuinely disjoint intervals do not.
- A malformed interval (non-numeric, or `start > end`) throws an error.

Run the checks with `npm test`.
