'use strict';
// 从 build/brand.svg 生成整套应用图标：
//   build/icon.png        1024×1024  窗口图标（运行时由 main.js 读取）
//   build/icon-512.png     512×512
//   build/icon.ico        16/20/24/32/40/48/64/96/128/256（exe 与安装器图标）
//   build/tray-16.png      16×16     托盘
//   build/tray-32.png      32×32     托盘（高 DPI）
//
// 设计稿只有 brand.svg 一份，其它尺寸全部由它推导，避免出现「图标与品牌图不一致」。
// 依赖 sharp：优先用内置内核里的那份（build/kernel/node_modules/sharp），
// 也可以在仓库根 `npm i -D sharp` 后运行。

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const buildDir = path.join(root, 'build');
const svgPath = path.join(buildDir, 'brand.svg');

function loadSharp() {
  const candidates = [
    'sharp',
    path.join(root, 'build', 'kernel', 'node_modules', 'sharp'),
    path.join(root, 'node_modules', 'sharp'),
  ];
  for (const c of candidates) {
    try {
      return require(c);
    } catch {
      /* try next */
    }
  }
  throw new Error('需要 sharp：npm i -D sharp，或先按 docs/BUILDING.md 准备 build/kernel');
}

const sharp = loadSharp();
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256];

// ICO：直接用 PNG 作为每个条目的负载（Windows Vista+ 支持，Win10/11 任务栏与资源管理器均正常）
function buildIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type = icon
  header.writeUInt16LE(entries.length, 4);

  const dirSize = 6 + entries.length * 16;
  let offset = dirSize;
  const dir = [];
  for (const e of entries) {
    const b = Buffer.alloc(16);
    b.writeUInt8(e.size >= 256 ? 0 : e.size, 0); // width（0 表示 256）
    b.writeUInt8(e.size >= 256 ? 0 : e.size, 1); // height
    b.writeUInt8(0, 2); // 调色板颜色数
    b.writeUInt8(0, 3); // reserved
    b.writeUInt16LE(1, 4); // color planes
    b.writeUInt16LE(32, 6); // bits per pixel
    b.writeUInt32LE(e.png.length, 8);
    b.writeUInt32LE(offset, 12);
    offset += e.png.length;
    dir.push(b);
  }
  return Buffer.concat([header, ...dir, ...entries.map((e) => e.png)]);
}

async function main() {
  if (!fs.existsSync(svgPath)) throw new Error('缺少设计稿：' + svgPath);
  const svg = fs.readFileSync(svgPath);

  const render = (size) =>
    sharp(svg, { density: Math.max(72, Math.ceil((size / 1024) * 72 * 4)) })
      .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png({ compressionLevel: 9, adaptiveFiltering: true })
      .toBuffer();

  // 大图：窗口图标
  fs.writeFileSync(path.join(buildDir, 'icon.png'), await render(1024));
  fs.writeFileSync(path.join(buildDir, 'icon-512.png'), await render(512));
  console.log('icon.png 1024 ✓');
  console.log('icon-512.png 512 ✓');

  // ICO：全部尺寸
  const entries = [];
  for (const size of ICO_SIZES) entries.push({ size, png: await render(size) });
  fs.writeFileSync(path.join(buildDir, 'icon.ico'), buildIco(entries));
  console.log('icon.ico ✓  ' + ICO_SIZES.join('/') + '  共 ' + fs.statSync(path.join(buildDir, 'icon.ico')).size + ' B');

  // 托盘：16/32 用同一设计稿，缩小后仍能认出是 Q
  fs.writeFileSync(path.join(buildDir, 'tray-16.png'), await render(16));
  fs.writeFileSync(path.join(buildDir, 'tray-32.png'), await render(32));
  console.log('tray-16.png / tray-32.png ✓');
}

main().catch((e) => {
  console.error('生成图标失败：' + ((e && e.message) || e));
  process.exitCode = 1;
});
