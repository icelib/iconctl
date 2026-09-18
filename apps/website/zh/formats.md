# 图标方案

iconctl 写出的是 **Iconify JSON**（以及可选的 SVG 文件）。那是工程源。各端怎么把图标画出来，是另一件事。

`i-brand-arrow-left` 是 CSS class，通常是 mask，不是字体，也不是一种新文件格式。

## SVG / webfont / symbol / CSS mask 算全面吗？

不算。这四个名字把文件格式、传输方式和绘制方式混在一起了：

| 口头说法 | 实际多半指 |
| --- | --- |
| SVG | 内联 `<svg>`、`<img src="*.svg">`，或 CSS `background-image` |
| Symbol | SVG sprite 的 `<symbol>` + `<use>`，或 iconfont.cn 的 Symbol JS |
| CSS mask | `mask-image` + `background-color: currentColor` |
| Webfont | `@font-face` + 私用区字形（老式 iconfont） |

面向 Web 和小程序，完整一点的地图是：

1. 内联 SVG（包括 Vue/React 的 SVG 组件）
2. SVG 文件（`<img>` 或 `background-image`）
3. SVG symbol 雪碧图（`<use href="#id">`，iconfont Symbol JS）
4. CSS mask（UnoCSS、`@iconify/tailwind4`、weapp-tailwindcss）
5. 不带 mask 的 CSS background data-URI（颜色写死在图里）
6. Iconify 运行时（`@iconify/vue`、web component）——JSON 进，内联 SVG 出
7. Webfont / iconfont

原生 iOS/Android 矢量、PNG/PDF、canvas 这里不展开。彩色品牌标还是图片，不要当 Iconify 图标。

iconctl **不会**产出 webfont 或 symbol JS。iconfont Symbol URL 是[输入](/zh/sources)，不是输出。

## 对比

| 方案 | `currentColor` | 多色 | 按需 | 额外请求 | 小程序 |
| --- | --- | --- | --- | --- | --- |
| 内联 SVG | 可以 | 可以 | 按组件 | 打进包则无 | SVG 支持差 |
| SVG 文件 | 不行 | 可以 | 可丢掉未用文件 | 一文件一请求 | 常常改 PNG |
| Symbol 雪碧图 | 可以 | 别扭 | 弱，除非按应用重生 | 一份 sprite / JS | 基本没有 `<use>` |
| CSS mask | 可以 | 不行 | 可以（Uno/Tailwind） | CSS 打进包则无 | **推荐** |
| CSS background | 不行 | 可以 | 可以 | 在 CSS 里 | 可以 |
| Iconify 运行时 | 可以 | 可以 | 按需 | 运行时 JS | 不行 |
| Webfont | 当文字色 | 不行 | 差 | 字体文件，FOUT | 很麻烦 |

### 内联 SVG

把 `<svg>` 写进 HTML，或做成 Vue/React 组件。CSS、动画、`aria` / `title` 都好做。

代价：同一图标在页面里复制很多次，标记会胀。小程序不能像浏览器那样吃 SVG。

[演示](/zh/demo) 画廊是把 JSON 的 `body` 内联进去预览。业务应用除非已经在发 SVG 组件，否则不要照抄。

### SVG 文件

`<img src="arrow-left.svg">` 或 `background-image`。缓存简单。颜色写死在文件里，不会跟 `text-primary`。小程序的 `<image>` 经常不认 SVG，最后还是 PNG。

### Symbol 雪碧图

一份文件里一堆 `<symbol id="...">`，再用 `<svg><use href="#arrow-left"></use></svg>`。iconfont 的 Symbol 模式就是这个，外加一段注入 JS。

一份可缓存的包，宿主 SVG 上可以 `currentColor`。外链 sprite 会碰到 CORS。不按应用重新生成就会整包下载。微信 / 支付宝 / 抖音基本没有 `<use>`。iconctl 不写这种产物。

### CSS mask

`mask-image`（SVG 当 alpha）加上 `background-color: currentColor`。class 写法和 iconfont 一样（`i-brand-arrow-left`），没有字体基线问题，UnoCSS 或 `@iconify/tailwind4` 能按用到的 class 裁 CSS。

只能单色——mask 自己没有填充。这和 iconctl 把颜色收成 `currentColor` 是对齐的。这是[小程序](/zh/miniprogram)的做法，也是 Web 的默认路径。

### 不带 mask 的 CSS background

`background-image` 里放 data-URI 或文件，不用 mask。多色能保住，`currentColor` 没有。图标本身就是多色、又还想用 class 时用这个。

### Iconify 运行时

`@iconify/vue` 一类把 JSON 在运行时画成内联 SVG。适合公共图标集，以及已经有这套运行时的应用。多一段 JS。小程序不能用。iconctl 在 Web 上的默认是构建期出 CSS，不走这条。

### Webfont / iconfont

`@font-face` 加私用区字形。HTML 短，大家熟。整份字体都要下，FOUT/FOIT，基线和对齐经常歪，连字会撞车。私用区不是真文字，读屏很容易失败。小程序里放字体文件又大又别扭。

不要从这套管线再出 webfont。如果已经有 iconfont Symbol CDN，[当源收进来](/zh/sources)，然后丢掉字体。

## 怎么选

| 目标 | 绘制方式 |
| --- | --- |
| Web（Vite / UnoCSS / Tailwind） | `@iconify/tailwind4` 或 UnoCSS → CSS mask，class `i-{prefix}-{name}` |
| 小程序 | 同一套 class，CSS mask + `currentColor` |
| 多色 Logo | 图片，不是 Iconify |
| 现成的 iconfont Symbol | `{ type: 'iconfont' }` 当源，然后走 CSS mask |

把 CSS 工具指到[分发](/zh/distribute)出来的 `icons.json`。一条流水线，一套 class 名。
