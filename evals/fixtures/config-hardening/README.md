# Configuration hardening fixture

`mergeConfig(defaults, supplied)` returns a new plain configuration object. It preserves ordinary own enumerable keys from both inputs, lets supplied values override defaults, ignores `__proto__`, `prototype`, and `constructor`, and never changes either input or any global prototype.
