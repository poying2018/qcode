# 构建与内核打包

本文档说明如何从源码构建 Qcode，以及如何准备「内置内核」。

## 环境要求

| 项目 | 版本 |
|---|---|
| Windows | 10 / 11 x64 |
| Node.js | ≥ 20（推荐 22 LTS） |
| npm | 随 Node 附带 |
| PowerShell | 5.1 或 7+（仅 `tools/` 脚本需要） |

## 依赖安装

```powershell
npm install
```

`npx electron .` 拉起的开发版本会直接读取仓库目录下的 `build/` 与 `renderer/`。

## 内置内核（`build/kernel/`）

Qcode 有两种使用 Qwen Code CLI 的方式：

1. **系统 CLI**：用户自己 `npm i -g @qwen-code/qwen-code`，Qcode 从 `PATH`、`%APPDATA%\npm`、`Program Files\nodejs` 等位置探测。
2. **内置内核**：把运行时随安装包一起分发，用户装完即用。这条路径需要 `build/kernel/`。

### 约定目录结构

```
build/kernel/
  node.exe                                  # 独立 Node 运行时（不是 Electron 的 ELECTRON_RUN_AS_NODE）
  node_modules/
    @qwen-code/
      qwen-code/
        cli-entry.js                        # 内核入口
        ...（完整运行树，含 sharp 等原生依赖）
```

代码中的解析顺序（`bundledKernelRoot()`）：

- 开发态：`<仓库根>/build/kernel/`
- 打包态：`<安装目录>/resources/kernel/`

### 为什么必须自带 `node.exe`

Qcode 用 `ELECTRON_RUN_AS_NODE` 起子进程会把入口脚本当成首条 prompt，并丢掉后续 stdin 消息。
所以内置内核必须是一个**独立的 Node 二进制**，不能复用 Electron 自身。

### 准备步骤

```powershell
# 1) 建目录
New-Item -ItemType Directory -Force build\kernel | Out-Null

# 2) 放入独立 Node 运行时（从 nodejs.org 下载 Windows x64 解压后复制 node.exe）
Copy-Item <解压目录>\node.exe build\kernel\node.exe

# 3) 安装 CLI 运行树到 build\kernel
Push-Location build\kernel
npm install --omit=dev --no-save @qwen-code/qwen-code
Pop-Location

# 4) 校验哨兵文件存在
Test-Path build\kernel\node_modules\@qwen-code\qwen-code\cli-entry.js
```

第 4 步必须返回 `True`，否则 `npm run dist` 的 `afterPack` 钩子会直接报错终止。

> `build/kernel/` 已被 `.gitignore` 排除：`node.exe` 约 92MB，运行树另含原生依赖，
> 不适合进版本库。请由使用者本地准备，或在自己的 CI 里缓存。

### 打包时的额外拷贝

`electron-builder` 会修剪 `extraResources` 中名为 `node_modules` 的目录，导致内核缺运行树。
`scripts/afterPack.js` 在生成安装包前把 `build/kernel/node_modules` 补拷到 `resources/kernel/node_modules`，
并用 `cli-entry.js` 作哨兵校验，缺失时清理残留后重拷。

## 构建产物

```powershell
npm run dist
```

| 产物 | 说明 |
|---|---|
| `dist/Qcode-Setup-<版本>.exe` | NSIS 安装器，`oneClick: false`，可选安装目录，卸载不清 AppData |
| `dist/Qcode-<版本>-win.zip` | 免安装版，解压即用 |

版本号统一取自 `package.json` 的 `version`；安装包 GUID 固定，便于覆盖升级。

## 自检门禁

```powershell
# 语法
node --check main.js
node --check preload.js
node --check renderer\app.js

# 功能断言 / 性能 / 空闲 / 端到端
npx electron . --smoke
npx electron . --bench
npx electron . --idle
npx electron . --e2e
```

`--smoke` 会打印一行 `[smoke] features: {...}`，其中所有布尔值都必须为 `true`；
仅有 `[smoke] done` 不代表通过。

跑自检前的注意事项：

- 当前终端不能带 `ELECTRON_RUN_AS_NODE=1`
- `--smoke` / `--bench` 会使用独立 `QCODE_USER_DATA` 目录，不会污染真实用户数据
- PowerShell 脚本若报中文解析错误，多半是文件缺 BOM；`tools/*.ps1` 已带 UTF-8 BOM
