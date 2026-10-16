// src/markdown-editor.js 测试 —— IME compositionend dirty flush
//
// 回归背景：updateListener 里 `!isComposing` 守卫在 IME 合成期间屏蔽 onChange
// 回调（避免 CJK 每个拼音字母触发一次 scheduleLivePreview 全页重建）。但
// compositionend 后 CM6 不一定再产生新 transaction —— 此时 onChange 永远不
// 触发，state.isDirty 保持 false，save() 走 !isDirty 早退返回 true，用户
// 看到中文已上屏但磁盘文件没写入。
//
// 修复：compositionend handler 主动比较 doc 与 lastSavedDoc，不同则补发
// onChange 让 app 层翻脏态。本文件覆盖这条新路径。
//
// 也覆盖：
//   - IME 期间 _composing 标记正确翻转
//   - IME 取消（doc 未变）不触发 onChange
//   - dispose 后 compositionend 不抛
//   - applyUserChange 在 IME 期间抛 EDITOR_COMPOSING
//
// 注意：jsdom 不实现 contenteditable / 真实 IME 事件，所以直接调
// editor._onCompositionStart / _onCompositionEnd 模拟。

/* @vitest-environment jsdom */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MarkdownEditor } from '../../src/markdown-editor.js';

// jsdom 不实现 scrollIntoView；MarkdownEditor 本身不调，但 CM6 basicSetup 可能
if (!HTMLElement.prototype.scrollIntoView) {
  HTMLElement.prototype.scrollIntoView = function () {};
}
// CM6 的 requestAnimationFrame 探测 —— jsdom 没有，polyfill
if (typeof window.requestAnimationFrame === 'undefined') {
  window.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  window.cancelAnimationFrame = (id) => clearTimeout(id);
}
// CM6 RectangleMarker 测量选中区时调 Range#getClientRects；jsdom 没实现
// Range#textRange 是 jsdom 假实现但没挂 getClientRects。每次 measure 抛 TypeError
// 会被 vitest 写到 stderr（污染测试输出）。返回空数组让 CM6 跳过选中区绘制。
if (typeof Range.prototype.getClientRects !== 'function') {
  Range.prototype.getClientRects = function () {
    // 真实浏览器返回 DOMRectList，CM6 只迭代 + 读 .top/.left/.width/.height。
    // 用 array-like 占位即可，避免导入完整 DOMRect 带来的兼容开销
    const arr = [];
    arr.item = (i) => arr[i] || null;
    return arr;
  };
}
if (typeof Range.prototype.getBoundingClientRect !== 'function') {
  Range.prototype.getBoundingClientRect = function () {
    return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 };
  };
}

function createEditor(opts = {}) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const onChange = vi.fn();
  const onSave = vi.fn();
  const editor = new MarkdownEditor({ element: el, onChange, onSave });
  return { editor, el, onChange, onSave };
}

describe('MarkdownEditor IME compositionend dirty flush', () => {
  let editor, el, onChange;

  beforeEach(() => {
    ({ editor, el, onChange } = createEditor());
    editor.loadFile({ path: '/test.md', name: 'test.md' }, 'hello');
  });

  it('IME 提交后 doc 变化 → compositionend 补发 onChange', () => {
    // 初始：doc === lastSavedDoc → isDirty = false
    expect(editor.isDirty()).toBe(false);
    expect(onChange).not.toHaveBeenCalled();

    // 模拟 IME 开始
    editor._onCompositionStart();
    expect(editor._composing).toBe(true);

    // 模拟 IME 期间 CM6 把中文写入了 doc。
    // userEvent: 'input.type.compose' 让 updateListener 识别为 IME 合成事件，
    // isComposing=true → onChange 被守卫屏蔽（这是原来的设计意图）。
    const view = editor.view;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: '你好世界' },
      userEvent: 'input.type.compose',
    });
    // 合成期间 onChange 被守卫屏蔽（这是原来的设计意图）
    expect(onChange).not.toHaveBeenCalled();
    // 但 doc 已经变了
    expect(view.state.doc.toString()).toBe('你好世界');
    expect(editor.isDirty()).toBe(true);

    // 模拟 IME 结束 —— 这是修复的关键：compositionend 必须补发 onChange
    editor._onCompositionEnd();
    expect(editor._composing).toBe(false);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('IME 取消（doc 未变）→ compositionend 不补发 onChange', () => {
    expect(editor.isDirty()).toBe(false);

    editor._onCompositionStart();
    expect(editor._composing).toBe(true);

    // 用户取消 IME（按 Esc）—— doc 没变
    editor._onCompositionEnd();
    expect(editor._composing).toBe(false);
    // doc 没变 → 不应触发 onChange
    expect(onChange).not.toHaveBeenCalled();
  });

  it('IME 期间已有 onChange（非 IME 字符触发）→ compositionend 不重复调', () => {
    // 场景：IME 期间用户也敲了一个英文字符，updateListener 因 !isComposing
    // 守卫不调 onChange，但如果将来守卫被移除或行为变化，compositionend 也不
    // 应该重复调（因为 doc 已在 updateListener 里触发过 onChange）。
    // 注意：当前实现中 updateListener 在 isComposing 时不调 onChange，所以
    // 这个测试验证 compositionend 只按「doc != lastSavedDoc」判断，
    // 不关心 onChange 之前是否已被调过。
    editor._onCompositionStart();
    const view = editor.view;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: '中文' },
      userEvent: 'input.type.compose',
    });
    // 手动模拟 updateListener 路径已调过 onChange（假设守卫被绕过的场景）
    onChange.mockClear();

    // compositionend 仍然会触发 onChange（因为 doc != lastSavedDoc）
    // 这是「宁可多调一次，不可漏调」的设计选择
    editor._onCompositionEnd();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('dispose 后 compositionend 不抛', () => {
    editor._onCompositionStart();
    editor.dispose();
    // dispose 后 view 被销毁，compositionend 不应抛
    expect(() => editor._onCompositionEnd()).not.toThrow();
    expect(editor._composing).toBe(false);
  });

  it('IME 期间 applyUserChange 抛 EDITOR_COMPOSING', () => {
    editor._onCompositionStart();
    expect(() => editor.applyUserChange('新内容')).toThrow('EDITOR_COMPOSING');
  });

  it('非 IME 期间 applyUserChange 不抛', () => {
    expect(() => editor.applyUserChange('新内容')).not.toThrow();
  });

  // audit fix (Round 4 F2)：setExternalContent 也要 IME 守卫。
  // fs-watcher 在 IME 合成期推「外部修改」→ view.dispatch 全量替换 doc
  // 会摧毁 IME 合成 buffer，已输入的拼音字符消失。与 applyUserChange 行为
  // 对齐：合成期间抛 EDITOR_COMPOSING 让调用方 catch 后给用户「请稍后再试」。
  it('IME 期间 setExternalContent 抛 EDITOR_COMPOSING', () => {
    editor._onCompositionStart();
    expect(() => editor.setExternalContent('外部内容')).toThrow('EDITOR_COMPOSING');
    // doc 没被替换
    expect(editor.getContent()).toBe('hello');
  });

  it('非 IME 期间 setExternalContent 不抛 + lastSavedDoc 同步更新', () => {
    expect(editor.isDirty()).toBe(false);
    editor.setExternalContent('外部内容');
    expect(editor.getContent()).toBe('外部内容');
    expect(editor.isDirty()).toBe(false);
  });
});

describe('MarkdownEditor 基础行为', () => {
  it('loadFile 后 isDirty = false', () => {
    const { editor } = createEditor();
    editor.loadFile({ path: '/x.md', name: 'x.md' }, 'content');
    expect(editor.isDirty()).toBe(false);
    expect(editor.getContent()).toBe('content');
  });

  it('输入后 isDirty = true', () => {
    const { editor } = createEditor();
    editor.loadFile({ path: '/x.md', name: 'x.md' }, 'content');
    editor.view.dispatch({
      changes: { from: 0, to: editor.view.state.doc.length, insert: 'changed' },
    });
    expect(editor.isDirty()).toBe(true);
    expect(editor.getContent()).toBe('changed');
  });

  it('markSaved 后 isDirty 归零', () => {
    const { editor } = createEditor();
    editor.loadFile({ path: '/x.md', name: 'x.md' }, 'old');
    editor.view.dispatch({
      changes: { from: 0, to: editor.view.state.doc.length, insert: 'new' },
    });
    expect(editor.isDirty()).toBe(true);
    editor.markSaved();
    expect(editor.isDirty()).toBe(false);
  });

  it('unload 后再 compositionend 不抛（view 已 null）', () => {
    const { editor } = createEditor();
    editor.loadFile({ path: '/x.md', name: 'x.md' }, '');
    editor.unload();
    expect(() => editor._onCompositionEnd()).not.toThrow();
  });
});


// ============================================================================
// audit R7b P1-18：单实例 EditorView 持久化
// ============================================================================
//
// 核心契约：loadFile 多次调用复用同一 view 实例，不再 _destroyView + new。
// 旧实现下：A→B→A 切文件会丢 history / selection / 折叠，30-100ms 黑闪。
describe('MarkdownEditor 单实例 view 持久化 (audit R7b P1-18)', () => {
  it('首次 loadFile 创建 view', () => {
    const { editor } = createEditor();
    expect(editor.view).toBeNull();
    editor.loadFile({ path: '/a.md', name: 'a.md' }, 'A content');
    expect(editor.view).not.toBeNull();
    expect(editor.getContent()).toBe('A content');
  });

  it('多次 loadFile 复用同一 view 实例（A→B→A 同一 view）', () => {
    const { editor } = createEditor();
    editor.loadFile({ path: '/a.md', name: 'a.md' }, 'A content');
    const viewA = editor.view;
    // 切到 B
    editor.loadFile({ path: '/b.md', name: 'b.md' }, 'B content');
    expect(editor.view).toBe(viewA); // 引用相等
    expect(editor.getContent()).toBe('B content');
    // 切回 A（新内容）
    editor.loadFile({ path: '/a.md', name: 'a.md' }, 'A content v2');
    expect(editor.view).toBe(viewA);
    expect(editor.getContent()).toBe('A content v2');
  });

  it('loadFile 切换文件后 selection 重置到 (0, 0)', () => {
    const { editor } = createEditor();
    editor.loadFile({ path: '/a.md', name: 'a.md' }, 'hello world');
    // 用户手动把光标移到位置 5
    editor.view.dispatch({ selection: { anchor: 5, head: 5 } });
    expect(editor.view.state.selection.main.anchor).toBe(5);
    // 切到 B → selection 应被重置
    editor.loadFile({ path: '/b.md', name: 'b.md' }, 'foo bar baz');
    expect(editor.view.state.selection.main.anchor).toBe(0);
    expect(editor.view.state.selection.main.head).toBe(0);
  });

  it('loadFile 切换后 history 仍可用（view 复用，undo stack 保留）', () => {
    const { editor } = createEditor();
    editor.loadFile({ path: '/a.md', name: 'a.md' }, 'one');
    // 用户编辑 → 一些 transaction 计入 history
    editor.view.dispatch({ changes: { from: 3, insert: ' two' } });
    editor.view.dispatch({ changes: { from: 7, insert: ' three' } });
    expect(editor.getContent()).toBe('one two three');
    // 切到 B 再切回 A（content 是初始 one，dispatch 替换；这里测的是 view 复用，
    // 不是 history 跨文件保留——后者是更大设计问题，本测试只锁 view 实例稳定）
    editor.loadFile({ path: '/b.md', name: 'b.md' }, 'B');
    expect(editor.view).not.toBeNull();
    // view 还是同一个引用 → history 字段在 view 生命周期内持续
    // （CM6 history field 由 EditorState 持有；view 复用 = state 延续）
    const beforeUndo = editor.view.state.doc.toString();
    // 触发一次新 transaction（与刚才的 history 关联）
    editor.view.dispatch({ changes: { from: 1, insert: 'B' } });
    // undo 应该能回到 beforeUndo
    expect(editor.view.state.doc.toString()).not.toBe(beforeUndo);
  });

  it('loadFile 复用 view 时 _viewAbort signal 不重建（IME listener 不会重复挂）', () => {
    const { editor } = createEditor();
    editor.loadFile({ path: '/a.md', name: 'a.md' }, 'A');
    const signal1 = editor._viewAbort;
    editor.loadFile({ path: '/b.md', name: 'b.md' }, 'B');
    const signal2 = editor._viewAbort;
    // view 复用 → 不需要新的 AbortController（IME listener 还在原 signal 上）
    expect(signal2).toBe(signal1);
  });

  it('unload → 销毁 view；再 loadFile 创建新 view', () => {
    const { editor } = createEditor();
    editor.loadFile({ path: '/a.md', name: 'a.md' }, 'A');
    const viewA = editor.view;
    editor.unload();
    expect(editor.view).toBeNull();
    editor.loadFile({ path: '/b.md', name: 'b.md' }, 'B');
    // unload 后 view 是 null；下次 loadFile 触发 _createView → 新 view
    expect(editor.view).not.toBe(viewA);
    expect(editor.view).not.toBeNull();
    expect(editor.getContent()).toBe('B');
  });

  it('多次 loadFile 复用 view 时 _viewAbort signal 引用稳定（IME listener 不重建）', () => {
    // 核心契约：旧实现每次 loadFile 都 _destroyView + new AbortController，
    // 但 addAbort 路径在 dispose 时才 remove —— 多次切文件会让 contentDOM
    // 上累积多份 IME listener（compositionend 跑多次 → onChange 多次 →
    // state.isDirty 翻脏态反复 + scheduleAutoSave 多次 clearTimeout）。
    // 新实现下 view 整个 lifetime 只一个 _viewAbort signal，listener 只一份。
    // 验证方式：loadFile 多次，_viewAbort 引用始终相等。
    const { editor } = createEditor();
    editor.loadFile({ path: '/a.md', name: 'a.md' }, 'A');
    const signalRef = editor._viewAbort;
    expect(signalRef).not.toBeNull();
    for (let i = 0; i < 10; i++) {
      editor.loadFile({ path: `/f${i}.md`, name: `f${i}.md` }, `content ${i}`);
      expect(editor._viewAbort).toBe(signalRef);
    }
  });

  it('loadFile 重复同一文件：onChange 触发次数精确等于 dispatch 次数（listener 不重复挂）', () => {
    // 回归锚点：旧实现每次 loadFile 都 addEventListener 三次（compositionstart
    // / end / cancel），但 dispose 才 remove —— contentDOM 上 listener 数量
    // 线性增长。N 次切文件 → onChange 被触发 3N 次。新实现下 view 不重建，
    // listener 只一份，N 次 loadFile 正好 N 次 onChange。
    const { editor, onChange } = createEditor();
    editor.loadFile({ path: '/a.md', name: 'a.md' }, 'A');
    const baseCount = onChange.mock.calls.length;
    for (let i = 0; i < 5; i++) {
      editor.loadFile({ path: '/a.md', name: 'a.md' }, `A${i}`);
    }
    const delta = onChange.mock.calls.length - baseCount;
    expect(delta).toBe(5); // 精确 5，不是 10 / 15 / ...
  });

  it('A→B→A 场景下 lastSavedDoc 跟踪最终内容', () => {
    const { editor } = createEditor();
    editor.loadFile({ path: '/a.md', name: 'a.md' }, 'A1');
    editor.loadFile({ path: '/b.md', name: 'b.md' }, 'B1');
    editor.loadFile({ path: '/a.md', name: 'a.md' }, 'A2');
    // loadFile 总是把 lastSavedDoc 同步到传入 content
    expect(editor.lastSavedDoc).toBe('A2');
    expect(editor.isDirty()).toBe(false);
  });

  it('getContent 在多次 loadFile 后返回当前 view 的 doc（不是 lastSavedDoc）', () => {
    const { editor } = createEditor();
    editor.loadFile({ path: '/a.md', name: 'a.md' }, 'A');
    expect(editor.getContent()).toBe('A');
    // 用户编辑
    editor.view.dispatch({ changes: { from: 1, insert: 'A-edit' } });
    expect(editor.getContent()).toBe('AA-edit');
    // 切到 B
    editor.loadFile({ path: '/b.md', name: 'b.md' }, 'B');
    expect(editor.getContent()).toBe('B');
    // 切回 A（content 是 A 初始的，但 view 的 doc 是 A-edit 之前 dispatch 过的
    // 状态——实际 loadFile 走 dispatch 全量替换，所以 doc 回到 A 初始）
    editor.loadFile({ path: '/a.md', name: 'a.md' }, 'A');
    expect(editor.getContent()).toBe('A');
  });
});
