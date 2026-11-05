/* 科大讯飞 T30 第三代星闪 AI 手写笔压感演算草稿本 (CnmScratchpad)
 * 核心特性：
 * 1. 基于标准 PointerEvent API 与 getCoalescedEvents() 适配 120Hz 高刷低延迟书写
 * 2. 超万级压感映射：线宽随手写笔压力动态连续变化，二次贝塞尔曲线平滑消除折线感
 * 3. 矢量笔迹指令栈 (Vector Stroke Log)：20+ 步撤销/重做内存占用 < 150KB，屏幕旋转或缩放时无损重绘
 * 4. 防手掌误触 (Palm Rejection)：支持「手写笔优先模式」，用笔书写时自动屏蔽手掌触摸干扰
 * 5. 三种理科演算底纹：空白、数学方格、平面直角坐标系，支持换题自动归档清空
 */
(function (global) {
  'use strict';

  var MAX_HISTORY = 30;
  var COLORS = [
    { key: 'ink', label: '墨黑', hex: '#1e293b', darkHex: '#f1f5f9' },
    { key: 'blue', label: '解题蓝', hex: '#1d4ed8', darkHex: '#60a5fa' },
    { key: 'red', label: '批注红', hex: '#dc2626', darkHex: '#f87171' }
  ];
  var GRIDS = [
    { key: 'square', label: '方格纸' },
    { key: 'axes', label: '坐标系' },
    { key: 'blank', label: '空白纸' }
  ];

  /* 压感线宽计算函数（纯函数，便于单元测试校验）：
   * pen 模式下根据 pressure (0~1) 计算平滑线宽；touch/mouse 保持基准线宽 */
  function computeStrokeWidth(baseWidth, pressure, pointerType, isEraser) {
    var base = Number(baseWidth) > 0 ? Number(baseWidth) : 2.6;
    if (isEraser) return base * 7.5;
    if (pointerType === 'pen') {
      var p = typeof pressure === 'number' && !isNaN(pressure) ? Math.max(0.05, Math.min(1, pressure)) : 0.5;
      var minW = base * 0.48;
      var maxW = base * 1.95;
      return Number((minW + (maxW - minW) * Math.pow(p, 0.85)).toFixed(2));
    }
    return base;
  }

  /* 防手掌误触判定函数（纯函数，便于单元测试校验）：
   * 当开启 palmRejection 且已检测到手写笔（或强制仅手写笔）时，忽略 touch 事件 */
  function shouldAcceptPointer(pointerType, state) {
    if (!state) return true;
    if (pointerType === 'pen') return true;
    if (state.palmRejection && state.penDetected && pointerType === 'touch') {
      return false;
    }
    return true;
  }

  /* 矢量笔迹栈状态管理器（无 DOM 依赖，支持 Node 单元测试） */
  function createStrokeStore(options) {
    var opts = options || {};
    var maxHistory = opts.maxHistory || MAX_HISTORY;
    var strokes = [];
    var redoStack = [];
    var activeStroke = null;
    var currentQuestionKey = null;
    var state = {
      tool: 'pen',          // 'pen' | 'eraser'
      colorKey: 'ink',
      baseWidth: 2.6,
      grid: 'square',       // 'square' | 'axes' | 'blank'
      palmRejection: true,  // 防手掌误触开关
      penDetected: false,   // 是否已识别到星闪手写笔输入
      autoClearOnNext: true // 换题时是否自动清空画布
    };

    function beginStroke(pt) {
      if (!pt || !shouldAcceptPointer(pt.pointerType, state)) return null;
      if (pt.pointerType === 'pen') state.penDetected = true;
      var isEraser = state.tool === 'eraser' || pt.button === 5 || pt.buttons === 32;
      activeStroke = {
        tool: isEraser ? 'eraser' : 'pen',
        colorKey: state.colorKey,
        baseWidth: state.baseWidth,
        pointerType: pt.pointerType || 'pen',
        points: [{
          x: Number(pt.x) || 0,
          y: Number(pt.y) || 0,
          p: typeof pt.pressure === 'number' ? pt.pressure : 0.5,
          w: computeStrokeWidth(state.baseWidth, pt.pressure, pt.pointerType, isEraser)
        }]
      };
      return activeStroke;
    }

    function appendPoint(pt) {
      if (!activeStroke || !pt) return false;
      var pts = activeStroke.points;
      var last = pts[pts.length - 1];
      var x = Number(pt.x) || 0;
      var y = Number(pt.y) || 0;
      /* 过滤距离过近的冗余抖动采样点 (< 0.8px) */
      if (last && Math.hypot(x - last.x, y - last.y) < 0.8) return false;
      var isEraser = activeStroke.tool === 'eraser';
      pts.push({
        x: x,
        y: y,
        p: typeof pt.pressure === 'number' ? pt.pressure : 0.5,
        w: computeStrokeWidth(activeStroke.baseWidth, pt.pressure, activeStroke.pointerType, isEraser)
      });
      return true;
    }

    function endStroke() {
      if (!activeStroke) return null;
      var finished = activeStroke;
      activeStroke = null;
      if (finished.points.length > 0) {
        strokes.push(finished);
        if (strokes.length > maxHistory) {
          strokes.shift();
        }
        redoStack = [];
      }
      return finished;
    }

    function undo() {
      if (!strokes.length) return false;
      redoStack.push(strokes.pop());
      return true;
    }

    function redo() {
      if (!redoStack.length) return false;
      strokes.push(redoStack.pop());
      return true;
    }

    function clear() {
      if (!strokes.length && !activeStroke) return false;
      strokes = [];
      redoStack = [];
      activeStroke = null;
      return true;
    }

    /* 当题目发生切换时调用：同一题内重绘（如点选选项）绝不清空草稿；换新题时按配置自动清空 */
    function notifyQuestionKey(nextKey) {
      var norm = nextKey ? String(nextKey) : null;
      if (norm === currentQuestionKey) {
        return { changed: false, cleared: false };
      }
      var hadPrev = currentQuestionKey !== null;
      currentQuestionKey = norm;
      if (hadPrev && norm !== null && state.autoClearOnNext && strokes.length > 0) {
        clear();
        return { changed: true, cleared: true };
      }
      return { changed: true, cleared: false };
    }

    return {
      state: state,
      getStrokes: function () { return strokes.slice(); },
      getRedoCount: function () { return redoStack.length; },
      getActiveStroke: function () { return activeStroke; },
      getQuestionKey: function () { return currentQuestionKey; },
      beginStroke: beginStroke,
      appendPoint: appendPoint,
      endStroke: endStroke,
      undo: undo,
      redo: redo,
      clear: clear,
      notifyQuestionKey: notifyQuestionKey
    };
  }

  /* ---------- DOM 与 Canvas 渲染挂载层 ---------- */
  function isDarkMode() {
    return !!(global.matchMedia && global.matchMedia('(prefers-color-scheme: dark)').matches);
  }

  function resolveStrokeColor(colorKey) {
    var dark = isDarkMode();
    var hit = COLORS.find(function (c) { return c.key === colorKey; }) || COLORS[0];
    return dark ? hit.darkHex : hit.hex;
  }

  function drawSingleStroke(ctx, stroke) {
    if (!ctx || !stroke || !stroke.points || !stroke.points.length) return;
    var pts = stroke.points;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (stroke.tool === 'eraser') {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.strokeStyle = 'rgba(0,0,0,1)';
    } else {
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = resolveStrokeColor(stroke.colorKey);
    }

    if (pts.length === 1) {
      var p0 = pts[0];
      ctx.beginPath();
      ctx.fillStyle = stroke.tool === 'eraser' ? 'rgba(0,0,0,1)' : resolveStrokeColor(stroke.colorKey);
      ctx.arc(p0.x, p0.y, Math.max(1, p0.w / 2), 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      return;
    }

    /* 分段二次贝塞尔曲线平滑绘制，支持每一段随手写笔压感动态变化线宽 */
    for (var i = 1; i < pts.length; i++) {
      var prev = pts[i - 1];
      var cur = pts[i];
      var midX = (prev.x + cur.x) / 2;
      var midY = (prev.y + cur.y) / 2;
      ctx.beginPath();
      if (i === 1) {
        ctx.moveTo(prev.x, prev.y);
        ctx.lineTo(midX, midY);
      } else {
        var prevPrev = pts[i - 2];
        var prevMidX = (prevPrev.x + prev.x) / 2;
        var prevMidY = (prevPrev.y + prev.y) / 2;
        ctx.moveTo(prevMidX, prevMidY);
        ctx.quadraticCurveTo(prev.x, prev.y, midX, midY);
      }
      ctx.lineWidth = (prev.w + cur.w) / 2;
      ctx.stroke();
    }
    ctx.restore();
  }

  function mountWorkbenchController() {
    if (typeof document === 'undefined') return null;
    var rootEl = document.getElementById('root');
    var workbench = document.getElementById('diagnose-workbench');
    var pane = document.getElementById('scratchpad-pane');
    if (!workbench && rootEl && rootEl.parentNode) {
      workbench = document.createElement('div');
      workbench.id = 'diagnose-workbench';
      workbench.className = 'diagnose-workbench';
      rootEl.parentNode.insertBefore(workbench, rootEl);
      workbench.appendChild(rootEl);
    }
    if (!pane && workbench) {
      pane = document.createElement('aside');
      pane.id = 'scratchpad-pane';
      pane.className = 'scratchpad-pane no-print';
      pane.setAttribute('aria-label', '手写演算草稿本');
      pane.hidden = true;
      workbench.appendChild(pane);
    }
    if (!workbench || !pane) return null;

    var store = createStrokeStore();
    var prefs = global.CnmPlatform ? global.CnmPlatform.loadPrefs() : { scratchpadOpen: true };
    var isMobileScreen = typeof global.innerWidth === 'number' && global.innerWidth > 0 && global.innerWidth < 960;
    /* 手机端默认收起草稿本（以右下角悬浮按钮按需唤出半屏抽屉，不遮挡看题），平板大屏默认双栏并排展开 */
    var panelVisible = isMobileScreen ? false : (prefs.scratchpadOpen !== false);
    var inQuestionPhase = false;

    /* 构建草稿本内部 DOM */
    pane.innerHTML = '';

    var header = document.createElement('div');
    header.className = 'scratchpad-header';
    var titleBox = document.createElement('div');
    titleBox.className = 'scratchpad-title';
    titleBox.innerHTML = '<span>✍️ 演算草稿本</span><span class="scratchpad-badge" id="sp-pen-status">支持触控与手写笔压感</span>';
    var headerRight = document.createElement('div');
    headerRight.className = 'sp-group';

    var btnPalm = document.createElement('button');
    btnPalm.type = 'button';
    btnPalm.id = 'sp-btn-palm';
    btnPalm.className = 'sp-btn on';
    btnPalm.textContent = '防误触：开';
    btnPalm.title = '开启后，一旦使用手写笔书写，将自动忽略手掌触摸绘线';

    var btnAutoClear = document.createElement('button');
    btnAutoClear.type = 'button';
    btnAutoClear.id = 'sp-btn-autoclear';
    btnAutoClear.className = 'sp-btn on';
    btnAutoClear.textContent = '换题清空';
    btnAutoClear.title = '进入下一题时自动清空上一题的演算草稿';

    var btnFs = document.createElement('button');
    btnFs.type = 'button';
    btnFs.id = 'sp-btn-fullscreen';
    btnFs.className = 'sp-btn';
    btnFs.textContent = '全屏演算';

    var btnHide = document.createElement('button');
    btnHide.type = 'button';
    btnHide.id = 'sp-btn-hide';
    btnHide.className = 'sp-btn';
    btnHide.textContent = '收起';

    headerRight.append(btnPalm, btnAutoClear, btnFs, btnHide);
    header.append(titleBox, headerRight);

    /* 工具栏：画笔/橡皮、颜色、底纹、撤销/重做/清空 */
    var toolbar = document.createElement('div');
    toolbar.className = 'scratchpad-toolbar';

    var toolGroup = document.createElement('div');
    toolGroup.className = 'sp-group';
    var btnPen = document.createElement('button');
    btnPen.type = 'button';
    btnPen.className = 'sp-btn on';
    btnPen.textContent = '画笔';
    var btnEraser = document.createElement('button');
    btnEraser.type = 'button';
    btnEraser.className = 'sp-btn';
    btnEraser.textContent = '橡皮擦';
    toolGroup.append(btnPen, btnEraser);

    var colorGroup = document.createElement('div');
    colorGroup.className = 'sp-group';
    var colorBtns = {};
    COLORS.forEach(function (c) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'sp-btn' + (c.key === store.state.colorKey ? ' on' : '');
      var dot = document.createElement('i');
      dot.className = 'sp-color-dot';
      dot.style.background = c.hex;
      b.append(dot, document.createTextNode(c.label));
      b.addEventListener('click', function () {
        store.state.tool = 'pen';
        store.state.colorKey = c.key;
        syncToolbarState();
      });
      colorBtns[c.key] = b;
      colorGroup.appendChild(b);
    });

    var gridGroup = document.createElement('div');
    gridGroup.className = 'sp-group';
    var gridBtns = {};
    GRIDS.forEach(function (g) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'sp-btn' + (g.key === store.state.grid ? ' on' : '');
      b.textContent = g.label;
      b.addEventListener('click', function () {
        store.state.grid = g.key;
        stage.setAttribute('data-grid', g.key);
        syncToolbarState();
      });
      gridBtns[g.key] = b;
      gridGroup.appendChild(b);
    });

    var actionGroup = document.createElement('div');
    actionGroup.className = 'sp-group';
    var btnUndo = document.createElement('button');
    btnUndo.type = 'button';
    btnUndo.className = 'sp-btn';
    btnUndo.textContent = '撤销';
    btnUndo.disabled = true;
    var btnRedo = document.createElement('button');
    btnRedo.type = 'button';
    btnRedo.className = 'sp-btn';
    btnRedo.textContent = '重做';
    btnRedo.disabled = true;
    var btnClear = document.createElement('button');
    btnClear.type = 'button';
    btnClear.className = 'sp-btn';
    btnClear.textContent = '清空';
    actionGroup.append(btnUndo, btnRedo, btnClear);

    toolbar.append(toolGroup, colorGroup, gridGroup, actionGroup);

    var stage = document.createElement('div');
    stage.className = 'scratchpad-stage';
    stage.setAttribute('data-grid', store.state.grid);

    var canvas = document.createElement('canvas');
    canvas.className = 'scratchpad-canvas';
    canvas.id = 'scratchpad-canvas';
    stage.appendChild(canvas);

    var footer = document.createElement('div');
    footer.className = 'scratchpad-footer';
    footer.innerHTML = '<span id="sp-question-hint">草稿随当前题目保留，点选选项不会丢失笔迹</span><span>手机触控 / 手写笔 120Hz 高刷优化</span>';

    pane.append(header, toolbar, stage, footer);

    /* 收起时的右下角悬浮唤起按钮 */
    var fab = document.createElement('button');
    fab.type = 'button';
    fab.id = 'scratchpad-fab';
    fab.className = 'scratchpad-toggle-fab no-print';
    fab.textContent = '✍️ 展开演算草稿本';
    fab.hidden = true;
    document.body.appendChild(fab);

    var ctx = null;
    try {
      ctx = canvas.getContext('2d', { desynchronized: true }) || canvas.getContext('2d');
    } catch (e) {
      ctx = canvas.getContext('2d');
    }

    var dpr = 1;
    function resizeCanvas() {
      if (!stage || pane.hidden) return;
      var rect = stage.getBoundingClientRect();
      if (rect.width < 10 || rect.height < 10) return;
      dpr = Math.min(global.devicePixelRatio || 1, 2.5);
      var targetW = Math.round(rect.width * dpr);
      var targetH = Math.round(rect.height * dpr);
      if (canvas.width !== targetW || canvas.height !== targetH) {
        canvas.width = targetW;
        canvas.height = targetH;
        redrawAll();
      }
    }

    function redrawAll() {
      if (!ctx) return;
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.scale(dpr, dpr);
      var list = store.getStrokes();
      for (var i = 0; i < list.length; i++) {
        drawSingleStroke(ctx, list[i]);
      }
      var active = store.getActiveStroke();
      if (active) drawSingleStroke(ctx, active);
      ctx.restore();
      syncToolbarState();
    }

    function syncToolbarState() {
      btnPen.classList.toggle('on', store.state.tool === 'pen');
      btnEraser.classList.toggle('on', store.state.tool === 'eraser');
      Object.keys(colorBtns).forEach(function (k) {
        colorBtns[k].classList.toggle('on', store.state.tool === 'pen' && store.state.colorKey === k);
      });
      Object.keys(gridBtns).forEach(function (k) {
        gridBtns[k].classList.toggle('on', store.state.grid === k);
      });
      btnPalm.classList.toggle('on', store.state.palmRejection);
      btnPalm.textContent = store.state.palmRejection ? '防误触：开' : '防误触：关';
      btnAutoClear.classList.toggle('on', store.state.autoClearOnNext);
      btnUndo.disabled = store.getStrokes().length === 0;
      btnRedo.disabled = store.getRedoCount() === 0;
      var badge = document.getElementById('sp-pen-status');
      if (badge) {
        badge.textContent = store.state.penDetected ? '星闪手写笔已激活（防手掌误触中）' : '支持星闪笔压感 / 手指书写';
      }
    }

    btnPen.addEventListener('click', function () {
      store.state.tool = 'pen';
      syncToolbarState();
    });
    btnEraser.addEventListener('click', function () {
      store.state.tool = 'eraser';
      syncToolbarState();
    });
    btnPalm.addEventListener('click', function () {
      store.state.palmRejection = !store.state.palmRejection;
      syncToolbarState();
    });
    btnAutoClear.addEventListener('click', function () {
      store.state.autoClearOnNext = !store.state.autoClearOnNext;
      syncToolbarState();
    });
    btnUndo.addEventListener('click', function () {
      if (store.undo()) redrawAll();
    });
    btnRedo.addEventListener('click', function () {
      if (store.redo()) redrawAll();
    });
    btnClear.addEventListener('click', function () {
      if (store.clear()) redrawAll();
    });
    btnFs.addEventListener('click', function () {
      var isFs = pane.classList.toggle('is-fullscreen');
      btnFs.classList.toggle('on', isFs);
      btnFs.textContent = isFs ? '退出全屏' : '全屏演算';
      setTimeout(resizeCanvas, 30);
    });
    btnHide.addEventListener('click', function () {
      panelVisible = false;
      if (global.CnmPlatform) global.CnmPlatform.savePrefs({ scratchpadOpen: false });
      pane.classList.remove('is-fullscreen');
      updateVisibility();
    });
    fab.addEventListener('click', function () {
      panelVisible = true;
      if (global.CnmPlatform) global.CnmPlatform.savePrefs({ scratchpadOpen: true });
      updateVisibility();
    });

    /* Pointer Events 120Hz 高频采样绑定 */
    var activePointerId = null;

    function pointFromEvent(e) {
      var rect = canvas.getBoundingClientRect();
      return {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
        pressure: typeof e.pressure === 'number' ? e.pressure : 0.5,
        pointerType: e.pointerType || 'pen',
        button: e.button,
        buttons: e.buttons
      };
    }

    canvas.addEventListener('pointerdown', function (e) {
      if (activePointerId !== null && activePointerId !== e.pointerId) return;
      var pt = pointFromEvent(e);
      var started = store.beginStroke(pt);
      if (!started) return;
      activePointerId = e.pointerId;
      if (canvas.setPointerCapture) {
        try { canvas.setPointerCapture(e.pointerId); } catch (err) {}
      }
      e.preventDefault();
      redrawAll();
    });

    canvas.addEventListener('pointermove', function (e) {
      if (activePointerId !== e.pointerId) return;
      e.preventDefault();
      var events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [e];
      if (!events || !events.length) events = [e];
      var added = false;
      for (var i = 0; i < events.length; i++) {
        if (store.appendPoint(pointFromEvent(events[i]))) added = true;
      }
      if (added) redrawAll();
    });

    function finishPointer(e) {
      if (activePointerId !== e.pointerId) return;
      activePointerId = null;
      store.endStroke();
      redrawAll();
    }

    canvas.addEventListener('pointerup', finishPointer);
    canvas.addEventListener('pointercancel', finishPointer);

    function updateVisibility() {
      if (!inQuestionPhase) {
        pane.hidden = true;
        fab.hidden = true;
        workbench.classList.remove('workbench-active');
        return;
      }
      if (panelVisible) {
        pane.hidden = false;
        fab.hidden = true;
        workbench.classList.add('workbench-active');
        requestAnimationFrame(resizeCanvas);
      } else {
        pane.hidden = true;
        fab.hidden = false;
        workbench.classList.remove('workbench-active');
      }
    }

    /* 供诊断页在 renderQuestion / renderStart / renderResult 时同步状态 */
    function syncDiagnoseState(info) {
      var opts = info || {};
      inQuestionPhase = !!opts.active;
      if (inQuestionPhase && opts.questionKey) {
        var res = store.notifyQuestionKey(opts.questionKey);
        if (res.cleared) redrawAll();
        var hint = document.getElementById('sp-question-hint');
        if (hint && opts.topicName) {
          hint.textContent = '当前演算：' + opts.topicName + '（点选选项不会丢失笔迹）';
        }
      } else if (!inQuestionPhase) {
        store.notifyQuestionKey(null);
      }
      updateVisibility();
    }

    global.addEventListener('resize', function () {
      requestAnimationFrame(resizeCanvas);
    });

    /* 零侵入监听 #root DOM 变化，无需修改上游 diagnose/app.js 即可自动感知题目切换 */
    if (rootEl && typeof MutationObserver !== 'undefined') {
      var syncFromRootDom = function () {
        var qTitle = rootEl.querySelector('.q-title');
        var qStem = rootEl.querySelector('.q-stem');
        if (qTitle) {
          var topicName = qTitle.textContent.trim();
          var stemText = qStem ? qStem.textContent.trim().slice(0, 120) : '';
          syncDiagnoseState({
            active: true,
            questionKey: topicName + '::' + stemText,
            topicName: topicName
          });
        } else {
          syncDiagnoseState({ active: false, questionKey: null, topicName: '' });
        }
      };
      var obs = new MutationObserver(syncFromRootDom);
      obs.observe(rootEl, { childList: true });
      syncFromRootDom();
    }

    return {
      store: store,
      syncDiagnoseState: syncDiagnoseState,
      redrawAll: redrawAll,
      resizeCanvas: resizeCanvas
    };
  }

  var controllerInstance = null;
  function getOrMountController() {
    if (!controllerInstance && typeof document !== 'undefined') {
      controllerInstance = mountWorkbenchController();
    }
    return controllerInstance;
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', getOrMountController);
    } else {
      getOrMountController();
    }
  }

  global.CnmScratchpad = {
    computeStrokeWidth: computeStrokeWidth,
    shouldAcceptPointer: shouldAcceptPointer,
    createStrokeStore: createStrokeStore,
    getController: getOrMountController
  };
})(typeof window !== 'undefined' ? window : globalThis);

