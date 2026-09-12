// src/editor-toolbar.js
//
// 三态（preview / edit / split）视图模式控件：图标按钮 + aria-pressed +
// body.dataset.editorMode（CSS 据此切布局）。构造函数绑 click → selectMode。
//
// 测试覆盖：
//   - selectMode 合法值：触发 onChange + DOM 更新 + aria-pressed 切换
//   - selectMode 非法值：被静默忽略（不抛、不触发 onChange、不动 DOM）
//   - selectMode 同模式：no-op（不重复触发 onChange）
//   - setMode：同步 DOM 但不触发 onChange（用于外部「持久化设置改了」
//     反向同步 UI，避免循环触发）
//   - getMode：从 body.dataset.editorMode 读，默认 'preview'
//   - cycle：preview → edit → split → preview（不依赖 setMode 路径，
//     走 selectMode 路径所以每次都触发 onChange）
//   - a11y：每个按钮都拿到 aria-pressed（不仅 active 那个）；不依赖按钮
//     缺省时整个 component 仍能工作（按钮可选）

// @vitest-environment jsdom

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EditorToolbar, EDITOR_MODES } from '../../src/editor-toolbar.js';

function makeBtn() {
  const btn = document.createElement('button');
  btn.type = 'button';
  return btn;
}

function setupDOM(initialMode = null) {
  document.body.innerHTML = '';
  if (initialMode === null) {
    delete document.body.dataset.editorMode;
  } else {
    document.body.dataset.editorMode = initialMode;
  }
  const btnPreview = makeBtn();
  const btnEdit = makeBtn();
  const btnSplit = makeBtn();
  document.body.append(btnPreview, btnEdit, btnSplit);
  return { btnPreview, btnEdit, btnSplit };
}

describe('EditorToolbar 构造 + 事件绑定', () => {
  it('按钮 click → selectMode(对应 mode) + onChange', () => {
    // 起始 'split' —— 不与任何一个按钮 mode 重合，确保 click 都触发 onChange
    const els = setupDOM('split');
    const onChange = vi.fn();
    new EditorToolbar({ elements: els, onChange });

    els.btnPreview.click();
    expect(onChange).toHaveBeenCalledWith('preview');
    onChange.mockClear();

    els.btnEdit.click();
    expect(onChange).toHaveBeenCalledWith('edit');
    onChange.mockClear();

    els.btnSplit.click();
    expect(onChange).toHaveBeenCalledWith('split');
  });

  it('缺按钮：对应 click 不绑、构造不抛', () => {
    const els = setupDOM();
    const onChange = vi.fn();
    // 只给 btnEdit，btnPreview / btnSplit 缺
    const partial = { btnEdit: els.btnEdit };
    expect(() => new EditorToolbar({ elements: partial, onChange })).not.toThrow();

    els.btnEdit.click();
    expect(onChange).toHaveBeenCalledWith('edit');
    // 缺按钮的 click 不应触发 selectMode（没绑事件）
    els.btnPreview.click();
    // onChange 仍只被调用 1 次（来自 btnEdit 这次）
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});

describe('EditorToolbar.selectMode', () => {
  it('合法值：更新 body.dataset.editorMode + aria-pressed + is-active class', () => {
    const els = setupDOM();
    const tb = new EditorToolbar({ elements: els, onChange: vi.fn() });

    tb.selectMode('edit');

    expect(document.body.dataset.editorMode).toBe('edit');
    expect(els.btnEdit.classList.contains('is-active')).toBe(true);
    expect(els.btnPreview.classList.contains('is-active')).toBe(false);
    expect(els.btnSplit.classList.contains('is-active')).toBe(false);
    expect(els.btnEdit.getAttribute('aria-pressed')).toBe('true');
    expect(els.btnPreview.getAttribute('aria-pressed')).toBe('false');
    expect(els.btnSplit.getAttribute('aria-pressed')).toBe('false');
  });

  it('非法值：被忽略（不抛、不触发 onChange、不动 DOM）', () => {
    const els = setupDOM();
    const onChange = vi.fn();
    const tb = new EditorToolbar({ elements: els, onChange });

    document.body.dataset.editorMode = 'split';

    expect(() => tb.selectMode('wide')).not.toThrow();
    expect(() => tb.selectMode('')).not.toThrow();
    expect(() => tb.selectMode(null)).not.toThrow();
    expect(() => tb.selectMode(undefined)).not.toThrow();

    expect(onChange).not.toHaveBeenCalled();
    expect(document.body.dataset.editorMode).toBe('split');
  });

  it('同模式 → no-op（不重复触发 onChange）', () => {
    const els = setupDOM();
    const onChange = vi.fn();
    const tb = new EditorToolbar({ elements: els, onChange });

    tb.selectMode('edit');
    expect(onChange).toHaveBeenCalledTimes(1);

    tb.selectMode('edit');
    expect(onChange).toHaveBeenCalledTimes(1);

    tb.selectMode('split');
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('无 onChange 回调：不抛', () => {
    const els = setupDOM();
    const tb = new EditorToolbar({ elements: els });
    expect(() => tb.selectMode('split')).not.toThrow();
    expect(document.body.dataset.editorMode).toBe('split');
  });
});

describe('EditorToolbar.setMode（外部同步 UI，不触发 onChange）', () => {
  it('同步 DOM 但不调用 onChange（避免循环）', () => {
    const els = setupDOM();
    const onChange = vi.fn();
    const tb = new EditorToolbar({ elements: els, onChange });

    tb.setMode('split');

    expect(document.body.dataset.editorMode).toBe('split');
    expect(els.btnSplit.classList.contains('is-active')).toBe(true);
    expect(els.btnSplit.getAttribute('aria-pressed')).toBe('true');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('同模式也执行 setDOM（与 selectMode 行为不同）', () => {
    // 用途：外部从持久化设置读了模式，反向同步 UI。即便模式已经是
    // 当前值，仍要走一遍 setDOM 确保 aria-pressed / is-active 状态
    // 是最新的（防止外部代码直接改过 dataset 但 UI 状态没跟上）。
    const els = setupDOM();
    document.body.dataset.editorMode = 'edit';
    els.btnEdit.classList.add('is-active');
    const tb = new EditorToolbar({ elements: els, onChange: vi.fn() });

    tb.setMode('edit');

    // 即使「同模式」，_setDOM 仍走一遍（aria-pressed / is-active 被重写）
    expect(els.btnEdit.getAttribute('aria-pressed')).toBe('true');
    expect(els.btnPreview.getAttribute('aria-pressed')).toBe('false');
  });

  it('非法值：静默忽略', () => {
    const els = setupDOM();
    const tb = new EditorToolbar({ elements: els, onChange: vi.fn() });
    document.body.dataset.editorMode = 'preview';
    tb.setMode('not-a-mode');
    expect(document.body.dataset.editorMode).toBe('preview');
  });
});

describe('EditorToolbar.getMode', () => {
  it('从 body.dataset.editorMode 读', () => {
    const els = setupDOM();
    document.body.dataset.editorMode = 'split';
    const tb = new EditorToolbar({ elements: els, onChange: vi.fn() });
    expect(tb.getMode()).toBe('split');
  });

  it('dataset 未设置：返回默认 "preview"', () => {
    const els = setupDOM();
    delete document.body.dataset.editorMode;
    const tb = new EditorToolbar({ elements: els, onChange: vi.fn() });
    expect(tb.getMode()).toBe('preview');
  });
});

describe('EditorToolbar.cycle', () => {
  it('preview → edit → split → preview，每次都触发 onChange', () => {
    const els = setupDOM();
    const onChange = vi.fn();
    delete document.body.dataset.editorMode;
    const tb = new EditorToolbar({ elements: els, onChange });

    tb.cycle();
    expect(tb.getMode()).toBe('edit');
    expect(onChange).toHaveBeenLastCalledWith('edit');

    tb.cycle();
    expect(tb.getMode()).toBe('split');
    expect(onChange).toHaveBeenLastCalledWith('split');

    tb.cycle();
    expect(tb.getMode()).toBe('preview');
    expect(onChange).toHaveBeenLastCalledWith('preview');

    expect(onChange).toHaveBeenCalledTimes(3);
  });
});

describe('EditorToolbar a11y', () => {
  it('三个按钮都拿到 aria-pressed（不仅 active 那个）', () => {
    // 屏幕阅读器依靠 aria-pressed 判状态；非 active 按钮也要明确
    // 'false' 而不是缺省（缺省时 SR 不知道这是 toggle）。
    // 起始 'edit'，selectMode('preview') 不会因同模式被早退。
    const els = setupDOM('edit');
    const tb = new EditorToolbar({ elements: els, onChange: vi.fn() });

    tb.selectMode('preview');

    expect(els.btnPreview.getAttribute('aria-pressed')).toBe('true');
    expect(els.btnEdit.getAttribute('aria-pressed')).toBe('false');
    expect(els.btnSplit.getAttribute('aria-pressed')).toBe('false');
  });

  it('EDIT_MODES 导出值与内部一致', () => {
    expect(EDITOR_MODES).toEqual(['preview', 'edit', 'split']);
  });
});