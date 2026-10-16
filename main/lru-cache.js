// P2-6（audit）：通用 LRU 缓存 —— Map 迭代序即插入序，get/set 命中时
// delete+set 把键提到最新；set 超 maxSize 删最老（第一个键）。
//
// 用途：main/ai.js 的 pickOpenAITokenConfig / joinUrl 每次调用重复跑
// 正则 + new URL 解析；同 model / 同 baseURL 在一次会话里反复命中，
// 缓存结果省 CPU。maxSize 64 足够覆盖「用户试过的模型 + URL」组合，
// 不会无界增长。

'use strict';

/**
 * @param {object} [opts]
 * @param {number} [opts.maxSize=64]
 * @returns {{ get: (k: any) => any, set: (k: any, v: any) => void,
 *            has: (k: any) => boolean, size: number }}
 */
function createLruCache({ maxSize = 64 } = {}) {
  const map = new Map();
  return {
    get(key) {
      if (!map.has(key)) return undefined;
      const v = map.get(key);
      // LRU：提到最新
      map.delete(key);
      map.set(key, v);
      return v;
    },
    set(key, value) {
      // 覆盖同键 = 使用一次，提到最新
      if (map.has(key)) map.delete(key);
      map.set(key, value);
      if (map.size > maxSize) {
        // Map 第一个键 = 最老
        map.delete(map.keys().next().value);
      }
    },
    has(key) { return map.has(key); },
    get size() { return map.size; },
  };
}

module.exports = { createLruCache };
