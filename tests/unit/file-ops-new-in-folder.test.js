// 渲染端 showFileListContextMenu 的「在文件夹中新建」项：
// 右键文件夹条目时，菜单顶部应出现「在文件夹中新建文件 / 新建文件夹」，
// 且选中后路由到 createNewFile / createNewFolder 并带上被右击文件夹的绝对路径
// 作为落点（targetDir）。文件条目则不应出现这组项。
//
// 同时覆盖 createNewFile/createNewFolder 的 targetDir 透传：
// 传 folder path 时主进程 createFile/createFolder 的 dir 等于该 path。

// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFileOps } from '../../src/file-ops.js';

// 桩 prompt / confirm（createNewFile 内部会弹，返回默认值即可跑通 IPC 路径）。
// confirm 仅在 state.isDirty 时触发，本测试 state.isDirty 恒为 false，不会走到。
vi.mock('../../src/prompt-dialog.js', () => ({
  showPromptDialog: async ({ defaultValue }) => defaultValue,
}));
vi.mock('../../src/confirm-dialog.js', () => ({
  showConfirmDialog: async () => 'confirm',
}));

function makeFileOps(apiCalls) {
  const contextMenu = { show: vi.fn() };
  const state = { currentFile: null, isDirty: false, breadcrumb: [] };
  const api = {
    createFile: vi.fn(async (name, opts) => {
      apiCalls.createFile = { name, opts };
      return { ok: true, name, path: `/d/${name}`, mtimeMs: 1, size: 1 };
    }),
    createFolder: vi.fn(async (name, opts) => {
      apiCalls.createFolder = { name, opts };
      return { ok: true, name, path: `/d/${name}`, mtimeMs: 1, size: 1 };
    }),
  };
  const ops = createFileOps({
    state,
    controls: {
      fileList: {},
      viewer: {},
      contextMenu,
      editor: { isDirty: () => false, getContent: () => '' },
    },
    api,
    callbacks: {
      openFile: vi.fn(),
      updateWindowTitle: vi.fn(),
      clearCurrentFile: vi.fn(),
      updateStatusStats: vi.fn(),
      syncSaveButton: vi.fn(),
      applyEditorMode: vi.fn(),
    },
  });
  return { ops, contextMenu };
}

describe('showFileListContextMenu 在文件夹中新建', () => {
  let apiCalls;
  let ops;
  let contextMenu;

  beforeEach(() => {
    apiCalls = {};
    ({ ops, contextMenu } = makeFileOps(apiCalls));
  });

  it('文件夹条目：顶部含「在文件夹中新建文件 / 新建文件夹」+ 分隔条', () => {
    ops.showFileListContextMenu({ name: 'sub', path: '/d/sub', entryType: 'folder' }, 10, 10);
    expect(contextMenu.show).toHaveBeenCalledTimes(1);
    const items = contextMenu.show.mock.calls[0][0].items;
    const labels = items.map((i) => i.label);
    expect(labels[0]).toBe('在文件夹中新建文件');
    expect(labels[1]).toBe('在文件夹中新建文件夹');
    expect(items[2]).toMatchObject({ separator: true });
    // 既有项仍在
    expect(labels).toContain('重命名');
    expect(labels).toContain('删除');
    expect(labels).toContain('粘贴');
  });

  it('文件条目：不出现「在文件夹中新建」项', () => {
    ops.showFileListContextMenu({ name: 'a.md', path: '/d/a.md', entryType: 'editable' }, 10, 10);
    const labels = contextMenu.show.mock.calls[0][0].items.map((i) => i.label);
    expect(labels).not.toContain('在文件夹中新建文件');
    expect(labels).not.toContain('在文件夹中新建文件夹');
  });

  it('文件夹右键「在文件夹中新建文件」→ createNewFile 落在该文件夹', async () => {
    ops.showFileListContextMenu({ name: 'sub', path: '/d/sub', entryType: 'folder' }, 10, 10);
    const { onSelect, items } = contextMenu.show.mock.calls[0][0];
    const item = items.find((i) => i.value === 'new_file_in');
    expect(item).toBeTruthy();
    await onSelect('new_file_in');
    expect(apiCalls.createFile).toBeDefined();
    expect(apiCalls.createFile.opts.dir).toBe('/d/sub');
  });

  it('文件夹右键「在文件夹中新建文件夹」→ createNewFolder 落在该文件夹', async () => {
    ops.showFileListContextMenu({ name: 'sub', path: '/d/sub', entryType: 'folder' }, 10, 10);
    const { onSelect } = contextMenu.show.mock.calls[0][0];
    await onSelect('new_folder_in');
    expect(apiCalls.createFolder).toBeDefined();
    expect(apiCalls.createFolder.opts.dir).toBe('/d/sub');
  });
});

describe('createNewFile / createNewFolder targetDir 透传', () => {
  it('createNewFile 不传 targetDir → dir 落当前浏览目录', async () => {
    const apiCalls = {};
    const { ops } = makeFileOps(apiCalls);
    // state.currentDir 默认空串 → dir 应为 ''（与旧行为一致）
    await ops.createNewFile();
    expect(apiCalls.createFile.opts.dir).toBe('');
  });

  it('createNewFile 传 targetDir → dir 等于该路径', async () => {
    const apiCalls = {};
    const { ops } = makeFileOps(apiCalls);
    await ops.createNewFile('/d/sub');
    expect(apiCalls.createFile.opts.dir).toBe('/d/sub');
  });

  it('createNewFolder 传 targetDir → dir 等于该路径', async () => {
    const apiCalls = {};
    const { ops } = makeFileOps(apiCalls);
    await ops.createNewFolder('/d/sub');
    expect(apiCalls.createFolder.opts.dir).toBe('/d/sub');
  });
});
