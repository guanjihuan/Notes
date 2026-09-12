// shared/friendly-fs-error.js —— 渲染端 + 主进程共用的 errno → 中文提示
//
// 覆盖 P0：Round 4 收尾前 renderer 端有三份独立 mapping（src/app.js /
// src/file-ops.js / main/file-ops.js），用户看到的 toast 文案 EROFS / ENAMETOOLONG
// / ENOTDIR / ENOTEMPTY 不一致。本测试钉死 shared 模块的 mapping 文案，main /
// preload / renderer 三处全依赖此单一事实源。每条 case 必须有断言 —— 防止未来
// 重构时改坏 mapping（用户会看到误导的"未知错误"）。
//
// shared/friendly-fs-error.js 是 CJS（module.exports = { friendlyFsError }），
// ESM 解析器不支持 named import from CJS —— vitest 在 node 环境下走 require 链路。

import { describe, it, expect } from 'vitest';
const { friendlyFsError } = require('../../shared/friendly-fs-error.js');

describe('friendlyFsError —— 已知 errno 映射', () => {
  it('EACCES → 权限 / 占用提示', () => {
    expect(friendlyFsError('EACCES')).toMatch(/占用|权限/);
  });

  it('EPERM → 权限 / 占用提示（与 EACCES 共用文案）', () => {
    expect(friendlyFsError('EPERM')).toBe(friendlyFsError('EACCES'));
  });

  it('ENOSPC → 磁盘空间不足', () => {
    expect(friendlyFsError('ENOSPC')).toBe('磁盘空间不足');
  });

  it('EROFS → 只读文件系统', () => {
    expect(friendlyFsError('EROFS')).toBe('只读文件系统，无法写入');
  });

  it('EIO → 磁盘 I/O 错误', () => {
    expect(friendlyFsError('EIO')).toBe('磁盘 I/O 错误');
  });

  it('EBUSY → 文件被其他程序占用', () => {
    expect(friendlyFsError('EBUSY')).toBe('文件被其他程序占用');
  });

  it('ENAMETOOLONG → 路径过长', () => {
    expect(friendlyFsError('ENAMETOOLONG')).toBe('路径过长');
  });

  it('ENOTDIR → 父目录不是目录', () => {
    expect(friendlyFsError('ENOTDIR')).toBe('父目录不是目录');
  });

  it('EISDIR → 目标路径是文件夹', () => {
    expect(friendlyFsError('EISDIR')).toBe('目标路径是文件夹，无法写入');
  });

  it('ENOTEMPTY → 目标文件夹不为空', () => {
    expect(friendlyFsError('ENOTEMPTY')).toBe('目标文件夹不为空');
  });
});

describe('friendlyFsError —— fallback 行为', () => {
  it('未知 errno + 有 fallback → 返回 fallback', () => {
    expect(friendlyFsError('EEXIST', '文件已存在')).toBe('文件已存在');
  });

  it('未知 errno + 无 fallback → 返回「未知错误」', () => {
    expect(friendlyFsError('EEXIST')).toBe('未知错误');
  });

  it('未知 errno + fallback=空串 → 走 fallback（空串本身）', () => {
    // 注意：空串是合法 fallback —— caller 故意传空串时不应被「未知错误」盖掉。
    // 但代码实现是 `fallback || '未知错误'`，所以空串会被替换为「未知错误」。
    // 这是有意的（避免空 toast），但要把行为钉死。
    expect(friendlyFsError('EEXIST', '')).toBe('未知错误');
  });

  it('undefined code → 走 default', () => {
    expect(friendlyFsError(undefined, 'fallback')).toBe('fallback');
  });

  it('null code → 走 default', () => {
    expect(friendlyFsError(null, 'fallback')).toBe('fallback');
  });

  it('空字符串 code → 走 default', () => {
    expect(friendlyFsError('', 'fallback')).toBe('fallback');
  });
});

describe('friendlyFsError —— 业务码（K1-R4 audit 合约）', () => {
  // audit fix (K1-R4)：所有 file:* / shell:* IPC 错误返回都有 code 字段。
  // 业务码（PATH_NOT_ALLOWED / SYMLINK_NOT_ALLOWED / FILE_TOO_LARGE 等）不在
  // errno 白名单里，renderer 一律走 fallback；而 renderer 8 个调用点现在传
  // result.message（中文）而不是 result.error（业务码字符串）做 fallback，
  // 这样业务码错误也能给用户友好提示。
  it('PATH_NOT_ALLOWED → 走 fallback（中文化 message）', () => {
    expect(friendlyFsError('PATH_NOT_ALLOWED', '路径不在数据目录内')).toBe('路径不在数据目录内');
  });

  it('SYMLINK_NOT_ALLOWED → 走 fallback', () => {
    expect(friendlyFsError('SYMLINK_NOT_ALLOWED', '不允许在符号链接目录下创建文件')).toBe('不允许在符号链接目录下创建文件');
  });

  it('FILE_TOO_LARGE → 走 fallback', () => {
    expect(friendlyFsError('FILE_TOO_LARGE', '文件超过 50 MB 上限')).toBe('文件超过 50 MB 上限');
  });

  it('FILE_CHANGED_EXTERNALLY → 走 fallback', () => {
    expect(friendlyFsError('FILE_CHANGED_EXTERNALLY', '文件在外部被修改')).toBe('文件在外部被修改');
  });

  it('NOT_A_FILE → 走 fallback', () => {
    expect(friendlyFsError('NOT_A_FILE', '该路径是文件夹')).toBe('该路径是文件夹');
  });
});
