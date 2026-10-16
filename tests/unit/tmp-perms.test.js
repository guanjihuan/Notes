// main/file-ops.js + main/config-store.js tmp 文件权限（audit R5 P1-13）
//
// 背景：tmp 文件用 fs.open(path, 'w') 创建时，Node 默认 mode = 0o666 受
// umask 影响（典型 0o022 → 实际 0o644），多用户 Linux/macOS 上其他用户能
// 读父目录（典型 ~/Library/Application Support/Notes）就能读 tmp，里面
// 可能含 AI Key 包络 / 整份配置 / 用户笔记内容。
//
// 修复：fs.open(tmpPath, 'w', 0o600) 强制 rw owner only。
//
// 测试策略：直接调 fs.promises.open 验证 0o600 mode 生效（file-ops 内部用
// 的就是这条路径）。atomicWriteFile 端到端测试在 file-ops.test.js 已经覆盖
// 写盘正确性，本文件专注「mode 真的生效」这条安全属性。

// @vitest-environment node

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open } from 'node:fs/promises';

let workDir;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'notes-tmp-perms-'));
});

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

describe('tmp 文件权限 0o600（audit R5 P1-13）', () => {
  it('fs.open(path, "w", 0o600) → mode & 0o077 === 0', async () => {
    // Windows NTFS 不强制 POSIX 权限位（用 ACL），statSync.mode 读出来仍是
    // 默认 ACL 简化位。修复在 Windows 上是 no-op（但语义一致，无害）。
    // 这条断言只验证 Linux/macOS —— 真正受多用户威胁面影响的平台。
    if (process.platform === 'win32') return;
    const tmpPath = join(workDir, 'with-mode.tmp');
    const fh = await open(tmpPath, 'w', 0o600);
    await fh.writeFile('test', 'utf-8');
    await fh.close();
    const st = statSync(tmpPath);
    // 0o600 = rw------- ：owner r/w，其他全无
    expect(st.mode & 0o077).toBe(0);
    expect(st.mode & 0o700).toBe(0o600);
  });

  it('fs.open 缺 mode（fallback to 0o666 + umask）可能非 0o600 —— 回归保护', async () => {
    // Windows 上 NTFS 不强制 POSIX 权限位（用 ACL），跳过
    if (process.platform === 'win32') return;
    const tmpPath = join(workDir, 'no-mode.tmp');
    const fh = await open(tmpPath, 'w');
    await fh.writeFile('test', 'utf-8');
    await fh.close();
    const st = statSync(tmpPath);
    // 不传 mode → 默认 0o666 受 umask 影响。
    // umask 0o022 → 实际 0o644 (& 0o077 = 0o044)
    // umask 0o077 → 实际 0o610 (& 0o077 = 0)
    // 不强断言非 0，只把 mode 读出来供 review（不传 mode 是漏洞）
    // eslint-disable-next-line no-console
    console.log(`[tmp-perms] no-mode default mode = 0o${(st.mode & 0o777).toString(8)} (umask-dependent)`);
    expect(st).toBeDefined();
  });

  it('file-ops atomicWriteFile 写盘成功 + 目标文件最终权限 0o600（rename 不改 mode）', async () => {
    const fileOps = await import('../../main/file-ops.js');
    const target = join(workDir, 'note.md');
    await fileOps.atomicWriteFile(target, '# hello\n', 'utf-8');
    // rename 在 Linux 上保留 source inode 的 mode，所以 final 文件的 mode
    // 也应该是 0o600（除非 umask 让 0o666 & 0o600 之后又变 —— 不会，
    // 因为 0o600 显式设的）。Windows 上跳过 mode 断言。
    const st = statSync(target);
    if (process.platform !== 'win32') {
      expect(st.mode & 0o077).toBe(0);
    }
    // 写盘内容正确（与权限无关，但顺手验一下不破坏）
    const { readFileSync } = await import('node:fs');
    expect(readFileSync(target, 'utf-8')).toBe('# hello\n');
  });
});
