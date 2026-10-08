# iconctl

## 0.3.0

### Minor Changes

- Add standalone local Iconify JSON to SVG sprite rendering and transactional output APIs, with the sprite CLI command.

- Generate standalone icon name types from local Iconify collections through the types CLI and public rendering and transactional writer APIs.

- Add local SVG watch with serial sync, recoverable configuration reload, path isolation and structured CLI events.

- Add read-only remote Iconify cache diagnostics with exact URL lookup, strict missing/corrupt checks and shared sync validation.

- Import local Iconify JSON collections with alias transforms, name selection and prefixes; watch JSON source files with output isolation.

- Add offline Iconify JSON comparison and safe standalone HTML reports

- Add standalone Iconify JSON checks with aggregated diagnostics, rendered alias geometry, original SVG names, and stable stateful regex validation.

- Add configuration-free local Iconify JSON previews with protected transactional HTML output.

- Add safe scriptable initialization with explicit source options, zero-write dry runs, atomic no-overwrite config creation, and cancellation exit status 130.

- Add deterministic SVG sprite output with isolated local references and transactional watch support; include resolvable aliases in generated icon name types, and preserve custom JSON package metadata with clean:false.

### Patch Changes

- Support HTTPS Iconify JSON sources with strict validation, conditional caching, and clear watch behavior.

- Validate output collisions, target types and symlink destinations during dry-run output checks.

- Fix native workspace CLI imports and report the package version from CLI metadata.

- Include ordered alias paths in local Iconify diagnostics.

- Support offline syncs from validated remote Iconify caches.

- Add deterministic Markdown output to the offline `iconctl diff` report for code review and terminal workflows.

- Reject ambiguous same-source Figma icon names and revalidate completion caches after validation rules change.

- Preserve the winning icon source and Figma node coordinates in processing and validation diagnostics, including renamed and replaced icons.

  Revalidate linked inputs after replacement watchers become ready, and retain rejected links and their path aliases so removal or repair resumes syncing safely.

  Coalesce repeated link-removal notifications across path aliases without losing separate source edits or link recreation.

- Ignore replayed watch notifications without a new input version while preserving configuration saves, atomic replacements, and symbolic-link recovery.

- Report malformed icons consistently across local, MasterGo and iconfont sources; refresh failed Figma imports after a file revision changes; and preserve sync integrity and cancellation while cleaning managed SVGs and reporting output recovery failures.

- Bound remote Iconify collections and caches, preserve cancellation during body reads, and diagnose oversized or changing cache entries.

- Validate all managed output artifacts before reusing completed remote syncs, and preserve manually edited or unowned retired SVG files.

- Keep watch responsive when a directory becomes a file during startup, ship the fixed traversal stack, and make CommonJS consumers share the ESM implementation.

- Allow init to create remote Iconify sources and reject ambiguous input flags.

- Reject malformed UTF-8 in local Iconify JSON inputs instead of silently replacing bytes.

- Reconcile missed local watch notifications, revalidate raced source graphs, and preserve configuration edits made during loading.

- Emit structured JSON fatal diagnostics once while preserving successful CLI reports and original rejected errors.

- Reload each watch configuration in an isolated worker so JavaScript and JSON helper modules refresh without changing native ESM semantics; preserve cancellation drain and structured error reporting.

- Updated dependencies:
  - @iconctl/core@0.3.0

## 0.2.0

### Minor Changes

- Protect sync outputs from incomplete Figma imports, report partial results explicitly, and support AbortSignal cancellation with staged output commits.

### Patch Changes

- Updated dependencies:
  - @iconctl/core@0.2.0

## 0.1.0

### Minor Changes

- Add Figma OAuth login and automatic token renewal for local CLI and GitHub Actions

### Patch Changes

- Updated dependencies:
  - @iconctl/core@0.1.0

## 0.0.1

### Patch Changes

- Reject Figma Community URLs with a duplicate-to-design-file hint, and create parent directories when writing Iconify JSON.

- Name local SVG files with the same kebab-case and draft-skip rules as Figma, and throw IconctlError when the directory is missing.

- Write a dated CHANGELOG.md from the icon diff when output.changelog is set.

- Allow jsonPackage to set package name and skip wiping sibling files.

- Updated dependencies:
  - @iconctl/core@0.0.1
