// IPC handler 入口 sender / frame 守卫（audit R5 P1-10 / P1-11 / P1-14）
// ============================================================================
//
// 背景：渲染端的 window.api.* 是 contextBridge 暴露的，渲染端任意 JS（XSS、
// devtools console 注入、扩展、未来的 webview）都能调。`renderer:set-dirty`
// 单独加了 sender 校验（main.js:952），其它 20+ file/folder/shell/window/ai
// handler 全裸奔 —— 攻击面包括：
//   - 读 / 写 / 删 用户笔记（file:read/write/delete）
//   - 改设置 / dataDir / 主题（app:*, window:*）
//   - 取消别人正在跑的 AI 请求（ai:cancel —— 跨窗口 race）
//   - 弹出 arm 窗口让 reveal-ai-key 流程推进（B-10，未来 webview 嵌入）
//
// 修复：抽 assertMainSender(event, getMainWindow) → { ok:true } | { ok:false,
// error:SENDER_NOT_ALLOWED }。所有 IPC handler 顶部一行 if 早退。
// senderFrame 守卫（assertTopFrame）单独抽，对子 frame 嵌入场景生效。
//
// 测试注入：getMainWindow 走参数注入，不直接读 main.js 闭包 —— 单测里
// 传 mock 即可。vi.mock('electron') 拦不住 CJS require，所以走参数。
//
// 用法示例（main.js）：
//   const { assertMainSender, SENDER_NOT_ALLOWED } = require('./ipc-sender.js');
//   ipcMain.handle('file:read', async (event, filePath) => {
//     const guard = assertMainSender(event, getMainWindow);
//     if (!guard.ok) return { ok: false, error: guard.error };
//     // ... 原有逻辑
//   });

'use strict';

/**
 * IPC handler 调用方来源校验。返回 ok=true 放行，ok=false 拒绝并附错误码。
 *
 * @param {Electron.IpcMainInvokeEvent | Electron.IpcMainMessageEvent} event
 *   IPC 事件对象；读取 event.sender（webContents 引用）。
 * @param {() => (Electron.BrowserWindow | null)} getMainWindow
 *   返回当前主窗口的 getter —— 走参数注入避免循环依赖 + 单测里 mock 方便。
 *   主窗口未创建（早期启动 race）或已销毁 → 拒绝。
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
function assertMainSender(event, getMainWindow) {
  if (!event || !event.sender) {
    return { ok: false, error: SENDER_NOT_ALLOWED };
  }
  const win = typeof getMainWindow === 'function' ? getMainWindow() : null;
  if (!win || typeof win.isDestroyed !== 'function' || win.isDestroyed()) {
    return { ok: false, error: SENDER_NOT_ALLOWED };
  }
  if (event.sender !== win.webContents) {
    return { ok: false, error: SENDER_NOT_ALLOWED };
  }
  return { ok: true };
}

/**
 * 顶层 frame 守卫：拒绝来自 iframe / webview 子 frame 的调用。
 * 用途：未来给主窗口加 webview 嵌入时（如设置面板内嵌文档预览），防止子
 * frame 里的脚本通过 ipcRenderer 直接调主进程敏感接口。
 *
 * @param {Electron.IpcMainInvokeEvent | Electron.IpcMainMessageEvent} event
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
function assertTopFrame(event) {
  // senderFrame 缺失（极少数场景）= 拒绝保守
  if (!event || !event.senderFrame) {
    return { ok: false, error: SENDER_NOT_ALLOWED };
  }
  // parent 真值 = 子 frame（iframe / webview / 子 BrowserWindow）；null = 顶层
  if (event.senderFrame.parent) {
    return { ok: false, error: SENDER_NOT_ALLOWED };
  }
  return { ok: true };
}

// AI cancel requestId 两种合法格式（main/ai.js:968 / src/ai/ai-chat-panel.js:21）：
//   - 'ai-<timestamp>-<UUIDv4>'（main 侧 fallback 生成）
//   - '<UUIDv4>'（renderer 侧 crypto.randomUUID()）
// 这条正则同时拒掉任意垃圾字符串、过长 payload（防内存放大）、非 hex 字符。
// 编译期一次，运行时零开销。
const RE_AI_REQUEST_ID = /^(?:ai-\d{1,18}-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

/**
 * ai:cancel IPC 的 requestId 格式校验。配合 assertMainSender 做纵深防御：
 *   - assertMainSender 拒掉恶意 webContents
 *   - assertAiRequestId 拒掉畸形 requestId（防 typo / 攻击者探测 Map 结构）
 *
 * @param {unknown} requestId
 * @returns {{ ok: true, requestId: string } | { ok: false, error: string }}
 */
function assertAiRequestId(requestId) {
  if (typeof requestId !== 'string') {
    return { ok: false, error: 'INVALID_REQUEST_ID' };
  }
  if (requestId.length > 200) {
    return { ok: false, error: 'INVALID_REQUEST_ID' };
  }
  if (!RE_AI_REQUEST_ID.test(requestId)) {
    return { ok: false, error: 'INVALID_REQUEST_ID' };
  }
  return { ok: true, requestId };
}

const SENDER_NOT_ALLOWED = 'SENDER_NOT_ALLOWED';
const INVALID_REQUEST_ID = 'INVALID_REQUEST_ID';

module.exports = {
  assertMainSender,
  assertTopFrame,
  assertAiRequestId,
  SENDER_NOT_ALLOWED,
  INVALID_REQUEST_ID,
};
