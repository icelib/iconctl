# 图标方案

iconctl 写出的是 **Iconify JSON**（以及可选的 SVG 文件）。那是工程源。各端怎么把图标画出来，是另一件事。`i-brand-arrow-left` 是 CSS class，通常是 mask，不是字体。

## 目录

这页出现过的绘制方案都在这里。**主流**指 2020 年代新做的 Web / 小程序 UI 实际在发什么，不是 iconfont.cn 还在生成什么。

| 方案 | 现状 | 干什么 |
| --- | --- | --- |
| [CSS mask](#css-mask) | 主流 | 产品 UI + 小程序。iconctl 默认。 |
| [内联 SVG](#内联-svg) | 主流 | Vue/React 组件、动画、无障碍。 |
| [Iconify 运行时](#iconify-运行时) | 主流 | 公共图标集 / 已经有 `@iconify/vue` 的应用。 |
| [SVG 文件](#svg-文件) | 按需 | 插画、Logo、`<img>`。 |
| [CSS background](#css-background) | 按需 | 多色图标还想用 class。 |
| [Symbol 雪碧图](#symbol-雪碧图) | 遗留 | `<use>` / iconfont Symbol JS。国内还常见。 |
| [Webfont](#webfont) | 遗留 | `@font-face` + 私用区。国内还常见。 |

iconctl **不会**产出 webfont 或 symbol JS。iconfont Symbol URL 是[输入](/zh/sources)。PNG、原生 iOS/Android 矢量这里不展开。

<IconFormatToolbar />

## CSS mask

**主流。** `mask-image` 加上 `background-color: currentColor`。class 写法和 iconfont 一样（`i-brand-arrow-left`），没有字体基线问题，UnoCSS 或 `@iconify/tailwind4` 能按用到的 class 裁 CSS。只能单色。这是[小程序](/zh/miniprogram)的做法，也是 iconctl 在 Web 上的默认。

<IconFormatDemo scheme="mask" />

## 内联 SVG

组件应用里的**主流**。把 `<svg>` 写进 HTML 或 Vue/React SFC，画法一样。CSS、动画、`aria` / `title` 都好做。同一图标在页面里复制很多次，标记会胀。小程序不能像浏览器那样吃 SVG。[演示](/zh/demo) 画廊把 JSON `body` 内联进去是预览，不是生产 class API。

<IconFormatDemo scheme="inline" />

## Iconify 运行时

公共图标集、以及已经跑着 `@iconify/vue`（或 web component）的应用，这是**主流**。JSON 进，内联 SVG 出。多一段 JS。小程序不能用。iconctl 在 Web 上默认仍是构建期出 CSS。

<IconFormatDemo scheme="runtime" />

## SVG 文件

**按需。** `<img src="arrow-left.svg">`。缓存简单。颜色写死，不会跟 `text-primary`。小程序的 `<image>` 经常不认 SVG。插画和 Logo 用这个，24px 的 UI 套件别用。

<IconFormatDemo scheme="file" />

## CSS background

**按需。** `background-image` 放 data-URI 或文件，不用 mask。多色能保住，`currentColor` 没有。图标本身就是多色、又还想用 class 时用这个。

<IconFormatDemo scheme="background" />

## Symbol 雪碧图

**遗留**，国内 iconfont 流程里还常见。一份文件里一堆 `<symbol id>`，再用 `<svg><use href="#id"></use></svg>`。iconfont 的 Symbol 就是这个，外加一段注入 JS。宿主 SVG 上可以 `currentColor`。外链 sprite 会碰到 CORS；不按应用重生就会整包下载。微信 / 支付宝 / 抖音基本没有 `<use>`。iconctl 不写这种产物。

<IconFormatDemo scheme="symbol" />

## Webfont

**遗留**，iconfont.cn 还在发。`@font-face` 加私用区字形。HTML 短，大家熟。整份字体都要下，FOUT，基线会漂，私用区不是真文字。下面的字形是**演示字体**（描边被收成填充），不是 iconctl 产物。不要从这套管线再出 webfont。如果已经有 Symbol CDN，[当源收进来](/zh/sources)，然后丢掉字体。

<IconFormatDemo scheme="webfont" />

<IconFormatScores />

## 补充：口头那四个名字

常听人说「SVG / webfont / symbol / CSS mask」。这四个把文件格式、传输方式和绘制方式混在一起了：

| 口头说法 | 实际多半指 |
| --- | --- |
| SVG | 内联 `<svg>`、`<img src="*.svg">`，或 CSS `background-image` |
| Symbol | SVG sprite 的 `<symbol>` + `<use>`，或 iconfont.cn 的 Symbol JS |
| CSS mask | `mask-image` + `background-color: currentColor` |
| Webfont | `@font-face` + 私用区字形 |

上面的目录才是这套产品实际在拆的方案。
