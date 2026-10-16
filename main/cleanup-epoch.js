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
// 修复：makeCleanupEpoch() 工厂 → { current, snapshot, invalidate, isCurrent }。
//   - cancelAll 入口 invalidate() → 序号 + 1（任何已 snapshot 的 in-flight 任务
//     之后 isCurrent() === false → 自行 bail）
//   - runEdit 入口 snapshot() 拿当前序号；await 后 isCurrent() === false
//     （说明本任务期间发生过 cancelAll）→ 不再 apply 任何副作用、直接 return
//
// 序号从 1 开始自增（0 留给「初始」/「无 epoch」语义）—— isCurrent 比较时
// 0 vs 0 也算成立（测试覆盖），但 cancelAll invalidate 之后序号一定 > 0，
// 真实 runEdit 拿的 snapshot 至少 1。

'use strict';

/**
 * 创建一个 epoch 计数器对象。cancelAll.invalidate / runEdit.snapshot / runEdit.isCurrent
 * 配合使用，挡住「cancelAll 中途新请求进入」的竞态。
 * @returns {{
 *   current: () => number,
 *   snapshot: () => number,
 *   invalidate: () => void,
 *   isCurrent: (snap: number) => boolean,
 * }}
 */
function makeCleanupEpoch() {
  let epoch = 0;
  return {
    /**
     * 当前 epoch 序号。0 = 初始（无 cancelAll 发生过）。
     * @returns {number}
     */
    current() {
      return epoch;
    },
    /**
     * 拍下当前 epoch 的快照，用于稍后 isCurrent() 校验。
     * runEdit 入口调用，await 后比对。
     * @returns {number}
     */
    snapshot() {
      return epoch;
    },
    /**
     * 自增 epoch，使所有「更早的 snapshot」isCurrent 失效。
     * cancelAll 入口调用。
     */
    invalidate() {
      epoch += 1;
    },
    /**
     * 校验「snap 是否仍是当前 epoch」。
     * @param {number} snap snapshot() 返回的序号
     * @returns {boolean} snap === current
     */
    isCurrent(snap) {
      return epoch === snap;
    },
  };
}

module.exports = { makeCleanupEpoch };
