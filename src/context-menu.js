// 自定义右键菜单
//
// 用于 markdown 阅读视图和编辑器，统一支持：复制 / 剪切 / 粘贴 / 全选。
//
// 设计要点：
// - 单一浮动菜单实例，按需定位显示（同一时刻只可能有一个菜单）
// - 选项根据上下文（是否可编辑 / 是否有选区）动态启用禁用
// - 完全基于 navigator.clipboard，不依赖浏览器默认菜单
// - 显示位置靠近视口边缘时自动向内收缩
// - 在 mousedown / 第二个 contextmenu / ESC / scroll / resize 时自动关闭

const MENU_ID = 'app-context-menu';

/**
 * 右键菜单项定义
 * @typedef {object} ContextMenuItem
 * @property {string} label     - 显示文本
 * @property {string} value    - 点击时回调收到的值
 * @property {boolean} [disabled]
 * @property {boolean} [danger]   - 破坏性操作（删除等）：红色文字 + 红色 hover 底
 * @property {boolean} [separator] - 若为 true 则渲染为分隔条（忽略其它字段）
 */

/**
 * 菜单配置
 * @typedef {object} ContextMenuShowOptions
 * @property {number} x - 视口 x 坐标
 * @property {number} y - 视口 y 坐标
 * @property {ContextMenuItem[]} items
 * @property {(value: string) => void} onSelect
 */

export class ContextMenu {
  /**
   * @param {object} [options]
   * @param {HTMLElement} [options.container] - 菜单挂载容器（默认 document.body）
   */
  constructor({ container } = {}) {
    this.container = container || document.body;
    this.element = null;
    this.onSelectCallback = null;
    // audit fix (Settings P3 / context-menu focus restore)：
    // 记录 show 之前 document.activeElement —— hide() 时尝试把焦点还回去。
    // 原版没记录，菜单关闭后焦点散落到 <body>，键盘用户失位：
    //   - 侧栏 file-list 右键 → 选「重命名」后 dialog 打开，关闭后焦点
    //     跑回 body 而非原先选中的 file-list item，键盘用户必须再 Tab
    //     一遍才能继续上下选。
    //   - 编辑器右键 → 选「全选」或「粘贴」后，焦点丢在 body。
    // 守卫：忽略 <body> / <html>，避免把焦点「还」到根（与 focus-trap.js
    // dispose 路径保持同样的 prevFocus 过滤）。
    this._prevFocus = null;
    this._blurFrame = null;

    // 提前 bind，方便 add/removeEventListener 引用同一函数
    this._onDocMouseDown = this._onDocMouseDown.bind(this);
    this._onDocContextMenu = this._onDocContextMenu.bind(this);
    this._onWindowScroll = this._onWindowScroll.bind(this);
    this._onWindowResize = this._onWindowResize.bind(this);
    this._onKeydown = this._onKeydown.bind(this);
    this._onMenuFocusOut = this._onMenuFocusOut.bind(this);
  }

  /**
   * 显示菜单
   * @param {ContextMenuShowOptions} options
   */
  show({ x, y, items, onSelect }) {
    this.hide();

    if (!Array.isArray(items) || items.length === 0) return;

    this.onSelectCallback = onSelect || null;
    // 捕获 prevFocus：在菜单创建之前 activeElement 已经是「用户操作过的元素」，
    // hide() 还要把焦点还回它。守卫 body/rootElement（与 focus-trap.js 同套）。
    {
      const ae = document.activeElement;
      this._prevFocus = (ae && ae !== document.body && ae !== document.documentElement
        && typeof ae.focus === 'function') ? ae : null;
    }

    const menu = document.createElement('div');
    menu.id = MENU_ID;
    menu.className = 'context-menu';
    menu.setAttribute('role', 'menu');
    // audit L (a11y)：menu 隐含 vertical orientation，但显式声明可减少
    // 屏幕阅读器误判（NVDA / JAWS 习惯按 aria-orientation 决定是 ←/→ 还是 ↑/↓）
    menu.setAttribute('aria-orientation', 'vertical');

    /** @type {HTMLButtonElement[]} */
    const menuItems = [];
    for (const item of items) {
      if (item && item.separator) {
        const sep = document.createElement('div');
        sep.className = 'context-menu-separator';
        sep.setAttribute('role', 'separator');
        menu.appendChild(sep);
        continue;
      }
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'context-menu-item';
      btn.setAttribute('role', 'menuitem');
      btn.textContent = item.label;
      if (item.danger) {
        btn.classList.add('is-danger');
      }
      if (item.disabled) {
        btn.disabled = true;
      }
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (btn.disabled) return;
        const value = item.value;
        // audit fix：先保存回调再 hide() —— hide() 内部会把 this.onSelectCallback
        // 清成 null（旧顺序：hide() 在前 → 后续 if 检查永远失败 → 右键菜单点击
        // 全部静默失效）。这影响所有右键入口（侧栏 重命名/在文件夹中显示/删除、
        // 编辑器 复制/剪切/粘贴/全选）。
        const cb = this.onSelectCallback;
        this.hide();
        if (cb) cb(value);
      });
      menu.appendChild(btn);
      menuItems.push(btn);
    }

    this.container.appendChild(menu);
    this.element = menu;
    // 保留菜单项引用，供方向键导航复用。
    this._items = menuItems;

    // 定位：菜单尺寸必须先知道，所以先 append 再算坐标。
    // 视口边缘自适应收缩（避免菜单跑出屏幕外）。
    const rect = menu.getBoundingClientRect();
    const margin = 4;
    const maxX = window.innerWidth - rect.width - margin;
    const maxY = window.innerHeight - rect.height - margin;
    const left = Math.max(margin, Math.min(x, Math.max(margin, maxX)));
    const top = Math.max(margin, Math.min(y, Math.max(margin, maxY)));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;

    // 关闭监听必须在本次 contextmenu 事件结束之后再绑定，
    // 否则本次的 mousedown 不会触发（右键按下时也会派发 mousedown），
    // 但其他位置再点右键时本次菜单应被关闭，所以下一次 contextmenu 仍要监听。

    // audit #C3 fix (memory leak critical)：保存 rAF handle。
    // 旧实现：hide() 同步把 this.element = null，但 rAF 回调里依然跑
    // addEventListener — 如果用户在同一帧内连续 show→hide→show（旧菜单点选项
    // 触发 onSelect 立即 hide，新菜单又 show），第一次的 rAF 仍会 fire，
    // 给 document / window 挂上 5 个 listener，且永远不会被 removeEventListener
    // 回收（hide 看 this.element === null 直接 early-return）。每个周期泄漏 5 个
    // listener，伴随绑定函数对 this 的强引用 → GC 不掉 → 右键速度随时间线性变慢。
    // 现在：hide() 先 cancelAnimationFrame，下次 show 再请求；rAF 内若 this.element
    // 已不是刚绑定的菜单，则不挂监听（防御性二次校验）。
    this._attachFrame = requestAnimationFrame(() => {
      this._attachFrame = null;
      // 二次校验：rAF fire 时如果 hide 已跑（this.element 已 null），跳过监听绑定。
      if (!this.element || this.element !== menu) return;
      document.addEventListener('mousedown', this._onDocMouseDown, true);
      document.addEventListener('contextmenu', this._onDocContextMenu, true);
      window.addEventListener('scroll', this._onWindowScroll, true);
      window.addEventListener('resize', this._onWindowResize, true);
      document.addEventListener('keydown', this._onKeydown, true);
      // audit fix (Settings P3 / context-menu blur close)：菜单自身的 focusout。
      // 旧版只盯 mousedown / contextmenu / scroll / resize / Esc —— 但用户用
      // Tab 把焦点移出菜单再点别处时不会触发 mousedown（focus 已经离开菜单），
      // 菜单留在屏幕上"卡死"。挂 focusout 在 capture 阶段，检查 relatedTarget
      // 是否仍在菜单内 —— 不在则收起。
      menu.addEventListener('focusout', this._onMenuFocusOut, true);
      // audit H (a11y)：菜单打开后立即把焦点放在第一个非 disabled 项，
      // 否则键盘用户没法用菜单（Tab 会跳到下个页面元素）。WAI-ARIA menu 模式
      // 要求"打开后焦点进入菜单"。
      const first = menuItems.find((b) => !b.disabled);
      if (first) first.focus();
    });
  }

  /**
   * 主动关闭菜单
   */
  hide() {
    // 取消未 fire 的 rAF，避免它在我们 detach 之后再去挂监听（见 show 注释）。
    if (this._attachFrame != null) {
      cancelAnimationFrame(this._attachFrame);
      this._attachFrame = null;
    }
    if (!this.element) return;
    const menu = this.element;
    document.removeEventListener('mousedown', this._onDocMouseDown, true);
    document.removeEventListener('contextmenu', this._onDocContextMenu, true);
    window.removeEventListener('scroll', this._onWindowScroll, true);
    window.removeEventListener('resize', this._onWindowResize, true);
    document.removeEventListener('keydown', this._onKeydown, true);
    menu.removeEventListener('focusout', this._onMenuFocusOut, true);
    if (menu.parentElement) {
      menu.parentElement.removeChild(menu);
    }
    this.element = null;
    this._items = null;
    this.onSelectCallback = null;

    // audit fix (Settings P3 / context-menu focus restore)：hide 完成后
    // 把焦点还回 prevFocus。rAF 推一拍 —— 此刻 menu 刚 removeChild，焦点
    // 已经因 focusout / mousedown 落到 body；rAF 让出这一帧让用户操作稳定，
    // 再把焦点给回 prevFocus，避免被后续的 focus() 事件覆盖。
    if (this._prevFocus) {
      const target = this._prevFocus;
      this._prevFocus = null;
      // 二次校验：节点可能被外部重渲染撕下 DOM（file-list 在 files:changed
      // 重建），与 focus-trap.js dispose 的 isConnected 守卫保持一致。
      if (target.isConnected) {
        requestAnimationFrame(() => {
          try { target.focus({ preventScroll: true }); } catch { /* ignore */ }
        });
      }
    }
  }

  /** 当前是否处于显示状态 */
  isVisible() {
    return !!this.element;
  }

  _onDocMouseDown(e) {
    if (this.element && this.element.contains(e.target)) return;
    this.hide();
  }

  _onDocContextMenu(e) {
    // 同一菜单内的右键：忽略，让菜单保持显示
    if (this.element && this.element.contains(e.target)) return;
    // 其它位置的右键：先关掉自己，由后续事件处理器决定是否打开新菜单
    this.hide();
  }

  _onWindowScroll() {
    this.hide();
  }

  _onWindowResize() {
    this.hide();
  }

  _onKeydown(e) {
    if (e.key === 'Escape') {
      this.hide();
      return;
    }
    // audit H (a11y)：menu 模式的方向键导航 —— ↑/↓ 移动焦点（跳过 disabled
    // 与 separator），Home/End 跳首尾。WAI-ARIA Authoring Practices 推荐。
    if (!this._items || this._items.length === 0) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
      // 只在焦点仍在菜单内时拦截 —— 防止外部其它快捷键（如 editor 里的
      // 方向键移动光标）被这里吞掉。
      const active = document.activeElement;
      const inMenu = active && this.element && this.element.contains(active);
      if (!inMenu) return;
      e.preventDefault();
      const enabled = this._items.filter((b) => !b.disabled);
      if (enabled.length === 0) return;
      let idx = enabled.indexOf(active);
      if (idx === -1) idx = e.key === 'ArrowUp' ? enabled.length - 1 : 0;
      else if (e.key === 'ArrowDown') idx = (idx + 1) % enabled.length;
      else if (e.key === 'ArrowUp') idx = (idx - 1 + enabled.length) % enabled.length;
      else if (e.key === 'Home') idx = 0;
      else if (e.key === 'End') idx = enabled.length - 1;
      enabled[idx].focus();
    }
  }

  // audit fix (Settings P3 / context-menu blur close)：
  // 焦点离开菜单时收起。
  //   - capture 阶段抓 —— 让外层 focusout handler 先跑完（例如文件列表
  //     自己的 focus 高亮），我们再决定是否要 hide。
  //   - relatedTarget 为 null（窗口失焦 / DevTools 抓走焦点）也收起，避免
  //     菜单"卡在屏幕上谁都看不见"。
  //   - rAF 推一拍：focusout 与 mousedown 同帧时，rAF 让 mousedown 的
  //     _onDocMouseDown 路径有机会先关菜单、避免双触发。
  _onMenuFocusOut(e) {
    if (!this.element) return;
    const next = e.relatedTarget;
    if (next && this.element.contains(next)) return;
    if (this._blurFrame != null) return;
    this._blurFrame = requestAnimationFrame(() => {
      this._blurFrame = null;
      this.hide();
    });
  }
}