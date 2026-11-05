/* 科大讯飞 T30 平板端环境感知、儿童纯净学习模式、类纸护眼模式与原生桥接层 (CnmPlatform)
 * 核心职责：
 * 1. 自动识别 Capacitor 原生容器或平板大屏环境，默认开启「学习机纯净模式」(屏蔽外网链接与推广横幅)
 * 2. 提供「类纸暖光护眼模式」与「三档字号 (标准/大字/特大)」顶栏控制与持久化
 * 3. 拦截外网链接点击，防止在讯飞学习机受控系统上跳出报错或白屏
 * 4. 桥接 Capacitor Filesystem / Share / App：
 *    - 孩子档案与诊断记录原生沙盒双写持久化（防 WebView 缓存被清）
 *    - 导出 JSON 与诊断分享图原生保存/系统分享
 *    - 安卓侧滑返回键 (Back Gesture) 状态机接管
 */
(function (global) {
  'use strict';

  var PREF_KEY = 'cnmPadPrefs.v1';
  var NATIVE_BACKUP_FILE = 'cnm_children_native_backup.json';
  var DOUBLE_BACK_MS = 2000;
  var lastBackPress = 0;

  var DEFAULT_PREFS = {
    pureMode: true,       // 学习机纯净模式默认开启
    eyecare: 'paper',     // 讯飞 T30 微纳米类纸屏默认开启暖光护眼配色 ('paper' | 'default')
    fontScale: 'lg',      // 14.7寸平板视距较远，默认使用大字号 ('std' | 'lg' | 'xl')
    numpadOpen: true,     // 数值题默认展开平板内联数学小键盘
    scratchpadOpen: true  // 答题时默认开启右侧星闪手写笔演算草稿本
  };

  function isNativeCapacitor() {
    return !!(global.Capacitor && typeof global.Capacitor.isNativePlatform === 'function' && global.Capacitor.isNativePlatform());
  }

  function isTabletViewport() {
    if (typeof global.innerWidth !== 'number') return true;
    var w = Math.max(global.innerWidth || 0, global.innerHeight || 0);
    var h = Math.min(global.innerWidth || 0, global.innerHeight || 0);
    return w >= 900 && h >= 600;
  }

  function loadPrefs() {
    try {
      var raw = global.localStorage && global.localStorage.getItem(PREF_KEY);
      if (!raw) return Object.assign({}, DEFAULT_PREFS);
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return Object.assign({}, DEFAULT_PREFS);
      return {
        pureMode: parsed.pureMode !== false,
        eyecare: parsed.eyecare === 'default' ? 'default' : 'paper',
        fontScale: (parsed.fontScale === 'std' || parsed.fontScale === 'lg' || parsed.fontScale === 'xl') ? parsed.fontScale : 'lg',
        numpadOpen: parsed.numpadOpen !== false,
        scratchpadOpen: parsed.scratchpadOpen !== false
      };
    } catch (e) {
      return Object.assign({}, DEFAULT_PREFS);
    }
  }

  function savePrefs(next) {
    var cur = Object.assign(loadPrefs(), next || {});
    try {
      if (global.localStorage) global.localStorage.setItem(PREF_KEY, JSON.stringify(cur));
    } catch (e) { /* 忽略隐私模式异常 */ }
    applyPrefsToDom(cur);
    return cur;
  }

  function applyPrefsToDom(prefs) {
    if (typeof document === 'undefined' || !document.documentElement) return;
    var p = prefs || loadPrefs();
    var root = document.documentElement;
    if (p.eyecare === 'paper') root.setAttribute('data-eyecare', 'paper');
    else root.removeAttribute('data-eyecare');
    root.setAttribute('data-font-scale', p.fontScale || 'lg');

    if (document.body) {
      document.body.classList.toggle('pure-study-mode', !!p.pureMode);
      document.body.classList.toggle('is-capacitor-native', isNativeCapacitor());
      document.body.classList.toggle('is-pad-t30', isTabletViewport() || isNativeCapacitor());
    }
    updateHeaderToolsState(p);
  }

  function showToast(msg, durationMs) {
    if (typeof document === 'undefined' || !document.body) return;
    var old = document.getElementById('pad-toast');
    if (old) old.remove();
    var toast = document.createElement('div');
    toast.id = 'pad-toast';
    toast.className = 'pad-toast';
    toast.setAttribute('role', 'status');
    toast.textContent = msg;
    document.body.appendChild(toast);
    setTimeout(function () {
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    }, durationMs || 2200);
  }

  /* ---------- 顶栏护眼与字号控制条 ---------- */
  function mountHeaderTools() {
    if (typeof document === 'undefined') return;
    var nav = document.querySelector('.site-nav');
    if (!nav || document.getElementById('pad-header-tools')) return;

    var prefs = loadPrefs();
    var box = document.createElement('div');
    box.id = 'pad-header-tools';
    box.className = 'pad-header-tools no-print';
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', '平板护眼与显示设置');

    var btnPaper = document.createElement('button');
    btnPaper.type = 'button';
    btnPaper.id = 'pad-btn-eyecare';
    btnPaper.className = 'pad-tool-btn' + (prefs.eyecare === 'paper' ? ' on' : '');
    btnPaper.textContent = '类纸护眼';
    btnPaper.title = '切换科大讯飞 T30 纳米类纸暖光护眼配色';
    btnPaper.addEventListener('click', function () {
      var cur = loadPrefs();
      var nextMode = cur.eyecare === 'paper' ? 'default' : 'paper';
      savePrefs({ eyecare: nextMode });
      showToast(nextMode === 'paper' ? '已开启类纸暖光护眼模式' : '已切换为标准明亮模式');
    });

    var scales = [
      { key: 'std', label: '标准字' },
      { key: 'lg', label: '大字' },
      { key: 'xl', label: '特大字' }
    ];
    var btnFont = document.createElement('button');
    btnFont.type = 'button';
    btnFont.id = 'pad-btn-font';
    btnFont.className = 'pad-tool-btn';
    var idx = scales.findIndex(function (s) { return s.key === prefs.fontScale; });
    if (idx < 0) idx = 1;
    btnFont.textContent = '字号：' + scales[idx].label;
    btnFont.title = '切换适合平板桌面视距的字号大小';
    btnFont.addEventListener('click', function () {
      var cur = loadPrefs();
      var i = scales.findIndex(function (s) { return s.key === cur.fontScale; });
      var next = scales[(i + 1) % scales.length];
      savePrefs({ fontScale: next.key });
      showToast('已切换为' + next.label + '模式');
    });

    box.appendChild(btnPaper);
    box.appendChild(btnFont);
    nav.appendChild(box);
  }

  function updateHeaderToolsState(prefs) {
    if (typeof document === 'undefined') return;
    var btnPaper = document.getElementById('pad-btn-eyecare');
    if (btnPaper) {
      btnPaper.classList.toggle('on', prefs.eyecare === 'paper');
    }
    var btnFont = document.getElementById('pad-btn-font');
    if (btnFont) {
      var map = { std: '标准字', lg: '大字', xl: '特大字' };
      btnFont.textContent = '字号：' + (map[prefs.fontScale] || '大字');
    }
  }

  /* ---------- 纯净学习模式：拦截外部跳转 ---------- */
  function isExternalUrl(href) {
    if (!href) return false;
    var s = String(href).trim();
    if (/^(?:javascript:|mailto:|tel:|#)/i.test(s)) return false;
    if (/^https?:\/\//i.test(s)) {
      try {
        var u = new URL(s, global.location ? global.location.href : 'https://localhost');
        var curHost = global.location ? global.location.hostname : 'localhost';
        return u.hostname !== curHost && u.hostname !== 'localhost' && u.hostname !== '127.0.0.1';
      } catch (e) {
        return true;
      }
    }
    return false;
  }

  function setupPureModeGuard() {
    if (typeof document === 'undefined') return;
    document.addEventListener('click', function (e) {
      var p = loadPrefs();
      if (!p.pureMode) return;
      var target = e.target && e.target.closest ? e.target.closest('a[href]') : null;
      if (!target) return;
      var href = target.getAttribute('href');
      if (isExternalUrl(href)) {
        e.preventDefault();
        e.stopPropagation();
        showToast('当前处于学习机纯净模式，已屏蔽外部网页跳转');
      }
    }, true);
  }

  /* ---------- 原生沙盒文件双写备份与恢复 (防 WebView 缓存被清) ---------- */
  function getFilesystemPlugin() {
    if (!global.Capacitor || !global.Capacitor.Plugins) return null;
    return global.Capacitor.Plugins.Filesystem || null;
  }

  function getSharePlugin() {
    if (!global.Capacitor || !global.Capacitor.Plugins) return null;
    return global.Capacitor.Plugins.Share || null;
  }

  function getAppPlugin() {
    if (!global.Capacitor || !global.Capacitor.Plugins) return null;
    return global.Capacitor.Plugins.App || null;
  }

  async function syncChildrenToNative() {
    var fs = getFilesystemPlugin();
    if (!fs || !global.CnmChildren) return false;
    try {
      var kids = global.CnmChildren.list();
      if (!kids || !kids.length) {
        await fs.deleteFile({ path: NATIVE_BACKUP_FILE, directory: 'DATA' }).catch(function () {});
        return true;
      }
      var backup = global.CnmChildren.exportBackup();
      await fs.writeFile({
        path: NATIVE_BACKUP_FILE,
        data: JSON.stringify(backup),
        directory: 'DATA',
        encoding: 'utf8'
      });
      return true;
    } catch (e) {
      return false;
    }
  }

  async function restoreChildrenFromNativeIfNeeded() {
    var fs = getFilesystemPlugin();
    if (!fs || !global.CnmChildren) return false;
    try {
      var existing = global.CnmChildren.list();
      if (existing && existing.length > 0) return false;
      var res = await fs.readFile({
        path: NATIVE_BACKUP_FILE,
        directory: 'DATA',
        encoding: 'utf8'
      });
      if (!res || !res.data) return false;
      var backup = global.CnmChildren.parseBackup(res.data);
      var preview = global.CnmChildren.previewImport(backup);
      if (preview && preview.token) {
        global.CnmChildren.importBackup(backup, preview.token);
        showToast('已从平板本地安全存储恢复孩子档案');
        return true;
      }
    } catch (e) {
      /* 尚无本地备份文件时静默跳过 */
    }
    return false;
  }

  function hookChildrenStorageSync() {
    if (!global.CnmChildren || global.CnmChildren.__nativeHooked) return;
    global.CnmChildren.__nativeHooked = true;
    var methods = ['add', 'update', 'remove', 'setCurrent', 'saveRecord', 'moveRecord', 'removeRecord', 'importBackup'];
    methods.forEach(function (name) {
      var orig = global.CnmChildren[name];
      if (typeof orig !== 'function') return;
      global.CnmChildren[name] = function () {
        var ret = orig.apply(this, arguments);
        syncChildrenToNative();
        return ret;
      };
    });
    restoreChildrenFromNativeIfNeeded();
  }

  /* ---------- 原生文件导出与图片分享桥接 ---------- */
  async function exportJsonFile(filename, jsonString, title) {
    var fs = getFilesystemPlugin();
    var share = getSharePlugin();
    if (fs && isNativeCapacitor()) {
      try {
        var writeRes = await fs.writeFile({
          path: filename,
          data: jsonString,
          directory: 'CACHE',
          encoding: 'utf8'
        });
        if (share && writeRes && writeRes.uri) {
          await share.share({
            title: title || '导出数据备份',
            text: filename,
            url: writeRes.uri,
            dialogTitle: title || '保存或分享备份文件'
          });
          return { ok: true, mode: 'native-share', uri: writeRes.uri };
        }
        /* 若系统分享取消或不支持，再写入 Documents */
        await fs.writeFile({
          path: filename,
          data: jsonString,
          directory: 'DOCUMENTS',
          encoding: 'utf8'
        });
        showToast('已保存到平板「文档 (Documents)」目录：' + filename, 3200);
        return { ok: true, mode: 'native-documents' };
      } catch (e) {
        /* 用户关闭分享面板不报错 */
        if (e && /cancel/i.test(String(e.message || e))) {
          return { ok: true, mode: 'cancelled' };
        }
      }
    }
    /* 回退到标准浏览器 Blob 下载 */
    if (typeof document !== 'undefined') {
      var blob = new Blob([jsonString], { type: 'application/json;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
      return { ok: true, mode: 'web-download' };
    }
    return { ok: false };
  }

  async function shareOrSaveCanvasImage(canvasOrDataUrl, filename) {
    var fs = getFilesystemPlugin();
    var share = getSharePlugin();
    var dataUrl = typeof canvasOrDataUrl === 'string'
      ? canvasOrDataUrl
      : (canvasOrDataUrl && canvasOrDataUrl.toDataURL ? canvasOrDataUrl.toDataURL('image/png') : '');
    if (!dataUrl) return { ok: false };

    if (fs && isNativeCapacitor() && dataUrl.indexOf('base64,') >= 0) {
      try {
        var base64Data = dataUrl.split('base64,')[1];
        var safeName = filename || ('diagnosis-share-' + Date.now() + '.png');
        var writeRes = await fs.writeFile({
          path: safeName,
          data: base64Data,
          directory: 'CACHE'
        });
        if (share && writeRes && writeRes.uri) {
          await share.share({
            title: '知识图谱诊断报告',
            url: writeRes.uri,
            dialogTitle: '保存或分享诊断报告图片'
          });
          return { ok: true, mode: 'native-share' };
        }
      } catch (e) {
        if (e && /cancel/i.test(String(e.message || e))) return { ok: true, mode: 'cancelled' };
      }
    }
    return { ok: false, mode: 'fallback' };
  }

  /* ---------- 安卓硬件返回键与侧滑返回手势状态机 ---------- */
  function handleAndroidBackButton() {
    if (typeof document === 'undefined') return false;

    /* 1. 若分享图弹窗打开，优先关闭分享弹窗 */
    var shareClose = document.getElementById('share-close');
    if (shareClose) {
      shareClose.click();
      return true;
    }

    /* 2. 若演算草稿本处于全屏展开状态，或手机端处于底部半屏抽屉展开状态，优先收起草稿本 */
    var spPane = document.getElementById('scratchpad-pane');
    if (spPane && spPane.classList.contains('is-fullscreen')) {
      var btnFs = document.getElementById('sp-btn-fullscreen');
      if (btnFs) btnFs.click();
      else spPane.classList.remove('is-fullscreen');
      return true;
    }
    var isMobileWidth = typeof global.innerWidth === 'number' && global.innerWidth > 0 && global.innerWidth < 960;
    if (isMobileWidth && spPane && !spPane.hidden) {
      var btnHide = document.getElementById('sp-btn-hide');
      if (btnHide) btnHide.click();
      else spPane.hidden = true;
      return true;
    }

    /* 3. 若在知识图谱窄屏模式下展开了目录抽屉，关闭抽屉 */
    var side = document.getElementById('side');
    var listToggle = document.getElementById('list-toggle');
    if (side && side.classList.contains('open') && listToggle) {
      listToggle.click();
      return true;
    }

    /* 4. 若在子页面（explore / diagnose / children），返回首页或上级 */
    var path = (global.location && global.location.pathname) || '/';
    var isHome = path === '/' || /\/index\.html$/i.test(path) && !/\/(explore|diagnose|children)\//i.test(path);
    if (!isHome) {
      if (global.history && global.history.length > 1) {
        global.history.back();
      } else {
        global.location.href = '../';
      }
      return true;
    }

    /* 5. 在首页时：双击返回键退出应用 */
    var now = Date.now();
    if (now - lastBackPress < DOUBLE_BACK_MS) {
      var appPlugin = getAppPlugin();
      if (appPlugin && typeof appPlugin.exitApp === 'function') {
        appPlugin.exitApp();
      }
      return true;
    }
    lastBackPress = now;
    showToast('再按一次返回键退出「知识图谱」');
    return true;
  }

  function setupAndroidBackListener() {
    var appPlugin = getAppPlugin();
    if (appPlugin && typeof appPlugin.addListener === 'function') {
      appPlugin.addListener('backButton', function () {
        handleAndroidBackButton();
      });
    }
  }

  /* ---------- 移动端/平板内联数学小键盘 (免弹系统软键盘遮挡屏幕) ---------- */
  function createInlineNumpad(inputEl, onSubmit) {
    if (typeof document === 'undefined' || !inputEl) return null;
    var prefs = loadPrefs();
    var wrap = document.createElement('div');
    wrap.className = 'pad-numpad no-print';
    wrap.id = 'pad-numpad';

    var head = document.createElement('div');
    head.className = 'pad-numpad-head';
    var title = document.createElement('span');
    title.textContent = '数学快捷键盘（免唤起系统输入法）';
    var toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = 'sp-btn';
    toggleBtn.textContent = prefs.numpadOpen ? '收起键盘' : '展开数学键盘';
    head.appendChild(title);
    head.appendChild(toggleBtn);
    wrap.appendChild(head);

    var grid = document.createElement('div');
    grid.className = 'pad-numpad-grid';
    grid.hidden = !prefs.numpadOpen;

    /* 当启用内联数学键盘时，默认设置 inputmode="none" 防止点击输入框弹出系统大模型软键盘占满半屏 */
    if (prefs.numpadOpen) {
      inputEl.setAttribute('inputmode', 'none');
    }

    toggleBtn.addEventListener('click', function () {
      var nextOpen = grid.hidden;
      grid.hidden = !nextOpen;
      toggleBtn.textContent = nextOpen ? '收起键盘' : '展开数学键盘';
      savePrefs({ numpadOpen: nextOpen });
      if (nextOpen) {
        inputEl.setAttribute('inputmode', 'none');
      } else {
        inputEl.removeAttribute('inputmode');
        inputEl.focus();
      }
    });

    var keys = [
      { label: '7', val: '7' },
      { label: '8', val: '8' },
      { label: '9', val: '9' },
      { label: '分数 /', val: '/', fn: true },
      { label: '退格 ⌫', act: 'backspace', fn: true },
      { label: '4', val: '4' },
      { label: '5', val: '5' },
      { label: '6', val: '6' },
      { label: '负号 -', val: '-', fn: true },
      { label: '清空', act: 'clear', fn: true },
      { label: '1', val: '1' },
      { label: '2', val: '2' },
      { label: '3', val: '3' },
      { label: '小数点 .', val: '.', fn: true },
      { label: '逗号 ,', val: '，', fn: true },
      { label: '0', val: '0' },
      { label: '百分号 %', val: '%', fn: true },
      { label: 'π', val: 'π', fn: true },
      { label: '提交答案 ↵', act: 'submit', submit: true }
    ];

    function triggerInput(nextVal) {
      inputEl.value = nextVal;
      var ev = typeof Event === 'function' ? new Event('input', { bubbles: true }) : { target: inputEl };
      if (inputEl.dispatchEvent && ev instanceof Event) inputEl.dispatchEvent(ev);
    }

    keys.forEach(function (k) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'pad-numpad-key' + (k.fn ? ' key-fn' : '') + (k.submit ? ' key-submit' : '');
      b.textContent = k.label;
      if (k.val) b.setAttribute('data-key', k.val);
      if (k.act) b.setAttribute('data-action', k.act);
      b.addEventListener('click', function () {
        var cur = String(inputEl.value || '');
        if (k.act === 'backspace') {
          triggerInput(Array.from(cur).slice(0, -1).join(''));
        } else if (k.act === 'clear') {
          triggerInput('');
        } else if (k.act === 'submit') {
          if (typeof onSubmit === 'function') onSubmit();
        } else if (k.val) {
          triggerInput(cur + k.val);
        }
      });
      grid.appendChild(b);
    });

    wrap.appendChild(grid);
    return wrap;
  }

  /* ---------- 零侵入式监听：自动为诊断页填空输入框挂载平板数学键盘 ---------- */
  function installDiagnoseNumpadObserver() {
    if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return;
    var rootEl = document.getElementById('root');
    if (!rootEl) return;

    var mountIfNeeded = function () {
      var inp = rootEl.querySelector('input#ans.ans-input');
      if (!inp || inp.tagName !== 'INPUT') return;
      if (rootEl.querySelector('#pad-numpad')) return;
      var numpad = createInlineNumpad(inp, function () {
        var btnSubmit = document.getElementById('btn-submit');
        if (btnSubmit) btnSubmit.click();
      });
      if (numpad) {
        inp.insertAdjacentElement('afterend', numpad);
      }
    };

    /* 捕获阶段拦截 focusin，确保在 diagnose/app.js 调用 inp.focus() 之前已设置 inputmode="none" */
    rootEl.addEventListener('focusin', function (e) {
      if (e.target && e.target.id === 'ans' && e.target.tagName === 'INPUT') {
        mountIfNeeded();
      }
    }, true);

    var obs = new MutationObserver(mountIfNeeded);
    obs.observe(rootEl, { childList: true, subtree: true });
    mountIfNeeded();
  }

  /* ---------- 零侵入式监听：拦截上游 <a download> 与 Blob URL，在 Capacitor 原生容器中桥接系统分享/保存 ---------- */
  var blobUrlStore = typeof Map !== 'undefined' ? new Map() : null;
  function installNativeDownloadInterceptor() {
    if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function' && blobUrlStore && !URL.__cnmHooked) {
      URL.__cnmHooked = true;
      var origCreate = URL.createObjectURL.bind(URL);
      var origRevoke = URL.revokeObjectURL ? URL.revokeObjectURL.bind(URL) : null;
      URL.createObjectURL = function (obj) {
        var url = origCreate(obj);
        if (obj && typeof Blob !== 'undefined' && obj instanceof Blob) {
          blobUrlStore.set(url, obj);
        }
        return url;
      };
      if (origRevoke) {
        URL.revokeObjectURL = function (url) {
          setTimeout(function () {
            blobUrlStore.delete(url);
            origRevoke(url);
          }, 5000);
        };
      }
    }

    if (typeof HTMLAnchorElement !== 'undefined' && !HTMLAnchorElement.prototype.__cnmClickHooked) {
      HTMLAnchorElement.prototype.__cnmClickHooked = true;
      var origClick = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () {
        if (isNativeCapacitor() && this.hasAttribute('download') && this.href && this.href.indexOf('blob:') === 0) {
          var blob = blobUrlStore ? blobUrlStore.get(this.href) : null;
          var dlName = this.getAttribute('download') || ('export-' + Date.now() + '.json');
          if (blob) {
            handleNativeBlobDownload(blob, dlName);
            return;
          }
        }
        return origClick.apply(this, arguments);
      };
    }

    if (typeof document !== 'undefined') {
      document.addEventListener('click', function (e) {
        if (!isNativeCapacitor() || !e.target || !e.target.closest) return;
        var a = e.target.closest('a[download]');
        if (!a || !a.href) return;
        var dlName = a.getAttribute('download') || 'download';
        if (a.href.indexOf('blob:') === 0 && blobUrlStore && blobUrlStore.has(a.href)) {
          e.preventDefault();
          handleNativeBlobDownload(blobUrlStore.get(a.href), dlName);
        } else if (a.href.indexOf('data:image/') === 0) {
          e.preventDefault();
          shareOrSaveCanvasImage(a.href, dlName);
        }
      }, true);
    }
  }

  function handleNativeBlobDownload(blob, filename) {
    if (!blob || typeof FileReader === 'undefined') return;
    var isImg = (blob.type && blob.type.indexOf('image/') === 0) || /\.(png|jpg|jpeg|webp)$/i.test(filename);
    var reader = new FileReader();
    if (isImg) {
      reader.onload = function () {
        shareOrSaveCanvasImage(String(reader.result || ''), filename);
      };
      reader.readAsDataURL(blob);
    } else {
      reader.onload = function () {
        exportJsonFile(filename, String(reader.result || ''), '导出数据文件');
      };
      reader.readAsText(blob, 'utf-8');
    }
  }

  /* ---------- 初始化入口 ---------- */
  function init() {
    var prefs = loadPrefs();
    applyPrefsToDom(prefs);
    mountHeaderTools();
    setupPureModeGuard();
    hookChildrenStorageSync();
    setupAndroidBackListener();
    installDiagnoseNumpadObserver();
    installNativeDownloadInterceptor();
  }

  if (typeof document !== 'undefined') {
    applyPrefsToDom(loadPrefs());
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }
  }

  global.CnmPlatform = {
    DEFAULT_PREFS: DEFAULT_PREFS,
    loadPrefs: loadPrefs,
    savePrefs: savePrefs,
    applyPrefsToDom: applyPrefsToDom,
    isNativeCapacitor: isNativeCapacitor,
    isTabletViewport: isTabletViewport,
    isExternalUrl: isExternalUrl,
    exportJsonFile: exportJsonFile,
    shareOrSaveCanvasImage: shareOrSaveCanvasImage,
    syncChildrenToNative: syncChildrenToNative,
    restoreChildrenFromNativeIfNeeded: restoreChildrenFromNativeIfNeeded,
    handleAndroidBackButton: handleAndroidBackButton,
    createInlineNumpad: createInlineNumpad,
    showToast: showToast
  };
})(typeof window !== 'undefined' ? window : globalThis);

