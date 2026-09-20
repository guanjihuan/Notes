// 救援文件工具 —— 共享给 save() / openFile() / onFilesChanged / file-ops
// (deleteFile / renameFile) 五条路径使用。
//
// 背景：原逻辑「生成 `<base>-rescued-<stamp>-<suffix>.md` 名字 + 写盘 +
// 弹 toast」在四处独立复制（约 90 行重复代码），命名规则不统一时极易漂移。
// 抽到本文件后：
//   - 命名规则 / 随机后缀长度 / 时间戳精度 只改一处
//   - 错误文案（特别是 friendlyFsError 接受 r.message 还是 r.error）一处修
//   - 各调用方只关心「我有 content、想救回」一件事
//
// 设计要点：
//   - buildRescueName 是同步、纯函数，方便测试
//   - rescueDirtyContent 是 fire-and-forget：写盘失败不抛、不阻塞调用方
//     （save() / openFile() 入口已用 try/catch 兜底，但 rescue 路径本身不能
//     把 unhandled rejection 抛进全局）
//   - 不假设 api 是 window.api 还是 ctx.api —— 任意带 createFile 方法的即可

import { showToast } from './feedback.js';

/**
 * 生成救援文件名
 *
 * 格式：`<原名去后缀>-rescued-<ISO 时间戳含毫秒>-<4 字符随机>.md`
 *
 * 设计动机（audit renderer-M9）：毫秒精度 + 4 字符 base36 随机后缀让同一
 * 秒内多次删除产生重名的概率约 1/1.6M（ms 撞上后还有 1.68M 空间）—— 旧版
 * 用秒级 ISO 时间戳（slice(0,19)）会让 createFile 走 EEXIST 分支，用户
 * 「未保存内容丢失」。
 *
 * @param {string} originalName - 原文件名（含或不含 .md 后缀都行）
 * @returns {string}
 */
export function buildRescueName(originalName) {
  const base = (originalName || 'untitled.md').replace(/\.md$/i, '');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 23); // 含 .mmm
  const suffix = Math.random().toString(36).slice(2, 6);
  return `${base}-rescued-${stamp}-${suffix}.md`;
}

/**
 * 把「编辑器里待救回的 dirty 内容」异步写到数据目录的救援文件。
 * 失败回退到 toast 提示用户；不会抛错（fire-and-forget）。
 *
 * @param {object} args
 * @param {object} args.api - IPC API（window.api 或 file-ops ctx.api 任一带 createFile 即可）
 * @param {string} args.originalName - 原文件名（用于命名救援文件）
 * @param {string} args.content - 待写入的编辑器内容（调用方负责在 clearCurrentFile 之前取好）
 * @param {string} args.event - 触发救援的事件描述，用于 toast 文案前缀
 *   （例：「文件已不在」「原文件已被删除」「文件已被删除」）。
 *   成功路径：`${event}，未保存内容已救回到「${rescueName}」`
 *   失败路径：`${event}；未保存内容丢失（救回失败：${friendlyFsError(...)}）`
 *   IPC 异常：`${event}；未保存内容丢失`
 * @returns {string} 救援文件名（同步返回，不等 IPC 完成）
 */
export function rescueDirtyContent({ api, originalName, content, event }) {
  const rescueName = buildRescueName(originalName);
  // 第二阶段代码审查 (Phase 2 review #1)：显式用 { initialContent } 对象形式，
  // 不再依赖 preload.js createFile 的 string-overload 兼容分支。
  // 该 overload 是「向后兼容老调用」的临时垫片，未来若被移除（强约束新签名），
  // 所有 5 条 rescue 路径会静默失败 —— 用户只在 toast 上看到「未保存内容丢失」，
  // 完全不知道是 payload shape 不匹配。这里走与 main/file-ops.js#resolveFileName
  // 对齐的新签名，消除隐式依赖。
  api.createFile(rescueName, { initialContent: content }).then((r) => {
    if (r && r.ok) {
      showToast(`${event}，未保存内容已救回到「${rescueName}」`, 'warning', 4500);
    } else {
      // 注意：friendlyFsError 的第二个参数是「fallback 中文明文」，
      // 必须传 r?.message（IPC handler 已塞好的中文），不能传 r?.error
      // （业务码字符串如 'INVALID_NAME'）—— 否则用户看到的是原始业务码
      // 而非可读中文。统一收口在这里一处，调用方不再需要关心这个细节。
      //
      // 第二阶段代码审查 (Phase 2 review #2)：走注入的 api 参数而非 window.api。
      // 之前用 window.api?.friendlyFsError 与本文件「不假设 api 是 window.api
      // 还是 ctx.api」的契约矛盾 —— createFile 走注入 api，friendlyFsError
      // 又走 window.api，未来若 ctx.api 与 window.api 不一致（DI / 测试桩）
      // 会 break。在生产里 window.api 与 ctx.api 同一对象所以无害，但破坏了
      // 抽象一致性。
      const friendly = api && typeof api.friendlyFsError === 'function'
        ? api.friendlyFsError(r?.code, r?.message || r?.error)
        : (r?.message || r?.error || '未知错误');
      showToast(`${event}；未保存内容丢失（救回失败：${friendly}）`, 'error', 4500);
    }
  }).catch((e) => {
    console.error('[rescue] createFile IPC 异常:', e);
    showToast(`${event}；未保存内容丢失`, 'error', 4500);
  });
  return rescueName;
}