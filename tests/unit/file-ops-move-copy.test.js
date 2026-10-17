// src/file-ops.js —— moveEntry / copyEntry / _applyMoveToOpenFile 单测
//
// 覆盖：
//   - moveEntry 成功：toast「已移动到」 + 当前打开文件被移动后 path/name/mtime/size 同步
//     （state.currentFile、lastSavedMtimeMs、fileList.setActive、viewer.setFileMeta、
//      updateWindowTitle、callbacks.onFileChanged 都收口到新路径）
//   - moveEntry 失败：toast「移动失败」且不篡改 state.currentFile
//   - copyEntry 成功：toast「已复制到」且**不**动当前打开文件 / 不 setActive
//   - copyEntry 失败：toast「复制失败」
//
// 渲染端模块带 DOM 依赖，这里用 vi.mock 把 feedback / prompt-dialog /
// confirm-dialog / utils / rescue / dirty-sync 全部打桩，只验证 move/copy 分支。

/* @vitest-environment jsdom */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// 打桩渲染端依赖，避免拉入 DOM-heavy 模块
vi.mock('../../src/feedback.js', () => ({ showToast: vi.fn() }));
vi.mock('../../src/prompt-dialog.js', () => ({ showPromptDialog: vi.fn() }));
vi.mock('../../src/confirm-dialog.js', () => ({ showConfirmDialog: vi.fn() }));
vi.mock('../../src/utils.js', () => ({ isMarkdownFile: () => true }));
vi.mock('../../src/rescue.js', () => ({ rescueDirtyContent: vi.fn() }));
vi.mock('../../src/dirty-sync.js', () => ({ syncDirtyFromEditor: vi.fn() }));

const { createFileOps } = await import('../../src/file-ops.js');
const { showToast } = await import('../../src/feedback.js');

function makeCtx(overrides = {}) {
  const mockApi = {
    moveFile: vi.fn(async () => ({ ok: true, path: '/d/sub/note.md', name: 'note.md', entryType: 'file', mtimeMs: 123, size: 10 })),
    copyFile: vi.fn(async () => ({ ok: true, path: '/d/sub/note.md', name: 'note.md', entryType: 'file', mtimeMs: 123, size: 10 })),
    friendlyFsError: (code, msg) => (msg ? `${msg}（${code}）` : String(code)),
  };
  const ctx = {
    state: {
      currentFile: { path: '/d/note.md', name: 'note.md', mtimeMs: 1, size: 5 },
      currentFileIsMarkdown: true,
      lastSavedMtimeMs: 1,
      clipboard: null,
      currentDir: '/d',
    },
    controls: {
      contextMenu: { show: vi.fn() },
      viewer: { setFileMeta: vi.fn() },
      fileList: { setActive: vi.fn() },
    },
    api: mockApi,
    callbacks: {
      openFile: vi.fn(),
      updateWindowTitle: vi.fn(),
      updateStatusStats: vi.fn(),
      syncSaveButton: vi.fn(),
      clearCurrentFile: vi.fn(),
      applyEditorMode: vi.fn(),
      onFileChanged: vi.fn(),
      onCut: vi.fn(),
      onCopy: vi.fn(),
      onPaste: vi.fn(),
    },
  };
  // file-ops 同时依赖全局 window.api.friendlyFsError
  globalThis.window = { api: mockApi };
  Object.assign(ctx, overrides);
  return ctx;
}

describe('moveEntry / copyEntry', () => {
  beforeEach(() => {
    showToast.mockClear();
  });

  it('moveEntry 成功：toast + 当前打开文件 path 同步到新目录', async () => {
    const ctx = makeCtx();
    const ops = createFileOps(ctx);
    const entry = { path: '/d/note.md', name: 'note.md', entryType: 'file' };

    const result = await ops.moveEntry(entry, '/d/sub');

    expect(result.ok).toBe(true);
    expect(showToast).toHaveBeenCalledWith('已移动到：note.md', 'success', 1500);
    // 当前打开文件即被移动的文件 → state 同步
    expect(ctx.state.currentFile.path).toBe('/d/sub/note.md');
    expect(ctx.state.currentFile.name).toBe('note.md');
    expect(ctx.state.currentFile.mtimeMs).toBe(123);
    expect(ctx.state.currentFile.size).toBe(10);
    expect(ctx.state.lastSavedMtimeMs).toBe(123);
    expect(ctx.controls.fileList.setActive).toHaveBeenCalledWith('/d/sub/note.md');
    expect(ctx.controls.viewer.setFileMeta).toHaveBeenCalled();
    expect(ctx.callbacks.updateWindowTitle).toHaveBeenCalled();
    expect(ctx.callbacks.onFileChanged).toHaveBeenCalledWith(ctx.state.currentFile);
  });

  it('moveEntry 成功：被移动的不是当前打开文件 → 不触发 setActive / onFileChanged', async () => {
    const ctx = makeCtx();
    const ops = createFileOps(ctx);
    const entry = { path: '/d/other.md', name: 'other.md', entryType: 'file' };

    await ops.moveEntry(entry, '/d/sub');

    expect(ctx.controls.fileList.setActive).not.toHaveBeenCalled();
    expect(ctx.callbacks.onFileChanged).not.toHaveBeenCalled();
    // 当前打开文件保持不变
    expect(ctx.state.currentFile.path).toBe('/d/note.md');
    expect(ctx.callbacks.updateWindowTitle).not.toHaveBeenCalled();
  });

  it('moveEntry 失败：toast「移动失败」且不动 state.currentFile', async () => {
    const ctx = makeCtx();
    ctx.api.moveFile = vi.fn(async () => ({ ok: false, code: 'EACCES', message: '没有访问权限' }));
    globalThis.window = { api: ctx.api };
    const ops = createFileOps(ctx);
    const entry = { path: '/d/note.md', name: 'note.md', entryType: 'file' };

    const result = await ops.moveEntry(entry, '/d/sub');

    expect(result.ok).toBe(false);
    expect(showToast).toHaveBeenCalledWith('移动失败：没有访问权限（EACCES）', 'error');
    expect(ctx.state.currentFile.path).toBe('/d/note.md');
    expect(ctx.controls.fileList.setActive).not.toHaveBeenCalled();
  });

  it('copyEntry 成功：toast + 不改动当前打开文件 / 不 setActive', async () => {
    const ctx = makeCtx();
    const ops = createFileOps(ctx);
    const entry = { path: '/d/note.md', name: 'note.md', entryType: 'file' };

    const result = await ops.copyEntry(entry, '/d/sub');

    expect(result.ok).toBe(true);
    expect(showToast).toHaveBeenCalledWith('已复制到：note.md', 'success', 1500);
    // 复制源不变
    expect(ctx.state.currentFile.path).toBe('/d/note.md');
    expect(ctx.controls.fileList.setActive).not.toHaveBeenCalled();
    expect(ctx.callbacks.updateWindowTitle).not.toHaveBeenCalled();
    expect(ctx.callbacks.onFileChanged).not.toHaveBeenCalled();
  });

  it('copyEntry 失败：toast「复制失败」', async () => {
    const ctx = makeCtx();
    ctx.api.copyFile = vi.fn(async () => ({ ok: false, code: 'ENOSPC', message: '磁盘空间不足' }));
    globalThis.window = { api: ctx.api };
    const ops = createFileOps(ctx);
    const entry = { path: '/d/note.md', name: 'note.md', entryType: 'file' };

    const result = await ops.copyEntry(entry, '/d/sub');

    expect(result.ok).toBe(false);
    expect(showToast).toHaveBeenCalledWith('复制失败：磁盘空间不足（ENOSPC）', 'error');
    expect(ctx.state.currentFile.path).toBe('/d/note.md');
  });

  it('moveEntry 飞行中设置 state.movingPath，成功后 finally 清空（fs-watcher 竞态守卫）', async () => {
    const ctx = makeCtx();
    let seenDuringFlight;
    ctx.api.moveFile = vi.fn(async () => {
      seenDuringFlight = ctx.state.movingPath;
      return { ok: true, path: '/d/sub/note.md', name: 'note.md', entryType: 'file', mtimeMs: 123, size: 10, relDir: 'sub' };
    });
    globalThis.window = { api: ctx.api };
    const ops = createFileOps(ctx);

    await ops.moveEntry({ path: '/d/note.md', name: 'note.md', entryType: 'file' }, '/d/sub');

    expect(seenDuringFlight).toBe('/d/note.md');
    expect(ctx.state.movingPath).toBeNull();
    // 移动文件本身 → currentFileRelDir 同步为 result.relDir
    expect(ctx.state.currentFileRelDir).toBe('sub');
  });

  it('moveEntry 失败同样清空 movingPath 守卫', async () => {
    const ctx = makeCtx();
    ctx.api.moveFile = vi.fn(async () => ({ ok: false, code: 'EACCES', message: '没有访问权限' }));
    globalThis.window = { api: ctx.api };
    const ops = createFileOps(ctx);

    await ops.moveEntry({ path: '/d/note.md', name: 'note.md', entryType: 'file' }, '/d/sub');

    expect(ctx.state.movingPath).toBeNull();
  });

  it('moveEntry 祖先文件夹被移动（重名避让改名）：新路径用 result.path 重拼、relDir 指向文件所在目录', async () => {
    const ctx = makeCtx();
    ctx.state.currentFile = { path: '/d/A/sub/note.md', name: 'note.md', mtimeMs: 7, size: 42 };
    ctx.state.currentFileRelDir = 'A/sub';
    // 移动 /d/A → /d/B，重名避让后实际落点 /d/B/A (2)
    ctx.api.moveFile = vi.fn(async () => ({
      ok: true, path: '/d/B/A (2)', name: 'A (2)', entryType: 'folder', relDir: 'B', mtimeMs: 123, size: 10,
    }));
    globalThis.window = { api: ctx.api };
    const ops = createFileOps(ctx);

    await ops.moveEntry({ path: '/d/A', name: 'A', entryType: 'folder' }, '/d/B');

    // 旧实现：destDir + remainder → 丢掉文件夹自身段，拼成 /d/B/sub/note.md（错）
    expect(ctx.state.currentFile.path).toBe('/d/B/A (2)/sub/note.md');
    expect(ctx.state.currentFile.name).toBe('note.md');
    // 旧实现：直接用 result.relDir='B'（被移动文件夹的新父目录，错）
    expect(ctx.state.currentFileRelDir).toBe('B/A (2)/sub');
    expect(ctx.controls.fileList.setActive).toHaveBeenCalledWith('/d/B/A (2)/sub/note.md');
  });

  it('moveEntry 祖先文件夹被移动（打开文件直接在文件夹下）：relDir = 新父/新名', async () => {
    const ctx = makeCtx();
    ctx.state.currentFile = { path: '/d/A/note.md', name: 'note.md', mtimeMs: 7, size: 42 };
    ctx.api.moveFile = vi.fn(async () => ({
      ok: true, path: '/d/B/A', name: 'A', entryType: 'folder', relDir: 'B', mtimeMs: 123, size: 10,
    }));
    globalThis.window = { api: ctx.api };
    const ops = createFileOps(ctx);

    await ops.moveEntry({ path: '/d/A', name: 'A', entryType: 'folder' }, '/d/B');

    expect(ctx.state.currentFile.path).toBe('/d/B/A/note.md');
    expect(ctx.state.currentFileRelDir).toBe('B/A');
  });

  it('moveEntry 祖先判定带分隔符边界：/d/A 移动不误伤打开文件 /d/Abc.md', async () => {
    const ctx = makeCtx();
    ctx.state.currentFile = { path: '/d/Abc.md', name: 'Abc.md', mtimeMs: 7, size: 42 };
    ctx.state.currentFileRelDir = '';
    // result.entryType folder 且 cfPath 与被移动文件夹共享前缀但不同目录
    ctx.api.moveFile = vi.fn(async () => ({
      ok: true, path: '/d/B/A', name: 'A', entryType: 'folder', relDir: 'B', mtimeMs: 123, size: 10,
    }));
    globalThis.window = { api: ctx.api };
    const ops = createFileOps(ctx);

    await ops.moveEntry({ path: '/d/A', name: 'A', entryType: 'folder' }, '/d/B');

    // 旧实现裸 startsWith('/d/A') 会误命中 '/d/Abc.md' 并把状态改坏
    expect(ctx.state.currentFile.path).toBe('/d/Abc.md');
    expect(ctx.state.currentFileRelDir).toBe('');
  });

  it('moveEntry / copyEntry 入参缺字段时直接返回 null', async () => {
    const ctx = makeCtx();
    const ops = createFileOps(ctx);
    expect(await ops.moveEntry(null, '/d/sub')).toBeNull();
    expect(await ops.moveEntry({ path: '/d/note.md' }, '')).toBeNull();
    expect(await ops.copyEntry(null, '/d/sub')).toBeNull();
    expect(ctx.api.moveFile).not.toHaveBeenCalled();
    expect(ctx.api.copyFile).not.toHaveBeenCalled();
  });
});
