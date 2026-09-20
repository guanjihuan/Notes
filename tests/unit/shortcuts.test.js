// src/shortcuts.js 测试
//
// 覆盖：
//   - 8 个全局快捷键派发到对应 handler
//   - 编辑器内（.cm-editor 内部）让位给 CM6（Ctrl+F / Ctrl+S / Ctrl+Shift+A）
//   - 模态打开时吞掉特定快捷键（避免抢焦点 / 顶替 dialog）
//   - Esc 在搜索框内 → 清空搜索
//   - non-modifier 按键不触发
//
// 用 jsdom 模拟 document.addEventListener('keydown')。
// modal-stack 用真实模块（之前 modal.test.js 已验证行为稳定）。

/* @vitest-environment jsdom */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mountKeyboardShortcuts } from '../../src/shortcuts.js';
import { mountModal } from '../../src/modal.js';
import { isOpen as modalIsOpen } from '../../src/modal-stack.js';

function fireKey(opts) {
  // 默认值：Ctrl 修饰，target = document.body
  const init = {
    key: 'f',
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
    ...opts,
  };
  const target = opts.target || document.body;
  const ev = new KeyboardEvent('keydown', init);
  target.dispatchEvent(ev);
  return ev;
}

describe('shortcuts 基本派发', () => {
  let handlers;
  let detach;

  beforeEach(() => {
    document.body.innerHTML = '<input id="search-input" />';
    handlers = {
      onFocusSearch: vi.fn(),
      onClearSearch: vi.fn(),
      onSettings: vi.fn(),
      onToggleTheme: vi.fn(),
      onSave: vi.fn(),
      onToggleEditorMode: vi.fn(),
      onNewFile: vi.fn(),
      onToggleFocusMode: vi.fn(),
      onToggleAi: vi.fn(),
      onReload: vi.fn(),
      onCloseFile: vi.fn(),
    };
    detach = mountKeyboardShortcuts(handlers);
  });

  afterEach(() => {
    if (typeof detach === 'function') detach();
  });

  it('Ctrl+F → onFocusSearch（不在编辑器内）', () => {
    fireKey({ key: 'f', ctrlKey: true });
    expect(handlers.onFocusSearch).toHaveBeenCalledTimes(1);
    expect(handlers.onFocusSearch.mock.invocationCallOrder[0])
      .toBeLessThan(Number.MAX_SAFE_INTEGER);
  });

  it('Ctrl+, → onSettings', () => {
    fireKey({ key: ',', ctrlKey: true });
    expect(handlers.onSettings).toHaveBeenCalledTimes(1);
  });

  it('Ctrl+Shift+T → onToggleTheme', () => {
    fireKey({ key: 'T', ctrlKey: true, shiftKey: true });
    expect(handlers.onToggleTheme).toHaveBeenCalledTimes(1);
    fireKey({ key: 't', ctrlKey: true, shiftKey: true });
    expect(handlers.onToggleTheme).toHaveBeenCalledTimes(2);
  });

  it('Ctrl+S → onSave（非编辑器内）', () => {
    fireKey({ key: 's', ctrlKey: true });
    expect(handlers.onSave).toHaveBeenCalledTimes(1);
  });

  it('Ctrl+E → onToggleEditorMode', () => {
    fireKey({ key: 'e', ctrlKey: true });
    expect(handlers.onToggleEditorMode).toHaveBeenCalledTimes(1);
  });

  it('Ctrl+N → onNewFile', () => {
    fireKey({ key: 'n', ctrlKey: true });
    expect(handlers.onNewFile).toHaveBeenCalledTimes(1);
  });

  it('Ctrl+Shift+F → onToggleFocusMode', () => {
    fireKey({ key: 'F', ctrlKey: true, shiftKey: true });
    expect(handlers.onToggleFocusMode).toHaveBeenCalledTimes(1);
  });

  it('Ctrl+Shift+A → onToggleAi', () => {
    fireKey({ key: 'A', ctrlKey: true, shiftKey: true });
    expect(handlers.onToggleAi).toHaveBeenCalledTimes(1);
  });

  // audit K1-H3：README 提到 Ctrl+R 重新加载界面但之前未注册。
  // 补：注册到 onReload handler（与主菜单 reload 同源）。
  it('Ctrl+R → onReload', () => {
    fireKey({ key: 'r', ctrlKey: true });
    expect(handlers.onReload).toHaveBeenCalledTimes(1);
    // 大写 R 也应命中（Shift 不会被按，但 key.toLowerCase() 仍可工作）
    fireKey({ key: 'R', ctrlKey: true });
    expect(handlers.onReload).toHaveBeenCalledTimes(2);
  });

  // 关闭当前文件：Ctrl+W。无文件时调 onCloseFile 也安全 —— app.js 的
  // closeCurrentFile() 内部对 !state.currentFile 直接 return，handler 失活无副作用。
  it('Ctrl+W → onCloseFile', () => {
    fireKey({ key: 'w', ctrlKey: true });
    expect(handlers.onCloseFile).toHaveBeenCalledTimes(1);
    fireKey({ key: 'W', ctrlKey: true });
    expect(handlers.onCloseFile).toHaveBeenCalledTimes(2);
  });

  it('Ctrl+W 必须 preventDefault（防止 Electron 默认关闭 BrowserWindow）', () => {
    const ev = fireKey({ key: 'w', ctrlKey: true });
    expect(ev.defaultPrevented).toBe(true);
  });

  it('Ctrl+Shift+W / Ctrl+Alt+W 不应触发 onCloseFile（避免误触）', () => {
    fireKey({ key: 'w', ctrlKey: true, shiftKey: true });
    fireKey({ key: 'w', ctrlKey: true, altKey: true });
    expect(handlers.onCloseFile).not.toHaveBeenCalled();
  });

  it('非修饰键 → 不触发任何 handler', () => {
    fireKey({ key: 'a', ctrlKey: false, metaKey: false });
    for (const [name, fn] of Object.entries(handlers)) {
      expect(fn, name).not.toHaveBeenCalled();
    }
  });

  it('Cmd+F（macOS） → onFocusSearch（metaKey 视为 ctrl）', () => {
    fireKey({ key: 'f', ctrlKey: false, metaKey: true });
    expect(handlers.onFocusSearch).toHaveBeenCalledTimes(1);
  });
});

describe('shortcuts 编辑器内让位', () => {
  let handlers;

  beforeEach(() => {
    // 构造编辑器内部 DOM：.cm-editor 容器包裹 .cm-content
    document.body.innerHTML = `
      <div class="cm-editor">
        <div class="cm-content" contenteditable="true">hello world</div>
      </div>
    `;
    handlers = {
      onFocusSearch: vi.fn(),
      onSave: vi.fn(),
      onToggleAi: vi.fn(),
      onSettings: vi.fn(),
      onToggleEditorMode: vi.fn(),
    };
    mountKeyboardShortcuts(handlers);
  });

  it('Ctrl+F 在编辑器内 → 不抢焦点（让位 CM6 搜索面板）', () => {
    const cm = document.querySelector('.cm-content');
    fireKey({ key: 'f', ctrlKey: true, target: cm });
    expect(handlers.onFocusSearch).not.toHaveBeenCalled();
  });

  it('Ctrl+S 在编辑器内 → 不触发 onSave（CM6 已 save）', () => {
    const cm = document.querySelector('.cm-content');
    fireKey({ key: 's', ctrlKey: true, target: cm });
    expect(handlers.onSave).not.toHaveBeenCalled();
  });

  it('Ctrl+Shift+A 在编辑器内 → 不抢（Shift+A 在编辑器里有内置语义）', () => {
    const cm = document.querySelector('.cm-content');
    fireKey({ key: 'A', ctrlKey: true, shiftKey: true, target: cm });
    expect(handlers.onToggleAi).not.toHaveBeenCalled();
  });

  it('Ctrl+E 在编辑器内 → 仍然生效（CM6 未占用）', () => {
    const cm = document.querySelector('.cm-content');
    fireKey({ key: 'e', ctrlKey: true, target: cm });
    expect(handlers.onToggleEditorMode).toHaveBeenCalledTimes(1);
  });
});

describe('shortcuts 模态打开时吞键', () => {
  let handlers;

  beforeEach(() => {
    document.body.innerHTML = `
      <div id="modal-root"></div>
      <input id="search-input" />
    `;
    handlers = {
      onFocusSearch: vi.fn(),
      onSettings: vi.fn(),
      onToggleTheme: vi.fn(),
      onToggleEditorMode: vi.fn(),
      onNewFile: vi.fn(),
      onToggleFocusMode: vi.fn(),
      onToggleAi: vi.fn(),
      onSave: vi.fn(),
    };
    mountKeyboardShortcuts(handlers);
  });

  afterEach(() => {
    // 关闭所有可能残留的 modal
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    document.body.innerHTML = '';
  });

  it('模态打开时 Ctrl+, → 不打开设置（避免顶替当前 dialog）', () => {
    mountModal({ title: 'mock-modal', body: '<p>x</p>' });
    expect(modalIsOpen()).toBe(true);

    fireKey({ key: ',', ctrlKey: true });
    expect(handlers.onSettings).not.toHaveBeenCalled();
  });

  it('模态打开时 Ctrl+F → 不抢焦点', () => {
    mountModal({ title: 'mock-modal', body: '<p>x</p>' });
    fireKey({ key: 'f', ctrlKey: true });
    expect(handlers.onFocusSearch).not.toHaveBeenCalled();
  });

  it('模态打开时 Ctrl+Shift+T → 不切主题', () => {
    mountModal({ title: 'mock-modal', body: '<p>x</p>' });
    fireKey({ key: 'T', ctrlKey: true, shiftKey: true });
    expect(handlers.onToggleTheme).not.toHaveBeenCalled();
  });

  it('模态打开时 Ctrl+Shift+A → 不切 AI dock', () => {
    mountModal({ title: 'mock-modal', body: '<p>x</p>' });
    fireKey({ key: 'A', ctrlKey: true, shiftKey: true });
    expect(handlers.onToggleAi).not.toHaveBeenCalled();
  });

  it('模态打开时 Ctrl+S 仍允许（与编辑器保存一致）', () => {
    // 验证「Ctrl+S 在模态内不禁用」这条契约；具体走哪个分支不重要，
    // 关键是 onSave 仍会被调用（设置对话框 / 文件新建 dialog 关闭时不丢改动）。
    mountModal({ title: 'mock-modal', body: '<p>x</p>' });
    fireKey({ key: 's', ctrlKey: true });
    expect(handlers.onSave).toHaveBeenCalledTimes(1);
  });
});

describe('shortcuts Esc 清空搜索', () => {
  let handlers;

  beforeEach(() => {
    document.body.innerHTML = '<input id="search-input" />';
    handlers = {
      onClearSearch: vi.fn(),
      onFocusSearch: vi.fn(),
    };
    mountKeyboardShortcuts(handlers);
  });

  it('焦点在 search-input 时按 Esc → onClearSearch', () => {
    const input = document.getElementById('search-input');
    input.focus();
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(handlers.onClearSearch).toHaveBeenCalledTimes(1);
  });

  it('焦点不在搜索框时按 Esc → 不触发 onClearSearch', () => {
    document.body.focus();
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(handlers.onClearSearch).not.toHaveBeenCalled();
  });
});

describe('shortcuts handler 缺失时静默', () => {
  it('不传 onSettings 也不应抛错', () => {
    document.body.innerHTML = '';
    mountKeyboardShortcuts({}); // 全空
    expect(() => {
      fireKey({ key: ',', ctrlKey: true });
      fireKey({ key: 'f', ctrlKey: true });
      fireKey({ key: 'T', ctrlKey: true, shiftKey: true });
      fireKey({ key: 'F', ctrlKey: true, shiftKey: true });
      fireKey({ key: 's', ctrlKey: true });
      fireKey({ key: 'e', ctrlKey: true });
      fireKey({ key: 'n', ctrlKey: true });
      fireKey({ key: 'O', ctrlKey: true, shiftKey: true });
      fireKey({ key: 'A', ctrlKey: true, shiftKey: true });
      fireKey({ key: 'w', ctrlKey: true });
    }).not.toThrow();
  });
});

describe('shortcuts IME 合成期间（C3 audit）', () => {
  let handlers;
  let detach;

  beforeEach(() => {
    document.body.innerHTML = '';
    handlers = {
      onToggleEditorMode: vi.fn(),
      onNewFile: vi.fn(),
      onFocusSearch: vi.fn(),
      onSave: vi.fn(),
    };
    detach = mountKeyboardShortcuts(handlers);
  });

  afterEach(() => {
    if (detach && typeof detach.dispose === 'function') detach.dispose();
  });

  it('isComposing=true 时 Ctrl+E 不触发 onToggleEditorMode（CJK 拼音中途保护）', () => {
    fireKey({ key: 'e', ctrlKey: true, isComposing: true });
    expect(handlers.onToggleEditorMode).not.toHaveBeenCalled();
  });

  it('keyCode=229（Firefox / 旧 Chromium）时 Ctrl+N 不触发 onNewFile', () => {
    fireKey({ key: 'n', ctrlKey: true, keyCode: 229 });
    expect(handlers.onNewFile).not.toHaveBeenCalled();
  });

  it('isComposing=true 时 Ctrl+F 也不抢焦点', () => {
    fireKey({ key: 'f', ctrlKey: true, isComposing: true });
    expect(handlers.onFocusSearch).not.toHaveBeenCalled();
  });

  it('isComposing=false 时（正常组合键）行为不变', () => {
    fireKey({ key: 'e', ctrlKey: true, isComposing: false });
    expect(handlers.onToggleEditorMode).toHaveBeenCalledTimes(1);
  });

  // Ctrl+W 在 IME 合成期也应被吞：用户在 CJK 拼音中途按 Ctrl+W 不应该
  // 立即关文件，IME buffer 还在编辑器里。
  it('isComposing=true 时 Ctrl+W 不触发 onCloseFile', () => {
    const handlers2 = { onCloseFile: vi.fn() };
    const detach2 = mountKeyboardShortcuts(handlers2);
    try {
      fireKey({ key: 'w', ctrlKey: true, isComposing: true });
      expect(handlers2.onCloseFile).not.toHaveBeenCalled();
    } finally {
      detach2();
    }
  });
});

describe('shortcuts 模态打开时 Ctrl+W 抑制（M1 audit）', () => {
  let handlers;
  let detach;
  let modalApi;

  beforeEach(() => {
    document.body.innerHTML = '<div id="modal-root"></div>';
    handlers = { onSettings: vi.fn() };
    detach = mountKeyboardShortcuts(handlers);
    // 模拟有模态打开
    modalApi = mountModal({ title: 't', body: '', footer: '', onBackdropClose: 'cancel' });
  });

  afterEach(() => {
    if (detach && typeof detach.dispose === 'function') detach.dispose();
    if (modalApi) modalApi.close('test-cleanup');
  });

  it('模态打开时 Ctrl+W 不触发默认行为（preventDefault）', () => {
    const ev = fireKey({ key: 'w', ctrlKey: true });
    expect(ev.defaultPrevented).toBe(true);
  });

  it('模态未开时 Ctrl+W 仍 preventDefault（挡 Electron 关窗口），但不在 SUPPRESS 列表里', () => {
    if (modalApi) modalApi.close('test-no-modal');
    modalApi = null;
    const closeHandler = vi.fn();
    const detachNoModal = mountKeyboardShortcuts({ onCloseFile: closeHandler });
    const ev = fireKey({ key: 'w', ctrlKey: true });
    // Ctrl+W 必须 preventDefault：否则 Electron 默认行为是直接关 BrowserWindow，
    // 整个应用被干掉，与"关闭当前文件"语义不符。这是 2026-09 设计优化引入
    // 的新行为（之前测试期望 defaultPrevented=false 是旧语义）。
    expect(ev.defaultPrevented).toBe(true);
    expect(closeHandler).toHaveBeenCalled();
    if (detachNoModal && typeof detachNoModal.dispose === 'function') detachNoModal.dispose();
  });
});

describe('shortcuts dispose（Phase O-M2 audit）', () => {
  it('mountKeyboardShortcuts 返回的 dispose 函数能 removeEventListener', () => {
    document.body.innerHTML = '<input id="search-input" />';
    const handler1 = vi.fn();
    const detach1 = mountKeyboardShortcuts({
      onSettings: handler1,
    });
    expect(typeof detach1).toBe('function');
    // 销毁第一个 mount
    detach1();
    // 再 mount 第二个
    const handler2 = vi.fn();
    const detach2 = mountKeyboardShortcuts({
      onSettings: handler2,
    });
    // 触发 Ctrl+,
    fireKey({ key: ',', ctrlKey: true });
    // 旧 handler 已经被 dispose → 不应被调用
    expect(handler1).not.toHaveBeenCalled();
    // 新 handler 应当被调用
    expect(handler2).toHaveBeenCalledTimes(1);
    detach2();
  });
});