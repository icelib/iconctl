# Figma 约定

Figma 只是 `iconctl` 的一种来源。设计师维护 Library，然后在 [iconctl 插件](/zh/publish) 里点 **Publish**。工程侧 review PR。Figma 的 Publish Library 只给其他设计稿用。

## 文件

图标单独放在 Library 文件里，不要画在业务稿中。

## 画板

- 一图标一个 Component（或 Component Set 里的变体）
- 默认 24×24
- 英文 kebab-case：`arrow-left`、`user-filled`
- 中文写在描述里
- `_` 或 `.` 开头视为草稿

## 配置

```ts
{
  type: 'figma',
  file: 'https://www.figma.com/design/<fileKey>/Icons',
  pages: ['Icons'],
}
```

在 Figma 里 Publish Library 是给其他设计稿用的。进代码靠插件的 **Publish**（或 `iconctl sync` / GitHub Action）。

[演示页](/zh/demo) 用公开的 [Lucide Icons](https://www.figma.com/community/file/939851755929765537/Lucide-Icons) 库跑了一遍流水线。Community 链接要先复制成 `/design/{fileKey}`，REST API 才能读。
