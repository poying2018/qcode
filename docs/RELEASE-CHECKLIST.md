# 发布检查清单

开源首发或每个正式版本发布前，按顺序走一遍。**未勾选的项不要发**。

## 1. 占位信息

- [ ] `package.json` 的 `repository` / `homepage` / `bugs` 与真实仓库一致
- [ ] `LICENSE` 的版权人年份正确
- [ ] `README.md` 里的 clone 地址已换成真实地址
- [ ] 仓库内没有**运行 smoke 顺带产生的截图**（`shots/` 已 gitignore，且 `runSmoke()` 默认写到临时目录）。
      对外展示图只放在 `docs/screenshots/`，由 `npm run shots` 在干净环境生成，并**逐张人工确认**

## 2. 仓库卫生

- [ ] `git status` 里没有 `node_modules/`、`dist/`、`build/kernel/`、`*.log`、`_probe*`、`shots/`
- [ ] 扫一遍本机绝对路径（盘符开头的绝对路径一律不应出现，测试夹具请用临时目录）：

```powershell
git ls-files | Where-Object { $_ -match '\.(js|json|md|ps1|yml|css|html|txt)$' } | ForEach-Object {
  $m = [regex]::Matches((Get-Content $_ -Raw), '[A-Z]:[\\/][A-Za-z][^"''\s),；，`]*')
  if ($m.Count) { "$_ : " + (($m | ForEach-Object { $_.Value } | Sort-Object -Unique) -join ' ') }
}
```

- [ ] 扫一遍系统用户名出现次数（结果应为 0）：

```powershell
$me = $env:USERNAME
git ls-files | Where-Object { $_ -match '\.(js|json|md|ps1|yml|css|html|txt)$' } |
  Select-String -Pattern ([regex]::Escape($me)) -SimpleMatch
```

- [ ] 扫一遍密钥形状的字符串（`sk-`、`Bearer `、`ghp_`、长十六进制）：

```powershell
git ls-files | Where-Object { $_ -match '\.(js|json|md|ps1|yml|css|html|txt)$' } |
  Select-String -Pattern 'sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}'
```

- [ ] `agent.log`、临时探针文件、调试用的 `console.log` 已清理

## 3. 验证

- [ ] 语法：`node --check main.js && node --check preload.js && node --check renderer\app.js`
- [ ] 功能断言：`npx electron . --smoke` → `[smoke] features` 中 `false` 数为 **0**
- [ ] 性能基准：`npx electron . --bench` 无回归（对照上一版的关键指标）
- [ ] 空闲占用：`npx electron . --idle`
- [ ] 端到端：`npx electron . --e2e`（需要可用内核）
- [ ] 完整门禁：`tools/audit.ps1` 通过
- [ ] 干净克隆验证：新目录 `git clone` → `npm install` → 按 `docs/BUILDING.md` 准备内核 → `npm start` 能起
- [ ] `npm run dist` 能产出 zip 与 Setup exe

## 4. 安装包

- [ ] `dist/` 下两个产物哈希已记录，并写入 `SHA256SUMS-<版本>.txt`
- [ ] 在**干净虚拟机**上安装、启动、完成一次真实对话、卸载
- [ ] 升级路径：旧版 → 新版 覆盖安装后，用户数据（会话、配置）完好
- [ ] 安装器图标、托盘图标、关于页版本号正确
- [ ] 卸载不会删除用户数据（`deleteAppDataOnUninstall: false`）

## 5. 文档与记录

- [ ] `RELEASE-NOTES-<版本>.md` 已补齐本版全部改动
- [ ] `README.md` 的功能列表与实际一致（没有已删除的功能、没有未实现的功能）
- [ ] `docs/BUILDING.md` 的内核准备步骤仍可用
- [ ] 从干净环境按 README 走一遍，确认没有依赖作者本机状态

## 6. 发布

- [ ] 版本号在 `package.json`、安装器产物名、关于页三处一致
- [ ] 打好 tag（建议 `v<版本>`）
- [ ] Release 附上：变更摘要、两个安装包、SHA256 校验值、最低系统要求
- [ ] 声明本项目为第三方外壳，与上游无隶属关系
- [ ] 发布后在新装环境再验一次下载到的安装包
