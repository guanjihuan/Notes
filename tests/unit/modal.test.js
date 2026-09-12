// Stage 7 tests: modal.js
//
// 覆盖：
//   - mountModal：基本 DOM 结构 / aria 属性
//   - 关闭路径：× 按钮 / Esc 键 / overlay-click 背景 / close(value) 显式
//   - data-action 按钮 → onAction 回调（**只对 footer/× 生效，body 内不拦截**）
//   - 单槽冲突：已开 modal 时再 mount 返回 null
//   - setBody / setFooter 替换内容
//   - setOnClose 接收 close 的 value
//   - #modal-root 缺失时返回 null
//
// 需要 DOM：jsdom 环境。

// @vitest-environment jsdom

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mountModal } from '../../src/modal.js';
import { isOpen as modalIsOpen } from '../../src/modal-stack.js';

beforeEach(() => {
  // 每个测试前清空 #modal-root；保证 modal-stack 状态干净
  document.body.innerHTML = '<div id="modal-root"></div>';
  // 防御：万一上一次测试失败没 unregister
  // modal-stack 的 isOpen 用 currentOverlay.isConnected 校验，DOM 清了后 isOpen() 就 false 了。
  // 不需要手动 unregister。
});

afterEach(() => {
  // 兜底：派发 Esc 给 document，让任何漏关的 modal 收掉
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  document.body.innerHTML = '';
});

function makeModal(opts = {}) {
  return mountModal({
    title: opts.title ?? '测试标题',
    body: opts.body ?? '<p>内容</p>',
    footer: opts.footer ?? '<button class="btn" data-action="ok">确定</button>',
    ...opts,
  });
}

describe('mountModal 基本结构', () => {
  it('#modal-root 缺失 → 返回 null', () => {
    document.body.innerHTML = '';
    const result = mountModal({ title: 'x' });
    expect(result).toBeNull();
  });

  it('挂载后返回 controller 且 overlay 在 DOM 里', () => {
    const modal = makeModal();
    expect(modal).not.toBeNull();
    expect(modal.overlay).toBeInstanceOf(HTMLElement);
    expect(modal.overlay.classList.contains('modal-overlay')).toBe(true);
    expect(document.getElementById('modal-root').contains(modal.overlay)).toBe(true);
  });

  it('设了 ARIA 属性', () => {
    const modal = makeModal({ title: 'aria 测试' });
    expect(modal.overlay.getAttribute('role')).toBe('dialog');
    expect(modal.overlay.getAttribute('aria-modal')).toBe('true');
    const titleId = modal.overlay.getAttribute('aria-labelledby');
    expect(titleId).toBeTruthy();
    // title 元素真有这个 id
    const titleEl = document.getElementById(titleId);
    expect(titleEl).not.toBeNull();
    expect(titleEl.textContent).toBe('aria 测试');
  });

  it('body / footer 内容写入对应容器', () => {
    const modal = makeModal({
      body: '<div class="custom-body">hello</div>',
      footer: '<button class="btn" data-action="cancel">取消</button>',
    });
    expect(modal.body.querySelector('.custom-body').textContent).toBe('hello');
    expect(modal.footer.querySelector('[data-action="cancel"]')).not.toBeNull();
  });
});

describe('mountModal 关闭路径', () => {
  it('close(value) → 从 DOM 移除 + onClose(value) 触发', () => {
    const modal = makeModal();
    const onClose = vi.fn();
    modal.setOnClose(onClose);

    modal.close('ok');

    expect(document.getElementById('modal-root').contains(modal.overlay)).toBe(false);
    expect(modalIsOpen()).toBe(false);
    expect(onClose).toHaveBeenCalledWith('ok');
  });

  it('重复 close 是幂等的', () => {
    const modal = makeModal();
    const onClose = vi.fn();
    modal.setOnClose(onClose);

    modal.close('first');
    modal.close('second');

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith('first');
  });

  it('点 × 按钮 → onBackdropClose 触发关闭', () => {
    const modal = makeModal({ onBackdropClose: 'cancel' });
    const onClose = vi.fn();
    modal.setOnClose(onClose);

    const closeBtn = modal.overlay.querySelector('.modal-close');
    closeBtn.click();

    expect(onClose).toHaveBeenCalledWith('cancel');
    expect(document.getElementById('modal-root').contains(modal.overlay)).toBe(false);
  });

  it('按 Esc → onBackdropClose 触发关闭', () => {
    const modal = makeModal({ onBackdropClose: 'esc-cancel' });
    const onClose = vi.fn();
    modal.setOnClose(onClose);

    modal.overlay.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(onClose).toHaveBeenCalledWith('esc-cancel');
  });

  it('点 overlay 背景（不是 modal 内部） → onBackdropClose', () => {
    const modal = makeModal({ onBackdropClose: 'dismissed' });
    const onClose = vi.fn();
    modal.setOnClose(onClose);

    // 直接派发 click 到 overlay 本身
    modal.overlay.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(onClose).toHaveBeenCalledWith('dismissed');
  });

  it('点 modal 内部（不是 overlay 背景）不关闭', () => {
    const modal = makeModal({ onBackdropClose: 'should-not-fire' });
    const onClose = vi.fn();
    modal.setOnClose(onClose);

    // 点击 modal 内部元素
    const inner = modal.overlay.querySelector('.modal');
    inner.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(onClose).not.toHaveBeenCalled();
    expect(document.getElementById('modal-root').contains(modal.overlay)).toBe(true);
  });
});

describe('mountModal onAction 回调', () => {
  it('点 footer [data-action] 按钮 → onAction(action, controller)', () => {
    const onAction = vi.fn();
    const modal = makeModal({
      onAction,
      footer: `
        <button class="btn" data-action="save">保存</button>
        <button class="btn" data-action="cancel">取消</button>
      `,
    });

    const cancelBtn = modal.footer.querySelector('[data-action="cancel"]');
    cancelBtn.click();

    expect(onAction).toHaveBeenCalledWith('cancel', modal);
  });

  it('onAction 返回 "close" → 自动 close(action)', () => {
    const onAction = vi.fn(() => 'close');
    const modal = makeModal({ onAction });
    const onClose = vi.fn();
    modal.setOnClose(onClose);

    const btn = modal.footer.querySelector('[data-action="ok"]');
    btn.click();

    expect(onAction).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledWith('ok');
    expect(document.getElementById('modal-root').contains(modal.overlay)).toBe(false);
  });

  it('onAction 返回 undefined → 不关', () => {
    const onAction = vi.fn();
    const modal = makeModal({ onAction });
    const onClose = vi.fn();
    modal.setOnClose(onClose);

    modal.footer.querySelector('[data-action="ok"]').click();

    expect(onAction).toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(document.getElementById('modal-root').contains(modal.overlay)).toBe(true);
  });

  // audit fix (Round 8 M-3)：onAction 抛同步错时 modal 不能挂死。
  // 旧实现：onAction 抛错 → event listener 抛 → modal 不关 → 用户没法关窗。
  // 修复：try/catch 兜底，错误打 console，modal 保持打开（用户看到具体错误）。
  it('onAction 抛同步错 → 不挂死，modal 仍可关（Round 8 M-3）', () => {
    const onAction = vi.fn(() => { throw new Error('dialog logic exploded'); });
    const modal = makeModal({ onAction });
    const onClose = vi.fn();
    modal.setOnClose(onClose);
    // 静默 console.error，避免测试输出噪音
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => modal.footer.querySelector('[data-action="ok"]').click()).not.toThrow();

    expect(onAction).toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
    // 关键断言 —— modal 仍可关闭（× 按钮正常工作）
    modal.footer.querySelector('[data-action="__modal_close__"], .modal-close')?.click();
    // 没有 × 时 overlay 背景点击也走 onBackdropClose；这里显式 close(value) 模拟用户关窗
    modal.close('manual');
    expect(document.getElementById('modal-root').contains(modal.overlay)).toBe(false);
  });
});

describe('mountModal data-action 作用域（仅 modal-level）', () => {
  // 契约：data-action 是 modal-level 属性，只被 modal 在 footer + × 关闭按钮上拦截。
  // body 内的 [data-action] 是 dialog 自己的 in-body action（例如 settings-dialog
  // 的「显示/隐藏 API Key」「清空 AI 配置」），由 dialog 各自 bind 处理；modal
  // 不应拦截、不应触发 onAction、也不应自动关闭。
  //
  // 之前 modal 无差别拦截所有 [data-action]，body 内按钮的 onAction 默认返回
  // 'close' → 点「显示」就立刻关 modal，UX 坏掉。
  it('body 内 [data-action] 按钮不触发 onAction', () => {
    const onAction = vi.fn(() => 'close');
    const modal = makeModal({
      onAction,
      body: '<button type="button" data-action="toggle-ai-key">显示 API Key</button>',
      footer: '<button class="btn" data-action="ok">确定</button>',
    });

    modal.body.querySelector('[data-action="toggle-ai-key"]').click();

    expect(onAction).not.toHaveBeenCalled();
    expect(document.getElementById('modal-root').contains(modal.overlay)).toBe(true);
  });

  it('body 内 [data-action] 按钮即使 onAction 返回 "close" 也不关 modal', () => {
    const onAction = vi.fn(() => 'close');
    const onClose = vi.fn();
    const modal = makeModal({
      onAction,
      onClose,
      body: '<button type="button" data-action="clear-ai">[清空 AI 配置]</button>',
    });
    modal.setOnClose(onClose);

    modal.body.querySelector('[data-action="clear-ai"]').click();

    expect(onAction).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(document.getElementById('modal-root').contains(modal.overlay)).toBe(true);
  });

  it('footer 内 [data-action] 仍然走 onAction（回归保护）', () => {
    const onAction = vi.fn(() => 'close');
    const modal = makeModal({
      onAction,
      body: '<button type="button" data-action="body-btn">body btn</button>',
      footer: '<button class="btn" data-action="footer-btn">footer btn</button>',
    });

    modal.footer.querySelector('[data-action="footer-btn"]').click();

    expect(onAction).toHaveBeenCalledWith('footer-btn', modal);
    expect(document.getElementById('modal-root').contains(modal.overlay)).toBe(false);
  });
});

describe('mountModal 单槽冲突', () => {
  it('已开一个再开第二个 → 第二个返回 null', () => {
    const first = makeModal({ title: 'first' });
    const second = makeModal({ title: 'second' });

    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it('关掉第一个后才能再开第二个', () => {
    const first = makeModal({ title: 'first' });
    expect(makeModal({ title: 'second' })).toBeNull();

    first.close('ok');

    const second = makeModal({ title: 'second' });
    expect(second).not.toBeNull();
  });
});

describe('mountModal setBody / setFooter', () => {
  it('setBody 替换正文', () => {
    const modal = makeModal();
    modal.setBody('<p class="replaced">new</p>');
    expect(modal.body.querySelector('.replaced').textContent).toBe('new');
  });

  it('setFooter 替换 footer 且按钮事件继续走委托', () => {
    const onAction = vi.fn();
    const modal = makeModal({ onAction });

    modal.setFooter('<button class="btn" data-action="replaced">替换的按钮</button>');
    modal.footer.querySelector('[data-action="replaced"]').click();

    expect(onAction).toHaveBeenCalledWith('replaced', modal);
  });
});

describe('mountModal abortSignal', () => {
  it('暴露 AbortSignal 用于外部挂监听', () => {
    const modal = makeModal();
    expect(modal.abortSignal).toBeInstanceOf(AbortSignal);
    expect(modal.abortSignal.aborted).toBe(false);

    modal.close('x');
    expect(modal.abortSignal.aborted).toBe(true);
  });
});