# 贡献指南

感谢你愿意改进 Qcode。这是一个刻意保持"小"的项目：无框架、无打包器、无 TypeScript，全部是原生 JS 直读源码。

## 环境准备

```powershell
npm install
# 需要内置内核时见 docs/BUILDING.md
npm start
```

## 代码地图

| 路径 | 作用 |
|---|---|
| `main.js` | 主进程：窗口、IPC、会话读写、内核子进程、导出、检查点、全部自检开关 |
| `preload.js` | `contextBridge` 暴露给渲染层的 `window.shell` API（唯一的进程间契约） |
| `renderer/app.js` | 渲染层全部逻辑：状态、渲染、交互、设置页 |
| `renderer/index.html` | 静态骨架与控件 |
| `renderer/style.css` | 全部样式（含深色主题与动效） |
| `tools/audit.ps1` | 复核门禁：smoke / bench / idle + 已安装版本探测 |
| `tools/upgrade.ps1` | 带哈希校验的本地升级与回滚 |
| `scripts/afterPack.js` | 打包后补拷内核运行树 |

## 提交前必须自检

```powershell
node --check main.js
node --check preload.js
node --check renderer\app.js

npx electron . --smoke
```

`--smoke` 会打印 `[smoke] features: {...}`，**其中每个布尔值都必须为 `true`**。
只看到 `[smoke] done` 不代表通过。

改动涉及渲染性能时，再跑 `npx electron . --bench` 并对比改动前后的 `bootMs`、`firstFrameMs`、
`frameP95`、`longMsgHighlightMs` 等指标。

## 改代码时的约定

- **不要引入框架或构建步骤**：新增能力优先用原生 DOM API。
- **渲染层不直接碰 Node**：一切系统能力走 `preload.js` 的 `window.shell`，主进程侧用受信任的 IPC 包装（校验根目录、realpath、负载上限）。
- **模板字符串里写正则要双写反斜杠**：渲染层逻辑大量位于 `executeJavaScript` 的模板字符串中，`\n`、`\d` 会被外层吞掉。
- **断言要可复现**：给 `--smoke` 加断言时，用临时目录而不是仓库路径，避免仓库体积变化导致断言漂移。
- **性能数字要带口径**：说明是单次、N 次均值还是 p95，并注明数据规模。
- **不要吞掉失败**：写盘、删除、恢复这类操作失败必须有可见反馈（状态栏 / toast / 返回值中的 `failed` 数组）。

## 提交信息

```
<范围>: <一句话做了什么>

可选：为什么这么改、验证方式、影响面
```

范围示例：`main`、`renderer`、`preload`、`tools`、`docs`。

## 报告问题

请附上：

- Windows 版本与 Qcode 版本（设置 → 关于）
- 复现步骤与预期/实际结果
- 相关日志片段（默认在 `%APPDATA%\Qcode`；日志中的密钥已自动打码）

安全相关问题请走 [SECURITY.md](SECURITY.md)，不要开公开 issue。
