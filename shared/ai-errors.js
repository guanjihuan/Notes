// AI 错误码 —— 主进程与 renderer 端共享的字符串字面值。
//
// audit fix (CQ-MED-7)：之前错误码字面量分散在 main/ai.js#ERR_* 与
// src/ai/ai-status.js#AI_ERROR 两处，靠注释提醒同步 —— 实际曾漂移（renderer 旧版
// 把 'AI_TIMEOUT' 写成 'ERR_TIMEOUT'，导致 ai-controller 收到 main 返回的错误码
// 后 aiErrorMessage switch 永不命中、永远走 fallback 'AI 修改失败'）。
// 现在所有跨进程错误码集中在本文件，main / preload / renderer 三处共用同一份字面值，
// 任何一边改了另一边不会失配。
//
// 加载：
//   - main/ai.js:   const { AI_ERROR } = require('../shared/ai-errors.js');
//   - preload.js:   contextBridge.exposeInMainWorld('api', { aiErrors: { AI_ERROR } })
//   - renderer:     const { AI_ERROR } = window.api.aiErrors;
//                   （fallback 见 src/ai/ai-status.js，jsdom 单测环境走本地副本）
//
// 命名规则：AI_ERROR.* 的 value 是字符串字面值；调用方比较时用 AI_ERROR.FOO 引用，
// 永远不要直接引用字符串字面量。

'use strict';

const AI_ERROR = Object.freeze({
  // ---- 跨进程（main ↔ renderer）----
  // 主进程 ai.js 抛出 + renderer 端 controller 检测本地未配置时同样抛出。
  NOT_CONFIGURED: 'AI_NOT_CONFIGURED',
  // fetch 超时（AbortError + timeout 信号）
  ERR_TIMEOUT: 'AI_TIMEOUT',
  // HTTP 4xx/5xx 或非 2xx 响应
  ERR_PROVIDER: 'AI_PROVIDER_ERROR',
  // 响应体 JSON 解析失败 / 不符合 OpenAI/Anthropic 协议
  ERR_FORMAT: 'AI_BAD_RESPONSE',
  // 用户主动取消（renderer abort signal / controller.cancelled 标志）
  ERR_CANCELLED: 'AI_CANCELLED',

  // ---- renderer 端辅助判定（main 不会产生这些值，但放一起便于集中引用）----
  NO_FILE: 'NO_FILE',
  EDITOR_UNAVAILABLE: 'EDITOR_UNAVAILABLE',
  IPC_FAILED: 'IPC_FAILED',
  GENERATION_STALE: 'GENERATION_STALE',
  FILE_CHANGED: 'FILE_CHANGED',
});

module.exports = { AI_ERROR };