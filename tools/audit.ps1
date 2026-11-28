<#
.SYNOPSIS
  Qcode 一键复核：跑冒烟 / 基准 / 空闲 / （可选）真实对话，解析并汇总，失败返回非 0。

.DESCRIPTION
  - smoke : 断言全量功能（解析 [smoke] features 的 false 数）
  - bench : 交互与启动基准（解析 [bench] renderer / main）
  - idle  : 静置 CPU（解析 [idle]）
  - e2e   : 真实内核对话两轮（需网络与模型额度，默认不跑）

.EXAMPLE
  pwsh -File tools/audit.ps1
  pwsh -File tools/audit.ps1 -WithE2E
  pwsh -File tools/audit.ps1 -Only smoke,bench
#>
param(
  [switch]$WithE2E,
  [switch]$WithInstalled,
  [string[]]$Only = @('smoke', 'bench', 'idle'),
  [int]$IdleSecs = 30,
  [string]$OutDir = '',
  [switch]$Keep,
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Programs\Qcode'),
  # 预算阈值：超过即判失败（让复核能当回归门用，而不是只报数字）
  [double]$MaxBootMs = 400,
  [double]$MaxTypingMs = 1.0,
  [double]$MaxResizeLayoutMs = 5.0,
  [double]$MaxIdleRenderer = 2.0,
  [double]$MaxGlobalSearchMs = 10.0,
  [double]$MaxExportHtmlMs = 100.0,
  [double]$MaxLongHighlightMs = 20.0,
  [double]$MaxPdf200MsgsMs = 5000.0
)

$ErrorActionPreference = 'Stop'
# -Only smoke,bench 从命令行进来是单个字符串，这里拆成数组（否则会「一个阶段都没跑却报通过」）
$Only = @($Only | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })
if ($WithE2E -and ($Only -notcontains 'e2e')) { $Only += 'e2e' }
if ($WithInstalled -and ($Only -notcontains 'installed')) { $Only += 'installed' }
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
if (-not (Test-Path (Join-Path $root 'package.json'))) { throw "找不到项目根目录（$root）" }

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
if (-not $OutDir) { $OutDir = Join-Path ([System.IO.Path]::GetTempPath()) "qcode-audit-$stamp" }
New-Item -ItemType Directory -Path $OutDir -Force | Out-Null

$electron = Join-Path $root 'node_modules\.bin\electron.cmd'
if (-not (Test-Path $electron)) { throw "找不到 electron（$electron），请先 npm install" }

# DSH 之类宿主会把 ELECTRON_RUN_AS_NODE 传进来，会让 electron 退化成纯 Node
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

$fail = @()
$report = [ordered]@{ stamp = $stamp; phases = [ordered]@{} }

function Invoke-Qcode([string]$name, [string[]]$argv, [string]$userDataName) {
  $log = Join-Path $OutDir "$name.log"
  $userData = Join-Path $OutDir $userDataName
  New-Item -ItemType Directory -Path $userData -Force | Out-Null
  $prevUd = $env:QCODE_USER_DATA
  $env:QCODE_USER_DATA = $userData
  $t0 = Get-Date
  try {
    Push-Location $root
    $argLine = ($argv | ForEach-Object { $_ }) -join ' '
    cmd /c "`"$electron`" . $argLine > `"$log`" 2>&1" | Out-Null
  } finally {
    Pop-Location
    $env:QCODE_USER_DATA = $prevUd
  }
  $secs = [math]::Round(((Get-Date) - $t0).TotalSeconds, 1)
  Write-Host ("  [{0}] {1}s → {2}" -f $name, $secs, $log) -ForegroundColor DarkGray
  return @{ log = $log; secs = $secs }
}

function Get-JsonLine([string]$log, [string]$pattern) {
  if (-not (Test-Path $log)) { return $null }
  $line = (Select-String -Path $log -Pattern $pattern | Select-Object -Last 1)
  if (-not $line) { return $null }
  $json = ($line.Line -replace $pattern, '')
  try { return $json | ConvertFrom-Json } catch { return $null }
}

Write-Host "Qcode 复核 ($stamp)" -ForegroundColor Cyan
Write-Host "  输出目录: $OutDir"

# ---------------- smoke ----------------
if ($Only -contains 'smoke') {
  $r = Invoke-Qcode 'smoke' @('--smoke') 'ud-smoke'
  $log = $r.log
  $line = Select-String -Path $log -Pattern '\[smoke\] features: ' | Select-Object -Last 1
  $s = [ordered]@{ ok = $false; secs = $r.secs }
  if ($line) {
    try {
      $o = ($line.Line -replace '^.*\[smoke\] features: ', '') | ConvertFrom-Json
      $props = $o.PSObject.Properties | Where-Object { $_.Value -is [bool] }
      $falses = @($props | Where-Object { -not $_.Value } | ForEach-Object { $_.Name })
      $s.keys = @($o.PSObject.Properties).Count
      $s.bool = @($props).Count
      $s.false = $falses.Count
      $s.falseNames = $falses
      $s.done = [bool](Select-String -Path $log -Pattern '\[smoke\] done' -Quiet)
      $s.ok = ($falses.Count -eq 0) -and $s.done -and ($s.bool -gt 0)
    } catch { $s.error = '无法解析 features 行' }
  } else { $s.error = '缺少 [smoke] features 行（流程未走完？）' }
  if (-not $s.ok) { $fail += "smoke: $($s.error) $($s.falseNames -join ',')" }
  $report.phases.smoke = $s
  Write-Host ("  smoke  : keys={0} bool={1} false={2} done={3}" -f $s.keys, $s.bool, $s.false, $s.done) -ForegroundColor $(if ($s.ok) { 'Green' } else { 'Red' })
}

# ---------------- bench ----------------
if ($Only -contains 'bench') {
  $r = Invoke-Qcode 'bench' @('--bench') 'ud-bench'
  $log = $r.log
  $rend = Get-JsonLine $log '^\[bench\] renderer '
  $main = Get-JsonLine $log '^\[bench\] main '
  $b = [ordered]@{ ok = [bool]($rend -and $main); parsed = [bool]($rend -and $main); secs = $r.secs }
  if ($rend) {
    $b.bootMs = $rend.bootMs
    $b.scriptStartMs = $rend.scriptStartMs
    $b.initialLayoutMs = $rend.initialLayoutMs
    $b.firstFrameMs = $rend.firstFrameMs
    $b.composerTypingMs = $rend.composerTypingMs
    $b.threadWindowMs = $rend.threadWindowMs
    $b.toolDenseCapMs = $rend.toolDenseCapMs
    $b.cfgOpenMs = $rend.cfgOpenMs
    $b.sidebarFullMs = $rend.sidebarFullMs
    $b.saveCostBigMs = if ($rend.saveCost) { $rend.saveCost.big.ms } else { $null }
    $b.heapMb = $rend.heapMb
    $b.typeset40Renders = $rend.typeset40Renders
    $b.frameP95 = if ($rend.frameStats) { $rend.frameStats.p95 } else { $null }
    $b.frameOver20 = if ($rend.frameStats) { $rend.frameStats.over20 } else { $null }
    $b.globalSearchHitMs = $rend.globalSearchHitMs
    $b.globalSearchMissMs = $rend.globalSearchMissMs
    $b.globalSearchFallbackMs = $rend.globalSearchFallbackMs
    $b.exportHtmlMs = $rend.exportHtmlMs
    $b.exportPdfHtmlMs = $rend.exportPdfHtmlMs
    $b.longMsgHighlightMs = $rend.longMsgHighlightMs
    $b.exportPdf200MsgsMs = $main.exportPdf200MsgsMs
  }
  if ($main) {
    $b.sessions = $main.sessionCount
    $b.backupFullMs = $main.backupFullMs
    $b.resizeLayoutMedianMs = $main.resizeLayoutMedianMs
    $b.resizeLayoutMaxMs = $main.resizeLayoutMaxMs
    $b.resizeLongTasks = $main.resizeLongTasks
  }
  # 预算判定：超阈值视为失败（阈值可用参数覆盖，便于自测「故意失败」）
  if ($b.ok) {
    if ($null -ne $b.bootMs -and $b.bootMs -gt $MaxBootMs) {
      $b.ok = $false
      $fail += "bench: boot=$($b.bootMs)ms 超预算 $MaxBootMs ms"
    }
    if ($null -ne $b.composerTypingMs -and $b.composerTypingMs -gt $MaxTypingMs) {
      $b.ok = $false
      $fail += "bench: 逐键=$($b.composerTypingMs)ms 超预算 $MaxTypingMs ms"
    }
    if ($null -ne $b.resizeLayoutMaxMs -and $b.resizeLayoutMaxMs -gt $MaxResizeLayoutMs) {
      $b.ok = $false
      $fail += "bench: 缩放布局=$($b.resizeLayoutMaxMs)ms 超预算 $MaxResizeLayoutMs ms"
    }
    if ($null -ne $b.globalSearchFallbackMs -and $b.globalSearchFallbackMs -gt $MaxGlobalSearchMs) {
      $b.ok = $false
      $fail += "bench: 全局搜索回退=$($b.globalSearchFallbackMs)ms 超预算 $MaxGlobalSearchMs ms"
    }
    if ($null -ne $b.exportHtmlMs -and $b.exportHtmlMs -gt $MaxExportHtmlMs) {
      $b.ok = $false
      $fail += "bench: 大会话 HTML 生成=$($b.exportHtmlMs)ms 超预算 $MaxExportHtmlMs ms"
    }
    if ($null -ne $b.longMsgHighlightMs -and $b.longMsgHighlightMs -gt $MaxLongHighlightMs) {
      $b.ok = $false
      $fail += "bench: 1MB 消息高亮=$($b.longMsgHighlightMs)ms 超预算 $MaxLongHighlightMs ms"
    }
    if ($null -ne $b.exportPdf200MsgsMs -and $b.exportPdf200MsgsMs -gt $MaxPdf200MsgsMs) {
      $b.ok = $false
      $fail += "bench: PDF 200 条=$($b.exportPdf200MsgsMs)ms 超预算 $MaxPdf200MsgsMs ms"
    }
  }
  if (-not $b.parsed) { $fail += 'bench: 缺少 renderer/main 汇总行' }
  $report.phases.bench = $b
  Write-Host ("  bench  : boot={0}ms layout={1}ms typing={2}ms 窗口={3}ms 设置={4}ms 保存2.3MB={5}ms 缩放={6}/{7}ms 搜索={8}/{9}/{10}ms heap={11}MB p95={12}ms" -f `
      $b.bootMs, $b.initialLayoutMs, $b.composerTypingMs, $b.threadWindowMs, $b.cfgOpenMs, $b.saveCostBigMs, $b.resizeLayoutMedianMs, $b.resizeLayoutMaxMs, $b.globalSearchHitMs, $b.globalSearchMissMs, $b.globalSearchFallbackMs, $b.heapMb, $b.frameP95) `
    -ForegroundColor $(if ($b.ok) { 'Green' } else { 'Red' })
}

# ---------------- idle ----------------
if ($Only -contains 'idle') {
  $r = Invoke-Qcode 'idle' @('--idle', "--idle-secs=$IdleSecs") 'ud-idle'
  $o = Get-JsonLine $r.log '^\[idle\] '
  $i = [ordered]@{ ok = [bool]$o; secs = $r.secs }
  if ($o) {
    $i.mainAvg = $o.mainAvg
    $i.rendererAvg = $o.rendererAvg
    $i.rendererMax = $o.rendererMax
    $i.raf = $o.rafDuringIdle
    $i.ok = ($o.mainAvg -le 1.5 -and $o.rendererAvg -le $MaxIdleRenderer)
    if (-not $i.ok) { $fail += ('idle: renderer=' + $o.rendererAvg + '% 超预算 ' + $MaxIdleRenderer + '%') }
  }
  if (-not $i.ok) { $fail += 'idle: 缺少汇总或空闲 CPU 超阈' }
  $report.phases.idle = $i
  Write-Host ("  idle   : main={0}% renderer={1}%（峰值 {2}%）raf={3}" -f $i.mainAvg, $i.rendererAvg, $i.rendererMax, $i.raf) `
    -ForegroundColor $(if ($i.ok) { 'Green' } else { 'Red' })
}

# ---------------- e2e（可选） ----------------
if ($WithE2E -or ($Only -contains 'e2e')) {
  $r = Invoke-Qcode 'e2e' @('--e2e', '--e2e-turns=2') 'ud-e2e'
  $o = Get-JsonLine $r.log '^\[e2e\] '
  $e = [ordered]@{ ok = [bool]($o -and $o.ok); secs = $r.secs }
  if ($o) {
    $e.turns = @($o.turns | ForEach-Object { $_.text })
    $e.ms = $o.ms
    $e.errors = @($o.errors).Count
  }
  if (-not $e.ok) { $fail += 'e2e: 未通过（需要网络与模型额度）' }
  $report.phases.e2e = $e
  Write-Host ("  e2e    : ok={0} turns={1} errors={2}" -f $e.ok, ($e.turns -join '/'), $e.errors) `
    -ForegroundColor $(if ($e.ok) { 'Green' } else { 'Red' })
}

# ---------------- installed（装机态：版本 + probe + smoke） ----------------
if ($Only -contains 'installed') {
  $exe = Join-Path $InstallDir 'Qcode.exe'
  $ins = [ordered]@{ ok = $false; installDir = $InstallDir }
  if (-not (Test-Path $exe)) {
    $fail += "installed: 找不到 $exe"
  } else {
    $ins.version = (Get-Item $exe).VersionInfo.ProductVersion
    $pkgVersion = ''
    try { $pkgVersion = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version } catch { $pkgVersion = '' }
    $ins.sourceVersion = $pkgVersion
    if ($pkgVersion -and -not ($ins.version -like "$pkgVersion*")) {
      $fail += "installed: 装机版 $($ins.version) 与源码 $pkgVersion 不一致"
      $ins.versionMatch = $false
    } else {
      $ins.versionMatch = $true
    }
    $ud = Join-Path $OutDir 'ud-installed'
    New-Item -ItemType Directory -Path $ud -Force | Out-Null
    Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
    $prevUd = $env:QCODE_USER_DATA
    $env:QCODE_USER_DATA = $ud
    $probeLog = Join-Path $OutDir 'installed-probe.log'
    $smokeLog = Join-Path $OutDir 'installed-smoke.log'
    try {
      cmd /c "`"$exe`" --probe > `"$probeLog`" 2>&1" | Out-Null
      cmd /c "`"$exe`" --smoke > `"$smokeLog`" 2>&1" | Out-Null
    } finally {
      $env:QCODE_USER_DATA = $prevUd
    }
    $pLine = Select-String -Path $probeLog -Pattern '\[probe\]' | Select-Object -Last 1
    if (-not $pLine) {
      $fail += 'installed: --probe 无输出'
    } else {
      $p = ($pLine.Line -replace '^\[probe\] ', '') | ConvertFrom-Json
      $ins.kernelOk = $p.kernel.ok
      $ins.kernelMode = $p.kernel.launch.mode
      $ins.inputReady = $p.dom.inputReady
      $ins.guideShown = $p.dom.guideShown
      if (-not $ins.inputReady) { $fail += 'installed: 界面未就绪' }
    }
    $sLine = Select-String -Path $smokeLog -Pattern '\[smoke\] features:' | Select-Object -Last 1
    if (-not $sLine) {
      $fail += 'installed: 冒烟无 features 行'
    } else {
      $o2 = ($sLine.Line -replace '^.*\[smoke\] features: ', '') | ConvertFrom-Json
      $bools2 = @($o2.PSObject.Properties | Where-Object { $_.Value -is [bool] })
      $falses2 = @($bools2 | Where-Object { -not $_.Value })
      $ins.smokeKeys = @($o2.PSObject.Properties).Count
      $ins.smokeBool = $bools2.Count
      $ins.smokeFalse = $falses2.Count
      if ($falses2.Count -gt 0) { $fail += ('installed: 冒烟失败项 ' + (($falses2 | ForEach-Object { $_.Name }) -join ',')) }
      $ins.done = [bool](Select-String -Path $smokeLog -Pattern '\[smoke\] done' -Quiet)
      if (-not $ins.done) { $fail += 'installed: 冒烟未走完' }
    }
    $ins.ok = ($ins.versionMatch -and $ins.inputReady -and $ins.smokeFalse -eq 0 -and $ins.done)
  }
  $report.phases.installed = $ins
  Write-Host ("  installed: ver={0}（源码 {1}）kernel={2}({3}) smoke={4}/{5}/false {6}" -f `
      $ins.version, $ins.sourceVersion, $ins.kernelOk, $ins.kernelMode, $ins.smokeKeys, $ins.smokeBool, $ins.smokeFalse) `
    -ForegroundColor $(if ($ins.ok) { 'Green' } else { 'Red' })
}

# ---------------- 汇总 ----------------
if ($report.phases.Keys.Count -eq 0) { $fail += '没有运行任何阶段（检查 -Only 参数）' }
$report.ok = ($fail.Count -eq 0)
$jsonPath = Join-Path $OutDir 'audit.json'
$report | ConvertTo-Json -Depth 6 | Set-Content -Path $jsonPath -Encoding utf8

Write-Host ''
if ($report.ok) {
  Write-Host "复核通过 ✅  （报告：$jsonPath）" -ForegroundColor Green
} else {
  Write-Host "复核失败 ❌" -ForegroundColor Red
  $fail | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
  Write-Host "  报告：$jsonPath"
}

if (-not $Keep -and $report.ok) {
  # 成功时清掉临时 userData，保留日志与报告
  Get-ChildItem $OutDir -Directory -Filter 'ud-*' -ErrorAction SilentlyContinue |
    ForEach-Object { Remove-Item $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }
}

exit ($(if ($report.ok) { 0 } else { 1 }))
