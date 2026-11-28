'use strict';
// R231：在「一次性干净环境」里生成界面截图。
//
// 为什么需要它：截图会拍下设置页里的配置路径、供应商端点、模型名，以及文件/Git 面板里的工作区路径。
// 直接对着真实环境截图必然把这些内容带进仓库。本脚本的做法是：
//   1) 用一个临时目录充当 USERPROFILE，qwen 配置全部写成假数据；
//   2) 用独立的 QCODE_USER_DATA，不碰真实会话与配置；
//   3) 渲染层的工作区路径由 --shots 模式注入的临时目录提供。
// 生成后仍需人工逐张确认，再决定是否入库。

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qcode-shots-home-'));
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qcode-shots-ud-'));
const outDir = path.join(root, 'shots');

function write(rel, text) {
  const abs = path.join(homeDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text, 'utf8');
}

// 假 qwen 配置：全部使用 example 域名与占位密钥，不含任何真实端点
const settings = {
  modelProviders: {
    openai: [
      {
        id: 'demo-gateway',
        name: '示例网关',
        baseUrl: 'https://api.example.com/v1',
        envKey: 'DEMO_GATEWAY_KEY',
        models: [
          { id: 'demo-large', name: 'Demo Large' },
          { id: 'demo-fast', name: 'Demo Fast' }
        ]
      },
      {
        id: 'demo-local',
        name: '本地示例',
        baseUrl: 'http://127.0.0.1:11434/v1',
        envKey: 'DEMO_LOCAL_KEY',
        models: [{ id: 'demo-local-7b', name: 'Demo Local 7B' }]
      }
    ]
  },
  security: { auth: { selectedType: 'openai' } },
  model: { name: 'demo-gateway', reasoningEffort: 'medium' },
  env: { DEMO_GATEWAY_KEY: 'sk-demo-placeholder', DEMO_LOCAL_KEY: 'sk-demo-placeholder' }
};
write('.qwen/settings.json', JSON.stringify(settings, null, 2) + '\n');

// 假用量记录（用量页需要）
const day = new Date();
const usage = [];
for (let i = 0; i < 6; i++) {
  const d = new Date(day.getTime() - i * 86400000);
  usage.push({
    ts: d.toISOString(),
    date: d.toISOString().slice(0, 10),
    model: 'demo-large',
    input_tokens: 1200 + i * 40,
    output_tokens: 600 + i * 25,
    total_tokens: 1800 + i * 65
  });
}
write('.qwen/usage_record.jsonl', usage.map((x) => JSON.stringify(x)).join('\n') + '\n');

fs.mkdirSync(outDir, { recursive: true });

const electron = require('electron');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.USERPROFILE = homeDir;
env.HOME = homeDir;
env.QCODE_USER_DATA = userDataDir;
env.QCODE_SHOTS_DIR = outDir;

console.log('[clean-shots] HOME     = ' + homeDir);
console.log('[clean-shots] USERDATA = ' + userDataDir);
console.log('[clean-shots] OUT      = ' + outDir);
console.log('[clean-shots] 启动 electron --shots …');

const child = spawn(electron, ['.', '--shots'], { cwd: root, env, stdio: 'inherit' });

child.on('exit', (code) => {
  const files = fs.existsSync(outDir) ? fs.readdirSync(outDir).filter((f) => f.endsWith('.png')) : [];
  console.log('[clean-shots] exit=' + code + '，产出 ' + files.length + ' 张：' + files.join(', '));
  if (code !== 0) process.exitCode = code || 1;
});
