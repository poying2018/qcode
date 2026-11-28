# Qcode 0.4.7

修复**任务栏 / 窗口图标缺失**，并把图标资产收敛到唯一设计稿。

## 修复

**任务栏图标空白（主要原因）**
- 构建配置缺少 `appId`，安装器写出的快捷方式**没有 AppUserModelID**，
  而程序里调用了 `app.setAppUserModelId('com.ljanx.qcode')`。
  两者对不上时 Windows 无法把窗口与快捷方式关联，任务栏按钮就显示为空白图标。
- 现在 `package.json` → `build.appId = "com.ljanx.qcode"`，与主进程的 AUMID 完全一致；
  安装后的 `Qcode.lnk` 已实测包含该 ID。

**图标资产与设计稿不一致**
- 仓库里的 `build/brand.svg` 是设计稿（浅色圆角底 + 深色 Q 环），
  但实际打包用的 `icon.png` 是另一套像素风图，且底色透明、描边偏深，缩到 16px 后几乎看不见。
- 现在所有尺寸**统一由 `brand.svg` 推导**，不再出现两套图。

## 新增

- `scripts/make-icons.js`（`npm run icons`）一键生成整套图标：
  - `build/icon.png` 1024×1024（运行时窗口图标）
  - `build/icon-512.png`
  - `build/icon.ico` 16/20/24/32/40/48/64/96/128/256 共 10 档（exe 与安装器）
  - `build/tray-16.png` / `tray-32.png`（托盘）
- 依赖 sharp：优先使用内置内核里的那份，或 `npm i -D sharp`

## 验证

```text
图标文件   icon.png 1024×1024 RGBA · tray 16/32 RGBA · icon.ico 10 档（16px 条目 649B）
安装       0.4.7 覆盖安装成功，probe kernelOk=True / inputReady=True
装机冒烟   599 项断言 / 590 布尔 / 0 false
快捷方式   Qcode.lnk 含 AppUserModelID = com.ljanx.qcode
窗口图标   WM_GETICON 返回 1024×1024 品牌图；类图标 48×48
```

## 升级

覆盖安装保留会话与配置。附件见本页 Release。
上一版记录：[RELEASE-NOTES-0.4.6.md](RELEASE-NOTES-0.4.6.md)
