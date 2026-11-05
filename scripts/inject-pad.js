#!/usr/bin/env node
/**
 * 零侵入式外挂注入器 (scripts/inject-pad.js)
 *
 * 设计目的：
 * 本仓库 Fork 自上游 https://github.com/xiaoyang111222/cn-math-taxonomy。
 * 为避免上游更新 index.html / diagnose/index.html / sw.js / package.json 时产生 Git 冲突或覆盖平板适配代码：
 * 1. 所有核心平板逻辑完全独立存放于：
 *    - assets/pad-t30.css
 *    - assets/platform.js
 *    - assets/scratchpad.js
 *    - scripts/build-www.js, scripts/inject-pad.js, scripts/manage.ps1
 *    - android/, capacitor.config.json, tests/test_pad_t30.js
 * 2. 上游核心业务脚本（diagnose/app.js, diagnose/engine.js, children/page.js 等）保持 100% 零修改。
 * 3. 每次同步上游源码后，本脚本幂等地向 HTML 入口文件、sw.js 与 package.json 自动挂载平板外挂脚本引用。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function injectHtmlFile(relPath, prefix, includeScratchpad) {
  const fullPath = path.join(ROOT, relPath);
  if (!fs.existsSync(fullPath)) return false;
  let html = fs.readFileSync(fullPath, 'utf8');
  let changed = false;

  const cssTag = `<link rel="stylesheet" href="${prefix}assets/pad-t30.css">`;
  if (!html.includes('assets/pad-t30.css')) {
    if (html.includes('</head>')) {
      html = html.replace('</head>', `${cssTag}\n</head>`);
      changed = true;
    }
  }

  const platformTag = `<script src="${prefix}assets/platform.js"></script>`;
  const scratchpadTag = `<script src="${prefix}assets/scratchpad.js"></script>`;

  if (!html.includes('assets/platform.js')) {
    // 优先插入在 children.js 之后（以便自动 Hook CnmChildren 双写存储），否则插入在 </body> 前
    const childrenScript = `<script src="${prefix}assets/children.js"></script>`;
    if (html.includes(childrenScript)) {
      const insertTags = includeScratchpad
        ? `${childrenScript}\n${platformTag}\n${scratchpadTag}`
        : `${childrenScript}\n${platformTag}`;
      html = html.replace(childrenScript, insertTags);
      changed = true;
    } else if (html.includes('</body>')) {
      const insertTags = includeScratchpad
        ? `${platformTag}\n${scratchpadTag}\n</body>`
        : `${platformTag}\n</body>`;
      html = html.replace('</body>', insertTags);
      changed = true;
    }
  } else if (includeScratchpad && !html.includes('assets/scratchpad.js')) {
    html = html.replace(platformTag, `${platformTag}\n${scratchpadTag}`);
    changed = true;
  }

  if (changed) {
    fs.writeFileSync(fullPath, html, 'utf8');
  }
  return changed;
}

function injectServiceWorker() {
  const swPath = path.join(ROOT, 'sw.js');
  if (!fs.existsSync(swPath)) return false;
  let sw = fs.readFileSync(swPath, 'utf8');
  let changed = false;

  if (!sw.includes("'assets/pad-t30.css'")) {
    const anchor = "'assets/site.css',";
    if (sw.includes(anchor)) {
      sw = sw.replace(
        anchor,
        `${anchor}\n  'assets/pad-t30.css',\n  'assets/platform.js',\n  'assets/scratchpad.js',`
      );
      changed = true;
    }
  }

  if (changed) {
    fs.writeFileSync(swPath, sw, 'utf8');
  }
  return changed;
}

function injectPackageJson() {
  const pkgPath = path.join(ROOT, 'package.json');
  if (!fs.existsSync(pkgPath)) return false;
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  let changed = false;

  pkg.scripts = pkg.scripts || {};
  const targetTestCmd = 'node tests/test_engine.js && node tests/test_children.js && node tests/test_blindspots.js && node tests/test_pad_t30.js';
  if (pkg.scripts.test !== targetTestCmd) {
    pkg.scripts.test = targetTestCmd;
    changed = true;
  }
  if (!pkg.scripts['build:www']) {
    pkg.scripts['build:www'] = 'node scripts/build-www.js';
    pkg.scripts['cap:sync'] = 'node scripts/build-www.js && npx cap sync android';
    changed = true;
  }

  pkg.dependencies = pkg.dependencies || {};
  const requiredDeps = {
    '@capacitor/android': '^6.2.1',
    '@capacitor/app': '^6.0.3',
    '@capacitor/core': '^6.2.1',
    '@capacitor/filesystem': '^6.0.4',
    '@capacitor/share': '^6.0.4'
  };
  for (const [k, v] of Object.entries(requiredDeps)) {
    if (!pkg.dependencies[k]) {
      pkg.dependencies[k] = v;
      changed = true;
    }
  }

  pkg.devDependencies = pkg.devDependencies || {};
  if (!pkg.devDependencies['@capacitor/cli']) {
    pkg.devDependencies['@capacitor/cli'] = '^6.2.1';
    changed = true;
  }

  if (changed) {
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  }
  return changed;
}

function applyAll() {
  const results = [];
  if (injectHtmlFile('index.html', '', false)) results.push('index.html');
  if (injectHtmlFile('explore/index.html', '../', false)) results.push('explore/index.html');
  if (injectHtmlFile('diagnose/index.html', '../', true)) results.push('diagnose/index.html');
  if (injectHtmlFile('children/index.html', '../', false)) results.push('children/index.html');
  if (injectHtmlFile('children/history.html', '../', false)) results.push('children/history.html');
  if (injectServiceWorker()) results.push('sw.js');
  if (injectPackageJson()) results.push('package.json');

  if (results.length > 0) {
    console.log('[inject-pad] 已自动挂载平板适配引用 -> ' + results.join(', '));
  } else {
    console.log('[inject-pad] 检查完毕：所有入口文件均已包含科大讯飞 T30 平板外挂引用。');
  }
}

applyAll();

