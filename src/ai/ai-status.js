// src/ai/ai-status.js —— AI 链路状态类型 / 错误码常量
//
// 把散落在 ai-controller / ai-chat-panel / ai-diff-panel 里的字面量集中
// 单一事实源；状态类型与 chat panel 的 notify / data-ai-state / dataset.status
// 三处渲染点保持一致。
//
// 错误码统一走 shared/ai-errors.js（CJS，main / preload / renderer 三处共用）。
// renderer 是 ESM 不能直接 require CJS，所以 preload 经 contextBridge 暴露
// window.api.aiErrors.AI_ERROR；本文件在模块顶层取这个值。单测（jsdom 无 preload）
// 走下方本地副本 —— 副本与 shared/ai-errors.js 同字面量，新增错误码时两边一起改，
// 由 tests/unit/ai-errors.test.js 校验两边一致。

/**
 * AI 状态类型 —— renderer 端所有状态渲染都引用这里。
 * 命名与 [data-ai-state] dataset 属性一一对应（见 ai-diff-panel / ai-chat-panel）。
 */
export const AI_STATUS = Object.freeze({
  IDLE: 'idle',
  RUNNING: 'running',
  CANCELLED: 'cancelled',
  ERROR: 'error',
  SUCCESS: 'success',
  DIFF: 'diff',
});

/**
 * AI 错误码 —— 来自 shared/ai-errors.js#AI_ERROR。renderer 在模块顶层直接
 * window.api?.aiErrors?.AI_ERROR 取值；取不到时（jsdom 单测 / preload 注入失败）
 * 退化到下方本地副本。
 *
 * audit fix (CQ-MED-7)：之前 renderer 各自维护一份字面量注释提醒"必须与 main/ai.js
 * 同名常量一致"——实际曾漂移（renderer 旧版 ERR_TIMEOUT='ERR_TIMEOUT' 与 main 的
 * 'AI_TIMEOUT' 对不上，aiErrorMessage switch 永不命中、永远走 fallback 'AI 修改失败'）。
 * 现在共享同一文件，注释提醒的"靠人同步"变成"靠文件同步"。
 */
const SHARED_AI_ERROR = (typeof window !== 'undefined'
  && window.api?.aiErrors?.AI_ERROR) || null;

const LOCAL_AI_ERROR_FALLBACK = Object.freeze({
  NOT_CONFIGURED: 'AI_NOT_CONFIGURED',
  NO_FILE: 'NO_FILE',
  EDITOR_UNAVAILABLE: 'EDITOR_UNAVAILABLE',
  IPC_FAILED: 'IPC_FAILED',
  GENERATION_STALE: 'GENERATION_STALE',
  FILE_CHANGED: 'FILE_CHANGED',
  ERR_TIMEOUT: 'AI_TIMEOUT',
  ERR_PROVIDER: 'AI_PROVIDER_ERROR',
  ERR_FORMAT: 'AI_BAD_RESPONSE',
  ERR_CANCELLED: 'AI_CANCELLED',
});

export const AI_ERROR = SHARED_AI_ERROR || LOCAL_AI_ERROR_FALLBACK;

/**
 * 把 AI 错误码映射成中文消息（用于 status bar chip / toast）。
 * 单一映射点，避免各组件各自拼字符串。
 */
export function aiErrorMessage(code, fallback) {
  switch (code) {
    case AI_ERROR.NOT_CONFIGURED: return 'AI 未配置，已打开设置';
    case AI_ERROR.NO_FILE: return '请先打开 Markdown 文件';
    case AI_ERROR.EDITOR_UNAVAILABLE: return '无法读取编辑器内容，已取消本次 AI 请求';
    case AI_ERROR.IPC_FAILED: return 'AI 通信异常';
    case AI_ERROR.GENERATION_STALE: return '文件已切换，旧 AI 响应已丢弃';
    case AI_ERROR.FILE_CHANGED: return '文件已被外部修改';
    case AI_ERROR.ERR_TIMEOUT: return 'AI 请求超时';
    case AI_ERROR.ERR_PROVIDER: return 'AI 服务返回异常';
    case AI_ERROR.ERR_FORMAT: return 'AI 响应格式无法解析';
    case AI_ERROR.ERR_CANCELLED: return '已取消 AI 请求';
    default: return fallback || 'AI 修改失败';
  }
}