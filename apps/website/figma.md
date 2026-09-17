# Figma conventions

Designers do not need a special figma-iconify publish button in v1. They maintain a Figma library; engineering syncs it.

## File

Keep icons in a dedicated library file, not inside product screens.

## Frames

- One icon = one Component (or a variant inside a Component Set)
- 24×24 canvas unless you change `validate.width` / `validate.height`
- English kebab-case names: `arrow-left`, `user-filled`
- Chinese labels belong in the description, not the layer name
- Drafts start with `_` or `.` and are skipped

## Color

Monochrome icons only. Fills and strokes should be a single color. The pipeline rewrites them to `currentColor` so Web and mini programs can color icons with text classes.

Multicolor brand marks and illustrations stay out of this pipeline.

## Outline strokes

Convert strokes to outlines before you expect a stable SVG. Hidden layers, raster images, and live text are rejected.

## Variants

A Component Set named `user` with a `Filled` variant becomes `user-style-filled` (or similar, after keyword cleanup). Prefer names that already read well in class form.

## Figma Library publish

Publishing the Figma library is for other design files. It does not push icons into git. Engineering runs `figma-iconify sync` or the GitHub Action after the library is ready.
