// 侧边栏文件列表组件
// 职责：渲染文件列表 + 处理点击 + 处理搜索过滤 + 排序
//
// 与 Todo List 的 sidebar.js 区别：移除分类、子分类、右键菜单、拖拽、智能列表。
// 只保留 "扁平文件列表 + 点击打开 + 搜索过滤 + 排序" 这四件事。
//
// Stage 8（Folder Browser）：
//   列表里可以同时出现三种条目：
//     - entryType === 'folder'  : 进入子目录 → onSelect(entry) 中 entryType === 'folder'
//     - entryType === 'editable': 打开编辑 → onSelect(entry) 中 entryType === 'editable'
//     - entryType === 'binary'  : 不支持打开，点击弹 toast → onSelect(entry) 中 entryType === 'binary'
//   渲染端 (app.js) 在 onSelect 里按 entryType 分发；本组件只负责按类型画图标 + 类名。
//   data-path 仍用绝对路径（文件夹也有 path = 绝对目录），保持事件委托反查统一。

import { formatSize, formatRelativeTime, pathsEqual } from './utils.js';
import { createDisposable } from './component.js';

/**
 * 文件名 fuzzy 匹配（子序列 + 评分）
 *
 * 算法：query 的每个字符按顺序出现在 name 里（不要求相邻）。
 *   - 大写 / 小写不敏感（两端都 lowercase 后比较）
 *   - 越靠前的命中越得分高（开头匹配 > 末尾匹配）
 *   - 单词边界命中再加分（`n` 出现在「_」/「.」/「-」后立刻得分 boost）
 *   - 完全包含子串 → 等同 fuzzy 得分 +50（避免「完全匹配反而排后」的反直觉）
 *
 * 返回 0 表示不匹配（filter 直接丢弃）。
 *
 * 约定：query 必须是小写。FileList 在 input handler 处统一做了 lowercase，
 * 这里不再重复 —— N 个文件就少 N 次 String#toLowerCase 调用。
 *
 * @param {string} name - 文件名（含扩展名）
 * @param {string} lowerQuery - 已 lowercase 的搜索词
 * @returns {number} 匹配分数；0 = 不匹配
 */
function fuzzyScore(name, lowerQuery) {
  if (!lowerQuery) return 1; // 空 query = 不过滤
  const n = name.toLowerCase();

  // 子串包含 → 直接高分（fuzzy 子序列可能反而排后面）
  let idx = n.indexOf(lowerQuery);
  if (idx >= 0) {
    // 靠前 + 单词边界 + 命中整词 → 更高分
    let bonus = 0;
    if (idx === 0) bonus += 30;
    else if (idx > 0 && /[_\-.\s]/.test(n[idx - 1])) bonus += 20;
    return 100 + bonus - idx;
  }

  // 子序列匹配（fuzzy）
  let qi = 0;
  let score = 0;
  let lastMatchIdx = -1;
  for (let ni = 0; ni < n.length && qi < lowerQuery.length; ni++) {
    if (n[ni] === lowerQuery[qi]) {
      // 相邻匹配加分（连续命中），否则只加基础分
      if (lastMatchIdx === ni - 1) score += 8;
      else score += 5;
      // 单词边界 bonus
      if (ni === 0 || /[_\-.\s]/.test(n[ni - 1])) score += 4;
      // 位置越靠前 bonus 越多
      score += Math.max(0, 10 - Math.floor(ni / 3));
      lastMatchIdx = ni;
      qi++;
    }
  }
  if (qi < lowerQuery.length) return 0; // 没匹配完所有字符
  return score;
}

// 合法 sortMode 白名单 —— setSort 与构造器都走它，避免漏判 / 拼写错误导致静默
// 退回到 'name'。新排序模式只在 SETTINGS_UI_OPTIONS.fileListSort 与本常量同时更新。
const SORT_MODES = new Set(['name', 'name-desc', 'mtime-desc', 'mtime-asc']);
function normalizeSortMode(mode) {
  return SORT_MODES.has(mode) ? mode : 'name';
}

// audit fix (R7a P1-15)：windowed 虚拟滚动常量。
//   - FILE_ITEM_HEIGHT 必须与 .file-item 的 height CSS 同步（src/styles/05-sidebar.css）
//     改一边忘了另一边会出"位置算出来但渲染时错位"。
//   - OVERSCAN 是「视口外多渲几个」的缓冲，跨边界滚动时不出现短暂空白。
//     5 个 = 250px 缓冲，肉眼看不出延迟。
//   - SENTINEL_CLASS 是撑出滚动条高度的占位 <li>，不渲染内容、aria-hidden。
const FILE_ITEM_HEIGHT = 50;
const FILE_ITEM_OVERSCAN = 5;
const SENTINEL_CLASS = 'file-list-sentinel';
const WINDOWED_CLASS = 'is-windowed';

/**
 * 文件列表组件
 */
export class FileList {
  /**
   * @param {object} options
   * @param {HTMLUListElement} options.element - <ul> 容器
   * @param {HTMLInputElement} options.searchInput - 搜索输入框
   * @param {(file: {path:string,name:string}) => void} options.onSelect - 点击文件回调
   * @param {string} [options.sortMode='name'] - 排序模式：'name' | 'name-desc' | 'mtime-desc' | 'mtime-asc'
   */
  constructor({ element, searchInput, onSelect, onContextMenu, onContextMenuEmpty, onDropIntoFolder, sortMode = 'name' }) {
    this.element = element;
    this.searchInput = searchInput;
    this.onSelect = onSelect;
    this.onContextMenu = onContextMenu;
    // 空白区域右键：没命中任何 file-item 时回调（弹「粘贴到当前目录」菜单）。
    this.onContextMenuEmpty = typeof onContextMenuEmpty === 'function' ? onContextMenuEmpty : null;
    // 拖拽到文件夹：把条目拖到 folder 项上时回调（move；按住 Ctrl/Cmd 时 copy）。
    this.onDropIntoFolder = typeof onDropIntoFolder === 'function' ? onDropIntoFolder : null;
    // 当前正在拖拽的源条目（dragstart 写入、dragend 清空）。
    // dataTransfer 在 dragover 阶段读不到自定义数据，所以源靠这里保存。
    this._dragEntry = null;
    this.files = [];
    this.filteredFiles = [];
    this.activePath = null;
    this.searchTerm = '';
    this.sortMode = normalizeSortMode(sortMode);
    /** path → file，供事件委托时反查（避免每个 <li> 挂一个闭包） */
    this._byPath = new Map();
    // audit fix (R7a P1-15)：windowed 虚拟滚动状态。
    //   - _sentinel：撑出滚动条高度的占位 <li>
    //   - _pool：复用的 <li> 池，scroll 时只 flush textContent + classList
    //   - _windowed：当前是否在 windowed 模式（决定 render 走哪条路径）
    //   - _scrollFrame：rAF token，scroll 事件节流
    this._sentinel = null;
    this._pool = [];
    this._windowed = false;
    this._scrollFrame = null;

    // 统一 lifecycle：dispose() 一次性 unbind 所有 listener。
    createDisposable(this);

    // 事件委托：整个列表只挂一对 click / keydown 监听。
    // 原来是每次 render 给每个 <li> 各挂两个闭包 —— 列表一重建就要重新分配 2N 个函数，
    // 搜索时每敲一个字符都重建一次。委托后 render 只管建 DOM。
    if (element) {
      element.addEventListener('click', (e) => {
        const file = this._fileFromEvent(e);
        if (file && this.onSelect) this.onSelect(file);
      }, { signal: this.signal });

      // 键盘激活与导航：Enter/Space 等价于点击；↑/↓/Home/End 走 moveActive
      // （moveActive 只挪高亮，不会打开文件 —— 打开动作由 Enter/Space 触发，
      //   走 _fileFromEvent(e) 从当前 focus 所在 LI 反查文件）。
      element.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') {
          e.preventDefault(); this.moveActive(1); return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault(); this.moveActive(-1); return;
        }
        if (e.key === 'Home') {
          e.preventDefault(); this.moveActive('first'); return;
        }
        if (e.key === 'End') {
          e.preventDefault(); this.moveActive('last'); return;
        }
        if (e.key === 'Enter' || e.key === ' ') {
          const file = this._fileFromEvent(e);
          if (!file) return;
          e.preventDefault();
          if (this.onSelect) this.onSelect(file);
        }
      }, { signal: this.signal });

      // 右键菜单：命中 file-item 弹条目菜单；空白区域弹「粘贴到当前目录」。
      element.addEventListener('contextmenu', (e) => {
        const file = this._fileFromEvent(e);
        if (file && this.onContextMenu) {
          e.preventDefault();
          this.onContextMenu(file, e.clientX, e.clientY);
          return;
        }
        // 没命中条目（列表空白 / 滚动条留白）→ 给调用方弹粘贴菜单
        if (this.onContextMenuEmpty) {
          e.preventDefault();
          this.onContextMenuEmpty(e.clientX, e.clientY);
        }
      }, { signal: this.signal });

      // 拖拽：把文件 / 文件夹拖到其他条目。
      // 仅 folder 条目是合法投放目标；dragstart 记录源条目，dragover/drop 用事件
      // 委托反查目标 folder。move = 普通拖拽，copy = 按住 Ctrl/Cmd 拖拽。
      // 用 createDisposable 的 signal 统一解绑（dispose 时自动移除）。
      element.addEventListener('dragstart', (e) => {
        const li = e.target.closest && e.target.closest('.file-item');
        if (!li) return;
        const entry = this._byPath.get(li.dataset.path);
        if (!entry) return;
        this._dragEntry = entry;
        try {
          e.dataTransfer.setData('text/plain', entry.path);
          e.dataTransfer.setData('application/x-notes-path',
            JSON.stringify({ path: entry.path, entryType: entry.entryType, name: entry.name }));
        } catch { /* 某些浏览器 setData 受限，但 drag 仍可继续 */ }
        e.dataTransfer.effectAllowed = (e.ctrlKey || e.metaKey) ? 'copy' : 'move';
        li.classList.add('is-dragging');
      }, { signal: this.signal });

      element.addEventListener('dragover', (e) => {
        if (!this._dragEntry) return;
        const li = e.target.closest && e.target.closest('.file-item');
        this._clearDropTargets();
        if (!li) { this._setDropEffect(e, 'none'); return; }
        const target = this._byPath.get(li.dataset.path);
        if (!target || target.entryType !== 'folder' || this._isInvalidDropTarget(this._dragEntry, target)) {
          this._setDropEffect(e, 'none');
          return;
        }
        e.preventDefault(); // 允许 drop 的必要前提
        this._setDropEffect(e, (e.ctrlKey || e.metaKey) ? 'copy' : 'move');
        li.classList.add('is-drop-target');
      }, { signal: this.signal });

      // 真正离开列表（relatedTarget 跑到列表外）才清高亮；子项之间移动会冒泡
      // dragleave，但 relatedTarget 仍在列表内，不误清。
      element.addEventListener('dragleave', (e) => {
        if (e.relatedTarget && element.contains(e.relatedTarget)) return;
        this._clearDropTargets();
      }, { signal: this.signal });

      element.addEventListener('drop', (e) => {
        if (!this._dragEntry) return;
        const li = e.target.closest && e.target.closest('.file-item');
        this._clearDropTargets();
        if (!li) return;
        const target = this._byPath.get(li.dataset.path);
        if (!target || target.entryType !== 'folder' || this._isInvalidDropTarget(this._dragEntry, target)) return;
        e.preventDefault();
        const copy = !!(e.ctrlKey || e.metaKey);
        const dragged = this._dragEntry;
        if (this.onDropIntoFolder) this.onDropIntoFolder(dragged, target, { copy });
      }, { signal: this.signal });

      element.addEventListener('dragend', () => {
        this._clearDropTargets();
        if (this._dragEntry && this.element) {
          const dragLi = Array.from(this.element.children).find(
            (li) => li.dataset && li.dataset.path === this._dragEntry.path,
          );
          if (dragLi) dragLi.classList.remove('is-dragging');
        }
        this._dragEntry = null;
      }, { signal: this.signal });

      // audit fix (R7a P1-15)：windowed 模式 scroll 监听。
      // passive: true 不阻塞滚动主线程；rAF 节流（_scheduleWindowedRender）保证
      // 一帧最多一次 render，避免快速滚动时每个 scroll 事件都触发全池子 update。
      element.addEventListener('scroll', () => this._scheduleWindowedRender(), {
        signal: this.signal,
        passive: true,
      });
      // dispose 时把挂起的 rAF 清掉，否则它会在组件已销毁后
      // 触发 _renderWindowed 访问已被释放的 this.filteredFiles。
      this.addAbort(() => {
        if (this._scrollFrame) {
          cancelAnimationFrame(this._scrollFrame);
          this._scrollFrame = null;
        }
      });
    }

    if (searchInput) {
      // 100ms trailing debounce —— 文件多时（1000+）每按一键全量重算 + 重渲染
      // 是 O(N) 的工作，连续输入会卡；debounce 让连续打字期间 CPU 闲下来。
      // { signal: this.signal } 走 AbortController 路径，dispose 时自动解绑。
      let searchTimer = null;
      const flushSearch = () => {
        searchTimer = null;
        this.searchTerm = searchInput.value.trim().toLowerCase();
        this.applyFilter();
        this.render();
      };
      // dispose 时把挂起的 debounce 定时器清掉 —— 否则它会在组件已销毁后
      // 触发 flushSearch，访问已被释放的 this.searchTerm / applyFilter / render。
      // 见 createDisposable.addAbort 的「abort 时一次性执行清理」语义。
      this.addAbort(() => {
        if (searchTimer) {
          clearTimeout(searchTimer);
          searchTimer = null;
        }
      });
      searchInput.addEventListener('input', () => {
        if (searchTimer) clearTimeout(searchTimer);
        searchTimer = setTimeout(flushSearch, 100);
      }, { signal: this.signal });
      // 失焦时立即落盘当前值，不等 debounce —— 用户离开搜索框后还看到旧结果会困惑
      searchInput.addEventListener('blur', () => {
        if (searchTimer) {
          clearTimeout(searchTimer);
          searchTimer = null;
          flushSearch();
        }
      }, { signal: this.signal });
    }
  }

  /**
   * 从委托事件里反查对应的 file 对象。
   * @param {Event} e
   * @returns {object|null}
   */
  _fileFromEvent(e) {
    const li = e.target.closest && e.target.closest('.file-item');
    if (!li || !this.element.contains(li)) return null;
    return this._byPath.get(li.dataset.path) || null;
  }

  /**
   * 清空所有 .is-drop-target 高亮（drop 目标指示）。
   */
  _clearDropTargets() {
    if (!this.element) return;
    for (const li of this.element.children) {
      if (li.classList && li.classList.contains('is-drop-target')) {
        li.classList.remove('is-drop-target');
      }
    }
  }

  /**
   * 安全设置 dataTransfer.dropEffect（部分浏览器 dataTransfer 受限时静默失败）。
   * @param {DragEvent} e
   * @param {'move'|'copy'|'none'} effect
   */
  _setDropEffect(e, effect) {
    try { e.dataTransfer.dropEffect = effect; } catch { /* ignore */ }
  }

  /**
   * 判断 src 能否投放到 target（target 必须是 folder）。
   * 非法情形：
   *   - 拖到自己（src.path === target.path）
   *   - 文件夹拖入自身或其子孙（循环 / 路径穿越）
   *   - 源已在 target 内部（同目录拖入 = 无意义的 name (2) 重名）
   * @param {{path:string,entryType:string}} src
   * @param {{path:string,entryType:string}} target
   * @returns {boolean}
   */
  _isInvalidDropTarget(src, target) {
    if (!src || !target) return true;
    if (src.path === target.path) return true;
    // 跨平台分隔符（Windows \ 与 POSIX /）都覆盖
    const selfDesc = src.entryType === 'folder'
      && (target.path === src.path + '/' || target.path === src.path + '\\'
        || target.path.startsWith(src.path + '/') || target.path.startsWith(src.path + '\\'));
    const alreadyInside = target.path === src.path
      || target.path.startsWith(src.path + '/') || target.path.startsWith(src.path + '\\');
    return !!(selfDesc || alreadyInside);
  }

  /**
   * 设置排序模式（供设置对话框等调用方热切换）
   * @param {'name' | 'name-desc' | 'mtime-desc' | 'mtime-asc'} mode
   */
  setSort(mode) {
    const next = normalizeSortMode(mode);
    if (next === this.sortMode) return;
    this.sortMode = next;
    this.applyFilter();
    this.render();
  }

  /**
   * 用新的条目列表替换当前列表
   *
   * Stage 8：接受混合条目（文件夹 + editable + binary）。每条至少含
   *   { name, path, entryType: 'folder'|'editable'|'binary', isFolder?: boolean, size?, mtimeMs? }
   * 向后兼容：旧调用传 { name, path, size, mtimeMs }（无 entryType）→ 视为 'editable'。
   *
   * @param {Array<object>} entries
   */
  setFiles(entries) {
    const previousActive = this.activePath;
    this.files = Array.isArray(entries)
      ? entries.map((e) => ({
          ...e,
          entryType: e.entryType || (e.isFolder ? 'folder' : 'editable'),
        }))
      : [];

    // M-series fix (audit Phase M-H2)：移除 setFiles 内的 onFileRemoved 触发。
    // 旧实现仅凭「previousActive 不在新 entries 里」就通知上层清空编辑器——
    // 这把「用户导航到子目录」（Folder Browser 语义：浏览期间不自动关文件）
    // 与「文件被外部删除」混淆为同一信号，导致切子目录时编辑器被错误清空。
    //
    // 改成 setFiles 只负责渲染，外部清理判定上移到 app.js#applyEntries：
    // 用「文件目录 === 当前浏览目录」区分「文件被删」与「导航到别处」。
    // signature：`activePath` 与新 entries 不再自动清零 —— 由调用方决定要不要
    // 通过 setActive(null) 主动清，否则高亮会跨目录污染。
    // fix(audit 2026-08)：Windows 路径大小写不敏感，=== 会让外部重命名（小
    // 小写差异）后侧栏失去高亮。统一走 pathsEqual。
    //
    // 审计修复 (Round 11 P1-1)：用 fs 返回的真实 case 覆盖 previousActive。
    // 旧逻辑保留 previousActive（用户输入时的大小写），state.currentFile.path
    // 与侧栏 data-path 出现大小写漂移，IPC / 日志 / 错误消息里看着像两个文件。
    // 现在回迁时优先取 this.files 里的真值（fs 返回的磁盘 case），IPC 跨进程
    // 看到的路径字符串统一。
    const canonicalForActive = (active) => {
      if (!active) return active;
      const hit = this.files.find((f) => pathsEqual(f.path, active) && f.entryType !== 'folder');
      return hit ? hit.path : active;
    };
    if (previousActive
        && !this.files.some(f => pathsEqual(f.path, previousActive) && f.entryType !== 'folder')) {
      // audit fix (Round 9)：保留「activePath 跨目录导航」回迁语义。
      // 之前这里直接 activePath=null，用户切走再切回原目录时 entries 又含
      // previousActive，但 activePath 已被清，侧栏不自动恢复高亮。
      // 改成：当前目录不含 previousActive 时不主动清，存到 lastSeenActivePath
      // 等下次 setFiles 时回迁；如果上层调 setActive(null) 显式清则一切如旧。
      this.lastSeenActivePath = previousActive;
      this.activePath = null;
    } else if (previousActive
        && this.files.some(f => pathsEqual(f.path, previousActive) && f.entryType !== 'folder')) {
      // 回迁到原目录（entries 又含 previousActive）→ 恢复 activePath，
      // 同时把大小写统一到 fs 真实 case（见上 canonicalForActive 注释）。
      this.activePath = canonicalForActive(previousActive);
      this.lastSeenActivePath = null;
    } else if (this.activePath) {
      // 兜底：当前 activePath 还在 setFiles 命中的新 entries 里时，统一一次大小写。
      // 例如外部 openFile 后接着 setFiles 没经过回迁分支，activePath 仍可能是旧 case。
      this.activePath = canonicalForActive(this.activePath);
    }

    this.applyFilter();
    this.render();
  }

  /**
   * 设置当前激活的文件（侧边栏高亮 + 调用方同步状态栏）
   *
   * 只挪 is-active 类，不重建列表 —— 这是最高频的渲染触发点（每次打开文件都走），
   * 而列表内容并没有变化，重建一遍纯属浪费。
   * @param {string|null} filePath
   */
  setActive(filePath) {
    const next = filePath || null;
    // audit fix (Case-M1)：上一版用 === —— Windows / macOS 路径大小写不敏感，
    // `next`（IPC 回来的 canonical case）与 `this.activePath`（先前设置的 case）
    // 不一致时早返回生效，per-li classList 更新被跳过，旧激活项残留 .is-active。
    // 改走 pathsEqual：与下面 per-li 匹配用同一份 case-fold 实现，
    // 「早返回条件」与「实际高亮条件」天然对齐，不会再出现「activePath 已换、
    // DOM 高亮还停在上一项」的撕裂状态。
    if (pathsEqual(next, this.activePath)) return;
    this.activePath = next;
    if (!this.element) return;
    // audit fix：Windows 路径大小写不敏感；state.currentFile.path 可能是用户输入
    // 的 case，fs 返回的是磁盘真实 case。直接 === 比对会让侧栏永远找不到 active
    // 条目、不显示高亮。统一走 pathsEqual（含 Windows case-fold）。
    // audit fix (R7a P1-15)：windowed 模式下 _sentinel 也是 element.children，
    // 它的 dataset.path 是空字符串，与 activePath 永远不等，无副作用（不会变
    // is-active），但白跑一遍 pathsEqual 不必要。显式 skip 节省一点点。
    for (const li of this.element.children) {
      if (li.classList.contains(SENTINEL_CLASS)) continue;
      const active = pathsEqual(li.dataset.path, this.activePath);
      li.classList.toggle('is-active', active);
      li.setAttribute('aria-selected', active ? 'true' : 'false');
    }
  }

  /**
   * 返回当前高亮条目对应的 entry 对象（供键盘剪切 / 复制 / 粘贴定位源条目）。
   * 没有高亮时返回 null。windowed 模式下 _byPath 仍含全部条目，查找不受影响。
   * @returns {object|null}
   */
  getActiveEntry() {
    if (!this.activePath) return null;
    return this._byPath.get(this.activePath) || null;
  }

  /**
   * 列表获焦时由键盘导航调用：移动激活态到相邻项。只挪高亮 + 焦点，
   * 不触发 onSelect —— 打开文件由 Enter / Space 键负责（走 _fileFromEvent）。
   * 旧版本在这里直接 onSelect，导致每按一次方向键就打开一个文件。
   * @param {number} delta  -1 上一项 / +1 下一项 / 'first' / 'last'
   */
  moveActive(delta) {
    const total = this.filteredFiles.length;
    if (total === 0) return;
    // audit fix (R7a P1-15)：windowed 模式下 DOM 里的 .file-item 只是当前
    // 可见的窗口，activePath 对应的项可能不在 DOM 里。用 filteredFiles
    // 反查 idx 而不是 querySelectorAll('.file-item')。
    // audit fix：Windows 大小写不敏感走 pathsEqual。
    let idx = this.activePath
      ? this.filteredFiles.findIndex(f => pathsEqual(f.path, this.activePath))
      : -1;
    if (idx < 0) idx = 0;
    if (delta === 'first') idx = 0;
    else if (delta === 'last') idx = total - 1;
    else idx = Math.max(0, Math.min(total - 1, idx + delta));
    const target = this.filteredFiles[idx];
    this.activePath = target.path;
    // 给当前 DOM 里的 .file-item（窗口化的池子）打高亮；sentinel 跳过。
    // 旧的 forEach(items) 写法在 windowed 下不可靠 —— target 可能不在池里。
    for (const li of this.element.children) {
      if (li.classList.contains(SENTINEL_CLASS)) continue;
      const active = pathsEqual(li.dataset.path, this.activePath);
      li.classList.toggle('is-active', active);
      li.setAttribute('aria-selected', active ? 'true' : 'false');
    }
    // windowed 模式：把 target 滚到可视区（仅当 activePath 真正变化时调 scroll）
    this._scrollIndexIntoView(idx);
    // focus 当前 activePath 对应的 <li>（可能在池里、可能不在）；
    // 不在时 focus 落到 ul 容器上，键盘导航下次按键仍能 continue。
    const targetLi = Array.from(this.element.children).find(li =>
      !li.classList.contains(SENTINEL_CLASS) && pathsEqual(li.dataset.path, this.activePath));
    if (targetLi) {
      // audit fix (2.4)：focus 默认会触发 scrollIntoView → 侧栏布局可能跳动。
      // 改用 preventScroll，再用 _scrollIndexIntoView 把项拉到可视区但不强制居中。
      try { targetLi.focus({ preventScroll: true }); } catch { /* ignore */ }
    }
  }

  /**
   * 应用搜索过滤 + 排序
   *
   * 搜索：先按 fuzzy 评分过滤 + 排序（高分在前），
   *       再按 sortMode 排序（name 或 mtime） —— 排序优先级：
   *         1) searchTerm 存在 → fuzzy 排序覆盖 sortMode（用户明确在搜）
   *         2) searchTerm 为空 → 走 sortMode
   *
   * 这样 "readme" 仍能在 mtime-desc 模式下把 README.md 排前，而不是按修改时间硬排。
   */
  applyFilter() {
    const term = this.searchTerm;
    let list;
    if (!term) {
      list = this.files.slice();
    } else {
      // fuzzy：打分并过滤
      const scored = [];
      for (const f of this.files) {
        const score = fuzzyScore(f.name, term);
        if (score > 0) scored.push({ file: f, score });
      }
      scored.sort((a, b) => b.score - a.score);
      list = scored.map(s => s.file);
    }
    // 有搜索时 fuzzy 排序已覆盖 sortMode，无需再切（避免重复扫描 + 误判）
    if (term) {
      this.filteredFiles = list;
      return;
    }
    switch (this.sortMode) {
      case 'mtime-desc':
        list.sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0));
        break;
      case 'mtime-asc':
        list.sort((a, b) => (a.mtimeMs || 0) - (b.mtimeMs || 0));
        break;
      case 'name-desc':
        // localeCompare(zh-CN) 反向：b 在前，a 在后
        list.sort((a, b) => b.name.localeCompare(a.name, 'zh-CN'));
        break;
      case 'name':
      default:
        list.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
        break;
    }
    this.filteredFiles = list;
  }

  /**
   * 渲染 DOM
   *
   * audit fix (R7a P1-15)：windowed 虚拟滚动分发。
   * 10000 文件全量重建 ~200ms+ → 走 windowed 只渲 visibleCount+overscan 个，
   * scroll 时复用 _pool 的 <li>，只 flush textContent + classList。
   *
   * 模式选择：
   *   - clientHeight === 0（jsdom 测试 / 隐藏的侧栏 / 测布局前）
   *   - 或 total ≤ visibleCount + 2*overscan（小列表）
   * → 走 _renderFull，全量重建（保持 jsdom 既有 34 个测试直接通过）
   *   其他情况 → 走 _renderWindowed，sentinel + pool + absolute 定位
   */
  render() {
    if (!this.element) return;
    // 重建 path → file 索引，供委托的 click / keydown 反查
    this._byPath.clear();
    for (const file of this.filteredFiles) {
      this._byPath.set(file.path, file);
    }

    if (this.filteredFiles.length === 0) {
      // 空状态分两种：搜索无结果 vs 目录真为空。
      // - 搜索有词 → "没找到匹配项"（让用户清空搜索或换关键词）
      // - 搜索为空 → "此文件夹为空"（index.html 的 data-empty 默认值；
      //   setFiles 调用时 element 还没渲染数据时 element.dataset.empty 还是这个）
      // 这样 UI 不会把"搜不到"误读成"目录空"，也避免反过来。
      const emptyMsg = this.searchTerm
        ? `没有匹配 “${this.searchTerm}” 的文件`
        : '此文件夹为空';
      this._teardownWindowed();
      this.element.replaceChildren();
      this.element.dataset.empty = emptyMsg;
      return;
    }

    // 有内容时清掉 data-empty，避免渲染期间被 :empty::after 短暂闪一下
    this.element.removeAttribute('data-empty');

    const total = this.filteredFiles.length;
    const viewportH = this.element.clientHeight;
    const visibleCount = viewportH > 0 ? Math.ceil(viewportH / FILE_ITEM_HEIGHT) : 0;

    // 走 full 模式的两个条件（满足任一即 full）：
    //   1) clientHeight 0 → 没法算窗口，先 full 渲（jsdom / 隐藏侧栏）
    //   2) 总数 ≤ 可见 + 2*overscan → 虚拟化没收益还多 sentinel 开销
    if (viewportH === 0 || total <= visibleCount + FILE_ITEM_OVERSCAN * 2) {
      if (this._windowed) this._teardownWindowed();
      this._renderFull();
    } else {
      this._renderWindowed();
    }
  }

  /**
   * 全量渲染（兼容 jsdom / 小列表）
   * 行为与 audit R7a P1-15 之前一致：replaceChildren + createElement + appendChild
   */
  _renderFull() {
    this.element.replaceChildren();
    this._windowed = false;
    const term = this.searchTerm;
    const frag = document.createDocumentFragment();
    for (const file of this.filteredFiles) {
      const li = document.createElement('li');
      this._fillItem(li, file, term, false, 0);
      frag.appendChild(li);
    }
    this.element.appendChild(frag);
  }

  /**
   * windowed 虚拟滚动渲染。
   *   - 用 _sentinel 撑出 total * FILE_ITEM_HEIGHT 的滚动高度
   *   - 用 _pool 维护 visibleCount + 2*overscan 个复用的 <li>
   *   - 每个 <li> position:absolute + top:N*50 钉在指定行
   *   - 滚动时只 flush textContent + classList，不重新创建 DOM
   */
  _renderWindowed() {
    if (!this._windowed) {
      // 首次进入 windowed：清掉 full 模式的旧 <li>，建 sentinel
      this.element.replaceChildren();
      this._sentinel = document.createElement('li');
      this._sentinel.className = SENTINEL_CLASS;
      this._sentinel.setAttribute('aria-hidden', 'true');
      this.element.appendChild(this._sentinel);
      this._pool = [];
      this._windowed = true;
    }

    const total = this.filteredFiles.length;
    const viewportH = this.element.clientHeight;
    const visibleCount = Math.ceil(viewportH / FILE_ITEM_HEIGHT);
    const scrollTop = this.element.scrollTop;
    // startIndex：scrollTop 落在哪一行。减 overscan 让上方提前几行开始出现，
    // 跨边界滚动时不出现"滚到了但还有几行空白"的延迟感。
    let startIndex = Math.floor(scrollTop / FILE_ITEM_HEIGHT) - FILE_ITEM_OVERSCAN;
    if (startIndex < 0) startIndex = 0;
    // endIndex：start + 可见 + 下方 overscan。封顶 total。
    const endIndex = Math.min(total, startIndex + visibleCount + FILE_ITEM_OVERSCAN * 2);
    const needed = endIndex - startIndex;

    // sentinel 高度 = total * itemHeight，给滚动条撑出总高
    this._sentinel.style.height = `${total * FILE_ITEM_HEIGHT}px`;

    // 缩放 pool 到 needed：池子小了 append 新 li，池子大了 remove 末尾的
    while (this._pool.length < needed) {
      const li = document.createElement('li');
      // 第一次建出来的 li 就要带 WINDOWED_CLASS（绝对定位），否则
      // append 后到 _fillItem 设置 position 之间会先以 flex item 出现再跳位。
      li.classList.add(WINDOWED_CLASS);
      this.element.appendChild(li);
      this._pool.push(li);
    }
    while (this._pool.length > needed) {
      const li = this._pool.pop();
      li.remove();
    }

    // 把数据填进 pool 的每个 li（复用：已有 li 只 flush textContent / classList）
    const term = this.searchTerm;
    for (let i = 0; i < needed; i++) {
      const dataIndex = startIndex + i;
      const file = this.filteredFiles[dataIndex];
      const li = this._pool[i];
      this._fillItem(li, file, term, true, dataIndex);
    }
  }

  /**
   * 把一个 file 对象的数据填进已有的 <li>。full 模式与 windowed 模式共用。
   * 复用关键：只在数据真变化时写 DOM（classList / textContent / dataset）。
   * @param {HTMLLIElement} li
   * @param {object} file
   * @param {string} term - 已 lowercase 的搜索词；空串 = 无搜索
   * @param {boolean} isWindowed - 是否 windowed 模式（决定是否设 WINDOWED_CLASS + style.top）
   * @param {number} dataIndex - 当前项在 filteredFiles 里的下标（windowed 用）
   */
  _fillItem(li, file, term, isWindowed, dataIndex) {
    // 基础属性：path / entryType / class（用 contains 避免重复 add）
    if (li.dataset.path !== file.path) li.dataset.path = file.path;
    if (li.dataset.entryType !== file.entryType) li.dataset.entryType = file.entryType;
    // 所有条目可拖拽（文件 / 文件夹 / 二进制都可选中拖到其它文件夹）
    if (li.draggable !== true) li.draggable = true;
    const wantClass = `file-item is-${file.entryType}${isWindowed ? ` ${WINDOWED_CLASS}` : ''}`;
    if (li.className !== wantClass) li.className = wantClass;
    if (li.getAttribute('role') !== 'option') li.setAttribute('role', 'option');
    if (!li.hasAttribute('tabindex')) li.tabIndex = 0;

    // 激活态（Windows 大小写不敏感走 pathsEqual）
    const isActive = pathsEqual(file.path, this.activePath);
    li.classList.toggle('is-active', isActive);
    li.setAttribute('aria-selected', isActive ? 'true' : 'false');

    // 子节点：icon / name / meta。首次建后保留引用，scroll 时只改 textContent。
    let name = li._cachedName;
    let meta = li._cachedMeta;
    let icon = li._cachedIcon;
    if (!name) {
      // 首次：建好结构并存到 ._cachedXxx。name/meta 是直接子 div，icon 是 svg
      icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      icon.setAttribute('class', 'file-icon');
      icon.setAttribute('viewBox', '0 0 24 24');
      icon.setAttribute('width', '14');
      icon.setAttribute('height', '14');
      icon.setAttribute('fill', 'none');
      icon.setAttribute('stroke', 'currentColor');
      icon.setAttribute('stroke-width', '1.8');
      icon.setAttribute('stroke-linecap', 'round');
      icon.setAttribute('stroke-linejoin', 'round');
      icon.setAttribute('aria-hidden', 'true');
      const text = document.createElement('div');
      text.className = 'file-text';
      name = document.createElement('div');
      name.className = 'file-name';
      meta = document.createElement('div');
      meta.className = 'file-meta';
      text.appendChild(name);
      text.appendChild(meta);
      li.appendChild(icon);
      li.appendChild(text);
      li._cachedName = name;
      li._cachedMeta = meta;
      li._cachedIcon = icon;
    }

    // 名称：搜索高亮（纯 textContent + <mark>，避免 innerHTML XSS）
    if (term) {
      const lowerName = file.name.toLowerCase();
      const idx = lowerName.indexOf(term);
      // 重渲时如果高亮结构变了（之前无 <mark> 现在有 / 反之），直接 replaceChildren
      const existingMark = name.querySelector('mark');
      if (idx >= 0) {
        const before = file.name.slice(0, idx);
        const hit = file.name.slice(idx, idx + term.length);
        const after = file.name.slice(idx + term.length);
        if (existingMark) {
          // 复用：把结构稳定归一为 [beforeText, mark, afterText]，否则搜索词在
          // 开头/结尾时 childNodes 数量会变化，走 appendChild 会把旧名字的尾巴拼到新名字后
          // （如 abc.md → 复用给 abc.txt 显示成 abc.md.txt）。before/after 文本节点可能为空。
          let beforeNode = existingMark.previousSibling;
          if (!beforeNode || beforeNode.nodeType !== Node.TEXT_NODE) {
            beforeNode = document.createTextNode('');
            name.insertBefore(beforeNode, existingMark);
          }
          let afterNode = existingMark.nextSibling;
          if (!afterNode || afterNode.nodeType !== Node.TEXT_NODE) {
            afterNode = document.createTextNode('');
            name.appendChild(afterNode);
          }
          beforeNode.nodeValue = before;
          existingMark.textContent = hit;
          afterNode.nodeValue = after;
        } else {
          // 重建（之前无 mark）
          name.replaceChildren();
          if (before) name.appendChild(document.createTextNode(before));
          const m = document.createElement('mark');
          m.textContent = hit;
          name.appendChild(m);
          if (after) name.appendChild(document.createTextNode(after));
        }
      } else {
        // 没命中 → 整个 name 设 textContent（无 mark）
        if (existingMark) {
          name.textContent = file.name;
        } else if (name.textContent !== file.name) {
          name.textContent = file.name;
        }
      }
    } else {
      // 无搜索：name 只在变化时写
      if (name.textContent !== file.name) name.textContent = file.name;
    }

    // meta：folder/binary/editable 三种文案
    let metaText;
    if (file.entryType === 'folder') {
      metaText = '文件夹';
    } else if (file.entryType === 'binary') {
      metaText = `${formatSize(file.size)} · 不可编辑`;
    } else {
      metaText = `${formatSize(file.size)} · ${formatRelativeTime(file.mtimeMs)}`;
    }
    if (meta.textContent !== metaText) meta.textContent = metaText;

    // icon：entryType 不同用不同 SVG path。innerHTML 路径已硬编码且非用户输入，
    // 这里继续走 innerHTML 比 createElement('path') + setAttribute 快 3-5x，
    // windowed scroll 触发的 update 路径上值得这点性能。
    let iconHtml;
    if (file.entryType === 'folder') {
      iconHtml = '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>';
    } else if (file.entryType === 'binary') {
      iconHtml = '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="5" y1="5" x2="19" y2="19"/>';
    } else {
      iconHtml = '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>';
    }
    if (icon.innerHTML !== iconHtml) icon.innerHTML = iconHtml;

    // windowed 专属：position:absolute + top:N*50（left/right 在 CSS 的 .is-windowed）
    if (isWindowed) {
      const top = dataIndex * FILE_ITEM_HEIGHT;
      if (li.style.top !== `${top}px`) li.style.top = `${top}px`;
    }
  }

  /**
   * 退出 windowed 模式：清掉 sentinel + pool，DOM 回到「无项目」状态
   * （render 的 full 分支会自己 replaceChildren + append 新 li）
   */
  _teardownWindowed() {
    if (this._sentinel) {
      this._sentinel.remove();
      this._sentinel = null;
    }
    for (const li of this._pool) {
      // 清掉 windowed 专属的 inline style，full 模式不需要 absolute 定位
      li.style.top = '';
      li.remove();
    }
    this._pool = [];
    this._windowed = false;
  }

  /**
   * scroll 事件 rAF 节流：一帧最多触发一次 _renderWindowed
   * 快速滚动 wheel 事件 60+ 次/秒，不节流会卡
   */
  _scheduleWindowedRender() {
    if (this._scrollFrame) return;
    if (!this._windowed) return; // full 模式不响应 scroll 事件
    this._scrollFrame = requestAnimationFrame(() => {
      this._scrollFrame = null;
      this._renderWindowed();
    });
  }

  /**
   * 把第 idx 项滚到可见区域（仅 windowed 模式有效，full 模式 noop）
   * moveActive 用：跨视口的键盘导航不依赖浏览器原生 focus
   */
  _scrollIndexIntoView(idx) {
    if (!this._windowed) return;
    const top = idx * FILE_ITEM_HEIGHT;
    const bottom = top + FILE_ITEM_HEIGHT;
    const scrollTop = this.element.scrollTop;
    const viewportH = this.element.clientHeight;
    if (top < scrollTop) {
      this.element.scrollTop = top;
    } else if (bottom > scrollTop + viewportH) {
      this.element.scrollTop = bottom - viewportH;
    }
  }

  /** test hook：当前是否在 windowed 模式（单测断言） */
  _test_isWindowed() { return this._windowed; }
  /** test hook：当前 pool 大小 */
  _test_poolSize() { return this._pool.length; }
  /** test hook：当前 sentinel 是否存在 */
  _test_hasSentinel() { return !!this._sentinel; }
}
