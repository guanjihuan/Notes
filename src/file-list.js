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

/**
 * 文件列表组件
 */
export class FileList {
  /**
   * @param {object} options
   * @param {HTMLUListElement} options.element - <ul> 容器
   * @param {HTMLInputElement} options.searchInput - 搜索输入框
   * @param {(file: {path:string,name:string}) => void} options.onSelect - 点击文件回调
   * @param {string} [options.sortMode='name'] - 排序模式：'name' | 'mtime-desc'
   */
  constructor({ element, searchInput, onSelect, onContextMenu, sortMode = 'name' }) {
    this.element = element;
    this.searchInput = searchInput;
    this.onSelect = onSelect;
    this.onContextMenu = onContextMenu;
    this.files = [];
    this.filteredFiles = [];
    this.activePath = null;
    this.searchTerm = '';
    this.sortMode = sortMode === 'mtime-desc' ? 'mtime-desc' : 'name';
    /** path → file，供事件委托时反查（避免每个 <li> 挂一个闭包） */
    this._byPath = new Map();

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

      // 右键菜单：弹给调用方处理（context-menu.js）
      element.addEventListener('contextmenu', (e) => {
        const file = this._fileFromEvent(e);
        if (!file || !this.onContextMenu) return;
        e.preventDefault();
        this.onContextMenu(file, e.clientX, e.clientY);
      }, { signal: this.signal });
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
   * 设置排序模式（供设置对话框等调用方热切换）
   * @param {'name' | 'mtime-desc'} mode
   */
  setSort(mode) {
    const next = mode === 'mtime-desc' ? 'mtime-desc' : 'name';
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
    if (next === this.activePath) return;
    this.activePath = next;
    if (!this.element) return;
    // audit fix：Windows 路径大小写不敏感；state.currentFile.path 可能是用户输入
    // 的 case，fs 返回的是磁盘真实 case。直接 === 比对会让侧栏永远找不到 active
    // 条目、不显示高亮。统一走 pathsEqual（含 Windows case-fold）。
    for (const li of this.element.children) {
      const active = pathsEqual(li.dataset.path, this.activePath);
      li.classList.toggle('is-active', active);
      li.setAttribute('aria-selected', active ? 'true' : 'false');
    }
  }

  /**
   * 列表获焦时由键盘导航调用：移动激活态到相邻项。只挪高亮 + 焦点，
   * 不触发 onSelect —— 打开文件由 Enter / Space 键负责（走 _fileFromEvent）。
   * 旧版本在这里直接 onSelect，导致每按一次方向键就打开一个文件。
   * @param {number} delta  -1 上一项 / +1 下一项 / 'first' / 'last'
   */
  moveActive(delta) {
    const items = Array.from(this.element.querySelectorAll('.file-item'));
    if (items.length === 0) return;
    // audit fix：与 setActive 保持一致 —— Windows 上 case-fold 比对。
    let idx = items.findIndex(li => pathsEqual(li.dataset.path, this.activePath));
    if (idx < 0) idx = 0;
    if (delta === 'first') idx = 0;
    else if (delta === 'last') idx = items.length - 1;
    else idx = Math.max(0, Math.min(items.length - 1, idx + delta));
    const target = items[idx];
    // 直接给目标项加高亮，避免 setActive→render 整树重画把焦点带走
    items.forEach(li => {
      const active = li === target;
      li.classList.toggle('is-active', active);
      li.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    this.activePath = target.dataset.path;
    // audit fix (2.4)：focus 默认会触发 scrollIntoView → 侧栏布局可能跳动。
    // 改用 preventScroll，再用 scrollIntoView('nearest') 把项拉到可视区但不强制居中。
    try { target.focus({ preventScroll: true }); } catch { /* ignore */ }
    try { target.scrollIntoView({ block: 'nearest' }); } catch { /* ignore */ }
  }

  /**
   * 应用搜索过滤 + 排序
   *
   * 搜索：先按 fuzzy 评分过滤 + 排序（高分在前），
   *       再按 sortMode 排序（name 或 mtime） —— 排序优先级：
   *         1) searchTerm 存在 → fuzzy 排序覆盖 sortMode（用户明确在搜）
   *         2) searchTerm 为空 → 走 sortMode
   *
   * 这样 "wel" 仍能在 mtime-desc 模式下把 welcome.md 排前，而不是按修改时间硬排。
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
    // 仅在无搜索时使用 sortMode；有搜索时 fuzzy 排序已覆盖
    if (!term) {
      if (this.sortMode === 'mtime-desc') {
        list.sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0));
      } else {
        list.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
      }
    }
    this.filteredFiles = list;
  }

  /**
   * 渲染 DOM
   */
  render() {
    if (!this.element) return;
    this.element.replaceChildren();

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
      this.element.dataset.empty = emptyMsg;
      return;
    }

    // 有内容时清掉 data-empty，避免渲染期间被 :empty::after 短暂闪一下
    this.element.removeAttribute('data-empty');

    const term = this.searchTerm;

    const frag = document.createDocumentFragment();
    for (const file of this.filteredFiles) {
      const li = document.createElement('li');
      li.className = 'file-item';
      li.dataset.path = file.path;
      // entryType / isFolder 是渲染端做图标 / 灰态分流的依据，
      // 也让右键菜单 / onSelect 分发有统一锚点。
      li.dataset.entryType = file.entryType;
      li.classList.add(`is-${file.entryType}`);
      // 列表项自身是按钮语义：通过 role/tabindex/aria-selected 把键盘可达性补齐
      // （容器 ul 已经声明 role="listbox"，单项用 role="option" 是规范对应）
      li.setAttribute('role', 'option');
      li.tabIndex = 0;
      // audit fix：Windows 路径大小写不敏感；fs 返回的真实 case 不一定等于
      // state.currentFile.path 上记录的 case，统一走 pathsEqual。
      const isActive = pathsEqual(file.path, this.activePath);
      if (isActive) {
        li.classList.add('is-active');
        li.setAttribute('aria-selected', 'true');
      } else {
        li.setAttribute('aria-selected', 'false');
      }

      const name = document.createElement('div');
      name.className = 'file-name';
      // 搜索高亮：纯 textContent + createElement('mark')，避免 innerHTML 引入 XSS
      if (term) {
        const lowerName = file.name.toLowerCase();
        const idx = lowerName.indexOf(term);
        if (idx >= 0) {
          const before = file.name.slice(0, idx);
          const hit = file.name.slice(idx, idx + term.length);
          const after = file.name.slice(idx + term.length);
          if (before) name.appendChild(document.createTextNode(before));
          const mark = document.createElement('mark');
          mark.textContent = hit;
          name.appendChild(mark);
          if (after) name.appendChild(document.createTextNode(after));
        } else {
          name.textContent = file.name;
        }
      } else {
        name.textContent = file.name;
      }

      const meta = document.createElement('div');
      meta.className = 'file-meta';
      // Stage 8：folder / binary 没有 size+mtime，只有 editable 显示完整 meta。
      // folder 显示「文件夹」；binary 显示大小 + 「不可编辑」提示。
      if (file.entryType === 'folder') {
        meta.textContent = '文件夹';
      } else if (file.entryType === 'binary') {
        meta.textContent = `${formatSize(file.size)} · 不可编辑`;
      } else {
        meta.textContent = `${formatSize(file.size)} · ${formatRelativeTime(file.mtimeMs)}`;
      }

      // 文件图标：左侧装饰，让 list 项视觉更有「文件感」。
      // aria-hidden，因为纯视觉；语义信息已经在 file-name 里。
      const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
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
      // 不同类型用不同 SVG path：folder / file / binary(带斜杠禁止感)
      if (file.entryType === 'folder') {
        icon.innerHTML = '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>';
      } else if (file.entryType === 'binary') {
        // 文件 + 斜杠：表达「不可编辑」
        icon.innerHTML = '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="5" y1="5" x2="19" y2="19"/>';
      } else {
        icon.innerHTML = '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>';
      }

      // 文本容器：把 name + meta 包成一列，让整体用 grid 布局对齐 icon。
      // 直接 append name/meta 到 li 会让它们和 icon 一起进入 grid 的同一列，
      // 排版混乱；所以包一层 .file-text。
      const text = document.createElement('div');
      text.className = 'file-text';
      text.appendChild(name);
      text.appendChild(meta);

      li.appendChild(icon);
      li.appendChild(text);
      // 点击 / 键盘由构造函数里的委托监听统一处理，这里不再逐项绑定
      frag.appendChild(li);
    }
    this.element.appendChild(frag);
  }
}
