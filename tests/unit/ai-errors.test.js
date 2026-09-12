// shared/ai-errors.js 与 renderer 端 LOCAL_AI_ERROR_FALLBACK 的漂移防护测试
//
// audit fix (CQ-MED-7)：之前主进程错误码字面量靠注释提醒同步，实际曾漂移
// （renderer ERR_TIMEOUT='ERR_TIMEOUT' 与 main 'AI_TIMEOUT' 对不上，
// aiErrorMessage switch 永不命中）。现在 renderer 在 jsdom 单测里走
// LOCAL_AI_ERROR_FALLBACK 这份本地副本，与 shared/ai-errors.js#AI_ERROR 必须
// 严格一致 —— 本测试校验两边字面值一一对应，新增 / 删除 / 改名都必须在两边同步改。

import { describe, it, expect } from 'vitest';
// shared/ai-errors.js 是 CJS（module.exports = { AI_ERROR }），ESM 解析器
// 不支持 named import from CJS —— vitest 在 node 环境下走 require 链路。
const { AI_ERROR: SHARED_AI_ERROR } = require('../../shared/ai-errors.js');
import { AI_ERROR as RENDERER_AI_ERROR } from '../../src/ai/ai-status.js';

describe('shared/ai-errors.js 与 src/ai/ai-status.js 错误码漂移防护 (CQ-MED-7)', () => {
  it('shared 与 renderer 的 key 集合完全一致', () => {
    const sharedKeys = Object.keys(SHARED_AI_ERROR).sort();
    const rendererKeys = Object.keys(RENDERER_AI_ERROR).sort();
    expect(rendererKeys).toEqual(sharedKeys);
  });

  it('shared 与 renderer 的每个 key 字面值完全一致', () => {
    for (const key of Object.keys(SHARED_AI_ERROR)) {
      expect(RENDERER_AI_ERROR[key]).toBe(SHARED_AI_ERROR[key]);
    }
  });

  it('renderer 的 AI_ERROR 在 jsdom 环境（无 preload）下能取到非空对象', () => {
    // 本测试文件跑在 jsdom 下，没有 window.api → 应走 LOCAL_AI_ERROR_FALLBACK。
    // 若拿到空对象 / undefined，说明 fallback 链路断了 —— 单测会假阳性通过，
    // 实际渲染时 aiErrorMessage 永远走 default 分支。
    expect(RENDERER_AI_ERROR).toBeDefined();
    expect(Object.keys(RENDERER_AI_ERROR).length).toBeGreaterThan(0);
  });

  it('跨进程错误码（main ↔ renderer 都会引用）的字面值是稳定的字符串', () => {
    // 不允许 undefined / null / 空串 —— main 返回这些值给 renderer 后，
    // ai-controller 会拿它们走 switch，落到 default 分支。
    for (const code of Object.values(SHARED_AI_ERROR)) {
      expect(typeof code).toBe('string');
      expect(code.length).toBeGreaterThan(0);
    }
  });
});