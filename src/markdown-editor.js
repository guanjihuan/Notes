// Markdown 编辑器（CodeMirror 6 包装）
// 职责：装载文件、跟踪脏状态、暴露 save 回调。
//
// 不负责：文件 IO（走 app.js）、确认对话框（走 confirm-dialog.js）。
//
// 与 markdown-viewer.js 的关系：viewer 只关心「渲染这一段字符串」，
// editor 只关心「让用户编辑这一段字符串」；二者由 app.js 协调。

import { EditorState, Prec, Compartment } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { basicSetup } from 'codemirror';
import { markdown } from '@codemirror/lang-markdown';
import { getTextStats } from './stats.js';
import { pickEditorTheme } from './editor-theme.js';
import { createDisposable } from './component.js';

/**
 * Markdown 编辑器（CodeMirror 6 包装）
 * 职责：装载文件、跟踪脏状态、暴露 save 回调。
 *
 * 不负责：文件 IO（走 app.js）、确认对话框（走 confirm-dialog.js）、
 *        主题定义（走 editor-theme.js）。
 *
 * 与 markdown-viewer.js 的关系：viewer 只关心「渲染这一段字符串」，
 * editor 只关心「让用户编辑这一段字符串」；二者由 app.js 协调。
 */
export class MarkdownEditor {
  /**
   * @param {object} options
   * @param {HTMLElement} options.element - 容器 div（需有 height: 100%）
   * @param {() => void} options.onChange - 内容变化回调（用于脏状态 UI）
   * @param {() => void} options.onSave - Ctrl/Cmd+S 触发（也供 app.js 直接调用）
   * @param {(progress:number) => void} [options.onScroll] - 滚动/光标变化回调 (0..1)，用于双栏同步滚动
   */
  constructor({ element, onChange, onSave, onScroll }) {
    this.element = element;
    this.onChangeCallback = onChange;
    this.onSaveCallback = onSave;
    this.onScrollCallback = onScroll || null;
    this.view = null;
    this.lastSavedDoc = '';
    this.editableCompartment = new Compartment();
    this.themeCompartment = new Compartment();
    // audit fix (renderer-M4)：滚动/光标 geometryChanged 在 split 模式下
    // 会被 app.js 同步调到 viewer.setScrollProgress；getScrollProgress 读
    // scrollHeight/clientHeight 强制 layout flush，setScrollProgress 又写
    // scrollTop 触发再次 layout —— 每个 keystroke + 移动光标都走一遍 N 次
    // layout 计算，长文档能感知到 jank。用 rAF 把同帧内的多次触发合并到
    // 一次，rAF 回调里只做一次 getScrollProgress（reader 与 writer 之间也
    // 是同一帧，避免交错布局）。
    this._scrollFrame = null;
    // H1 fix (audit P0)：统一 dispose 入口。MarkdownEditor 不直接挂 DOM listener
    // （CodeMirror 自己处理），但需要暴露 dispose() 让 app.js 在切数据目录 / 重启
    // 窗口 / HMR 时显式释放。createDisposable 也提供 addAbort 注册 _destroyView
    // 之外的清理（如 rAF 取消、Compartment 引用置空）。dispose() 幂等，可重复调用。
    createDisposable(this);
    // 兜底清理：即便外部忘记调 dispose，rAF 取消 + view.destroy 仍会执行。
    // 注意：createDisposable 会在实例上挂 this.dispose —— 不能在 class 原型上
    // 另写同名的 dispose() 覆盖它。所有清理逻辑都通过 addAbort 注册，dispose()
    // 触发 abort 时统一执行。
    this.addAbort(() => {
      this._destroyView();
      this.lastSavedDoc = '';
      // 解除 callback 闭包对 viewer / 业务对象的引用，便于 GC。
      this.onChangeCallback = null;
      this.onSaveCallback = null;
      this.onScrollCallback = null;
      // audit fix (Round 7 LOW)：补齐 dispose 引用清理，与 onChangeCallback 等
      // 对称。_composing 标志若残留 true，下次 new MarkdownEditor 拿旧实例时会
      // 误判 IME（虽然 module-scope 的 editor 实例永不释放，但显式置 false
      // 让 _destroyView 路径上的状态机更易预测）。compartment 显式置 null 释放
      // 引用。_onComposition* 函数引用故意保留（顶部 view null 守卫兜底）——
      // dispose 后极端时序再 fire 这些 handler 仍然 noop，不会抛 TypeError。
      this._composing = false;
      this.editableCompartment = null;
      this.themeCompartment = null;
      // Round 13 fix (H8)：dispose 时也 abort viewAbort，确保即便 loadFile
      // 路径漏调（极端情况）contentDOM 上的 IME listener 也能摘掉。
      if (this._viewAbort) {
        try { this._viewAbort.abort(); } catch { /* ignore */ }
        this._viewAbort = null;
      }
    });
  }

  /**
   * 当前主题（dark / light）—— 决定是否套用 oneDark
   */
  get currentTheme() {
    return document.body.dataset.theme === 'light' ? 'light' : 'dark';
  }

  /**
   * 是否处于 IME 合成状态。CM6 不暴露 composing API；通过 contentDOM
   * compositionstart/end listener 跟踪。app.js 在 IME 期间要跳过：
   *   - auto-save（save() 写入 IME-buffer 中的未确认字符）
   *   - AI 应用（applyUserChange 在合成期会破坏 IME buffer）
   * 暴露 getter 而不是让外部读 _composing 下划线字段。
   * @returns {boolean}
   */
  isComposing() {
    return this._composing === true;
  }

  /**
   * 加载文件内容到编辑器。多次调用会销毁旧 view。
   * @param {{path:string,name:string}} file
   * @param {string} content
   */
  loadFile(file, content) {
    // audit fix (Round 7 MED)：element 早失败。CodeMirror 内部 parent.appendChild
    // 会因 null/undefined 抛 TypeError，把整个 bootstrap 拖到 unhandled rejection。
    // 显式校验：调用方若传错，loadFile 直接抛可读错误，app.js 顶层 catch 能定位。
    if (!this.element || typeof this.element.appendChild !== 'function') {
      throw new Error('MarkdownEditor: element required (must be a DOM node)');
    }
    this._destroyView();

    // Round 13 fix (H8)：clearListeners 用新 AbortController 包住本轮 view 的
    // listener 与 IME handler。下次 loadFile() / dispose() 时清掉旧 listener。
    // 旧实现每次 loadFile 都给 contentDOM addEventListener，但只 dispose 时
    // 才走 addAbort 的 remove —— 多次开文件会让 DOM 上累积多份 IME handler，
    // 极端时序（compositionend 在 view 已 destroy 之后才 fire）会跑多次
    // onChangeCallback，让 app 翻脏态 + 调度多余的 auto-save。
    this._viewAbort = new AbortController();
    // 把 contentDOM 上的 listener 挂到这个 signal，loadFile 重入 / dispose
    // 都一次性 abort。CM6 自己的 listener 用 contentDOM 默认挂（不在 signal
    // 上），由 _destroyView / view.destroy 拆解。
    const contentSignal = this._viewAbort.signal;

    this.lastSavedDoc = content || '';

    const state = EditorState.create({
      doc: this.lastSavedDoc,
      extensions: [
        EditorView.lineWrapping,
        basicSetup,
        markdown(),
        this.themeCompartment.of(pickEditorTheme(this.currentTheme)),
        this.editableCompartment.of(EditorView.editable.of(true)),
        Prec.highest(keymap.of([
          {
            key: 'Mod-s',
            preventDefault: true,
            run: () => {
              if (this.onSaveCallback) this.onSaveCallback();
              return true;
            },
          },
        ])),
        EditorView.updateListener.of((update) => {
          // audit fix (K2-H2)：CJK IME 合成期间，CM6 把每个临时字符 commit 成
          // 独立 transaction（userEvent: 'input.type.compose'）—— 一个 20 字的
          // 中文段落会触发 20 次 updateListener，每次 docChanged=true 都跑
          // onChange 全链路：state.isDirty 立即翻 true（用户还没打完就显示
          // 脏态）、save 按钮进 is-dirty 提示态、scheduleAutoSave 反复 clearTimeout、
          // scheduleLivePreview 200ms 后 viewer.loadContentLive 整页 innerHTML
          // 重建。合成中的 IME 字符不会真的写盘，对外只 commit 一次（compositionend）
          // —— 跳过中间过程，让脏态 / live preview / auto-save 在 compositionend
          // 时一次性 flush。
          // scroll（geometryChanged）不依赖 docChanged，IME 期间用户也可能滚动
          // 列表，跟之前一样保留。
          const isComposing = update.transactions.some((t) => t.isUserEvent('input.type.compose'));
          if (update.docChanged && !isComposing && this.onChangeCallback) {
            this.onChangeCallback();
          }
          // P1-10：只把「真实滚动」转发给 onScroll。
          // selectionSet（光标移动）也走到了这里 —— 但 app.js 的 onScroll 只是
          // viewer.setScrollProgress(...) 同步右侧预览位置，光标移动跟预览无关，
          // 不应该触发。getScrollProgress 会读 scrollHeight/clientHeight，强制
          // layout flush，10K 行文档下每个 keystroke + 移动光标都做几次 N 次
          // layout 计算，体感明显。
          if (update.geometryChanged && this.onScrollCallback) {
            // audit fix (renderer-M4)：geometryChanged 在 split 模式下会被高
            // 频触发，rAF 合并到一帧一次。rAF 在浏览器不可见标签页里会自然暂停，
            // 也避免背景 tab 里持续 layout flush。
            if (this._scrollFrame !== null) {
              cancelAnimationFrame(this._scrollFrame);
            }
            this._scrollFrame = requestAnimationFrame(() => {
              this._scrollFrame = null;
              // view 已经在 _destroyView 走完时被置 null，rAF 回调里再读会抛
              // getScrollProgress 已经做 null 检查，但显式守一遍更稳。
              if (!this.view || !this.onScrollCallback) return;
              this.onScrollCallback(this.getScrollProgress());
            });
          }
        }),
      ],
    });

    this.view = new EditorView({
      state,
      parent: this.element,
    });
    // audit fix (Phase O-M1)：跟踪 IME 合成状态。
    // CM6 没有公开 composing API（这是 contenteditable 的概念），最准确的方式
    // 是直接在 contentDOM 上挂 compositionstart/compositionend listener。
    // applyUserChange（AI 应用 diff）合成期间调用会摧毁 IME buffer，让 AI 控
    // 制器在 catch 里给用户「请稍后再试」提示。
    // listener 用 addAbort 注册，dispose 时统一解绑。
    //
    // audit fix (IME-dirty-flush)：compositionend 后补发 onChange。
    // updateListener 里 `!isComposing` 守卫在 IME 合成期间屏蔽 onChange
    // （避免中文每字触发一次 scheduleLivePreview / scheduleAutoSave）。
    // 但 compositionend 后 CM6 不一定再产生新 transaction —— 此时 onChange
    // 永远不触发，state.isDirty 保持 false，save() 走 !isDirty 早退，
    // 用户看到的中文已上屏但磁盘没写入。修复：compositionend 时主动比较
    // doc 与 lastSavedDoc，不同则补发 onChange 让 app 层正确翻脏态。
    this._composing = false;
    // audit fix (Round 7)：三个 IME handler 都先守 view 存在，dispose 后
    // _destroyView 把 view 置 null，再 fire 这些 handler（极端时序）不会抛
    // TypeError 而是 noop。原 onChange 路径里也有 `this.view &&` 守卫，这次
    // 提到函数顶部，让整个 dispose-after-fire 路径完全幂等。
    this._onCompositionStart = () => {
      if (!this.view) return;
      this._composing = true;
    };
    this._onCompositionEnd = () => {
      if (!this.view) return;
      this._composing = false;
      // IME 提交后补发 onChange：doc 已变但 updateListener 在合成期没调过
      // onChange → state.isDirty 还是 false。这里主动调一次让 app 翻脏。
      // 防御性校验：view 可能已被 dispose、callback 可能已解绑。
      if (this.onChangeCallback) {
        const currentDoc = this.view.state.doc.toString();
        if (currentDoc !== this.lastSavedDoc) {
          this.onChangeCallback();
        }
      }
    };
    // audit fix (Round 7 HIGH)：compositioncancel listener。
    // 部分 OS / IME 实现（如 macOS 日语 IME 切换、Windows 部分第三方输入法）
    // 在用户按 Esc 取消 / 外部抢焦点 / IME 引擎切换时只发 compositioncancel
    // 不发 compositionend —— _composing 会永远停在 true，所有 dispatch
    // （applyUserChange / setExternalContent）抛 EDITOR_COMPOSING，编辑器
    // 永久锁死直到用户 reload view。处理同 compositionend：清标记 + 补 onChange。
    this._onCompositionCancel = () => {
      if (!this.view) return;
      this._composing = false;
      if (this.onChangeCallback) {
        const currentDoc = this.view.state.doc.toString();
        if (currentDoc !== this.lastSavedDoc) {
          this.onChangeCallback();
        }
      }
    };
    // Round 13 fix (H8)：用 this._viewAbort.signal 一次性管所有 listener，
    // 下次 loadFile / dispose 时整体 abort。旧版 addAbort 路径在 dispose 时
    // 才 removeEventListener，期间多次 loadFile 会让多份 IME handler 累积
    // 在 contentDOM 上。signal 路径里 removeEventListener 由浏览器自动处理。
    this.view.contentDOM.addEventListener('compositionstart', this._onCompositionStart, { signal: contentSignal });
    this.view.contentDOM.addEventListener('compositionend', this._onCompositionEnd, { signal: contentSignal });
    this.view.contentDOM.addEventListener('compositioncancel', this._onCompositionCancel, { signal: contentSignal });
  }

  /**
   * 切换编辑器主题（不重建 view）
   * @param {'dark'|'light'} theme
   */
  setTheme(theme) {
    if (!this.view) return;
    const ext = pickEditorTheme(theme);
    this.view.dispatch({
      effects: this.themeCompartment.reconfigure(ext),
    });
  }

  /**
   * 卸载当前编辑器（不写盘）
   */
  unload() {
    this._destroyView();
    this.lastSavedDoc = '';
    // Phase N-2 修复（关键 bug · 保存按钮失灵）：
    //   K2-L10 的旧实现会在这里清掉 onChange/onSave/onScroll 三个 callback。
    //   后果：clearCurrentFile() → unload() 把 callback 置空 → 下次 openFile
    //   走 editor.loadFile() 时只重建 view，**不重建 callback** → 用户的
    //   编辑不再触发 state.isDirty 翻转 → 保存按钮永远不亮 → 用户以为保存
    //   按钮坏了。
    //
    //   触发场景：当前打开的文件被外部删除 → applyEntries 调 clearCurrentFile
    //   → 卸载旧 view 并清 callback → 用户再开新文件 → loadFile 只重建 view
    //   → callback 仍是 null → 编辑器从此对所有用户输入静默忽略。
    //
    //   K2-L10 的原意（HMR/切数据目录/Ctrl+R 不挂旧闭包）：这一层不该由
    //   unload() 兜底，应该由 dispose() 兜底（pagehide 清理在 app.js:3497
    //   已正确调 editor.dispose()），dispose() 走 addAbort 注册的清理路径
    //   会把 callback 置 null。unload() 只清 view 状态，不动 callback。
    //
    //   关于 callback 闭包反向持有 viewer/state/ai 的"内存延长"顾虑 —— editor
    //   实例本身是 module-scope 的（app.js:475 const editor = new MarkdownEditor(...)），
    //   永不释放；callback 持有那几个引用等价于 editor 持有那几个引用，不存在
    //   "延长 lifecycle"的差异。让 callback 跟 editor 一起活到 dispose()。
  }

  /**
   * 取当前编辑器内容（字符串）
   */
  getContent() {
    if (!this.view) return '';
    return this.view.state.doc.toString();
  }

  /**
   * 是否脏（未保存改动）
   */
  isDirty() {
    if (!this.view) return false;
    return this.view.state.doc.toString() !== this.lastSavedDoc;
  }

  /**
   * 标记当前内容为「已保存」基线。下次 isDirty() 比较的就是这次保存的版本。
   */
  markSaved() {
    if (!this.view) return;
    this.lastSavedDoc = this.view.state.doc.toString();
  }

  /**
   * 用外部内容替换当前编辑器内容（例如外部修改覆盖本地）。
   * 同时更新 lastSavedDoc —— 因为这是从磁盘来的「最新权威」。
   *
   * 注意：必须先更新 lastSavedDoc 再 dispatch，否则 updateListener 会同步触发 onChange，
   * 此时 lastSavedDoc 仍是旧值，isDirty() 会错误返回 true。
   *
   * audit fix (K2-M4)：dispatch 前快照当前 selection，dispatch 时回填到
   * clamp 后的位置 —— CM6 默认把光标落到新 doc末尾，若用户正读到第 50 行做
   * diff 标注，外部一次保存就把编辑器滚到底部，等于打断阅读。
   */
  setExternalContent(content) {
    if (!this.view) return;
    // audit fix (Round 4 F2)：IME 合成期拒绝 setExternalContent。
    // fs-watcher 在 _composing=true 期间推「外部修改」→ view.dispatch 全量替换
    // doc 会摧毁 IME 合成 buffer，已输入的拼音字符消失。applyUserChange 已有同样
    // 守卫，setExternalContent 同性质入口行为必须对齐。抛 EDITOR_COMPOSING 让
    // 调用方 catch 后给用户「请稍后再试」提示或推迟到 compositionend 后再 dispatch。
    if (this._composing) {
      throw new Error('EDITOR_COMPOSING');
    }
    const sel = this.view.state.selection.main;
    this.lastSavedDoc = content || '';
    const insert = content || '';
    const newLen = insert.length;
    this.view.dispatch({
      changes: { from: 0, to: this.view.state.doc.length, insert },
      selection: {
        anchor: Math.min(sel.anchor, newLen),
        head: Math.min(sel.head, newLen),
      },
    });
  }

  /**
   * 用新内容替换当前编辑器内容，并把这次替换标记为"未保存改动"。
   * 与 setExternalContent 的区别：lastSavedDoc 不跟着更新，
   * 替换后 isDirty() 仍返回 true（自动保存 / Ctrl+S 能正确触发）。
   *
   * 用于 AI 修改应用：用户能 Ctrl+Z 撤销 AI 的改动、自动保存会落盘、
   * 保存按钮进入 is-dirty 提醒态。
   *
   * userEvent: 'input.fromAI' 让 CodeMirror 把它当作一次用户输入（影响 undo history）。
   * 单次 dispatch 完整替换（而不是 splice），所以 undo 一步就回到旧内容。
   */
  applyUserChange(content) {
    if (!this.view) return;
    // audit fix (Phase O-M1)：IME 合成期间拒绝 applyUserChange。
    // AI 控制器（chat dock 自动 apply / 用户鼠标误点 chat）调用本方法时，
    // 若用户正在 CJK 拼音输入，view.dispatch 全量替换 doc 会摧毁 IME 合成
    // buffer，已输入的拼音字符消失。抛特定 message 让调用方 catch 后给用户
    // 「请稍后再试」提示（ai-controller.js 已 try/catch + 按 message 区分）。
    if (this._composing) {
      throw new Error('EDITOR_COMPOSING');
    }
    // audit fix (K2-M3)：dispatch 前快照 selection.main（AI 应用 region/all
    // 整页替换后，CM6 默认把光标落到新 doc 末尾）。clamp 到新 doc 内，至少
    // 保留用户下次编辑起点（接受 AI 改动后想继续写，不至于被甩到文末）。
    const sel = this.view.state.selection.main;
    const insert = content || '';
    const newLen = insert.length;
    this.view.dispatch({
      changes: { from: 0, to: this.view.state.doc.length, insert },
      userEvent: 'input.fromAI',
      selection: {
        anchor: Math.min(sel.anchor, newLen),
        head: Math.min(sel.head, newLen),
      },
    });
  }

  // L11 fix (audit)：原参数名 `enabled` 是双重否定陷阱 —— 调用方
  // setReadOnly(true) 实际是「启用只读」，跟「enable writing」直觉反着。
  // 改名 `readOnly` 后 setReadOnly(true) = 只读，setReadOnly(false) = 可写。
  // CM6 内部 EditorView.editable.of(true) 表示「可编辑」，所以仍然要取反。
  setReadOnly(readOnly) {
    if (!this.view) return;
    this.view.dispatch({
      effects: this.editableCompartment.reconfigure(EditorView.editable.of(!readOnly)),
    });
  }

  focus() {
    if (this.view) this.view.focus();
  }

  /**
   * 编辑器的滚动进度（0..1）
   *
   * 用滚动视口顶部在文档中的位置（即「已滚过的距离 / 总可滚距离」）作为比例，
   * 与 viewer 的 getScrollProgress() 口径一致，双栏同步时直接套用即可。
   *
   * 如果文档没溢出（max<=0），返回 0 —— 避免 NaN。
   * @returns {number}
   */
  getScrollProgress() {
    if (!this.view) return 0;
    const scroller = this.view.scrollDOM;
    const max = scroller.scrollHeight - scroller.clientHeight;
    if (max <= 0) return 0;
    return Math.min(1, Math.max(0, scroller.scrollTop / max));
  }

  /**
   * 把编辑器滚动到指定比例（0..1）。供双栏反向同步（viewer → editor）。
   * 与 viewer.setScrollProgress() 是一对。
   * @param {number} progress
   */
  setScrollProgress(progress) {
    if (!this.view) return;
    const scroller = this.view.scrollDOM;
    const max = scroller.scrollHeight - scroller.clientHeight;
    if (max <= 0) return;
    const target = Math.min(1, Math.max(0, progress)) * max;
    scroller.scrollTop = target;
  }

  /**
   * 当前编辑器的字数统计（CJK 友好，统一走 stats.js）
   * 行数基于源文本非空行数，与 viewer 一致 —— 切换预览/编辑时不会跳变。
   * @returns {{chars:number, words:number, lines:number}}
   */
  getStats() {
    if (!this.view) return { chars: 0, words: 0, lines: 1 };
    return getTextStats(this.view.state.doc.toString());
  }

  _destroyView() {
    // audit fix (M2)：loadFile 走 _destroyView → 立刻建新 _viewAbort；旧信号若
    // 不 abort，挂在新 view contentDOM 上的 compositionstart/end/cancel listener
    // 仍绑着。view.destroy() 只解 CM6 自己的 DOM，**不**摘我们手动 add 的 listener。
    // detach 后 listener 不会 fire（事件 target 已不在 DOM），但 listener↔signal
    // 循环推迟旧 view 整棵子树的 GC。
    if (this._viewAbort) {
      try { this._viewAbort.abort(); } catch { /* ignore */ }
      this._viewAbort = null;
    }
    // audit fix (renderer-M4)：先取消可能挂着的 rAF —— 否则 destroy 后 rAF
    // 回调里读 this.view / this.onScrollCallback 还能命中内存中尚未 GC 的
    // 引用，触发到旧组件实例的回调链。
    if (this._scrollFrame !== null) {
      cancelAnimationFrame(this._scrollFrame);
      this._scrollFrame = null;
    }
    if (this.view) {
      this.view.destroy();
      this.view = null;
    }
  }
}
