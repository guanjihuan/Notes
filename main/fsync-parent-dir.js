// main.js file:rename / folder:rename —— rename 后父目录 fsync（audit P1-6）
//
// 背景：fs.rename 在 POSIX 下只 fsync 自己的 inode，不 fsync 父目录的 directory entry。
// 崩溃时新名可能没落盘，恢复后看到的是「旧名 inode + 文件内容」。audit 要求
// 与 atomicWriteFile（main.js:1801-1809 模式）一致：rename 成功后对父目录做 fsync。
//
// 现状：folder:create 已经在 mkdir 后做了父目录 fsync（main.js:1854-1864），
// 但 file:rename（main.js:1986）和 folder:rename（main.js:2085）都没有。
//
// 设计：
//   - 抽 fsyncParentDir(filePath, opts?) helper
//   - win32 上 NTFS journal 自带元数据持久化，直接 noop（与 folder:create 一致）
//   - fsImpl 注入：生产用 Node 内置 fs；单测用 mock 验证 open→sync→close 顺序
//   - close 失败静默吞（与 folder:create 行为一致）
//   - open/sync 失败透传错误（不静默 —— rename 已成功，父目录 fsync 失败要可观测）
//
// 调用方语义：rename 成功后调用。失败不抛、返 {ok:false, error, code} 让调用方
// 决定是否吞（推荐：log warn，不回滚 rename —— 文件已改名成功，父目录 fsync
// 失败只是「崩溃时不保证新名持久化」，回滚成本高、收益低）。

'use strict';

const path = require('path');

/**
 * 对 filePath 的父目录做 fsync，确保 directory entry 落盘。
 * @param {string} filePath 文件/文件夹的完整路径
 * @param {{
 *   fsImpl?: { open: (p: string, m: string) => Promise<{ sync: () => Promise<void>, close: () => Promise<void> }> },
 *   platform?: NodeJS.Platform,
 * }} [opts]
 * @returns {Promise<{ ok: boolean, error?: string, code?: string, skipped?: string }>}
 */
async function fsyncParentDir(filePath, opts) {
  const fsImpl = (opts && opts.fsImpl) || require('fs').promises;
  const platform = (opts && opts.platform) || process.platform;

  if (platform === 'win32') {
    // NTFS journal 自带元数据持久化，无需 fsync
    return { ok: true, skipped: 'win32' };
  }

  const parentDir = path.dirname(filePath);
  let fh;
  try {
    fh = await fsImpl.open(parentDir, 'r');
  } catch (e) {
    return { ok: false, error: e.message, code: e.code };
  }
  try {
    await fh.sync();
  } catch (e) {
    return { ok: false, error: e.message, code: e.code };
  } finally {
    try {
      await fh.close();
    } catch {
      // close 失败静默吞（与 folder:create 行为一致 —— 防止 fh 泄漏已尽力）
    }
  }
  return { ok: true };
}

module.exports = { fsyncParentDir };
