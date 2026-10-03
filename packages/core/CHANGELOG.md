# @iconctl/core

## 0.3.0

### Minor Changes

- Add local SVG watch with serial sync, recoverable configuration reload, path isolation and structured CLI events.

- Import local Iconify JSON collections with alias transforms, name selection and prefixes; watch JSON source files with output isolation.

- Add offline Iconify JSON comparison and safe standalone HTML reports

- Add standalone Iconify JSON checks with aggregated diagnostics, rendered alias geometry, original SVG names, and stable stateful regex validation.

### Patch Changes

- Reject ambiguous same-source Figma icon names and revalidate completion caches after validation rules change.

- Preserve the winning icon source and Figma node coordinates in processing and validation diagnostics, including renamed and replaced icons.

  Revalidate linked inputs after replacement watchers become ready, and retain rejected links and their path aliases so removal or repair resumes syncing safely.

  Coalesce repeated link-removal notifications across path aliases without losing separate source edits or link recreation.

- Ignore replayed watch notifications without a new input version while preserving configuration saves, atomic replacements, and symbolic-link recovery.

- Report malformed icons consistently across local, MasterGo and iconfont sources; refresh failed Figma imports after a file revision changes; and preserve sync integrity and cancellation while cleaning managed SVGs and reporting output recovery failures.

- Keep watch responsive when a directory becomes a file during startup, ship the fixed traversal stack, and make CommonJS consumers share the ESM implementation.

- Reload each watch configuration in an isolated worker so JavaScript and JSON helper modules refresh without changing native ESM semantics; preserve cancellation drain and structured error reporting.

## 0.2.0

### Minor Changes

- Protect sync outputs from incomplete Figma imports, report partial results explicitly, and support AbortSignal cancellation with staged output commits.

## 0.1.0

### Minor Changes

- Add Figma OAuth login and automatic token renewal for local CLI and GitHub Actions

- Add injectable Figma authorization providers and a Workers-compatible OAuth protocol export; preserve multi-source sync results and validate cache baselines.

### Patch Changes

- Use a Workers-compatible OAuth redirect policy and reject redirected credential requests.

## 0.0.1

### Patch Changes

- Reject Figma Community URLs with a duplicate-to-design-file hint, and create parent directories when writing Iconify JSON.

- Name local SVG files with the same kebab-case and draft-skip rules as Figma, and throw IconctlError when the directory is missing.

- Write a dated CHANGELOG.md from the icon diff when output.changelog is set.

- Allow jsonPackage to set package name and skip wiping sibling files.
