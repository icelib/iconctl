# 小程序

微信、支付宝、抖音不能像浏览器那样直接吃 SVG。继续把 Iconify JSON 当源，渲染用 CSS mask + `currentColor`（和 `weapp-tailwindcss` + `@iconify/tailwind4` 同一条路）。

```html
<view class="i-brand-arrow-left text-primary text-24px"></view>
```

class 名和 Web 一样，颜色跟文字走。

不要从这套管线再出 iconfont，也不要把 PNG 雪碧图塞进图标集。

多色 Logo 当普通图片，不要当 Iconify 图标。
