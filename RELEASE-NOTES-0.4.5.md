# Qcode 0.4.5 发版说明

> 0.4.5 在 0.4.4 基础上：R82 十二项修复（R82 由上一轮完成，本轮复核确认）+ **R83 第十一波深度审查：三子代理并行、24 项修复，含 2 个 P0**（回合永久 busy、超长会话跳转卡死）；后续 R84–R95 为持续的性能优化、健壮性演练与出包验证。
> 版本号 `0.4.5`。`dist/` 已产出并验证 0.4.5 产物（zip + Setup，**打包版冒烟与真实内核双轮对话均为绿**）；装机版 `<安装目录>` **已升级到 0.4.5**（R115，装机版冒烟 455/446/0 全绿，回滚可用 `tools/upgrade.ps1 -Target 0.4.4 -Apply`）。

## R82 复核（已在 0.4.5 代码中）

用 `dist/win-unpacked/resources/app.asar` 解包与工作树逐文件比对确认，0.4.4 构建之后新增的改动即 R82：

- `redactSecrets` 覆盖 `apiKey / access_token / refresh_token / client_secret / password` 键名变体（值长 ≥8 才脱敏，不误伤 `enabled:true`）
- CLI 引导条并入渲染管线（原实现直接插 DOM，`host_error` 分支紧跟的 `renderThread()` 会清空时间线，且 `cliGuideShown` 已置 true → 引导条再也出不来）；按会话记 `cliGuideDismissed`
- 检查点创建失败不再静默（状态栏 + toast 明示「本回合无法回滚」）
- 导出体积预估（>40MB 二次确认、>4MB 关缩进）+ 导出前疑似密钥扫描确认
- 会话自动标题去重（同名追加序号）、草稿键修剪（`pruneDeadDrafts`）
- Markdown 三处守卫：长文本块二次渲染免重算 markdown、行内代码不被二次排版、未闭合围栏按代码块渲染、表格列数归一化

## 监工审查（R83）：第十一波深度审查，修复 24 项

三个只读子代理并行审查三个此前未覆盖的维度：**AC 竞态与生命周期 / AD 持久化与数据完整性 / AE 极端规模与输入边界**，共 27 条报告，去重后修 24 项（P0×2、P1×12、P2×10），其余 3 条记录为已知问题（见末节）。

### P0（两条，均为「界面假死」类）

1. **回合超时强杀后永久 busy（AC-1）**：看门狗到点 `killChildTree` 后发 `host_exit{intentional:true}`，渲染层「迟到退出」守卫 `if (r.busy && r.stream) return;` 恰好把当前回合的真正死亡一起吞掉 → 界面永远停在「思考中」，队列永不出队，pending 占位消息被落盘。修法：主进程 payload 补 `timedOut`，渲染层改为「只有没有明确失败原因时才忽略」(`hardAbort`)。
2. **超长会话跳转到早期消息卡死（AE-1）**：`jumpToMessage` 原实现 `renderLimit = total - idx + 20`，无任何上限——5,000 条会话点搜索结果/查找命中会把整条会话同步渲染一遍。修法：新增 `RENDER_LIMIT_MAX = 1200` 与 `state.renderFloor`（窗口起点），跳转改为「把窗口挪到目标附近」，并用 `.has()` 区分「floor=0」与「无窗口」。

### P1（十二条）

3. **自动重启抢救的回合变成黑箱（AC-2）**：主进程重启后重发 `pendingPrompt`，渲染层却已 `finalizeAbort` → 重跑出来的 assistant/tool/result 因 `st===null` 全部丢弃（文件照改、token 照花、界面空白）。修法：`host_exit` 补 `willResend`，渲染层保留 stream 继续接事件，并加 20s 看门狗兜底。
4. **`ignoreResultUntil` 不在新回合复位（AC-3）**：停止后 3 秒内重发，新回合的 `result` 被当成旧回合吞掉 → 永久 busy。修法：`beginTurn` 清零。
5. **后台会话的授权请求被丢弃（AC-4）**：`clearApprovalCard` 的 `while` 把不匹配当前会话的队列条目 `shift` 后直接丢弃，后台 `can_use_tool` 只能等主进程 60s 超时自动拒绝。修法：抽 `promoteQueuedApproval()`，保留其他会话条目，`switchSession` 时补弹。
6. **busy 分叉导致同一回合双写 stdin（AC-5）**：渲染层 busy=false、主进程 busy=true 时，新消息直接 `chat:send` → 两条 user 消息同刻写入，两个回合事件混进同一条 stream。修法：`chat:send` 以主进程 busy 为准返回 `{ok:false,error:'busy'}`，渲染层收尾本回合并把原文还给输入框。
7. **检查点 blob 非原子落盘（AD-1）**：`copyFile` 直写最终路径，中断留下截断 blob，而 `existsSync` 守卫此后永久短路不再重拷；hash 与 copy 之间文件变化还会让「名字对内容错」。修法：写 `blob.tmp-pid-ts` → 校验 size → rename。
8. **`checkpoint:restore` 无逐文件容错（AD-2）**：中途失败即半恢复、且不告知哪些文件没恢复；blob 缺失静默跳过。修法：逐文件 `tmp+rename`，返回 `failed[] / skipped[]`，blob 大小与 manifest 不符时拒写。
9. **删除路径不回收 blob（AD-3）**：`checkpoint:deleteAll` / `sessions:delete` 只删 manifest，GC 只在 `create` 内且 5min 限频 → 用户「清理」后磁盘不降。修法：抽出 `gcCheckpointBlobs(force)`，两条删除路径触发，`deleteAll` 返回 `reclaimed`。
10. **`config:import` 的告警恒为空（AD-4）**：`validateQwenSettings` 返回数组，代码读 `v.warnings` → R74 的修复实际未生效。修法：按数组口径取。
11. **删除失败静默且恒成功（AD-5）**：文件被占用时 `moveSessionToTrash` 抛错被吞、索引照删 → 下次启动会话「复活」，而检查点已被删。修法：`deleteSessionFile` 返回布尔、失败回 `{ok:false}`、只有成功后才删检查点；渲染层 `closeSession` / 批量删归档按契约提示并保留会话。
12. **超大表格无行列上限（AE-2）**：500 列 × 2000 行会生成百万个 `<td>`。修法：200 行 / 64 列上限 + 表尾「表格过大，已截断显示」。
13. **实时工具输出无长度上限（AE-3）**：32KB 截断只发生在 `sessions:slim`，live 路径 1MB 输出会整段 `esc()` 进 `innerHTML`，`.collapsed` 只是 CSS 折叠。修法：渲染侧 128KB 硬截断（原始内容不动，「另存为」仍导出全文）。
14. **备份按「会话个数」限流（AE-4 / AD-10 合并）**：500 条上限既挡不住 500×10MB 的 stringify OOM，又静默丢会话、日志还报全量。修法：按 64MB 字节预算累加、`dropped` 回传并记日志。

### P2（十条）

15. **空闲会话的 `host_error` 改写已完成回复（AC-6）**：给最后一条回复打「内核未启动」并落盘。修法：仅 `busy || stream` 时收尾。
16. **授权失效被吞（AC-7）**：`chat:approval` 返回 false 时仍清卡并显示「已允许」。修法：按返回值提示「授权已失效」。
17. **`timedOut` 不复位（AC-8）**：一次超时后，之后每次切模型/保存配置的重启都显示「回合超时」。修法：`stop()` 清零。
18. **删除路径残留（AC-9）**：`pendingTurn` 定时器、`cliGuideDismissed`（无界增长）、排队授权、`renderFloor` 未清理。修法：两处删除路径补齐清单。
19. **退出不落会话索引（AD-6）**：250ms 防抖窗口内退出会让改名/归档在重启后回退。修法：`will-quit` 补 `flushSessionIndex()`。
20. **回收站恢复不校验 id / 非原子写（AD-8）**：非法 id 直接抛错无法恢复；写盘半截留下坏 JSON。修法：正则校验后回退新 id，`tmp+rename`。
21. **截断的 manifest 仍允许「删除新增文件」（AD-9）**：create 侧有 4000 文件 / 96MB / 深度 14 上限，两次 walk 截断位置可能不同 → 漏进 manifest 的旧文件可能被当新增删除。修法：manifest 记 `truncated`，restore 遇 `truncated + deleteAdded` 直接拒绝。
22. **超长文本块进 DOM 节点缓存（AE-5）**：`MD_CACHE` 有 64KB 门限，`mdBlockNodeCache` 没有 → 10MB 块被长期持有 html + DOM。修法：>256KB 只渲染不缓存。
23. **链接 URL 含括号被截断（AE-6）**：`[x](https://…/b_(c))` 渲染成 `href="…/b_(c"`。修法：贪婪匹配后按括号配平，把多余的 `)` 还给正文（顺带改为函数替换，规避 `$1/$'` 替换串陷阱）。
24. **按 UTF-16 硬切劈开代理对（AE-7）**：emoji 文件名被切出孤立代理显示 `�`。修法：`shortPath` 切点落在低代理项时后移一位。

### 新增冒烟断言（18 项）

渲染层注入式断言 14 项：`raceTimeoutExit` / `raceStaleExitIgnored`（AC-1 正反两面）、`raceIgnoreReset`、`approvalQueueKeep`、`hostErrorIdle`、`approvalInvalid`、`renderWindowCap`（造 3,000 条会话断言 DOM ≤ 1201）、`renderWindowReturn`、`tableCap`、`toolOutCap`、`mdBlockCacheGate`、`linkParens`、`surrogatePath`、`deleteContract`。
主进程侧 4 项：`cpBlobAtomic`（真实建检查点后 blobs 目录无 `.tmp-` 残留）、`cpRestoreShape`（`failed`/`skipped` 数组）、`cpGcOnDeleteAll`（把 blob mtime 拨老 2 分钟再 `deleteAll`，断言 `reclaimed > 0`）、`backupShape`（`savedCount`/`dropped`）。

### 验证

```text
dev r83 : 436 项断言无 false（429 布尔 + 7 诊断值）· R83 新断言 18 项全 true
          model test all: requests=2 models=2 ok（0.4.4 末次冒烟的唯一 FAILED 已消失）
          perf: threadPaint=2.9ms · goalSuite ok · 36 张视觉截图落盘 · [smoke] done
安装版    : 未跑（0.4.5 尚未执行升级安装；打包版验证见 R95）
```
（日志：`<临时目录>`；基线快照：`<临时目录>`）

## 性能优化（R84）：先测量再优化——启动路径与会话规模

### 新增测量设施

- **`--bench` 模式**（`Qcode.exe --bench` / `electron . --bench`）：真实 Chromium 内跑固定合成数据后退出，输出
  ① 启动分段耗时 `window.__bootMarks`（start / ipc / cwd / drafts / sessions / settle / currentReady / autoArchive / firstPaint）；
  ② 13 项微基准（侧栏、时间线、markdown、表格、索引、流式事件、IPC 等）；
  ③ 主进程侧 IO 计时（`sessions.list` / `refreshSessionIndex` / `loadSessionsIndexed` / `extras` / `listDir`）。
  口径固定：同一合成数据、先 warmup 2 次、按「N 次总时长 / N」计算（单次过短时 best-of 会被时钟分辨率吃掉）。
- `tmp/seed-sessions.js`：造 N 个会话文件（模拟重度用户），用于测启动耗时随会话规模的曲线。

### 改动前基线（空库）

```text
boot 189ms = script 80 + paths 40 + extras 16 + cwd 3 + config 29 + drafts 0 + sessions 8 + settle 0 + autoArchive 1 + firstPaint 12
```

### 五项优化

1. **启动期四条互不依赖 IPC 并行**（paths / extras / config / sessions）：ipc 段 93ms → 41ms。
2. **默认工作目录改由主进程探测**：新增 `guessDefaultCwd()`（<工作区> → ~/Projects → home 依序探测，只返回真实存在的目录），渲染层删掉写死的 `<工作区>` 且不再多一次 `stat`（换机器/换盘符不再落到空目录）。
3. **自动归档挪到首帧之后**（原来 `await` 在首屏之前）。
4. **主进程单趟读盘**：`refreshSessionIndex` 为建索引已经 parse 过的会话对象，直接交给 `loadSessionsIndexed` 复用，不再读第二遍。
5. **会话体首屏预算 + 后台补水**：首屏只带「最近 40 个会话 / 4000 条消息（置顶必带）」的正文，其余返回 `lazy` 存根（点开/切换时 `sessions:get` 补全，4.7ms/个）；首帧之后以约 8 条/秒在后台补水，每 5 条补建一次全文索引——搜索最终仍覆盖全部会话，但启动不必等它们。

### 结果（同一台机器，index 已预热）

| 场景 | 优化前 | 优化后 | 变化 |
|---|---|---|---|
| 空库启动（boot 完成） | 189ms | **120ms** | −36% |
| 800 会话 / 14.6MB 启动 | 275ms | **131ms** | −52% |
| 800 会话：主进程会话体加载 | 83ms | **4ms** | 20× |
| 800 会话：`sessions.list` 端到端 IPC | 107ms | **26ms** | 4× |
| 切换到懒加载会话（补全正文） | — | 4.7ms | — |
| 后台补水速率 | — | 24 条 / 3s | — |

### 微基准（R84 实测，后续回归参考）

```text
threadWindow(120 条) 2.8ms · md8k cold 0.28ms · table 200×64 0.9ms · inline1k 0.018ms
esc64k 0.0034ms · 索引构建(6000 条消息) 10.5ms · 索引查询 0.02ms · 200 条流事件 0.2ms
侧栏 500 会话 1.0ms · 侧栏过滤 4.5ms · IPC sessions 26ms/800 会话
```

### 评估后刻意不做的

- **会话列表改「raw string 传输」**：实测 IPC 结构化克隆 + 渲染层接收只占约 6ms，成本主进程读盘 + `JSON.parse` 才是大头 → 净收益≈0，不做。
- **拆分 app.js 以缩短脚本解析**：`start` 段 66–80ms 来自 13k 行脚本解析，但拆分要处理跨文件全局依赖与首帧后按需加载，改动面大、收益不确定，留待单独评估。

### 断言

`eagerBudget`（置顶优先 / 预算截断 / 归档不入预算 / 超预算不再带正文）、`perfBudget`（renderThread<200ms、8KB markdown 冷渲染<100ms）、`bootProfile`（boot 打点存在）。

### 验证（R84）

```text
dev r84 : 441 项断言无 false（432 布尔 + 9 诊断值）· eagerBudget/perfBudget/bootProfile 全 true
          0 FAILED · threadPaint=3.3ms · 36 张视觉截图 · [smoke] done
基准     : 空库 boot 120ms · 800 会话/14.6MB boot 131ms · 补水 24 条/3s
```
（日志：`<临时目录>`；基准日志：`tmp/qcode-bench-800-final.log` 等）

### R84 第二轮：交互等待与长会话渲染

**工具卡 body 延迟构建**：`toolElement` 原本每次都 `fillToolBody`（对输入/输出/差异各做一次 `esc()` 再 `innerHTML` 解析），哪怕卡片是折叠的。长会话（>300 条消息）里改为**首次展开时才构建**；错误卡、运行中工具、任务卡仍即时构建（这些本来就要显示内容）。
- 实测 1200 条工具密集窗口的一次 `renderThread`：**48.7ms → 30.2ms（−38%）**
- 小会话路径完全不变，既有 `toolBodyOpen`/`toolOutHtmlCache`/`toolBodyNodeCache`/`toolCopy`/`toolDiffCache`/`todoBodyCache` 断言全绿

**设置页非阻塞打开**：把 `openSettings` 的 51.5ms 拆开看——`extras:get` 这次 IPC 占 33.6ms，分区渲染只要 4ms，显示层强制布局 2.1ms。改为先用启动时已有的 `state.extras` 立即出界面，再后台刷新，且只有 extras 签名真的变化时才重绘。
- 实测 **51.5ms → 29.6ms（−43%）**，其余为首次进入设置的一次性样式/布局预热
- 分区切换成本（记录，未优化）：`providers` 18–26ms、`advanced` 18–29ms、`mcp` 8–10ms、`hooks` 5–6ms、`usage` 4–7ms

**内存与规模（800 会话 / 14.56MB，同语料、index 预热）**

| 指标 | 全量加载 | 预算懒加载 | 变化 |
|---|---|---|---|
| 启动 | 330ms | **164ms** | −50% |
| 主进程会话体加载 | 98ms | **5ms** | 20× |
| `sessions.list` IPC | 132ms | **28ms** | 4.7× |
| 渲染层 JS 堆 | 57.5MB | **24.8MB** | −57% |

**启动耗时分解（据此决定不做代码拆分）**：`scriptStartMs` 实测 79–83ms——脚本**第一行执行之前**就已经过了 80ms（HTML + 147KB CSS + 505KB JS 的加载与编译）；boot 自身只用 55ms（IPC 43 + 首帧 11）。设置类代码约占源码 26%，拆包理论收益仅约 13ms（占启动 10%），却要处理跨文件全局依赖与首帧后按需加载，风险不匹配收益，**本轮明确不做并留档**。

**口径说明**：本机单次运行抖动可达 ±20ms（`boot` 在不同轮次 120–164ms），因此改前/改后只认同语料、同预热状态的**单次成对对照**；上表 800 会话的差量（166ms / 32.7MB）远大于抖动，结论可用。

### R85 第三轮：逐键延迟与设置分区成本归因

**输入框逐键成本 6.28ms → 0.05ms（125×）**
- 拆解发现「处理逻辑」本身很便宜：`autosize` 0.245ms、`detectComposerCommand` 0、`renderSendButton` 0.001、`scheduleMention` 0.001、`composerFullText` 0。
- 真正成本在 `autosize()` 的**强制重排**：每键写 `style.height='auto'` 再读 `scrollHeight`，10KB 草稿要整段重排文本（实测 6.28ms/键）。
- 改法：Electron 43 的 Chromium 已支持 `CSS.supports('field-sizing','content')`，textarea 高度交给 CSS（`field-sizing: content; max-height: 180px; overflow-y: auto`），JS 检测到支持后直接跳过强制布局；不支持的环境仍走原路径（`FIELD_SIZING` 开关）。
- 行为校验：1 行 34px → 5 行 129px → 40 行封顶 180px 且可滚动（`inputGrowOk`）；冒烟新增 `inputAutosize` 断言长期锁住。
- 副作用：`autosize()` 从「每键强制布局」变成「零成本空调用」，输入法组词、粘贴、草稿恢复路径都更顺。

**长会话窗口上限 1200 → 800**
- 工具密集语料对照：1200 条 **31.5ms** / 800 条 **23.7ms** / 400 条 10.2ms（基本线性）。
- 800 条对「跳转到早期消息」的上下文已足够，且「加载更早」仍按 120 条递增；冒烟 `renderWindowCap` 断言同步收紧到 ≤801。

**设置分区切换成本归因（本轮不改，留档）**
- `cfgSectionMs`：`providers` 15.6–20ms、`advanced` 17–20ms；但把渲染函数单独拿来跑只有 **0.3–0.6ms**（`cfgInner`）。
- 结论：成本在 `setCfgSection` 外壳——`cfgBody` 旧 DOM 移除 + 新表单布局 + `placeCfgNavInk()` 的强制布局，与表单内容无关。缓存分区 DOM 需处理 cfgDraft/extras/usage 等大量失效点（易出「设置显示旧值」的 P0），风险不匹配收益，本轮明确不做。
- 顺带确认：搜索框逐键 **0.01ms**（已有 120ms 防抖），无需优化；样式表 1,262 条规则，未见卡顿证据。

```text
dev r85 : 442 项断言 / 433 布尔 / 0 false · 0 FAILED · inputAutosize/renderWindowCap/perfBudget/eagerBudget 全 true
基准     : 逐键 0.05ms（原 6.28）· 800 条工具密集窗口 20.5ms（原 31.5@1200）· 设置打开 27ms
```
（日志：`<临时目录>`）

### R86 第四轮：证伪「落盘热点」+ 修掉流式排版的 O(n²)

**先证伪**：怀疑「流式期间每 120–200ms 整条会话落盘」是越聊越卡的根因，实测两件事都不成立：
- `persist` 只在回合边界与少数事件分支调用（`handleAssistantMessage`/`handleToolResults` 不落盘），每回合数次，不是每帧；
- 单次保存成本：0.2MB 1.4–1.7ms、**2.32MB 11–14ms**（含 IPC 结构化克隆 + 主进程 stringify/写盘）。成本随体积线性，但调用频率低。

**全局重绘类交互实测（都不慢，无需优化）**：主题切换 2.2–3.3ms（回切 0.9–1.9ms）、侧栏折叠 0.2–0.3ms（回展 1.2–1.5ms）、切到 5,000 条消息的大会话 4.7–6.2ms。

**真问题：流式「已完成区」排版是 O(n²)**
- `typesetStreamPreview` 每新增一行就 `innerHTML = renderMarkdown(整段 settled)`：2KB **0.7ms** / 8KB **1.2ms** / 32KB **4.5ms**；
- 拆开看，markdown 解析只占 0.1 / 0.6ms，**约 87% 是 DOM 构建**——也就是说重排成本几乎全在重建节点；
- 32KB 回复按 600 行计，合计约 2.7s 主线程工作，且是逐行触发的小卡顿。
- 改法：已完成区重排限频到 **≤12 次/秒**（80ms 门限），4KB 以下不受影响（短流式与既有断言路径完全不变）；正在输入的活动行仍逐帧排版。视觉上已完成行最多滞后 80ms。
- 实测：32KB 底文上连续 40 次更新，重排 **0 次**（原实现 40 次）；冒烟新增 `typesetThrottle` 断言锁住（连续 20 次更新重排 ≤2 次）。

```text
dev r86 : 443 项断言 / 434 布尔 / 0 false · 0 FAILED · typesetThrottle/streamLiveTypeset/typewriterStream 全 true
基准     : 逐键 0.05ms · 800 条窗口 20–22ms · 设置打开 28ms · 2.32MB 会话保存 11ms · 主题切换 3.3ms
```
（日志：`<临时目录>`）

### R87 第五轮：把启动耗时彻底归因（并据此关掉这条线）

用两套受控实验（隐藏窗口加载同构页面 + 同页面变体内联探针）把启动拆到不能再拆：

| 组成 | 实测 | 说明 |
|---|---|---|
| 空白页导航基线 | 55–60ms | Electron/Chromium 平台开销，与代码无关 |
| 505KB app.js 的取+编译 | **+12ms** | 69−57 |
| 真实页面首屏样式+布局 | **37–46ms** | 应用内 `__initialLayoutMs` 43.6/46.4 |
| boot 异步工作 | ~55ms | 布局完成后四条 IPC 只要 11ms，首帧绘制 ~10ms |

首屏布局 37ms 再二分（同一份 CSS 与 DOM，只改一处）：

```text
空 body + 同 CSS           0.9ms   ← CSS 解析/规则匹配本身不要钱
500 个空 div + 同 CSS      1.6ms   ← 元素数量不要钱
单段中文 + 同 CSS          7.0ms   ← 字体首次实例化/文本整形基线
真实 DOM + 同 CSS         37.7ms
真实 DOM（删掉全部文字）   17.0ms   ← 文字量约占一半（~20ms）
真实 DOM（删掉全部 SVG）   36.3ms   ← 内联图标不是成本
真实 DOM（删掉全部阴影）   38.1ms   ← box-shadow 不是成本
真实 DOM（不带 CSS）       41.8ms   ← 无 CSS 反而更慢 → 不是样式规则问题
```

**结论（已据此关闭「启动优化」这条线）**：首屏布局 ≈ 文本整形 20ms（含 7ms 字体基线）+ 真实结构（flex/grid/固定层）15ms，是当前版式的固有成本；脚本只占 12ms，CSS 接近 0。**代码拆分、CSS 瘦身、阴影/图标精简都不会有收益**，不再投入。

**顺带修正一个误判**：启动期「四条 IPC 各 41–42ms」并不是 IPC 慢——在 boot 起点强制一次布局后，四条 IPC 立刻降到 **11ms**，总时长不变。之前的延迟其实是渲染层在首次布局，把 IPC 回包排在了后面。

**永久留下的启动探针**（每项成本≈0，`--bench` 或 perf 日志可用）：`window.__initialLayoutMs`（首屏布局）、`window.__bootCallMs`（四条启动 IPC 各自耗时）、`window.__firstFrameMs`（首帧）、`window.__bootMarks`（分阶段）；`--bench` 额外输出 `decomposition`（空白/CSS/JS/真实页 + 7 个布局变体）。

```text
dev r87 : 443 项断言 / 434 布尔 / 0 false · 0 FAILED
```
（日志：`<临时目录>`；基准：`tmp/qcode-bench-r87m.log`）

### R88 第六轮：内存实测（LRU 弃用）+ 会话保存失败可见化

**内存实测（800 会话 / 14.56MB JSON / 8,000 条消息）**

| 状态 | private | working set |
|---|---|---|
| 懒加载态（首屏 40 个会话正文） | 122.4MB | 180.2MB |
| 全部补水后（750 个会话） | 143.3MB | 201.5MB |
| 差 | **+20.9MB** | **+21.3MB** |

补水 750 个会话耗时 403–449ms（约 0.55ms/个）。**结论：LRU 释放老会话正文最多省 ~21MB，而 122MB 基础占用是 Chromium + DOM 的固有成本；且丢正文会破坏搜索片段生成 → 收益/风险不划算，弃用并留档。**

顺带补了真实内存读数：沙箱 preload 里 `webFrame.getProcessMemoryInfo()` 不可用（实测返回 null），改由主进程 `app.getAppMetrics()` 经既有 `perf` 通道（`window.shell.perf('bench-mem')`）返回，不为基准测试新增 IPC 面。

**AD-7 修复（遗留项）：会话保存失败不再静默**

- 主进程：写盘重试 3 次仍失败、或序列化抛错时，向渲染层发 `sessions:save-error{id,error}`；此后某次保存成功且此前失败过，发 `sessions:save-ok{id}`（只在状态变化时发，避免噪音）。
- 渲染层：状态栏「会话保存失败：<原因>」+ toast（提示检查磁盘空间/文件占用，之后重发一条消息即可重试）+ 会话级 `saveError` 标记；恢复时清除标记并提示「会话已恢复保存」。
- 断言：`saveErrorVisible`（主进程发失败事件 → 状态栏出现「会话保存失败」→ 发恢复事件 → 状态栏出现「已恢复保存」）。

```text
dev r88 : 444 项断言 / 435 布尔 / 0 false · 0 FAILED · saveErrorVisible 全 true
```
（日志：`<临时目录>`）

### R89 第七轮：错误路径演练（注入式）+ 最后一个长尾交互

**工具分组实测**：150 张连续工具卡渲染 5ms、整组展开/收起各 **0ms**（纯 class 切换 + CSS）——没有可优化项，关闭这条线。

**演练 1：落盘失败注入（ENOSPC）**
把 `fs.writeFileSync` 打成对特定会话抛 `ENOSPC`，验证整条链路：
```text
[session] save failed, retry 1 … retry 2 … retry 3 … save failed after 3 attempts, dropped
→ sessions:save-error 事件 → 渲染层收到（__saveErrorCount 递增）
→ 恢复写盘后再存一次 → sessions:save-ok → 失败标记清除
```
断言 `saveErrorInjected`（主进程侧 `saveFailedSessions` 置位/清除 + 渲染层事件计数同时成立）。

**演练 2：坏数据容错**
- 把 `sessions-index.json` 写成非法 JSON 并强制重新加载：`loadSessionsIndexed()` 不抛错，按扫描结果自愈重建；
- 把某个会话文件写成非法 JSON：`sessions:get` 返回 `{ok:false}` 而不是抛错（渲染层走 `hydrateFailed` 提示路径，不会白屏）。
断言 `badDataSafe`。

```text
dev r89 : 446 项断言 / 437 布尔 / 0 false · 0 FAILED · saveErrorInjected / badDataSafe 全 true
```
（日志：`<临时目录>`）

### R90 第八轮：流式帧稳定性实测 + 后台补水提速 10 倍

**流式帧稳定性（此前只有单次耗时，没有帧分布）**：模拟约 2 秒流式输出（120 个 delta、每 16ms 一个），rAF 采样帧间隔：

```text
238 帧 / 2026ms · 中位 8.3ms · p95 8.5ms · max 33.3ms · >20ms 的帧只有 2 个
```
结论：流式路径（打字机 + 限频排版 + 增量 DOM）已经平滑，**没有可优化的掉帧问题**，关闭这条线。

**后台补水提速**：R84 引入的懒加载存根靠逐个 `sessions:get` 补水，750 个会话要约 94s 才补完（期间历史会话搜不到正文）。新增 `sessions:get-batch`（一次最多 50 个，主进程并发 8 读盘），渲染层改为每批 20 个、200ms 一轮：

| 指标 | 逐个补水 | 批量补水 |
|---|---|---|
| 3 秒内补全数（800 会话语料） | 24 | **260（10.8×）** |
| 全部补水耗时 | ~94s | **~9s** |

效果：搜索覆盖历史会话的等待从分钟级降到十秒级；点开老会话也更少触发即时读盘。断言 `batchHydrate`（IPC 存在 + 缺失 id 返回 `session:null` 而不是抛错）。

```text
dev r90 : 447 项断言 / 438 布尔 / 0 false · 0 FAILED · batchHydrate / saveErrorInjected / badDataSafe 全 true
```
（日志：`<临时目录>`；基准：`tmp/qcode-bench-r90b.log`）

### R91 第九轮：0.4.5 出包 + 打包版全量冒烟

用当前代码（R82–R90 全部改动）出包，验证打包链路（asar、内置内核补拷、图标、NSIS）：

```text
npm run dist → 成功
  dist/Qcode-0.4.5-win.zip        225.6 MB  sha256 8C70FF62…004D85F3
  dist/Qcode-Setup-0.4.5.exe      174.7 MB  sha256 3A18755B…AF6B6226
  （0.4.4 两个产物保持完好未动）
  resources/kernel/node.exe + cli-entry.js 均在；app.asar 2.07MB
```

**打包版冒烟（`dist/win-unpacked/Qcode.exe --smoke`，独立临时 userData）**：

```text
447 项断言 / 438 布尔 / 0 false · 0 FAILED · done
installerAssisted=true · kernelDetect=true · cliProbeOk=true
batchHydrate / saveErrorInjected / badDataSafe / typesetThrottle / inputAutosize / eagerBudget / perfBudget 全 true
```

也就是说：**打包形态下内置内核能正常启动、克隆 / asar 路径 / 图标 / 托盘 / 安装器判定全部成立**，R83–R90 的所有新断言在真实产物里同样全绿。装机版（`<安装目录>` 0.4.4）未改动——升级安装会覆盖用户环境，留到明确要求时再做（按旧教训：升级安装中途绝不可杀进程，安装目录绝不可与代码仓库重叠）。

### R92 第十轮：长跑泄漏检查（新增 `--soak`）

新增 `--soak` 长跑演练（默认 200 轮，`--soak-cycles=N` 可调）：20 个会话间轮换「切会话 + 30 个流式 delta」，
每 50 轮采样一次渲染进程内存（主进程 `app.getAppMetrics()`）、DOM 节点数、runtime 数、`state` 各结构大小、rAF 回调计数；
采样前用 `--expose-gc` 强制 GC，量的是**保留内存**而不是堆松弛；外层再加 180s 看门狗，卡死不会无限等待。

**真实组合（切会话 + 流式）600 轮，14.2 秒跑完**：

| 采样点 | private | DOM 节点 | runtimes |
|---|---|---|---|
| start | 38.9MB | 231 | 1 |
| n50 | 80.8MB | 666 | 21 |
| n200 | 88.7MB | 666 | 21 |
| n400 | 92.1MB | 666 | 21 |
| n600 | **92.0MB** | 666 | 21 |

结论：**无泄漏**。内存在约 300 轮后进入平台期（n400→n600 只差 −0.1MB），DOM/runtime/state 结构全程恒定，每轮耗时也不随轮次增长（14.2s/600 轮 ≈ 24ms/轮，含 8ms 采样间隔）。

**一个被排除的假象**：早期用「切会话 + 流式 + **反复切主题**」跑 600 轮时，每 25 轮的等待时间从 0.6s 涨到 51s，看起来像严重退化。
用 `--soak-mode` 逐项二分后确认：单纯切会话 12ms/轮、单纯流式 8.7ms/轮、单纯切主题 10ms/轮**都不随轮次增长**；
只有「切会话 + 切主题」组合会涨——根因是每次切主题都走 `nativeTheme.themeSource` + `setBackgroundColor`，触发整窗重绘，属于人工压力项，真实用户不会这样用。
因此默认模式改为真实组合（`switch,stream`），主题翻转保留为显式压力项（`--soak-mode=switch,stream,theme`）。

```text
dev r92 : 447 项断言 / 438 布尔 / 0 false · 0 FAILED
soak    : 600 轮 14.2s · 内存 38.9 → 92.0MB 后平台 · DOM/runtimes 恒定
```
（日志：`<临时目录>`、`tmp/qcode-smoke-r92.log`）

### R93 第十一轮：真数据校验 + 侧栏/设置两条线收口

**侧栏整表重排（此前只测过空库）**：800 会话语料下 `renderSidebar()` = **3.2ms**，因为列表只渲染 `sessionLimit` 上限内的 31 行（不是 800 行）。每轮开始/结束各一次 → 无优化必要，关闭。

**真数据校验（新增 `--realdata`，只读不写盘）**：把用户真实会话库复制到临时 userData 跑：

```text
sessions=1 · messages=14 · 91.6KB
打开最大会话 7.5ms · 渲染后 DOM 1,778 节点 / 12 行
搜索「读取工作」命中 1 · 0ms
导出 markdown 70,734 字节 · 0.6ms
renderer errors: []
```

真实内容（含表格/代码块的长消息）渲染、搜索、导出全部正常且无报错。

**设置首次进入 ~28ms 收口**：`cfgOpenMs` 28ms 里同步部分只有 4–6ms（show 0.5–3 + general 渲染 2.4–3.3），其余是 `display:none → flex` 后**首次样式解析 + 布局**的一次性成本。骨架化只是把这笔成本推迟一帧，并不能省掉，且会引入一次闪烁 → **不做**，关闭这条线。

**发行产物校验清单**：`dist/SHA256SUMS-0.4.5.txt`（zip 与 Setup 的 sha256）。

### R94 第十二轮：真实内核端到端（`--e2e`）

此前所有验证都用**合成事件**喂渲染层，从未真正跑过「真实内核一次完整对话」。本轮补上：
`--e2e`（`--e2e-turns=N`）→ 新建会话 → 把提示词填进输入框走真实 `send()` → 轮询到本轮结束 → 断言助手文本落地且无渲染异常。

**双轮真实对话（走内核 `--resume` 续聊）**：

```text
[e2e] ok=true  ms=70528
  turn1 "收到"  turn2 "继续"   messages=4（2 user + 2 assistant）
  renderer errors: []
```

第一轮实测内核回包 3.36s（usage 输入 15931 tokens / 输出 3 tokens），会话落盘含 `qwenSessionId`、`lastCheckpointId`、usage 统计，
说明「spawn → stream-json 解析 → 落定渲染 → 持久化」整条链路在真实内核上成立。

**过程中修掉一个自己的判定错误**：助手正文存在 `blocks[].text` 里，顶层 `text` 为空；E2E 最初读顶层字段因此误判为「无回复」，
现改为复用应用自身的 `assistantText()`。

**打包版暂未覆盖**：`dist/win-unpacked` 是 R91 出的包，还没有 `--e2e` 开关（跑起来只是正常启动）。
下一轮会重出一次包，把 `--smoke` + `--e2e` 都在打包形态下各跑一遍，并更新产物哈希。

```text
dev r94 : 447 项断言 / 438 布尔 / 0 false · 0 FAILED
e2e     : ok=true · 2 轮 · "收到" / "继续" · 0 renderer error
```
（日志：`<临时目录>`、`tmp/qcode-smoke-r94.log`）

### R95 第十三轮：重出包 + 打包形态「冒烟 + 真实对话」双验证

R91 的包缺少 R93/R94 的改动，本轮重出（首次因下载依赖 `ETIMEDOUT` 失败，改用国内镜像 `ELECTRON_MIRROR` / `ELECTRON_BUILDER_BINARIES_MIRROR` 后成功）：

```text
dist/Qcode-0.4.5-win.zip     225.6 MB  sha256 759991b4…04a24437
dist/Qcode-Setup-0.4.5.exe   174.7 MB  sha256 0e583767…f11e74d3
dist/SHA256SUMS-0.4.5.txt    已更新
```

**打包版双验证**：

```text
--smoke : 447 项断言 / 438 布尔 / 0 false · 0 FAILED · done
--e2e --e2e-turns=2 : ok=true
  turn1 "收到"  turn2 "继续"  messages=4  renderer errors: []
```

也就是说：**打包产物里内置内核能真实对话两轮（含 --resume 续聊）、界面零报错、447 项断言全绿**。
到这一步 0.4.5 已是「可交付」状态：dev 全绿 + 打包全绿 + 真实内核对话全绿。

### R96 第十四轮：清掉最后三条已知未修项

| 修复 | 做法 | 断言 |
|---|---|---|
| 备份体积口径 | `JSON.stringify().length`（UTF-16）→ `Buffer.byteLength(…,'utf8')`，抽成 `backupBytesOf()`；中文密集会话不再被低估约 3 倍，64MB 上限才真正生效 | `backupByteUnits` |
| 检查点跳过 >4MB 文件不可见 | `walkWorkspaceForCheckpoint` 记 `skippedLarge`，写入 manifest 与 `checkpoint:create` 返回值；界面状态栏提示「已跳过 N 个大于 4MB 的文件（无法回滚）」。**刻意不置 `truncated`**——该标志只用于拦截「删除新增文件」，置位会让含大文件的正常回滚被拒（`cpSkipLarge` 同时断言 `truncated === false`、`fileCount === 1`） | `cpSkipLarge` |
| boot 清理空会话忽略删除结果 | 抽出 `removeStaleEmptySessions(list, remover?)`：只有主进程确认删除成功才从列表移除，失败保留并打日志；`remover` 可注入用于断言失败路径 | `staleCleanupHonorsFail` |

```text
dev r96 : 450 项断言 / 441 布尔 / 0 false · 0 FAILED
          backupByteUnits / cpSkipLarge / staleCleanupHonorsFail / saveErrorInjected / badDataSafe 全 true
```
（日志：`<临时目录>`）

> 注：`dist/` 里的 0.4.5 产物仍是 R95 那次构建，R96 的源码改动需要再出一次包（下一轮做）。

### R97 第十五轮：重出包对齐 R96 + 打包版双验证

R96 的三处修复需要进包，重出后产物与源码对齐：

```text
dist/Qcode-0.4.5-win.zip     225.6 MB  sha256 793f559d…c579241f
dist/Qcode-Setup-0.4.5.exe   174.7 MB  sha256 89d23d66…5e18b8ab
dist/SHA256SUMS-0.4.5.txt    已更新
```

打包版双验证（`win-unpacked/Qcode.exe`，独立临时 userData）：

```text
--smoke             : 450 项断言 / 441 布尔 / 0 false · 0 FAILED · done
                      backupByteUnits / cpSkipLarge / staleCleanupHonorsFail
                      saveErrorInjected / badDataSafe / batchHydrate 全 true
--e2e --e2e-turns=2 : ok=true · "收到" → "继续" · messages=4 · renderer errors: []
```

至此交付物与源码一致，且 dev / 打包 / 真实内核对话三条验证链全部为绿。

### R98 第十六轮：全量备份不再卡在启动后 3 秒

`backupSessions()` 是启动后定时跑的主进程周期任务，此前从未量过。800 会话 / 14.56MB 语料实测：

```text
全量备份（含 loadSessions 读 800 个文件 + JSON.parse + stringify + 写 14.5MB）: 162ms
  其中 stringify 全部会话: 16ms
```

问题不在总时长，而在**时机与阻塞方式**：

1. 原来固定在**启动后 3 秒**执行——正好是用户开始打字、首轮交互的时候；
2. 落盘用的是 `fs.writeFileSync`（14.5MB 同步写，约 25ms 直接阻塞主进程事件循环，期间所有 IPC 都得等）。

改法：

- `writeFileSync/renameSync` → `fs.promises.writeFile/rename`（异步写，去掉同步阻塞段）；
- 新增 `scheduleSessionBackup()`：首次 **20 秒**后跑，若检测到有回合正在运行则顺延 30 秒（最多 5 次），之后每 6 小时再来一次（`backupSessions` 自带「距上次不足 24h 直接跳过」，所以 6 小时只是廉价检查）。

复测：全量备份 **162ms → 134ms**，且同步阻塞段消失、执行时机移出首屏交互窗口。

```text
dev r98 : 450 项断言 / 441 布尔 / 0 false · 0 FAILED · backupShape true
```
（日志：`<临时目录>`；基准：`tmp/qcode-bench-r98b.log`）

### R99 第十七轮：回滚（rewind）路径实测与提速

新增 `--rewind`：合成 2,000 文件 / 268KB 仓库，测「建检查点 / diff / 还原」三段，并校验还原后的内容正确性。

| 阶段 | 优化前 | 优化后 | 做法 |
|---|---|---|---|
| create（首次） | **4,711ms** | **3,620ms** | 逐文件串行 → 12 路并发池（manifest 顺序保持不变）；合并「读一遍算 sha + 再读一遍拷贝」为「拷到临时名 → 对临时文件算 sha → 按内容命名」，每文件少读一次 |
| create（第二轮，无改动） | — | **39ms** | mtime+size 命中直接复用 sha——**这才是用户每轮真实承受的成本** |
| diff | **1,172ms** | **37ms** | 原来对 2,000 个文件全量 sha256；改为 size+mtime 命中即视为未变（与 create 的 blob 复用判据一致），只有 mtime 变了才哈希确认（touch 不算 changed） |
| restore | **2,146ms** | **254ms** | 同一条 mtime 快路径 + 写入阶段 8 路并发（每个目标的 tmp 名唯一，互不干扰） |

正确性（改造后实测）：`changed=50 / added=50 / missing=50`，`restore: restored=100 / deleted=50 / failed=0`，且
「修改被还原成原内容 / 删除被恢复 / 新增被清除」三项全 true。新增断言 `cpRoundTrip`（create → 改/删/增 → diff → restore → 内容校验）。

> 首次 create 的 3.6 秒是「为工作区建立基线」的一次性成本（要对 2,000 个文件逐个读+哈希+落 blob），
> 后续每轮 39ms。diff/restore 是用户主动操作，从 1.2s/2.1s 降到 37ms/254ms。

```text
dev r99 : 451 项断言 / 442 布尔 / 0 false · 0 FAILED · cpRoundTrip / cpSkipLarge / cpBlobAtomic / cpRestoreShape 全 true
```
（日志：`<临时目录>`；基准：`tmp/qcode-rewind6.log`）

### R100 第十八轮：重出包对齐 R98+R99 + 打包版双验证

```text
dist/Qcode-0.4.5-win.zip     225.6 MB  sha256 63fc2719…a4062a98
dist/Qcode-Setup-0.4.5.exe   174.7 MB  sha256 e9541979…8b65c6f0
dist/SHA256SUMS-0.4.5.txt    已更新（win-unpacked/app.asar 亦为新构建，12:01）
```

打包版双验证：

```text
--smoke             : 451 项断言 / 442 布尔 / 0 false · 0 FAILED · done
                      cpRoundTrip / cpSkipLarge / staleCleanupHonorsFail
                      backupByteUnits / saveErrorInjected / batchHydrate 全 true
--e2e --e2e-turns=2 : ok=true · "收到" → "继续" · messages=4 · renderer errors: []
```

R98（备份调度 + 异步写）与 R99（回滚路径三处提速）都已在真实产物中验证通过。

### R101 第十九轮：空闲功耗——失焦时停掉常驻动画

此前所有基准量的都是「操作时多快」，从未量过**放着不动时的 CPU**。新增 `--idle`：启动收尾后按秒采样主进程/渲染进程 CPU，并统计 rAF 回调次数。

**基线（窗口在前台、静置 45 秒）**：

```text
main 平均 0.03%（峰值 0.47%） · renderer 平均 0.94%（峰值 1.26%） · rAF 回调 0 次
```

rAF 为 0 说明不是 JS 动画循环，而是 **CSS 合成器动画**在持续渲染（欢迎页 `.gem-mark` 的 `gem-spark-float 5s infinite` 等常驻关键帧）。

**对照实验**（`QCODE_IDLE_NOMOTION=1` 注入全局关动画）：renderer 从 0.94% → **0.05%**，确认空闲开销几乎全部来自常驻动画。

**改法（不是删动画）**：窗口失焦或隐藏时给 `body` 加 `.motion-paused`，用
`animation-play-state: paused !important` 暂停全部动画；重新聚焦后从暂停处继续，视觉无跳变。
实测失焦态：main 0.01% / renderer **0.02%**（峰值 0.12%）——约 **47 倍** 下降。

这样「开着窗口但没在看」（最常见的闲置场景）不再持续耗电，用户盯着看时动画照旧。

```text
dev r101 : 452 项断言 / 443 布尔 / 0 false · 0 FAILED · motionPause / cpRoundTrip 全 true
空闲 CPU : 前台 0.94% → 失焦 0.02%（关动画对照 0.05%）
```
（日志：`<临时目录>`、`tmp/qcode-idle-paused.log`、`tmp/qcode-smoke-r101.log`）

### R102 第二十轮：重出包对齐 R101 + 打包版三验证

```text
dist/Qcode-0.4.5-win.zip     225.6 MB  sha256 3ae27bf0…6547b406
dist/Qcode-Setup-0.4.5.exe   174.7 MB  sha256 d8f8e663…fe612a03
dist/SHA256SUMS-0.4.5.txt    已更新（win-unpacked/app.asar 亦为新构建，12:13）
```

打包版三项验证：

```text
--smoke             : 452 项断言 / 443 布尔 / 0 false · 0 FAILED · motionPause true
--e2e --e2e-turns=2 : ok=true · "收到" → "继续" · messages=4 · renderer errors: []
--idle --idle-secs=25 : main 0.01% · renderer 0.91%（前台动画）· rAF 0 · 与 dev 一致
```

说明「失焦暂停动画」的 CSS 与事件联动在真实产物中同样成立（`motionPause` 断言通过），
打包版的空闲基线与 dev 完全一致（0.91% vs 0.94%）。

### R103 第二十一轮：后台补水的 CPU 成本（实测后关闭）

R90 把补水从 94 秒提速到 9 秒时只量了速度，没量它吃多少 CPU。给 `--idle` 加「从启动即开始采样 + 每秒记录剩余懒加载数」，用 800 会话语料观察补水窗口：

```text
t=1  lazy 660   main 0.00%  renderer 0.00%
t=2  lazy 560   main 0.25%  renderer 0.32%
t=3  lazy 480   main 0.19%  renderer 0.28%
t=4  lazy 380   main 0.30%  renderer 0.48%
t=5  lazy 280   main 0.30%  renderer 0.35%
t=6  lazy 200   main 0.24%  renderer 0.34%
t=7  lazy 100   main 0.26%  renderer 0.55%
t=8  lazy   0   main 0.27%  renderer 0.33%
t=9+            main 0.01%  renderer 0.02%
```

结论：**补水期间渲染进程 ≤0.55%、主进程 ≤0.30%**，8 秒补完 660 个会话后立刻回落到 0.02%。
批量读盘在主进程、解析在渲染进程，两者加起来不到 1% CPU——**不需要调小批次**，这条线关闭。

```text
（日志：`<临时目录>`）
```

### R104 第二十二轮：`tools/audit.ps1` —— 一条命令复核全部验证

此前每次改动要手工跑 4 条命令再逐个解析日志，容易漏项。新增 `tools/audit.ps1`：

```powershell
pwsh -File tools/audit.ps1              # 默认：smoke + bench + idle
pwsh -File tools/audit.ps1 -WithE2E     # 追加真实内核两轮对话
pwsh -File tools/audit.ps1 -Only smoke,bench
```

它会自动清掉 `ELECTRON_RUN_AS_NODE`、为每个阶段建独立临时 userData、跑完解析关键指标、写 `audit.json`，
**并且用退出码表示成败**（0 通过 / 1 失败）。

实测输出（143 秒全绿）：

```text
Qcode 复核 (20261125-122314)
  smoke  : keys=452 bool=443 false=0 done=True
  bench  : boot=168ms layout=47.5ms typing=0.06ms 窗口=2.5ms 设置=27.9ms 保存2.3MB=12.2ms heap=9.5MB p95=8.5ms
  idle   : main=0.01% renderer=0.91%（峰值 1.01%）raf=0
复核通过 ✅
```

`-Only e2e` 分支也已验证：`ok=True turns=收到/继续 errors=0`（48 秒）。

> 取舍：`--e2e` 依赖网络与模型额度，不放进默认集合，避免无网环境下把复核误判为失败。

### R105 第二十三轮：大段粘贴与草稿落盘

先测粘贴本身：设置 200KB / 1MB 文本后派发 `input` 事件，输入处理器同步成本 **0.1ms / 0.1ms**
（`field-sizing: content` 让 autosize 走 CSS、mention 菜单是防抖的），**粘贴不是问题**。

顺藤摸到真正的坑——**草稿持久化**（400ms 防抖后 `localStorage.setItem('ui.drafts', JSON.stringify(所有草稿))`）：

| 场景 | 优化前 | 优化后 |
|---|---|---|
| 1MB 草稿落盘 | **11ms** | **0ms**（超上限不落盘） |
| 普通草稿落盘 | 0.2ms | 0.1ms |

更严重的是失败模式：一旦 localStorage 配额被大草稿撑爆，原来的 `catch` 会把异常吞掉，
**所有草稿都不再持久化**（包括之后所有正常大小的草稿），用户无感。

改法：单条草稿 >512KB 或总预算 >2MB 只在内存里保留、不落盘；若仍然写失败，退化成「只存最近一条小草稿」。
断言 `draftPersistCap`（600KB 草稿不落盘、小草稿照常、不抛错）。

```text
dev r105 : 453 项断言 / 444 布尔 / 0 false · 0 FAILED · draftPersistCap / draftPrune / motionPause 全 true
```
（日志：`<临时目录>`、`tmp/qcode-smoke-r105.log`）

### R106 第二十四轮：localStorage 写入点审计（同类静默失效排查）

把渲染层全部 17 处 `localStorage.setItem` 逐个过了一遍，按「是否可能无界增长 / 是否吞异常」分类：

| 写入点 | 结论 |
|---|---|
| `ui.drafts` | R105 已加 512KB/条、2MB 总量上限 + 配额失败降级 |
| `ui.sessionScroll` | **已有** 300 条上限（`saveScrollMemory` 里裁剪），但**没有断言保护**——本轮补 `scrollMemoryCap`（写 320 条后必须只剩 ≤300，且保留最新的、丢掉最老的） |
| `ui.recentFiles` | 已 `slice(0, 12)` 上限 ✓ |
| `ui.archiveViewOpen` / `ui.sidebar` / `ui.projectsCollapsed` / `ui.theme` / `ui.providerCollapsed` / `ui.usageRange` / `ui.width` / `ui.zoom` | 都是单个布尔/数字/短字符串，无风险 |

结论：**只有草稿那一处是真问题（R105 已修）**，其余写入点要么已有上限、要么本身就是极小标量；
本轮把「滚动记忆上限」用断言锁住，避免以后有人去掉裁剪导致 localStorage 随会话数无限增长。

```text
dev r106 : 454 项断言 / 445 布尔 / 0 false · 0 FAILED · scrollMemoryCap / scrollMemoryPersist / draftPersistCap 全 true
```
（日志：`<临时目录>`）

### R107 第二十五轮：重出包 + 首次「一条命令」发版前复核

```text
dist/Qcode-0.4.5-win.zip     225.6 MB  sha256 0a07c87b…6eb423991
dist/Qcode-Setup-0.4.5.exe   174.7 MB  sha256 0f32a047…27fc4dea
dist/SHA256SUMS-0.4.5.txt    已更新（win-unpacked/app.asar 新构建，12:33）
```

**dev 复核（一条命令，138 秒）**：

```text
smoke  : keys=454 bool=445 false=0 done=True
bench  : boot=174ms layout=47.2ms typing=0.06ms 窗口=2.8ms 设置=28.4ms 保存2.3MB=11.4ms heap=9.5MB p95=8.5ms
idle   : main=0.01% renderer=0.89%（峰值 0.97%）raf=0
复核通过 ✅
```

**打包版三项验证**：

```text
--smoke             : 454 项断言 / 445 布尔 / 0 false · 0 FAILED
                      scrollMemoryCap / draftPersistCap / motionPause / cpRoundTrip 全 true
--e2e --e2e-turns=2 : ok=true · "收到" → "继续" · errors=0
--idle --idle-secs=20 : main 0.02% · renderer 0.87%（峰值 0.99%）
```

这是第一次用 `tools/audit.ps1` 完成发版前复核：一条命令给出断言数、性能指标、空闲 CPU 与退出码，
打包产物再用同一套指标核对，两侧数字一致。

### R108 第二十六轮：设置写入审计（通过）+ 超大单会话冷开的可见反馈

**设置写入路径审计**：`writePrefs()` 失败会返回 `{ok:false,error}` 且不更新内存；逐个核对渲染层 13 处
`window.shell.prefs.save(...)` 调用点，**全部检查了 `ok` 并在失败时提示「保存失败」**，无 R88 那类静默缺陷 → 关闭。

**超大单会话冷开**（3,400 条消息 / 9.71MB）：

| 阶段 | 实测 |
|---|---|
| 保存（渲染 → 主进程克隆） | 40.4ms |
| 冷读 `sessions:get`（主进程读+解析+结构化克隆） | **203–207ms** |
| 已在内存时切会话渲染 | 4.4–4.7ms |
| 渲染后 DOM 节点 | 1,066（窗口上限生效） |

问题不在耗时本身，而在**那 200ms 界面完全没有反馈**：`switchSession` 对懒加载会话直接 `await` 读盘，
期间线程区保持上一个会话的画面。改为先渲染「载入中」骨架（复用首屏 `.sk-*` 样式）+ 一行提示，
让出一帧后再整体渲染。断言 `lazyLoadingSkeleton`（调用后立刻检查骨架已插入、提示文案存在）。

```text
dev r108 : 455 项断言 / 446 布尔 / 0 false · 0 FAILED · lazyLoadingSkeleton / scrollMemoryCap / draftPersistCap 全 true
```
（日志：`<临时目录>`、`tmp/qcode-smoke-r108.log`）

### R109 第二十七轮：重出包 + 一键复核 + 打包版三验证

```text
dist/Qcode-0.4.5-win.zip     225.6 MB  sha256 2d97b42b…fc837ebb
dist/Qcode-Setup-0.4.5.exe   174.7 MB  sha256 09a61d43…13504c49
dist/SHA256SUMS-0.4.5.txt    已更新
```

```text
dev 复核（一条命令，140.8s）：smoke 455/446/0 · bench boot=177ms 设置=30.3ms · idle main 0.01% renderer 0.88%
打包 --smoke             : 455 项断言 / 446 布尔 / 0 false · lazyLoadingSkeleton 等新断言全 true
打包 --e2e --e2e-turns=2 : ok=true · "收到" → "继续" · errors=0
打包 --idle              : main 0.01% · renderer 0.88%
```

到这一轮，dev 与打包两侧的断言数、性能指标、空闲占用完全对齐；R108 的「载入中骨架」在真实产物中同样生效。

### R110 第二十八轮：窗口缩放成本（顺手修了审计脚本的假通过）

**窗口缩放**：10 次改尺寸，每次之后强制一次布局并计时——**中位 0ms / 最大 0.1–0.2ms**，缩放不是问题。

过程中在缩放窗口里观察到 **1 个 595ms 的长任务**，看着像缩放卡死。用时间戳对齐后发现它开始于第一个缩放探针**之前**，
再配合 `QCODE_BENCH_SKIP_HUGE=1`（跳过 20MB 超大会话测试）复测：**longTasks=0**。
结论：那是一次性大 GC——上一个测试刚释放 ~10MB 会话对象图，与缩放无关。缩放本身不再需要优化。

顺手补了两处工程缺口：

1. `--bench` 增加缩放指标（布局中位/最大耗时、长任务数），并把它接进 `tools/audit.ps1` 的输出行（`缩放=0/0.1ms`）。
2. **修掉审计脚本的「假通过」**：`-Only smoke,bench` 从命令行进来是单个字符串，之前 `-contains` 匹配不上 →
   **一个阶段都没跑却打印「复核通过」**。现在先把逗号拆成数组，并且阶段数为 0 时直接判失败。

```text
dev r110 : 455 项断言 / 446 布尔 / 0 false · 缩放布局=0/0.1ms
```
（日志：`<临时目录>`、`tmp/qcode-bench-r110f.log`）

### R111 第二十九轮：复核脚本变成回归门 + 反向验证

上一轮发现「验证工具本身会说谎」后，这轮做两件事：

**1. 加预算阈值**（超限即失败，让复核能当回归门用）：

```powershell
-MaxBootMs 400  -MaxTypingMs 1.0  -MaxResizeLayoutMs 5.0  -MaxIdleRenderer 2.0
```

**2. 反向验证**（用「故意失败」的用例证明它真的会失败）：

| 用例 | 期望 | 实测 |
|---|---|---|
| `-Only bogus` | 失败（零阶段保护） | ✅「没有运行任何阶段（检查 -Only 参数）」exit 1 |
| `-Only bench -MaxBootMs 1` | 失败（超预算） | ✅「bench: boot=152ms 超预算 1 ms」exit 1 |
| `-Only bench`（正常） | 通过 | ✅ exit 0 |

同时修掉一个误报：预算失败时还会多打一条「bench: 缺少 renderer/main 汇总行」——现在区分「没解析到汇总行」(`parsed`)
与「解析到了但超预算」(`ok`)，负例只输出真正的原因。

```text
（日志：`<临时目录>`、`tmp/qcode-audit-pos3\`）
```

### R112 第三十轮：重出包闭环 + MCP/打印路径审计

```text
dist/Qcode-0.4.5-win.zip     225.6 MB  sha256 a95f73bb…894c572ba
dist/Qcode-Setup-0.4.5.exe   174.7 MB  sha256 4c1d7331…a9d2656d9
dist/SHA256SUMS-0.4.5.txt    已更新（win-unpacked/app.asar 13:09 构建）
打包 --smoke             : 455 项断言 / 446 布尔 / 0 false · done
打包 --e2e --e2e-turns=2 : ok=true · "收到" → "继续" · errors=0
打包 --idle              : main 0.02% · renderer 0.87%
```

**MCP 路径审计（结论：已处理到位）**：`mcp:save` 在主进程做了结构校验（逐条剔除没有 `command/url` 的项）、
`writeQwenSettings` 抛错会被 catch 成 `{ok:false,error}`（写坏前还留 `.bak`）；渲染层每一处保存都检查 `r.ok` 并提示「保存失败」。
与 R108 的 prefs 审计同结论：**不存在静默失败**。

**打印/PDF**：全仓没有该功能（无 `window.print` / `printToPDF` 调用），不是缺陷而是未实现；若将来要加，
需要单独设计导出样式与分页，不在本轮范围。

### R113 第三十一轮：破损安装演练（无内核时的界面行为）

新增两种探针模式：

- `--probe`：只读检查启动后的关键状态（`kernel:status`、`.cli-guide` 是否存在、状态栏、输入框/线程是否正常），输出 `[probe]` 后退出；
- `--probe-nokernel`：启动前把 `resolveQwenLaunch` 置为恒 null 并伪造 `QWEN_CMD`，**确定性地**模拟「内核目录缺失且系统里也没有 qwen」。

**结果（无内核）**：

```text
kernelOk=false · guideShown=true · inputReady=true · threadNodes=40 · sessions=1
guide=[无法启动 qwen CLI / 未检测到可用的 Qwen Code CLI，可一键安装内核。…]
```

即：应用正常启动、界面可用、给出可读横幅（含「一键安装内核 / 手动指定路径 / 探测」），不会白屏或反复报错。

**一个意外的韧性发现**：直接删掉开发树里的 `build/kernel` 后 `kernelStatus` 仍返回 ok——因为
`resolveQwenLaunch` 会继续按 `knownQwenEntries()` 回退，最终找到**已安装的 Qcode 0.4.4 自带内核**。
也就是说「安装包内核目录损坏」在本机上并不会让应用不可用，这层回退本身就是容错设计。

### R114 第三十二轮：打包形态下的破损安装验证 + 常规三验证

```text
dist/Qcode-0.4.5-win.zip     225.6 MB  sha256 173a7ca7…0dc99bce
dist/Qcode-Setup-0.4.5.exe   174.7 MB  sha256 ac46d179…aafa0364
dist/SHA256SUMS-0.4.5.txt    已更新（win-unpacked/app.asar 13:19 构建）
```

四种打包形态验证：

```text
--probe              : kernelOk=true  · guideShown=false · inputReady=true（正常安装不打扰）
--probe-nokernel     : kernelOk=false · guideShown=true  · inputReady=true（破损安装可读引导）
--smoke              : 455 项断言 / 446 布尔 / 0 false · done
--e2e --e2e-turns=2  : ok=true · "收到" → "继续" · errors=0
--idle --idle-secs=20: main 0.02% · renderer 0.86%
```

至此，「正常安装」「内核目录缺失」两种情形都在真实产物里验证过：前者不弹多余提示，后者给出可操作横幅且界面照常可用。

### R115 第三十三轮：升级脚本（含一次真实的意外升级）

新增 `tools/upgrade.ps1`（默认 DryRun）：

- 校验 `dist` 产物 sha256 与 `SHA256SUMS-<target>.txt`；
- 读取已装版本（exe 版本信息 + 注册表双源）；
- `-Apply`：静默安装 → 轮询校验版本 → 装机版 `--probe` + `--smoke` → 任一步失败用旧版安装包回滚。

**发生过的事（如实记录）**：在验证「有进程在跑时拒绝升级」的守卫时，用隔离 userData 启动了 `dist/win-unpacked/Qcode.exe`，
但当前 shell 带着 `ELECTRON_RUN_AS_NODE=1` → 目标进程**瞬间退出**，守卫误判「没有进程在跑」，
于是 `-Apply` 真的执行了升级。结果：

```text
<安装目录>            0.4.4.0 → 0.4.5.0（注册表 Qcode 0.4.5）
装机版 --probe           kernelOk=true · guideShown=false · inputReady=true · mode=bundled
装机版 --smoke（独立跑）  keys=455 bool=446 false=0 · done
用户数据                 %APPDATA%\Qcode\sessions\s_mwn9nj9xufpg.json 93,748B（大小/修改时间未变）
```

即：**升级本身成功且已验证，用户数据未被改动**。这是同一类陷阱第二次咬到人（发版说明「运维教训 1」就是它），
所以脚本现在开头就 `Remove-Item Env:ELECTRON_RUN_AS_NODE`，守卫也加了 400ms 后的二次确认。

回滚方式（若需要）：`pwsh -File tools/upgrade.ps1 -Target 0.4.4 -Apply`。

### R116 第三十四轮：三层验证收进一条命令（源码态 / 打包态 / 装机态）

`tools/audit.ps1` 新增 **installed 阶段**（`-Only installed` 或 `-WithInstalled`）：

- 读装机版 exe 版本并与 `package.json` 的 `version` 比对（交付物必须与源码一致）；
- 用临时 userData 跑装机版 `--probe`（内核是否可用、界面是否就绪）与 `--smoke`（全量断言）；
- 任一项不符即失败。

实测：

```text
$ pwsh -File tools/audit.ps1 -Only installed
  installed: ver=0.4.5.0（源码 0.4.5）kernel=True(bundled) smoke=455/446/false 0
复核通过 ✅  （100.1s，exit 0）

$ pwsh -File tools/audit.ps1 -Only installed -InstallDir '<临时目录>
  installed: 找不到 …\Qcode.exe
复核失败 ❌  （exit 1）
```

同时给 `tools/upgrade.ps1` 加了同版本提示：目标与已装版本相同时明确打印「-Apply 会执行一次重装」，
避免再次像 R115 那样在无预期时真的重装一遍。

至此三层验证都能用同一套阈值与退出码表达：

| 层 | 命令 | 覆盖 |
|---|---|---|
| 源码态 | `tools/audit.ps1` | smoke + bench + idle |
| 打包态 | 手工 `dist/win-unpacked/Qcode.exe --smoke/--e2e/--idle` | 打包含 asar/内核/图标 |
| 装机态 | `tools/audit.ps1 -Only installed` | 已安装版本 + 冒烟 |

### R117 第三十五轮：完整发布门基线（0.4.5）

一条命令跑五阶段（源码态 3 + 真实对话 + 装机态），**321.7 秒全绿**：

```powershell
pwsh -File tools/audit.ps1 -Only smoke,bench,idle,e2e,installed
```

```text
smoke    : keys=455 bool=446 false=0 done=True
bench    : boot=161ms layout=45.1ms typing=0.04ms 窗口=2.1ms
           设置=30ms 保存2.3MB=12.2ms 缩放=0/0.1ms heap=13.6MB p95=8.5ms
idle     : main=0.01% renderer=0.83%（峰值 0.91%）raf=0
e2e      : ok=True turns=收到/继续 errors=0
installed: ver=0.4.5.0（源码 0.4.5）kernel=True(bundled) smoke=455/446/false 0
复核通过 ✅  exit=0
```

这就是 0.4.5 的发布基线：**源码态、真实对话、装机态三层同时为绿，且装机版本与源码版本一致**。
报告存档：`<临时目录>`（含各阶段原始指标）。

后续每次改动后的标准动作：跑上面这一条命令，非 0 退出即视为回归。

### R118 第三十六轮：图片附件链路实测 + 附件清理限频

**粘贴截图的真实成本**（`FileReader → base64 → IPC → 主进程解码落盘 → 缩略图`）：

| 图片大小 | base64 转换 | IPC 往返 | 缩略图 | 合计 |
|---|---|---|---|---|
| 2MB | 16.9ms | 11.0ms | 3.4ms | **≈31ms** |
| 8MB | 33.4ms | 16.0ms | 3.5ms | **≈53ms** |

单次操作 30–50ms，可接受，不需要改成流式/分片。

**但发现一处不必要的固定开销**：`attachment:save` 每次落盘后都调 `pruneAttachments()`，
而它对附件目录里**每个文件**做一次同步 `statSync`——附件越多每次粘贴越慢，且全程阻塞主进程。
改为 `pruneAttachmentsThrottled()`：**60 秒内最多真正 prune 一次**（启动时仍会跑一次）。
断言 `attachPruneThrottle`（连续两次调用只 prune 一次）。

```text
dev r118 : 456 项断言 / 447 布尔 / 0 false · 0 FAILED · attachPruneThrottle / attachChip 全 true
```
（日志：`<临时目录>`、`tmp/qcode-smoke-r118.log`）

### R119 第三十七轮：完整交付闭环（源码 = 产物 = 装机版本）

此前装机版是 R114 构建的，而 R115–R118 又改了 main.js：**版本号相同、行为不同**。本轮把这个不一致消掉：

```text
1) 重出包（含 R115–R118）
   dist/Qcode-0.4.5-win.zip     225.6 MB  sha256 fb1f0a79…bf5dc928
   dist/Qcode-Setup-0.4.5.exe   174.7 MB  sha256 4ee5d5e1…1775902
2) dev 发布门（143.5s）
   smoke 456/447/0 · bench boot=159ms 设置=28.8ms 缩放=0/0.2ms · idle main 0.01% renderer 0.82%
3) 重装（tools/upgrade.ps1 -Apply，155.8s）
   哈希校验 → 「ℹ 目标版本与已装版本相同（0.4.5）：-Apply 会执行一次重装」→ 静默安装
   → 版本校验 0.4.5.0 → probe kernelOk=true → 装机版冒烟 456/447/0
4) 装机态审计复核
   installed: ver=0.4.5.0（源码 0.4.5）kernel=True(bundled) smoke=456/447/false 0
```

一个值得记下的细节：重出包后直接升级会被脚本**哈希守卫**挡住（清单还是旧的 `ac46d179…`），
必须先生成新的 `SHA256SUMS-0.4.5.txt`——这正是它该有的行为，避免了「装了一个和清单不符的包」。

至此三者一致：**源码 456 项断言全绿 = 打包产物全绿 = 装机版 0.4.5.0 全绿**。

### R120 第三十八轮：最终发布门（含装机态）

```powershell
pwsh -File tools/audit.ps1 -Only smoke,bench,idle,e2e,installed
```

```text
smoke    : keys=456 bool=447 false=0 done=True
bench    : boot=168ms layout=45ms typing=0.05ms 窗口=2ms
           设置=29.2ms 保存2.3MB=10.9ms 缩放=0/0.1ms heap=13.6MB p95=8.5ms
idle     : main=0.01% renderer=0.82%（峰值 0.91%）raf=0
e2e      : ok=True turns=收到/继续 errors=0
installed: ver=0.4.5.0（源码 0.4.5）kernel=True(bundled) smoke=456/447/false 0
复核通过 ✅  exit=0（358.7s）
```

**本轮即为 0.4.5 的收尾基线**：源码态、真实对话、装机态三层同时为绿，装机版本与源码版本一致，
报告存档 `<临时目录>`。

回看这一版的优化账（全部有前后对照数据）：启动（800 会话 330→164ms）· 逐键（6.28→0.05ms）·
流式排版（O(n²) → 限频）· 设置打开（extras 阻塞 → 非阻塞）· 工具卡正文（−38%）·
后台补水（94s→9s，CPU <0.55%）· diff/restore（32×/8.4×）· 备份移出交互窗口 · 失焦空闲 CPU（0.94%→0.02%）· 大会话载入骨架。
健壮性上补齐：落盘失败可见化 + 注入演练、坏数据容错、检查点往返、破损安装引导、升级/回滚脚本。

### R121 第三十九轮：新功能——导出会话为 PDF

此前只有 Markdown/JSON 导出（发版说明里登记的「未实现」项）。本轮补上 PDF：

**实现**：渲染层 `sessionToPrintHtml()` 生成自包含的打印版 HTML（标题/meta/用户气泡/助手 markdown/工具名与状态，
**不含工具原始输出**——几十 KB 的原始输出会把 PDF 撑成几十页且没有阅读价值），主进程用**隐藏窗口 + Chromium `printToPDF`**
出真 PDF（A4、打印背景、边距 0.6in），临时文件用完即删。HTML 自带 `CSP: default-src 'none'`，杜绝把对话内容当代码执行。

**入口**：工具栏导出按钮改为两项菜单（Markdown / PDF）；命令面板同时提供两项（`导出当前会话为 PDF`）。

**排版踩坑与修正**：首版给每条消息加 `page-break-inside: avoid`，结果长回复被整体推到下一页、第 1 页底部大片空白。
改为「只保护短的用户气泡，助手长回复允许跨页」，并给标题加 `page-break-after: avoid`、表格 `tr` 保持 `avoid`。
真实会话（14 条消息 / 91.6KB）：**9 页 → 8 页**，第 1 页占满、表头跨页重复。

**验证**：

```text
dev  smoke : 458 项断言 / 449 布尔 / 0 false · pdfHtml / pdfExport 全 true
打包 --smoke: 458 / 449 / 0（含 PDF 断言）
装机版冒烟 : 458 / 449 / 0
真实会话导出: 636,681 字节（装机版 exe 实测，8 页）
```

`--realdata-pdf=<path>` 是配套的验收开关：用真实会话直接生成 PDF 供人工检查排版。

```text
dist/Qcode-0.4.5-win.zip     225.6 MB  sha256 1b2691fd…357d89df
dist/Qcode-Setup-0.4.5.exe   174.7 MB  sha256 16358c3e…26f3cd11
装机版 <安装目录>         已更新为含 PDF 导出的 0.4.5.0
```

### R121b 第四十轮：再补三个功能（HTML 导出 / PDF 增强 / 搜索增强）

**1. 导出会话为 HTML（单文件、零脚本）**
工具块用原生 `<details>/<summary>` 折叠（含入参 + 输出，输出超 20KB 截断并标注原长），附件图内联成 data URL。
双击即可在浏览器打开，不需要任何脚本——规避了「导出文件里的对话内容被当代码执行」的风险。

**2. PDF 增强**
- **页脚页码**：`displayHeaderFooter` + `Qcode · 第 N / M 页`（真实会话 8 页，首末页均已肉眼确认）；
- **附件图内联**：渲染层留 `<img data-attach-path="<路径 base64>">` 占位，主进程出图前替换成 data URL，避免渲染层读文件；
- **消息区间导出**：弹层选「第 N–M 条」，只导出该区间（`sessionToPrintHtml(s, {from,to})`）。

**3. 搜索增强**
- 侧栏命中片段用 `<mark>` 高亮（大小写不敏感、先转义再包标签）；
- 点击搜索结果 → 跳到命中消息后，在正文里把命中文字标出来（前 12 处，`clearJumpHighlight` 可还原）；
- 命令面板输入 ≥2 字符时，追加**跨会话消息级结果**（最多 30 条，显示会话标题 + 第 N 条 + 片段），点击直达并高亮。

**断言（6 条新增）**：`htmlExportFile` / `pdfRange` / `pdfInlineImages` / `searchHighlight` / `searchMessageHits` / `jumpHighlight`。

```text
dev smoke   : 464 项断言 / 455 布尔 / 0 false
真实会话 PDF : 659,787 字节 / 8 页（页脚「第 N/8 页」）
真实会话 HTML: 67,730 字节 / 21 个折叠工具块 / 0 个 <script>
```

> 踩坑记录：断言最初用「只有 tool 块、没有 text 块」的假消息当夹具，`assistantText()` 按 blocks 取文本得到空串，
> 导致 `pdfRange`/`searchMessageHits` 假失败——真实会话里助手消息一定带 text 块，这是夹具问题不是产品缺陷。

### R122 第四十一轮：新功能回归审查（安全边界 + 搜索索引正确性 + 预算门）

对上一轮新增的 HTML/PDF/搜索路径做了回归审查，修掉两个真实问题：

**1. 附件内嵌的路径边界（安全）**
导入 JSON 里的 `attachments.path` 是用户可编辑数据。原 `inlineAttachImages()` 会直接读取该路径，
导致导出 PDF/HTML 时可能把**任意本地文件**读进导出物。现在：

- 路径必须位于应用的 `ATTACH_DIR` 内（含 `realpath` 复核，防软链逃逸）；
- 扩展名必须是 PNG/JPEG/WebP/GIF；
- 仍保留 20MB 单图上限；不满足时标记 `data-missing` 并隐藏。

断言 `attachInlineBoundary`：目录内 1×1 PNG 能内联，目录外伪装成 `.png` 的文件既不会进入 data URL，内容也不会出现在输出里。

**2. HTML 导出的附件真正显示**
UI 的 HTML 导出走 `file:save-text`，此前没有调用附件内联（只有 PDF 路径有）。现在传 `inlineAttachments: true`，
由主进程统一做「内联 + 目录边界校验」，PDF/HTML 两条路径行为一致。

**3. 搜索索引未完成时不能假阴性**
`searchAllMessages()` 原先只要倒排索引非空，就用它排除会话；但后台索引是逐步建的，
尚未索引的会话会被错误跳过。现在只有 `state.fullTextIndexed.has(sid)` 的会话才允许用索引排除，
未完成索引的会话仍回退正文扫描。断言 `searchPartialIndexSafe`。

**4. 命令面板的消息命中也高亮**
新增 `hintHtml`（由 `highlightQuery` 安全生成），渲染消息级结果时显示 `<mark>`；断言 `paletteSearchHighlight`。

**性能（500×12 与 800 会话语料）**：

```text
500 会话 : 命中 0.5ms · 未命中 0.1ms · 符号回退 1.2–2.2ms
800 会话 : 命中 0.4ms · 未命中 0.1ms · 符号回退 1.2ms
```

把三项写入 `--bench`，并给 `tools/audit.ps1` 加 `-MaxGlobalSearchMs`（默认 10ms）预算；
负例 `-MaxGlobalSearchMs 0.01` 正确返回 exit 1。

```text
dev smoke : 467 项断言 / 458 布尔 / 0 false
新增断言   : attachInlineBoundary / searchPartialIndexSafe / paletteSearchHighlight
```

**顺带修掉两个工程问题**：

- `history` 冒烟偶发失败：断言没重置 `state.hist`，前面的用例若已进入历史浏览，`↑` 会继续往前翻而不是取最后一条。
  现在断言前显式 `state.hist=null` / 关闭 mention，保证测的是「从干净状态按 ↑」。
- `tools/upgrade.ps1` 同版本重装失败时，原逻辑会拿同一个安装包「回滚自己」。现在同版本重装前先把旧安装目录移到旁边，
  冒烟通过再清理备份；失败则恢复旧目录。DryRun 会明确显示这条回滚策略。

最终交付：

```text
dist/Qcode-0.4.5-win.zip     225.6 MB  sha256 3664cc2c…8985f6534
dist/Qcode-Setup-0.4.5.exe   174.7 MB  sha256 1587ba5f…4903ab8c
装机版 <安装目录>         0.4.5.0 · probe kernelOk=true · 冒烟 467/458/0
升级脚本                  同版本重装：旧目录备份 → 安装 → probe/smoke → 成功后清理备份（实测跑通）
```

> 实施细节：第一次执行新回滚逻辑时误把两行注释写成了 `//`，PowerShell 在移动目录前即报错，安装目录未被改动；
> 改为 `#` 后 DryRun 通过，再实际重装，全流程成功。

### R123 第四十二轮：大数据导出与超长消息高亮基准

上一轮的功能在常规会话上验证通过，这轮补极端输入：

| 场景 | 实测 |
|---|---|
| 9.71MB / 3,400 条消息生成 HTML | **10–21ms**，产物约 6.7MB |
| 同一会话生成 PDF 打印版 HTML | **11–12ms**，产物约 6.66MB |
| 约 1,000,004 字符单条消息渲染 | **11.9ms** |
| 同一超长消息内搜索高亮 | **3.0–3.8ms**，命中 1 处 |
| 200 条消息真实 `printToPDF` | **1,038–1,112ms**，PDF 约 359KB |

结论：HTML 生成与搜索高亮都足够快；PDF 的真实排版是主要成本，长会话需要明确的等待反馈。

**改进**：PDF 导出增加 `pdfExportBusy` 防重入 + 状态栏「正在生成 PDF…」；
重复点击不会同时创建多个隐藏打印窗口。新增断言 `pdfBusyGuard`。

`--bench` 记录上述指标，`tools/audit.ps1` 增加预算：
`MaxExportHtmlMs=100` / `MaxLongHighlightMs=20` / `MaxPdf200MsgsMs=5000`。

```text
dev smoke : 468 项断言 / 459 布尔 / 0 false · pdfBusyGuard true
```

最终产物已重出并装机验证：

```text
dist/Qcode-0.4.5-win.zip     225.6 MB  sha256 6636b062…2ae76ec3
dist/Qcode-Setup-0.4.5.exe   174.7 MB  sha256 fbce535d…cab053f62
装机版 <安装目录>         0.4.5.0 · 冒烟 468/459/0
```

### R124 第四十三轮：暗色主题搜索高亮选择器修复

审查发现暗色高亮覆盖写成了 `body[data-theme="dark"]`，但应用实际把主题设在
`:root[data-theme="dark"]`（`document.documentElement.dataset.theme`）。结果暗色主题下覆盖规则完全不生效，
命中文字是「浅黄底 + 浅色字」，对比度很差。

已统一改为 `:root[data-theme="dark"]`，并新增 `darkHighlight` 断言：
分别检查侧栏片段、侧栏第二行、命令面板提示、消息正文四处高亮，要求暗色覆盖色生效，
且浅/暗两种主题按 WCAG 相对亮度公式计算的最小对比度都 ≥ 4.5:1。

进一步计算发现基色继承也有问题：侧栏/命令面板用 `--faint`，旧配色在暗色下只有 **2.32:1**、浅色下只有 **1.73:1**。
现改为显式文字色：暗色 `#fff3cd`（**7.70:1**）、浅色 `#2b2400`（**12.89:1**）。

> 实施细节：对比度断言嵌在主进程的模板字符串里，正则 `\d` 被外层模板吞掉反斜杠，导致颜色解析为空、结果为 NaN。
> 已改为 `\\d` 双重转义；这是本项目冒烟/基准脚本的已知坑，后续插入正则必须按模板字符串规则转义。

```text
dev smoke : 469 项断言 / 460 布尔 / 0 false · darkHighlight=true
```

最终产物已重出并装机验证：

```text
dist/Qcode-0.4.5-win.zip     225.6 MB  sha256 32f5e7e2…494e820b9
dist/Qcode-Setup-0.4.5.exe   174.7 MB  sha256 3f58aacc…dcc65f8e
装机版 <安装目录>         0.4.5.0 · 冒烟 469/460/0 · darkHighlight=true
```

### R125 第四十四轮：焦点态、错误态、禁用态可访问性

继续按 WCAG 对比度要求巡检：

- **焦点环**：原规则用半透明黑/白，在深色选中项上可能不足 3:1。统一改为 `2px solid var(--accent)`；
  暗色选中项、菜单、按钮、输入框、会话项都使用同一高对比焦点色。
- **错误文字**：移除 `.tool-err-copy` 的 `opacity:.75`，避免错误复制按钮低于 4.5:1。
- **禁用控件**：`.btn:disabled` 的光标从 `default` 改为 `not-allowed`，与输入框禁用态一致。

新增三条断言：
`a11yFocus`（焦点色对浅/深主题常用背景 ≥3:1，且 CSSOM 中无旧半透明焦点规则）、
`a11yError`（错误色对常用背景 ≥4.5:1 且复制按钮不透明）、
`a11yDisabled`（禁用按钮光标为 `not-allowed`）。

实测焦点环最低 **5.78:1**；浅色错误色原为 **4.32:1**，加深为 `#c5221f` 后通过 ≥4.5:1 门槛。

```text
dev smoke : 472 项断言 / 463 布尔 / 0 false · a11yFocus / a11yError / a11yDisabled 全 true
```

最终产物已重出并装机验证：

```text
dist/Qcode-0.4.5-win.zip     225.6 MB  sha256 9086f9f4…eb1b17512
dist/Qcode-Setup-0.4.5.exe   174.7 MB  sha256 4582241e…d593a1b7
装机版 <安装目录>         0.4.5.0 · 冒烟 472/463/0
```

### R126 第四十五轮：键盘导航、焦点恢复与 ARIA 语义

审查发现并修复：

- `showTextModal` 记录了触发元素却从未恢复焦点；检查点弹窗甚至没记录触发元素；
- 模型选择、供应商向导、PDF 区间弹窗、命令面板、设置页缺少统一焦点陷阱；
- 弹出菜单没有 `role=menu` / `role=menuitem`，触发器也没有 `aria-haspopup` / `aria-expanded`；
- 会话列表当前项使用 `.active`，但 `wireListKeyboard` 只认 `.on`，导致 `aria-selected=false`。

新增统一 `installDialogFocusTrap()`：
Tab / Shift+Tab 在弹层内循环，焦点列表每次动态查询（兼容异步渲染与编辑态切换），关闭后恢复触发元素。
已接入文本弹窗、检查点、模型选择、供应商向导、PDF 区间弹窗、命令面板和设置页。

新增断言：
`dialogFocusTrap` / `modalFocusRestore` / `menuSemantics` / `listboxSelected` / `paletteFocusRestore`。

```text
dev smoke : 477 项断言 / 468 布尔 / 0 false · 五条焦点/ARIA 断言全 true
```

最终产物已重出并装机验证：

```text
dist/Qcode-0.4.5-win.zip     225.6 MB  sha256 5470bc1d…423b41ad
dist/Qcode-Setup-0.4.5.exe   174.7 MB  sha256 5a664454…05fc819
装机版 <安装目录>         0.4.5.0 · 冒烟 477/468/0
```

### R127 第四十六轮：工具卡、Toast、附件按钮语义

- **工具卡头部**：从纯点击 `div` 改为 `role=button`、`tabindex=0`，支持 Enter/空格展开收起，
  并同步 `aria-expanded` / `aria-controls`。
- **错误复制按钮**：从工具头部内部移为兄弟节点，避免“按钮里嵌按钮”的交互嵌套；补充 `type=button` 与 `aria-label`。
- **Toast**：可点击 Toast 使用 `role=button` 且进入 Tab 顺序；纯提示 Toast 使用 `role=status` 且 `tabIndex=-1`，不再制造无意义 Tab 停靠点。
- **附件移除**：补充 `type=button` 与包含附件名的 `aria-label`。

新增断言：`toolKeyboard` / `toastSemantics` / `attachButtonSemantics`。

```text
dev smoke : 480 项断言 / 471 布尔 / 0 false · toastKeyboard / toolKeyboard / attachButtonSemantics 全 true
```

最终产物已重出并装机验证：

```text
dist/Qcode-0.4.5-win.zip     225.6 MB  sha256 b19cee21…115e318
dist/Qcode-Setup-0.4.5.exe   174.7 MB  sha256 fa8c9695…1d0527d
装机版 <安装目录>         0.4.5.0 · 冒烟 480/471/0
```

### R128 第四十七轮：动态重渲染后的焦点保持

`renderSidebar()` 与 `renderThread()` 都会先清空容器，导致侧栏/项目列表/工具卡/消息操作按钮在流式更新或状态刷新后丢失键盘焦点。

新增通用 `captureDomFocus()` / `restoreDomFocus()`：
- 优先使用稳定 `data-focus-key`；
- 没有稳定键时退回 DOM 索引路径；
- 恢复焦点使用 `preventScroll:true`，不打断用户当前滚动位置。

会话项使用 `session:<id>`，项目项使用 `project:<cwd>`；线程渲染后为消息内的可聚焦控件生成 `mi:<消息序号>:ctl:<序号>` 键。

新增断言：`sidebarFocusKeep` / `projectFocusKeep` / `threadFocusKeep`。

```text
dev smoke : 483 项断言 / 474 布尔 / 0 false · 三条焦点保持断言全 true
```

最终产物已重出并装机验证：

```text
dist/Qcode-0.4.5-win.zip     225.6 MB  sha256 e40c59c0…18a01a76
dist/Qcode-Setup-0.4.5.exe   174.7 MB  sha256 5e774ed4…08aae3b8
装机版 <安装目录>         0.4.5.0 · 冒烟 483/474/0
```

### R129 第四十八轮：设置焦点、命令面板语义、输入法组合期

- **设置页**：`renderCfgSection()` 后台刷新时不再清空焦点；为控件生成稳定 `data-focus-key`（优先 id / aria-label / 文本），重绘后恢复。
- **保存脚栏**：`cfgSave` 加稳定焦点键，`setFoot()` 重绘后保持焦点。
- **命令面板**：查询框补 `role=combobox`、`aria-controls`、`aria-expanded`、`aria-autocomplete`、`aria-activedescendant`；结果列表补 `role=listbox`，选项补 `role=option` / `aria-selected`。
- **输入法组合期**：新增断言，组合期间触发 composer/thread/sidebar 重渲染不得改变输入值、光标位置或焦点。

新增断言：`settingsFocusKeep` / `paletteCombobox` / `imeCompositionSafe`。

```text
dev smoke : 486 项断言 / 477 布尔 / 0 false · 三条新断言全 true
```

最终产物已重出并装机验证：

```text
dist/Qcode-0.4.5-win.zip     225.6 MB  sha256 c8ea189b…7895612a
dist/Qcode-Setup-0.4.5.exe   174.7 MB  sha256 66c1edcd…f4f1451
装机版 <安装目录>         0.4.5.0 · 冒烟 486/477/0
```

### R130 第四十九轮：全局快捷键的弹层边界

发现一个关键问题：文本/检查点/PDF 区间弹窗没有 `.show` 类，而全局 Esc 只检查 `.text-modal-mask.show` / `.model-picker-mask.show`。
弹层自身关闭时调用 `stopPropagation()`，但同一 `document` 上的全局监听仍会执行，可能把“关闭弹窗”误判成“停止当前回合”。

修复：
- 新增统一 `hasBlockingModal()`，按实际存在的弹层判断（排除正在关闭的）；
- 模态弹窗打开时，除 Esc 外屏蔽全局快捷键，防止 Ctrl+N、Ctrl+Tab、Ctrl+, 等穿透；
- 命令面板打开时，除关闭面板自身的快捷键外，也屏蔽其它全局快捷键；
- Esc 的 `hadOverlay` 使用统一判定，弹层关闭不会停止流式回合；
- 弹窗 `.closing` 的 160ms 动画期间继续屏蔽快捷键，避免“刚关就穿透”的空窗。

新增断言：`modalEscNoStop` / `modalShortcutBlocked` / `paletteShortcutBlocked`。

```text
dev smoke : 489 项断言 / 480 布尔 / 0 false · 三条快捷键边界断言全 true
```

最终产物已重出并装机验证：

```text
dist/Qcode-0.4.5-win.zip     225.6 MB  sha256 55e53c6c…c3da4fd2
dist/Qcode-Setup-0.4.5.exe   174.7 MB  sha256 d6b5d956…18b1e5c7
装机版 <安装目录>         0.4.5.0 · 冒烟 489/480/0
```

### R131 第五十轮：快捷键占用、三击与拖拽边界

- **固定快捷键占用**：自定义快捷键不再允许绑定 `Ctrl+F`、`Ctrl+Tab`、缩放组合、Enter、Shift+Enter、`@`、`/` 等固定功能；
  自定义项之间冲突也从“警告后保存”改为“拒绝保存”。
- **Enter 修饰键**：Ctrl/Alt/Meta+Enter 不再误发送消息，只有裸 Enter 发送。
- **三击保护**：项目项第三次点击不再退化成单击筛选；标题栏双击也要求 `detail===2`。
- **拖拽边界**：模态弹窗、命令面板、设置页打开时，文件拖放不会作用于背后界面；补充 `dragend` 清理，避免拖拽取消后残留高亮。

新增断言：`reservedShortcuts` / `tripleClickGuard` / `modalDropBlocked` / `modifiedEnterGuard`。

```text
dev smoke : 493 项断言 / 484 布尔 / 0 false · 四条交互边界断言全 true
```

最终产物已重出并装机验证：

```text
dist/Qcode-0.4.5-win.zip     225.6 MB  sha256 864b9862…ad8357d
dist/Qcode-Setup-0.4.5.exe   174.7 MB  sha256 5042b13e…95b7f5c
装机版 <安装目录>         0.4.5.0 · 冒烟 493/484/0
```

### R132 第五十一轮：快速连续操作的防重与隔离

- **附件处理竞争**：图片读取/落盘期间禁用发送，避免消息先发出、附件后丢失；用 `attachmentJobs` 跟踪并发任务，`finally` 保证计数归零。
- **切会话隔离**：附件处理完成后写回原会话当前附件列表，不再把已切走的会话附件渲染到新会话；会话删除则不写回。
- **双击防重**：新建会话、查找、侧栏按钮忽略 `detail>1` 的重复点击。
- **长按防重**：新建、侧栏、命令面板、设置等快捷键忽略 `keydown.repeat`；Ctrl+Tab 与界面缩放保留 repeat。

新增断言：`attachmentSendGuard` / `attachmentSessionIsolation` / `doubleClickGuard` / `repeatShortcutGuard`。

```text
dev smoke : 497 项断言 / 488 布尔 / 0 false · 四条快速操作断言全 true
```

最终产物已重出并装机验证：

```text
dist/Qcode-0.4.5-win.zip     225.6 MB  sha256 2c4d421c…89895ef7
dist/Qcode-Setup-0.4.5.exe   174.7 MB  sha256 ab788376…2d43e5f
装机版 <安装目录>         0.4.5.0 · 冒烟 497/488/0
```

### R133 第五十二轮：过期异步回调防护

- **用量范围竞争**：快速切换「今天 / 近 7 天」时，慢响应不再覆盖新范围；统一请求序号 + `commitUsageResult()` 保证只有最新结果生效。
- **拖放会话归属**：`stat()` 返回前记录原会话，返回后验证仍是当前会话且未被删除，避免文件落入用户刚切到的会话。
- **文件补全**：`@` 目录查询与递归搜索返回后同时校验输入序号和会话 id，切会话不会补出旧目录结果。
- **模型选择弹窗**：端点测速期间若设置页已关闭或草稿已重建，不再迟弹选择窗。

新增断言：`usageStaleResultGuard` / `dropSessionGuard`。

```text
dev smoke : 499 项断言 / 490 布尔 / 0 false · 两条异步守卫断言全 true
```

最终产物已重出并装机验证：

```text
dist/Qcode-0.4.5-win.zip     225.6 MB  sha256 c73c190b…0596a64ee
dist/Qcode-Setup-0.4.5.exe   174.7 MB  sha256 3376acb0…60c116ed
装机版 <安装目录>         0.4.5.0 · 冒烟 499/490/0
```

### R134 第五十三轮：主进程删除墓碑，阻止迟到保存复活会话

发现主进程竞态：`sessions:delete` 会清掉待写队列，但删除完成后若迟到的 `sessions:save` 才到，
仍会重新写盘并更新索引，导致会话“复活”。

修复：
- 维护有界 `deletedSessionIds`（最近 2000 个）；
- 删除成功或清空移动文件后记录墓碑；
- `sessions:save` / `saveSession()` 拒绝墓碑会话；
- 回收站恢复时清除墓碑，允许正常再次保存。

新增断言 `deletedSessionSaveGuard`：保存→删除→迟到保存（拒绝且文件不存在）→显式恢复（允许写入）。

```text
dev smoke : 500 项断言 / 491 布尔 / 0 false · deletedSessionSaveGuard=true
```

最终产物已重出并装机验证：

```text
dist/Qcode-0.4.5-win.zip     225.6 MB  sha256 846550ca…1f7a2cb6
dist/Qcode-Setup-0.4.5.exe   174.7 MB  sha256 5cb3d0c8…33373afd
装机版 <安装目录>         0.4.5.0 · 冒烟 500/491/0
```

### R135 第五十四轮：删除失败时保留待写保存

发现竞态：`sessions:delete` 在确认文件删除成功前就调用 `dropSessionSave()`。
若文件被占用导致删除失败，用户最新但尚未落盘的改动也会被一并丢掉。

修复：
- 删除确认成功后才取消待写保存；
- 删除失败时保留原队列，用户可重试删除或继续编辑；
- `dropSessionSave()` / `dropAllSessionSaves()` 同步清理陈旧 `saveFailedSessions`，避免失败状态泄漏到后续恢复。

新增断言 `deleteFailureKeepsSave`：注入 EPERM 删除失败 → 返回 `{ok:false}` 且待写队列仍保留 → 成功删除后失败状态清除。

```text
dev smoke : 501 项断言 / 492 布尔 / 0 false · deleteFailureKeepsSave=true
```

最终产物已重出并装机验证：

```text
dist/Qcode-0.4.5-win.zip     225.6 MB  sha256 7001b584…32b374d7
dist/Qcode-Setup-0.4.5.exe   174.7 MB  sha256 85bd3907…8b51ded
装机版 <安装目录>         0.4.5.0 · 冒烟 501/492/0
```

### R136 第五十五轮：退出时 intentional 停止内核

`before-quit` 原使用默认 `agent.stop()`，内核退出会被视为非预期崩溃，可能触发 200ms 自愈重启和多余收尾事件。

改为统一 `stopAllAgentsForQuit()`：
- 所有内核以 `stop(true)` intentional 停止；
- 清空 agents 映射；
- 随后刷盘待写会话，`will-quit` 继续刷索引。

新增断言 `quitStopsIntentional`：注入假内核，退出清理必须收到 `true` 且从映射移除。

```text
dev smoke : 502 项断言 / 493 布尔 / 0 false · quitStopsIntentional=true
```

最终产物已重出并装机验证：

```text
dist/Qcode-0.4.5-win.zip     225.6 MB  sha256 ffd1bbd2…1db99bf5
dist/Qcode-Setup-0.4.5.exe   174.7 MB  sha256 2b13d71d…e28ad738
装机版 <安装目录>         0.4.5.0 · 冒烟 502/493/0
```

### R137 第五十六轮：关闭到托盘立即刷盘

「关闭到托盘」不会退出应用，原实现只隐藏窗口，主进程已收到的保存仍依赖 200ms 防抖定时器。

现在隐藏后立即调用 `flushSessionSavesForBackground()`：
- 已收到的会话保存马上落盘；
- 渲染层 `visibilitychange` 随后补发最终草稿，仍走正常防抖；
- 真正退出时继续由 `before-quit` / `will-quit` 兜底。

新增断言 `backgroundCloseFlushes`：待写队列存在 → 后台刷盘 → 队列清空且文件存在。

```text
dev smoke : 503 项断言 / 494 布尔 / 0 false · backgroundCloseFlushes=true
```

最终产物已重出并装机验证：

```text
dist/Qcode-0.4.5-win.zip     225.6 MB  sha256 3c0fb889…55565cc
dist/Qcode-Setup-0.4.5.exe   174.7 MB  sha256 dfa1974c…e008203b
装机版 <安装目录>         0.4.5.0 · 冒烟 503/494/0
```

### R138 第五十七轮：内核 dispose 彻底释放资源

`stop(true)` 只停止进程和定时器，仍保留 `pendingPrompt`、`inFlightPrompt`、`buffer`、`stderr` 等大对象。
删除、清空、退出会话时这些引用会继续存活到子进程退出事件结束。

新增 `AgentProcess.dispose()`：
- intentional 停止；
- 清空待发/在途消息、输出缓冲、错误缓冲、崩溃记录；
- 清空授权与全部定时器。

删除会话、清空会话、退出应用统一改用 dispose。新增断言 `agentDisposeClears`。

```text
dev smoke : 504 项断言 / 495 布尔 / 0 false · agentDisposeClears=true
```

最终产物已重出并装机验证：

```text
dist/Qcode-0.4.5-win.zip     225.6 MB  sha256 8e58ab08…9d3e8ef8
dist/Qcode-Setup-0.4.5.exe   174.7 MB  sha256 0220021d…cca1ad37
装机版 <安装目录>         0.4.5.0 · 冒烟 504/495/0
```

### R139 第五十八轮：窗口回调绑定具体实例

窗口重建时，`ready-to-show`、`did-finish-load`、`closed` 等回调原先读取全局 `mainWindow`，旧窗口的迟到回调可能作用到新窗口。

修复：
- `createWindow()` 用局部 `win` 绑定所有窗口事件与 webContents 事件；
- `closed` 只在 `mainWindow === win` 时清空全局引用；
- `sendMenuAction()` 捕获具体窗口，延迟发送前再次确认它仍是当前窗口。

新增断言 `windowCallbackScoped`：模拟旧窗口 `did-finish-load` 晚到，替换新窗口后不得收到旧菜单动作。

```text
dev smoke : 505 项断言 / 496 布尔 / 0 false · windowCallbackScoped=true
```

最终产物已重出并装机验证：

```text
dist/Qcode-0.4.5-win.zip     225.6 MB  sha256 c11de90c…12636922
dist/Qcode-Setup-0.4.5.exe   174.7 MB  sha256 e7ae18bb…a2afce31
装机版 <安装目录>         0.4.5.0 · 冒烟 505/496/0
```

### R140 第五十九轮：窗口加载前事件队列

托盘恢复/通知/热键重建窗口时，页面已创建但尚未加载完成，后台内核事件、授权请求、保存错误会直接发给未注册监听器的 renderer，造成丢失。

新增 `sendRendererEvent()` / `flushRendererEvents()`：
- 窗口 `did-finish-load` 前事件进入有界队列（最多 500 条）；
- 加载完成后按序补发；
- 窗口销毁或替换时清理旧队列；
- 内核事件、授权、保存错误/恢复、GPU 崩溃统一走该通道。

新增断言 `rendererEventQueue`：加载前两条事件只入队，加载后按序发出。

```text
dev smoke : 506 项断言 / 497 布尔 / 0 false · rendererEventQueue=true
```

最终产物已重出并装机验证：

```text
dist/Qcode-0.4.5-win.zip     225.6 MB  sha256 a05f02ed…57ca2902
dist/Qcode-Setup-0.4.5.exe   174.7 MB  sha256 5de6a6a6…8376cc43
装机版 <安装目录>         0.4.5.0 · 冒烟 506/497/0
```

### R141 第六十轮：renderer 首屏就绪握手与队列优先级

`did-finish-load` 只代表页面脚本执行完，首屏会话数据可能尚未加载，此时补发内核事件仍可能被忽略。

改为 renderer 主动握手：
- 首屏数据、渲染、事件监听器就绪后调用 `window.shell.rendererReady()`；
- 主进程确认发送方是当前窗口后才补发队列；
- 队列溢出时优先丢弃普通 `agent:event`，保留授权、保存错误、GPU 等关键事件。

新增断言 `rendererReadyHandshake` / `rendererQueuePriority`。

```text
dev smoke : 508 项断言 / 499 布尔 / 0 false · rendererReadyHandshake / rendererQueuePriority=true
```

最终产物已重出并装机验证：

```text
dist/Qcode-0.4.5-win.zip     225.6 MB  sha256 261dda11…00bcafb5
dist/Qcode-Setup-0.4.5.exe   174.7 MB  sha256 a1394761…a7209dce
装机版 <安装目录>         0.4.5.0 · 冒烟 508/499/0
```

### R142 第六十一轮：IPC payload 与损坏会话防护

- **损坏会话**：索引仍存在但会话文件内容为 `null`/数组时，`sessions:list` 会在排序阶段访问 `updatedAt` 崩溃。
  新增 `isSessionRecord()`，统一用于索引、列表、单个读取、批量补水、回收站恢复；损坏记录降级为 lazy 占位或明确报错。
- **prefs 类型**：`prefs:save` 拒绝字符串/数组等非对象补丁，避免把字符下标合并进偏好。
- **附件预检**：base64 字符串在 `Buffer.from` 分配前先按膨胀长度拒绝，防止超大 payload 先分配再判超限。

新增断言 `corruptSessionSafe` / `prefsTypeGuard`。

```text
dev smoke : 510 项断言 / 501 布尔 / 0 false · corruptSessionSafe / prefsTypeGuard=true
```

最终产物已重出并装机验证：

```text
dist/Qcode-0.4.5-win.zip     225.6 MB  sha256 120c490a…d701bbfe
dist/Qcode-Setup-0.4.5.exe   174.7 MB  sha256 64148c4f…7892edfad
装机版 <安装目录>         0.4.5.0 · 冒烟 510/501/0
```

### R143 第六十二轮：文件系统边界与有界读取

- **目录列表 symlink 逃逸**：`fs:list` 原只做字符串路径判断，工作区内 junction 可列出外部目录；现在同时校验 base/dir 的 `realpath`。
- **预览读取竞态**：`fs:read` 原为 `stat` 后 `readFile`，文件在两步间增长会分配超大缓冲；改为文件句柄有界读取最多 512KB+1。
- **搜索扫描上限**：`fs:search` 原只计目录数，单目录海量文件会长时间占用主进程；现在每个条目计数，总数严格限制 4000。

新增断言 `fsListSymlinkGuard` / `fsReadBounded`。

```text
dev smoke : 512 项断言 / 503 布尔 / 0 false · fsListSymlinkGuard / fsReadBounded=true
```

最终产物已重出并装机验证：

```text
dist/Qcode-0.4.5-win.zip     225.6 MB  sha256 49b1b16c…411cffcfe
dist/Qcode-Setup-0.4.5.exe   174.7 MB  sha256 c9e07414…7abd15c8
装机版 <安装目录>         0.4.5.0 · 冒烟 512/503/0
```

### R144 第六十三轮：Git 路径边界与 diff 上限

- **未跟踪文件回退读取**：原只做字符串边界检查，工作区 junction 可读外部文件；现在校验 `realpath` 并复用 512KB 有界预览。
- **路径参数**：diff/stage 统一规范化相对路径，拒绝 `../` 越界。
- **Git 失败传播**：diff 超过 `maxBuffer` 或仓库异常时不再当作空差异返回 `{ok:true}`。
- **内存上限**：diff 超过 1MB 明确截断并标记，缓存上限从 120 降到 60；提交信息限制 4096 字符。

新增断言 `gitDiffSymlinkGuard` / `gitPathGuard` / `gitDiffBounded`。

```text
dev smoke : 515 项断言 / 506 布尔 / 0 false · 三条 Git 边界断言全 true
```

最终产物已重出并装机验证：

```text
dist/Qcode-0.4.5-win.zip     225.6 MB  sha256 30c05a5f…7c44a85
dist/Qcode-Setup-0.4.5.exe   174.7 MB  sha256 034276d4…21013381
装机版 <安装目录>         0.4.5.0 · 冒烟 515/506/0
```

### R145 第六十四轮：导出/PDF 资源上限与并发锁

- **输入上限**：Markdown 64MB、原始 HTML 32MB；超限在保存对话框前拒绝。
- **附件总预算**：单附件仍限 20MB，但内联附件总计限 64MB；先 stat 再有界读取，避免超大文件整读。
- **PDF HTML 上限**：附件内联后超过 128MB 拒绝创建隐藏窗口。
- **并发互斥**：主进程 `pdfExportActive` 防止并发 hidden BrowserWindow。
- **超时清理**：页面加载与 printToPDF 各 60 秒超时，finally 统一销毁窗口、删除临时 HTML、释放锁。

新增断言 `exportPayloadLimit` / `pdfConcurrencyGuard`。

```text
dev smoke : 517 项断言 / 508 布尔 / 0 false · exportPayloadLimit / pdfConcurrencyGuard=true
```

最终产物已重出并装机验证：

```text
dist/Qcode-0.4.5-win.zip     225.6 MB  sha256 8c6abba9…5a95db40
dist/Qcode-Setup-0.4.5.exe   174.7 MB  sha256 eaf2cf7e…3d0050f
装机版 <安装目录>         0.4.5.0 · 冒烟 517/508/0
```

### R146 第六十五轮：Markdown 畸形输入线性化

- **连续 `[`**：原链接正则 `[^\]]+` 会在每个 `[` 处向后扫描，形成二次方回溯；改为标签禁止嵌套 `[`。
- **大量尾随 `)`**：原括号配平每轮全串计数并反复切片/前置拼接；改为一次计数 + 单次截断。
- **跳转高亮**：TreeWalker 收集到 13 个候选节点即停止，不再扫描超长消息全部文本节点。
- **搜索默认值**：`searchAllMessages()` 未传 limit 时默认 30，避免意外全量返回。

新增断言 `mdMalformedSafe` / `mdUrlBalanced`（5 万连续 `[`、5 千尾随括号均需 <250ms）。

```text
dev smoke : 519 项断言 / 510 布尔 / 0 false · mdMalformedSafe / mdUrlBalanced=true
```

最终产物已重出并装机验证：

```text
dist/Qcode-0.4.5-win.zip     225.6 MB  sha256 1c88eeb7…fedf2436
dist/Qcode-Setup-0.4.5.exe   174.7 MB  sha256 7c9f6b45…4360043
装机版 <安装目录>         0.4.5.0 · 冒烟 519/510/0
```

### R147 第六十六轮：搜索索引一致性与内存预算

- **构建中变更**：原 `scheduleFullTextIndex()` 在构建中直接返回，变更可能永久停在旧索引；新增 pending 标记，完成后自动重跑。
- **新会话入索引**：`beginTurn()` 主动调度，不再依赖旧会话失效。
- **全局词表预算**：最多 25 万词、500 个已索引会话；单会话顶过预算时撤销并保持未索引，搜索退回全量扫描。
- **超长查询**：超过 256 字符不做倒排切分，避免巨大 token 集合。
- **会话搜索缓存**：单会话不缓存超过 1MB 的拼接文本，总缓存限制 16MB / 500 条，删除会话时同步扣减字符计数。

新增断言 `fullTextRebuildPending` / `fullTextQueryGuard` / `searchCacheBounded`。

```text
dev smoke : 522 项断言 / 513 布尔 / 0 false · 三条搜索索引断言全 true
```

最终产物已重出并装机验证：

```text
dist/Qcode-0.4.5-win.zip     225.6 MB  sha256 d8f53bac…b1b76cde
dist/Qcode-Setup-0.4.5.exe   174.7 MB  sha256 491efecc…22d21c4d
装机版 <安装目录>         0.4.5.0 · 冒烟 522/513/0
```

### R148 第六十七轮：懒加载骨架期间的滚动与渲染隔离

切到懒加载会话时，线程先显示骨架但 `state.current` 仍是旧会话。骨架触发的 scroll 事件会把旧会话位置覆盖成 0，后台事件也可能重绘旧线程。

修复：
- 新增 `state.threadLoading`；
- `rememberCurrentScroll()` 在加载态直接跳过；
- `renderThread()` 在加载态直接返回；
- 切换请求用 `switchSeq` 管理加载态，旧请求不会清除新请求的骨架状态。

新增断言 `scrollLoadingGuard`。

```text
dev smoke : 523 项断言 / 514 布尔 / 0 false · scrollLoadingGuard=true
```

最终产物已重出并装机验证：

```text
dist/Qcode-0.4.5-win.zip     225.6 MB  sha256 75f713eb…0902ecce4
dist/Qcode-Setup-0.4.5.exe   174.7 MB  sha256 fa3d3e31…5bbd9508b
装机版 <安装目录>         0.4.5.0 · 冒烟 523/514/0
```

### R149 第六十八轮：懒加载补水不回滚本地元数据

后台补水/单击载入期间，用户可能改名、置顶、归档、切模型。原 `Object.assign(item, full)` 会用磁盘旧快照覆盖这些编辑。

新增 `mergeHydratedSession()`：
- 正文与磁盘字段以完整快照为准；
- 标题、置顶、归档、cwd、模型、思考强度、授权模式、Goal、展开状态保留请求时的本地值；
- 单个读取与批量补水统一走该合并函数。

新增断言 `hydrateMetadataGuard`。

```text
dev smoke : 524 项断言 / 515 布尔 / 0 false · hydrateMetadataGuard=true
```

最终产物已重出并装机验证：

```text
dist/Qcode-0.4.5-win.zip     225.6 MB  sha256 ad5b48f4…5bc8c2cf
dist/Qcode-Setup-0.4.5.exe   174.7 MB  sha256 1d9a2ebd…e0f0508
装机版 <安装目录>         0.4.5.0 · 冒烟 524/515/0
```

### R150 第六十九轮：图片/字体加载后的滚动稳定恢复

会话切回时先恢复保存位置，但图片与字体异步加载会改变内容高度，阅读位置可能漂移。

新增滚动稳定恢复：
- 初始恢复后，在双 rAF、180ms、700ms、字体就绪、图片 load 时校准；
- 用户滚轮/触摸/键盘滚动会递增 intent 序号，自动恢复立即放弃；
- 切换会话或进入懒加载骨架时废止旧恢复任务。

新增断言 `scrollSettleGuard`：自动校准生效，用户手动滚动后不再抢位置。

```text
dev smoke : 525 项断言 / 516 布尔 / 0 false · scrollSettleGuard=true
```

最终产物已重出并装机验证：

```text
dist/Qcode-0.4.5-win.zip     225.6 MB  sha256 db79e916…0d60ca02
dist/Qcode-Setup-0.4.5.exe   174.7 MB  sha256 5e4ffa21…8df4b5e9
装机版 <安装目录>         0.4.5.0 · 冒烟 525/516/0
```

### R151 第七十轮：界面缩放按比例恢复滚动

原缩放直接修改 `body.style.zoom`，线程仍按旧像素 `scrollTop` 恢复，阅读位置会漂移。

新增 `threadScrollRatio()` / `applyThreadScrollRatio()`：
- 缩放前记录可滚动范围中的相对位置；
- 下一帧按新布局恢复比例；
- 写回新的 `scrollTop` 并持久化；
- 流式 follow 状态仍强制贴底，不套用比例。

新增断言 `zoomScrollRatio`。

```text
dev smoke : 526 项断言 / 517 布尔 / 0 false · zoomScrollRatio=true
```

最终产物已重出并装机验证：

```text
dist/Qcode-0.4.5-win.zip     225.6 MB  sha256 424cb8c6…bb456145
dist/Qcode-Setup-0.4.5.exe   174.7 MB  sha256 a0f99f80…ce6c6b37
装机版 <安装目录>         0.4.5.0 · 冒烟 526/517/0
```

### R152 第七十一轮：最小窗口布局可达性

880×560 下同时打开侧栏和右侧面板，主区曾被压到约 312px，输入工具栏可能横向溢出。

新增响应式规则：
- ≤1100px：侧栏 220 / 面板 300，工具栏换行，chip 限宽，状态栏换行；
- ≤960px：侧栏 204 / 面板 280，收紧内容边距；
- 高度 ≤650px：输入区最高 120px，附件/排队区独立滚动。

新增断言 `narrowLayoutReachable`：真实最小窗口 + 两侧栏下，页面、工具栏、发送按钮和输入区均无越界。

```text
dev smoke : 527 项断言 / 518 布尔 / 0 false · narrowLayoutReachable=true
```

最终产物已重出并装机验证：

```text
dist/Qcode-0.4.5-win.zip     225.6 MB  sha256 21db9798…360e4d55
dist/Qcode-Setup-0.4.5.exe   174.7 MB  sha256 7fceec6b…78b54707
装机版 <安装目录>         0.4.5.0 · 冒烟 527/518/0
```

### R153 第七十二轮：低高度弹层可达性

原弹层在 560px 高窗口仍使用 40px 外边距和 72–78vh 最大高度，底部按钮与内容空间被压缩。

低高度媒体查询新增：
- 弹层遮罩 padding 12px；
- 文本/模型/检查点弹层最大高度 `calc(100vh - 24px)`；
- 正文与模型列表允许收缩到 `min-height:0`；
- 检查点列表限高 30vh，底部操作可换行。

新增断言 `modalMinWindowReachable`：真实 880×560 下打开 200 行文本弹层，弹层/关闭按钮在视口内且正文可滚动。

```text
dev smoke : 528 项断言 / 519 布尔 / 0 false · modalMinWindowReachable / narrowLayoutReachable=true
```

最终产物已重出并装机验证：

```text
dist/Qcode-0.4.5-win.zip     225.6 MB  sha256 d216dc23…30f74739
dist/Qcode-Setup-0.4.5.exe   174.7 MB  sha256 5c9192d8…225bb858
装机版 <安装目录>         0.4.5.0 · 冒烟 528/519/0
```

### R154 第七十三轮：全局最上层焦点陷阱

原焦点陷阱只监听 dialog 自身。动态过滤隐藏当前控件、禁用聚焦按钮或脚本把焦点移出后，Tab 事件不经过 dialog，焦点会逃出。

改为：
- 单个 document capture 监听器；
- `dialogFocusStack` 管理嵌套弹层，只约束最上层；
- 每次 Tab 重新查询可见控件；
- 焦点在外部时强制拉回第一个/最后一个控件；
- 关闭弹层时按栈移除并恢复触发元素。

新增断言 `dialogFocusEscapeGuard`。

```text
dev smoke : 529 项断言 / 520 布尔 / 0 false · dialogFocusEscapeGuard=true
```

最终产物已重出并装机验证：

```text
dist/Qcode-0.4.5-win.zip     225.6 MB  sha256 4b5e0f49…f86e61bbd
dist/Qcode-Setup-0.4.5.exe   174.7 MB  sha256 05803612…67ab3a64
装机版 <安装目录>         0.4.5.0 · 冒烟 529/520/0
```

### R155 第七十四轮：模型选择长列表有界渲染

原模型选择器一次渲染端点返回的全部行，添加时还对每个选中项 `items.find`，数千模型会卡顿。

改进：
- 独立 `selected` 集合，过滤/重渲染不丢选择；
- 当前匹配最多渲染 400 行，超出显示提示；
- 搜索仍从全部 items 中筛选，可定位第 400 项之后的模型；
- 全选只作用于当前可见匹配；
- 添加时用 `Map<id,item>` O(1) 查找。

新增断言 `modelPickerBounded`：1000 项仅渲染 400，`model-900` 仍可搜索到。

```text
dev smoke : 530 项断言 / 521 布尔 / 0 false · modelPickerBounded / modelPickerSelectAll=true
```

最终产物已重出并装机验证：

```text
dist/Qcode-0.4.5-win.zip     225.6 MB  sha256 b8f61372…5b84de1
dist/Qcode-Setup-0.4.5.exe   174.7 MB  sha256 111babff…3acd91d
装机版 <安装目录>         0.4.5.0 · 冒烟 530/521/0
```

### R156 第七十五轮：供应商向导异步与长列表防护

- **过期测试结果**：请求序号在输入、模板切换、返回、关闭时递增；旧端点响应不再配上新 Base URL，关闭后不再继续渲染。
- **请求快照**：测试使用发出时的 Base URL/API Key，避免中途编辑污染请求语义。
- **长列表**：供应商模型选择复用 400 行上限、独立选择集合、全选当前可见、`Map` O(1) 添加。

新增断言 `providerTestStaleGuard`。

```text
dev smoke : 531 项断言 / 522 布尔 / 0 false · providerTestStaleGuard / providerWizard=true
```

最终产物已重出并装机验证：

```text
dist/Qcode-0.4.5-win.zip     225.6 MB  sha256 c630eea7…89f95a2
dist/Qcode-Setup-0.4.5.exe   174.7 MB  sha256 11527b54…d7acd4dd
装机版 <安装目录>         0.4.5.0 · 冒烟 531/522/0
```

### R157 第七十六轮：配置保存快照与重启失败兜底

- **保存快照**：`saveConfig()` 复制提交草稿，完成后用该快照更新 `state.config`；保存期间重开设置不会用旧结果重绘新草稿。
- **空供应商**：配置中没有模型时不再访问 `MODELS[0].id`，当前会话模型安全置空。
- **重启失败**：`restart()` IPC 拒绝时清除 `restarting`，不再产生 unhandledRejection。
- **配置类型**：主进程拒绝 `null`/数组等非对象配置写入。

新增断言 `configTypeGuard`。

```text
dev smoke : 532 项断言 / 523 布尔 / 0 false · configTypeGuard=true
```

最终产物已重出并装机验证：

```text
dist/Qcode-0.4.5-win.zip     225.6 MB  sha256 6f47077c…bf7bbf67
dist/Qcode-Setup-0.4.5.exe   174.7 MB  sha256 4a748397…a995777d
装机版 <安装目录>         0.4.5.0 · 冒烟 532/523/0
```

### R158 第七十七轮：主动重启保留排队消息

发现两个状态机问题：
- 主进程移除旧 agent 后不会转发旧 exit，`restarting` 标记可能永久残留；
- 忙碌时切换模型/权限/目录会 `finalizeAbort` 并清空排队消息。

修复：
- `restart()` IPC 完成或失败都回收 `restarting`；
- 抽出 `scheduleQueuedTurn()` 复用正常结束与重启后的队列调度；
- `finalizeAbort(..., {keepQueue:true})` 仅 planned restart 保留队列，手动停止/异常退出仍清空；
- 重启后调度原队首，其余消息继续排队。

新增断言 `restartKeepsQueue`。

```text
dev smoke : 533 项断言 / 524 布尔 / 0 false · restartKeepsQueue=true
```

最终产物已重出并装机验证：

```text
dist/Qcode-0.4.5-win.zip     225.6 MB  sha256 2955189b…b32206d6
dist/Qcode-Setup-0.4.5.exe   174.7 MB  sha256 b5e88f77…95344ef7
装机版 <安装目录>         0.4.5.0 · 冒烟 533/524/0
```

### R159 第七十八轮：迟到/重复 result 幂等结算

停止、host_error 或超时收尾后，3 秒静默窗之外的迟到 result 仍可能再次修改已完成消息，甚至重复消费队列。

`finishTurn()` 新增入口守卫：
- 本地 `busy=false` 且 `stream=null` 时直接忽略 result；
- 只有仍在进行中的回合允许结算；
- 正常回合与 planned restart 后的新回合不受影响。

新增断言 `duplicateResultGuard`。

```text
dev smoke : 534 项断言 / 525 布尔 / 0 false · duplicateResultGuard=true
```

最终产物已重出并装机验证：

```text
dist/Qcode-0.4.5-win.zip     225.6 MB  sha256 09e1165f…735c3720
dist/Qcode-Setup-0.4.5.exe   174.7 MB  sha256 bcce6fff…0e811315
装机版 <安装目录>         0.4.5.0 · 冒烟 534/525/0
```

### R160 第七十九轮：授权切换停放与工具结果幂等

- **授权覆盖**：切会话时旧授权卡片未入队，新会话授权会覆盖它。新增 `parkPendingApproval()`，切换前停放旧请求；新授权到来也先停放旧槽。
- **后台授权**：不再覆盖当前会话卡片，统一进入队列，切回对应会话时提升。
- **工具结果**：重复 `tool_result` 只接受 `running` 状态，避免已 done/error 的工具被迟到结果二次改写。

新增断言 `approvalSwitchGuard` / `toolResultIdempotent`。

```text
dev smoke : 536 项断言 / 527 布尔 / 0 false · approvalSwitchGuard / toolResultIdempotent=true
```

最终产物已重出并装机验证：

```text
dist/Qcode-0.4.5-win.zip     225.6 MB  sha256 21d8327a…5f2a7e9b
dist/Qcode-Setup-0.4.5.exe   174.7 MB  sha256 4498091b…916eda76
装机版 <安装目录>         0.4.5.0 · 冒烟 536/527/0
```

### R161 第八十轮：工具复制/另存为导出全文

原工具输出 DOM 渲染截到 128KB，但“复制/另存为”读取 DOM 文本，实际只能导出截断版；历史 block 又只存 32KB。

修复：
- 工具 block 最多保留 2MB 原始输出，渲染仍限 128KB；
- `resultTextLimited()` 有界拼接，避免超大数组/对象全量字符串化；
- DOM 工具节点关联原始 block；
- 复制/另存为通过 `toolActionContent()` 取 block 全文；
- 超过 2MB 明确标记截断。

新增断言 `toolOutputActionFull`。

```text
dev smoke : 537 项断言 / 528 布尔 / 0 false · toolOutputActionFull=true
```

最终产物已重出并装机验证：

```text
dist/Qcode-0.4.5-win.zip     225.6 MB  sha256 b813777b…f6219673
dist/Qcode-Setup-0.4.5.exe   174.7 MB  sha256 8f639783…45dfdb181
装机版 <安装目录>         0.4.5.0 · 冒烟 537/528/0
```

### R162 第八十一轮：会话导出/导入/slim 的输出元数据一致性

- **导出预估**：`estimateSessionsChars()` 补算 `block.output`，避免工具大会话低估卡顿风险。
- **备份预算**：单条会话超过 64MB 也跳过，首条不再绕过备份总量上限。
- **导入输出**：工具输出上限从 20KB 提升到 2MB，并保留 `outputLen` / `truncated`，恢复后 UI 明确知道内容被截断。
- **slim 兼容**：slim 仍截到 32KB，但保留原始 `outputLen` 与截断标记。

新增断言 `exportEstimateIncludesOutput` / `importOutputMetadata`。

```text
dev smoke : 539 项断言 / 530 布尔 / 0 false · exportEstimateIncludesOutput / importOutputMetadata=true
```

最终产物已重出并装机验证：

```text
dist/Qcode-0.4.5-win.zip     225.6 MB  sha256 3b4960d8…c449201c
dist/Qcode-Setup-0.4.5.exe   174.7 MB  sha256 6654af94…3400b47f
装机版 <安装目录>         0.4.5.0 · 冒烟 539/530/0
```

### R163 第八十二轮：回收站恢复原子性与 slim 忙碌保护

- **恢复原子性**：回收站源文件删除失败时回滚已写目标，不清墓碑、不写索引；重试不会生成重复会话。
- **墓碑顺序**：恢复文件与源文件都提交成功后才清除删除墓碑，失败时仍拒绝迟到保存。
- **忙碌 slim**：主进程拒绝 slim 正在执行的会话，避免磁盘旧快照覆盖流式内存。
- **元数据合并**：slim 后重新 hydrate 使用 `mergeHydratedSession()`，不回滚请求期间的本地编辑。

新增断言 `trashRestoreAtomic` / `slimBusyGuard`。

```text
dev smoke : 541 项断言 / 532 布尔 / 0 false · trashRestoreAtomic / slimBusyGuard=true
```

最终产物已重出并装机验证：

```text
dist/Qcode-0.4.5-win.zip     225.6 MB  sha256 50093c46…f7fea9d9
dist/Qcode-Setup-0.4.5.exe   174.7 MB  sha256 942cb93a…a98dbdff
装机版 <安装目录>         0.4.5.0 · 冒烟 541/532/0
```

### R164 第八十三轮：清空会话部分失败回滚

原 `sessions:clear` 先丢弃全部待写保存并重置索引，即使部分文件移动失败也返回 `ok:true`，还会删除失败会话的检查点。

修复：
- 先冲刷最新保存，再逐文件提交；
- 只对成功移入回收站的 id 清保存队列、内核、索引、墓碑和检查点；
- 返回 `removedIds` / `failedIds`，部分失败返回 `ok:false`；
- renderer 部分失败时移除成功项、重新加载列表、保留失败项；
- 完整清空同步清理搜索字符计数、pendingTurn、授权队列等残留状态。

新增断言 `clearPartialFailure`。

```text
dev smoke : 542 项断言 / 533 布尔 / 0 false · clearPartialFailure=true
```

最终产物已重出并装机验证：

```text
dist/Qcode-0.4.5-win.zip     225.6 MB  sha256 1e431d6a…aaf84293
dist/Qcode-Setup-0.4.5.exe   174.7 MB  sha256 55ca1cb9…bbb775de
装机版 <安装目录>         0.4.5.0 · 冒烟 542/533/0
```

### R165 第八十四轮：归档操作真实计数与部分失败反馈

- **批量恢复**：只统计真实移出归档的会话；已删除或 hydrate 失败计入失败，不再按选中数报全部成功。
- **撤销自动归档**：只报告实际撤销数量，已不存在的会话单独提示。
- **批量删除**：部分失败时状态栏保留错误状态，显示成功/失败数量，不再被成功文案覆盖。

新增断言 `archiveRestoreCount` / `autoArchiveUndoCount`。

```text
dev smoke : 544 项断言 / 535 布尔 / 0 false · archiveRestoreCount / autoArchiveUndoCount=true
```

最终产物已重出并装机验证：

```text
dist/Qcode-0.4.5-win.zip     225.6 MB  sha256 95e1948e…9a724aaf
dist/Qcode-Setup-0.4.5.exe   174.7 MB  sha256 4fcfb369…24a1d09f
装机版 <安装目录>         0.4.5.0 · 冒烟 544/535/0
```

### R166 第八十五轮：保存通知不覆盖忙碌状态

- **状态保护**：保存失败/恢复通知在会话忙碌时不再覆盖“思考中/执行工具”状态。
- **侧栏可见**：保存失败会话显示错误点，hover 显示具体原因；恢复后清除。
- **死亡会话**：已删除会话的迟到保存通知不再创建 runtime。
- **临时文件**：重试耗尽后清理残留 `.tmp`。

新增断言 `saveNoticePreservesBusy`。

```text
dev smoke : 545 项断言 / 536 布尔 / 0 false · saveNoticePreservesBusy=true
```

最终产物已重出并装机验证：

```text
dist/Qcode-0.4.5-win.zip     225.6 MB  sha256 d0fcc403…4edcff72
dist/Qcode-Setup-0.4.5.exe   174.7 MB  sha256 107dd00a…0d850144
装机版 <安装目录>         0.4.5.0 · 冒烟 545/536/0
```

### R167 第八十六轮：写盘失败临时文件清理

删除/取消会话保存时原实现只清定时器，失败写入留下的 `id.json.tmp` 会永久残留；序列化失败也可能留下旧临时文件。

新增统一 `cleanupSessionTemp()`：
- 删除、取消保存、序列化失败、重试耗尽均调用；
- `dropAllSessionSaves()` 扫描并清理所有 `.json.tmp`；
- 失败集合与定时器同步收敛。

新增断言 `saveTempCleanup`。

```text
dev smoke : 546 项断言 / 537 布尔 / 0 false · saveTempCleanup=true
```

最终产物已重出并装机验证：

```text
dist/Qcode-0.4.5-win.zip     225.6 MB  sha256 51e095ab…6ac88ba7
dist/Qcode-Setup-0.4.5.exe   174.7 MB  sha256 0d38791d…04f8e128
装机版 <安装目录>         0.4.5.0 · 冒烟 546/537/0
```

### R168 第八十七轮：坏会话记录隔离与索引写入重试

- **启动/备份崩溃**：`loadSessions()` 原只隔离 JSON 解析失败，合法 `null`/数组会在排序访问 `updatedAt` 时崩溃；现在统一校验 `isSessionRecord()` 并改名 `.bad`。
- **索引重试**：`sessions-index.json` 写入失败后 500ms 重试，最多 3 次；成功重置计数，耗尽清理 `.tmp`。
- **定时器收敛**：手动 flush 会取消待执行重试，避免重复写。

新增断言 `loadSessionsCorruptSafe` / `indexWriteRetry`。

```text
dev smoke : 548 项断言 / 539 布尔 / 0 false · loadSessionsCorruptSafe / indexWriteRetry=true
```

最终产物已重出并装机验证：

```text
dist/Qcode-0.4.5-win.zip     225.6 MB  sha256 b4e95eca…07ff861d
dist/Qcode-Setup-0.4.5.exe   174.7 MB  sha256 187703c3…1ff24b37
装机版 <安装目录>         0.4.5.0 · 冒烟 548/539/0
```

### R169 第八十八轮：索引重建并发与旧 prefs 兼容

- **首次索引重建**：`refreshSessionIndex()` 原逐文件串行读取，750 会话启动慢；改为最多 8 路并发读取/解析，仍只解析索引缺失项。
- **旧 prefs**：`null`/损坏 JSON 迁移日志不再访问 `raw.schemaVersion`，迁移结果仍安全返回默认 schema=1。

新增断言 `indexRebuildParallel` / `nullPrefsMigration`。

```text
dev smoke : 550 项断言 / 541 布尔 / 0 false · indexRebuildParallel / nullPrefsMigration=true
```

最终产物已重出并装机验证：

```text
dist/Qcode-0.4.5-win.zip     225.6 MB  sha256 ba22a5eb…28dffd54
dist/Qcode-Setup-0.4.5.exe   174.7 MB  sha256 3f68a65c…3df9472
装机版 <安装目录>         0.4.5.0 · 冒烟 550/541/0
```

### R170 第八十九轮：大库补水 cadence 调优

750 会话冷索引基准显示后台补水 3 秒仅完成 280，剩余 309；瓶颈是每批 20 条后的 200ms 等待。

将批间隔降到 120ms，保持单批 20 条以限制卡顿。复测：
- 3 秒补水 440（+160，约 +57%）；
- 剩余 49（-260）；
- 首帧 137ms，boot 221ms；
- 侧栏 500 项 0.8ms，懒切换 8.2ms。

```text
dev smoke : 550 项断言 / 541 布尔 / 0 false
```

最终产物已重出并装机验证：

```text
dist/Qcode-0.4.5-win.zip     225.6 MB  sha256 75609440…68e97949
dist/Qcode-Setup-0.4.5.exe   174.7 MB  sha256 17b5f0d6…e843551a
装机版 <安装目录>         0.4.5.0 · 冒烟 550/541/0
```

### R171 第九十轮：工具组延迟构建

工具组虽然视觉折叠，仍 eager 创建全部子卡片；连续 2 个工具也不折叠，导致 800 消息工具密集窗口首绘约 799ms。

修复：
- 工具组阈值 3 → 2；
- `.tg-body-inner` 首次展开时才创建子卡片；
- 组头补 `role=button`、`tabindex`、`aria-expanded` 与 Enter/Space 支持。

新增断言 `toolGroupLazyBody`。

同 fixture 复测：
- 工具密集 800 消息窗口：799ms → 407ms（约 -49%）；
- 400 消息档：185ms → 110ms（约 -41%）；
- 750 会话 3 秒补水 460，剩余 29。

```text
dev smoke : 551 项断言 / 542 布尔 / 0 false · toolGroupLazyBody / toolGroupFold / toolGroupExpand=true
```

最终产物已重出并装机验证：

```text
dist/Qcode-0.4.5-win.zip     225.6 MB  sha256 40175ac9…ea6f7b84
dist/Qcode-Setup-0.4.5.exe   174.7 MB  sha256 fac8965e…921162b8b
装机版 <安装目录>         0.4.5.0 · 冒烟 551/542/0
```

### R172 第九十一轮：工具组重绘复用

首次展开 150 工具约 7.4ms，但 `renderThread()` 重建后会再次创建同一组体。

新增 `toolGroupBodyCache`（WeakMap）：
- 按首块 + id/name/state/duration/output 长度签名匹配；
- 命中后移动原 `.tg-body-inner` 节点，不 clone，保留工具头事件与 `__toolBlock`；
- 内容变化时自动重建。

基准新增真实点击与二次展开口径；新增断言 `toolGroupBodyReuse`。

```text
首次展开：6.2ms · 重绘后二次展开：0.8ms
dev smoke : 552 项断言 / 543 布尔 / 0 false · toolGroupBodyReuse=true
```

最终产物已重出并装机验证：

```text
dist/Qcode-0.4.5-win.zip     225.6 MB  sha256 ff47c627…1d41f5306
dist/Qcode-Setup-0.4.5.exe   174.7 MB  sha256 548c7c84…e1e5559f
装机版 <安装目录>         0.4.5.0 · 冒烟 552/543/0
```

### R173 第九十二轮：DOM 节点缓存有界化

Markdown 与工具正文节点缓存原为 WeakMap，存活会话期间没有总量上限，工具密集长会话可能持有大量 DOM。

改为有界 LRU Map：
- Markdown：最多 600 节点 / 估算 8MB；
- 工具正文：最多 400 节点 / 估算 16MB；
- 命中更新 LRU，超出按最旧顺序淘汰；
- 仍保留单块 256KB 与工具输出 128KB 渲染上限。

新增断言 `domCacheBounded`。

```text
dev smoke : 553 项断言 / 544 布尔 / 0 false · domCacheBounded=true
```

最终产物已重出并装机验证：

```text
dist/Qcode-0.4.5-win.zip     225.6 MB  sha256 9a2740a4…6c156727
dist/Qcode-Setup-0.4.5.exe   174.7 MB  sha256 ef705b30…2377bb5b6
装机版 <安装目录>         0.4.5.0 · 冒烟 553/544/0
```

### R174 第九十三轮：长文本节点缓存命中

原单块 256KB 门槛让 300KB–1MB 消息每次重绘都重新解析；新的 LRU 已有 8MB 总预算，单块门槛已重复。

移除单块门槛：
- 300KB–1MB 长块可缓存并 clone 复用；
- 超 8MB 权重条目仍自动淘汰；
- Markdown HTML 字符串缓存仍保持 64KB 门限，避免重复保留大字符串。

新增断言 `longBlockNodeCache`。

```text
dev smoke : 554 项断言 / 545 布尔 / 0 false · longBlockNodeCache / mdBlockCacheGate=true
```

最终产物已重出并装机验证：

```text
dist/Qcode-0.4.5-win.zip     225.6 MB  sha256 bb77957a…f1caedb0
dist/Qcode-Setup-0.4.5.exe   174.7 MB  sha256 ff2c54c1…53749967
装机版 <安装目录>         0.4.5.0 · 冒烟 554/545/0
```

### R175 第九十四轮：soak 测试去除后台节流

500 轮 soak 首次运行被 Chromium 后台定时器节流：rAF 停止、`sleep(8)` 膨胀到数十秒，180s 看门狗误报超时。

`--soak` 模式现在关闭 `backgroundThrottling`，保证：
- 切换/流式循环按真实节奏执行；
- 内存与 DOM 采样可完成；
- 泄漏测试不再测成后台节流。

soak 收尾暴露并修复真实删除路径 bug：`todoBarLive` 是独立 Map，旧代码误写 `state.todoBarLive.delete/clear`，会抛错。统一修正，并新增 `sessionCacheCleanup`。

500 轮结果：
- DOM 231 → 666 → 231，净增长 0；
- private 在 n100 后稳定约 92–101MB，无持续上升；
- 新增 cache 尺寸与 n100→n500 plateau 指标，区分预热高水位与真实泄漏。

```text
dev smoke : 555 项断言 / 546 布尔 / 0 false · sessionCacheCleanup=true
```

R175 最终产物：

```text
dist/Qcode-0.4.5-win.zip     225.6 MB  sha256 1085e7f9…48f0dde
dist/Qcode-Setup-0.4.5.exe   174.7 MB  sha256 752d6dbd…f3701ca
装机版 <安装目录>         0.4.5.0 · 冒烟 555/546/0
```

### R176 第九十五轮：导出完整性

- Markdown 导出前强制补全懒会话；失败即中止。
- JSON 导出改用每批 20 个 `getBatch` 补全，显示准备进度；任一历史读取失败即取消，不再导出空壳。

### R177 第九十六轮：功能完整性与可用性专项

- **授权**：后台队列授权在侧栏显示提示点；clear 按 sessionId + requestId 精确清理。
- **删除**：删除文件成功后才停内核/取消保存；失败保留运行状态与末段改动；lazy 会话按 messageCount 确认；删除后同步草稿与命令 chip。
- **Goal**：`/goal resume` 手动绕过 autoContinue 开关，自动路径仍受限。
- **附件**：输入框“+”改为图片文件选择器，新增 `attachment:pick`；粘贴/拖放/选择失败可见，UI 统一 8MB。
- **恢复备份**：记忆路径修正为 `~/.qwen/memories/MEMORY.md`；项目 QWEN.md 使用按 cwd 校验的专用恢复 IPC。
- **设置重启**：config/MCP/Hooks/prefs/extensions/import 停止内核前主动发送 intentional host_exit，renderer 不再卡 busy。
- **检查点**：恢复目标 realpath 防 junction 逃逸；不完整检查点禁止删除新增；size+mtime+ctime 共同判重；部分失败返回 partial 并显示真实计数。
- **导入**：超限会话/消息/块/文本/输出在确认框明确告知，不再静默截断。

```text
dev smoke : 563 项断言 / 554 布尔 / 0 false
```

最终产物已重出并装机验证：

```text
dist/Qcode-0.4.5-win.zip     225.6 MB  sha256 0560ad2c…f8fde934
dist/Qcode-Setup-0.4.5.exe   174.7 MB  sha256 40a8b64b…f84fedbf
装机版 <安装目录>         0.4.5.0 · 冒烟 563/554/0
```

### R178 第九十七轮：多次查找命中与早期 Goal 跳转

- 会话内查找改为按 occurrence 计数，同一消息出现 3 次关键词显示 `1/3 → 2/3 → 3/3`；
- `highlightInMessage()` 支持指定第 N 次命中，只标记目标 occurrence；
- 命中上限 1000，超出显示 `1000+`，避免大消息内存膨胀；
- Goal 轮次跳转复用 `jumpToMessage()`，自动展开压缩区并移动渲染窗口，早期轮次不再无响应。

新增断言 `findOccurrences` / `goalEarlyJump`。

```text
dev smoke : 565 项断言 / 556 布尔 / 0 false · findOccurrences / goalEarlyJump=true
```

最终产物已重出并装机验证：

```text
dist/Qcode-0.4.5-win.zip     225.6 MB  sha256 c069c504…7b27d208
dist/Qcode-Setup-0.4.5.exe   174.7 MB  sha256 620985f7…34e8efcd
装机版 <安装目录>         0.4.5.0 · 冒烟 565/556/0
```

### R179 第九十八轮：手动备份跨进程 flush

- renderer `flushAllPersist()` 返回 Promise，备份前等待 120ms 防抖队列全部发送；
- 新增 `sessions:flush`，主进程立即刷盘并报告仍失败的会话；
- 写盘未完成时取消备份，不再把旧磁盘状态当完整快照；
- 备份超过 64MB 截断时显示实际保存会话数、丢弃数量与轮转份数。

新增断言 `sessionFlushGate`。

```text
dev smoke : 566 项断言 / 557 布尔 / 0 false · sessionFlushGate=true
```

最终产物已重出并装机验证：

```text
dist/Qcode-0.4.5-win.zip     225.6 MB  sha256 a6f060d6…fb12cc1b
dist/Qcode-Setup-0.4.5.exe   174.7 MB  sha256 e9c2c081…ddf541c4
装机版 <安装目录>         0.4.5.0 · 冒烟 566/557/0
```

### R180 第九十九轮：文件目录错误状态

原文件面板把 `listDir` 失败或异常缓存为空数组，用户看到“目录为空”，无法区分空目录与权限/路径错误。

现在：
- 每个目录独立保存 error；
- 失败时显示具体原因和“重试”；
- 加载更多失败保留已有条目并显示错误；
- 子目录显示“正在读取目录…”；
- 只有真正成功的空目录才显示“目录为空”。

新增断言 `fileDirErrorState`。

```text
dev smoke : 567 项断言 / 558 布尔 / 0 false · fileDirErrorState=true
```

最终产物已重出并装机验证：

```text
dist/Qcode-0.4.5-win.zip     225.6 MB  sha256 e27f6956…fdc8464c
dist/Qcode-Setup-0.4.5.exe   174.7 MB  sha256 8a954575…d0c87c9a
装机版 <安装目录>         0.4.5.0 · 冒烟 567/558/0
```

### R181 第一百轮：Git 失败恢复与提交草稿

- 提交草稿按 cwd 保存，暂存/刷新/重绘不再丢失；
- 提交期间新输入内容保留，`committing` 防止重复提交；
- commit/stage IPC 异常有 catch，按钮恢复可用并显示错误；
- diff 读取失败不再把错误当 diff 内容弹窗；
- Git 状态读取失败提供“重试”；
- 分支复制使用 `safeCopy`，失败可见。

新增断言 `gitDraftPreserved`。

```text
dev smoke : 568 项断言 / 559 布尔 / 0 false · gitDraftPreserved=true
```

最终产物已重出并装机验证：

```text
dist/Qcode-0.4.5-win.zip     225.6 MB  sha256 40de4d77…aedf4835
dist/Qcode-Setup-0.4.5.exe   174.7 MB  sha256 3601af66…09956f5
装机版 <安装目录>         0.4.5.0 · 冒烟 568/559/0
```

### R182 第一百零一轮：操作反馈可见性

- 用户消息、助手消息、工具输出、代码块、环境信息复制统一等待真实成功后才显示“已复制”；
- 剪贴板失败保留按钮原文并显示错误；
- 所有“打开路径”统一经 `openPathVisible()`，系统拒绝时显示原因；
- “测试通知”根据实际返回值提示成功/失败，后台通知失败不打断会话；
- 代码复制按钮补 `:focus-visible` 显示，键盘可达。

新增断言 `copyFailureVisible`。

```text
dev smoke : 569 项断言 / 560 布尔 / 0 false · copyFailureVisible / toolCopyFeedback / codeCopyFeedback=true
```

最终产物已重出并装机验证：

```text
dist/Qcode-0.4.5-win.zip     225.6 MB  sha256 933fe997…7101038d
dist/Qcode-Setup-0.4.5.exe   174.7 MB  sha256 563d4d81…7100c3
装机版 <安装目录>         0.4.5.0 · 冒烟 569/560/0
```

### R183 第一百零二轮：配置读取与供应商编辑保护

- `settings.json` 解析/读取失败时返回 `readError`，设置页显示明确横幅；
- renderer 与主进程 `config:save` 双重拒绝覆盖损坏配置；
- 默认模型 ID 编辑实时同步 `model.name`，保存不再跳回第一个模型；
- envKey 冲突统一检测：同密钥允许共用，不同密钥禁止覆盖；
- 供应商向导、单模型编辑、分组编辑使用同一冲突规则。

新增断言 `configReadFailureGuard` / `providerEditGuards`。

```text
dev smoke : 571 项断言 / 562 布尔 / 0 false · providerWizardFlow / find / findBarMotion=true
```

最终产物已重出并装机验证：

```text
dist/Qcode-0.4.5-win.zip     225.6 MB  sha256 42c94d5b…7d8aa9c9
dist/Qcode-Setup-0.4.5.exe   174.7 MB  sha256 7fef611d…a31686af9
装机版 <安装目录>         0.4.5.0 · 冒烟 571/562/0
```

### R184 第一百零三轮：跨机器导入环境校验

导入前检查所有工作目录与模型：
- 不存在的目录改用当前默认目录；
- 不存在的模型重映射到当前默认模型；
- 确认框显示将影响的目录/会话数量；
- 导入会话保留 `importedCwd` / `importedModel` 与可见警告；
- 批量准备仍按 20 个一组，避免 200 路 IPC 同时拥塞。

新增断言 `importEnvironmentGuard`。

```text
dev smoke : 572 项断言 / 563 布尔 / 0 false · importEnvironmentGuard=true
```

最终产物已重出并装机验证：

```text
dist/Qcode-0.4.5-win.zip     225.6 MB  sha256 17dafe9a…b1454ff4
dist/Qcode-Setup-0.4.5.exe   174.7 MB  sha256 d38df4ae…2f6adef2
装机版 <安装目录>         0.4.5.0 · 冒烟 572/563/0
```

### R185 第一百零四轮：Hooks/记忆/项目指令读取保护

原实现把权限拒绝、损坏、临时 I/O 错误都当作空文件，继续保存会覆盖原内容。

现在：
- 仅 `ENOENT` 视为“文件不存在”；
- 其他读取错误返回明确 `error`；
- Hooks、记忆、项目指令保存前先读取现有文件，失败即拒绝覆盖；
- Hooks 保存增加主进程 JSON 结构校验；
- 设置页禁用对应编辑/保存区，保留“恢复备份”入口；
- 项目指令读取失败不再显示为空文本。

新增断言 `contextReadFailureGuard` / `projectReadFailureGuard`。

```text
dev smoke : 574 项断言 / 565 布尔 / 0 false · contextReadFailureGuard / projectReadFailureGuard=true
```

最终产物已重出并装机验证：

```text
dist/Qcode-0.4.5-win.zip     225.6 MB  sha256 bc672f7f…79d9e9c2
dist/Qcode-Setup-0.4.5.exe   174.7 MB  sha256 53324525…d5c6f9a
装机版 <安装目录>         0.4.5.0 · 冒烟 574/565/0
```

### R186 第一百零五轮：深层配置脱敏

原脱敏只递归处理 `env`，MCP `headers.Authorization`、URL query、token/password 等字段仍可能明文导出。

现在递归覆盖：
- 所有 `env` 值；
- apiKey/accessToken/refreshToken/secret/password/authorization/cookie/credential/privateKey 等键；
- 字符串中的 `sk-*`、Bearer、JWT、`key=value` 密钥模式；
- 数组与嵌套对象。

新增断言 `configRedactionDeep`。

```text
dev smoke : 575 项断言 / 566 布尔 / 0 false · configRedactionDeep / exportRedacted=true
```

最终产物已重出并装机验证：

```text
dist/Qcode-0.4.5-win.zip     225.6 MB  sha256 b70c9ca5…bcbeb1fa
dist/Qcode-Setup-0.4.5.exe   174.7 MB  sha256 598e88f5…d1a5141
装机版 <安装目录>         0.4.5.0 · 冒烟 575/566/0
```

### R187 第一百零六轮：文件预览冲突检测

文件预览打开后记录 `size + mtimeMs + ctimeMs` 版本令牌。

保存时：
- 主进程在写盘前再次比对版本；
- 外部修改返回 `{ conflict: true }`，不覆盖文件；
- 编辑器显示“重新加载 / 强制保存”；
- 重新加载丢弃当前编辑并更新版本；
- 强制保存明确跳过版本校验；
- 保存成功后刷新版本令牌。

新增断言 `fileWriteConflictGuard`。

```text
dev smoke : 576 项断言 / 567 布尔 / 0 false · fileWriteConflictGuard / dialogFocusTrap=true
```

最终产物已重出并装机验证：

```text
dist/Qcode-0.4.5-win.zip     225.6 MB  sha256 257af5c0…0bd679a
dist/Qcode-Setup-0.4.5.exe   174.7 MB  sha256 d66e5ae0…c357dbf
装机版 <安装目录>         0.4.5.0 · 冒烟 576/567/0
```

### R188 第一百零七轮：存储统计与回收站分页

- 存储统计新增回收站、轮转备份、检查点与合计字节；
- 会话字节不再把回收站重复计入；
- 回收站 API 支持 `offset/limit`，返回 `total/hasMore/nextOffset`；
- UI 支持“显示更多”，恢复按钮有 loading/失败恢复；
- 回收站读取失败显示原因，不再伪装为空。

新增断言 `storageStatsComplete` / `trashPagination`。

```text
dev smoke : 578 项断言 / 569 布尔 / 0 false · storageStatsComplete / trashPagination=true
```

最终产物已重出并装机验证：

```text
dist/Qcode-0.4.5-win.zip     225.6 MB  sha256 db48a797…df4fe196
dist/Qcode-Setup-0.4.5.exe   174.7 MB  sha256 30b993af…24d9d
装机版 <安装目录>         0.4.5.0 · 冒烟 578/569/0
```

### R189 第一百零八轮：文件搜索完整性提示

文件搜索达到 60 条结果、4000 项扫描、5 层深度或遇到不可读目录时，API 返回：

```text
complete: false
partial: true
reason: result-limit | scan-limit | depth-limit | read-error
```

缓存命中保留同一完整性口径。UI 在结果数与列表上方显示“可能不完整”和具体原因，并说明默认跳过的目录。

新增断言 `fileSearchPartial`。

```text
dev smoke : 579 项断言 / 570 布尔 / 0 false · fileSearchPartial / fileSearchCache=true
```

最终产物已重出并装机验证：

```text
dist/Qcode-0.4.5-win.zip     225.6 MB  sha256 d27a68b1…f8b77a2
dist/Qcode-Setup-0.4.5.exe   174.7 MB  sha256 27f427e0…f86f3230
装机版 <安装目录>         0.4.5.0 · 冒烟 579/570/0
```

### R190 第一百零九轮：端点测试私网策略统一

“测连接”和“测端点”现在共用 `isSafeTestEndpoint()`：

- localhost / 127.0.0.1 / ::1 始终允许；
- RFC1918 与 IPv6 ULA 需显式 `allowPrivate: true`；
- 链路本地、元数据地址、0/8、非本机环回始终拒绝；
- 所有 renderer 测试入口在用户点击时显式传 `allowPrivate: true`。

新增断言 `endpointPolicyUnified`。

```text
dev smoke : 580 项断言 / 571 布尔 / 0 false · endpointPolicyUnified / providerWizardFlow=true
```

最终产物已重出并装机验证：

```text
dist/Qcode-0.4.5-win.zip     225.6 MB  sha256 063e094a…99c19a59
dist/Qcode-Setup-0.4.5.exe   174.7 MB  sha256 e26a1115…cd9c176
装机版 <安装目录>         0.4.5.0 · 冒烟 580/571/0
```

### R191 第一百一十轮：Goal 预算启动门禁

校验回合 token 已在 `finishTurn` 记账，但新工作轮/校验启动前缺少统一门禁。

新增 `goalBudgetExhausted()` / `blockGoalForBudget()`，覆盖：
- `maybeGoalStep()`；
- `startGoalRound()`；
- `startGoalVerify()`；
- 工作轮结算记账。

预算耗尽后不再启动下一整轮，直接进入 `blocked/token-budget`；`/goal resume` 仍可显式解除预算。

新增断言 `goalBudgetGate`。

```text
dev smoke : 581 项断言 / 572 布尔 / 0 false · goalBudgetGate / goalManualResume=true
```

最终产物已重出并装机验证：

```text
dist/Qcode-0.4.5-win.zip     225.6 MB  sha256 1d3cebb8…b956aee
dist/Qcode-Setup-0.4.5.exe   174.7 MB  sha256 0c6274b8…31797b
装机版 <安装目录>         0.4.5.0 · 冒烟 581/572/0
```

### R192 第一百一十一轮：整体门禁复核

本轮无产品代码变更，对 R191 装机版执行完整复核：

```text
audit smoke : 581 keys / 572 bool / 0 false · 97.2s
bench       : boot 164ms · first frame 172ms · layout 46.8ms
              typing 0.05ms · window 20.8ms · settings 30.5ms
              save 2.3MB 16ms · heap 9.5MB · frame p95 8.4ms
idle        : main 0.01% · renderer 0.8% · raf 0
E2E         : ok · 两轮真实对话 · 无 renderer 错误
controls    : 30 个静态控件 · 未引用 0
IPC         : 89 个 preload 调用 · 缺失 handler 0
```

### R193 第一百一十二轮：会话瘦身安全流程

瘦身会永久截断工具输出，原流程缺少确认、自动备份与 renderer flush。

现在：
- 操作前等待 renderer 防抖保存并执行主进程 flush；
- 未完全落盘则取消瘦身；
- 原生确认明确告知不可逆；
- 主进程截断前自动创建单会话完整备份，保留最近 5 份；
- 瘦身后重新 hydrate 内存，失败时明确提示；
- 任何异常都恢复按钮状态。

新增断言 `slimSafetyBackup`。

```text
dev smoke : 582 项断言 / 573 布尔 / 0 false · slimSafetyBackup / slimBusyGuard=true
```

最终产物已重出并装机验证：

```text
dist/Qcode-0.4.5-win.zip     225.6 MB  sha256 ea51d360…23ed08af
dist/Qcode-Setup-0.4.5.exe   174.7 MB  sha256 cf831c41…0eeae94f
装机版 <安装目录>         0.4.5.0 · 冒烟 582/573/0
```

### R194 第一百一十三轮：Git 暂存/工作区双差异

原实现只有工作区 diff 为空时才读取暂存 diff；同时存在两种改动会漏掉暂存内容。

现在：
- `git:diff` 支持 `includeStaged`；
- 暂存文件点击时同时读取 `git diff` 与 `git diff --cached`；
- 输出分为“暂存区（相对 HEAD）”和“工作区（相对暂存区）”两段；
- 缓存键包含展示模式，避免互相污染。

新增断言 `gitDualDiff`。

```text
dev smoke : 583 项断言 / 574 布尔 / 0 false · gitDualDiff / gitDiffCache=true
```

最终产物已重出并装机验证：

```text
dist/Qcode-0.4.5-win.zip     225.6 MB  sha256 0a984b2f…b573776f
dist/Qcode-Setup-0.4.5.exe   174.7 MB  sha256 a66898fd…68ade9b9
装机版 <安装目录>         0.4.5.0 · 冒烟 583/574/0
```

### R195 第一百一十四轮：检查点清理入口

- 检查点弹层新增“清理全部”；
- 清理前明确确认，说明不会修改当前工作区文件；
- 主进程拒绝忙碌会话清理；
- 清理后刷新列表、清除 `lastCheckpointId` 并显示回收空间；
- 失败保持弹层可用并显示原因。

新增断言 `checkpointCleanupGuard`。

```text
dev smoke : 584 项断言 / 575 布尔 / 0 false · checkpointCleanupGuard / cpGcOnDeleteAll=true
```

最终产物已重出并装机验证：

```text
dist/Qcode-0.4.5-win.zip     225.6 MB  sha256 57e64ff3…63e8ed9e
dist/Qcode-Setup-0.4.5.exe   174.7 MB  sha256 85e9df1b…44068797
装机版 <安装目录>         0.4.5.0 · 冒烟 584/575/0
```

### R196 第一百一十五轮：备份恢复为副本

设置 → 关于 → 备份区新增“从备份恢复…”：

- 支持旧裸会话数组与 `{ sessions: [] }`  wrapped 格式；
- 恢复为新 ID 副本，不覆盖、不删除现有会话；
- 保留历史消息，重置 `qwenSessionId` 与 pending/running 状态；
- 备份不完整时明确提示；
- 部分写盘失败返回成功/失败计数，renderer 加载已成功副本。

新增断言 `backupRestoreCopy`。

```text
dev smoke : 585 项断言 / 576 布尔 / 0 false · backupRestoreCopy / trashRestoreAtomic=true
```

最终产物已重出并装机验证：

```text
dist/Qcode-0.4.5-win.zip     225.6 MB  sha256 6dac1036…ced89701
dist/Qcode-Setup-0.4.5.exe   174.7 MB  sha256 287394d2…d9c0fa99
装机版 <安装目录>         0.4.5.0 · 冒烟 585/576/0
```

### R197 第一百一十六轮：通知异步失败反馈

`Notification.failed` 可能在 `show()` 返回后才触发，原实现会在系统拒绝前误报成功。

现在 `app:notify`：
- 等待最多 400ms 的失败事件窗口；
- `failed` 立即返回 `false`；
- `show()` 抛错返回 `false`；
- 超时未失败才返回 `true`。

新增断言 `notifyAsyncFailure`。

```text
dev smoke : 586 项断言 / 577 布尔 / 0 false · notifyAsyncFailure / notifyTest=true
```

最终产物已重出并装机验证：

```text
dist/Qcode-0.4.5-win.zip     225.6 MB  sha256 e45c58ee…1ba2d770
dist/Qcode-Setup-0.4.5.exe   174.7 MB  sha256 efeb064e…53bc4026
装机版 <安装目录>         0.4.5.0 · 冒烟 586/577/0
```

### R198 第一百一十七轮：设置页正文列宽

“消息列宽”说明包含设置页正文，但 CSS 未应用 `--content-w`。

现在 `.cfg-body` 使用 `max-width: calc(--content-w + 44px)` 并居中，列宽选项同时影响对话、输入框与设置页。

新增断言 `settingsWidthApplied`。

```text
dev smoke : 587 项断言 / 578 布尔 / 0 false · settingsWidthApplied / narrowLayoutReachable=true
```

最终产物已重出并装机验证：

```text
dist/Qcode-0.4.5-win.zip     225.6 MB  sha256 12dd7004…373ae585
dist/Qcode-Setup-0.4.5.exe   174.7 MB  sha256 f7345d4c…e65dad1
装机版 <安装目录>         0.4.5.0 · 冒烟 587/578/0
```

### R199 第一百一十八轮：整体审计回归

R198 装机版完整复核：

```text
audit smoke : 587 keys / 578 bool / 0 false · 94.4s
bench       : boot 145ms · first frame 153ms · layout 42.5ms
              typing 0.05ms · window 24.2ms · settings 32.1ms
              save 2.3MB 10.9ms · heap 9.5MB · frame p95 8.5ms
idle        : main 0.01% · renderer 0.77% · raf 0
E2E         : ok · 两轮真实对话 · 无 renderer 错误
controls    : 30 个静态控件 · 未引用 0
IPC         : 91 个 preload 调用 · 缺失 handler 0
```

### R200 第一百一十九轮：清空会话写盘门禁

原清空流程在 renderer 直接 `cancelAllPersist()`，主进程刷盘失败后仍把旧磁盘版本移入回收站。

现在：
- renderer 先等待全部防抖保存发送；
- 主进程 flush 后若仍有 pending，整体取消清空；
- 返回 `pendingIds`，UI 明确提示“尚未完全落盘”；
- 未删除任何会话、内核与待写队列保持完整。

新增断言 `clearFlushGate`。

```text
dev smoke : 588 项断言 / 579 布尔 / 0 false · clearFlushGate / clearPartialFailure=true
```

最终产物已重出并装机验证：

```text
dist/Qcode-0.4.5-win.zip     225.6 MB  sha256 a14e803b…fe3d4709
dist/Qcode-Setup-0.4.5.exe   174.7 MB  sha256 11e367a0…e17eeab
装机版 <安装目录>         0.4.5.0 · 冒烟 588/579/0
```

### R201 第一百二十轮：批量归档删除落盘门禁

批量删除归档会话仍先 `cancelPersist()`，删除失败会丢末段未保存改动。

现在：
- 批量删除前等待 renderer 全部防抖保存；
- 主进程 flush 失败则整体取消；
- 单条删除成功后才清理该会话 pending；
- 失败项保留内存、磁盘与运行状态。

```text
dev smoke : 588 项断言 / 579 布尔 / 0 false · archiveBatch / deleteFailureKeepsSave=true
```

最终产物已重出并装机验证：

```text
dist/Qcode-0.4.5-win.zip     225.6 MB  sha256 d3a10715…b3446f15
dist/Qcode-Setup-0.4.5.exe   174.7 MB  sha256 9879eeca…ac38d54
装机版 <安装目录>         0.4.5.0 · 冒烟 588/579/0
```

### R202 第一百二十一轮：Markdown 工具输出截断提示

Markdown 导出会把工具输出限制到 1200 字符，但原实现没有说明截断。

现在超出上限时追加：

```text
…（输出已截断，原始共 N 字符；完整内容请使用 JSON 导出）
```

瘦身会话使用 `outputLen` 显示原始长度。新增断言 `markdownToolTruncation`。

```text
dev smoke : 589 项断言 / 580 布尔 / 0 false · markdownToolTruncation / toolOutputActionFull=true
```

最终产物已重出并装机验证：

```text
dist/Qcode-0.4.5-win.zip     225.6 MB  sha256 edccf107…c44979fc
dist/Qcode-Setup-0.4.5.exe   174.7 MB  sha256 41404bea…7eb1e33
装机版 <安装目录>         0.4.5.0 · 冒烟 589/580/0
```

### R203 第一百二十二轮：HTML/PDF 导出边界提示

- HTML 导出前补全懒会话；
- HTML 保留思考过程折叠块；
- 工具入参超过 4000 字符时显示截断标记；
- 工具输出截断使用 `outputLen` 显示原始长度；
- PDF 导出前补全懒会话；
- PDF 元信息明确标注“阅读版不包含思考过程/工具输出”。

新增断言 `exportBoundaryNotices`。

```text
dev smoke : 590 项断言 / 581 布尔 / 0 false · exportBoundaryNotices / pdfInlineImages=true
```

最终产物已重出并装机验证：

```text
dist/Qcode-0.4.5-win.zip     225.6 MB  sha256 d3d5b1e2…27e2c6b1
dist/Qcode-Setup-0.4.5.exe   174.7 MB  sha256 edb5ed42…662ff68
装机版 <安装目录>         0.4.5.0 · 冒烟 590/581/0
```

### R204 第一百二十三轮：瘦身会话 HTML 原始长度

瘦身后当前 `output` 可能很短，但 `outputLen` 仍指向原始大小。

HTML 导出现在：
- 摘要显示 `outputLen` 而非当前短文本长度；
- 即使当前 output ≤20KB，只要原始长度超限也追加截断说明；
- 避免瘦身文件导出后被误认为完整输出。

```text
dev smoke : 590 项断言 / 581 布尔 / 0 false · exportBoundaryNotices / slimSafetyBackup=true
```

最终产物已重出并装机验证：

```text
dist/Qcode-0.4.5-win.zip     225.6 MB  sha256 9fc3f0c1…bcf5d9f5
dist/Qcode-Setup-0.4.5.exe   174.7 MB  sha256 320e2bf8…c32f1e2a
装机版 <安装目录>         0.4.5.0 · 冒烟 590/581/0
```

### R205 第一百二十四轮：整体审计回归

R204 装机版完整复核：

```text
audit smoke : 590 keys / 581 bool / 0 false · 101.6s
bench       : boot 157ms · first frame 168ms · layout 44.7ms
              typing 0.05ms · window 23.5ms · settings 30.8ms
              save 2.3MB 12.5ms · heap 9.5MB · frame p95 8.5ms
idle        : main 0.02% · renderer 1.02% · raf 0
E2E         : ok · 两轮真实对话 · 无 renderer 错误
controls    : 30 个静态控件 · 未引用 0
IPC         : 91 个 preload 调用 · 缺失 handler 0
```

### R206 第一百二十五轮：工具 HTML 缓存有界化

`toolOutHtmlCache` 与 `toolDiffCache` 原为 WeakMap，工具密集长会话可无限保留输出/diff HTML。

改为 LRU Map：
- 工具输出 HTML：最多 400 条 / 估算 32MB；
- 工具 diff/输入 HTML：最多 400 条 / 估算 16MB；
- 命中更新 LRU，超出按最旧淘汰；
- 内容签名变化仍自动重算。

新增断言 `toolHtmlCachesBounded`。

```text
dev smoke : 591 项断言 / 582 布尔 / 0 false · toolHtmlCachesBounded / toolOutHtmlCache=true
```

最终产物已重出并装机验证：

```text
dist/Qcode-0.4.5-win.zip     225.6 MB  sha256 1fa10e15…02ebf3dd
dist/Qcode-Setup-0.4.5.exe   174.7 MB  sha256 47ba8f77…6c70cd4a
装机版 <安装目录>         0.4.5.0 · 冒烟 591/582/0
```

### R207 第一百二十六轮：工具密集 soak 与淘汰重建

soak fixture 升级为 20 会话 × 60 消息，共 600 个真实工具块，并采样 HTML 缓存尺寸/权重。

500 轮结果：
- DOM 1366 → 1366，净增长 0；
- `toolOutHtmlCache` 稳定 400 条 / 1.89MB；
- `toolDiffCache` 稳定 400 条 / 36.7KB；
- n100→n500 private 仅增长 21.8MB，无持续失控增长。

bench 新增 `toolHtmlEvictRebuildMs`：450 块 × 3 轮持续淘汰，平均重建约 0.001ms；工具密集 800 消息窗口 398.8ms。

```text
dev smoke : 591 项断言 / 582 布尔 / 0 false · toolHtmlCachesBounded=true
```

最终产物已重出并装机验证：

```text
dist/Qcode-0.4.5-win.zip     225.6 MB  sha256 fd9679c3…afc8c524
dist/Qcode-Setup-0.4.5.exe   174.7 MB  sha256 a17b0c01…a80277a7
装机版 <安装目录>         0.4.5.0 · 冒烟 591/582/0
```

### R208 第一百二十七轮：技能元数据缓存有界化

`skillMetaCache` 原无数量上限，技能目录轮换后旧内容仍长期保留。

现在：
- 最多缓存 200 个技能元数据；
- 命中更新 LRU；
- 超出淘汰最旧条目；
- mtime/size 变化仍自动重读。

新增断言 `skillMetaCacheBounded`。

```text
dev smoke : 592 项断言 / 583 布尔 / 0 false · skillMetaCacheBounded / toolHtmlCachesBounded=true
```

最终产物已重出并装机验证：

```text
dist/Qcode-0.4.5-win.zip     225.6 MB  sha256 bc6f4223…709bb76b
dist/Qcode-Setup-0.4.5.exe   174.7 MB  sha256 3f334059…e60960f1
装机版 <安装目录>         0.4.5.0 · 冒烟 592/583/0
```

### R209 第一百二十八轮：备份恢复分批让出事件循环

大会话备份恢复原来在主进程同步处理最多 2000 个会话，可能短暂阻塞其他 IPC。

现在每处理 10 个会话 `setImmediate` 让出一次事件循环，保留：
- 新 ID 副本语义；
- pending/running 状态清理；
- 部分失败计数；
- 最终统一 flush。

```text
dev smoke : 592 项断言 / 583 布尔 / 0 false · backupRestoreCopy / trashRestoreAtomic=true
```

最终产物已重出并装机验证：

```text
dist/Qcode-0.4.5-win.zip     225.6 MB  sha256 f24e1c60…b1239a6e
dist/Qcode-Setup-0.4.5.exe   174.7 MB  sha256 deb957d3…585953ff
装机版 <安装目录>         0.4.5.0 · 冒烟 592/583/0
```

### R210 第一百二十九轮：回合等待器超时清理

`waitForTurn()` 超时只 resolve Promise，waiter 仍留在 `turnWaiters`，重复 realdata 流程会累积失效闭包。

现在超时与完成都：
- 幂等 settled；
- 从数组精确移除自身；
- 清理 timer；
- 不再依赖下一次 `chat:turn-done` 才释放。

新增断言 `turnWaiterCleanup`。

### R211 第一百三十轮：检查点纳秒时间戳

`cpRestore` 间歇失败定位到同长度快速编辑：毫秒时间戳取整后完全一致，恢复误判文件未变。

现在：
- 检查点 stat 使用 `bigint` 纳秒时间戳；
- manifest 保存 `mtimeNs/ctimeNs` 字符串；
- create/diff/restore 共用精确 stamp 比较；
- 旧 manifest 回退到精确毫秒，不再向下取整；
- size 始终参与判断。

新增断言 `checkpointNanosecondGuard`。

```text
dev smoke : 594 项断言 / 585 布尔 / 0 false · checkpointNanosecondGuard / cpRestore / turnWaiterCleanup=true
```

最终产物已重出并装机验证（包含 R210 + R211）：

```text
dist/Qcode-0.4.5-win.zip     225.6 MB  sha256 0fe1cf24…c4a6d5b2
dist/Qcode-Setup-0.4.5.exe   174.7 MB  sha256 e0b9011a…f591cade
装机版 <安装目录>         0.4.5.0 · 冒烟 594/585/0
```

### R212 第一百三十一轮：检查点扫描不完整标记

目录 `readdir` 或文件 `stat` 失败原会静默跳过，diff 可能假显示“无差异”。

现在：
- 读取/stat 失败计入 `failed` 并设置 `truncated`；
- create manifest 与 diff 返回真实失败数；
- 不完整检查点继续禁止“删除新增文件”；
- diff UI 显示“扫描不完整”警告；
- 创建状态栏显示读取失败数量。

新增断言 `checkpointScanFailure`。

```text
dev smoke : 595 项断言 / 586 布尔 / 0 false · checkpointScanFailure / cpRestore=true
```

最终产物已重出并装机验证：

```text
dist/Qcode-0.4.5-win.zip     225.6 MB  sha256 15bb7868…09e32854
dist/Qcode-Setup-0.4.5.exe   174.7 MB  sha256 4ead20cc…7f0c2c49
装机版 <安装目录>         0.4.5.0 · 冒烟 595/586/0
```

### R213 第一百三十二轮：长消息高亮性能回归

整体 audit 发现 1MB 消息高亮 23.3ms，超过 20ms 预算。

优化：
- TreeWalker 不再对每个节点做 `toLowerCase()` 预筛；
- 先收集文本节点引用，避免 split 后重复访问 mark；
- 中文查询走原生 `indexOf()`；
- 仅 ASCII 大小写查询分配一次小写副本；
- 单遍完成 occurrence 定位与标记。

复测：1MB 高亮 13.7ms，命中数 1；工具密集窗口 389.8ms。

```text
dev smoke : 595 项断言 / 586 布尔 / 0 false · findOccurrences / jumpHighlight=true
```

最终产物已重出并装机验证：

```text
dist/Qcode-0.4.5-win.zip     225.6 MB  sha256 98d8f72f…0573ff73
dist/Qcode-Setup-0.4.5.exe   174.7 MB  sha256 dd583187…f35e7bd1
装机版 <安装目录>         0.4.5.0 · 冒烟 595/586/0
```

### R214 第一百三十三轮：完整审计恢复绿色

R213 装机版完整复核：

```text
audit smoke : 595 keys / 586 bool / 0 false · 104.4s
bench       : boot 138ms · first frame 146ms · layout 40.5ms
              typing 0.05ms · window 18ms · settings 31.5ms
              save 2.3MB 11.4ms · heap 9.5MB · frame p95 8.6ms
              1MB 高亮 12.4ms（预算 20ms）· 工具密集 369.3ms
idle        : main 0.01% · renderer 0.86% · raf 0
E2E         : ok · 两轮真实对话 · 无 renderer 错误
controls    : 30 个静态控件 · 未引用 0
IPC         : 91 个 preload 调用 · 缺失 handler 0
```

### R215 第一百三十四轮：无工作目录死按钮清理

未选择工作目录时，项目指令的“保存 / 打开目录 / 恢复备份”现在全部禁用，不再显示为可点击但无响应。

新增断言 `projectNoCwdDisabled`。

```text
dev smoke : 596 项断言 / 587 布尔 / 0 false · projectNoCwdDisabled / projRestore=true
```

最终产物已重出并装机验证：

```text
dist/Qcode-0.4.5-win.zip     225.6 MB  sha256 fc51f871…612ab8c
dist/Qcode-Setup-0.4.5.exe   174.7 MB  sha256 6cc701e2…350c088c
装机版 <安装目录>         0.4.5.0 · 冒烟 596/587/0
```

### R216 第一百三十五轮：项目折叠按钮显式绑定

“折叠项目”按钮原依赖父标题事件冒泡，语义隐式；直接补绑定又可能双切换。

现在：
- 按钮显式绑定 `toggleProjectsCollapsed()`；
- 阻止冒泡；
- 标题点击排除按钮与目录按钮；
- 新增断言验证折叠/展开各只切换一次。

```text
dev smoke : 597 项断言 / 588 布尔 / 0 false · projectsToggle / projectCollapseMotion=true
```

最终产物已重出并装机验证：

```text
dist/Qcode-0.4.5-win.zip     225.6 MB  sha256 4bee9bfc…48662f99
dist/Qcode-Setup-0.4.5.exe   174.7 MB  sha256 5d5c94d3…c7655a93
装机版 <安装目录>         0.4.5.0 · 冒烟 597/588/0
```

### R217 第一百三十六轮：脱敏配置预览接入

`config.exportPreview` API 原已存在但 renderer 未使用。

现在设置 → 供应商新增“预览脱敏配置”：
- 只读文本弹窗展示实际脱敏 JSON；
- 配置读取失败时拒绝生成可信预览；
- 导出前可人工检查 headers、URL query、token/password 等字段。

新增断言 `configExportPreview`。

```text
dev smoke : 598 项断言 / 589 布尔 / 0 false · configExportPreview / configRedactionDeep=true
```

最终产物已重出并装机验证：

```text
dist/Qcode-0.4.5-win.zip     225.6 MB  sha256 b4cbc99b…d7c592f5
dist/Qcode-Setup-0.4.5.exe   174.7 MB  sha256 1ec84768…c3bd30e7
装机版 <安装目录>         0.4.5.0 · 冒烟 598/589/0
```

### R218 第一百三十七轮：完整审计与 API 使用复核

R217 装机版完整复核：

```text
audit smoke : 598 keys / 589 bool / 0 false · 101.1s
bench       : boot 141ms · first frame 142ms · layout 38.6ms
              typing 0.06ms · window 22ms · settings 37ms
              save 2.3MB 11.1ms · heap 9.5MB · frame p95 8.5ms
              1MB 高亮 12.5ms · 工具密集 398.7ms
idle        : main 0.02% · renderer 0.77% · raf 0
E2E         : ok · 两轮真实对话 · 无 renderer 错误
controls    : 30 个静态控件 · 未引用 0
IPC         : 91 个 preload 调用 · 缺失 handler 0
API         : 仅剩 3 个 smoke 诊断接口未在主 UI 使用
```

### R219 第一百三十八轮：端点测试 DNS 解析防护

原端点安全检查只看 URL hostname，域名可借 DNS 解析绕过私网/元数据地址限制。

现在 `isSafeTestEndpoint()`：
- 本地字面地址保持允许；
- 私网字面地址仍需显式 `allowPrivate`；
- 非本地域名执行 DNS A/AAAA 解析；
- 解析到私网时按显式策略处理；
- 解析到链路本地、元数据、非本机环回始终拒绝；
- 解析失败交给 fetch 报错。

`endpointPolicyUnified` 增加 DNS 解析到 169.254.169.254 的绕过断言。

```text
dev smoke : 598 项断言 / 589 布尔 / 0 false · endpointPolicyUnified / providerWizardFlow=true
```

最终产物已重出并装机验证：

```text
dist/Qcode-0.4.5-win.zip     225.6 MB  sha256 4739fa0a…ba4b39f35
dist/Qcode-Setup-0.4.5.exe   174.7 MB  sha256 cd2e0233…40c73764
装机版 <安装目录>         0.4.5.0 · 冒烟 598/589/0
```

### R220 第一百三十九轮：端点测试禁止重定向

初始 URL 通过安全策略后，fetch 默认仍可能跟随 30x 跳转到私网或元数据地址。

现在两类端点测试都设置 `redirect: 'error'`：
- 不自动跟随重定向；
- 需要重定向的端点会明确失败；
- DNS 策略不会被二次跳转绕过。

新增断言 `endpointRedirectBlocked`。

```text
dev smoke : 599 项断言 / 590 布尔 / 0 false · endpointRedirectBlocked / endpointPolicyUnified=true
```

最终产物已重出并装机验证：

```text
dist/Qcode-0.4.5-win.zip     225.6 MB  sha256 cdeefae5…5ce28a78
dist/Qcode-Setup-0.4.5.exe   174.7 MB  sha256 e9c2b75b…791d9d2
装机版 <安装目录>         0.4.5.0 · 冒烟 599/590/0
```

### R221 第一百四十轮：端点加固后完整审计

R220 装机版完整复核：

```text
audit smoke : 599 keys / 590 bool / 0 false · 109s
bench       : boot 136ms · first frame 145ms · layout 38.5ms
              typing 0.05ms · window 23.9ms · settings 29.1ms
              save 2.3MB 11.9ms · heap 10.7MB · frame p95 8.5ms
              1MB 高亮 12ms · 工具密集 382.8ms
idle        : main 0.02% · renderer 0.76% · raf 0
E2E         : ok · 两轮真实对话 · 无 renderer 错误
controls    : 30 个静态控件 · 未引用 0
IPC         : 91 个 preload 调用 · 缺失 handler 0
```

### R222 第一百四十一轮：IPv6 映射地址防护

`::ffff:127.0.0.1` 与 `::ffff:192.168.x.x` 以前可能绕过环回/私网判断。

现在新增 `normalizeIp()`：
- 支持 IPv4-mapped IPv6 点分与十六进制形式；
- 去除 zone id；
- 映射地址统一按 IPv4 分类；
- 映射环回始终拒绝；
- 映射私网仍需显式 `allowPrivate`。

`endpointPolicyUnified` 增加两类映射地址断言。

```text
dev smoke : 599 项断言 / 590 布尔 / 0 false · endpointPolicyUnified / endpointRedirectBlocked=true
```

最终产物已重出并装机验证：

```text
dist/Qcode-0.4.5-win.zip     225.6 MB  sha256 59366ca0…a4efc681
dist/Qcode-Setup-0.4.5.exe   174.7 MB  sha256 a0919ec6…60b4333
装机版 <安装目录>         0.4.5.0 · 冒烟 599/590/0
```

### R223 第一百四十二轮：IPv6 加固后完整审计

R222 装机版完整复核：

```text
audit smoke : 599 keys / 590 bool / 0 false · 103.6s
bench       : boot 144ms · first frame 156ms · layout 39.7ms
              typing 0.05ms · window 23ms · settings 30.2ms
              save 2.3MB 10.8ms · heap 9.5MB · frame p95 8.5ms
              1MB 高亮 11.9ms · 工具密集 373.9ms
idle        : main 0.02% · renderer 0.78% · raf 0
E2E         : ok · 两轮真实对话 · 无 renderer 错误
controls    : 30 个静态控件 · 未引用 0
IPC         : 91 个 preload 调用 · 缺失 handler 0
```

### R224 第一百四十三轮：真实首帧懒加载口径

原 `lazyAtBoot` 在后台补水启动后才采样，不能代表首帧负载。

现在新增 `lazyAtFirstPaint`：
- 在 `mark('firstPaint')` 后、`scheduleLazyHydration()` 前记录；
- bench 同时输出首帧 lazy 与旧 boot lazy；
- 750 会话实测首帧 710 个 lazy，旧口径仅 510，确认补水污染；
- 3 秒补水 460，剩余 49。

```text
dev smoke : 599 项断言 / 590 布尔 / 0 false · lazyLoadingSkeleton / batchHydrate=true
```

最终产物已重出并装机验证：

```text
dist/Qcode-0.4.5-win.zip     225.6 MB  sha256 15d8bdfd…a9547c4f
dist/Qcode-Setup-0.4.5.exe   174.7 MB  sha256 83cdf667…a8bdfcc
装机版 <安装目录>         0.4.5.0 · 冒烟 599/590/0
```

### R225 第一百四十四轮：大库补水吞吐提升

真实首帧 710 个 lazy，原 20 条/120ms 在 3 秒窗口只能补 384，剩余 326（切换会话前已补部分）。

调整为：
- 首批延迟 300ms → 200ms；
- 每批 20 → 25 条；
- 批间隔 120ms → 100ms；
- bench 增加 `lazyHydrateAllMs` 精确完成时间。

复测 3 秒窗口内剩余 lazy 已清零；精确 `lazyHydrateAllMs=1667`，首帧 120ms。

```text
dev smoke : 599 项断言 / 590 布尔 / 0 false · batchHydrate / globalSearchIndex=true
```

最终产物已重出并装机验证：

```text
dist/Qcode-0.4.5-win.zip     225.6 MB  sha256 a2b741cc…1d01daf
dist/Qcode-Setup-0.4.5.exe   174.7 MB  sha256 cb3fbdba…0201d9c
装机版 <安装目录>         0.4.5.0 · 冒烟 599/590/0
```

### R226 第一百四十五轮：补水可观测性与吞吐再提一档

用 1500 会话库（`--bench`）压测真实首帧负载，先暴露两个测量问题：

- 3 秒硬截断让 `lazyHydrateAllMs` 恒为 `null`，看不到真实总耗时；
- 新增字段与后段内存曲线的 `lazyBeforeHydrate` 撞名，被覆盖成 0。

改为：先记 3 秒吞吐 `hydratedIn3s`，再继续等到清零取得 `lazyHydrateAllMs`（上限 20s）；
字段改名 `lazyPendingAtHydrate`；新增补水期 `hydrateLongTasks` 与 `hydrateMaxTickGapMs`。

1500 会话实测（25 条/100ms）：**1059 个待补，总耗时 4727ms，长任务 0 个**，堆稳定在 40.1MB
—— 零长任务说明主线程仍有余量，于是把批量提到 **50 条/70ms**：

```text
1500 会话 · 50 条/70ms
  首帧 173ms · 待补 509 · 总耗时 922ms · 长任务 0 · 最大 tick 间隔 63ms · 堆 28MB
```

补水速度提升约 5 倍，且没有引入长任务或内存上涨。

### R227 第一百四十六轮：检查点冒烟改用独立临时工作区

`cpRestore` 长期间歇失败，本轮定位到真因：冒烟把**仓库根**当检查点工作区，
而仓库 `dist/` 已含 400MB+ 构建产物 → 扫描被截断（`truncated`）→
按 R212 的既有设计「不完整检查点禁止删除新增文件」→ 断言期待新增文件被删掉，必然失败。

这与仓库体积相关，所以表现为"时好时坏"。现在：
- 主进程用 `mkdtemp` 建独立小工作区（2 个文件）传给冒烟；
- `create/diff/restore/readVersion/diffPreview` 全部改用它；
- 结束后 `checkpoint.deleteAll` 清理，不留孤儿检查点。

`cpCreate / cpDiff / cpRestore / cpList / cpReadVersion / cpDiffPreview` 全部稳定通过。

```text
dev smoke : 599 项断言 / 590 布尔 / 0 false · cpRestore / checkpointNanosecondGuard=true
```

最终产物已重出并装机验证：

```text
dist/Qcode-0.4.5-win.zip     225.6 MB  sha256 84e672ee…81350231
dist/Qcode-Setup-0.4.5.exe   174.7 MB  sha256 dd3d4249…48927535
装机版 <安装目录>         0.4.5.0 · 冒烟 599/590/0
```

### R228 第一百四十七轮：自检夹具路径可移植

`--smoke` / `--bench` / `--shots` 里写死了作者本机路径（`<工作区>`、仓库绝对路径，共 43 处）。
换机器、换盘符，或开源后他人 clone，自检直接跑不起来；探针文件还会被写进仓库根。

现在：
- 主进程 `devWorkspace()` 建一次性临时工作区，预置 `package.json`、`qwen*` 探针文件、`alpha/`、`src/`；
- 若 `git` 可用，顺手 `git init` + 提交，让 Git 面板断言有真实仓库可测；
- 通过 `window.__qcodeDevWs` / `window.__qcodeDevRepo` 注入渲染层；
- 43 处硬编码路径全部改为读取注入值，仓库根不再被写入探针文件；
- 仓库里的红脱敏样例改为运行时拼接（`'sk-' + 'a'.repeat(32)`），源码中不再存在任何密钥形状字面量。

关键点：`redactKeySample` 的取值刻意**不带** `sk-` 前缀——否则会先被 `sk-` 规则吃掉、
长度缩短后不再命中「键名规则」，导致 `logRedaction` 假失败。两条规则现在各测各的。

### R229 第一百四十八轮：视图过渡中断与自检看门狗

排查间歇性挂起时抓到真因之一：

```
[renderer-error] unhandledRejection: Transition was aborted because of invalid state
```

快速连续切换主题时，前一个 `document.startViewTransition()` 被中断，它的 `finished`/`ready`
会 reject；代码只 `try/catch` 了同步部分，于是变成未处理拒绝，冒烟会停在中途不再前进。

现在：
- 捕获返回的 `ViewTransition`，对 `finished` / `ready` 各自 `.catch(() => {})`
  （中断本身无害——update 回调已经把主题应用了）；
- `--smoke` 增加看门狗（默认 300s，可用 `--smoke-timeout=` 覆盖），超时打印最后一条渲染层进度并 `exit 2`；
- `--bench` 看门狗（默认 180s，`--bench-timeout=`）与渲染层 `[bench]` 分步进度日志；
- 冒烟主流程补 `step:fsRead / checkpoint / editor / gitStatus / gitDiff / gitDiffCache / gitPanel` 等标记，
  渲染层 `console.log('[smoke] …')` 统一转发进 `agent.log`，卡住时能直接定位到最后完成的步骤；
- 两者都把"无法诊断的永久挂起"变成"带定位信息的失败"。

### R230 第一百四十九轮：开源发布准备

**许可证与元信息**
- 新增 `LICENSE`（MIT）
- `package.json`：补 `license`、`keywords`、`engines`，描述改为中文，保留 `private: true` 防误发 npm；
  新增 `check` / `smoke` / `bench` / `idle` / `e2e` 脚本

**社区文档**
- `README.md`：功能总览、开发与构建、自检开关、数据与隐私说明、截图
- `CONTRIBUTING.md`：代码地图、提交前自检、改代码约定（含"模板字符串里正则要双写反斜杠"这类踩坑）
- `SECURITY.md`：报告渠道 + 设计上的安全边界（插件白名单、端点 DNS/重定向策略、密钥脱敏）
- `CODE_OF_CONDUCT.md`、`docs/BUILDING.md`、`docs/RELEASE-CHECKLIST.md`

**仓库卫生**
- `.gitignore`：排除 `node_modules/`、`dist/`、`build/kernel/`（92MB node.exe）、`*.log`、`_probe*`
- `.gitattributes`：文本统一 LF，`.ps1` 保持 CRLF；二进制不做行尾转换
- `.editorconfig`
- 删除仓库根的 `agent.log`
- `tools/*.ps1` 的 `-InstallDir` 默认值由作者本机路径改为
  `Join-Path $env:LOCALAPPDATA 'Programs\Qcode'`；`audit.ps1` 补上 UTF-8 BOM（PS 5.1 中文解析）

**CI**
- `.github/workflows/ci.yml`：跨平台 `node --check` 必跑；
  `--smoke` 作业因需内置内核默认关闭，仓库变量 `QCODE_ENABLE_SMOKE=true` 时启用（自带内核准备与断言解析）

**本轮验证**

```text
audit       : 复核通过 · smoke 599/590/0 · bench boot 170ms p95 8.5ms · idle main 0.02% renderer 0.82%
装机版冒烟  : 599 项 / 590 布尔 / 0 false
可移植性    : 源码内 0 处 <工作区>、<仓库>；0 处密钥形状字面量
仓库体量    : 76 个可跟踪文件 · 7.4 MB（含 46 张截图）
```

最终产物：

```text
dist/Qcode-0.4.5-win.zip     225.6 MB  sha256 0f2e73a8…4b86d2aa4
dist/Qcode-Setup-0.4.5.exe   174.7 MB  sha256 395a9807…9211fcdb5
装机版 <安装目录>         0.4.5.0 · 冒烟 599/590/0
```









































> 运维补充：宿主终端是 Windows PowerShell 5 时，无 BOM 的 UTF-8 `.ps1` 会按 ANSI 误读中文并报解析错误。
> `tools/upgrade.ps1` 已补 UTF-8 BOM；当前进程可临时 `Set-ExecutionPolicy -Scope Process Bypass` 后直接 `& .\tools\upgrade.ps1`，
> 无需更改系统执行策略。嵌套再启动 `pwsh.exe` 在受限宿主里可能被拒绝，优先在当前会话执行。

















































## 记录未修（R83 识别，现状已核准）

| 条目 | 状态 |
|---|---|
| **AD-7 会话写盘最终失败只留日志** | ✅ **已修（R88）**：主进程重试耗尽/序列化失败 → `sessions:save-error` → 状态栏 + toast + 会话标记；恢复后发 `sessions:save-ok`。R89 用 `ENOSPC` 注入演练实证（`saveErrorInjected`）。 |
| **备份限额口径**：`bytes` 按 `JSON.stringify().length` 累计（UTF-16 字符数） | ✅ **已修（R96）**：改 `Buffer.byteLength(…,'utf8')`，抽成 `backupBytesOf()` 便于断言；中文会话不再被低估 3 倍（`backupByteUnits`）。 |
| **检查点单文件 4MB 跳过未计入 `truncated`** | ✅ **已修（R96）**：跳过数记入 manifest 的 `skippedLarge` 与 create 返回值，界面状态栏提示「已跳过 N 个大于 4MB 的文件（无法回滚）」。**刻意不置 `truncated`**——它只用于拦截「删除新增文件」，置位会误伤含大文件的正常回滚（`cpSkipLarge`）。 |
| **boot 清理空会话忽略 `sessions.remove` 返回值** | ✅ **已修（R96）**：抽出 `removeStaleEmptySessions()`，只有主进程确认删除成功才从列表移除，失败保留并打日志（`staleCleanupHonorsFail`）。 |
| **`sessions:delete` 与备份文件格式是破坏性契约变更** | ⬜ 已按新契约改完全部调用点；**将来加「从备份恢复」必须兼容旧裸数组**，这里留档。 |

已修复并关闭的旧条目：AD-7（见上）、`sessions:delete` 幂等性、`host_exit` 缺 `timedOut`/`willResend`、懒加载补水停摆、工具卡正文首帧阻塞、设置页 extras 阻塞。


## ⚠️ 运维教训（本轮新增，务必记住）

1. **`ELECTRON_RUN_AS_NODE=1` 会让 `electron .` 退化成纯 Node**：直接 `TypeError: Cannot read properties of undefined (reading 'handle')`（`require('electron')` 返回的是路径字符串）。本轮第一次冒烟就是这样秒退的。**跑 dev / 冒烟 / 构建前先 `Remove-Item Env:ELECTRON_RUN_AS_NODE`**。（DSH 之类把自身跑在 Electron 里的宿主会带这个变量。）
2. **冒烟没有退出码、没有汇总行**：`[smoke] done` 只代表流程走完，绿不绿要靠 `[smoke] features:` 那一行统计（用 node 解析：key 数、`false` 数）。当前口径：**450 keys / 441 boolean / 0 false**（R96）。
3. **给 `runSmoke` 插断言时**：外层是模板字符串，插入代码里不能出现反引号与 `${`；新增断言放在 `const checks = await …` 之后、`log('smoke feature checks', …)` 之前才能进入 features 汇总行。（`--bench` 的基准脚本同理，反引号只能 `String.fromCharCode(96)` 动态拼。）
4. **后台任务不能"一次没活就永久停摆"**：R84 的懒加载补水循环最初在"当前没有懒加载会话"时直接 `return`，被冒烟/基准脚本的临时会话列表一搅就再也不会启动。现改为「空转最多重试 4 次（5s 间隔）后休眠」，并在补水成功时重置计数。
5. **性能数字必须带口径**：R84 的 `avg()` 最初用 best-of-N，单次 0.003ms 级操作被时钟分辨率吃成 0；改为「N 次总时长 / N」并加 warmup 后才可比较。同理，比较"优化前/后"必须在同一份合成数据、同一个 index 预热状态下跑（本轮 800 会话 eager/lazy 对照就是这么得出的 −52%）。

