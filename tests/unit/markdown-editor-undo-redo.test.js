// 2026-10 撤销 / 重做按钮（#btn-undo / #btn-redo）背后的 MarkdownEditor 门面：
//   - canUndo / canRedo 跟随 CodeMirror history 深度
//   - undo / redo 执行命令并返回是否生效
//   - loadFile 复用 view 切文件时 history 重置（每文件一份干净 undo/redo 栈，
//     按钮不会在刚打开的文件上误导「有可撤销」）
// app.js 顶层不静态 import CM6（audit P2-9），按钮接线测不到这里，
// 语义正确性全部收敛在本文件的 MarkdownEditor 方法层。

// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest';
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

// 模拟一次用户输入（独立 history 事件：userEvent 不同不会被 newGroupDelay 合并）
function type(editor, text) {
  editor.view.dispatch({
    changes: { from: editor.view.state.doc.length, insert: text },
    userEvent: 'input.type',
  });
}

describe('MarkdownEditor 撤销/重做门面（2026-10）', () => {
  let editor;

  beforeEach(() => {
    editor = createEditor();
  });

  it('view 未创建（还没 loadFile）→ canUndo / canRedo 均 false，undo/redo 返回 false', () => {
    expect(editor.canUndo()).toBe(false);
    expect(editor.canRedo()).toBe(false);
    expect(editor.undo()).toBe(false);
    expect(editor.redo()).toBe(false);
  });

  it('首次 loadFile 后（fresh view）→ 无可撤无可重做', () => {
    editor.loadFile({ path: '/a.md', name: 'a.md' }, 'hello');
    expect(editor.canUndo()).toBe(false);
    expect(editor.canRedo()).toBe(false);
  });

  it('输入 → canUndo true；undo() 回退 doc 且 canRedo true；redo() 再前滚', () => {
    editor.loadFile({ path: '/a.md', name: 'a.md' }, 'hello');
    type(editor, ' world');
    expect(editor.view.state.doc.toString()).toBe('hello world');
    expect(editor.canUndo()).toBe(true);
    expect(editor.canRedo()).toBe(false);

    expect(editor.undo()).toBe(true);
    expect(editor.view.state.doc.toString()).toBe('hello');
    expect(editor.canUndo()).toBe(false);
    expect(editor.canRedo()).toBe(true);

    expect(editor.redo()).toBe(true);
    expect(editor.view.state.doc.toString()).toBe('hello world');
    expect(editor.canRedo()).toBe(false);
  });

  it('历史耗尽时 undo 空操作返回 false，不吞事件', () => {
    editor.loadFile({ path: '/a.md', name: 'a.md' }, 'x');
    expect(editor.undo()).toBe(false);
    expect(editor.view.state.doc.toString()).toBe('x');
  });

  it('切文件（复用 view）→ 前一文件的编辑记录被清空，doc 是新文件内容', () => {
    editor.loadFile({ path: '/a.md', name: 'a.md' }, 'AAA');
    type(editor, '!'); // A 有可撤的一步
    expect(editor.canUndo()).toBe(true);

    editor.loadFile({ path: '/b.md', name: 'b.md' }, 'BBB');
    expect(editor.view.state.doc.toString()).toBe('BBB');
    // 关键断言：不能把 A 的编辑 history 带进 B（否则 ↶ 在新文件上亮着，
    // 按下去会退回 A 的内容 —— 旧实现的跨文件撤销 bug）
    expect(editor.canUndo()).toBe(false);
    expect(editor.canRedo()).toBe(false);
  });

  it('切文件后在新文件里编辑 → 撤销只回到新文件初始内容', () => {
    editor.loadFile({ path: '/a.md', name: 'a.md' }, 'AAA');
    type(editor, '!!!');
    editor.loadFile({ path: '/b.md', name: 'b.md' }, 'BBB');
    type(editor, '?');
    editor.undo();
    expect(editor.view.state.doc.toString()).toBe('BBB');
  });

  it('loadFile 切文件不触发 onChange（setState 非 transaction，不 fire updateListener）', () => {
    // 2026-10 语义变更：旧实现「dispatch 替换 doc」每次切文件都会伪报一次
    // onChange（触发多余的 live preview / auto-save 空转）。setState 重建 state
    // 不派发事务 → onChange 不跑；脏态复位由 openFile 尾部显式完成。
    const onChange = vi.fn();
    const el = document.createElement('div');
    document.body.appendChild(el);
    const ed = new MarkdownEditor({ element: el, onChange, onSave: vi.fn() });
    ed.loadFile({ path: '/a.md', name: 'a.md' }, 'AAA'); // 首次建 view：0 次
    ed.loadFile({ path: '/b.md', name: 'b.md' }, 'BBB'); // setState 复用：0 次
    expect(onChange).not.toHaveBeenCalled();
  });
});
