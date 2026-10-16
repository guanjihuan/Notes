// P2-7（audit）：app:open-config-dir 高频调用检测。
//
// 设计：main/audit-rate.js 提供 createAuditRateTracker({ windowMs, threshold, now })
// 返回 hit(key) → { count, exceeded }。滑动窗口按 key 计数：
//   - 窗口内 count ≤ threshold → exceeded=false
//   - 窗口内 count > threshold → exceeded=true（调用方据此 console.warn）
//   - 超过 windowMs 的旧记录自动过期
//
// now 可注入（Date.now 默认），方便单测推进时间。

import { describe, it, expect } from 'vitest';
const { createAuditRateTracker } = require('../../main/audit-rate.js');

describe('createAuditRateTracker —— P2-7 高频调用检测', () => {
  it('首次调用 count=1，不 exceeded', () => {
    const t = createAuditRateTracker({ windowMs: 60_000, threshold: 5 });
    expect(t.hit('k')).toEqual({ count: 1, exceeded: false });
  });

  it('窗口内累计到 threshold 不 exceeded，超过则 exceeded', () => {
    let now = 1000;
    const t = createAuditRateTracker({ windowMs: 60_000, threshold: 3, now: () => now });
    expect(t.hit('k').exceeded).toBe(false); // 1
    expect(t.hit('k').exceeded).toBe(false); // 2
    expect(t.hit('k').exceeded).toBe(false); // 3
    const fourth = t.hit('k'); // 4 > 3
    expect(fourth.count).toBe(4);
    expect(fourth.exceeded).toBe(true);
  });

  it('不同 key 独立计数', () => {
    const t = createAuditRateTracker({ windowMs: 60_000, threshold: 1 });
    t.hit('a');
    expect(t.hit('b')).toEqual({ count: 1, exceeded: false });
  });

  it('超过 windowMs 的旧记录过期，重新计数', () => {
    let now = 0;
    const t = createAuditRateTracker({ windowMs: 1000, threshold: 2, now: () => now });
    t.hit('k'); // t=0
    t.hit('k'); // t=0, count=2
    expect(t.hit('k').exceeded).toBe(true); // t=0, count=3
    now = 1500; // 滑出窗口
    expect(t.hit('k')).toEqual({ count: 1, exceeded: false });
  });

  it('边界：恰好 windowMs 的时间点视为过期（[now-window, now) 语义）', () => {
    let now = 0;
    const t = createAuditRateTracker({ windowMs: 1000, threshold: 1, now: () => now });
    t.hit('k'); // t=0
    now = 1000; // 恰好 1000ms 后
    expect(t.hit('k')).toEqual({ count: 1, exceeded: false });
  });

  it('默认 now=Date.now，不抛错', () => {
    const t = createAuditRateTracker({ windowMs: 1000, threshold: 1 });
    expect(() => t.hit('k')).not.toThrow();
  });
});
