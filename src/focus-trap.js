// 焦点陷阱 —— 通用最小可工作版
//
// 解决两件事：
//   1. Tab / Shift+Tab 在容器内循环，不外溢到背景 DOM
//   2. 关闭时把焦点还给打开前的元素
//
// 不做（避免过度工程）：
//   - 自动找"第一个 focusable"作为初始焦点 —— 由调用方传入 initialFocus 更明确
//   - 屏幕阅读器特殊处理 —— aria-modal + aria-hidden 已交给调用方
//   - 焦点恢复时滚屏校正 —— focus({ preventScroll: true }) 即可
//
// 调用约定：
//   const trap = createFocusTrap(overlay, {
//     initialFocus: overlay.querySelector('input, button, [tabindex]:not([tabindex="-1"])'),
//     signal: abortController.signal,   // 可选：signal abort 时自动 dispose
//   });
//   ...
//   trap.dispose();   // 把焦点还给 prevFocus

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export function createFocusTrap(container, { initialFocus = null, signal = null, fallback = null } = {}) {
  if (!container) throw new Error('createFocusTrap: container 必填');

  // audit fix：原条件只排除 body，但 <html>（documentElement）也是
  // document.activeElement 的常见值（焦点漂移到根节点 —— 例如布局 reflow
  // 期间、点击非可聚焦区域后）。<html>.focus() 是合法但无视觉焦点的
  // no-op，导致 dispose 后屏幕阅读器 / 键盘用户的虚拟焦点被困在已关闭
  // 的模态内。这里把 documentElement / body 都视为「无效 prevFocus」，
  // 返回 null；dispose 会直接跳过 focus 调用，焦点自然落到 body 上。
  const ae = document.activeElement;
  const prevFocus = (ae && ae !== document.body && ae !== document.documentElement
    && typeof ae.focus === 'function') ? ae : null;

  // 容器自身需要能接收焦点，否则 Tab 从末尾跳到第一个时容器不会被激活
  const hadTabindex = container.hasAttribute('tabindex');
  if (!hadTabindex) {
    container.setAttribute('tabindex', '-1');
  }

  /** @returns {HTMLElement[]} */
  function getFocusable() {
    // H1 fix (audit)：原 filter 用 `el.offsetParent !== null` 判断可见性，
    // 但 `position: fixed` 元素的 offsetParent === null，会被误判成「不可见」
    // 从 Tab 序列里剔除。模态里有 sticky 按钮 / 浮动操作按钮（如未来加的
    // 「在此打开文件夹」），Tab 会跳过它们到末尾后跳回首项，无法到达。
    // 用 `getClientRects().length > 0` 兜住 fixed / sticky，且对 display:none
    // 仍然返回空（hidden 元素没有 layout box）。已聚焦的 fixed 元素保留。
    //
    // 审计修复 (Round 11)：还要排除以下三类元素：
    //   - visibility: hidden —— 仍有 client rects（filter 里已放过），但 .focus()
    //     是 silent no-op；Tab 序列走到这里 → first.focus() 落在 no-op 元素上 →
    //     「Tab 死掉」的假象
    //   - inert 子树 —— W3C 新标准，把子树标记为不可交互；closest('[inert]')
    //     命中即剔除
    //   - aria-hidden=true 子树 —— 屏幕阅读器跳过；但键盘 Tab 仍可能命中，
    //     排除防止 Tab 看着「消失」
    // contenteditable 显式加入选择器，CM 编辑器嵌入 modal 时能正常 Tab 进。
    return Array.from(container.querySelectorAll(FOCUSABLE_SELECTOR + ',[contenteditable]:not([contenteditable="false"])'))
      .filter((el) => {
        if (el.getClientRects().length === 0 && el !== document.activeElement) return false;
        if (el.closest && el.closest('[inert],[aria-hidden="true"]')) return false;
        // visibility:hidden 元素的 clientWidth/Height 仍可能 > 0，但 getComputedStyle
        // 拿到 visibility === 'hidden'。已经聚焦的元素（activeElement）保留——可能
        // 是「用户主动聚焦后外部样式改了 visibility」的边角，dispose 时回退路径不应
        // 把已聚焦元素从序列里踢出。
        if (el !== document.activeElement) {
          const cs = (typeof window !== 'undefined' && window.getComputedStyle) ? window.getComputedStyle(el) : null;
          if (cs && cs.visibility === 'hidden') return false;
        }
        return true;
      });
  }

  function onKeydown(e) {
    // audit fix (Phase O-L14)：Tab 也守 IME 合成。
    // 与 shortcuts.js:84 / markdown-editor.js 风格一致：CJK 拼音输入中途按 Tab
    // 选候选词（Windows IME 习惯），focus-trap 不能把焦点甩到下一个按钮。
    // 当前 modal 没有 IME 重输入控件（settings / confirm / prompt 都是普通
    // input），潜在风险。但保持一致性：所有 document-level keydown listener
    // 都守 isComposing / keyCode=229。
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key !== 'Tab') return;
    const items = getFocusable();
    if (items.length === 0) {
      // 没有可聚焦元素：把焦点留在容器上，避免跳出去
      e.preventDefault();
      container.focus();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey) {
      if (active === first || !container.contains(active)) {
        e.preventDefault();
        last.focus();
      }
    } else {
      if (active === last || !container.contains(active)) {
        e.preventDefault();
        first.focus();
      }
    }
  }

  container.addEventListener('keydown', onKeydown);

  let disposed = false;
  function dispose() {
    if (disposed) return;
    disposed = true;
    container.removeEventListener('keydown', onKeydown);
    // audit fix (renderer-M10)：只在是我们自己注入的 tabindex 时移除，
    // 宿主原有值（如 HMR 复用场景下节点本身带 tabindex）原样保留。
    if (!hadTabindex) {
      container.removeAttribute('tabindex');
    }
    if (prevFocus && typeof prevFocus.focus === 'function') {
      // 审计修复 (Round 11)：dispose 时重验 isConnected。
      // prevFocus 在 capture 阶段（第 38-40 行）只检查 !== body/rootElement，
      // 但 modal 期间 prevFocus 可能被外部重渲染 / 撕下 DOM —— 例如：
      //   - file-list 右键菜单 → 「重命名」 → 弹 prompt-dialog；
      //     菜单 close 时整块被 unmount，prevFocus 已 detached，
      //     .focus() 是 silent no-op，焦点落到 <body>，键盘用户失位。
      //   - 文件列表 items 在 files:changed 事件里重建，prevFocus 同样 detached。
      // 重新检查 isConnected；连接不上时回退到稳定锚点（caller 提供
      // 的 fallback）—— 而不是让焦点散落到 <body>。
      //
      // audit fix (Settings P3 / focus-trap fallback lift)：原来这里
      // 硬编码 `document.getElementById('file-list')` 作为兜底 —— 把
      // 「renderer 侧具体 DOM 节点」写进通用 focus-trap，跨上下文错位：
      //   - settings-dialog 关掉 → 焦点跳到 #file-list，语义错位
      //     （用户在设置里改东西，期望焦点回设置前的位置）
      //   - confirm / prompt / 未来 AI 弹窗同样问题
      //   - 通用包里写死具体 id，一旦 #file-list 改名/删名静默退化到 <body>
      // 现在让 caller 通过 fallback 选项传一个语义匹配的节点；未传则按
      // fallback 节点 → document.body 的顺序找第一个仍 connected 的。
      // 之前 modal.js 调用点没传 fallback，下面 mountModal 那侧会传入
      // 一个 caller 级别的稳定锚点（modal.options.fallbackFocus）。
      let restoreTarget = prevFocus;
      if (!prevFocus.isConnected) {
        const candidates = [fallback, document.body].filter(Boolean);
        restoreTarget = candidates.find((el) => {
          try { return el && typeof el.isConnected === 'boolean' && el.isConnected; }
          catch { return false; }
        }) || document.body;
      }
      try { restoreTarget.focus({ preventScroll: true }); } catch { /* ignore */ }
    }
  }

  if (signal) {
    if (signal.aborted) dispose();
    else signal.addEventListener('abort', dispose, { once: true });
  }

  // 初始焦点：异步让出渲染时间，避免被外层 setTimeout(0) 抢走
  queueMicrotask(() => {
    if (disposed) return;
    const target = initialFocus || getFocusable()[0] || container;
    try { target.focus({ preventScroll: true }); } catch { /* ignore */ }
  });

  return { dispose };
}