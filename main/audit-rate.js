// P2-7（audit）：IPC 高频调用检测 —— 滑动窗口按 key 计数。
//
// 背景：app:open-config-dir 这类「打开系统目录」的 handler 被 renderer 任意
// JS 调到（XSS / devtools 注入）。单次调用无害，但脚本化高频调用能弹出一串
// 文件管理器窗口骚扰用户。主进程记一笔滑动窗口计数，超阈值 console.warn
// （会同步进 notes-main.log，事后可查）。
//
// 只检测、不拦截 —— 拦截合法双击/连点会误伤，先只留审计痕迹。

'use strict';

/**
 * @param {object} opts
 * @param {number} opts.windowMs  滑动窗口毫秒数
 * @param {number} opts.threshold 窗口内允许的最大次数；第 threshold+1 次起 exceeded=true
 * @param {() => number} [opts.now] 时钟注入，默认 Date.now（单测推进时间用）
 * @returns {{ hit: (key: string) => { count: number, exceeded: boolean } }}
 */
function createAuditRateTracker({ windowMs, threshold, now } = {}) {
  const clock = typeof now === 'function' ? now : Date.now;
  /** @type {Map<string, number[]>} key → 窗口内各次调用的时间戳（升序） */
  const buckets = new Map();
  return {
    hit(key) {
      const t = clock();
      const cutoff = t - windowMs;
      let arr = buckets.get(key);
      if (!arr) {
        arr = [];
        buckets.set(key, arr);
      }
      // 过期剔除：[cutoff, t) 语义 —— 恰好 windowMs 前的记录视为过期
      while (arr.length > 0 && arr[0] <= cutoff) arr.shift();
      arr.push(t);
      return { count: arr.length, exceeded: arr.length > threshold };
    },
  };
}

module.exports = { createAuditRateTracker };
