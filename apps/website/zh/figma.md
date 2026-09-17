# Figma 约定

v1 不要求设计师在 Figma 里点我们的发布按钮。他们维护 Library，工程侧去 sync。

## 文件

图标单独放在 Library 文件里，不要画在业务稿中。

## 画板

- 一图标一个 Component（或 Component Set 里的变体）
- 默认 24×24，除非你改了 `validate.width` / `validate.height`
- 英文 kebab-case：`arrow-left`、`user-filled`
- 中文写在描述里，不要当图层名
- `_` 或 `.` 开头视为草稿，会被跳过

## 颜色

只收单色图标。填充和描边用同一颜色。管线会改写成 `currentColor`，Web 和小程序都能跟文字色走。

多色品牌标和插画不要进这套管线。

## 描边

需要稳定 SVG 时，先 Outline Stroke。隐藏图层、位图、未转曲文字会被拒绝。

## 变体

名为 `user` 的 Component Set，Filled 变体会变成 `user-style-filled`（经过 keyword 清洗）。尽量让名字直接能当 class 用。

## Figma Library 发布

在 Figma 里 Publish Library 是给其他设计稿用的，不会进 git。设计就绪后，工程跑 `figma-iconify sync` 或 GitHub Action。
