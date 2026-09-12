// Stage 7+: prompt-dialog.js
//
// 覆盖：
//   - 挂载后渲染 input + 两个按钮（cancel/confirm）+ label
//   - 点 Confirm → resolve(input.value)，包含空格原样返回
//   - 点 Cancel → resolve(null)
//   - Esc / × 按钮 / 点 overlay 背景 → resolve(null)（onBackdropClose='cancel'）
//   - Enter 键（在 input 内） → resolve(input.value)
//   - input 引用丢失的极端兜底 → resolve(null)，不挂死
//   - 默认文本 selectAllOnOpen=true 时选中（默认行为）
//   - 默认文本 selectAllOnOpen=false 时不选中
//   - 用户自定义 confirmLabel / cancelLabel / placeholder 写入 DOM
//   - #modal-root 缺失 → resolve(null)
//   - 已有 modal 占位 → resolve(null)（单槽冲突）
//   - 无 title 参数 → resolve(null)（兜底，不挂死）
//
// 需要 DOM：jsdom 环境。

// @vitest-environment jsdom

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { showPromptDialog } from '../../src/prompt-dialog.js';
import { isOpen as modalIsOpen } from '../../src/modal-stack.js';

beforeEach(() => {
  document.body.innerHTML = '<div id="modal-root"></div>';
});

afterEach(() => {
  // 兜底：派发 Esc，让任何漏关的 modal 收掉
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  document.body.innerHTML = '';
});

/**
 * 等待 queueMicrotask + 一帧渲染（focus / .select() 都依赖异步）
 */
function flushMicrotasks() {
  return new Promise((resolve) => {
    queueMicrotask(() => queueMicrotask(resolve));
  });
}

describe('showPromptDialog 基本结构', () => {
  it('挂载后渲染 input + 两个按钮', async () => {
    const promise = showPromptDialog({ title: '新建笔记' });

    const input = document.getElementById('prompt-dialog-input');
    expect(input).not.toBeNull();
    expect(input.tagName).toBe('INPUT');
    expect(input.type).toBe('text');

    const buttons = document.querySelectorAll('.modal-footer .btn');
    expect(buttons.length).toBe(2);
    const actions = Array.from(buttons).map((b) => b.dataset.action);
    expect(actions).toContain('cancel');
    expect(actions).toContain('confirm');

    // 清理
    document.querySelector('.modal-overlay').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await promise;
  });

  it('label 关联到 input（for 属性匹配 id）', async () => {
    const promise = showPromptDialog({ title: '重命名', inputLabel: '新文件名' });

    const label = document.querySelector('.modal-body .form-label');
    expect(label).not.toBeNull();
    expect(label.getAttribute('for')).toBe('prompt-dialog-input');
    expect(label.textContent).toBe('新文件名');

    document.querySelector('.modal-overlay').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await promise;
  });

  it('inputLabel 缺省时退化为 title', async () => {
    const promise = showPromptDialog({ title: '我的标题' });

    const label = document.querySelector('.modal-body .form-label');
    expect(label.textContent).toBe('我的标题');

    document.querySelector('.modal-overlay').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await promise;
  });

  it('用户自定义 confirmLabel / cancelLabel / placeholder 写入 DOM', async () => {
    const promise = showPromptDialog({
      title: 't',
      confirmLabel: '好的',
      cancelLabel: '不要',
      placeholder: '请输入文件名',
    });

    const input = document.getElementById('prompt-dialog-input');
    expect(input.getAttribute('placeholder')).toBe('请输入文件名');

    const buttons = document.querySelectorAll('.modal-footer .btn');
    const labels = Array.from(buttons).map((b) => b.textContent.trim());
    expect(labels).toContain('好的');
    expect(labels).toContain('不要');

    document.querySelector('.modal-overlay').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await promise;
  });

  it('message 缺省不渲染 <p.conf-message>', async () => {
    const promise = showPromptDialog({ title: 'no-msg' });

    expect(document.querySelector('.confirm-message')).toBeNull();

    document.querySelector('.modal-overlay').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await promise;
  });

  it('title / message / label 的 HTML 特殊字符被转义（防止 XSS）', async () => {
    const promise = showPromptDialog({
      title: '<img src=x>',
      message: '<script>alert(1)</script>',
      inputLabel: '"><b>x</b>',
    });

    const overlay = document.querySelector('.modal-overlay');
    expect(overlay.innerHTML).not.toContain('<img src=x>');
    expect(overlay.innerHTML).not.toContain('<script>alert(1)</script>');
    // 转义后保留字面字符
    expect(overlay.textContent).toContain('<img src=x>');
    expect(overlay.textContent).toContain('<script>alert(1)</script>');

    overlay.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await promise;
  });
});

describe('showPromptDialog 关闭路径', () => {
  it('点 Confirm → resolve(input.value)，含空格原样返回', async () => {
    const promise = showPromptDialog({ title: 't', defaultValue: '默认' });

    const input = document.getElementById('prompt-dialog-input');
    input.value = '  hello world  ';

    const confirmBtn = document.querySelector('.modal-footer .btn[data-action="confirm"]');
    confirmBtn.click();

    await expect(promise).resolves.toBe('  hello world  ');
    expect(modalIsOpen()).toBe(false);
  });

  it('点 Cancel → resolve(null)', async () => {
    const promise = showPromptDialog({ title: 't', defaultValue: '默认值' });

    const cancelBtn = document.querySelector('.modal-footer .btn[data-action="cancel"]');
    cancelBtn.click();

    await expect(promise).resolves.toBeNull();
    expect(modalIsOpen()).toBe(false);
  });

  it('按 Esc → resolve(null)（onBackdropClose=cancel）', async () => {
    const promise = showPromptDialog({ title: 't', defaultValue: 'x' });

    const overlay = document.querySelector('.modal-overlay');
    overlay.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    await expect(promise).resolves.toBeNull();
  });

  it('点 × 按钮 → resolve(null)', async () => {
    const promise = showPromptDialog({ title: 't' });

    document.querySelector('.modal-close').click();

    await expect(promise).resolves.toBeNull();
  });

  it('点 overlay 背景 → resolve(null)', async () => {
    const promise = showPromptDialog({ title: 't' });

    const overlay = document.querySelector('.modal-overlay');
    overlay.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    await expect(promise).resolves.toBeNull();
  });

  it('Enter 键（在 input 内） → resolve(input.value)，modal 关闭', async () => {
    const promise = showPromptDialog({ title: 't', defaultValue: 'old' });

    const input = document.getElementById('prompt-dialog-input');
    input.value = 'new name';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));

    await expect(promise).resolves.toBe('new name');
    expect(modalIsOpen()).toBe(false);
  });

  it('Enter 键被 preventDefault（不触发任何潜在 form submit）', async () => {
    const promise = showPromptDialog({ title: 't' });
    const input = document.getElementById('prompt-dialog-input');
    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    input.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);

    await promise;
  });

  it('关闭后 overlay 已从 DOM 移除', async () => {
    const promise = showPromptDialog({ title: 't' });
    expect(document.querySelector('.modal-overlay')).not.toBeNull();

    document.querySelector('.modal-overlay').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    await promise;
    expect(document.querySelector('.modal-overlay')).toBeNull();
  });
});

describe('showPromptDialog 默认值 / 全选', () => {
  it('defaultValue 写入 input.value', async () => {
    const promise = showPromptDialog({ title: 't', defaultValue: '未命名-2026' });

    const input = document.getElementById('prompt-dialog-input');
    expect(input.value).toBe('未命名-2026');

    document.querySelector('.modal-overlay').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await promise;
  });

  it('selectAllOnOpen=true（默认）+ defaultValue 非空 → 打开后选中', async () => {
    const promise = showPromptDialog({ title: 't', defaultValue: '选中我' });

    await flushMicrotasks();
    const input = document.getElementById('prompt-dialog-input');
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe('选中我'.length);

    document.querySelector('.modal-overlay').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await promise;
  });

  it('selectAllOnOpen=false → 不全选', async () => {
    const promise = showPromptDialog({
      title: 't',
      defaultValue: '保持光标',
      selectAllOnOpen: false,
    });

    await flushMicrotasks();
    const input = document.getElementById('prompt-dialog-input');
    // selectionStart === selectionEnd 表示无选中（光标在末尾）
    expect(input.selectionStart).toBe(input.selectionEnd);

    document.querySelector('.modal-overlay').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await promise;
  });
});

describe('showPromptDialog validate 选项', () => {
  it('validate 返回字符串 → 显示行内错误、dialog 保持打开', async () => {
    let calls = 0;
    const promise = showPromptDialog({
      title: '重命名',
      defaultValue: 'old.md',
      validate: (raw) => {
        calls += 1;
        if (raw.includes('/')) return '不能包含 /';
        return null;
      },
    });
    await flushMicrotasks();

    const input = document.getElementById('prompt-dialog-input');
    const errorEl = document.getElementById('prompt-dialog-error');

    // 改成非法值 → 点确认
    input.value = 'foo/bar.md';
    const confirmBtn = document.querySelector('.modal-footer .btn[data-action="confirm"]');
    confirmBtn.click();
    await flushMicrotasks();

    // validate 调用了；错误显示；modal 仍在；promise 没 resolve
    expect(calls).toBeGreaterThanOrEqual(1);
    expect(errorEl.hidden).toBe(false);
    expect(errorEl.textContent).toBe('不能包含 /');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.classList.contains('is-invalid')).toBe(true);
    expect(modalIsOpen()).toBe(true);

    // 改成合法值 → input 事件清错误
    input.value = 'foo-bar.md';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(errorEl.hidden).toBe(true);
    expect(input.hasAttribute('aria-invalid')).toBe(false);

    // 再次确认 → 通过 → resolve
    confirmBtn.click();
    await expect(promise).resolves.toBe('foo-bar.md');
  });

  it('validate 抛错 → 错误消息被当作 validate 返回值展示', async () => {
    const promise = showPromptDialog({
      title: 't',
      validate: () => { throw new Error('check failed'); },
    });
    await flushMicrotasks();

    const errorEl = document.getElementById('prompt-dialog-error');
    document.querySelector('.modal-footer .btn[data-action="confirm"]').click();
    await flushMicrotasks();

    expect(errorEl.hidden).toBe(false);
    expect(errorEl.textContent).toBe('check failed');
    expect(modalIsOpen()).toBe(true);

    document.querySelector('.modal-overlay').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await expect(promise).resolves.toBeNull();
  });

  it('validate 不传 → 行为不变（向后兼容）', async () => {
    const promise = showPromptDialog({ title: 't', defaultValue: 'ok' });

    document.querySelector('.modal-footer .btn[data-action="confirm"]').click();

    await expect(promise).resolves.toBe('ok');
  });

  // audit fix (Phase L1-Settings P1)：Enter 键必须与按钮 click 走完全同一条
  // validate 路径。早期实现 Enter 直接 modal.close('confirm') 跳过校验 → 用户
  // 重命名输入非法名按 Enter → dialog 静默关闭 → typed text 丢失、错误仅通过
  // 通用 toast 模糊暴露。
  it('Enter 键 + validate 失败 → dialog 保持打开、行内错误显示', async () => {
    let calls = 0;
    const promise = showPromptDialog({
      title: '重命名',
      defaultValue: 'old.md',
      validate: (raw) => {
        calls += 1;
        if (raw.includes('/')) return '不能包含 /';
        return null;
      },
    });
    await flushMicrotasks();

    const input = document.getElementById('prompt-dialog-input');
    const errorEl = document.getElementById('prompt-dialog-error');

    // 改成非法值，按 Enter —— 之前会跳过 validate 直接关 dialog
    input.value = 'foo/bar.md';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await flushMicrotasks();

    expect(calls).toBeGreaterThanOrEqual(1);
    expect(errorEl.hidden).toBe(false);
    expect(errorEl.textContent).toBe('不能包含 /');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(modalIsOpen()).toBe(true);
    // promise 还没 resolve
    let resolved = false;
    promise.then(() => { resolved = true; });
    await flushMicrotasks();
    expect(resolved).toBe(false);

    // 改成合法值按 Enter → 通过 → resolve
    input.value = 'foo-bar.md';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));

    await expect(promise).resolves.toBe('foo-bar.md');
  });

  it('Enter 键 + 无 validate → 行为不变（向后兼容）', async () => {
    const promise = showPromptDialog({ title: 't', defaultValue: 'ok' });

    const input = document.getElementById('prompt-dialog-input');
    input.value = 'changed';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));

    await expect(promise).resolves.toBe('changed');
  });
});

describe('showPromptDialog 退化路径', () => {
  it('#modal-root 缺失 → resolve(null)，不挂死', async () => {
    document.body.innerHTML = '';   // 干掉 #modal-root

    const promise = showPromptDialog({ title: 't', defaultValue: 'd' });

    await expect(promise).resolves.toBeNull();
  });

  it('已有 modal 占位 → resolve(null)（与 mountModal 单槽冲突一致）', async () => {
    // 第一个 modal 占住 #modal-root
    const first = showPromptDialog({ title: 'first' });
    // 第二个开不起来
    const second = showPromptDialog({ title: 'second' });

    await expect(second).resolves.toBeNull();

    // 收掉第一个
    document.querySelector('.modal-overlay').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await first;
  });

  it('无 title 参数 → 立即 resolve(null)，不挂死', async () => {
    const promise = showPromptDialog();

    await expect(promise).resolves.toBeNull();
    expect(modalIsOpen()).toBe(false);
  });
});

describe('showPromptDialog Promise resolve 幂等性', () => {
  it('close 后多次 resolve 不抛错（Promise resolve 是幂等的）', async () => {
    const promise = showPromptDialog({ title: 't' });

    const overlay = document.querySelector('.modal-overlay');
    overlay.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    // 再次尝试关 —— close 内部有 closed 保护
    const modalCtrl = document.getElementById('modal-root').firstChild;
    // 第一次关闭后 overlay 已经从 DOM 移除；这里只确保 promise 不抛
    await expect(promise).resolves.toBeNull();
  });
});