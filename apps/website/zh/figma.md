# Figma 约定

Figma 只是 `iconctl` 的一种来源。v1 不要求设计师点我们的发布按钮。他们维护 Library，工程侧去 sync。

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

在 Figma 里 Publish Library 是给其他设计稿用的。进代码靠 `iconctl sync` 或 GitHub Action。
