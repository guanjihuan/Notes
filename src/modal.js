// 通用 modal 骨架 —— 集中 ARIA / Esc / overlay-click / focus-trap / 单槽冲突
//
// 之前 settings-dialog.js 与 confirm-dialog.js 字符级复制了同样的 modal-overlay
// 骨架 + 一套关闭事件（overlay-click / Esc / × 按钮）+ focus-trap 接线。
// 抽到一处后，aria 属性、focus 行为、生命周期都只有一份代码可改。
//
// 设计目标：
//   - 调用方只关心「标题 / 正文 / 按钮」三件事
//   - 关闭路径（Esc / 点背景 / × 按钮）由 modal 自身统一处理
//   - 调用方可以自定义「关闭时取什么值」（resolve(value)）
//   - 提供 closeValue / updateBody 等逃生口用于更新对话框内容
//
// 调用方式：
//   const modal = mountModal({
//     title: '...',
//     body: '<p>...</p>',     // 直接 HTML 字符串（调用方负责 escape）
//     footer: '<button>...</button>',
//     onAction: (action, modal) => { ... },  // data-action 的按钮触发
//     onBackdropClose: () => 'cancel',       // 点背景/Esc/× → 哪个 value
//     initialFocus: el,
//   });
//   // 需要关闭时：modal.close(value)
//   // 需要更新正文：modal.setBody(html)

import { escapeHtml } from './utils.js';
import { isOpen as modalIsOpen, register as modalRegister, unregister as modalUnregister } from './modal-stack.js';
import { createFocusTrap } from './focus-trap.js';
import { showToast } from './feedback.js';

/**
 * 关闭按钮 SVG（×）—— 单一来源
 */
const CLOSE_BUTTON_SVG = `
  <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
    <line x1="0" y1="0" x2="10" y2="10" stroke="currentColor" stroke-width="1"/>
    <line x1="10" y1="0" x2="0" y2="10" stroke="currentColor" stroke-width="1"/>
  </svg>
`;

/**
 * 挂一个 modal 到 #modal-root，并返回控制器。
 *
 * @param {object} options
 * @param {string} options.title - 标题文本
 * @param {string} [options.body=''] - 正文 HTML（调用方负责 escape；可用 setBody() 后续更新）
 * @param {string} [options.footer=''] - 底部 HTML（一般放按钮；按钮带 data-action，触发 onAction）
 * @param {(action: string, modal: ModalController) =>
 *     ('close' | undefined | void | Promise<'close' | undefined | void>)} [options.onAction]
 *   任意 data-action 按钮点击时触发。返回 'close' 时 modal 会自动 close(action)；
 *   返回 undefined / void 时 modal 不关，由调用方决定何时 close。
 *
 *   **同步 / 异步两种形态都支持**（审计修复 Round 11 vol.2）：
 *   - 同步函数返回 'close' → 立即同步路径关闭（零延迟）
 *   - 同步函数返回 undefined → 不关
 *   - 异步函数 resolve 'close' → 微任务里关闭
 *   - 异步函数 reject → toast「操作失败：…」(2.4s) + modal 保持打开
 *   - 同步函数 throw → 同上（toast + 不关）
 *
 *   实现细节：modal.js 内部用 `Promise.resolve(result).then(...).catch(...)` 把
 *   两种形态统一成一个 Promise 链；同步 throw 由外层 try/catch 接。**onAction
 *   只会被调用一次** —— 不要在同步与异步路径里各实现一遍业务逻辑。
 * @param {string} [options.onBackdropClose='cancel']
 *   点 overlay 背景 / 按 Esc / 点 × 按钮时调 close() 用的 value。
 * @param {HTMLElement|string} [options.initialFocus]
 *   初始焦点元素（或选择器）。默认聚焦 footer 最后一个按钮，否则首个可聚焦元素。
 * @param {string} [options.titleId] - aria-labelledby 指向的元素 id（默认自动生成 modal-title-{counter}）
 * @param {HTMLElement} [options.fallbackFocus]
 *   focus-trap 关闭时，若打开前 activeElement 已从 DOM 移除（菜单项被 unmount /
 *   files:changed 重建列表等），焦点回不到原位的兜底锚点。默认 document.body。
 *   一般传「打开 modal 之前最常交互的元素」：file-list 右键菜单 → 焦点会回
 *   那个 item；search 输入触发的搜索结果 dialog → 回搜索框。**不传**的话
 *   focus-trap 内置回 document.body。
 * @returns {ModalController|null} null = 没拿到 #modal-root；或已有 modal 占位
 */
export function mountModal({
  title,
  body = '',
  footer = '',
  onAction,
  onBackdropClose = 'cancel',
  initialFocus,
  titleId,
  fallbackFocus = null,
}) {
  const root = document.getElementById('modal-root');
  if (!root) {
    console.error('[modal] #modal-root 缺失');
    return null;
  }

  // 占位检测：与 modal-stack 单槽策略一致；调用方若需要排队，应自己处理。
  if (modalIsOpen()) return null;

  const abort = new AbortController();
  const id = titleId || `modal-title-${Date.now().toString(36)}`;

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', id);
  overlay.innerHTML = `
    <div class="modal" role="document">
      <div class="modal-header">
        <h2 id="${escapeHtml(id)}" class="modal-title">${escapeHtml(title)}</h2>
        <button class="modal-close" type="button" data-action="__modal_close__" aria-label="关闭">${CLOSE_BUTTON_SVG}</button>
      </div>
      <div class="modal-body" data-modal-body></div>
      <div class="modal-footer" data-modal-footer></div>
    </div>
  `;

  // 正文 / footer 用单独容器而非 innerHTML 整段注入，让调用方可以走安全的文本/HTML 边界。
  const bodyEl = overlay.querySelector('[data-modal-body]');
  const footerEl = overlay.querySelector('[data-modal-footer]');
  if (body) bodyEl.innerHTML = body;
  if (footer) footerEl.innerHTML = footer;

  root.replaceChildren(overlay);
  modalRegister(overlay);

  // 审计修复 (Round 11 vol.2)：挂 inert 背景 app 根节点。
  // modal-overlay 本身在 #modal-root 里（独立容器），它的子树不影响背景 DOM。
  // 但 background DOM（#app / #file-list / 编辑器 / 工具栏）默认仍然可交互——
  // 屏幕阅读器会朗读背景、键盘 Tab 在某些浏览器上仍能跳出 modal、IME 焦点
  // 路径不直观。aria-modal="true" 在 AT 上一致性差，给背景打 inert 是
  // W3C 推荐的标准化隔离方式。
  //
  // 选择 #app 而非 document.body —— body 上 inert 会同时让 modal 自身失活；
  // #app 是背景应用的稳定根，生命周期长于单次 modal。
  // 多 modal 嵌套：当前是单槽设计，不会同时开两个；嵌套场景在 modal-stack 升级到
  // 真栈后单独处理。
  const appRoot = document.getElementById('app');
  const prevAppInert = appRoot ? appRoot.hasAttribute('inert') : false;
  if (appRoot && !prevAppInert) {
    appRoot.setAttribute('inert', '');
  }

  // 关闭逻辑：单一入口，所有路径（overlay-click / Esc / × / onAction 触发）最终都走这里。
  // onClose 改成回调数组：调用方多次 setOnClose 不再互相覆盖（之前 settings-dialog
  // 注册的「清空 API Key」就被后注册的 resolve 静默丢弃，P1-1 修复失效）。
  let closed = false;
  const onCloseCallbacks = [];
  const close = (value) => {
    if (closed) return;
    closed = true;
    abort.abort();
    if (overlay.parentElement) overlay.parentElement.removeChild(overlay);
    modalUnregister(overlay);
    // 复位背景 inert —— 之前没设置过就别删（防御上游已经手动设 inert 的场景，
    // 例如正在跑加载遮罩，modal 不应擦掉它的标记）。
    if (appRoot && !prevAppInert && appRoot.hasAttribute('inert')) {
      appRoot.removeAttribute('inert');
    }
    // 按注册顺序全部调用；单个 throw 不应阻断其它清理（例如清空敏感字段必须在 resolve 之前）
    for (const cb of onCloseCallbacks) {
      try {
        cb(value);
      } catch (e) {
        console.error('[modal] onClose callback threw:', e);
      }
    }
  };

  // 点背景（点击 overlay 本身而非 modal） → onBackdropClose
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close(onBackdropClose);
  }, { signal: abort.signal });

  // Esc → onBackdropClose
  //
  // 审计修复 (Round 11)：Esc 必须守 IME 合成期 + stopPropagation。
  //   1) isComposing / keyCode=229 守卫：CJK 拼音期按 Esc 是「关闭候选词」而不是「关弹窗」。
  //      旧版误关 → 用户的拼音/候选词全废、rename/new-note resolve(null) 静默吞掉。
  //      与 focus-trap.js:67 / shortcuts.js:80 / prompt-dialog.js:148 保持一致。
  //   2) e.stopPropagation()：modal 关掉的同一帧 focus 回到 prevFocus（搜索框），
  //      event 继续冒泡到 document，shortcuts.js:75 看到 activeElement 是 #search-input
  //      且 !modalOpen → 调 onClearSearch() 把用户搜索词一并清掉，与用户意图无关的副作用。
  overlay.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close(onBackdropClose);
    }
  }, { signal: abort.signal });

  // [data-action] 按钮：× 按钮（__modal_close__）+ footer 自定义按钮。
  // **不拦截 body 内的 [data-action]** —— 那是 dialog 自己的 in-body action，
  // 由 dialog 各自 bind 处理（例如 settings-dialog 的「显示/隐藏 API Key」「清空
  // AI 配置」按钮）。之前无差别拦截所有 [data-action]，body 内这些按钮会被
  // onAction 误判为 modal-level 动作（onAction 默认返回 'close' → 立即关 modal），
  // 点「显示」结果 modal 直接关掉，UX 直接坏掉。
  // 文档化契约：data-action 是 modal-level（footer/header），in-body 行为用别的属性。
  overlay.addEventListener('click', (e) => {
    const target = e.target.closest('[data-action]');
    if (!target || !overlay.contains(target)) return;
    const action = target.dataset.action;
    if (action === '__modal_close__') {
      close(onBackdropClose);
      return;
    }
    // 只处理 footer 内的 data-action；body 内的交给 dialog 自己的 listener
    if (!footerEl.contains(target)) return;
    if (!onAction) return;
    // audit fix (Round 8 M-3)：onAction 抛同步错时 modal 不会关，footer 按钮
    // 「死」了用户没法关窗。try/catch 后错误打 console，模态保持打开让用户
    // 看到具体错误（dialog 自己负责 catch 业务错误；这里是兜底防御）。
    //
    // 审计修复 (Round 11)：onAction 现在支持同步 / 异步两种形态。
    //   - 同步 throw → try/catch 接住
    //   - 同步 return 'close' → 同步路径直接 close(action)
    //   - 同步 return 其他 → 不关（与旧行为一致）
    //   - 异步 reject → Promise.resolve().catch() 接，escape 到
    //     window.onunhandledrejection，modal 永不关、footer 按钮「死」
    //   - 异步 resolve 'close' → .then(r => r === 'close' && close(action))
    // 把同步 + 异步统一成一个 Promise 链，避免双重调用 onAction（否则 rename
    // / 清 Key 等会被执行两次）。
    let result;
    try {
      result = onAction(action, controller);
    } catch (e) {
      console.error('[modal] dialog onAction 抛出异常:', action, e);
      try {
        const msg = (e && typeof e.message === 'string' && e.message) || '操作失败';
        showToast(`操作失败：${msg}`, 'error', 2400);
      } catch { /* toast 自身抛错就吞 */ }
      return;
    }
    // 同步 'close' 直接关（保持旧路径零延迟）；否则交给 Promise.resolve
    // 处理（同步非 promise 值 / Promise 都接得住）。
    if (result === 'close') {
      close(action);
      return;
    }
    Promise.resolve(result).then((r) => {
      if (r === 'close') close(action);
    }).catch((e) => {
      console.error('[modal] dialog onAction 异步异常:', action, e);
      try {
        const msg = (e && typeof e.message === 'string' && e.message) || '操作失败';
        showToast(`操作失败：${msg}`, 'error', 2400);
      } catch { /* ignore */ }
    });
  }, { signal: abort.signal });

  // 焦点陷阱（focus-trap 内部已订阅 abort.signal 自动 dispose，这里不需保留引用）。
  // audit fix (Settings P3 / focus-trap fallback lift)：fallbackFocus 由 caller
  // 传入，prevFocus 被外部重渲染/撕下 DOM 时焦点回这个锚点（见 focus-trap.js
  // dispose 路径）。默认 null → focus-trap 内部回 document.body。
  createFocusTrap(overlay, {
    initialFocus: resolveInitialFocus(initialFocus, footerEl),
    signal: abort.signal,
    fallback: fallbackFocus,
  });

  const controller = {
    /** overlay 根节点 */
    overlay,
    /** 内层 .modal */
    modal: overlay.querySelector('.modal'),
    /** 正文容器（可写入 innerHTML） */
    body: bodyEl,
    /** footer 容器 */
    footer: footerEl,
    /** 显式关闭（带 value，可由 onClose 拦截） */
    close,
    /** 替换正文 HTML */
    setBody(html) { bodyEl.innerHTML = html; },
    /** 替换 footer HTML */
    setFooter(html) {
      footerEl.innerHTML = html;
      // 重新绑定 footer 按钮的事件已经在 overlay 上委托，无需重绑
    },
    /** 暴露 AbortController，方便调用方挂自己的 listener 到同生命周期 */
    abortSignal: abort.signal,
    /**
     * 注册关闭回调。每次 close(value) 时按注册顺序全部调用一次。
     * 多次注册不会被覆盖 —— 调用方可以分别挂上「清理副作用」「resolve promise」
     * 等独立关注点，而不必合并到一个回调里。
     * @param {(value: string) => void} cb
     */
    setOnClose(cb) { onCloseCallbacks.push(cb); },
  };

  return controller;
}

/**
 * 解析 initialFocus：HTMLElement 直接用；字符串 → querySelector；undefined →
 * footer 第一个安全按钮。
 *
 * audit fix (H2-renderer)：之前默认焦点是「最后一个按钮」—— 对 confirm-dialog
 * 之类 [取消, 删除] / [取消, 确认] 布局，最右侧往往是 primary/danger，按 Enter
 * 就直接执行破坏性操作。改成「第一个 .btn-secondary（安全的取消类），没有再
 * 回退到第一个按钮」：用户按 Enter 默认是安全的取消/返回，符合 WAI-ARIA
 * "least destructive option" 原则；需要主动执行破坏性动作时再鼠标/Tab 选。
 *
 * @param {HTMLElement|string|undefined} initialFocus
 * @param {HTMLElement} footerEl
 * @returns {HTMLElement|null}
 */
function resolveInitialFocus(initialFocus, footerEl) {
  if (initialFocus instanceof HTMLElement) return initialFocus;
  if (typeof initialFocus === 'string') {
    return document.querySelector(initialFocus);
  }
  if (footerEl) {
    const safe = footerEl.querySelector('.btn.btn-secondary');
    if (safe) return safe;
    const btns = footerEl.querySelectorAll('.btn');
    if (btns.length > 0) return btns[0];
  }
  return null;
}

/**
 * @typedef {object} ModalController
 * @property {HTMLElement} overlay
 * @property {HTMLElement} modal
 * @property {HTMLElement} body
 * @property {HTMLElement} footer
 * @property {(value: string) => void} close
 * @property {(html: string) => void} setBody
 * @property {(html: string) => void} setFooter
 * @property {AbortSignal} abortSignal
 * @property {(cb: (value: string) => void) => void} setOnClose
 */
