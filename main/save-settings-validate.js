// main.js app:save-settings —— partial payload 校验（audit P1-1）
//
// 背景：原 handler `if (!partial || typeof partial !== 'object') return
// { ok: true, settings: configStore.getConfig() };` 把 null / undefined /
// string / array 都当成「无更新」静默放过，renderer 缓存与磁盘脱钩
// （settingsStore.update({...}) 拿不到 error 也不会重试，直到下次合法保存）。
//
// 修复：抽 isValidPartialSettings(partial) 纯函数；handler 顶部调用，
// 拒收集合 → 返回 { ok: false, error: 'INVALID_PAYLOAD' }。
//
// 为什么纯函数 + 抽出：
//   1. 单测无需 mock ipcMain / Electron 运行时；
//   2. 日后若 renderer 端要前置校验（避免 round-trip），同一函数可直接 import。
//
// 拒收集合：null / undefined / 任何 primitive / Array / Function。
// 接收：plain object（typeof === 'object' && !Array.isArray）。

'use strict';

/**
 * @param {unknown} partial
 * @returns {boolean} true = 合法 partial（plain object），false = 应拒
 */
function isValidPartialSettings(partial) {
  return (
    partial !== null &&
    typeof partial === 'object' &&
    !Array.isArray(partial)
  );
}

module.exports = { isValidPartialSettings };
