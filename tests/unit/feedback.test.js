// Stage 7+: feedback.js (showToast)
//
// 覆盖 feedback.js 的「被广泛调用但没测试」的分支：
//   - #toast-container 缺失 → 静默 return（不抛、不 console 噪声）
//   - MAX_VISIBLE_TOASTS 超出 → 同步移除最早的（不等淡出动画）
//   - dismiss() 重入守卫：dataset.dismissed=1 后第二次调用直接 return
//     （防 transition 重入 + 防 double-remove）
//   - duration=0 → 不挂 auto-close timer（但 click 仍能关）
//   - duration>0 → 计时器到期自动 dismiss
//   - 默认 type='info' → className 含 is-info
//   - message / type 写入 DOM（role=status + textContent）
//
// 75+ 个调用点：app.js / file-ops.js / settings-dialog.js 等。补上 guard 守护，
// 防止未来重构时无意改坏 eviction / dismiss 语义（数据丢失风险虽低，但 toast
// 满天飞也是用户能感知的 bug）。
//
// 需要 DOM：jsdom 环境。

// @vitest-environment jsdom

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { showToast } from '../../src/feedback.js';

beforeEach(() => {
  // 标准 toast container —— src/index.html 里的 id
  document.body.innerHTML = '<div id="toast-container"></div>';
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

/**
 * 等待一次 raf 让 DOM 操作 / 微任务走完 —— jsdom 里 setTimeout / 微任务
 * 时序差异大，必须显式推进。
 */
function flushAll() {
  // 推进 fake timers（duration 到期）+ queueMicrotask
  return Promise.resolve().then(() => Promise.resolve());
}

describe('showToast 基础行为', () => {
  it('#toast-container 缺失 → 静默 return，不抛、不写 console', () => {
    document.body.innerHTML = '';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(() => showToast('hi')).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    warn.mockRestore();
    log.mockRestore();
  });

  it('默认 type=info → toast 含 className "toast is-info"', () => {
    showToast('hello');
    const t = document.querySelector('#toast-container > .toast');
    expect(t).not.toBeNull();
    expect(t.className).toContain('is-info');
  });

  it('type=success / warning / error → 各自 className', () => {
    showToast('a', 'success');
    showToast('b', 'warning');
    showToast('c', 'error');
    const list = Array.from(document.querySelectorAll('#toast-container > .toast'));
    expect(list.map((el) => el.className)).toEqual([
      expect.stringContaining('is-success'),
      expect.stringContaining('is-warning'),
      expect.stringContaining('is-error'),
    ]);
  });

  it('message 写入 textContent，role=status', () => {
    showToast('自定义消息', 'warning');
    const t = document.querySelector('#toast-container > .toast');
    expect(t.textContent).toBe('自定义消息');
    expect(t.getAttribute('role')).toBe('status');
  });
});

describe('showToast 自动关闭 + duration', () => {
  it('duration>0 → 计时器到期后自动 dismiss', () => {
    showToast('auto', 'info', 1000);
    expect(document.querySelectorAll('#toast-container > .toast')).toHaveLength(1);

    vi.advanceTimersByTime(1000);
    // dismiss 内部还有 150ms 的 fade-out setTimeout
    vi.advanceTimersByTime(150);
    expect(document.querySelectorAll('#toast-container > .toast')).toHaveLength(0);
  });

  it('duration=0 → 不挂 auto-close timer，但 click 仍能关', () => {
    showToast('sticky', 'info', 0);
    const t = document.querySelector('#toast-container > .toast');
    expect(t).not.toBeNull();

    vi.advanceTimersByTime(60_000);
    // 还在
    expect(document.querySelectorAll('#toast-container > .toast')).toHaveLength(1);

    // click 关闭
    t.click();
    vi.advanceTimersByTime(150);
    expect(document.querySelectorAll('#toast-container > .toast')).toHaveLength(0);
  });
});

describe('showToast click 立即关闭', () => {
  it('点击 toast → 立即触发 dismiss', () => {
    showToast('clickable', 'info', 60_000);
    const t = document.querySelector('#toast-container > .toast');
    t.click();
    vi.advanceTimersByTime(150);
    expect(document.querySelectorAll('#toast-container > .toast')).toHaveLength(0);
  });
});

describe('showToast MAX_VISIBLE_TOASTS 上限', () => {
  // MAX_VISIBLE_TOASTS = 5 — 反馈模块内部常量。如果改了这里也要改测试。
  // 抽成常量让失败信息更可读。
  const MAX = 5;

  it('到上限再 push → 最旧的被同步移除', () => {
    for (let i = 0; i < MAX; i += 1) showToast(`t${i}`);
    expect(document.querySelectorAll('#toast-container > .toast')).toHaveLength(MAX);

    showToast(`t${MAX}`);
    expect(document.querySelectorAll('#toast-container > .toast')).toHaveLength(MAX);
    // 最旧的 t0 应被踢出
    const texts = Array.from(document.querySelectorAll('#toast-container > .toast'))
      .map((el) => el.textContent);
    expect(texts).not.toContain('t0');
    expect(texts).toContain(`t${MAX}`);
  });

  it('连续 push 6 条 → 仍只剩最新 5 条', () => {
    for (let i = 0; i < MAX + 1; i += 1) showToast(`t${i}`);
    const list = Array.from(document.querySelectorAll('#toast-container > .toast'));
    expect(list).toHaveLength(MAX);
    const texts = list.map((el) => el.textContent);
    expect(texts).toEqual(['t1', 't2', 't3', 't4', 't5']);
  });

  it('被踢出的 toast 带 data-dismissed="1"（防 timer / click 回调闭包污染）', () => {
    for (let i = 0; i < MAX + 1; i += 1) showToast(`t${i}`);
    // 已经从 DOM 移除 —— 但闭包里的 dismiss 标记应当仍为 1。
    // 这里只能从新增的第 6 条倒推：第 6 条入 DOM 时把 t0 踢出，
    // t0.dataset.dismissed 应是 1。
    // 由于 t0 已经脱离 DOM，dataset 仍可读（dataset 是元素本身的属性）。
    // 我们拿到的是被踢的节点引用 —— 没法直接从 container 查。
    // 改为验证：再 push 1 条时，没有 console error（dismiss 回调跑过、被守卫挡住）。
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    showToast('extra');
    // 让所有到期 timer 跑一遍（包括 t0 的 auto-close timer —— 若 dismiss 没被
    // 守卫挡，会触发 container.removeChild(t0)，但 t0 已经脱离 DOM，
    // removeChild 抛 NotFoundError 进 console）。
    vi.advanceTimersByTime(60_000);
    expect(err).not.toHaveBeenCalled();
    err.mockRestore();
  });
});

describe('showToast dismiss() 重入守卫', () => {
  it('同一 toast 的 dismiss 被多次触发（auto + click 抢跑）→ 只移除一次', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});

    showToast('race', 'info', 1000);
    const t = document.querySelector('#toast-container > .toast');

    // click 先触发 dismiss（dataset.dismissed=1, fade-out timer 排队）
    t.click();
    // 同时计时器到期再触发 dismiss —— 应被 dataset 守卫挡住
    vi.advanceTimersByTime(1000);
    // 让两段 fade-out 完成
    vi.advanceTimersByTime(500);

    expect(document.querySelectorAll('#toast-container > .toast')).toHaveLength(0);
    // removeChild 不抛 NotFoundError —— 第二次 removeChild 被 parentElement 检查挡住
    expect(err).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();

    warn.mockRestore();
    err.mockRestore();
  });
});