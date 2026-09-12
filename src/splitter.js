// 通用拖拽分割条工厂
// ============================================================================
//
// 起源（Stage 4d 抽出）：src/app.js 里有三段几乎一模一样的 mountSplitter*：
//   - mountSplitter         (editor ↔ viewer，3480-3640)
//   - mountSidebarSplitter  (sidebar，3652-3850)
//   - mountAiSplitter       (AI panel，3865-3984)
//
// 三段共享的样板：
//   - 鼠标 + 触屏 drag 状态机（dragging / pointerId / startX / startWidth）
//   - cursor: col-resize + userSelect: none 切换
//   - is-dragging  class 切换
//   - 命中区扩展（仅 sidebar / AI：±HIT_RADIUS 像素也算命中）
//   - document 级 mousemove / touchmove / mouseup / touchend / touchcancel
//
// 不共享的部分（由调用方注入）：
//   - 边界 clamp：editor 走 frSpace 动态算，sidebar/AI 走静态 [MIN, MAX]
//   - 持久化：splitRatio / sidebarWidth / aiWidth 三个字段
//   - 命中区距离计算：sidebar 缓存中线（Phase M-H6），AI 每次重读
//
// 设计：
//   - createSplitter(opts) 接受 handle / setSize / getSize / clampSize / onDragEnd
//     等回调；工厂不耦合业务（不知道是 px 还是 ratio，不知道写到 :root 还是
//     .appShell），保持单一职责。
//   - 内部维护自己挂的 listener 列表，dispose() 一次性解除 —— 调用方在 pagehide
//     兜底调一次，避免 15 个 document 级 listener 长期持有闭包。
// ============================================================================

/**
 * @typedef {Object} HitZoneOpts
 * @property {number} radius - 鼠标距 splitter 中线 ± radius 像素都算命中
 * @property {() => boolean} [isAvailable] - 当前是否启用命中区（AI 关闭时返回 false）
 *   默认 true
 * @property {(coord: number) => number} distanceTo - 鼠标坐标 → 到 splitter 中线的距离
 *   （sidebar 缓存中线版本由调用方实现，工厂不关心怎么算）
 * @property {(inZone: boolean) => void} [onHover] - 进/出命中区的视觉反馈
 *   默认：改 document.body.style.cursor（仅 axis='x' → col-resize）
 */

/**
 * @typedef {Object} SplitterOpts
 * @property {HTMLElement} handle - 拖拽条元素
 * @property {'x' | 'y'} [axis='x'] - 'x' = 水平拖动改宽度；'y' = 垂直拖动改高度
 * @property {() => number} getSize - 当前目标元素的尺寸（px）
 *   拖动期间会读多次（每次 mousemove 都会读）；mount 时也会读一次确认初值
 * @property {(px: number) => void} setSize - 把 px 写到目标（CSS 变量 / inline style）
 *   调用方负责写哪儿（:root / .appShell / 元素自身）
 * @property {(px: number) => number} clampSize - clamp 到合法范围（动态边界由调用方负责）
 * @property {(px: number) => void} onDragEnd - 拖完调一次，参数是已 clamp 的 px
 *   调用方负责持久化 / 反算 ratio / 弹错误提示
 * @property {() => number} [initialSize] - 启动初始化。mount 时会用 setSize 应用一次
 * @property {HTMLElement} [body] - 设 cursor/userSelect 的元素，默认 document.body
 * @property {HitZoneOpts} [hitZone] - 扩展命中区（不传 = 不启用）
 * @property {Array<{type: string, listener: Function, options?: AddEventListenerOptions|boolean}>} [windowListeners]
 *   额外挂在 window 上的监听器（如 sidebar 的 resize/scroll 用来失效命中区中线缓存）。
 *   dispose() 时一并解除 —— 与 handle / document 监听器同走同一张表，单点真理。
 * @property {() => (1 | -1)} [getDragSign] - 拖动起点回调，返回 dCoord 的符号：
 *   +1（默认）= 鼠标右移让目标变大；-1 = 鼠标右移让目标变小。
 *   用于「目标元素可以在 splitter 两侧」的场景 —— 例如 AI 面板：split 模式下
 *   AI 在 splitter 左边（鼠标右移 = AI 变大），preview/edit + focus 模式下 AI 在
 *   splitter 右边且贴着窗口右边缘（鼠标右移 AI 会向左扩张，splitter 视觉上反而
 *   左移 → 与鼠标反向）。每次 startDrag 时调用一次，结果用于整次拖动。
 *   不传 = 始终 +1（语义同原 createSplitter，老调用方无需改）。
 */

/**
 * 创建通用拖拽分割条。
 *
 * 鼠标 / 触屏 拖拽的语义与原三段实现一致：
 *   - mouse / touch 都能起拖；触屏用 touch.identifier 关联 touchmove/touchend
 *   - 拖动期间：document.body.style.cursor = 'col-resize' 或 'row-resize'，
 *     userSelect = 'none'；拖完恢复
 *   - 拖完一次：调 onDragEnd(clampSize(getSize()))，由调用方持久化
 *
 * 命中区扩展（hitZone）语义：
 *   - document 级 capture mousedown：鼠标在 ±radius 内且目标不是 handle 自己，
 *     启动拖动（capture 阶段确保在 file-list / editor 等之前拿到事件）
 *   - document 级 mousemove：拖动中按 axis 改尺寸；空闲时按 distanceTo 算 inZone，
 *     通知 onHover 做视觉反馈（默认 cursor）
 *   - 调用方传 isAvailable 返回 false 时，整个命中区逻辑跳过（AI 关闭时）
 *
 * @param {SplitterOpts} opts
 * @returns {{
 *   dispose: () => void,
 *   rebalance?: () => void,
 * }}
 *   dispose  解除挂载的所有 listener（document 级 + handle 级 + window 级）
 *   rebalance 仅当传了 initialSize 时返回 —— 调用方在 window resize / layout 变化
 *            时调，按最新 frSpace / DPI 重算尺寸（不影响持久化值）
 */
export function createSplitter(opts) {
  const {
    handle,
    axis = 'x',
    getSize,
    setSize,
    clampSize,
    onDragEnd,
    initialSize,
    body = (typeof document !== 'undefined' ? document.body : null),
    hitZone = null,
    windowListeners = null,
    getDragSign = null,
  } = opts;

  if (!handle) throw new Error('[splitter] handle 必须是 DOM 元素');
  if (typeof getSize !== 'function') throw new Error('[splitter] getSize 必须是函数');
  if (typeof setSize !== 'function') throw new Error('[splitter] setSize 必须是函数');
  if (typeof clampSize !== 'function') throw new Error('[splitter] clampSize 必须是函数');
  if (typeof onDragEnd !== 'function') throw new Error('[splitter] onDragEnd 必须是函数');

  const cursor = axis === 'x' ? 'col-resize' : 'row-resize';
  // axis 对应的 clientX/Y 字段名
  const coordKey = axis === 'x' ? 'clientX' : 'clientY';
  // 触屏坐标取 touches[i[]. 的 clientX/Y，命名与 coordKey 一致

  /** 当前挂的所有 listener，dispose 时一次性解除 */
  const listeners = [];

  function addListener(target, type, listener, options) {
    target.addEventListener(type, listener, options);
    listeners.push({ target, type, listener, options });
  }

  // 拖拽状态机 —— 与原三段实现语义一致
  let dragging = false;
  let pointerId = null;
  let startCoord = 0;
  let startSize = 0;
  let dragSign = 1; // 当前拖动的 dCoord 符号；getDragSign 在 startDrag 时赋值

  function coordOf(eventLike) {
    return eventLike[coordKey];
  }

  function startDrag(coord, id) {
    dragging = true;
    pointerId = id;
    handle.classList.add('is-dragging');
    startCoord = coord;
    startSize = getSize();
    // 拖动起点的 dCoord 符号：getDragSign 让调用方按当前布局动态决定（+1 / -1）。
    // AI 面板这种「目标元素可落在 splitter 任一侧」的场景，必须每次拖动重新检测，
    // 否则切模式后方向仍按旧符号计算，splitter 视觉上与鼠标反向。
    // 兜底：getDragSign 抛错或返回非 -1/1 时退化为 +1（默认方向），
    // 保证一次坏回调不会让整次拖动卡死（用户能继续拖回正常状态）。
    if (getDragSign) {
      try {
        const sign = getDragSign();
        dragSign = sign === -1 ? -1 : 1;
      } catch {
        dragSign = 1;
      }
    } else {
      dragSign = 1;
    }
    if (body) {
      body.style.cursor = cursor;
      body.style.userSelect = 'none';
    }
  }

  function applyDrag(coord) {
    const dCoord = coord - startCoord;
    setSize(clampSize(startSize + dragSign * dCoord));
  }

  function endDrag() {
    if (!dragging) return;
    dragging = false;
    pointerId = null;
    handle.classList.remove('is-dragging');
    if (body) {
      body.style.cursor = '';
      body.style.userSelect = '';
    }
    onDragEnd(clampSize(getSize()));
  }

  // ----- 自身 handle 上的 mousedown / touchstart -----
  addListener(handle, 'mousedown', (e) => {
    startDrag(coordOf(e), null);
    e.preventDefault();
  });

  addListener(handle, 'touchstart', (e) => {
    const t = e.touches[0];
    if (!t) return;
    startDrag(coordOf(t), t.identifier);
  }, { passive: true });

  // ----- document 级 mousemove / touchmove / ----end -----
  addListener(document, 'mousemove', (e) => {
    if (!dragging || pointerId !== null) return;
    applyDrag(coordOf(e));
  });

  addListener(document, 'touchmove', (e) => {
    if (!dragging || pointerId === null) return;
    const t = Array.from(e.touches).find((x) => x.identifier === pointerId);
    if (!t) return;
    applyDrag(coordOf(t));
  }, { passive: true });

  addListener(document, 'mouseup', endDrag);
  addListener(document, 'touchend', endDrag);
  addListener(document, 'touchcancel', endDrag);

  // ----- 命中区扩展（可选）-----
  if (hitZone) {
    const { radius, isAvailable = () => true, distanceTo, onHover } = hitZone;

    // document 级 capture mousedown：捕获阶段拿到事件，避免被 file-list 等吞掉
    addListener(document, 'mousedown', (e) => {
      if (dragging) return;
      if (e.button !== 0) return; // 只接左键
      if (!isAvailable()) return;
      // handle 自己 / handle 内子节点（含 reset 按钮等）不重入 —— 子节点自己
      // 处理 mousedown（一般带 stopPropagation），否则会出现「点了按钮又拖动」。
      if (handle.contains(e.target)) return;
      if (distanceTo(coordOf(e)) > radius) return;
      e.preventDefault();
      e.stopPropagation();
      startDrag(coordOf(e), null);
    }, true);

    // 拖动中 + 空闲命中区视觉反馈（合并到一个监听器，少派发一次）
    let lastHover = null;
    addListener(document, 'mousemove', (e) => {
      if (dragging) {
        if (pointerId === null) applyDrag(coordOf(e));
        return;
      }
      if (!isAvailable()) return;
      const inZone = distanceTo(coordOf(e)) <= radius;
      if (inZone !== lastHover) {
        lastHover = inZone;
        if (onHover) onHover(inZone);
        else if (body) body.style.cursor = inZone ? cursor : '';
      }
    });
  }

  // ----- 扩展 window 监听器（可选）-----
  // 例如 sidebar splitter 用 resize / scroll 失效命中区中线缓存。
  // 走 addListener 同一张表，dispose() 一次性解除。
  if (windowListeners && windowListeners.length) {
    for (const { type, listener, options } of windowListeners) {
      addListener(window, type, listener, options);
    }
  }

  // ----- 启动初始化 -----
  if (typeof initialSize === 'function') {
    setSize(clampSize(initialSize()));
  }

  // ----- 返回 -----
  const result = {
    /** 解除所有挂载的 listener。可重复调用。 */
    dispose() {
      for (const { target, type, listener, options } of listeners) {
        try { target.removeEventListener(type, listener, options); } catch { /* ignore */ }
      }
      listeners.length = 0;
      if (body) {
        body.style.cursor = '';
        body.style.userSelect = '';
      }
      handle.classList.remove('is-dragging');
    },
  };

  // 仅当调用方传 initialSize 时才暴露 rebalance —— 让"窗口 resize 时按 frSpace 重算"
  // 这类外部触发走单点真理（避免多个 mountSplitter 都各自挂 resize 监听器）。
  if (typeof initialSize === 'function') {
    result.rebalance = () => {
      if (dragging) return;
      setSize(clampSize(initialSize()));
    };
  }

  return result;
}