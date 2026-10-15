# Controlled reliability fixture

Repair createRenamer(write) in src/rename.js. Return a function rename(id,title) that serializes writes for the same id while different ids can progress independently. Return each write result or rejection. A rejected write must never be replayed and must not poison later explicit operations. Preserve this API and do not add dependencies.

The runner copies this synthetic workspace before execution. No external services or dependencies are needed.
