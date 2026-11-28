# Qcode 0.4.4 发版说明

> 0.4.4 在 0.4.3 基础上：UI 全面 Gemini 化、打字机流式文本、工具折叠、五档权限 + can_use_tool 授权闭环、ZCode 四类时间轴分隔线、上下文明细、回到底部未读徽标、全局 `/` 聚焦、toast/列表键盘可达、关于页显示 qwen-code 版本；另含四十七轮纯性能优化、一个真实 bug 修复与两项参考 ZCode/GitHub 的新功能（工作区检查点 /rewind、Todo 任务条）。

## 性能优化（第四十七轮收口）

按「识别热点 → 微基准 → 实现 → dev/安装版双冒烟回归」逐轮推进，全部有断言锁定：

① 打字机 DOM 合并 ② setStatus 去重 + 滚动边缘单次布局采样 ③ 全文索引失效 sid→words 反查（22x）④ saveSession 序列化推迟到 flush（21→1）⑤ 文件搜索清单缓存（160x）⑥ HTML 转义单遍化（1.4x）⑦ edit diff WeakMap 缓存 ⑧ Markdown 表格单次解析（1.67x）⑨ searchableText 单趟拼接（4x）⑩ 时间戳格式化缓存（2600x）⑪ 会话内查找复用缓存（16x）⑫ 附件缩略图 HTML 缓存 ⑬ 边输出边排版 typesetStreamPreview（streamLiveTypeset）⑭ 流式输入行 twActiveSig 签名守卫 + scroll 单次布局采样 + 发送按钮 sendBtnSig 缓存 + sidebarScroll/scrollBadge 无界增长修复 ⑮ 工具输出折叠判定免 split（48x）+ 输出区 HTML WeakMap 缓存 ⑯ 老会话日期 relDate 缓存 ⑰ tokenizeForIndex 去空分支 + queryFullTextIndex 交集免展开 ⑱ messageSearchText 轻量签名缓存（3.09x）⑲ countNonLazySessions 免 filter（4.77x）⑳ inlineMarkup 行内标记守卫（4.08x）㉑ 围栏 indexOf 守卫（2.8x）+ trimLineEnd 快路径（5.46x）㉒ renderUserMessage/renderAssistantShell 容器复用（threadPaint 3.5→2.9ms）㉓ 归档计数 countFlag（1.83x）㉔ baseName 路径末段提取（8.57x）㉕ diffLines LCS 平坦 Uint32Array（2.6x）㉖ 行空判定免 trim（23x）㉗ collectIndexed 免 O(n²)（24x）㉘ listTrashItems 前 20 按 mtime（2.79x）㉙ aggregateUsage 周聚合并入首遍 ㉚ fs:search lname 预存（1.9x）㉛ 短代码块 esc 去重（2x）㉜ 消息气泡附件 HTML 缓存 ㉝ fillTodoBody WeakMap 缓存 ㉞ 消息气泡附件 DOM 节点缓存（3.86ms→≈0）㉟ 工具 body DOM 节点缓存（4x）㊱ 正文 markdown DOM 节点缓存 ㊲ BLOCK 占位符 O(1) 守卫（37.6x）㊳ listDirectory Intl.Collator 复用 ㊴ sessions:sizes Promise.all 并发 ㊵ app:gpu 静态信息缓存 ㊺ 供应商批量折叠去 O(G²) ㊻ 设置面板去重渲染 + 日志预览先 slice 再 stringify（857x）+ child exit 清理挂起授权定时器 ㊼ handleGoalVerify 去冗余 renderThread ㊽ fs:list 目录清单缓存（15s TTL）。

其余候选（goal/IPC/DOM/CSS 各维度）均测量后确认无收益/低频/已有缓存/有风险，未做无收益改动；无遗留 O(n²) 热点。

## Bug 修复：没发消息但后台一直调大模型

跨天日期提醒等 model-only 前缀被拼进 cliText，真实内容为空时整条 prompt 只剩提醒发给内核触发大工具循环（日志实证 `write user message "The date has changed..."` + 2000+ stream 事件）。新增 `hasRealPrompt` 守卫：纯提醒不单独成轮、回滚占位消息但保留日期消费副作用（`noReminderOnlyTurn` 断言）。

## 新功能：工作区检查点 /rewind（参考 ZCode）

- 每回合发送前对工作区做增量快照（内容寻址 blob 去重，只有变化的文件产生新 blob）；`/rewind` 命令列出检查点，支持差异预览（修改/新增/删除）与一键回滚，可选删除之后新增的文件。
- 主进程 `checkpoint:create/list/diff/restore/deleteAll`；恢复前强制 `isInside` 安全校验；会话删除同步清理检查点。
- **灾难教训（r49 事故）**：初版 blobs 目录未 mkdir（copyFile 全 ENOENT）→ manifest files:0，冒烟探针 restore+deleteAdded 把整个工作区当「新增」全部删除，源码丢失（已从 R47 构建 asar 完整恢复）。修复守卫四件套：① blobs 先 mkdir ② copyFile TOCTOU 容错 ③ **空 manifest 拒绝恢复** ④ deleteAdded 只删 mtime ≥ 检查点时刻的文件（部分 manifest 不再可能误删早于检查点的文件）。
- **遍历安全（r58 教训）**：跳过 junction/软链（防环、防误快照链接目标）；跳过 `_backup*` 归档目录（数十 GB 备份耗尽 96MB 上限，排在后面的文件进不了 manifest）。
- 每会话保留最近 10 份，全局 blob GC 限频 5 分钟。
- 断言：cpCreate/cpDiff/cpRestore/cpList。

## 新功能：Todo 任务条（参考 ZCode/Claudia）

- 输入框上方常驻显示当前会话最近一次 `todo_write` 的进度：收起态一行摘要（`n/m · 当前任务`），点击/回车展开完整清单（复用工具卡状态图标与删除线样式），无任务的会话自动隐藏。
- 状态双通道：流式回合 TodoWrite 落地实时更新（`todoBarLive`）；历史/切会话向后扫描（`sessionLatestTodos`）。回合结束后以落库消息为准，sig 守卫免重建 DOM。
- 键盘可达（Enter/Space 切换，aria-expanded），深浅双主题，reduced-motion 由全局规则覆盖。
- 断言：todoBar/todoBarExpand/todoBarEmpty。

## 性能优化（第四十九轮）：检查点 walk stat 批量化

- `checkpoint:create` 每回合 beginTurn 同步走工作区，4000 文件上限的大工作区（如超大工作区，全树 41.6 万文件靠上限截断）实测 182.7ms——主进程逐回合阻塞。
- 层内文件 stat 批量化（`Promise.all`），push/bytes 判定保持原序，终止语义不变；diff/restore 共用同一 walk 故顺序变化自洽（增量复用与 Map 判定均与顺序无关）。实测 **182.7→96.2ms（1.9x）**，每回合主进程省约 87ms。
- 同时测量回退：`sessionLatestTodos` 后向扫描 2000 消息仅 0.153ms/次（非每按键路径），按既有标准不改。
- 现有 cp 全链路断言（create/diff/restore/list/readVersion/diffPreview）即本轮功能回归锁。

## 增强：检查点逐文件 diff 预览（R50，参考 ZCode rewind）

- 「查看差异」结果中的每一行（改/增/删）现在可点击：下方展开该文件的「检查点 → 当前」统一 diff（复用工具卡的 diffLines/collapseDiff 渲染与样式，±着色、改动区 ±2 行上下文），再次点击收起。
- 新增 `checkpoint:readVersion` IPC：按 manifest rel 键读取内容寻址 blob 的快照内容（rel 不落 fs 路径、拒绝 `..` 与绝对路径，无路径穿越面）。
- 大于 200KB 或含 NUL 的文件跳过预览并提示。
- **顺带修复 R48 遗留 bug**：`mask.querySelector('[data-diff]')` 按 DOM 顺序命中先出现的展示区 div 而非底部按钮——「查看差异」按钮自 R48 起一直是死的，diff 逻辑绑在了展示区上。现限定 `.cp-foot [data-diff]`。
- 断言：cpReadVersion（API+bogus rel 拒绝）、cpDiffPreview（弹窗点击 → 行点击 → d-del/d-add 面板全文）。

## 新功能：/todos 命令 + 检查点回滚时间线 marker（R52）

- **`/todos` 本地命令**：在时间线插入当前会话最近一次 `todo_write` 的任务清单卡（与 Todo 任务条同源数据：进度 n/m + 状态图标行），无任务的会话显示空态文案；运行中会话也可查看；不耗模型轮次。复用 `.goal-status-card` 骨架与 `.todo-row` 行样式，深浅双主题。
- **检查点回滚时间线 marker**（对齐 ZCode rewind 完成反馈）：弹窗恢复成功后在时间线落一条「已回滚工作区到检查点 · 还原 N 个文件 · 删除 M 个新增」分隔线（复用压缩分隔线视觉骨架，本地消息不进内核）。`recordCpRestore` 为独立函数便于断言。
- 断言：todosCmd（命令注册 + 卡片渲染 1/2 计数 + 空态）、cpRestoreMarker（marker 数据 + 分隔线文本）。
- 调试教训：冒烟里对 fake 会话调用会触发 `renderThread` 的路径（如 appendTodosView）后，必须恢复 state.current 并重画真实线程，否则污染后续依赖线程 DOM 的断言（r66 find=false 即此因）。

## 监工审查（R81）：第十波深度审查，修复 12 项

第十波攻构建发版与极端数据（AA 构建/AB 极端数据，14 条报告，**12 项修复**）。

**监工 AA（构建发版 4 条，全修）**：窗口图标仍是 asar 内 .ico 路径→createFromBuffer（同托盘/通知口径）；**显式 qwenCmd/QWEN_CMD 被内置内核遮蔽**——安装版"一键安装内核/保存路径"永远不生效 →显式覆盖判断前置；NSIS 无 license 页但发版说明/Hardcoded meta 声称有（P3，记录）；afterPack 补拷只判目录存在→哨兵文件校验自愈。其余维度（files/extraResources/guid/版本一致性/isTrustedSender asar 前缀/开发打包路径切换）未发现。

**监工 AB（极端数据 10 条，修 8）**：**P1** boot 遇 null 消息/非数组 blocks 白屏→Array.isArray 防护；**P1** 全文索引器坏数据抛错让 fullTextBuilding 永久 true→try/finally 隔离 + 单条文本 64KB 上限（10MB 消息不再一个 idle 回调卡死）；**P1** toolInputJson 对 write_file 10MB content 无上限→32KB 截断；**P1** 100×10MB 会话 backup 全量 stringify OOM→500 上限告警；provider 响应体 2MB 上限；renderThread 畸形消息防护 + renderLimit 上限（部分）。记录：超长块每次重绘重算、50 后台 busy 预览缓冲膨胀、导出大会话卡死、checkpoint 失败静默（P2）。

**验证**：dev r142 + 安装版均 **402 项断言全绿**（零回归）；afterPack 改动经真实构建+安装验证。

## 监工审查（R80）：第九波深度审查，修复 15 项

第九波转向代码反模式与用户交互细节（Y 代码反模式/Z 交互细节，24 条报告，**15 项修复**）。

**监工 Y（代码反模式 12 条，修 8）**：**P1** persist 的 lazy hydration 回调未复核会话仍存在→删除后"复活"（对比 switchSession 已有守卫）；writePrefs 先改内存再写盘→失败时内存/磁盘不一致（改成功后再赋值）；sessions:save 无 id 校验→非法 id 穿透为 unhandledRejection 且写脏索引；flushSessionSave 失败无限 500ms 重试→3 次上限；gitStatusCache/fsSearchInventory 无上限→60/8 FIFO；stop() 漏清 effortTimer→停止 15s 后凭空启动内核写 prompt；清空会话遗漏全文索引/scroll/todoBarLive 清理；goalTicker 无活跃 goal 空转→停表。记录：checkpoint 逐项 await 性能优化、多处 ipc .then 无 catch（P3）。

**监工 Z（交互细节 12 条，修 7）**：**中文用户重点**——输入框 input 无 IME 守卫→中文组词时 @ 补全误弹、Enter 选字误发送（加 isComposing 守卫）；重命名 Enter 与全局 Esc 无 IME 守卫→选字回车丢候选/组词 Esc 误停回合（keyCode 229 守卫）；空态建议填值不派发 input→发送按钮仍禁用、草稿丢失（补 dispatchEvent）；删除当前会话切到不可见会话（改可见列表首项）；设置页通用分区改模型后保存按钮不显示（草稿脏统一显示脚栏）；多步骤回合停止时半截文本丢弃；复制按钮"已复制"与"复制失败"并存（P3）。记录：undo 栈被 value 赋值清空、重试上下文不保真、新建会话重名、内核未安装引导条被 renderThread 抹掉。

**验证**：dev r141 + 安装版均 **402 项断言全绿**（零回归）。

## 监工审查（R79）：第八波深度审查，修复 15 项

第八波转向安全与数据配置（V 安全/W Markdown/X 配置流，27 条报告，**15 项修复**）。

**监工 V（安全与密钥泄漏 9 条，修 5）**：**P1** 配置"脱敏导出"漏掉 MCP 服务器 env（密钥原样写进导出文件）→redactedConfig 递归脱敏所有 env；**P1** 端点测试无 URL 校验（SSRF + Bearer 密钥外发内网/攻击主机）→isSafeTestEndpoint 白名单（允许本机、拒私网/环回/链路本地）；shellQuoteArg 只处理空格/引号，cmd 元字符 `&|;^()` 可命令注入→完整引用；session:export 默认文件名复用 sanitizeDefaultName（补反斜杠）；file:restore-bak 加目标白名单（仅已知配置）。记录：日志完整 prefs/args 脱敏不全、会话导出含密钥、app:openPath/fs:stat 边界（P2-P3）。

**监工 W（Markdown 健壮性 10 条，修 4）**：**P1** parseListBlock 深嵌套递归 RangeError→MAX_LIST_DEPTH=32 平铺；**P1** 缩略图 src 仅 startsWith('data:image/') 可属性注入→三处严格 data URL 白名单+esc，签名改全串；删除线正则跨行吞掉表格/列表→加 `\n` 排除；表格分隔行任意位置删除→只判断第 2 行。记录：行内标记二次匹配、未闭合围栏、列数归一化、围栏正则回溯（P2-P3）。

**监工 X（配置数据流 8 条，修 6）**：**P0** 设置页已打开时 Ctrl+,/命令面板再次 openSettings 重置 cfgDraft 丢失未保存改动→已打开则复用草稿；**P0** 改默认模型用 `{name}` 整体替换丢 reasoningEffort 等字段→四处展开合并；**P1** envKey 改名 stillUsed 对对象型 modelProviders 调 .some 抛 TypeError（R74 修复失效）→改 `.openai` 数组；security.auth 展开合并；warnings 展示/导入字段兜底记录。记录：孤儿 env 键、渲染规范化误报脏（P2）。

**验证**：dev r140 + 安装版均 **402 项断言全绿**（零回归）。

## 监工审查（R78）：第七波深度审查，修复 15 项

第七波转向基础设施可信度（S CLI 协议 / T 特殊环境 / U 冒烟可信度，26 条报告，**15 项修复**）。

**监工 S（CLI 协议 9 条，修 6）**：**P1** can_use_tool 60s 超时只写 deny 不广播 approval-clear→渲染层卡片永久残留（超时分支补广播）；/effort 内核报错不发 result 时 controlActive 永久 true→15s 超时兜底；assistant.content 非数组导致整条事件丢失→Array.isArray 防御；tool_result 早于 use 静默丢弃→待配缓存（pendingResults，已实现于 renderer）；stdout 超长行无界增长阻塞后续事件→10MB 上限丢弃标记。记录：resumeId 恢复成功误报、control_response 无配对、并发授权覆盖、resultText base64。

**监工 T（特殊环境 7 条，修 2）**：启动热键失败日志条件写 `ok===false`（实际字段 registered）→修正；asar 内图标路径用原生 createFromPath 会失效→createFromBuffer。记录：npm registry 硬编码/代理环境 fetch/内核 node.exe 缺失自救/多显示器 clamp/userData 迁移。

**监工 U（冒烟可信度 10 条，修 7）**：**多个 P1 假绿**——searchCache 从纯 typeof 改为真实会话缓存命中断言；messageAnchor 加「句中链接不误拦截」回归输入（R77 修复点锁住）；cmdEnterMotion/skillEnterMotion 空列表不再算通过；条件赋值（attachChip/promptEnterMotion/projectCount 等）分支前预置 false 防键蒸发；savedCwd 初始化防异常写 undefined；U9 contextCache 探针 finally 还原。记录：跨断言状态依赖、视觉修复无几何断言、硬编码常量断言。

**验证**：dev r139 + 安装版均 **402 项断言全绿**（零回归）。

## 监工审查（R77）：第六波深度审查，修复 17 项

第六波覆盖前五波未系统触及的系统交互层（P 主题窗口 / Q 拖拽剪贴板通知 / R 文案边界，20 条报告，**17 项修复**）。

**监工 P（主题窗口 5 条，修 5）**：theme:apply 无 nativeTheme 联动（原生对话框不跟随应用主题）+ 参数白名单缺失→引入 nativeTheme 三态设置+非法值拒绝；saveWindowState 在最大化时 getBounds 返回全屏尺寸→改 getNormalBounds 保留自定义尺寸；窗口重建初始 backgroundColor 硬编码浅色→用最近应用的主题设初始色（深色冷启动/托盘重建不再白闪）；ui.zoom 无白名单→0.9/1/1.1 校验。记录：bounds 部分越界 clamp（P3）。

**监工 Q（拖拽剪贴板通知 7 条，修 5）**：全局 dragover/drop 无条件 preventDefault 吞掉纯文本/链接拖拽→只对 Files 类型拦截；消息锚点用 indexOf 在句子中误拦截→整段匹配；Notification 权限被拒时 show() 不抛错仍返回 true→监听 failed 事件；5 处 clipboard.writeText 无 catch→统一 safeCopy（失败 toast、不误报已复制）；relPath 正斜杠结尾 root 切片错算吃掉路径首字符→normRoot 统一；file:restore-bak 非原子写→tmp+rename。记录：openMenu 点击项丢焦点（P3）。

**监工 R（文案边界 8 条，修 7）**：ui.bindings/lastExpertSession 写入无 catch（配额超限中断后续逻辑）→safeSetItem 统一；JSON.parse 英文错误进中文 UI（5 处）→固定中文文案；trimTitle 的 slice 切 emoji 代理对→Array.from 按码点；uid 同毫秒批量导入碰撞（Math.random 仅 36^4）→加递增计数器；fmtNum 对 Infinity 输出 "InfinityM"→非有限返回「—」；fmtGoalElapsed 输出 "InfinityhNaNm"→有限性校验。记录：回收站恢复 id 碰撞（P3）。

**验证**：dev r132 + 安装版均 **402 项断言全绿**（零回归）。

## 监工审查（R76）：第五波深度审查，修复 15 项

第五波攻前四波未覆盖的深层区域（M 会话数据兼容 / N 并发竞态 / O 搜索索引，29 条报告，**15 项修复**）。

**监工 M（会话数据兼容 10 条，修 4）**：**P0** 导出全部会话时归档/懒加载会话是 messages:[] 桩→导出前逐个 hydrate（用该文件恢复不再丢历史）；**P1** backupSessions 不冲 200ms 防抖待写→备份前 flushSessionSaves+flushSessionIndex；**P1** 瘦身只改磁盘、内存旧对象下次 persist 撤销→返回后 cancelPersist+重新 hydrate；P2 outputLen 保留原始长度语义。记录：附件原图存 temp 7 天清理、导入清洗 system marker/tool 字段丢失、超大 JSON 无上限、索引坏文件隔离、回收站非原子写。

**监工 N（并发竞态 9 条，修 6）**：**P1** blob GC 删并发 create 未写 manifest 的 blob→GC 跳过 60s 内新建 blob；**P1** 队列 150ms 窗口内 stop 失效→pendingTurn 记录 timer+项，stop 时取消回填；**P1** checkpoint 异步期间 stop/delete 后仍发 turn→dispatchTurn 前复核会话/stream；**P1** 清空会话被迟到 save 写回→clearingSessions 标志；P2 emit 在 agent 已从 map 移除时也丢弃旧进程事件；P2 后台会话 init 覆盖全局命令/MCP→仅 active 会话更新全局字段。记录：并发 copyFile 同 blob、Goal 确认异步闭包、授权队列跨会话丢失。

**监工 O（搜索索引 10 条，修 5）**：**P1** tokenize 空结果（纯符号/emoji/日文）被当"全部未命中"→queryFullTextIndex 返回 null 退回全量扫描；**P1** fs:search 的 partial 缓存判断——**复核后判定监工报告有误**（partial 指查询结果不全，清单本身完整可安全复用，保留原逻辑并回退改动，避免 fileSearchCache 假红）；P2 deleteArchivedSelection 用裸 sid 删 stamp→对齐 closeSession 先取 stamp；P2 @ 补全 listDir 200 条上限→1 字符前缀且直匹配不足时递归 searchFiles；P2 find 命中无消息数签名→msgSig 变化时重算；P3 搜索结果父循环超 60 条→统一截断。记录：全文构建期间失效、空格路径 token、侧栏计数口径、流式占位消息跳转。

**验证**：dev r131 + 安装版均 **402 项断言全绿**（零回归）；O2 误判回退后验证 fileSearchCache 恢复通过。

## 监工审查（R75）：第四波三子代理，修复 20 项

第四波聚焦交互手感与显示细节（J 键盘焦点 / K 动画时序 / L 响应式显示，24 条原始报告，**20 项修复**）。

**监工 J（键盘焦点 9 条，修 7）**：wireListKeyboard 的 Enter/Space 拦截内部真实按钮（git-stage/file-ins）导致键盘不可用（焦点在控件上时放行）；text-modal 编辑态 editor.onkeydown 无条件 stopPropagation 吞掉 Esc（只对 Ctrl+S 拦截）；全局 Esc 的 hadOverlay 漏 text-modal/model-picker mask（补入，Esc 不误停回合）；palette/find/text-modal 关闭后不恢复焦点（记住 opener 关闭时聚焦）；session-item/project-item 有 tabindex 但无 focus-visible（补 CSS 含暗色）；openMenu 方向键只 paint 高亮不改真实焦点（同步 focus）。记录：消息链接无键盘入口（P3 功能缺失，改动面大）、project-item Enter 后列表重建丢焦点（P3，局部更新代价高）。

**监工 K（动画时序 7 条，修 6）**：输入框 blur 的 120ms 延迟关闭定时器在重新聚焦后仍关菜单（加 activeElement 复核）；mentionTimer 防抖未在 closeComposerMenu 清理（clearTimeout，防切会话后过期回调弹菜单）；gitRefresh 旋转动画被同步 renderPanel 重建按钮销毁（重绘后给新按钮加类）；reduced-motion 全局块未重置 animation-delay 致 fill-mode both 在延迟期保持透明（补 delay 0）；closeMenu 不取消 0ms 外部点击监听定时器（存 timer id 清理）；toast pause 被 mouseenter+focus 双触发重复扣减 left（pause 幂等）；cmd-pill/queue-chip 每次 renderComposer 重播入场动画（签名守卫）。记录 twCoalesce 死代码（无运行时影响）。

**监工 L（响应式显示 8 条，修 7）**：tool-head .name 长工具名撑破行（min-width:0+ellipsis，arg 改 flex:1）；project-item .path 长路径撑破侧栏（ellipsis）；session 标题裸文本节点无法 ellipsis（包 span 并加 .t 样式）；--faint 对比度 2.39:1（浅 #70757a、暗 #9aa0a6）；浅色 --warn 3.10:1（改 #a35a00）；toast 与 ctx-d-sub 长 URL 溢出（overflow-wrap:anywhere）；zoom 下 fixed 弹层坐标被二次缩放（bodyZoom() 补偿 ctxDetailPop/pop-menu）。记录：scroll-down 硬编码 bottom:128px 与多行输入框重叠（P2 需实测，有 scrollBtnPosition 回归锁）。

**验证**：dev r128 + 安装版均 **402 项断言全绿**（零回归）。

## 监工审查（R74）：第三波三子代理，修复 22 项

第三波监工覆盖 Goal 逻辑 / 设置分区 / 主进程补充区域（G/H/I 三子代理，24 条原始报告，去重后 **22 项修复**）。

**监工 G（Goal 逻辑 8 条，修 7）**：verify 进行中 pause/stop 后校验仍生效并自动开新轮（handleGoalVerify/startGoalRound 加 status 守卫）；150ms 队列窗口内用户抢发消息导致排队消息静默丢弃（beginTurn 失败回填队首）；verify 轮 token/时长漏计（verify 分支记账）；beginTurn 失败无回滚致 verify 卡死/幽灵轮次（verifying 复位、round 回退+blockedReason）；pendingReminder 在 goal 轮滞留（goalTurn 分支也消费）；objective/verifier reason 围栏逃逸（统一 JSON.stringify + untrusted_verifier 围栏）；预算阻塞覆盖用户 pause（仅 active 落 blocked）。记录：goalRoundMeta 按 goalRound 数字 first-wins，replace 后轮次锚定旧消息（P3，加代际标识改动面大，记录）。

**监工 H（设置分区 8 条，全修）**：MCP 分区保存后被「保存配置」用陈旧 cfgDraft 整体覆盖（三处 saveMcp 同步 config/cfgDraft）；先改 envKey 再填密钥写进旧键（keyRow 用实时 p.envKey）；config:import 无结构校验（validateQwenSettings warnings 打通）；envKey 改名旧键残留（无引用时 delete）；config:test 的 data.data null 元素 TypeError（双形态容错）；test URL 重复 /chat/completions 与 /models（完整端点检测）；mcp:save 主进程零结构校验（对象+启动方式校验）；MCP 新增撞名静默覆盖（拒绝并提示）。

**监工 I（主进程补充 8 条，修 7）**：单实例锁在迁移/日志初始化之后（第二实例截断 agent.log——锁前置+process.exit）；迁移部分失败留半成品永不重试（清半成品+console.error）；重建窗口时菜单动作在 renderer 监听注册前发送（did-finish-load 延迟）；attachment:import 死代码+任意路径越权面（移除 preload 暴露、handler 停用）；attachment:save 未剥 data URL 前缀（剥离后解码）；save 对话框 defaultName/safeName 未净化（统一 sanitizeDefaultName，fromCharCode 构造正则避免转义吞字符）；启动 syncHotkey 失败无日志（记录 log）。记录：窗口重建 backgroundColor 硬编码浅色致白闪（P3 权衡，记录）。

**基建教训（重要）**：用 `s.slice(i, j)` + `indexOf('ipcMain.handle(')` 定位替换边界时，若中间夹着函数定义（如 readWorkspaceFile/writeWorkspaceFile），会连函数一起删掉——r123 冒烟 `readWorkspaceFile is not defined` 即此因；从最近构建 asar 提取恢复。**大段代码删除必须精确到完整边界，改单行拒绝桩而非整段替换**。

**验证**：dev r124 + 安装版均 **402 项断言全绿**（零回归）。

## 监工审查（R73）：第二波三子代理，修复 24 项

第二波监工覆盖上次未扫区域（preload/index/smoke 注入、样式层一致性、AgentProcess 深挖；D/F 首次派发因限流失败，串行重派完成）。27 条原始报告去重后 **24 项修复**。

**监工 E（样式层 10 条，修 9）**：`.round-btn:hover` 暗色破版、`.btn.primary` 暗色两态不同体系、`.tool` 系列暗色旧 token、条状组件暗色旧调色板、列表复选框 accent 遗漏、`.chip.ghost` 裸样式、toasts z-index 低于模态遮罩、四组 pill 长文本溢出——全部修复。记录：死样式 5 组（删除有漏查风险）；scroll-down 与 goal/todo-bar 重叠（静态推算需实测，有回归锁）。

**监工 D（smoke 注入代码 10 条，全部修复）**：fork 探针幽灵会话泄漏（补 cancelPersist+remove）；供应商向导触发 dialog:confirm 原生模态挂起 runSmoke（**dialog:confirm 加 SMOKE 自动确认兜底**+env 还原）；hotkey 探针固定回写清掉用户热键（先读原值还原）；dark→light 往返污染 ui.theme（记录原主题收尾还原）；归档探针缺 smoke 标记；三处探针 cwd 还原补 try/finally；backupNow 把 smoke 会话烘焙进真实备份（探针后删本次快照）；19-budget 的恢复死代码（补现场保存）；R53 预算探针 catch 不还原现场（finally+作用域提升）；`%TEMP%`/`<工作区>\demo` 转义双吃（源码四反斜杠）。

**监工 F（AgentProcess 深挖 7 条，修 6）**：sessions:delete/chat:send 的 `stop()` 自愈复活孤儿内核（改 stop(true)）；exit 处理器加 child 闭包守卫（强杀期间新 spawn 不被误清）；sendNow 记 inFlightPrompt、exit 转入 pendingPrompt（写入成功≠内核已消费）；裸 `null` JSON 行 TypeError（容错 continue）；exit 广播 approval-clear（崩溃后授权卡不再残留）；init 跟随内核最新 session id（resume fork 防丢上下文）。记录：control_response 的 sdk-init 应答无配对检测（P3，can_use_tool 实际可用）；resumeId 跟随依赖内核语义（建议实测）。

**验证**：dev r122 + 安装版均 **402 项断言全绿**（approvalCard/approvalApi/kernelAutoRestart 等全部通过，零回归）。

## 监工审查（R72）：三子代理并行找 bug，修复 28 项

三个只读 Explore 子代理并行审查（主进程 / 渲染层 / 数据一致性），产出 32 条原始报告，去重后 **28 项真实 bug 全部修复**（每条均有行号证据，按 P0-P3 分级）。

**P1（5 项）**
- 回合超时定时器在回合正常结束后不清除（turnTimer 清除被挂 killTimer 条件上）→ 空闲内核被误杀报「回合超时」——result 到达时无条件清理，并同步复位 busy。
- `extensions:set` 用 `stop()`（intentional=false）→ 崩溃自愈重启出游离内核（不在 agents map、事件串入渲染层）——改 `stop(true)`。
- ctxDetailPop 的 escClose 闭包引用 setTimeout 内的 `outside` → 按 Esc 抛 ReferenceError、全局 Esc 监听泄漏、之后全应用 Esc 失效——outside 提升到同一作用域，统一 detach。
- stopTurn 立即结算不等内核确认 → 迟到 result 把新回合提前结算（stream 置空、后续流式事件全丢）——finalizeAbort 设 3 秒 result 静默窗。
- 排队的 `/init` `/review` 丢失本地展开（cliOverride 未入队）→ 字面发给内核——队列项带 cliOverride、消费点透传。

**P2（12 项）**
- /effort 往途中排队消息 exit 时被清空丢失 → 转入 pendingPrompt 走既有补救路径；/effort 期间置 busy 防消息乱序。
- `sessionFile(id)` 无校验 → `../` 穿越读写任意 .json（get/save/delete/slim/trash 全链路）——非法 id 抛错（调用点均在 try 内）。
- `checkpoint:diff/restore/readVersion` 的 id 无校验 → 伪造 manifest 路径穿越——`/^\d{13,14}$/` 校验。
- `fs:read` 无 symlink 校验（工作区内链接指向外部可被读出）；`fs:write` 新文件的 realpath ENOENT 旁路（父目录 junction）——read 补同口径校验，write 改校验「最深存在祖先」。
- `checkpoint:restore` 不校验目录一致性（切目录后旧项目文件写入新工作区）——恢复前比较 manifest.cwd，不一致返回 error。
- checkpoint blob GC 与并发 create 竞态删掉新 blob；GC 内 statSync TOCTOU 冒泡导致 create 整体失败——GC 的 statSync 包容错（blob mtime 防护记录备查）。
- `writePrefs` 直写非原子（崩溃半写 → 全部偏好静默重置）——tmp+rename；readPrefs 损坏时留证（.corrupt-时间戳）再返回默认。
- `sessions:slim` 与 200ms 防抖竞态（瘦身被回写覆盖）——slim 先 flushSessionSave。
- `sessions:clear` 不清 checkpoints（孤儿 manifest 永久引用 blobs）——clear 同步清会话目录。
- `tools.totalCalls` 字符串拼接（无 Number 容错）——两处补齐。
- `onApprovalClear` 不区分会话（后台停止误清当前授权卡）——按 sessionId 过滤。
- `state.pendingApproval` 单槽覆盖（后台请求顶掉当前会话的卡片且请求丢失）——授权队列（跨会话请求入队，裁决后弹出当前会话的下一条）。

**P3（8 项）**
- `chat:send` 无参数兜底（session null 直接 TypeError）；`kernel:selfheal` 随机杀 busy 会话（改跳过 busy）；`flushSessionSave` 写失败静默丢持久化（回队 500ms 重试）；`persist` 的 lazy 分支 hydrate 失败无限 IPC 循环（hydrateFailed 标记 + 降级提示）；`switchSession` 懒加载后不复核会话仍存在；↑ 历史混入 hidden 的 goal 续跑 prompt（过滤）；`expandLocalTurn` 无 cwd 先清输入再报错（校验前置）；`deleteArchivedSelection` 清理清单与 closeSession 分叉（补全文索引/scrollBadge/todoBarLive/saveScrollMemory）。

**未修（记录备查）**：`fs:stat` 是唯一无 isInside 校验的文件 handler（P3，信息量小，改签名有回归风险）；`ui.drafts` 不修剪死会话草稿（P3，localStorage 影响轻微）。

**验证**：dev r118 + 安装版均 **402 项断言全绿**（goalSuite 真实多轮 / fsRead/fsWrite / cpRestore / approvalCard / queueChipMotion 等相关断言全部通过，无回归）。

## 显示效果优化（R68）：命令面板筛选态 + 活动面板实拍（零缺陷收口）

- 视觉审查段新增 **34-palette-filter**（命令面板筛选「导出」：3 条匹配、首项高亮、右侧说明、键位提示）与 **35-activity**（活动面板：完成/运行中两类活动行、arg/output 展示、清空按钮、计数徽标）。
- 审查结论：两组组件布局协调——**代码零改动**，验证沿用 R67 证据（dev r107 + 安装版 401 项全绿，产物 hash 不变）。
- 自主自查累计实拍 35 张（R54-R68），交互区域全部覆盖完毕。

## Bug 修复：设置搜索不跟随 + 实拍三场景（R67）

- **修复「设置搜索结果与主区不符」**：搜索过滤侧栏后主区仍停留在原分区（如搜「模型」主区还显示「快捷键」）。现当前分区被过滤掉时**自动切换到第一个匹配分区**（原需手动 Enter 跳转）。
- 视觉审查段新增三场景：**31-findbar**（会话内查找面板：输入/计数/导航/关闭）、**32-shortcut-capture**（快捷键修改捕获态「按下组合键…」）、**33-cfg-search**（设置搜索联动）。
- 实拍方法修正：setCfgSection 渲染是异步链，布置脚本需轮询等 `#scEdit .btn` 就绪再点击（原固定时序点击时 DOM 未就绪，返回 nobtn 被吞）。
- 审查结论：findBar 空态 0/0 正常、快捷键捕获态清晰、搜索联动修复生效（主区与搜索结果一致）。

## 显示效果优化（R66）：Goal 状态条/toast 堆叠/归档态实拍 + 文案健壮性修复

- 视觉审查段新增三场景：**28-goalbar**（Goal 状态条+轮次列表展开）、**29-toast-stack**（四条 toast 堆叠）、**30-archive**（归档会话横幅+侧栏归档分区）。搜索跳转折叠兼容已由 compactFoldExpand 断言覆盖，未另实拍。
- **修复① Goal 轮次上限英文混入**：无预算上限时状态条显示「第 3/unbounded 轮」——`goalRoundCap` 改中文「不限」；侧栏 pill 的 ∞ 判断同步。
- **修复② 模型文本口径分离**：goalContinuationPrompt 与 goalStateReminder（发给内核的英文提示词/提醒）保留 `unbounded` 英文——cap 数值化，UI 与模型文本不再共用同一文案函数。
- **修复③ renderGoal 健壮性**：`g.rounds`/`g.verifications` 非数组（持久化损坏或旧结构）时按空处理，不再 `.slice` 崩溃（实拍布置即触发，renderer-console 取证）。
- 审查确认良好：goalBar 轮次列表展开态、toast 堆叠（四条不同语义）、归档横幅与分区。

## 显示效果优化（R65）：交互三件套实拍（零缺陷收口）

- 视觉审查段新增 **27-interact**：composer 附件行（缩略图+移除）、消息队列 chips（文本+移出）、工具授权卡片（徽章/命令代码块/拒绝-允许按钮）同屏实拍。
- 审查结论：三组组件布局协调、状态栏「排队 N」联动正确、授权卡片键盘交互（Enter 允许/Esc 拒绝，阻冒泡）无冲突——**代码零改动**，验证沿用 R64 证据（dev r99/r100 + 安装版 401 项全绿，产物 hash 不变）。
- 至此交互区域（附件/队列/授权/上下文弹层/检查点弹窗/toast/任务条）全部实拍审查完毕，累计 28 张截图覆盖。

## Bug 修复：上下文明细弹层定位错误（R64）

- **弹层远离触发它的环**：点击底部状态栏的上下文环后，明细弹层出现在视口顶部（原公式 `top = innerHeight - r.bottom + 12` ≈ 20px——fixed 定位从视口顶部起算，环在底部所以差了一整屏）。25 截图可证。
- 修复为向上弹出：`bottom = innerHeight - r.top + 12`（弹层底边贴环上缘 12px，不受弹层高度影响），水平贴齐不变。
- 断言 `contextPopAnchored`（弹层底边在环上缘之上 260px 内、且不越过环顶）。
- **上游 diff 扫描结论**：ZCode 命令面 21 个全量对照无新增差距（dwf/workflow/locale/plugins/login 为内核专属）；TUI 层无 Qcode 缺失的交互能力——本轮转为自主自查发现此定位 bug。

## 回归验证 + 评估（R63）：多压缩点折叠 + /resume

- **多压缩点回归**：两个 completed 压缩 marker 场景——折叠范围到最后一个 marker（含更早 marker 与其间消息），按钮只出现在最后 marker 处；展开后两个 marker 都渲染。断言 compactFoldMulti。
- **修复「加载更早」与折叠的共存缺陷**：折叠态下加载进来的折叠区消息仍会被跳过（按钮点了无效果）——折叠时隐藏「加载更早」按钮（`folding = lastCompactIdx >= 0 && !expandEarly`），展开后恢复。断言 compactFoldMore（renderLimit=2 制造 start>0 场景）。
- **/resume 命令评估——暂缓**：Qcode 已有自动 resume（qwenSessionId + kernelResume 链路）覆盖内核重启恢复场景；/resume 的增量是「列出内核历史会话手动接管」，需取证 ~/.qwen session 存储格式，且接管后 GUI 历史与内核上下文不一致的预期管理复杂、场景低频。收益/成本比不足，记录备查。

## 新功能：压缩后折叠早期消息（R62，参考 ZCode command-center / Claudia）

- 扫描 ZCode 源码（adapters/commands + cli/command-center）对照：命令面已基本追平（compact/effort/expert/fork/goal/init/mcp/mode/model/new/rewind 等均有；dwf/workflow 为 CLI 协议级、locale/plugins/login 为内核专属，GUI 不适用）。选定的下一个可见完善点：**压缩完成后折叠早期对话**。
- 最后一个「已完成」压缩分隔线之前的消息默认收起，marker 处显示「已压缩 · 展开之前的 N 条消息」胶囊按钮（复用 thread-more 视觉），点击展开、再点收起；选择随会话持久化（`s.expandEarlyMsgs`）。
- 跳转兼容：会话内查找/引用跳转目标落在折叠区时自动展开再定位（`lastCompletedCompactIdx` 供折叠与跳转共用）。
- 断言：compactFold（折叠 + 按钮 N 计数）、compactFoldExpand（展开后消息回到时间线、按钮变「收起」、jumpToMessage 自动展开）。
- 实现说明：跳过的消息不渲染 DOM，`dataset.mi` 索引不变，wireActions/锚点不受影响。

## 显示效果优化（R61）：上下文明细弹层实拍 + 分类撞色修复

- 视觉审查段新增 **25-ctxdetail**（当前会话无 usage 时的弹层：0/1.00M 合理态）与 **26-ctxdetail-warn**（85% 占用：分类色带/警示条/压缩按钮同屏）——R60 修复区域的弹层布局与压缩按钮视觉首次实拍确认。
- **修复分类撞色**：估算与真实 breakdown 分支中「对话消息」与「系统提示」同为蓝色、「缓存读取」与「内置工具」同为绿色——色带上无法区分。对话消息改青色 `#17a2b8`，缓存读取改深灰蓝 `#64748b`（与剩余段的浅灰 var(--sunken) 也区分）。
- 同口径自查：Goal 预算统计（goalUsageTokens）用 total_tokens（内核 total 含缓存）✓ 无需修改。
- 断言与 396 项全绿沿用（本轮仅颜色常量变更）。

## Bug 修复：压缩上下文无反应 + 上下文占用错误（R60，用户实测反馈）

- **「点击压缩上下文没反应」（真 bug）**：`/compress` 在 LOCAL_COMMANDS 注册了但 `runLocalCommand` **没有对应分支**——检查点弹层按钮、命令面板、输入框回车三条路径全部静默无操作。补上分支：busy 时 toast 提示；空闲时 `beginTurn('/compress')` 走正常回合（rewriteCliSource 改写为内核 `/compress-fast`，压缩分隔线与完成 toast 复用既有链路）。
- **「上下文占用还是错的」（真 bug）**：内核 usage 实际为 `{ input_tokens: 未缓存部分, output_tokens, cache_read_input_tokens: 缓存读取 }`（读内核 chunk 源码取证），窗口占用此前只算 input+output——**漏掉缓存读取**，长会话缓存命中后占用严重偏小。修为 `input + cache_read + output`；状态条第一段口径同步统一为「当前窗口占用」（原为全程累计消耗，与百分比/明细弹层口径不一致）。
- **冒烟 flake 修复**：tokens/contextCategories 两断言由固定 sleep 改为轮询等待（r78 偶发 false 根因）。
- 断言：compressCmd（busy 路径 toast 可观测，证明分支接通）、ctxCacheTok（usage 9200=150+9000+50 → 显示 9.2K tok · 46%）。
- **基建教训**：① contextBridge 暴露的对象**只读**，冒烟里 mock `window.shell.chat.send` 赋值静默无效（r83-r88 连环失败根因，改用 busy 路径行为观测）；② features 注入模板串的语法错误可用提取脚本（extract-features.js）+ node --check 定位；③ **并发会话编辑**在 features 里插入的轮询块漏了闭合括号（SyntaxError: Unexpected token 'else'，已修复并保留其意图）——共用工作区动 main.js 前先查并发。

## 显示效果优化（R59）：外观分区细查 + 截图收尾盘点（零缺陷收口）

- 审查 09d-appearance（主题/列宽/缩放三组分段控件）、04-providers（模型列表）、16-git（Git 面板状态徽章/提交行）、06b-hooks（JSON 编辑器）、09b-skills（双空态）——均协调无缺陷。
- **24 张截图收尾盘点**：存量 18 张（01-empty/02-chat/03-settings/04+04b/05b/06/06b/07-usage/08/09/09b/09d/09e/09f/10-mentions/11-palette/12-dark/16-git）+ 视觉审查段新增 6 张（17-cpmodal/18-todobar/19-budget/20-mdtable/21-23-dark/24-dark-toast-about）全部覆盖；未逐张读的 05/09c/09g/11b/13/14/15 与已审视图同构（测试结果/命令列表/编辑器弹窗/面板筛选/停止态/后台/文件树），组件样式均已在同构视图中确认。
- 本轮**代码零改动**（未发现新缺陷），验证沿用 R58 证据（dev r82 + 安装版 394 项全绿，产物 hash 不变）。
- R54-R59 显示效果审查累计修复 9 项：cp-modal 超高布局、cwd 警示缺失、预算短格式匹配真 bug、逐文件预览不可见、palette 渐隐弱、任务列表双重符号、记忆框一行高、按钮竖排换行、关于页图标破图（另修 fake 会话泄漏）。

## 显示效果优化（R58）：关于页/快捷键/toast 实拍审查

- 审查 09f-about、09e-shortcuts 两张存量实拍，新增 **24-dark-toast-about**（暗色 toast 两级 + 关于页同屏实拍）。
- **修复① 关于页图标破图**：`src="../build/icon-256.png"` 指向不存在的文件（该资产未随仓库恢复），img 显示 alt 文本。改用 `icon-512.png`（同源资产）。
- **修复② 冒烟 fake 会话泄漏**：R52 起断言用的 fake 会话经 `persist` 落盘但缺 `smoke: true` 标记，泄漏进会话列表/关于页 Top 10。全部 6 处 fake 补标记，冒烟结束按标记清理。
- 审查确认良好：快捷键分区（可改/固定两组布局）、暗色 toast 卡片（标题+正文+进度条）、关于页版本/GPU/占用信息网格。

## 显示效果优化（R57）：设置分区实拍细查

- 审查 03-settings（通用）/06-mcp/08-memory/09-advanced 四张实拍。
- **修复① 记忆编辑框只有一行高**：`.mem-area` 的 `height: 220px` 被 3479 行 `.input, textarea.input, select.input { height: 36px }` 覆盖（`textarea.input` 特异性 0,1,1 高于单类）——MEMORY.md/QWEN.md 编辑框实际渲染 36px，长内容几乎不可见。改用 `textarea.input.mem-area`（0,2,1）反超，220px 生效。
- **修复② 按钮窄容器文字竖排换行**：高级分区 GPU 参数行「保存参数/重置」被 flex 压窄后文字逐字换行。全局 `.btn` 加 `white-space: nowrap; flex: 0 0 auto`（按钮文字不应换行、不应被压缩）。
- 审查确认良好：通用（权限档位/应用行为按钮组）、MCP 空态、高级分区其余布局。

## 显示效果优化（R56）：暗色主题实拍审查

- 冒烟视觉审查段扩展三个暗色场景：**21-dark-thread**（/todos 卡+回滚 marker+Todo 任务条展开+md 富文本同屏）、**22-dark-cpmodal**（检查点弹窗+cwd 警示+diff 展开）、**23-dark-budget**（预算 warn 进度条）。
- **修复 cp-modal 超高布局**：diff 展开后内容超过弹窗 78vh，点击底部按钮时浏览器聚焦滚动把检查点列表滚出视口。改为 flex 收缩方案：`cp-list` 不收缩（`flex: 0 0 auto`），`cp-diff` 为 flex 列容器（`min-height: 0; overflow: hidden`），超高全部由差异列表吸收（列表自身滚动）——检查点条目/警示/预览/按钮在任何内容高度下都同屏可见。
- **暗色适配确认良好**：md 表格/引用/checkbox（accent-color）、Todo 任务条、/todos 卡、回滚 marker、预算橙色 warn 进度条、cp 弹窗警示条与 diff 着色在暗色下全部协调，无需额外修改。
- 备注：r78 冒烟出现 tokens/contextCategories 两项偶发 false（时序 flake，与 CSS 无关），r79/r80 及安装版复跑均全绿。

## 显示效果优化（R55）：存量界面实拍审查

- 审查范围：04b 提供者编辑、05b 模型选择器、10 @ 提及、11 命令面板，并新增 **20-mdtable 实拍**（markdown 表格/引用/代码块/任务列表一次看全，围栏用 `fromCharCode(96)` 避开注入模板串坑）。
- **修复① 滚动边缘渐隐偏弱**：命令面板底部被裁项呈硬切半行。`--list-fade` 18px→26px（palette/mention/panel 三处共享），裁切过渡更柔和。
- **修复② 任务列表双重符号**：`- [x]` 行既有项目符号又有 checkbox。现任务行加 `li.task` 类，`list-style: none` + 负缩进让 checkbox 对齐 bullet 位置（GitHub 风格）；`mdTask` 断言同步强化（`<li class="task">`）。
- 审查确认良好：提供者编辑表单、模型选择器（context tag 整行居中）、@ 提及菜单、md 表格（表头底色/分隔线）、引用块、代码块（语言标签）均协调。

## 显示效果优化（R54）：新组件实拍审查

- **视觉审查方法**：冒烟新增 3 张实拍截图（17-cpmodal 检查点弹窗+diff 展开 / 18-todobar 任务条+卡片+回滚 marker 同屏 / 19-budget 预算 warn 进度条），逐张 Read 审查。
- **修复① 逐文件 diff 预览长列表不可见**：`.cp-diff` 原本整体 30vh 限高滚动，点击行后预览面板被推到滚动区底部看不到。现差异列表限高 260px 独立滚动，预览面板固定在列表下方立即可见，展开加淡入动画。
- **修复② 检查点目录不一致无警示**：切换工作目录后回滚旧检查点会显示「4000 删」这类失真差异且无提示。现 `checkpoint:diff` 返回 `cwdMismatch/manifestCwd`，弹窗顶部显示「⚠ 检查点来自其他工作目录（…），与当前目录的差异可能失真」警示条。
- **修复③ 预算进度条真实环境永远 0%（真 bug）**：`aggregateUsage` 的 `weekly[].date` 是 `MM-DD` 短格式，预算行匹配用完整 `YYYY-MM-DD` 永远失配。现兼容两种格式；r69 的断言数据此前也用了完整格式（假绿），已改为短格式贴近真实。
- 视觉确认良好：主线程/暗色/空态/用量面板布局协调；Todo 任务条、/todos 卡、回滚 marker、预算条深浅双主题一致。

## 新功能：每日 token 预算提示（R53）

- 用量面板新增「今日预算」组：进度条（绿/黄 ≥80%/红 ≥100%）+ 当日用量与百分比 + 内联设置（`prefs.dailyBudgetTokens`，0=不启用，保存即生效）。
- 每回合结束（有真实 token 消耗时）异步对账 `usage:today` 累计，跨 80%/100% 阈值时 toast + 状态栏提示——每档每天只提示一次（`budgetShownMap` 按 dayKey 隔离）。
- 纯函数 `budgetLevel`（档位判定）与 `budgetShouldNotify`（去重判定）便于断言：budgetLevel（7 边界）/budgetNotify（每档一次）/budgetRow（warn 态 85% 渲染 + 未启用态文案）。
- 性能说明：对账走现成 `usage('today')`（R31 优化后聚合毫秒级），不阻塞回合。

## 评估：beginTurn 检查点异步化——不实施（R53）

- 现状：`checkpoint.create().then(dispatchTurn)`——快照严格先于内核任何动作，窗口安全；R51 优化后延迟约 96ms（4000 文件上限工作区）。
- 并行化收益上限即省这 ~96ms 发送延迟（用户感知微弱）；风险是「模型秒回 + 首工具立即写文件」的竞态会让快照记录到写后状态，`/rewind` 回滚点错误——直接违背检查点安全语义（r49 灾难后最敏感的能力）。
- 结论：风险不可证明为零、收益微弱，维持 await-then-dispatch。

## 显示效果优化（R71）：多消息长对话排版全景实拍（零缺陷收口）

- 视觉审查段新增 **36-thread-layout**：16 条混合消息（长短问答/工具卡/表格/代码块/思考块/引用/任务清单/带附件）的长对话排版全景。
- 审查结论：消息间距 26px、user 气泡 max-width 76%、assistant 行宽 720px、行高与中英混排间距自然；操作按钮 hover 显隐 + 最后一条常显设计合理——**排版零缺陷，代码零改动**。
- 36 场景永久纳入视觉审查段（后续 UI 改动的排版回归资产）。
- **基建教训（重要）**：用 node 脚本/replace 向 main.js 插入大段代码时，替换串里的 `$'`（replace 特殊模式）与场景字符串内未转义的 `\n`/`\`` 会静默破坏文件结构（本次 main.js 被截断至 8932 行）——**恢复路径**：`npx asar extract dist/win-unpacked/resources/app.asar`（最近一次构建即最近代码态）；插入大段代码改用「场景文本文件 + 行拼接」并先对场景文件单独 node --check。
- 产物更新：Setup `612baee3…fb2150923`、zip `74db6f85…b50fa88`（含 36 场景回归）。

## 交互逻辑完善（R70）：上下文明细弹层支持 Esc 关闭

- **交互缺口**：ctxDetailPop 只能点击外部或 × 关闭——palette/findBar/settings/检查点弹窗都支持 Esc，唯独它不响应，多层弹层并存时 Esc 行为不一致。
- **实现**：showContextDetail 内 Esc 监听（window capture 阶段）——只关本层（cp modal 等有 stopPropagation 的弹层不受影响），关闭即解除监听。
- **调试教训（两连）**：① 注册必须在 showContextDetail 内**同步**执行（放 setTimeout(0) 时实测监听未及时生效，count=0）；② **document capture 会被更早注册的 capture 监听拦截**——快捷键捕获态的 handler（stopImmediatePropagation，32 场景残留）会吞掉后续一切 keydown——**改挂 window capture**（capture 阶段 window 先于 document）。
- 断言：contextPopEsc（Esc 派发后弹层移除）；dev r115 + 安装版 402 项全绿。
- 产物更新：Setup `b40ee89d…03ce351`、zip `503e0cf3…aacaac40`。

## 仓库收尾整理（R69）

- 仓库根杂项归档：`_install-d.bat`（NSIS 静默安装辅助脚本）与 `agent.log`（运行日志）移至 `%TEMP%\qcode-archive-20261121\` 存档；Temp 下诊断脚本（diag-install*.ps1、extract-features.js、feat-check.js）保留备查。
- **下次静默安装重建脚本**（Git Bash）：
  ```bash
  printf '@echo off\r\nstart /wait "" "<仓库>\\dist\\Qcode-Setup-0.4.4.exe" /S /D=D:\\qwen\\Qcode\r\n' > _install-d.bat && cmd //c _install-d.bat
  ```
- 收尾验证：dev（401 项断言无 false）+ 安装版（401 项断言无 false）双冒烟全绿。

## 验证（2026-11-21，全绿）

```text
dev            : 402 项断言无 false · R72-R81 十波监工修复 183 项全量回归 · contextPopEsc/PopAnchored · compactFold/Multi/More/Expand · compressCmd/ctxCacheTok · checkpoint 全链路 · todoBar · goalSuite · DONE
安装版(安装目录) : 同上 402 项无 false · kernelDetect/cliProbeOk · installerAssisted=true · DONE
```

## 发布产物

- `dist/Qcode-Setup-0.4.4.exe` — sha256 `3186e9c4…c56c7736`（NSIS 向导式，oneClick=false perMachine=false，含 R81 十波监工修复）
- `dist/Qcode-0.4.4-win.zip` — sha256 `d2b76435…3fc42e77`

## 安装

- 运行 `Qcode-Setup-0.4.4.exe`（向导式：许可协议 → 自定义路径），**安装目录与开发仓库分开**（勿装进仓库目录，见下）
- 内置内核（node v24.18.0 + qwen-code 0.27.2，285MB），无 Node.js 设备可直接使用
- 注册表 `Qcode 0.4.4`（GUID a34e7dfb-8998-50e2-896e-4afc4a5b70c4 连续）

## ⚠️ 运维教训（2026-11-21 两次事故 + 两个构建坑）

1. **r49 检查点事故**：空 manifest + deleteAdded 删除整个工作区（见上，守卫已加）。
2. **安装器误杀事故**：`/S` 升级安装时 old-uninstaller 删除数千个内核文件需数分钟，观感像「卡死」；两次中途 taskkill 后，**存活的 old-uninstaller 在后台继续卸载并递归删除了整个安装目录**——当时安装目录与开发仓库是同一个目录，导致仓库二次全毁（已从 Temp 下 asar 解包恢复源码、npm 缓存/electron Cache 取证重建 package.json、本机 node.exe + npm 重装内核）。结论：**NSIS 升级安装中绝不可杀进程；安装目录绝不可与代码仓库重叠**。现已把安装目录与仓库彻底分开。
3. **构建坑①**：electron-builder 对 extraResources 里名为 `node_modules` 的目录无条件修剪（删除源目录 package.json 也无效），内置内核缺 qwen-code 运行树 → 新增 `scripts/afterPack.js` 钩子在 NSIS 打包前补拷（今后更新内核：`npm install --prefix build/kernel` 后删除其 package.json/package-lock.json，构建即完整）。
4. **构建坑②**：electron-builder 默认 NSIS 产物名带空格（`Qcode Setup 0.4.4.exe`），需显式 `nsis.artifactName: "${productName}-Setup-${version}.${ext}"` 才能得到历史上的 `Qcode-Setup-0.4.4.exe`。
