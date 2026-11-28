'use strict';
// electron-builder 会把 extraResources 里名为 node_modules 的目录整体修剪掉
// （即使源目录没有 package.json），导致内置内核缺 qwen-code 运行树。
// 此钩子在打包目标（nsis/zip）生成前把内核 node_modules 补拷进 appOutDir。
const path = require('path');
const fs = require('fs');

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;
  const src = path.join(context.packager.projectDir, 'build', 'kernel', 'node_modules');
  const dst = path.join(context.appOutDir, 'resources', 'kernel', 'node_modules');
  if (!fs.existsSync(src)) throw new Error('afterPack: 缺少 build/kernel/node_modules，请先构建内置内核');
  // R81 监工AA：目录存在≠内容完整——校验哨兵文件，缺失则清理残留后重拷
  const sentinel = path.join(dst, '@qwen-code', 'qwen-code', 'cli-entry.js');
  if (!fs.existsSync(sentinel)) {
    if (fs.existsSync(dst)) fs.rmSync(dst, { recursive: true, force: true });
    fs.cpSync(src, dst, { recursive: true });
    if (!fs.existsSync(sentinel)) throw new Error('afterPack: 内核入口拷贝后仍缺失');
  }
};
