// 文件系统 errno → 用户能看懂的提示（main + renderer 共享）
// ============================================================================
//
// 单一事实源。解决 Round 3 之前的三份独立实现漂移：
//   - main/file-ops.js#friendlyWriteError(e)     —— 主进程内部，签名 e.code
//   - src/app.js#friendlyWriteError(code, fallback)        —— renderer save 路径
//   - src/file-ops.js#friendlyFsError(code, fallback)      —— renderer 文件 CRUD
//
// 三份在 EROFS / ENAMETOOLONG / ENOTDIR / ENOTEMPTY 上文案不同 —— 用户看到
// 不一致提示。每加一个 errno 都要同步改三处，每处都有人漏改。
//
// 修法（Round 4 收尾）：本文件 CJS export 函数 friendlyFsError(code, fallback)，
//   - main/file-ops.js 用 require('./shared/friendly-fs-error.js')，
//     调用时友好FsError(e?.code, e?.message || '写入文件失败')
//   - preload 用 require + contextBridge 暴露 window.api.friendlyFsError，
//     renderer 端走 window.api.friendlyFsError(...) 拿到同一份文案
//
// 加载方式：
//   - main.js / main/file-ops.js / preload.js (CJS)：const { friendlyFsError } = require('...')
//   - renderer：经 preload contextBridge 过桥（window.api.friendlyFsError）
//     —— renderer 跑在 Chromium 原生 ESM，不能直接 import CJS
//
// 【fallback 行为】
//   - 已知 errno：返回固定中文文案（与 fileOps.friendlyFsError 测试矩阵对齐）
//   - 未知 errno：返回 fallback（业务码如 PATH_NOT_ALLOWED / SYMLINK_NOT_ALLOWED /
//     FILE_TOO_LARGE / FILE_CHANGED_EXTERNALLY 等不是 fs errno，由 IPC 调用方
//     把 result.message 中文文案塞进 fallback）
//   - fallback 为空串 / undefined：走兜底「未知错误」，避免空 toast
// ============================================================================

'use strict';

/**
 * 把后端返回的 errno 翻译成中文用户提示。
 *
 * @param {string|null|undefined} code - 原始 errno（EACCES / EPERM / ENOSPC ...）
 *   或业务码字符串（PATH_NOT_ALLOWED 等），业务码一律走 fallback
 * @param {string|undefined} fallback - errno 未匹配时使用的回退文案
 *   （主进程一般传 e?.message；renderer 一般传 IPC result.message / result.error）
 * @returns {string} 中文提示（永不为空 —— 兜底走「未知错误」）
 */
function friendlyFsError(code, fallback) {
  switch (code) {
    case 'EACCES':
    case 'EPERM':
      return '文件被占用或没有写入权限（可能是只读文件 / 另一进程独占 / 权限不足）';
    case 'ENOSPC':
      return '磁盘空间不足';
    case 'EROFS':
      return '只读文件系统，无法写入';
    case 'EIO':
      return '磁盘 I/O 错误';
    case 'EBUSY':
      return '文件被其他程序占用';
    case 'ENAMETOOLONG':
      return '路径过长';
    case 'ENOTDIR':
      return '父目录不是目录';
    case 'EISDIR':
      return '目标路径是文件夹，无法写入';
    case 'ENOTEMPTY':
      return '目标文件夹不为空';
    // audit fix (Settings P3 / ENOENT mapping)：原本 ENOENT 没在 mapping 里，
    // 走 default → fallback 兜底成「未知错误」。ENOENT 是最常见的 fs errno
    // 之一（rename 源文件已删 / delete 已被外部删 / 路径打错 / watch 到一半
    // 文件被替换），用户看到一个空泛"未知错误"会以为 Notes 出 bug。补上。
    // 措辞区分「文件不存在」与「路径里某一级目录不存在」也覆盖 ENOTDIR
    // 已有的 case —— ENOENT 统一按"目标路径不存在"处理（精确到「文件还是
    // 目录」要 main 端自己抛业务码，不该让 errno mapping 揣测）。
    case 'ENOENT':
      return '文件或目录不存在（可能已被移动、重命名或删除）';
    default:
      return fallback || '未知错误';
  }
}

module.exports = { friendlyFsError };