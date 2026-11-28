'use strict';

const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  screen,
  Notification,
  Tray,
  Menu,
  nativeImage,
  nativeTheme,
  globalShortcut,
  session,
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { spawn, exec, execFile, execFileSync } = require('node:child_process');
const dns = require('node:dns');
const readline = require('node:readline');
const { createHash } = require('node:crypto');

// 只允许本应用窗口的 renderer 调用 IPC（纵深防御：sandbox/CSP 之外的补充）
const RENDERER_DIR_URL = pathToFileURL(path.join(__dirname, 'renderer')).href;
function isTrustedSender(event) {
  try {
    const url = event && event.senderFrame && event.senderFrame.url;
    return !!url && url.startsWith(RENDERER_DIR_URL + '/');
  } catch {
    return false;
  }
}
const rawIpcHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, listener) =>
  rawIpcHandle(channel, (event, ...args) => {
    if (!isTrustedSender(event)) {
      log('[ipc-blocked]', channel, (event && event.senderFrame && event.senderFrame.url) || '');
      return { ok: false, error: 'untrusted sender' };
    }
    return listener(event, ...args);
  });

let lastAppliedTheme = 'light'; // R77 监工P：最近一次 theme:apply 的主题，供窗口重建时设初始背景色
const SMOKE = process.argv.includes('--smoke');
const SMOKE_PERF = process.argv.includes('--smoke-perf');
const SMOKE_KERNEL = process.argv.includes('--smoke-kernel');
// R84：性能基准模式——真实 Chromium 里跑一组可重复的微基准后退出，用于「先测量再优化」
const BENCH = process.argv.includes('--bench');
// 诊断用：跳过 20MB 超大会话测试（用于判断 resize 期间那个 ~600ms 长任务的来源）
const BENCH_SKIP_HUGE = process.env.QCODE_BENCH_SKIP_HUGE === '1';
const SOAK = process.argv.includes('--soak');
const REALDATA = process.argv.includes('--realdata');
const E2E = process.argv.includes('--e2e');
const REWIND = process.argv.includes('--rewind');
const IDLE = process.argv.includes('--idle');
const PROBE = process.argv.includes('--probe');
// 确定性演练：让内核解析恒为 null，验证「完全没有可用 CLI」时的界面（不依赖真实删文件）
const PROBE_NOKERNEL = process.argv.includes('--probe-nokernel');
// R92：泄漏检查的轮数可配（--soak-cycles=800），并暴露 gc() 用于「GC 后保留内存」采样
const SOAK_CYCLES = (() => {
  const m = /--soak-cycles=(\d+)/.exec(process.argv.join(' '));
  const n = m ? Number(m[1]) : 0;
  return n > 0 && n <= 5000 ? n : 200;
})();
// R92：二分用——只跑某一种操作，定位是哪一步在累积（switch / stream / theme / all）
const SOAK_MODE = (() => {
  const m = /--soak-mode=([\w,]+)/.exec(process.argv.join(' '));
  // 默认取真实会发生的组合：切会话 + 流式。theme 是人工压力项（每次都会翻转 nativeTheme 触发整窗重绘），
  // 需要时用 --soak-mode=switch,stream,theme 显式开启。
  return m ? m[1] : 'switch,stream';
})();
if (SOAK) app.commandLine.appendSwitch('js-flags', '--expose-gc');
const BOOT_T0 = Date.now();
let QWEN_CMD = process.env.QWEN_CMD || 'qwen';

// 应用更名 Qcode：显式设置应用名，并迁移旧的 Qwen Agent 用户数据（只补缺失项）
app.setName('Qcode');
if (process.env.QCODE_USER_DATA) {
  try {
    app.setPath('userData', path.resolve(process.env.QCODE_USER_DATA));
  } catch {
    /* ignore test override */
  }
}
// R74（监工I）：单实例锁必须在迁移/日志初始化之前——第二实例原实现只 app.quit() 但代码
// 继续同步执行，会用同一 userData 截断第一实例正在写的 agent.log、并发重跑迁移
const hasSingleLock = app.requestSingleInstanceLock();
if (!hasSingleLock) {
  app.quit();
  process.exit(0); // 立即终止，不执行后续任何初始化
}

try {
  const appData = app.getPath('appData');
  const oldData = path.join(appData, 'Qwen Agent');
  const newData = path.join(appData, 'Qcode');
  if (fs.existsSync(oldData)) {
    fs.mkdirSync(newData, { recursive: true });
    for (const item of fs.readdirSync(oldData)) {
      const from = path.join(oldData, item);
      const to = path.join(newData, item);
      if (fs.existsSync(to)) continue;
      try {
        fs.cpSync(from, to, { recursive: true });
      } catch (e) {
        // R74（监工I）：清掉半成品目录——否则下次启动 existsSync(to) 为真直接 continue，
        // 剩余文件永远迁不过去（用户会话静默缺失）
        try {
          fs.rmSync(to, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
        // log() 尚未初始化（在迁移代码之后定义），此处用 console.error 留痕
        console.error('[migrate] failed', item, String((e && e.message) || e));
      }
    }
  }
} catch {
  /* ignore migration errors */
}

// Windows 通知/任务栏需要显式 AppUserModelID
app.setAppUserModelId('com.ljanx.qcode');

// 打包后 __dirname 位于 asar 内只读，运行期产物统一写 userData
const WRITABLE_DIR = app.isPackaged ? app.getPath('userData') : __dirname;

// R228：自检夹具的工作区基线。以前写死作者本机路径（作者本机的 D 盘工作区、仓库绝对路径），
// 换机器/换盘符/开源后他人 clone 都跑不起来，还会把探针文件写进仓库根。
// 现在统一用一个临时工作区，并按需初始化为 git 仓库。
const DEV_REPO_DIR = __dirname.replace(/\\/g, '/');
let devWorkspaceDir = '';
function devWorkspace() {
  if (devWorkspaceDir) return devWorkspaceDir;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qcode-devws-'));
  const write = (rel, text) => {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text, 'utf8');
  };
  write('package.json', JSON.stringify({ name: 'qcode', version: '0.0.0', private: true }, null, 2) + '\n');
  write('qcode-project-probe.txt', '# probe\n');
  write('qwen-demo.txt', 'qwen\n');
  write('alpha/readme.md', 'alpha\n');
  write('src/main.ts', 'export const x = 1;\n');
  // 文件搜索 / Git 面板的断言需要一个真实仓库；没有 git 时这些断言会失败，属预期（文档已说明）
  try {
    const opts = { cwd: dir, stdio: 'ignore' };
    execFileSync('git', ['init'], opts);
    execFileSync('git', ['add', '-A'], opts);
    execFileSync('git', ['-c', 'user.email=dev@qcode.local', '-c', 'user.name=qcode-dev', 'commit', '-m', 'init'], opts);
  } catch {
    /* 无 git 可用时保留普通目录 */
  }
  devWorkspaceDir = dir.replace(/\\/g, '/');
  return devWorkspaceDir;
}
const LOG_FILE = path.join(WRITABLE_DIR, 'agent.log');
try {
  fs.writeFileSync(LOG_FILE, '');
} catch {
  /* ignore */
}
let logBytes = 0;
// 兜底把主进程异常写进 agent.log，方便排查
process.on('uncaughtException', (e) => {
  log('[uncaught]', String((e && e.stack) || e));
});
process.on('unhandledRejection', (e) => {
  log('[unhandledRejection]', String((e && e.stack) || e));
});

function redactSecrets(text) {
  return String(text == null ? '' : text)
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***')
    .replace(/(Bearer\s+)[A-Za-z0-9._-]{12,}/gi, '$1***')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, 'eyJ***')
    // R82：键名覆盖 apiKey/access_token/refresh_token/client_secret/password 等常见变体，
    // 仅按值长度≥8 脱敏，避免把 enabled/true 之类的短值误伤
    .replace(
      /("?[A-Za-z0-9_.-]*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|client[_-]?secret|secret|password|passwd|authorization)[A-Za-z0-9_.-]*"?\s*[:=]\s*"?)[^"\s,}]{8,}/gi,
      '$1***'
    );
}

function log(...args) {
  const line = `[${new Date().toISOString()}] ${redactSecrets(args.join(' '))}\n`;
  try {
    fs.appendFileSync(LOG_FILE, line);
    logBytes += Buffer.byteLength(line);
    // 单次运行日志超过 5MB 时轮转，避免长期占用与写入变慢
    if (logBytes > 5 * 1024 * 1024) {
      try {
        fs.rmSync(LOG_FILE + '.1', { force: true });
        fs.renameSync(LOG_FILE, LOG_FILE + '.1');
        fs.writeFileSync(LOG_FILE, '');
        logBytes = 0;
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ */
/* 会话存储                                                            */
/* ------------------------------------------------------------------ */

const DATA_DIR = path.join(app.getPath('userData'), 'sessions');
const TRASH_DIR = path.join(DATA_DIR, '.trash');
const BACKUP_DIR = path.join(app.getPath('userData'), 'backups');
fs.mkdirSync(DATA_DIR, { recursive: true });

function sessionFile(id) {
  // R72（监工A）：id 来自渲染层，必须校验——否则 ../ 穿越可读写任意 .json
  // （与 checkpoint 系列的 CHECKPOINT_SESSION_ID_RE 同一防护口径）。
  // 非法 id 直接抛错：调用点均在 handler 的 try 内，会被捕获并返回 error。
  if (!CHECKPOINT_SESSION_ID_RE.test(String(id || ''))) {
    throw new Error('invalid session id');
  }
  return path.join(DATA_DIR, `${id}.json`);
}

async function loadSessions() {
  let names;
  try {
    names = await fs.promises.readdir(DATA_DIR);
  } catch {
    return [];
  }
  const files = names.filter((f) => f.endsWith('.json'));
  const out = [];
  let cursor = 0;
  // 并发读 8 个：避免启动时 readFileSync 逐个大文件把主进程锁住
  const worker = async () => {
    while (cursor < files.length) {
      const f = files[cursor++];
      try {
        const session = JSON.parse(await fs.promises.readFile(path.join(DATA_DIR, f), 'utf8'));
        if (!isSessionRecord(session)) throw new Error('invalid session record');
        out.push(session);
      } catch {
        // 解析失败的文件改名留证，别让它每次启动都报错
        try {
          await fs.promises.rename(path.join(DATA_DIR, f), path.join(DATA_DIR, f + '.bad'));
          log('quarantined bad session', f);
        } catch {
          /* ignore */
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, files.length) }, worker));
  return out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

/* ---------------- 会话索引：归档会话启动时不读全文 ---------------- */

const SESSION_INDEX_FILE = path.join(app.getPath('userData'), 'sessions-index.json');
let sessionIndex = null;
let sessionIndexTimer = 0;
let sessionIndexDirty = false;
let sessionIndexWriteAttempts = 0;

function sessionMeta(s) {
  return {
    id: String(s.id || ''),
    title: s.title || '未命名会话',
    cwd: s.cwd || '',
    model: s.model || '',
    modelLabel: s.modelLabel || '',
    reasoningEffort: s.reasoningEffort || '',
    approvalMode: s.approvalMode || 'auto',
    createdAt: s.createdAt || 0,
    updatedAt: s.updatedAt || 0,
    archived: s.archived === true,
    pinned: s.pinned === true,
    messageCount: Array.isArray(s.messages) ? s.messages.length : 0,
  };
}

function loadSessionIndexFile() {
  try {
    const raw = JSON.parse(fs.readFileSync(SESSION_INDEX_FILE, 'utf8'));
    if (!Array.isArray(raw)) return new Map();
    const map = new Map();
    for (const item of raw) {
      if (item && item.id) map.set(String(item.id), { ...sessionMeta(item), ...item });
    }
    return map;
  } catch {
    return new Map();
  }
}

function writeSessionIndexNow() {
  if (!sessionIndex) return;
  clearTimeout(sessionIndexTimer);
  sessionIndexTimer = 0;
  try {
    const tmp = SESSION_INDEX_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify([...sessionIndex.values()]), 'utf8');
    fs.renameSync(tmp, SESSION_INDEX_FILE);
    sessionIndexDirty = false;
    sessionIndexWriteAttempts = 0;
  } catch (err) {
    sessionIndexWriteAttempts++;
    log('session index write failed', String((err && err.message) || err));
    if (sessionIndexWriteAttempts <= 3) {
      sessionIndexTimer = setTimeout(writeSessionIndexNow, 500);
    } else {
      try { fs.rmSync(SESSION_INDEX_FILE + '.tmp', { force: true }); } catch { /* ignore */ }
    }
  }
}

function scheduleSessionIndexWrite() {
  sessionIndexDirty = true;
  sessionIndexWriteAttempts = 0;
  clearTimeout(sessionIndexTimer);
  sessionIndexTimer = setTimeout(writeSessionIndexNow, 250);
}

function flushSessionIndex() {
  clearTimeout(sessionIndexTimer);
  if (sessionIndexDirty || sessionIndex) writeSessionIndexNow();
}

function updateSessionIndex(session) {
  if (!session || !session.id) return;
  if (!sessionIndex) sessionIndex = loadSessionIndexFile();
  sessionIndex.set(String(session.id), sessionMeta(session));
  scheduleSessionIndexWrite();
}

function removeSessionIndex(id) {
  if (!sessionIndex) sessionIndex = loadSessionIndexFile();
  if (sessionIndex.delete(String(id))) scheduleSessionIndexWrite();
}

// R84：carry 复用——refresh 为了建索引已经把文件读过并 parse 过，loadSessionsIndexed 不必再读一遍
async function refreshSessionIndex(carry) {
  if (!sessionIndex) sessionIndex = loadSessionIndexFile();
  let names = [];
  try {
    names = (await fs.promises.readdir(DATA_DIR)).filter((f) => f.endsWith('.json'));
  } catch {
    names = [];
  }
  const live = new Set(names.map((f) => f.slice(0, -5)));
  let changed = false;
  for (const id of [...sessionIndex.keys()]) {
    if (!live.has(id)) {
      sessionIndex.delete(id);
      changed = true;
    }
  }
  const missing = names.filter((name) => !sessionIndex.has(name.slice(0, -5)));
  let cursor = 0;
  const worker = async () => {
    while (cursor < missing.length) {
      const name = missing[cursor++];
      const id = name.slice(0, -5);
      try {
        const full = JSON.parse(await fs.promises.readFile(path.join(DATA_DIR, name), 'utf8'));
        if (!isSessionRecord(full)) continue;
        sessionIndex.set(id, sessionMeta(full));
        if (carry) carry.set(id, full);
        changed = true;
      } catch {
        /* bad files are quarantined by loadSessions */
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, missing.length) }, worker));
  if (changed) scheduleSessionIndexWrite();
  return sessionIndex;
}

// R84：首屏只带「最近/置顶」会话的正文，其余以 lazy 存根返回（点开时 sessions:get 补全，渲染层已有该链路）。
// 重度用户（300+ 会话、数十 MB）启动不再全量读盘+parse+IPC；搜索索引由渲染层后台补水逐步补齐。
// 预算按「会话数 + 消息数」双阈值：普通用户（几十个会话）行为完全不变。
const SESSION_EAGER_MAX = 40;
const SESSION_EAGER_MESSAGES = 4000;

function pickEagerSessions(metas) {
  const keep = new Set();
  let count = 0;
  let messages = 0;
  // 置顶优先：用户主动钉住的会话必须常在，不受首屏预算影响
  for (const m of metas || []) {
    if (!m || m.archived || !m.pinned) continue;
    keep.add(m.id);
    count++;
    messages += m.messageCount || 0;
  }
  for (const m of metas || []) {
    if (!m || m.archived || m.pinned || keep.has(m.id)) continue;
    if (count >= SESSION_EAGER_MAX) break;
    if (messages + (m.messageCount || 0) > SESSION_EAGER_MESSAGES) break;
    keep.add(m.id);
    count++;
    messages += m.messageCount || 0;
  }
  return keep;
}

function isSessionRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value) && typeof value.id === 'string' && !!value.id;
}

async function loadSessionsIndexed() {
  const parsed = new Map();
  const idx = await refreshSessionIndex(parsed);
  const metas = [...idx.values()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const eager = pickEagerSessions(metas);
  const out = [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < metas.length) {
      const meta = metas[cursor++];
      if (!eager.has(meta.id)) {
        out.push({ ...meta, messages: [], lazy: true });
        continue;
      }
      const carried = parsed.get(meta.id);
      if (carried) {
        out.push(carried);
        continue;
      }
      try {
        const full = JSON.parse(await fs.promises.readFile(sessionFile(meta.id), 'utf8'));
        out.push(isSessionRecord(full) ? full : { ...meta, messages: [], lazy: true });
      } catch {
        out.push({ ...meta, messages: [], lazy: true });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, metas.length) }, worker));
  return out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

const pendingSessionSaves = new Map(); // id -> { file, data, timer }
// R134：删除墓碑——阻止删除/清空后迟到的 sessions:save 或重试定时器把旧会话写回来。
const deletedSessionIds = new Set();
function rememberDeletedSession(id) {
  if (!id || !CHECKPOINT_SESSION_ID_RE.test(String(id))) return;
  deletedSessionIds.delete(String(id));
  deletedSessionIds.add(String(id));
  // 有界：正常会话 id 不会复用，保留最近 2000 个删除记录足够覆盖迟到回调
  while (deletedSessionIds.size > 2000) deletedSessionIds.delete(deletedSessionIds.values().next().value);
}
function allowRestoredSession(id) {
  deletedSessionIds.delete(String(id || ''));
}
let sessionSaveRequests = 0;
let sessionWriteCount = 0;
let sessionSerializeCount = 0; // 会话序列化次数（防回归：多次 persist 不应多次 stringify）

/* ---------------- 会话每日备份 ---------------- */

function listSessionBackups() {
  try {
    return fs
      .readdirSync(BACKUP_DIR)
      .filter((f) => /^sessions-.*\.json$/.test(f))
      .map((f) => {
        const full = path.join(BACKUP_DIR, f);
        let size = 0;
        let mtime = 0;
        try {
          const st = fs.statSync(full);
          size = st.size;
          mtime = st.mtimeMs;
        } catch {
          /* ignore */
        }
        return { name: f, size, mtime };
      })
      .sort((a, b) => b.mtime - a.mtime);
  } catch {
    return [];
  }
}

// R96：备份体积按 UTF-8 落盘字节计量（抽成函数便于断言）
function backupBytesOf(session) {
  return Buffer.byteLength(JSON.stringify(session), 'utf8');
}

// R98：备份调度器——首次 20 秒后跑；若有回合正在运行则顺延（最多 5 次），
// 之后每 6 小时再来一次（`backupSessions` 自带「距上次不足 24h 直接跳过」，所以这只是廉价检查）。
function scheduleSessionBackup(delayMs = 20000, attempt = 0) {
  setTimeout(() => {
    const busy = [...agents.values()].some((a) => a && a.busy);
    if (busy && attempt < 5) {
      scheduleSessionBackup(30000, attempt + 1);
      return;
    }
    backupSessions()
      .catch((e) => log('session backup failed', String((e && e.message) || e)))
      .finally(() => scheduleSessionBackup(6 * 3600 * 1000, 6));
  }, delayMs);
}

async function backupSessions(force = false) {
  // R76 监工M：备份前冲刷 200ms 防抖待写队列与索引——否则备份不含最后一次修改（P1）
  flushSessionSaves();
  flushSessionIndex();
  if (pendingSessionSaves.size) {
    return { ok: false, error: '仍有会话保存失败，已取消备份', pending: [...pendingSessionSaves.keys()] };
  }
  const backups = listSessionBackups();
  if (!force && backups.length && Date.now() - backups[0].mtime < 86400000) {
    return { ok: true, skipped: true, last: backups[0], dir: BACKUP_DIR, count: backups.length };
  }
  const sessions = await loadSessions();
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const file = path.join(BACKUP_DIR, `sessions-${stamp}.json`);
    const tmp = file + '.tmp';
    // R81 监工AB：超大会话集合（100×10MB）全量 stringify 会 OOM 冻结主进程——限制总量并告警
    // R83 监工AE4：原守卫按「会话个数」限流，既挡不住 500×10MB 的 stringify OOM，又会静默丢会话
    const BACKUP_BYTE_MAX = 64 * 1024 * 1024;
    const saved = [];
    let bytes = 0;
    for (const s of sessions) {
      let len = 0;
      try {
        // R96：按 UTF-8 实际落盘字节计量（原按 UTF-16 字符数，中文密集会话真实体积可达 3 倍，
        // 会让 64MB 上限形同虚设）
        len = backupBytesOf(s);
      } catch {
        continue; // 循环引用等异常会话跳过
      }
      if (len > BACKUP_BYTE_MAX) continue; // 单条超限也跳过，首条不能绕过总量预算
      if (bytes + len > BACKUP_BYTE_MAX && saved.length) break;
      bytes += len;
      saved.push(s);
    }
    const dropped = sessions.length - saved.length;
    if (dropped > 0) log('[backup] truncated', String(saved.length), 'of', String(sessions.length), 'bytes', String(bytes));
    const payload = JSON.stringify({ __backup: true, truncated: dropped > 0, total: sessions.length, saved: saved.length, sessions: saved });
    // R98：14.5MB/800 会话下原来的 writeFileSync 会同步阻塞主进程 ~25ms（叠加 JSON.parse 的 CPU），
    // 又正好落在启动后 3 秒——改成异步写，且调用点推迟到空闲期（见 scheduleSessionBackup）
    await fs.promises.writeFile(tmp, payload, 'utf8');
    await fs.promises.rename(tmp, file);
    // 只保留最近 3 份
    for (const old of listSessionBackups().slice(3)) {
      try {
        fs.unlinkSync(path.join(BACKUP_DIR, old.name));
      } catch {
        /* ignore */
      }
    }
    const last = listSessionBackups()[0];
    log('session backup', file, 'count', String(saved.length), 'total', String(sessions.length));
    return {
      ok: true,
      skipped: false,
      last,
      dir: BACKUP_DIR,
      count: listSessionBackups().length,
      savedCount: saved.length,
      dropped,
      bytes,
    };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// 回合中的 assistant/tool 事件会频繁 persist：合并 200ms 内的重复写入，
// 避免每个事件都同步序列化 + 落盘整个会话，卡住主进程的 IPC/流事件。
function saveSession(session) {
  if (!session || !session.id || deletedSessionIds.has(String(session.id))) return;
  session.updatedAt = Date.now();
  updateSessionIndex(session);
  const prev = pendingSessionSaves.get(session.id);
  if (prev) clearTimeout(prev.timer);
  // 序列化推迟到 flush 截止点：同一会话 200ms 内的多次 persist 只 stringify 最终状态一次，
  // 避免每次 persist 都做一次昂贵且随即被丢弃的 JSON.stringify（大会话尤其明显）。
  const entry = { file: sessionFile(session.id), session, timer: null };
  entry.timer = setTimeout(() => flushSessionSave(session.id), 200);
  pendingSessionSaves.set(session.id, entry);
}

// R88：会话持久化失败不能静默（AD-7 遗留）——磁盘满/文件被占用时 3 次重试后会丢弃本次改动，
// 原来只写 console.error，界面完全无感。这里通过事件把失败/恢复告诉渲染层。
const saveFailedSessions = new Set();
function notifySaveError(id, err) {
  saveFailedSessions.add(id);
  sendRendererEvent('sessions:save-error', {
    id,
    error: String((err && (err.code || err.message)) || err || '写入失败'),
  });
}
function notifySaveOk(id) {
  if (!saveFailedSessions.delete(id)) return;
  sendRendererEvent('sessions:save-ok', { id });
}

function cleanupSessionTemp(id) {
  try { fs.rmSync(sessionFile(id) + '.tmp', { force: true }); } catch { /* ignore */ }
}

function flushSessionSave(id) {
  const entry = pendingSessionSaves.get(id);
  if (!entry) return;
  clearTimeout(entry.timer);
  pendingSessionSaves.delete(id);
  let data;
  try {
    data = JSON.stringify(entry.session);
  } catch (err) {
    console.error('[session] serialize failed', err);
    notifySaveError(id, err);
    cleanupSessionTemp(id);
    return;
  }
  sessionSerializeCount++;
  try {
    const tmp = entry.file + '.tmp';
    fs.writeFileSync(tmp, data, 'utf8');
    fs.renameSync(tmp, entry.file);
    sessionWriteCount++;
    notifySaveOk(id);
  } catch (err) {
    // R72（监工C）：写失败（Windows 下 rename 目标被并发读持有即 EPERM）把 entry 放回
    // 待写队列短暂重试——否则本轮最后一次 persist 静默丢失，崩溃后丢末段消息
    // R80 监工Y：重试有上限——磁盘满时不再无限 500ms 重试并持有完整 session
    entry.attempts = (entry.attempts || 0) + 1;
    if (entry.attempts > 3) {
      console.error('[session] save failed after 3 attempts, dropped', id, err);
      // R88：重试耗尽＝本次改动真的丢了，必须让用户知道（磁盘满/目录只读/文件长期被占用）
      notifySaveError(id, err);
      cleanupSessionTemp(id);
      return;
    }
    console.error('[session] save failed, retry', entry.attempts, err);
    entry.timer = setTimeout(() => flushSessionSave(id), 500);
    pendingSessionSaves.set(id, entry);
  }
}

function flushSessionSaves() {
  for (const id of [...pendingSessionSaves.keys()]) flushSessionSave(id);
}

function flushSessionSavesForBackground() {
  // 关闭到托盘不是退出，但应立即落盘已收到的保存；渲染层随后 visibilitychange 还会补发最终草稿
  flushSessionSaves();
}

function dropSessionSave(id) {
  const entry = pendingSessionSaves.get(id);
  if (entry) {
    clearTimeout(entry.timer);
    pendingSessionSaves.delete(id);
  }
  cleanupSessionTemp(id);
  saveFailedSessions.delete(String(id || ''));
}

function dropAllSessionSaves() {
  for (const entry of pendingSessionSaves.values()) clearTimeout(entry.timer);
  pendingSessionSaves.clear();
  saveFailedSessions.clear();
  for (const f of fs.readdirSync(DATA_DIR)) {
    if (f.endsWith('.json.tmp')) cleanupSessionTemp(f.slice(0, -'.json.tmp'.length));
  }
}

function pruneTrash(max) {
  try {
    const files = fs
      .readdirSync(TRASH_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        const full = path.join(TRASH_DIR, f);
        let mtime = 0;
        try {
          mtime = fs.statSync(full).mtimeMs;
        } catch {
          mtime = 0;
        }
        return { f, mtime };
      })
      .sort((a, b) => b.mtime - a.mtime);
    for (const x of files.slice(max || 50)) {
      try {
        fs.unlinkSync(path.join(TRASH_DIR, x.f));
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
}

function moveSessionToTrash(file) {
  if (!fs.existsSync(file)) return false;
  fs.mkdirSync(TRASH_DIR, { recursive: true });
  const target = path.join(TRASH_DIR, Date.now() + "-" + path.basename(file));
  try {
    fs.renameSync(file, target);
  } catch {
    fs.copyFileSync(file, target);
    fs.unlinkSync(file);
  }
  return true;
}

function deleteSessionFile(id) {
  // R83 监工AD5：删除失败不能吞掉——文件被占用（EPERM/EBUSY）时原实现仍删索引并返回成功，
  // 下一轮 refreshSessionIndex 又把会话「复活」，而检查点已被删
  let ok = false;
  try {
    const file = sessionFile(id);
    // 文件本来就不存在＝幂等删除，按成功处理（moveSessionToTrash 对缺失文件返回 false）
    ok = fs.existsSync(file) ? moveSessionToTrash(file) : true;
    pruneTrash(50);
  } catch (e) {
    log('session delete failed', String(id), String((e && e.message) || e));
    return false;
  }
  removeSessionIndex(id);
  if (ok !== false) rememberDeletedSession(id);
  return ok !== false;
}

/* ------------------------------------------------------------------ */
/* Qwen CLI 进程管理                                                    */
/* ------------------------------------------------------------------ */

function findOnPath(names) {
  const dirs = String(process.env.PATH || "").split(path.delimiter);
  for (const dir of dirs) {
    if (!dir) continue;
    for (const name of names) {
      const full = path.join(dir, name);
      try {
        if (fs.existsSync(full) && fs.statSync(full).isFile()) return full;
      } catch {
        /* ignore */
      }
    }
  }
  return null;
}

function commonBinDirs() {
  const out = [];
  const add = (p) => {
    if (p && !out.includes(p)) out.push(p);
  };
  add(path.join(process.env.APPDATA || '', 'npm'));
  add(path.join(process.env.ProgramFiles || '', 'nodejs'));
  add(path.join(process.env['ProgramFiles(x86)'] || '', 'nodejs'));
  add(path.join(process.env.LOCALAPPDATA || '', 'Programs', 'nodejs'));
  add(path.join(app.getPath('userData'), 'kernel', 'node_modules', '.bin'));
  return out.filter((d) => d && fs.existsSync(d));
}

function findQwenExecutable() {
  const onPath = findOnPath(['qwen.cmd', 'qwen.exe', 'qwen.bat']);
  if (onPath) return onPath;
  for (const dir of commonBinDirs()) {
    for (const name of ['qwen.cmd', 'qwen.exe', 'qwen.bat']) {
      const full = path.join(dir, name);
      try {
        if (fs.existsSync(full) && fs.statSync(full).isFile()) return full;
      } catch {
        /* ignore */
      }
    }
  }
  return null;
}

function findNodeExecutable() {
  const onPath = findOnPath(['node.exe', 'node']);
  if (onPath) return onPath;
  for (const dir of commonBinDirs()) {
    const full = path.join(dir, 'node.exe');
    try {
      if (fs.existsSync(full) && fs.statSync(full).isFile()) return full;
    } catch {
      /* ignore */
    }
  }
  return null;
}

function findNpmExecutable() {
  const onPath = findOnPath(['npm.cmd', 'npm.exe', 'npm']);
  if (onPath) return onPath;
  for (const dir of commonBinDirs()) {
    for (const name of ['npm.cmd', 'npm.exe']) {
      const full = path.join(dir, name);
      try {
        if (fs.existsSync(full) && fs.statSync(full).isFile()) return full;
      } catch {
        /* ignore */
      }
    }
  }
  return null;
}

function kernelInstallDir() {
  return path.join(app.getPath('userData'), 'kernel');
}

function localKernelEntry() {
  return path.join(
    kernelInstallDir(),
    'node_modules',
    '@qwen-code',
    'qwen-code',
    'cli-entry.js'
  );
}

function quoteCmdArg(value) {
  const s = String(value || '');
  return /[\s"]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

async function installKernel() {
  const npm = findNpmExecutable();
  const node = findNodeExecutable();
  if (!npm || !node) {
    return {
      ok: false,
      needNode: true,
      error: '未找到 Node.js / npm，请先安装 Node.js 20+ 后重试',
    };
  }
  const dir = kernelInstallDir();
  fs.mkdirSync(dir, { recursive: true });
  const args = [
    'install',
    '@qwen-code/qwen-code@0.27.2',
    '--prefix',
    dir,
    '--omit=dev',
    '--no-audit',
    '--no-fund',
    '--loglevel=error',
    '--registry=https://registry.npmmirror.com',
  ];
  const npmCli = path.join(path.dirname(npm), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const useNodeCli = fs.existsSync(npmCli);
  const command = 'call ' + [npm, ...args].map(quoteCmdArg).join(' ');
  const result = await new Promise((resolve) => {
    let output = '';
    let child;
    try {
      child = useNodeCli
        ? spawn(node, [npmCli, ...args], {
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
          })
        : spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', command], {
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
          });
    } catch (e) {
      resolve({ ok: false, error: String((e && e.message) || e) });
      return;
    }
    const timer = setTimeout(() => {
      try {
        killChildTree(child);
      } catch {
        /* ignore */
      }
      resolve({ ok: false, error: '安装超时（5 分钟）' });
    }, 300000);
    child.stdout.on('data', (c) => {
      output = (output + c.toString()).slice(-4000);
    });
    child.stderr.on('data', (c) => {
      output = (output + c.toString()).slice(-4000);
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, error: String((e && e.message) || e) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code, output });
    });
  });
  if (!result.ok) {
    return {
      ok: false,
      needNode: !npm || !node,
      error: result.error || `npm 退出码 ${result.code}`,
      output: result.output || '',
    };
  }
  const entry = localKernelEntry();
  if (!fs.existsSync(entry)) {
    return { ok: false, error: '安装完成但未找到 cli-entry.js', output: result.output || '' };
  }
  writePrefs({ qwenCmd: entry });
  QWEN_CMD = entry;
  stopAgentsForSettings('内核已安装');
  return { ok: true, path: entry };
}

function bundledKernelRoot() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'kernel')
    : path.join(__dirname, 'build', 'kernel');
}

function bundledKernelEntry() {
  const entry = path.join(
    bundledKernelRoot(),
    'node_modules',
    '@qwen-code',
    'qwen-code',
    'cli-entry.js'
  );
  try {
    return fs.existsSync(entry) ? entry : '';
  } catch {
    return '';
  }
}

// 内置真实 Node 运行时。不能用 Electron 的 ELECTRON_RUN_AS_NODE：
// 该模式会让 Qwen CLI 把入口脚本当成首条 prompt，并丢失后续 stdin 消息。
function bundledNodeExecutable() {
  const exe = path.join(bundledKernelRoot(), 'node.exe');
  try {
    return fs.existsSync(exe) ? exe : '';
  } catch {
    return '';
  }
}

function knownQwenEntries() {
  const roots = [
    path.join(process.env.APPDATA || '', 'npm', 'node_modules'),
    path.join(process.env.ProgramFiles || '', 'nodejs', 'node_modules'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'nodejs', 'node_modules'),
    path.join(app.getPath('userData'), 'kernel', 'node_modules'),
  ];
  return roots
    .filter(Boolean)
    .map((root) => path.join(root, '@qwen-code', 'qwen-code', 'cli-entry.js'))
    .filter((p) => {
      try {
        return fs.existsSync(p);
      } catch {
        return false;
      }
    });
}

// Windows 下把 qwen.cmd 解析成 node + cli-entry.js，绕开 shell 与二次分词
function resolveQwenLaunch() {
  if (process.platform !== 'win32') return null;
  // R81 监工AA：用户显式设置的 qwenCmd 优先——否则安装版"一键安装内核/保存路径"永远被内置内核遮蔽
  const explicit = String(process.env.QWEN_CMD || prefs.qwenCmd || '');
  if (explicit && explicit !== 'qwen') {
    if (/\.js$/i.test(explicit) && fs.existsSync(explicit)) {
      const node = findNodeExecutable();
      if (node) return { cmd: node, prefix: [path.resolve(explicit)], mode: 'node' };
    } else if (fs.existsSync(explicit)) {
      return { cmd: path.resolve(explicit), prefix: [], mode: 'custom' };
    }
  }
  // 安装包内置内核：优先用随包分发的真实 node.exe，设备无需预装 Node/qwen
  const bundled = bundledKernelEntry();
  if (bundled) {
    const nodeExe = bundledNodeExecutable();
    if (nodeExe) {
      return {
        cmd: nodeExe,
        prefix: [bundled],
        mode: 'bundled',
        env: {},
      };
    }
    // 极端回退：内核目录缺少 node.exe 时仍用 Electron 自带 Node（兼容旧包）
    return {
      cmd: process.execPath,
      prefix: [bundled],
      mode: 'bundled-electron',
      env: { ELECTRON_RUN_AS_NODE: '1' },
    };
  }
  const direct = String(QWEN_CMD || "");
  if (/\.js$/i.test(direct) && fs.existsSync(direct)) {
    const node = findNodeExecutable();
    return node ? { cmd: node, prefix: [path.resolve(direct)], mode: 'node' } : null;
  }
  let cmdPath = null;
  if (/[\\/]/.test(direct) || /\.(exe|cmd|bat)$/i.test(direct)) {
    cmdPath = path.resolve(direct);
  } else {
    cmdPath = findQwenExecutable();
  }
  if (cmdPath && fs.existsSync(cmdPath)) {
    if (/\.exe$/i.test(cmdPath)) return { cmd: cmdPath, prefix: [], mode: "exe" };
    if (/\.(cmd|bat)$/i.test(cmdPath)) {
      let text = "";
      try {
        text = fs.readFileSync(cmdPath, "utf8");
      } catch {
        text = "";
      }
      const hit =
        text.match(/"([^"]*cli-entry\.js)"/i) || text.match(/([^\s"]+cli-entry\.js)/i);
      if (hit) {
        let entry = hit[1].replace(/%dp0%|%~dp0/gi, path.dirname(cmdPath) + path.sep);
        if (!path.isAbsolute(entry)) entry = path.resolve(path.dirname(cmdPath), entry);
        if (fs.existsSync(entry)) {
          const node = findNodeExecutable();
          if (node) return { cmd: node, prefix: [entry], mode: 'node' };
        }
      }
    }
  }
  // PATH/常见目录里没有 qwen.cmd，再查 npm 全局与本应用内核安装目录
  const entries = knownQwenEntries();
  if (entries.length) {
    const node = findNodeExecutable();
    if (node) return { cmd: node, prefix: [entries[0]], mode: 'node' };
  }
  return null;
}

function killChildTree(child) {
  if (!child) return;
  const pid = child.pid;
  if (process.platform === 'win32' && pid) {
    try {
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.on('error', () => {});
    } catch {
      /* ignore */
    }
  }
  try {
    child.kill();
  } catch {
    /* ignore */
  }
}

function shellQuoteArg(value) {
  const s = String(value);
  if (!s) return '""';
  // R79 监工V：cmd 元字符（& | ; ^ ( ) $）也需引用——原实现只处理空格/引号，
  // qwenCmd='a&calc.exe' 会被 shell 解释成两条命令
  return '"' + s.replace(/"/g, '""') + '"';
}

function splitCliArgs(s) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(String(s || '')))) out.push(m[1] != null ? m[1] : m[2] != null ? m[2] : m[3]);
  return out;
}

// 授权快速通道判定（纯函数，供 handleControlRequest 与 --smoke 共用）
// 对齐 CLI/ZCode 语义：只读工具所有档自动放行；auto-edit 额外放行文件编辑。
const APPROVAL_READ_ONLY = new Set([
  'read_file', 'read', 'glob', 'grep_search', 'grep', 'list_dir', 'ls',
  'todowrite', 'todo_write', 'view_image', 'lsp', 'think', 'web_search',
]);
const APPROVAL_EDIT = new Set(['edit', 'write_file', 'write', 'notebook_edit', 'apply_patch']);
function approvalAutoAllow(mode, toolName) {
  const t = String(toolName || '').toLowerCase();
  if (APPROVAL_READ_ONLY.has(t)) return true;
  return mode === 'auto-edit' && APPROVAL_EDIT.has(t);
}

class AgentProcess {
  constructor(opts) {
    this.sessionId = opts.sessionId;
    this.cwd = opts.cwd;
    this.model = opts.model || null;
    this.approvalMode = opts.approvalMode || 'auto';
    this.resumeId = opts.resumeId || null;
    this.child = null;
    this.buffer = '';
    this.stderr = '';
    this.qwenSessionId = null;
    this.ready = false;
    this.pendingPrompt = null;
    this.killTimer = null;
    this.turnTimer = null;
    this.intentional = false;
    this.timedOut = false;
    this.crashTimes = [];
    this.autoRestartTimer = null;
    this.autoRestartCount = 0;
    this.desiredEffort = opts.effort || null;
    this.appliedEffort = null;
    this.controlActive = false;
    this.controlTier = null;
    this.queuedPrompt = null;
    this.pendingApproval = null; // can_use_tool 等待用户裁决：{ requestId, toolName, toolUseId, input, timer }
    this.sdkInitSent = false; // default/auto-edit 档需要先发 initialize 进入 SDK 模式，工具才会走 can_use_tool
    this.busy = false;
    this.restartAfterTurn = false;
  }

  setEffort(tier) {
    const next = tier || null;
    if (next !== this.desiredEffort) {
      this.desiredEffort = next;
      log('effort desired', String(next || 'default'));
    }
  }

  args() {
    const base = [
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--include-partial-messages',
      '--approval-mode',
      this.approvalMode,
    ];
    if (this.model) base.push('--model', this.model);
    // 恢复上次的真实上下文（不是仅恢复界面）
    if (this.resumeId) base.push('--resume', this.resumeId);
    // 高级分区里的内核限制
    if (prefs.maxTurns > 0) base.push('--max-session-turns', String(prefs.maxTurns));
    if (prefs.maxToolCalls > 0) base.push('--max-tool-calls', String(prefs.maxToolCalls));
    if (prefs.maxSubagentDepth > 0) base.push('--max-subagent-depth', String(prefs.maxSubagentDepth));
    if (Array.isArray(prefs.disabledSlashCommands) && prefs.disabledSlashCommands.length) {
      base.push('--disabled-slash-commands', prefs.disabledSlashCommands.join(','));
    }
    // 安全模式：禁用全部自定义（context/hooks/extensions/skills/MCP）排障用
    if (prefs.safeMode) base.push('--safe-mode');
    if (String(prefs.appendSystemPrompt || '').trim()) {
      base.push('--append-system-prompt', String(prefs.appendSystemPrompt));
    }
    // 高级分区里的自定义 CLI 参数（支持引号包裹含空格的值）
    base.push(...splitCliArgs(prefs.extraArgs));
    return base;
  }

  start() {
    if (this.child) return;
    this.intentional = false;
    const rawArgs = this.args();
    const launch = resolveQwenLaunch();
    const child = launch
      ? spawn(launch.cmd, [...launch.prefix, ...rawArgs], {
          cwd: this.cwd,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', ...((launch && launch.env) || {}) },
        })
      : spawn(shellQuoteArg(QWEN_CMD), rawArgs.map(shellQuoteArg), {
          cwd: this.cwd,
          shell: true,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', ...((launch && launch.env) || {}) },
        });
    log('spawn', launch ? launch.mode : 'shell', launch ? launch.cmd : QWEN_CMD, rawArgs.join(' '), '| cwd=', this.cwd);
    this.child = child;

    // 逐项确认档（default/auto-edit）先发 SDK initialize，让内核把所有工具走 can_use_tool，
    // 这样我们的授权卡片才会真正出现。auto/yolo/plan 仍用直连模式（只读工具不打扰用户）。
    if (this.approvalMode === 'default' || this.approvalMode === 'auto-edit') {
      try {
        child.stdin.write(
          JSON.stringify({
            type: 'control_request',
            request_id: 'sdk-init-' + this.sessionId,
            request: { subtype: 'initialize', payload: {} },
          }) + '\n'
        );
        this.sdkInitSent = true;
        log('sdk init sent for approval mode', this.approvalMode);
      } catch (e) {
        log('sdk init write failed', String(e && e.message));
      }
    }

    child.stdin.on('error', (err) => log('stdin error', String((err && err.message) || err)));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.onStdout(chunk));

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      this.stderr = (this.stderr + chunk).slice(-8000);
      log('stderr', JSON.stringify(chunk.slice(0, 400)));
    });

    child.on('error', (err) => {
      log('child error', String(err && err.message));
      this.emit({ type: 'host_error', message: String(err && err.message) });
    });

    child.on('exit', (code, signal) => {
      log('child exit', code, signal);
      // R73 监工F：强杀（taskkill 异步）期间新 spawn 的 child 已就位时，本次 exit 属于旧进程——
      // 不能清掉新 child 引用与新回合定时器
      if (this.child && this.child !== child) return;
      const wasBusy = this.busy;
      const wasReady = this.ready;
      clearTimeout(this.killTimer);
      this.killTimer = null;
      clearTimeout(this.turnTimer);
      this.turnTimer = null;
      this.child = null;
      this.busy = false;
      // 内核退出时清理挂起的授权兜底定时器，避免其持有整个 AgentProcess 60 秒后空触发
      if (this.pendingApproval && this.pendingApproval.timer) {
        clearTimeout(this.pendingApproval.timer);
        const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
        sendRendererEvent('agent:approval-clear', { sessionId: this.sessionId, requestId: this.pendingApproval.requestId });
        this.pendingApproval = null;
      }
      this.controlActive = false;
      this.controlTier = null;
      // R72（监工A）：/effort 往途中排队待发的用户消息不能直接丢弃——转入 pendingPrompt，
      // 自动重启后的 init 会重发（与 pendingPrompt 的补救路径一致），否则用户消息静默丢失。
      if (this.queuedPrompt) {
        this.pendingPrompt = this.queuedPrompt;
        this.queuedPrompt = null;
      }
      // R73 监工F：写入已成功但内核未消费的在途消息同样转入 pendingPrompt 补救
      if (this.inFlightPrompt) {
        this.pendingPrompt = this.pendingPrompt || this.inFlightPrompt;
        this.inFlightPrompt = null;
      }
      // 非预期退出：60 秒内最多自愈 3 次，带 resume 恢复上下文
      let autoRestart = false;
      if (!this.intentional && (wasBusy || wasReady)) {
        const now = Date.now();
        this.crashTimes = this.crashTimes.filter((t) => now - t < 60000);
        if (this.crashTimes.length < 3) {
          this.crashTimes.push(now);
          autoRestart = true;
          clearTimeout(this.autoRestartTimer);
          this.autoRestartTimer = setTimeout(() => {
            if (this.intentional || this.child) return;
            log('kernel auto restart', this.sessionId, 'resume', String(this.resumeId || ''));
            this.start();
          }, 200);
        }
      }
      this.emit({
        type: 'host_exit',
        code,
        signal,
        stderr: this.stderr.slice(-1500),
        intentional: !!this.intentional,
        autoRestart,
        reason: this.timedOut ? '回合超时' : '',
        timedOut: !!this.timedOut, // R83 监工AC1：显式标记超时强杀，渲染层据此必须收尾当前回合
        willResend: !!this.pendingPrompt, // R83 监工AC2：重启后会重发本轮 prompt，渲染层据此保留回合不被 abort
        resumeId: autoRestart ? this.resumeId || this.qwenSessionId || null : null,
      });
    });
  }

  onStdout(chunk) {
    this.buffer += chunk;
    // R78 监工S：超长行（>10MB，如工具 base64）丢弃并标记——否则无界增长且后续事件全阻塞
    if (this.buffer.length > 10 * 1024 * 1024 && this.buffer.indexOf(String.fromCharCode(10)) < 0) {
      log('host oversized line dropped', String(this.buffer.length));
      this.emit({ type: 'host_raw', line: '[超长行已丢弃]' });
      this.buffer = '';
    }
    let idx;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).replace(/\r$/, '').trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let event;
      try {
        event = JSON.parse(line);
        if (!event || typeof event !== 'object') {
          // R73 监工F：裸 null/非对象行防 TypeError 中断当前 chunk 余下行解析
          log('raw', line.slice(0, 200));
          this.emit({ type: 'host_raw', line: line.slice(0, 500) });
          continue;
        }
      } catch {
        log('raw', line.slice(0, 200));
        this.emit({ type: 'host_raw', line: line.slice(0, 500) });
        continue;
      }
      this.handleEvent(event);
    }
  }

  // 工具授权：CLI 在 default/auto-edit 档遇到需确认的工具时发 control_request，
  // 必须回一条 control_response 才会继续（不回则 60s 后自动拒绝）。这里转给渲染层让用户裁决。
  handleControlRequest(event) {
      const req = event.request || {};
      const requestId = event.request_id;
      if (req.subtype !== 'can_use_tool' || !requestId) {
        // 其他 control 子类按未知处理：回 error（CLI 读 response.error），避免内核一直等
        this.write({
          type: 'control_response',
          response: { request_id: requestId, subtype: 'error', error: 'unsupported control request' },
        });
        return;
      }
      // 同一回合只挂起一个授权请求：并发到来时先拒绝后来的，避免弹窗叠加
      if (this.pendingApproval) {
        this.write({
          type: 'control_response',
          response: { request_id: requestId, subtype: 'success', response: { behavior: 'deny', message: '另一个授权尚未处理' } },
        });
        return;
      }
      const toolName = req.tool_name || 'tool';
      // 安全快速通道（对齐 CLI / ZCode 语义）：只读工具在所有档自动放行；
      // auto-edit 档额外自动放行文件编辑，只有 shell 等非只读操作才弹卡片。
      const autoAllow = approvalAutoAllow(this.approvalMode, toolName);
      if (autoAllow) {
        this.write({
          type: 'control_response',
          response: { request_id: requestId, subtype: 'success', response: { behavior: 'allow' } },
        });
        log('approval auto-allow', this.approvalMode, toolName, requestId);
        return;
      }
      const info = {
        requestId,
        toolName,
        toolUseId: req.tool_use_id || '',
        input: req.input && typeof req.input === 'object' ? req.input : {},
        blockedPath: req.blocked_path || null,
      };
      this.pendingApproval = info;
      // 兜底：60s 无操作自动拒绝（与内核默认超时一致），防止内核挂死
      info.timer = setTimeout(() => this.resolveApproval(requestId, false, true), 60000);
      const win = mainWindow;
      if (win && !win.isDestroyed()) {
        sendRendererEvent('agent:approval', { sessionId: this.sessionId, ...info, timer: undefined });
      }
      log('approval request', this.sessionId, info.toolName, requestId);
    }

    // 裁决工具授权：allowed=true 写 allow，否则 deny。always=true 仅影响设置提示，不改变本次内核行为。
    resolveApproval(requestId, allowed, timedOut = false) {
      const p = this.pendingApproval;
      if (!p || p.requestId !== requestId) return false;
      clearTimeout(p.timer);
      this.pendingApproval = null;
      const ok = this.write({
        type: 'control_response',
        response: {
          request_id: requestId,
          subtype: 'success',
          response: allowed
            ? { behavior: 'allow' }
            : { behavior: 'deny', message: timedOut ? '授权超时，已自动拒绝' : '用户拒绝' },
        },
      });
      log('approval resolved', this.sessionId, allowed ? 'allow' : 'deny', requestId, 'written=' + ok);
      // R78 监工S：超时自动拒绝也要广播 approval-clear——否则渲染层卡片永久残留（P1）
      if (timedOut) {
        const win = mainWindow;
        sendRendererEvent('agent:approval-clear', { sessionId: this.sessionId, requestId });
      }
      return true;
    }

    handleEvent(event) {
    // 授权控制请求：不转发给渲染层当普通消息，直接挂起等待裁决
    if (event.type === 'control_request') {
      this.handleControlRequest(event);
      return;
    }
    if (event.type === 'stream_event') {
      // 每个 token 一次事件，逐条写盘会拖慢流式输出，抽样记录
      this.streamLogCount = (this.streamLogCount || 0) + 1;
      if (this.streamLogCount % 50 === 0) {
        log('stream_event x' + this.streamLogCount, event.session_id || '');
      }
    } else {
      log('event', event.type, event.subtype || '', event.session_id || '');
    }
    if (event.type === 'result') {
      // R72（监工A）：回合结束无条件取消强杀看门狗与超时定时器——原先 turnTimer 的清除
      // 被挂在 killTimer 非空的条件上，普通回合结束后超时定时器继续计时，
      // 会把空闲内核误杀并报「回合超时」。
      clearTimeout(this.killTimer);
      this.killTimer = null;
      clearTimeout(this.turnTimer);
      this.turnTimer = null;
      this.busy = false;
      this.inFlightPrompt = null; // 内核已消费在途消息
    }
    if (event.type === 'system' && event.subtype === 'init') {
      this.qwenSessionId = event.session_id || this.qwenSessionId;
      // R73 监工F：跟随内核上报的最新 id（resume fork 场景，旧 id 会丢中间上下文）
      this.resumeId = event.session_id || this.resumeId;
      this.ready = true;
      // 缓存内核命令表，重启应用后设置页仍能展示（不必先发一条消息）
      if (Array.isArray(event.slash_commands) && event.slash_commands.length) {
        const next = event.slash_commands;
        const prev = Array.isArray(prefs.lastCommands) ? prefs.lastCommands : [];
        if (next.join(',') !== prev.join(',')) writePrefs({ lastCommands: next });
      }
      if (this.pendingPrompt && !this.controlActive) {
        const text = this.pendingPrompt;
        this.pendingPrompt = null;
        this.send(text);
      }
    }
    if (this.controlActive) {
      // /effort 是控制命令：吞掉它的 init/assistant/result，避免渲染层把它当成用户回合
      if (event.type === 'result') {
        clearTimeout(this.effortTimer); // R78 监工S：控制回合正常结束清超时
        this.appliedEffort = this.controlTier;
        this.controlActive = false;
        this.controlTier = null;
        log('effort applied', String(this.appliedEffort || 'default'));
        const queued = this.queuedPrompt;
        this.queuedPrompt = null;
        if (queued) this.sendNow(queued);
      }
      return;
    }
    if (event.type === 'result') this.busy = false;
    if (event.session_id && !this.qwenSessionId) this.qwenSessionId = event.session_id;
    this.emit(event);
  }

  send(text) {
    if (!this.child) this.start();
    if (!this.controlActive && this.desiredEffort && this.desiredEffort !== this.appliedEffort) {
      this.controlActive = true;
      this.controlTier = this.desiredEffort;
      this.queuedPrompt = text;
      // R72（监工A）：/effort 往途期间置 busy——否则渲染层看到空闲会立刻发下一条消息，
      // controlActive 又让后者直接 sendNow，导致 stdin 顺序变为 /effort → text2 → text1 乱序。
      this.busy = true;
      log('apply effort', this.controlTier);
      const ok = this.write({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'text', text: '/effort ' + this.controlTier }],
        },
      });
      if (!ok) {
        this.controlActive = false;
        this.controlTier = null;
        this.queuedPrompt = null;
        this.pendingPrompt = text;
      } else {
        // R78 监工S：控制回合 15s 超时兜底——内核对 /effort 报错可能不发 result，

        // 原实现 controlActive/busy 永久为 true、排队消息永不发出（P2）
        clearTimeout(this.effortTimer);
        const tierAtStart = this.controlTier;
        this.effortTimer = setTimeout(() => {
          if (!this.controlActive || this.controlTier !== tierAtStart) return;
          log('effort control timeout', this.sessionId, String(tierAtStart));
          this.controlActive = false;
          this.controlTier = null;
          this.appliedEffort = tierAtStart;
          const queued = this.queuedPrompt;
          this.queuedPrompt = null;
          if (queued) this.send(queued);
          else this.busy = false;
        }, 15000);
      }
      return;
    }
    this.sendNow(text);
  }

  sendNow(text) {
    if (!this.child) this.start();
    // 注意：stream-json 模式下 CLI 收到首条消息后才会发 init，
    // 所以这里必须立即写入，不能等 init，否则死锁。
    this.busy = true;
    this.timedOut = false;
    clearTimeout(this.turnTimer);
    const minutes = Number(prefs.turnTimeoutMin) || 0;
    if (minutes > 0) {
      this.turnTimer = setTimeout(() => {
        log('turn timeout', this.sessionId, minutes + 'min');
        this.intentional = true;
        this.timedOut = true;
        if (this.child) killChildTree(this.child);
      }, minutes * 60000);
    }
    const payload = {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
    };
    // 只序列化前 80 字符做日志预览：原实现先 JSON.stringify 整段 prompt（大上下文可达 MB，约 0.9ms）再截断
    log('write user message', JSON.stringify(String(text == null ? '' : text).slice(0, 80)));
    const ok = this.write(payload);
    if (!ok) {
      this.busy = false;
      log('stdin not ready, queue prompt');
      this.pendingPrompt = text;
    } else {
      // R73 监工F：写入成功≠内核已消费——记录在途消息，内核在消费前死亡时
      // exit 处理转入 pendingPrompt，自动重启后重发（否则消息静默丢失）
      this.inFlightPrompt = text;
    }
  }

  write(obj) {
    if (!this.child || !this.child.stdin.writable) return false;
    try {
      this.child.stdin.write(JSON.stringify(obj) + '\n');
      return true;
    } catch {
      return false;
    }
  }

  interrupt() {
    const ok = this.write({ type: 'interrupt' });
    if (ok) {
      // stream-json 的 interrupt 语义未在所有内核版本验证过：
      // 5 秒内没等到 result 就强杀进程，保证「停止」一定停得下来
      clearTimeout(this.killTimer);
      this.killTimer = setTimeout(() => {
        if (this.child) {
          log('interrupt timeout, killing child tree');
          killChildTree(this.child);
        }
      }, 1200);
    }
    return ok;
  }

  stop(intentional = false) {
    // R80 监工Y：清 effortTimer 与 control 状态——否则停止 15s 后凭空启动内核写排队 prompt
    clearTimeout(this.effortTimer);
    this.effortTimer = null;
    this.controlActive = false;
    this.controlTier = null;
    this.queuedPrompt = null;
    // R83 监工AC8：不清 timedOut 会让之后每次主动重启都显示「回合超时」
    this.timedOut = false;
    clearTimeout(this.killTimer);
    this.killTimer = null;
    clearTimeout(this.turnTimer);
    this.turnTimer = null;
    clearTimeout(this.autoRestartTimer);
    this.autoRestartTimer = null;
    // 停止/重启时清掉未裁决的授权，避免残留定时器与卡住的弹窗
    if (this.pendingApproval) {
      clearTimeout(this.pendingApproval.timer);
      const rid = this.pendingApproval.requestId;
      this.pendingApproval = null;
      const win = mainWindow;
      sendRendererEvent('agent:approval-clear', { sessionId: this.sessionId, requestId: rid });
    }
    if (!this.child) return;
    this.intentional = intentional;
    killChildTree(this.child);
    this.child = null;
  }

  dispose() {
    this.stop(true);
    this.pendingPrompt = null;
    this.inFlightPrompt = null;
    this.buffer = '';
    this.stderr = '';
    this.crashTimes = [];
  }

  emit(event) {
    // 内核进程已被替换时，旧进程的残留事件（含退出）全部丢弃，避免串到新回合
    const current = agents.get(this.sessionId);
    // R76 监工N：agent 已从 map 移除（stop/delete）时 current 为空——旧残留事件也应丢弃（P2）
    if (current !== this) return;
    const win = mainWindow;
    sendRendererEvent('agent:event', { sessionId: this.sessionId, event });
  }
}

const agents = new Map();
function stopAgentsForSettings(reason) {
  const ids = [...agents.keys()];
  for (const id of ids) {
    const agent = agents.get(id);
    if (agent) agent.stop(true);
    // map 清除后旧 exit 不会转发，主动补发 intentional 事件让 renderer 收尾 busy/stream
    sendRendererEvent('agent:event', {
      sessionId: id,
      event: { type: 'host_exit', intentional: true, reason: reason || '设置已更新，内核已重启' },
    });
  }
  agents.clear();
  return ids;
}

function getAgent(session) {
  let agent = agents.get(session.id);
  if (!agent) {
    agent = new AgentProcess({
      sessionId: session.id,
      cwd: session.cwd,
      model: session.model,
      approvalMode: session.approvalMode,
      resumeId: session.qwenSessionId || null,
      effort: session.reasoningEffort || null,
    });
    agents.set(session.id, agent);
    agent.start();
  }
  return agent;
}

/* ---------------- 本应用偏好（启动参数） ---------------- */

const PREFS_FILE = path.join(app.getPath('userData'), 'prefs.json');

const DEFAULT_PREFS = {
  schemaVersion: 1,
  disabledSlashCommands: [],
  maxTurns: 0,
  maxToolCalls: 0,
  maxSubagentDepth: 0,
  extraArgs: '',
  closeAction: 'quit',
  notifyBackground: true,
  launchAtLogin: false,
  alwaysOnTop: false,
  safeMode: false,
  appendSystemPrompt: '',
  prompts: [],
  hotkey: '',
  defaultCwd: '',
  window: null,
  lastCommands: [],
  disableGpu: false,
  gpuFlags: '',
  qwenCmd: '',
  turnTimeoutMin: 0,
  goalAutoContinue: true,
  goalMaxRounds: 0,
  goalTokenBudget: 0,
  dailyBudgetTokens: 0, // 每日 token 预算（0=不启用），达 80%/100% 时提示
};

const GPU_FLAG_WHITELIST = [
  'enable-gpu-rasterization',
  'enable-zero-copy',
  'ignore-gpu-blocklist',
  'force-color-profile',
];

const KERNEL_KEYS = [
  'disabledSlashCommands',
  'maxTurns',
  'maxToolCalls',
  'maxSubagentDepth',
  'extraArgs',
  'safeMode',
  'appendSystemPrompt',
];

const PREFS_SCHEMA_VERSION = 1;
function migratePrefs(raw) {
  const from = Math.max(0, Number(raw && raw.schemaVersion) || 0);
  const next = { ...DEFAULT_PREFS, ...(raw && typeof raw === 'object' ? raw : {}) };
  if (from < PREFS_SCHEMA_VERSION) {
    next.turnTimeoutMin = Math.max(0, Number(next.turnTimeoutMin) || 0);
    next.autoArchiveDays = [0, 7, 30, 90].includes(Number(next.autoArchiveDays))
      ? Number(next.autoArchiveDays)
      : 0;
    next.disableGpu = !!next.disableGpu;
    next.gpuFlags = String(next.gpuFlags || '');
    next.qwenCmd = String(next.qwenCmd || '');
    next.goalAutoContinue = next.goalAutoContinue !== false;
    next.goalMaxRounds = Math.max(0, Math.floor(Number(next.goalMaxRounds) || 0));
    next.goalTokenBudget = Math.max(0, Math.floor(Number(next.goalTokenBudget) || 0));
    next.prompts = Array.isArray(next.prompts) ? next.prompts : [];
    next.disabledSlashCommands = Array.isArray(next.disabledSlashCommands)
      ? next.disabledSlashCommands
      : [];
    next.schemaVersion = PREFS_SCHEMA_VERSION;
  }
  return { next, from, migrated: from < PREFS_SCHEMA_VERSION };
}

function readPrefs() {
  try {
    const raw = JSON.parse(fs.readFileSync(PREFS_FILE, 'utf8'));
    const { next, migrated } = migratePrefs(raw);
    if (migrated) {
      try {
        fs.copyFileSync(PREFS_FILE, PREFS_FILE + '.bak');
      } catch {
        /* ignore backup failure */
      }
      try {
        fs.writeFileSync(PREFS_FILE, JSON.stringify(next, null, 2), 'utf8');
        log('prefs migrated', String(Number(raw && raw.schemaVersion) || 0), '→', String(PREFS_SCHEMA_VERSION));
      } catch {
        /* ignore write failure */
      }
    }
    return next;
  } catch (e) {
    // R72（监工C）：半写损坏的 prefs 留证再返回默认——否则下次 prefs:save 用默认值覆盖后无从排查
    try {
      if (fs.existsSync(PREFS_FILE)) {
        fs.copyFileSync(PREFS_FILE, PREFS_FILE + '.corrupt-' + Date.now());
        log('prefs corrupted, archived; ' + String((e && e.message) || e));
      }
    } catch {
      /* ignore archive failure */
    }
    return { ...DEFAULT_PREFS };
  }
}

let prefs = readPrefs();
log('prefs file', PREFS_FILE, JSON.stringify(prefs));

// CLI 路径：环境变量优先，其次用户在设置里手动指定的 qwenCmd
QWEN_CMD = process.env.QWEN_CMD || prefs.qwenCmd || 'qwen';

// GPU 相关偏好在 app ready 之前应用；命令行开关只接受白名单键
(function applyGpuStartupPrefs() {
  if (prefs.disableGpu) {
    app.disableHardwareAcceleration();
    log('gpu', 'hardware acceleration disabled by prefs');
  }
  const tokens = String(prefs.gpuFlags || '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const token of tokens) {
    const at = token.indexOf('=');
    const key = (at >= 0 ? token.slice(0, at) : token).trim();
    const value = at >= 0 ? token.slice(at + 1).trim() : '';
    if (!GPU_FLAG_WHITELIST.includes(key)) {
      log('gpu flag rejected', token);
      continue;
    }
    if (value) app.commandLine.appendSwitch(key, value);
    else app.commandLine.appendSwitch(key);
    log('gpu flag applied', token);
  }
})();

function writePrefs(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { ok: false, error: 'prefs 补丁必须是对象' };
  // R80 监工Y：先构造 next、写盘成功后再更新内存——失败时内存/磁盘保持一致
  const next = { ...prefs, ...patch, schemaVersion: PREFS_SCHEMA_VERSION };
  try {
    fs.mkdirSync(path.dirname(PREFS_FILE), { recursive: true });
    fs.writeFileSync(PREFS_FILE + '.tmp', JSON.stringify(next, null, 2), 'utf8');
    fs.renameSync(PREFS_FILE + '.tmp', PREFS_FILE);
  } catch (e) {
    return { ok: false, error: String(e && e.message) };
  }
  prefs = next;
  return { ok: true };
}

ipcMain.handle('prefs:get', () => prefs);
ipcMain.handle('prefs:save', (_e, patch) => {
  const kernelBefore = JSON.stringify(KERNEL_KEYS.map((k) => prefs[k]));
  const res = writePrefs(patch);
  if (res.ok) {
    // 只有内核相关参数变化才需要重启进程；开关类设置即时生效
    if (JSON.stringify(KERNEL_KEYS.map((k) => prefs[k])) !== kernelBefore) {
      stopAgentsForSettings('内核参数已更新');
    }
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setAlwaysOnTop(!!prefs.alwaysOnTop);
    syncTray();
    const hk = syncHotkey();
    res.hotkey = hk;
  }
  return res;
});

/* ---------------- 其余分区数据 ---------------- */

const QWEN_DIR = path.join(os.homedir(), '.qwen');
const QWEN_SETTINGS = path.join(QWEN_DIR, 'settings.json');

function readJsonFile(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

function usageDayKey(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function usageDayLabel(d) {
  return String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

async function aggregateUsage(range) {
  const usagePath = path.join(QWEN_DIR, 'usage_record.jsonl');
  let cutoff = 0;
  if (range === 'today') {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    cutoff = d.getTime();
  } else if (range === '7d') {
    cutoff = Date.now() - 7 * 24 * 3600 * 1000;
  }
  const empty = {
    sessions: 0,
    input: 0,
    output: 0,
    total: 0,
    toolCalls: 0,
    models: [],
    recent: [],
    path: usagePath,
  };
  try {
    await fs.promises.access(usagePath, fs.constants.R_OK);
  } catch {
    return empty;
  }

  const models = new Map();
  let input = 0;
  let output = 0;
  let total = 0;
  let toolCalls = 0;
  const records = [];

  // 近 7 天每日 token / 工具调用（不受范围筛选影响）：在首次读取循环里一并累加，
  // 避免先存全部记录再二次遍历（原 allRecords 全量保留 + 第二遍 Date/遍历）。
  const dayMap = new Map();
  const dayKeys = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - i);
    const key = usageDayKey(d);
    dayKeys.push(key);
    dayMap.set(key, { date: usageDayLabel(d), tokens: 0, calls: 0 });
  }

  // 逐行流式读取：usage 记录可能到数 MB，readFileSync + 全量 split/parse 会锁住主进程
  const stream = fs.createReadStream(usagePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line) continue;
      let r;
      try {
        r = JSON.parse(line);
      } catch {
        continue;
      }
      // weekly 不受范围筛选影响：在 cutoff 过滤之前累加（首遍一处完成）
      if (r.timestamp) {
        const dw = new Date(r.timestamp);
        if (!Number.isNaN(dw.getTime())) {
          const slot = dayMap.get(usageDayKey(dw));
          if (slot) {
            const mo = r.models && typeof r.models === 'object' ? r.models : {};
            for (const mm of Object.values(mo)) slot.tokens += (Number(mm && mm.totalTokens) || 0);
            slot.calls += (r.tools && typeof r.tools === 'object' && Number(r.tools.totalCalls)) || 0;
          }
        }
      }
      if (cutoff && r.timestamp && new Date(r.timestamp).getTime() < cutoff) continue;
      records.push(r);
      const modelsObj = r.models && typeof r.models === 'object' ? r.models : {};
      for (const [name, m] of Object.entries(modelsObj)) {
        if (!m || typeof m !== 'object') continue;
        const cur = models.get(name) || { name, input: 0, output: 0, total: 0, requests: 0 };
        cur.input += Number(m.inputTokens) || 0;
        cur.output += Number(m.outputTokens) || 0;
        cur.total += Number(m.totalTokens) || 0;
        cur.requests += Number(m.requests) || 0;
        models.set(name, cur);
        input += Number(m.inputTokens) || 0;
        output += Number(m.outputTokens) || 0;
        total += Number(m.totalTokens) || 0;
      }
      toolCalls += (r.tools && typeof r.tools === 'object' && Number(r.tools.totalCalls)) || 0;
    }
  } catch {
    return empty;
  } finally {
    rl.close();
    stream.destroy();
  }

  // weekly 已在读取循环内一并累加，这里只汇总（不再二次遍历全量记录）
  const weekly = dayKeys.map((k) => dayMap.get(k));

  const recent = records
    .slice(-6)
    .reverse()
    .map((r) => ({
      time: r.timestamp ? new Date(r.timestamp).toLocaleString('zh-CN', { hour12: false }) : '',
      project: r.project || '',
      model:
        r.models && typeof r.models === 'object' ? Object.keys(r.models)[0] || '' : '',
      tokens:
        r.models && typeof r.models === 'object'
          ? Object.values(r.models).reduce((a, x) => a + (Number(x && x.totalTokens) || 0), 0)
          : 0,
      tools: (r.tools && typeof r.tools === 'object' && Number(r.tools.totalCalls)) || 0,
      duration: Math.round((r.durationMs || 0) / 1000),
    }));

  return {
    sessions: records.length,
    input,
    output,
    total,
    toolCalls,
    models: [...models.values()].sort((a, b) => b.total - a.total),
    weekly,
    recent,
    path: usagePath,
  };
}

const SKILLS_DIR = path.join(QWEN_DIR, 'skills');
const EXT_DIR = path.join(QWEN_DIR, 'extensions');

const skillMetaCache = new Map();
const SKILL_META_CACHE_MAX = 200;

function parseSkillMeta(text, dirPath, dirName) {
  const meta = { name: dirName, dirName, description: '', path: dirPath };
  meta.content = text.slice(0, 6000);
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (fm) {
    const name = fm[1].match(/^name:\s*(.+)$/m);
    const yamlBlock = fm[1].match(/^description:\s*[|>][-+]?\s*\r?\n((?:[ \t]+.*(?:\r?\n|$))+)/m);
    const desc = fm[1].match(/^description:\s*(.+)$/m);
    if (name) meta.name = name[1].trim().replace(/^["']|["']$/g, '');
    if (yamlBlock) {
      meta.description = yamlBlock[1]
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .join(' ');
    } else if (desc) {
      meta.description = desc[1].trim().replace(/^["']|["']$/g, '');
    }
  }
  return meta;
}

async function readSkillMetaCached(dirPath, dirName) {
  const file = path.join(dirPath, 'SKILL.md');
  try {
    const st = await fs.promises.stat(file);
    const hit = skillMetaCache.get(dirPath);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
      skillMetaCache.delete(dirPath);
      skillMetaCache.set(dirPath, hit);
      return hit.meta;
    }
    const text = await fs.promises.readFile(file, 'utf8');
    const meta = parseSkillMeta(text, dirPath, dirName);
    if (skillMetaCache.size >= SKILL_META_CACHE_MAX) {
      const oldest = skillMetaCache.keys().next().value;
      if (oldest !== undefined) skillMetaCache.delete(oldest);
    }
    skillMetaCache.set(dirPath, { mtimeMs: st.mtimeMs, size: st.size, meta });
    return meta;
  } catch {
    /* 没有 SKILL.md 就只显示目录名 */
    return { name: dirName, dirName, description: '', path: dirPath };
  }
}

async function getExtrasPayload() {
  const cfg = readQwenSettings();

  const memPath = path.join(QWEN_DIR, 'memories', 'MEMORY.md');
  let memory = '';
  let memStat = null;
  let memoryError = null;
  try {
    memory = await fs.promises.readFile(memPath, 'utf8');
    memStat = await fs.promises.stat(memPath);
  } catch (e) {
    if (!e || e.code !== 'ENOENT') memoryError = String((e && e.message) || e);
    memory = '';
    memStat = null;
  }

  let skills = [];
  try {
    const dirs = (await fs.promises.readdir(SKILLS_DIR, { withFileTypes: true })).filter((d) =>
      d.isDirectory()
    );
    skills = await Promise.all(
      dirs.map((d) => readSkillMetaCached(path.join(SKILLS_DIR, d.name), d.name))
    );
  } catch {
    skills = [];
  }

  const enablement = readJsonFile(path.join(EXT_DIR, 'extension-enablement.json'), {});
  let extensions = [];
  try {
    extensions = (await fs.promises.readdir(EXT_DIR, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    extensions = [];
  }

  return {
    mcpServers: cfg.mcpServers || {},
    memory: {
      path: memPath,
      content: memory,
      error: memoryError,
      size: memStat ? memStat.size : 0,
      mtime: memStat ? memStat.mtimeMs : 0,
    },
    skills,
    skillsDir: SKILLS_DIR,
    extensions,
    extensionEnablement: enablement,
    extensionsDir: EXT_DIR,
    prefs,
  };
}

ipcMain.handle('extras:get', () => getExtrasPayload());

ipcMain.handle('mcp:save', (_e, servers) => {
  try {
    // R74 监工H：主进程侧结构校验（renderer 有防护，但 IPC 面向全渲染层开放——双保险对齐 hooks:save）
    if (!servers || typeof servers !== 'object' || Array.isArray(servers)) {
      return { ok: false, error: 'mcpServers 必须是对象' };
    }
    const cleaned = {};
    for (const [k, v] of Object.entries(servers)) {
      if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
      if (!(v.command || v.url || v.httpUrl)) continue; // 无启动方式的条目剔除
      cleaned[k] = v;
    }
    servers = cleaned;
    const cfg = readQwenSettings();
    cfg.mcpServers = servers || {};
    writeQwenSettings(cfg);
    stopAgentsForSettings('MCP 配置已更新');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e && e.message) };
  }
});

function projectContextFile(cwd) {
  const base = path.resolve(cwd || ".");
  return path.join(base, 'QWEN.md');
}

ipcMain.handle('project:context:get', (_e, { cwd } = {}) => {
  try {
    if (!cwd) return { ok: false, error: '没有工作目录' };
    const base = path.resolve(cwd);
    if (!fs.statSync(base).isDirectory()) return { ok: false, error: "工作目录无效" };
    const file = projectContextFile(base);
    try {
      content = fs.readFileSync(file, "utf8");
    } catch (e) {
      if (!e || e.code !== 'ENOENT') return { ok: false, error: '项目指令读取失败：' + String((e && e.message) || e), path: file };
      content = "";
    }
    return { ok: true, path: file, content };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

ipcMain.handle('project:context:save', (_e, { cwd, content } = {}) => {
  try {
    if (!cwd) return { ok: false, error: '没有工作目录' };
    const base = path.resolve(cwd);
    if (!fs.statSync(base).isDirectory()) return { ok: false, error: "工作目录无效" };
    const file = projectContextFile(base);
    if (fs.existsSync(file)) {
      try { fs.readFileSync(file, 'utf8'); }
      catch (e) { return { ok: false, error: '现有项目指令读取失败，拒绝覆盖：' + String((e && e.message) || e) }; }
    }
    try {
      if (fs.existsSync(file)) fs.copyFileSync(file, file + ".bak");
    } catch {
      /* ignore */
    }
    fs.writeFileSync(file, String(content == null ? "" : content), "utf8");
    return { ok: true, path: file };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

ipcMain.handle('project:context:restore', (_e, { cwd } = {}) => {
  try {
    if (!cwd) return { ok: false, error: '没有工作目录' };
    const base = path.resolve(cwd);
    if (!fs.statSync(base).isDirectory()) return { ok: false, error: '工作目录无效' };
    const target = projectContextFile(base);
    const bak = target + '.bak';
    if (!fs.existsSync(bak)) return { ok: false, error: '没有 QWEN.md.bak 备份' };
    const tmp = target + '.restore-tmp';
    fs.copyFileSync(bak, tmp);
    fs.renameSync(tmp, target);
    return { ok: true, path: target, bak };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

ipcMain.handle('memory:save', (_e, content) => {
  try {
    const dir = path.join(QWEN_DIR, 'memories');
    const memFile = path.join(dir, 'MEMORY.md');
    if (fs.existsSync(memFile)) {
      try { fs.readFileSync(memFile, 'utf8'); }
      catch (e) { return { ok: false, error: '现有记忆读取失败，拒绝覆盖：' + String((e && e.message) || e) }; }
    }
    fs.mkdirSync(dir, { recursive: true });
    try {
      if (fs.existsSync(memFile)) fs.copyFileSync(memFile, memFile + '.bak');
    } catch {
      /* ignore */
    }
    fs.writeFileSync(memFile, content, 'utf8');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e && e.message) };
  }
});

/* ------------------------------------------------------------------ */
/* 窗口                                                                */
/* ------------------------------------------------------------------ */

let mainWindow = null;
let mainWindowReady = false;
let pendingRendererEvents = [];
const turnWaiters = [];

function sendRendererEvent(channel, payload) {
  const win = mainWindow;
  if (!win || win.isDestroyed()) return;
  if (!mainWindowReady) {
    pendingRendererEvents.push({ win: win, channel: channel, payload: payload });
    // 有界兜底：异常启动时不无限缓存流式事件；溢出时优先丢弃普通流事件，保留授权/错误等关键事件
    if (pendingRendererEvents.length > 500) {
      const ordinary = pendingRendererEvents.findIndex((e) => e.channel === 'agent:event');
      if (ordinary >= 0) pendingRendererEvents.splice(ordinary, 1);
      else pendingRendererEvents.shift();
    }
    return;
  }
  win.webContents.send(channel, payload);
}
function flushRendererEvents(win) {
  if (mainWindow !== win || win.isDestroyed()) return;
  mainWindowReady = true;
  const queued = pendingRendererEvents;
  pendingRendererEvents = [];
  for (const e of queued) {
    if (e.win === win && !win.isDestroyed()) win.webContents.send(e.channel, e.payload);
  }
}

ipcMain.on('chat:turn-done', (event) => {
  if (!isTrustedSender(event)) return;
  for (const resolve of turnWaiters.splice(0)) resolve();
});

function waitForTurn(maxMs) {
  return new Promise((resolve) => {
    let settled = false;
    const waiter = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const at = turnWaiters.indexOf(waiter);
      if (at >= 0) turnWaiters.splice(at, 1);
      resolve(true);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const at = turnWaiters.indexOf(waiter);
      if (at >= 0) turnWaiters.splice(at, 1);
      resolve(false);
    }, maxMs);
    turnWaiters.push(waiter);
  });
}

let boundsTimer = null;
let tray = null;
let forceQuit = false;

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function sendMenuAction(action) {
  const wasDestroyed = !mainWindow || mainWindow.isDestroyed();
  showMainWindow();
  const win = mainWindow;
  if (!win || win.isDestroyed()) return;
  if (wasDestroyed) {
    // R74 监工I：重建窗口时页面尚未加载、renderer 监听未注册——等 did-finish-load 再发
    win.webContents.once('did-finish-load', () => {
      if (mainWindow === win && !win.isDestroyed()) win.webContents.send('menu:action', action);
    });
  } else {
    win.webContents.send('menu:action', action);
  }
}

function ensureTray() {
  if (tray) return;
  const trayFile = path.join(__dirname, 'build', 'tray-16.png');
  const fallback = path.join(__dirname, 'build', 'icon.png');
  // R78 监工T：asar 内路径不能传给原生 createFromPath——用 createFromBuffer（Electron fs 可读 asar）
  const iconFile = fs.existsSync(trayFile) ? trayFile : fallback;
  const icon = nativeImage.createFromBuffer(fs.readFileSync(iconFile));
  tray = new Tray(icon);
  tray.setToolTip('Qcode');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '打开主窗口', click: () => showMainWindow() },
      { label: '新建会话', click: () => sendMenuAction('new') },
      { label: '设置…', click: () => sendMenuAction('settings') },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          forceQuit = true;
          app.quit();
        },
      },
    ])
  );
  tray.on('double-click', () => showMainWindow());
  // Windows 惯例：单击托盘图标即切换显示/隐藏
  tray.on('click', () => toggleMainWindowByHotkey());
}

function syncTray() {
  if (prefs.closeAction === 'tray') ensureTray();
  else if (tray) {
    tray.destroy();
    tray = null;
  }
}
function saveWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  // R77 监工P：最大化时 getBounds 返回全屏尺寸——用 getNormalBounds 保留用户自定义尺寸
  const b = mainWindow.getNormalBounds();
  writePrefs({
    window: {
      x: b.x,
      y: b.y,
      width: b.width,
      height: b.height,
      maximized: mainWindow.isMaximized(),
    },
  });
}

function scheduleWindowSave() {
  clearTimeout(boundsTimer);
  boundsTimer = setTimeout(saveWindowState, 400);
}

// 恢复的窗口位置必须与现有显示器工作区有实质交集，否则拔掉显示器后会“隐身”
function isBoundsOnScreen(b) {
  try {
    return screen
      .getAllDisplays()
      .some((d) => {
        const a = d.workArea;
        return (
          b.x + b.width > a.x + 60 &&
          b.x < a.x + a.width - 60 &&
          b.y + b.height > a.y + 60 &&
          b.y < a.y + a.height - 60
        );
      });
  } catch {
    return true;
  }
}

function createWindow() {
  const raw =
    prefs.window && Number.isFinite(prefs.window.width) && prefs.window.width >= 880 ? prefs.window : null;
  const saved = raw && isBoundsOnScreen(raw) ? raw : null;

  const win = new BrowserWindow({
    width: saved ? saved.width : 1180,
    height: saved ? saved.height : 780,
    ...(saved ? { x: saved.x, y: saved.y } : {}),
    minWidth: 880,
    minHeight: 560,
    show: false,
    frame: false,
    // R77 监工P：用最近一次主题设初始背景色——深色用户冷启动/托盘重建不再白闪
    backgroundColor: lastAppliedTheme === 'dark' || (lastAppliedTheme === 'system' && nativeTheme.shouldUseDarkColors) ? '#0f0f0f' : '#ffffff',
    titleBarStyle: 'hidden',
    // 无边框窗口在 Windows 任务栏不会稳定继承 exe 图标，显式设置窗口图标
    // R81 监工AA：asar 内 .ico 路径原生加载失效——用 PNG buffer（同托盘/通知口径）
    icon: nativeImage.createFromBuffer(fs.readFileSync(path.join(__dirname, 'build', 'icon.png'))),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // 隐藏/最小化时暂停 rAF 省 CPU；会话事件由 IPC 驱动，不会被节流
      backgroundThrottling: true,
    },
  });
  mainWindow = win;
  mainWindowReady = false;
  pendingRendererEvents = [];

  if (saved && saved.maximized) win.maximize();
  if (prefs.alwaysOnTop) win.setAlwaysOnTop(true);

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  if (SOAK) {
    // 长时泄漏测试不能被 Chromium 后台定时器节流，否则 sleep/rAF 膨胀导致假超时
    win.webContents.setBackgroundThrottling(false);
  }

  win.once('ready-to-show', async () => {
    if (win.isDestroyed()) return;
    win.show();
    // 自检夹具统一的工作区（见 devWorkspace()），渲染层通过 window.__qcodeDevWs 取用
    if (SMOKE || SMOKE_PERF || SMOKE_KERNEL || BENCH || SOAK || REALDATA || E2E || REWIND || IDLE) {
      try {
        await win.webContents.executeJavaScript(
          'window.__qcodeDevWs=' + JSON.stringify(devWorkspace()) + ';window.__qcodeDevRepo=' + JSON.stringify(DEV_REPO_DIR) + ';true'
        );
      } catch {
        /* 注入失败时夹具会退化为空工作区，断言会明确失败 */
      }
    }
    if (SMOKE) {
      // 看门狗：冒烟曾在个别时机上永久挂起（日志停在中途、进程不退出），
      // 超时后打印最后一条渲染层进度并明确失败，避免 CI/本地无限等待。
      const smokeTimeoutArg = /--smoke-timeout=(\d+)/.exec(process.argv.join(' '));
      const smokeTimeout = Math.max(30000, Number(smokeTimeoutArg && smokeTimeoutArg[1]) || 300000);
      win.webContents.on('console-message', (_ev, _level, message) => {
        const m = String(message || '');
        if (m.indexOf('[smoke]') === 0) log('renderer ' + m.slice(0, 200));
      });
      const smokeWatchdog = setTimeout(() => {
        try {
          log('smoke watchdog timeout after ' + smokeTimeout + 'ms (见上方最后一条 renderer 日志)');
        } catch {
          /* 日志失败也要退出 */
        }
        app.exit(2);
      }, smokeTimeout);
      smokeWatchdog.unref && smokeWatchdog.unref();
      runSmoke()
        .catch((e) => {
          log('smoke failed ' + String((e && e.message) || e));
        })
        .finally(() => clearTimeout(smokeWatchdog));
    }
    else if (SMOKE_PERF) runPerfSmoke();
    else if (SMOKE_KERNEL) runKernelSmoke();
    else if (BENCH) {
      // 基准卡住时 agent.log 里能直接看到渲染层走到哪一步
      let lastBenchStep = '(未开始)';
      win.webContents.on('console-message', (_ev, _level, message) => {
        const m = String(message || '');
        if (m.indexOf('[bench]') === 0) {
          lastBenchStep = m.slice(7).trim() || lastBenchStep;
          log('renderer ' + m);
        }
      });
      // 看门狗：--bench 曾在个别机器/时机上永久挂起（无输出、无退出），
      // 与其让 CI 干等，不如超时后打印进度并明确失败。
      const benchTimeoutArg = /--bench-timeout=(\d+)/.exec(process.argv.join(' '));
      const benchTimeout = Math.max(30000, Number(benchTimeoutArg && benchTimeoutArg[1]) || 180000);
      const benchWatchdog = setTimeout(() => {
        try {
          const mem = process.memoryUsage();
          log(
            'bench watchdog timeout after ' +
              benchTimeout +
              'ms; lastStep=' +
              lastBenchStep +
              '; rssMb=' +
              Math.round(mem.rss / 1048576)
          );
        } catch {
          /* 日志失败也要退出 */
        }
        app.exit(2);
      }, benchTimeout);
      benchWatchdog.unref && benchWatchdog.unref();
      runBench()
        .catch((e) => {
          log('bench failed ' + String((e && e.message) || e));
        })
        .finally(() => clearTimeout(benchWatchdog));
    }
    else if (SOAK) runSoak();
    else if (REALDATA) runRealData();
    else if (E2E) runE2E();
    else if (REWIND) runRewindBench();
    else if (IDLE) runIdle();
    else if (PROBE || PROBE_NOKERNEL) runProbe();
  });

  win.on('resize', scheduleWindowSave);
  win.on('move', scheduleWindowSave);

  win.on('close', (e) => {
    clearTimeout(boundsTimer);
    saveWindowState();
    // 「关闭到托盘」模式下拦截关闭，只隐藏窗口
    if (!forceQuit && prefs.closeAction === 'tray' && !win.isDestroyed()) {
      e.preventDefault();
      win.hide();
      flushSessionSavesForBackground();
    }
  });

  win.on('closed', () => {
    if (mainWindow === win) {
      mainWindow = null;
      mainWindowReady = false;
      pendingRendererEvents = [];
    }
  });

  win.webContents.once('did-finish-load', () => {
    // 不在这里补发：页面脚本已执行但 boot 的首屏数据可能尚未就绪。
    // renderer 完成首屏后会通过 app:renderer-ready 握手触发 flushRendererEvents。
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    // 只允许 http(s) 交给系统浏览器，其它协议一律拒绝
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // markdown 里的普通链接如果不拦，会在应用窗口内导航走（把界面顶掉）
  // 把 renderer 控制台错误写日志（诊断 smoke 断言异常，收口后保留也有价值）
  win.webContents.on('console-message', (params) => {
    const msg = String(params.message || '');
    if (params.level >= 2 || /error|uncaught|exception/i.test(msg)) {
      log('[renderer-console] level=' + params.level + ' line=' + params.lineNumber + ' ' + params.sourceId + ' :: ' + msg.slice(0, 400));
    }
  });

  win.webContents.on('will-navigate', (e, url) => {
    const cur = !win.isDestroyed() ? win.webContents.getURL() : '';
    if (url === cur) return;
    e.preventDefault();
    if (/^https?:/i.test(url)) shell.openExternal(url);
  });

  // 原生右键菜单：输入框给剪切/复制/粘贴/全选，选中文本给复制
  win.webContents.on('context-menu', (_e, params) => {
    const items = [];
    if (params.isEditable) {
      items.push(
        { role: 'cut', enabled: params.editFlags.canCut },
        { role: 'copy', enabled: params.editFlags.canCopy },
        { role: 'paste', enabled: params.editFlags.canPaste },
        { type: 'separator' },
        { role: 'selectAll' }
      );
    } else if (params.selectionText) {
      items.push({ role: 'copy' });
    }
    if (!items.length) return;
    Menu.buildFromTemplate(items).popup({ window: win });
  });
}

/* ------------------------------------------------------------------ */
/* IPC                                                                 */
/* ------------------------------------------------------------------ */

// R86：IPC 通道预热用的空消息（preload 启动即发一条，把首个 invoke 的冷启动成本挪到解析期），
// 不读写任何状态，纯 no-op。
ipcMain.handle('app:ping', () => true);

ipcMain.handle('app:renderer-ready', (event) => {
  if (!isTrustedSender(event)) return false;
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win !== mainWindow) return false;
  flushRendererEvents(win);
  return true;
});

ipcMain.handle('app:info', () => ({
  cwd: os.homedir(),
  home: os.homedir(),
  platform: process.platform,
  qwen: QWEN_CMD,
}));

ipcMain.handle('app:security', () => ({
  ok: true,
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  clipboardOnly: true,
  attachMax: ATTACH_MAX,
  redactSample: redactSecrets('sk-' + 'a'.repeat(32)),
  // R82：结构化键名变体（apiKey/access_token 等）也须脱敏，供 --smoke 断言
  // 取值刻意不带 sk- 前缀：命中的是「键名规则」而非「sk- 前缀规则」，两条规则各测各的
  redactKeySample: redactSecrets('{"apiKey":"' + 'b'.repeat(32) + '","access_token":"' + 'c'.repeat(40) + '","enabled":true}'),
}));

ipcMain.handle('app:meta', () => ({
  ok: true,
  name: 'Qcode',
  version: app.getVersion(),
  smokePerf: true,
  // 需要 SDK 初始化才能逐项确认的档位（供 --smoke 验证 gating 与 UI 档位一致）
  sdkApprovalTiers: ['default', 'auto-edit'],
  // 授权快速通道抽样（供 --smoke 校验：只读所有档放行、auto-edit 放行编辑、default 拦截编辑）
  approvalFastPath: {
    readOnlyInDefault: approvalAutoAllow('default', 'glob'),
    readOnlyInAutoEdit: approvalAutoAllow('auto-edit', 'glob'),
    editInAutoEdit: approvalAutoAllow('auto-edit', 'edit'),
    editInDefault: approvalAutoAllow('default', 'edit'),
    shellInDefault: approvalAutoAllow('default', 'run_shell_command'),
    shellInAutoEdit: approvalAutoAllow('auto-edit', 'run_shell_command'),
  },
  // 安装器形态只读快照：供 --smoke 验证交付配置，避免误交付旧 oneClick 包
  // 安装器形态：写死为当前 package.json 的 nsis 配置（构建期事实）。
  // 打包后 asar 内的 package.json 会被 electron-builder 改写、读不到 build 字段，
  // 所以不能用运行时 require('./package.json') 判定。
  installer: {
    oneClick: false,
    directory: true,
    license: true,
    perMachine: false,
  },
}));

// R84：默认工作目录改为「候选探测」——渲染层原本写死 <工作区>，换机器/换盘符即失效
function guessDefaultCwd() {
  const cands = [];
  if (process.platform === 'win32') cands.push(path.join(os.homedir(), 'source', 'repos'));
  cands.push(path.join(os.homedir(), 'Projects'), os.homedir());
  for (const c of cands) {
    try {
      if (fs.statSync(c).isDirectory()) return c;
    } catch {
      /* try next */
    }
  }
  return os.homedir();
}

ipcMain.handle('app:paths', () => ({
  home: os.homedir(),
  userData: app.getPath('userData'),
  sessions: DATA_DIR,
  logFile: LOG_FILE,
  qwenConfig: QWEN_DIR,
  platform: process.platform,
  version: app.getVersion(),
  electron: process.versions.electron,
  node: process.versions.node,
  defaultCwd: guessDefaultCwd(),
}));

ipcMain.handle('app:iconInfo', () => {
  const out = { ok: true, sizes: [], tray: false, brand: false, smallIconBytes: 0, installerIcon: false };
  try {
    const ico = fs.readFileSync(path.join(__dirname, 'build', 'icon.ico'));
    const count = ico.readUInt16LE(4);
    for (let i = 0; i < count; i++) {
      const w = ico[6 + i * 16];
      const bytes = ico.readUInt32LE(6 + i * 16 + 8);
      if (w === 16) out.smallIconBytes = bytes;
      out.sizes.push(w === 0 ? 256 : w);
    }
  } catch {
    out.ok = false;
  }
  out.tray = fs.existsSync(path.join(__dirname, 'build', 'tray-16.png'));
  out.brand = fs.existsSync(path.join(__dirname, 'build', 'brand.svg'));
  // 透明底校验：colorType=6 表示带 alpha（深浅主题不露白块）
  const pngColorType = (f) => {
    try {
      const b = fs.readFileSync(path.join(__dirname, 'build', f));
      return b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? b[25] : -1;
    } catch {
      return -1;
    }
  };
  out.transparent = pngColorType('icon.png') === 6;
  out.trayTransparent = pngColorType('tray-16.png') === 6;
  // 构建期事实：package.json 的 win.icon / nsis.installerIcon 均为 build/icon.ico。
  // 打包后 asar 内 package.json 被改写读不到 build 字段，只校验图标文件本身存在。
  out.installerIcon = fs.existsSync(path.join(__dirname, 'build', 'icon.ico'));
  return out;
});

ipcMain.handle('cli:probe', async () => {
  const launch = resolveQwenLaunch();
  const candidates = [];
  if (launch) candidates.push(launch.cmd);
  const onPath = findQwenExecutable();
  if (onPath) candidates.push(onPath);
  const node = findNodeExecutable();
  const npm = findNpmExecutable();
  const local = localKernelEntry();
  if (fs.existsSync(local)) candidates.push(local);
  for (const entry of knownQwenEntries()) candidates.push(entry);
  const localPrograms = process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'Programs')
    : '';
  if (localPrograms && fs.existsSync(localPrograms)) {
    try {
      for (const name of fs.readdirSync(localPrograms)) {
        if (/qwen/i.test(name)) candidates.push(path.join(localPrograms, name));
      }
    } catch {
      /* optional probe */
    }
  }
  return {
    ok: true,
    found: !!launch,
    mode: launch ? launch.mode : '',
    cmd: launch ? launch.cmd : '',
    qwenCmd: QWEN_CMD,
    candidates: [...new Set(candidates)].filter(Boolean).slice(0, 12),
    node: node || '',
    npm: npm || '',
    localKernel: fs.existsSync(local),
  };
});

ipcMain.handle('kernel:status', () => {
  const launch = resolveQwenLaunch();
  return {
    ok: !!launch,
    launch: launch || null,
    node: findNodeExecutable() || '',
    npm: findNpmExecutable() || '',
    localKernel: fs.existsSync(localKernelEntry()),
    qwenCmd: QWEN_CMD,
  };
});

ipcMain.handle('kernel:install', () => installKernel());

ipcMain.handle('kernel:selfheal', async () => {
  // R72（监工A）：跳过 busy 的会话——强杀进行中回合会走崩溃自愈路径，渲染层收到非预期 host_exit
  const agent = [...agents.values()].find((a) => a.child && !a.busy);
  if (!agent) {
    const anyChild = [...agents.values()].find((a) => a.child);
    return anyChild
      ? { ok: false, error: '内核都在执行回合，稍后再试' }
      : { ok: false, error: '没有正在运行的内核进程' };
  }
  const before = agent.child.pid;
  const resumeBefore = agent.resumeId || agent.qwenSessionId || null;
  agent.stop(false);
  await new Promise((resolve) => setTimeout(resolve, 900));
  const after = agent.child;
  return {
    ok: !!after,
    before,
    after: after ? after.pid : null,
    resume: agent.resumeId || agent.qwenSessionId || null,
    resumeBefore,
  };
});

// GPU 硬件信息在一次会话内不变，但 getGPUInfo 每次查询 GPU 进程（5-50ms）。
// 只缓存静态部分（device/vendor/feature），动态的 disableGpu/gpuFlags 每次从 prefs 读取合并。
let gpuInfoCache = null;
function getGpuInfoCached() {
  if (gpuInfoCache) return gpuInfoCache;
  gpuInfoCache = (async () => {
    let info = {};
    try {
      info = await app.getGPUInfo('basic');
    } catch {
      /* optional diagnostics */
    }
    let feature = {};
    try {
      feature = app.getGPUFeatureStatus() || {};
    } catch {
      /* optional diagnostics */
    }
    return {
      feature,
      device: (info && info.gpuDevice && info.gpuDevice[0] && info.gpuDevice[0].deviceString) || '',
      vendor: (info && info.gpuDevice && info.gpuDevice[0] && info.gpuDevice[0].vendorString) || '',
    };
  })();
  return gpuInfoCache;
}
ipcMain.handle('app:gpu', async () => {
  const staticInfo = await getGpuInfoCached();
  return {
    ok: true,
    ...staticInfo,
    disableGpu: !!prefs.disableGpu,
    gpuFlags: prefs.gpuFlags || '',
    backgroundThrottling: true,
    whitelist: GPU_FLAG_WHITELIST,
  };
});

/* ---------------- 文件系统辅助（@ 提及 / 拖放） ---------------- */

function isInside(base, target) {
  const b = path.resolve(base).toLowerCase().replace(/[\\/]+$/, '');
  const t = path.resolve(target).toLowerCase().replace(/[\\/]+$/, '');
  return t === b || t.startsWith(b + path.sep);
}

let fsListRequests = 0;
// String.localeCompare 每次排序都要重建排序规则；预建 Intl.Collator 复用（2000 条排序 1.6x）
const fsNameCollator = new Intl.Collator();

// 目录清单缓存：分页「加载更多」/目录展开/@ 路径每次按键都请求同一目录，
// 原实现每次 readdir + stat 符号链接 + 全排序（200 条约 1ms，2000 条约 10-25ms）。
// 按 resolved dir 缓存已排序清单，短 TTL；写文件经 invalidateFsSearchInventory 失效。
const fsListCache = new Map();
const FS_LIST_TTL = 15000;

async function buildDirectoryListing(dir) {
  const items = await fs.promises.readdir(dir, { withFileTypes: true });
  const all = [];
  for (const d of items) {
    if (d.name.startsWith('.')) continue;
    let isDir = d.isDirectory();
    if (d.isSymbolicLink()) {
      try {
        isDir = (await fs.promises.stat(path.join(dir, d.name))).isDirectory();
      } catch {
        /* 坏链接当文件处理 */
      }
    }
    all.push({ name: d.name, dir: isDir });
  }
  all.sort((a, b) => (a.dir === b.dir ? fsNameCollator.compare(a.name, b.name) : a.dir ? -1 : 1));
  return all;
}

async function listDirectory(dir, offset, limit) {
  let all = null;
  const hit = fsListCache.get(dir);
  if (hit && Date.now() - hit.at < FS_LIST_TTL) all = hit.entries;
  if (!all) {
    all = await buildDirectoryListing(dir);
    fsListCache.set(dir, { at: Date.now(), entries: all });
    if (fsListCache.size > 200) {
      const oldest = fsListCache.keys().next().value;
      if (oldest !== undefined) fsListCache.delete(oldest);
    }
  }
  const start = Math.max(0, Math.floor(Number(offset) || 0));
  const pageSize = Math.min(500, Math.max(1, Math.floor(Number(limit) || 200)));
  return {
    ok: true,
    dir,
    entries: all.slice(start, start + pageSize),
    total: all.length,
    offset: start,
    limit: pageSize,
  };
}

ipcMain.handle('fs:list', async (_e, { root, rel, offset = 0, limit = 200 } = {}) => {
  fsListRequests++;
  const base = path.resolve(root || os.homedir());
  const dir = path.resolve(base, rel || '.');
  if (!isInside(base, dir)) return { ok: false, error: '路径越界', entries: [], total: 0 };
  try {
    const realBase = await fs.promises.realpath(base);
    const realDir = await fs.promises.realpath(dir);
    if (!isInside(realBase, realDir)) return { ok: false, error: '路径越界', entries: [], total: 0 };
    return await listDirectory(dir, offset, limit);
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e), entries: [], total: 0 };
  }
});

ipcMain.handle('fs:stat', (_e, target) => {
  try {
    const st = fs.statSync(target);
    return { ok: true, isDirectory: st.isDirectory(), isFile: st.isFile(), size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

function runGit(cwd, args) {
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, ...args], { timeout: 15000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        stdout: String(stdout || ""),
        stderr: String(stderr || ""),
        error: err ? String((err && err.message) || err) : '',
      });
    });
  });
}

const gitStatusCache = new Map();
const gitStatusCacheLimit = 60; // R80 监工Y：防大量 cwd 常驻 1000 文件对象

ipcMain.handle('git:status', async (_e, { cwd, force } = {}) => {
  if (!cwd) return { ok: false, isRepo: false, error: '没有工作目录' };
  const key = path.resolve(cwd);
  if (force) {
    for (const k of [...gitDiffCache.keys()]) {
      if (k.startsWith(key + '\u0000')) gitDiffCache.delete(k);
    }
  }
  const hit = gitStatusCache.get(key);
  if (!force && hit && Date.now() - hit.at < 3000) return hit.result;
  const started = Date.now();
  // -z 避免路径转义；关闭 rename 检测/fsmonitor，大仓库里明显更快
  const res = await runGit(key, ['-c', 'core.quotepath=false', '-c', 'core.fsmonitor=false', 'status', '--porcelain=v1', '-z', '-b', '--no-renames', '--ignore-submodules=dirty']);
  if (!res.ok) {
    const result = { ok: false, isRepo: false, error: res.stderr || res.error };
    gitStatusCache.set(key, { at: Date.now(), result });
    if (gitStatusCache.size > gitStatusCacheLimit) gitStatusCache.delete(gitStatusCache.keys().next().value);
    return result;
  }
  const parts = res.stdout.split("\u0000").filter(Boolean);
  let branch = "";
  const files = [];
  let truncated = false;
  for (const part of parts) {
    if (part.startsWith("## ")) {
      branch = part.slice(3).split("...")[0].trim();
      continue;
    }
    if (part.length < 4) continue;
    const xy = part.slice(0, 2);
    const p = part.slice(3);
    files.push({
      status: xy.trim() || "M",
      path: p,
      index: xy[0],
      worktree: xy[1],
      staged: xy[0] !== ' ' && xy[0] !== '?',
    });
    if (files.length >= 1000) {
      truncated = true;
      break;
    }
  }
  const result = { ok: true, isRepo: true, branch, files, truncated, elapsedMs: Date.now() - started };
  gitStatusCache.set(key, { at: Date.now(), result });
    if (gitStatusCache.size > gitStatusCacheLimit) gitStatusCache.delete(gitStatusCache.keys().next().value);
  log("git status", key, String(result.files.length), "files", String(result.elapsedMs) + "ms");
  return result;
});

const gitDiffCache = new Map();
const gitDiffCacheLimit = 60;
const GIT_DIFF_MAX = 1024 * 1024;

function resolveGitRelPath(cwd, rel) {
  const base = path.resolve(cwd);
  const file = path.resolve(base, String(rel || ''));
  if (!isInside(base, file)) return null;
  return { base: base, file: file, rel: path.relative(base, file) || '.' };
}
function capGitDiff(text) {
  const s = String(text || '');
  if (s.length <= GIT_DIFF_MAX) return { diff: s, truncated: false };
  return { diff: s.slice(0, GIT_DIFF_MAX) + '\n\n[diff 超过 1MB，已截断]\n', truncated: true };
}

ipcMain.handle('git:diff', async (_e, { cwd, rel, includeStaged } = {}) => {
  if (!cwd || !rel) return { ok: false, error: '缺少参数' };
  const paths = resolveGitRelPath(cwd, rel);
  if (!paths) return { ok: false, error: '路径越界' };
  const key = paths.base + '\u0000' + paths.rel + '\u0000' + (includeStaged ? '1' : '0');
  const hit = gitDiffCache.get(key);
  if (hit && Date.now() - hit.at < 3000) {
    return { ...hit.result, cached: true };
  }
  let res = await runGit(paths.base, ['diff', '--', paths.rel]);
  if (!res.ok) return { ok: false, error: res.stderr || res.error || '读取差异失败' };
  let diff = res.stdout;
  let stagedDiff = '';
  if (includeStaged || !diff.trim()) {
    const staged = await runGit(paths.base, ['diff', '--cached', '--', paths.rel]);
    if (!staged.ok) return { ok: false, error: staged.stderr || staged.error || '读取暂存差异失败' };
    stagedDiff = staged.stdout;
    if (!diff.trim()) diff = stagedDiff;
  }
  if (diff.trim() && stagedDiff.trim() && diff.trim() !== stagedDiff.trim()) {
    diff = '// 暂存区（相对 HEAD）\n' + stagedDiff.trim() + '\n\n// 工作区（相对暂存区）\n' + diff.trim();
  }
  if (!diff.trim()) {
    try {
      const realBase = await fs.promises.realpath(paths.base);
      const realFile = await fs.promises.realpath(paths.file);
      if (isInside(realBase, realFile)) {
        const preview = await readWorkspaceFile(paths.file);
        if (preview.ok) diff = '(未跟踪或未暂存，以下为文件内容)\n\n' + preview.content;
      }
    } catch {
      /* ignore */
    }
  }
  const capped = capGitDiff(diff || '(无差异)');
  const result = { ok: true, diff: capped.diff, stagedDiff: capGitDiff(stagedDiff || '(无暂存差异)').diff, truncated: capped.truncated };
  gitDiffCache.set(key, { at: Date.now(), result });
  if (gitDiffCache.size > gitDiffCacheLimit) {
    const first = gitDiffCache.keys().next().value;
    if (first !== undefined) gitDiffCache.delete(first);
  }
  return result;
});

function invalidateGitCaches(cwd) {
  const key = path.resolve(cwd);
  gitStatusCache.delete(key);
  for (const k of [...gitDiffCache.keys()]) {
    if (k.startsWith(key + '\u0000')) gitDiffCache.delete(k);
  }
}

ipcMain.handle('git:stage', async (_e, { cwd, rel, stage } = {}) => {
  if (!cwd || !rel) return { ok: false, error: '缺少参数' };
  const paths = resolveGitRelPath(cwd, rel);
  if (!paths) return { ok: false, error: '路径越界' };
  let res;
  if (stage) {
    res = await runGit(paths.base, ['add', '--', paths.rel]);
  } else {
    res = await runGit(paths.base, ['restore', '--staged', '--', paths.rel]);
    if (!res.ok) res = await runGit(paths.base, ['reset', '--', paths.rel]);
  }
  if (!res.ok) return { ok: false, error: res.stderr || res.error || '操作失败' };
  invalidateGitCaches(cwd);
  return { ok: true };
});

ipcMain.handle('git:commit', async (_e, { cwd, message } = {}) => {
  const msg = String(message || '').trim();
  if (!cwd || !msg) return { ok: false, error: '提交信息为空' };
  if (msg.length > 4096) return { ok: false, error: '提交信息超过 4096 字符' };
  const res = await runGit(cwd, ['commit', '-m', msg]);
  if (!res.ok) return { ok: false, error: res.stderr || res.stdout || res.error || '提交失败' };
  invalidateGitCaches(cwd);
  return { ok: true, stdout: res.stdout };
});
const ATTACH_DIR = path.join(app.getPath('temp'), 'qwen-agent-attachments');
const ATTACH_MAX = 20 * 1024 * 1024;
const IMAGE_EXT = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

// R118：pruneAttachments 对目录里每个附件做同步 stat，原来每次保存图片都跑一遍；限频到 60s 一次。
let attachPruneAt = 0;
function pruneAttachmentsThrottled() {
  const now = Date.now();
  if (now - attachPruneAt < 60000) return;
  attachPruneAt = now;
  pruneAttachments();
}

function pruneAttachments() {
  try {
    const files = fs
      .readdirSync(ATTACH_DIR)
      .map((f) => {
        const full = path.join(ATTACH_DIR, f);
        let mtime = 0;
        try {
          mtime = fs.statSync(full).mtimeMs;
        } catch {
          mtime = 0;
        }
        return { f, full, mtime };
      })
      .sort((a, b) => b.mtime - a.mtime);
    const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
    files.forEach((x, i) => {
      if (i >= 200 || x.mtime < cutoff) {
        try {
          fs.unlinkSync(x.full);
        } catch {
          /* ignore */
        }
      }
    });
  } catch {
    /* ignore */
  }
}

function newAttachmentPath(ext) {
  return path.join(ATTACH_DIR, 'attach-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.' + ext);
}

ipcMain.handle('attachment:save', (_e, { name, mime, dataBase64 } = {}) => {
  try {
    if (!dataBase64) return { ok: false, error: '空数据' };
    const ext = IMAGE_EXT[String(mime || "").toLowerCase()];
    if (!ext) return { ok: false, error: '仅支持 PNG/JPEG/WebP/GIF' };
    // R74 监工I：剥离 data URL 前缀（整段 data:image/...;base64,... 直接解码会产生损坏字节）
    const raw = String(dataBase64).replace(/^data:[^,]*,/, "");
    // 先按 base64 膨胀后的长度拒绝，避免超大字符串先 Buffer.from 分配再检查
    if (raw.length > Math.ceil((ATTACH_MAX * 4) / 3) + 64) return { ok: false, error: '单张图片不能超过 20MB' };
    const buf = Buffer.from(raw, "base64");
    if (!buf.length) return { ok: false, error: '图片数据无效' };
    if (buf.length > ATTACH_MAX) return { ok: false, error: '单张图片不能超过 20MB' };
    fs.mkdirSync(ATTACH_DIR, { recursive: true });
    const file = newAttachmentPath(ext);
    fs.writeFileSync(file, buf);
    pruneAttachmentsThrottled();
    return { ok: true, path: file, name: String(name || "图片").slice(0, 120), size: buf.length };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

ipcMain.handle('attachment:pick', async () => {
  try {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: '选择图片附件',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }],
    });
    if (res.canceled || !res.filePaths || !res.filePaths.length) return { ok: false, canceled: true };
    const items = [];
    let skipped = 0;
    for (const file of res.filePaths.slice(0, 6)) {
      try {
        const st = await fs.promises.stat(file);
        if (!st.isFile() || st.size > 8 * 1024 * 1024) { skipped++; continue; }
        const ext = path.extname(file).toLowerCase();
        const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : ext === '.gif' ? 'image/gif' : 'image/png';
        const buf = await fs.promises.readFile(file);
        items.push({ name: path.basename(file), mime, dataBase64: buf.toString('base64') });
      } catch {
        skipped++;
      }
    }
    return { ok: true, items, skipped };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

// R74 监工I：attachment:import 死代码 + 任意路径越权面——preload 已移除暴露，
// handler 保留但不接受任意 source（如需导入走用户 dialog 选择，由主进程产生路径）
ipcMain.handle('attachment:import', async () => ({ ok: false, error: '已停用，请通过选择文件导入' }));

async function readWorkspaceFile(file) {
  const handle = await fs.promises.open(file, 'r');
  try {
    const st = await handle.stat();
    if (!st.isFile()) return { ok: false, error: '不是文件' };
    if (st.size > 512 * 1024) return { ok: false, error: '文件超过 512KB，不做预览' };
    // 有界读取：避免 stat 后文件被快速增大时 readFile 分配超大缓冲
    const buf = Buffer.alloc(512 * 1024 + 1);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    if (bytesRead > 512 * 1024) return { ok: false, error: '文件超过 512KB，不做预览' };
    const data = buf.subarray(0, bytesRead);
    if (data.includes(0)) return { ok: false, error: '二进制文件无法预览' };
    return { ok: true, path: file, size: bytesRead, content: data.toString('utf8') };
  } finally {
    await handle.close();
  }
}

ipcMain.handle('fs:read', async (_e, { root, rel } = {}) => {
  const base = path.resolve(root || os.homedir());
  const file = path.resolve(base, rel || '');
  if (!isInside(base, file)) return { ok: false, error: '路径越界' };
  try {
    // R72（监工A）：读路径与写路径同口径——工作区内指向外部的 symlink/junction 不可借道读出
    const realBase = await fs.promises.realpath(base);
    const realFile = await fs.promises.realpath(file);
    if (!isInside(realBase, realFile)) return { ok: false, error: '路径越界' };
    return await readWorkspaceFile(file);
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

async function writeWorkspaceFile(file, content) {
  const st = await fs.promises.stat(file).catch(() => null);
  if (st && !st.isFile()) return { ok: false, error: '不是文件' };
  if (Buffer.byteLength(content, 'utf8') > 2 * 1024 * 1024) {
    return { ok: false, error: '内容超过 2MB，拒绝写入' };
  }
  await fs.promises.writeFile(file, content, 'utf8');
  const after = await fs.promises.stat(file);
  return { ok: true, path: file, size: after.size };
}

// R72（监工A）：新文件的 realpath 会 ENOENT——改校验「最深存在的祖先目录」，
// 防止父目录是 junction 时新文件被写到工作区外。
async function realPathOfDeepestExisting(base, file) {
  let cur = file;
  for (let i = 0; i < 32; i++) {
    const real = await fs.promises.realpath(cur).catch(() => null);
    if (real) return real;
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
  return null;
}

ipcMain.handle('fs:write', async (_e, { root, rel, content, expected } = {}) => {
  const base = path.resolve(root || os.homedir());
  const file = path.resolve(base, rel || '');
  if (!isInside(base, file)) return { ok: false, error: '路径越界' };
  if (typeof content !== 'string') return { ok: false, error: '内容无效' };
  try {
    // symlink 目标也要落在工作目录内，避免借链接写出工作区
    const realBase = await fs.promises.realpath(base);
    const realFile = await realPathOfDeepestExisting(base, file);
    if (!realFile || !isInside(realBase, realFile)) return { ok: false, error: '路径越界' };
    if (expected && typeof expected === 'object') {
      const st = await fs.promises.stat(file).catch(() => null);
      if (!st || st.size !== expected.size || Math.floor(st.mtimeMs) !== Math.floor(expected.mtimeMs) || Math.floor(st.ctimeMs) !== Math.floor(expected.ctimeMs)) {
        return { ok: false, conflict: true, error: '文件已被外部修改，请重新加载或强制保存' };
      }
    }
    invalidateFsSearchInventory(base); // 文件变化后搜索清单需重建
    return await writeWorkspaceFile(file, content);
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

ipcMain.handle('model:context', (_e, modelId) => {
  try {
    const reg = JSON.parse(fs.readFileSync(path.join(QWEN_DIR, 'model-registry.json'), 'utf8'));
    const models = (reg && reg.models) || {};
    const id = String(modelId || '');
    let hit = models[id];
    if (!hit && id.includes('/')) hit = models[id.slice(id.lastIndexOf('/') + 1)];
    return { ok: true, context: Number(hit && hit.context) || 0 };
  } catch {
    return { ok: true, context: 0 };
  }
});

/* ---------------- 内核版本 / 主题 ---------------- */

let cliVersionCache = null;
// 内核（qwen-code）权威版本：直接读上游包的 package.json，离线即时且与源码一致
function bundledKernelPkgVersion() {
  try {
    const pkg = path.join(
      bundledKernelRoot(),
      'node_modules',
      '@qwen-code',
      'qwen-code',
      'package.json'
    );
    const j = JSON.parse(fs.readFileSync(pkg, 'utf8'));
    if (j && typeof j.version === 'string' && j.version.trim()) {
      return { ok: true, version: j.version.trim(), source: 'package.json' };
    }
  } catch {
    /* 内核不存在时走 --version 探测兜底 */
  }
  return null;
}
ipcMain.handle('cli:version', () => {
  if (cliVersionCache && cliVersionCache.ok) return Promise.resolve(cliVersionCache);
  const fromPkg = bundledKernelPkgVersion();
  if (fromPkg) {
    cliVersionCache = fromPkg;
    return Promise.resolve(fromPkg);
  }
  return new Promise((resolve) => {
    const launch = resolveQwenLaunch();
    if (!launch) {
      resolve({ ok: false, error: '未找到 qwen CLI，可一键安装内核或手动指定路径' });
      return;
    }
    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = spawn(launch.cmd, [...launch.prefix, '--version'], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', ...((launch && launch.env) || {}) },
      });
    } catch (e) {
      resolve({ ok: false, error: String((e && e.message) || e) });
      return;
    }
    const timer = setTimeout(() => {
      try {
        killChildTree(child);
      } catch {
        /* ignore */
      }
      resolve({ ok: false, error: '版本检测超时' });
    }, 8000);
    child.stdout.on('data', (c) => {
      stdout = (stdout + c.toString()).slice(-2000);
    });
    child.stderr.on('data', (c) => {
      stderr = (stderr + c.toString()).slice(-2000);
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, error: String((e && e.message) || e) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const out = { ok: code === 0, version: stdout.trim() };
      if (code !== 0) {
        out.ok = false;
        out.error = stderr.trim() || `退出码 ${code}`;
      } else {
        cliVersionCache = out;
      }
      resolve(out);
    });
  });
});

ipcMain.handle('renderer:error', (_e, info = {}) => {
  log('[renderer-error]', String(info.message || '').slice(0, 300), String(info.stack || '').slice(0, 1200));
  return true;
});

ipcMain.handle('theme:apply', (_e, theme) => {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  // R77 监工P：参数白名单 + nativeTheme 联动——原生对话框（打开/保存/确认）跟随应用主题
  if (!['light', 'dark', 'system'].includes(theme)) return false;
  nativeTheme.themeSource = theme;
  const dark = theme === 'dark' || (theme === 'system' && nativeTheme.shouldUseDarkColors);
  mainWindow.setBackgroundColor(dark ? '#0f0f0f' : '#ffffff');
  lastAppliedTheme = theme;
  return true;
});

/* ---------------- 通用设置：自启 / 通知 / 扩展开关 ---------------- */

function applyLoginItem() {
  if (!app.isPackaged) return;
  try {
    const cur = !!app.getLoginItemSettings().openAtLogin;
    if (cur !== !!prefs.launchAtLogin) {
      app.setLoginItemSettings({ openAtLogin: !!prefs.launchAtLogin, path: process.execPath, args: [] });
    }
  } catch {
    /* 某些环境不支持登录项，忽略 */
  }
}

ipcMain.handle('app:loginItem', (_e, enable) => {
  if (enable != null) {
    if (!app.isPackaged) {
      return { ok: false, available: false, error: '开发模式不支持开机自启，打包安装后可用' };
    }
    writePrefs({ launchAtLogin: !!enable });
    applyLoginItem();
  }
  return {
    ok: true,
    available: app.isPackaged,
    enabled: app.isPackaged ? !!app.getLoginItemSettings().openAtLogin : !!prefs.launchAtLogin,
  };
});

async function notifyWithFailureWindow(title, body, NotificationCtor = Notification) {
  try {
    if (!NotificationCtor.isSupported()) return false;
    const n = new NotificationCtor({
      title: String(title || 'Qcode').slice(0, 80),
      body: String(body || '').slice(0, 220),
      // R78 监工T：同上，通知图标走 buffer 避开 asar 路径失效
      icon: nativeImage.createFromBuffer(fs.readFileSync(path.join(__dirname, 'build', 'icon.png'))),
      silent: true,
    });
    n.on('click', () => {
      showMainWindow();
    });
    // failed 是异步事件；等待一小段窗口，避免在系统拒绝前就返回成功
    return await new Promise((resolve) => {
      let settled = false;
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(ok);
      };
      const timer = setTimeout(() => finish(true), 400);
      n.once('failed', () => finish(false));
      try { n.show(); } catch { finish(false); }
    });
  } catch {
    return false;
  }
}

ipcMain.handle('app:notify', (_e, { title, body } = {}) => notifyWithFailureWindow(title, body));

/* ---------------- 全局热键 / 文件搜索 / 钩子 / 导出 ---------------- */

function toggleMainWindowByHotkey() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isVisible() && !mainWindow.isMinimized()) mainWindow.hide();
  else showMainWindow();
}

function syncHotkey() {
  try {
    globalShortcut.unregisterAll();
  } catch {
    /* ignore */
  }
  const acc = String(prefs.hotkey || '').trim();
  if (!acc) return { registered: false };
  try {
    const ok = globalShortcut.register(acc, toggleMainWindowByHotkey);
    return ok ? { registered: true } : { registered: false, error: '快捷键被其他应用占用' };
  } catch (e) {
    return { registered: false, error: String((e && e.message) || e) };
  }
}

/* ---------------- 工作区检查点（参考 ZCode rewind） ---------------- */
// 每回合发送前对工作区做增量快照；/rewind 可将文件回滚到检查点状态。
// 内容寻址 blob 去重：只有变化的文件才产生新 blob，恢复=把 blob 写回路径。
// 灾难教训（r49 事故）：blobs 目录必须先 mkdir；空 manifest（walk 未收集到文件）时
// 严禁 deleteAdded，否则会把整个工作区当「新增」全部删除。

const CHECKPOINT_IGNORE_DIRS = new Set([
  'node_modules', 'dist', 'build', 'out', '.git', '.svn', '.hg', '.venv', 'venv',
  '__pycache__', 'target', '.idea', '.vscode', '.next', 'coverage', '.qwen',
]);
const CHECKPOINT_FILE_MAX = 4 * 1024 * 1024;
const CHECKPOINT_TOTAL_MAX = 96 * 1024 * 1024;
const CHECKPOINT_WALK_DEPTH = 14;
const CHECKPOINT_KEEP_PER_SESSION = 10;
const CHECKPOINT_SESSION_ID_RE = /^[a-zA-Z0-9_-]{1,80}$/;
let checkpointGcAt = 0;

function checkpointRootDir() {
  return path.join(app.getPath('userData'), 'checkpoints');
}
function checkpointSessionDir(sessionId) {
  return path.join(checkpointRootDir(), sessionId);
}
function sameCheckpointStamp(record, st) {
  if (!record || !st) return false;
  if (record.size !== Number(st.size)) return false;
  if (record.mtimeNs && st.mtimeNs !== undefined) {
    return record.mtimeNs === String(st.mtimeNs) && record.ctimeNs === String(st.ctimeNs);
  }
  return record.size === Number(st.size) && record.mtimeMs === Number(st.mtimeMs) && record.ctimeMs === Number(st.ctimeMs);
}
function checkpointBlobPath(sha) {
  return path.join(checkpointRootDir(), 'blobs', sha);
}

async function sha256File(file) {
  return new Promise((resolve) => {
    const hash = createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('data', (c) => hash.update(c));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', () => resolve(null));
  });
}

// 有界遍历工作区：跳过忽略目录/隐藏项/超大文件。
// 层内文件 stat 批量化（Promise.all），push/bytes 判定保持原序；大工作区（4000 文件上限）
// 实测 182.7→96.2ms（1.9x）。create/diff/restore 共用本函数，顺序变化自洽。
async function walkWorkspaceForCheckpoint(dir, base, out, depth) {
  if (depth > CHECKPOINT_WALK_DEPTH || out.bytes > CHECKPOINT_TOTAL_MAX) {
    out.truncated = true;
    return;
  }
  let items;
  try {
    items = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    out.truncated = true;
    out.failed = (out.failed || 0) + 1;
    return;
  }
  const fileJobs = [];
  for (const d of items) {
    if (out.files.length >= 4000) {
      out.truncated = true;
      return;
    }
    if (d.name.startsWith('.') || CHECKPOINT_IGNORE_DIRS.has(d.name)) continue;
    if (d.name.startsWith('_backup')) continue; // 归档目录（可达数十 GB），绝不可进检查点
    const full = path.join(dir, d.name);
    if (d.isSymbolicLink()) continue; // junction/软链不跟随：防环、防误快照链接目标
    if (d.isDirectory()) {
      await walkWorkspaceForCheckpoint(full, base, out, depth + 1);
    } else if (d.isFile()) {
      fileJobs.push(full);
    }
  }
  if (!fileJobs.length) return;
  const sts = await Promise.all(fileJobs.map((f) => fs.promises.stat(f, { bigint: true }).catch(() => null)));
  for (let i = 0; i < fileJobs.length; i++) {
    if (out.files.length >= 4000) {
      out.truncated = true;
      return;
    }
    const st = sts[i];
    if (!st) {
      out.failed = (out.failed || 0) + 1;
      continue;
    }
    const size = Number(st.size);
    if (size > CHECKPOINT_FILE_MAX) {
      // R96：跳过的大文件要计数——否则用户以为整仓都进了检查点，回滚时才发现少文件
      out.skippedLarge = (out.skippedLarge || 0) + 1;
      continue;
    }
    out.bytes += size;
    if (out.bytes > CHECKPOINT_TOTAL_MAX) {
      out.truncated = true;
      return;
    }
    out.files.push({ abs: fileJobs[i], rel: path.relative(base, fileJobs[i]).split(path.sep).join('/'), size, mtimeMs: Number(st.mtimeMs), ctimeMs: Number(st.ctimeMs), mtimeNs: String(st.mtimeNs), ctimeNs: String(st.ctimeNs) });
  }
}

// R83 监工AD3：blob 回收抽成独立函数——删除会话/清理检查点后也要能回收，否则磁盘只增不减
async function gcCheckpointBlobs(force = false) {
  const now = Date.now();
  if (!force && checkpointGcAt && now - checkpointGcAt < 5 * 60 * 1000) return 0;
  checkpointGcAt = now;
  let reclaimed = 0;
  const blobDir = path.join(checkpointRootDir(), 'blobs');
  const referenced = new Set();
  for (const sid of await fs.promises.readdir(checkpointRootDir()).catch(() => [])) {
    if (sid === 'blobs') continue;
    const sdir = path.join(checkpointRootDir(), sid);
    try {
      if (!fs.existsSync(sdir) || !fs.statSync(sdir).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const f of await fs.promises.readdir(sdir).catch(() => [])) {
      if (!f.endsWith('.json')) continue;
      try {
        const m = JSON.parse(await fs.promises.readFile(path.join(sdir, f), 'utf8'));
        for (const x of m.files || []) referenced.add(x.sha);
      } catch { /* skip */ }
    }
  }
  for (const b of await fs.promises.readdir(blobDir).catch(() => [])) {
    if (referenced.has(b)) continue;
    try {
      const st = await fs.promises.stat(path.join(blobDir, b));
      if (now - st.mtimeMs < 60000) continue;
    } catch { /* stat 失败当作旧 blob */ }
    const ok = await fs.promises.rm(path.join(blobDir, b), { force: true }).then(() => true).catch(() => false);
    if (ok) reclaimed++;
  }
  return reclaimed;
}

ipcMain.handle('checkpoint:create', async (_e, { sessionId, cwd } = {}) => {
  try {
    if (!sessionId || !CHECKPOINT_SESSION_ID_RE.test(sessionId) || !cwd) {
      return { ok: false, error: '参数无效' };
    }
    const base = path.resolve(cwd);
    const walked = { files: [], bytes: 0, truncated: false };
    await walkWorkspaceForCheckpoint(base, base, walked, 0);
    // 增量：与上一份 manifest 对比，size+mtime 未变的文件复用其 sha/backup 引用
    const sessionDir = checkpointSessionDir(sessionId);
    const manifestFiles = (await fs.promises.readdir(sessionDir).catch(() => []))
      .filter((f) => f.endsWith('.json')).sort();
    const prevManifest = manifestFiles.length
      ? JSON.parse(await fs.promises.readFile(path.join(sessionDir, manifestFiles[manifestFiles.length - 1]), 'utf8').catch(() => '{}'))
      : null;
    const prevMap = new Map();
    if (prevManifest && Array.isArray(prevManifest.files)) {
      for (const f of prevManifest.files) prevMap.set(f.rel, f);
    }
    const ts = Date.now();
    const id = String(ts);
    const files = [];
    const blobDir = path.join(checkpointRootDir(), 'blobs');
    await fs.promises.mkdir(blobDir, { recursive: true }); // 灾难修复：blobs 目录必须先建
    // R99：原来逐文件串行（sha256 + copy + stat + rename），2000 文件实测 4.7 秒。
    // 改成 12 路并发池：results 按下标回填，manifest 顺序与 walked.files 一致，行为不变。
    const results = new Array(walked.files.length);
    let fileCursor = 0;
    const CP_CONCURRENCY = 12;
    const cpWorker = async () => {
      while (fileCursor < walked.files.length) {
        const idx = fileCursor++;
        const w = walked.files[idx];
        const prev = prevMap.get(w.rel);
        let sha = null;
        if (prev && sameCheckpointStamp(prev, w)) {
          sha = prev.sha; // 未变：复用上一份引用，不重复拷贝
        } else {
          // R99：合并「读一遍算 sha + 再读一遍拷贝」为「拷到临时名 → 对临时文件算 sha → 按内容命名」，
          // 每个文件少读一次；tmp 名带下标，避免同内容并发写同一 blob 时互相覆盖
          const tmp = path.join(blobDir, '.incoming-' + process.pid + '-' + idx + '-' + Date.now());
          try {
            await fs.promises.copyFile(w.abs, tmp);
            const st = await fs.promises.stat(tmp);
            if (st.size !== w.size) {
              await fs.promises.rm(tmp, { force: true }).catch(() => {});
              continue;
            }
            sha = await sha256File(tmp);
            if (!sha) {
              await fs.promises.rm(tmp, { force: true }).catch(() => {});
              continue;
            }
            const blob = checkpointBlobPath(sha);
            if (fs.existsSync(blob)) {
              await fs.promises.rm(tmp, { force: true }).catch(() => {});
            } else {
              // rename 是原子覆盖且内容相同，同 sha 并发写也安全
              await fs.promises.rename(tmp, blob);
            }
          } catch {
            await fs.promises.rm(tmp, { force: true }).catch(() => {});
            continue;
          }
        }
        results[idx] = { rel: w.rel, sha, size: w.size, mtimeMs: w.mtimeMs, ctimeMs: w.ctimeMs, mtimeNs: w.mtimeNs, ctimeNs: w.ctimeNs };
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(CP_CONCURRENCY, walked.files.length) }, cpWorker)
    );
    for (const r of results) if (r) files.push(r);
    const failedFiles = (walked.failed || 0) + (walked.files.length - files.length);
    const manifest = {
      id,
      ts,
      cwd: base,
      fileCount: files.length,
      files,
      truncated: !!walked.truncated,
      // R96：>4MB 被跳过的文件数（不进 manifest 但要能看出来）
      skippedLarge: walked.skippedLarge || 0,
      failed: failedFiles,
    };
    await fs.promises.mkdir(sessionDir, { recursive: true });
    const mf = path.join(sessionDir, id + '.json');
    await fs.promises.writeFile(mf + '.tmp', JSON.stringify(manifest), 'utf8');
    await fs.promises.rename(mf + '.tmp', mf);
    // 每会话只保留最近 N 份；全局 blob GC：删除不被任何保留 manifest 引用的 blob（限频）
    const kept = (await fs.promises.readdir(sessionDir)).filter((f) => f.endsWith('.json')).sort();
    for (const old of kept.slice(0, Math.max(0, kept.length - CHECKPOINT_KEEP_PER_SESSION))) {
      await fs.promises.rm(path.join(sessionDir, old), { force: true }).catch(() => {});
    }
    await gcCheckpointBlobs(false);
    return {
      ok: true,
      id,
      fileCount: files.length,
      total: walked.files.length,
      bytes: walked.bytes,
      truncated: !!walked.truncated,
      skippedLarge: walked.skippedLarge || 0,
      failed: failedFiles,
      reusedManifest: !!prevManifest,
    };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

ipcMain.handle('checkpoint:list', async (_e, { sessionId } = {}) => {
  try {
    if (!sessionId || !CHECKPOINT_SESSION_ID_RE.test(sessionId)) return { ok: false, items: [] };
    const sessionDir = checkpointSessionDir(sessionId);
    const out = [];
    for (const f of (await fs.promises.readdir(sessionDir).catch(() => [])).sort()) {
      if (!f.endsWith('.json')) continue;
      try {
        const m = JSON.parse(await fs.promises.readFile(path.join(sessionDir, f), 'utf8'));
        out.push({ id: m.id, ts: m.ts, fileCount: m.fileCount, bytes: (m.files || []).reduce((a, x) => a + (x.size || 0), 0), truncated: !!m.truncated, skippedLarge: m.skippedLarge || 0, failed: m.failed || 0 });
      } catch { /* skip */ }
    }
    return { ok: true, items: out.sort((a, b) => b.ts - a.ts) };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e), items: [] };
  }
});

ipcMain.handle('checkpoint:diff', async (_e, { sessionId, id, cwd } = {}) => {
  try {
    if (!sessionId || !CHECKPOINT_SESSION_ID_RE.test(sessionId) || !id || !cwd) {
      return { ok: false, error: '参数无效' };
    }
    if (!/^\d{13,14}$/.test(String(id || ''))) return { ok: false, error: '检查点 id 无效' }; // R72（监工A）：防伪造 manifest 路径穿越
    const mf = path.join(checkpointSessionDir(sessionId), String(id) + '.json');
    const manifest = JSON.parse(await fs.promises.readFile(mf, 'utf8'));
    const base = path.resolve(cwd);
    const manifestMap = new Map((manifest.files || []).map((f) => [f.rel, f]));
    const walked = { files: [], bytes: 0, truncated: false };
    await walkWorkspaceForCheckpoint(base, base, walked, 0);
    const changed = [];
    const added = [];
    const missing = [];
    const seen = new Set();
    for (const w of walked.files) {
      seen.add(w.rel);
      const m = manifestMap.get(w.rel);
      if (!m) {
        added.push(w.rel);
        continue;
      }
      if (m.size !== w.size) {
        changed.push(w.rel);
        continue;
      }
      // R99：size+mtime 与检查点记录一致 ⇒ 视为未变，不再逐个算 sha256。
      // 2000 文件实测：原来全量哈希 1172ms → 只 stat 约 100ms。判据与 create 的 blob 复用一致。
      if (sameCheckpointStamp(m, w)) continue;
      // mtime 变了才需要哈希确认（touch 过但内容没变的文件不算 changed）
      const curSha = await sha256File(w.abs);
      if (curSha !== m.sha) changed.push(w.rel);
    }
    for (const rel of manifestMap.keys()) if (!seen.has(rel)) missing.push(rel);
    return {
      ok: true,
      changed,
      added,
      missing,
      cwdMismatch: String(manifest.cwd || '') !== base, // 检查点目录与请求目录不一致（如切目录后回滚）
      manifestCwd: String(manifest.cwd || ''),
      truncated: !!walked.truncated || !!manifest.truncated,
      skippedLarge: (walked.skippedLarge || 0) + (manifest.skippedLarge || 0),
      failed: (walked.failed || 0) + (manifest.failed || 0),
    };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

ipcMain.handle('checkpoint:restore', async (_e, { sessionId, id, cwd, deleteAdded } = {}) => {
  try {
    if (!sessionId || !CHECKPOINT_SESSION_ID_RE.test(sessionId) || !id || !cwd) {
      return { ok: false, error: '参数无效' };
    }
    if (!/^\d{13,14}$/.test(String(id || ''))) return { ok: false, error: '检查点 id 无效' }; // R72（监工A）：防伪造 manifest 路径穿越
    const mf = path.join(checkpointSessionDir(sessionId), String(id) + '.json');
    const manifest = JSON.parse(await fs.promises.readFile(mf, 'utf8'));
    // 灾难守卫：空 manifest + deleteAdded 会把整个工作区当「新增」全部删除（r49 事故）
    if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
      return { ok: false, error: '检查点为空，拒绝恢复（避免误删工作区文件）' };
    }
    const base = path.resolve(cwd);
    // R72（监工A）：恢复前校验目录一致性——切目录后直接恢复会把旧项目文件写入新工作区
    // （isInside 只保证不越出新目录，删/写集合本身是错的）。与 checkpoint:diff 的 cwdMismatch 同口径。
    if (String(manifest.cwd || '') !== base) {
      return {
        ok: false,
        error: '检查点来自其他工作目录（' + String(manifest.cwd || '') + '），请在对应目录下恢复或先查看差异确认',
        cwdMismatch: true,
        manifestCwd: String(manifest.cwd || ''),
      };
    }
    await fs.promises.mkdir(base, { recursive: true });
    const realBase = await fs.promises.realpath(base);
    let restored = 0;
    const failed = [];
    const skipped = [];
    const manifestMap = new Map((manifest.files || []).map((f) => [f.rel, f]));
    // 回滚每个检查点内文件到快照内容
    // R99：8 路并发（每个 rel 的 tmp 名唯一，互不干扰）；100 个待还原文件实测 619ms → 并发后明显下降
    const restoreJobs = [...manifestMap.entries()];
    let restoreCursor = 0;
    const restoreWorker = async () => {
      while (restoreCursor < restoreJobs.length) {
        const [rel, f] = restoreJobs[restoreCursor++];
      const target = path.resolve(base, rel);
      if (!isInside(base, target)) { failed.push(rel); continue; }
      const realTarget = await realPathOfDeepestExisting(base, target);
      if (!realTarget || !isInside(realBase, realTarget)) { failed.push(rel); continue; }
      const blob = checkpointBlobPath(f.sha);
      if (!fs.existsSync(blob)) {
        skipped.push(rel); // R83 监工AD2：blob 缺失不再静默跳过，交给调用方提示「未恢复」
        continue;
      }
      let curSha = null;
      try {
        const st = await fs.promises.stat(blob);
        if (typeof f.size === 'number' && st.size !== f.size) {
          failed.push(rel); // R83 监工AD2：blob 大小与 manifest 不符=坏 blob，拒绝写坏内容
          continue;
        }
        // R99：工作区文件 size+mtime 与检查点一致 ⇒ 已经在检查点状态，不必哈希也不必回写。
        // 2000 文件实测：原来全量哈希 2146ms → 只 stat 约 200ms（真正要改的才哈希+写）。
        const stCur = await fs.promises.stat(target, { bigint: true }).catch(() => null);
        if (stCur && sameCheckpointStamp(f, stCur)) {
          continue;
        }
        curSha = await sha256File(target).catch(() => null);
      } catch {
        failed.push(rel);
        continue;
      }
      if (curSha === f.sha) continue; // 已是检查点状态
      // R83 监工AD2：写临时名 + rename——避免半截写覆盖工作区源文件
      const tmp = target + '.qcp-tmp';
      try {
        await fs.promises.mkdir(path.dirname(target), { recursive: true });
        await fs.promises.copyFile(blob, tmp);
        await fs.promises.rename(tmp, target);
        restored++;
      } catch {
        failed.push(rel);
        await fs.promises.rm(tmp, { force: true }).catch(() => {});
      }
      }
    };
    await Promise.all(Array.from({ length: Math.min(8, restoreJobs.length) }, restoreWorker));
    let deleted = 0;
    // R83 监工AD9：create 侧 walk 有 4000 文件/96MB/深度 14 上限，manifest 可能不完整——
    // 若工作区在检查点时刻被截断，就绝不允许「删除新增文件」（否则漏进的旧文件会被当新增删掉）
    if (deleteAdded && (manifest.truncated || manifest.skippedLarge || manifest.failed)) {
      return {
        ok: false,
        error: '该检查点不完整（截断、跳过大文件或复制失败），拒绝删除新增文件',
        incomplete: true,
        restored,
        deleted: 0,
        failed,
        skipped,
      };
    }
    if (deleteAdded) {
      // 删除检查点之后新增的文件（用户可勾选；默认保留）。
      // 双重安全：1) 只删 manifest 中没有的文件；2) 只删 mtime ≥ 检查点时间的文件——
      // 即使 walk 因 caps 部分中止漏掉预存在文件，也不会把老文件当「新增」误删（r49 事故教训）。
      const walked = { files: [], bytes: 0, truncated: false };
      await walkWorkspaceForCheckpoint(base, base, walked, 0);
      for (const w of walked.files) {
        if (!manifestMap.has(w.rel) && w.mtimeMs >= manifest.ts) {
          const target = path.resolve(base, w.rel);
          const realTarget = await realPathOfDeepestExisting(base, target);
          if (isInside(base, target) && realTarget && isInside(realBase, realTarget)) {
            try {
              await fs.promises.rm(target, { force: true });
              deleted++;
            } catch {
              failed.push(w.rel);
            }
          }
        }
      }
    }
    invalidateFsSearchInventory(base);
    const ok = failed.length === 0 && skipped.length === 0;
    return { ok, partial: !ok, restored, deleted, failed, skipped };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

ipcMain.handle('checkpoint:deleteAll', async (_e, { sessionId } = {}) => {
  try {
    if (!sessionId || !CHECKPOINT_SESSION_ID_RE.test(sessionId)) return { ok: false, error: '参数无效' };
    const agent = agents.get(sessionId);
    if (agent && agent.busy) return { ok: false, error: '会话正在执行中，暂时不能清理检查点' };
    await fs.promises.rm(checkpointSessionDir(sessionId), { recursive: true, force: true });
    const reclaimed = await gcCheckpointBlobs(true).catch(() => 0);
    return { ok: true, reclaimed };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

// 读取某文件在检查点中的快照内容（blob 内容寻址，rel 仅作 manifest 键、不落 fs 路径）
ipcMain.handle('checkpoint:readVersion', async (_e, { sessionId, id, rel } = {}) => {
  try {
    const rs = String(rel || '');
    if (!sessionId || !CHECKPOINT_SESSION_ID_RE.test(sessionId) || !id || !rs ||
        rs.includes('..') || path.isAbsolute(rs)) {
      return { ok: false, error: '参数无效' };
    }
    if (!/^\d{13,14}$/.test(String(id || ''))) return { ok: false, error: '检查点 id 无效' }; // R72（监工A）：防伪造 manifest 路径穿越
    const mf = path.join(checkpointSessionDir(sessionId), String(id) + '.json');
    const manifest = JSON.parse(await fs.promises.readFile(mf, 'utf8'));
    const f = (manifest.files || []).find((x) => x.rel === rs);
    if (!f) return { ok: false, error: '文件不在该检查点内' };
    const blob = checkpointBlobPath(f.sha);
    if (!fs.existsSync(blob)) return { ok: false, error: '快照内容已不存在' };
    const content = await fs.promises.readFile(blob, 'utf8');
    return { ok: true, content };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});


async function dirSize(dir, depth = 0) {
  let total = 0;
  if (depth > 4) return total;
  let items;
  try {
    items = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return total;
  }
  for (const d of items) {
    const full = path.join(dir, d.name);
    try {
      if (d.isDirectory()) total += await dirSize(full, depth + 1);
      else total += (await fs.promises.stat(full)).size;
    } catch {
      /* 跳过不可读项 */
    }
  }
  return total;
}

ipcMain.handle('storage:stats', async () => {
  const shotDir = path.join(WRITABLE_DIR, "shots");
  let sessionFiles = 0;
  try {
    sessionFiles = (await fs.promises.readdir(DATA_DIR)).filter((f) => f.endsWith(".json")).length;
  } catch {
    sessionFiles = 0;
  }
  let logBytes = 0;
  try {
    logBytes = (await fs.promises.stat(LOG_FILE)).size;
  } catch {
    logBytes = 0;
  }
  const dataBytes = await dirSize(DATA_DIR);
  const trashBytes = await dirSize(TRASH_DIR);
  const sessionsBytes = Math.max(0, dataBytes - trashBytes);
  const backupBytes = await dirSize(BACKUP_DIR);
  const checkpointBytes = await dirSize(checkpointRootDir());
  const shotBytes = await dirSize(shotDir);
  return {
    sessions: sessionFiles,
    sessionsBytes,
    trashBytes,
    backupBytes,
    checkpointBytes,
    logBytes,
    shotBytes,
    totalBytes: sessionsBytes + trashBytes + backupBytes + checkpointBytes + logBytes + shotBytes,
    userData: app.getPath("userData"),
  };
});

ipcMain.handle('usage:get', async (_e, range) => aggregateUsage(range === 'today' || range === '7d' ? range : 'all'));

let fsSearchSeq = 0;
// 递归目录清单缓存：同 root 的连续查询（输入过程中反复改查询词）不再重复遍历整棵树
const fsSearchInventory = new Map(); // root -> { at, entries: [{name, rel, dir}] }
const FS_SEARCH_INVENTORY_ROOTS = 8; // R80 监工Y：防搜索过大量 root 后常驻数万条目
const FS_SEARCH_TTL = 15000;
let fsSearchWalks = 0; // 实际遍历次数（冒烟断言：重复查询应命中缓存）

ipcMain.handle('fs:search', async (_e, { root, query } = {}) => {
  const base = path.resolve(root || os.homedir());
  const q = String(query || '').toLowerCase();
  if (!q) return { ok: true, entries: [] };
  const seq = ++fsSearchSeq;
  const SKIP = new Set(['node_modules', 'dist', 'build', '__pycache__', 'target']);
  // 命中缓存：内存过滤，最多 60 条（与遍历路径上限一致）
  const cached = fsSearchInventory.get(base);
  if (cached && Date.now() - cached.at < FS_SEARCH_TTL) {
    const out = [];
    for (const e of cached.entries) {
      if ((e.lname || e.name.toLowerCase()).includes(q)) {
        out.push(e);
        if (out.length >= 60) break;
      }
    }
    return { ok: true, entries: out, cached: true, complete: !cached.partial, partial: !!cached.partial, reason: cached.reason || '' };
  }
  fsSearchWalks++;
  const inventory = [];
  const results = [];
  let scanned = 0;
  let complete = true; // 是否完整走完（未因结果上限/扫描上限提前退出）
  let partialReason = '';
  // 异步逐目录遍历：旧实现 readdirSync 递归会把主进程锁住，输入时整个窗口卡顿；
  // seq 让快速连续输入只保留最后一次搜索，旧请求在下一个目录边界退出。
  const walk = async (dir, depth) => {
    if (seq !== fsSearchSeq) return;
    if (depth > 5 || scanned > 4000 || results.length >= 60) {
      if (depth > 5) { complete = false; partialReason = 'depth-limit'; }
      else if (scanned > 4000) { complete = false; partialReason = 'scan-limit'; }
      else { complete = false; partialReason = 'result-limit'; }
      return;
    }
    let items;
    try {
      items = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      complete = false;
      partialReason = 'read-error';
      return;
    }
    for (const d of items) {
      if (seq !== fsSearchSeq) return;
      if (d.name.startsWith('.') || SKIP.has(d.name) || d.isSymbolicLink()) continue;
      if (++scanned > 4000) { complete = false; partialReason = 'scan-limit'; return; }
      const full = path.join(dir, d.name);
      const rel = path.relative(base, full).split(path.sep).join('/');
      // 预存小写名：缓存命中后每次按键都要对全部条目 toLowerCase，改为构建时算一次（1.9x）
      const lname = d.name.toLowerCase();
      const item = { name: d.name, rel, dir: d.isDirectory(), lname };
      if (inventory.length < 4000) inventory.push(item);
      if (lname.includes(q)) {
        results.push(item);
        if (results.length >= 60) { complete = false; partialReason = 'result-limit'; return; }
      }
      if (d.isDirectory()) {
        await walk(full, depth + 1);
        if (seq !== fsSearchSeq) return;
      }
    }
  };
  await walk(base, 0);
  // R76 监工O：父层循环可能在子 walk return 后继续 push——统一截断到 60
  if (results.length > 60) results.length = 60;
  // 未被取消即缓存清单：命中扫描上限时 fresh 搜索本身也只返回部分结果，缓存同口径；
  // TTL 15s + 写文件失效保证不会长期陈旧。
  if (seq === fsSearchSeq && inventory.length > 0) {
    fsSearchInventory.set(base, { at: Date.now(), entries: inventory, partial: !complete, reason: partialReason });
    if (fsSearchInventory.size > FS_SEARCH_INVENTORY_ROOTS) fsSearchInventory.delete(fsSearchInventory.keys().next().value);
  }
  return {
    ok: true,
    entries: seq === fsSearchSeq ? results : [],
    canceled: seq !== fsSearchSeq,
    complete,
    partial: !complete,
    reason: partialReason,
  };
});

// 工作区文件变化后使搜索清单失效（写文件/删目录等主进程操作处调用）
function invalidateFsSearchInventory(root) {
  if (!root) { fsSearchInventory.clear(); fsListCache.clear(); return; }
  fsSearchInventory.delete(path.resolve(root));
  // 目录清单也含子目录条目：任写操作都可能改变任意已缓存目录，整表清空（≤200 项）
  fsListCache.clear();
}

const HOOKS_FILE = path.join(QWEN_DIR, 'hooks', 'hooks.json');

ipcMain.handle('hooks:get', () => {
  try {
    return { ok: true, path: HOOKS_FILE, content: fs.readFileSync(HOOKS_FILE, 'utf8'), error: null };
  } catch (e) {
    if (e && e.code === 'ENOENT') return { ok: true, path: HOOKS_FILE, content: '', error: null };
    return { ok: false, path: HOOKS_FILE, content: '', error: String((e && e.message) || e) };
  }
});

ipcMain.handle('hooks:save', (_e, content) => {
  try {
    if (fs.existsSync(HOOKS_FILE)) {
      try { fs.readFileSync(HOOKS_FILE, 'utf8'); }
      catch (e) { return { ok: false, error: '现有 hooks.json 读取失败，拒绝覆盖：' + String((e && e.message) || e) }; }
    }
    const hooksText = String(content == null ? '' : content).trim();
    let parsed = {};
    if (hooksText) {
      try { parsed = JSON.parse(hooksText); }
      catch (e) { return { ok: false, error: 'JSON 格式错误：' + String((e && e.message) || e) }; }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, error: 'hooks.json 顶层必须是对象' };
    }
    fs.mkdirSync(path.dirname(HOOKS_FILE), { recursive: true });
    try {
      if (fs.existsSync(HOOKS_FILE)) fs.copyFileSync(HOOKS_FILE, HOOKS_FILE + '.bak');
    } catch {
      /* ignore */
    }
    fs.writeFileSync(HOOKS_FILE, hooksText || '{}', 'utf8');
    // 钩子在内核启动时装载，改完重启进程使其生效
    stopAgentsForSettings('Hooks 已更新');
    return { ok: true, path: HOOKS_FILE };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

// R74 监工I：对话框默认文件名净化——统一处理正反斜杠与首尾点空格
// 用 String.fromCharCode 构造字符类，避免脚本插入时的反斜杠转义吞字符
function sanitizeDefaultName(name) {
  const bad = new RegExp('[' + String.fromCharCode(92) + '/:*?"<>|]', 'g');
  const edge = new RegExp('^[ ' + String.fromCharCode(46) + ']+|[ ' + String.fromCharCode(46) + ']+$', 'g');
  return String(name || '').replace(bad, '_').replace(edge, '') || 'export.txt';
}

ipcMain.handle('file:save-text', async (_e, { title, defaultName, content, filters, inlineAttachments } = {}) => {
  try {
    const res = await dialog.showSaveDialog(mainWindow, {
      title: title || '保存文件',
      // R74 监工I：净化默认文件名（防 .. 越出 home 目录）
      defaultPath: path.join(os.homedir(), sanitizeDefaultName(defaultName || 'export.txt')),
      filters: Array.isArray(filters) && filters.length ? filters : [{ name: 'Text', extensions: ['txt'] }],
    });
    if (res.canceled || !res.filePath) return { ok: false, canceled: true };
    // R122：HTML 导出用同一套附件内联（带目录边界校验）；普通文本不受影响
    const text = inlineAttachments ? inlineAttachImages(content) : String(content == null ? '' : content);
    fs.writeFileSync(res.filePath, text, 'utf8');
    return { ok: true, path: res.filePath };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

function tailText(file, lineCount) {
  try {
    const st = fs.statSync(file);
    if (!st.size) return '';
    const start = Math.max(0, st.size - 128 * 1024);
    const len = st.size - start;
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split(/\r?\n/);
    if (start > 0) lines.shift();
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    return lines.slice(-(lineCount || 200)).join(String.fromCharCode(10));
  } catch {
    return '';
  }
}

// R88：渲染进程真实内存读数（performance.memory 粗粒度、不随 GC 及时刷新）——
// 通过既有 perf 通道取，避免为基准测试新增 IPC 面。单位换算成 MB。
function rendererMemMb() {
  try {
    const pid = mainWindow && mainWindow.webContents ? mainWindow.webContents.getOSProcessId() : 0;
    const metric = app.getAppMetrics().find((x) => x.pid === pid);
    if (!metric || !metric.memory) return null;
    return {
      privateMb: +(metric.memory.privateBytes / 1024).toFixed(1),
      workingMb: +(metric.memory.workingSetSize / 1024).toFixed(1),
    };
  } catch {
    return null;
  }
}

ipcMain.handle('perf:log', (_e, label, value) => {
  // 基准专用：label='bench-mem' 时直接回渲染进程内存快照（不写日志）
  if (label === 'bench-mem') return rendererMemMb();
  const line = `${String(label || 'metric')}=${value == null ? '' : value}`;
  log('perf', line);
  console.log('[smoke] perf:', line);
  return { ok: true };
});

ipcMain.handle('log:info', () => {
  let size = 0;
  try {
    size = fs.statSync(LOG_FILE).size;
  } catch {
    size = 0;
  }
  const rot = LOG_FILE + '.1';
  let rotSize = 0;
  try {
    rotSize = fs.statSync(rot).size;
  } catch {
    rotSize = 0;
  }
  return {
    ok: true,
    path: LOG_FILE,
    dir: WRITABLE_DIR,
    size,
    rotated: rotSize > 0 ? { path: rot, size: rotSize } : null,
    tail: tailText(LOG_FILE, 200),
  };
});

ipcMain.handle('file:restore-bak', (_e, target) => {
  try {
    if (!target) return { ok: false, error: '缺少目标路径' };
    // R79 监工V：限制恢复目标为已知配置文件（防任意 .bak 覆盖）
    const allowed = [
      QWEN_SETTINGS,
      path.join(QWEN_DIR, 'memories', 'MEMORY.md'),
      path.join(QWEN_DIR, 'MEMORY.md'), // 兼容旧版本
      HOOKS_FILE,
    ].map((p) => path.resolve(p));
    const resolved = path.resolve(String(target));
    if (!allowed.includes(resolved)) return { ok: false, error: '目标路径不在允许范围内' };
    const bak = target + ".bak";
    if (!fs.existsSync(bak)) return { ok: false, error: "没有 .bak 备份" };
    // R77 监工Q：原子写——copyFileSync 中断会让目标半写损坏（与 writePrefs 同口径）
    const tmp = target + ".restore-tmp";
    fs.copyFileSync(bak, tmp);
    fs.renameSync(tmp, target);
    return { ok: true, bak };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

ipcMain.handle('file:open-text', async (_e, { title, filters } = {}) => {
  try {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: title || '打开文件',
      filters: Array.isArray(filters) && filters.length ? filters : [{ name: 'Text', extensions: ['txt'] }],
      properties: ['openFile'],
    });
    if (res.canceled || !res.filePaths || !res.filePaths[0]) return { ok: false, canceled: true };
    const file = res.filePaths[0];
    return { ok: true, path: file, content: fs.readFileSync(file, "utf8") };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

const EXPORT_TEXT_MAX = 64 * 1024 * 1024;
const EXPORT_HTML_MAX = 32 * 1024 * 1024;
const INLINE_ATTACH_TOTAL_MAX = 64 * 1024 * 1024;
const PDF_INLINE_HTML_MAX = 128 * 1024 * 1024;
let pdfExportActive = false;

function exportPayloadError(value, max, label) {
  if (typeof value !== 'string') return label + '内容无效';
  if (Buffer.byteLength(value, 'utf8') > max) return label + '超过大小上限';
  return '';
}

ipcMain.handle('session:export', async (_e, { title, content } = {}) => {
  try {
    const invalid = exportPayloadError(content, EXPORT_TEXT_MAX, 'Markdown');
    if (invalid) return { ok: false, error: invalid };
    const safeName = sanitizeDefaultName(String(title || '会话').slice(0, 60)) || '会话'; // R79 监工V：复用统一净化（含反斜杠）
    const res = await dialog.showSaveDialog(mainWindow, {
      title: '导出会话为 Markdown',
      defaultPath: path.join(os.homedir(), safeName + '.md'),
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    });
    if (res.canceled || !res.filePath) return { ok: false, canceled: true };
    fs.writeFileSync(res.filePath, content, 'utf8');
    return { ok: true, path: res.filePath };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

// R121：导出为 PDF——渲染层生成打印版 HTML，这里用隐藏窗口 + Chromium printToPDF 出真 PDF。
// 隐藏窗口用完即销毁；HTML 自带 CSP（禁脚本），避免把对话内容当代码执行。
// R121b：把渲染层留下的附件占位（data-attach-path，值为路径的 base64）替换成 data URL，
// 这样 PDF/HTML 里能真正看到图片，同时不需要在渲染层读文件。
function inlineAttachImages(html) {
  let total = 0;
  return String(html || '').replace(/<img\b[^>]*\bdata-attach-path="([^"]*)"[^>]*>/g, (tag, b64) => {
    try {
      const file = Buffer.from(String(b64), 'base64').toString('utf8');
      // R122：附件只允许来自应用自己的附件目录。导入 JSON 里的 attachments.path 是用户可编辑数据，
      // 若不校验，导出 PDF/HTML 时可能把任意本地文件（甚至非图片）读进导出物。
      if (!isInside(ATTACH_DIR, file)) return tag.replace('data-attach-path=', 'data-missing=');
      const ext = path.extname(file).toLowerCase();
      if (!['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(ext)) {
        return tag.replace('data-attach-path=', 'data-missing=');
      }
      const real = fs.realpathSync(file);
      if (!isInside(ATTACH_DIR, real)) return tag.replace('data-attach-path=', 'data-missing=');
      const st = fs.statSync(real);
      if (!st.isFile() || st.size > 20 * 1024 * 1024 || total + st.size > INLINE_ATTACH_TOTAL_MAX) {
        return tag.replace('data-attach-path=', 'data-missing=');
      }
      const fd = fs.openSync(real, 'r');
      let buf;
      try {
        buf = Buffer.alloc(st.size);
        const read = fs.readSync(fd, buf, 0, buf.length, 0);
        if (read !== st.size) return tag.replace('data-attach-path=', 'data-missing=');
      } finally {
        fs.closeSync(fd);
      }
      total += buf.length;
      const mime =
        ext === '.jpg' || ext === '.jpeg'
          ? 'image/jpeg'
          : ext === '.webp'
            ? 'image/webp'
            : ext === '.gif'
              ? 'image/gif'
              : 'image/png';
      const src = 'data:' + mime + ';base64,' + buf.toString('base64');
      // 保留原有 class/alt，去掉占位属性并补 src
      return tag.replace(/\sdata-attach-path="[^"]*"/, ' src="' + src + '"');
    } catch (e) {
      return tag.replace('data-attach-path=', 'data-missing=');
    }
  });
}

async function htmlToPdfBuffer(html, opts) {
  if (pdfExportActive) return { ok: false, error: '已有 PDF 导出正在进行，请稍候' };
  const invalid = exportPayloadError(html, EXPORT_HTML_MAX, 'HTML');
  if (invalid) return { ok: false, error: invalid };
  pdfExportActive = true;
  const tmp = path.join(os.tmpdir(), 'qcode-print-' + process.pid + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.html');
  let win = null;
  let timer = null;
  const wantFooter = !(opts && opts.footer === false);
  try {
    const inlined = inlineAttachImages(html);
    if (Buffer.byteLength(inlined, 'utf8') > PDF_INLINE_HTML_MAX) return { ok: false, error: '内联附件后的 HTML 超过 128MB 上限' };
    fs.writeFileSync(tmp, inlined, 'utf8');
    win = new BrowserWindow({
      show: false,
      width: 900,
      height: 1200,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    await Promise.race([
      win.loadFile(tmp),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('PDF 页面加载超时')), 60000); }),
    ]);
    clearTimeout(timer);
    timer = null;
    // 稍等一帧，让字体与布局稳定（printToPDF 不会等待图片/字体加载完成）
    await new Promise((r) => setTimeout(r, 120));
    const buf = await Promise.race([
      win.webContents.printToPDF({
      printBackground: true,
      pageSize: 'A4',
      displayHeaderFooter: wantFooter,
      headerTemplate: '<div></div>',
      // R121b：页脚带页码——长会话打印/分享时能对得上页
      footerTemplate: wantFooter
        ? '<div style="width:100%;font-size:8px;color:#9a9a94;padding:0 0.6in;display:flex;justify-content:space-between;">' +
          '<span>Qcode</span><span>第 <span class="pageNumber"></span> / <span class="totalPages"></span> 页</span></div>'
        : '<div></div>',
      margins: { top: 0.6, bottom: wantFooter ? 0.75 : 0.6, left: 0.6, right: 0.6 },
      preferCSSPageSize: false,
      }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('PDF 渲染超时')), 60000); }),
    ]);
    clearTimeout(timer);
    timer = null;
    return { ok: true, buffer: buf };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  } finally {
    clearTimeout(timer);
    pdfExportActive = false;
    if (win && !win.isDestroyed()) win.destroy();
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
  }
}

ipcMain.handle('session:exportPdf', async (_e, { title, html } = {}) => {
  try {
    const invalid = exportPayloadError(html, EXPORT_HTML_MAX, 'HTML');
    if (invalid) return { ok: false, error: invalid };
    if (pdfExportActive) return { ok: false, error: '已有 PDF 导出正在进行，请稍候' };
    const safeName = sanitizeDefaultName(String(title || '会话').slice(0, 60)) || '会话';
    const res = await dialog.showSaveDialog(mainWindow, {
      title: '导出会话为 PDF',
      defaultPath: path.join(os.homedir(), safeName + '.pdf'),
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (res.canceled || !res.filePath) return { ok: false, canceled: true };
    const out = await htmlToPdfBuffer(html);
    if (!out.ok) return { ok: false, error: out.error };
    fs.writeFileSync(res.filePath, out.buffer);
    return { ok: true, path: res.filePath, bytes: out.buffer.length };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

ipcMain.handle('extensions:set', (_e, { name, enabled } = {}) => {
  if (!name) return { ok: false, error: '缺少扩展名' };
  try {
    const file = path.join(EXT_DIR, 'extension-enablement.json');
    const next = { ...readJsonFile(file, {}), [name]: !!enabled };
    fs.mkdirSync(EXT_DIR, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(next, null, 2), 'utf8');
    // 内核在启动时读取启用表，改完重启进程使其生效
    stopAgentsForSettings('扩展设置已更新');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

ipcMain.handle('app:openPath', async (_e, target) => {
  try {
    const err = await shell.openPath(target);
    return { ok: !err, error: err || null };
  } catch (e) {
    return { ok: false, error: String(e && e.message) };
  }
});

/* ---------------- Qwen 配置读写 ---------------- */

function qwenSettingsReadError() {
  if (!fs.existsSync(QWEN_SETTINGS)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(QWEN_SETTINGS, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'settings.json 顶层不是对象';
    return null;
  } catch (e) {
    return String((e && e.message) || e);
  }
}

function readQwenSettings() {
  const fallback = {
    modelProviders: { openai: [] },
    env: {},
    security: { auth: { selectedType: 'openai' } },
    model: { name: '' },
  };
  try {
    const parsed = JSON.parse(fs.readFileSync(QWEN_SETTINGS, "utf8"));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    return fallback;
  } catch {
    return fallback;
  }
}

function maskSecret(value) {
  const v = String(value == null ? '' : value);
  if (!v || /^\{\{SECRET_[^}]+\}\}$/.test(v)) return v;
  if (v.length <= 8) return '••••';
  return v.slice(0, 3) + '***' + v.slice(-2);
}

function redactedConfig(config, includeKeys) {
  const clone = JSON.parse(JSON.stringify(config || {}));
  if (includeKeys) return clone;
  const sensitiveKey = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|client[_-]?secret|secret|password|passwd|authorization|credential|private[_-]?key|cookie)/i;
  const walk = (value, key = '') => {
    if (Array.isArray(value)) return value.map((v) => walk(v, key));
    if (!value || typeof value !== 'object') return value;
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (k.toLowerCase() === 'env' && v && typeof v === 'object' && !Array.isArray(v)) {
        out[k] = {};
        for (const [ek, ev] of Object.entries(v)) out[k][ek] = typeof ev === 'string' ? maskSecret(ev) : walk(ev, ek);
      } else if (sensitiveKey.test(k) && typeof v === 'string') {
        out[k] = maskSecret(v);
      } else if (typeof v === 'string') {
        out[k] = redactSecrets(v);
      } else {
        out[k] = walk(v, k);
      }
    }
    return out;
  };
  return walk(clone);
}

function validateQwenSettings(config) {
  const warnings = [];
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return ['settings.json 顶层必须是对象'];
  }
  const providers = config.modelProviders;
  if (!providers || typeof providers !== 'object' || Array.isArray(providers)) {
    warnings.push('modelProviders 缺失或格式不正确');
  } else if (!Array.isArray(providers.openai)) {
    warnings.push('modelProviders.openai 应为数组');
  } else {
    providers.openai.forEach((p, i) => {
      if (!p || typeof p !== 'object') {
        warnings.push(`第 ${i + 1} 个供应商不是对象`);
        return;
      }
      if (!p.id || typeof p.id !== 'string') warnings.push(`第 ${i + 1} 个供应商缺少模型 ID`);
      if (!p.baseUrl || !/^https?:\/\//.test(String(p.baseUrl))) {
        warnings.push(`第 ${i + 1} 个供应商 Base URL 无效`);
      }
      if (!p.envKey || typeof p.envKey !== 'string') {
        warnings.push(`第 ${i + 1} 个供应商缺少 envKey`);
      }
    });
  }
  if (!config.env || typeof config.env !== 'object' || Array.isArray(config.env)) {
    warnings.push('env 缺失或不是对象');
  }
  const authType = config.security && config.security.auth && config.security.auth.selectedType;
  if (authType && authType !== 'openai') {
    warnings.push('security.auth.selectedType 建议为 openai');
  }
  const modelName = config.model && config.model.name;
  if (modelName && Array.isArray(providers && providers.openai)) {
    if (!providers.openai.some((p) => p && p.id === modelName)) {
      warnings.push('默认模型不在 modelProviders.openai 列表中');
    }
  }
  return warnings;
}

function writeQwenSettings(config) {
  fs.mkdirSync(QWEN_DIR, { recursive: true });
  const tmp = QWEN_SETTINGS + '.tmp';
  // 覆盖前留一份上一版，配置写坏时可手工回滚
  try {
    if (fs.existsSync(QWEN_SETTINGS)) fs.copyFileSync(QWEN_SETTINGS, QWEN_SETTINGS + '.bak');
  } catch {
    /* 备份失败不阻断保存 */
  }
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), 'utf8');
  fs.renameSync(tmp, QWEN_SETTINGS);
}

ipcMain.handle('config:get', () => {
  const config = readQwenSettings();
  const readError = qwenSettingsReadError();
  return { path: QWEN_SETTINGS, config, warnings: validateQwenSettings(config), readError };
});
ipcMain.handle('config:validate', (_e, config) => ({
  ok: true,
  warnings: validateQwenSettings(config),
}));

ipcMain.handle('config:save', (_e, config) => {
  try {
    if (!config || typeof config !== 'object' || Array.isArray(config)) return { ok: false, error: '配置必须是对象' };
    const readError = qwenSettingsReadError();
    if (readError) return { ok: false, error: 'settings.json 读取失败，拒绝覆盖：' + readError };
    writeQwenSettings(config);
    // 配置变了，已起的内核进程必须重启才能生效
    stopAgentsForSettings('配置已更新');
    return { ok: true, path: QWEN_SETTINGS, warnings: validateQwenSettings(config) };
  } catch (e) {
    return { ok: false, error: String(e && e.message) };
  }
});

ipcMain.handle('config:export', async (_e, opts = {}) => {
  try {
    const includeKeys = !!(opts && opts.includeKeys);
    const res = await dialog.showSaveDialog(mainWindow, {
      title: '导出 qwen 配置',
      defaultPath: path.join(os.homedir(), includeKeys ? 'qwen-settings.json' : 'qwen-settings-redacted.json'),
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (res.canceled || !res.filePath) return { ok: false, canceled: true };
    fs.writeFileSync(
      res.filePath,
      JSON.stringify(redactedConfig(readQwenSettings(), includeKeys), null, 2),
      'utf8'
    );
    return { ok: true, path: res.filePath, includeKeys };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

ipcMain.handle('config:redactionSelfTest', () => {
  const sample = { env: { API_KEY: 'sk-' + 'd'.repeat(32) } };
  const safe = redactedConfig(sample, false);
  return {
    ok: true,
    masked: safe.env.API_KEY !== sample.env.API_KEY && safe.env.API_KEY.includes('***'),
    value: safe.env.API_KEY,
  };
});

ipcMain.handle('config:exportPreview', (_e, opts = {}) => {
  const includeKeys = !!(opts && opts.includeKeys);
  return {
    ok: true,
    includeKeys,
    content: JSON.stringify(redactedConfig(readQwenSettings(), includeKeys), null, 2),
  };
});

ipcMain.handle('config:import', async () => {
  try {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: '导入 qwen 配置',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile'],
    });
    if (res.canceled || !res.filePaths || !res.filePaths[0]) return { ok: false, canceled: true };
    const parsed = JSON.parse(fs.readFileSync(res.filePaths[0], "utf8"));
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: '配置必须是 JSON 对象' };
    }
    const envValues = parsed.env && typeof parsed.env === 'object' ? Object.values(parsed.env) : [];
    if (envValues.some((v) => typeof v === 'string' && (v.includes('***') || v.includes('••••')))) {
      return { ok: false, error: '检测到脱敏占位符，请导入含完整密钥的配置或手动填写' };
    }
    writeQwenSettings(parsed);
    stopAgentsForSettings('配置已导入');
    // R74 监工H：与 config:save 同口径——导入后跑结构校验，warnings 随返回值给渲染层展示
    let warnings = [];
    try {
      // R83 监工AD4：validateQwenSettings 返回数组（原代码读 v.warnings 恒为空，R74 修复实际未生效）
      const v = validateQwenSettings(parsed);
      warnings = Array.isArray(v) ? v : [];
    } catch { /* 校验失败不阻断导入 */ }
    return { ok: true, path: res.filePaths[0], warnings };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

function normalizeIp(host) {
  let h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  if (h.startsWith('::ffff:')) {
    const tail = h.slice(7);
    if (tail.includes('.')) h = tail;
    else {
      const parts = tail.split(':');
      if (parts.length === 2 && /^[0-9a-f]{1,4}$/.test(parts[0]) && /^[0-9a-f]{1,4}$/.test(parts[1])) {
        const a = parseInt(parts[0], 16), b = parseInt(parts[1], 16);
        h = [a >> 8, a & 255, b >> 8, b & 255].join('.');
      }
    }
  }
  return h;
}
function isPrivateIp(host) {
  const h = normalizeIp(host);
  if (/^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h)) return true;
  return /^f[cd]/.test(h);
}
function isAlwaysBlockedIp(host) {
  const h = normalizeIp(host);
  return /^(169\.254\.|127\.|0\.|::1$|::$)/.test(h) || /^fe[89ab]/.test(h);
}

// R79/R219：端点测试统一私网策略；域名解析结果也参与判断，防 DNS 绕过元数据/私网。
async function isSafeTestEndpoint(rawUrl, allowPrivate = false) {
  try {
    const u = new URL(String(rawUrl || ''));
    if (!['http:', 'https:'].includes(u.protocol)) return false;
    const host = (u.hostname || '').toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]') return true;
    if (isAlwaysBlockedIp(host)) return false;
    if (isPrivateIp(host)) return allowPrivate === true;
    let records;
    try {
      records = await dns.promises.lookup(host, { all: true, verbatim: true });
    } catch {
      return true; // 解析失败交给 fetch 报错，不存在可连接目标
    }
    for (const r of records) {
      if (isAlwaysBlockedIp(r.address)) return false;
      if (isPrivateIp(r.address) && allowPrivate !== true) return false;
    }
    return true;
  } catch { return false; }
}
let configModelTestRequests = 0;

ipcMain.handle('config:test-model', async (_e, { baseUrl, apiKey, modelId, allowPrivate } = {}) => {
  configModelTestRequests++;
  if (!baseUrl) return { ok: false, error: 'Base URL 为空' };
  if (!await isSafeTestEndpoint(baseUrl, allowPrivate)) return { ok: false, error: '端点地址不安全（私网需显式允许，链路本地/元数据地址始终拒绝）' }; // R79/R219
  if (!modelId) return { ok: false, error: '模型 ID 为空' };
  const url = baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: 'user', content: 'Reply with the single word: OK' }],
        max_tokens: 64,
        temperature: 0,
        stream: false,
      }),
      signal: AbortSignal.timeout(30000),
      redirect: 'error',
    });
    // R81 监工AB：响应体大小上限（防恶意端点 10MB+ 响应吸收卡死主进程）
    const clen = Number(res.headers && res.headers.get('content-length')) || 0;
    if (clen > 2 * 1024 * 1024) return { ok: false, error: '响应过大（>2MB）', status: res.status };
    const text = await res.text();
    if (text.length > 2 * 1024 * 1024) return { ok: false, error: '响应过大（>2MB）', status: res.status };
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      const line = String(text)
        .split(/\r?\n/)
        .find((l) => l.startsWith('data:'));
      if (line) {
        try {
          data = JSON.parse(line.slice(5).trim());
        } catch {
          /* 保留原始错误片段 */
        }
      }
    }
    if (!res.ok) {
      const msg =
        (data && data.error && (data.error.message || data.error.type)) ||
        String(text || '').slice(0, 300) ||
        res.statusText;
      return {
        ok: false,
        error: 'HTTP ' + res.status + ' · ' + msg,
        status: res.status,
        elapsedMs: Date.now() - started,
      };
    }
    const choice = data && Array.isArray(data.choices) ? data.choices[0] : null;
    if (!choice) {
      return {
        ok: false,
        error: '响应没有 choices：' + String(text || '').slice(0, 240),
        elapsedMs: Date.now() - started,
      };
    }
    const msg = choice.message || {};
    const reply = String(msg.content || msg.reasoning_content || '').trim();
    return {
      ok: true,
      modelId,
      reply: reply.slice(0, 120),
      finishReason: choice.finish_reason || '',
      elapsedMs: Date.now() - started,
    };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e), elapsedMs: Date.now() - started };
  }
});

let configTestRequests = 0;

ipcMain.handle('config:test', async (_e, { baseUrl, apiKey, modelId, allowPrivate } = {}) => {
  configTestRequests++;
  if (!baseUrl) return { ok: false, error: 'Base URL 为空' };
  if (!await isSafeTestEndpoint(baseUrl, allowPrivate)) return { ok: false, error: '端点地址不安全（私网需显式允许，链路本地/元数据地址始终拒绝）' };
  const url = baseUrl.replace(/\/+$/, '') + '/models';
  const started = Date.now();
  try {
    const res = await fetch(url, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(10000),
      redirect: 'error',
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status} ${res.statusText}` };
    // R81 监工AB：响应体大小上限（防恶意端点 10MB+ 响应吸收卡死主进程）
    const clen = Number(res.headers && res.headers.get('content-length')) || 0;
    if (clen > 2 * 1024 * 1024) return { ok: false, error: '响应过大（>2MB）', status: res.status };
    const data = await res.json();
    // R74 监工H：元素可能为 null 或字符串（部分 OpenAI 兼容网关）——双形态容错
    const ids = Array.isArray(data && data.data)
      ? data.data.map((m) => (m && typeof m === 'object' ? m.id : typeof m === 'string' ? m : null)).filter((x) => x != null)
      : [];
    const modelList = (Array.isArray(data && data.data) ? data.data : [])
      .map((m) => ({
        id: String((m && m.id) || ''),
        name: String((m && (m.display_name || m.name)) || (m && m.id) || ''),
        context: Number((m && (m.context_length || m.context_window)) || 0),
      }))
      .filter((m) => m.id)
      .slice(0, 1000);
    return {
      ok: true,
      count: ids.length,
      found: modelId ? ids.includes(modelId) : null,
      sample: ids.slice(0, 6),
      models: ids.slice(0, 1000),
      modelList,
      elapsedMs: Date.now() - started,
    };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e), elapsedMs: Date.now() - started };
  }
});

ipcMain.handle('win:isFocused', () => !!(mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused()));

ipcMain.handle('win:minimize', () => mainWindow && mainWindow.minimize());
ipcMain.handle('win:maximize', () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.handle('win:close', () => mainWindow && mainWindow.close());

ipcMain.handle('dialog:pickFolder', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: '选择工作目录',
  });
  return res.canceled ? null : res.filePaths[0];
});

ipcMain.handle('dialog:confirm', async (_e, { title, message, detail, confirmLabel, cancelLabel } = {}) => {
  // R73（监工D）：SMOKE 模式无人值守——原生模态框会挂起 runSmoke（executeJavaScript 永不 resolve），
  // 统一自动确认
  if (process.argv.includes('--smoke')) return true;
  try {
    const res = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: [cancelLabel || '取消', confirmLabel || '确定'],
      defaultId: 1,
      cancelId: 0,
      noLink: true,
      title: title || '确认',
      message: message || '确认执行这个操作？',
      detail: detail || '',
    });
    return res.response === 1;
  } catch {
    return false;
  }
});

ipcMain.handle('sessions:list', async () => {
  flushSessionSaves();
  flushSessionIndex();
  return loadSessionsIndexed();
});

// R90：批量补水——渲染层后台补全会话正文时，逐个 sessions:get（750 个=750 次往返，约 94s）太慢。
// 一次取一批（并发 8 读盘），把「历史会话可被搜索/可秒开」的等待从分钟级压到十秒级。
ipcMain.handle('sessions:get-batch', async (_e, ids) => {
  const list = Array.isArray(ids) ? ids.slice(0, 50) : [];
  const out = [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < list.length) {
      const id = list[cursor++];
      if (!id || !CHECKPOINT_SESSION_ID_RE.test(String(id))) continue;
      try {
        const full = JSON.parse(await fs.promises.readFile(sessionFile(String(id)), 'utf8'));
        out.push({ id: String(id), session: isSessionRecord(full) ? full : null });
      } catch {
        out.push({ id: String(id), session: null });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, list.length) }, worker));
  return out;
});

ipcMain.handle('sessions:get', async (_e, id) => {
  try {
    const full = JSON.parse(await fs.promises.readFile(sessionFile(String(id || '')), 'utf8'));
    if (!isSessionRecord(full)) return { ok: false, error: '会话格式错误' };
    return { ok: true, session: full };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

ipcMain.handle('sessions:backupInfo', () => {
  const items = listSessionBackups();
  return { ok: true, dir: BACKUP_DIR, items: items.slice(0, 5), last: items[0] || null };
});

ipcMain.handle('sessions:flush', () => {
  flushSessionSaves();
  const pending = [...pendingSessionSaves.keys()];
  return pending.length
    ? { ok: false, error: '仍有会话保存失败，备份已取消', pending }
    : { ok: true };
});

function parseBackupSessions(text) {
  const parsed = JSON.parse(String(text || ''));
  const list = Array.isArray(parsed) ? parsed : parsed && Array.isArray(parsed.sessions) ? parsed.sessions : null;
  if (!list) throw new Error('需要会话数组或 { sessions: [] } 格式');
  const sessions = list.filter((x) => isSessionRecord(x) && Array.isArray(x.messages));
  if (!sessions.length) throw new Error('备份中没有有效会话');
  return {
    sessions,
    truncated: !Array.isArray(parsed) && parsed.truncated === true,
    total: !Array.isArray(parsed) && Number(parsed.total) || sessions.length,
    saved: !Array.isArray(parsed) && Number(parsed.saved) || sessions.length,
  };
}

ipcMain.handle('sessions:backup:read', async () => {
  try {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: '选择会话备份',
      filters: [{ name: 'JSON 备份', extensions: ['json'] }],
      properties: ['openFile'],
    });
    if (res.canceled || !res.filePaths || !res.filePaths[0]) return { ok: false, canceled: true };
    const file = res.filePaths[0];
    const st = await fs.promises.stat(file);
    if (!st.isFile() || st.size > 256 * 1024 * 1024) return { ok: false, error: '备份文件无效或超过 256MB' };
    const parsed = parseBackupSessions(await fs.promises.readFile(file, 'utf8'));
    return { ok: true, file, ...parsed };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

ipcMain.handle('sessions:backup:restore', async (_e, { sessions } = {}) => {
  try {
    if (!Array.isArray(sessions) || !sessions.length) return { ok: false, error: '没有可恢复的会话' };
    if (sessions.length > 2000) return { ok: false, error: '单次最多恢复 2000 个会话' };
    const restored = [];
    const failed = [];
    for (let i = 0; i < sessions.length; i++) {
      const src = sessions[i];
      if (!isSessionRecord(src) || !Array.isArray(src.messages)) { failed.push(i); continue; }
      const copy = JSON.parse(JSON.stringify(src));
      copy.id = 's_restore_' + Date.now().toString(36) + '_' + i + '_' + Math.random().toString(36).slice(2, 6);
      copy.title = String(copy.title || '恢复会话').slice(0, 120) + '（恢复副本）';
      copy.qwenSessionId = null;
      copy.pending = false;
      copy.lazy = false;
      for (const m of copy.messages) {
        if (!m || typeof m !== 'object') continue;
        m.pending = false;
        for (const b of Array.isArray(m.blocks) ? m.blocks : []) {
          if (b && b.state === 'running') b.state = 'stopped';
        }
      }
      saveSession(copy);
      restored.push(copy);
      if ((i + 1) % 10 === 0) await new Promise((resolve) => setImmediate(resolve));
    }
    flushSessionSaves();
    for (const s of restored) if (pendingSessionSaves.has(s.id)) failed.push(s.id);
    return { ok: failed.length === 0, partial: failed.length > 0, sessions: restored, failed };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e), sessions: [] };
  }
});

ipcMain.handle('sessions:backupNow', () => backupSessions(true));

ipcMain.handle('sessions:sizes', async () => {
  try {
    const names = (await fs.promises.readdir(DATA_DIR)).filter((f) => f.endsWith('.json'));
    // 并发 stat：原逐文件串行 await，50 个会话约 5-25ms；Promise.all 保持每个文件的容错
    const sized = await Promise.all(names.map(async (name) => {
      try {
        const st = await fs.promises.stat(path.join(DATA_DIR, name));
        return { id: name.slice(0, -5), bytes: st.size };
      } catch {
        return null;
      }
    }));
    const items = sized.filter(Boolean);
    items.sort((a, b) => b.bytes - a.bytes);
    return { ok: true, items: items.slice(0, 10) };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e), items: [] };
  }
});

ipcMain.handle('sessions:slim', (_e, id) => {
  try {
    const sid = String(id || '');
    const agent = agents.get(sid);
    if (agent && agent.busy) return { ok: false, error: '会话正在执行中，暂时不能瘦身' };
    // R72（监工C）：先冲刷待写的防抖保存再瘦身——否则瘦身结果会被 200ms 后的
    // flushSessionSave（用内存完整 session）覆盖回去，返回已瘦身但文件实际没变小
    flushSessionSave(sid);
    if (pendingSessionSaves.has(sid)) return { ok: false, error: '会话尚未完全落盘，已取消瘦身' };
    const file = sessionFile(sid);
    const raw = fs.readFileSync(file, 'utf8');
    const session = JSON.parse(raw);
    let saved = 0;
    for (const msg of Array.isArray(session.messages) ? session.messages : []) {
      for (const block of Array.isArray(msg.blocks) ? msg.blocks : []) {
        if (block && block.type === 'tool' && typeof block.output === 'string' && block.output.length > 32768) {
          // R76 监工M：outputLen 保留原始长度语义——UI 的「共 N 字符」应显示真实规模
          const origLen = Number(block.outputLen) || block.output.length;
          saved += block.output.length - 32768;
          block.output = block.output.slice(0, 32768) + '\n…（已瘦身，截断到 32KB）';
          block.truncated = true;
          block.outputLen = origLen;
        }
      }
    }
    if (saved > 0) {
      // 不可逆截断前自动保留单会话完整备份
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backup = path.join(BACKUP_DIR, 'sessions-slim-' + stamp + '-' + sid + '.json');
      const backupTmp = backup + '.tmp';
      fs.mkdirSync(BACKUP_DIR, { recursive: true });
      fs.writeFileSync(backupTmp, JSON.stringify({ __backup: true, reason: 'slim', total: 1, saved: 1, sessions: [JSON.parse(raw)] }), 'utf8');
      fs.renameSync(backupTmp, backup);
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(session), 'utf8');
      fs.renameSync(tmp, file);
      for (const old of fs.readdirSync(BACKUP_DIR).filter((f) => f.startsWith('sessions-slim-') && f.endsWith('.json')).sort().slice(0, -5)) {
        fs.rmSync(path.join(BACKUP_DIR, old), { force: true });
      }
      return { ok: true, saved, backup };
    }
    return { ok: true, saved };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

ipcMain.handle('sessions:save', (_e, session) => {
  // R80 监工Y：先校验 id——非法 id 会让 sessionFile 的 throw 穿透为 unhandledRejection 且写脏索引
  if (!session || !CHECKPOINT_SESSION_ID_RE.test(String(session.id || ''))) return { ok: false, error: '无效会话 id' };
  if (deletedSessionIds.has(String(session.id))) return { ok: false, error: '会话已删除，拒绝迟到保存' };
  sessionSaveRequests++;
  saveSession(session);
  return true;
});

ipcMain.handle('sessions:clear', () => {
  // 先落盘最新内容，避免把旧版本移入回收站；失败项保留原队列
  flushSessionSaves();
  if (pendingSessionSaves.size) {
    const pendingIds = [...pendingSessionSaves.keys()];
    return { ok: false, removed: 0, removedIds: [], failedIds: [], pendingIds, error: '仍有会话保存失败，已取消清空' };
  }
  let removed = 0;
  const removedIds = [];
  const failedIds = [];
  try {
    for (const f of fs.readdirSync(DATA_DIR)) {
      if (!f.endsWith('.json')) continue;
      const id = f.slice(0, -5);
      try {
        moveSessionToTrash(path.join(DATA_DIR, f)); // 文件已消失也按幂等成功处理
        rememberDeletedSession(id);
        removedIds.push(id);
        removed++;
      } catch {
        failedIds.push(id);
      }
    }
  } catch {
    /* 目录不存在 */
  }
  // 只清理真正移入回收站的会话；失败项的内核、待写保存和索引必须保留
  for (const id of removedIds) {
    dropSessionSave(id);
    removeSessionIndex(id);
    const agent = agents.get(id);
    if (agent) {
      agent.dispose();
      agents.delete(id);
    }
    try {
      if (CHECKPOINT_SESSION_ID_RE.test(id)) fs.rmSync(checkpointSessionDir(id), { recursive: true, force: true });
    } catch {
      /* 检查点清理失败不阻断会话删除 */
    }
  }
  return { ok: failedIds.length === 0, removed, removedIds, failedIds };
});

// 按时间倒序取前 N（纯函数，便于断言）：先 stat 排序再只解析入选文件，避免全量 JSON.parse
function topByMtime(items, n) {
  return items.slice().sort((a, b) => b.deletedAt - a.deletedAt).slice(0, n);
}

async function listTrashItems(offset = 0, limit = 20) {
  let files;
  try {
    files = (await fs.promises.readdir(TRASH_DIR)).filter((f) => f.endsWith('.json'));
  } catch (e) {
    if (e && e.code === 'ENOENT') return { ok: true, items: [], total: 0, hasMore: false, nextOffset: 0 };
    return { ok: false, error: String((e && e.message) || e), items: [], total: 0, hasMore: false, nextOffset: 0 };
  }
  const withTime = await Promise.all(
    files.map(async (f) => {
      let deletedAt = 0;
      try {
        deletedAt = (await fs.promises.stat(path.join(TRASH_DIR, f))).mtimeMs;
      } catch {
        /* 读不到 mtime 的排最后 */
      }
      return { f, deletedAt };
    })
  );
  const start = Math.max(0, Number(offset) || 0);
  const size = Math.max(1, Math.min(50, Number(limit) || 20));
  const page = topByMtime(withTime, start + size).slice(start);
  const items = await Promise.all(
    page.map(async ({ f, deletedAt }) => {
      const full = path.join(TRASH_DIR, f);
      let title = '未命名会话';
      let messages = 0;
      try {
        const j = JSON.parse(await fs.promises.readFile(full, 'utf8'));
        title = j.title || title;
        messages = Array.isArray(j.messages) ? j.messages.length : 0;
      } catch {
        /* 打不开也给个条目 */
      }
      return { file: f, title, messages, deletedAt };
    })
  );
  const nextOffset = start + items.length;
  return { ok: true, items, total: files.length, hasMore: nextOffset < files.length, nextOffset };
}

ipcMain.handle('sessions:trash:list', (_e, opts = {}) => listTrashItems(opts.offset, opts.limit));

ipcMain.handle('sessions:trash:restore', (_e, { file } = {}) => {
  try {
    const base = path.basename(String(file || ""));
    if (!base.endsWith(".json")) return { ok: false, error: "参数无效" };
    const src = path.join(TRASH_DIR, base);
    if (!isInside(TRASH_DIR, src) || !fs.existsSync(src)) return { ok: false, error: "文件不存在" };
    const session = JSON.parse(fs.readFileSync(src, "utf8"));
    if (!isSessionRecord(session)) return { ok: false, error: "会话格式错误" };
    let id = String(session.id || "s_restored_" + Date.now().toString(36));
    // R83 监工AD8：回收站里的 id 可能来自旧版本或人工编辑——不合法就换新 id，不能让文件打不开
    if (!CHECKPOINT_SESSION_ID_RE.test(id)) id = 's_restored_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    if (fs.existsSync(sessionFile(id))) id = id + "-r" + Date.now().toString(36);
    session.id = id;
    session.qwenSessionId = null;
    session.pending = false;
    session.updatedAt = Date.now();
    for (const msg of Array.isArray(session.messages) ? session.messages : []) {
      msg.pending = false;
      for (const b of Array.isArray(msg.blocks) ? msg.blocks : []) {
        if (b && b.type === "tool" && b.state === "running") b.state = "stopped";
      }
    }
    // 从回收站恢复的 Goal 一律暂停（对齐冷恢复语义），不能自动续跑
    if (session.goal && typeof session.goal === "object" && session.goal.status !== "complete") {
      session.goal.status = "paused";
      session.goal.verifying = false;
      session.goal.blockedReason = { code: "restored", message: "从回收站恢复 - 需 /goal resume 手动恢复" };
      session.goal.updatedAt = Date.now();
    }
    const target = sessionFile(id);
    const tmp = target + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(session), 'utf8');
    fs.renameSync(tmp, target);
    try {
      fs.unlinkSync(src);
    } catch (e) {
      // 源文件仍在回收站：回滚目标，避免重试恢复产生重复会话
      try { fs.rmSync(target, { force: true }); } catch { /* ignore */ }
      return { ok: false, error: '恢复失败：无法移除回收站源文件 ' + String((e && e.message) || e) };
    }
    allowRestoredSession(id);
    updateSessionIndex(session);
    return { ok: true, session };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

ipcMain.handle('sessions:delete', (_e, id) => {
  // 先确认文件删除成功；失败时内核、待写保存和 renderer 状态都必须保留
  const removed = deleteSessionFile(id);
  if (!removed) return { ok: false, error: '会话文件删除失败（可能被占用），请关闭占用后重试' };
  dropSessionSave(id);
  const agent = agents.get(id);
  if (agent) {
    agent.dispose();
    agents.delete(id);
  }
  // 同步清理该会话的工作区检查点
  if (id && CHECKPOINT_SESSION_ID_RE.test(id)) {
    const sdir = checkpointSessionDir(id);
    fs.promises
      .rm(sdir, { recursive: true, force: true })
      .then(() => gcCheckpointBlobs(true))
      .catch(() => {});
  }
  return { ok: true };
});

ipcMain.handle('chat:send', (_e, { session, text } = {}) => {
  // R72（监工A）：参数兜底与校验（session 为 null 时原先直接 TypeError 且无日志）
  if (!session || !session.id) return { ok: false, error: '参数无效：缺少会话' };
  // 默认思考强度需要重启内核才能清除，等当前回合结束后再换进程
  const pendingRestart = agents.get(session.id);
  if (pendingRestart && pendingRestart.restartAfterTurn && !pendingRestart.busy) {
    pendingRestart.stop(true);
    agents.delete(session.id);
  }
  // 上一轮刚被 interrupt、进程还在等强杀：直接换新进程，避免把新消息写进正在退出的内核
  const existing = agents.get(session.id);
  if (existing && existing.killTimer) {
    existing.stop(true); // R73 监工F：同上，防孤儿复活
    agents.delete(session.id);
  }
  // R83 监工AC5：渲染层与主进程 busy 可能分叉（自动重启抢救 prompt）——重复写 stdin 会让
  // 两个回合的事件混进同一条 stream。这里以主进程的 busy 为准，拒绝第二条消息。
  const busyAgent = agents.get(session.id);
  if (busyAgent && busyAgent.busy) return { ok: false, error: 'busy' };
  const agent = getAgent(session);
  agent.setEffort(session.reasoningEffort || null);
  agent.send(text);
  return true;
});

ipcMain.handle('chat:set-effort', (_e, { sessionId, tier } = {}) => {
  const next = ['low', 'medium', 'high', 'xhigh', 'max'].includes(tier) ? tier : '';
  try {
    const cfg = readQwenSettings();
    cfg.model = cfg.model && typeof cfg.model === 'object' ? cfg.model : {};
    if (next) cfg.model.reasoningEffort = next;
    else delete cfg.model.reasoningEffort;
    writeQwenSettings(cfg);
  } catch (e) {
    log('effort setting failed', String((e && e.message) || e));
  }
  const agent = agents.get(sessionId);
  if (agent) {
    if (next) {
      agent.restartAfterTurn = false;
      agent.setEffort(next);
    } else if (agent.busy) {
      // 当前回合继续用旧强度，下一轮发送前重启内核读取默认设置
      agent.restartAfterTurn = true;
    } else {
      agent.stop(true);
      agents.delete(sessionId);
    }
  }
  return { ok: true, tier: next };
});

ipcMain.handle('chat:interrupt', (_e, { sessionId }) => {
  const agent = agents.get(sessionId);
  return agent ? agent.interrupt() : false;
});

// 工具授权裁决：渲染层把 can_use_tool 的 requestId 连同 allow/deny 回传，
// 写入内核 stdin 的 control_response 让被挂起的回合继续。
ipcMain.handle('chat:approval', (_e, { sessionId, requestId, allowed } = {}) => {
  const agent = agents.get(sessionId);
  return agent ? agent.resolveApproval(requestId, !!allowed) : false;
});

ipcMain.handle('agent:restart', (_e, { session }) => {
  const agent = agents.get(session.id);
  if (agent) {
    agent.stop(true);
    agents.delete(session.id);
    return true;
  }
  return false;
});

/* ------------------------------------------------------------------ */
/* 冒烟测试：自动发一条消息，等完成，截图，退出                          */
/* ------------------------------------------------------------------ */

async function runKernelSmoke() {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    await wait(1800);
    const before = await mainWindow.webContents.executeJavaScript(`(async () => ({
      status: await window.shell.kernelStatus(),
      guide: !!document.querySelector('.cli-guide'),
      installBtn: !!document.querySelector('[data-cli-install], #cliInstallAbout'),
    }))()`);
    console.log('[smoke:kernel] before', JSON.stringify(before));
    const bundled = !!(
      before.status &&
      before.status.launch &&
      String(before.status.launch.mode || '').startsWith('bundled')
    );
    const install = bundled
      ? { ok: true, skipped: true, bundled: true }
      : await mainWindow.webContents.executeJavaScript('window.shell.kernelInstall()');
    console.log('[smoke:kernel] install', JSON.stringify(install));
    await wait(900);
    const after = await mainWindow.webContents.executeJavaScript(`(async () => ({
      status: await window.shell.kernelStatus(),
      version: await window.shell.cliVersion(),
    }))()`);
    console.log('[smoke:kernel] after', JSON.stringify(after));
    log('smoke kernel', JSON.stringify({ before, install, after }));
  } catch (e) {
    console.error('[smoke:kernel] failed', e);
  } finally {
    setTimeout(() => app.quit(), 600);
  }
}

// R84：性能基准 harness——`Qcode.exe --bench` 在真实 Chromium 里跑一组可重复微基准后退出。
// 口径固定（同样的合成数据、同样的 warmup），保证「优化前 vs 优化后」可比。
// R86：受控实验——用三个空白页面分别测「导航基线 / +CSS / +JS」，
// 把启动前「首行代码执行之前」的耗时拆成 CSS 解析与 JS 编译各占多少。
async function benchPageLoad(url, expr, settleMs) {
  const win = new BrowserWindow({
    show: false,
    width: 1200,
    height: 800,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  try {
    await win.loadURL(url);
    if (settleMs) await new Promise((r) => setTimeout(r, settleMs));
    return await win.webContents.executeJavaScript(expr);
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

async function benchBootDecomposition() {
  const dir = path.join(os.tmpdir(), 'qcode-bench-pages');
  fs.mkdirSync(dir, { recursive: true });
  const cssUrl = pathToFileURL(path.join(__dirname, 'renderer', 'style.css')).href;
  const jsUrl = pathToFileURL(path.join(__dirname, 'renderer', 'app.js')).href;
  const write = (name, head, body) => {
    const html =
      '<!doctype html><html><head><meta charset="utf-8">' +
      head +
      '<script>window.__m=performance.now()</script></head><body>' +
      body +
      '</body></html>';
    const p = path.join(dir, name + '.html');
    fs.writeFileSync(p, html, 'utf8');
    return pathToFileURL(p).href;
  };
  const blankUrl = write('blank', '', '');
  const cssUrlPage = write('css', '<link rel="stylesheet" href="' + cssUrl + '">', '');
  // 标记脚本放在 app.js 之前：__scriptStart 由 app.js 第一行写入，差值即「取+编译」
  const jsUrlPage = write('js', '', '<script src="' + jsUrl + '"></script>');
  const out = {};
  try {
    out.blankMs = Math.round(await benchPageLoad(blankUrl, 'window.__m'));
    out.withCssMs = Math.round(await benchPageLoad(cssUrlPage, 'window.__m'));
    out.jsStartMs = Math.round(await benchPageLoad(jsUrlPage, 'window.__scriptStart || -1'));
    // 真实 index.html（无 preload）：脚本起点与首帧各在何时——用于判断「IPC 慢」还是「首屏布局吃掉了那 40ms」
    const realUrl = pathToFileURL(path.join(__dirname, 'renderer', 'index.html')).href;
    out.realScriptStartMs = Math.round(await benchPageLoad(realUrl, 'window.__scriptStart || -1', 20));
    out.realFirstFrameMs = Math.round(
      await benchPageLoad(realUrl, 'window.__firstFrameMs || -1', 600)
    );
    // 变体：去掉 style.css（脚本用绝对路径）——隔离「CSS 解析+首屏样式计算」占多少
    {
      const htmlSrc = fs.readFileSync(path.join(__dirname, 'renderer', 'index.html'), 'utf8');
      const variant = htmlSrc
        .replace(/<link[^>]*style\.css[^>]*>/, '')
        .replace('<script src="app.js"></script>', '<script src="' + jsUrl + '"></script>');
      const p = path.join(dir, 'nocss.html');
      fs.writeFileSync(p, variant, 'utf8');
      out.realNoCssScriptStartMs = Math.round(
        await benchPageLoad(pathToFileURL(p).href, 'window.__scriptStart || -1', 20)
      );
    }
    // 首屏布局二分：静态页面 + 末尾内联探针（不跑 app.js），逐项剔除可疑样式看布局耗时
    {
      const htmlSrc = fs.readFileSync(path.join(__dirname, 'renderer', 'index.html'), 'utf8');
      const cssSrc = fs.readFileSync(path.join(__dirname, 'renderer', 'style.css'), 'utf8');
      const probe =
        '<script>window.__probeLayout=(function(){var t=performance.now();void document.body.offsetHeight;' +
        'return +(performance.now()-t).toFixed(1);})();</script></body>';
      const build = (name, css, mutateHtml) => {
        const cssFile = path.join(dir, name + '.css');
        fs.writeFileSync(cssFile, css, 'utf8');
        let html = htmlSrc
          .replace(/<link[^>]*style\.css[^>]*>/, '<link rel="stylesheet" href="' + pathToFileURL(cssFile).href + '">')
          // 变体页面要去掉 CSP meta，否则 inline 探针脚本会被 default-src 'self' 拦掉
          .replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '')
          .replace('<script src="app.js"></script>', '');
        if (mutateHtml) html = mutateHtml(html);
        html = html.replace('</body>', probe);
        const p = path.join(dir, name + '.html');
        fs.writeFileSync(p, html, 'utf8');
        return pathToFileURL(p).href;
      };
      const readLayout = (url) => benchPageLoad(url, 'window.__probeLayout', 30);
      out.layoutRealMs = await readLayout(build('lay-1', cssSrc));
      out.layoutNoShadowMs = await readLayout(
        build('lay-2', cssSrc.replace(/box-shadow\s*:[^;}]+;?/g, ''))
      );
      out.layoutMinimalMs = await readLayout(
        build('lay-3', cssSrc, (h) =>
          h
            .replace('<div class="panel"', '<div class="panel" style="display:none"')
            .replace('<div class="thread-skeleton" id="threadSkeleton"', '<div class="thread-skeleton" id="threadSkeleton" style="display:none"')
            .replace('<div class="toasts"', '<div class="toasts" style="display:none"')
        )
      );
      // 对照：同样的 CSS 但空 body / 真实 DOM 但无 CSS——把「平台首屏开销」与「我们的 DOM/CSS」分开
      out.layoutEmptyMs = await readLayout(
        build('lay-4', cssSrc, (h) => h.replace(/<body>[\s\S]*<\/body>/, '<body></body>'))
      );
      out.layoutNoCssMs = await readLayout(build('lay-5', '', (h) => h));
      // 拆开「元素数量」与「中文文本整形/字体首次实例化」两个嫌疑
      out.layoutDivsOnlyMs = await readLayout(
        build('lay-6', cssSrc, (h) =>
          h.replace(/<body>[\s\S]*<\/body>/, '<body>' + new Array(501).join('<div></div>') + '</body>')
        )
      );
      out.layoutTextOnlyMs = await readLayout(
        build('lay-7', cssSrc, (h) =>
          h.replace(
            /<body>[\s\S]*<\/body>/,
            '<body><div style="font-family:\'Microsoft YaHei\',sans-serif">界面中文文本测试：需要我为你做些什么？会话列表与输入框示例文本。</div></body>'
          )
        )
      );
      // 内联 SVG 是否是大头：把真实 DOM 里的 <svg>…</svg> 全部换成空 span
      out.layoutNoSvgMs = await readLayout(
        build('lay-8', cssSrc, (h) => h.replace(/<svg[\s\S]*?<\/svg>/g, '<span></span>'))
      );
      // 文字量是否是主因：去掉所有文本节点（保留标签与属性）
      out.layoutNoTextMs = await readLayout(
        build('lay-9', cssSrc, (h) => h.replace(/>([^<>]+)</g, (m, t) => (/^\s*$/.test(t) ? m : '><')))
      );
    }
  } catch (e) {
    out.error = String((e && e.message) || e);
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  return out;
}

// R92：长跑泄漏检查——`--soak` 跑 200 轮「切会话 + 流式 + 切主题」，按间隔采样渲染进程内存与 DOM 节点数。
// 判定标准：堆/节点数不随轮次单调增长（允许首轮预热与 GC 抖动）。
async function runSoak() {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    await wait(1500);
    const out = await Promise.race([
      mainWindow.webContents.executeJavaScript(`
      (async () => {
        const bt = String.fromCharCode(96);
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const keepSessions = state.sessions;
        const keepCurrent = state.current;
        const many = [];
        for (let i = 0; i < 20; i++) {
          many.push({ id: 'soak' + i, title: 'soak ' + i, cwd: state.defaultCwd, createdAt: 1, updatedAt: 1, messages: [] });
        }
        for (let i = 0; i < 20; i++) {
          for (let j = 0; j < 60; j++) {
            many[i].messages.push(
              j % 2
                ? { role: 'assistant', text: '回复', blocks: [
                    { type: 'text', text: '段落 ' + j + ' **b** ' + bt + 'c' + bt },
                    { type: 'tool', id: 'soak_t_' + i + '_' + j, name: 'run_shell_command', state: 'done', input: { command: 'echo ' + j }, output: 'tool-output-' + j + '-' + 'x'.repeat(2048) },
                  ], ts: 1 }
                : { role: 'user', text: '问 ' + j, ts: 1 }
            );
          }
        }
        state.sessions = many;
        const samples = [];
        const sample = async (tag) => {
          let mem = null;
          try {
            // 采样前强制 GC（--expose-gc 只在 --soak 下开启），量的是「保留内存」而不是堆松弛
            if (typeof window.gc === 'function') {
              window.gc();
              await sleep(60);
            }
          } catch (e) {
            /* gc 不可用时忽略 */
          }
          try {
            mem = await window.shell.perf('bench-mem');
          } catch (e) {
            mem = null;
          }
          samples.push({
            tag: tag,
            privateMb: mem ? mem.privateMb : -1,
            workingMb: mem ? mem.workingMb : -1,
            dom: document.getElementsByTagName('*').length,
            mdNodes: mdBlockNodeCache.size,
            toolNodes: toolBodyNodeCache.size,
            outHtml: toolOutHtmlCache.size,
            diffHtml: toolDiffCache.size,
            mdWeight: mdBlockNodeCache.__weight || 0,
            toolWeight: toolBodyNodeCache.__weight || 0,
            outHtmlWeight: toolOutHtmlCache.__weight || 0,
            diffHtmlWeight: toolDiffCache.__weight || 0,
            sessions: state.sessions.length,
            runtimes: state.runtimes.size,
          });
        };
        await sample('start');
        const phaseTotals = { switch: 0, stream: 0, theme: 0, sleep: 0 };
        // R92：统计 rAF 回调次数——若远多于「帧数」，说明有动画循环在累积
        const origRaf = window.requestAnimationFrame.bind(window);
        let rafCount = 0;
        window.requestAnimationFrame = (cb) =>
          origRaf((ts) => {
            rafCount++;
            return cb(ts);
          });
        for (let n = 0; n < ${SOAK_CYCLES}; n++) {
          if (n % 25 === 0) {
            // 进度打点（走既有权 perf 通道 → agent.log），卡住时能看出停在哪一轮
            try {
              await window.shell.perf('soak-progress', 'n' + n + ' ' + JSON.stringify(Object.assign({ raf: rafCount, dom: document.getElementsByTagName('*').length }, phaseTotals, { sizes: (function () {
                const o = {};
                for (const k of Object.keys(state)) {
                  const v = state[k];
                  if (Array.isArray(v)) o[k] = v.length;
                  else if (v instanceof Map || v instanceof Set) o[k] = v.size;
                }
                return o;
              })() })));
            } catch (e) {
              /* ignore */
            }
          }
          const s = many[n % 20];
          const modeSet = '${SOAK_MODE}'.split(',');
          const onOp = (x) => modeSet.indexOf(x) >= 0 || modeSet.indexOf('all') >= 0;
          let tPhase = performance.now();
          if (onOp('switch')) await switchSession(s.id);
          phaseTotals.switch += performance.now() - tPhase;
          tPhase = performance.now();
          const r = rt(s.id);
          if (onOp('stream')) {
            r.busy = true;
            r.stream = { blocks: [], tools: {}, toolEls: {}, previewText: '', text: '' };
            renderThread();
            for (let k = 0; k < 30; k++) {
              handleStreamEvent(
                s,
                { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '片段' + k } } },
                true
              );
            }
            r.busy = false;
            r.stream = null;
          }
          phaseTotals.stream += performance.now() - tPhase;
          tPhase = performance.now();
          if (onOp('theme')) applyTheme(n % 2 ? 'dark' : 'light', false);
          phaseTotals.theme += performance.now() - tPhase;
          tPhase = performance.now();
          await sleep(8);
          phaseTotals.sleep += performance.now() - tPhase;
          if ((n + 1) % 50 === 0) await sample('n' + (n + 1));
        }
        applyTheme(localStorage.getItem('ui.theme') || 'light', false);
        for (const s of many) forgetSessionCaches(s.id);
        state.sessions = keepSessions;
        state.current = keepCurrent;
        renderAll();
        await sleep(300);
        await sample('end');
        return { samples };
      })()
    `),
      // 看门狗：渲染层若被卡住，不再无限等待（泄漏检查本身不该挂死）
      new Promise((resolve) => setTimeout(() => resolve({ samples: [], timeout: true }), 180000)),
    ]);
    console.log('[soak] ' + JSON.stringify(out));
    const s = (out && out.samples) || [];
    if (s.length >= 2) {
      const first = s[0];
      const last = s[s.length - 1];
      console.log(
        '[soak] growth private=' +
          (last.privateMb - first.privateMb).toFixed(1) +
          'MB working=' +
          (last.workingMb - first.workingMb).toFixed(1) +
          'MB dom=' +
          (last.dom - first.dom) +
          ' nodes'
      );
      const warm = s.find((x) => x.tag === 'n100');
      const plateau = s[s.length - 2] || last;
      if (warm) {
        console.log(
          '[soak] plateau private=' +
            (plateau.privateMb - warm.privateMb).toFixed(1) +
            'MB working=' +
            (plateau.workingMb - warm.workingMb).toFixed(1) +
            'MB mdNodes=' + plateau.mdNodes +
            ' toolNodes=' + plateau.toolNodes +
            ' outHtml=' + plateau.outHtml +
            ' diffHtml=' + plateau.diffHtml +
            ' outHtmlWeight=' + plateau.outHtmlWeight
        );
      }
    }
    log('soak', JSON.stringify(out));
  } catch (e) {
    console.error('[soak] failed', e);
  } finally {
    setTimeout(() => app.quit(), 500);
  }
}

// R93：真数据校验——`--realdata` 用当前 userData 里的真实会话做渲染/搜索/导出验证。
// 只读：不写盘、不改用户会话，除非显式指定 --realdata-write。
async function runRealData() {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    await wait(2000);
    const out = await mainWindow.webContents.executeJavaScript(`
      (async () => {
        const t = (fn) => {
          const t0 = performance.now();
          const v = fn();
          return { ms: +(performance.now() - t0).toFixed(1), v: v };
        };
        const res = { errors: [] };
        window.addEventListener('error', (e) => res.errors.push(String(e.message)));
        res.sessions = state.sessions.length;
        const withMsgs = state.sessions
          .map((s) => ({ id: s.id, n: (s.messages || []).length, lazy: !!s.lazy }))
          .sort((a, b) => b.n - a.n);
        res.top = withMsgs.slice(0, 5);
        res.totalMessages = withMsgs.reduce((a, x) => a + x.n, 0);
        res.lazyCount = withMsgs.filter((x) => x.lazy).length;
        if (!withMsgs.length) return res;
        // 最大会话：打开 + 渲染
        const big = withMsgs[0];
        const open = await (async () => {
          const t0 = performance.now();
          await switchSession(big.id);
          return +(performance.now() - t0).toFixed(1);
        })();
        res.switchBigMs = open;
        const r = rt(big.id);
        res.domNodes = document.getElementsByTagName('*').length;
        res.renderedRows = document.querySelectorAll('#thread .msg').length;
        // 搜索：用第一条用户消息里前 4 个字做查询
        const cur = state.current;
        const firstUser = (cur.messages || []).find((m) => m.role === 'user' && (m.text || '').trim());
        if (firstUser) {
          const q = String(firstUser.text).trim().slice(0, 4);
          const found = t(() => {
            const hits = [];
            for (const s of state.sessions) {
              if (s.lazy) continue;
              for (const m of s.messages || []) {
                if ((m.text || '').indexOf(q) >= 0) {
                  hits.push(s.id);
                  break;
                }
              }
            }
            return hits.length;
          });
          res.search = { q: q, ms: found.ms, hits: found.v };
        }
        // 导出 markdown：真实会话（不写盘，只看代价与长度）
        const md = t(() => (typeof sessionToMarkdown === 'function' ? sessionToMarkdown(cur) : ''));
        res.exportMd = { ms: md.ms, bytes: String(md.v || '').length };
        res.finalSessionId = cur.id;
        res.messages = (cur.messages || []).length;
        return res;
      })()
    `);
    // R121：可选导出 PDF——--realdata-pdf=<path> 直接用真实会话生成一份 PDF 供人工检查
    const pdfArg = (process.argv.find((a) => a.startsWith('--realdata-pdf=')) || '').slice('--realdata-pdf='.length);
    if (pdfArg && out.finalSessionId) {
      try {
        const html = await mainWindow.webContents.executeJavaScript(
          "(function () { var s = state.current; return s ? sessionToPrintHtml(s) : ''; })()"
        );
        const pdf = await htmlToPdfBuffer(html);
        if (pdf.ok) {
          fs.writeFileSync(pdfArg, pdf.buffer);
          out.pdf = { path: pdfArg, bytes: pdf.buffer.length };
        } else {
          out.pdf = { error: pdf.error };
        }
      } catch (e) {
        out.pdf = { error: String((e && e.message) || e) };
      }
    }
    // R121b：可选导出 HTML——`--realdata-html=<path>` 用真实会话生成单文件 HTML 供人工检查
    const htmlArg = (process.argv.find((a) => a.startsWith('--realdata-html=')) || '').slice('--realdata-html='.length);
    if (htmlArg && out.finalSessionId) {
      try {
        const html = await mainWindow.webContents.executeJavaScript(
          "(function () { var s = state.current; return s ? sessionToHtmlFile(s) : ''; })()"
        );
        fs.writeFileSync(htmlArg, inlineAttachImages(html), 'utf8');
        out.html = { path: htmlArg, bytes: fs.statSync(htmlArg).size };
      } catch (e) {
        out.html = { error: String((e && e.message) || e) };
      }
    }
    console.log('[realdata] ' + JSON.stringify(out));
    log('realdata', JSON.stringify(out));
  } catch (e) {
    console.error('[realdata] failed', e);
    log('realdata failed', String((e && e.message) || e));
  } finally {
    setTimeout(() => app.quit(), 400);
  }
}

// R94：真实内核端到端——`--e2e` 用内置内核真发一条消息，断言助手回复落地、无 renderer 报错。
// 冒烟用的是合成事件，这里补的是「真实 spawn + stream-json + UI 落定」的最终验证。
async function runE2E() {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const started = Date.now();
  const result = { ok: false, ms: 0, textLen: 0, errors: [], status: '', logins: '' };
  try {
    await wait(2500);
    // 轮数可配：--e2e-turns=2 验证同一会话的第二轮（走内核 --resume 续聊）
    const turns = (() => {
      const m = /--e2e-turns=(\d+)/.exec(process.argv.join(' '));
      const n = m ? Number(m[1]) : 0;
      return n > 0 && n <= 5 ? n : 1;
    })();
    result.turns = [];
    let sessionId = null;
    // 轮询用的状态变量要在循环外声明，最后一轮结束后还要用
    let lastText = '';
    let state0 = null;
    for (let ti = 0; ti < turns; ti++) {
      const prompt =
        ti === 0
          ? '只回复两个字：收到。不要调用任何工具，不要解释。'
          : '再回复两个字：继续。不要调用任何工具。';
      const setup = await mainWindow.webContents.executeJavaScript(`
        (async () => {
          if (window.__e2eErrors == null) {
            window.__e2eErrors = [];
            window.addEventListener('error', (e) => window.__e2eErrors.push(String(e.message)));
          }
          ${ti === 0 ? 'newSessionOrFocus();' : ''}
          const s = state.current;
          const inp = document.getElementById('input');
          inp.value = ${JSON.stringify(prompt)};
          inp.dispatchEvent(new Event('input', { bubbles: true }));
          await send();
          return { id: s && s.id, busy: !!(s && rt(s.id).busy) };
        })()
      `);
      sessionId = (setup && setup.id) || sessionId;
      result.sessionId = sessionId;
      result.sent = !!(setup && setup.busy);
      const deadline = Date.now() + 120000;
      lastText = '';
      state0 = null;
      while (Date.now() < deadline) {
        await wait(700);
        state0 = await mainWindow.webContents.executeJavaScript(`
          (function () {
            const s = state.current;
            if (!s) return null;
            const r = rt(s.id);
            const msgs = s.messages || [];
            let text = '';
            for (let i = msgs.length - 1; i >= 0; i--) {
              if (msgs[i] && msgs[i].role === 'assistant') {
                // 助手正文在 blocks 里（顶层 text 可能为空），复用应用自己的取文本函数
                text = String((typeof assistantText === 'function' ? assistantText(msgs[i]) : msgs[i].text) || '');
                break;
              }
            }
            return {
              busy: !!r.busy,
              text: text.slice(0, 400),
              count: msgs.length,
              status: (r.status && r.status.text) || '',
              errors: window.__e2eErrors || [],
            };
          })()
        `);
        if (!state0) break;
        lastText = state0.text || lastText;
        if (!state0.busy) break;
      }
      result.turns.push({ turn: ti + 1, textLen: lastText.length, text: lastText.slice(0, 80), ok: lastText.length > 0 && !!(state0 && !state0.busy) });
      if (!(state0 && !state0.busy)) break;
    }
    result.ms = Date.now() - started;
    const lastTurn = result.turns[result.turns.length - 1] || {};
    result.textLen = lastTurn.textLen || 0;
    result.text = lastTurn.text || '';
    result.ok = result.turns.length === turns && result.turns.every((t) => t.ok) && (state0 ? (state0.errors || []).length === 0 : false);
    result.errors = state0 ? state0.errors || [] : [];
    result.status = state0 ? state0.status : '';
    result.messages = state0 ? state0.count : 0;
    console.log('[e2e] ' + JSON.stringify(result));
    log('e2e', JSON.stringify(result));
  } catch (e) {
    result.error = String((e && e.message) || e);
    console.log('[e2e] failed ' + result.error);
    log('e2e failed', result.error);
  } finally {
    setTimeout(() => app.quit(), 400);
  }
}

// R99：回滚（rewind）成本测量——合成仓库 2000 文件，测「建检查点 / diff / 还原」三段耗时，
// 并校验还原结果真的把内容与删除/新增都处理对了。
async function runRewindBench() {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const sid = 's_rewind_bench';
  const repo = path.join(DATA_DIR, 'rewind-repo');
  const out = {};
  try {
    await wait(2000);
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(checkpointSessionDir(sid), { recursive: true, force: true });
    // 2000 个文件，分散在 20 个子目录
    for (let d = 0; d < 20; d++) {
      const sub = path.join(repo, 'd' + d);
      fs.mkdirSync(sub, { recursive: true });
      for (let i = 0; i < 100; i++) {
        fs.writeFileSync(path.join(sub, 'f' + i + '.txt'), 'original-' + d + '-' + i + '-' + 'x'.repeat(120), 'utf8');
      }
    }
    const tCreate = Date.now();
    out.create = await mainWindow.webContents.executeJavaScript(
      'window.shell.checkpoint.create(' + JSON.stringify(sid) + ',' + JSON.stringify(repo) + ')'
    );
    out.createMs = Date.now() - tCreate;
    const cpId = String((out.create && out.create.id) || '');
    // 第二轮（无改动）：这才是用户每轮真正承受的成本（mtime/size 未变 → 复用 sha，不拷贝不哈希）
    const tCreate2 = Date.now();
    const second = await mainWindow.webContents.executeJavaScript(
      'window.shell.checkpoint.create(' + JSON.stringify(sid) + ',' + JSON.stringify(repo) + ')'
    );
    out.createIncrementalMs = Date.now() - tCreate2;
    out.createIncremental = second && second.ok ? { fileCount: second.fileCount, id: second.id } : second;
    // 改动：50 个修改、50 个删除（都是确实存在的 f0..f99）、50 个新增
    for (let i = 0; i < 50; i++) {
      fs.writeFileSync(path.join(repo, 'd' + (i % 20), 'f' + i + '.txt'), 'MODIFIED-' + i, 'utf8');
      fs.rmSync(path.join(repo, 'd' + (i % 20), 'f' + (i + 50) + '.txt'), { force: true });
      fs.writeFileSync(path.join(repo, 'd' + (i % 20), 'new' + i + '.txt'), 'added-' + i, 'utf8');
    }
    const tDiff = Date.now();
    out.diff = await mainWindow.webContents.executeJavaScript(
      'window.shell.checkpoint.diff(' +
        JSON.stringify(sid) +
        ',' +
        JSON.stringify(cpId) +
        ',' +
        JSON.stringify(repo) +
        ')'
    );
    out.diffMs = Date.now() - tDiff;
    if (!cpId) {
      out.diff = { ok: false, error: 'no checkpoint id' };
    }
    const tRestore = Date.now();
    out.restore = await mainWindow.webContents.executeJavaScript(
      'window.shell.checkpoint.restore(' +
        JSON.stringify(sid) +
        ',' +
        JSON.stringify(cpId) +
        ',' +
        JSON.stringify(repo) +
        ',true)'
    );
    out.restoreMs = Date.now() - tRestore;
    // 校验：修改被还原、删除被恢复、新增被删掉
    let restoredContent = '';
    try {
      restoredContent = fs.readFileSync(path.join(repo, 'd0', 'f0.txt'), 'utf8');
    } catch {
      restoredContent = '';
    }
    out.verify = {
      modifiedReverted: restoredContent.startsWith('original-0-0-'),
      deletedRestored: fs.existsSync(path.join(repo, 'd0', 'f50.txt')),
      addedRemoved: !fs.existsSync(path.join(repo, 'd0', 'new0.txt')),
    };
    out.ok =
      out.verify.modifiedReverted &&
      out.verify.deletedRestored &&
      out.verify.addedRemoved &&
      !!(out.restore && out.restore.ok);
    console.log('[rewind] ' + JSON.stringify(out));
    log('rewind', JSON.stringify(out));
  } catch (e) {
    out.error = String((e && e.message) || e);
    console.log('[rewind] failed ' + out.error);
    log('rewind failed', out.error);
  } finally {
    try {
      fs.rmSync(checkpointSessionDir(sid), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(repo, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    setTimeout(() => app.quit(), 500);
  }
}

// R101：空闲功耗——静置时按秒采样主进程/渲染进程 CPU，并统计渲染层 rAF 是否还在跑。
// 交互基准发现不了「放着不动也在烧 CPU」的问题（遗留 setInterval、没停的动画循环）。
async function runIdle() {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const secs = (() => {
    const m = /--idle-secs=(\d+)/.exec(process.argv.join(' '));
    const n = m ? Number(m[1]) : 0;
    return n >= 10 && n <= 300 ? n : 60;
  })();
  const out = { secs, samples: [] };
  try {
    // QCODE_IDLE_FROM=0 时从启动就开始采样（用于观察后台补水窗口的 CPU）
    if (process.env.QCODE_IDLE_FROM === '0') {
      await wait(300);
    } else {
      await wait(6000); // 等启动收尾（备份已推迟到 20s，这里先看前 6 秒之后的稳态）
    }
    // 对照实验：QCODE_IDLE_NOMOTION=1 时注入全局「关动画」样式，用来判断空闲 CPU 是不是动画贡献的
    // 对照实验：QCODE_IDLE_PAUSED=1 模拟「窗口失焦」，验证 motion-paused 真的把动画停掉
    if (process.env.QCODE_IDLE_PAUSED === '1') {
      await mainWindow.webContents.executeJavaScript(
        "document.body.classList.add('motion-paused'); true"
      );
      await wait(1500);
    }
    if (process.env.QCODE_IDLE_NOMOTION === '1') {      await mainWindow.webContents.executeJavaScript(`
        (function () {
          const st = document.createElement('style');
          st.id = 'idle-nomotion';
          st.textContent = '*,*::before,*::after{animation:none!important;transition:none!important}';
          document.head.appendChild(st);
          return true;
        })()
      `);
      await wait(1500);
    }
    const rendererPid = mainWindow.webContents.getOSProcessId();
    const t0 = Date.now();
    // 渲染层 rAF 计数：空闲时若还在持续触发，说明有动画循环没停
    await mainWindow.webContents.executeJavaScript(`
      (function () {
        window.__idleRaf = 0;
        const orig = window.requestAnimationFrame.bind(window);
        window.requestAnimationFrame = (cb) => orig((ts) => { window.__idleRaf++; return cb(ts); });
        return true;
      })()
    `);
    for (let i = 0; i < secs; i++) {
      await wait(1000);
      const metrics = app.getAppMetrics();
      const mainM = metrics.find((m) => m.pid === process.pid);
      const rendM = metrics.find((m) => m.pid === rendererPid);
      let lazyLeft = -1;
      try {
        lazyLeft = await mainWindow.webContents.executeJavaScript(
          'state.sessions.filter(function (s) { return s && s.lazy; }).length'
        );
      } catch {
        lazyLeft = -1;
      }
      out.samples.push({
        t: i + 1,
        main: mainM && mainM.cpu ? +mainM.cpu.percentCPUUsage.toFixed(2) : -1,
        renderer: rendM && rendM.cpu ? +rendM.cpu.percentCPUUsage.toFixed(2) : -1,
        lazy: lazyLeft,
      });
    }
    out.wallMs = Date.now() - t0;
    out.rafDuringIdle = await mainWindow.webContents.executeJavaScript('window.__idleRaf || 0');
    const avg = (key) => {
      const vals = out.samples.map((s) => s[key]).filter((v) => v >= 0);
      return vals.length ? +(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2) : -1;
    };
    const max = (key) => {
      const vals = out.samples.map((s) => s[key]).filter((v) => v >= 0);
      return vals.length ? +Math.max(...vals).toFixed(2) : -1;
    };
    out.mainAvg = avg('main');
    out.mainMax = max('main');
    out.rendererAvg = avg('renderer');
    out.rendererMax = max('renderer');
    out.idleQuiet = out.mainAvg <= 1 && out.rendererAvg <= 1;
    console.log('[idle] ' + JSON.stringify(out));
    log('idle', JSON.stringify({ mainAvg: out.mainAvg, mainMax: out.mainMax, rendererAvg: out.rendererAvg, rendererMax: out.rendererMax, raf: out.rafDuringIdle, quiet: out.idleQuiet }));
  } catch (e) {
    out.error = String((e && e.message) || e);
    console.log('[idle] failed ' + out.error);
    log('idle failed', out.error);
  } finally {
    setTimeout(() => app.quit(), 400);
  }
}

// R113：破损安装演练——`--probe` 只读地检查启动后的关键状态（内核探测 / CLI 引导条 / 界面是否正常），
// 用于对比「完整安装」与「内核目录被删掉」两种情况。
async function runProbe() {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = {};
  try {
    await wait(4000); // 等 boot 完成后的 kernelStatus 探测（boot 里是 700ms）
    try {
      out.kernel = await mainWindow.webContents.executeJavaScript('window.shell.kernelStatus()');
    } catch (e) {
      out.kernel = { error: String((e && e.message) || e) };
    }
    out.dom = await mainWindow.webContents.executeJavaScript(
      "(function () {" +
        "var g = document.querySelector('.cli-guide');" +
        "return {" +
        "  guideShown: !!g," +
        "  guideText: g ? String(g.textContent || '').slice(0, 120) : ''," +
        "  statusText: (document.getElementById('statusText') || {}).textContent || ''," +
        "  threadNodes: document.querySelectorAll('#thread *').length," +
        "  sessions: (state && state.sessions ? state.sessions.length : -1)," +
        "  inputReady: !!document.getElementById('input')," +
        "};" +
        "})()"
    );
  } catch (e) {
    out.error = String((e && e.message) || e);
  }
  console.log('[probe] ' + JSON.stringify(out));
  log('probe', JSON.stringify(out));
  setTimeout(() => app.quit(), 400);
}

async function runBench() {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const t0 = Date.now();
  try {
    await wait(1500);
    // 主进程侧：几个启动期/高频 IO 的成本（与渲染层无关，单独计时）
    const mainTimings = {};
    let t = Date.now();
    await loadSessionsIndexed();
    mainTimings.sessionsListMs = Date.now() - t;
    t = Date.now();
    await refreshSessionIndex();
    mainTimings.refreshIndexMs = Date.now() - t;
    t = Date.now();
    const probeSessions = await loadSessionsIndexed();
    mainTimings.loadIndexedMs = Date.now() - t;
    mainTimings.sessionCount = probeSessions.length;
    t = Date.now();
    await getExtrasPayload().catch(() => null);
    mainTimings.extrasMs = Date.now() - t;
    t = Date.now();
    await getExtrasPayload().catch(() => null);
    mainTimings.extras2Ms = Date.now() - t;
    t = Date.now();
    await getExtrasPayload().catch(() => null);
    mainTimings.extras3Ms = Date.now() - t;
    t = Date.now();
    await listDirectory(path.join(WRITABLE_DIR, 'shots')).catch(() => null);
    mainTimings.listDirMs = Date.now() - t;
    // R98：启动后 3 秒会跑一次全量备份——大会话库下它是主进程的潜在停顿点，先量化
    try {
      const all = await loadSessions();
      mainTimings.sessionCount = all.length;
      t = Date.now();
      let bytes = 0;
      for (const s of all) {
        try {
          bytes += Buffer.byteLength(JSON.stringify(s), 'utf8');
        } catch {
          /* skip */
        }
      }
      mainTimings.backupStringifyMs = Date.now() - t;
      mainTimings.backupBytes = bytes;
      t = Date.now();
      await backupSessions(true).catch(() => null);
      mainTimings.backupFullMs = Date.now() - t;
    } catch (e) {
      mainTimings.backupError = String((e && e.message) || e);
    }

    log('bench main timings ' + JSON.stringify(mainTimings));

    const out = await mainWindow.webContents.executeJavaScript(`(async () => {
      const out = {};
      const bt = String.fromCharCode(96); // 反引号：外层是模板字符串，这里只能动态拼
      const timed = (fn) => {
        const t0 = performance.now();
        fn();
        return +(performance.now() - t0).toFixed(2);
      };
      // 固定"N 次总耗时 / N"的口径：单次 op 太短（<0.01ms）时 best-of 会被时钟分辨率吃掉
      const avg = (fn, n) => {
        fn();
        fn(); // warmup，避免把 JIT 编译算进首次
        const t0 = performance.now();
        for (let i = 0; i < n; i++) fn();
        return +((performance.now() - t0) / n).toFixed(4);
      };
      const step = (n) => { try { console.log('[bench] ' + n); } catch (e) {} };
      step('start');
      out.bootMs = Math.round(window.__bootMs || 0);
      out.scriptStartMs = Math.round(window.__scriptStart || 0);
      out.bootCalls = window.__bootCallMs || null;
      out.firstFrameMs = Math.round(window.__firstFrameMs || 0);
      out.initialLayoutMs = window.__initialLayoutMs == null ? -1 : window.__initialLayoutMs;
      // 启动分阶段：相邻 mark 的差值（ms），看时间到底花在哪一段
      {
        const bm = window.__bootMarks || {};
        const phases = {};
        let prev = 0;
        for (const k of Object.keys(bm)) {
          phases[k] = bm[k] - prev;
          prev = bm[k];
        }
        out.bootPhases = phases;
      }

      const savedSessions = state.sessions;
      const savedCurrent = state.current;
      const savedLimit = state.renderLimit.get(savedCurrent ? savedCurrent.id : '');
      const savedFloor = state.renderFloor.has(savedCurrent ? savedCurrent.id : '');

      // R84：懒加载预算与切换补全链路（用真实启动态测，必须在装合成会话之前）
      out.sessionCount = state.sessions.length;
      out.lazyAtFirstPaint = Number(window.__lazyAtFirstPaint) || 0;
      out.lazyAtBoot = state.sessions.filter(function (x) { return x && x.lazy; }).length;
      {
        const lazyOne = state.sessions.find(function (x) { return x && x.lazy; });
        if (lazyOne) {
          const tH = performance.now();
          await switchSession(lazyOne.id);
          out.lazyHydrateMs = +(performance.now() - tH).toFixed(2);
          out.lazySwitchOk = !lazyOne.lazy && (lazyOne.messages || []).length > 0;
        } else {
          out.lazyHydrateMs = 0;
          out.lazySwitchOk = true;
        }
        // 后台补水速率：先记 3 秒窗口内的吞吐，再继续等待到清零以取得总耗时
        // （R226：1500 会话库需要约 5 秒，原先 3 秒硬截断会让 lazyHydrateAllMs 恒为 null）
        {
          const before = state.sessions.filter(function (x) { return x && x.lazy; }).length;
          const hydrateStart = performance.now();
          let after = before;
          let at3s = null;
          // 补水期间的长任务：判断还能不能继续加大批量的依据
          let longTasks = 0;
          let maxGap = 0;
          let lastTick = hydrateStart;
          const obs = typeof PerformanceObserver === 'function' && PerformanceObserver.supportedEntryTypes && PerformanceObserver.supportedEntryTypes.indexOf('longtask') >= 0
            ? new PerformanceObserver(function (list) { longTasks += list.getEntries().length; })
            : null;
          if (obs) {
            try { obs.observe({ entryTypes: ['longtask'] }); } catch (e) { obs.disconnect(); }
          }
          do {
            await new Promise(function (r) { setTimeout(r, 50); });
            const now = performance.now();
            if (now - lastTick > maxGap) maxGap = now - lastTick;
            lastTick = now;
            after = state.sessions.filter(function (x) { return x && x.lazy; }).length;
            if (at3s === null && now - hydrateStart >= 3000) at3s = after;
          } while (after > 0 && performance.now() - hydrateStart < 20000);
          if (obs) { try { obs.disconnect(); } catch (e) {} }
          out.hydratedIn3s = before - (at3s === null ? after : at3s);
          out.lazyPendingAtHydrate = before;
          out.lazyRemaining = after;
          out.hydrateLongTasks = longTasks;
          out.hydrateMaxTickGapMs = Math.round(maxGap);
          out.lazyHydrateAllMs = after === 0 ? Math.round(performance.now() - hydrateStart) : null;
        }
      }

      // 1) 侧栏 500 会话（渲染 + 排序 + 分组）
      step('s1-sidebar');
      const many = [];
      for (let i = 0; i < 500; i++) {
        many.push({
          id: 'bench' + i,
          title: '会话 ' + i,
          cwd: state.defaultCwd,
          createdAt: Date.now() - i * 60000,
          updatedAt: Date.now() - i * 60000,
          messages: [{ role: 'user', text: 'hi' }, { role: 'assistant', text: 'ok' }],
        });
      }
      state.sessions = many;
      state.current = many[0];
      renderSidebar();
      out.sidebar500ms = timed(() => renderSidebar());

      // 2) 时间线 1000 条消息（窗口默认 120 条）
      const msgs = [];
      for (let i = 0; i < 1000; i++) {
        msgs.push(
          i % 2
            ? { role: 'assistant', text: '回复 ' + i, blocks: [{ type: 'text', text: '段落 ' + i + '，包含 **粗体** 与 ' + bt + 'code' + bt + '。' }], ts: 1 }
            : { role: 'user', text: '问题 ' + i, ts: 1 }
        );
      }
      many[1].messages = msgs;
      state.current = many[1];
      renderThread();
      out.threadWindowMs = timed(() => renderThread());

      // 3) markdown：8KB 混合文本，20 次取最优
      step('s3-markdown');
      const chunk =
        '## 小节\\n\\n' +
        '- 列表项 **加粗** 与 ' + bt + 'inline' + bt + '\\n' +
        '- 第二项 [链接](https://example.com/a_(b))\\n\\n' +
        '| a | b |\\n|---|---|\\n| 1 | 2 |\\n\\n' +
        '段落中文与 English 混排，包含 ~~删除线~~ 与普通文本。\\n\\n';
      let mdText = '';
      while (mdText.length < 8192) mdText += chunk;
      out.md8kCacheHitMs = avg(() => renderMarkdown(mdText), 200);
      out.md8kColdMs = avg(() => renderMarkdown(mdText + ' ', true), 100);

      // 4) 行内标记：1KB 行 × 2000 次
      let line = '';
      while (line.length < 1024) line += '普通 **粗** ' + bt + '行内' + bt + ' ~~删~~ ';
      out.inline1kMs = avg(() => inlineMarkup(line), 2000);

      // 5) HTML 转义：64KB × 500 次
      const raw = new Array(65537).join('x');
      out.esc64kMs = avg(() => esc(raw), 500);

      // 6) 表格 200×64
      const cols = [];
      for (let i = 0; i < 64; i++) cols.push('c' + i);
      const headRow = '| ' + cols.join(' | ') + ' |';
      const rows2 = [headRow, '| ' + cols.map(function () { return '---'; }).join(' | ') + ' |'];
      for (let i = 0; i < 200; i++) rows2.push(headRow);
      out.table200x64Ms = avg(() => renderTable(rows2), 20);

      // 7) 全文索引：500 会话 × 12 条消息，建索引 + 查询
      step('s7-index');
      state.sessions = many;
      for (const s of many) {
        s.messages = [];
        for (let i = 0; i < 12; i++) s.messages.push({ role: i % 2 ? 'assistant' : 'user', text: '消息内容 ' + s.id + ' 第 ' + i + ' 条 english words keyword' + (i % 3), ts: 1 });
      }
      state.fullTextIndex = new Map();
      state.fullTextIndexed = new Set();
      state.fullTextStampBySid = new Map();
      state.fullTextSessionWords = new Map();
      out.indexBuildMs = timed(() => {
        for (const s of many) {
          indexSessionMessages(state.fullTextIndex, s.id, s.messages, state.fullTextSessionWords);
          state.fullTextIndexed.add(s.id);
        }
      });
      out.indexQueryMs = avg(() => queryFullTextIndex(state.fullTextIndex, 'keyword1'), 2000);

      // R122：新功能「跨会话消息级搜索」的成本（索引命中 / 索引未命中 / 必须全量扫描的符号查询）
      out.globalSearchHitMs = timed(() => searchAllMessages('keyword1', 30).length);
      out.globalSearchMissMs = timed(() => searchAllMessages('zzzz-no-match-122', 30).length);
      out.globalSearchFallbackMs = timed(() => searchAllMessages('😀', 30).length);

      // 7b) 会话列表 IPC 的端到端成本（主进程读盘+parse + 结构化克隆 + 渲染层接收）
      {
        const t0 = performance.now();
        const arr = await window.shell.sessions.list();
        out.ipcSessionsWarmMs = +(performance.now() - t0).toFixed(2);
        out.ipcSessionsCount = Array.isArray(arr) ? arr.length : 0;
      }

      // 8) 流式事件：200 条 stream_event（打字机 + DOM 增量）
      step('s8-stream');
      const cur = many[2];
      state.current = cur;
      const r = rt(cur.id);
      r.busy = true;
      r.stream = { blocks: [], tools: {}, toolEls: {}, previewText: '', text: '' };
      renderThread();
      out.stream200Ms = timed(() => {
        for (let i = 0; i < 200; i++) {
          handleStreamEvent(cur, { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '流式文本片段' + i + ' ' } } }, true);
        }
      });
      r.busy = false;
      r.stream = null;

      // 9) 搜索：500 会话的侧栏过滤
      state.searchIndex = new Map();
      out.sidebarFilterMs = timed(() => {
        document.getElementById('search').value = 'keyword1';
        renderSidebar();
        document.getElementById('search').value = '';
      });

      // 10) 内存与 DOM 规模（长会话/多会话的常驻成本）
      step('s10-memory');
      try {
        const mem = performance.memory || {};
        out.heapMb = mem.usedJSHeapSize ? +(mem.usedJSHeapSize / 1048576).toFixed(1) : -1;
        out.domNodes = document.getElementsByTagName('*').length;
      } catch (e) {
        out.heapMb = -1;
        out.domNodes = -1;
      }

      // 11) 资源解析成本：脚本/CSS 的 load+parse（file:// 下 duration 近似解析耗时）
      try {
        const res = performance.getEntriesByType('resource') || [];
        const pick = (re) => {
          let ms = 0;
          for (const r of res) if (re.test(r.name)) ms += r.duration || 0;
          return +ms.toFixed(1);
        };
        out.scriptParseMs = pick(/\\.js$/);
        out.styleParseMs = pick(/\\.css$/);
        out.domContentMs = Math.round((performance.getEntriesByType('navigation')[0] || {}).domContentLoadedEventEnd || 0);
      } catch (e) {
        out.scriptParseMs = -1;
        out.styleParseMs = -1;
      }

      // 12) 工具密集的 1200 条窗口（R83 的上限档位）：每次 renderThread 的实际成本
      {
        const dense = [];
        for (let i = 0; i < 1200; i++) {
          if (i % 3 === 0) {
            dense.push({
              role: 'assistant',
              text: '',
              blocks: [
                { type: 'tool', id: 't' + i, name: 'run_shell_command', state: 'done', input: { command: 'echo ' + i }, output: new Array(4097).join('y'), durationMs: 12 },
                { type: 'tool', id: 'g' + i, name: 'read_file', state: 'done', input: { file_path: '/tmp/f' + i }, output: 'line\\n'.repeat(200) },
                { type: 'text', text: '说明 ' + i + '：**粗体** 与 ' + bt + 'code' + bt },
              ],
              ts: 1,
            });
          } else {
            dense.push({ role: 'user', text: '指令 ' + i, ts: 1 });
          }
        }
        many[3].messages = dense;
        state.current = many[3];
        // R85：上限已降到 800，这里测「当前上限窗口」与「一半窗口」两个参考点
        state.renderLimit.set(many[3].id, 800);
        renderThread();
        out.toolDenseCapMs = timed(() => renderThread());
        state.renderLimit.set(many[3].id, 400);
        renderThread();
        out.toolDense400Ms = timed(() => renderThread());
        const cacheProbe = [];
        for (let i = 0; i < 450; i++) cacheProbe.push({ name: 'run_shell_command', output: 'x'.repeat(2048), state: 'done' });
        for (const b of cacheProbe) toolOutHtml(b);
        const rebuildStart = performance.now();
        for (let cycle = 0; cycle < 3; cycle++) for (const b of cacheProbe) toolOutHtml(b);
        out.toolHtmlEvictRebuildMs = +((performance.now() - rebuildStart) / (cacheProbe.length * 3)).toFixed(3);
        out.toolHtmlCacheSize = toolOutHtmlCache.size;
        out.toolHtmlCacheWeight = toolOutHtmlCache.__weight || 0;
        state.renderLimit.delete(many[3].id);
        state.current = many[1];
      }

      // 13) 设置页各分区渲染成本（这是用户点开设置时的等待来源）
      try {
        state.sessions = savedSessions;
        state.current = savedCurrent;
        const tOpen = performance.now();
        await openSettings();
        out.cfgOpenMs = +(performance.now() - tOpen).toFixed(1);
        const tGen = performance.now();
        setCfgSection('general');
        out.cfgGeneralMs = +(performance.now() - tGen).toFixed(1);
        // 拆解 openSettings 的 53ms 到底花在哪：show 类切换 / loadExtras / 分区渲染
        {
          await closeSettings();
          const page = document.getElementById('settingsPage');
          let tSeg = performance.now();
          page.classList.add('show');
          document.body.classList.add('settings-open');
          void document.body.offsetHeight; // 强制布局：把显示设置页引起的样式重算/布局算进来
          out.cfgShowMs = +(performance.now() - tSeg).toFixed(1);
          tSeg = performance.now();
          JSON.parse(JSON.stringify(state.config || {}));
          out.cfgCloneMs = +(performance.now() - tSeg).toFixed(1);
          tSeg = performance.now();
          await loadExtras();
          out.cfgExtrasMs = +(performance.now() - tSeg).toFixed(1);
          tSeg = performance.now();
          setCfgSection('general');
          out.cfgGeneral2Ms = +(performance.now() - tSeg).toFixed(1);
          page.classList.remove('show');
          document.body.classList.remove('settings-open');
          await openSettings();
        }
        const sections = ['providers', 'usage', 'advanced', 'mcp', 'hooks'];
        out.cfgSectionMs = {};
        for (const sec of sections) {
          const t0 = performance.now();
          await setCfgSection(sec);
          out.cfgSectionMs[sec] = +(performance.now() - t0).toFixed(1);
        }
        // 把分区渲染从外壳里剥出来单独计时（区分「渲染本身」与「切分区/布局」）
        try {
          const host = document.createElement('div');
          document.body.appendChild(host);
          const t = (fn) => {
            const a = performance.now();
            fn();
            return +(performance.now() - a).toFixed(1);
          };
          out.cfgInner = {
            general: t(() => renderGeneralCfg(host)),
            prompts: t(() => renderPromptsCfg(host)),
            providers: t(() => renderProvidersCfg(host)),
            advanced: t(() => renderAdvancedCfg(host)),
            skills: t(() => renderSkillsCfg(host)),
          };
          host.remove();
          out.cfgDirtyMs = (() => {
            const a = performance.now();
            for (let i = 0; i < 50; i++) JSON.stringify(cfgDraft) !== JSON.stringify(state.config || {});
            return +((performance.now() - a) / 50).toFixed(3);
          })();
          out.cfgRules = document.styleSheets.length ? document.styleSheets[0].cssRules.length : -1;
        } catch (e) {
          out.cfgInner = { err: String((e && e.message) || e) };
        }
        await closeSettings();
      } catch (e) {
        out.cfgOpenMs = -1;
      }

      // 14) 长文本流式：600 个 delta（打字机 + 预览 DOM）
      {
        const cur2 = many[4];
        state.current = cur2;
        const r2 = rt(cur2.id);
        r2.busy = true;
        r2.stream = { blocks: [], tools: {}, toolEls: {}, previewText: '', text: '' };
        renderThread();
        out.streamLongMs = timed(() => {
          for (let i = 0; i < 600; i++) {
            handleStreamEvent(cur2, { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '长文本片段' + i + '，' } } }, true);
          }
        });
        r2.busy = false;
        r2.stream = null;
      }

      // 15) 逐键延迟：搜索框（800 会话）与输入框（2KB 草稿）
      {
        const searchEl = document.getElementById('search');
        const inputEl = document.getElementById('input');
        const many2 = [];
        for (let i = 0; i < 800; i++) {
          many2.push({
            id: 'ty' + i,
            title: '标题 ' + i,
            cwd: state.defaultCwd,
            createdAt: 1,
            updatedAt: 1,
            messages: [{ role: 'user', text: 'keyword ' + i, ts: 1 }],
          });
        }
        state.sessions = many2;
        state.current = many2[0];
        renderAll();
        const typeOnce = (el, value) => {
          el.value = value;
          el.dispatchEvent(new Event('input', { bubbles: true }));
        };
        let tType = performance.now();
        for (let i = 0; i < 20; i++) typeOnce(searchEl, ('keyword ' + i).slice(0, 7));
        out.searchTypingMs = +((performance.now() - tType) / 20).toFixed(2);
        searchEl.value = '';
        searchEl.dispatchEvent(new Event('input', { bubbles: true }));
        const draft = new Array(2049).join('草稿内容 ');
        tType = performance.now();
        for (let i = 0; i < 20; i++) typeOnce(inputEl, draft + i);
        out.composerTypingMs = +((performance.now() - tType) / 20).toFixed(2);
        inputEl.value = '';
        inputEl.dispatchEvent(new Event('input', { bubbles: true }));
        state.sessions = savedSessions;
        state.current = savedCurrent;
        renderAll();
      }

      // 16) 输入框逐键成本拆解（定位 6.6ms 的来源）
      {
        const inputEl = document.getElementById('input');
        inputEl.value = new Array(2049).join('草稿内容 ');
        const benchPart = (fn, n) => {
          const a = performance.now();
          for (let i = 0; i < n; i++) fn();
          return +((performance.now() - a) / n).toFixed(3);
        };
        out.composerParts = {
          autosize: benchPart(() => autosize(), 100),
          detect: benchPart(() => detectComposerCommand(), 100),
          sendBtn: benchPart(() => renderSendButton(), 100),
          mention: benchPart(() => scheduleMention(), 100),
          fullText: benchPart(() => composerFullText(), 100),
        };
        out.fieldSizing = !!(typeof CSS !== 'undefined' && CSS.supports && CSS.supports('field-sizing', 'content'));
        // 校验自适应高度仍然正确：5 行要长高，40 行要封顶在 180px 并可滚动
        {
          const oneLine = (() => {
            inputEl.value = '一行';
            inputEl.dispatchEvent(new Event('input', { bubbles: true }));
            return inputEl.getBoundingClientRect().height;
          })();
          inputEl.value = 'l1\\nl2\\nl3\\nl4\\nl5';
          inputEl.dispatchEvent(new Event('input', { bubbles: true }));
          const fiveLine = inputEl.getBoundingClientRect().height;
          inputEl.value = new Array(41).join('line\\n');
          inputEl.dispatchEvent(new Event('input', { bubbles: true }));
          const fortyLine = inputEl.getBoundingClientRect().height;
          out.inputGrow = {
            one: Math.round(oneLine),
            five: Math.round(fiveLine),
            forty: Math.round(fortyLine),
            scrolls: inputEl.scrollHeight > inputEl.clientHeight + 1,
          };
          out.inputGrowOk =
            fiveLine > oneLine + 10 && fortyLine <= 181 && fortyLine >= fiveLine && out.inputGrow.scrolls;
        }
        inputEl.value = '';
        inputEl.dispatchEvent(new Event('input', { bubbles: true }));
        state.sessions = savedSessions;
        state.current = savedCurrent;
        renderAll();
      }

      // 17) 会话落盘成本 vs 体积（流式期间每 120–200ms 会整条保存一次）
      {
        const mkSession = (nMsgs, chars) => {
          const msgs = [];
          const filler = new Array(Math.ceil(chars / 2) + 1).join('内容');
          for (let i = 0; i < nMsgs; i++) {
            msgs.push(
              i % 2
                ? { role: 'assistant', text: filler, blocks: [{ type: 'text', text: filler }], ts: 1 }
                : { role: 'user', text: 'q' + i, ts: 1 }
            );
          }
          return {
            id: 'bench_save_' + nMsgs + '_' + chars,
            title: 'save probe',
            cwd: state.defaultCwd,
            messages: msgs,
            createdAt: 1,
            updatedAt: 1,
          };
        };
        out.saveCost = {};
        for (const spec of [['small', 20, 200], ['mid', 200, 1000], ['big', 600, 4000]]) {
          const s = mkSession(spec[1], spec[2]);
          const bytes = JSON.stringify(s).length;
          const t0 = performance.now();
          await window.shell.sessions.save(s);
          const ms = performance.now() - t0;
          out.saveCost[spec[0]] = { mb: +(bytes / 1048576).toFixed(2), ms: +ms.toFixed(1) };
          try {
            await window.shell.sessions.remove(s.id);
          } catch (e) {}
        }
      }

      // 18) 全局重绘类交互：主题切换 / 侧栏折叠 / 切到大会话
      {
        // 主题切换（整页样式重算）
        const curTheme = localStorage.getItem('ui.theme') || 'light';
        let t0 = performance.now();
        applyTheme(curTheme === 'dark' ? 'light' : 'dark', false);
        void document.body.offsetHeight;
        out.themeSwitchMs = +(performance.now() - t0).toFixed(1);
        t0 = performance.now();
        applyTheme(curTheme, false);
        void document.body.offsetHeight;
        out.themeSwitchBackMs = +(performance.now() - t0).toFixed(1);

        // 侧栏折叠（布局大幅变化）
        const many3 = [];
        for (let i = 0; i < 800; i++) {
          many3.push({ id: 'sw' + i, title: '会话 ' + i, cwd: state.defaultCwd, createdAt: 1, updatedAt: 1, messages: [{ role: 'user', text: 'x', ts: 1 }] });
        }
        const keepSessions = state.sessions;
        const keepCurrent = state.current;
        state.sessions = many3;
        state.current = many3[0];
        renderAll();
        t0 = performance.now();
        toggleSidebar();
        void document.body.offsetHeight;
        out.sidebarToggleMs = +(performance.now() - t0).toFixed(1);
        t0 = performance.now();
        toggleSidebar();
        void document.body.offsetHeight;
        out.sidebarToggleBackMs = +(performance.now() - t0).toFixed(1);

        // 切到一个 5,000 条消息的大会话（真实用户最重的一次切换）
        {
          const big = { id: 'sw_big', title: '大会话', cwd: state.defaultCwd, createdAt: 1, updatedAt: 1, messages: [] };
          for (let i = 0; i < 5000; i++) {
            big.messages.push(
              i % 2
                ? { role: 'assistant', text: '回复 ' + i, blocks: [{ type: 'text', text: '段落 ' + i + ' 内容内容内容' }], ts: 1 }
                : { role: 'user', text: '问题 ' + i, ts: 1 }
            );
          }
          state.sessions.push(big);
          t0 = performance.now();
          await switchSession(big.id);
          out.switchBigSessionMs = +(performance.now() - t0).toFixed(1);
          state.renderLimit.delete(big.id);
          state.renderFloor.delete(big.id);
          state.runtimes.delete(big.id);
          const at = state.sessions.indexOf(big);
          if (at >= 0) state.sessions.splice(at, 1);
        }
        state.sessions = keepSessions;
        state.current = keepCurrent;
        renderAll();
      }

      // 19) 流式排版的重复渲染成本：已完成区域每新增一行就整段重排（疑似 O(n²)）
      {
        const host = document.createElement('div');
        document.body.appendChild(host);
        const st = { previewEl: host, previewText: '', twShown: null };
        out.typesetCost = {};
        for (const target of [2048, 8192, 32768]) {
          let text = '';
          while (text.length < target) text += '段落内容段落内容段落内容，包含 **粗体** 与 ' + bt + 'code' + bt + '。\\n';
          st.previewText = text + '正在输入的这一行';
          st.twShown = st.previewText.length;
          st.twSettledSig = '';
          st.twActiveSig = '';
          st.twSettledAt = 0; // 绕过限频，测「单次全量重排」真实成本（含 DOM 构建）
          const t0 = performance.now();
          typesetStreamPreview(st);
          out.typesetCost[String(target)] = +(performance.now() - t0).toFixed(1);
          // 底层 markdown 解析成本（不含 DOM），用于区分「解析」与「DOM 构建」
          const t1 = performance.now();
          renderMarkdown(text, true);
          if (!out.mdSettledFull) out.mdSettledFull = {};
          out.mdSettledFull[String(target)] = +(performance.now() - t1).toFixed(1);
        }
        // 一整轮 40KB 回复、每行触发一次的累计成本估算（按 32KB 档 × 行数）
        // R86：限频守卫——32KB 底文上连续 40 行到达，settled 区域最多重排 3 次（原实现 40 次）
        {
          const host2 = document.createElement('div');
          document.body.appendChild(host2);
          const st2 = { previewEl: host2, previewText: '', twShown: null };
          let base = '';
          while (base.length < 32768) base += '段落内容段落内容段落内容，包含 **粗体**。\\n';
          st2.previewText = base;
          st2.twShown = base.length;
          typesetStreamPreview(st2);
          st2.twSettledRenders = 0;
          for (let i = 0; i < 40; i++) {
            st2.previewText = base + '新行' + i + '\\n';
            st2.twShown = st2.previewText.length;
            typesetStreamPreview(st2);
          }
          out.typeset40Renders = st2.twSettledRenders;
          out.typesetThrottle = st2.twSettledRenders >= 0 && st2.twSettledRenders <= 3;
          host2.remove();
        }
        host.remove();
      }

      // 20) 内存曲线：懒加载桩 → 全部补水之后的堆占用（评估是否需要 LRU 释放老会话正文）
      {
        const lazyList = state.sessions.filter(function (x) { return x && x.lazy; });
        out.lazyBeforeHydrate = lazyList.length;
        out.heapBeforeHydrate = performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : -1;
        const memOf = async () => {
          try {
            return await window.shell.perf('bench-mem');
          } catch (e) {
            return null;
          }
        };
        out.memBeforeHydrate = await memOf();
        if (lazyList.length) {
          const t0 = performance.now();
          for (const s of lazyList) await ensureFullSession(s);
          out.hydrateAllMs = Math.round(performance.now() - t0);
        } else {
          out.hydrateAllMs = 0;
        }
        out.lazyAfterHydrate = state.sessions.filter(function (x) { return x && x.lazy; }).length;
        out.heapAfterHydrate = performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : -1;
        out.memAfterHydrate = await memOf();
        out.msgCountTotal = state.sessions.reduce(function (a, x) { return a + ((x && x.messages) || []).length; }, 0);
      }

      // 21) 工具分组：150 张连续工具卡的渲染与展开/收起成本
      {
        const blocks = [];
        for (let i = 0; i < 150; i++) {
          blocks.push({
            type: 'tool',
            id: 'tg' + i,
            name: 'read_file',
            state: 'done',
            input: { file_path: '/tmp/f' + i },
            output: new Array(201).join('x'),
          });
        }
        const gs = {
          id: 'tg_sess',
          title: 'tools',
          cwd: state.defaultCwd,
          createdAt: 1,
          updatedAt: 1,
          messages: [{ role: 'assistant', text: '', blocks, ts: 1 }],
        };
        state.sessions.push(gs);
        state.current = gs;
        renderThread();
        out.toolGroupRenderMs = timed(() => renderThread());
        const grp = document.querySelector('#thread .tool-group');
        out.toolGroupFound = !!grp;
        if (grp) {
          const t0 = performance.now();
          grp.querySelector('.tg-head').click();
          void document.body.offsetHeight;
          out.toolGroupOpenMs = +(performance.now() - t0).toFixed(1);
          const t1 = performance.now();
          grp.querySelector('.tg-head').click();
          void document.body.offsetHeight;
          out.toolGroupCloseMs = +(performance.now() - t1).toFixed(1);
          const host2 = document.createElement('div');
          appendBlocksGrouped(host2, blocks);
          const grp2 = host2.querySelector('.tool-group');
          const t2 = performance.now();
          grp2.querySelector('.tg-head').click();
          void document.body.offsetHeight;
          out.toolGroupCachedOpenMs = +(performance.now() - t2).toFixed(1);
        }
        state.sessions.splice(state.sessions.indexOf(gs), 1);
        state.current = many[0];
        renderAll();
      }

      // 22) 帧稳定性：模拟约 2 秒流式输出（每 16ms 一个 delta），统计帧间隔
      {
        const cur3 = many[5];
        state.current = cur3;
        const r3 = rt(cur3.id);
        r3.busy = true;
        r3.stream = { blocks: [], tools: {}, toolEls: {}, previewText: '', text: '' };
        renderThread();
        const frames = [];
        let last = performance.now();
        let running = true;
        const tick = (ts) => {
          frames.push(ts - last);
          last = ts;
          if (running) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
        const chunk = '这是流式输出的一段文本，包含 **加粗** 与 ' + bt + 'code' + bt + ' 以及中文标点。\\n';
        const tStart = performance.now();
        for (let i = 0; i < 120; i++) {
          handleStreamEvent(
            cur3,
            { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: chunk } } },
            true
          );
          await new Promise(function (res) {
            setTimeout(res, 16);
          });
        }
        const streamWall = performance.now() - tStart;
        running = false;
        await new Promise(function (res) {
          setTimeout(res, 60);
        });
        r3.busy = false;
        r3.stream = null;
        const sorted = frames.slice(2).sort(function (a, b) {
          return a - b;
        });
        const pick = function (p) {
          return +(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] || 0).toFixed(1);
        };
        out.frameStats = {
          n: sorted.length,
          wallMs: Math.round(streamWall),
          median: pick(0.5),
          p95: pick(0.95),
          max: +(sorted.length ? sorted[sorted.length - 1] : 0).toFixed(1),
          over20: sorted.filter(function (x) {
            return x > 20;
          }).length,
        };
        state.current = many[0];
        renderThread();
      }

      // 23) 侧栏整表重排成本（每轮开始/结束各一次；大会话库下是关键）
      {
        const t0 = performance.now();
        renderSidebar();
        out.sidebarFullMs = +(performance.now() - t0).toFixed(1);
        out.sidebarRows = document.querySelectorAll('#sessionList > *').length;
        out.sidebarSessions = state.sessions.length;
      }

      // 24) 大段粘贴：设置 200KB / 1MB 文本后派发 input 事件，量输入处理器同步成本
      {
        const inp = document.getElementById('input');
        const prev = inp.value;
        const mk = function (bytes) {
          const unit = '粘贴的大段文本一行内容 with english ';
          return new Array(Math.ceil(bytes / (unit.length + 1)) + 1).join(unit + String.fromCharCode(10));
        };
        out.pasteCost = {};
        out.pasteLen = {};
        for (const kb of [200, 1024]) {
          const text = mk(kb * 1024);
          out.pasteLen[String(kb)] = text.length;
          inp.value = text;
          const t0 = performance.now();
          inp.dispatchEvent(new Event('input', { bubbles: true }));
          out.pasteCost[String(kb)] = +(performance.now() - t0).toFixed(1);
        }
        inp.value = prev;
        inp.dispatchEvent(new Event('input', { bubbles: true }));
      }

      // 25) 草稿落盘：localStorage 写入包含当前输入全文（400ms 防抖），大段粘贴下可能很贵
      {
        const cur = many[0];
        const prevDrafts = state.drafts;
        const unit = '大段草稿行内容 with english ';
        const big = new Array(Math.ceil((1024 * 1024) / (unit.length + 1)) + 1).join(unit + String.fromCharCode(10));
        state.drafts = {};
        state.drafts[cur.id] = big;
        state.current = cur;
        const t0 = performance.now();
        persistDrafts();
        out.draftPersist1MbMs = +(performance.now() - t0).toFixed(1);
        // 对照：正常大小草稿
        state.drafts = {};
        state.drafts[cur.id] = '普通草稿内容';
        const t1 = performance.now();
        persistDrafts();
        out.draftPersistSmallMs = +(performance.now() - t1).toFixed(1);
        state.drafts = prevDrafts;
        state.current = many[0];
        try {
          persistDrafts();
        } catch (e) {
          /* ignore */
        }
      }

      // 26) 超大单会话冷开：构造 ~20MB 会话 → 落盘 → sessions:get（主进程读+解析+克隆）→ switchSession
      if (!${BENCH_SKIP_HUGE}) {
        const unit = '这是一行比较长的回复内容，用于制造超大单会话的压测数据。';
        const block = new Array(71).join(unit); // 约 2000 字符/条
        const huge = { id: 'huge_sess', title: 'huge', cwd: state.defaultCwd, createdAt: 1, updatedAt: 1, messages: [] };
        for (let i = 0; i < 3400; i++) {
          huge.messages.push(
            i % 2
              ? { role: 'assistant', text: block, blocks: [{ type: 'text', text: block }], ts: 1 }
              : { role: 'user', text: block, ts: 1 }
          );
        }
        out.hugeMb = +(JSON.stringify(huge).length / 1048576).toFixed(2);
        const tSave = performance.now();
        await window.shell.sessions.save(huge);
        out.hugeSaveMs = +(performance.now() - tSave).toFixed(1);
        // 主进程写盘是 200ms 防抖，必须等落盘完成再测冷读
        await new Promise(function (res) {
          setTimeout(res, 450);
        });
        const tGet = performance.now();
        const got = await window.shell.sessions.get('huge_sess');
        out.hugeGetMs = +(performance.now() - tGet).toFixed(1);
        out.hugeOk = !!(got && got.ok && got.session && got.session.messages.length === 3400);
        state.sessions.push({
          id: 'huge_sess',
          title: 'huge',
          cwd: state.defaultCwd,
          createdAt: 1,
          updatedAt: 1,
          lazy: false,
          messages: (got && got.session && got.session.messages) || huge.messages,
        });
        const tSwitch = performance.now();
        await switchSession('huge_sess');
        out.hugeSwitchMs = +(performance.now() - tSwitch).toFixed(1);
        out.hugeDom = document.getElementsByTagName('*').length;
        // R123：大数据会话导出——分别量 HTML / PDF 打印版生成成本与产物体积
        let exportHtml = '';
        let printHtml = '';
        out.exportHtmlMs = timed(() => {
          exportHtml = sessionToHtmlFile(state.current);
        });
        out.exportHtmlMb = +(exportHtml.length / 1048576).toFixed(2);
        out.exportPdfHtmlMs = timed(() => {
          printHtml = sessionToPrintHtml(state.current);
        });
        out.exportPdfHtmlMb = +(printHtml.length / 1048576).toFixed(2);
        // 只保留前 200 条消息的打印版给主进程测真实 printToPDF，避免一次生成上千页把基准跑爆
        window.__benchPdfHtml = sessionToPrintHtml({
          ...state.current,
          messages: (state.current.messages || []).slice(0, 200),
        });
        exportHtml = '';
        printHtml = '';
        state.sessions = state.sessions.filter(function (x) {
          return x.id !== 'huge_sess';
        });
        state.current = many[0];
        renderAll();
        try {
          await window.shell.sessions.remove('huge_sess');
        } catch (e) {}
      }

      // 27) 超长单消息：~1MB 正文的渲染与搜索高亮成本
      {
        const longText = new Array(500001).join('内容') + '目标命中';
        const ls = {
          id: 'bench_long_msg',
          title: 'long message',
          cwd: state.defaultCwd,
          createdAt: 1,
          updatedAt: 1,
          messages: [{ role: 'assistant', text: longText, blocks: [{ type: 'text', text: longText }], ts: 1 }],
        };
        state.sessions.push(ls);
        state.current = ls;
        out.longMsgRenderMs = timed(() => renderThread());
        out.longMsgChars = longText.length;
        out.longMsgHighlightMs = timed(() => highlightInMessage(ls.id, 0, '目标命中'));
        out.longMsgHighlightCount = document.querySelectorAll('#thread .jump-hit').length;
        clearJumpHighlight();
        state.sessions = state.sessions.filter(function (x) {
          return x.id !== ls.id;
        });
        state.runtimes.delete(ls.id);
        state.renderLimit.delete(ls.id);
        state.renderFloor.delete(ls.id);
        state.current = many[0];
        renderAll();
      }

      // 28) 图片附件：2MB / 8MB 截图 → FileReader 转 base64 → IPC 落盘 → 缩略图（粘贴截图是常见操作）
      {
        const mkPng = function (bytes) {
          // 造一个内容随机的 PNG-ish 字节流（不需要真解码，只测传输/落盘/缩略图失败路径外的成本）
          const arr = new Uint8Array(bytes);
          for (let i = 0; i < arr.length; i += 4096) arr[i] = i & 255;
          return new File([arr], 'paste-probe.png', { type: 'image/png' });
        };
        out.attachCost = {};
        for (const mb of [2, 8]) {
          const file = mkPng(mb * 1024 * 1024);
          const t0 = performance.now();
          const dataUrl = await fileToDataUrl(file);
          const tData = performance.now() - t0;
          const t1 = performance.now();
          const res = await window.shell.saveAttachment({
            name: 'probe-' + mb + 'mb.png',
            mime: 'image/png',
            dataBase64: (dataUrl || '').split(',')[1] || '',
          });
          const tIpc = performance.now() - t1;
          const t2 = performance.now();
          try {
            await makeThumbFromFile(file);
          } catch (e) {
            /* 假 PNG 解码失败属预期 */
          }
          const tThumb = performance.now() - t2;
          out.attachCost[String(mb)] = {
            dataUrlMs: +tData.toFixed(1),
            ipcMs: +tIpc.toFixed(1),
            thumbMs: +tThumb.toFixed(1),
            ok: !!(res && res.ok),
          };
          // 清理交给主进程基准收尾（没有 removeAttachment API）
        }
      }

      // 恢复现场
      state.sessions = savedSessions;
      state.current = savedCurrent;
      state.fullTextIndex = new Map();
      state.fullTextIndexed = new Set();
      state.fullTextStampBySid = new Map();
      state.fullTextSessionWords = new Map();
      state.searchIndex = new Map();
      if (savedCurrent) {
        if (savedLimit == null) state.renderLimit.delete(savedCurrent.id);
        else state.renderLimit.set(savedCurrent.id, savedLimit);
        if (!savedFloor) state.renderFloor.delete(savedCurrent.id);
      }
      renderAll();
      scheduleFullTextIndex();
      return out;
    })()`);
    // R118：清掉附件基准留下的探针图片（渲染层没有删除附件的 API）
    try {
      for (const f of fs.readdirSync(ATTACH_DIR)) {
        if (/^probe-\d+mb\.png$/.test(f)) fs.rmSync(path.join(ATTACH_DIR, f), { force: true });
      }
    } catch (e) {
      /* ignore */
    }
    // R110：窗口缩放成本——每次改尺寸后强制一次布局，量重排耗时（帧间隔会被遮挡节流污染，不适合）
    try {
      const base = mainWindow.getBounds();
      // 长任务观察器：缩放期间若出现 >50ms 的同步任务，说明重排/脚本真的卡住了
      await mainWindow.webContents.executeJavaScript(`
        (function () {
          window.__longTasks = [];
          try {
            window.__longTaskObs = new PerformanceObserver(function (l) {
              for (const e of l.getEntries()) {
                window.__longTasks.push({ start: Math.round(e.startTime), dur: Math.round(e.duration) });
              }
            });
            window.__longTaskObs.observe({ entryTypes: ['longtask'] });
            window.__resizeSteps = [];
          } catch (e) {
            /* 不支持则忽略 */
          }
          return true;
        })()
      `);
      const layoutMs = [];
      for (let i = 0; i < 10; i++) {
        mainWindow.setBounds({
          x: base.x,
          y: base.y,
          width: base.width + (i % 2 === 0 ? 60 : -60),
          height: base.height + (i % 2 === 0 ? 40 : -40),
        });
        await new Promise((r) => setTimeout(r, 70));
        const ms = await mainWindow.webContents.executeJavaScript(
          '(function(){var t=performance.now();void document.body.offsetHeight;return +(performance.now()-t).toFixed(1);})()'
        );
        layoutMs.push(ms);
        try {
          await mainWindow.webContents.executeJavaScript('(window.__resizeSteps=window.__resizeSteps||[]).push(Math.round(performance.now())); true');
        } catch (e2) {}
      }
      mainWindow.setBounds(base);
      await new Promise((r) => setTimeout(r, 200));
      const longTasks = (await mainWindow.webContents.executeJavaScript('window.__longTasks || []')) || [];
      const sorted = layoutMs.slice().sort((a, b) => a - b);
      mainTimings.resizeLayouts = sorted.length;
      mainTimings.resizeLayoutMedianMs = sorted.length ? sorted[Math.floor(sorted.length / 2)] : -1;
      mainTimings.resizeLayoutMaxMs = sorted.length ? sorted[sorted.length - 1] : -1;
      mainTimings.resizeLongTasks = longTasks.length;
      mainTimings.resizeLongMaxMs = longTasks.length ? Math.max.apply(null, longTasks.map((x) => x.dur)) : 0;
      mainTimings.resizeLongDetail = longTasks.slice(0, 5);
      try {
        mainTimings.resizeSteps = await mainWindow.webContents.executeJavaScript('window.__resizeSteps || []');
      } catch (e3) {}
    } catch (e) {
      mainTimings.resizeError = String((e && e.message) || e);
    }
    // R123：超长单消息的搜索高亮成本（TreeWalker + 文本匹配）
    try {
      const html = await mainWindow.webContents.executeJavaScript('window.__benchPdfHtml || ""');
      const tPdf = Date.now();
      const pdf = await htmlToPdfBuffer(html);
      mainTimings.exportPdf200MsgsMs = Date.now() - tPdf;
      mainTimings.exportPdf200MsgsBytes = pdf && pdf.ok ? pdf.buffer.length : 0;
      mainTimings.exportPdf200MsgsOk = !!(pdf && pdf.ok);
      await mainWindow.webContents.executeJavaScript('window.__benchPdfHtml = ""; true');
    } catch (e) {
      mainTimings.exportPdfError = String((e && e.message) || e);
    }
    console.log('[bench] renderer ' + JSON.stringify(out));
    console.log('[bench] main ' + JSON.stringify({ ...mainTimings, wallMs: Date.now() - t0, readyMs: Date.now() - BOOT_T0 }));
    try {
      const decomp = await benchBootDecomposition();
      console.log('[bench] decomposition ' + JSON.stringify(decomp));
    } catch (e) {
      console.log('[bench] decomposition failed ' + String((e && e.message) || e));
    }
    log('bench', JSON.stringify({ renderer: out, main: mainTimings }));
  } catch (e) {
    console.error('[bench] failed', e);
  } finally {
    setTimeout(() => app.quit(), 400);
  }
}

async function runPerfSmoke() {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    await wait(1600);
    const out = await mainWindow.webContents.executeJavaScript(`(async () => {
      // R73（监工D）：记录用户原主题——冒烟的 dark→light 往返会污染 localStorage['ui.theme']
      window.__origTheme = localStorage.getItem('ui.theme');
      const t0 = performance.now();
      renderThread();
      const threadPaint = performance.now() - t0;
      const gpu = await window.shell.gpu();
      return { threadPaint, gpu: !!(gpu && gpu.ok), hardware: gpu && !gpu.disableGpu };
    })()`);
    console.log('[smoke:perf]', JSON.stringify(out));
    log('smoke perf', JSON.stringify(out));
  } catch (e) {
    console.error('[smoke:perf] failed', e);
  } finally {
    setTimeout(() => app.quit(), 500);
  }
}

async function runSmoke() {
  const shotDir = path.join(WRITABLE_DIR, 'shots');
  fs.mkdirSync(shotDir, { recursive: true });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  let originalEffort;
  try {
    originalEffort = (readQwenSettings().model || {}).reasoningEffort;
  } catch {
    originalEffort = undefined;
  }
  let mainEffortOk = false;
  let providerAllOk = false;

  // 轮询等待渲染层条件成立，避免固定 sleep 造成的错位
  const until = async (expr, timeoutMs = 15000) => {
    try {
      return await mainWindow.webContents.executeJavaScript(
        `new Promise((resolve) => {
           const started = Date.now();
           const tick = () => {
             let ok = false;
             try { ok = !!(${expr}); } catch (e) { ok = false; }
             if (ok) return resolve(true);
             if (Date.now() - started > ${timeoutMs}) return resolve(false);
             setTimeout(tick, 60);
           };
           tick();
         })`
      );
    } catch {
      return false;
    }
  };

  try {
    await wait(1500);
    await mainWindow.webContents.capturePage().then((img) => {
      fs.writeFileSync(path.join(shotDir, '01-empty.png'), img.toPNG());
    });
    mainWindow.webContents.send('smoke:start');
    await wait(600);
    const smokeSid = await mainWindow.webContents.executeJavaScript(
      'state.current && state.current.id'
    );
    // 等这一轮真正结束（result 事件）再截图，避免截在工具执行中间
    let finished = await waitForTurn(120000);
    if (!finished) {
      log('smoke turn timeout, retry plain turn');
      try {
        await mainWindow.webContents.executeJavaScript('stopTurn()');
      } catch {
        /* ignore */
      }
      await wait(600);
      await mainWindow.webContents.executeJavaScript(
        "document.getElementById('input').value = '只回复两个字：完成'; send();"
      );
      finished = await waitForTurn(60000);
    }
    log('smoke turn finished', String(finished));
    const mainAgent = smokeSid ? agents.get(smokeSid) : null;
    mainEffortOk = !!(mainAgent && mainAgent.appliedEffort === 'low');
    log('smoke effort applied', String(mainAgent && mainAgent.appliedEffort));
    console.log(
      '[smoke] effort applied:',
      mainAgent && mainAgent.appliedEffort ? mainAgent.appliedEffort : 'none',
      mainEffortOk ? 'ok' : 'FAILED'
    );
    await wait(500);
    await mainWindow.webContents.capturePage().then((img) => {
      fs.writeFileSync(path.join(shotDir, '02-chat.png'), img.toPNG());
    });

    mainWindow.webContents.send('smoke:settings');
    await until("document.getElementById('settingsPage') && document.getElementById('settingsPage').classList.contains('show')");
    await wait(800);
    await mainWindow.webContents.capturePage().then((img) => {
      fs.writeFileSync(path.join(shotDir, '03-settings.png'), img.toPNG());
    });

    await mainWindow.webContents.executeJavaScript("setCfgSection('providers')");
    await until("document.querySelectorAll('#pList .p-item').length > 0");
    await wait(600);
    await mainWindow.webContents.capturePage().then((img) => {
      fs.writeFileSync(path.join(shotDir, '04-providers.png'), img.toPNG());
    });

    // 供应商分组编辑表单截图
    await mainWindow.webContents.executeJavaScript(
      "(() => { const b = document.querySelector('#pList .p-group-edit'); if (b) b.click(); })()"
    );
    await wait(260);
    await mainWindow.webContents.capturePage().then((img) => {
      fs.writeFileSync(path.join(shotDir, '04b-provider-edit.png'), img.toPNG());
    });
    await mainWindow.webContents.executeJavaScript(
      "(() => { const b = document.querySelector('.p-group-form [data-act=cancel]'); if (b) b.click(); })()"
    );
    await wait(120);

    // 真点一次「测连接」，验证 provider 连通性检测走通 IPC → fetch
    await mainWindow.webContents.executeJavaScript(
      "(() => { const b = document.querySelector('#pList .p-test'); if (b) b.click(); })()"
    );
    await until(
      "!!document.querySelector('#pList .p-badge.test-ok, #pList .p-badge.test-warn, #pList .p-badge.test-err')",
      20000
    );
    await wait(300);
    await mainWindow.webContents.capturePage().then((img) => {
      fs.writeFileSync(path.join(shotDir, '05-provider-test.png'), img.toPNG());
    });

    // 从端点选择模型弹层截图
    await mainWindow.webContents.executeJavaScript(
      "(() => { const b = document.querySelector('#pList .p-group-add'); if (b) b.click(); })()"
    );
    await wait(100);
    await mainWindow.webContents.executeJavaScript(
      "(() => { const b = [...document.querySelectorAll('.pop-menu button')].find(x => x.textContent.includes('从端点选择')); if (b) b.click(); })()"
    );
    await until("document.querySelectorAll('.model-picker-mask .mp-row').length > 0", 20000);
    await wait(300);
    await mainWindow.webContents.capturePage().then((img) => {
      fs.writeFileSync(path.join(shotDir, '05b-model-picker.png'), img.toPNG());
    });
    await mainWindow.webContents.executeJavaScript(
      "(() => { const b = document.querySelector('.model-picker-mask [data-close]'); if (b) b.click(); })()"
    );

    // 「测试全部模型」逐个真实发最小对话；「测端点」只请求一次 /models
    configModelTestRequests = 0;
    const expectedModels = await mainWindow.webContents.executeJavaScript(
      "(cfgDraft.modelProviders.openai || []).filter(p => p.baseUrl && p.id).length"
    );
    await mainWindow.webContents.executeJavaScript(
      "(() => { const b = document.getElementById('pTestAll'); if (b) b.click(); })()"
    );
    providerAllOk = await until(
      `(() => {
         const total = document.querySelectorAll('#pList .p-test').length;
         const done = document.querySelectorAll('#pList .p-badge.test-ok, #pList .p-badge.test-warn, #pList .p-badge.test-err').length;
         return total > 0 && done >= total;
       })()`,
      60000
    );
    providerAllOk = providerAllOk && configModelTestRequests === expectedModels;
    log(
      'smoke model test all',
      'requests',
      configModelTestRequests,
      'models',
      expectedModels,
      'ok',
      String(providerAllOk)
    );
    console.log(
      '[smoke] model test all:',
      'requests=' + configModelTestRequests,
      'models=' + expectedModels,
      providerAllOk ? 'ok' : 'FAILED'
    );

    // 组头「测端点」只发一次 /models，与逐模型真实测试分开
    configTestRequests = 0;
    await mainWindow.webContents.executeJavaScript(
      "(() => { const b = document.querySelector('#pList .p-endpoint-test'); if (b) b.click(); })()"
    );
    const endpointDone = await until(
      "(() => { const b = document.querySelector('#pList .p-endpoint-test'); return !!b && b.textContent === '测端点' && !b.disabled; })()",
      30000
    );
    const endpointStatusOk =
      endpointDone &&
      (await mainWindow.webContents.executeJavaScript(
        "(() => { const s = document.querySelector('#pList .p-group-status'); return !!s && !s.hidden && s.classList.contains('ok') && s.textContent.indexOf('/') > 0; })()"
      ));
    const providerEndpointOk = endpointDone && configTestRequests === 1 && !!endpointStatusOk;
    log(
      'smoke endpoint test',
      'requests',
      configTestRequests,
      'ok',
      String(providerEndpointOk)
    );
    console.log(
      '[smoke] endpoint test:',
      'requests=' + configTestRequests,
      providerEndpointOk ? 'ok' : 'FAILED'
    );
    providerAllOk = providerAllOk && providerEndpointOk;

    for (const [sec, file] of [
      ['mcp', '06-mcp.png'],
      ['hooks', '06b-hooks.png'],
      ['usage', '07-usage.png'],
      ['memory', '08-memory.png'],
      ['advanced', '09-advanced.png'],
      ['skills', '09b-skills.png'],
      ['commands', '09c-commands.png'],
      ['appearance', '09d-appearance.png'],
      ['shortcuts', '09e-shortcuts.png'],
    ]) {
      await mainWindow.webContents.executeJavaScript(`setCfgSection('${sec}')`);
      if (sec === 'usage') await until('state.extras && state.extras.usage', 5000);
      await wait(600);
      await mainWindow.webContents.capturePage().then((img) => {
        fs.writeFileSync(path.join(shotDir, file), img.toPNG());
      });
    }

    // 新增交互：@ 文件提及 / Ctrl+K 面板 / 深色主题
    await mainWindow.webContents.executeJavaScript(`
      (() => {
        closeSettings();
        const input = document.getElementById('input');
        input.value = '@';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.focus();
      })()
    `);
    await until("document.getElementById('mentionMenu') && document.getElementById('mentionMenu').classList.contains('show')", 8000);
    await wait(400);
    await mainWindow.webContents.capturePage().then((img) => {
      fs.writeFileSync(path.join(shotDir, '10-mentions.png'), img.toPNG());
    });
    await mainWindow.webContents.executeJavaScript(
      'closeComposerMenu(); document.getElementById("input").value = ""; autosize();'
    );

    await mainWindow.webContents.executeJavaScript('openPalette()');
    await until("document.getElementById('palette') && document.getElementById('palette').classList.contains('show')", 8000);
    await wait(700);
    await mainWindow.webContents.capturePage().then((img) => {
      fs.writeFileSync(path.join(shotDir, '11-palette.png'), img.toPNG());
    });
    await mainWindow.webContents.executeJavaScript("document.getElementById('paletteQuery').value = '设置'; document.getElementById('paletteQuery').dispatchEvent(new Event('input', {bubbles:true}))");
    await wait(600);
    await mainWindow.webContents.capturePage().then((img) => {
      fs.writeFileSync(path.join(shotDir, '11b-palette-filter.png'), img.toPNG());
    });
    await mainWindow.webContents.executeJavaScript('closePalette()');

    await mainWindow.webContents.executeJavaScript("setTheme('dark')");
    await wait(600);
    await mainWindow.webContents.capturePage().then((img) => {
      fs.writeFileSync(path.join(shotDir, '12-dark.png'), img.toPNG());
    });
    await mainWindow.webContents.executeJavaScript("setTheme('light')");
    await wait(300);
    // 巡检：逐个分区渲染，body 为空即视为失败
    const report = await mainWindow.webContents.executeJavaScript(`
      (async () => {
        const bad = [];
        for (const sec of ['general','prompts','providers','mcp','hooks','memory','skills','commands','usage','advanced','appearance','shortcuts','about']) {
          setCfgSection(sec);
          await new Promise(r => setTimeout(r, 120));
          const n = document.getElementById('cfgBody').children.length;
          if (!n) bad.push(sec);
        }
        setCfgSection('general');
        return bad;
      })()
    `);
    log('smoke section check', JSON.stringify(report));
    console.log('[smoke] sections empty:', JSON.stringify(report));

    // 停止链路：真实发起一个必然长流式的回合，中断后验证状态与截图
    mainWindow.webContents.send('smoke:stop-test');
    await wait(3500);

    // 忙碌时发送应排队，停止时应清空排队
    const queueCheck = await mainWindow.webContents.executeJavaScript(`
      (() => {
        const s = state.current;
        const before = state.queue[s.id] ? state.queue[s.id].length : 0;
        document.getElementById('input').value = '排队消息';
        send();
        const after = state.queue[s.id] ? state.queue[s.id].length : 0;
        return {
          before,
          after,
          shown: (document.getElementById('tokensText').textContent || '').includes('排队'),
        };
      })()
    `);
    log('smoke queue check', JSON.stringify(queueCheck));

    await wait(800);
    await mainWindow.webContents.executeJavaScript('stopTurn()');
    const stoppedOk = await until(
      "document.getElementById('statusText') && document.getElementById('statusText').textContent === '已停止'",
      8000
    );
    const queueCleared = await mainWindow.webContents.executeJavaScript(
      'Object.keys(state.queue).length === 0'
    );
    log('smoke stop test', String(stoppedOk), 'queue cleared', String(queueCleared));
    console.log('[smoke] stop test:', stoppedOk ? 'ok' : 'FAILED', '| queued:', queueCheck.after, '| cleared:', queueCleared);
    await wait(500);
    await mainWindow.webContents.capturePage().then((img) => {
      fs.writeFileSync(path.join(shotDir, '13-stop.png'), img.toPNG());
    });

    // R227：检查点冒烟用独立小工作区，避免扫描仓库构建产物被截断
    let cpSmokeDir = '';
    try {
      cpSmokeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qcode-cp-smoke-'));
      fs.mkdirSync(path.join(cpSmokeDir, 'sub'), { recursive: true });
      fs.writeFileSync(path.join(cpSmokeDir, '_probe-write.txt'), 'write-probe-ok', 'utf8');
      fs.writeFileSync(path.join(cpSmokeDir, 'sub', 'keep.txt'), 'keep-ok', 'utf8');
    } catch {
      cpSmokeDir = '';
    }

    // 新功能回归断言：tokens 显示 / 重命名 / 置顶 / 设置搜索 / hooks / safe-mode
    const checks = await mainWindow.webContents.executeJavaScript(`
      (async () => {
        const out = {};
        // tokens 显示：切回有 usage 的主冒烟会话再读（停止测试会话没有 usage）
        // 会话可能是懒加载的，先补齐 messages；switchSession 是异步的，必须等渲染完成
        let withUsage = state.sessions.find((x) => (x.messages || []).some((m) => m.usage));
        if (!withUsage) {
          for (const x of state.sessions) {
            if (x.lazy) await ensureFullSession(x);
            if ((x.messages || []).some((m) => m.usage)) {
              withUsage = x;
              break;
            }
          }
        }
        if (withUsage) {
          await switchSession(withUsage.id);
          // R60：轮询等待 usage 落到消息与 tokensText 渲染（固定 220ms 偶发不够，r78 flake）
          for (let i = 0; i < 40; i++) {
            const ok =
              !!state.current &&
              (state.current.messages || []).some((m) => m.usage) &&
              !!document.getElementById('tokensText') &&
              !!document.getElementById('tokensText').textContent;
            if (ok) break;
            await new Promise((r) => setTimeout(r, 100));
          }
        }
        out.tokens =
          !!state.current &&
          (state.current.messages || []).some((m) => m.usage) &&
          !!document.getElementById('tokensText').textContent;
        // HTML 转义单遍优化：输出须与四遍替换一致（含 & < > " 与 null）
        out.escSinglePass =
          esc('a & b < c > d "e"') === 'a &amp; b &lt; c &gt; d &quot;e&quot;' &&
          esc(null) === '' &&
          esc('plain') === 'plain';
        // R82：CLI 引导条必须跨 renderThread 保留（host_error 先 showCliGuide 再 renderThread）
        out.cliGuidePersist = (() => {
          const s = state.current;
          if (!s) return false;
          const prevGuide = state.cliGuide;
          const prevDismissed = state.cliGuideDismissed;
          state.cliGuideDismissed = {};
          state.cliGuide = { sessionId: s.id, message: 'SmokeCliGuideProbe' };
          renderThread();
          const first = threadEl().querySelector('.cli-guide');
          const painted = !!first && first.textContent.includes('SmokeCliGuideProbe');
          renderThread();
          const still = !!threadEl().querySelector('.cli-guide');
          state.cliGuide = prevGuide;
          state.cliGuideDismissed = prevDismissed;
          renderThread();
          return painted && still;
        })();
        // R82：导出体积预估走正文累加，不对大对象做 stringify（5+3+10=18）
        out.exportEstimate =
          estimateSessionsChars([
            {
              messages: [
                { text: '12345', blocks: [{ text: '678' }], attachments: [{ thumb: '9'.repeat(10) }] },
              ],
            },
          ]) === 18;
        // R82：自动标题同名时追加序号（已有「同名」「同名 2」→ 新标题取「同名 3」）
        out.titleDedupe = (() => {
          const savedSessions = state.sessions;
          state.sessions = [{ id: 'a', title: '同名' }, { id: 'b', title: '同名 2' }];
          const t = uniqueSessionTitle('同名', 'c');
          state.sessions = savedSessions;
          return t === '同名 3';
        })();
        // R82：草稿修剪只保留仍存在的会话；断言后恢复 localStorage 原值，避免污染后续探针
        out.draftPrune = (() => {
          const savedSessions = state.sessions;
          const savedDrafts = state.drafts;
          const raw = localStorage.getItem('ui.drafts');
          state.sessions = [{ id: 'live' }];
          state.drafts = { live: 'keep', dead: 'drop' };
          const n = pruneDeadDrafts();
          const ok = n === 1 && state.drafts.live === 'keep' && !('dead' in state.drafts);
          state.sessions = savedSessions;
          state.drafts = savedDrafts;
          if (raw === null) localStorage.removeItem('ui.drafts');
          else localStorage.setItem('ui.drafts', raw);
          return ok;
        })();
        // R82：导出前疑似密钥扫描（提示不阻断正常会话导出）
        out.exportSecretScan =
          containsSuspectedSecret('{"apiKey":"abcdefgh12345678"}') === true &&
          containsSuspectedSecret('普通会话内容') === false;
        // R82：长文本块二次渲染不再重跑 markdown（缓存按 block 身份+原文命中）
        out.longBlockReuse = (() => {
          const b = { type: 'text', text: '长块复用探针'.repeat(160) };
          const before = mdCacheStats();
          blockElement(b);
          const mid = mdCacheStats();
          blockElement(b);
          const after = mdCacheStats();
          const first = mid.hits + mid.misses;
          const second = after.hits + after.misses;
          return first > before.hits + before.misses && second === first;
        })();
        // R82：行内代码内容不被 ** 二次排版
        out.mdInlineCodeGuard = (() => {
          const bt = String.fromCharCode(96);
          const html = renderMarkdown(bt + '**x**' + bt);
          return html.includes('<code class="inline">**x**</code>') && !html.includes('<strong>');
        })();
        // R82：未闭合围栏按代码块渲染到文本结尾（不再当普通段落解析）
        out.mdUnclosedFence = (() => {
          const bt = String.fromCharCode(96);
          const html = renderMarkdown(
            bt.repeat(3) + 'js' + String.fromCharCode(10) + 'const a = 1;'
          );
          return html.includes('class="code-wrap"') && html.includes('const a = 1;');
        })();
        // R82：表格列数归一化（表头 2 列、数据行 1 列 → 补 1 个空格子）
        out.mdTableCols = (() => {
          const nl = String.fromCharCode(10);
          const html = renderMarkdown(['| a | b |', '|---|---|', '| 1 |'].join(nl));
          return (html.match(/<th>/g) || []).length === 2 && (html.match(/<td>/g) || []).length === 2;
        })();
        // R78 监工U：typeof 存在性不算行为——用真实会话调用并断言返回结构 + 缓存命中
        out.searchCache = (() => {
          const real = state.current;
          if (!real) return false;
          const a = sessionSearchText(real);
          const b = sessionSearchText(real);
          return a === b && typeof a === 'string';
        })();
        const probeMsg = { role: 'user', text: 'CacheProbe Alpha' };
        const probeMsgA = messageSearchText(probeMsg);
        const probeMsgB = messageSearchText(probeMsg);
        out.searchMsgCache =
          probeMsgA === probeMsgB && probeMsgA.lower === 'cacheprobe alpha';
        // searchableText 单趟拼接：assistant 多文本块用空格连接、跳过工具块，user 取 text，hidden 为空
        out.searchableText =
          searchableText({ role: 'assistant', blocks: [{ type: 'text', text: '甲' }, { type: 'tool', name: 'x' }, { type: 'text', text: '乙' }] }) === '甲 乙' &&
          searchableText({ role: 'user', text: '提问' }) === '提问' &&
          searchableText({ role: 'user', text: 'x', hidden: true }) === '';
        const probeHit = findSessionMatch(
          {
            messages: [
              { role: 'user', text: 'first' },
              { role: 'user', text: 'second Alpha tail' },
            ],
          },
          'alpha'
        );
        out.searchMatch = probeHit.jump === 1 && probeHit.snippet.includes('Alpha');
        // searchGrouped：命中时间 / 两行上下文 / 同会话命中计数（纯函数探针）
        {
          const grp = findSessionMatch(
            {
              messages: [
                { role: 'user', text: 'Alpha 开头', ts: 1000 },
                { role: 'user', text: '中间无关', ts: 2000 },
                { role: 'assistant', blocks: [{ type: 'text', text: 'Alpha 后续上下文再补一段' }], ts: 3000 },
              ],
            },
            'alpha'
          );
          out.searchGrouped =
            grp.jump === 0 &&
            grp.ts === 1000 &&
            grp.totalHits === 2 &&
            grp.snippet.includes('Alpha') &&
            !!grp.snippet2 &&
            grp.snippet2.indexOf('Alpha') < 0;
        }
        // messageAnchor：链接生成/解析 + 渲染出的消息元素带右键定位能力
        out.messageAnchor = (() => {
          const link = makeMessageAnchor('s_abc123', 7);
          const p = parseMessageAnchor(link);
          const okParse = !!p && p.sid === 's_abc123' && p.mi === 7;
          const okBad = parseMessageAnchor('普通文本') === null &&
            parseMessageAnchor('qcode://msg/bad') === null &&
            // R78 监工U：R77「句中链接不误拦截」的回归输入——旧 indexOf 实现会命中这里
            parseMessageAnchor('参考 qcode://msg/s_abc123/7 这条消息') === null;
          const okLink = link.indexOf('qcode://msg/s_abc123/7') === 0;
          // 当前会话首条消息元素应挂了右键定位（通过 dataset.mi 与链接函数间接验证）
          const firstEl = document.querySelector('#thread .msg[data-mi]');
          return okParse && okBad && okLink && !!firstEl &&
            makeMessageAnchor('s_abc123', 7) === link;
        })();
        // globalSearchIndex：倒排索引建/查/多词 AND + 大库查询耗时（大纲阶段 6）
        {
          const idx = new Map();
          const t0 = Date.now();
          for (let i = 0; i < 50; i++) {
            indexSessionMessages(idx, 's_idx_' + i, [
              { role: 'user', text: i % 2 === 0 ? '工作目录 配置 alpha' : '无关内容 beta' },
              { role: 'assistant', blocks: [{ type: 'text', text: 'alpha 后续 gamma' }] },
            ]);
          }
          const r1 = queryFullTextIndex(idx, 'alpha');
          const r2 = queryFullTextIndex(idx, 'alpha 配置');
          const r3 = queryFullTextIndex(idx, '不存在xyz');
          const elapsed = Date.now() - t0;
          console.log('[smoke] perf: fullTextIndex=' + elapsed + 'ms sessions=50');
          out.globalSearchIndex =
            idx.size > 0 &&
            r1.size === 50 &&
            r2.size === 25 &&
            r3.size === 0 &&
            elapsed < 1000;
          // 索引失效优化：sid->words 反查只删该会话词，O(该会话词数) 而非 O(全词表)
          {
            const idx2 = new Map();
            const words = new Map();
            const mk = (sid, list) => indexSessionMessages(idx2, sid, [{ role: 'user', text: list }], words);
            mk('a', 'apple banana cherry');
            mk('b', 'apple date');
            const before = idx2.size;
            const removed = removeSessionFromIndex(idx2, 'a', words);
            out.indexInvalidateOptimized =
              removed > 0 &&
              idx2.size < before &&
              idx2.get('apple').has('b') && !idx2.get('apple').has('a') &&
              !idx2.has('banana') && !idx2.has('cherry') &&
              idx2.get('date').has('b') &&
              !words.has('a');
          }
          // R17：分词去空分支 + 查询交集免展开——token 与命中结果不变
          {
            const tk = tokenizeForIndex('工作目录 config 123');
            out.tokenizeLean = tk.has('工') && tk.has('作') && tk.has('工作') && tk.has('config') && tk.has('123') && !tk.has('工作目');
            const idx3 = new Map();
            indexSessionMessages(idx3, 'x', [
              { role: 'user', text: 'alpha beta gamma' },
              { role: 'assistant', blocks: [{ type: 'text', text: 'alpha gamma' }] },
              { role: 'user', text: 'alpha only' },
            ]);
            const inter = queryFullTextIndex(idx3, 'alpha gamma');
            out.queryIntersectLean = inter.size === 1 && inter.get('x').has(0) && inter.get('x').has(1) && !inter.get('x').has(2);
            // R20：非懒加载会话计数（无 filter 分配）
            out.countNonLazy = countNonLazySessions([{ lazy: false }, { lazy: true }, { lazy: false }, {}]) === 3 &&
              countNonLazySessions([]) === 0;
            // R25：归档数计数复用通用 countFlag（无 filter 分配）
            out.countFlag = countFlag([{ archived: true }, { archived: false }, { archived: true }], 'archived') === 2 &&
              countFlag([], 'x') === 0;
          }
        }
        out.effortApi = typeof window.shell.chat.setEffort === 'function';
        // 工具授权五档 + can_use_tool 控制协议（参考内核 CLI approval-mode 文档）
        out.approvalApi =
          typeof window.shell.chat.approval === 'function' &&
          typeof window.shell.onApproval === 'function' &&
          typeof window.shell.onApprovalClear === 'function';
        // 无挂起请求时裁决 IPC 必须安全返回布尔（不抛异常），保证卡片超时/竞态不拖垮渲染层
        out.approvalIpcSafe = await (async () => {
          try {
            const r = await window.shell.chat.approval(state.current.id, '__none__', true);
            return typeof r === 'boolean';
          } catch {
            return false;
          }
        })();
        out.approvalTiers =
          APPROVALS.length === 5 &&
          ['plan', 'default', 'auto-edit', 'auto', 'yolo'].every((m) =>
            APPROVALS.some((a) => a.mode === m)
          );
        {
          const modes = ['plan', 'default', 'auto-edit', 'auto', 'yolo'];
          const modeNames = ['只读规划', '逐项确认', '自动改文件', '智能放行', '完全放开'];
          // 渲染授权卡片并校验命令预览 + 允许/拒绝按钮，然后清理
          showApprovalCard({
            sessionId: state.current.id,
            requestId: 'smoke-req',
            toolName: 'run_shell_command',
            toolUseId: 'smoke-tool',
            input: { command: 'echo smoke' },
          });
          const card = document.getElementById('approval-card') ||
            document.querySelector('.approval-card');
          out.approvalCard =
            !!card &&
            /echo smoke/.test(card.textContent || '') &&
            !!card.querySelector('[data-approval-allow]') &&
            !!card.querySelector('[data-approval-deny]');
          // 键盘可达：role/aria + Enter=允许 / Esc=拒绝（对齐 ZCode/Claude Code 权限弹层）
          out.approvalKeyNav =
            !!card && card.getAttribute('role') === 'group' &&
            card.getAttribute('aria-label') === '工具授权确认' &&
            typeof card.onkeydown === 'function' &&
            approvalKeyAction({ key: 'Enter' }) === 'allow' &&
            approvalKeyAction({ key: 'Escape' }) === 'deny' &&
            approvalKeyAction({ key: 'a' }) === null;
          // 重绘后卡片应从 state.pendingApproval 恢复（切会话/流式刷新不丢授权入口）
          renderThread();
          out.approvalPersist = !!document.querySelector('.approval-card');
          // 挂起授权时侧栏会话项应显示"等待授权"状态点（切到别的会话也能看到）
          out.approvalDot = !!document.querySelector('.session-item .approval-dot');
          clearApprovalCard();
          out.approvalClean = !document.querySelector('.approval-card');
          out.approvalDotCleared = !document.querySelector('.approval-dot');
          out.approvalTierLabels = modes.every(
            (m, i) => (APPROVALS.find((a) => a.mode === m) || {}).label === modeNames[i]
          );
        }
        out.effortChip =
          !!document.getElementById('chipEffort') &&
          /思考/.test((document.getElementById('effortText') || {}).textContent || '');
        document.getElementById('chipEffort').click();
        await new Promise((r) => setTimeout(r, 80));
        const effLabels = [...document.querySelectorAll('.pop-menu button')].map(
          (b) => b.textContent
        );
        out.effortMenu =
          effLabels.length === 6 &&
          effLabels.some((t) => t.includes('低')) &&
          effLabels.some((t) => t.includes('最大'));
        closeMenu();
        const effPrev = state.current.reasoningEffort;
        state.current.reasoningEffort = 'high';
        renderComposer();
        out.effortLabel = ((document.getElementById('effortText') || {}).textContent || '').includes(
          '高'
        );
        state.current.reasoningEffort = effPrev;
        renderComposer();
        const winPrev = state.current;
        const winId = 's_winprobe_' + Date.now().toString(36);
        const winMsgs = [];
        for (let i = 0; i < 30; i++) winMsgs.push({ role: 'user', text: 'm' + i, ts: Date.now() });
        const winS = {
          id: winId,
          title: '窗口测试',
          cwd: winPrev.cwd,
          model: winPrev.model,
          approvalMode: 'auto',
          messages: winMsgs,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        state.sessions.unshift(winS);
        state.current = winS;
        state.renderLimit.set(winId, 20);
        renderThread();
        out.threadWindow = !!document.querySelector('.thread-more');
        const msgBefore = document.querySelectorAll('#thread .msg').length;
        const moreBtn = document.querySelector('.thread-more');
        if (moreBtn) moreBtn.click();
        await new Promise((r) => setTimeout(r, 80));
        out.threadExpand = document.querySelectorAll('#thread .msg').length > msgBefore;
        state.sessions = state.sessions.filter((x) => x.id !== winId);
        state.current = winPrev;
        state.renderLimit.delete(winId);
        state.searchIndex.delete(winId);
        renderAll();
        out.toolbar = !!document.getElementById('btnFind') && !!document.getElementById('btnExport');
        out.suggest = emptyMarkup().includes('data-suggest');
        openPalette();
        await new Promise((r) => setTimeout(r, 40));
        {
          const pe = document.querySelector('.palette-item.enter');
          out.paletteMotion = !!pe && getComputedStyle(pe).animationName.includes('list-item-in');
          out.paletteSelectionMotion =
            !!pe && getComputedStyle(pe).transitionProperty.includes('background-color');
          const firstPalette = document.querySelector('.palette-item');
          const paletteQuery = document.getElementById('paletteQuery');
          paletteQuery.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })
          );
          out.paletteInPlace = document.querySelector('.palette-item') === firstPalette;
          const pl = document.getElementById('paletteList');
          const oldMax = pl.style.maxHeight;
          pl.style.maxHeight = '80px';
          updateMenuEdges(pl);
          out.paletteEdgeFade =
            pl.classList.contains('can-down') && getComputedStyle(pl).maskImage !== 'none';
          pl.style.maxHeight = oldMax;
          updateMenuEdges(pl);
          rememberRecentFile(state.current.cwd, 'package.json');
          const allPalette = paletteItems('');
          out.paletteRecentFile = allPalette.some((x) => x.label.startsWith('文件 · '));
          out.paletteGitOps = allPalette.some((x) => x.label.startsWith('Git：'));
          out.paletteArchive = allPalette.some((x) => x.label.includes('归档'));
          const emptyProbe = document.createElement('div');
          emptyProbe.className = 'menu-empty';
          emptyProbe.textContent = 'probe';
          document.body.appendChild(emptyProbe);
          out.menuEmptyIcon =
            getComputedStyle(emptyProbe, '::before').content.includes('⌕') &&
            getComputedStyle(emptyProbe).animationName.includes('ui-fade-up');
          emptyProbe.remove();
        }
        closePalette();
        {
          const inpM = document.getElementById('input');
          inpM.value = '@';
          inpM.dispatchEvent(new Event('input', { bubbles: true }));
          let mi = 0;
          for (let i = 0; i < 20 && !mi; i++) {
            await new Promise((r) => setTimeout(r, 120));
            mi = document.querySelectorAll('.mention-item.enter').length;
          }
          out.mentionMotion =
            mi > 0 &&
            getComputedStyle(document.querySelector('.mention-item.enter')).animationName.includes('list-item-in');
          const mm = document.getElementById('mentionMenu');
          out.mentionSelectionMotion =
            !!document.querySelector('.mention-item') &&
            getComputedStyle(document.querySelector('.mention-item')).transitionProperty.includes(
              'background-color'
            );
          const oldMentionMax = mm.style.maxHeight;
          mm.style.maxHeight = '80px';
          updateMenuEdges(mm);
          out.mentionEdgeFade =
            mm.classList.contains('can-down') && getComputedStyle(mm).maskImage !== 'none';
          mm.style.maxHeight = oldMentionMax;
          updateMenuEdges(mm);
          closeComposerMenu();
          inpM.value = '';
          inpM.dispatchEvent(new Event('input', { bubbles: true }));
        }
        out.version = !!(document.getElementById('cfgVersion') || {}).textContent;
        out.focusApi = typeof window.shell.win.isFocused === 'function';
        // Esc→stop 忽略判定（移植 ZCode shouldIgnoreEscapeForStopGeneration）：
        // defaultPrevented / dialog 路径不误停，普通按键路径仍允许停止
        {
          const target = { tagName: 'DIV', getAttribute: () => null, dataset: {}, parentElement: null };
          const plain = { defaultPrevented: false, target, composedPath: () => [target] };
          const prevented = { defaultPrevented: true, target, composedPath: () => [target] };
          const dlgTarget = { tagName: 'DIV', getAttribute: (n) => (n === 'role' ? 'dialog' : null), dataset: {}, parentElement: null };
          const inDialog = { defaultPrevented: false, target: dlgTarget, composedPath: () => [target, dlgTarget] };
          const slotTarget = { tagName: 'DIV', getAttribute: () => null, dataset: { slot: 'dialog-content' }, parentElement: null };
          const inSlot = { defaultPrevented: false, target: slotTarget, composedPath: () => [target, slotTarget] };
          out.escapeStopGuard =
            shouldIgnoreEscapeForStop(plain) === false &&
            shouldIgnoreEscapeForStop(prevented) === true &&
            shouldIgnoreEscapeForStop(inDialog) === true &&
            shouldIgnoreEscapeForStop(inSlot) === true;
          // "/" 快速聚焦：输入区/弹层/修饰键不触发，普通正文键触发
          const bodyEvt = { key: '/', target: { tagName: 'DIV', isContentEditable: false } };
          const inputEvt = { key: '/', target: { tagName: 'TEXTAREA', isContentEditable: false } };
          const ctrlEvt = { key: '/', ctrlKey: true, target: { tagName: 'DIV', isContentEditable: false } };
          out.slashFocusGuard =
            shouldFocusComposerOnSlash(bodyEvt, false) === true &&
            shouldFocusComposerOnSlash(inputEvt, false) === false &&
            shouldFocusComposerOnSlash(ctrlEvt, false) === false &&
            shouldFocusComposerOnSlash(bodyEvt, true) === false;
        }
        // 上下文用量环（开源 agent 共识交互）：环形 SVG + 阈值变色 + 点击明细
        {
          const ring = document.getElementById('ctxRing');
          const arc = ring && ring.querySelector('.ctx-arc');
          out.contextRing =
            !!ring &&
            !!arc &&
            typeof (arc.style.strokeDasharray || '') === 'string' &&
            /ctx-arc/.test(ring.innerHTML) &&
            ring.getAttribute('aria-label') !== null;
          if (ring) {
            ring.click();
            const pop = document.getElementById('ctxDetailPop');
            out.contextDetail = !!pop && !!pop.querySelector('.ctx-d-num') && !!pop.querySelector('.ctx-d-bar');
            // R64：弹层向上弹出（环在底部状态栏）——弹层底边应在环上缘之上，不得远贴视口顶部
            const popRect = pop && pop.getBoundingClientRect ? pop.getBoundingClientRect() : null;
            const ringRect = ring && ring.getBoundingClientRect ? ring.getBoundingClientRect() : null;
            out.contextPopAnchored =
              !!popRect && !!ringRect &&
              popRect.bottom <= ringRect.top + 2 &&
              popRect.bottom > ringRect.top - 260;
            // R70：Esc 关闭明细弹层（补齐与 palette/findBar/settings 一致的关闭交互）
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            await new Promise((r) => setTimeout(r, 30));
            out.contextPopEsc = !document.getElementById('ctxDetailPop');
            if (!out.contextPopEsc) {
              const p2 = document.getElementById('ctxDetailPop');
              if (p2) p2.remove();
            }
            // 分类明细（对齐内核 CATEGORY_KEYS / ZCode contextUsage）：图例至少含
            // 「系统提示 / 内置工具 / 对话消息」等类别，且色带按分类分段
            // R60：轮询等待图例渲染（ctxDetail 数据异步就绪，立即查偶发不全，r78 flake）
            {
              const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
              const legendEl = pop && pop.querySelector('.ctx-d-legend');
              let legendText = legendEl ? legendEl.textContent || '' : '';
              for (let i = 0; i < 30; i++) {
                if (['系统提示', '内置工具', '对话消息'].every((k) => legendText.includes(k))) break;
                await sleepMs(100);
                const el = pop && pop.querySelector('.ctx-d-legend');
                legendText = el ? el.textContent || '' : '';
              }
              const legend = pop && pop.querySelector('.ctx-d-legend');
              const bar = pop && pop.querySelector('.ctx-d-bar');
              out.contextCategories =
                !!legend &&
                ['系统提示', '内置工具', '对话消息'].every((k) => legendText.includes(k)) &&
                !!bar && bar.querySelectorAll('span').length >= 3;
            } // R60 轮询块闭合（并发编辑漏了此括号，导致注入脚本 SyntaxError: Unexpected token 'else'）
            // 色带宽度口径（对齐 ZCode Progress）：分类段份额 × pct + free ≤ 100%，不得溢出
            const pctNow = Number((state.ctxDetail || {}).pct) || 0;
            const sample = [3, 1, 2];
            const sum = sample.reduce((a, x) => a + x, 0);
            const widths = sample.map((x) => ctxSegmentWidthPct(x, sum, pctNow, true));
            const totalWidth = widths.reduce((a, x) => a + x, 0) + Math.max(0, 100 - pctNow);
            out.ctxBarNoOverflow =
              Math.abs(totalWidth - 100) < 0.5 &&
              widths.every((w) => w >= 0 && w <= 100) &&
              ctxSegmentWidthPct(3, sum, 0, true) === 0;
            // 压缩按钮：明细里必须存在（OpenHands 式操作入口）
            const cbtn = pop && pop.querySelector('[data-ctx-compress]');
            out.compactButton =
              !!cbtn && /压缩/.test(cbtn.textContent || '') &&
              getComputedStyle(cbtn).display !== 'none' && !cbtn.disabled;
            if (pop) pop.remove();
          } else {
            out.contextDetail = false;
            out.contextCategories = false;
          }
          // compact 时间轴分隔线：running/completed/failed 三种状态 + 文案 + 细线结构
          const cdRunning = compactDividerElement({ compact: { status: 'running', ts: Date.now() } });
          const cdDone = compactDividerElement({ compact: { status: 'completed', duration: 1200 } });
          const cdFail = compactDividerElement({ compact: { status: 'failed' } });
          out.compactDivider =
            cdRunning.classList.contains('running') &&
            cdRunning.dataset.compactStatus === 'running' &&
            cdRunning.querySelectorAll('.cd-line').length === 2 &&
            /压缩/.test(cdRunning.textContent || '') &&
            cdDone.dataset.compactStatus === 'completed' &&
            /已压缩/.test(cdDone.textContent || '') &&
            cdFail.classList.contains('failed');
          // CSS 真的作用到了分隔线（细线有背景色、pill 有圆角），防止只加 DOM 没加样式
          document.body.appendChild(cdDone);
          const cdStyle = getComputedStyle(cdDone);
          const cdLineStyle = getComputedStyle(cdDone.querySelector('.cd-line'));
          out.compactDividerStyle =
            cdStyle.display === 'flex' &&
            cdLineStyle.height === '1px' &&
            parseFloat(getComputedStyle(cdDone.querySelector('.cd-pill')).borderTopLeftRadius) >= 8;
          cdDone.remove();
          // 模型切换分隔线：有来源显示双箭头 + "从 X 切换到 Y"；首次使用显示"使用模型"
          const mcSwitch = modelChangeDividerElement({ modelChange: { fromLabel: '模型 A', toLabel: '模型 B' } });
          const mcFirst = modelChangeDividerElement({ modelChange: { fromLabel: '', toLabel: '模型 B' } });
          // 派生分隔线（对齐 ZCode forkNotice）：/new 承接来源 + 可点跳回
          {
            const fakeS = { id: '__fork_probe__', forkFrom: { sid: 'src-1', title: '源会话' }, messages: [{}] };
            const forkEl = forkDividerElement(fakeS);
            out.forkDivider =
              !!forkEl.classList.contains('fork-divider') &&
              forkEl.dataset.forkFrom === 'src-1' &&
              /派生自 源会话/.test(forkEl.textContent || '') &&
              !!forkEl.querySelector('.fk-line') &&
              typeof forkEl.onclick === 'function';
            // newSessionLike 记录 forkFrom（纯数据契约）
            const srcS = { id: 'src-x', title: '原会话', cwd: 'C:\\tmp', model: 'm', approvalMode: 'auto' };
            const prevCur = state.current;
            state.current = srcS;
            const forked = newSessionLike(srcS);
            out.forkRecorded = !!(forked.forkFrom && forked.forkFrom.sid === 'src-x' && forked.forkFrom.title === '原会话');
            // 清理探测会话（不污染后续断言），重绘恢复 DOM 到原会话
            // R73（监工D）：newSessionLike 内部 persist 会落盘派生会话——只从 sessions 数组移除
            // 不 cancelPersist + sessions.remove 的话，落盘文件（无 smoke 标记）永久泄漏进真实会话列表
            if (typeof cancelPersist === 'function') cancelPersist(forked.id);
            window.shell.sessions.remove(forked.id).catch(() => {});
            state.sessions = state.sessions.filter((x) => x.id !== forked.id);
            state.current = prevCur;
            renderAll();
          }
          // Goal 校验分隔线（ZCode goalVerify marker）：第 N 次迭代 + 三种结果
          {
            const gvRun = goalVerifyDividerElement({ goalVerify: { n: 2, outcome: 'running' } });
            const gvPass = goalVerifyDividerElement({ goalVerify: { n: 2, outcome: 'passed' } });
            const gvNo = goalVerifyDividerElement({ goalVerify: { n: 3, outcome: 'notSatisfied' } });
            out.goalVerifyDivider =
              /第 2 次迭代/.test(gvRun.textContent || '') &&
              /校验中/.test(gvRun.textContent || '') &&
              gvRun.querySelectorAll('.gv-line').length === 2 &&
              gvPass.dataset.goalVerify === 'passed' &&
              gvPass.classList.contains('passed') &&
              /校验完成/.test(gvPass.textContent || '') &&
              gvNo.classList.contains('incomplete') &&
              /未完成/.test(gvNo.textContent || '');
            // appendGoalVerifyMarker 写入含 goalVerify 的 system 消息
            const probeS = { id: '__gv_probe__', smoke: true, messages: [], updatedAt: 0 };
            appendGoalVerifyMarker(probeS, 4, 'passed');
            out.goalVerifyRecord =
              probeS.messages.length === 1 &&
              probeS.messages[0].role === 'system' &&
              probeS.messages[0].goalVerify.n === 4 &&
              probeS.messages[0].goalVerify.outcome === 'passed';
          }
          out.modelChangeDivider =
            mcSwitch.dataset.modelChange === '1' &&
            mcSwitch.querySelectorAll('.mc-line').length === 2 &&
            /从 模型 A 切换到 模型 B/.test(mcSwitch.textContent || '') &&
            !!mcSwitch.querySelector('.mc-pill svg') &&
            /使用模型 模型 B/.test(mcFirst.textContent || '') &&
            !mcFirst.querySelector('.mc-pill svg');
          // CSS 生效（细线 1px / pill 圆角）
          document.body.appendChild(mcSwitch);
          out.modelChangeDividerStyle =
            getComputedStyle(mcSwitch).display === 'flex' &&
            getComputedStyle(mcSwitch.querySelector('.mc-line')).height === '1px' &&
            parseFloat(getComputedStyle(mcSwitch.querySelector('.mc-pill')).borderTopLeftRadius) >= 8;
          mcSwitch.remove();
          // markModelChange 记录语义：不同模型才记、同模型不记
          {
            const fakeS = { id: '__mc_probe__', model: 'a', modelLabel: '模型 A' };
            markModelChange(fakeS, 'b', '模型 B');
            const recorded = !!fakeS.pendingModelChange &&
              fakeS.pendingModelChange.fromLabel === '模型 A' &&
              fakeS.pendingModelChange.toLabel === '模型 B';
            fakeS.model = 'b'; fakeS.modelLabel = '模型 B';
            const before = fakeS.pendingModelChange.ts;
            markModelChange(fakeS, 'b', '模型 B'); // 选同一模型不应覆盖记录
            const noDup = fakeS.pendingModelChange.ts === before;
            out.modelChangeRecord = recorded && noDup;
            // 物化：有 pending 时产出 system/modelChange 消息并清空；无 pending 时返回 null
            const fakeS2 = { id: '__mc_probe2__', messages: [] };
            markModelChange(fakeS2, 'b', '模型 B');
            const materialized = consumeModelChange(fakeS2);
            const cleared = !fakeS2.pendingModelChange && consumeModelChange(fakeS2) === null;
            out.modelChangeMaterialize =
              !!materialized && materialized.role === 'system' &&
              !!materialized.modelChange && cleared;
          }
          out.compactRewrite =
            rewriteCliSource('/compress') === '/compress-fast' &&
            rewriteCliSource('/compact 说明') === '/compress-fast 说明' &&
            isCompactTurnText('/compress') === true &&
            isCompactTurnText('/compact 说明') === true &&
            isCompactTurnText('/model') === false;
          // 运行中禁用判定（OpenHands 式）：构造 busy + pending compact 的假会话
          {
            const saved = { cur: state.current, run: state.runtimes.get(state.current.id) };
            const fakeS = { id: '__compact_probe__', messages: [{ compact: { status: 'running' }, pending: true }] };
            state.current = fakeS;
            state.runtimes.set(fakeS.id, { busy: true });
            const busyDisabled = compactRunning(fakeS) === true;
            state.runtimes.set(fakeS.id, { busy: false });
            const idleEnabled = compactRunning(fakeS) === false;
            state.runtimes.delete(fakeS.id);
            state.current = saved.cur;
            out.compactBusyDisabled = busyDisabled && idleEnabled;
          }
          const toastOk = compactToastFor(true);
          const toastDone = compactToastFor(false);
          out.compactToast =
            /压缩失败/.test(toastOk.title) &&
            /压缩/.test(toastDone.title) &&
            !!toastDone.detail;
        }
        try {
          const gi = await window.shell.gpu();
          out.gpuDiag =
            !!gi &&
            gi.ok === true &&
            gi.backgroundThrottling === true &&
            !!gi.feature &&
            Object.keys(gi.feature).length >= 2;
          out.gpuFlagsWhitelist =
            Array.isArray(gi.whitelist) &&
            gi.whitelist.includes('enable-gpu-rasterization') &&
            !gi.whitelist.includes('remote-debugging-port');
          // R42：静态 GPU 信息缓存后重复查询一致（动态 prefs 字段仍每次合并）
          const gi2 = await window.shell.gpu();
          out.gpuCached = !!gi2 && gi2.device === gi.device && gi2.vendor === gi.vendor &&
            JSON.stringify(gi2.feature) === JSON.stringify(gi.feature) &&
            gi2.disableGpu === gi.disableGpu && gi2.gpuFlags === gi.gpuFlags;
        } catch {
          out.gpuDiag = false;
          out.gpuFlagsWhitelist = false;
        }
        out.backgroundThrottling = out.gpuDiag;
        try {
          const kh = await window.shell.kernelSelfHeal();
          out.kernelAutoRestart =
            !!kh &&
            kh.ok === true &&
            typeof kh.before === 'number' &&
            typeof kh.after === 'number' &&
            kh.after !== kh.before;
          out.kernelResume =
            !!kh && kh.ok === true && (!!kh.resume || !!kh.resumeBefore);
          const ks = await window.shell.kernelStatus();
          out.kernelDetect = !!(ks && ks.ok === true && ks.launch);
          out.kernelInstallApi = typeof window.shell.kernelInstall === 'function';
        } catch {
          out.kernelAutoRestart = false;
          out.kernelResume = false;
          out.kernelDetect = false;
          out.kernelInstallApi = false;
        }
        try {
          const cp = await window.shell.cliProbe();
          out.cliProbeOk =
            !!cp &&
            cp.ok === true &&
            (cp.found === true ? !!cp.cmd : Array.isArray(cp.candidates));
        } catch {
          out.cliProbeOk = false;
        }
        try {
          const ii = await window.shell.iconInfo();
          out.iconSizes =
            !!ii &&
            ii.ok === true &&
            Array.isArray(ii.sizes) &&
            ii.sizes.length >= 9 &&
            ii.sizes.includes(20) &&
            ii.sizes.includes(40);
          out.trayIconFile = !!(ii && ii.tray);
          out.brandUnified = !!(ii && ii.brand);
          // 16px 图标有实质内容（非透明像素大致反映在字节数上）、安装器图标引用正确
          out.iconSmallLegible = !!(ii && ii.smallIconBytes > 100);
          out.installerIcon = !!(ii && ii.installerIcon);
          out.iconTransparentBg = !!(ii && ii.transparent && ii.trayTransparent);
        } catch {
          out.iconSizes = false;
          out.trayIconFile = false;
          out.brandUnified = false;
          out.iconSmallLegible = false;
          out.installerIcon = false;
          out.iconTransparentBg = false;
        }
        out.perfApi = typeof window.shell.perf === 'function';
        if (out.perfApi) await window.shell.perf('smokeProbe', 1);
        try {
          await window.shell.sessions.backupNow();
          const bi = await window.shell.sessions.backupInfo();
          // R73（监工D）：本次快照含 smoke 会话，探针后删除，防恢复备份时注入幽灵会话
          try {
            if (bi && bi.last && bi.last.name) fs.rmSync(path.join(BACKUP_DIR, bi.last.name), { force: true });
          } catch { /* 删除失败忽略 */ }
          out.sessionBackup = !!(
            bi &&
            bi.ok &&
            bi.last &&
            Number(bi.last.size) > 0 &&
            Array.isArray(bi.items)
          );
          const sz = await window.shell.sessions.sizes();
          out.sessionSizes =
            !!sz &&
            sz.ok === true &&
            Array.isArray(sz.items) &&
            sz.items.length > 0 &&
            typeof sz.items[0].bytes === 'number' &&
            // R41：并发 stat 后仍按体积倒序
            sz.items.every((it, i) => i === 0 || sz.items[i - 1].bytes >= it.bytes);
          const slimRes = await window.shell.sessions.slim(state.current.id);
          out.sessionSlim = !!(slimRes && slimRes.ok === true);
        } catch {
          out.sessionBackup = false;
          out.sessionSizes = false;
          out.sessionSlim = false;
        }
        try {
          const pf = await window.shell.prefs.get();
          out.prefsSchema = !!(pf && pf.schemaVersion === 1);
          const badCfg = await window.shell.config.validate({
            modelProviders: { openai: [{}] },
            env: null,
          });
          const goodCfg = await window.shell.config.validate(state.config);
          out.configSchemaWarn =
            !!badCfg &&
            Array.isArray(badCfg.warnings) &&
            badCfg.warnings.length > 0 &&
            !!goodCfg &&
            Array.isArray(goodCfg.warnings) &&
            goodCfg.warnings.length === 0;
          out.providerTemplates =
            Array.isArray(PROVIDER_TEMPLATES) &&
            PROVIDER_TEMPLATES.length >= 6 &&
            PROVIDER_TEMPLATES.some((t) => t.label.includes('Ollama'));
          const sec = await window.shell.security();
          out.permissionGuard =
            !!sec && sec.clipboardOnly === true && sec.sandbox === true && sec.contextIsolation === true;
          // R82：除 sk- 外，结构化键名变体（apiKey/access_token）也必须脱敏且不误伤布尔值
          out.logRedaction =
            !!sec &&
            sec.redactSample === 'sk-***' &&
            (sec.redactKeySample || '').includes('"apiKey":"***"') &&
            (sec.redactKeySample || '').includes('"access_token":"***"') &&
            (sec.redactKeySample || '').includes('"enabled":true');
          out.attachSizeGuard = !!sec && sec.attachMax === 20 * 1024 * 1024;
          const redact = await window.shell.config.redactionSelfTest();
          out.exportRedacted = !!(redact && redact.ok && redact.masked);
          const meta = await window.shell.meta();
          out.smokePerfEntry = !!(meta && meta.ok && meta.smokePerf === true);
          // 逐项确认档必须走 SDK 初始化，否则 default/auto-edit 不会发 can_use_tool
          out.sdkApprovalGating =
            !!meta &&
            Array.isArray(meta.sdkApprovalTiers) &&
            ['default', 'auto-edit'].every((m) => meta.sdkApprovalTiers.includes(m)) &&
            ['plan', 'auto', 'yolo'].every((m) => !meta.sdkApprovalTiers.includes(m));
          const fp = meta && meta.approvalFastPath;
          out.approvalFastPath =
            !!fp &&
            fp.readOnlyInDefault === true && fp.readOnlyInAutoEdit === true &&
            fp.editInAutoEdit === true && fp.editInDefault === false &&
            fp.shellInDefault === false && fp.shellInAutoEdit === false;
          // 安装器形态：向导式（许可协议 + 自定义路径），防止误交付旧 oneClick 包
          out.installerAssisted = !!(
            meta &&
            meta.installer &&
            meta.installer.oneClick === false &&
            meta.installer.directory === true &&
            meta.installer.license === true
          );
        } catch {
          out.prefsSchema = false;
          out.configSchemaWarn = false;
          out.providerTemplates = false;
          out.permissionGuard = false;
          out.logRedaction = false;
          out.attachSizeGuard = false;
          out.exportRedacted = false;
          out.smokePerfEntry = false;
          out.installerAssisted = false;
        }
        {
          const rules = [];
          for (const sheet of document.styleSheets) {
            try {
              for (const rule of sheet.cssRules) rules.push(rule);
            } catch {
              /* ignore */
            }
          }
          out.focusVisibleCoverage = rules.some(
            (r) => r.selectorText && r.selectorText.includes('.archive-entry:focus-visible')
          );
          out.reducedMotionRegression = rules.some(
            (r) =>
              r.type === CSSRule.MEDIA_RULE &&
              String(r.conditionText || '').includes('prefers-reduced-motion')
          );
        }
        const cvProbe = document.createElement('div');
        cvProbe.className = 'msg';
        document.body.appendChild(cvProbe);
        out.contentVisibility = getComputedStyle(cvProbe).contentVisibility === 'auto';
        cvProbe.remove();
        {
          const perfPrev = state.current;
          if (perfPrev) {
            const perfId = 'perf_' + Date.now().toString(36);
            const perfSess = {
              id: perfId,
              title: 'perf',
              cwd: perfPrev.cwd,
              model: perfPrev.model,
              approvalMode: 'auto',
              messages: [],
              createdAt: Date.now(),
              updatedAt: Date.now(),
            };
            for (let i = 0; i < 120; i++) {
              if (i % 2 === 0) perfSess.messages.push({ role: 'user', text: '问题 ' + i, ts: Date.now() });
              else
                perfSess.messages.push({
                  role: 'assistant',
                  text: '回复 ' + i,
                  blocks: [{ type: 'text', text: '回复 ' + i }],
                  ts: Date.now(),
                });
            }
            state.current = perfSess;
            const t0 = performance.now();
            renderThread();
            const ms = performance.now() - t0;
            state.current = perfPrev;
            state.runtimes.delete(perfId);
            renderAll();
            if (window.shell.perf) await window.shell.perf('threadPaint', ms.toFixed(1) + 'ms');
          }
        }
        const probePng =
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
        const at = await window.shell.saveAttachment({
          name: 'probe.png',
          mime: 'image/png',
          dataBase64: probePng,
        });
          out.attachChip = false;
          out.attachHtmlCache = false;
        out.attachmentApi = !!(at && at.ok && at.path);
        if (at && at.ok) {
          const curS = state.current;
          const prevAtt = state.attachments.get(curS.id) || [];
          state.attachments.set(curS.id, [{ path: at.path, name: 'probe.png', thumb: '' }]);
          renderComposer();
          out.attachChip = !!document.querySelector('#attachRow .attach-chip');
          // 附件 HTML 缓存：内容未变时重复 renderComposer 不重建 innerHTML（保留同一 DOM 节点）
          {
            const chip1 = document.querySelector('#attachRow .attach-chip');
            renderComposerAttachments();
            const chip2 = document.querySelector('#attachRow .attach-chip');
            out.attachHtmlCache = !!chip1 && chip1 === chip2;
          }
          const attachRemove = document.querySelector('#attachRow [data-attach-remove]');
          out.attachRemoveMotion = false;
          if (attachRemove) {
            attachRemove.click();
            await new Promise((r) => setTimeout(r, 40));
            const removingChip = document.querySelector('#attachRow .attach-chip.removing');
            out.attachRemoveMotion = !!removingChip;
            await new Promise((r) => setTimeout(r, 160));
            out.attachRemoveMotion = out.attachRemoveMotion && currentAttachments().length === 0;
          }
          const probeMsg = renderUserMessage({
            role: 'user',
            text: '图片消息',
            attachments: [{ path: at.path, name: 'probe.png', thumb: '' }],
          });
          out.attachMessage = !!probeMsg.querySelector('.bubble-attach');
          probeMsg.remove();
          // R34/R36：消息气泡附件节点缓存——命中走 cloneNode（每次新元素但含附件），文本变化仍更新
          {
            const bm = { role: 'user', text: '缓存探针', attachments: [{ path: 'p', name: 'n', thumb: 'data:image/png;base64,AAAA' }] };
            const e1 = renderUserMessage(bm), h1 = e1.innerHTML;
            const e2 = renderUserMessage(bm), h2 = e2.innerHTML;
            bm.text = '缓存探针2';
            const h3 = renderUserMessage(bm).innerHTML;
            out.userBubbleCache = e1 !== e2 && h1 === h2 && h1.indexOf('data:image/png') >= 0 &&
              h1.indexOf('缓存探针') < h1.indexOf('bubble-attach') &&
              h3 !== h2 && h3.indexOf('缓存探针2') >= 0 && h3.indexOf('data:image/png') >= 0;
          }
          state.attachments.set(curS.id, prevAtt);
          renderComposer();
        }
        out.attachCli = cliTextWithAttachments('看图', [
          { path: window.__qcodeDevWs + '/a.png' },
        ]).includes('@' + window.__qcodeDevWs + '/a.png');
        try {
          const bytes = Uint8Array.from(atob(probePng), (c) => c.charCodeAt(0));
          const probeFile = new File([bytes], 'probe2.png', { type: 'image/png' });
          const probeFile2 = new File([bytes], 'probe3.png', { type: 'image/png' });
          await addImageFiles([probeFile, probeFile2]);
          out.attachAdd = currentAttachments().length > 0;
          out.attachBatch = currentAttachments().length === 2;
          state.attachments.set(state.current.id, []);
          renderComposer();
        } catch {
          out.attachAdd = false;
          out.attachBatch = false;
        }
        const sendBtn = document.getElementById('btnSend');
        const inpS = document.getElementById('input');
        inpS.value = '';
        inpS.dispatchEvent(new Event('input', { bubbles: true }));
        out.sendDisabled = sendBtn.disabled === true;
        inpS.value = 'x';
        inpS.dispatchEvent(new Event('input', { bubbles: true }));
        out.sendEnabled = sendBtn.disabled === false;
        // 纯提醒不能单独成轮：防止「没发消息但后台一直调大模型」
        out.noReminderOnlyTurn =
          hasRealPrompt('', [], null, null) === false &&
          hasRealPrompt('用户问题', [], null, null) === true &&
          hasRealPrompt('', ['att'], null, null) === true &&
          hasRealPrompt('', [], null, '/compress') === true;
        {
          const prevQueue = state.queue[state.current.id];
          state.queue[state.current.id] = [{ text: '排队探针消息', attachments: [] }];
          renderComposer();
          const qchip = document.querySelector('#queueRow .queue-chip');
          const queueOk =
            !!qchip && getComputedStyle(qchip).animationName.includes('list-item-in');
          const qbtn = qchip && qchip.querySelector('[data-queue-remove]');
          if (qbtn) qbtn.click();
          out.queueChipMotion =
            queueOk && !(state.queue[state.current.id] && state.queue[state.current.id].length);
          if (prevQueue) state.queue[state.current.id] = prevQueue;
          else delete state.queue[state.current.id];
          renderComposer();
          document.body.classList.add('dragging');
          out.composerDropHighlight = getComputedStyle(
            document.getElementById('composer'),
            '::after'
          ).content.includes('松开');
          document.body.classList.remove('dragging');
          sendBtn.classList.add('sent');
          out.sendButtonMotion = getComputedStyle(sendBtn).animationName.includes('send-pulse');
          sendBtn.classList.remove('sent');
          openMenu(document.getElementById('chipEffort'), [{ label: '探针', active: true }], () => {});
          const activeMenuItem = document.querySelector('.pop-menu button.on');
          out.chipMenuIndicator =
            !!activeMenuItem && getComputedStyle(activeMenuItem).boxShadow.includes('inset');
          // pop-menu 键盘可达：↑↓ roving + Enter 选择 + Esc 关闭
          {
            let picked = null;
            openMenu(document.getElementById('chipEffort'), [
              { label: '甲' }, { label: '乙' }, { label: '丙' },
            ], (it) => { picked = it.label; });
            const menu = document.querySelector('.pop-menu');
            const mbs = menu ? [...menu.querySelectorAll('button')] : [];
            const navHandler = !!menu && typeof menu.onkeydown === 'function';
            const firstFocused = document.activeElement === mbs[0];
            if (menu) {
              menu.onkeydown({ key: 'ArrowDown', preventDefault() {}, stopPropagation() {} });
              menu.onkeydown({ key: 'Enter', preventDefault() {}, stopPropagation() {} });
            }
            out.popMenuKeyboard = navHandler && firstFocused && mbs.length === 3 && picked === '乙';
            closeMenu();
          }
          closeMenu();
          inpS.value = '/goal 测试目标';
          inpS.dispatchEvent(new Event('input', { bubbles: true }));
          await new Promise((r) => setTimeout(r, 20));
          const cmdPill = document.querySelector('#cmdChipRow .cmd-pill');
          out.commandChip =
            !!cmdPill &&
            cmdPill.textContent.includes('Goal') &&
            inpS.value === '测试目标' &&
            !sendBtn.disabled &&
            !!cmdPill.querySelector('svg');
          const cmdClear = cmdPill && cmdPill.querySelector('[data-cmd-clear]');
          if (cmdClear) cmdClear.click();
          out.commandChipRemove =
            inpS.value.includes('/goal') && !state.composerCommand;
        }
        inpS.value = '';
        inpS.dispatchEvent(new Event('input', { bubbles: true }));
        // 提示词库：列表、插入、引用
        setCfgSection('prompts');
        await new Promise((r) => setTimeout(r, 150));
        out.prompts = !!document.getElementById('promptAdd');
        out.promptFilter = !!document.getElementById('promptFilter');
        out.promptIO = !!document.getElementById('promptExport') && !!document.getElementById('promptImport');
        // R29：collectIndexed 过滤保留原始索引（避免 O(n²) indexOf）
        {
          const ci = collectIndexed([{ n: 'a' }, { n: 'b' }, { n: 'c' }], (x) => x.n !== 'b');
          out.collectIndexed = ci.length === 2 && ci[0].i === 0 && ci[1].i === 2 && ci[0].item.n === 'a';
        }
          out.promptEnterMotion = false;
          out.promptInsert = false;
        const prevPrompts = state.extras && state.extras.prefs ? state.extras.prefs.prompts : undefined;
        if (state.extras) {
          state.extras.prefs = { ...(state.extras.prefs || {}), prompts: [{ id: 'probe', name: '探针提示词', text: 'PROMPT-PROBE' }] };
          renderCfgSection();
          const promptCard = document.querySelector('#promptList .p-card.enter');
          out.promptEnterMotion =
            !!promptCard &&
            getComputedStyle(promptCard).animationName.includes('list-item-in') &&
            getComputedStyle(promptCard).transitionProperty.includes('border-color');
          const insBtn = [...document.querySelectorAll('#promptList .btn')].find((b) => b.textContent === '插入');
          if (insBtn) insBtn.click();
          const inp0 = document.getElementById('input');
          out.promptInsert = inp0.value.includes('PROMPT-PROBE');
          inp0.value = '';
          inp0.dispatchEvent(new Event('input', { bubbles: true }));
          state.extras.prefs.prompts = prevPrompts;
          renderCfgSection();
        }
        quoteText('QUOTE-PROBE');
        const inpQ = document.getElementById('input');
        out.quote = inpQ.value.includes('> QUOTE-PROBE');
        inpQ.value = '';
        inpQ.dispatchEvent(new Event('input', { bubbles: true }));
        const s = state.current;
        s.title = '改名测试';
        s.pinned = true;
        persist(s);
        renderSidebar();
        out.rename = !![...document.querySelectorAll('#sessionList .txt')].find(
          (t) => t.textContent === '改名测试'
        );
        out.pin = !!document.querySelector('#sessionList .pin.on');
        out.recency = !!document.querySelector('#sessionList .when');
        const pinOn = document.querySelector('#sessionList .pin.on');
        const whenEl = document.querySelector('#sessionList .when');
        out.sessionHoverMotion =
          !!whenEl &&
          getComputedStyle(whenEl).transitionProperty.includes('max-width') &&
          !!pinOn &&
          getComputedStyle(pinOn).transitionProperty.includes('transform');
        // 会话列表键盘导航（对齐 ZCode/file-row 的 wireListKeyboard）
        const navItems = [...document.querySelectorAll('#sessionList .session-item')];
        const listBox = document.getElementById('sessionList');
        out.sessionListKeyboard =
          navItems.length > 0 &&
          navItems.every((el) => el.tabIndex === 0 && el.getAttribute('role') === 'option') &&
          !!navItems[0].onkeydown &&
          !!listBox && listBox.getAttribute('role') === 'listbox';
        // 项目列表键盘导航（与 session-list 同款 wireListKeyboard）
        const projItems = [...document.querySelectorAll('#projectList .project-item')];
        const projBox = document.getElementById('projectList');
        out.projectListKeyboard =
          projItems.length > 0 &&
          projItems.every((el) => el.tabIndex === 0 && el.getAttribute('role') === 'option') &&
          !!projItems[0].onkeydown &&
          !!projBox && projBox.getAttribute('role') === 'listbox';
        const pinnedSid = state.current && state.current.id;
        if (pinOn) pinOn.click();
        await new Promise((r) => setTimeout(r, 40));
        const unpinnedItem = [...document.querySelectorAll('#sessionList .session-item')].find(
          (el) => el.dataset.sid === pinnedSid
        );
        const unpinStar = unpinnedItem && unpinnedItem.querySelector('.pin');
        out.pinPopMotion =
          !!unpinStar &&
          unpinStar.classList.contains('pin-pop') &&
          getComputedStyle(unpinStar).animationName.includes('pin-pop');
        if (unpinStar) unpinStar.click();
        await new Promise((r) => setTimeout(r, 40));
        const sideList = document.getElementById('sessionList');
        const sideSearch = document.getElementById('search');
        const oldSideQuery = sideSearch.value;
        const tallStyle = document.createElement('style');
        tallStyle.textContent =
          '#sessionList .session-item{height:70px!important;min-height:70px!important}';
        document.head.appendChild(tallStyle);
        sideList.style.height = '30px';
        sideSearch.value = '';
        renderSidebar();
        sideList.scrollTop = 40;
        sideSearch.value = '__scroll_probe__';
        renderSidebar();
        sideSearch.value = '';
        renderSidebar();
        out.sidebarScrollMemory = sideList.scrollTop > 0;
        sideList.scrollTop = 0;
        sideList.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true }));
        out.scrollBounceMotion =
          sideList.classList.contains('bounce-top') &&
          getComputedStyle(sideList).animationName.includes('scroll-bounce-top');
        const memSid = state.current && state.current.id;
        const prevMemTop = memSid ? state.scroll[memSid] : undefined;
        if (memSid) {
          state.scroll[memSid] = 77;
          saveScrollMemory();
          out.scrollMemoryPersist =
            JSON.parse(localStorage.getItem('ui.sessionScroll') || '{}')[memSid] === 77;
          if (typeof prevMemTop === 'number') state.scroll[memSid] = prevMemTop;
          else delete state.scroll[memSid];
          saveScrollMemory();
        }
        sideList.classList.remove('bounce-top', 'bounce-bottom');
        sideList.style.height = '';
        tallStyle.remove();
        sideSearch.value = oldSideQuery;
        renderSidebar();
        out.sidebarOnly =
          !document.getElementById('tabs') &&
          !!document.getElementById('sessionList') &&
          !!document.getElementById('btnNew') &&
          !!document.getElementById('btnSidebar');
        const sbTab = document.getElementById('search');
        const lastUserMsg = [...(state.current.messages || [])]
          .reverse()
          .find((m) => m.role === 'user');
        const qTab = ((lastUserMsg && lastUserMsg.text) || state.current.title || '冒烟').slice(0, 2);
        sbTab.value = qTab;
        sbTab.dispatchEvent(new Event('input', { bubbles: true }));
        renderSidebar();
        const sbHit = [...document.querySelectorAll('#sessionList .session-item')].find(
          (x) => x.textContent.includes(qTab)
        );
        out.sidebarHit = !!sbHit && !!sbHit.querySelector('.session-snippet');
        sbTab.value = '';
        sbTab.dispatchEvent(new Event('input', { bubbles: true }));
        renderSidebar();
        const sbEl = document.getElementById('sidebar');
        sbEl.classList.add('hidden');
        document.getElementById('sessionList').innerHTML = '';
        renderSidebar();
        const sidebarIdle = document.getElementById('sessionList').children.length === 0;
        sbEl.classList.remove('hidden');
        renderSidebar();
        out.sidebarIdle =
          sidebarIdle && document.querySelectorAll('#sessionList .session-item').length > 0;
        const archPrev = state.current && state.current.id;
        const archS = newSession(window.__qcodeDevWs);
        archS.title = '归档测试';
        archS.smoke = true;
        archS.archived = true;
        state.current =
          state.sessions.find((x) => x.id === archPrev) ||
          state.sessions.find((x) => x.id !== archS.id) ||
          null;
        persist(archS);
        renderAll();
        const archHidden = ![...document.querySelectorAll('#sessionList .txt')].some(
          (t) => t.textContent === '归档测试'
        );
        const archiveEntry = document.getElementById('btnArchiveView');
        if (archiveEntry) archiveEntry.click();
        const archShown = [...document.querySelectorAll('#sessionList .txt')].some(
          (t) => t.textContent === '归档测试'
        );
        const archiveHead = !!document.getElementById('archiveBack');
        const archiveBack = document.getElementById('archiveBack');
        if (archiveBack) archiveBack.click();
        const archBackHidden = ![...document.querySelectorAll('#sessionList .txt')].some(
          (t) => t.textContent === '归档测试'
        );
        out.archiveSession = !!(archHidden && archiveEntry && archShown && archiveHead && archBackHidden);
        await new Promise((r) => setTimeout(r, 260));
        const archList = await window.shell.sessions.list();
        const archMeta = archList.find((x) => x.id === archS.id);
        out.archiveLazyLoad =
          !!archMeta && archMeta.lazy === true && Array.isArray(archMeta.messages) && archMeta.messages.length === 0;
        await switchSession(archS.id);
        out.archiveHydrate = !!findSession(archS.id) && findSession(archS.id).lazy !== true;
        out.archiveBanner =
          !!document.querySelector('.archive-banner') &&
          !!document.getElementById('archiveUnarchive');
        out.archiveCycleSkip = !sortedSessions()
          .filter((s) => !s.archived)
          .some((s) => s.id === archS.id);
        const unarchiveBtn = document.getElementById('archiveUnarchive');
        if (unarchiveBtn) unarchiveBtn.click();
        await new Promise((r) => setTimeout(r, 80));
        out.archiveBannerUnarchive = archS.archived === false;
        localStorage.setItem('ui.archiveViewOpen', '0');
        state.showArchived = false;
        archS.archived = false;
        cancelPersist(archS.id);
        await window.shell.sessions.remove(archS.id);
        // 归档搜索 token：输入 is:archived 应自动打开归档视图（大纲 FULL 阶段 2）
        {
          const searchEl = document.getElementById('search');
          const prevShowArchived = state.showArchived;
          const prevQ = searchEl ? searchEl.value : '';
          if (searchEl) {
            searchEl.value = 'is:archived';
            renderSidebar();
            out.archiveSearchToken = state.showArchived === true;
            searchEl.value = prevQ;
            state.showArchived = prevShowArchived;
            localStorage.setItem('ui.archiveViewOpen', prevShowArchived ? '1' : '0');
            renderSidebar();
          } else {
            out.archiveSearchToken = false;
          }
        }
        state.sessions = state.sessions.filter((x) => x.id !== archS.id);
        state.current =
          state.sessions.find((x) => x.id === archPrev) || state.sessions[0] || null;
        renderAll();
        {
          const prevAuto = state.extras && state.extras.prefs ? state.extras.prefs.autoArchiveDays : 0;
          if (state.extras) {
            state.extras.prefs = state.extras.prefs || {};
            state.extras.prefs.autoArchiveDays = 30;
          }
          const oldId = 's_auto_' + Date.now().toString(36);
          const busyId = 's_busy_' + Date.now().toString(36);
          const oldS = {
            id: oldId,
            smoke: true,
            title: '自动归档测试',
            cwd: window.__qcodeDevWs,
            messages: [],
            createdAt: Date.now() - 41 * 86400000,
            updatedAt: Date.now() - 40 * 86400000,
          };
          const busyS = {
            id: busyId,
            smoke: true,
            title: '忙碌豁免测试',
            cwd: window.__qcodeDevWs,
            messages: [],
            createdAt: Date.now() - 41 * 86400000,
            updatedAt: Date.now() - 40 * 86400000,
          };
          state.sessions.push(oldS, busyS);
          persist(oldS);
          persist(busyS);
          rt(busyId).busy = true;
          const autoCount = await runAutoArchive();
          out.autoArchiveRule =
            autoCount >= 1 &&
            oldS.archived === true &&
            busyS.archived !== true &&
            state.sessions.some((s) => s.id === oldId && s.archived);
          rt(busyId).busy = false;
          state.runtimes.delete(busyId);
          state.sessions = state.sessions.filter((x) => x.id !== oldId && x.id !== busyId);
          cancelPersist(oldId);
          cancelPersist(busyId);
          await window.shell.sessions.remove(oldId);
          await window.shell.sessions.remove(busyId);
          if (state.extras) state.extras.prefs.autoArchiveDays = prevAuto || 0;
          renderSidebar();
        }
        {
          const b1 = { id: 's_ab1_' + Date.now().toString(36), smoke: true, title: '归档批量A', cwd: window.__qcodeDevWs, messages: [], archived: true, createdAt: Date.now(), updatedAt: Date.now() };
          const b2 = { id: 's_ab2_' + Date.now().toString(36), smoke: true, title: '归档批量B', cwd: window.__qcodeDevWs, messages: [], archived: true, createdAt: Date.now(), updatedAt: Date.now() };
          state.sessions.push(b1, b2);
          persist(b1);
          persist(b2);
          state.showArchived = true;
          renderSidebar();
          const manageBtn = document.getElementById('archiveManage');
          if (manageBtn) manageBtn.click();
          await new Promise((r) => setTimeout(r, 30));
          const boxes = [...document.querySelectorAll('#sessionList .arch-check')];
          boxes.slice(0, 2).forEach((cb) => cb.click());
          const batchBar = document.querySelector('.archive-batch');
          const batchEnabled =
            !!batchBar &&
            boxes.length >= 2 &&
            !batchBar.querySelector('[data-arch-restore]').disabled &&
            batchBar.querySelector('.cnt').textContent.includes('2');
          const restoreBtn = batchBar && batchBar.querySelector('[data-arch-restore]');
          if (restoreBtn) restoreBtn.click();
          await new Promise((r) => setTimeout(r, 120));
          out.archiveBatch = batchEnabled && b1.archived === false && b2.archived === false;
          state.showArchived = false;
          state.archiveManage = false;
          state.archiveSelected.clear();
          cancelPersist(b1.id);
          cancelPersist(b2.id);
          state.sessions = state.sessions.filter((s) => s.id !== b1.id && s.id !== b2.id);
          await window.shell.sessions.remove(b1.id);
          await window.shell.sessions.remove(b2.id);
          renderSidebar();
        }
        state.sessionLimit = 1;
        renderSidebar();
        out.sessionPager = !!document.querySelector('.session-more');
        state.sessionLimit = 30;
        renderSidebar();
        // 重命名：Esc 取消不应落盘，Enter 应提交
        const firstEd = document.querySelector('#sessionList .ed');
        if (firstEd) {
          firstEd.click();
          const rin = document.querySelector('.rename-input');
          if (rin) {
            rin.value = '不应保存';
            rin.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            await new Promise((r) => setTimeout(r, 60));
            out.renameEsc = s.title === '改名测试';
          }
          const ed2 = document.querySelector('#sessionList .ed');
          if (ed2) {
            ed2.click();
            const rin2 = document.querySelector('.rename-input');
            if (rin2) {
              rin2.value = '改名测试2';
              rin2.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
              await new Promise((r) => setTimeout(r, 60));
              out.renameEnter = state.sessions.some((x) => x.title === '改名测试2');
            }
          }
        }
        // 补全菜单关闭后异步结果不应重新打开
        const seqBefore = mention.seq;
        closeComposerMenu();
        out.mentionSeq = mention.seq > seqBefore;
        // thinking 兜底必须排在文本前
        const rt0 = rt(s.id);
        const streamBackup = rt0.stream;
        rt0.stream = {
          blocks: [],
          blocksEl: document.createElement('div'),
          tools: {},
          toolEls: {},
          previewEl: null,
          previewText: '',
          previewThinkText: '思考内容',
          follow: true,
        };
        handleAssistantMessage(s, { message: { content: [{ type: 'text', text: '回答' }] } }, true);
        out.thinkOrder = !!(
          rt0.stream.blocks[0] &&
          rt0.stream.blocks[0].type === 'thinking' &&
          rt0.stream.blocks[1] &&
          rt0.stream.blocks[1].type === 'text'
        );
        rt0.stream = streamBackup;
        // 输入历史索引越界回退
        const hist2 = (s.messages || []).filter((m) => m.role === 'user').map((m) => m.text || '');
        if (hist2.length) {
          state.hist = { sessionId: s.id, idx: hist2.length + 5, draft: '' };
          const inp0 = document.getElementById('input');
          inp0.value = '';
          inp0.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
          out.historyClamp = inp0.value === hist2[hist2.length - 1];
          inp0.value = '';
          inp0.dispatchEvent(new Event('input', { bubbles: true }));
        }
        const pv = {
          previewEl: document.createElement('div'),
          previewText: 'A',
          previewNode: null,
          previewPainted: 0,
        };
        paintStreamPreview(pv);
        pv.previewText = 'AB';
        paintStreamPreview(pv);
        pv.previewText = 'ABC';
        paintStreamPreview(pv);
        out.streamAppend = !!(
          pv.previewNode &&
          pv.previewNode.data === 'ABC' &&
          pv.previewPainted === 3
        );
        s.pinned = false;
        s.title = '冒烟测试';
        persist(s);
        renderSidebar();
        setCfgSection('general');
        out.resumeStatus = document
          .getElementById('cfgBody')
          .textContent.includes('上下文状态');
        const search = document.getElementById('cfgSearch');
        search.value = '供应';
        search.dispatchEvent(new Event('input', { bubbles: true }));
        out.search = [...document.querySelectorAll('.cfg-nav-item')]
          .filter((b) => b.style.display !== 'none')
          .map((b) => b.dataset.sec)
          .join(',');
        // 关键词搜索：深色 → 外观
        search.value = '深色';
        search.dispatchEvent(new Event('input', { bubbles: true }));
        out.searchKw = [...document.querySelectorAll('.cfg-nav-item')]
          .filter((b) => b.style.display !== 'none')
          .map((b) => b.dataset.sec)
          .includes('appearance');
        search.value = 'zzzz-no-match';
        search.dispatchEvent(new Event('input', { bubbles: true }));
        out.cfgSearchEmpty = !document.getElementById('cfgSearchEmpty').hidden;
        search.value = '';
        search.dispatchEvent(new Event('input', { bubbles: true }));
        out.cfgSearchEmpty = out.cfgSearchEmpty && document.getElementById('cfgSearchEmpty').hidden;
        {
          const mkEmpty = (cls) => {
            const el = document.createElement('div');
            el.className = 'empty-row ' + cls;
            el.textContent = 'probe';
            document.body.appendChild(el);
            return el;
          };
          const e0 = mkEmpty('');
          const e1 = mkEmpty('loading');
          const e2 = mkEmpty('error');
          const e3 = mkEmpty('search');
          out.emptyStateVariants =
            getComputedStyle(e0, '::before').content !== 'none' &&
            getComputedStyle(e1, '::before').animationName.includes('empty-spin') &&
            getComputedStyle(e2, '::before').content.includes('!') &&
            getComputedStyle(e3, '::before').content !== 'none';
          out.emptyStateMotion = getComputedStyle(e0).animationName.includes('ui-fade-up');
          // 阶段 6：四种空态图标覆盖（emptyIconsCoverage）
          // 三种字符图标（∅ / ! / ⌕）+ loading 的 spinner 动画，避免依赖 computed content 的引号表示
          const iconText = (el) => getComputedStyle(el, '::before').content.replace(/^"|"$/g, '');
          const loadingBefore = getComputedStyle(e1, '::before');
          out.emptyIconsCoverage =
            iconText(e0) === '∅' &&
            iconText(e2) === '!' &&
            iconText(e3) === '⌕' &&
            loadingBefore.animationName.includes('empty-spin') &&
            parseFloat(loadingBefore.width) > 0;
          [e0, e1, e2, e3].forEach((el) => el.remove());
          const di = document.createElement('input');
          di.className = 'input';
          di.disabled = true;
          document.body.appendChild(di);
          out.disabledInputStyle = getComputedStyle(di).cursor === 'not-allowed';
          di.remove();
          const db = document.createElement('button');
          db.className = 'btn';
          db.disabled = true;
          document.body.appendChild(db);
          out.disabledButtonTransition =
            getComputedStyle(db).transitionProperty.includes('opacity');
          db.remove();
        }
        setCfgSection('hooks');
        await new Promise((r) => setTimeout(r, 350));
        out.hooks = /hooks\\.json$/.test((document.getElementById('hkPath') || {}).textContent || '');
        out.hkRestore = !!document.getElementById('hkRestore');
        // hooks JSON 格式化 + 记忆字数
        const hkt = document.getElementById('hkText');
        hkt.value = '{"a":1}';
        document.getElementById('hkFormat').click();
        out.hookFormat = hkt.value.includes(String.fromCharCode(10));
        setCfgSection('memory');
        await new Promise((r) => setTimeout(r, 200));
        out.memCount = /字符/.test((document.getElementById('memCount') || {}).textContent || '');
        out.projectCtx = !!document.getElementById('projText');
        out.memRestore = !!document.getElementById('memRestore');
        out.projRestore = !!document.getElementById('projRestore');
        // 命令批量启停 + MCP/技能刷新
        setCfgSection('commands');
        await new Promise((r) => setTimeout(r, 150));
        out.cmdBulk = !!document.getElementById('cmdEnableAll') && !!document.getElementById('cmdDisableAll');
        {
          const cmdRow = document.querySelector('#cmdList .list-row');
          out.cmdEnterMotion =
            !!cmdRow &&
            (cmdRow.classList.contains('enter') &&
              getComputedStyle(cmdRow).transitionProperty.includes('background-color'));
        }
        setCfgSection('mcp');
        await new Promise((r) => setTimeout(r, 150));
        out.refreshBtns = !!document.getElementById('mRefresh');
        out.mcpImport = !!document.getElementById('mImport');
        setCfgSection('skills');
        await new Promise((r) => setTimeout(r, 150));
        out.refreshBtns = out.refreshBtns && !!document.getElementById('skRefresh');
        {
          // R78 监工U：环境可能没装技能——无 DOM 行时改测 CSS 规则（避免空列表被算通过）
          const skillRow = document.querySelector('#skList .list-row');
          const cssHasEnter = Array.from(document.styleSheets).some((ss) => {
            try { return Array.from(ss.cssRules).some((r) => r.selectorText && r.selectorText.includes('.list-row.enter') && /animation|transition/.test(r.cssText)); }
            catch { return false; }
          });
          out.skillEnterMotion = skillRow
            ? (skillRow.classList.contains('enter') && getComputedStyle(skillRow).transitionProperty.includes('background-color'))
            : cssHasEnter;
        }
        const backBtn = document.getElementById('cfgBack');
        out.cfgBack = !!backBtn && backBtn.textContent.includes('返回');
        const settingsWasOpen = document
          .getElementById('settingsPage')
          .classList.contains('show');
        if (!settingsWasOpen) {
          await openSettings();
          await new Promise((r) => setTimeout(r, 250));
        }
        if (backBtn) {
          const bb = backBtn.getBoundingClientRect();
          const hitEl = document.elementFromPoint(bb.left + bb.width / 2, bb.top + bb.height / 2);
          out.cfgBackHit = !!(hitEl && (hitEl === backBtn || hitEl.closest('#cfgBack')));
          out.cfgBackHitEl = hitEl
            ? hitEl.id || String(hitEl.className || '').slice(0, 40) || hitEl.tagName
            : 'none';
          out.cfgBackBox = [Math.round(bb.left), Math.round(bb.top), Math.round(bb.width), Math.round(bb.height)];
          const cfgHead = document.querySelector('.cfg-head');
          out.cfgDrag =
            !!cfgHead &&
            getComputedStyle(cfgHead).getPropertyValue('-webkit-app-region').trim() === 'drag';
          out.cfgMotion = getComputedStyle(document.getElementById('settingsPage')).animationName.includes('ui-page-in');
          setCfgSection('about');
          out.cfgSectionMotion = getComputedStyle(document.getElementById('cfgBody')).animationName.includes('cfg-section-in');
          await new Promise((r) => setTimeout(r, 30));
          out.brandUnified = out.brandUnified && !!document.querySelector('.brand-mark');
          const brandImg = document.querySelector('.brand-mark');
          const brandSrc = brandImg ? (brandImg.getAttribute('src') || '') : '';
          window.__brandSrc = brandSrc;
          out.iconUnified =
            !!brandImg &&
            brandSrc.indexOf('icon-') >= 0 &&
            brandSrc.indexOf('.png') > brandSrc.indexOf('icon-') &&
            brandSrc.indexOf('brand.svg') < 0;
          const inkEl = document.getElementById('cfgNavInk');
          const inkBefore = inkEl ? inkEl.style.transform : '';
          const inkHeight = inkEl ? parseFloat(inkEl.style.height) || 0 : 0;
          setCfgSection('appearance');
          const inkAfter = inkEl ? inkEl.style.transform : '';
          out.cfgNavInk = !!inkEl && inkHeight > 0 && inkBefore !== inkAfter && inkEl.style.opacity === '1';
          const themeSeg = document.querySelector('.row.seg[data-seg="theme"]');
          const thumbEl = themeSeg && themeSeg.querySelector('.seg-thumb');
          out.segThumbMotion =
            !!thumbEl &&
            ['0', '1', '2'].includes(themeSeg.style.getPropertyValue('--i')) &&
            getComputedStyle(thumbEl).transitionProperty.includes('transform') &&
            parseFloat(getComputedStyle(thumbEl).width) > 0;
          setCfgSection('providers');
        }
        if (!settingsWasOpen) await closeSettings();
        out.modalApi = typeof showTextModal === 'function';
        // Goal / 本地命令 / 运行时提醒 套件断言（纯函数 + DOM 探针，不向内核发消息）
        out.goalSuite = await (async () => {
          // 探针原状态在 try 外声明，catch 兜底还原时可访问
          let fake = null;
          let prevCur = null;
          let prevMcp = null;
          let prevCfgSection = null;
          try {
            const g = {
              objective: '完善 Qcode 交互',
              title: '完善 Qcode 交互',
              status: 'active',
              round: 1,
              tokensUsed: 1200,
              timeUsedSeconds: 65,
              tokenBudget: null,
              maxRounds: 0,
              rounds: [{ n: 1, title: '首轮', startedAt: Date.now(), tokens: 1200, durationMs: 9000 }],
              verifications: [{ n: 2, outcome: 'notSatisfied', reason: '还差 UI 细节', nextAction: '打磨轮次条', at: Date.now() }],
            };
            const cont = goalContinuationPrompt(g, { nextAction: 'X', reason: 'R' });
            const okCont =
              cont.includes('<goal_round>') &&
              cont.includes('Round: 1/unbounded') &&
              cont.includes('X') &&
              cont.includes('Do not mark the goal complete yourself');
            const verify = goalVerifyPrompt(g);
            const okVerify =
              verify.includes('"passed"') &&
              verify.includes('<untrusted_objective>') &&
              verify.includes('nextAction') &&
              verify.includes('evidence');
            const tick = String.fromCharCode(96);
            const p1 = parseGoalVerification(
              [tick + tick + tick + 'json', '{"passed":true,"reason":"r","nextAction":""}', tick + tick + tick].join('\\n')
            );
            const p2 = parseGoalVerification('前缀 {"passed":false,"reason":"a","nextAction":"b"} 后缀');
            const okParse =
              p1.ok && p1.data.passed === true && p2.ok && p2.data.nextAction === 'b' &&
              !parseGoalVerification('nope').ok;
            const remText = goalStateReminder(g);
            const okRem = remText.includes('authoritative') && remText.includes(g.objective) && remText.includes('Round: 1/unbounded');
            const full = buildPlanReminder({ approvalMode: 'plan', messages: [] });
            const sparseOff =
              buildPlanReminder({ approvalMode: 'plan', messages: [{ role: 'user', planReminder: 1, text: '' }] }) === null;
            const autoOff = buildPlanReminder({ approvalMode: 'auto', messages: [] }) === null;
            const todoS = { messages: [] };
            // todo_write 放在 10 个助手轮之前，之后再来 10 轮，才满足「10 轮未用 todo」触发
            todoS.messages.push({
              role: 'assistant',
              blocks: [{ type: 'tool', name: 'todo_write', input: { todos: [{ status: 'completed', content: 'alpha' }, { status: 'pending', content: 'beta' }] } }],
            });
            for (let i = 0; i < 10; i++) todoS.messages.push({ role: 'assistant', blocks: [] });
            const todo = buildTodoReminder(todoS);
            const okTodo = !!todo && todo.text.includes('todo_write') && todo.text.includes('- [completed] alpha');
            const todoEarly =
              buildTodoReminder({ messages: [{ role: 'assistant', blocks: [{ type: 'tool', name: 'todo_write', input: { todos: [] } }] }] }) === null;
            const okDate =
              buildDateReminder({ lastTurnDate: '2000-01-01' }).includes('date has changed') &&
              buildDateReminder({ lastTurnDate: new Date().toISOString().slice(0, 10) }) === null;
            const okRewrite =
              rewriteCliSource('/compress fast') === '/compress-fast fast' &&
              rewriteCliSource('/compact') === '/compress-fast' &&
              rewriteCliSource('/summary') === '/summary';
            const okInit =
              buildInitAgentsPrompt('F:\\\\demo', '注意项').includes('AGENTS.md') &&
              buildInitAgentsPrompt('F:\\\\demo', '').includes('.qwen') &&
              buildInitAgentsPrompt('F:\\\\demo', '注意项').includes('Additional user instructions');
            const reviewText = buildReviewPrompt('F:\\\\demo', 'src/x.js');
            const okReview =
              reviewText.includes('P0') &&
              reviewText.includes('file:line') &&
              reviewText.includes('src/x.js') &&
              reviewText.includes('AGENTS.md') &&
              reviewText.includes('do NOT modify files');
            // Goal 状态条 DOM（伪会话探针，不污染真实会话）
            fake = {
              id: 's_probe_goal_' + Date.now().toString(36),
              title: 'probe',
              messages: [
                { role: 'user', text: 'pr', hidden: true, goalRound: 1 },
                { role: 'assistant', goalRound: 1, blocks: [{ type: 'tool', name: 'todo_write', input: { todos: [{ status: 'completed', content: 'a' }, { status: 'pending', content: 'b' }] } }] },
              ],
              goal: JSON.parse(JSON.stringify(g)),
            };
            prevCur = state.current;
            state.current = fake;
            renderGoal(fake);
            const bar = $('goalBar');
            const okBar =
              !!bar && !bar.hidden &&
              /进行中/.test((bar.querySelector('.goal-chip') || {}).textContent || '') &&
              ((bar.querySelector('.goal-round-count') || {}).textContent || '') === '1/2' &&
              !!bar.querySelector('.goal-outcome.loop') &&
              !!bar.querySelector('[data-jump-mi="1"]') &&
              // 控制按钮键盘/读屏可达
              [...bar.querySelectorAll('.goal-btn')].length >= 3 &&
              [...bar.querySelectorAll('.goal-btn')].every((b) => !!b.getAttribute('aria-label')) &&
              !!bar.querySelector('.goal-btn[data-gact="toggle"][aria-expanded="false"]');
            // 轮次行内联 todo 明细：计数可点，展开含三态标记，再点收起
            const cntEl = bar.querySelector('.goal-round-count.togglable');
            const detailEl = bar.querySelector('.goal-todos[data-for="1"]');
            const okTodosClosed = !!cntEl && !!detailEl && detailEl.hidden;
            if (cntEl) cntEl.click();
            const okTodosOpen =
              !!detailEl && !detailEl.hidden &&
              detailEl.textContent.includes('[×]') &&
              detailEl.textContent.includes('[ ]') &&
              detailEl.textContent.includes(' a') &&
              detailEl.textContent.includes(' b');
            if (cntEl) cntEl.click();
            const okTodosToggle = okTodosClosed && okTodosOpen && detailEl.hidden;
            // Goal 终态本地卡片：完成/受阻两态渲染 + 导出文本含标记
            const cardFake = {
              id: 's_probe_card_' + Date.now().toString(36),
              title: 'probe',
              messages: [
                { role: 'system', goalStatus: 'complete', text: '全部需求已实现', ts: Date.now() },
                { role: 'system', goalStatus: 'blocked', text: '轮数上限', ts: Date.now() + 1 },
              ],
            };
            const prevCur2 = state.current;
            state.current = cardFake;
            renderThread();
            const threadCards = document.querySelectorAll('#thread .goal-status-card');
            const okCardRender =
              threadCards.length === 2 &&
              !!document.querySelector('#thread .goal-status-card.complete') &&
              !!document.querySelector('#thread .goal-status-card.blocked');
            const md = sessionToMarkdown(cardFake);
            const okCardExport = md.includes('Goal 已完成') && md.includes('Goal 已受阻');
            state.current = prevCur2;
            renderThread();
            const okPal =
              paletteItems('/goal').some((it) => it.label === '/goal' && /本地/.test(it.hint || '')) &&
              paletteItems('').some((it) => /^Goal · 第 1 轮/.test(it.label));
            const okPill =
              goalPillHtml(fake).includes('1/∞') &&
              goalPillHtml(fake).includes('goal-pill run') &&
              (() => {
                const doneFake = JSON.parse(JSON.stringify(fake));
                doneFake.goal.status = 'complete';
                return goalPillHtml(doneFake).includes('goal-pill done');
              })() &&
              goalPillHtml({}) === '';
            const resumePlan = (code) => {
              const f = JSON.parse(JSON.stringify(fake));
              f.goal.status = 'blocked';
              f.goal.blockedReason = { code, message: 'x' };
              return goalResumePlan(f.goal);
            };
            const okResumePlan =
              !!resumePlan('token-budget') && resumePlan('token-budget').kind === 'unbudget' &&
              !!resumePlan('round-limit') && resumePlan('round-limit').kind === 'extend' &&
              resumePlan('round-limit').step > 0 &&
              resumePlan('verifier-invalid') === null;
            // 跨模块审计修复：末尾 system 卡不误导 currentTurnAssistant / retryLast / 导入
            const auxFake = {
              id: 's_probe_aux_' + Date.now().toString(36),
              messages: [
                { role: 'user', text: '用户原文', ts: Date.now() },
                { role: 'user', text: 'model-only 续跑', hidden: true, goalRound: 1, ts: Date.now() },
                { role: 'assistant', blocks: [], pending: false, ts: Date.now() },
                { role: 'system', goalStatus: 'complete', text: '完成', ts: Date.now() },
              ],
            };
            const asst = currentTurnAssistant(auxFake);
            const okTurnAssistant = !!asst && asst.role === 'assistant' && asst.blocks.length === 0;
            const okImportNorm = (() => {
              const im = sanitizeImportedSession({ messages: auxFake.messages });
              const roles = im.messages.map((m) => m.role);
              return roles[0] === 'user' && roles[3] === 'system' &&
                im.messages[3].goalStatus === 'complete';
            })();
            const okImportGoal = (() => {
              const im = sanitizeImportedSession({ goal: { status: 'active', objective: 'x', round: 2 }, messages: [] });
              return im.goal && im.goal.status === 'paused' && im.goal.blockedReason.code === 'imported';
            })();
            // 自动归档：用真正的 shouldAutoArchiveSession 判定活跃 Goal 豁免
            const archiveFake = {
              id: 's_probe_arch_' + Date.now().toString(36),
              updatedAt: 1,
              archived: false,
              lazy: false,
              goal: { status: 'active', objective: 'x' },
            };
            const archiveCtx = { running: () => false, queued: () => false };
            const okArchiveSkip = !shouldAutoArchiveSession(archiveFake, Date.now(), archiveCtx);
            archiveFake.goal.status = 'complete';
            const okArchiveAllow = shouldAutoArchiveSession(archiveFake, Date.now(), archiveCtx);
            // 排队消息后的续跑：用真正的 cache/consume 函数验证缓存→消费语义
            const contFake = JSON.parse(JSON.stringify(fake));
            const cached = cacheGoalContinuation(contFake.goal, '打磨轮次条', 'r');
            const okContCache =
              !!contFake.goal.pendingContinuation &&
              cached.nextAction === '打磨轮次条' &&
              cached.reason === 'r' &&
              contFake.goal.pendingContinuation.nextAction === '打磨轮次条';
            const consumed = consumeGoalContinuation(contFake.goal);
            const okContConsumed =
              !!consumed && consumed.nextAction === '打磨轮次条' &&
              !contFake.goal.pendingContinuation &&
              consumeGoalContinuation(contFake.goal) === null;
            // 手动归档活跃 Goal：用真正的 pauseGoalForArchive 执行
            const archGoalFake = JSON.parse(JSON.stringify(fake));
            archGoalFake.goal.status = 'active';
            archGoalFake.goal.pendingContinuation = { nextAction: 'x' };
            archGoalFake.archived = true;
            const pausedByArchive = pauseGoalForArchive(archGoalFake);
            const okArchivePause =
              pausedByArchive === true &&
              archGoalFake.goal.status === 'paused' &&
              !archGoalFake.goal.pendingContinuation &&
              archGoalFake.goal.blockedReason.code === 'archived' &&
              // 未在归档/非 active 时不重复暂停
              pauseGoalForArchive(archGoalFake) === false;
            // /goal edit 语义：用真正的 applyGoalEdit 改 objective，进度不变
            const editFake = JSON.parse(JSON.stringify(fake));
            const beforeRound = editFake.goal.round;
            const beforeTokens = editFake.goal.tokensUsed;
            applyGoalEdit(editFake.goal, '新目标');
            const editReminderOk = String(editFake.goal.pendingReminder || '').indexOf('edited (progress preserved)') >= 0;
            const okGoalEdit =
              editFake.goal.objective === '新目标' &&
              editFake.goal.round === beforeRound &&
              editFake.goal.tokensUsed === beforeTokens &&
              editReminderOk;
            // 队列非空时抑制 Goal 续跑：用真正的 shouldResumeGoalAfterTurn
            const okQueueGuard =
              shouldResumeGoalAfterTurn(fake, false, 0) === true &&
              shouldResumeGoalAfterTurn(fake, false, 1) === false &&
              shouldResumeGoalAfterTurn(fake, true, 0) === false;
            state.current = prevCur;
            renderGoal(prevCur);
            renderThread();
            renderSidebar();
            state.runtimes.delete(fake.id);
            // 探针完整性：结束后不应残留任何探针会话的 DOM
            const okProbeClean =
              !document.querySelector('[data-sid="' + fake.id + '"]') &&
              !document.querySelector('[data-sid="' + cardFake.id + '"]') &&
              !document.querySelector('[data-sid="' + auxFake.id + '"]');
            // 后台会话 Goal 不得污染当前状态条：用非当前会话 renderGoal 后 DOM 不应变化
            const barBefore = $('goalBar') ? $('goalBar').innerHTML : '';
            const bgFake = JSON.parse(JSON.stringify(fake));
            bgFake.id = 's_probe_bg_' + Date.now().toString(36);
            bgFake.goal.title = '后台会话 Goal';
            renderGoal(bgFake);
            const okBgGuard = !!$('goalBar') && $('goalBar').innerHTML === barBefore;
            const okLocal =
              LOCAL_COMMANDS.length >= 9 &&
              findLocalCommand('clear').name === 'new' &&
              findLocalCommand('compact').name === 'compress' &&
              findLocalCommand('variant').name === 'effort' &&
              LOCAL_COMMANDS.every((c) => c.usage && c.summary && c.detail);
            const sid = state.current && state.current.id;
            prevMcp = state.mcpServers;
            handleAgentEvent({
              sessionId: sid,
              event: { type: 'system', subtype: 'init', mcp_servers: [{ name: 'qcode-probe', status: 'connected' }] },
            });
            const okMcp = (state.mcpServers || []).some((sv) => sv.name === 'qcode-probe' && sv.status === 'connected');
            // MCP 卡片重连按钮 + 预算 meta（DOM 探针，探完还原）
            let okMcpCard = false;
            let okBudget = false;
            const prevServers =
              state.extras && state.extras.mcpServers ? state.extras.mcpServers : null;
            prevCfgSection = typeof cfgSection !== 'undefined' ? cfgSection : null;
            try {
              if (state.extras) {
                state.extras.mcpServers = Object.assign({}, prevServers || {}, {
                  'qcode-probe': { command: 'qcode-probe-cmd' },
                });
              }
              state.mcpServers = [{ name: 'qcode-probe', status: 'disconnected' }];
              setCfgSection('mcp');
              okMcpCard = !!document.querySelector('#mList .btn.mcp-reconnect');
              fake.goal.tokenBudget = 50000;
              state.current = fake;
              renderGoal(fake);
              const budgetMeta = (($('goalBar') || {}).querySelector ? (($('goalBar').querySelector('.goal-meta') || {}).textContent || '') : '');
              okBudget = budgetMeta.indexOf('/50') >= 0;
              state.current = prevCur;
              renderGoal(prevCur);
              state.runtimes.delete(fake.id);
            } finally {
              if (state.extras) {
                if (prevServers) state.extras.mcpServers = prevServers;
                else delete state.extras.mcpServers;
              }
              state.mcpServers = prevMcp;
              if (prevCfgSection !== null) {
                cfgSection = prevCfgSection;
                setCfgSection(prevCfgSection);
              }
            }
            const suiteParts = {
              okCont, okVerify, okParse, okRem, planFull: !!full && full.full === true,
              sparseOff, autoOff, okTodo, todoEarly, okDate, okRewrite, okInit,
              okReview, okBar, okTodosToggle, okCardRender, okCardExport, okPal, okPill,
              okResumePlan, okTurnAssistant, okImportNorm, okImportGoal,
              okArchiveSkip, okArchiveAllow, okProbeClean, okBgGuard,
              okContCache, okContConsumed, okArchivePause, okGoalEdit, okQueueGuard,
              okLocal, okMcp, okMcpCard, okBudget,
            };
            const failedParts = Object.entries(suiteParts).filter(([, v]) => !v).map(([k]) => k);
            const nonBool = Object.entries(suiteParts).filter(([, v]) => typeof v !== 'boolean').map(([k, v]) => k + '=' + typeof v);
            if (nonBool.length) console.error('[smoke] goalSuite non-boolean parts: ' + nonBool.join(','));
            // 通过 window 变量把细分结果带到主进程（诊断 + 长期可观测）
            window.__goalSuiteParts = suiteParts;
            window.__goalSuiteFailed = failedParts;
            window.__goalSuiteNonBool = nonBool;
            if (failedParts.length) console.error('[smoke] goalSuite failed parts: ' + failedParts.join(','));
            if (failedParts.length) console.error('[smoke] goalSuite failed parts: ' + failedParts.join(','));
            return (
              okCont && okVerify && okParse && okRem && !!full && full.full === true &&
              sparseOff && autoOff && okTodo && todoEarly && okDate && okRewrite && okInit &&
              okReview && okBar && okTodosToggle && okCardRender && okCardExport && okPal && okPill && okResumePlan && okTurnAssistant && okImportNorm && okImportGoal && okArchiveSkip && okArchiveAllow && okProbeClean && okBgGuard && okContCache && okContConsumed && okArchivePause && okGoalEdit && okQueueGuard && okLocal && okMcp && okMcpCard && okBudget
            );
          } catch (e) {
            console.error('[smoke] goal suite error', e);
            // 兜底还原：断言中途抛错也不能污染后续冒烟步骤
            try {
              if (prevCur) {
                state.current = prevCur;
                renderGoal(prevCur);
                renderThread();
                renderSidebar();
              }
              if (prevMcp !== null) state.mcpServers = prevMcp;
              if (prevCfgSection !== null) {
                cfgSection = prevCfgSection;
                setCfgSection(prevCfgSection);
              }
              if (fake && fake.id) state.runtimes.delete(fake.id);
            } catch {}
            return false;
          }
        })();
        const modalProbe = document.createElement('div');
        modalProbe.className = 'text-modal-mask closing';
        modalProbe.innerHTML = '<div class="text-modal"></div>';
        document.body.appendChild(modalProbe);
        out.modalCloseMotion =
          getComputedStyle(modalProbe).animationName.includes('ui-fade-out') &&
          getComputedStyle(modalProbe.firstElementChild).animationName.includes('ui-fade-out');
        modalProbe.remove();
        const exLazy = await window.shell.extras();
        out.usageLazy = !Object.prototype.hasOwnProperty.call(exLazy || {}, 'usage');
        setCfgSection('usage');
        for (let i = 0; i < 20 && !(state.extras && state.extras.usage); i++) {
          await new Promise((r) => setTimeout(r, 150));
        }
        out.weekly = document.querySelectorAll('#uWeekly .wcol').length === 7;
        // R31：weekly 首遍折叠产出 7 天且每天有 date/tokens/calls 字段
        {
          const u31 = state.extras && state.extras.usage;
          out.weeklyFold = !!(u31 && Array.isArray(u31.weekly) && u31.weekly.length === 7 &&
            u31.weekly.every((d) => d && typeof d.date === 'string' && typeof d.tokens === 'number' && typeof d.calls === 'number'));
        }
        out.usageExport = !!document.getElementById('uExport');
        setCfgSection('advanced');
        await new Promise((r) => setTimeout(r, 200));
        out.safe = (document.getElementById('aSafe') || {}).textContent || '';
        out.sysPrompt = !!document.getElementById('aSysPrompt');
        out.gpuToggle =
          !!document.getElementById('aGpuToggle') &&
          !!document.getElementById('aGpuFlags') &&
          !!document.getElementById('aGpuFlagsSave') &&
          document.getElementById('aGpuToggle').textContent.includes('硬件加速');
        out.turnTimeoutOption =
          !!document.getElementById('aTimeout') &&
          [...document.querySelectorAll('#aTimeout option')].length >= 5;
        setCfgSection('shortcuts');
        await new Promise((r) => setTimeout(r, 200));
        out.scEdit = !!document.getElementById('scEdit') && document.getElementById('scEdit').children.length >= 4;
        // markdown：嵌套列表、任务项、删除线
        const md = renderMarkdown(
          '- a' +
            String.fromCharCode(10) +
            '  - b' +
            String.fromCharCode(10) +
            '- [x] done' +
            String.fromCharCode(10) +
            '~~gone~~'
        );
        out.mdNested = (md.match(/<ul>/g) || []).length >= 2;
        out.mdTask = md.includes('type="checkbox"') && md.includes('checked') && md.includes('<li class="task">');
        out.mdStrike = md.includes('<del>gone</del>');
        // Markdown 渲染缓存：同一文本第二次命中，结果保持一致
        const mdCacheSrc =
          '## 缓存' +
          String.fromCharCode(10) +
          String.fromCharCode(10) +
          '**加粗** ' +
          String.fromCharCode(96) +
          'code' +
          String.fromCharCode(96);
        mdCacheReset();
        const mdCacheA = renderMarkdown(mdCacheSrc);
        const mdCacheB = renderMarkdown(mdCacheSrc);
        const mdStats = mdCacheStats();
        out.mdCache =
          mdCacheA === mdCacheB && mdStats.hits === 1 && mdStats.misses === 1 && mdStats.size === 1;
        // R38：正文 block DOM 节点缓存——同一 block 重复取走 cloneNode（新元素同内容）
        {
          const blk = { type: 'text', text: '缓存正文 **加粗** 内容' };
          const e1 = blockElement(blk), h1 = e1.innerHTML;
          const e2 = blockElement(blk), h2 = e2.innerHTML;
          blk.text = '缓存正文 **改后** 内容';
          const h3 = blockElement(blk).innerHTML;
          out.mdBlockNodeCache = e1 !== e2 && h1 === h2 && h1.indexOf('<strong>') >= 0 &&
            h3 !== h2 && h3.indexOf('改后') >= 0;
        }
        // R21：无标记文本跳过 4 遍行内正则（结果与逐条替换一致），有标记仍正常排版
        {
          const NL21 = String.fromCharCode(10);
          const plain21 = '普通正文没有标记 ' + '内容'.repeat(30) + NL21 + '第二行也没有';
          const marked21 = '**粗** ' + String.fromCharCode(96) + '码' + String.fromCharCode(96) + ' ~~删~~ [链](https://x.co)';
          out.inlineMarkupGuard =
            inlineMarkup(plain21) === plain21 &&
            inlineMarkup(marked21).indexOf('<strong>') >= 0 &&
            inlineMarkup(marked21).indexOf('<code class="inline">') >= 0 &&
            inlineMarkup(marked21).indexOf('<del>') >= 0 &&
            inlineMarkup(marked21).indexOf('<a href=') >= 0;
          // R22：行尾修剪与 /\s+$/ 语义一致；围栏守卫不影响代码块渲染
          out.trimLineEndGuard =
            trimLineEnd('abc   ') === 'abc' &&
            trimLineEnd('abc') === 'abc' &&
            trimLineEnd('a' + String.fromCharCode(9) + ' ') === 'a' &&
            trimLineEnd('') === '';
          const F = String.fromCharCode(96);
          const fenceMd = F + F + F + 'js' + String.fromCharCode(10) + 'const a = 1;' + String.fromCharCode(10) + F + F + F;
          const fenceHtml = renderMarkdown(fenceMd);
          out.fenceGuard = fenceHtml.indexOf('code-wrap') >= 0 &&
            fenceHtml.indexOf('const a = 1;') >= 0 &&  // 占位符还原成功
            fenceHtml.indexOf('BLOCK') < 0 &&           // 无残留占位符
            renderMarkdown('无代码块的纯正文').indexOf('code-wrap') < 0;
          // R28：trimLineEnd 后纯空白行变 ''，!line 空判定仍正确分段/闭合列表
          const NL28 = String.fromCharCode(10), SP28 = ' ';
          const blankMd = '第一段' + NL28 + SP28 + SP28 + NL28 + '第二段' + NL28 + '- a' + NL28 + SP28 + NL28 + '收尾';
          const blankHtml = renderMarkdown(blankMd);
          out.blankLineGuard =
            (blankHtml.match(/<p>/g) || []).length === 3 &&
            blankHtml.indexOf('<ul>') >= 0 &&
            blankHtml.indexOf('</ul>') >= 0;
        }
        const msgProbe = document.createElement('div');
        msgProbe.className = 'msg enter';
        document.body.appendChild(msgProbe);
        out.msgAnimation = getComputedStyle(msgProbe).animationName.includes('msg-in');
        msgProbe.remove();
        // R24：消息外壳渲染支持传入容器（renderThread 复用已算好的 inner，省每条消息一次 querySelector）
        {
          const box = document.createElement('div');
          const u = renderUserMessage({ role: 'user', text: 'probe' }, box);
          const a = renderAssistantShell(box);
          out.shellContainerReuse = u.parentNode === box && a.parentNode === box && box.children.length === 2;
        }
        const toolProbe = toolElement({
          type: 'tool',
          name: 'motion-probe',
          input: {},
          state: 'done',
          output: 'ok',
        });
        toolProbe.classList.add('enter');
        document.body.appendChild(toolProbe);
        out.toolAnimation = getComputedStyle(toolProbe).animationName.includes('tool-in');
        out.toolBodyMotion = getComputedStyle(
          toolProbe.querySelector('.tool-body')
        ).transitionProperty.includes('grid-template-rows');
        out.toolTimeMono = getComputedStyle(
          toolProbe.querySelector('.tool-head .state')
        ).fontFamily.includes('mono');
        toolProbe.remove();
        const errProbe = toolElement({ type: 'tool', name: 'err-probe', input: {}, state: 'error', output: 'x' });
        document.body.appendChild(errProbe);
        out.toolErrorBar = getComputedStyle(errProbe, '::after').content !== 'none';
        errProbe.remove();
        const thinkProbe = thinkElement('THINK-PROBE');
        document.body.appendChild(thinkProbe);
        const thinkHead = thinkProbe.querySelector('.think-head');
        thinkHead.click();
        out.thinkingCollapseMotion =
          thinkProbe.classList.contains('open') &&
          getComputedStyle(thinkProbe.querySelector('.think-body-wrap')).transitionProperty.includes(
            'grid-template-rows'
          );
        thinkProbe.remove();
        const stoppedProbe = document.createElement('div');
        stoppedProbe.className = 'msg assistant';
        stoppedProbe.innerHTML = metaMarkup({ ts: Date.now(), stopped: '已停止' }, false);
        document.body.appendChild(stoppedProbe);
        out.stoppedMarkerStyle =
          !!stoppedProbe.querySelector('.stopped-mark') &&
          getComputedStyle(stoppedProbe.querySelector('.stopped-mark')).color.includes(
            '192'
          );
        stoppedProbe.remove();
        const fence = String.fromCharCode(96).repeat(3);
        const nl = String.fromCharCode(10);
        const mdCode = renderMarkdown(
          fence + 'js' + nl + Array.from({ length: 12 }, (_, i) => 'line' + i).join(nl) + nl + fence
        );
        const codeDoc = new DOMParser().parseFromString(mdCode, 'text/html');
        const codeEl = codeDoc.querySelector('pre.ln code');
        out.codeLineNumbers =
          !!codeEl &&
          codeEl.querySelectorAll('.cl').length === 12 &&
          (codeEl.dataset.code || '').includes('line11');
        // R33：短代码块 data-code 与正文共用一次转义，内容仍正确
        {
          const F33 = String.fromCharCode(96), nl33 = String.fromCharCode(10);
          const shortMd = F33 + F33 + F33 + 'js' + nl33 + 'const x = <a> & "b";' + nl33 + F33 + F33 + F33;
          const shortDoc = new DOMParser().parseFromString(renderMarkdown(shortMd), 'text/html');
          const sc = shortDoc.querySelector('pre code');
          out.codeEscDedup = !!sc &&
            (sc.dataset.code || '').indexOf('<a>') >= 0 &&
            sc.textContent.indexOf('<a>') >= 0 &&
            sc.querySelectorAll('.cl').length === 0;
        }
        const runProbe = toolElement({ type: 'tool', name: 'run-probe', input: {}, state: 'running' });
        document.body.appendChild(runProbe);
        out.toolProgressMotion = getComputedStyle(runProbe, '::before').animationName.includes(
          'tool-progress'
        );
        runProbe.remove();
        const openProbe = toolElement({ type: 'tool', name: 'open-probe', input: {}, state: 'error', output: 'boom' });
        openProbe.style.position = 'absolute';
        openProbe.style.left = '-9999px';
        document.body.appendChild(openProbe);
        await new Promise((r) => setTimeout(r, 300));
        out.toolBodyOpen = openProbe.querySelector('.tool-body').getBoundingClientRect().height > 10;
        openProbe.remove();
        const caretProbe = toolElement({ type: 'tool', name: 'caret-probe', input: {}, state: 'done', output: 'x' });
        document.body.appendChild(caretProbe);
        out.toolCaretMotion = getComputedStyle(
          caretProbe.querySelector('.tool-head'),
          '::after'
        ).transitionProperty.includes('transform');
        caretProbe.remove();
        const copyTool = toolElement({
          type: 'tool',
          name: 'copy-probe',
          input: {},
          state: 'done',
          output: 'COPY-ME',
        });
        document.body.appendChild(copyTool);
        const prevWrite = navigator.clipboard && navigator.clipboard.writeText;
        if (navigator.clipboard) Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: () => Promise.resolve() });
        try {
          const toolCopyBtn = copyTool.querySelector('[data-tool-copy]');
          if (toolCopyBtn) toolCopyBtn.click();
          await new Promise((r) => setTimeout(r, 20));
          out.toolCopyFeedback =
            !!toolCopyBtn &&
            toolCopyBtn.classList.contains('copied') &&
            getComputedStyle(toolCopyBtn).animationName.includes('copy-pop');
        } finally {
          if (navigator.clipboard && prevWrite) Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: prevWrite });
        }
        copyTool.remove();
        const codeProbe = document.createElement('div');
        codeProbe.className = 'code-wrap';
        codeProbe.innerHTML =
          '<button class="code-copy" data-code-copy>复制</button><pre><code>CODE-ME</code></pre>';
        document.body.appendChild(codeProbe);
        const codeCopyBtn = codeProbe.querySelector('[data-code-copy]');
        if (navigator.clipboard) Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: () => Promise.resolve() });
        codeCopyBtn.click();
        await new Promise((r) => setTimeout(r, 20));
        if (navigator.clipboard && prevWrite) Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: prevWrite });
        out.codeCopyFeedback =
          codeCopyBtn.classList.contains('copied') &&
          getComputedStyle(codeCopyBtn).animationName.includes('copy-pop') &&
          codeCopyBtn.textContent === '已复制';
        codeProbe.remove();
        const shimmerProbe = document.createElement('div');
        shimmerProbe.className = 'sk-line';
        document.body.appendChild(shimmerProbe);
        out.skeletonShimmer = getComputedStyle(shimmerProbe).animationName.includes(
          'skeleton-shimmer'
        );
        shimmerProbe.remove();
        const firstFadeProbe = document.createElement('div');
        firstFadeProbe.className = 'thread-inner first-in';
        document.body.appendChild(firstFadeProbe);
        out.firstLoadFade = getComputedStyle(firstFadeProbe).animationName.includes(
          'thread-first-in'
        );
        firstFadeProbe.remove();
        out.scrollDetail =
          getComputedStyle(document.getElementById('thread')).scrollbarGutter === 'stable';
        // 流式跟随：thread 不能用 scroll-behavior:smooth，否则每帧 scrollTop 被平滑动画
        // 打断，对话跟不上进度（真实 bug 回归锁）
        out.streamFollowScroll =
          getComputedStyle(document.getElementById('thread')).scrollBehavior === 'auto';
        const cursorProbe = document.createElement('div');
        cursorProbe.className = 'md streaming-preview';
        document.body.appendChild(cursorProbe);
        out.streamCursor = getComputedStyle(cursorProbe, '::after').content !== 'none';
        cursorProbe.remove();
        // 文字输出打字机动画：chunk 淡入 + 自适应步长（本地网关大 delta 不再瞬间出现）
        {
          const twProbe = document.createElement('div');
          twProbe.className = 'md streaming-preview';
          const chunk = document.createElement('span');
          chunk.className = 'tw-chunk';
          chunk.textContent = '字';
          twProbe.appendChild(chunk);
          document.body.appendChild(twProbe);
          out.typewriterStream =
            typeof typewriterFeed === 'function' &&
            getComputedStyle(chunk).animationName.includes('tw-chunk-in') &&
            typewriterStepCount(0) === 0 &&
            typewriterStepCount(2) === 1 &&
            typewriterStepCount(50) === 3 &&
            typewriterStepCount(200) === 6;
          twProbe.remove();
          // 取消揭示循环：新一轮/权威消息/中断前调用，清掉 timer 与 tw 状态
          {
            const fake = { twTimer: 123, twEl: {}, twShown: 5 };
            cancelTypewriter(fake);
            out.typewriterCancel =
              fake.twTimer === 0 && fake.twEl === null && fake.twShown === 0;
          // 打字机逐帧跟随滚动：跟随底部时滚动、用户上滚阅读时不打扰
          out.typewriterFollow =
            typewriterShouldFollow({ follow: true }) === true &&
            typewriterShouldFollow({ follow: false }) === false &&
            typewriterShouldFollow({}) === true;
          // 流式 DOM 有界：旧 chunk 并入前导文本节点，span 数不超过 TW_MAX_CHUNKS
          {
            const box = document.createElement('div');
            document.body.appendChild(box);
            const mkSpan = (t) => { const s = document.createElement('span'); s.className = 'tw-chunk'; s.textContent = t; box.appendChild(s); return s; };
            const settled = document.createTextNode('前');
            box.insertBefore(settled, box.firstChild);
            const fake = { previewEl: box, twSettled: settled, twPending: [] };
            for (let i = 0; i < TW_MAX_CHUNKS + 8; i++) fake.twPending.push(mkSpan(String(i)));
            const merged = twCoalesce(fake);
            out.typewriterCoalesce =
              merged === 8 &&
              fake.twPending.length === TW_MAX_CHUNKS &&
              box.querySelectorAll('.tw-chunk').length === TW_MAX_CHUNKS &&
              settled.data.indexOf('前') === 0 && settled.data.length > 1;
            box.remove();
          }
          // 边输出边排版：已完成行渲染为 markdown 块，正在输入行也行内排版（而非裸文本）
          {
            const liveBox = document.createElement('div');
            document.body.appendChild(liveBox);
            const liveSt = {
              previewEl: liveBox,
              previewText: '**已完成粗体**' + String.fromCharCode(10) + '正在输入 ' + String.fromCharCode(96) + '代码' + String.fromCharCode(96),
              twShown: 9999,
            };
            typesetStreamPreview(liveSt);
            const settledHtml = liveSt.twSettledEl ? liveSt.twSettledEl.innerHTML : '';
            const activeHtml = liveSt.twActiveEl ? liveSt.twActiveEl.innerHTML : '';
            out.streamLiveTypeset =
              settledHtml.indexOf('<strong>') >= 0 &&
              activeHtml.indexOf('<code class="inline">') >= 0;
            liveBox.remove();
          }
          // R14：输入行签名守卫——同一 active 不重复重排 DOM；内容变化后才重建
          {
            const sigBox = document.createElement('div');
            document.body.appendChild(sigBox);
            const sigSt = { previewEl: sigBox, previewText: '内容甲', twShown: 9999 };
            typesetStreamPreview(sigSt);
            const firstEl = sigSt.twActiveEl;
            const firstHtml = firstEl ? firstEl.innerHTML : '';
            if (firstEl) firstEl.textContent = 'SENTINEL';
            typesetStreamPreview(sigSt);
            const skipped = sigSt.twActiveEl === firstEl && firstEl.textContent === 'SENTINEL';
            sigSt.previewText = '内容乙';
            sigSt.twShown = 9999;
            typesetStreamPreview(sigSt);
            const rebuilt = !!sigSt.twActiveEl && sigSt.twActiveEl.textContent !== 'SENTINEL';
            out.streamActiveSigCache = skipped && rebuilt && firstHtml.indexOf('内容甲') >= 0;
            sigBox.remove();
          }
          // R14：发送按钮签名缓存——重复调用不重建 SVG 节点
          {
            const sbtn = $('btnSend');
            renderSendButton();
            const sChild = sbtn.firstChild;
            renderSendButton();
            out.sendButtonCache = !!sChild && sbtn.firstChild === sChild;
          }
          // 权威 markdown 替换预览的平滑过渡：settle 块带 md-settle 且 CSS 动画生效
          {
            const settleSt = { blocksEl: document.createElement('div'), tools: {}, toolEls: {} };
            const settleBlock = { type: 'text', text: '正文', settle: true };
            appendBlockDom(settleSt, settleBlock);
            const md = settleBlock.el;
            if (md) document.body.appendChild(md);
            out.mdSettle = !!md && md.classList.contains('md-settle') &&
              getComputedStyle(md).animationName.includes('md-settle');
            if (md) md.remove();
          }
          // 多轮工具折叠：连续 >=2 个工具块折成「调用了 N 次工具」，首次展开才构建；1 个不折叠
          {
            const mk = (n) => ({ type: 'tool', id: 'g' + n, name: 'demo' + n, input: {}, state: 'done', output: 'ok', durationMs: 500 });
            const box = document.createElement('div');
            appendBlocksGrouped(box, [mk(1), mk(2), mk(3), mk(4), mk(5)]);
            const grp = box.querySelector('.tool-group');
            const head = grp && grp.querySelector('.tg-head');
            out.toolGroupFold =
              !!grp &&
              /调用了 5 次工具/.test(grp.textContent || '') &&
              !grp.classList.contains('open') &&
              grp.querySelectorAll('.tool').length === 0 &&
              !!head && typeof head.onclick === 'function';
            head.click();
            out.toolGroupExpand = grp.classList.contains('open') && grp.querySelectorAll('.tool').length === 5;
            const box2 = document.createElement('div');
            appendBlocksGrouped(box2, [mk(1)]);
            out.toolGroupSmallKept =
              !box2.querySelector('.tool-group') && box2.querySelectorAll('.tool').length === 1;
          }
          // 关于页显示 qwen-code 版本号：以上游 package.json 为权威来源
          {
            const cv = await window.shell.cliVersion();
            setCfgSection('about');
            await new Promise((r) => setTimeout(r, 300));
            const el = document.getElementById('cliVersion');
            out.aboutQwenVersion =
              !!cv && cv.ok === true && cv.source === 'package.json' &&
              String(cv.version || '').indexOf('.') > 0 &&
              !!el && /qwen-code [0-9]/.test(el.textContent || '');
            setCfgSection('providers');
          }
          // 模型-only 回合不渲染可见流式外壳：隐藏 stream 标记 + renderThread 跳过 attach
          {
            const fakeHidden = { hidden: true };
            const fakeVisible = { hidden: false };
            // 探测：给 runtime 注入一个 hidden stream，renderThread 后不应出现可见的"思考中…"外壳
            const prevCur0 = state.current;
            const cur = state.current;
            const rs = cur && rt(cur.id);
            const prevStream = rs ? rs.stream : null;
            let noVisibleShell = true;
            if (rs && cur) {
              rs.stream = { blocks: [], hidden: true, el: null, blocksEl: null, tools: {}, toolEls: {}, follow: true };
              renderThread();
              const shells = [...document.querySelectorAll('.msg.assistant .meta .m-time')]
                .filter((n) => /思考中/.test(n.textContent || ''));
              noVisibleShell = shells.length === 0;
              rs.stream = prevStream;
              renderThread();
            }
            state.current = prevCur0;
            out.streamHidden =
              fakeHidden.hidden === true && !fakeVisible.hidden && noVisibleShell;
          }
          }
        }
        out.themeTransition = typeof document.startViewTransition === 'function';
        const led = document.getElementById('statusLed');
        out.statusLedMotion = getComputedStyle(led).transitionProperty.includes('background-color');
        const stPrev = { ...(rt(state.current.id).status || {}) };
        setStatus('motion-probe', 'busy', state.current.id);
        out.statusTextMotion = getComputedStyle(document.getElementById('statusText')).animationName.includes(
          'status-text-in'
        );
        // 阶段 6：状态灯三种 kind 背景色互异 + 过渡（statusColorMotion）
        {
          const probeLed = document.getElementById('statusLed');
          const origCls = probeLed ? probeLed.className : '';
          const grab = (cls) => {
            if (probeLed) probeLed.className = 'status-led ' + cls;
            // 直接读 CSS 变量（不依赖 transition 的计算中间值 / 元素可见性）
            const root = getComputedStyle(document.documentElement);
            const val =
              cls === 'busy' ? root.getPropertyValue('--warn').trim() :
              cls === 'error' ? root.getPropertyValue('--err').trim() :
              root.getPropertyValue('--ok').trim();
            return val;
          };
          const cOk = grab('');
          const cBusy = grab('busy');
          const cErr = grab('error');
          if (probeLed) probeLed.className = origCls;
          out.statusColorMotion =
            !!cOk && cOk !== cBusy && cBusy !== cErr &&
            (!probeLed || getComputedStyle(probeLed).transitionProperty.includes('background-color'));
        }
        setStatus(stPrev.text || '就绪', stPrev.kind || '', state.current.id);
        // 流式性能优化：setStatus 状态未变时跳过对象分配与重绘
        {
          const sid = state.current.id;
          setStatus('__perf_probe__', 'busy', sid);
          const first = rt(sid).status;
          setStatus('__perf_probe__', 'busy', sid); // 同值重复
          const sameRef = rt(sid).status === first;
          setStatus('__perf_probe2__', 'busy', sid); // 不同值
          const changedRef = rt(sid).status !== first;
          setStatus(stPrev.text || '就绪', stPrev.kind || '', sid);
          out.statusWriteGuard = sameRef && changedRef;
        }
        toast('motion-probe');
        const toastLife = document.querySelector('.toast .toast-life');
        out.toastMotion = !!toastLife && getComputedStyle(toastLife).animationName.includes('toast-life');
        // Toast 键盘可达：纯提示 role=status 且不占 Tab；可操作提示 role=button 且可聚焦
        const tkToasts = [...document.querySelectorAll('.toast')];
        out.toastKeyboard =
          tkToasts.length > 0 &&
          tkToasts.every((t) => ((t.getAttribute('role') === 'status' && t.tabIndex === -1) || (t.getAttribute('role') === 'button' && t.tabIndex === 0)) && typeof t.onkeydown === 'function') &&
          toastKeyAction({ key: 'Enter' }) === 'activate' &&
          toastKeyAction({ key: ' ' }) === 'activate' &&
          toastKeyAction({ key: 'Escape' }) === 'dismiss' &&
          toastKeyAction({ key: 'a' }) === null;
        // 阶段 6：多 toast 堆叠入场动效 + 容器 flex 列布局（toastStackMotion）
        toast('stack-a');
        toast('stack-b');
        {
          const stack = [...document.querySelectorAll('.toast')];
          const box = document.getElementById('toasts');
          out.toastStackMotion =
            stack.length >= 2 &&
            stack.slice(-2).every((el) => getComputedStyle(el).animationName.includes('ui-toast-in')) &&
            getComputedStyle(box).display === 'flex' &&
            getComputedStyle(box).flexDirection === 'column';
          stack.slice(-2).forEach((el) => el.remove());
        }
        const toastProbe = [...document.querySelectorAll('.toast')].pop();
        if (toastProbe) toastProbe.remove();
        toast('pause-probe');
        const pauseToast = [...document.querySelectorAll('.toast')].pop();
        const pauseLife = pauseToast && pauseToast.querySelector('.toast-life');
        if (pauseToast && pauseLife) {
          pauseToast.dispatchEvent(new MouseEvent('mouseenter'));
          out.toastPause =
            pauseToast.dataset.paused === 'true' &&
            getComputedStyle(pauseLife).animationPlayState === 'paused';
          pauseToast.dispatchEvent(new MouseEvent('mouseleave'));
          pauseToast.remove();
        } else {
          out.toastPause = false;
        }
        state.threadSwitchDir = 1;
        const threadProbe = document.getElementById('thread');
        paintThreadSwitch(threadProbe);
        out.threadSwitchMotion =
          !!threadProbe && getComputedStyle(threadProbe).animationName.includes('thread-in-up');
        if (threadProbe) threadProbe.classList.remove('thread-in-up', 'thread-in-down');
        // 滚动按钮：离开底部显示，强制回到底部后隐藏
        const scrollEl = threadEl();
        const scrollInner = scrollEl.querySelector('.thread-inner');
        let scrollOk = false;
        let edgeOk = false;
        if (scrollInner) {
          const probe = document.createElement('div');
          probe.style.height = '2400px';
          scrollInner.appendChild(probe);
          scrollEl.style.scrollBehavior = 'auto';
          scrollEl.scrollTop = 0;
          updateScrollBtn();
          const shown = document.getElementById('btnScrollDown').classList.contains('show');
          const shell = scrollEl.closest('.thread-shell');
          scrollEl.scrollTop = 600;
          updateThreadEdges();
          const upShown = !!shell && shell.classList.contains('can-up');
          const downShown = !!shell && shell.classList.contains('can-down');
          scrollDown(true);
          const hidden = !document.getElementById('btnScrollDown').classList.contains('show');
          const bottomHidden = !!shell && !shell.classList.contains('can-down');
          probe.remove();
          scrollEl.style.scrollBehavior = '';
          scrollOk = shown && hidden;
          edgeOk = upShown && downShown && bottomHidden;
        }
        out.scrollBtn = scrollOk;
        // 布局读取合并：纯函数从单次采样推导边缘状态，语义与合并前一致
        out.scrollEdgeState =
          scrollEdgeState(600, 2400, 800).up === true &&
          scrollEdgeState(600, 2400, 800).down === true &&
          scrollEdgeState(0, 400, 800).up === false &&
          scrollEdgeState(0, 400, 800).down === false &&
          scrollEdgeState(0, 1500, 800).gap === 700;
        // 回归锁：按钮必须保持 absolute 悬浮定位（曾误设 relative 掉进文档流跑到侧边）
        out.scrollBtnPosition =
          getComputedStyle(document.getElementById('btnScrollDown')).position === 'absolute';
        out.threadEdges = edgeOk;
        // 回到底部未读计数：follow=false 时累积，回到顶部清零；按钮渲染 .scroll-badge
        {
          const sid = state.current && state.current.id;
          const oldBadge = state.scrollBadge[sid];
          state.scrollBadge[sid] = 0;
          bumpScrollBadge({ follow: true });
          const noIncWhenFollowing = !state.scrollBadge[sid];
          bumpScrollBadge({ follow: false });
          bumpScrollBadge({ follow: false });
          const incWhenScrolledUp = state.scrollBadge[sid] === 2;
          const btn = document.getElementById('btnScrollDown');
          // 自带一个足够高的探针，确保 scrollTop=0 时确实远离底部（不依赖前面探针的残留高度）
          const badgeProbe = document.createElement('div');
          badgeProbe.style.height = '2400px';
          scrollInner.appendChild(badgeProbe);
          const savedTop = scrollEl.scrollTop;
          scrollEl.scrollBehavior = 'auto';
          scrollEl.scrollTop = 0;
          updateScrollBtn();
          const badge = btn && btn.querySelector('.scroll-badge');
          const badgeShown = !!badge && badge.textContent === '2';
          scrollEl.scrollTop = scrollEl.scrollHeight;
          updateScrollBtn();
          const badgeCleared = !btn.querySelector('.scroll-badge') && state.scrollBadge[sid] === 0;
          scrollEl.scrollTop = savedTop;
          scrollEl.scrollBehavior = '';
          badgeProbe.remove();
          updateScrollBtn();
          if (oldBadge === undefined) delete state.scrollBadge[sid];
          else state.scrollBadge[sid] = oldBadge;
          out.scrollBadge = noIncWhenFollowing && incWhenScrolledUp && badgeShown && badgeCleared;
        }
        const peProbe = document.createElement('div');
        peProbe.className = 'panel-empty';
        document.body.appendChild(peProbe);
        out.panelEmptyMotion = getComputedStyle(peProbe).animationName.includes('panel-empty-in');
        peProbe.remove();
        const liveBubble = document.querySelector('.msg.user .bubble');
        const liveActs = document.querySelector('.msg.user .msg-acts');
        out.msgHoverFeedback =
          !!liveBubble &&
          getComputedStyle(liveBubble).transitionProperty.includes('background-color') &&
          !!liveActs &&
          getComputedStyle(liveActs).transitionProperty.includes('transform');
        // 消息操作按钮键盘可达：focus-within 时 opacity=1（原 hover-only 对键盘无效）
        {
          const probe = document.createElement('div');
          probe.className = 'msg user';
          probe.style.cssText = 'position:fixed;left:0;top:0;content-visibility:visible';
          probe.innerHTML = '<div class="bubble">x</div><div class="msg-acts"><button data-copy>复制</button></div>';
          document.body.appendChild(probe);
          const acts = probe.querySelector('.msg-acts');
          const btn = probe.querySelector('[data-copy]');
          const before = getComputedStyle(acts).opacity;
          btn.focus();
          await new Promise((r) => setTimeout(r, 180)); // 等 opacity 过渡完成
          const after = getComputedStyle(acts).opacity;
          btn.blur();
          probe.remove();
          out.msgActionsKeyboard = parseFloat(before) < 1 && parseFloat(after) >= 1;
        }
        // 草稿持久化
        const inp = document.getElementById('input');
        inp.value = 'draft-probe';
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 700));
        out.drafts = (localStorage.getItem('ui.drafts') || '').includes('draft-probe');
        inp.value = '';
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        // 输入历史：空输入按 ↑ 应回到上一条提问
        // R122：从「未在浏览历史」的干净状态开始；否则前面的用例可能已把 state.hist.idx 往前移过
        state.hist = null;
        mention.open = false;
        closeComposerMenu();
        const hist = (s.messages || []).filter((m) => m.role === 'user').map((m) => m.text || '');
        inp.value = '';
        inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
        out.history = hist.length > 0 && inp.value === hist[hist.length - 1];
        inp.value = '';
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        // 有序列表保留起始序号
        out.olStart = renderMarkdown('3. three').includes('start="3"');
        // 工具活动不再自动展开右侧面板：只在用户点 btnPanel 时展开
        {
          const before = state.panelOpen;
          const beforeShow = document.getElementById('panel').classList.contains('show');
          state.panelOpen = false;
          document.getElementById('panel').classList.remove('show');
          const probeS = state.current;
          if (probeS) pushActivity(probeS, { id: '__panel_probe__', name: 'demo', arg: '', state: 'done', output: '' });
          out.panelManualOnly =
            state.panelOpen === false &&
            !document.getElementById('panel').classList.contains('show');
          // 还原
          if (probeS && rt(probeS.id)) rt(probeS.id).activities = rt(probeS.id).activities.filter((a) => a.id !== '__panel_probe__');
          state.panelOpen = before;
          document.getElementById('panel').classList.toggle('show', beforeShow);
        }
        // 活动面板清空按钮
        const ar = activeRt();
        if (ar) {
          ar.activities = [{ id: 'x', name: 'demo', arg: '', state: 'done', output: '' }];
          renderPanel();
          out.panelClear = !!document.querySelector('#panelBody .panel-clear');
          ar.activities = [];
          renderPanel();
          document.getElementById('panel').classList.add('show');
          state.panelOpen = true;
          const tabInk = document.getElementById('panelTabInk');
          const inkBefore = tabInk ? tabInk.style.transform : '';
          switchPanelTab('files');
          await new Promise((r) => setTimeout(r, 40));
          out.panelTabMotion = getComputedStyle(document.getElementById('panelBody')).animationName.includes('panel-body-in');
          out.panelTabInk =
            !!tabInk &&
            tabInk.style.opacity === '1' &&
            tabInk.style.transform !== inkBefore &&
            parseFloat(tabInk.style.width) > 0;
          switchPanelTab('activity');
          await new Promise((r) => setTimeout(r, 40));
        }
        // 存储占用统计
        const stg = window.shell.storageStats ? await window.shell.storageStats() : null;
        out.storage = !!stg && typeof stg.sessions === 'number';
        // 工作区递归文件搜索
        const fsr = await window.shell.searchFiles(window.__qcodeDevWs, 'qwen');
        out.fileSearch = !!(fsr && fsr.ok && fsr.entries && fsr.entries.length);
        out.fileSearchAsync = !!(fsr && typeof fsr.canceled === 'boolean');
        // 搜索清单缓存：连续查询同 root 应命中缓存（cached=true 表示跳过整树遍历）
        // 用窄查询确保首次遍历完整（不会因命中 60 条上限而放弃缓存）
        {
          const a = await window.shell.searchFiles(window.__qcodeDevWs, 'qcode-project-probe');
          const b = await window.shell.searchFiles(window.__qcodeDevWs, 'qcode-project-probe');
          out.fileSearchCache = !!(b && b.cached === true);
          // R32：预存小写名后，大小写混合查询在缓存路径仍返回相同结果
          const qLower = await window.shell.searchFiles(window.__qcodeDevWs, 'qwen');
          const qUpper = await window.shell.searchFiles(window.__qcodeDevWs, 'QWEN');
          out.fileSearchLower = !!(qLower && qUpper && Array.isArray(qLower.entries) && Array.isArray(qUpper.entries) &&
            qLower.entries.length > 0 && qLower.entries.length === qUpper.entries.length &&
            qLower.entries.every((e, i) => e.name === qUpper.entries[i].name));
        }
        console.log('[smoke] step:fsRead');
        const fr = await window.shell.readFile(window.__qcodeDevWs, 'package.json');
        out.fsRead = !!(fr && fr.ok && String(fr.content || '').includes('qcode'));
        const fw = await window.shell.writeFile(
          window.__qcodeDevWs,
          '_probe-write.txt',
          'write-probe-ok'
        );
        const frr = await window.shell.readFile(window.__qcodeDevWs, '_probe-write.txt');
        out.fsWrite = !!(fw && fw.ok && frr && frr.ok && frr.content === 'write-probe-ok');
        console.log('[smoke] step:checkpoint');
        // 检查点 create/diff/restore（参考 ZCode rewind）
        // R227：改用独立临时工作区（由主进程预先建好）——仓库根已含 400MB+ 构建产物，
        // 扫描会被截断，而截断的检查点按设计禁止删除新增文件，导致断言假失败。
        try {
          const cpRoot = ${JSON.stringify(cpSmokeDir)};
          const cpNewName = '_cp-probe-new-' + Date.now() + '.txt'; // 动态名：杜绝上次运行残留干扰断言
          const sid = state.current ? state.current.id : '';
          const cp1 = await window.shell.checkpoint.create(sid, cpRoot);
          out.cpCreate = !!(cp1 && cp1.ok && cp1.fileCount >= 2);
          await window.shell.writeFile(cpRoot, '_probe-write.txt', 'write-probe-v2');
          await window.shell.writeFile(cpRoot, cpNewName, 'added-after-cp');
          const df = await window.shell.checkpoint.diff(sid, cp1.id, cpRoot);
          out.cpDiff = !!(df && df.ok && Array.isArray(df.changed) && df.changed.includes('_probe-write.txt') &&
            Array.isArray(df.added) && df.added.includes(cpNewName));
          const rs = await window.shell.checkpoint.restore(sid, cp1.id, cpRoot, true);
          const back = await window.shell.readFile(cpRoot, '_probe-write.txt');
          const addedGone = await window.shell.readFile(cpRoot, cpNewName);
          out.cpRestore = !!(rs && rs.ok && rs.restored >= 1 && back && back.ok &&
            back.content === 'write-probe-ok' && (!addedGone || addedGone.ok !== true));
          const cl = await window.shell.checkpoint.list(sid);
          out.cpList = !!(cl && cl.ok && Array.isArray(cl.items) && cl.items.length >= 1);
        } catch {
          out.cpCreate = false;
          out.cpDiff = false;
          out.cpRestore = false;
          out.cpList = false;
        }
        // R50：检查点逐文件 diff 预览（readVersion API + 弹窗点击预览）
        try {
          const cpRoot = ${JSON.stringify(cpSmokeDir)};
          const sid = state.current ? state.current.id : '';
          const cl = await window.shell.checkpoint.list(sid);
          const lastId = cl && cl.ok && cl.items && cl.items[0] && cl.items[0].id;
          const rv = lastId ? await window.shell.checkpoint.readVersion(sid, lastId, '_probe-write.txt') : null;
          const rvBad = lastId ? await window.shell.checkpoint.readVersion(sid, lastId, '_cp-nope-' + Date.now() + '.txt') : null;
          out.cpReadVersion = !!(rv && rv.ok && rv.content === 'write-probe-ok' && rvBad && rvBad.ok === false);
        } catch {
          out.cpReadVersion = false;
        }
        try {
          const cpRoot = ${JSON.stringify(cpSmokeDir)};
          const sid = state.current ? state.current.id : '';
          const cl = await window.shell.checkpoint.list(sid);
          const lastId = cl && cl.ok && cl.items && cl.items[0] && cl.items[0].id;
          if (!lastId) throw new Error('no checkpoint');
          let okRows = false;
          let okPanel = false;
          let savedCwd = state.current && state.current.cwd; // R78 监工U：初始化防异常时写 undefined
          try {
            await window.shell.writeFile(cpRoot, '_probe-write.txt', 'write-probe-v2');
            savedCwd = state.current.cwd; // 弹窗内部用 s.cwd，冒烟会话 cwd 不一定是仓库根
            state.current.cwd = cpRoot;
            openCheckpointModal(state.current);
            const cpMask = document.querySelector('.cp-modal-mask');
            const cpDiffBtn = cpMask && cpMask.querySelector('.cp-foot [data-diff]');
            const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
            for (let i = 0; i < 40 && cpDiffBtn && cpDiffBtn.disabled; i++) await sleep(50);
            if (cpDiffBtn && !cpDiffBtn.disabled) {
              cpDiffBtn.click();
              let rowBtn = null;
              for (let i = 0; i < 60 && !rowBtn; i++) {
                await sleep(50);
                rowBtn = cpMask.querySelector('.cp-diff-row[data-rel="_probe-write.txt"]');
              }
              okRows = !!rowBtn;
              if (rowBtn) {
                rowBtn.click();
                for (let i = 0; i < 60 && !okPanel; i++) {
                  await sleep(50);
                  const fd = cpMask.querySelector('[data-filediff]');
                  const txt = fd && !fd.hidden ? String(fd.textContent || '') : '';
                  okPanel = txt.indexOf('write-probe-ok') >= 0 && txt.indexOf('write-probe-v2') >= 0 &&
                    !!fd.querySelector('.d-del') && !!fd.querySelector('.d-add');
                }
              }
            }
            const closeBtn = cpMask && cpMask.querySelector('[data-close]');
            if (closeBtn) closeBtn.click();
            state.current.cwd = savedCwd;
          } catch {
            okRows = false;
          } finally {
            state.current.cwd = savedCwd; // R73 监工D：异常路径也还原，否则污染其后依赖 cwd 的断言
          }
          out.cpDiffPreview = okRows && okPanel;
          await window.shell.writeFile(cpRoot, '_probe-write.txt', 'write-probe-ok');
        } catch {
          out.cpDiffPreview = false;
        }
        // 临时检查点工作区用完即清，避免冒烟留下孤儿检查点
        try {
          const sid = state.current ? state.current.id : '';
          await window.shell.checkpoint.deleteAll(sid);
        } catch {}
        console.log('[smoke] step:editor');
        showTextModal('editor-probe', 'hello', {
          editRoot: window.__qcodeDevWs,
          editRel: '_probe-write.txt',
        });
        const emk = document.querySelector('.text-modal-mask');
        const eEdit = emk && emk.querySelector('[data-edit]');
        if (eEdit) eEdit.click();
        const eEditor = emk && emk.querySelector('[data-editor]');
        out.editorModal = !!(emk && eEdit && eEditor && !eEditor.hidden);
        if (eEditor) {
          eEditor.value = 'edited-probe';
          eEditor.dispatchEvent(new Event('input', { bubbles: true }));
        }
        const eSave = emk && emk.querySelector('[data-save]');
        if (eSave) eSave.click();
        await new Promise((r) => setTimeout(r, 250));
        const fr2 = await window.shell.readFile(window.__qcodeDevWs, '_probe-write.txt');
        out.editorSave = !!(fr2 && fr2.ok && fr2.content === 'edited-probe');
        if (emk && document.body.contains(emk)) emk.querySelector('[data-close]').click();
        out.gitActions =
          typeof window.shell.gitStage === 'function' &&
          typeof window.shell.gitCommit === 'function';
        const pl = await window.shell.listDir(window.__qcodeDevWs, '.', 0, 20);
        out.filePaging = !!(
          pl && pl.ok && pl.entries.length <= 20 && Number(pl.total) >= pl.entries.length
        );
        // R40：目录条目保持「目录在前 + 名称有序」（Intl.Collator 排序）
        {
          const es = pl && pl.entries || [];
          let ok = true;
          for (let i = 1; i < es.length; i++) {
            if (es[i - 1].dir !== es[i].dir) { if (!es[i - 1].dir) ok = false; }
            else if (new Intl.Collator().compare(es[i - 1].name, es[i].name) > 0) ok = false;
          }
          out.fsListSorted = ok;
        }
        const mc = await window.shell.modelContext('auto/deepseek-v4.1-flash');
        out.modelCtx = !!(mc && mc.ok && Number(mc.context) > 0);
        state.panelTab = 'files';
        renderPanel();
        await new Promise((r) => setTimeout(r, 500));
        renderPanel();
        out.filePanel = document.querySelectorAll('#panelBody .file-row').length > 0;
        {
          const fr = document.querySelector('#panelBody .file-row');
          out.fileRowMotion = !!fr && getComputedStyle(fr).animationName.includes('list-row-in');
          out.fileRowHoverMotion =
            !!fr && getComputedStyle(fr).transitionProperty.includes('background-color');
          const caretProbe = document.createElement('div');
          caretProbe.className = 'file-row dir open';
          caretProbe.innerHTML =
            '<span class="caret"><svg viewBox="0 0 16 16"><path d="M6 4l4 4-4 4"/></svg></span>';
          document.body.appendChild(caretProbe);
          out.fileCaretMotion = getComputedStyle(
            caretProbe.querySelector('svg')
          ).transitionProperty.includes('transform');
          caretProbe.remove();
          const fileRow = document.querySelector('#panelBody .file-row.file');
          if (fileRow) {
            const rel = fileRow.dataset.rel;
            state.fileSelected = rel;
            renderPanel();
            await new Promise((r) => setTimeout(r, 30));
            const selectedRow = document.querySelector('#panelBody .file-row.on');
            out.fileSelected =
              !!selectedRow && selectedRow.dataset.rel === rel && state.fileSelected === rel;
            state.fileSelected = '';
            renderPanel();
            await new Promise((r) => setTimeout(r, 30));
            const fRows = [...document.querySelectorAll('#panelBody .file-row')];
            out.fileRowKeyboard = false;
            if (fRows.length > 1) {
              fRows[0].focus();
              fRows[0].dispatchEvent(
                new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })
              );
              out.fileRowKeyboard =
                document.activeElement === fRows[1] && fRows[1].getAttribute('aria-selected') !== null;
            }
          } else {
            out.fileSelected = false;
          }
          const pb = document.getElementById('panelBody');
          const oldMax = pb.style.maxHeight;
          pb.style.maxHeight = '80px';
          updateMenuEdges(pb);
          out.panelEdgeFade =
            pb.classList.contains('can-down') && getComputedStyle(pb).maskImage !== 'none';
          pb.style.maxHeight = oldMax;
          updateMenuEdges(pb);
        }
        out.fileFilter = !!document.getElementById('fileFilter');
        const ff = document.getElementById('fileFilter');
        if (ff) {
          ff.value = 'package';
          ff.dispatchEvent(new Event('input', { bubbles: true }));
          // 递归搜索耗时受磁盘负载影响，轮询到结果或 3s 超时，避免固定等待造成假失败
          for (let i = 0; i < 20 && (state.fileSearching || !state.fileHits.length); i++) {
            await new Promise((r) => setTimeout(r, 150));
          }
          renderPanel();
          out.fileSearchUi = document.querySelectorAll('#panelBody .file-row').length > 0;
          state.fileQuery = '';
          state.fileHits = [];
          state.fileSearching = false;
          renderPanel();
        }
        console.log('[smoke] step:gitStatus');
        const gs = await window.shell.gitStatus(window.__qcodeDevWs);
        out.gitRepo = !!(gs && gs.ok && gs.isRepo);
        out.gitPerf = !!(gs && typeof gs.elapsedMs === 'number' && Array.isArray(gs.files));
        console.log('[smoke] step:gitDiff');
        const gd = await window.shell.gitDiff(window.__qcodeDevWs, 'package.json');
        out.gitDiff = !!(gd && gd.ok && typeof gd.diff === 'string');
        console.log('[smoke] step:gitDiffCache');
        const gd2 = await window.shell.gitDiff(window.__qcodeDevWs, 'package.json');
        out.gitDiffCache = !!(gd2 && gd2.ok && gd2.cached === true && gd2.diff === gd.diff);
          out.gitTab = !!document.querySelector('.panel-tab[data-ptab="git"]');
        console.log('[smoke] step:gitPanel');
        const gitProbeCwd = (state.current && state.current.cwd) || window.__qcodeDevWs;
        state.gitData = {
          cwd: gitProbeCwd,
          ok: true,
          isRepo: true,
          branch: 'main',
          files: [
            { path: 'probe.txt', status: 'M', staged: false },
            { path: 'apps/zcode-cli/packages/core/src/runtime/methods/target-continuation-loop.ts', status: 'A', staged: false },
          ],
        };
        state.panelOpen = true;
        state.panelTab = 'git';
        syncPanelTabs();
        renderPanel();
        out.gitCommitUi = !!document.getElementById('gitCommit') && !!document.querySelector('.git-stage');
        // 阶段 1：Git 路径文件名优先 / 分支复制 / 刷新旋转 / diff 骨架
        out.gitPathFilenameFirst = (() => {
          const pp = gitPathParts('apps/zcode-cli/packages/core/src/runtime/methods/target-continuation-loop.ts');
          const longRow = [...document.querySelectorAll('#panelBody .git-row')]
            .find((r) => r.dataset.rel && r.dataset.rel.indexOf('target-continuation-loop.ts') >= 0);
          return (
            pp.name === 'target-continuation-loop.ts' &&
            pp.dir.startsWith('…') === true &&
            !!longRow &&
            !!longRow.querySelector('.gp-name') &&
            longRow.querySelector('.gp-name').textContent === pp.name &&
            !!longRow.querySelector('.gp-dir') &&
            longRow.querySelector('.fname').getAttribute('title') === longRow.dataset.rel
          );
        })();
        out.gitBranchCopy = (() => {
          const b = document.getElementById('gitBranch');
          return !!b && b.tagName === 'BUTTON' && /复制/.test(b.getAttribute('title') || '');
        })();
        out.gitRefreshSpin = (() => {
          const rf = document.getElementById('gitRefresh');
          if (!rf) return false;
          rf.classList.add('spinning');
          const anim = getComputedStyle(rf).animationName;
          rf.classList.remove('spinning');
          return anim.includes('git-refresh-spin');
        })();
        out.gitDiffSkeleton = panelSkeleton(3).includes('panel-skel');
        {
          const gr = document.querySelector('#panelBody .git-row');
          out.gitRowMotion = !!gr && getComputedStyle(gr).animationName.includes('list-row-in');
          out.gitRowHoverMotion =
            !!gr && getComputedStyle(gr).transitionProperty.includes('background-color');
          const gsBtn = document.querySelector('#panelBody .git-stage');
          out.gitStageMotion =
            !!gsBtn && getComputedStyle(gsBtn).transitionProperty.includes('opacity');
          state.gitSelected = 'probe.txt';
          renderPanel();
          out.gitRowSelected =
            !!document.querySelector('#panelBody .git-row.on') &&
            document.querySelector('#panelBody .git-row.on').dataset.rel === 'probe.txt';
          state.gitSelected = '';
          renderPanel();
          await new Promise((r) => setTimeout(r, 30));
          const gRows = [...document.querySelectorAll('#panelBody .git-row')];
          out.gitRowKeyboard = false;
          if (gRows.length) {
            gRows[0].focus();
            out.gitRowKeyboard =
              document.activeElement === gRows[0] && gRows[0].getAttribute('aria-selected') !== null;
          }
          const gCommit = document.getElementById('gitCommit');
          out.gitCommitDisabled =
            !!gCommit &&
            gCommit.disabled &&
            getComputedStyle(gCommit).transitionProperty.includes('opacity');
          out.gitLoadingSkeleton = panelSkeleton(3).includes('panel-skel');
          const skelProbe = document.createElement('div');
          skelProbe.innerHTML = panelSkeleton(2);
          document.body.appendChild(skelProbe);
          out.panelSkeletonMotion = getComputedStyle(
            skelProbe.querySelector('.sk-line')
          ).animationName.includes('skeleton-shimmer');
          skelProbe.remove();
        }
        state.gitData = null;
        state.panelOpen = false;
        document.getElementById('panel').classList.remove('show');
        state.panelTab = 'activity';
        syncPanelTabs();
        renderPanel();
        // 深色主题切换
        setTheme('dark');
        for (let i = 0; i < 20 && document.documentElement.dataset.theme !== 'dark'; i++) {
          await new Promise((r) => setTimeout(r, 25));
        }
        out.dark = document.documentElement.dataset.theme === 'dark';
        setTheme('light');
        // 消息锚点（供搜索跳转）
        out.jump = !!document.querySelector('.msg[data-mi]');
        // 侧栏搜索命中片段
        const sb = document.getElementById('search');
        sb.value = '用一句话';
        sb.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 300));
        out.snippet = !!document.querySelector('.session-snippet');
        // 项目筛选
        const cwd0 = (state.sessions[0] || {}).cwd;
          out.projectCount = false;
          out.baseName = false;
          out.projectFilter = false;
        if (cwd0) {
          const projItem = [...document.querySelectorAll('#projectList .project-item')].find(
            (el) => el.title.startsWith(cwd0)
          );
          const expectedCount = state.sessions.filter((x) => x.cwd === cwd0).length;
          out.projectCount =
            !!projItem &&
            projItem.querySelector('.path').textContent === String(expectedCount);
          // R26：baseName 路径末段提取（与 split/filter/pop 等价，免中间数组）
          {
            const BS = String.fromCharCode(92);
            out.baseName =
              baseName(window.__qcodeDevWs + '/alpha') === 'alpha' &&
              baseName('F:' + BS + 'Projects' + BS + 'alpha' + BS) === 'alpha' &&
              baseName('///') === '' &&
              baseName('') === '' &&
              baseName('a/b' + BS + 'c') === 'c';
          }
          state.projectFilter = cwd0;
          renderSidebar();
          out.projectFilter =
            !!document.querySelector('.project-item.on') && !!document.querySelector('.project-back');
          state.projectFilter = '';
          renderSidebar();
        }
        {
          const pWrap = document.getElementById('projectWrap');
          const pCaret = document.getElementById('btnProjectsToggle');
          const pTitle = document.getElementById('projectSectionTitle');
          if (pWrap.classList.contains('collapsed')) {
            pTitle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            await new Promise((r) => setTimeout(r, 240));
          }
          pTitle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          await new Promise((r) => setTimeout(r, 30));
          const collapsedOk =
            pWrap.classList.contains('collapsed') &&
            pCaret.getAttribute('aria-expanded') === 'false' &&
            getComputedStyle(pWrap).transitionProperty.includes('grid-template-rows') &&
            localStorage.getItem('ui.projectsCollapsed') === '1';
          pTitle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          await new Promise((r) => setTimeout(r, 30));
          out.projectCollapseMotion =
            collapsedOk &&
            !pWrap.classList.contains('collapsed') &&
            pCaret.getAttribute('aria-expanded') === 'true';
        }
        // 会话右键菜单
        const firstItem = document.querySelector('#sessionList .session-item');
        if (firstItem) {
          firstItem.dispatchEvent(
            new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
          );
          out.contextMenu = !!document.querySelector('.pop-menu');
          closeMenu();
        }
        out.toolCopy = !!toolElement({
          type: 'tool',
          name: 'demo',
          input: {},
          state: 'done',
          output: 'ok',
        }).querySelector('[data-tool-copy]');
        // 失败态 tooltip：状态词带错误原因 title + 复制按钮（对齐 ZCode statusTooltip）
        {
          const errEl = toolElement({
            type: 'tool', name: 'fail-demo', input: {}, state: 'error',
            output: 'Exit code 1: permission denied',
          });
          const stateEl = errEl.querySelector('.tool-head .state');
          out.toolErrorTip =
            !!stateEl &&
            stateEl.hasAttribute('data-err-tip') &&
            /permission denied/.test(stateEl.getAttribute('title') || '') &&
            !!errEl.querySelector('[data-tool-err-copy]') &&
            toolErrorBrief({ state: 'error', output: 'Exit code 1: permission denied' }) === 'Exit code 1: permission denied' &&
            toolErrorBrief({ state: 'done', output: 'ok' }) === '';
        }
        // Todo 工具紧凑清单（对齐 ZCode TodoToolCallBlock）：收起态当前任务 + 完成计数，展开态状态清单
        {
          const todoEl = toolElement({
            type: 'tool', name: 'todo_write', state: 'done', output: '',
            input: { todos: [
              { status: 'completed', content: '完成规划' },
              { status: 'in_progress', content: '实现分隔线' },
              { status: 'pending', content: '补冒烟断言' },
            ] },
          });
          const head = todoEl.querySelector('.tool-head');
          const name = head && head.querySelector('.name');
          const state = head && head.querySelector('.state');
          const arg = head && head.querySelector('.arg');
          out.todoToolSummary =
            !!todoEl.classList.contains('todo-tool') &&
            !!name && name.textContent === '任务列表' &&
            !!state && state.textContent === '1/3' &&
            !!arg && arg.textContent === '实现分隔线';
          const rows = todoEl.querySelectorAll('.todo-row');
          out.todoToolList =
            rows.length === 3 &&
            !!todoEl.querySelector('.todo-row.completed .todo-text') &&
            !!todoEl.querySelector('.todo-row.in_progress .todo-text') &&
            !!todoEl.querySelector('.todo-row.pending .todo-text');
          // 折叠默认 + 点击展开
          const initiallyClosed = !todoEl.classList.contains('open');
          head.click();
          out.todoToolFold = initiallyClosed && todoEl.classList.contains('open');
          // R35：todo 列表 HTML 缓存——同一 block 重复填命中，步骤状态变化后失效
          {
            const tb = { type: 'tool', name: 'todo_write', input: { todos: [{ status: 'pending', content: '甲' }] } };
            const steps1 = extractTodoSteps(tb);
            const host = document.createElement('div');
            host.innerHTML = '<div class="arg"></div><div class="state"></div><div class="tool-body"></div>';
            fillTodoBody(host, tb, steps1);
            const h1 = host.querySelector('.tool-body').innerHTML;
            fillTodoBody(host, tb, steps1);
            const h2 = host.querySelector('.tool-body').innerHTML;
            tb.input.todos[0].status = 'completed';
            const steps2 = extractTodoSteps(tb);
            fillTodoBody(host, tb, steps2);
            const h3 = host.querySelector('.tool-body').innerHTML;
            out.todoBodyCache = h1 === h2 && h1.indexOf('pending') >= 0 && h3 !== h2 && h3.indexOf('completed') >= 0;
          }
          // CSS 生效：todo 图标有描边、完成项有删除线、未完成项无删除线
          document.body.appendChild(todoEl);
          const doneText = rows[0].querySelector('.todo-text');
          const pendText = rows[2].querySelector('.todo-text');
          out.todoToolStyle =
            getComputedStyle(doneText).textDecorationLine.includes('line-through') &&
            !getComputedStyle(pendText).textDecorationLine.includes('line-through') &&
            getComputedStyle(rows[0].querySelector('.todo-ico svg')).stroke !== 'none';
          todoEl.remove();
        }
        // R49 Todo 任务条：历史会话显示最近 todo 进度、点击展开、无 todo 会话隐藏
        {
          const bar = document.getElementById('todoBar');
          const cur = state.current;
          const fake = { id: 'smoke_todo_bar_sid', smoke: true, messages: [{ role: 'assistant', blocks: [{ type: 'tool', id: 't1', name: 'todo_write', input: { todos: [
            { status: 'completed', content: '任务一' },
            { status: 'in_progress', content: '任务二' },
            { status: 'pending', content: '任务三' },
          ] } }] }] };
          state.current = fake;
          renderTodoBar();
          const sum = bar && bar.querySelector('.todo-bar-summary');
          out.todoBar = !!(bar && !bar.hidden && sum) &&
            String(sum.textContent || '').indexOf('1/3') === 0 &&
            bar.querySelectorAll('.todo-row').length === 3;
          if (bar) bar.querySelector('.todo-bar-head').click();
          out.todoBarExpand = !!(bar && bar.classList.contains('open')) &&
            getComputedStyle(bar.querySelector('.todo-bar-list')).display !== 'none';
          const fake2 = { id: 'smoke_todo_bar_sid2', smoke: true, messages: [{ role: 'user', blocks: [] }] };
          state.current = fake2;
          renderTodoBar();
          out.todoBarEmpty = !!(bar && bar.hidden);
          state.current = cur;
          renderTodoBar();
        }
        // R52：/todos 本地命令（时间线任务清单卡）+ 检查点回滚时间线 marker
        {
          const cmd = findLocalCommand('todos');
          const cur = state.current;
          const fake = { id: 'smoke_todos_cmd_sid', smoke: true, title: 'todo 冒烟', messages: [{ role: 'assistant', blocks: [{ type: 'tool', id: 't1', name: 'todo_write', input: { todos: [
            { status: 'completed', content: '已办' },
            { status: 'in_progress', content: '进行中' },
          ] } }] }], updatedAt: Date.now() };
          state.current = fake;
          let okCmd = false;
          let okEmpty = false;
          let okMarker = false;
          if (cmd) {
            runLocalCommand(cmd, '', fake);
            const msgs = fake.messages;
            const mv = msgs[msgs.length - 1];
            okCmd = !!(mv && mv.role === 'system' && mv.todosView && mv.todosView.steps.length === 2);
            if (okCmd) {
              const el = todosViewElement(mv);
              okCmd = okCmd &&
                String(el.textContent || '').indexOf('1/2') >= 0 &&
                el.querySelectorAll('.todo-row').length === 2 &&
                !!el.querySelector('.todo-row.completed .todo-text');
            }
            // 无任务会话：显示空态文案
            const fake2 = { id: 'smoke_todos_cmd_sid2', smoke: true, title: 'x', messages: [], updatedAt: Date.now() };
            state.current = fake2;
            runLocalCommand(cmd, '', fake2);
            const mv2 = fake2.messages[fake2.messages.length - 1];
            const el2 = mv2 && todosViewElement(mv2);
            okEmpty = !!(el2 && String(el2.textContent || '').indexOf('还没有任务列表') >= 0);
            // 检查点回滚 marker：纯函数 + 渲染分支
            recordCpRestore(fake, 3, 1);
            const mm = fake.messages[fake.messages.length - 1];
            const del = cpRestoreDividerElement(mm);
            okMarker = !!(mm && mm.cpRestore && mm.cpRestore.restored === 3 && mm.cpRestore.deleted === 1 &&
              del.dataset.cpRestore === '1' &&
              String(del.textContent || '').indexOf('已回滚工作区') >= 0 &&
              String(del.textContent || '').indexOf('还原 3 个文件') >= 0 &&
              String(del.textContent || '').indexOf('删除 1 个新增') >= 0);
          }
          state.current = cur;
          renderThread(); // fake 会话期间 appendTodosView/recordCpRestore 已按 fake 渲染过线程，恢复后重画真实线程
          out.todosCmd = !!(okCmd && okEmpty);
          out.cpRestoreMarker = okMarker;
        }
        // R53：每日 token 预算——纯函数边界 + 用量面板预算行渲染
        {
          let okLevel = false;
          let okNotify = false;
          let okRow = false;
          let savedExtras; // R73 监工D：提升到 try 外，finally 才能访问
          let fakeBody;
          try {
            okLevel =
              budgetLevel(0, 0) === '' &&
              budgetLevel(500, 0) === '' &&
              budgetLevel(790, 1000) === '' &&
              budgetLevel(800, 1000) === 'warn' &&
              budgetLevel(999, 1000) === 'warn' &&
              budgetLevel(1000, 1000) === 'over' &&
              budgetLevel(2000, 1000) === 'over';
            const shown = {};
            okNotify =
              budgetShouldNotify(shown, 'warn') && shown.warn === undefined &&
              (() => { shown.warn = true; return budgetShouldNotify(shown, 'warn') === false; })() &&
              (() => { shown.over = true; return budgetShouldNotify(shown, 'warn') === false && budgetShouldNotify(shown, 'over') === false; })();
            // 用量面板预算行：注入 fake usage/prefs 渲染
            savedExtras = state.extras;
            const todayKey = todayUsageKey();
            fakeBody = document.createElement('div');
            document.body.appendChild(fakeBody);
            state.extras = {
              prefs: { dailyBudgetTokens: 1000 },
              usage: {
                sessions: 3, total: 5000, input: 4000, toolCalls: 2, models: [], recent: [],
                path: 'fake',
                weekly: [
                  { date: '2020-01-01', tokens: 100, calls: 0 },
                  { date: todayKey.slice(5), tokens: 850, calls: 1 }, // 真实 weekly[].date 是 MM-DD 短格式
                ],
              },
            };
            renderUsageCfg(fakeBody);
            const bar = fakeBody.querySelector('.budget-bar');
            const meta = fakeBody.querySelector('.budget-meta');
            okRow = !!bar && bar.dataset.budget === 'warn' &&
              !!meta && String(meta.textContent || '').indexOf('今日 850') >= 0 &&
              String(meta.textContent || '').indexOf('预算 1.0K') >= 0 &&
              String(meta.textContent || '').indexOf('85%') >= 0 &&
              String(meta.textContent || '').indexOf('接近上限') >= 0 &&
              String((bar.querySelector('.budget-fill') || {}).style.width || '').indexOf('85') >= 0;
            // 未启用态文案
            state.extras = {
              prefs: { dailyBudgetTokens: 0 },
              usage: { sessions: 0, total: 0, input: 0, toolCalls: 0, models: [], recent: [], path: 'fake', weekly: [] },
            };
            renderUsageCfg(fakeBody);
            const meta2 = fakeBody.querySelector('.budget-meta');
            okRow = okRow && !!meta2 && String(meta2.textContent || '').indexOf('未启用每日预算') >= 0;
            state.extras = savedExtras;
            fakeBody.remove();
          } catch {
            okLevel = false;
            okRow = false;
          } finally {
            state.extras = savedExtras; // R73 监工D：中途抛错也要还原
            if (typeof fakeBody !== 'undefined' && fakeBody && fakeBody.parentNode) fakeBody.remove();
          }
          out.budgetLevel = okLevel;
          out.budgetNotify = okNotify;
          out.budgetRow = okRow;
        }
        // R60：压缩命令分支接通。contextBridge 暴露的对象只读（mock 赋值静默无效，r83-r88 教训），
        // 改用 busy 路径的可观测行为：分支命中时 toast 提示「回合还在运行」；旧代码无分支则完全静默。
        {
          let okCmd = false;
          try {
            const fake = { id: 'smoke_compress_cmd_sid', smoke: true, cwd: window.__qcodeDevWs, title: 'x', messages: [], updatedAt: Date.now() };
            const cur = state.current;
            state.current = fake;
            rt(fake.id).busy = true; // busy：分支应提示而非静默/起回合
            const c = findLocalCommand('compress');
            if (c) runLocalCommand(c, '', fake);
            const toastsEl = document.getElementById('toasts');
            const txt = toastsEl ? String(toastsEl.textContent || '') : '';
            okCmd = !!(c && txt.indexOf('压缩上下文') >= 0 && txt.indexOf('还在运行') >= 0);
            rt(fake.id).busy = false;
            // 无分支的旧代码在此完全静默；同时验证 compact 占位链路可由分支产生（非 busy + mock 前提下由 beginTurn push）
            state.current = cur;
          } catch (e2) {
            okCmd = false;
          }
          out.compressCmd = okCmd;
        }
        // R60：窗口占用计入缓存读取（内核 usage = input(未缓存)+cache_read+output，漏 cache_read 会严重偏小）
        {
          let okCache = false;
          try {
            const fake = { id: 'smoke_ctx_cache_sid', smoke: true, model: 'auto/deepseek-v4.1-flash', modelLabel: 'DeepSeek V4.1 Flash', messages: [
              { role: 'assistant', blocks: [], usage: { input_tokens: 150, cache_read_input_tokens: 9000, output_tokens: 50 } },
            ], updatedAt: Date.now() };
            const cur = state.current;
            const savedCache = state.contextCache.get(fake.model);
            state.contextCache.set(fake.model, 20000);
            state.current = fake;
            renderComposer();
            const tokEl = document.getElementById('tokensText');
            const txt = tokEl ? String(tokEl.textContent || '') : '';
            okCache = txt.indexOf('9.2K tok') >= 0 && txt.indexOf('46%') >= 0;
            if (savedCache === undefined) state.contextCache.delete(fake.model);
            else state.contextCache.set(fake.model, savedCache);
            state.current = cur;
            renderComposer();
          } catch {
            okCache = false;
          }
          out.ctxCacheTok = okCache;
        }
        // R62：压缩折叠——最后一个 completed 压缩 marker 之前的消息默认折叠，可展开/收起；跳转自动展开
        {
          let okFold = false;
          let okExpand = false;
          try {
            const fake = { id: 'smoke_cpt_fold_sid', smoke: true, cwd: window.__qcodeDevWs, title: 'x', messages: [
              { role: 'user', text: '早期问题', ts: Date.now() },
              { role: 'assistant', blocks: [{ type: 'text', text: '早期回答' }], ts: Date.now() },
              { role: 'assistant', blocks: [], pending: false, compact: { status: 'completed', duration: 800 }, ts: Date.now() },
              { role: 'user', text: '压缩后问题', ts: Date.now() },
            ], updatedAt: Date.now() };
            const cur = state.current;
            state.current = fake;
            renderThread();
            const earlyGone = !threadEl().querySelector('.msg[data-mi="0"]');
            const btn = threadEl().querySelector('.thread-early-toggle');
            okFold = !!(earlyGone && btn && String(btn.textContent || '').indexOf('2 条') >= 0);
            if (btn) btn.click();
            renderThread();
            const earlyBack = !!threadEl().querySelector('.msg[data-mi="0"]');
            // 展开后按钮变为「收起早期消息」（不是消失）
            const btnAfter = threadEl().querySelector('.thread-early-toggle');
            okExpand = !!(earlyBack && btnAfter && String(btnAfter.textContent || '').indexOf('收起早期消息') >= 0);
            // 跳转兼容：收起后 jumpToMessage 早期索引应自动展开
            fake.expandEarlyMsgs = false;
            renderThread();
            jumpToMessage(0, fake.id);
            await new Promise((r) => setTimeout(r, 80));
            okExpand = okExpand && !!threadEl().querySelector('.msg[data-mi="0"]');
            state.current = cur;
            renderThread();
          } catch {
            okFold = false;
            okExpand = false;
          }
          out.compactFold = okFold;
          out.compactFoldExpand = okExpand;
        }
        // R63：多压缩点回归——折叠范围到最后一个 completed marker（含更早的 marker），按钮只在最后 marker 处
        {
          let okMulti = false;
          let okMore = false;
          try {
            const fake = { id: 'smoke_cpt_multi_sid', smoke: true, cwd: window.__qcodeDevWs, title: 'x', messages: [
              { role: 'user', text: '一轮', ts: Date.now() },
              { role: 'assistant', blocks: [], pending: false, compact: { status: 'completed', duration: 500 }, ts: Date.now() },
              { role: 'user', text: '二轮', ts: Date.now() },
              { role: 'assistant', blocks: [], pending: false, compact: { status: 'completed', duration: 600 }, ts: Date.now() },
              { role: 'user', text: '三轮', ts: Date.now() },
            ], updatedAt: Date.now() };
            const cur = state.current;
            state.current = fake;
            renderThread();
            // 折叠中：idx 0-3 全部不渲染（含第一个 marker），按钮在 idx 3（最后 marker）处，计数 4 条
            const earlyGone = !threadEl().querySelector('.msg[data-mi="0"]') && !threadEl().querySelector('.msg[data-mi="2"]');
            const firstDivGone = !threadEl().querySelector('.compact-divider[data-mi="1"]');
            const btn = threadEl().querySelector('.thread-early-toggle');
            const btnAt = btn && btn.previousElementSibling && btn.previousElementSibling.dataset
              ? btn.previousElementSibling : null;
            okMulti = !!(earlyGone && firstDivGone && btn &&
              String(btn.textContent || '').indexOf('3 条') >= 0);
            out.multiDbg = 'gone=' + String(earlyGone) + ' div1=' + String(firstDivGone) +
              ' btn=' + String(!!btn) + ' txt=' + String(btn ? btn.textContent || '' : '').slice(0, 30);
            // 展开后：两个 marker 都渲染
            if (btn) btn.click();
            renderThread();
            const divCount = threadEl().querySelectorAll('.compact-divider').length;
            okMulti = okMulti && divCount === 2;
            // R63：折叠时「加载更早」按钮隐藏（renderLimit=2 制造 start>0 场景）
            state.renderLimit.set(fake.id, 2);
            fake.expandEarlyMsgs = false;
            renderThread();
            okMore = !threadEl().querySelector('.thread-more') &&
              !!threadEl().querySelector('.thread-early-toggle');
            state.renderLimit.delete(fake.id);
            state.current = cur;
            renderThread();
          } catch {
            okMulti = false;
            okMore = false;
          }
          out.compactFoldMulti = okMulti;
          out.compactFoldMore = okMore;
        }
        const foldEl = toolElement({
          type: 'tool',
          name: 'large-output',
          input: {},
          state: 'done',
          output: 'x'.repeat(3000),
          outputLen: 3000,
        });
        out.toolFold = !!(
          foldEl.querySelector('.tool-out.collapsed') &&
          foldEl.querySelector('[data-tool-toggle]')
        );
        out.toolSave = !!foldEl.querySelector('[data-tool-save]');
        sb.value = '';
        sb.dispatchEvent(new Event('input', { bubbles: true }));
        // Ctrl+, 打开设置
        document.dispatchEvent(
          new KeyboardEvent('keydown', { key: ',', ctrlKey: true, bubbles: true })
        );
        await new Promise((r) => setTimeout(r, 200));
        out.settingsKey = document.getElementById('settingsPage').classList.contains('show');
        await closeSettings();
        // 分隔线 + 缩放快捷键 + 窗口置顶开关
        out.hr = renderMarkdown('---').includes('<hr/>');
        // 表格单次 split：表头 + 数据行保留、分隔行跳过（输出与去重前一致）
        out.mdTable =
          renderTable(['| A | B |', '| --- | --- |', '| x | y |']) ===
          '<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>x</td><td>y</td></tr></tbody></table>';
        document.dispatchEvent(new KeyboardEvent('keydown', { key: '=', ctrlKey: true, bubbles: true }));
        out.zoom = document.body.style.zoom === '1.1';
        document.dispatchEvent(new KeyboardEvent('keydown', { key: '0', ctrlKey: true, bubbles: true }));
        setCfgSection('general');
        out.notifyTest = [...document.querySelectorAll('#gToggles .btn')].some((b) => b.textContent === '测试通知');
        out.alwaysOnTop = !![...document.querySelectorAll('#gToggles .btn')].find((b) =>
          b.textContent.includes('窗口置顶')
        );
        // 工具错误自动展开 + 供应商排序 + 配置导入导出入口
        out.toolErrOpen = toolElement({
          type: 'tool',
          name: 'x',
          input: {},
          state: 'error',
          output: 'boom',
        }).classList.contains('open');
        // edit diff 折叠未变行
        const baseLines = [];
        for (let i = 0; i < 20; i++) baseLines.push('line' + i);
        const nextLines = baseLines.slice();
        nextLines[10] = 'changed';
        // edit diff 缓存：同一块重复取 diff 命中缓存（O(n×m) LCS 不重算）
        {
          const NL = String.fromCharCode(10);
          const cv = { role: 'assistant', type: 'tool', name: 'edit', input: {
            file_path: 'x', old_string: 'a' + NL + 'b' + NL + 'c', new_string: 'a' + NL + 'B' + NL + 'c',
          }, state: 'done', output: '' };
          const h1 = toolDiffHtml(cv);
          const h2 = toolDiffHtml(cv);
          out.toolDiffCache = h1 === h2 && h1.indexOf('d-add') >= 0 && h1.indexOf('B') >= 0;
          cv.input.new_string = 'a' + NL + 'C' + NL + 'c';
          out.toolDiffInvalidate = toolDiffHtml(cv) !== h1 && toolDiffHtml(cv).indexOf('C') >= 0;
          // R27：平坦 Uint32Array LCS 正确产出 add/del/eq（差分测试已验证与二维矩阵一致）
          const dRows = diffLines('a' + NL + 'b' + NL + 'c', 'a' + NL + 'B' + NL + 'c');
          out.diffFlatMatrix =
            dRows.filter((r) => r.t === 'add').length === 1 &&
            dRows.some((r) => r.t === 'add' && r.l === 'B') &&
            dRows.filter((r) => r.t === 'del').length === 1 &&
            dRows.some((r) => r.t === 'eq' && r.l === 'a');
          // 工具输入 JSON 序列化缓存：同一 input 对象重复取值结果一致，替换引用后失效
          const jv = { type: 'tool', name: 'demo', input: { a: 1, b: 'x' }, state: 'done' };
          const j1 = toolInputJson(jv);
          const j2 = toolInputJson(jv);
          jv.input = { a: 2 };
          const j3 = toolInputJson(jv);
          out.toolInputJsonCache = j1 === j2 && j1.indexOf('a&quot;: 1') >= 0 && j3 !== j2 && j3.indexOf('a&quot;: 2') >= 0;
          // R15：大输出折叠判定（字符计数，不用 split 分配整行数组）
          const NL15 = String.fromCharCode(10);
          out.toolOutNeedsFold =
            toolOutNeedsFold('短输出') === false &&
            toolOutNeedsFold(Array(21).join('x' + NL15)) === true &&
            toolOutNeedsFold('x'.repeat(1300)) === true;
          // R15：输出区 HTML 缓存——同一块重复取命中，output 变化后失效
          const ov = { type: 'tool', name: 'demo', input: {}, state: 'done', output: '<a> & x' + NL15 + 'y' };
          const o1 = toolOutHtml(ov);
          const o2 = toolOutHtml(ov);
          ov.output = '<b> & z';
          const o3 = toolOutHtml(ov);
          out.toolOutHtmlCache = o1 === o2 && o1.indexOf('&lt;a&gt;') >= 0 && o3 !== o2 && o3.indexOf('&lt;b&gt;') >= 0;
          // R37：工具 body DOM 节点缓存——命中走 cloneNode（新元素含内容），输出变化后重建
          {
            const tv = { type: 'tool', name: 'edit', input: { old_string: 'a', new_string: 'b' }, state: 'done', output: 'first output' };
            const host = document.createElement('div');
            host.innerHTML = '<div class="tool-body"></div>';
            fillToolBody(host, tv);
            const b1 = host.querySelector('.tool-body').innerHTML;
            fillToolBody(host, tv);
            const b2 = host.querySelector('.tool-body').innerHTML;
            tv.output = 'second output';
            fillToolBody(host, tv);
            const b3 = host.querySelector('.tool-body').innerHTML;
            out.toolBodyNodeCache = b1 === b2 && b1.indexOf('first output') >= 0 && b3 !== b2 && b3.indexOf('second output') >= 0;
          }
        }
        out.diffGap = toolElement({
          type: 'tool',
          name: 'edit',
          input: {
            file_path: 'x',
            old_string: baseLines.join(String.fromCharCode(10)),
            new_string: nextLines.join(String.fromCharCode(10)),
          },
          state: 'done',
          output: '',
        }).textContent.includes('行未变');
        if (!document.getElementById('settingsPage').classList.contains('show')) {
          await openSettings();
          await new Promise((r) => setTimeout(r, 250));
        }
        setCfgSection('providers');
        out.providerMove = !!document.querySelector('#pList .p-more');
        const pMore = document.querySelector('#pList .p-more');
        if (pMore) {
          pMore.click();
          await new Promise((r) => setTimeout(r, 60));
          const pMenuLabels = [...document.querySelectorAll('.pop-menu button')].map(
            (b) => b.textContent
          );
          out.providerMenu =
            pMenuLabels.some((t) => t.includes('复制模型')) &&
            pMenuLabels.some((t) => t.includes('删除'));
          const pm = document.querySelector('.pop-menu');
          if (pm) {
            const settingsZ = Number(getComputedStyle(document.getElementById('settingsPage')).zIndex) || 0;
            const menuZ = Number(getComputedStyle(pm).zIndex) || 0;
            const pb = pm.getBoundingClientRect();
            const hit = document.elementFromPoint(pb.left + pb.width / 2, pb.top + Math.min(30, pb.height / 2));
            out.providerMenuTop = menuZ > settingsZ;
            out.providerMenuMotion = getComputedStyle(pm).animationName.includes('ui-menu-in');
            out.providerMenuHit = !!(hit && hit.closest('.pop-menu'));
            const configBox = document.querySelector('.p-config').getBoundingClientRect();
            out.providerMenuInside =
              pb.right <= configBox.right + 1 && pb.left >= configBox.left - 1;
            out.providerMenuBox = [Math.round(pb.left),Math.round(pb.right),Math.round(pb.width)];
            out.providerConfigBox = [Math.round(configBox.left),Math.round(configBox.right)];
          }
          closeMenu();
        }
        const groupAdd = document.querySelector('#pList .p-group-add');
        if (groupAdd) {
          groupAdd.click();
          await new Promise((r) => setTimeout(r, 60));
          const pickItem = [...document.querySelectorAll('.pop-menu button')].find((b) =>
            b.textContent.includes('从端点选择')
          );
          if (pickItem) {
            pickItem.click();
            let pickRows = 0;
            for (let i = 0; i < 100 && pickRows === 0; i++) {
              await new Promise((r) => setTimeout(r, 150));
              pickRows = document.querySelectorAll('.model-picker-mask .mp-row').length;
            }
            out.modelPicker = pickRows > 0;
            out.modelPickerSelectAll = false;
            out.pickerRowMotion = false;
            const picker = document.querySelector('.model-picker-mask');
            if (picker) {
              const firstPickRow = picker.querySelector('.mp-row');
              out.pickerRowMotion =
                !!firstPickRow &&
                getComputedStyle(firstPickRow).animationName.includes('list-item-in');
              const allBox = picker.querySelector('[data-all]');
              if (allBox) {
                allBox.click();
                out.modelPickerSelectAll =
                  [...picker.querySelectorAll('.mp-row input')].every((i) => i.checked) &&
                  picker.querySelector('[data-add]').disabled === false;
              }
              picker.querySelector('[data-close]').click();
            }
          } else {
            closeMenu();
          }
        }
        out.pTestAll =
          !!document.getElementById('pTestAll') &&
          document.querySelectorAll('#pList .p-test').length ===
            (cfgDraft.modelProviders.openai || []).length;
        out.providerTestLabels =
          [...document.querySelectorAll('#pList .p-btn')].some(
            (b) => b.textContent === '测连接'
          ) &&
          [...document.querySelectorAll('#pList .btn')].some(
            (b) => b.textContent === '测端点'
          ) &&
          !!document.getElementById('pTestAll') &&
          document.getElementById('pTestAll').textContent.includes('测试全部模型');
        out.pRestore = !!document.getElementById('pRestore');
        out.configIO = !!document.getElementById('pExport') && !!document.getElementById('pImport');
        out.cfgFootMotion =
          getComputedStyle(document.getElementById('cfgFoot')).transitionProperty.includes('max-height') &&
          !!document.getElementById('cfgSave');
        {
          const saveProbe = document.createElement('button');
          saveProbe.className = 'btn primary';
          saveProbe.textContent = '保存';
          document.body.appendChild(saveProbe);
          const pending = withSaveButton(saveProbe, async () => {
            await new Promise((r) => setTimeout(r, 40));
            return true;
          });
          const busyOk =
            saveProbe.classList.contains('is-saving') && saveProbe.textContent === '保存中…';
          await pending;
          out.saveButtonMotion =
            busyOk &&
            saveProbe.classList.contains('is-saved') &&
            saveProbe.textContent === '已保存' &&
            getComputedStyle(saveProbe).animationName.includes('save-pop');
          saveProbe.remove();
          const invalidProbe = document.createElement('input');
          invalidProbe.className = 'input';
          document.body.appendChild(invalidProbe);
          invalidField(invalidProbe);
          out.formInvalidMotion =
            invalidProbe.classList.contains('field-invalid') &&
            getComputedStyle(invalidProbe).animationName.includes('field-shake');
          invalidProbe.remove();
        }
        // 供应商分组折叠 / 全部折叠
        out.providerCollapse = false;
        out.providerCollapseAll = false;
        const firstGroup = document.querySelector('#pList .p-group');
        const firstCollapse = firstGroup && firstGroup.querySelector('.p-collapse');
        if (firstGroup && firstCollapse) {
          if (firstGroup.classList.contains('collapsed')) firstCollapse.click();
          firstCollapse.click();
          await new Promise((r) => setTimeout(r, 40));
          const wrapped = firstGroup.querySelector('.p-rows-wrap');
          const collapsedOk =
            firstGroup.classList.contains('collapsed') &&
            firstCollapse.getAttribute('aria-expanded') === 'false' &&
            getComputedStyle(wrapped).transitionProperty.includes('grid-template-rows') &&
            JSON.parse(localStorage.getItem('ui.providerCollapsed') || '[]').includes(firstGroup._pkey);
          firstCollapse.click();
          await new Promise((r) => setTimeout(r, 40));
          out.providerCollapse = collapsedOk && !firstGroup.classList.contains('collapsed');
          const allBtn = document.getElementById('pToggleAll');
          if (allBtn) {
            allBtn.click();
            await new Promise((r) => setTimeout(r, 40));
            const allCollapsed =
              [...document.querySelectorAll('#pList .p-group')].every((el) =>
                el.classList.contains('collapsed')
              ) && allBtn.textContent === '全部展开';
            allBtn.click();
            await new Promise((r) => setTimeout(r, 40));
            const storedCollapsed = (() => { try { return JSON.parse(localStorage.getItem('ui.providerCollapsed') || '[]'); } catch { return []; } })();
            out.providerCollapseAll =
              allCollapsed &&
              [...document.querySelectorAll('#pList .p-group')].every(
                (el) => !el.classList.contains('collapsed')
              ) &&
              allBtn.textContent === '全部折叠' &&
              // R43：批量展开后 localStorage 已一次性同步（无残留 collapsed key）
              storedCollapsed.length === 0;
          }
        }
        out.providerEditForm = false;
        out.providerEditApply = false;
        out.providerEditDirty = false;
        const groupEditBtn = document.querySelector('#pList .p-group-edit');
        if (groupEditBtn) {
          groupEditBtn.click();
          await new Promise((r) => setTimeout(r, 60));
          const pgForm = document.querySelector('#pList .p-group-form');
          const pgInputs = pgForm ? [...pgForm.querySelectorAll('input.input')] : [];
          out.providerEditForm =
            !!pgForm &&
            pgInputs.length >= 3 &&
            !!pgForm.querySelector('[data-act="apply"]') &&
            !!pgForm.querySelector('[data-act="cancel"]');
          if (pgForm && pgInputs.length >= 3) {
            const originalBase = pgInputs[0].value;
            const envName = pgInputs[1].value;
            const hadEnv =
              !!cfgDraft.env && Object.prototype.hasOwnProperty.call(cfgDraft.env, envName);
            const oldKey = cfgDraft.env ? cfgDraft.env[envName] : undefined;
            const applyBtn = pgForm.querySelector('[data-act="apply"]');
            const initiallyDisabled = !!applyBtn && applyBtn.disabled;
            pgInputs[0].value = 'http://127.0.0.1:3425/v1-smoke';
            pgInputs[0].dispatchEvent(new Event('input', { bubbles: true }));
            out.providerEditDirty = initiallyDisabled && !!applyBtn && !applyBtn.disabled;
            applyBtn.click();
            await new Promise((r) => setTimeout(r, 80));
            const changed = (cfgDraft.modelProviders.openai || []).filter(
              (p) => p.baseUrl === 'http://127.0.0.1:3425/v1-smoke'
            ).length;
            out.providerEditApply = changed > 0 && !!document.getElementById('cfgSave');
            (cfgDraft.modelProviders.openai || []).forEach((p) => {
              if (p.baseUrl === 'http://127.0.0.1:3425/v1-smoke') p.baseUrl = originalBase;
            });
            if (cfgDraft.env) {
              if (hadEnv) cfgDraft.env[envName] = oldKey;
              else delete cfgDraft.env[envName];
            }
            renderCfgSection();
          }
        }
        // 供应商编辑表单：密钥显示按钮
        const editBtn = [...document.querySelectorAll('#pList .p-btn')].find(
          (b) => b.textContent === '编辑'
        );
        if (editBtn) editBtn.click();
        await new Promise((r) => setTimeout(r, 120));
        out.keyShow = !!document.getElementById('keyShow');
        // 添加供应商向导：入口、模板填充、表单校验、注入假模型走通入库全流程
        out.providerAddEntry = !!document.getElementById('pAddProvider');
        const wizBefore = (cfgDraft.modelProviders.openai || []).length;
        const pAddProviderBtn = document.getElementById('pAddProvider');
        if (pAddProviderBtn) pAddProviderBtn.click();
        await new Promise((r) => setTimeout(r, 80));
        const wiz = document.querySelector('.model-picker-mask');
        out.providerWizard = !!wiz && wiz.textContent.includes('添加供应商');
        out.providerWizardTpl = false;
        out.providerWizardValid = false;
        out.providerWizardFlow = false;
        if (wiz) {
          const tpl = [...wiz.querySelectorAll('.pw-tpl')].find((b) => b.textContent === 'DeepSeek');
          if (tpl) tpl.click();
          const wBase = wiz.querySelector('[data-pw-base]');
          const wEnv = wiz.querySelector('[data-pw-env]');
          const wTest = wiz.querySelector('[data-pw-test]');
          out.providerWizardTpl = !!(
            wBase &&
            wBase.value.includes('api.deepseek.com') &&
            wEnv &&
            wEnv.value === 'DEEPSEEK_API_KEY'
          );
          // 校验：Base URL 清空后下一步必须禁用
          wBase.value = '';
          wBase.dispatchEvent(new Event('input', { bubbles: true }));
          out.providerWizardValid = !!wTest && wTest.disabled === true;
          wBase.value = 'http://127.0.0.1:3425/v1';
          wBase.dispatchEvent(new Event('input', { bubbles: true }));
          wEnv.value = 'DEEPSEEK_API_KEY';
          wEnv.dispatchEvent(new Event('input', { bubbles: true }));
          // 注入假模型跳过真实端点请求，走第 2 步勾选入库
          wiz._pwFake = [{ id: 'smoke/wiz-m1', name: 'Smoke Wizard M1', context: 64000 }];
          wTest.click();
          await new Promise((r) => setTimeout(r, 150));
          const wAdd = wiz.querySelector('[data-pw-add]');
          const wRows = wiz.querySelectorAll('.mp-row').length;
          if (wAdd && !wAdd.disabled) {
            window.__wizHadEnv = !!(cfgDraft.env && Object.prototype.hasOwnProperty.call(cfgDraft.env, 'DEEPSEEK_API_KEY'));
            window.__wizOldKey = cfgDraft.env ? cfgDraft.env.DEEPSEEK_API_KEY : undefined;
            wAdd.click();
            // 关闭动画 160ms，等它结束再断言
            await new Promise((r) => setTimeout(r, 300));
          }
          const addedArr = cfgDraft.modelProviders.openai || [];
          out.providerWizardFlow = !!(
            wRows > 0 &&
            addedArr.length === wizBefore + 1 &&
            addedArr.some((p) => p.id === 'smoke/wiz-m1' && p.baseUrl.includes('3425')) &&
            !document.querySelector('.model-picker-mask')
          );
          // 清理假模型，恢复现场（R73 监工D：env 也要还原——persistKey 写入的 MAGPIE_API_KEY:''
          // 会让 closeSettings 的 cfgDraft 对比触发 dialog:confirm）
          cfgDraft.modelProviders.openai = addedArr.filter((p) => p.id !== 'smoke/wiz-m1');
          if (cfgDraft.env) {
            if (window.__wizHadEnv) cfgDraft.env.DEEPSEEK_API_KEY = window.__wizOldKey;
            else delete cfgDraft.env.DEEPSEEK_API_KEY;
          }
          renderCfgSection();
        }
        const wizLeft = document.querySelector('.model-picker-mask');
        if (wizLeft) wizLeft.querySelector('[data-close]').click();
        setCfgSection('providers');
        // 查找栏要看到主会话，先关设置页
        await closeSettings();
        out.toolDuration = toolElement({ type: 'tool', name: 'demo', input: {}, state: 'done', output: '', durationMs: 1500 }).textContent.includes('1.5s');
        const batchId = 's_batch_' + Date.now().toString(36);
        const batchRt = rt(batchId);
        batchRt.stream = {
          tools: {
            t1: { id: 't1', name: 'demo1', input: {}, state: 'running', startedAt: Date.now() },
            t2: { id: 't2', name: 'demo2', input: {}, state: 'running', startedAt: Date.now() },
          },
          blocks: [],
        };
        batchRt.activities = [
          { id: 't1', name: 'demo1', state: 'running' },
          { id: 't2', name: 'demo2', state: 'running' },
        ];
        handleToolResults(
          { id: batchId, messages: [] },
          {
            message: {
              content: [
                { type: 'tool_result', tool_use_id: 't1', content: 'alpha' },
                { type: 'tool_result', tool_use_id: 't2', content: 'beta' },
              ],
            },
          },
          false
        );
        out.toolBatch = !!(
          batchRt.stream.tools.t1.state === 'done' &&
          batchRt.stream.tools.t2.state === 'done' &&
          batchRt.activities[0].output === 'alpha' &&
          batchRt.activities[1].output === 'beta'
        );
        state.runtimes.delete(batchId);
        // 会话内查找（Ctrl+F）
        document.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true })
        );
        await new Promise((r) => setTimeout(r, 120));
        const fi = document.getElementById('findInput');
        fi.value = '用一句话';
        fi.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 180));
        out.find =
          document.getElementById('findBar').classList.contains('show') &&
          !!document.getElementById('findCount').textContent &&
          !!document.querySelector('.msg.flash');
        out.findBarMotion = getComputedStyle(document.getElementById('findBar')).animationName.includes(
          'ui-menu-in'
        );
        // 查找复用 messageSearchText 缓存：命中后 lower 直接可取，不再重算 searchableText
        {
          const fm = { role: 'assistant', blocks: [{ type: 'text', text: 'FindCache 探针 Alpha' }] };
          const first = messageSearchText(fm);
          out.findUsesCache = first.lower.indexOf('findcache') >= 0 && messageSearchText(fm) === first;
          // R19：轻量签名缓存——命中复用，内容变更（块追加/文本追加）后失效重算
          const sm = { role: 'assistant', blocks: [{ type: 'text', text: '甲' }] };
          const s1 = messageSearchText(sm);
          const s1hit = messageSearchText(sm) === s1 && s1.src === '甲';
          sm.blocks.push({ type: 'text', text: '乙' });
          const s2 = messageSearchText(sm);
          sm.blocks[0].text = '甲乙丙';
          const s3 = messageSearchText(sm);
          out.msgSearchSigCache = s1hit && s2 !== s1 && s2.src.indexOf('乙') >= 0 && s3 !== s2 && s3.src.indexOf('丙') >= 0;
        }
        closeFind();
        out.findBarCloseMotion =
          document.getElementById('findBar').classList.contains('closing') &&
          getComputedStyle(document.getElementById('findBar')).animationName.includes('ui-fade-out');
        // Ctrl+Tab 循环切换会话
        const beforeSwitch = state.current && state.current.id;
        document.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Tab', ctrlKey: true, bubbles: true })
        );
        await new Promise((r) => setTimeout(r, 120));
        out.cycle = !!state.current && state.current.id !== beforeSwitch;
        // 工具输出截断标记
        out.truncated = toolElement({
          type: 'tool',
          name: 'x',
          input: {},
          state: 'done',
          output: 'abc',
          outputLen: 9999,
          truncated: true,
        }).textContent.includes('已截断');
        // 消息时间戳 + 同配置新会话
        out.ts = state.sessions.some((x) => (x.messages || []).some((m) => m.ts));
        // 时间戳格式化缓存：同一 ts 结果恒定，命中后不再调用 Intl
        {
          const probeTs = 1795155251010;
          const a = fmtTime(probeTs);
          const cacheBefore = fmtTimeCache.get(probeTs);
          const b = fmtTime(probeTs);
          out.fmtTimeCache = a === b && a.indexOf(':') > 0 && cacheBefore === a && fmtTime(0) === '';
        }
        // R16：老会话日期分支缓存（>30 天走 toLocaleDateString，按 ts 缓存）
        {
          const oldTs = Date.now() - 60 * 86400000;
          const d1 = relDate(oldTs);
          const cached = relDateCache.get(oldTs);
          const d2 = relDate(oldTs);
          out.relDateCache = d1 === d2 && !!cached && cached === d1 && relTime(oldTs) === d1;
        }
        const srcS = state.current;
        const like = newSessionLike(srcS);
        out.sessionLike =
          like.model === srcS.model && like.cwd === srcS.cwd && like.messages.length === 0;
        cancelPersist(like.id);
        await window.shell.sessions.remove(like.id);
        state.sessions = state.sessions.filter((x) => x.id !== like.id);
        state.current = srcS;
        renderAll();
        // 新建会话复用空会话
        const a1 = newSessionOrFocus();
        const a2 = newSessionOrFocus();
        out.sessionReuse = a1.id === a2.id;
        if (a1.messages.length === 0) {
          cancelPersist(a1.id);
          await window.shell.sessions.remove(a1.id);
          const at = state.sessions.findIndex((x) => x.id === a1.id);
          if (at >= 0) state.sessions.splice(at, 1);
          state.current = state.sessions[0] || null;
          renderAll();
        }
        setCfgSection('about');
        await new Promise((r) => setTimeout(r, 400));
        out.sessionIO = [...document.querySelectorAll('#aLinks .btn')].some(
          (b) => b.textContent === '导出全部会话'
        );
        out.trashApi = typeof window.shell.sessions.trashList === 'function';
        const tr = await window.shell.sessions.trashList();
        out.trashList = !!(tr && Array.isArray(tr.items));
        // R30：trash 列表按 deletedAt 倒序、最多 20 条（先 stat 排序再只解析入选文件）
        out.trashTop20 = tr.items.length <= 20 && tr.items.every(
          (it, i) => i === 0 || tr.items[i - 1].deletedAt >= it.deletedAt
        );
        out.logViewer =
          !!document.getElementById('logTail') &&
          !!document.getElementById('logRefresh') &&
          !!document.getElementById('logOpenDir') &&
          typeof window.shell.logInfo === 'function';
        const li = await window.shell.logInfo().catch(() => null);
        out.logInfo = !!(
          li &&
          li.ok &&
          typeof li.tail === 'string' &&
          typeof li.size === 'number' &&
          typeof li.dir === 'string' &&
          li.path
        );
        out.logRendered = /agent.log/.test(
          (document.getElementById('logMeta') || {}).textContent || ''
        );
        out.logRotate = /agent\.log\.1.*2 KB/.test(
          logMetaText({ size: 1024, rotated: { size: 2048 } })
        );
        setCfgSection('general');
        return out;
      })()
    `);
    // R83 监工：本轮 14 项修复的行为断言（AC1/AC3/AC4/AC6/AC7 + AE1/AE2/AE3/AE5/AE6/AE7）
    try {
      const r83 = await mainWindow.webContents.executeJavaScript(`
        (async () => {
          const out = {};
          const s = state.current;
          if (!s) return { noSession: true };
          const r = rt(s.id);
          const busy0 = r.busy;
          const stream0 = r.stream;
          const fire = (ev) => handleAgentEvent({ sessionId: s.id, event: ev });

          // AC1：回合超时强杀必须收尾当前回合（busy && stream 也要收）
          r.busy = true;
          r.stream = { blocks: [], tools: {}, toolEls: {} };
          fire({ type: 'host_exit', code: 1, intentional: true, reason: '回合超时', timedOut: true });
          out.raceTimeoutExit = r.busy === false && r.stream === null;

          // AC1 反向：没有失败原因的迟到退出仍要忽略（新回合正在跑）
          r.busy = true;
          r.stream = { blocks: [], tools: {}, toolEls: {} };
          fire({ type: 'host_exit', code: 0, intentional: true, reason: '' });
          out.raceStaleExitIgnored = r.busy === true && !!r.stream;
          r.busy = busy0;
          r.stream = stream0;
          r.ignoreResultUntil = 0;
          r.status = { text: '就绪', kind: '' };

          // AC3：beginTurn 必须复位 ignoreResultUntil（cwd 置空让它复位后立即返回）
          const cwd0 = s.cwd;
          s.cwd = '';
          r.ignoreResultUntil = Date.now() + 3000;
          beginTurn(s, 'r83-probe');
          out.raceIgnoreReset = r.ignoreResultUntil === 0;
          s.cwd = cwd0;

          // AC4：其他会话的排队授权不能被丢弃
          const sidB = 's_r83_b';
          approvalQueue.length = 0;
          state.pendingApproval = { sessionId: s.id, requestId: 'rA83', toolName: 'bash', input: { command: 'echo' } };
          approvalQueue.push({ sessionId: sidB, requestId: 'rB83', toolName: 'bash', input: { command: 'echo' } });
          clearApprovalCard();
          out.approvalQueueKeep = approvalQueue.some(function (x) { return x && x.sessionId === sidB; });
          approvalQueue.length = 0;
          clearApprovalCard();

          // AC6：空闲会话的 host_error 不能改写已完成回复
          const assistants = (s.messages || []).filter(function (m) { return m && m.role === 'assistant'; });
          const lastA = assistants.length ? assistants[assistants.length - 1] : null;
          const stopped0 = lastA ? lastA.stopped : undefined;
          r.busy = false;
          r.stream = null;
          fire({ type: 'host_error', message: 'r83-probe' });
          out.hostErrorIdle = !lastA || lastA.stopped === stopped0;
          // 探针会留下「无法启动 qwen CLI」引导条，撤掉避免污染后续视觉截图
          state.cliGuide = null;
          const guideEl = document.querySelector('.cli-guide');
          if (guideEl) guideEl.remove();

          // AC7：失效授权必须返回 false（渲染层据此提示「已失效」而不是显示「已允许」）
          out.approvalInvalid = (await window.shell.chat.approval(s.id, 'r83-no-such-request', true)) === false;

          // AE1：跳转到早期消息时渲染窗口必须封顶（不一次渲染整条会话）
          const fakeId = 's_r83_long';
          const many = [];
          for (let i = 0; i < 3000; i++) many.push({ role: 'assistant', text: 'l' + i, blocks: [{ type: 'text', text: 'l' + i }], ts: 1 });
          const fake = { id: fakeId, title: 'r83-long', cwd: s.cwd, messages: many, createdAt: 1, updatedAt: 1 };
          const cur0 = state.current;
          state.sessions.push(fake);
          state.current = fake;
          jumpToMessage(0, fakeId);
          const painted = document.querySelectorAll('#thread .msg').length;
          out.renderWindowCap = painted > 0 && painted <= 801;
          state.renderFloor.delete(fakeId);
          state.renderLimit.delete(fakeId);
          state.runtimes.delete(fakeId);
          state.current = cur0;
          state.sessions.splice(state.sessions.indexOf(fake), 1);
          renderThread();
          out.renderWindowReturn = state.renderFloor.has(s.id) === false;

          // AE2：超大表格截断（201 列 × 402 行）
          const cols = [];
          for (let i = 0; i < 201; i++) cols.push('c' + i);
          const headRow = '| ' + cols.join(' | ') + ' |';
          const sepRow = '| ' + cols.map(function () { return '---'; }).join(' | ') + ' |';
          const bigRows = [headRow, sepRow];
          for (let i = 0; i < 400; i++) bigRows.push(headRow);
          const tableHtml = renderTable(bigRows);
          out.tableCap = (tableHtml.match(/<td>/g) || []).length <= 64 * 200 && tableHtml.indexOf('表格过大') >= 0;

          // AE3：实时工具输出渲染侧硬截断
          const bigOut = new Array(400000).join('x');
          const toolHtml = toolOutHtml({ name: 'run_shell_command', output: bigOut });
          out.toolOutCap = toolHtml.length < 400000 && toolHtml.indexOf('渲染已截断') >= 0;

          // AE5：300KB 长块在总预算内应缓存，普通块照常缓存
          const bigBlock = { type: 'text', text: new Array(300000).join('y') };
          blockElement(bigBlock);
          const smallBlock = { type: 'text', text: 'r83-small' };
          blockElement(smallBlock);
          out.mdBlockCacheGate = !!mdBlockNodeCache.get(bigBlock) && !!mdBlockNodeCache.get(smallBlock);

          // AE6：URL 里的成对括号要完整保留；多出来的 ) 要还给正文
          const linkPlain = inlineMarkup('[x](https://a.example/b_(c))');
          const linkExtra = inlineMarkup('[x](https://a.example/b_(c)))');
          out.linkParens =
            linkPlain.indexOf('href="https://a.example/b_(c)"') >= 0 &&
            linkExtra.indexOf('href="https://a.example/b_(c)"') >= 0 &&
            linkExtra.indexOf('</a>)') >= 0;

          // AE7：按代理对安全截断，不产出孤立代理
          const emoji = String.fromCodePoint(0x1F600);
          let ep = window.__qcodeDevWs + '/deep/nested/path/';
          for (let i = 0; i < 12; i++) ep += emoji;
          ep += '.xlsx';
          const sp = shortPath(ep, 8);
          let lone = false;
          for (let i = 0; i < sp.length; i++) {
            const c = sp.charCodeAt(i);
            if (c >= 0xd800 && c <= 0xdbff) {
              const n = sp.charCodeAt(i + 1);
              if (!(n >= 0xdc00 && n <= 0xdfff)) { lone = true; break; }
              i++;
            } else if (c >= 0xdc00 && c <= 0xdfff) { lone = true; break; }
          }
          out.surrogatePath = !lone && sp.indexOf(emoji) >= 0;

          // AD5：sessions:delete 的返回值契约（新形状 {ok:true}）
          const delRes = await window.shell.sessions.remove('s_r83_nonexistent');
          out.deleteContract = !!(delRes && delRes.ok === true);

          // R84：性能预算断言——阈值刻意宽松（只拦灾难性回归，不因机器差异抖动）
          const tPerf0 = performance.now();
          renderThread();
          out.perfThreadMs = +(performance.now() - tPerf0).toFixed(2);
          const bt2 = String.fromCharCode(96);
          let mdSrc = '';
          while (mdSrc.length < 8192) mdSrc += '## 段\\n\\n- 项 **粗** ' + bt2 + 'code' + bt2 + '\\n\\n';
          const tPerf1 = performance.now();
          renderMarkdown(mdSrc + ' ');
          out.perfMd8kMs = +(performance.now() - tPerf1).toFixed(2);
          out.perfBudget = out.perfThreadMs < 200 && out.perfMd8kMs < 100;
          out.bootProfile = !!(window.__bootMs > 0 && window.__bootMarks);

          // R85：输入框高度自适应仍正确（Electron 43 走 CSS field-sizing 路径，无 JS 强制重排）
          {
            const inp = document.getElementById('input');
            const prevVal = inp.value;
            inp.value = '一行';
            inp.dispatchEvent(new Event('input', { bubbles: true }));
            const h1 = inp.getBoundingClientRect().height;
            inp.value = 'a\\nb\\nc\\nd\\ne';
            inp.dispatchEvent(new Event('input', { bubbles: true }));
            const h5 = inp.getBoundingClientRect().height;
            inp.value = new Array(41).join('line\\n');
            inp.dispatchEvent(new Event('input', { bubbles: true }));
            const h40 = inp.getBoundingClientRect().height;
            out.inputAutosize = h5 > h1 + 10 && h40 <= 181 && inp.scrollHeight > inp.clientHeight;
            inp.value = prevVal;
            inp.dispatchEvent(new Event('input', { bubbles: true }));
          }

          // R86：流式排版限频——32KB 底文上连续 20 次更新，已 settled 区域最多重排 2 次
          {
            const host = document.createElement('div');
            document.body.appendChild(host);
            const st = { previewEl: host, previewText: '', twShown: null };
            let base = '';
            while (base.length < 32768) base += '段落 **粗** ' + String.fromCharCode(10);
            st.previewText = base;
            st.twShown = base.length;
            typesetStreamPreview(st);
            st.twSettledRenders = 0;
            for (let i = 0; i < 20; i++) {
              st.previewText = base + 'x' + i + String.fromCharCode(10);
              st.twShown = st.previewText.length;
              typesetStreamPreview(st);
            }
            out.typesetThrottle = st.twSettledRenders <= 2;
            host.remove();
          }

          // 恢复现场：本轮注入可能给最后一条回复打了 stopped 标记
          if (lastA) lastA.stopped = stopped0;
          persist(s);
          return out;
        })()
      `);
      Object.assign(checks, r83 || {});
    } catch (e) {
      for (const k of ['raceTimeoutExit', 'raceStaleExitIgnored', 'raceIgnoreReset', 'approvalQueueKeep', 'hostErrorIdle', 'approvalInvalid', 'renderWindowCap', 'renderWindowReturn', 'tableCap', 'toolOutCap', 'mdBlockCacheGate', 'linkParens', 'surrogatePath', 'deleteContract']) {
        checks[k] = false;
      }
      log('r83 renderer checks failed', String((e && e.message) || e));
    }
    // R83 监工AD1/AD2/AD3/AE4：检查点 blob 原子落盘、恢复返回值形状、删除回收、备份限额（临时目录，不碰真实项目）
    try {
      const cpSid = 's_r83_cp';
      const cpDir = path.join(WRITABLE_DIR, 'r83-cp');
      fs.mkdirSync(cpDir, { recursive: true });
      fs.writeFileSync(path.join(cpDir, 'a.txt'), 'r83-checkpoint');
      const created = await mainWindow.webContents.executeJavaScript(
        'window.shell.checkpoint.create(' + JSON.stringify(cpSid) + ',' + JSON.stringify(cpDir) + ')'
      );
      const blobDir = path.join(checkpointRootDir(), 'blobs');
      const leftovers = fs.existsSync(blobDir)
        ? fs.readdirSync(blobDir).filter((f) => f.indexOf('.tmp-') >= 0).length
        : 0;
      const restored = created && created.ok
        ? await mainWindow.webContents.executeJavaScript(
            'window.shell.checkpoint.restore(' +
              JSON.stringify(cpSid) +
              ',' +
              JSON.stringify(created.id) +
              ',' +
              JSON.stringify(cpDir) +
              ',false)'
          )
        : null;
      // GC 会跳过 60s 内的新 blob（并发 create 保护），这里把 mtime 拨老 2 分钟再验证回收
      const past = new Date(Date.now() - 120000);
      if (fs.existsSync(blobDir)) {
        for (const f of fs.readdirSync(blobDir)) {
          try {
            fs.utimesSync(path.join(blobDir, f), past, past);
          } catch {
            /* ignore */
          }
        }
      }
      const delAll = await mainWindow.webContents.executeJavaScript(
        'window.shell.checkpoint.deleteAll(' + JSON.stringify(cpSid) + ')'
      );
      checks.cpBlobAtomic = leftovers === 0 && !!created && created.ok === true;
      checks.cpRestoreShape = !!(restored && restored.ok === true && Array.isArray(restored.failed) && Array.isArray(restored.skipped));
      checks.cpGcOnDeleteAll = !!(delAll && delAll.ok === true && typeof delAll.reclaimed === 'number' && delAll.reclaimed > 0);
      try {
        fs.rmSync(cpDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    } catch (e) {
      checks.cpBlobAtomic = false;
      checks.cpRestoreShape = false;
      checks.cpGcOnDeleteAll = false;
      log('r83 checkpoint checks failed', String((e && e.message) || e));
    }
    try {
      const bk = await backupSessions(true);
      checks.backupShape = !!(bk && bk.ok === true && typeof bk.savedCount === 'number' && typeof bk.dropped === 'number');
    } catch {
      checks.backupShape = false;
    }
    // R84：懒加载预算选择器（纯函数，直接断言优先级与阈值）
    try {
      const mk = (i, archived, pinned, msgCount) => ({
        id: 'e' + i,
        archived: !!archived,
        pinned: !!pinned,
        messageCount: msgCount,
        updatedAt: 100000 - i,
      });
      const list = [];
      for (let i = 0; i < 100; i++) list.push(mk(i, false, false, 100));
      const picked = pickEagerSessions(list);
      const onlyArchived = pickEagerSessions([mk(1, true, false, 5), mk(2, true, false, 5)]);
      const pinnedOverBudget = pickEagerSessions([mk(1, false, false, 10000), mk(2, false, true, 10000), mk(3, false, false, 10)]);
      checks.eagerBudget =
        picked.size === SESSION_EAGER_MAX &&
        picked.has('e0') &&
        !picked.has('e99') &&
        onlyArchived.size === 0 &&
        pinnedOverBudget.has('e2');
    } catch {
      checks.eagerBudget = false;
    }
    // R88：会话保存失败必须可见（主进程事件 → 状态栏/toast），恢复后清除
    try {
      const sid = await mainWindow.webContents.executeJavaScript('state.current && state.current.id');
      if (sid) {
        mainWindow.webContents.send('sessions:save-error', { id: sid, error: 'smoke-disk-full' });
        await new Promise((r) => setTimeout(r, 120));
        const failedText = await mainWindow.webContents.executeJavaScript(
          "document.getElementById('statusText').textContent"
        );
        const hooked = await mainWindow.webContents.executeJavaScript('!!window.__saveErrorHooked');
        mainWindow.webContents.send('sessions:save-ok', { id: sid });
        await new Promise((r) => setTimeout(r, 80));
        const okText = await mainWindow.webContents.executeJavaScript(
          "document.getElementById('statusText').textContent"
        );
        checks.saveErrorVisible =
          hooked && /会话保存失败/.test(String(failedText)) && /已恢复保存/.test(String(okText));
      } else {
        checks.saveErrorVisible = false;
      }
    } catch (e) {
      checks.saveErrorVisible = false;
      log('save error assertion failed', String((e && e.message) || e));
    }
    // R88：落盘失败注入演练——把 writeFileSync 打成 ENOSPC，验证「重试耗尽 → 通知渲染层 → 恢复后清除」
    {
      const injId = 's_smoke_save_inject';
      const realWrite = fs.writeFileSync;
      let injecting = true;
      fs.writeFileSync = function (p, data, enc) {
        if (injecting && String(p).indexOf(injId) >= 0) {
          const err = new Error('ENOSPC: no space left on device (smoke-injected)');
          err.code = 'ENOSPC';
          throw err;
        }
        return realWrite.call(fs, p, data, enc);
      };
      try {
        const beforeCount = await mainWindow.webContents.executeJavaScript(
          'window.__saveErrorCount || 0'
        );
        const fake = {
          id: injId,
          title: 'save-inject',
          cwd: '.',
          messages: [],
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        saveSession(fake);
        flushSessionSave(injId); // 第 1 次失败 → 开始 500ms 重试
        await new Promise((r) => setTimeout(r, 2200)); // 等 4 次尝试（>3 次即丢弃并通知）
        injecting = false;
        const notified = saveFailedSessions.has(injId);
        const afterCount = await mainWindow.webContents.executeJavaScript(
          'window.__saveErrorCount || 0'
        );
        // 恢复：再存一次应当成功并发出 save-ok
        saveSession(fake);
        flushSessionSave(injId);
        await new Promise((r) => setTimeout(r, 150));
        const recovered = !saveFailedSessions.has(injId);
        checks.saveErrorInjected = notified && recovered && afterCount > beforeCount;
        try {
          deleteSessionFile(injId);
        } catch {
          /* ignore */
        }
      } catch (e) {
        checks.saveErrorInjected = false;
        log('save inject drill failed', String((e && e.message) || e));
      } finally {
        injecting = false;
        fs.writeFileSync = realWrite;
      }
    }
    // R88：坏数据演练——损坏的索引/会话文件必须被容错（自愈或返回 ok:false），不能把启动打崩
    try {
      let idxBackup = null;
      try {
        idxBackup = fs.readFileSync(SESSION_INDEX_FILE, 'utf8');
      } catch {
        idxBackup = null;
      }
      fs.writeFileSync(SESSION_INDEX_FILE, '{ this is not valid json', 'utf8');
      sessionIndex = null; // 强制重新读取（否则走内存缓存，测不到损坏路径）
      let idxOk = false;
      try {
        const list = await loadSessionsIndexed();
        idxOk = Array.isArray(list);
      } catch {
        idxOk = false;
      }
      try {
        if (idxBackup != null) fs.writeFileSync(SESSION_INDEX_FILE, idxBackup, 'utf8');
        else fs.unlinkSync(SESSION_INDEX_FILE);
      } catch {
        /* ignore */
      }
      // 坏会话文件：sessions:get 必须返回 {ok:false} 而不是抛错
      const badId = 's_smoke_badfile';
      fs.writeFileSync(sessionFile(badId), '{ broken json', 'utf8');
      const got = await mainWindow.webContents.executeJavaScript(
        'window.shell.sessions.get(' + JSON.stringify(badId) + ')'
      );
      const getOk = !!(got && got.ok === false);
      try {
        fs.unlinkSync(sessionFile(badId));
      } catch {
        /* ignore */
      }
      checks.badDataSafe = idxOk && getOk;
    } catch (e) {
      checks.badDataSafe = false;
      log('bad data drill failed', String((e && e.message) || e));
    }
    // R90：批量补水 IPC 契约（缺失 id 要返回 session:null 而不是抛错）
    try {
      const rows = await mainWindow.webContents.executeJavaScript(
        "window.shell.sessions.getBatch(['s_missing_a83','s_missing_b83'])"
      );
      const hasApi = await mainWindow.webContents.executeJavaScript(
        "typeof window.shell.sessions.getBatch === 'function'"
      );
      checks.batchHydrate =
        !!hasApi &&
        Array.isArray(rows) &&
        rows.length === 2 &&
        rows.every((r) => r && r.session === null);
    } catch (e) {
      checks.batchHydrate = false;
      log('batch hydrate assertion failed', String((e && e.message) || e));
    }
    // R96：备份体积按 UTF-8 字节计量（中文会话不能按 UTF-16 字符数算）
    try {
      const sample = { text: '中文内容，占多个字节', n: 1 };
      const utf8 = Buffer.byteLength(JSON.stringify(sample), 'utf8');
      checks.backupByteUnits = backupBytesOf(sample) === utf8 && utf8 > JSON.stringify(sample).length;
    } catch (e) {
      checks.backupByteUnits = false;
      log('backup byte assertion failed', String((e && e.message) || e));
    }
    // R96：检查点跳过 >4MB 文件要计数（skippedLarge），且不得影响其余文件入检查点
    try {
      const cpDir = path.join(DATA_DIR, 'cp-src-smoke');
      fs.rmSync(cpDir, { recursive: true, force: true });
      fs.mkdirSync(cpDir, { recursive: true });
      fs.writeFileSync(path.join(cpDir, 'small.txt'), 'hello', 'utf8');
      fs.writeFileSync(path.join(cpDir, 'big.bin'), Buffer.alloc(5 * 1024 * 1024, 1));
      const cpRes = await mainWindow.webContents.executeJavaScript(
        'window.shell.checkpoint.create("s_smoke_cp_large", ' + JSON.stringify(cpDir) + ')'
      );
      checks.cpSkipLarge = !!(
        cpRes &&
        cpRes.ok &&
        cpRes.skippedLarge >= 1 &&
        cpRes.fileCount === 1 &&
        cpRes.truncated === false
      );
      try {
        fs.rmSync(checkpointSessionDir('s_smoke_cp_large'), { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      try {
        fs.rmSync(cpDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    } catch (e) {
      checks.cpSkipLarge = false;
      log('checkpoint skip assertion failed', String((e && e.message) || e));
    }
    // R96：清理历史空会话必须尊重删除结果（失败的要留在列表里）
    try {
      const r = await mainWindow.webContents.executeJavaScript(`
        (async () => {
          const keep = state.sessions;
          const fake = [
            { id: 's_stale_ok83', title: '新会话', messages: [], archived: false, lazy: false },
            { id: 's_stale_fail83', title: '新会话', messages: [], archived: false, lazy: false },
          ];
          state.sessions = fake.slice();
          let out = null;
          try {
            out = await removeStaleEmptySessions(fake, (id) => Promise.resolve({ ok: id === 's_stale_ok83' }));
          } finally {
            const left = (state.sessions || []).map((x) => x.id);
            state.sessions = keep;
            out = { left: left };
          }
          return out;
        })()
      `);
      checks.staleCleanupHonorsFail = !!(r && r.left.length === 1 && r.left[0] === 's_stale_fail83');
    } catch (e) {
      checks.staleCleanupHonorsFail = false;
      log('stale cleanup assertion failed', String((e && e.message) || e));
    }
    // R99：检查点 create → diff → restore 端到端（含「改/删/增」三类差异与还原后内容校验）
    try {
      const dir = path.join(DATA_DIR, 'cp-roundtrip');
      const sid = 's_smoke_cp_roundtrip';
      fs.rmSync(dir, { recursive: true, force: true });
      try {
        fs.rmSync(checkpointSessionDir(sid), { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'a.txt'), 'AAA', 'utf8');
      fs.writeFileSync(path.join(dir, 'b.txt'), 'BBB', 'utf8');
      const created = await mainWindow.webContents.executeJavaScript(
        'window.shell.checkpoint.create("' + sid + '",' + JSON.stringify(dir) + ')'
      );
      fs.writeFileSync(path.join(dir, 'a.txt'), 'MODIFIED', 'utf8');
      fs.rmSync(path.join(dir, 'b.txt'), { force: true });
      fs.writeFileSync(path.join(dir, 'c.txt'), 'NEW', 'utf8');
      const diff = await mainWindow.webContents.executeJavaScript(
        'window.shell.checkpoint.diff("' + sid + '","' + String((created && created.id) || '') + '",' + JSON.stringify(dir) + ')'
      );
      const restored = await mainWindow.webContents.executeJavaScript(
        'window.shell.checkpoint.restore("' + sid + '","' + String((created && created.id) || '') + '",' + JSON.stringify(dir) + ',true)'
      );
      let contentA = '';
      try {
        contentA = fs.readFileSync(path.join(dir, 'a.txt'), 'utf8');
      } catch {
        contentA = '';
      }
      const okA = contentA === 'AAA';
      const okB = fs.existsSync(path.join(dir, 'b.txt'));
      const okC = !fs.existsSync(path.join(dir, 'c.txt'));
      checks.cpRoundTrip = !!(
        created &&
        created.ok &&
        diff &&
        diff.ok &&
        diff.changed.length === 1 &&
        diff.added.length === 1 &&
        diff.missing.length === 1 &&
        restored &&
        restored.ok &&
        restored.restored === 2 &&
        restored.deleted === 1 &&
        okA &&
        okB &&
        okC
      );
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      try {
        fs.rmSync(checkpointSessionDir(sid), { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    } catch (e) {
      checks.cpRoundTrip = false;
      log('checkpoint roundtrip assertion failed', String((e && e.message) || e));
    }
    // R101：失焦暂停常驻动画——类名生效 + blur/focus 事件真的切换它
    try {
      const r = await mainWindow.webContents.executeJavaScript(`
        (function () {
          const el = document.createElement('div');
          el.style.animation = 'pulse 1s infinite';
          document.body.appendChild(el);
          document.body.classList.add('motion-paused');
          const paused = getComputedStyle(el).animationPlayState;
          document.body.classList.remove('motion-paused');
          const running = getComputedStyle(el).animationPlayState;
          el.remove();
          // 事件联动：blur 应加类，focus 应去类
          window.dispatchEvent(new Event('blur'));
          const afterBlur = document.body.classList.contains('motion-paused');
          window.dispatchEvent(new Event('focus'));
          const afterFocus = document.body.classList.contains('motion-paused');
          return { paused: paused, running: running, afterBlur: afterBlur, afterFocus: afterFocus };
        })()
      `);
      checks.motionPause = !!(
        r &&
        r.paused === 'paused' &&
        r.running === 'running' &&
        r.afterBlur === true &&
        r.afterFocus === false
      );
    } catch (e) {
      checks.motionPause = false;
      log('motion pause assertion failed', String((e && e.message) || e));
    }
    // R105：草稿持久化上限——超 512KB 的草稿不落盘，小草稿照常，且不抛错
    try {
      const r = await mainWindow.webContents.executeJavaScript(`
        (function () {
          const keep = state.drafts;
          const key = 'ui.drafts';
          const prev = localStorage.getItem(key);
          const big = new Array(600 * 1024).join('x'); // ~614KB，超过 512KB 上限
          state.drafts = { small1: '普通草稿', big1: big };
          persistDrafts();
          const raw = localStorage.getItem(key) || '';
          let parsed = {};
          try { parsed = JSON.parse(raw) || {}; } catch (e) { parsed = {}; }
          const res = {
            hasSmall: parsed.small1 === '普通草稿',
            hasBig: Object.prototype.hasOwnProperty.call(parsed, 'big1'),
            rawLen: raw.length,
          };
          state.drafts = keep;
          if (prev == null) localStorage.removeItem(key);
          else localStorage.setItem(key, prev);
          return res;
        })()
      `);
      checks.draftPersistCap = !!(r && r.hasSmall === true && r.hasBig === false && r.rawLen < 100 * 1024);
    } catch (e) {
      checks.draftPersistCap = false;
      log('draft persist cap assertion failed', String((e && e.message) || e));
    }
    // R106：滚动记忆上限——超过 300 条必须裁剪（否则 localStorage 随会话数无限增长）
    try {
      const r = await mainWindow.webContents.executeJavaScript(`
        (function () {
          const keep = state.scroll;
          const prevRaw = localStorage.getItem('ui.sessionScroll');
          const fake = {};
          for (let i = 0; i < 320; i++) fake['s_cap_' + i] = i;
          state.scroll = fake;
          saveScrollMemory();
          let parsed = {};
          try { parsed = JSON.parse(localStorage.getItem('ui.sessionScroll') || '{}') || {}; } catch (e) { parsed = {}; }
          const res = {
            n: Object.keys(parsed).length,
            keptLast: parsed['s_cap_319'] === 319,
            droppedFirst: !Object.prototype.hasOwnProperty.call(parsed, 's_cap_0'),
          };
          state.scroll = keep;
          if (prevRaw == null) localStorage.removeItem('ui.sessionScroll');
          else localStorage.setItem('ui.sessionScroll', prevRaw);
          return res;
        })()
      `);
      checks.scrollMemoryCap = !!(r && r.n <= 300 && r.keptLast && r.droppedFirst);
    } catch (e) {
      checks.scrollMemoryCap = false;
      log('scroll memory cap assertion failed', String((e && e.message) || e));
    }
    // R108：懒加载会话切换时先出「载入中」骨架（超大单会话冷读 200ms 不能是死寂）
    try {
      const r = await mainWindow.webContents.executeJavaScript(`
        (async function () {
          const s = state.sessions.find(function (x) { return x && x.id; });
          if (!s) return { ok: false, why: 'no session' };
          const keepLazy = s.lazy;
          const keepMsgs = s.messages;
          s.lazy = true;
          s.messages = [];
          const p = switchSession(s.id); // 不 await：立刻检查已插入的骨架
          const html = (document.getElementById('thread') || {}).innerHTML || '';
          await p;
          s.lazy = keepLazy;
          s.messages = keepMsgs;
          delete s.hydrateFailed;
          renderThread();
          return {
            showed: html.indexOf('正在载入会话') >= 0,
            hasSkeleton: html.indexOf('sk-inner') >= 0,
          };
        })()
      `);
      checks.lazyLoadingSkeleton = !!(r && r.showed === true && r.hasSkeleton === true);
    } catch (e) {
      checks.lazyLoadingSkeleton = false;
      log('lazy loading skeleton assertion failed', String((e && e.message) || e));
    }
    // R118：附件清理限频——连续两次调用只真正 prune 一次
    try {
      attachPruneAt = 0;
      pruneAttachmentsThrottled();
      const first = attachPruneAt;
      pruneAttachmentsThrottled();
      checks.attachPruneThrottle = first > 0 && attachPruneAt === first;
    } catch (e) {
      checks.attachPruneThrottle = false;
      log('attach prune throttle assertion failed', String((e && e.message) || e));
    }
    // R121：导出 PDF——(a) 打印版 HTML 结构正确且禁脚本；(b) printToPDF 真的产出 PDF
    try {
      const r = await mainWindow.webContents.executeJavaScript(`
        (function () {
          const s = state.current;
          if (!s) return { ok: false, why: 'no session' };
          const html = sessionToPrintHtml(s);
          const lastUser = (s.messages || []).filter(function (m) { return m && m.role === 'user' && (m.text || '').trim(); }).pop();
          return {
            len: html.length,
            doctype: html.indexOf('<!doctype html>') === 0,
            csp: html.indexOf("script-src") >= 0 || html.indexOf("default-src 'none'") >= 0,
            noScriptTag: !/<script/i.test(html),
            hasTitle: html.indexOf('<h1>') > 0,
            hasUserText: lastUser ? html.indexOf(esc(String(lastUser.text).slice(0, 12))) >= 0 : true,
          };
        })()
      `);
      checks.pdfHtml = !!(
        r &&
        r.doctype &&
        r.csp &&
        r.noScriptTag &&
        r.hasTitle &&
        r.hasUserText &&
        r.len > 200
      );
      const pdf = await htmlToPdfBuffer(
        '<!doctype html><html><head><meta charset="utf-8"><style>body{font-family:sans-serif}h1{color:#111}</style></head><body><h1>Qcode PDF 冒烟</h1><p>这是一段用于验证 printToPDF 的中文内容。</p></body></html>'
      );
      const buf = pdf && pdf.ok ? pdf.buffer : null;
      checks.pdfExport = !!(buf && buf.length > 1000 && buf.slice(0, 4).toString('latin1') === '%PDF');
      if (!checks.pdfExport) log('pdf export assertion detail', JSON.stringify({ ok: !!(pdf && pdf.ok), bytes: buf ? buf.length : 0, err: (pdf && pdf.error) || '' }));
    } catch (e) {
      checks.pdfHtml = false;
      checks.pdfExport = false;
      log('pdf assertions failed', String((e && e.message) || e));
    }
    // R121b：导出 HTML / PDF 区间 / 附件内嵌 / 搜索增强
    try {
      const r = await mainWindow.webContents.executeJavaScript(`
        (function () {
          const fake = {
            id: 'fake_export', title: '导出测试', cwd: 'F:\\\\x', modelLabel: 'M',
            messages: [
              { role: 'user', text: '第一条 用户消息 ALPHA', ts: 1, attachments: [] },
              { role: 'assistant', text: '第二条 助手回复 **beta**', ts: 2, blocks: [{ type: 'text', text: '第二条 助手回复 **beta**' }, { type: 'tool', name: 'read_file', state: 'done', output: 'TOOL-OUTPUT-LINE', input: { p: 1 } }] },
              { role: 'user', text: '第三条 用户消息 GAMMA', ts: 3, attachments: [] },
            ],
          };
          const html = sessionToHtmlFile(fake);
          const pdfAll = sessionToPrintHtml(fake);
          const pdfRange = sessionToPrintHtml(fake, { from: 1, to: 1 });
          const hl = highlightQuery('Foo BAR baz <b>', 'bar');
          const prevIndex = state.fullTextIndex;
          const prevIndexed = state.fullTextIndexed;
          const prevSessions = state.sessions;
          let hits = [];
          let partialHits = [];
          let paletteHit = null;
          try {
            state.fullTextIndex = new Map();
            state.fullTextIndexed = new Set();
            state.sessions = [fake];
            hits = searchAllMessages('第二条', 5);
            // 索引里明确「没有这个会话」但该会话尚未完成索引 → 仍应回退扫描，不能假阴性
            state.fullTextIndex = new Map([['第', new Map()]]);
            partialHits = searchAllMessages('第二条', 5);
            const found = (paletteItems('第二条') || []).find((it) => it.section === 'search') || null;
            paletteHit = found ? { hintHtml: found.hintHtml || '', label: found.label || '' } : null;
          } finally {
            state.fullTextIndex = prevIndex;
            state.fullTextIndexed = prevIndexed;
            state.sessions = prevSessions;
          }
          return {
            html: html,
            pdfAll: pdfAll,
            pdfRange: pdfRange,
            hl: hl,
            hits: hits,
            partialHits: partialHits,
            paletteHit: paletteHit,
          };
        })()
      `);
      checks.htmlExportFile = !!(
        r &&
        r.html.indexOf('<!doctype html>') === 0 &&
        /<details class="tool">/.test(r.html) &&
        r.html.indexOf('<script') < 0 &&
        r.html.indexOf('TOOL-OUTPUT-LINE') > 0 &&
        r.html.indexOf('ALPHA') > 0 &&
        r.html.indexOf('导出测试') > 0
      );
      checks.pdfRange = !!(
        r &&
        r.pdfAll.indexOf('ALPHA') > 0 &&
        r.pdfAll.indexOf('GAMMA') > 0 &&
        r.pdfRange.indexOf('ALPHA') < 0 &&
        r.pdfRange.indexOf('GAMMA') < 0 &&
        r.pdfRange.indexOf('beta') > 0
      );
      checks.searchHighlight =
        !!r && r.hl === 'Foo <mark class="hit">BAR</mark> baz &lt;b&gt;';
      checks.searchMessageHits = !!(r && r.hits.length === 1 && r.hits[0].mi === 1 && r.hits[0].sid === 'fake_export');
      checks.searchPartialIndexSafe = !!(r && r.partialHits.length === 1 && r.partialHits[0].mi === 1);
      checks.paletteSearchHighlight = !!(
        r &&
        r.paletteHit &&
        String(r.paletteHit.hintHtml || '').indexOf('<mark class="hit">第二条</mark>') >= 0
      );
      if (!checks.pdfRange || !checks.searchMessageHits) {
        log(
          'export/search detail',
          JSON.stringify({
            rangeLen: r && r.pdfRange ? r.pdfRange.length : -1,
            rangeHasAlpha: !!(r && r.pdfRange && r.pdfRange.indexOf('ALPHA') >= 0),
            rangeHasGamma: !!(r && r.pdfRange && r.pdfRange.indexOf('GAMMA') >= 0),
            rangeHasBeta: !!(r && r.pdfRange && r.pdfRange.indexOf('beta') >= 0),
            allHas: !!(r && r.pdfAll && r.pdfAll.indexOf('ALPHA') >= 0),
            hits: r && r.hits,
          })
        );
      }
    } catch (e) {
      checks.htmlExportFile = false;
      checks.pdfRange = false;
      checks.searchHighlight = false;
      checks.searchMessageHits = false;
      checks.searchPartialIndexSafe = false;
      checks.paletteSearchHighlight = false;
      log('export/search assertions failed', String((e && e.message) || e));
    }
    // R121b：附件占位符内联成 data URL（PDF/HTML 里能真正看到图）
    try {
      const pngPath = path.join(ATTACH_DIR, 'smoke-inline-122.png');
      fs.mkdirSync(ATTACH_DIR, { recursive: true });
      // 1x1 透明 PNG
      fs.writeFileSync(
        pngPath,
        Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64')
      );
      const b64 = Buffer.from(pngPath, 'utf8').toString('base64');
      const html = '<p>x</p><img class="att" data-attach-path="' + b64 + '" alt="t">';
      const out = inlineAttachImages(html);
      checks.pdfInlineImages = out.indexOf('src="data:image/png;base64,') > 0 && out.indexOf('data-attach-path') < 0;
      // R122：目录外的文件（哪怕是 .png）绝不能被打进导出物
      const outside = path.join(DATA_DIR, 'smoke-outside.png');
      fs.writeFileSync(outside, 'TOP-SECRET-OUTSIDE-122', 'utf8');
      const outB64 = Buffer.from(outside, 'utf8').toString('base64');
      const badOut = inlineAttachImages('<img data-attach-path="' + outB64 + '">');
      checks.attachInlineBoundary =
        checks.pdfInlineImages &&
        badOut.indexOf('data:image') < 0 &&
        badOut.indexOf('TOP-SECRET-OUTSIDE-122') < 0 &&
        badOut.indexOf('data-missing') >= 0;
      try {
        fs.rmSync(pngPath, { force: true });
        fs.rmSync(outside, { force: true });
      } catch {
        /* ignore */
      }
    } catch (e) {
      checks.pdfInlineImages = false;
      checks.attachInlineBoundary = false;
      log('inline attach assertion failed', String((e && e.message) || e));
    }
    // R121b：跳到命中后，消息 DOM 里真的出现 <mark class="jump-hit">，清掉也能还原
    try {
      const r = await mainWindow.webContents.executeJavaScript(`
        (function () {
          const s = state.current;
          if (!s) return { ok: false, why: 'no session' };
          const msgs = s.messages || [];
          let idx = -1, probe = '';
          for (let i = msgs.length - 1; i >= 0; i--) {
            const t = String((typeof assistantText === 'function' ? assistantText(msgs[i]) : msgs[i].text) || '').trim();
            if (msgs[i] && t.length >= 6) { idx = i; probe = t.slice(0, 4); break; }
          }
          if (idx < 0) return { ok: true, skipped: true };
          const made = highlightInMessage(s.id, idx, probe);
          const domHits = document.querySelectorAll('#thread .jump-hit').length;
          clearJumpHighlight();
          const after = document.querySelectorAll('#thread .jump-hit').length;
          return { ok: true, made: made, domHits: domHits, after: after };
        })()
      `);
      checks.jumpHighlight = !!(r && r.ok && (r.skipped ? true : r.made > 0 && r.domHits > 0 && r.after === 0));
    } catch (e) {
      checks.jumpHighlight = false;
      log('jump highlight assertion failed', String((e && e.message) || e));
    }
    // R123：PDF 导出防重入——busy 时再次调用必须立即返回，不能启动第二个隐藏打印窗口
    try {
      const r = await mainWindow.webContents.executeJavaScript(`
        (async function () {
          const prev = pdfExportBusy;
          pdfExportBusy = true;
          await exportCurrentSessionPdf();
          const stillBusy = pdfExportBusy;
          const status = (document.getElementById('statusText') || {}).textContent || '';
          pdfExportBusy = prev;
          return { stillBusy: stillBusy, status: status };
        })()
      `);
      checks.pdfBusyGuard = !!(r && r.stillBusy === true && r.status.indexOf('正在生成 PDF') >= 0);
    } catch (e) {
      checks.pdfBusyGuard = false;
      log('pdf busy guard assertion failed', String((e && e.message) || e));
    }
    // R124：搜索高亮对比度——暗色必须命中 :root 选择器；浅/暗两种主题的四种表面都要 ≥ 4.5:1
    try {
      const r = await mainWindow.webContents.executeJavaScript(`
        (function () {
          const prev = document.documentElement.dataset.theme;
          const wrap = document.createElement('div');
          wrap.innerHTML =
            '<span class="session-snippet"><mark class="hit">命中</mark></span>' +
            '<span class="session-snippet2"><mark class="hit">命中</mark></span>' +
            '<span class="pi-hint"><mark class="hit">命中</mark></span>' +
            '<mark class="jump-hit">命中</mark>';
          document.body.appendChild(wrap);
          const els = [wrap.querySelector('.session-snippet mark'), wrap.querySelector('.session-snippet2 mark'), wrap.querySelector('.pi-hint mark'), wrap.querySelector('.jump-hit')];
          const rgb = (c) => (String(c).match(/\\d+(\\.\\d+)?/g) || []).map(Number);
          const lum = (c) => {
            const a = c.slice(0, 3).map((v) => {
              v /= 255;
              return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
            });
            return 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
          };
          const measure = () => {
            const base = rgb(getComputedStyle(document.body).backgroundColor);
            return els.map((el) => {
              const cs = getComputedStyle(el);
              const hb = rgb(cs.backgroundColor);
              const alpha = hb.length > 3 ? hb[3] : 1;
              const blended = base.map((v, i) => Math.round(hb[i] * alpha + v * (1 - alpha)));
              const tc = rgb(cs.color);
              const l1 = lum(blended);
              const l2 = lum(tc);
              return +((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)).toFixed(2);
            });
          };
          applyTheme('dark', false);
          const darkContrasts = measure();
          const darkBg = getComputedStyle(els[3]).backgroundColor;
          const darkText = getComputedStyle(els[3]).color;
          applyTheme('light', false);
          const lightContrasts = measure();
          const lightBg = getComputedStyle(els[3]).backgroundColor;
          const lightText = getComputedStyle(els[3]).color;
          wrap.remove();
          applyTheme(prev || 'light', false);
          return {
            darkBg: darkBg,
            darkText: darkText,
            lightBg: lightBg,
            lightText: lightText,
            darkContrasts: darkContrasts,
            lightContrasts: lightContrasts,
            minContrast: Math.min.apply(null, darkContrasts.concat(lightContrasts)),
          };
        })()
      `);
      checks.darkHighlight = !!(
        r &&
        r.darkBg !== r.lightBg &&
        r.darkBg.indexOf('255, 200, 80') >= 0 &&
        r.darkBg.indexOf('0.32') >= 0 &&
        r.darkText.indexOf('255, 243, 205') >= 0 &&
        r.lightText.indexOf('43, 36, 0') >= 0 &&
        r.minContrast >= 4.5
      );
      if (!checks.darkHighlight) log('dark highlight detail', JSON.stringify(r));
    } catch (e) {
      checks.darkHighlight = false;
      log('dark highlight assertion failed', String((e && e.message) || e));
    }
    // R125：暗/浅主题可访问性——焦点环 ≥3:1、错误文字 ≥4.5:1、禁用控件有明确光标
    try {
      const r = await mainWindow.webContents.executeJavaScript(`
        (function () {
          const prev = document.documentElement.dataset.theme;
          const parse = (c) => (String(c).match(/\\d+(\\.\\d+)?/g) || []).map(Number);
          const lum = (c) => {
            const a = c.slice(0, 3).map((v) => {
              v /= 255;
              return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
            });
            return 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
          };
          const ratio = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
          const probe = document.createElement('div');
          document.body.appendChild(probe);
          const colorOf = (v) => {
            probe.style.color = v;
            return parse(getComputedStyle(probe).color);
          };
          const bgOf = (v) => {
            probe.style.color = '';
            probe.style.background = v;
            const c = parse(getComputedStyle(probe).backgroundColor);
            probe.style.background = '';
            return c;
          };
          let minFocus = 99;
          let minError = 99;
          for (const theme of ['light', 'dark']) {
            applyTheme(theme, false);
            const accent = colorOf('var(--accent)');
            const err = colorOf('var(--err)');
            for (const bgVar of ['--bg', '--surface', '--sunken']) {
              const bg = bgOf('var(' + bgVar + ')');
              minFocus = Math.min(minFocus, ratio(accent, bg));
              minError = Math.min(minError, ratio(err, bg));
            }
          }
          // CSSOM 检查：所有 focus-visible 规则不能再用半透明黑/白或低对比 line 当焦点环
          let badFocusRules = 0;
          for (const sheet of document.styleSheets) {
            try {
              for (const rule of sheet.cssRules) {
                if (!rule.selectorText || !rule.selectorText.includes(':focus-visible')) continue;
                const outline = String(rule.style.outline || '') + ' ' + String(rule.style.outlineColor || '');
                if (outline.indexOf('rgba(28, 28, 26') >= 0 || outline.indexOf('rgba(236, 236, 231') >= 0 || outline.indexOf('var(--line)') >= 0) badFocusRules++;
              }
            } catch (e) {
              /* ignore */
            }
          }
          const disabled = document.createElement('button');
          disabled.className = 'btn';
          disabled.disabled = true;
          disabled.textContent = 'disabled';
          document.body.appendChild(disabled);
          const disabledCursor = getComputedStyle(disabled).cursor;
          const errCopy = document.createElement('button');
          errCopy.className = 'tool-err-copy';
          errCopy.textContent = 'copy';
          document.body.appendChild(errCopy);
          const errCopyOpacity = getComputedStyle(errCopy).opacity;
          disabled.remove();
          errCopy.remove();
          probe.remove();
          applyTheme(prev || 'light', false);
          return {
            minFocus: +minFocus.toFixed(2),
            minError: +minError.toFixed(2),
            badFocusRules: badFocusRules,
            disabledCursor: disabledCursor,
            errCopyOpacity: errCopyOpacity,
          };
        })()
      `);
      checks.a11yFocus = !!(r && r.minFocus >= 3 && r.badFocusRules === 0);
      checks.a11yError = !!(r && r.minError >= 4.5 && Number(r.errCopyOpacity) === 1);
      checks.a11yDisabled = !!(r && r.disabledCursor === 'not-allowed');
      if (!checks.a11yFocus || !checks.a11yError || !checks.a11yDisabled) log('a11y detail', JSON.stringify(r));
    } catch (e) {
      checks.a11yFocus = false;
      checks.a11yError = false;
      checks.a11yDisabled = false;
      log('a11y assertions failed', String((e && e.message) || e));
    }
    // R126：键盘导航与弹层语义——焦点陷阱、关闭恢复、菜单 role、列表选中态
    try {
      const r = await mainWindow.webContents.executeJavaScript(`
        (async function () {
          const opener = document.createElement('button');
          opener.textContent = 'opener';
          document.body.appendChild(opener);
          opener.focus();

          // 1) 通用焦点陷阱：末尾 Tab → 头部，头部 Shift+Tab → 末尾，关闭恢复 opener
          const mask = document.createElement('div');
          const dialog = document.createElement('div');
          dialog.innerHTML = '<button>one</button><button>two</button>';
          mask.appendChild(dialog);
          document.body.appendChild(mask);
          const release = installDialogFocusTrap(mask, dialog);
          const one = dialog.querySelectorAll('button')[0];
          const two = dialog.querySelectorAll('button')[1];
          two.focus();
          two.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
          const tabWrap = document.activeElement === one;
          one.focus();
          one.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }));
          const shiftWrap = document.activeElement === two;
          release();
          const utilityRestore = document.activeElement === opener;
          mask.remove();

          // 2) 真实文本弹窗：打开聚焦内部，关闭后恢复 opener
          opener.focus();
          showTextModal('焦点测试', '内容');
          const textDialog = document.querySelector('.text-modal-mask .text-modal');
          const openedInside = !!textDialog && textDialog.contains(document.activeElement);
          const closeBtn = textDialog && textDialog.querySelector('[data-close]');
          if (closeBtn) closeBtn.click();
          await new Promise((res) => setTimeout(res, 220));
          const textRestore = document.activeElement === opener;

          // 3) 菜单语义 + Esc 关闭/恢复焦点
          opener.focus();
          let picked = '';
          openMenu(opener, [{ label: '甲' }, { label: '乙' }], (it) => { picked = it.label; });
          const menu = document.querySelector('.pop-menu');
          const menuItems = menu ? menu.querySelectorAll('[role="menuitem"]') : [];
          const expanded = opener.getAttribute('aria-expanded');
          if (menu) menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          const menuClosed = !document.querySelector('.pop-menu');
          const menuRestore = document.activeElement === opener && opener.getAttribute('aria-expanded') === 'false';

          // 4) 列表当前项 aria-selected
          const list = document.createElement('div');
          list.setAttribute('role', 'listbox');
          const row = document.createElement('div');
          row.className = 'session-item active';
          list.appendChild(row);
          document.body.appendChild(list);
          wireListKeyboard(list, '.session-item');
          const selected = row.getAttribute('aria-selected');
          list.remove();

          // 5) 命令面板：打开聚焦查询框，关闭恢复 opener
          opener.focus();
          openPalette();
          const paletteInside = document.getElementById('paletteQuery') === document.activeElement;
          closePalette();
          const paletteRestore = document.activeElement === opener;

          opener.remove();
          return {
            tabWrap: tabWrap,
            shiftWrap: shiftWrap,
            utilityRestore: utilityRestore,
            openedInside: openedInside,
            textRestore: textRestore,
            menuRole: !!(menu && menu.getAttribute('role') === 'menu'),
            menuItems: menuItems.length,
            expanded: expanded,
            menuClosed: menuClosed,
            menuRestore: menuRestore,
            selected: selected,
            paletteInside: paletteInside,
            paletteRestore: paletteRestore,
          };
        })()
      `);
      checks.dialogFocusTrap = !!(r && r.tabWrap && r.shiftWrap && r.utilityRestore);
      checks.modalFocusRestore = !!(r && r.openedInside && r.textRestore);
      checks.menuSemantics = !!(r && r.menuRole && r.menuItems === 2 && r.expanded === 'true' && r.menuClosed && r.menuRestore);
      checks.listboxSelected = !!(r && r.selected === 'true');
      checks.paletteFocusRestore = !!(r && r.paletteInside && r.paletteRestore);
      if (!checks.dialogFocusTrap || !checks.modalFocusRestore || !checks.menuSemantics || !checks.listboxSelected || !checks.paletteFocusRestore) {
        log('focus detail', JSON.stringify(r));
      }
    } catch (e) {
      checks.dialogFocusTrap = false;
      checks.modalFocusRestore = false;
      checks.menuSemantics = false;
      checks.listboxSelected = false;
      checks.paletteFocusRestore = false;
      log('focus assertions failed', String((e && e.message) || e));
    }
    // R127：剩余交互控件语义——工具卡键盘展开、Toast 角色、附件移除按钮标签
    try {
      const r = await mainWindow.webContents.executeJavaScript(`
        (function () {
          const host = document.createElement('div');
          document.body.appendChild(host);
          const tool = toolElement({ id: 'a11y-tool', name: 'read_file', state: 'done', input: { file_path: 'x' }, output: 'ok' });
          host.appendChild(tool);
          const head = tool.querySelector('.tool-head');
          const role = head.getAttribute('role');
          const tabIndex = head.tabIndex;
          const controls = head.getAttribute('aria-controls');
          const bodyId = tool.querySelector('.tool-body').id;
          head.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
          const enterOpen = tool.classList.contains('open') && head.getAttribute('aria-expanded') === 'true';
          head.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
          const spaceClosed = !tool.classList.contains('open') && head.getAttribute('aria-expanded') === 'false';
          const errTool = toolElement({ id: 'a11y-err', name: 'bash', state: 'error', input: {}, output: 'boom' });
          host.appendChild(errTool);
          const errHead = errTool.querySelector('.tool-head');
          const errCopy = errTool.querySelector('[data-tool-err-copy]');
          const copySeparate = !!errCopy && !errHead.contains(errCopy) && errCopy.getAttribute('type') === 'button' && !!errCopy.getAttribute('aria-label');
          host.remove();

          toast('普通提示', '不需要交互');
          const plain = document.querySelector('#toasts .toast:last-child');
          const plainRole = plain.getAttribute('role');
          const plainTab = plain.tabIndex;
          plain.click();
          let clicked = 0;
          toast('可操作提示', '按回车', () => { clicked++; });
          const action = document.querySelector('#toasts .toast:last-child');
          const actionRole = action.getAttribute('role');
          const actionTab = action.tabIndex;
          const actionLabel = action.getAttribute('aria-label') || '';
          action.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

          const s = state.current;
          const prevAtt = s ? state.attachments.get(s.id) : null;
          if (s) {
            state.attachments.set(s.id, [{ name: '截图.png', path: 'x', thumb: '' }]);
            renderComposerAttachments();
          }
          const removeBtn = document.querySelector('#attachRow [data-attach-remove]');
          const removeLabel = removeBtn ? removeBtn.getAttribute('aria-label') || '' : '';
          const removeType = removeBtn ? removeBtn.getAttribute('type') : '';
          if (s) {
            if (prevAtt) state.attachments.set(s.id, prevAtt);
            else state.attachments.delete(s.id);
            renderComposerAttachments();
          }
          return {
            role: role, tabIndex: tabIndex, controls: controls, bodyId: bodyId,
            enterOpen: enterOpen, spaceClosed: spaceClosed, copySeparate: copySeparate,
            plainRole: plainRole, plainTab: plainTab,
            actionRole: actionRole, actionTab: actionTab, actionLabel: actionLabel,
            removeLabel: removeLabel, removeType: removeType,
          };
        })()
      `);
      checks.toolKeyboard = !!(r && r.role === 'button' && r.tabIndex === 0 && r.controls === r.bodyId && r.enterOpen && r.spaceClosed && r.copySeparate);
      checks.toastSemantics = !!(r && r.plainRole === 'status' && r.plainTab === -1 && r.actionRole === 'button' && r.actionTab === 0 && r.actionLabel.indexOf('可操作提示') >= 0);
      checks.attachButtonSemantics = !!(r && r.removeType === 'button' && r.removeLabel.indexOf('截图.png') >= 0);
      if (!checks.toolKeyboard || !checks.toastSemantics || !checks.attachButtonSemantics) log('control semantics detail', JSON.stringify(r));
    } catch (e) {
      checks.toolKeyboard = false;
      checks.toastSemantics = false;
      checks.attachButtonSemantics = false;
      log('control semantics assertions failed', String((e && e.message) || e));
    }
    // R128：动态重渲染焦点保持——侧栏/项目列表/线程工具与消息操作
    try {
      const r = await mainWindow.webContents.executeJavaScript(`
        (function () {
          const list = document.getElementById('sessionList');
          const row = list.querySelector('.session-item[data-focus-key]');
          let sidebarOk = false;
          if (row) {
            row.focus();
            const key = row.getAttribute('data-focus-key');
            renderSidebar();
            const again = [...list.querySelectorAll('.session-item[data-focus-key]')].find((x) => x.getAttribute('data-focus-key') === key);
            sidebarOk = !!again && document.activeElement === again;
          }
          const pl = document.getElementById('projectList');
          const project = pl.querySelector('.project-item[data-focus-key]');
          let projectOk = false;
          if (project) {
            project.focus();
            const key = project.getAttribute('data-focus-key');
            renderSidebar();
            const again = [...pl.querySelectorAll('.project-item[data-focus-key]')].find((x) => x.getAttribute('data-focus-key') === key);
            projectOk = !!again && document.activeElement === again;
          }

          const keepSessions = state.sessions;
          const keepCurrent = state.current;
          const fake = {
            id: 's_focus_keep', title: 'focus keep', cwd: state.defaultCwd, createdAt: 1, updatedAt: 1,
            messages: [{ role: 'assistant', text: 'hello', ts: 1, blocks: [
              { type: 'text', text: 'hello' },
              { type: 'tool', id: 'focus-tool', name: 'read_file', state: 'done', input: {}, output: 'ok' },
            ] }],
          };
          let toolOk = false;
          let actionOk = false;
          try {
            state.sessions = keepSessions.concat([fake]);
            state.current = fake;
            renderThread();
            const head = document.querySelector('#thread .tool-head');
            head.focus();
            const toolKey = head.getAttribute('data-focus-key');
            renderThread();
            const head2 = [...document.querySelectorAll('#thread [data-focus-key]')].find((x) => x.getAttribute('data-focus-key') === toolKey);
            toolOk = !!head2 && document.activeElement === head2;
            const copy = document.querySelector('#thread .msg [data-copy]');
            copy.focus();
            const copyKey = copy.getAttribute('data-focus-key');
            renderThread();
            const copy2 = [...document.querySelectorAll('#thread [data-focus-key]')].find((x) => x.getAttribute('data-focus-key') === copyKey);
            actionOk = !!copy2 && document.activeElement === copy2;
          } finally {
            state.sessions = keepSessions;
            state.current = keepCurrent;
            state.runtimes.delete(fake.id);
            state.renderLimit.delete(fake.id);
            state.renderFloor.delete(fake.id);
            renderThread();
          }
          return { sidebarOk: sidebarOk, projectOk: projectOk, toolOk: toolOk, actionOk: actionOk };
        })()
      `);
      checks.sidebarFocusKeep = !!(r && r.sidebarOk);
      checks.projectFocusKeep = !!(r && r.projectOk);
      checks.threadFocusKeep = !!(r && r.toolOk && r.actionOk);
      if (!checks.sidebarFocusKeep || !checks.projectFocusKeep || !checks.threadFocusKeep) log('focus keep detail', JSON.stringify(r));
    } catch (e) {
      checks.sidebarFocusKeep = false;
      checks.projectFocusKeep = false;
      checks.threadFocusKeep = false;
      log('focus keep assertions failed', String((e && e.message) || e));
    }
    // R129：设置页焦点保持、命令面板 combobox 语义、输入法组合期渲染安全
    try {
      const r = await mainWindow.webContents.executeJavaScript(`
        (async function () {
          await openSettings();
          const sel = document.getElementById('gModel');
          sel.focus();
          const key = sel.getAttribute('data-focus-key');
          renderCfgSection();
          const sel2 = [...document.querySelectorAll('#cfgBody [data-focus-key]')].find((x) => x.getAttribute('data-focus-key') === key);
          const settingsOk = !!sel2 && document.activeElement === sel2;
          await closeSettings();

          openPalette();
          const query = document.getElementById('paletteQuery');
          const list = document.getElementById('paletteList');
          const option = list.querySelector('[role="option"]');
          const activeId = query.getAttribute('aria-activedescendant');
          renderPalette();
          const paletteOk =
            document.activeElement === query &&
            query.getAttribute('role') === 'combobox' &&
            list.getAttribute('role') === 'listbox' &&
            !!option && option.getAttribute('aria-selected') === 'true' &&
            activeId === option.id;
          closePalette();

          const input = document.getElementById('input');
          const prev = input.value;
          input.value = '组合文本测试';
          input.focus();
          input.setSelectionRange(2, 2);
          input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
          renderComposer();
          renderThread();
          renderSidebar();
          const imeOk =
            document.activeElement === input &&
            input.value === '组合文本测试' &&
            input.selectionStart === 2 &&
            input.selectionEnd === 2;
          input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
          input.value = prev;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          return { settingsOk: settingsOk, paletteOk: paletteOk, imeOk: imeOk };
        })()
      `);
      checks.settingsFocusKeep = !!(r && r.settingsOk);
      checks.paletteCombobox = !!(r && r.paletteOk);
      checks.imeCompositionSafe = !!(r && r.imeOk);
      if (!checks.settingsFocusKeep || !checks.paletteCombobox || !checks.imeCompositionSafe) log('settings/ime detail', JSON.stringify(r));
    } catch (e) {
      checks.settingsFocusKeep = false;
      checks.paletteCombobox = false;
      checks.imeCompositionSafe = false;
      log('settings/ime assertions failed', String((e && e.message) || e));
    }
    // R130：快捷键边界——模态弹窗 Esc 不误停回合，Ctrl+N/Ctrl+Tab 不穿透
    try {
      const r = await mainWindow.webContents.executeJavaScript(`
        (async function () {
          const s = state.current;
          const prevBusy = s ? rt(s.id).busy : false;
          const prevStop = stopTurn;
          const prevNew = document.getElementById('btnNew').onclick;
          const prevCycle = cycleSession;
          let stopCalls = 0;
          let newCalls = 0;
          let cycleCalls = 0;
          try {
            if (s) rt(s.id).busy = true;
            stopTurn = () => { stopCalls++; };
            document.getElementById('btnNew').onclick = () => { newCalls++; };
            cycleSession = () => { cycleCalls++; };

            showTextModal('快捷键边界', '内容');
            const dialog = document.querySelector('.text-modal-mask .text-modal');
            dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', ctrlKey: true, bubbles: true }));
            await new Promise((res) => setTimeout(res, 220));
            const modalEscOk = stopCalls === 0;
            const modalShortcutOk = newCalls === 0;

            openPalette();
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', ctrlKey: true, bubbles: true }));
            const paletteShortcutOk = cycleCalls === 0;
            closePalette();
            return { modalEscOk: modalEscOk, modalShortcutOk: modalShortcutOk, paletteShortcutOk: paletteShortcutOk };
          } finally {
            stopTurn = prevStop;
            cycleSession = prevCycle;
            document.getElementById('btnNew').onclick = prevNew;
            if (s) rt(s.id).busy = prevBusy;
          }
        })()
      `);
      checks.modalEscNoStop = !!(r && r.modalEscOk);
      checks.modalShortcutBlocked = !!(r && r.modalShortcutOk);
      checks.paletteShortcutBlocked = !!(r && r.paletteShortcutOk);
      if (!checks.modalEscNoStop || !checks.modalShortcutBlocked || !checks.paletteShortcutBlocked) log('shortcut boundary detail', JSON.stringify(r));
    } catch (e) {
      checks.modalEscNoStop = false;
      checks.modalShortcutBlocked = false;
      checks.paletteShortcutBlocked = false;
      log('shortcut boundary assertions failed', String((e && e.message) || e));
    }
    // R131：快捷键占用、三击、拖拽弹层边界、修饰键 Enter
    try {
      const r = await mainWindow.webContents.executeJavaScript(`
        (function () {
          const reservedOk =
            isReservedBinding('ctrl+f') && isReservedBinding('ctrl+shift+tab') &&
            isReservedBinding('ctrl++') && isReservedBinding('shift+enter') &&
            !isReservedBinding('ctrl+n') && !isReservedBinding('ctrl+enter');
          const dup = findBindingConflict({ newSession: 'ctrl+n', palette: 'ctrl+k' }, 'newSession', 'ctrl+k');

          const project = document.querySelector('#projectList .project-item[data-focus-key]');
          clearTimeout(projectClickTimer);
          projectClickTimer = null;
          if (project) project.onclick({ detail: 3 });
          const tripleOk = projectClickTimer === null;
          clearTimeout(projectClickTimer);
          projectClickTimer = null;

          const prevDrop = handleDrop;
          let dropCalls = 0;
          let modalDropOk = false;
          try {
            handleDrop = () => { dropCalls++; return Promise.resolve(); };
            showTextModal('拖拽边界', '内容');
            const dt = new DataTransfer();
            dt.items.add(new File(['x'], 'x.txt', { type: 'text/plain' }));
            const de = new Event('drop', { bubbles: true, cancelable: true });
            Object.defineProperty(de, 'dataTransfer', { value: dt });
            window.dispatchEvent(de);
            modalDropOk = dropCalls === 0 && !document.body.classList.contains('dragging');
            const close = document.querySelector('.text-modal-mask [data-close]');
            if (close) close.click();
          } finally {
            handleDrop = prevDrop;
          }

          document.body.classList.add('dragging');
          window.dispatchEvent(new Event('dragend'));
          const dragEndOk = !document.body.classList.contains('dragging');

          const input = document.getElementById('input');
          const prev = input.value;
          const prevSend = send;
          let sendCalls = 0;
          try {
            input.value = 'x';
            send = () => { sendCalls++; };
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
          } finally {
            send = prevSend;
            input.value = prev;
          }
          return {
            reservedOk: reservedOk, dup: dup, projectFound: !!project, tripleOk: tripleOk,
            modalDropOk: modalDropOk, dragEndOk: dragEndOk, sendCalls: sendCalls,
          };
        })()
      `);
      checks.reservedShortcuts = !!(r && r.reservedOk && r.dup === 'palette');
      checks.tripleClickGuard = !!(r && r.projectFound && r.tripleOk);
      checks.modalDropBlocked = !!(r && r.modalDropOk && r.dragEndOk);
      checks.modifiedEnterGuard = !!(r && r.sendCalls === 0);
      if (!checks.reservedShortcuts || !checks.tripleClickGuard || !checks.modalDropBlocked || !checks.modifiedEnterGuard) log('interaction boundary detail', JSON.stringify(r));
    } catch (e) {
      checks.reservedShortcuts = false;
      checks.tripleClickGuard = false;
      checks.modalDropBlocked = false;
      checks.modifiedEnterGuard = false;
      log('interaction boundary assertions failed', String((e && e.message) || e));
    }
    // R132：快速连续操作——附件处理中禁发、切会话附件隔离、双击/长按防重
    try {
      const r = await mainWindow.webContents.executeJavaScript(`
        (async function () {
          const s = state.current;
          const input = document.getElementById('input');
          const prevInput = input.value;
          const prevJobs = attachmentJobs;
          const prevCount = s ? s.messages.length : 0;
          let sendBlocked = false;
          try {
            input.value = '快速发送测试';
            attachmentJobs = 1;
            await send();
            sendBlocked = s ? s.messages.length === prevCount : true;
          } finally {
            attachmentJobs = prevJobs;
            input.value = prevInput;
            renderSendButton();
          }

          const btnNew = document.getElementById('btnNew');
          const prevNewFn = newSessionOrFocus;
          let newCalls = 0;
          let doubleNewBlocked = false;
          let singleNewOk = false;
          let repeatBlocked = false;
          newSessionOrFocus = () => { newCalls++; };
          try {
            btnNew.dispatchEvent(new MouseEvent('click', { detail: 2, bubbles: true }));
            doubleNewBlocked = newCalls === 0;
            btnNew.dispatchEvent(new MouseEvent('click', { detail: 1, bubbles: true }));
            singleNewOk = newCalls === 1;
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', ctrlKey: true, repeat: true, bubbles: true }));
            repeatBlocked = newCalls === 1;
          } finally {
            newSessionOrFocus = prevNewFn;
          }

          const keepSessions = state.sessions;
          const keepCurrent = state.current;
          const keepInput = input.value;
          const a = { id: 's_attach_a', title: 'A', cwd: state.defaultCwd, createdAt: 1, updatedAt: 1, messages: [] };
          const b = { id: 's_attach_b', title: 'B', cwd: state.defaultCwd, createdAt: 1, updatedAt: 1, messages: [] };
          let isolationOk = false;
          let savedPath = '';
          try {
            state.sessions = keepSessions.concat([a, b]);
            state.current = a;
            input.value = '等待附件';
            const bin = atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==');
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            const file = new File([bytes], 'tiny.png', { type: 'image/png' });
            const pending = addImageFiles([file]);
            const busyDuring = attachmentJobs === 1 && document.getElementById('btnSend').disabled;
            state.current = b;
            await pending;
            const aa = state.attachments.get(a.id) || [];
            const bb = state.attachments.get(b.id) || [];
            isolationOk = busyDuring && aa.length === 1 && bb.length === 0 && attachmentJobs === 0;
            savedPath = aa[0] ? aa[0].path : '';
          } finally {
            state.sessions = keepSessions;
            state.current = keepCurrent;
            input.value = keepInput;
            state.attachments.delete(a.id);
            state.attachments.delete(b.id);
            renderComposerAttachments();
            renderComposer();
          }
          return {
            sendBlocked: sendBlocked, doubleNewBlocked: doubleNewBlocked,
            singleNewOk: singleNewOk, repeatBlocked: repeatBlocked,
            isolationOk: isolationOk, savedPath: savedPath, newCalls: newCalls,
            btnNewDisabled: btnNew.disabled,
          };
        })()
      `);
      checks.attachmentSendGuard = !!(r && r.sendBlocked);
      checks.doubleClickGuard = !!(r && r.doubleNewBlocked && r.singleNewOk);
      checks.repeatShortcutGuard = !!(r && r.repeatBlocked);
      checks.attachmentSessionIsolation = !!(r && r.isolationOk);
      if (r && r.savedPath) {
        try {
          fs.rmSync(r.savedPath, { force: true });
        } catch {
          /* ignore */
        }
      }
      if (!checks.attachmentSendGuard || !checks.doubleClickGuard || !checks.repeatShortcutGuard || !checks.attachmentSessionIsolation) log('rapid action detail', JSON.stringify(r));
    } catch (e) {
      checks.attachmentSendGuard = false;
      checks.doubleClickGuard = false;
      checks.repeatShortcutGuard = false;
      checks.attachmentSessionIsolation = false;
      log('rapid action assertions failed', String((e && e.message) || e));
    }
    // R133：过期异步结果——用量范围竞争、拖放会话归属
    try {
      const r = await mainWindow.webContents.executeJavaScript(`
        (function () {
          const prevSeq = usageRequestSeq;
          const prevRange = state.usageRange;
          const prevStored = localStorage.getItem('ui.usageRange');
          const prevUsage = state.extras ? state.extras.usage : undefined;
          const seq1 = ++usageRequestSeq;
          const seq2 = ++usageRequestSeq;
          const stale = commitUsageResult(seq1, 'today', { tag: 'old' });
          const fresh = commitUsageResult(seq2, '7d', { tag: 'new' });
          const usageOk = !stale && fresh && state.usageRange === '7d' && state.extras.usage.tag === 'new';
          usageRequestSeq = prevSeq;
          state.usageRange = prevRange;
          if (prevStored == null) localStorage.removeItem('ui.usageRange');
          else localStorage.setItem('ui.usageRange', prevStored);
          if (state.extras) state.extras.usage = prevUsage;

          const keepSessions = state.sessions;
          const keepCurrent = state.current;
          const a = { id: 's_drop_a', title: 'A', cwd: 'A', createdAt: 1, updatedAt: 1, messages: [] };
          const b = { id: 's_drop_b', title: 'B', cwd: 'B', createdAt: 1, updatedAt: 1, messages: [] };
          let dropOk = false;
          try {
            state.sessions = keepSessions.concat([a, b]);
            state.current = a;
            const before = isActiveSession(a.id);
            state.current = b;
            const after = isActiveSession(a.id);
            const currentB = isActiveSession(b.id);
            dropOk = before && !after && currentB;
          } finally {
            state.sessions = keepSessions;
            state.current = keepCurrent;
          }
          return { usageOk: usageOk, dropOk: dropOk };
        })()
      `);
      checks.usageStaleResultGuard = !!(r && r.usageOk);
      checks.dropSessionGuard = !!(r && r.dropOk);
      if (!checks.usageStaleResultGuard || !checks.dropSessionGuard) log('async guard detail', JSON.stringify(r));
    } catch (e) {
      checks.usageStaleResultGuard = false;
      checks.dropSessionGuard = false;
      log('async guard assertions failed', String((e && e.message) || e));
    }
    // R134：删除墓碑——删除后迟到保存不得复活；显式恢复后允许再次保存
    try {
      const id = 's_tombstone_test';
      const fake = { id, title: 'tombstone', cwd: '.', messages: [], createdAt: 1, updatedAt: 1 };
      saveSession(fake);
      flushSessionSave(id);
      const before = fs.existsSync(sessionFile(id));
      const deleted = deleteSessionFile(id);
      const late = await mainWindow.webContents.executeJavaScript(
        'window.shell.sessions.save(' + JSON.stringify(fake) + ')'
      );
      flushSessionSave(id);
      const afterLate = fs.existsSync(sessionFile(id));
      allowRestoredSession(id);
      const restored = await mainWindow.webContents.executeJavaScript(
        'window.shell.sessions.save(' + JSON.stringify(fake) + ')'
      );
      flushSessionSave(id);
      const afterRestore = fs.existsSync(sessionFile(id));
      checks.deletedSessionSaveGuard = !!(
        before && deleted && late && late.ok === false && !afterLate && restored === true && afterRestore
      );
      deleteSessionFile(id);
      try {
        for (const f of fs.readdirSync(TRASH_DIR)) {
          if (f.endsWith('-' + id + '.json')) fs.rmSync(path.join(TRASH_DIR, f), { force: true });
        }
      } catch {
        /* ignore */
      }
    } catch (e) {
      checks.deletedSessionSaveGuard = false;
      log('deleted session guard assertion failed', String((e && e.message) || e));
    }
    // R135：删除失败不得顺带丢掉待写保存；失败状态在删除成功后清理
    try {
      const id = 's_delete_fail_test';
      const file = sessionFile(id);
      const fake = { id, title: 'delete fail', cwd: '.', messages: [], createdAt: 1, updatedAt: 1 };
      saveSession(fake);
      flushSessionSave(id);
      fake.updatedAt = 2;
      saveSession(fake);
      const origRename = fs.renameSync;
      const origCopy = fs.copyFileSync;
      const origUnlink = fs.unlinkSync;
      const blocked = () => {
        const err = new Error('EPERM smoke-injected');
        err.code = 'EPERM';
        throw err;
      };
      fs.renameSync = (a, b) => (String(a) === file ? blocked() : origRename(a, b));
      fs.copyFileSync = (a, b) => (String(a) === file ? blocked() : origCopy(a, b));
      fs.unlinkSync = (a) => (String(a) === file ? blocked() : origUnlink(a));
      let res = null;
      try {
        res = await mainWindow.webContents.executeJavaScript(
          'window.shell.sessions.remove(' + JSON.stringify(id) + ')'
        );
      } finally {
        fs.renameSync = origRename;
        fs.copyFileSync = origCopy;
        fs.unlinkSync = origUnlink;
      }
      const kept = pendingSessionSaves.has(id);
      saveFailedSessions.add(id);
      dropSessionSave(id);
      const failureCleared = !saveFailedSessions.has(id);
      checks.deleteFailureKeepsSave = !!(res && res.ok === false && kept && failureCleared);
      deleteSessionFile(id);
      try {
        for (const f of fs.readdirSync(TRASH_DIR)) {
          if (f.endsWith('-' + id + '.json')) fs.rmSync(path.join(TRASH_DIR, f), { force: true });
        }
      } catch {
        /* ignore */
      }
    } catch (e) {
      checks.deleteFailureKeepsSave = false;
      log('delete failure guard assertion failed', String((e && e.message) || e));
    }
    // R136：退出清理必须 intentional 停止内核，避免崩溃自愈在退出时重启
    try {
      const fakeId = 'quit-probe';
      let intentional = null;
      agents.set(fakeId, { stop: (v) => { intentional = v; } });
      stopAllAgentsForQuit();
      checks.quitStopsIntentional = intentional === true && !agents.has(fakeId);
    } catch (e) {
      checks.quitStopsIntentional = false;
      log('quit cleanup assertion failed', String((e && e.message) || e));
    }
    // R137：关闭到托盘应立即刷掉已收到的待写保存，不依赖 200ms 防抖
    try {
      const id = 's_background_flush';
      const fake = { id, title: 'background flush', cwd: '.', messages: [], createdAt: 1, updatedAt: 1 };
      saveSession(fake);
      const pendingBefore = pendingSessionSaves.has(id);
      flushSessionSavesForBackground();
      checks.backgroundCloseFlushes = pendingBefore && !pendingSessionSaves.has(id) && fs.existsSync(sessionFile(id));
      deleteSessionFile(id);
      try {
        for (const f of fs.readdirSync(TRASH_DIR)) {
          if (f.endsWith('-' + id + '.json')) fs.rmSync(path.join(TRASH_DIR, f), { force: true });
        }
      } catch {
        /* ignore */
      }
    } catch (e) {
      checks.backgroundCloseFlushes = false;
      log('background flush assertion failed', String((e && e.message) || e));
    }
    // R138：内核 dispose 必须清定时器、缓冲、待发消息与授权状态
    try {
      const a = new AgentProcess({ sessionId: 'dispose-probe', cwd: '.' });
      a.effortTimer = setTimeout(() => {}, 10000);
      a.killTimer = setTimeout(() => {}, 10000);
      a.turnTimer = setTimeout(() => {}, 10000);
      a.autoRestartTimer = setTimeout(() => {}, 10000);
      a.pendingApproval = { requestId: 'p', timer: setTimeout(() => {}, 10000) };
      a.pendingPrompt = 'large pending';
      a.inFlightPrompt = 'large inflight';
      a.buffer = 'large buffer';
      a.stderr = 'large stderr';
      a.crashTimes = [1];
      a.dispose();
      checks.agentDisposeClears =
        a.effortTimer == null &&
        a.killTimer == null &&
        a.turnTimer == null &&
        a.autoRestartTimer == null &&
        a.pendingApproval == null &&
        a.pendingPrompt == null &&
        a.inFlightPrompt == null &&
        a.buffer === '' &&
        a.stderr === '' &&
        a.crashTimes.length === 0;
    } catch (e) {
      checks.agentDisposeClears = false;
      log('agent dispose assertion failed', String((e && e.message) || e));
    }
    // R139：旧窗口延迟回调不得作用到新窗口
    try {
      const prevMain = mainWindow;
      const prevCreate = createWindow;
      const sent = [];
      let late = null;
      const oldWin = {
        isDestroyed: () => false,
        webContents: {
          once: (_ev, cb) => { late = cb; },
          send: (channel, payload) => sent.push({ channel: channel, payload: payload }),
        },
      };
      const newWin = {
        isDestroyed: () => false,
        webContents: { send: (channel, payload) => sent.push({ channel: channel, payload: payload }) },
      };
      try {
        mainWindow = null;
        createWindow = () => { mainWindow = oldWin; };
        sendMenuAction('new');
        mainWindow = newWin;
        if (late) late();
        checks.windowCallbackScoped = sent.length === 0;
      } finally {
        createWindow = prevCreate;
        mainWindow = prevMain;
      }
    } catch (e) {
      checks.windowCallbackScoped = false;
      log('window callback assertion failed', String((e && e.message) || e));
    }
    // R140：窗口加载前事件排队，did-finish-load 后按序补发；旧窗口不得刷新新窗口队列
    try {
      const prevMain = mainWindow;
      const prevReady = mainWindowReady;
      const prevPending = pendingRendererEvents;
      const sent = [];
      const fake = {
        isDestroyed: () => false,
        webContents: { send: (channel, payload) => sent.push({ channel: channel, payload: payload }) },
      };
      try {
        mainWindow = fake;
        mainWindowReady = false;
        pendingRendererEvents = [];
        sendRendererEvent('agent:event', { n: 1 });
        sendRendererEvent('agent:approval', { n: 2 });
        const queuedOnly = sent.length === 0 && pendingRendererEvents.length === 2;
        flushRendererEvents(fake);
        const flushed = sent.length === 2 && sent[0].payload.n === 1 && sent[1].payload.n === 2 && mainWindowReady;
        checks.rendererEventQueue = queuedOnly && flushed;
      } finally {
        mainWindow = prevMain;
        mainWindowReady = prevReady;
        pendingRendererEvents = prevPending;
      }
    } catch (e) {
      checks.rendererEventQueue = false;
      log('renderer event queue assertion failed', String((e && e.message) || e));
    }
    // R141：队列溢出优先保留关键事件；首屏就绪握手必须已执行
    try {
      const prevMain = mainWindow;
      const prevReady = mainWindowReady;
      const prevPending = pendingRendererEvents;
      const fake = { isDestroyed: () => false, webContents: { send: () => {} } };
      try {
        mainWindow = fake;
        mainWindowReady = false;
        pendingRendererEvents = [];
        for (let i = 0; i < 500; i++) sendRendererEvent('agent:event', { n: i });
        sendRendererEvent('agent:approval', { critical: true });
        checks.rendererQueuePriority =
          pendingRendererEvents.length === 500 &&
          pendingRendererEvents.some((e) => e.channel === 'agent:approval') &&
          !pendingRendererEvents.some((e) => e.channel === 'agent:event' && e.payload.n === 0);
      } finally {
        mainWindow = prevMain;
        mainWindowReady = prevReady;
        pendingRendererEvents = prevPending;
      }
      checks.rendererReadyHandshake = !!mainWindowReady;
    } catch (e) {
      checks.rendererQueuePriority = false;
      checks.rendererReadyHandshake = false;
      log('renderer ready assertion failed', String((e && e.message) || e));
    }
    // R142：损坏会话记录不得污染列表/排序；prefs 补丁类型必须正确
    try {
      const id = 's_corrupt_probe';
      fs.writeFileSync(sessionFile(id), 'null', 'utf8');
      updateSessionIndex({ id, title: 'corrupt', messages: [], createdAt: 1, updatedAt: 1 });
      const got = await mainWindow.webContents.executeJavaScript(
        'window.shell.sessions.get(' + JSON.stringify(id) + ')'
      );
      const listed = await mainWindow.webContents.executeJavaScript('window.shell.sessions.list()');
      const row = Array.isArray(listed) ? listed.find((x) => x && x.id === id) : null;
      checks.corruptSessionSafe = !!(got && got.ok === false && row && row.lazy === true);
      const badPrefs = await mainWindow.webContents.executeJavaScript("window.shell.prefs.save('bad')");
      checks.prefsTypeGuard = !!(badPrefs && badPrefs.ok === false);
      removeSessionIndex(id);
      flushSessionIndex();
      fs.rmSync(sessionFile(id), { force: true });
    } catch (e) {
      checks.corruptSessionSafe = false;
      checks.prefsTypeGuard = false;
      log('ipc payload guard assertion failed', String((e && e.message) || e));
    }
    // R143：工作区 junction 不得列出外部目录；文件预览严格限制 512KB
    try {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qcode-fs-guard-'));
      const root = path.join(tmp, 'root');
      const outside = path.join(tmp, 'outside');
      fs.mkdirSync(root);
      fs.mkdirSync(outside);
      fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret', 'utf8');
      fs.symlinkSync(outside, path.join(root, 'escape'), 'junction');
      const listed = await mainWindow.webContents.executeJavaScript(
        'window.shell.listDir(' + JSON.stringify(root) + ", 'escape')"
      );
      checks.fsListSymlinkGuard = !!(listed && listed.ok === false);
      const big = path.join(root, 'big.txt');
      fs.writeFileSync(big, Buffer.alloc(512 * 1024 + 1, 65));
      const read = await mainWindow.webContents.executeJavaScript(
        'window.shell.readFile(' + JSON.stringify(root) + ", 'big.txt')"
      );
      checks.fsReadBounded = !!(read && read.ok === false && /512KB/.test(read.error || ''));
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch (e) {
      checks.fsListSymlinkGuard = false;
      checks.fsReadBounded = false;
      log('filesystem guard assertion failed', String((e && e.message) || e));
    }
    // R144：Git 未跟踪回退不得借 junction 读外部文件；diff 输出有界
    try {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qcode-git-guard-'));
      const repo = path.join(tmp, 'repo');
      const outside = path.join(tmp, 'outside');
      fs.mkdirSync(repo);
      fs.mkdirSync(outside);
      fs.writeFileSync(path.join(outside, 'secret.txt'), 'TOP-SECRET-GIT', 'utf8');
      await runGit(repo, ['init', '-q']);
      fs.symlinkSync(outside, path.join(repo, 'escape'), 'junction');
      const diff = await mainWindow.webContents.executeJavaScript(
        'window.shell.gitDiff(' + JSON.stringify(repo) + ", 'escape/secret.txt')"
      );
      const traversal = await mainWindow.webContents.executeJavaScript(
        'window.shell.gitDiff(' + JSON.stringify(repo) + ", '../outside/secret.txt')"
      );
      const capped = capGitDiff('x'.repeat(GIT_DIFF_MAX + 100));
      checks.gitDiffSymlinkGuard = !!(diff && diff.ok === true && !String(diff.diff).includes('TOP-SECRET-GIT'));
      checks.gitPathGuard = !!(traversal && traversal.ok === false);
      checks.gitDiffBounded = capped.truncated && capped.diff.length > GIT_DIFF_MAX && capped.diff.length < GIT_DIFF_MAX + 100;
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch (e) {
      checks.gitDiffSymlinkGuard = false;
      checks.gitPathGuard = false;
      checks.gitDiffBounded = false;
      log('git guard assertion failed', String((e && e.message) || e));
    }
    // R145：导出 payload 上限与 PDF 主进程互斥
    try {
      const tooBig = exportPayloadError('x'.repeat(EXPORT_HTML_MAX + 1), EXPORT_HTML_MAX, 'HTML');
      const prevActive = pdfExportActive;
      let busy = null;
      try {
        pdfExportActive = true;
        busy = await htmlToPdfBuffer('<p>x</p>');
      } finally {
        pdfExportActive = prevActive;
      }
      checks.exportPayloadLimit = !!tooBig && !exportPayloadError('<p>x</p>', EXPORT_HTML_MAX, 'HTML');
      checks.pdfConcurrencyGuard = !!(busy && busy.ok === false && /正在/.test(busy.error || ''));
    } catch (e) {
      checks.exportPayloadLimit = false;
      checks.pdfConcurrencyGuard = false;
      log('export guard assertion failed', String((e && e.message) || e));
    }
    // R146：畸形 Markdown 与大量括号 URL 必须线性完成
    try {
      const r = await mainWindow.webContents.executeJavaScript(`
        (function () {
          const t0 = performance.now();
          const malformed = renderMarkdown('['.repeat(50000), true);
          const malformedMs = performance.now() - t0;
          const n = 5000;
          const t1 = performance.now();
          const linked = renderMarkdown('[x](https://e.test/a' + ')'.repeat(n), true);
          const linkMs = performance.now() - t1;
          return {
            malformedMs: malformedMs,
            linkMs: linkMs,
            malformedOk: malformed.includes('['.repeat(50000)),
            linkOk: linked.includes('href="https://e.test/a"') && linked.endsWith(')'.repeat(n - 1) + '</p>'),
          };
        })()
      `);
      checks.mdMalformedSafe = !!(r && r.malformedOk && r.malformedMs < 250);
      checks.mdUrlBalanced = !!(r && r.linkOk && r.linkMs < 250);
      if (!checks.mdMalformedSafe || !checks.mdUrlBalanced) log('markdown boundary detail', JSON.stringify(r));
    } catch (e) {
      checks.mdMalformedSafe = false;
      checks.mdUrlBalanced = false;
      log('markdown boundary assertions failed', String((e && e.message) || e));
    }
    // R147：索引构建期间变更必须重跑；查询/缓存有明确内存预算
    try {
      const r = await mainWindow.webContents.executeJavaScript(`
        (function () {
          const prevBuilding = state.fullTextBuilding;
          const prevPending = state.fullTextIndexPending;
          state.fullTextBuilding = true;
          state.fullTextIndexPending = false;
          invalidateFullTextIndex('s_index_pending_probe');
          const pendingOk = state.fullTextIndexPending === true;
          state.fullTextBuilding = prevBuilding;
          state.fullTextIndexPending = prevPending;

          const longQuery = queryFullTextIndex(new Map(), 'x'.repeat(FULLTEXT_QUERY_MAX + 1));
          const queryOk = longQuery === null;

          const prevIndex = state.searchIndex;
          const prevChars = state.searchIndexChars;
          const text = 'x'.repeat(1024 * 1024);
          state.searchIndex = new Map();
          state.searchIndexChars = 0;
          for (let i = 0; i < 20; i++) state.searchIndex.set('p' + i, { key: 'k', text: text });
          state.searchIndexChars = 20 * 1024 * 1024;
          evictSessionSearchCache();
          const cacheOk = state.searchIndexChars <= SEARCH_INDEX_CHARS_MAX && state.searchIndex.size <= 500;
          state.searchIndex = prevIndex;
          state.searchIndexChars = prevChars;
          return { pendingOk: pendingOk, queryOk: queryOk, cacheOk: cacheOk };
        })()
      `);
      checks.fullTextRebuildPending = !!(r && r.pendingOk);
      checks.fullTextQueryGuard = !!(r && r.queryOk);
      checks.searchCacheBounded = !!(r && r.cacheOk);
      if (!checks.fullTextRebuildPending || !checks.fullTextQueryGuard || !checks.searchCacheBounded) log('search index detail', JSON.stringify(r));
    } catch (e) {
      checks.fullTextRebuildPending = false;
      checks.fullTextQueryGuard = false;
      checks.searchCacheBounded = false;
      log('search index assertions failed', String((e && e.message) || e));
    }
    // R148：懒加载骨架期间不得覆盖旧会话滚动位置，也不得被后台渲染替换
    try {
      const r = await mainWindow.webContents.executeJavaScript(`
        (function () {
          const cur = state.current;
          const prevLoading = state.threadLoading;
          const prevScroll = cur ? state.scroll[cur.id] : undefined;
          const t = document.getElementById('thread');
          const prevHtml = t.innerHTML;
          let ok = false;
          try {
            if (!cur) return { ok: false };
            state.threadLoading = true;
            state.scroll[cur.id] = 777;
            t.scrollTop = 0;
            t.dispatchEvent(new Event('scroll'));
            rememberCurrentScroll(true);
            const scrollOk = state.scroll[cur.id] === 777;
            t.innerHTML = '<div id="loading-sentinel">loading</div>';
            renderThread();
            const renderOk = !!document.getElementById('loading-sentinel');
            return { ok: scrollOk && renderOk };
          } finally {
            state.threadLoading = prevLoading;
            if (cur) {
              if (prevScroll === undefined) delete state.scroll[cur.id];
              else state.scroll[cur.id] = prevScroll;
            }
            t.innerHTML = prevHtml;
            renderThread();
          }
        })()
      `);
      checks.scrollLoadingGuard = !!(r && r.ok);
    } catch (e) {
      checks.scrollLoadingGuard = false;
      log('scroll loading guard assertion failed', String((e && e.message) || e));
    }
    // R149：懒加载补水不得回滚请求期间的本地元数据编辑
    try {
      const r = await mainWindow.webContents.executeJavaScript(`
        (function () {
          const item = {
            id: 's_hydrate_probe', title: '本地新标题', pinned: true, archived: false,
            cwd: 'local-cwd', model: 'local-model', lazy: true, messages: [],
          };
          const full = {
            id: 's_hydrate_probe', title: '磁盘旧标题', pinned: false, archived: true,
            cwd: 'disk-cwd', model: 'disk-model', lazy: true,
            messages: [{ role: 'user', text: '正文', ts: 1 }],
          };
          const ok = mergeHydratedSession(item, full);
          return {
            ok: ok,
            title: item.title, pinned: item.pinned, archived: item.archived,
            cwd: item.cwd, model: item.model, lazy: item.lazy,
            messages: item.messages.length,
          };
        })()
      `);
      checks.hydrateMetadataGuard = !!(
        r && r.ok && r.title === '本地新标题' && r.pinned === true && r.archived === false &&
        r.cwd === 'local-cwd' && r.model === 'local-model' && r.lazy === false && r.messages === 1
      );
      if (!checks.hydrateMetadataGuard) log('hydrate metadata detail', JSON.stringify(r));
    } catch (e) {
      checks.hydrateMetadataGuard = false;
      log('hydrate metadata assertion failed', String((e && e.message) || e));
    }
    // R150：图片/字体加载后可校准保存位置，但用户手动滚动必须立即接管
    try {
      const r = await mainWindow.webContents.executeJavaScript(`
        (function () {
          const cur = state.current;
          if (!cur) return { ok: false };
          const t = document.getElementById('thread');
          const prevHtml = t.innerHTML;
          const prevSettle = state.scrollSettle;
          const prevIntent = state.scrollIntentSeq;
          const prevLoading = state.threadLoading;
          try {
            state.threadLoading = false;
            state.scrollSettle = null;
            state.scrollIntentSeq = 0;
            t.innerHTML = '<div style="height:3000px;min-height:3000px">spacer</div>';
            t.style.height = '240px';
            t.style.flex = 'none';
            scheduleSavedScrollSettle(cur.id, 123);
            t.scrollTop = 0;
            state.scrollSettle.apply();
            const restored = Math.abs(t.scrollTop - 123) < 1;
            state.scrollIntentSeq++;
            t.scrollTop = 0;
            state.scrollSettle.apply();
            return { ok: restored && t.scrollTop === 0 && state.scrollSettle === null };
          } finally {
            state.scrollSettle = null;
            state.scrollIntentSeq = prevIntent;
            state.threadLoading = prevLoading;
            t.innerHTML = prevHtml;
            t.style.height = '';
            t.style.flex = '';
            renderThread();
          }
        })()
      `);
      checks.scrollSettleGuard = !!(r && r.ok);
      if (!checks.scrollSettleGuard) log('scroll settle detail', JSON.stringify(r));
    } catch (e) {
      checks.scrollSettleGuard = false;
      log('scroll settle assertion failed', String((e && e.message) || e));
    }
    // R151：界面缩放/DPI 变化按滚动比例恢复，而非旧像素值
    try {
      const r = await mainWindow.webContents.executeJavaScript(`
        (function () {
          const t = document.getElementById('thread');
          const prevHtml = t.innerHTML;
          const prevHeight = t.style.height;
          const prevFlex = t.style.flex;
          try {
            t.style.height = '240px';
            t.style.flex = 'none';
            t.innerHTML = '<div id="zoom-spacer" style="height:3000px;min-height:3000px">x</div>';
            t.scrollTop = 600;
            const ratio = threadScrollRatio(t);
            document.getElementById('zoom-spacer').style.height = '5000px';
            document.getElementById('zoom-spacer').style.minHeight = '5000px';
            applyThreadScrollRatio(t, ratio);
            const max = t.scrollHeight - t.clientHeight;
            return { ok: Math.abs(t.scrollTop - ratio * max) < 2, ratio: ratio };
          } finally {
            t.innerHTML = prevHtml;
            t.style.height = prevHeight;
            t.style.flex = prevFlex;
            renderThread();
          }
        })()
      `);
      checks.zoomScrollRatio = !!(r && r.ok);
    } catch (e) {
      checks.zoomScrollRatio = false;
      log('zoom scroll assertion failed', String((e && e.message) || e));
    }
    // R152：最小窗口 + 侧栏 + 右侧面板下，输入工具栏与发送按钮必须可达
    let bounds = null;
    try {
      bounds = mainWindow.getBounds();
      mainWindow.setSize(880, 560);
      await new Promise((r) => setTimeout(r, 180));
      const r = await mainWindow.webContents.executeJavaScript(`
        (function () {
          const prevOpen = state.panelOpen;
          try {
            state.panelOpen = true;
            document.getElementById('panel').classList.add('show');
            renderPanel();
            const bar = document.querySelector('.composer-bar');
            const send = document.getElementById('btnSend').getBoundingClientRect();
            const input = document.getElementById('input').getBoundingClientRect();
            const mask = document.createElement('div');
            mask.className = 'text-modal-mask';
            mask.innerHTML = '<div class="text-modal" role="dialog"><div class="tm-head"><span class="tm-title">最小窗口弹层</span><button class="mini-btn" data-close>×</button></div><pre class="tm-body">' +
              Array.from({ length: 200 }, (_, i) => 'line ' + i).join('\\n') + '</pre></div>';
            document.body.appendChild(mask);
            const modal = mask.querySelector('.text-modal');
            const body = mask.querySelector('.tm-body');
            const close = mask.querySelector('[data-close]').getBoundingClientRect();
            const rect = modal.getBoundingClientRect();
            const modalOk = rect.top >= 0 && rect.bottom <= innerHeight && close.bottom <= innerHeight &&
              body.clientHeight > 0 && getComputedStyle(body).overflow === 'auto';
            mask.remove();
            return {
              pageOk: document.documentElement.scrollWidth <= innerWidth + 1,
              barOk: bar.scrollWidth <= bar.clientWidth + 1,
              sendOk: send.right <= innerWidth + 1 && send.bottom <= innerHeight + 1,
              inputOk: input.bottom <= innerHeight + 1 && input.height > 0,
              modalOk: modalOk,
            };
          } finally {
            state.panelOpen = prevOpen;
            document.getElementById('panel').classList.toggle('show', prevOpen);
            renderPanel();
          }
        })()
      `);
      checks.narrowLayoutReachable = !!(r && r.pageOk && r.barOk && r.sendOk && r.inputOk);
      checks.modalMinWindowReachable = !!(r && r.modalOk);
      if (!checks.narrowLayoutReachable || !checks.modalMinWindowReachable) log('narrow layout detail', JSON.stringify(r));
      mainWindow.setBounds(bounds);
    } catch (e) {
      checks.narrowLayoutReachable = false;
      checks.modalMinWindowReachable = false;
      log('narrow layout assertion failed', String((e && e.message) || e));
      try { mainWindow.setBounds(bounds); } catch { /* ignore */ }
    }
    // R154：焦点逃到弹层外部后，Tab 仍应由最上层 dialog 接管
    try {
      const r = await mainWindow.webContents.executeJavaScript(`
        (function () {
          const outside = document.getElementById('btnNew');
          const mask = document.createElement('div');
          mask.innerHTML = '<div role="dialog"><button id="trap-a">A</button><button id="trap-b">B</button></div>';
          document.body.appendChild(mask);
          const dialog = mask.firstElementChild;
          const release = installDialogFocusTrap(mask, dialog);
          try {
            outside.focus();
            outside.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
            return { ok: dialog.contains(document.activeElement) };
          } finally {
            release();
            mask.remove();
          }
        })()
      `);
      checks.dialogFocusEscapeGuard = !!(r && r.ok);
    } catch (e) {
      checks.dialogFocusEscapeGuard = false;
      log('dialog focus escape assertion failed', String((e && e.message) || e));
    }
    // R155：模型选择器长列表只渲染 400 项，但搜索仍可定位后续项
    try {
      const r = await mainWindow.webContents.executeJavaScript(`
        (function () {
          const items = Array.from({ length: 1000 }, (_, i) => ({ id: 'model-' + i, name: 'Model ' + i }));
          const first = filterModelPickerItems(items, '');
          const later = filterModelPickerItems(items, 'model-900');
          return { first: first.length, last: first[first.length - 1].id, later: later.length, laterId: later[0] && later[0].id };
        })()
      `);
      checks.modelPickerBounded = !!(r && r.first === 400 && r.last === 'model-399' && r.later === 1 && r.laterId === 'model-900');
    } catch (e) {
      checks.modelPickerBounded = false;
      log('model picker bound assertion failed', String((e && e.message) || e));
    }
    // R156：供应商测试只接受当前序号且弹层未关闭的结果
    try {
      const r = await mainWindow.webContents.executeJavaScript(`
        (function () {
          return {
            current: providerTestResultCurrent(1, 1, false),
            stale: providerTestResultCurrent(1, 2, false),
            closed: providerTestResultCurrent(1, 1, true),
          };
        })()
      `);
      checks.providerTestStaleGuard = !!(r && r.current && !r.stale && !r.closed);
    } catch (e) {
      checks.providerTestStaleGuard = false;
      log('provider stale guard assertion failed', String((e && e.message) || e));
    }
    // R157：配置保存快照/类型边界，null/数组不得写入 settings.json
    try {
      const bad = await mainWindow.webContents.executeJavaScript('window.shell.config.save(null)');
      checks.configTypeGuard = !!(bad && bad.ok === false);
    } catch (e) {
      checks.configTypeGuard = false;
      log('config type guard assertion failed', String((e && e.message) || e));
    }
    // R158：主动重启保留排队消息；手动停止仍清空
    try {
      const r = await mainWindow.webContents.executeJavaScript(`
        (async function () {
          const keepSessions = state.sessions;
          const keepCurrent = state.current;
          const prevSchedule = scheduleQueuedTurn;
          const prevPersist = persist;
          const s = { id: 's_restart_probe', title: 'restart', cwd: '.', messages: [
            { role: 'user', text: 'q', ts: 1 },
            { role: 'assistant', blocks: [], pending: true, ts: 1 },
          ], createdAt: 1, updatedAt: 1 };
          let captured = null;
          try {
            state.sessions = keepSessions.concat([s]);
            state.current = s;
            const rtProbe = rt(s.id);
            rtProbe.busy = true;
            rtProbe.stream = null;
            state.queue[s.id] = [{ text: 'next-1' }, { text: 'next-2' }];
            scheduleQueuedTurn = (_sid, next) => { captured = next; };
            persist = () => {};
            restartSession(s, '测试重启');
            await new Promise((res) => setTimeout(res, 20));
            return {
              queue: (state.queue[s.id] || []).length,
              captured: captured && captured.text,
              busy: rtProbe.busy,
              restarting: rtProbe.restarting,
            };
          } finally {
            scheduleQueuedTurn = prevSchedule;
            persist = prevPersist;
            state.sessions = keepSessions;
            state.current = keepCurrent;
            state.runtimes.delete(s.id);
            delete state.queue[s.id];
            renderThread();
            renderComposer();
          }
        })()
      `);
      checks.restartKeepsQueue = !!(r && r.queue === 1 && r.captured === 'next-1' && r.busy === false && r.restarting === false);
    } catch (e) {
      checks.restartKeepsQueue = false;
      log('restart queue assertion failed', String((e && e.message) || e));
    }
    // R159：迟到/重复 result 不得二次结算已完成回合
    try {
      const r = await mainWindow.webContents.executeJavaScript(`
        (function () {
          const keepSessions = state.sessions;
          const keepCurrent = state.current;
          const prevPersist = persist;
          const s = { id: 's_result_probe', title: 'result', cwd: '.', messages: [
            { role: 'user', text: 'q', ts: 1 },
            { role: 'assistant', blocks: [], pending: true, ts: 1 },
          ], createdAt: 1, updatedAt: 1 };
          try {
            state.sessions = keepSessions.concat([s]);
            state.current = s;
            persist = () => {};
            const rProbe = rt(s.id);
            rProbe.busy = false;
            rProbe.stream = null;
            finishTurn(s, { subtype: 'success', duration_ms: 1 });
            const staleIgnored = s.messages[1].pending === true;
            rProbe.busy = true;
            finishTurn(s, { subtype: 'success', duration_ms: 1 });
            return { staleIgnored: staleIgnored, settled: s.messages[1].pending === false };
          } finally {
            persist = prevPersist;
            state.sessions = keepSessions;
            state.current = keepCurrent;
            state.runtimes.delete(s.id);
            renderThread();
          }
        })()
      `);
      checks.duplicateResultGuard = !!(r && r.staleIgnored && r.settled);
    } catch (e) {
      checks.duplicateResultGuard = false;
      log('duplicate result assertion failed', String((e && e.message) || e));
    }
    // R160：切会话停放旧授权；重复 tool_result 不得二次改写
    try {
      const r = await mainWindow.webContents.executeJavaScript(`
        (function () {
          const keepSessions = state.sessions;
          const keepCurrent = state.current;
          const keepPending = state.pendingApproval;
          const keepQueue = approvalQueue.splice(0);
          const a = { id: 's_approval_a', title: 'A', cwd: '.', messages: [], createdAt: 1, updatedAt: 1 };
          const b = { id: 's_approval_b', title: 'B', cwd: '.', messages: [], createdAt: 1, updatedAt: 1 };
          try {
            state.sessions = keepSessions.concat([a, b]);
            state.current = a;
            const ia = { sessionId: a.id, requestId: 'ra', toolName: 'shell' };
            const ib = { sessionId: b.id, requestId: 'rb', toolName: 'shell' };
            state.pendingApproval = ia;
            parkPendingApproval();
            const parked = state.pendingApproval === null && approvalQueue.includes(ia);
            state.current = b;
            showApprovalCard(ib);
            const currentB = state.pendingApproval === ib;
            showApprovalCard(ia);
            const notOverwritten = state.pendingApproval === ib && approvalQueue.includes(ia);
            return { parked: parked, currentB: currentB, notOverwritten: notOverwritten };
          } finally {
            state.sessions = keepSessions;
            state.current = keepCurrent;
            state.pendingApproval = keepPending;
            approvalQueue.splice(0, approvalQueue.length, ...keepQueue);
            renderThread();
          }
        })()
      `);
      checks.approvalSwitchGuard = !!(r && r.parked && r.currentB && r.notOverwritten);
    } catch (e) {
      checks.approvalSwitchGuard = false;
      log('approval switch assertion failed', String((e && e.message) || e));
    }
    try {
      const r = await mainWindow.webContents.executeJavaScript(`
        (function () {
          const s = state.current;
          const rProbe = rt(s.id);
          const prevStream = rProbe.stream;
          const block = { id: 't1', type: 'tool', state: 'running', output: '', startedAt: 1 };
          try {
            rProbe.stream = { tools: { t1: block }, blocks: [block], follow: true };
            handleToolResults(s, { message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'first' }] } }, false);
            handleToolResults(s, { message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: false, content: 'second' }] } }, false);
            return { state: block.state, output: block.output };
          } finally {
            rProbe.stream = prevStream;
          }
        })()
      `);
      checks.toolResultIdempotent = !!(r && r.state === 'error' && r.output === 'first');
    } catch (e) {
      checks.toolResultIdempotent = false;
      log('tool result idempotent assertion failed', String((e && e.message) || e));
    }
    // R161：工具复制/另存为取 block 全文，不受 128KB 渲染截断影响
    try {
      const r = await mainWindow.webContents.executeJavaScript(`
        (function () {
          const full = 'x'.repeat(200 * 1024);
          const block = { id: 't-full', name: 'shell', state: 'done', input: {}, output: full };
          const tool = toolElement(block);
          const btn = document.createElement('button');
          tool.appendChild(btn);
          const action = toolActionContent(btn);
          const limited = resultTextLimited('y'.repeat(TOOL_OUTPUT_STORE_MAX + 100));
          return {
            actionFull: action === full,
            renderCut: toolOutHtml(block).includes('渲染已截断'),
            storeBounded: limited.text.length === TOOL_OUTPUT_STORE_MAX && limited.truncated,
          };
        })()
      `);
      checks.toolOutputActionFull = !!(r && r.actionFull && r.renderCut && r.storeBounded);
    } catch (e) {
      checks.toolOutputActionFull = false;
      log('tool output action assertion failed', String((e && e.message) || e));
    }
    // R162：导出预估计入工具输出；导入保留输出截断元数据
    try {
      const r = await mainWindow.webContents.executeJavaScript(`
        (function () {
          const out = 'x'.repeat(100 * 1024);
          const estimate = estimateSessionsChars([{ messages: [{ role: 'assistant', blocks: [{ type: 'tool', output: out }] }] }]);
          const imported = sanitizeImportedSession({ messages: [{ role: 'assistant', blocks: [
            { type: 'tool', output: out, outputLen: 500000, truncated: true },
          ] }] });
          const b = imported.messages[0].blocks[0];
          return { estimate: estimate, output: b.output.length, outputLen: b.outputLen, truncated: b.truncated };
        })()
      `);
      checks.exportEstimateIncludesOutput = !!(r && r.estimate >= 100 * 1024);
      checks.importOutputMetadata = !!(r && r.output === 100 * 1024 && r.outputLen === 500000 && r.truncated === true);
    } catch (e) {
      checks.exportEstimateIncludesOutput = false;
      checks.importOutputMetadata = false;
      log('output metadata assertion failed', String((e && e.message) || e));
    }
    // R163：回收站恢复原子性；忙碌会话禁止 slim
    try {
      const id = 's_trash_atomic';
      const file = sessionFile(id);
      const fake = { id, title: 'trash atomic', cwd: '.', messages: [], createdAt: 1, updatedAt: 1 };
      saveSession(fake);
      flushSessionSave(id);
      deleteSessionFile(id);
      const trashFile = fs.readdirSync(TRASH_DIR).find((f) => f.endsWith('-' + id + '.json'));
      const src = path.join(TRASH_DIR, trashFile || '');
      const origUnlink = fs.unlinkSync;
      let failed = null;
      fs.unlinkSync = (p) => {
        if (String(p) === src) {
          const err = new Error('EPERM smoke-injected');
          err.code = 'EPERM';
          throw err;
        }
        return origUnlink(p);
      };
      try {
        failed = await mainWindow.webContents.executeJavaScript(
          'window.shell.sessions.trashRestore(' + JSON.stringify(trashFile) + ')'
        );
      } finally {
        fs.unlinkSync = origUnlink;
      }
      const rolledBack = failed && failed.ok === false && !fs.existsSync(file) && deletedSessionIds.has(id);
      const restored = await mainWindow.webContents.executeJavaScript(
        'window.shell.sessions.trashRestore(' + JSON.stringify(trashFile) + ')'
      );
      const saved = await mainWindow.webContents.executeJavaScript(
        'window.shell.sessions.save(' + JSON.stringify(fake) + ')'
      );
      checks.trashRestoreAtomic = !!(rolledBack && restored && restored.ok === true && fs.existsSync(file) && !deletedSessionIds.has(id) && saved === true);
      flushSessionSave(id);
      deleteSessionFile(id);
      try {
        for (const f of fs.readdirSync(TRASH_DIR)) {
          if (f.endsWith('-' + id + '.json')) fs.rmSync(path.join(TRASH_DIR, f), { force: true });
        }
      } catch { /* ignore */ }
    } catch (e) {
      checks.trashRestoreAtomic = false;
      log('trash restore atomic assertion failed', String((e && e.message) || e));
    }
    try {
      const id = 's_slim_busy';
      agents.set(id, { busy: true });
      const r = await mainWindow.webContents.executeJavaScript('window.shell.sessions.slim(' + JSON.stringify(id) + ')');
      checks.slimBusyGuard = !!(r && r.ok === false && /执行中/.test(r.error || ''));
      agents.delete(id);
    } catch (e) {
      checks.slimBusyGuard = false;
      log('slim busy assertion failed', String((e && e.message) || e));
    }
    // R164：清空部分失败只提交成功项，保留失败会话磁盘/索引/墓碑
    try {
      const a = 's_clear_fail_a';
      const b = 's_clear_fail_b';
      const fa = sessionFile(a);
      const fb = sessionFile(b);
      fs.writeFileSync(fa, JSON.stringify({ id: a, title: 'A', messages: [] }));
      fs.writeFileSync(fb, JSON.stringify({ id: b, title: 'B', messages: [] }));
      updateSessionIndex({ id: a, title: 'A', messages: [] });
      updateSessionIndex({ id: b, title: 'B', messages: [] });
      flushSessionIndex();
      const origRename = fs.renameSync;
      const origCopy = fs.copyFileSync;
      const origUnlink = fs.unlinkSync;
      const blocked = () => { const e = new Error('EPERM smoke-injected'); e.code = 'EPERM'; throw e; };
      fs.renameSync = (src, dst) => String(src) === fa ? blocked() : origRename(src, dst);
      fs.copyFileSync = (src, dst) => String(src) === fa ? blocked() : origCopy(src, dst);
      fs.unlinkSync = (src) => String(src) === fa ? blocked() : origUnlink(src);
      let r = null;
      try {
        r = await mainWindow.webContents.executeJavaScript('window.shell.sessions.clear()');
      } finally {
        fs.renameSync = origRename;
        fs.copyFileSync = origCopy;
        fs.unlinkSync = origUnlink;
      }
      const detail = {
        result: r, aFile: fs.existsSync(fa), bFile: fs.existsSync(fb),
        aIndex: sessionIndex.has(a), bIndex: sessionIndex.has(b),
        aTomb: deletedSessionIds.has(a), bTomb: deletedSessionIds.has(b),
      };
      checks.clearPartialFailure = !!(
        r && r.ok === false && r.removed >= 1 &&
        Array.isArray(r.removedIds) && r.removedIds.includes(b) &&
        Array.isArray(r.failedIds) && r.failedIds.includes(a) &&
        fs.existsSync(fa) && !fs.existsSync(fb) &&
        sessionIndex.has(a) && !sessionIndex.has(b) &&
        !deletedSessionIds.has(a) && deletedSessionIds.has(b)
      );
      if (!checks.clearPartialFailure) log('clear partial detail', JSON.stringify(detail));
      fs.rmSync(fa, { force: true });
      removeSessionIndex(a);
      removeSessionIndex(b);
      flushSessionIndex();
      try {
        for (const f of fs.readdirSync(TRASH_DIR)) if (f.endsWith('-' + b + '.json')) fs.rmSync(path.join(TRASH_DIR, f), { force: true });
      } catch { /* ignore */ }
    } catch (e) {
      checks.clearPartialFailure = false;
      log('clear partial failure assertion failed', String((e && e.message) || e));
    }
    // R165：归档恢复/撤销按真实成功数反馈，缺失或 hydrate 失败计入失败
    try {
      const r = await mainWindow.webContents.executeJavaScript(`
        (async function () {
          const keepSessions = state.sessions;
          const keepPersist = persist;
          const s = { id: 's_archive_probe', title: 'archive', cwd: '.', archived: true, messages: [], createdAt: 1, updatedAt: 1 };
          try {
            state.sessions = keepSessions.concat([s]);
            persist = () => {};
            state.archiveSelected = new Set([s.id, 's_archive_missing']);
            await restoreArchivedSelection();
            return { restored: s.archived === false, status: document.getElementById('statusText').textContent };
          } finally {
            persist = keepPersist;
            state.sessions = keepSessions;
            state.archiveSelected = new Set();
            renderAll();
          }
        })()
      `);
      checks.archiveRestoreCount = !!(r && r.restored && /已移出归档 1/.test(r.status) && /1 个失败/.test(r.status));
    } catch (e) {
      checks.archiveRestoreCount = false;
      log('archive restore count assertion failed', String((e && e.message) || e));
    }
    try {
      const r = await mainWindow.webContents.executeJavaScript(`
        (async function () {
          const keepSessions = state.sessions;
          const keepExtras = state.extras;
          const keepPersist = persist;
          const keepToast = toast;
          const keepRender = renderSidebar;
          const calls = [];
          const s = { id: 's_auto_probe', title: 'auto', cwd: '.', archived: false, messages: [], createdAt: 1, updatedAt: 1 };
          try {
            state.sessions = keepSessions.concat([s]);
            state.extras = { prefs: { autoArchiveDays: 1 } };
            persist = () => {};
            renderSidebar = () => {};
            toast = (title, _detail, action) => calls.push({ title, action });
            await runAutoArchive();
            state.sessions = keepSessions;
            if (calls[0] && calls[0].action) calls[0].action();
            return { archived: s.archived, undo: calls[1] && calls[1].title };
          } finally {
            persist = keepPersist;
            toast = keepToast;
            renderSidebar = keepRender;
            state.sessions = keepSessions;
            state.extras = keepExtras;
            renderAll();
          }
        })()
      `);
      checks.autoArchiveUndoCount = !!(r && r.archived === true && /撤销自动归档 0/.test(r.undo || '') && /1 个会话已不存在/.test(r.undo || ''));
    } catch (e) {
      checks.autoArchiveUndoCount = false;
      log('auto archive undo assertion failed', String((e && e.message) || e));
    }
    // R166：保存失败/恢复通知不得覆盖忙碌会话状态
    try {
      const r = await mainWindow.webContents.executeJavaScript(`
        (function () {
          const keepSessions = state.sessions;
          const keepCurrent = state.current;
          const keepRender = renderSidebar;
          const keepToast = toast;
          const s = { id: 's_save_notice', title: 'save', cwd: '.', messages: [], createdAt: 1, updatedAt: 1 };
          try {
            state.sessions = keepSessions.concat([s]);
            state.current = s;
            renderSidebar = () => {};
            toast = () => {};
            const rProbe = rt(s.id);
            rProbe.busy = true;
            rProbe.status = { text: '思考中', kind: 'busy' };
            applySessionSaveError({ id: s.id, error: 'ENOSPC' });
            const errorKept = rProbe.status.kind === 'busy' && rProbe.status.text === '思考中' && !!s.saveError;
            applySessionSaveOk({ id: s.id });
            return { errorKept: errorKept, cleared: !s.saveError, statusKept: rProbe.status.kind === 'busy' && rProbe.status.text === '思考中' };
          } finally {
            renderSidebar = keepRender;
            toast = keepToast;
            state.sessions = keepSessions;
            state.current = keepCurrent;
            state.runtimes.delete(s.id);
            renderAll();
          }
        })()
      `);
      checks.saveNoticePreservesBusy = !!(r && r.errorKept && r.cleared && r.statusKept);
    } catch (e) {
      checks.saveNoticePreservesBusy = false;
      log('save notice assertion failed', String((e && e.message) || e));
    }
    // R167：删除/取消保存与序列化失败都必须清理 .tmp
    try {
      const id = 's_temp_cleanup';
      const tmp = sessionFile(id) + '.tmp';
      fs.writeFileSync(tmp, 'partial');
      dropSessionSave(id);
      const dropClean = !fs.existsSync(tmp);
      fs.writeFileSync(tmp, 'partial');
      const cyclic = { id: id, title: 'cyclic', messages: [] };
      cyclic.self = cyclic;
      saveSession(cyclic);
      flushSessionSave(id);
      checks.saveTempCleanup = dropClean && !fs.existsSync(tmp) && !pendingSessionSaves.has(id);
      dropSessionSave(id);
      removeSessionIndex(id);
      flushSessionIndex();
    } catch (e) {
      checks.saveTempCleanup = false;
      log('save temp cleanup assertion failed', String((e && e.message) || e));
    }
    // R168：合法 JSON 的坏会话记录必须隔离；索引写入失败可重试
    try {
      const id = 's_null_record';
      const file = sessionFile(id);
      fs.writeFileSync(file, 'null');
      const list = await loadSessions();
      checks.loadSessionsCorruptSafe = Array.isArray(list) && !list.some((s) => s && s.id === id) && fs.existsSync(file + '.bad');
      fs.rmSync(file, { force: true });
      fs.rmSync(file + '.bad', { force: true });
    } catch (e) {
      checks.loadSessionsCorruptSafe = false;
      log('corrupt load assertion failed', String((e && e.message) || e));
    }
    try {
      const realWrite = fs.writeFileSync;
      let fail = true;
      fs.writeFileSync = (p, data, enc) => {
        if (fail && String(p) === SESSION_INDEX_FILE + '.tmp') {
          const err = new Error('EACCES smoke-injected'); err.code = 'EACCES'; throw err;
        }
        return realWrite(p, data, enc);
      };
      updateSessionIndex({ id: 's_index_retry', title: 'retry', messages: [] });
      clearTimeout(sessionIndexTimer);
      writeSessionIndexNow();
      const scheduled = sessionIndexWriteAttempts === 1 && !!sessionIndexTimer;
      fail = false;
      writeSessionIndexNow();
      checks.indexWriteRetry = scheduled && sessionIndexWriteAttempts === 0 && !sessionIndexDirty;
      fs.writeFileSync = realWrite;
      removeSessionIndex('s_index_retry');
      flushSessionIndex();
    } catch (e) {
      checks.indexWriteRetry = false;
      log('index retry assertion failed', String((e && e.message) || e));
    }
    // R169：索引首次重建并发读取；null prefs 迁移不抛错
    try {
      const prevIndex = sessionIndex;
      const ids = [];
      for (let i = 0; i < 20; i++) {
        const id = 's_idx_parallel_' + i;
        ids.push(id);
        fs.writeFileSync(sessionFile(id), JSON.stringify({ id, title: id, messages: [], updatedAt: 1 }));
      }
      const realRead = fs.promises.readFile;
      let active = 0;
      let maxActive = 0;
      fs.promises.readFile = async (p, ...args) => {
        if (ids.some((id) => String(p) === sessionFile(id))) {
          active++;
          maxActive = Math.max(maxActive, active);
          await new Promise((r) => setTimeout(r, 30));
          active--;
        }
        return realRead.call(fs.promises, p, ...args);
      };
      try {
        sessionIndex = new Map();
        await refreshSessionIndex();
      } finally {
        fs.promises.readFile = realRead;
      }
      checks.indexRebuildParallel = maxActive > 1 && maxActive <= 8 && ids.every((id) => sessionIndex.has(id));
      sessionIndex = prevIndex;
      for (const id of ids) {
        removeSessionIndex(id);
        fs.rmSync(sessionFile(id), { force: true });
      }
      flushSessionIndex();
      const migrated = migratePrefs(null);
      checks.nullPrefsMigration = !!(migrated && migrated.migrated && migrated.next.schemaVersion === PREFS_SCHEMA_VERSION);
    } catch (e) {
      checks.indexRebuildParallel = false;
      checks.nullPrefsMigration = false;
      log('index parallel assertion failed', String((e && e.message) || e));
    }
    // R171：工具组首次展开才构建子卡片，连续 2 个工具即可折叠
    try {
      const r = await mainWindow.webContents.executeJavaScript(`
        (function () {
          const blocks = [
            { type: 'tool', id: 'lg1', name: 'read_file', state: 'done', input: {}, output: 'a' },
            { type: 'tool', id: 'lg2', name: 'read_file', state: 'done', input: {}, output: 'b' },
          ];
          const host = document.createElement('div');
          appendBlocksGrouped(host, blocks);
          const group = host.querySelector('.tool-group');
          const before = group.querySelectorAll('.tg-body-inner .tool').length;
          group.querySelector('.tg-head').click();
          const after = group.querySelectorAll('.tg-body-inner .tool').length;
          return { grouped: !!group, before: before, after: after, expanded: group.classList.contains('open') };
        })()
      `);
      checks.toolGroupLazyBody = !!(r && r.grouped && r.before === 0 && r.after === 2 && r.expanded);
    } catch (e) {
      checks.toolGroupLazyBody = false;
      log('tool group lazy assertion failed', String((e && e.message) || e));
    }
    // R172：工具组重绘后复用已构建组体节点
    try {
      const r = await mainWindow.webContents.executeJavaScript(`
        (function () {
          const blocks = [
            { type: 'tool', id: ' reuse1'.trim(), name: 'read_file', state: 'done', input: {}, output: 'a' },
            { type: 'tool', id: 'reuse2', name: 'read_file', state: 'done', input: {}, output: 'b' },
          ];
          const h1 = document.createElement('div');
          const h2 = document.createElement('div');
          appendBlocksGrouped(h1, blocks);
          appendBlocksGrouped(h2, blocks);
          const g1 = h1.querySelector('.tool-group');
          const g2 = h2.querySelector('.tool-group');
          g1.querySelector('.tg-head').click();
          const node1 = g1.querySelector('.tg-body-inner');
          g2.querySelector('.tg-head').click();
          const node2 = g2.querySelector('.tg-body-inner');
          return { reused: node1 === node2, count: node2.querySelectorAll('.tool').length };
        })()
      `);
      checks.toolGroupBodyReuse = !!(r && r.reused && r.count === 2);
    } catch (e) {
      checks.toolGroupBodyReuse = false;
      log('tool group reuse assertion failed', String((e && e.message) || e));
    }
    // R173：DOM 缓存按字节与条目数双重淘汰，命中更新 LRU
    try {
      const r = await mainWindow.webContents.executeJavaScript(`
        (function () {
          const cache = new Map();
          boundedCacheSet(cache, 'a', { v: 1 }, 2, 5, 3);
          boundedCacheSet(cache, 'b', { v: 2 }, 2, 5, 3);
          boundedCacheGet(cache, 'a');
          boundedCacheSet(cache, 'c', { v: 3 }, 2, 5, 3);
          return { evicted: !cache.has('b'), keptA: cache.has('a'), keptC: cache.has('c'), weight: cache.__weight };
        })()
      `);
      checks.domCacheBounded = !!(r && r.evicted && r.keptA && r.keptC && r.weight <= 5);
    } catch (e) {
      checks.domCacheBounded = false;
      log('dom cache bound assertion failed', String((e && e.message) || e));
    }
    // R174：300KB 长块首次构建后应命中节点缓存，超预算巨块仍自动淘汰
    try {
      const r = await mainWindow.webContents.executeJavaScript(`
        (function () {
          const text = 'x'.repeat(300 * 1024);
          const block = { type: 'text', text: text };
          const a = blockElement(block);
          const b = blockElement(block);
          const cloned = a !== b && a.innerHTML === b.innerHTML;
          const cachedBefore = mdBlockNodeCache.has(block);
          const huge = {};
          boundedCacheSet(mdBlockNodeCache, huge, { text: '', html: '', node: null }, 8 * 1024 * 1024 + 1, 8 * 1024 * 1024, 600);
          return {
            cached: cachedBefore,
            cloned: cloned,
            hugeEvicted: !mdBlockNodeCache.has(huge),
            weight: mdBlockNodeCache.__weight,
          };
        })()
      `);
      checks.longBlockNodeCache = !!(r && r.cached && r.cloned && r.hugeEvicted && r.weight <= 8 * 1024 * 1024);
    } catch (e) {
      checks.longBlockNodeCache = false;
      log('long block cache assertion failed', String((e && e.message) || e));
    }
    // R175：会话删除缓存清理不得访问不存在的 state.todoBarLive
    try {
      const r = await mainWindow.webContents.executeJavaScript(`
        (function () {
          const id = 's_cleanup_probe';
          const prevIndex = state.searchIndex;
          const prevChars = state.searchIndexChars;
          try {
            state.searchIndex = new Map();
            state.searchIndexChars = 0;
            state.runtimes.set(id, {});
            state.attachments.set(id, []);
            state.renderLimit.set(id, 120);
            state.renderFloor.set(id, 0);
            todoBarLive.set(id, []);
            state.searchIndex.set(id, { key: 'k', text: 'x' });
            state.searchIndexChars = 1;
            forgetSessionCaches(id);
            return {
              runtime: !state.runtimes.has(id), attach: !state.attachments.has(id),
              limit: !state.renderLimit.has(id), floor: !state.renderFloor.has(id),
              todo: !todoBarLive.has(id), search: !state.searchIndex.has(id), chars: state.searchIndexChars,
            };
          } finally {
            state.searchIndex = prevIndex;
            state.searchIndexChars = prevChars;
          }
        })()
      `);
      checks.sessionCacheCleanup = !!(r && r.runtime && r.attach && r.limit && r.floor && r.todo && r.search && r.chars === 0);
    } catch (e) {
      checks.sessionCacheCleanup = false;
      log('session cache cleanup assertion failed', String((e && e.message) || e));
    }
    // R176：导出前批量补全懒会话，缺失历史必须中止而非导出空壳
    try {
      const id = 's_export_hydrate';
      const full = { id, title: 'disk', cwd: '.', messages: [{ role: 'user', text: 'history', ts: 1 }], createdAt: 1, updatedAt: 1 };
      saveSession(full);
      flushSessionSave(id);
      const r = await mainWindow.webContents.executeJavaScript(`
        (async function () {
          const lazy = { id: 's_export_hydrate', title: 'local', lazy: true, messages: [] };
          const missing = { id: 's_export_missing', title: 'missing', lazy: true, messages: [] };
          const failed = await hydrateSessionsForExport([lazy, missing]);
          return { failed: failed, lazy: lazy.lazy, title: lazy.title, messages: (lazy.messages || []).length, missingLazy: missing.lazy };
        })()
      `);
      checks.exportBatchHydrate = !!(r && r.failed === 1 && r.lazy === false && r.title === 'local' && r.messages === 1 && r.missingLazy === true);
      deleteSessionFile(id);
    } catch (e) {
      checks.exportBatchHydrate = false;
      log('export hydrate assertion failed', String((e && e.message) || e));
    }
    // R177：后台授权在侧栏可见
    try {
      const r = await mainWindow.webContents.executeJavaScript(`
        (function () {
          const keepSessions = state.sessions;
          const keepCurrent = state.current;
          const keepQueue = approvalQueue.splice(0);
          const a = { id: 's_approval_dot', title: 'A', cwd: '.', messages: [], createdAt: 1, updatedAt: 1 };
          const b = { id: 's_approval_other', title: 'B', cwd: '.', messages: [], createdAt: 1, updatedAt: 1 };
          try {
            state.sessions = keepSessions.concat([a, b]);
            state.current = b;
            approvalQueue.push({ sessionId: a.id, requestId: 'r1', toolName: 'shell' });
            renderSidebar();
            const row = document.querySelector('[data-focus-key="session:s_approval_dot"]');
            return { ok: !!row && !!row.querySelector('.approval-dot') };
          } finally {
            state.sessions = keepSessions;
            state.current = keepCurrent;
            approvalQueue.splice(0, approvalQueue.length, ...keepQueue);
            renderAll();
          }
        })()
      `);
      checks.backgroundApprovalDot = !!(r && r.ok);
    } catch (e) {
      checks.backgroundApprovalDot = false;
      log('background approval assertion failed', String((e && e.message) || e));
    }
    // 手动 Goal resume 绕过自动续跑开关，自动路径仍受限
    try {
      const r = await mainWindow.webContents.executeJavaScript(`
        (function () {
          const keepExtras = state.extras;
          const keepSessions = state.sessions;
          const keepCurrent = state.current;
          const prevRound = startGoalRound;
          const prevVerify = startGoalVerify;
          const s = { id: 's_goal_manual', title: 'goal', cwd: '.', messages: [], createdAt: 1, updatedAt: 1,
            goal: { status: 'active', round: 0, objective: 'test', maxRounds: 0 } };
          let started = 0;
          try {
            state.sessions = keepSessions.concat([s]);
            state.current = s;
            state.extras = { prefs: { goalAutoContinue: false, goalMaxRounds: 0 } };
            startGoalRound = () => { started++; };
            startGoalVerify = () => {};
            maybeGoalStep(s);
            const afterAuto = started;
            maybeGoalStep(s, true);
            return { afterAuto: afterAuto, started: started };
          } finally {
            startGoalRound = prevRound;
            startGoalVerify = prevVerify;
            state.extras = keepExtras;
            state.sessions = keepSessions;
            state.current = keepCurrent;
          }
        })()
      `);
      checks.goalManualResume = !!(r && r.afterAuto === 0 && r.started === 1);
    } catch (e) {
      checks.goalManualResume = false;
      log('goal manual assertion failed', String((e && e.message) || e));
    }
    // 导入截断报告必须可解释
    try {
      const r = await mainWindow.webContents.executeJavaScript(`
        (function () {
          const block = { type: 'text', text: 'x'.repeat(200001), output: 'y'.repeat(2097153) };
          const overMessages = Array(2001).fill({ role: 'assistant', blocks: Array(501).fill(block) });
          const list = Array(200).fill({ messages: [] });
          list.push({ messages: overMessages });
          const report = importTruncationReport(list);
          return { sessions: report.sessions, messages: report.messages, blocks: report.blocks, texts: report.texts > 0, outputs: report.outputs > 0 };
        })()
      `);
      checks.importTruncationReport = !!(r && r.sessions === 1 && r.messages > 0 && r.blocks > 0 && r.texts && r.outputs);
    } catch (e) {
      checks.importTruncationReport = false;
      log('import truncation assertion failed', String((e && e.message) || e));
    }
    // 检查点恢复不得沿 junction 写出工作区
    try {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qcode-cp-link-'));
      const repo = path.join(tmp, 'repo');
      const outside = path.join(tmp, 'outside');
      fs.mkdirSync(path.join(repo, 'dir'), { recursive: true });
      fs.mkdirSync(outside);
      fs.writeFileSync(path.join(repo, 'dir', 'a.txt'), 'inside');
      fs.writeFileSync(path.join(outside, 'a.txt'), 'outside');
      const sid = 's_cp_link_probe';
      const cp = await mainWindow.webContents.executeJavaScript(
        'window.shell.checkpoint.create(' + JSON.stringify(sid) + ', ' + JSON.stringify(repo) + ')'
      );
      fs.rmSync(path.join(repo, 'dir'), { recursive: true, force: true });
      fs.symlinkSync(outside, path.join(repo, 'dir'), 'junction');
      const rr = await mainWindow.webContents.executeJavaScript(
        'window.shell.checkpoint.restore(' + JSON.stringify(sid) + ', ' + JSON.stringify(cp.id) + ', ' + JSON.stringify(repo) + ', false)'
      );
      checks.checkpointSymlinkGuard = !!(cp && cp.ok && rr && rr.ok === false && fs.readFileSync(path.join(outside, 'a.txt'), 'utf8') === 'outside');
      await mainWindow.webContents.executeJavaScript('window.shell.checkpoint.deleteAll(' + JSON.stringify(sid) + ')');
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch (e) {
      checks.checkpointSymlinkGuard = false;
      log('checkpoint symlink assertion failed', String((e && e.message) || e));
    }
    // 设置触发的批量停内核必须通知 renderer 收尾 busy
    try {
      await mainWindow.webContents.executeJavaScript(`
        (function () {
          const keepSessions = state.sessions;
          const keepCurrent = state.current;
          const s = { id: 's_cfg_stop_probe', title: 'cfg', cwd: '.', messages: [
            { role: 'user', text: 'q', ts: 1 }, { role: 'assistant', blocks: [], pending: true, ts: 1 },
          ], createdAt: 1, updatedAt: 1 };
          state.sessions = keepSessions.concat([s]);
          state.current = s;
          const r = rt(s.id);
          r.busy = true;
          r.stream = null;
          window.__cfgStopProbe = s.id;
        })()
      `);
      agents.set('s_cfg_stop_probe', { stop: () => {} });
      stopAgentsForSettings('配置已更新');
      await new Promise((r) => setTimeout(r, 80));
      const busy = await mainWindow.webContents.executeJavaScript("rt('s_cfg_stop_probe').busy");
      checks.configStopFinalizes = busy === false;
      await mainWindow.webContents.executeJavaScript(`
        (function () {
          const id = window.__cfgStopProbe;
          state.sessions = state.sessions.filter((s) => s.id !== id);
          state.runtimes.delete(id);
          if (state.current && state.current.id === id) state.current = state.sessions[0] || null;
          renderAll();
        })()
      `);
    } catch (e) {
      checks.configStopFinalizes = false;
      log('config stop assertion failed', String((e && e.message) || e));
    }
    // 项目 QWEN.md 备份恢复专用 IPC
    try {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qcode-project-restore-'));
      fs.writeFileSync(path.join(tmp, 'QWEN.md'), 'current');
      fs.writeFileSync(path.join(tmp, 'QWEN.md.bak'), 'backup');
      const r = await mainWindow.webContents.executeJavaScript(
        'window.shell.projectContextRestore(' + JSON.stringify(tmp) + ')'
      );
      checks.projectContextRestore = !!(r && r.ok && fs.readFileSync(path.join(tmp, 'QWEN.md'), 'utf8') === 'backup');
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch (e) {
      checks.projectContextRestore = false;
      log('project restore assertion failed', String((e && e.message) || e));
    }
    checks.attachmentPickApi = await mainWindow.webContents.executeJavaScript("typeof window.shell.pickImages === 'function'");
    // R178：同一消息多次命中逐处翻页，早期 Goal 轮次可移窗口跳转
    try {
      const r = await mainWindow.webContents.executeJavaScript(`
        (function () {
          const keepSessions = state.sessions;
          const keepCurrent = state.current;
          const s = { id: 's_find_occ', title: 'find', cwd: '.', createdAt: 1, updatedAt: 1,
            messages: [{ role: 'user', text: 'alpha alpha alpha', ts: 1 }] };
          try {
            state.sessions = keepSessions.concat([s]);
            state.current = s;
            state.find.hits = [];
            state.find.query = '';
            document.getElementById('findInput').value = 'alpha';
            runFind(0);
            const first = document.getElementById('findCount').textContent;
            runFind(1);
            const second = document.getElementById('findCount').textContent;
            return { hits: state.find.hits.length, first: first, second: second, shape: state.find.hits[1] };
          } finally {
            state.sessions = keepSessions;
            state.current = keepCurrent;
            state.find.hits = [];
            clearJumpHighlight();
            renderAll();
          }
        })()
      `);
      checks.findOccurrences = !!(r && r.hits === 3 && r.first === '1/3' && r.second === '2/3' && r.shape && r.shape.mi === 0 && r.shape.nth === 1);
    } catch (e) {
      checks.findOccurrences = false;
      log('find occurrence assertion failed', String((e && e.message) || e));
    }
    try {
      const r = await mainWindow.webContents.executeJavaScript(`
        (function () {
          const keepSessions = state.sessions;
          const keepCurrent = state.current;
          const msgs = Array.from({ length: 1000 }, (_, i) => ({ role: 'user', text: 'm' + i, ts: 1 }));
          msgs[10] = { role: 'assistant', goalRound: 1, blocks: [], ts: 1 };
          const s = { id: 's_goal_jump', title: 'goal jump', cwd: '.', messages: msgs, createdAt: 1, updatedAt: 1 };
          try {
            state.sessions = keepSessions.concat([s]);
            state.current = s;
            state.renderLimit.set(s.id, 50);
            state.renderFloor.set(s.id, 900);
            jumpToMessage(10, s.id);
            return { floor: state.renderFloor.get(s.id), found: !!threadEl().querySelector('.msg[data-mi="10"]') };
          } finally {
            state.sessions = keepSessions;
            state.current = keepCurrent;
            state.renderLimit.delete(s.id);
            state.renderFloor.delete(s.id);
            renderAll();
          }
        })()
      `);
      checks.goalEarlyJump = !!(r && r.found && r.floor <= 10);
    } catch (e) {
      checks.goalEarlyJump = false;
      log('goal early jump assertion failed', String((e && e.message) || e));
    }
    // R179：手动备份前跨进程 flush，写盘未完成时拒绝备份
    try {
      const id = 's_flush_probe';
      const fake = { id, title: 'flush', cwd: '.', messages: [], createdAt: 1, updatedAt: 1 };
      saveSession(fake);
      const ok = await mainWindow.webContents.executeJavaScript('window.shell.sessions.flush()');
      const flushed = ok && ok.ok === true && !pendingSessionSaves.has(id) && fs.existsSync(sessionFile(id));
      const realWrite = fs.writeFileSync;
      fs.writeFileSync = (p, data, enc) => {
        if (String(p).includes(id)) { const e = new Error('ENOSPC'); e.code = 'ENOSPC'; throw e; }
        return realWrite(p, data, enc);
      };
      let failed = null;
      try {
        saveSession(fake);
        failed = await mainWindow.webContents.executeJavaScript('window.shell.sessions.flush()');
      } finally {
        fs.writeFileSync = realWrite;
      }
      checks.sessionFlushGate = !!(flushed && failed && failed.ok === false && pendingSessionSaves.has(id));
      dropSessionSave(id);
      deleteSessionFile(id);
    } catch (e) {
      checks.sessionFlushGate = false;
      log('session flush assertion failed', String((e && e.message) || e));
    }
    // R180：文件目录读取失败显示错误与重试，不再伪装为空目录
    try {
      const r = await mainWindow.webContents.executeJavaScript(`
        (function () {
          const keepCurrent = state.current;
          const keepTree = state.fileTree;
          const keepTab = state.panelTab;
          const keepOpen = state.panelOpen;
          try {
            state.current = { id: 's_file_err', title: 'file', cwd: window.__qcodeDevWs + '/does-not-exist', messages: [] };
            state.fileTree = null;
            state.panelTab = 'files';
            state.panelOpen = true;
            const ft = ensureFileTree(state.current.cwd);
            ft.cache.set('', []);
            ft.errors.set('', 'EACCES: permission denied');
            renderPanel();
            const body = document.getElementById('panelBody');
            return { error: !!body.querySelector('.file-tree-error'), retry: !!body.querySelector('[data-retry]'), empty: body.textContent.includes('目录为空') };
          } finally {
            state.current = keepCurrent;
            state.fileTree = keepTree;
            state.panelTab = keepTab;
            state.panelOpen = keepOpen;
            renderPanel();
          }
        })()
      `);
      checks.fileDirErrorState = !!(r && r.error && r.retry && !r.empty);
    } catch (e) {
      checks.fileDirErrorState = false;
      log('file dir error assertion failed', String((e && e.message) || e));
    }
    // R181：Git 提交草稿跨重绘保留，读取失败提供重试
    try {
      const r = await mainWindow.webContents.executeJavaScript(`
        (function () {
          const keepCurrent = state.current;
          const keepData = state.gitData;
          const keepTab = state.panelTab;
          const keepOpen = state.panelOpen;
          const keepDrafts = state.gitDrafts;
          try {
            state.current = { id: 's_git_ui', title: 'git', cwd: window.__qcodeDevWs, messages: [] };
            state.gitDrafts = {};
            state.panelTab = 'git';
            state.panelOpen = true;
            state.gitData = { cwd: window.__qcodeDevWs, ok: true, isRepo: true, branch: 'main', files: [{ path: 'a.txt', status: 'M', staged: true }] };
            renderPanel();
            const msg = document.getElementById('gitMsg');
            msg.value = '保留这条提交草稿';
            msg.dispatchEvent(new Event('input'));
            renderPanel();
            const kept = document.getElementById('gitMsg').value;
            state.gitData = { cwd: window.__qcodeDevWs, ok: false, isRepo: false, error: 'EACCES denied' };
            renderPanel();
            return { kept: kept, retry: !!document.getElementById('gitRetry') };
          } finally {
            state.current = keepCurrent;
            state.gitData = keepData;
            state.panelTab = keepTab;
            state.panelOpen = keepOpen;
            state.gitDrafts = keepDrafts;
            renderPanel();
          }
        })()
      `);
      checks.gitDraftPreserved = !!(r && r.kept === '保留这条提交草稿' && r.retry);
    } catch (e) {
      checks.gitDraftPreserved = false;
      log('git draft assertion failed', String((e && e.message) || e));
    }
    // R182：复制失败不得显示“已复制”
    try {
      const r = await mainWindow.webContents.executeJavaScript(`
        (async function () {
          const clip = navigator.clipboard;
          const prev = clip && clip.writeText;
          const btn = document.createElement('button');
          btn.textContent = '复制';
          try {
            if (clip) Object.defineProperty(clip, 'writeText', { configurable: true, value: () => Promise.reject(new Error('denied')) });
            const ok = await copyWithFeedback('probe', btn);
            return { ok: ok, text: btn.textContent };
          } finally {
            if (clip && prev) Object.defineProperty(clip, 'writeText', { configurable: true, value: prev });
          }
        })()
      `);
      checks.copyFailureVisible = !!(r && r.ok === false && r.text === '复制');
    } catch (e) {
      checks.copyFailureVisible = false;
      log('copy feedback assertion failed', String((e && e.message) || e));
    }
    // R183：损坏配置拒绝覆盖；默认模型 ID 同步；envKey 冲突保护
    try {
      const realRead = fs.readFileSync;
      fs.readFileSync = (p, enc) => {
        if (String(p) === QWEN_SETTINGS) throw new SyntaxError('invalid settings probe');
        return realRead(p, enc);
      };
      let getRes = null;
      let saveRes = null;
      try {
        getRes = await mainWindow.webContents.executeJavaScript('window.shell.config.get()');
        saveRes = await mainWindow.webContents.executeJavaScript("window.shell.config.save({ modelProviders: { openai: [] }, env: {} })");
      } finally {
        fs.readFileSync = realRead;
      }
      checks.configReadFailureGuard = !!(getRes && getRes.readError && saveRes && saveRes.ok === false);
    } catch (e) {
      checks.configReadFailureGuard = false;
      log('config read guard assertion failed', String((e && e.message) || e));
    }
    try {
      const r = await mainWindow.webContents.executeJavaScript(`
        (function () {
          const keep = cfgDraft;
          try {
            cfgDraft = { model: { name: 'old-id' }, modelProviders: { openai: [] }, env: {} };
            const p = { id: 'old-id', envKey: 'A' };
            updateProviderModelId(p, 'new-id', 0);
            const providers = [{ envKey: 'SHARED' }, { envKey: 'SHARED' }, { envKey: 'OTHER' }];
            return { defaultId: cfgDraft.model.name, pId: p.id,
              sameKey: providerEnvKeyConflict(providers, [], 'SHARED', 'key-a', { SHARED: 'key-a' }),
              diffKey: providerEnvKeyConflict(providers, [], 'SHARED', 'key-b', { SHARED: 'key-a' }),
              excluded: providerEnvKeyConflict(providers, [0, 1], 'SHARED', 'key-b', { SHARED: 'key-a' }) };
          } finally { cfgDraft = keep; }
        })()
      `);
      checks.providerEditGuards = !!(r && r.defaultId === 'new-id' && r.pId === 'new-id' && !r.sameKey && r.diffKey && !r.excluded);
    } catch (e) {
      checks.providerEditGuards = false;
      log('provider edit guard assertion failed', String((e && e.message) || e));
    }
    // R184：跨机器导入校验 cwd 与模型，重映射后保留原值提示
    try {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qcode-import-env-'));
      const missing = path.join(tmp, 'missing');
      const r = await mainWindow.webContents.executeJavaScript(`
        (async function () {
          const keepModels = MODELS;
          const keepDefault = state.defaultCwd;
          try {
            MODELS = [{ id: 'local/model', label: 'Local Model' }];
            state.defaultCwd = ${JSON.stringify(tmp)};
            const env = await inspectImportEnvironment([
              { cwd: ${JSON.stringify(tmp)}, model: 'local/model', messages: [] },
              { cwd: ${JSON.stringify(missing)}, model: 'remote/model', messages: [] },
            ]);
            const copy = await prepareImportedSession({ cwd: ${JSON.stringify(missing)}, model: 'remote/model', messages: [] }, env);
            return { invalid: env.invalidCwds, remapped: env.remappedModels, cwd: copy.cwd, model: copy.model,
              importedCwd: copy.importedCwd, importedModel: copy.importedModel, warnings: (copy.importWarnings || []).length };
          } finally { MODELS = keepModels; state.defaultCwd = keepDefault; }
        })()
      `);
      checks.importEnvironmentGuard = !!(r && r.invalid === 1 && r.remapped === 1 && r.cwd === tmp && r.model === 'local/model' && r.importedCwd === missing && r.importedModel === 'remote/model' && r.warnings === 2);
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch (e) {
      checks.importEnvironmentGuard = false;
      log('import environment assertion failed', String((e && e.message) || e));
    }
    // R185：Hooks/记忆/项目指令读取失败时拒绝覆盖
    try {
      const realRead = fs.readFileSync;
      const realExists = fs.existsSync;
      const realAsyncRead = fs.promises.readFile;
      const memFile = path.join(QWEN_DIR, 'memories', 'MEMORY.md');
      let hooksGet = null, hooksSave = null, extras = null, memSave = null;
      fs.readFileSync = (p, enc) => {
        if (String(p) === HOOKS_FILE || String(p) === memFile) { const e = new Error('EACCES probe'); e.code = 'EACCES'; throw e; }
        return realRead(p, enc);
      };
      fs.existsSync = (p) => String(p) === memFile ? true : realExists(p);
      fs.promises.readFile = (p, enc) => String(p) === memFile ? Promise.reject(Object.assign(new Error('EACCES probe'), { code: 'EACCES' })) : realAsyncRead(p, enc);
      try {
        hooksGet = await mainWindow.webContents.executeJavaScript('window.shell.hooksGet()');
        hooksSave = await mainWindow.webContents.executeJavaScript("window.shell.hooksSave('{}')");
        extras = await mainWindow.webContents.executeJavaScript('window.shell.extras()');
        memSave = await mainWindow.webContents.executeJavaScript("window.shell.saveMemory('probe')");
      } finally {
        fs.readFileSync = realRead;
        fs.existsSync = realExists;
        fs.promises.readFile = realAsyncRead;
      }
      checks.contextReadFailureGuard = !!(hooksGet && hooksGet.ok === false && hooksSave && hooksSave.ok === false && extras && extras.memory && extras.memory.error && memSave && memSave.ok === false);
    } catch (e) {
      checks.contextReadFailureGuard = false;
      log('context read guard assertion failed', String((e && e.message) || e));
    }
    try {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qcode-project-read-'));
      const file = path.join(tmp, 'QWEN.md');
      fs.writeFileSync(file, 'original');
      const realRead = fs.readFileSync;
      fs.readFileSync = (p, enc) => String(p) === file ? (() => { const e = new Error('EACCES probe'); e.code = 'EACCES'; throw e; })() : realRead(p, enc);
      let getRes = null, saveRes = null;
      try {
        getRes = await mainWindow.webContents.executeJavaScript('window.shell.projectContextGet(' + JSON.stringify(tmp) + ')');
        saveRes = await mainWindow.webContents.executeJavaScript('window.shell.projectContextSave(' + JSON.stringify(tmp) + ", 'overwrite')");
      } finally { fs.readFileSync = realRead; }
      checks.projectReadFailureGuard = !!(getRes && getRes.ok === false && saveRes && saveRes.ok === false && fs.readFileSync(file, 'utf8') === 'original');
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch (e) {
      checks.projectReadFailureGuard = false;
      log('project read guard assertion failed', String((e && e.message) || e));
    }
    // R186：配置脱敏覆盖 headers、URL query、token/password 与 JWT
    try {
      const safe = redactedConfig({
        env: { API_KEY: 'env-secret-value' },
        mcpServers: { demo: { headers: { Authorization: 'Bearer abcdefghijklmnop' }, url: 'https://example.test/?api_key=query-secret-value' } },
        auth: { accessToken: 'access-secret-value', password: 'password-secret-value' },
        note: 'token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signaturevalue123',
      }, false);
      const text = JSON.stringify(safe);
      checks.configRedactionDeep = !/(env-secret-value|abcdefghijklmnop|query-secret-value|access-secret-value|password-secret-value|eyJhbGciOiJIUzI1NiJ9)/.test(text) && safe.mcpServers.demo.headers.Authorization.indexOf('***') >= 0;
    } catch (e) {
      checks.configRedactionDeep = false;
      log('config redaction assertion failed', String((e && e.message) || e));
    }
    // R187：文件预览保存使用版本令牌，外部修改返回 conflict
    try {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qcode-file-conflict-'));
      const file = path.join(tmp, 'a.txt');
      fs.writeFileSync(file, 'base');
      const st = fs.statSync(file);
      const expected = { size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs };
      fs.writeFileSync(file, 'external');
      const conflict = await mainWindow.webContents.executeJavaScript(
        'window.shell.writeFile(' + JSON.stringify(tmp) + ", 'a.txt', 'mine', " + JSON.stringify(expected) + ')'
      );
      const kept = fs.readFileSync(file, 'utf8');
      const forced = await mainWindow.webContents.executeJavaScript(
        'window.shell.writeFile(' + JSON.stringify(tmp) + ", 'a.txt', 'mine')"
      );
      checks.fileWriteConflictGuard = !!(conflict && conflict.ok === false && conflict.conflict === true && kept === 'external' && forced && forced.ok === true && fs.readFileSync(file, 'utf8') === 'mine');
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch (e) {
      checks.fileWriteConflictGuard = false;
      log('file write conflict assertion failed', String((e && e.message) || e));
    }
    // R188：存储统计覆盖回收站/备份/检查点，回收站支持分页
    try {
      const st = await mainWindow.webContents.executeJavaScript('window.shell.storageStats()');
      checks.storageStatsComplete = !!(st && typeof st.sessionsBytes === 'number' && typeof st.trashBytes === 'number' && typeof st.backupBytes === 'number' && typeof st.checkpointBytes === 'number' && st.totalBytes >= st.sessionsBytes + st.trashBytes + st.backupBytes + st.checkpointBytes);
    } catch (e) {
      checks.storageStatsComplete = false;
      log('storage stats assertion failed', String((e && e.message) || e));
    }
    try {
      const made = [];
      for (let i = 0; i < 25; i++) {
        const f = 'qcode-pagination-' + Date.now() + '-' + i + '.json';
        fs.writeFileSync(path.join(TRASH_DIR, f), JSON.stringify({ id: 's_probe', title: 'probe ' + i, messages: [] }));
        made.push(f);
      }
      const first = await mainWindow.webContents.executeJavaScript('window.shell.sessions.trashList(0, 20)');
      const second = await mainWindow.webContents.executeJavaScript('window.shell.sessions.trashList(20, 20)');
      checks.trashPagination = !!(first && first.ok && first.items.length === 20 && first.hasMore && second && second.ok && second.items.length > 0 && first.total >= 25);
      for (const f of made) fs.rmSync(path.join(TRASH_DIR, f), { force: true });
    } catch (e) {
      checks.trashPagination = false;
      log('trash pagination assertion failed', String((e && e.message) || e));
    }
    // R189：文件搜索达到上限时返回 complete=false 与原因
    try {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qcode-search-partial-'));
      for (let i = 0; i < 65; i++) fs.writeFileSync(path.join(tmp, 'needle-' + i + '.txt'), 'x');
      const first = await mainWindow.webContents.executeJavaScript('window.shell.searchFiles(' + JSON.stringify(tmp) + ", 'needle')");
      const cached = await mainWindow.webContents.executeJavaScript('window.shell.searchFiles(' + JSON.stringify(tmp) + ", 'needle')");
      checks.fileSearchPartial = !!(first && first.ok && first.entries.length === 60 && first.complete === false && first.reason === 'result-limit' && cached && cached.cached && cached.complete === false);
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch (e) {
      checks.fileSearchPartial = false;
      log('file search partial assertion failed', String((e && e.message) || e));
    }
    // R190：连接/端点测试统一私网显式授权策略
    try {
      const policy = {
        local: await isSafeTestEndpoint('http://127.0.0.1:3425/v1'),
        privateBlocked: await isSafeTestEndpoint('http://192.168.1.20/v1', false),
        privateAllowed: await isSafeTestEndpoint('http://192.168.1.20/v1', true),
        metadataBlocked: await isSafeTestEndpoint('http://169.254.169.254/latest', true),
        mappedLoopbackBlocked: !await isSafeTestEndpoint('http://[::ffff:127.0.0.1]/', true),
        mappedPrivateBlocked: !await isSafeTestEndpoint('http://[::ffff:192.168.1.20]/', false),
      };
      const endpoint = await mainWindow.webContents.executeJavaScript("window.shell.config.test({ baseUrl: 'http://192.168.1.20/v1', allowPrivate: false })");
      const model = await mainWindow.webContents.executeJavaScript("window.shell.config.testModel({ baseUrl: 'http://192.168.1.20/v1', modelId: 'x', allowPrivate: false })");
      const realLookup = dns.promises.lookup;
      let dnsBlocked = false;
      dns.promises.lookup = async () => [{ address: '169.254.169.254', family: 4 }];
      try {
        dnsBlocked = !await isSafeTestEndpoint('http://public.example.test/v1', true);
      } finally {
        dns.promises.lookup = realLookup;
      }
      checks.endpointPolicyUnified = !!(policy.local && !policy.privateBlocked && policy.privateAllowed && !policy.metadataBlocked && policy.mappedLoopbackBlocked && policy.mappedPrivateBlocked && dnsBlocked && endpoint && endpoint.ok === false && model && model.ok === false && /不安全/.test(endpoint.error || '') && /不安全/.test(model.error || ''));
    } catch (e) {
      checks.endpointPolicyUnified = false;
      log('endpoint policy assertion failed', String((e && e.message) || e));
    }
    // R191：Goal 新工作轮/校验启动前统一 token 预算门禁
    try {
      const r = await mainWindow.webContents.executeJavaScript(`
        (function () {
          const keepSessions = state.sessions;
          const keepCurrent = state.current;
          const prevBegin = beginTurn;
          let calls = 0;
          const s = { id: 's_goal_budget', title: 'budget', cwd: '.', messages: [], createdAt: 1, updatedAt: 1,
            goal: { status: 'active', round: 1, tokensUsed: 100, tokenBudget: 100, objective: 'test', rounds: [], verifications: [] } };
          try {
            state.sessions = keepSessions.concat([s]);
            state.current = s;
            beginTurn = () => { calls++; return true; };
            startGoalRound(s, null);
            const roundBlocked = s.goal.status === 'blocked' && s.goal.blockedReason.code === 'token-budget';
            s.goal.status = 'active';
            s.goal.blockedReason = null;
            startGoalVerify(s);
            return { calls: calls, roundBlocked: roundBlocked, verifyBlocked: s.goal.status === 'blocked' && !s.goal.verifying };
          } finally {
            beginTurn = prevBegin;
            state.sessions = keepSessions;
            state.current = keepCurrent;
          }
        })()
      `);
      checks.goalBudgetGate = !!(r && r.calls === 0 && r.roundBlocked && r.verifyBlocked);
    } catch (e) {
      checks.goalBudgetGate = false;
      log('goal budget assertion failed', String((e && e.message) || e));
    }
    // R193：瘦身前完整备份，截断落盘后可验证原输出仍在备份
    try {
      const id = 's_slim_backup_probe';
      const original = 'x'.repeat(40000);
      saveSession({ id, title: 'slim', cwd: '.', createdAt: 1, updatedAt: 1, messages: [{ role: 'assistant', blocks: [{ type: 'tool', name: 'shell', state: 'done', input: {}, output: original }] }] });
      flushSessionSave(id);
      const r = await mainWindow.webContents.executeJavaScript('window.shell.sessions.slim(' + JSON.stringify(id) + ')');
      const disk = JSON.parse(fs.readFileSync(sessionFile(id), 'utf8'));
      const backup = r && r.backup ? JSON.parse(fs.readFileSync(r.backup, 'utf8')) : null;
      checks.slimSafetyBackup = !!(r && r.ok && r.saved > 0 && r.backup && disk.messages[0].blocks[0].truncated && disk.messages[0].blocks[0].output.length < 40000 && backup && backup.sessions[0].messages[0].blocks[0].output === original);
      if (r && r.backup) fs.rmSync(r.backup, { force: true });
      deleteSessionFile(id);
    } catch (e) {
      checks.slimSafetyBackup = false;
      log('slim backup assertion failed', String((e && e.message) || e));
    }
    // R194：同时展示暂存区与工作区差异
    try {
      const { execFileSync } = require('node:child_process');
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qcode-git-dual-'));
      const git = (args) => execFileSync('git', ['-C', tmp, ...args], { stdio: 'ignore' });
      git(['init']);
      git(['config', 'user.email', 'probe@example.test']);
      git(['config', 'user.name', 'probe']);
      fs.writeFileSync(path.join(tmp, 'a.txt'), 'base\n');
      git(['add', 'a.txt']);
      git(['commit', '-m', 'base']);
      fs.writeFileSync(path.join(tmp, 'a.txt'), 'staged-change\n');
      git(['add', 'a.txt']);
      fs.writeFileSync(path.join(tmp, 'a.txt'), 'worktree-change\n');
      const r = await mainWindow.webContents.executeJavaScript('window.shell.gitDiff(' + JSON.stringify(tmp) + ", 'a.txt', true)");
      checks.gitDualDiff = !!(r && r.ok && r.diff.includes('暂存区') && r.diff.includes('工作区') && r.diff.includes('staged-change') && r.diff.includes('worktree-change'));
      try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* Windows Git 对象可能短暂锁定，不阻断断言 */ }
    } catch (e) {
      checks.gitDualDiff = false;
      log('git dual diff assertion failed', String((e && e.message) || e));
    }
    // R195：检查点清理忙碌保护与空间回收
    try {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qcode-cp-clean-'));
      fs.writeFileSync(path.join(tmp, 'a.txt'), 'x');
      const sid = 's_cp_clean_probe';
      const cp = await mainWindow.webContents.executeJavaScript('window.shell.checkpoint.create(' + JSON.stringify(sid) + ', ' + JSON.stringify(tmp) + ')');
      agents.set(sid, { busy: true });
      const busy = await mainWindow.webContents.executeJavaScript('window.shell.checkpoint.deleteAll(' + JSON.stringify(sid) + ')');
      const still = await mainWindow.webContents.executeJavaScript('window.shell.checkpoint.list(' + JSON.stringify(sid) + ')');
      agents.get(sid).busy = false;
      const cleared = await mainWindow.webContents.executeJavaScript('window.shell.checkpoint.deleteAll(' + JSON.stringify(sid) + ')');
      const after = await mainWindow.webContents.executeJavaScript('window.shell.checkpoint.list(' + JSON.stringify(sid) + ')');
      checks.checkpointCleanupGuard = !!(cp && cp.ok && busy && busy.ok === false && still && still.items.length === 1 && cleared && cleared.ok && after && after.items.length === 0);
      agents.delete(sid);
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp cleanup */ }
    } catch (e) {
      checks.checkpointCleanupGuard = false;
      log('checkpoint cleanup assertion failed', String((e && e.message) || e));
    }
    // R196：备份恢复为非破坏性副本，兼容旧数组与 wrapped 格式
    try {
      const old = parseBackupSessions(JSON.stringify([{ id: 's_old', title: 'old', messages: [] }]));
      const wrapped = parseBackupSessions(JSON.stringify({ __backup: true, truncated: true, total: 2, saved: 1, sessions: [{ id: 's_new', title: 'new', messages: [] }] }));
      const id = 's_backup_restore_probe';
      const source = { id, title: 'source', cwd: '.', messages: [{ role: 'user', text: 'history', ts: 1 }], createdAt: 1, updatedAt: 1 };
      saveSession(source);
      flushSessionSave(id);
      const r = await mainWindow.webContents.executeJavaScript('window.shell.sessions.backupRestore(' + JSON.stringify([source]) + ')');
      const copy = r && r.sessions && r.sessions[0];
      checks.backupRestoreCopy = !!(old && old.sessions.length === 1 && wrapped && wrapped.truncated && wrapped.saved === 1 && r && r.ok && copy && copy.id !== id && copy.title.includes('恢复副本') && fs.existsSync(sessionFile(copy.id)) && fs.existsSync(sessionFile(id)));
      if (copy) deleteSessionFile(copy.id);
      deleteSessionFile(id);
    } catch (e) {
      checks.backupRestoreCopy = false;
      log('backup restore assertion failed', String((e && e.message) || e));
    }
    // R197：异步 Notification.failed 必须传播为 false
    try {
      const FakeNotification = class {
        constructor() {}
        on() {}
        once(event, cb) { if (event === 'failed') setTimeout(cb, 10); }
        show() {}
      };
      FakeNotification.isSupported = () => true;
      const result = await notifyWithFailureWindow('probe', 'probe', FakeNotification);
      checks.notifyAsyncFailure = result === false;
    } catch (e) {
      checks.notifyAsyncFailure = false;
      log('notify async assertion failed', String((e && e.message) || e));
    }
    // R198：消息列宽同时影响设置页正文
    try {
      const r = await mainWindow.webContents.executeJavaScript(`
        (function () {
          const prev = document.documentElement.style.getPropertyValue('--content-w');
          try {
            document.documentElement.style.setProperty('--content-w', '600px');
            const body = document.getElementById('settingsPage').querySelector('.cfg-body');
            const max = body ? parseFloat(getComputedStyle(body).maxWidth) : 0;
            return { max: max, width: body ? body.getBoundingClientRect().width : 0 };
          } finally {
            if (prev) document.documentElement.style.setProperty('--content-w', prev);
            else document.documentElement.style.removeProperty('--content-w');
          }
        })()
      `);
      checks.settingsWidthApplied = !!(r && r.max >= 600 && r.max <= 650);
    } catch (e) {
      checks.settingsWidthApplied = false;
      log('settings width assertion failed', String((e && e.message) || e));
    }
    // R200：清空会话前写盘失败必须整体取消
    try {
      const id = 's_clear_flush_probe';
      saveSession({ id, title: 'clear', cwd: '.', messages: [], createdAt: 1, updatedAt: 1 });
      flushSessionSave(id);
      const realWrite = fs.writeFileSync;
      fs.writeFileSync = (p, data, enc) => {
        if (String(p).includes(id)) { const e = new Error('ENOSPC'); e.code = 'ENOSPC'; throw e; }
        return realWrite(p, data, enc);
      };
      saveSession({ id, title: 'clear', cwd: '.', messages: [], createdAt: 1, updatedAt: 1 });
      let r = null;
      try {
        r = await mainWindow.webContents.executeJavaScript('window.shell.sessions.clear()');
      } finally {
        fs.writeFileSync = realWrite;
      }
      checks.clearFlushGate = !!(r && r.ok === false && r.removed === 0 && r.pendingIds.includes(id) && fs.existsSync(sessionFile(id)));
      dropSessionSave(id);
      deleteSessionFile(id);
    } catch (e) {
      checks.clearFlushGate = false;
      log('clear flush assertion failed', String((e && e.message) || e));
    }
    // R202：Markdown 工具输出截断必须可见
    try {
      const r = await mainWindow.webContents.executeJavaScript(`
        (function () {
          const md = sessionToMarkdown({ title: 'md', messages: [{ role: 'assistant', blocks: [{ type: 'tool', name: 'shell', state: 'done', input: {}, output: 'x'.repeat(1300), outputLen: 5000 }] }] });
          return { marker: md.includes('输出已截断'), len: md.includes('5000') };
        })()
      `);
      checks.markdownToolTruncation = !!(r && r.marker && r.len);
    } catch (e) {
      checks.markdownToolTruncation = false;
      log('markdown truncation assertion failed', String((e && e.message) || e));
    }
    // R203：HTML 截断提示与 PDF 阅读版缺失说明
    try {
      const r = await mainWindow.webContents.executeJavaScript(`
        (function () {
          const s = { title: 'bounds', messages: [{ role: 'assistant', blocks: [
            { type: 'thinking', text: 'thinking-body' },
            { type: 'tool', name: 'shell', state: 'done', input: { x: 'a'.repeat(5000) }, output: 'b'.repeat(21000), outputLen: 30000 },
          ] }] };
          const html = sessionToHtmlFile(s);
          const slim = sessionToHtmlFile({ title: 'slim', messages: [{ role: 'assistant', blocks: [{ type: 'tool', name: 'shell', state: 'done', input: {}, output: 'short', outputLen: 50000 }] }] });
          const pdf = sessionToPrintHtml(s, { from: 0, to: 0 });
          return { think: html.includes('thinking-body'), inputCut: html.includes('入参已截断'), outputCut: html.includes('原长 30000'), slimCut: slim.includes('原长 50000'), pdfNote: pdf.includes('PDF 为阅读版') && pdf.includes('工具输出') };
        })()
      `);
      checks.exportBoundaryNotices = !!(r && r.think && r.inputCut && r.outputCut && r.slimCut && r.pdfNote);
    } catch (e) {
      checks.exportBoundaryNotices = false;
      log('export boundary assertion failed', String((e && e.message) || e));
    }
    // R206：工具输出/diff HTML 缓存有界，工具密集长会话不无限保留
    try {
      const r = await mainWindow.webContents.executeJavaScript(`
        (function () {
          toolOutHtmlCache.clear();
          toolDiffCache.clear();
          for (let i = 0; i < 450; i++) {
            toolOutHtml({ name: 'shell', output: 'x'.repeat(2000), state: 'done' });
            toolDiffHtml({ name: 'write_file', input: { content: 'y'.repeat(1000) } });
          }
          return { outSize: toolOutHtmlCache.size, diffSize: toolDiffCache.size, outWeight: toolOutHtmlCache.__weight, diffWeight: toolDiffCache.__weight };
        })()
      `);
      checks.toolHtmlCachesBounded = !!(r && r.outSize <= 400 && r.diffSize <= 400 && r.outWeight <= 32 * 1024 * 1024 && r.diffWeight <= 16 * 1024 * 1024);
    } catch (e) {
      checks.toolHtmlCachesBounded = false;
      log('tool html cache assertion failed', String((e && e.message) || e));
    }
    // R208：技能元数据缓存有界，目录轮换不保留旧内容
    try {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qcode-skill-cache-'));
      for (let i = 0; i < 210; i++) {
        const dir = path.join(tmp, 'skill-' + i);
        fs.mkdirSync(dir);
        fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: skill ' + i + '\ndescription: probe\n---\n' + 'x'.repeat(1000));
        await readSkillMetaCached(dir, 'skill-' + i);
      }
      checks.skillMetaCacheBounded = skillMetaCache.size <= 200 && !skillMetaCache.has(path.join(tmp, 'skill-0'));
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch (e) {
      checks.skillMetaCacheBounded = false;
      log('skill cache assertion failed', String((e && e.message) || e));
    }
    // R210：回合等待超时后必须移除 waiter，避免失效闭包累积
    try {
      const before = turnWaiters.length;
      const result = await waitForTurn(5);
      checks.turnWaiterCleanup = result === false && turnWaiters.length === before;
    } catch (e) {
      checks.turnWaiterCleanup = false;
      log('turn waiter assertion failed', String((e && e.message) || e));
    }
    // R211：同长度快速编辑也必须能回滚（纳秒时间戳防毫秒误判）
    try {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qcode-cp-ns-'));
      const file = path.join(tmp, 'same.txt');
      fs.writeFileSync(file, 'aaaa');
      const sid = 's_cp_ns_probe';
      const cp = await mainWindow.webContents.executeJavaScript('window.shell.checkpoint.create(' + JSON.stringify(sid) + ', ' + JSON.stringify(tmp) + ')');
      fs.writeFileSync(file, 'bbbb');
      const rr = await mainWindow.webContents.executeJavaScript('window.shell.checkpoint.restore(' + JSON.stringify(sid) + ', ' + JSON.stringify(cp.id) + ', ' + JSON.stringify(tmp) + ', false)');
      checks.checkpointNanosecondGuard = !!(cp && cp.ok && rr && rr.ok && fs.readFileSync(file, 'utf8') === 'aaaa');
      await mainWindow.webContents.executeJavaScript('window.shell.checkpoint.deleteAll(' + JSON.stringify(sid) + ')');
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch (e) {
      checks.checkpointNanosecondGuard = false;
      log('checkpoint nanosecond assertion failed', String((e && e.message) || e));
    }
    // R212：检查点目录读取失败必须标记不完整
    try {
      const walked = { files: [], bytes: 0, truncated: false };
      await walkWorkspaceForCheckpoint(path.join(os.tmpdir(), 'qcode-definitely-missing-' + Date.now()).replace(/\\/g, '/'), path.join(os.tmpdir(), 'qcode-definitely-missing-' + Date.now()).replace(/\\/g, '/'), walked, 0);
      checks.checkpointScanFailure = !!(walked.truncated && walked.failed === 1);
    } catch (e) {
      checks.checkpointScanFailure = false;
      log('checkpoint scan assertion failed', String((e && e.message) || e));
    }
    // R215：无工作目录时项目指令操作全部禁用
    try {
      const r = await mainWindow.webContents.executeJavaScript(`
        (async function () {
          const keepCurrent = state.current;
          const keepExtras = state.extras;
          const keepSection = cfgSection;
          try {
            state.current = { id: 's_no_cwd', title: 'no cwd', messages: [] };
            state.extras = { memory: { path: '', content: '', size: 0, mtime: 0 } };
            await openSettings();
            setCfgSection('memory');
            return { save: document.getElementById('projSave').disabled, open: document.getElementById('projOpen').disabled, restore: document.getElementById('projRestore').disabled };
          } finally {
            state.current = keepCurrent;
            state.extras = keepExtras;
            cfgSection = keepSection;
            await closeSettings();
          }
        })()
      `);
      checks.projectNoCwdDisabled = !!(r && r.save && r.open && r.restore);
    } catch (e) {
      checks.projectNoCwdDisabled = false;
      log('project no cwd assertion failed', String((e && e.message) || e));
    }
    // R216：项目折叠按钮必须真实可切换
    try {
      const r = await mainWindow.webContents.executeJavaScript(`
        (function () {
          const prev = state.projectsCollapsed;
          const btn = document.getElementById('btnProjectsToggle');
          try {
            state.projectsCollapsed = false;
            applyProjectsCollapsed();
            btn.click();
            const collapsed = state.projectsCollapsed && document.getElementById('projectWrap').classList.contains('collapsed') && btn.getAttribute('aria-expanded') === 'false';
            btn.click();
            const expanded = !state.projectsCollapsed && !document.getElementById('projectWrap').classList.contains('collapsed') && btn.getAttribute('aria-expanded') === 'true';
            return { collapsed: collapsed, expanded: expanded };
          } finally {
            state.projectsCollapsed = prev;
            applyProjectsCollapsed();
          }
        })()
      `);
      checks.projectsToggle = !!(r && r.collapsed && r.expanded);
    } catch (e) {
      checks.projectsToggle = false;
      log('projects toggle assertion failed', String((e && e.message) || e));
    }
    // R217：脱敏配置预览 API 已接入且不暴露密钥
    try {
      const r = await mainWindow.webContents.executeJavaScript("window.shell.config.exportPreview({ includeKeys: false })");
      checks.configExportPreview = !!(r && r.ok && r.includeKeys === false && typeof r.content === 'string' && r.content.length > 0);
    } catch (e) {
      checks.configExportPreview = false;
      log('config preview assertion failed', String((e && e.message) || e));
    }
    // R220：端点测试禁止自动重定向，防二次跳转绕过地址策略
    try {
      const realFetch = global.fetch;
      let redirectMode = '';
      global.fetch = async (_url, opts) => {
        redirectMode = opts && opts.redirect;
        return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ data: [] }) };
      };
      try {
        await mainWindow.webContents.executeJavaScript("window.shell.config.test({ baseUrl: 'http://127.0.0.1:1/v1', allowPrivate: true })");
      } finally {
        global.fetch = realFetch;
      }
      checks.endpointRedirectBlocked = redirectMode === 'error';
    } catch (e) {
      checks.endpointRedirectBlocked = false;
      log('endpoint redirect assertion failed', String((e && e.message) || e));
    }
    log('smoke feature checks', JSON.stringify(checks));
        if (typeof checks.goalSuite !== 'boolean') {
          console.log('[smoke] goalSuite returned non-boolean:', typeof checks.goalSuite);
          checks.goalSuite = false;
        }
    console.log('[smoke] features:', JSON.stringify(checks));
    console.log('[smoke] goal suite:', checks.goalSuite ? 'ok' : 'FAILED');
    try {
      const dbg = await mainWindow.webContents.executeJavaScript(
        'JSON.stringify({failed: window.__goalSuiteFailed || null, parts: window.__goalSuiteParts || null, nonBool: window.__goalSuiteNonBool || null})'
      );
      const parsed = JSON.parse(dbg);
      if (parsed.failed) console.log('[smoke] goalSuite failed parts:', parsed.failed.join(','));
      if (parsed.nonBool && parsed.nonBool.length) console.log('[smoke] goalSuite non-boolean:', parsed.nonBool.join(','));
    } catch (e) {
      console.log('[smoke] goalSuite parts unavailable:', String(e).slice(0, 120));
    }
    checks.effortApplied = mainEffortOk;
    checks.providerTestAll = providerAllOk;
    log('smoke effort applied final', String(checks.effortApplied));
    try {
      for (const f of fs.readdirSync(window.__qcodeDevWs)) {
        if (/^(_probe-write\.txt|_cp-probe-new)/.test(f)) {
          try { fs.unlinkSync(path.join(window.__qcodeDevWs, f)); } catch { /* 无妨 */ }
        }
      }
    } catch {
      /* 探针文件不存在也无妨 */
    }

    // 面板关闭时 renderAll 不应在后台触发文件树请求
    fsListRequests = 0;
    await mainWindow.webContents.executeJavaScript(
      "state.panelOpen=false; state.panelTab='files'; state.fileTree=null; renderAll();"
    );
    await wait(150);
    checks.panelIdle = fsListRequests === 0;
    log('smoke panel idle', 'listDir', fsListRequests, 'ok', String(checks.panelIdle));
    console.log('[smoke] panel idle: listDir=' + fsListRequests, checks.panelIdle ? 'ok' : 'FAILED');
    checks.sessionsAsync = loadSessions.constructor.name === 'AsyncFunction';
    log('smoke sessions async', String(checks.sessionsAsync));
    console.log('[smoke] sessions async:', checks.sessionsAsync ? 'ok' : 'FAILED');
    checks.usageAsync = aggregateUsage.constructor.name === 'AsyncFunction';
    log('smoke usage async', String(checks.usageAsync));
    console.log('[smoke] usage async:', checks.usageAsync ? 'ok' : 'FAILED');
    checks.fsIoAsync =
      listDirectory.constructor.name === 'AsyncFunction' &&
      readWorkspaceFile.constructor.name === 'AsyncFunction';
    log('smoke fs io async', String(checks.fsIoAsync));
    console.log('[smoke] fs io async:', checks.fsIoAsync ? 'ok' : 'FAILED');
    checks.aboutIoAsync =
      dirSize.constructor.name === 'AsyncFunction' &&
      listTrashItems.constructor.name === 'AsyncFunction';
    log('smoke about io async', String(checks.aboutIoAsync));
    console.log('[smoke] about io async:', checks.aboutIoAsync ? 'ok' : 'FAILED');
    checks.extrasAsync =
      getExtrasPayload.constructor.name === 'AsyncFunction' &&
      readSkillMetaCached.constructor.name === 'AsyncFunction';
    log('smoke extras async', String(checks.extrasAsync));
    console.log('[smoke] extras async:', checks.extrasAsync ? 'ok' : 'FAILED');
    await mainWindow.webContents.executeJavaScript(
      "state.panelTab='activity'; state.fileTree=null;"
    );

    // 会话写入合并：快速 persist 多次只发一次 IPC、只落盘一次，且保留最后一次内容
    const ioPrev = await mainWindow.webContents.executeJavaScript(
      'state.current ? state.current.id : ""'
    );
    sessionSaveRequests = 0;
    sessionWriteCount = 0;
    sessionSerializeCount = 0;
    let ioWrites = 0;
    const origWriteFileSync = fs.writeFileSync;
    let ioId = '';
    let io = null;
    fs.writeFileSync = function (file, ...rest) {
      if (ioId && typeof file === 'string' && file.includes(ioId) && file.endsWith('.tmp')) {
        ioWrites++;
      }
      return origWriteFileSync.call(fs, file, ...rest);
    };
    try {
      io = await mainWindow.webContents.executeJavaScript(`
        (() => {
          const s = newSession(window.__qcodeDevWs);
          s.smoke = true;
          s.title = 'IO-0';
          persist(s);
          for (let i = 1; i <= 20; i++) { s.title = 'IO-' + i; persist(s); }
          return { id: s.id };
        })()
      `);
      ioId = io.id;
      await wait(500);
      const ioList = await mainWindow.webContents.executeJavaScript(
        'window.shell.sessions.list()'
      );
      const ioGot = (ioList || []).find((x) => x.id === io.id);
      let ioCompact = false;
      try {
        const raw = fs.readFileSync(path.join(DATA_DIR, io.id + '.json'), 'utf8');
        ioCompact = raw[0] === '{' && !raw.includes(String.fromCharCode(10) + '  "');
      } catch {
        /* 读取失败即断言失败 */
      }
      checks.sessionIoCoalesce = sessionSaveRequests <= 2 && ioWrites === 1;
      // 序列化也合并：21 次 persist 只 stringify 一次（此前每次都 stringify 整段会话）
      checks.sessionSerializeCoalesce = sessionSerializeCount === 1;
      checks.sessionIoLatest = !!(ioGot && ioGot.title === 'IO-20');
      checks.sessionIoCompact = ioCompact;
      log(
        'smoke session io',
        'requests',
        sessionSaveRequests,
        'writes',
        ioWrites,
        'serializes',
        sessionSerializeCount,
        'title',
        ioGot && ioGot.title,
        'compact',
        ioCompact
      );
      console.log(
        '[smoke] session io:',
        'requests=' + sessionSaveRequests,
        'writes=' + ioWrites,
        'serializes=' + sessionSerializeCount,
        'title=' + (ioGot && ioGot.title),
        'compact=' + ioCompact
      );
      await mainWindow.webContents.executeJavaScript(`
        (() => {
          cancelPersist('${io.id}');
          state.sessions = state.sessions.filter((x) => x.id !== '${io.id}');
          if (state.current && state.current.id === '${io.id}') {
            state.current = state.sessions[0] || null;
          }
          renderAll();
          return true;
        })()
      `);
      dropSessionSave(io.id);
      try {
        fs.unlinkSync(path.join(DATA_DIR, io.id + '.json'));
      } catch {
        /* 清理尽力而为 */
      }
    } finally {
      fs.writeFileSync = origWriteFileSync;
      if (ioPrev) {
        await mainWindow.webContents.executeJavaScript(
          "switchSession('" + ioPrev + "')"
        );
      }
    }

    // 关于页（日志查看器）截图
    await mainWindow.webContents.executeJavaScript(
      "openSettings().then(() => setCfgSection('about'))"
    );
    await wait(900);
    await mainWindow.webContents.capturePage().then((img) => {
      fs.writeFileSync(path.join(shotDir, '09f-about.png'), img.toPNG());
    });
    await mainWindow.webContents.executeJavaScript("closeSettings()");

    // 文件预览/编辑弹层截图
    const modalSample = JSON.stringify(
      { name: 'qwen-agent-shell', version: '0.3.0', main: 'main.js' },
      null,
      2
    );
    await mainWindow.webContents.executeJavaScript(
      `showTextModal('package.json · 编辑模式', ${JSON.stringify(modalSample)}, { editRoot: window.__qcodeDevWs, editRel: 'package.json' }); document.querySelector('.text-modal-mask [data-edit]').click();`
    );
    await wait(400);
    await mainWindow.webContents.capturePage().then((img) => {
      fs.writeFileSync(path.join(shotDir, '09g-editor.png'), img.toPNG());
    });
    await mainWindow.webContents.executeJavaScript(
      "(() => { const b = document.querySelector('.text-modal-mask [data-close]'); if (b) b.click(); })()"
    );

    // 文件面板截图
    await mainWindow.webContents.executeJavaScript(
      "state.panelTab='files'; state.panelOpen=true; document.getElementById('panel').classList.add('show'); syncPanelTabs(); renderPanel();"
    );
    await wait(700);
    await mainWindow.webContents.capturePage().then((img) => {
      fs.writeFileSync(path.join(shotDir, '15-files.png'), img.toPNG());
    });
    await mainWindow.webContents.executeJavaScript(
      "state.panelTab='activity'; syncPanelTabs(); renderPanel();"
    );

    // Git 面板截图（用真实仓库）
    const prevGit = await mainWindow.webContents.executeJavaScript(
      "(() => { const prev = state.current && state.current.id; const s = newSession(window.__qcodeDevWs); s.title = 'Git 测试'; s.smoke = true; renderAll(); persist(s); state.panelOpen = true; state.panelTab = 'git'; document.getElementById('panel').classList.add('show'); syncPanelTabs(); renderPanel(); return prev; })()"
    );
    await wait(1400);
    await mainWindow.webContents.capturePage().then((img) => {
      fs.writeFileSync(path.join(shotDir, '16-git.png'), img.toPNG());
    });
    await mainWindow.webContents.executeJavaScript(
      "state.panelTab='activity'; syncPanelTabs(); renderPanel();" + (prevGit ? "switchSession('" + prevGit + "')" : '')
    );

    // 全局热键注册/注销链路（退出前有 will-quit 兜底 unregisterAll）
    // R73（监工D）：先读原 hotkey，探针后还原——固定回写 '' 会清掉用户真实 prefs 的自定义热键
    const hkBefore = await mainWindow.webContents.executeJavaScript(
      'window.shell.prefs.get().then((p) => p.hotkey || "")'
    );
    const hk = await mainWindow.webContents.executeJavaScript(
      "window.shell.prefs.save({ hotkey: 'Control+Alt+Q' }).then((r) => r.hotkey)"
    );
    log('smoke hotkey register', JSON.stringify(hk));
    console.log('[smoke] hotkey:', hk && hk.registered ? 'ok' : 'FAILED');
    await mainWindow.webContents.executeJavaScript(
      "window.shell.prefs.save({ hotkey: " + JSON.stringify(hkBefore || '') + " })"
    );

    // 渲染层错误上报链路
    await mainWindow.webContents.executeJavaScript(
      "window.shell.reportError({ message: 'smoke-renderer-error-probe', stack: 'probe' })"
    );
    const rendererLogOk = fs.readFileSync(LOG_FILE, 'utf8').includes('smoke-renderer-error-probe');
    console.log('[smoke] renderer error log:', rendererLogOk ? 'ok' : 'FAILED');

    // 后台会话：发送后立刻切走，验证回合不中断、完成后标记未读
    const bg = await mainWindow.webContents.executeJavaScript(`
      (() => {
        const prev = state.current && state.current.id;
        const s = newSession(state.defaultCwd);
        s.title = '后台测试';
        s.smoke = true;
        renderAll();
        persist(s);
        document.getElementById('input').value = '只回复两个字：完成';
        send();
        if (prev) switchSession(prev);
        return { id: s.id, prev };
      })()
    `);
    const bgDoneExpr = `(() => {
         const s = state.sessions.find((x) => x.id === '${bg.id}');
         const r = state.runtimes.get('${bg.id}');
         return !!(s && r && !r.busy && (s.messages || []).some(
           (m) => m.role === 'assistant' && (m.blocks || []).some((b) => b.type === 'text')
         ));
       })()`;
    let bgOk = await until(bgDoneExpr, 90000);
    if (!bgOk) {
      // 模型网关偶发无响应：中断后重试一次，避免把网关抖动当成功能回归
      log('smoke background retry');
      await mainWindow.webContents.executeJavaScript(`
        (async () => {
          try {
            await window.shell.chat.interrupt('${bg.id}');
          } catch {}
          await new Promise((r) => setTimeout(r, 2500));
          switchSession('${bg.id}');
          document.getElementById('input').value = '只回复两个字：完成';
          send();
          ${bg.prev ? `switchSession('${bg.prev}');` : ''}
        })()
      `);
      bgOk = await until(bgDoneExpr, 90000);
    }
    const bgUnread = await mainWindow.webContents.executeJavaScript(
      `(() => { const r = state.runtimes.get('${bg.id}'); return !!(r && r.unread); })()`
    );
    const bgSideUnread = await mainWindow.webContents.executeJavaScript(
      "!!document.querySelector('#sessionList .unread-dot')"
    );
    log('smoke background', String(bgOk), 'unread', String(bgUnread), 'sidebar', String(bgSideUnread));
    console.log(
      '[smoke] background:',
      bgOk ? 'ok' : 'FAILED',
      '| unread:',
      bgUnread,
      '| sidebar:',
      bgSideUnread
    );
    await mainWindow.webContents.capturePage().then((img) => {
      fs.writeFileSync(path.join(shotDir, '14-background.png'), img.toPNG());
    });

    // R54 视觉审查截图：R48-R53 新组件实拍（cp 弹窗 / Todo 任务条 + /todos 卡 + 回滚 marker / 预算进度条）
    try {
      const todayKeyMain = (() => {
        const d = new Date();
        return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      })();
      // ① 检查点弹窗：打开 + diff 行展开
      await mainWindow.webContents.executeJavaScript(`
        (async () => {
          const s = state.current;
          if (!s) return 'nosession';
          const savedCwd = s.cwd;
          s.cwd = window.__qcodeDevWs;
          const cl = await window.shell.checkpoint.list(s.id);
          if (!cl.ok || !cl.items.length) { s.cwd = savedCwd; return 'nocp'; }
          try {
            openCheckpointModal(s);
            const mask = document.querySelector('.cp-modal-mask');
            const diffBtn = mask.querySelector('.cp-foot [data-diff]');
            const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
            for (let i = 0; i < 40 && diffBtn && diffBtn.disabled; i++) await sleep(50);
            if (diffBtn && !diffBtn.disabled) {
              diffBtn.click();
              let rowBtn = null;
              for (let i = 0; i < 40 && !rowBtn; i++) {
                await sleep(50);
                rowBtn =
                  mask.querySelector('.cp-diff-row[data-rel="scripts/afterPack.js"]') ||
                  mask.querySelector('.cp-diff-row[data-rel="renderer/style.css"]') ||
                  mask.querySelector('.cp-diff-row');
              }
              if (rowBtn) { rowBtn.click(); await sleep(500); }
            }
          } finally {
            s.cwd = savedCwd; // R73 监工D：异常路径还原，防污染其后依赖 cwd 的探针
          }
          return 'ok';
        })()
      `);
      await wait(300);
      await mainWindow.webContents.capturePage().then((img) => {
        fs.writeFileSync(path.join(shotDir, '17-cpmodal.png'), img.toPNG());
      });
      await mainWindow.webContents.executeJavaScript(
        "(() => { const m = document.querySelector('.cp-modal-mask'); if (m) { const c = m.querySelector('[data-close]'); if (c) c.click(); } return 'ok'; })()"
      );
      // ② 线程内 /todos 卡 + 回滚 marker + Todo 任务条展开态（同屏）
      await mainWindow.webContents.executeJavaScript(`
        (() => {
          const s = state.current;
          if (!s) return 'nosession';
          s.messages.push(
            { role: 'system', todosView: { steps: [
              { status: 'completed', title: '梳理 ZCode rewind 语义' },
              { status: 'in_progress', title: '实现检查点弹窗逐文件 diff 预览' },
              { status: 'pending', title: '补齐 dev/安装版双冒烟断言' },
            ] }, ts: Date.now(), hidden: false },
            { role: 'system', cpRestore: { restored: 5, deleted: 2, at: Date.now() }, ts: Date.now(), hidden: false }
          );
          renderThread();
          const fake = { id: 'shot_todo_sid', smoke: true, title: '视觉审查', messages: [{ role: 'assistant', blocks: [{ type: 'tool', id: 'v1', name: 'todo_write', input: { todos: [
            { status: 'completed', content: '梳理 ZCode rewind 语义' },
            { status: 'in_progress', title: '', content: '实现检查点弹窗逐文件 diff 预览' },
            { status: 'pending', content: '补齐 dev/安装版双冒烟断言' },
          ] } }] }], updatedAt: Date.now() };
          window.__shotSavedCur = s;
          state.current = fake;
          renderTodoBar();
          const bar = document.getElementById('todoBar');
          if (bar && !bar.hidden && !bar.classList.contains('open')) {
            const h = bar.querySelector('.todo-bar-head');
            if (h) h.click(); // 仅未展开时点击（断言块可能已把 todoBarOpen 置 true，再点会收回）
          }
          return 'ok';
        })()
      `);
      await wait(300);
      await mainWindow.webContents.capturePage().then((img) => {
        fs.writeFileSync(path.join(shotDir, '18-todobar.png'), img.toPNG());
      });
      await mainWindow.webContents.executeJavaScript(`
        (() => {
          const s = window.__shotSavedCur || state.current;
          state.current = s;
          while (s.messages.length && s.messages[s.messages.length - 1].role === 'system') s.messages.pop();
          renderThread();
          renderTodoBar();
          return 'ok';
        })()
      `);
      // ③ 用量分区预算 warn 态进度条（先开面板加载真实 extras，再替换 fake 数据重绘）
      await mainWindow.webContents.executeJavaScript(`
        (async () => {
          openSettings();
          setCfgSection('usage');
          await new Promise((r) => setTimeout(r, 400));
          window.__shotSavedExtras = state.extras; // R73 监工D：此前从未赋值，恢复行是死代码
          state.extras = {
            prefs: { dailyBudgetTokens: 1000000 },
            usage: {
              sessions: 134, total: 15630000, input: 15300000, toolCalls: 1251,
              models: [{ name: 'group/auto-deepseek-v4-1-flash', requests: 1216, input: 15300000, output: 325800, total: 15630000 }],
              recent: [], path: '~/.qwen/usage_record.jsonl',
              weekly: [
                { date: '11-15', tokens: 1200, calls: 1 }, { date: '11-16', tokens: 5200000, calls: 300 },
                { date: '11-17', tokens: 2100000, calls: 120 }, { date: '11-18', tokens: 800, calls: 0 },
                { date: '11-19', tokens: 1500, calls: 1 }, { date: '11-20', tokens: 900, calls: 0 },
                { date: '${todayKeyMain.slice(5)}', tokens: 850000, calls: 20 },
              ],
            },
          };
          renderCfgSection();
          return 'ok';
        })()
      `);
      await wait(500);
      await mainWindow.webContents.capturePage().then((img) => {
        fs.writeFileSync(path.join(shotDir, '19-budget.png'), img.toPNG());
      });
      await mainWindow.webContents.executeJavaScript(`
        (() => {
          state.extras = window.__shotSavedExtras || state.extras;
          if (typeof closeSettings === 'function') closeSettings();
          return 'ok';
        })()
      `);
      // ④ markdown 富文本实拍（表格/引用/代码块/任务列表）
      await mainWindow.webContents.executeJavaScript(`
        (() => {
          const s = state.current;
          if (!s) return 'nosession';
          const fence = String.fromCharCode(96, 96, 96);
          const nl = String.fromCharCode(10);
          const md = [
            '| 模型 | 上下文 | 说明 |',
            '| --- | --- | --- |',
            '| DeepSeek V4.1 Flash | 128k | 默认模型，智能放行友好 |',
            '| GLM-5.3-Flash | 200k | 长上下文，代码评审更强 |',
            '',
            '> 引用一行：检查点每回合发送前自动创建，/rewind 可回滚。',
            '',
            fence + 'bash',
            'ls -dt -- */ | head -n 3',
            fence,
            '',
            '- [x] 已完成：检查点守卫四件套',
            '- [ ] 待办：usage 预算阈值提示',
          ].join(nl);
          window.__shotMdMsg = { role: 'assistant', blocks: [{ type: 'text', text: md }], ts: Date.now() };
          s.messages.push(window.__shotMdMsg);
          renderThread();
          return 'ok';
        })()
      `);
      await wait(400);
      await mainWindow.webContents.capturePage().then((img) => {
        fs.writeFileSync(path.join(shotDir, '20-mdtable.png'), img.toPNG());
      });
      await mainWindow.webContents.executeJavaScript(`
        (() => {
          const s = state.current;
          if (s && window.__shotMdMsg) {
            const i = s.messages.indexOf(window.__shotMdMsg);
            if (i >= 0) s.messages.splice(i, 1);
            renderThread();
          }
          return 'ok';
        })()
      `);
      // ⑤ 暗色主题下的新组件：/todos 卡 + 回滚 marker + Todo 任务条 + md 富文本（同屏）
      await mainWindow.webContents.executeJavaScript(`
        (() => {
          const s = state.current;
          if (!s) return 'nosession';
          setTheme('dark');
          const fence = String.fromCharCode(96, 96, 96);
          const nl = String.fromCharCode(10);
          const md = [
            '| 模型 | 上下文 | 说明 |',
            '| --- | --- | --- |',
            '| DeepSeek V4.1 Flash | 128k | 默认模型 |',
            '',
            '> 引用一行：检查点每回合自动创建。',
            '',
            '- [x] 已完成：暗色适配',
            '- [ ] 待办：预算提示核对',
          ].join(nl);
          window.__shotDarkMsg = { role: 'assistant', blocks: [{ type: 'text', text: md }], ts: Date.now() };
          s.messages.push(
            window.__shotDarkMsg,
            { role: 'system', todosView: { steps: [
              { status: 'completed', title: '梳理 ZCode rewind 语义' },
              { status: 'in_progress', title: '暗色主题实拍审查' },
              { status: 'pending', title: '修复发现的视觉缺陷' },
            ] }, ts: Date.now(), hidden: false },
            { role: 'system', cpRestore: { restored: 5, deleted: 2, at: Date.now() }, ts: Date.now(), hidden: false }
          );
          renderThread();
          const fake = { id: 'shot_dark_todo_sid', smoke: true, title: '暗色审查', messages: [{ role: 'assistant', blocks: [{ type: 'tool', id: 'v2', name: 'todo_write', input: { todos: [
            { status: 'completed', content: '梳理 ZCode rewind 语义' },
            { status: 'in_progress', content: '暗色主题实拍审查' },
            { status: 'pending', content: '修复发现的视觉缺陷' },
          ] } }] }], updatedAt: Date.now() };
          window.__shotSavedCurDark = s;
          state.current = fake;
          renderTodoBar();
          const bar = document.getElementById('todoBar');
          if (bar && !bar.hidden && !bar.classList.contains('open')) {
            const h = bar.querySelector('.todo-bar-head');
            if (h) h.click();
          }
          return 'ok';
        })()
      `);
      await wait(400);
      await mainWindow.webContents.capturePage().then((img) => {
        fs.writeFileSync(path.join(shotDir, '21-dark-thread.png'), img.toPNG());
      });
      await mainWindow.webContents.executeJavaScript(`
        (() => {
          const s = window.__shotSavedCurDark || state.current;
          state.current = s;
          while (s.messages.length && (s.messages[s.messages.length - 1].role === 'system' || s.messages[s.messages.length - 1] === window.__shotDarkMsg)) s.messages.pop();
          renderThread();
          renderTodoBar();
          return 'ok';
        })()
      `);
      // ⑥ 暗色检查点弹窗（cwd 警示 + diff 展开）
      await mainWindow.webContents.executeJavaScript(`
        (async () => {
          const s = state.current;
          if (!s) return 'nosession';
          const savedCwd = s.cwd;
          s.cwd = window.__qcodeDevWs;
          const cl = await window.shell.checkpoint.list(s.id);
          if (!cl.ok || !cl.items.length) { s.cwd = savedCwd; return 'nocp'; }
          try {
            openCheckpointModal(s);
            const mask = document.querySelector('.cp-modal-mask');
            const diffBtn = mask.querySelector('.cp-foot [data-diff]');
            const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
            for (let i = 0; i < 40 && diffBtn && diffBtn.disabled; i++) await sleep(50);
            if (diffBtn && !diffBtn.disabled) {
              diffBtn.click();
              let rowBtn = null;
              for (let i = 0; i < 40 && !rowBtn; i++) {
                await sleep(50);
                rowBtn = mask.querySelector('.cp-diff-row[data-rel="scripts/afterPack.js"]');
              }
              if (rowBtn) { rowBtn.click(); await sleep(500); }
            }
          } finally {
            s.cwd = savedCwd; // R73 监工D
          }
          return 'ok';
        })()
      `);
      await wait(300);
      await mainWindow.webContents.capturePage().then((img) => {
        fs.writeFileSync(path.join(shotDir, '22-dark-cpmodal.png'), img.toPNG());
      });
      await mainWindow.webContents.executeJavaScript(
        "(() => { const m = document.querySelector('.cp-modal-mask'); if (m) { const c = m.querySelector('[data-close]'); if (c) c.click(); } return 'ok'; })()"
      );
      // ⑦ 暗色预算 warn 进度条
      await mainWindow.webContents.executeJavaScript(`
        (async () => {
          window.__shotSavedExtrasDark = state.extras;
          openSettings();
          setCfgSection('usage');
          await new Promise((r) => setTimeout(r, 400));
          state.extras = {
            prefs: { dailyBudgetTokens: 1000000 },
            usage: {
              sessions: 134, total: 15630000, input: 15300000, toolCalls: 1251,
              models: [{ name: 'group/auto-deepseek-v4-1-flash', requests: 1216, input: 15300000, output: 325800, total: 15630000 }],
              recent: [], path: '~/.qwen/usage_record.jsonl',
              weekly: [
                { date: '11-15', tokens: 1200, calls: 1 }, { date: '11-16', tokens: 5200000, calls: 300 },
                { date: '11-17', tokens: 2100000, calls: 120 }, { date: '11-18', tokens: 800, calls: 0 },
                { date: '11-19', tokens: 1500, calls: 1 }, { date: '11-20', tokens: 900, calls: 0 },
                { date: '${todayKeyMain.slice(5)}', tokens: 850000, calls: 20 },
              ],
            },
          };
          renderCfgSection();
          return 'ok';
        })()
      `);
      await wait(500);
      await mainWindow.webContents.capturePage().then((img) => {
        fs.writeFileSync(path.join(shotDir, '23-dark-budget.png'), img.toPNG());
      });
      await mainWindow.webContents.executeJavaScript(`
        (() => {
          state.extras = window.__shotSavedExtrasDark || state.extras;
          if (typeof closeSettings === 'function') closeSettings();
          return 'ok';
        })()
      `);
      // ⑧ 暗色 toast 实拍（信息/成功两级）+ 关于页图标（R58）
      await mainWindow.webContents.executeJavaScript(`
        (() => {
          setTheme('dark');
          toast('每日预算', '今日已用 850.0K tokens，已达预算的 85%');
          setTimeout(() => toast('工作区已回滚', '还原 5 个文件，删除 2 个新增'), 150);
          openSettings();
          setCfgSection('about');
          return 'ok';
        })()
      `);
      await wait(500);
      await mainWindow.webContents.capturePage().then((img) => {
        fs.writeFileSync(path.join(shotDir, '24-dark-toast-about.png'), img.toPNG());
      });
      await mainWindow.webContents.executeJavaScript(`
        (() => {
          if (typeof closeSettings === 'function') closeSettings();
          setTheme('light');
          return 'ok';
        })()
      `);
      console.log('[smoke] visual shots: 17-cpmodal/18-todobar/19-budget/20-mdtable/21-23-dark/24-dark-toast');
      // ⑨ 上下文明细弹层实拍（R60 修复区域：占用口径 + 压缩按钮）
      await mainWindow.webContents.executeJavaScript(`
        (() => {
          const ring = document.getElementById('ctxRing');
          if (!ring) return 'noring';
          const prev = document.getElementById('ctxDetailPop');
          if (prev) prev.remove();
          ring.click();
          return 'ok';
        })()
      `);
      await wait(400);
      await mainWindow.webContents.capturePage().then((img) => {
        fs.writeFileSync(path.join(shotDir, '25-ctxdetail.png'), img.toPNG());
      });
      await mainWindow.webContents.executeJavaScript(
        "(() => { const p = document.getElementById('ctxDetailPop'); if (p) p.remove(); return 'ok'; })()"
      );
      // 有数据的弹层：fake ctxDetail（85% 占用，验证分类色带与警示条渲染）
      await mainWindow.webContents.executeJavaScript(`
        (() => {
          state.ctxDetail = {
            model: 'DeepSeek V4.1 Flash',
            used: 850000, limit: 1000000, pct: 85,
            messages: 24, turns: 6,
          };
          const ring = document.getElementById('ctxRing');
          if (!ring) return 'noring';
          showContextDetail(ring);
          return 'ok';
        })()
      `);
      await wait(400);
      await mainWindow.webContents.capturePage().then((img) => {
        fs.writeFileSync(path.join(shotDir, '26-ctxdetail-warn.png'), img.toPNG());
      });
      await mainWindow.webContents.executeJavaScript(
        "(() => { const p = document.getElementById('ctxDetailPop'); if (p) p.remove(); state.ctxDetail = null; return 'ok'; })()"
      );
      // ⑩ 交互三件套同屏：composer 附件行 + 消息队列 chips + 授权卡片（R65）
      await mainWindow.webContents.executeJavaScript(`
        (() => {
          const cur = state.current;
          const fake = { id: 'shot_interact_sid', smoke: true, cwd: window.__qcodeDevWs, title: '交互审查', messages: [
            { role: 'user', text: '帮我看下这个目录', ts: Date.now() },
            { role: 'assistant', blocks: [{ type: 'text', text: '好的，我来执行命令查看。' }], ts: Date.now() },
          ], updatedAt: Date.now() };
          window.__shotSavedCurInter = cur;
          state.current = fake;
          const px = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
          state.attachments.set(fake.id, [
            { path: window.__qcodeDevWs + '/demo.png', name: 'demo.png', thumb: px },
            { path: window.__qcodeDevWs + '/report.md', name: 'report.md', thumb: px },
          ]);
          state.queue[fake.id] = [{ text: '再统计一下文件总数' }, { text: '顺便把结果导出成 CSV' }];
          renderComposer();
          showApprovalCard({ sessionId: fake.id, requestId: 'shot-req-1', toolName: 'run_shell_command', input: { command: 'ls -dt -- */ | head -n 3' } });
          return 'ok';
        })()
      `);
      await wait(500);
      await mainWindow.webContents.capturePage().then((img) => {
        fs.writeFileSync(path.join(shotDir, '27-interact.png'), img.toPNG());
      });
      await mainWindow.webContents.executeJavaScript(`
        (() => {
          const fake = state.current;
          if (fake && fake.id === 'shot_interact_sid') {
            state.attachments.delete(fake.id);
            delete state.queue[fake.id];
          }
          if (state.pendingApproval && state.pendingApproval.sessionId === 'shot_interact_sid') {
            state.pendingApproval = null;
            if (approvalCard && approvalCard.parentNode) approvalCard.remove();
            approvalCard = null;
          }
          state.current = window.__shotSavedCurInter || state.current;
          renderComposer();
          renderThread();
          return 'ok';
        })()
      `);
      console.log('[smoke] visual shots: .../25-ctxdetail/26-ctxdetail-warn/27-interact');
      // ⑪ Goal 状态条 + 轮次列表展开
      await mainWindow.webContents.executeJavaScript(`
        (() => {
          const fake = { id: 'shot_goal_sid', smoke: true, cwd: window.__qcodeDevWs, title: 'Goal 审查', messages: [
            { role: 'user', text: '第一轮任务', goalRound: 1, ts: Date.now() },
            { role: 'assistant', blocks: [{ type: 'text', text: '第一轮回复' }], goalRound: 1, ts: Date.now() },
            { role: 'user', text: '第二轮任务', goalRound: 2, ts: Date.now() },
            { role: 'assistant', blocks: [{ type: 'text', text: '第二轮回复' }], goalRound: 2, ts: Date.now() },
          ], goal: { status: 'active', objective: '持续完善 Qcode 的显示效果与交互体验', title: '完善显示效果', round: 3, rounds: 2, tokensUsed: 12400, tokenBudget: 50000 }, updatedAt: Date.now() };
          window.__shotSavedCurGoal = state.current;
          state.current = fake;
          renderThread();
          renderGoal(fake);
          const btn = document.querySelector('#goalBar [data-gact="toggle"]');
          if (btn) btn.click();
          return 'ok';
        })()
      `);
      await wait(400);
      await mainWindow.webContents.capturePage().then((img) => {
        fs.writeFileSync(path.join(shotDir, '28-goalbar.png'), img.toPNG());
      });
      await mainWindow.webContents.executeJavaScript(`
        (() => {
          state.current = window.__shotSavedCurGoal || state.current;
          renderGoal(state.current);
          renderThread();
          return 'ok';
        })()
      `);
      // ⑫ toast 堆叠（四条不同语义）
      await mainWindow.webContents.executeJavaScript(`
        (() => {
          toast('每日预算', '今日已用 850.0K tokens，已达预算的 85%');
          setTimeout(() => toast('工作区已回滚', '还原 5 个文件，删除 2 个新增'), 120);
          setTimeout(() => toast('供应商已接入', '已添加 1 个模型（记得保存配置）'), 240);
          setTimeout(() => toast('已移出排队消息', ''), 360);
          return 'ok';
        })()
      `);
      await wait(650);
      await mainWindow.webContents.capturePage().then((img) => {
        fs.writeFileSync(path.join(shotDir, '29-toast-stack.png'), img.toPNG());
      });
      // ⑬ 会话列表归档态（归档横幅 + 归档分区）
      await mainWindow.webContents.executeJavaScript(`
        (() => {
          const fake = { id: 'shot_arch_sid', smoke: true, archived: true, cwd: window.__qcodeDevWs, title: '归档的旧会话', messages: [
            { role: 'user', text: '很久之前的对话', ts: Date.now() },
            { role: 'assistant', blocks: [{ type: 'text', text: '当时的回复' }], ts: Date.now() },
          ], updatedAt: Date.now() - 86400000 };
          window.__shotSavedCurArch = state.current;
          state.sessions.unshift(fake);
          state.current = fake;
          renderAll();
          return 'ok';
        })()
      `);
      await wait(400);
      await mainWindow.webContents.capturePage().then((img) => {
        fs.writeFileSync(path.join(shotDir, '30-archive.png'), img.toPNG());
      });
      await mainWindow.webContents.executeJavaScript(`
        (() => {
          const at = state.sessions.findIndex((x) => x && x.id === 'shot_arch_sid');
          if (at >= 0) state.sessions.splice(at, 1);
          state.current = window.__shotSavedCurArch || state.sessions[0] || null;
          renderAll();
          return 'ok';
        })()
      `);
      console.log('[smoke] visual shots: .../27-interact/28-goalbar/29-toast-stack/30-archive');
      // ⑭ 会话内查找面板（命中计数 + flash 高亮）
      await mainWindow.webContents.executeJavaScript(`
        (() => {
          const s = state.current;
          if (!s || !(s.messages || []).length) return 'nomsg';
          openFind();
          const inp = document.getElementById('findInput');
          inp.value = '回复';
          inp.dispatchEvent(new Event('input', { bubbles: true }));
          runFind();
          return 'ok';
        })()
      `);
      await wait(400);
      await mainWindow.webContents.capturePage().then((img) => {
        fs.writeFileSync(path.join(shotDir, '31-findbar.png'), img.toPNG());
      });
      await mainWindow.webContents.executeJavaScript('closeFind()');
      // ⑮ 快捷键修改捕获态（点「修改」后按钮进入按下组合键…；setCfgSection 渲染是异步链，轮询等按钮就绪）
      await mainWindow.webContents.executeJavaScript(`
        (async () => {
          openSettings();
          setCfgSection('shortcuts');
          const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
          let btns = [];
          for (let i = 0; i < 30; i++) {
            await sleep(50);
            btns = Array.from(document.querySelectorAll('#scEdit .btn'));
            if (btns.length) break;
          }
          if (!btns.length) return 'nobtn';
          btns[0].click();
          return 'ok';
        })()
      `);
      await wait(400);
      await mainWindow.webContents.capturePage().then((img) => {
        fs.writeFileSync(path.join(shotDir, '32-shortcut-capture.png'), img.toPNG());
      });
      await mainWindow.webContents.executeJavaScript(
        // R67 教训升级：捕获 handler 挂在 document（capture+stopImmediatePropagation），
        // Escape 要派发到 document 让它自行 cleanup——派发给 activeElement 会漏（焦点已随重绘漂移）
        "(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); if (typeof closeSettings === 'function') closeSettings(); return 'ok'; })()"
      );
      // ⑯ 设置搜索结果列表
      await mainWindow.webContents.executeJavaScript(`
        (() => {
          openSettings();
          const q = document.getElementById('cfgSearch');
          if (!q) return 'nosearch';
          q.value = '模型';
          q.dispatchEvent(new Event('input', { bubbles: true }));
          return 'ok';
        })()
      `);
      await wait(500);
      await mainWindow.webContents.capturePage().then((img) => {
        fs.writeFileSync(path.join(shotDir, '33-cfg-search.png'), img.toPNG());
      });
      await mainWindow.webContents.executeJavaScript(`
        (() => {
          const q = document.getElementById('cfgSearch');
          if (q) { q.value = ''; q.dispatchEvent(new Event('input', { bubbles: true })); }
          if (typeof closeSettings === 'function') closeSettings();
          return 'ok';
        })()
      `);
      console.log('[smoke] visual shots: .../30-archive/31-findbar/32-shortcut-capture/33-cfg-search');
      // ⑰ 命令面板筛选态
      await mainWindow.webContents.executeJavaScript(`
        (() => {
          openPalette();
          const q = document.getElementById('paletteQuery');
          if (!q) return 'noquery';
          q.value = '导出';
          q.dispatchEvent(new Event('input', { bubbles: true }));
          return 'ok';
        })()
      `);
      await wait(500);
      await mainWindow.webContents.capturePage().then((img) => {
        fs.writeFileSync(path.join(shotDir, '34-palette-filter.png'), img.toPNG());
      });
      await mainWindow.webContents.executeJavaScript('closePalette()');
      // ⑱ 活动面板（running/done 两类活动行 + 清空按钮）
      await mainWindow.webContents.executeJavaScript(`
        (() => {
          const fake = { id: 'shot_act_sid', smoke: true, cwd: window.__qcodeDevWs, title: '活动审查', messages: [
            { role: 'user', text: '列一下目录', ts: Date.now() },
          ], updatedAt: Date.now() };
          window.__shotSavedCurAct = state.current;
          state.current = fake;
          rt(fake.id).activities.push(
            { id: 'a1', name: 'run_shell_command', arg: 'ls -dt -- */ | head -n 3', state: 'done', output: 'qwen-agent-shell/ _ref-dsh/ tmp/', startedAt: Date.now() - 400 },
            { id: 'a2', name: 'glob', arg: '*/*.md', state: 'running', startedAt: Date.now() },
          );
          state.panelOpen = true;
          state.panelTab = 'activity';
          document.getElementById('panel').classList.add('show');
          renderAll();
          return 'ok';
        })()
      `);
      await wait(400);
      await mainWindow.webContents.capturePage().then((img) => {
        fs.writeFileSync(path.join(shotDir, '35-activity.png'), img.toPNG());
      });
      await mainWindow.webContents.executeJavaScript(`
        (() => {
          const fake = state.current;
          if (fake && fake.id === 'shot_act_sid') {
            rt(fake.id).activities = [];
          }
          state.panelOpen = false;
          document.getElementById('panel').classList.remove('show');
          state.current = window.__shotSavedCurAct || state.current;
          renderAll();
          return 'ok';
        })()
      `);
      console.log('[smoke] visual shots: .../33-cfg-search/34-palette-filter/35-activity');
      // ⑯ 多消息长对话排版全景（16 条混合消息；换行用 fromCharCode(10) 拼接规避模板串转义坑）
      await mainWindow.webContents.executeJavaScript(`
        (async () => {
          const cur = state.current;
          const nl = String.fromCharCode(10);
          const fence = String.fromCharCode(96, 96, 96);
          const msgs = [];
          msgs.push({ role: 'user', text: '帮我梳理一下这个项目的目录结构，并给出重构建议', ts: Date.now() - 600000 });
          msgs.push({ role: 'assistant', blocks: [
            { type: 'text', text: '我先看了顶层目录，然后按模块给你梳理。' },
            { type: 'tool', name: 'run_shell_command', state: 'done', input: { command: 'ls -la' }, output: ['main.js', 'renderer/', 'build/'].join(nl) },
            { type: 'text', text: ['## 目录结构', '', '| 目录 | 职责 |', '| --- | --- |', '| renderer/ | 渲染层 UI |', '| build/ | 构建资源与内核 |', '', '**要点**：渲染层与主进程职责清晰。'].join(nl) },
          ], ts: Date.now() - 580000 });
          msgs.push({ role: 'user', text: '压缩相关的代码在哪里？', ts: Date.now() - 400000 });
          msgs.push({ role: 'assistant', blocks: [
            { type: 'thinking', text: '用户问压缩逻辑的位置，我记得在 beginTurn 附近有 isCompactTurn 的判断。' },
            { type: 'text', text: '压缩相关逻辑集中在两处：' },
            { type: 'tool', name: 'edit', state: 'done', input: { old_string: 'a', new_string: 'b' }, output: 'ok' },
            { type: 'text', text: [fence + 'js', 'const isCompactTurn = isCompactTurnText(text);', 'if (msg.compact) { settle(); }', fence, '', '- rewriteCliSource 负责命令改写', '- finishTurn 负责结算'].join(nl) },
          ], ts: Date.now() - 380000 });
          msgs.push({ role: 'user', text: '明白了，那测试覆盖呢？', ts: Date.now() - 200000 });
          msgs.push({ role: 'assistant', blocks: [
            { type: 'text', text: ['> 测试统一走 --smoke 入口，402 项断言覆盖全部交互。'].join(nl) },
            { type: 'text', text: ['- [x] 检查点守卫四件套', '- [x] 压缩分支接通', '- [ ] 弹层栈统一管理'].join(nl) },
          ], ts: Date.now() - 180000 });
          for (let i = 0; i < 4; i++) {
            msgs.push({ role: 'user', text: '补充问题 ' + (i + 1), ts: Date.now() - 100000 - i * 1000 });
            msgs.push({ role: 'assistant', blocks: [{ type: 'text', text: '这是对补充问题 ' + (i + 1) + ' 的回答，包含一段较长的说明文本用来观察行宽与行高在多行段落下的表现，以及中英文混排的间距处理是否自然。' }], ts: Date.now() - 99000 - i * 1000 });
          }
          const fake = { id: 'shot_layout_sid', smoke: true, cwd: window.__qcodeDevWs, title: '排版审查', messages: msgs, updatedAt: Date.now() };
          window.__shotSavedCurLayout = cur;
          state.current = fake;
          renderThread();
          return 'ok';
        })()
      `);
      await wait(600);
      await mainWindow.webContents.capturePage().then((img) => {
        fs.writeFileSync(path.join(shotDir, '36-thread-layout.png'), img.toPNG());
      });
      await mainWindow.webContents.executeJavaScript(
        "(() => { const fake = state.current; if (fake && fake.id === 'shot_layout_sid') { const at = state.sessions.findIndex((x) => x && x.id === fake.id); if (at >= 0) state.sessions.splice(at, 1); } state.current = window.__shotSavedCurLayout || state.sessions[0] || null; renderAll(); return 'ok'; })()"
      );
      console.log('[smoke] visual shots: .../35-activity/36-thread-layout');

    } catch (e) {
      console.log('[smoke] visual shots failed:', String(e && e.message || e).slice(0, 120));
    }

    // R73（监工D）：还原用户原主题（冒烟的 dark→light 往返会污染 ui.theme）
    try {
      await mainWindow.webContents.executeJavaScript(
        "setTheme(" + JSON.stringify(window.__origTheme === 'dark' ? 'dark' : window.__origTheme === 'system' ? 'system' : 'light') + ")"
      );
    } catch {
      /* 还原失败不影响收尾 */
    }
    console.log('[smoke] done');
  } catch (err) {
    console.error('[smoke] failed', err);
  } finally {
    try {
      const cfg = readQwenSettings();
      cfg.model = cfg.model && typeof cfg.model === 'object' ? cfg.model : {};
      if (originalEffort) cfg.model.reasoningEffort = originalEffort;
      else delete cfg.model.reasoningEffort;
      writeQwenSettings(cfg);
    } catch (e) {
      log('smoke effort restore failed', String((e && e.message) || e));
    }
    // 清理本轮冒烟产生的会话，不污染真实会话列表
    try {
      let removed = 0;
      // 先取消合并队列，避免清理后 200ms 的延迟写把冒烟会话又落回来
      try {
        if (mainWindow && !mainWindow.isDestroyed()) {
          await mainWindow.webContents.executeJavaScript('cancelAllPersist()');
        }
      } catch {
        /* 窗口已销毁则只清主进程队列 */
      }
      dropAllSessionSaves();
      for (const f of fs.readdirSync(DATA_DIR)) {
        if (!f.endsWith('.json')) continue;
        const j = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));
        if (j && j.smoke) {
          fs.unlinkSync(path.join(DATA_DIR, f));
          removed++;
        }
      }
      log('smoke session cleanup', String(removed));
    } catch (e) {
      log('smoke session cleanup failed', String(e && e.message));
    }
    setTimeout(() => app.quit(), 800);
  }
}

/* ------------------------------------------------------------------ */

let gpuCrashNotified = false;
app.on('child-process-gone', (_e, details) => {
  if (!details || details.type !== 'GPU') return;
  log('gpu process gone', JSON.stringify(details));
  if (gpuCrashNotified || !mainWindow || mainWindow.isDestroyed()) return;
  gpuCrashNotified = true;
  try {
    sendRendererEvent('gpu:crashed', {
      reason: details.reason || '',
      exitCode: details.exitCode,
    });
  } catch {
    /* window may be closing */
  }
});

app.on('web-contents-created', (_e, contents) => {
  contents.on('will-attach-webview', (ev) => ev.preventDefault());
});

app.on('second-instance', () => {
  showMainWindow();
});

app.whenReady().then(() => {
  if (PROBE_NOKERNEL) {
    // 演练专用：启动即让内核解析失败，模拟「内核目录缺失且系统里也没有 qwen」
    resolveQwenLaunch = () => null;
    QWEN_CMD = 'qwen_not_installed_113';
  }
  pruneAttachments();
  // 本地应用不需要摄像头/麦克风/通知等 renderer 权限
  try {
    session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) =>
      cb(permission === 'clipboard-sanitized-write')
    );
    session.defaultSession.setPermissionCheckHandler(
      (_wc, permission) => permission === 'clipboard-sanitized-write'
    );
  } catch {
    /* ignore */
  }
  // 无边框窗口不需要系统菜单栏
  Menu.setApplicationMenu(null);
  applyLoginItem();
  syncTray();
  // R74 监工I：启动注册失败时留痕（原返回值被丢弃，快捷键被占用时用户无从排查）
  {
    const hkResult = syncHotkey();
    if (hkResult && typeof hkResult === 'object' && hkResult.registered === false) { // R78 监工T：实际字段是 registered
      log('hotkey register failed at startup', String(hkResult.error || hkResult.reason || ''));
    }
  }
  createWindow();
  // R98：全量备份在大会话库下要 ~160ms（读 800 个文件 + parse + stringify + 写 14.5MB）。
  // 原来固定在启动后 3 秒跑，正好撞上用户开始打字；改为空闲期执行，且避开有回合正在跑的时候。
  scheduleSessionBackup();
});

function stopAllAgentsForQuit() {
  for (const agent of agents.values()) {
    if (agent && typeof agent.dispose === 'function') agent.dispose();
    else if (agent && typeof agent.stop === 'function') agent.stop(true);
  }
  agents.clear();
}

app.on('before-quit', () => {
  forceQuit = true;
  stopAllAgentsForQuit();
  flushSessionSaves();
});

app.on('will-quit', () => {
  flushSessionSaves();
  // R83 监工AD6：索引防抖 250ms，退出前必须落盘，否则改名/归档在重启后回退
  flushSessionIndex();
  try {
    globalShortcut.unregisterAll();
  } catch {
    /* ignore */
  }
});
