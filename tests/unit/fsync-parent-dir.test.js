// main.js file:rename / folder:rename —— rename 后父目录 fsync（audit P1-6）
//
// 背景：fs.rename 在 POSIX 下只 fsync 自己的 inode，不 fsync 父目录的 directory entry。
// 崩溃时新名可能没落盘，恢复后看到的是「旧名 inode + 文件内容」。audit 要求
// 与 atomicWriteFile（main.js:1801-1809 模式）一致：rename 成功后对父目录做 fsync。
//
// 现状：folder:create 已经在 mkdir 后做了父目录 fsync（main.js:1854-1864），
// 但 file:rename（main.js:1986）和 folder:rename（main.js:2085）都没有。
//
// 修复：抽 fsyncParentDir(filePath, fsImpl?) helper → 打开父目录 → fsync → 关闭。
//  - win32 上 NTFS journal 自带元数据持久化，helper 直接 noop（与 folder:create 一致）
//  - fsImpl 注入便于单测：传 mock fsImpl，验证 open→sync→close 顺序与错误透传
//  - production 调用走 main.js 实际 import 的 fs（Node 内置）
//
// 测试策略：纯函数 + 注入 fsImpl。覆盖：
//   - POSIX 平台：open 父目录、sync 父 fh、close fh
//   - win32 平台：直接 noop（不动 fsImpl）
//   - open 失败透传错误
//   - sync 失败：仍执行 close（finally）
//   - close 失败：静默吞（与 folder:create 行为一致）

import { describe, it, expect, vi } from 'vitest';
import { fsyncParentDir } from '../../main/fsync-parent-dir.js';

function makeMockFs({ openOk = true, syncOk = true, closeOk = true } = {}) {
  const calls = [];
  const openErr = openOk ? null : Object.assign(new Error('EACCES'), { code: 'EACCES' });
  const syncErr = syncOk ? null : Object.assign(new Error('EIO'), { code: 'EIO' });
  const fh = {
    sync: vi.fn(async () => {
      calls.push({ kind: 'sync' });
      if (syncErr) throw syncErr;
    }),
    close: vi.fn(async () => {
      calls.push({ kind: 'close' });
      if (!closeOk) throw new Error('close-fail');
    }),
  };
  const fsImpl = {
    open: vi.fn(async (p, mode) => {
      calls.push({ kind: 'open', p, mode });
      if (openErr) throw openErr;
      return fh;
    }),
  };
  return { fsImpl, fh, calls, openErr, syncErr };
}

describe('fsyncParentDir（audit P1-6）', () => {
  it('POSIX：open 父目录 → sync → close，顺序正确', async () => {
    const { fsImpl, fh, calls } = makeMockFs();
    const r = await fsyncParentDir('/data/notes/foo.md', { fsImpl, platform: 'linux' });
    expect(r).toEqual({ ok: true });
    // open 父目录（不是文件本身）
    expect(fsImpl.open).toHaveBeenCalledTimes(1);
    expect(fsImpl.open).toHaveBeenCalledWith('/data/notes', 'r');
    // sync + close 都触发
    expect(fh.sync).toHaveBeenCalledTimes(1);
    expect(fh.close).toHaveBeenCalledTimes(1);
    // 顺序：open → sync → close
    expect(calls.map((c) => c.kind)).toEqual(['open', 'sync', 'close']);
  });

  it('win32：直接 noop，不调用 fsImpl', async () => {
    const { fsImpl, fh } = makeMockFs();
    const r = await fsyncParentDir('C:\\data\\notes\\foo.md', { fsImpl, platform: 'win32' });
    expect(r).toEqual({ ok: true, skipped: 'win32' });
    expect(fsImpl.open).not.toHaveBeenCalled();
    expect(fh.sync).not.toHaveBeenCalled();
    expect(fh.close).not.toHaveBeenCalled();
  });

  it('open 失败：透传错误，sync/close 不触发', async () => {
    const { fsImpl, fh } = makeMockFs({ openOk: false });
    const r = await fsyncParentDir('/data/notes/foo.md', { fsImpl, platform: 'linux' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('EACCES');
    expect(r.code).toBe('EACCES');
    expect(fh.sync).not.toHaveBeenCalled();
    expect(fh.close).not.toHaveBeenCalled();
  });

  it('sync 失败：finally 仍执行 close', async () => {
    const { fsImpl, fh, calls } = makeMockFs({ syncOk: false });
    const r = await fsyncParentDir('/data/notes/foo.md', { fsImpl, platform: 'linux' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('EIO');
    // close 仍触发（避免 fh 泄漏）
    expect(fh.close).toHaveBeenCalledTimes(1);
    expect(calls.map((c) => c.kind)).toEqual(['open', 'sync', 'close']);
  });

  it('close 失败：静默吞（与 folder:create 行为一致）', async () => {
    const { fsImpl, fh } = makeMockFs({ closeOk: false });
    const r = await fsyncParentDir('/data/notes/foo.md', { fsImpl, platform: 'linux' });
    // close 失败不抛、不计入返回值（folder:create 模式 try/catch close）
    expect(r.ok).toBe(true);
    expect(fh.close).toHaveBeenCalledTimes(1);
  });

  it('根目录边界：parent = "/" 时仍能 open（POSIX 允许）', async () => {
    const { fsImpl } = makeMockFs();
    const r = await fsyncParentDir('/foo.md', { fsImpl, platform: 'linux' });
    expect(r.ok).toBe(true);
    expect(fsImpl.open).toHaveBeenCalledWith('/', 'r');
  });

  it('默认 platform/process：未指定时用 process.platform', async () => {
    const { fsImpl } = makeMockFs();
    // 不传 platform → 走 process.platform
    const r = await fsyncParentDir('/data/notes/foo.md', { fsImpl });
    // 在 linux 容器（CI）上 process.platform === 'linux' → 正常 open
    if (process.platform === 'win32') {
      expect(r).toEqual({ ok: true, skipped: 'win32' });
    } else {
      expect(r.ok).toBe(true);
      expect(fsImpl.open).toHaveBeenCalledWith('/data/notes', 'r');
    }
  });

  it('路径为相对路径：parent 用 path.dirname 解出', async () => {
    const { fsImpl } = makeMockFs();
    const r = await fsyncParentDir('notes/sub/foo.md', { fsImpl, platform: 'linux' });
    expect(r.ok).toBe(true);
    // path.dirname('notes/sub/foo.md') === 'notes/sub'
    expect(fsImpl.open).toHaveBeenCalledWith('notes/sub', 'r');
  });
});
