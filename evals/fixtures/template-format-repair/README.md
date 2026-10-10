# template-format-repair

`formatMessage(template, values)` fills `{key}` placeholders. It currently throws on a
missing key and has no brace-escape handling, which is wrong.

Correct behaviour (see the prompt):

- `{key}` is replaced with `String(values[key])` when the key is present.
- A `{key}` with no matching value is left unchanged (`{key}` stays literal) — never throws.
- `{{` renders a literal `{`, and `}}` renders a literal `}` (so `{{name}}` → `{name}`, not a substitution).
- Substituted values are inserted literally; their text is not re-scanned for placeholders.
- `template` and `values` must not be mutated.

Run the checks with `npm test`.
