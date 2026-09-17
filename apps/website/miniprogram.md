# Mini programs

WeChat, Alipay, and Douyin do not consume SVG the way a browser does. Keep using Iconify JSON as the source, then render with CSS mask + `currentColor` (the same approach as `weapp-tailwindcss` + `@iconify/tailwind4`).

```html
<view class="i-brand-arrow-left text-primary text-24px"></view>
```

Class names stay identical to Web. Color follows text color.

Do not generate iconfont from this pipeline. Do not drop PNG sprites into the icon set.

Multicolor logos are normal images, not Iconify icons.
