---
"@iconctl/core": patch
"iconctl": patch
---

Fix conditional declaration exports so CommonJS consumers resolve .d.cts files and ESM consumers resolve .d.mts files, including nightly package validation.
