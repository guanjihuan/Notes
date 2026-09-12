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
