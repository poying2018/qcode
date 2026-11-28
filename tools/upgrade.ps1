<#
.SYNOPSIS
  Qcode 升级/回滚一条命令。默认 DryRun：只校验产物与打印步骤，不动系统。

.DESCRIPTION
  1) 校验 dist 产物 sha256 与 SHA256SUMS-<target>.txt 一致
  2) 打印「当前已装版本 → 目标版本」与将执行的步骤
  3) -Apply 时：静默安装 → 校验版本 → 装机版 --probe/--smoke 冒烟 → 失败自动回滚到旧版安装包

.EXAMPLE
  pwsh -File tools/upgrade.ps1                       # DryRun（默认）
  pwsh -File tools/upgrade.ps1 -Apply                # 真正升级
  pwsh -File tools/upgrade.ps1 -Apply -SkipSmoke     # 只装不跑冒烟（快）
#>
param(
  [switch]$Apply,
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Programs\Qcode'),
  [string]$Target = (Get-Content (Join-Path (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)) 'package.json') -Raw | ConvertFrom-Json).version,
  [switch]$SkipSmoke,
  [int]$SmokeTimeoutSec = 240
)

$ErrorActionPreference = 'Stop'
# 必须清掉：DSH 等宿主会带 ELECTRON_RUN_AS_NODE=1，会让目标 Electron 应用退化成纯 Node 秒退。
# 守卫「检测进程在不在」时正是被它坑过：启动的副本瞬间退出 → 误判没有进程在跑。
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$dist = Join-Path $root 'dist'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$logDir = Join-Path ([System.IO.Path]::GetTempPath()) "qcode-upgrade-$stamp"
New-Item -ItemType Directory -Path $logDir -Force | Out-Null

function Say([string]$msg, [string]$color = 'Gray') { Write-Host $msg -ForegroundColor $color }
function Fail([string]$msg) { Say "❌ $msg" Red; exit 1 }

$setup = Join-Path $dist "Qcode-Setup-$Target.exe"
$sums = Join-Path $dist "SHA256SUMS-$Target.txt"
if (-not (Test-Path $setup)) { Fail "找不到安装包：$setup（先跑 npm run dist）" }

# ---------- 1) 校验产物哈希 ----------
if (Test-Path $sums) {
  $expected = $null
  Get-Content $sums | ForEach-Object {
    if ($_ -match '^([0-9a-f]{64})\s+\*?(.+)$' -and $Matches[2].Trim() -eq "Qcode-Setup-$Target.exe") { $expected = $Matches[1] }
  }
  if ($expected) {
    $actual = (Get-FileHash $setup -Algorithm SHA256).Hash.ToLower()
    if ($actual -ne $expected) { Fail "安装包哈希不匹配`n  期望 $expected`n  实际 $actual" }
    Say "✅ 哈希校验通过（$($expected.Substring(0,16))…）" Green
  } else {
    Say "⚠ SHA256SUMS 里没有 Qcode-Setup-$Target.exe 条目，跳过哈希校验" Yellow
  }
} else {
  Say "⚠ 找不到 $sums，跳过哈希校验" Yellow
}

# ---------- 2) 当前版本 ----------
$exe = Join-Path $InstallDir 'Qcode.exe'
$current = '未安装'
if (Test-Path $exe) {
  try { $current = (Get-Item $exe).VersionInfo.ProductVersion } catch { $current = '未知' }
}
$regVersion = $null
try {
  Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' -ErrorAction SilentlyContinue | ForEach-Object {
    $p = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue
    if ($p.DisplayName -match '^Qcode') { $regVersion = $p.DisplayVersion }
  }
} catch { /* 注册表不可读时忽略 */ }

Say ""
Say "Qcode 升级计划" Cyan
Say "  安装目录   : $InstallDir"
Say "  当前版本   : $current$(if ($regVersion) { "（注册表 $regVersion）" })"
Say "  目标版本   : $Target"
Say "  安装包     : $setup"
Say "  日志目录   : $logDir"
Say ""

$currentShort = ($current -replace '\.0$', '')
$sameVersion = $currentShort -eq $Target
if ($sameVersion) { Say "ℹ 目标版本与已装版本相同（$Target）：-Apply 会执行一次重装，并先备份旧安装目录" Yellow }
$running = @(Get-Process -Name 'Qcode' -ErrorAction SilentlyContinue)
if (-not $running.Count) {
  Start-Sleep -Milliseconds 400
  $running = @(Get-Process -Name 'Qcode' -ErrorAction SilentlyContinue)
}
if ($running.Count) {
  Say "⚠ 检测到 $($running.Count) 个 Qcode 进程在运行" Yellow
  $running | ForEach-Object { Say ("    pid={0} start={1}" -f $_.Id, $_.StartTime) }
  if ($Apply) { Fail "请先手动退出 Qcode（升级过程中强杀进程可能损坏安装）" }
}

if (-not $Apply) {
  Say "步骤（DryRun，不执行）：" Cyan
  Say "  1. 静默运行 $setup /S"
  Say "  2. 校验 $exe 版本 == $Target"
  Say "  3. 用临时 userData 跑装机版 --probe$(if (-not $SkipSmoke) { ' 与 --smoke' })"
  Say "  4. 任一步失败 → $(if ($sameVersion) { '恢复安装前的目录备份' } else { "用 dist\Qcode-Setup-$currentShort.exe 回滚（若该包存在）" })"
  Say ""
  Say "DryRun 结束：没有对系统做任何修改。加 -Apply 才会真正升级。" Green
  exit 0
}

# ---------- 3) 安装 ----------
Say "开始安装 $Target …" Cyan
$installLog = Join-Path $logDir 'install.log'
$preInstallBackup = $null
if ($sameVersion) {
  # 同版本重装没有「旧版本安装包」可回滚。先把整个安装目录移到旁边，冒烟通过后再删备份；
  # 失败则删掉新装目录并移回旧目录，避免拿同一个安装包「回滚」自己。
  $preInstallBackup = Join-Path (Split-Path -Parent $InstallDir) ("Qcode-backup-$stamp")
  if (Test-Path $preInstallBackup) { Fail "备份路径已存在：$preInstallBackup" }
  Say "  备份旧安装目录 → $preInstallBackup" Yellow
  Move-Item -LiteralPath $InstallDir -Destination $preInstallBackup
}
$proc = Start-Process -FilePath $setup -ArgumentList '/S' -PassThru -Wait
Say ("  安装器退出码：{0}（日志 {1}）" -f $proc.ExitCode, $installLog)

$ok = $false
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Seconds 2
  if (Test-Path $exe) {
    $v = (Get-Item $exe).VersionInfo.ProductVersion
    if ($v -like "$Target*") { $ok = $true; break }
  }
}
if (-not $ok) {
  $v = if (Test-Path $exe) { (Get-Item $exe).VersionInfo.ProductVersion } else { '缺失' }
  Say "❌ 安装后版本校验失败（当前 $v），尝试回滚" Red
} else {
  Say "✅ 已安装版本：$((Get-Item $exe).VersionInfo.ProductVersion)" Green
}

# ---------- 4) 装机版冒烟 ----------
function Invoke-Installed([string]$argsLine, [string]$tag) {
  $ud = Join-Path $logDir "ud-$tag"
  New-Item -ItemType Directory -Path $ud -Force | Out-Null
  $log = Join-Path $logDir "$tag.log"
  $prevUd = $env:QCODE_USER_DATA
  $prevRun = $env:ELECTRON_RUN_AS_NODE
  $env:QCODE_USER_DATA = $ud
  Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
  try {
    cmd /c "`"$exe`" $argsLine > `"$log`" 2>&1" | Out-Null
  } finally {
    $env:QCODE_USER_DATA = $prevUd
    if ($prevRun) { $env:ELECTRON_RUN_AS_NODE = $prevRun }
  }
  return $log
}

if ($ok) {
  $probeLog = Invoke-Installed '--probe' 'probe'
  $probeLine = Select-String -Path $probeLog -Pattern '\[probe\]' | Select-Object -Last 1
  if (-not $probeLine) {
    Say "❌ 装机版 --probe 没有输出（$probeLog）" Red
    $ok = $false
  } else {
    $p = ($probeLine.Line -replace '^\[probe\] ', '') | ConvertFrom-Json
    Say ("   probe: kernelOk={0} guideShown={1} inputReady={2}" -f $p.kernel.ok, $p.dom.guideShown, $p.dom.inputReady)
    if (-not $p.dom.inputReady) { Say "❌ 界面未就绪" Red; $ok = $false }
  }
}

if ($ok -and -not $SkipSmoke) {
  Say "跑装机版冒烟（最长 $SmokeTimeoutSec 秒）…" Cyan
  $smokeLog = Invoke-Installed '--smoke' 'smoke'
  $featureLine = Select-String -Path $smokeLog -Pattern '\[smoke\] features:' | Select-Object -Last 1
  if (-not $featureLine) {
    Say "❌ 装机版冒烟没有 features 汇总行（$smokeLog）" Red
    $ok = $false
  } else {
    $o = ($featureLine.Line -replace '^.*\[smoke\] features: ', '') | ConvertFrom-Json
    $bools = @($o.PSObject.Properties | Where-Object { $_.Value -is [bool] })
    $falses = @($bools | Where-Object { -not $_.Value })
    Say ("   冒烟: keys={0} bool={1} false={2}" -f @($o.PSObject.Properties).Count, $bools.Count, $falses.Count)
    if ($falses.Count -gt 0) {
      Say ("   失败项：" + (($falses | ForEach-Object { $_.Name }) -join ', ')) Red
      $ok = $false
    }
  }
}

# ---------- 5) 结果 ----------
Say ""
if ($ok) {
  if ($preInstallBackup -and (Test-Path $preInstallBackup)) {
    try {
      Remove-Item -LiteralPath $preInstallBackup -Recurse -Force -ErrorAction Stop
      Say "  已清理安装前备份" DarkGray
    } catch {
      Say "⚠ 安装成功，但旧安装备份未能清理：$preInstallBackup" Yellow
    }
  }
  Say "升级完成 ✅  （日志：$logDir）" Green
  exit 0
}

Say "升级失败 ❌" Red
if ($sameVersion -and $preInstallBackup -and (Test-Path $preInstallBackup)) {
  Say "恢复安装前目录备份 …" Yellow
  if (Test-Path $InstallDir) { Remove-Item -LiteralPath $InstallDir -Recurse -Force }
  Move-Item -LiteralPath $preInstallBackup -Destination $InstallDir
  if (Test-Path $exe) { Say ("  已恢复版本：{0}" -f (Get-Item $exe).VersionInfo.ProductVersion) }
} else {
  $rollback = Join-Path $dist "Qcode-Setup-$currentShort.exe"
  if (Test-Path $rollback) {
    Say "回滚到 $current …" Yellow
    $rb = Start-Process -FilePath $rollback -ArgumentList '/S' -PassThru -Wait
    Say ("  回滚安装器退出码：{0}" -f $rb.ExitCode)
    if (Test-Path $exe) { Say ("  当前版本：{0}" -f (Get-Item $exe).VersionInfo.ProductVersion) }
  } else {
    Say "⚠ 找不到回滚包 $rollback，请手动处理" Yellow
  }
}
Say "  日志：$logDir"
exit 1

