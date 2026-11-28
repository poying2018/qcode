# Qcode 0.4.6

本次为维护版本，重点是**发布流程搬到 GitHub Actions**，以及若干可用性与隐私改进。

## 新增

**GitHub Actions 构建与发布**
- 新增 `.github/workflows/release.yml`：推送 `v*` 标签或手动触发即可在 `windows-latest` 上完成
  内核准备 → 语法检查 → 打包 → 生成校验和 → 创建/更新 Release，产物同时留档为 Actions artifact
- 仓库不再需要本地打包上传（仍可用 `npm run dist` 本地构建）

**干净的界面截图流水线**
- 新增 `--shots` 模式与 `scripts/clean-shots.js`（`npm run shots`）：用临时 `USERPROFILE`、假 qwen 配置、独立 `userData` 生成截图，不接触真实会话与端点
- `docs/screenshots/` 收录 4 张经过人工核对的截图，README 恢复图例

## 改进

- **设置页配置路径按 `~` 折叠显示**：界面与截图不再出现完整的用户目录（主进程新增 `displayPath`）
- `runSmoke()` 顺带截图默认写入临时目录，只有 `QCODE_SMOKE_SHOTS=1` 才写仓库，避免把真实配置拍进仓库
- 测试夹具不再硬编码任何盘符路径，统一使用临时目录与注入的工作区

## 修复

- `guessDefaultCwd()` 去掉硬编码的默认工作区候选，改为主目录探测
- 视图过渡被中断（连续切换主题）不再产生未处理拒绝
- 冒烟/基准新增看门狗与分步进度日志，卡住时能定位到最后完成的步骤

## 验证

```text
本地冒烟（内核 0.29.0）  : 599 项断言 / 590 布尔 / 0 false
本地真实对话（--e2e）    : ok，两轮均收到回复，无 renderer 错误
Actions 发布运行          : success（15 个步骤全绿，含内核准备、打包、上传、发布）
Actions artifact          : qcode-windows 426,182,217 B（保留 14 天）
```

产物（由 GitHub Actions 在 windows-latest 上构建）：

```text
Qcode-0.4.6-win.zip      240,420,454 B  sha256 9dc16182…df70274
Qcode-Setup-0.4.6.exe    186,689,818 B  sha256 8a869f7a…542edd
```

内置内核：`@qwen-code/qwen-code` **最新版（0.29.0）**，随安装包分发。

## 升级

安装包见本页 Release 附件（`Qcode-Setup-0.4.6.exe` / `Qcode-0.4.6-win.zip`），
SHA256 见 `SHA256SUMS-0.4.6.txt`。覆盖安装会保留会话与配置。

上一版记录：[RELEASE-NOTES-0.4.5.md](RELEASE-NOTES-0.4.5.md)
