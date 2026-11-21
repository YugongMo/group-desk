# Group Desk

[GitHub Pages 启动页](https://yugongmo.github.io/group-desk/)用作 Grist Group Desk 自定义组件的外壳。页面先显示加载动画，再从当前组件的 `widgetOptions` 读取 `_html` 和 `_js`，在子 iframe 中运行。

部署到 GitHub Pages 时使用 `main` 分支的根目录。切换组件时使用自定义 URL 模式，保留已有访问级别和完整的 `widgetOptions`。加载动画需要 `renderAfterReady: false` 才能在 Grist 握手前显示。

回退时，把组件改回 **Custom widget builder**，并原样保留 `widgetOptions`。
