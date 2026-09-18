# Figma conventions

Figma is one `iconctl` source. Designers do not need a special publish button in v1. They maintain a Figma library; engineering syncs it.

## File

Keep icons in a dedicated library file, not inside product screens.

## Frames

- One icon = one Component (or a variant inside a Component Set)
- 24×24 canvas unless you change `validate.width` / `validate.height`
- English kebab-case names: `arrow-left`, `user-filled`
- Chinese labels belong in the description, not the layer name
- Drafts start with `_` or `.` and are skipped

## Color

Monochrome icons only. The pipeline rewrites fills to `currentColor`.

## Config

```ts
{
  type: 'figma',
  file: 'https://www.figma.com/design/<fileKey>/Icons',
  pages: ['Icons'],
}
```

Publishing the Figma library is for other design files. Engineering runs `iconctl sync` or the GitHub Action after the library is ready.
