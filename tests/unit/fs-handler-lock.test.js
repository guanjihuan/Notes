// src/app.js onFilesChanged —— handler 并发闸（audit P1-4）
//
// 背景：原代码
//   const myToken = ++fsHandlerToken;     // 自增但还没 SET
//   if (inFlightToken !== 0) { return; }  // 检查还是 0
//   inFlightToken = myToken;              // 才 SET
// 两行间是 microtask 窗口：burst 50 events 时多个 callback 排在同一 microtask
// queue 里，每个都看到 inFlightToken === 0，全部过闸 → handler 并发跑
// （applyEntries 双跑、scanDir 双发、UI 闪烁）。
//
// 修复：抽 makeLock() 工厂 → { tryClaim, release, current }。tryClaim 是同步
// 「check-and-set」原子操作：if 锁空闲则 SET 并返新 token，否则返 null。
// 在 callback 入口 tryClaim → null 直接 return → 不再丢事件，统一存到
// pendingRescanRel（既有逻辑保留）。
//
// 测试策略：直接 import 工厂函数，模拟 burst 场景验证「N 次 tryClaim 只有
// 第一次成功」。

import { describe, it, expect } from 'vitest';
import { makeLock } from '../../src/fs-handler-lock.js';

describe('fs-handler lock（audit P1-4）', () => {
  it('初始空闲 → tryClaim 返非零 token，current 反映该 token', () => {
    const lock = makeLock();
    const t = lock.tryClaim();
    expect(t).toBeGreaterThan(0);
    expect(lock.current()).toBe(t);
  });

  it('已占用时 tryClaim 返 null，current 不变', () => {
    const lock = makeLock();
    const t1 = lock.tryClaim();
    const t2 = lock.tryClaim();
    expect(t1).toBeGreaterThan(0);
    expect(t2).toBe(null);
    expect(lock.current()).toBe(t1);
  });

  it('release(token) → 锁重新空闲，tryClaim 能拿到新 token', () => {
    const lock = makeLock();
    const t1 = lock.tryClaim();
    expect(lock.release(t1)).toBe(true);
    expect(lock.current()).toBe(0);
    const t2 = lock.tryClaim();
    expect(t2).toBeGreaterThan(0);
    expect(t2).not.toBe(t1);
  });

  it('release(非当前 token) → 返 false，锁不被错误释放', () => {
    const lock = makeLock();
    const t1 = lock.tryClaim();
    expect(lock.release(99999)).toBe(false);
    expect(lock.current()).toBe(t1);
  });

  it('burst 50 次 tryClaim → 只有 1 次成功', () => {
    // 关键测试：模拟 microtask 批量场景
    const lock = makeLock();
    const results = Array.from({ length: 50 }, () => lock.tryClaim());
    const successes = results.filter((r) => r !== null);
    expect(successes).toHaveLength(1);
    // 其余 49 次全部 null
    expect(results.filter((r) => r === null)).toHaveLength(49);
  });

  it('release → tryClaim → 再 burst：交替可串行化多批事件', () => {
    const lock = makeLock();
    for (let batch = 0; batch < 5; batch++) {
      const t = lock.tryClaim();
      expect(t).not.toBe(null);
      // 本批 10 次并发全应被拒
      for (let i = 0; i < 10; i++) {
        expect(lock.tryClaim()).toBe(null);
      }
      // 释放
      expect(lock.release(t)).toBe(true);
    }
  });

  it('token 自增：每次成功 tryClaim 返的 token 都不同', () => {
    const lock = makeLock();
    const t1 = lock.tryClaim();
    lock.release(t1);
    const t2 = lock.tryClaim();
    lock.release(t2);
    const t3 = lock.tryClaim();
    expect(new Set([t1, t2, t3]).size).toBe(3);
  });
});
