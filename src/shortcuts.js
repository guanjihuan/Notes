// 全局快捷键
//
// 10 个常用快捷键（详见下文清单）：
//   - Ctrl/Cmd + F           聚焦文件搜索框（编辑器内让给 CM6 查找面板）
//   - Ctrl/Cmd + S           保存当前编辑的文件（脏状态时）
//   - Ctrl/Cmd + E           切换视图模式（preview → edit → split）
//   - Ctrl/Cmd + N           新建文件
//   - Ctrl/Cmd + ,           打开设置
//   - Ctrl/Cmd + R           重新加载界面（与主菜单 reload 等价）
//   - Ctrl/Cmd + Shift+T     切换主题
//   - Ctrl/Cmd + Shift+F     切换聚焦模式（隐藏工具栏/侧栏/状态栏）
//   - Ctrl/Cmd + Shift+A     切换 AI 修改面板（编辑器内让给 CM6）
//   - Esc（搜索框内）        清空搜索
//
// 注意：CM6 内部的 keymap 会优先拦截 Mod-s / Mod-f（在编辑器聚焦时），
// 但事件仍会继续冒泡到 document —— 所以这里必须主动避让，否则
// 在编辑器里按 Ctrl+F 会「同时」打开 CM 搜索面板并把焦点抢到侧栏搜索框。
//
// 模态对话框打开期间（#modal-root 有 overlay），Ctrl+, / Ctrl+F / Ctrl+Shift+T
// 应当静默不触发，否则会把焦点抢走、或者顶掉现有 dialog（详见 modal-stack.js）。
// 模态自己的 Esc → 关闭 在 dialog 内部已经独立处理。
// Ctrl+R 不抑制：模态挂死时这反而是逃生口。

import { isOpen as modalIsOpen } from './modal-stack.js';

/**
 * 事件是否发生在 CodeMirror 编辑器内部。
 * @param {Event} e
 * @returns {boolean}
 */
function isInsideEditor(e) {
  const target = e.target;
  if (!target || typeof target.closest !== 'function') return false;
  return !!target.closest('.cm-editor');
}

/**
 * @param {object} handlers
 * @param {() => void} handlers.onFocusSearch
 * @param {() => void} handlers.onClearSearch
 * @param {() => void} handlers.onSettings
 * @param {() => void} handlers.onToggleTheme
 * @param {() => void} handlers.onSave        - Ctrl/Cmd+S
 * @param {() => void} handlers.onToggleEditorMode - Ctrl/Cmd+E
 * @param {() => void} [handlers.onNewFile]   - Ctrl/Cmd+N
 * @param {() => void} [handlers.onToggleFocusMode] - Ctrl/Cmd+Shift+F
 * @param {() => void} [handlers.onToggleAi] - Ctrl/Cmd+Shift+A（AI 修改面板）
 * @param {() => void} [handlers.onReload]   - Ctrl/Cmd+R（README 之前提到但未注册——audit 补全）
 */
export function mountKeyboardShortcuts({
  onFocusSearch,
  onClearSearch,
  onSettings,
  onToggleTheme,
  onSave,
  onToggleEditorMode,
  onNewFile,
  onToggleFocusMode,
  onToggleAi,
  onReload,
}) {
  // audit fix (Phase O-M2)：提取命名 handler 让 dispose 能 removeEventListener。
  // 之前匿名函数 addEventListener 后无法解绑，测试 beforeEach 反复 mount
  // 会让 keydown listener 累积（每个按键触发 N 个回调）；生产路径虽然只 mount
  // 一次不致命，但 devtools 反复 Ctrl+R 重载 + HMR 场景下 listener 长期持有
  // handlers 闭包。
  const handler = (e) => {
    const ctrl = e.ctrlKey || e.metaKey;
    const modalOpen = modalIsOpen();

    // Esc 清空搜索（仅当焦点在搜索框内，且不在模态内——模态自身监听 Esc）
    if (e.key === 'Escape' && document.activeElement?.id === 'search-input' && !modalOpen) {
      // audit fix (Round 4 F3)：CJK IME 合成期间按 Esc 想收候选窗口时，document
      // 仍可能 fire keydown。本分支若不拦，会调用 onClearSearch 清空搜索词 + IME
      // 半截输入一起丢。下方 Ctrl+letter 分支已有 isComposing/keyCode=229 守卫，
      // Esc 分支同样加上保持对称。
      if (e.isComposing || e.keyCode === 229) return;
      if (onClearSearch) onClearSearch();
      return;
    }

    if (!ctrl) return;

    // C3 fix (audit)：CJK IME 合成期间（CJ / 中文拼音 / 日文 IME 等）浏览器
    // 仍会 fire keydown 给 Ctrl+letter 组合，且 key 已是真实字符（如 'e'）。
    // 此时触发「切换视图模式 / 新建文件 / 切换 AI」会让用户
    // 拼音还没敲完视图就跳了 —— 而且 editor 是 CM6 容器时，模式切换会
    // destroy view，合成中的 IME buffer 跟着丢。
    // keyCode === 229 是历史 fallback（Firefox / 旧 Chromium 用 keyCode 标识
    // composition 状态），与 isComposing 一起兜底。
    if (e.isComposing || e.keyCode === 229) return;

    const inEditor = isInsideEditor(e);

    // 模态打开时禁用所有 Ctrl/Cmd 类快捷键，避免抢焦点或顶替对话框。
    // 注意：编辑器内的 Ctrl+S/Ctrl+F 已经在 inEditor 分支里 return 了，
    // 所以这里再补一个 modalOpen 不会影响 CM6 内部的快捷键。
    if (modalOpen && !inEditor) {
      // 但 Ctrl+S 仍允许 —— 在模态内按 Ctrl+S 不该有副作用
      // 真正会被拦下的：Ctrl+, / Ctrl+F / Ctrl+Shift+T / Ctrl+E / Ctrl+N / Ctrl+Shift+F / Ctrl+Shift+A
      // 用 toLowerCase() 同时覆盖 Ctrl 与 Cmd，按 Shift 时 key 已是 'F'/'T' 等大写
      // —— 所以 'f' 一行就同时兜住 Ctrl+F 和 Ctrl+Shift+F，不用再写一份 shiftKey 子句。
      const k = e.key.toLowerCase();
      // P3 fix：用 Set 集中管理「modal 时需要吞掉的快捷键」白名单，
      // 之前手写 6 个 k === X 链式条件，新增快捷键容易漏写一份。
      // shiftKey-only 的 't' / 'a' 用 `${k}:shift` 作 key，加 shift 后缀区分。
      const SUPPRESS_KEYS = new Set([
        ',',
        'f',
        't:shift',
        'e',
        'n',
        'a:shift',
        // M1 fix (audit)：模态打开时拦截 Ctrl+W —— 否则 Electron 默认行为
        // 是直接关闭窗口（带「未保存」的 settings dialog 也一起没了）。
        // 'w' 无 shift 修饰，token 写法同 'f' / 'e' / 'n'。
        'w',
      ]);
      const token = e.shiftKey && (k === 't' || k === 'a') ? `${k}:shift` : k;
      if (SUPPRESS_KEYS.has(token) && !e.altKey) {
        e.preventDefault();
        return;
      }
    }

    // Ctrl/Cmd + F → 聚焦搜索（不带 Shift，让位给 Ctrl+Shift+F = 聚焦模式）
    // 编辑器内让给 CM6 的查找面板（文内查找显然比跳到文件搜索更符合预期）
    if ((e.key === 'f' || e.key === 'F') && !e.shiftKey) {
      if (inEditor) return;
      e.preventDefault();
      if (onFocusSearch) onFocusSearch();
      return;
    }

    // Ctrl/Cmd + , → 设置
    if (e.key === ',') {
      e.preventDefault();
      if (onSettings) onSettings();
      return;
    }

    // Ctrl/Cmd + Shift + T → 切换主题
    if ((e.key === 'T' || e.key === 't') && e.shiftKey) {
      e.preventDefault();
      if (onToggleTheme) onToggleTheme();
      return;
    }

    // Ctrl/Cmd + S → 保存（无 shift 修饰，避免误触）
    // 编辑器内 CM6 的 Prec.highest keymap 已经调过 onSave 了，
    // 这里再调一次会触发两次写盘 + 两个 toast。
    if ((e.key === 's' || e.key === 'S') && !e.shiftKey && !e.altKey) {
      if (inEditor) return;
      e.preventDefault();
      if (onSave) onSave();
      return;
    }

    // Ctrl/Cmd + E → 切换视图模式（CM6 没占用，编辑器内也生效）
    if ((e.key === 'e' || e.key === 'E') && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      if (onToggleEditorMode) onToggleEditorMode();
      return;
    }

    // Ctrl/Cmd + N → 新建文件
    // 注意：Ctrl+N 是 Electron「新建窗口」的传统快捷键，但本应用不提供多窗口，
    // 直接复用为「新建文件」更符合笔记应用直觉。
    if ((e.key === 'n' || e.key === 'N') && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      if (onNewFile) onNewFile();
      return;
    }

    // Ctrl/Cmd + Shift + F → 聚焦模式（隐藏工具栏/侧栏/状态栏，纯阅读）
    // 与 Ctrl+F 区别开 —— 后者是文内查找（编辑器内）/聚焦文件搜索（其它位置）。
    if ((e.key === 'F' || e.key === 'f') && e.shiftKey && !e.altKey) {
      e.preventDefault();
      if (onToggleFocusMode) onToggleFocusMode();
      return;
    }

    // Ctrl/Cmd + Shift + A → 切换 AI 修改面板（与聚焦模式同用 Shift 修饰，
    // 避开 Ctrl+S/E/N/F/T 等已占用位置）
    // C2 fix (audit)：编辑器聚焦时让位给 CM6 的 keymap（Shift+A 在编辑器里是
    // "全选" 之外的扩展键位），避免与编辑器内选择行为冲突。
    if ((e.key === 'A' || e.key === 'a') && e.shiftKey && !e.altKey) {
      if (inEditor) return;
      e.preventDefault();
      if (onToggleAi) onToggleAi();
      return;
    }

    // Ctrl/Cmd + R → 重新加载界面（README 之前提到但未注册——audit 补全）。
    // 与主菜单「重新加载」等价（两者都是 webContents.reload / location.reload）。
    // 不走 modalOpen 抑制：模态挂死时用户可能就需要这个来强制刷新。
    // 也不走 inEditor 抑制：CM6 没占 Ctrl+R。
    if ((e.key === 'r' || e.key === 'R') && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      if (onReload) onReload();
      return;
    }
  };
  document.addEventListener('keydown', handler);
  return () => document.removeEventListener('keydown', handler);
}
