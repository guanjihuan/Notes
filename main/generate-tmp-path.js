// main/file-ops.js atomicWriteFile —— tmp 路径生成（audit P2-1）
//
// 背景：原 inline 实现 `Math.random().toString(36).slice(2, 8)`
//   - Math.random() 不加密安全，并发同毫秒 + 同 pid + 同 dst 可能撞名
//     （虽然 36^6 ≈ 21 亿，实际不撞，但语义上 audit 要求与 crypto.randomUUID 对齐）
//   - 仓库其它路径已用 crypto.randomUUID()，统一风格
//
// 设计：
//   - 抽 generateTmpPath(dst, { crypto, pid, now }) 工厂
//   - 注入 crypto / pid / now 便于单测验证随机性来源
//   - 默认走 node:crypto.randomUUID()（128-bit 加密安全）
//   - 路径格式：${dst}.tmp.${pid}.${ts}.${randomId}
//     保持现有格式不破坏 fs-watcher（fs-watcher 旧逻辑只匹配 .tmp.* 前缀，randomId
//     改成 UUID 不影响匹配）
//
// 调用方：atomicWriteFile 在 fs.open 之前构造 tmpPath。

'use strict';

/**
 * 生成 atomicWriteFile 用的 tmp 路径。
 * @param {string} dst 目标文件完整路径
 * @param {{
 *   crypto?: { randomUUID: () => string },
 *   pid?: number,
 *   now?: () => number,
 * }} [opts] 注入依赖，便于单测
 * @returns {string} `${dst}.tmp.${pid}.${ts}.${randomId}`
 */
function generateTmpPath(dst, opts) {
  const cryptoImpl = (opts && opts.crypto) || require('node:crypto');
  const pid = (opts && typeof opts.pid === 'number') ? opts.pid : process.pid;
  const now = (opts && typeof opts.now === 'function') ? opts.now : Date.now;
  const randomId = cryptoImpl.randomUUID();
  return `${dst}.tmp.${pid}.${now()}.${randomId}`;
}

module.exports = { generateTmpPath };
