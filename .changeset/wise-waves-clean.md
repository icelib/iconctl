---
"@iconctl/core": patch
"iconctl": patch
---

Reload each watch configuration in an isolated worker so JavaScript and JSON helper modules refresh without changing native ESM semantics; preserve cancellation drain and structured error reporting.
