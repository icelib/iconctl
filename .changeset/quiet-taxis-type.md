---
"@iconctl/core": patch
"iconctl": patch
---

Preserve the winning icon source and Figma node coordinates in processing and validation diagnostics, including renamed and replaced icons.

Revalidate linked inputs after replacement watchers become ready, and retain rejected links and their path aliases so removal or repair resumes syncing safely.

Coalesce repeated link-removal notifications across path aliases without losing separate source edits or link recreation.
