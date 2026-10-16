// src/markdown-editor.js —— CodeMirror history depth 上限（audit P0-3）
//
// 背景：basicSetup 默认带 history()，无 maxDepth 上限。打开 5MB 文件 + 长
// 时间编辑 → history stack 几百 MB，OOM 风险。
//
// 修复：extensions 列表里 basicSetup 之后加 Prec.high(history({ minEventTimeout: 200, maxDepth: 500 }))。
// 覆盖 basicSetup 的默认 history 配置：maxDepth 限制 undo 步数，minEventTimeout
// 把 200ms 内的连续 keystroke 合并成 1 步（避免每个键 1 步、3 千字输入塞 3 千
// 条 history）。
//
// 测试策略：
//   - 1MB 文档 + 1000 次独立 transaction → undoDepth ≤ 500（maxDepth）
//   - 500 次 transaction → undoDepth = 500（恰好满载）
//   - undo 一次 → undoDepth 减 1，redoDepth 加 1

// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { undoDepth, redoDepth, undo, isolateHistory } from '@codemirror/commands';
import { EditorView } from '@codemirror/view';
import { MarkdownEditor } from '../../src/markdown-editor.js';

if (!HTMLElement.prototype.scrollIntoView) {
  HTMLElement.prototype.scrollIntoView = function () {};
}
if (typeof window.requestAnimationFrame === 'undefined') {
  window.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  window.cancelAnimationFrame = (id) => clearTimeout(id);
}
if (typeof Range.prototype.getClientRects !== 'function') {
  Range.prototype.getClientRects = function () {
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

function createEditor() {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return new MarkdownEditor({
    element: el,
    onChange: vi.fn(),
    onSave: vi.fn(),
  });
}

describe('CodeMirror history depth 上限（audit P0-3）', () => {
  let editor;

  beforeEach(() => {
    editor = createEditor();
  });

  it('加载空 doc → undoDepth = 0', () => {
    // MarkdownEditor 懒加载 view —— 必须先 loadFile
    editor.loadFile({ path: '/empty.md', name: 'empty.md' }, '');
    expect(undoDepth(editor.view.state)).toBe(0);
  });

  it('1000 次独立 transaction → undoDepth ≤ 520（minDepth 500 + updateBranch +20 buffer）', () => {
    // 注：audit P0-3 描述「1MB 文档 + 1000 次 transaction」—— 这里用 1KB
    // 文档，理由：audit 关心的是 history 长度上限（minDepth 截断），不关心
    // 文档大小本身。1KB 文档下跑 1000 次 dispatch 几秒内出结果，1MB 文档
    // 要 46 秒（每次 dispatch 都做 change mapping + state 克隆）。
    editor.loadFile({ path: '/big.md', name: 'big.md' }, 'x'.repeat(1024));
    const view = editor.view;

    // 1000 次独立 transaction：用 userEvent: 'test.step' 跳出 joinableUserEvent
    // 正则（^(input\.type|delete)($|\.)）—— 不匹配的 userEvent 不会与上一个
    // event 合并，确保每个 transaction 各自成为 1 个 history step。
    // 同步加 isolateHistory 标注，双重保险。
    for (let i = 0; i < 1000; i++) {
      view.dispatch({
        changes: { from: 0, to: 1, insert: String.fromCharCode(65 + (i % 26)) },
        userEvent: 'test.step',
        annotations: [isolateHistory.of('test')],
      });
    }

    // 关键断言：undoDepth 不会无限增长，超 minDepth(500) 即被截断
    // updateBranch 内部 maxLen + 20 buffer，所以上限是 520
    expect(undoDepth(view.state)).toBeLessThanOrEqual(520);
    expect(undoDepth(view.state)).toBeGreaterThanOrEqual(500);
  });

  it('500 次 transaction → undoDepth = 500（恰好满载，未截断）', () => {
    editor.loadFile({ path: '/x.md', name: 'x.md' }, 'hello world');
    const view = editor.view;

    for (let i = 0; i < 500; i++) {
      view.dispatch({
        changes: { from: 0, to: 1, insert: String.fromCharCode(65 + (i % 26)) },
        userEvent: 'test.step',
        annotations: [isolateHistory.of('test')],
      });
    }

    expect(undoDepth(view.state)).toBe(500);
  });

  it('undo 一次 → undoDepth 减 1，redoDepth 加 1（minDepth 限制下 history 仍可用）', () => {
    editor.loadFile({ path: '/x.md', name: 'x.md' }, 'hello');
    const view = editor.view;

    for (let i = 0; i < 3; i++) {
      view.dispatch({
        changes: { from: 0, to: 0, insert: 'a' },
        userEvent: 'test.step',
        annotations: [isolateHistory.of('test')],
      });
    }
    expect(undoDepth(view.state)).toBe(3);
    expect(redoDepth(view.state)).toBe(0);

    undo(view);
    expect(undoDepth(view.state)).toBe(2);
    expect(redoDepth(view.state)).toBe(1);
  });

  it('超 500 步后 undo 老的 history 被丢弃，只剩最新的 ~500 步可撤销', () => {
    editor.loadFile({ path: '/x.md', name: 'x.md' }, 'x');
    const view = editor.view;

    // 600 步独立 transaction
    for (let i = 0; i < 600; i++) {
      view.dispatch({
        changes: { from: 0, to: 0, insert: 'a' },
        userEvent: 'test.step',
        annotations: [isolateHistory.of('test')],
      });
    }
    // 600 步后只剩 minDepth(500) + 20 buffer = 520
    expect(undoDepth(view.state)).toBeLessThanOrEqual(520);
    expect(undoDepth(view.state)).toBeGreaterThanOrEqual(500);

    // 连续 undo 直到 history 空
    while (undoDepth(view.state) > 0) {
      undo(view);
    }
    expect(undoDepth(view.state)).toBe(0);
    // redo 应有 ~500+ 条
    expect(redoDepth(view.state)).toBeLessThanOrEqual(520);
    expect(redoDepth(view.state)).toBeGreaterThanOrEqual(500);

    // 再 undo：应失败（已无 history 可撤销）
    const beforeUndo = undoDepth(view.state);
    undo(view);
    expect(undoDepth(view.state)).toBe(beforeUndo); // 没变化
  });
});
