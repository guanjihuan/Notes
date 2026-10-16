// main/ai.js cancelAll —— 顺序竞争 epoch 闸（audit P1-5）
//
// 背景：cancelAll 内部三步
//   1) for (controller of pending.values()) controller.abort();
//   2) pending.clear();
//   3) inFlightRequestIds.clear();
// 三步非原子。竞态：cancelAll 走到 step 1 刚 abort 完，runEdit 同步阶段
// 已经把「新 requestId + 新 controller」加进 pending + inFlightRequestIds →
// step 2/3 把这条新 entry 也清掉，runEdit 自以为还在跑，await 不到结果，
// 任何同 requestId 重试都找不到 controller。
//
// 修复：抽 makeCleanupEpoch() 工厂 → { snapshot, invalidate, current, isCurrent }。
//   - cancelAll 入口 invalidate() → 序号 + 1（任何已 snapshot 的 in-flight 任务
//     之后 isCurrent() === false → 自行 bail）
//   - runEdit 入口 snapshot() 拿当前序号；await 后 isCurrent() === false
//     （说明本任务期间发生过 cancelAll）→ 不再 apply 任何副作用、直接 return
//
// 测试策略：纯函数工厂，无 fs / network / Electron 依赖。

import { describe, it, expect } from 'vitest';
import { makeCleanupEpoch } from '../../main/cleanup-epoch.js';

describe('cleanup epoch（audit P1-5）', () => {
  it('初始：current = 0，snapshot(0) isCurrent 成立', () => {
    const ep = makeCleanupEpoch();
    expect(ep.current()).toBe(0);
    expect(ep.snapshot()).toBe(0);
    expect(ep.isCurrent(ep.snapshot())).toBe(true);
  });

  it('invalidate() → current 自增，isCurrent 旧 snapshot 返 false', () => {
    const ep = makeCleanupEpoch();
    const oldSnap = ep.snapshot();
    ep.invalidate();
    expect(ep.current()).toBeGreaterThan(oldSnap);
    expect(ep.isCurrent(oldSnap)).toBe(false);
  });

  it('invalidate 之后再 snapshot 拿新序号，isCurrent 成立', () => {
    const ep = makeCleanupEpoch();
    ep.invalidate();
    const newSnap = ep.snapshot();
    expect(ep.isCurrent(newSnap)).toBe(true);
  });

  it('多次 invalidate 序号单调递增', () => {
    const ep = makeCleanupEpoch();
    const seqs = Array.from({ length: 5 }, () => {
      const before = ep.current();
      ep.invalidate();
      return ep.current() - before;
    });
    // 每次都增 1
    expect(seqs).toEqual([1, 1, 1, 1, 1]);
  });

  it('runEdit 模式：A 拿快照 → cancelAll → A 的 isCurrent 返 false', () => {
    // 模拟 P1-5 竞态：A 在 cancelAll 之前 snapshot，cancelAll 之后 A 检查 → 失效
    const ep = makeCleanupEpoch();
    const aSnap = ep.snapshot();
    // ... await 期间 ...
    ep.invalidate(); // cancelAll 触发
    expect(ep.isCurrent(aSnap)).toBe(false);
  });

  it('runEdit 模式：B 在 cancelAll 之后 snapshot → isCurrent 成立', () => {
    // 新请求在 cancelAll 之后进入，snapshot 拿新序号 → isCurrent true
    const ep = makeCleanupEpoch();
    ep.invalidate();
    const bSnap = ep.snapshot();
    expect(ep.isCurrent(bSnap)).toBe(true);
  });

  it('cancelAll 期间 burst：B1 → cancelAll → B2 都拿自己的快照，互不影响', () => {
    const ep = makeCleanupEpoch();
    const a1 = ep.snapshot();
    ep.invalidate();
    const b1 = ep.snapshot();
    ep.invalidate();
    const b2 = ep.snapshot();
    expect(ep.isCurrent(a1)).toBe(false); // A1 被 cancelAll 失效
    expect(ep.isCurrent(b1)).toBe(false); // B1 也被第二次 cancelAll 失效
    expect(ep.isCurrent(b2)).toBe(true);  // B2 仍有效
  });
});
