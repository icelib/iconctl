# Figma conventions

Figma is one `iconctl` source. Designers maintain a library file, then press **Publish** in the [iconctl plugin](/publish). Engineering reviews the pull request. Figma Library “Publish” is only for other design files.

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

Publishing the Figma library is for other design files. Shipping icons into code is the plugin **Publish** button (or `iconctl sync` / the GitHub Action).

See the [demo](/demo) for a gallery built from the public [Lucide Icons](https://www.figma.com/community/file/939851755929765537/Lucide-Icons) library. Community URLs must be duplicated to a `/design/{fileKey}` link before the REST API will serve them.
