# Report repair fixture

`buildReport(records)` returns `{ total, average, highest }`. `total` is the sum of numeric `value` fields, `average` is the arithmetic mean (or `0` for no records), and `highest` is the original record with the greatest value (or `null`). The function must not mutate the input.
