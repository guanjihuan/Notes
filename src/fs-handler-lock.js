// src/app.js onFilesChanged —— handler 并发闸（audit P1-4）
//
// 背景：原代码
//   const myToken = ++fsHandlerToken;
//   if (inFlightToken !== 0) { return; }
//   inFlightToken = myToken;
// 自增和 SET 之间是 microtask 窗口：burst 50 events 时多个 callback 排在同一
// microtask queue，每个都看到 inFlightToken === 0，全部过闸 → handler
// 并发跑（applyEntries 双跑、scanDir 双发、UI 闪烁）。
//
// 修复：makeLock() 工厂 → { tryClaim, release, current }。tryClaim 是同步
// check-and-set 原子操作：锁空闲时 SET 并返新 token（非零），否则返 null。
// callback 入口 tryClaim → null 直接 return（pendingRescanRel 由调用方决定
// 是否记下）。
//
// 计数器：每次成功 tryClaim 自增，token 永不复用 —— 旧 handler 的 finally
// 即使「迟到的 release」也不会误释新 handler 的锁（release 检查 token 匹配）。
//
// ESM 导出（src/ 已是 ESM，跨 test 直接 import）。

/**
 * 创建一个并发闸对象。
 * @returns {{
 *   tryClaim: () => (number | null),
 *   release: (token: number) => boolean,
 *   current: () => number,
 * }}
 */
export function makeLock() {
  let inFlightToken = 0;
  let nextToken = 0;
  return {
    /**
     * 尝试占锁。锁空闲 → SET + 返新 token；锁被占 → 返 null。
     * 同步原子，不留 microtask 窗口。
     * @returns {number | null} 新 token（非零）或 null
     */
    tryClaim() {
      if (inFlightToken !== 0) return null;
      nextToken += 1;
      inFlightToken = nextToken;
      return inFlightToken;
    },
    /**
     * 释放锁。token 与当前锁不匹配 → 返 false，锁不变（防止旧 handler 误释
     * 新 handler 的锁，例如「finally 迟到」场景）。
     * @param {number} token tryClaim 返回的 token
     * @returns {boolean} true = 已释放，false = token 不匹配
     */
    release(token) {
      if (inFlightToken !== token) return false;
      inFlightToken = 0;
      return true;
    },
    /**
     * 当前锁的 token。0 = 空闲。
     * @returns {number}
     */
    current() {
      return inFlightToken;
    },
  };
}
