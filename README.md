# Qcode

Qcode 是 **Qwen Code CLI 的 Windows 桌面图形外壳**。它把命令行里的对话、上下文、工具执行、文件与 Git 操作整理成一个可长期使用的桌面工作台，同时保留 CLI 的全部能力。

- 技术栈：Electron 43 + 原生 JS（无框架、无打包器），主进程 `main.js`、预加载 `preload.js`、渲染层 `renderer/`
- 平台：Windows 10 / 11 x64
- 当前版本：`0.4.5`
- 许可证：MIT（见 [LICENSE](LICENSE)）

> Qcode 是第三方外壳，与阿里云 / Qwen 官方无隶属关系。Qwen Code CLI 本身遵循其上游项目许可证，请自行遵守。

## 功能

**对话与上下文**
- 流式输出、markdown / 表格 / 代码块渲染、思考过程折叠、工具调用卡片（含时长、错误条、复制）
- 上下文占用环与明细面板，手动压缩、超限自动提醒
- Goal 模式：自动续跑、轮数 / 预算门禁、提前跳转
- 回合超时、停止与续聊（走内核 `--resume`）

**会话管理**
- 会话列表、置顶、重命名、归档（批量 / 自动规则 / 撤销）、回收站
- 跨会话消息级搜索、侧栏过滤、懒加载大库（千级会话秒开）
- 草稿保存、历史输入、滚动位置记忆

**工作区**
- 项目分组、文件树（异步搜索、分页、符号链接防护）
- 内置文件编辑、Git 面板（暂存 / 提交 / 双栏 diff / 分支复制）
- 检查点：创建 / 差异预览 / 逐文件回滚 / 新增文件清理

**配置与集成**
- 多供应商 / 多模型配置，端点与连通性测试（统一私网与 DNS 安全策略）
- MCP、Hooks、Skills、斜杠命令、记忆与项目指令
- 用量统计、Token 预算、导出（HTML / PDF）
- 深色主题、快捷键、托盘、置顶、开机启动

## 快速开始（开发）

```powershell
git clone https://github.com/poying2018/qcode.git
cd qcode
npm install
npm start
```

`npm start` 需要能找到 Qwen Code CLI，二选一：

1. **使用系统已安装的 CLI**：在设置 → 高级里填入 `qwen` 可执行文件路径，或确保它在 `PATH` 中。
2. **使用内置内核**：把一份 Node 运行时与 `qwen-code` 运行树放到 `build/kernel/`，详见 [docs/BUILDING.md](docs/BUILDING.md)。

## 构建安装包

```powershell
npm run dist
```

产物在 `dist/`：

| 文件 | 用途 |
|---|---|
| `Qcode-Setup-<版本>.exe` | NSIS 安装器（可选安装目录） |
| `Qcode-<版本>-win.zip` | 免安装绿色版 |

`build/kernel/` 不会进版本库，构建前需先准备好，否则 `afterPack` 会明确报错提示。

## 自检

项目自带一套可复现的自检开关，便于改动后回归（均为命令行走廊，不需要人工点）：

```powershell
# 功能断言（输出一行 [smoke] features: {...}，全部布尔为 true 才算通过）
npx electron . --smoke

# 渲染性能基准
npx electron . --bench

# 空闲占用
npx electron . --idle

# 真实内核端到端
npx electron . --e2e
```

运行前请确认当前终端没有 `ELECTRON_RUN_AS_NODE=1`（某些把自身跑在 Electron 里的终端会注入它，导致 `electron .` 退化成纯 Node）。

`tools/audit.ps1` 会把 smoke / bench / idle 与已安装版本探测串成一道门禁；`tools/upgrade.ps1` 做带哈希校验的本地升级与回滚。两者都是 PowerShell 脚本，按需修改路径后使用。

## 数据与隐私

- 会话、配置、日志默认写入 Electron 的 `userData` 目录（Windows 通常是 `%APPDATA%\Qcode`）
- 配置导出默认**脱敏**（API Key 打码），导出前可在设置页预览实际内容
- 日志与错误提示对密钥、Bearer token、URL query 中的敏感字段做深度打码
- 本项目不收集任何遥测数据

## 文档

- [构建与内核打包](docs/BUILDING.md)
- [发布检查清单](docs/RELEASE-CHECKLIST.md)
- [贡献指南](CONTRIBUTING.md)
- [安全策略](SECURITY.md)
- [变更记录](RELEASE-NOTES-0.4.5.md)

## 截图

界面截图正在按「不含任何本机路径与个人配置」的标准重新生成，补齐后会放在这里。

需要先看效果的话，可以本地跑 `npm start`，或用 `--shots` 开关自动生成全套界面截图到 `shots/`。
