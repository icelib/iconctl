# iconctl

## 0.0.1

### Patch Changes

- Reject Figma Community URLs with a duplicate-to-design-file hint, and create parent directories when writing Iconify JSON.

- Name local SVG files with the same kebab-case and draft-skip rules as Figma, and throw IconctlError when the directory is missing.

- Write a dated CHANGELOG.md from the icon diff when output.changelog is set.

- Allow jsonPackage to set package name and skip wiping sibling files.

- Updated dependencies:
  - @iconctl/core@0.0.1
