# @iconctl/core

## 0.1.0

### Minor Changes

- Add Figma OAuth login and automatic token renewal for local CLI and GitHub Actions

- Add injectable Figma authorization providers and a Workers-compatible OAuth protocol export; preserve multi-source sync results and validate cache baselines.

## 0.0.1

### Patch Changes

- Reject Figma Community URLs with a duplicate-to-design-file hint, and create parent directories when writing Iconify JSON.

- Name local SVG files with the same kebab-case and draft-skip rules as Figma, and throw IconctlError when the directory is missing.

- Write a dated CHANGELOG.md from the icon diff when output.changelog is set.

- Allow jsonPackage to set package name and skip wiping sibling files.
