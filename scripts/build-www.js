/* 构建 Capacitor Android 离线内嵌静态资产目录 (www/)
 * 职责：
 * 1. 按白名单精确抽取前端页面、样式、脚本、图标与生产环境核心 JSON 数据
 * 2. 自动剔除 data/_qbatches、data/_second_pass、scripts、tests、screenshots 等开发期冗余文件
 * 3. 在输出的 HTML 中确保启用科大讯飞 T30 学习机纯净模式与本地离线标记
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'www');

const FILES_TO_COPY = [
  'index.html',
  'manifest.webmanifest',
  'sw.js',
  'explore/index.html',
  'explore/app.js',
  'diagnose/index.html',
  'diagnose/app.js',
  'diagnose/engine.js',
  'diagnose/share.js',
  'diagnose/style.css',
  'children/index.html',
  'children/history.html',
  'children/children.css',
  'children/page.js',
  'children/history.js',
  'assets/site.css',
  'assets/pad-t30.css',
  'assets/explore.css',
  'assets/pwa.css',
  'assets/home.js',
  'assets/platform.js',
  'assets/scratchpad.js',
  'assets/children.js',
  'assets/blindspots.js',
  'assets/stats-config.js',
  'assets/stats.js',
  'assets/pwa.js',
  'assets/vendor/cytoscape.min.js',
  'assets/vendor/cytoscape-dagre.js',
  'assets/vendor/dagre.min.js',
  'assets/vendor/qrcode.js',
  'assets/icons/apple-touch-icon.png',
  'assets/icons/icon-192.png',
  'assets/icons/icon-512.png',
  'assets/icons/icon-maskable-512.png',
  'data/topics.json',
  'data/dependencies.json',
  'data/cn-curriculum-standards.json',
  'data/questions.json',
  'data/id-aliases.json'
];

const OPTIONAL_DIRS = [
  'data/mappings'
];

function cleanDir(dir) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  fs.mkdirSync(dir, { recursive: true });
}

function copyFileRel(relPath) {
  const src = path.join(ROOT, relPath);
  const dest = path.join(OUT, relPath);
  if (!fs.existsSync(src)) {
    throw new Error('缺少必需构建文件: ' + relPath);
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  /* 对 HTML 文件默认注入 pure-study-mode 与 data-eyecare="paper"，防止首帧闪烁任何外链横幅 */
  if (relPath.endsWith('.html')) {
    let html = fs.readFileSync(src, 'utf8');
    html = html.replace('<html lang="zh-CN">', '<html lang="zh-CN" data-eyecare="paper" data-font-scale="lg">');
    html = html.replace(/<body([^>]*)>/, function (match, attrs) {
      if (attrs.indexOf('class="') >= 0) {
        return '<body' + attrs.replace('class="', 'class="pure-study-mode is-pad-t30 ') + '>';
      }
      return '<body class="pure-study-mode is-pad-t30"' + attrs + '>';
    });
    fs.writeFileSync(dest, html, 'utf8');
    return fs.statSync(dest).size;
  }

  /* 对 JSON 数据文件进行紧凑化序列化（去除多余缩进空白，进一步减小 APK 体积并加快解析） */
  if (relPath.endsWith('.json') && relPath.startsWith('data/')) {
    const raw = fs.readFileSync(src, 'utf8');
    const parsed = JSON.parse(raw);
    const minified = JSON.stringify(parsed);
    fs.writeFileSync(dest, minified, 'utf8');
    return fs.statSync(dest).size;
  }

  fs.copyFileSync(src, dest);
  return fs.statSync(dest).size;
}

function copyDirRecursive(relDir) {
  const srcDir = path.join(ROOT, relDir);
  if (!fs.existsSync(srcDir)) return 0;
  let bytes = 0;
  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const childRel = path.posix.join(relDir, entry.name);
    if (entry.isDirectory()) {
      bytes += copyDirRecursive(childRel);
    } else if (entry.isFile() && !entry.name.endsWith('.example.json')) {
      bytes += copyFileRel(childRel);
    }
  }
  return bytes;
}

function build() {
  require('./inject-pad.js');
  console.log('正在清理并构建 Android 离线内嵌静态资产目录 (www/)...');
  cleanDir(OUT);
  let totalBytes = 0;
  let fileCount = 0;

  for (const rel of FILES_TO_COPY) {
    totalBytes += copyFileRel(rel);
    fileCount++;
  }
  for (const dir of OPTIONAL_DIRS) {
    totalBytes += copyDirRecursive(dir);
  }

  const mb = (totalBytes / (1024 * 1024)).toFixed(2);
  console.log('构建完成：共打包 ' + fileCount + '+ 个核心资产文件，精简后总大小 ' + mb + ' MB -> ' + OUT);
}

build();

