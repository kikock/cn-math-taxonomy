/* 科大讯飞 T30 平板专项适配测试套件 (test_pad_t30.js)
 * 覆盖：
 * 1. 星闪 AI 手写笔压感线宽映射函数 (computeStrokeWidth) 边界与单调性校验
 * 2. 防手掌误触状态机 (shouldAcceptPointer / palmRejection) 校验
 * 3. 矢量笔迹指令流 (createStrokeStore) 绘画、抖动过滤、撤销/重做栈、内存上限与换题自动清空策略
 * 4. 关键契约：同一题目内点选选项重绘 (notifyQuestionKey 相同 key) 绝不清空草稿，切换到新题目时自动清空
 * 5. 学习机儿童纯净模式 (CnmPlatform) 默认配置、外链识别拦截、护眼与字号偏好持久化、原生沙盒双写钩子
 * 6. 离线打包资产目录 (www/) 完整性、HTML 纯净模式预注入与冗余文件剔除校验
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ok   ' + name);
  } catch (err) {
    failed++;
    console.error('  FAIL ' + name + '\n       ' + (err && err.stack ? err.stack : err));
  }
}

function makeSandbox(extra) {
  const store = Object.create(null);
  const localStorage = {
    getItem(k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
    setItem(k, v) { store[k] = String(v); },
    removeItem(k) { delete store[k]; }
  };
  const sb = Object.assign({
    localStorage,
    location: { href: 'https://localhost/diagnose/', hostname: 'localhost', pathname: '/diagnose/', search: '', hash: '' },
    innerWidth: 1512,
    innerHeight: 1008,
    devicePixelRatio: 2,
    Date,
    Math,
    JSON,
    Array,
    Object,
    String,
    Number,
    Boolean,
    RegExp,
    Error,
    URL,
    setTimeout: function (fn) { return 1; },
    clearTimeout: function () {}
  }, extra || {});
  sb.window = sb;
  sb.globalThis = sb;
  return { sb, store };
}

function loadScript(relPath, sb) {
  const code = fs.readFileSync(path.join(ROOT, relPath), 'utf8');
  vm.runInNewContext(code, sb, { filename: relPath });
}

console.log('科大讯飞 T30 星闪手写笔与压感演算草稿本');

const { sb: spSb } = makeSandbox();
loadScript('assets/scratchpad.js', spSb);
const SP = spSb.CnmScratchpad;

test('压感线宽计算：pen 模式下线宽随压力单调递增，且严格限制在合理区间内', function () {
  assert.ok(SP, 'CnmScratchpad 已导出');
  const wLight = SP.computeStrokeWidth(2.6, 0.1, 'pen', false);
  const wMid = SP.computeStrokeWidth(2.6, 0.5, 'pen', false);
  const wHeavy = SP.computeStrokeWidth(2.6, 0.95, 'pen', false);
  assert.ok(wLight < wMid && wMid < wHeavy, `压感线宽应单调递增: ${wLight} < ${wMid} < ${wHeavy}`);
  assert.ok(wLight >= 1.0 && wHeavy <= 6.0, '线宽在合理视觉边界内');

  /* 非法或越界压力值安全钳制 */
  const wNeg = SP.computeStrokeWidth(2.6, -5, 'pen', false);
  const wOver = SP.computeStrokeWidth(2.6, 99, 'pen', false);
  assert.strictEqual(wNeg, SP.computeStrokeWidth(2.6, 0.05, 'pen', false));
  assert.strictEqual(wOver, SP.computeStrokeWidth(2.6, 1.0, 'pen', false));

  /* 橡皮擦线宽放大 */
  const wEraser = SP.computeStrokeWidth(2.6, 0.5, 'pen', true);
  assert.ok(wEraser > wHeavy * 2, '橡皮擦线宽显著大于画笔');
});

test('防手掌误触状态机：未用笔前允许手指书写，一旦识别星闪手写笔则自动屏蔽手掌 touch', function () {
  const store = SP.createStrokeStore();
  assert.strictEqual(store.state.palmRejection, true);
  assert.strictEqual(store.state.penDetected, false);

  /* 尚未检测到手写笔时，允许手指 touch 书写 */
  const s1 = store.beginStroke({ x: 10, y: 10, pressure: 0.5, pointerType: 'touch' });
  assert.ok(s1, '未用笔前允许手指书写');
  store.endStroke();
  assert.strictEqual(store.getStrokes().length, 1);

  /* 使用星闪手写笔书写一笔 */
  const s2 = store.beginStroke({ x: 50, y: 50, pressure: 0.7, pointerType: 'pen' });
  assert.ok(s2, '手写笔正常落笔');
  assert.strictEqual(store.state.penDetected, true, '已自动标记检测到手写笔');
  store.endStroke();

  /* 此时手掌压在屏幕上产生 touch 事件，应被直接拒绝 */
  const palmTouch = store.beginStroke({ x: 200, y: 300, pressure: 1.0, pointerType: 'touch' });
  assert.strictEqual(palmTouch, null, '防误触开启且已激活手写笔时，手掌触摸被拦截');
  assert.strictEqual(store.getStrokes().length, 2);

  /* 若用户主动关闭防误触开关，则手指可再次书写 */
  store.state.palmRejection = false;
  const fingerAgain = store.beginStroke({ x: 80, y: 80, pressure: 0.5, pointerType: 'touch' });
  assert.ok(fingerAgain, '关闭防误触后允许手指触摸');
  store.endStroke();
});

test('矢量笔迹栈：抖动过滤、撤销/重做闭环、新笔迹清空重做栈与历史上限裁剪', function () {
  const store = SP.createStrokeStore({ maxHistory: 5 });
  store.beginStroke({ x: 100, y: 100, pressure: 0.4, pointerType: 'pen' });
  /* 距离 < 0.8px 的极微抖动点应被过滤 */
  assert.strictEqual(store.appendPoint({ x: 100.2, y: 100.3, pressure: 0.4, pointerType: 'pen' }), false);
  /* 正常移动采样点被记录 */
  assert.strictEqual(store.appendPoint({ x: 112, y: 118, pressure: 0.6, pointerType: 'pen' }), true);
  assert.strictEqual(store.appendPoint({ x: 130, y: 140, pressure: 0.8, pointerType: 'pen' }), true);
  const finished = store.endStroke();
  assert.strictEqual(finished.points.length, 3);
  assert.strictEqual(store.getStrokes().length, 1);

  /* 再画第 2 笔 */
  store.beginStroke({ x: 20, y: 20, pressure: 0.5, pointerType: 'pen' });
  store.endStroke();
  assert.strictEqual(store.getStrokes().length, 2);

  /* 撤销与重做 */
  assert.strictEqual(store.undo(), true);
  assert.strictEqual(store.getStrokes().length, 1);
  assert.strictEqual(store.getRedoCount(), 1);
  assert.strictEqual(store.redo(), true);
  assert.strictEqual(store.getStrokes().length, 2);
  assert.strictEqual(store.getRedoCount(), 0);

  /* 撤销后画新的一笔，redoStack 必须清空 */
  store.undo();
  store.beginStroke({ x: 30, y: 30, pressure: 0.5, pointerType: 'pen' });
  store.endStroke();
  assert.strictEqual(store.getRedoCount(), 0);

  /* 验证 maxHistory=5 裁剪 */
  for (let i = 0; i < 10; i++) {
    store.beginStroke({ x: i * 10, y: i * 10, pressure: 0.5, pointerType: 'pen' });
    store.endStroke();
  }
  assert.strictEqual(store.getStrokes().length, 5, '严格遵守撤销栈容量上限');
});

test('诊断答题联动：同题点选选项重绘绝不丢失草稿，切换下一题时自动清空草稿', function () {
  const store = SP.createStrokeStore();
  /* 进入第 1 题 cnm_221#1 */
  store.notifyQuestionKey('cnm_221#1');
  store.beginStroke({ x: 10, y: 20, pressure: 0.6, pointerType: 'pen' });
  store.appendPoint({ x: 40, y: 60, pressure: 0.7, pointerType: 'pen' });
  store.endStroke();
  assert.strictEqual(store.getStrokes().length, 1);

  /* 学生在左侧点选了选择题 A 选项，触发 renderQuestion 重绘，但 questionKey 仍是 cnm_221#1 */
  const sameRes = store.notifyQuestionKey('cnm_221#1');
  assert.strictEqual(sameRes.changed, false);
  assert.strictEqual(sameRes.cleared, false);
  assert.strictEqual(store.getStrokes().length, 1, '同题重绘时草稿笔迹 100% 保持');

  /* 学生提交后进入下一题 cnm_221#2 */
  const nextRes = store.notifyQuestionKey('cnm_221#2');
  assert.strictEqual(nextRes.changed, true);
  assert.strictEqual(nextRes.cleared, true);
  assert.strictEqual(store.getStrokes().length, 0, '切换到新题目时自动清空上一题草稿');
});

console.log('学习机纯净模式、护眼配置与原生容器双写桥接');

test('默认开启学习机纯净模式、类纸暖光护眼模式与大字号，且准确识别外部链接', function () {
  const { sb } = makeSandbox();
  loadScript('assets/platform.js', sb);
  const PF = sb.CnmPlatform;
  assert.ok(PF, 'CnmPlatform 已导出');

  const prefs = PF.loadPrefs();
  assert.strictEqual(prefs.pureMode, true, '默认开启学习机纯净模式');
  assert.strictEqual(prefs.eyecare, 'paper', '默认开启 T30 类纸暖光护眼模式');
  assert.strictEqual(prefs.fontScale, 'lg', '默认开启平板大字号');
  assert.strictEqual(PF.isTabletViewport(), true, '1512×1008 识别为平板视口');

  /* 外链检测 */
  assert.strictEqual(PF.isExternalUrl('https://test.pansgo.com/?from=math-top'), true);
  assert.strictEqual(PF.isExternalUrl('https://pansgo.com'), true);
  assert.strictEqual(PF.isExternalUrl('https://github.com/xiaoyang111222/cn-math-taxonomy'), true);
  assert.strictEqual(PF.isExternalUrl('explore/?subject=math'), false);
  assert.strictEqual(PF.isExternalUrl('../diagnose/'), false);
  assert.strictEqual(PF.isExternalUrl('#cnm_221'), false);

  /* 偏好修改与持久化 */
  PF.savePrefs({ fontScale: 'xl', eyecare: 'default' });
  const updated = PF.loadPrefs();
  assert.strictEqual(updated.fontScale, 'xl');
  assert.strictEqual(updated.eyecare, 'default');
});

test('Capacitor 原生文件双写钩子：添加孩子档案时自动同步写入原生 DATA 沙盒并在清空后可恢复', async function () {
  const nativeFiles = Object.create(null);
  const mockCapacitor = {
    isNativePlatform: function () { return true; },
    Plugins: {
      Filesystem: {
        writeFile: async function (opts) {
          nativeFiles[opts.directory + ':' + opts.path] = opts.data;
          return { uri: 'file:///data/user/0/com.cnmath.taxonomy.pad/files/' + opts.path };
        },
        readFile: async function (opts) {
          const k = opts.directory + ':' + opts.path;
          if (!nativeFiles[k]) throw new Error('File does not exist');
          return { data: nativeFiles[k] };
        },
        deleteFile: async function (opts) {
          delete nativeFiles[opts.directory + ':' + opts.path];
        }
      }
    }
  };

  const { sb, store } = makeSandbox({ Capacitor: mockCapacitor });
  loadScript('assets/children.js', sb);
  loadScript('assets/platform.js', sb);

  const addRes = sb.CnmChildren.add({ name: '讯飞小满', grade: '七年级', textbook: '人教版' });
  assert.strictEqual(addRes.ok, true);
  await sb.CnmPlatform.syncChildrenToNative();

  const savedRaw = nativeFiles['DATA:cnm_children_native_backup.json'];
  assert.ok(savedRaw && savedRaw.indexOf('讯飞小满') >= 0, '孩子档案已同步镜像到 Android 原生 DATA 沙盒');

  /* 模拟 WebView localStorage 被系统清理 */
  delete store['cnmChildren.v1'];
  delete store['cnmChildren.records.v1'];
  assert.strictEqual(sb.CnmChildren.list().length, 0);

  /* 从原生沙盒恢复 */
  const restored = await sb.CnmPlatform.restoreChildrenFromNativeIfNeeded();
  assert.strictEqual(restored, true, '成功从原生沙盒恢复');
  assert.strictEqual(sb.CnmChildren.list().length, 1);
  assert.strictEqual(sb.CnmChildren.list()[0].name, '讯飞小满');
});

console.log('离线打包资产目录 (www/) 与纯净模式预注入检查');

test('www/ 构建产物包含全套核心页面与压缩题库，且不包含开发期冗余目录', function () {
  const wwwDir = path.join(ROOT, 'www');
  assert.ok(fs.existsSync(wwwDir), 'www/ 目录已生成');
  const required = [
    'index.html',
    'explore/index.html',
    'diagnose/index.html',
    'children/index.html',
    'assets/pad-t30.css',
    'assets/platform.js',
    'assets/scratchpad.js',
    'data/topics.json',
    'data/questions.json',
    'data/dependencies.json'
  ];
  required.forEach(function (rel) {
    assert.ok(fs.existsSync(path.join(wwwDir, rel)), '存在核心打包文件: ' + rel);
  });

  /* 确保开发期临时目录未被打入包内 */
  assert.strictEqual(fs.existsSync(path.join(wwwDir, 'data/_qbatches')), false, '已剔除 _qbatches');
  assert.strictEqual(fs.existsSync(path.join(wwwDir, 'data/_second_pass')), false, '已剔除 _second_pass');
  assert.strictEqual(fs.existsSync(path.join(wwwDir, 'scripts')), false, '已剔除 scripts');

  /* 检查 HTML 首帧已注入 pure-study-mode 与 data-eyecare="paper" */
  const indexHtml = fs.readFileSync(path.join(wwwDir, 'index.html'), 'utf8');
  assert.ok(indexHtml.indexOf('data-eyecare="paper"') >= 0, 'HTML 預設注入类纸护眼属性');
  assert.ok(indexHtml.indexOf('pure-study-mode') >= 0, 'HTML 預設注入学习机纯净模式类名');
});

setTimeout(function () {
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed > 0) process.exit(1);
}, 50);

