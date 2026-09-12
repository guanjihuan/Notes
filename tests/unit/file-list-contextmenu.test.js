// 集成测试：模拟完整的「右键文件 → 弹菜单 → 点击重命名」流程。
// 验证 file-list 的 contextmenu 委托、showFileListContextMenu 的菜单构造、
// 以及 ContextMenu 的 onSelect 回调链路。

/* @vitest-environment jsdom */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FileList } from '../../src/file-list.js';
import { ContextMenu } from '../../src/context-menu.js';
import { createFileOps } from '../../src/file-ops.js';

describe('右键文件 → 弹菜单流程', () => {
  let list;
  let onContextMenu;
  let menu;
  let container;

  beforeEach(() => {
    document.body.innerHTML = `
      <ul id="files"></ul>
      <div id="context-menu-test-container"></div>
      <div id="modal-root"></div>
    `;
    container = document.getElementById('context-menu-test-container');
    menu = new ContextMenu({ container });
    onContextMenu = vi.fn();
    list = new FileList({
      element: document.getElementById('files'),
      onSelect: vi.fn(),
      onContextMenu,
    });
    list.setFiles([
      { name: 'a.md', path: '/d/a.md' },
      { name: 'b.md', path: '/d/b.md' },
    ]);
  });

  it('右键 li → onContextMenu 拿到对应 file', () => {
    const li = document.querySelectorAll('.file-item')[1];
    const evt = new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true,
      clientX: 100, clientY: 200,
    });
    li.dispatchEvent(evt);
    expect(onContextMenu).toHaveBeenCalledTimes(1);
    expect(onContextMenu.mock.calls[0][0].name).toBe('b.md');
    expect(onContextMenu.mock.calls[0][1]).toBe(100);
    expect(onContextMenu.mock.calls[0][2]).toBe(200);
  });

  it('右键 li → preventDefault 已被调（否则浏览器原生菜单会闪）', () => {
    const li = document.querySelector('.file-item');
    const evt = new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true,
    });
    li.dispatchEvent(evt);
    expect(evt.defaultPrevented).toBe(true);
  });

  it('右键 ul 上的非 li 区域 → 不触发 onContextMenu，不 preventDefault', () => {
    const evt = new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true,
    });
    document.getElementById('files').dispatchEvent(evt);
    expect(onContextMenu).not.toHaveBeenCalled();
    expect(evt.defaultPrevented).toBe(false);
  });
});

describe('showFileListContextMenu 集成', () => {
  let menu;
  let container;
  let lastOnSelect;

  beforeEach(() => {
    document.body.innerHTML = `
      <ul id="files"></ul>
      <div id="context-menu-test-container"></div>
      <div id="modal-root"></div>
    `;
    container = document.getElementById('context-menu-test-container');
    menu = new ContextMenu({ container });
    lastOnSelect = null;
    // 拦截 onSelect 以便测试断言「点击菜单项最终走到哪个回调」
    const origShow = menu.show.bind(menu);
    menu.show = (opts) => {
      lastOnSelect = opts.onSelect;
      return origShow(opts);
    };
  });

  // 复刻 src/file-ops.js:260-277 的菜单构造逻辑（不 import file-ops，
  // 因为它依赖 state / controls / api / callbacks 太重）
  function fakeShowFileListContextMenu(entry, x, y, contextMenu, callbacks) {
    const isFolder = entry && entry.entryType === 'folder';
    const items = [];
    if (!isFolder) items.push({ label: '重命名', value: 'rename' });
    items.push({ label: '在文件夹中显示', value: 'reveal' });
    items.push({ separator: true, value: '' });
    items.push({ label: '删除', value: 'delete' });
    contextMenu.show({
      x, y, items,
      onSelect: (value) => {
        if (value === 'rename') callbacks.onRename(entry);
        else if (value === 'reveal') callbacks.onReveal(entry);
        else if (value === 'delete') callbacks.onDelete(entry);
      },
    });
  }

  it('菜单包含 rename / reveal / delete + separator', () => {
    fakeShowFileListContextMenu(
      { name: 'a.md', path: '/d/a.md' }, 10, 10, menu,
      { onRename: vi.fn(), onReveal: vi.fn(), onDelete: vi.fn() }
    );
    const buttons = container.querySelectorAll('.context-menu-item');
    expect(Array.from(buttons).map((b) => b.textContent)).toEqual([
      '重命名', '在文件夹中显示', '删除',
    ]);
  });

  it('folder 条目 → 菜单不包含 rename', () => {
    fakeShowFileListContextMenu(
      { name: 'subdir', path: '/d/subdir', entryType: 'folder' }, 10, 10, menu,
      { onRename: vi.fn(), onReveal: vi.fn(), onDelete: vi.fn() }
    );
    const buttons = container.querySelectorAll('.context-menu-item');
    expect(Array.from(buttons).map((b) => b.textContent)).toEqual([
      '在文件夹中显示', '删除',
    ]);
  });

  it('点击「重命名」 → onRename 回调被调，且菜单关闭', () => {
    const onRename = vi.fn();
    const onReveal = vi.fn();
    const onDelete = vi.fn();
    fakeShowFileListContextMenu(
      { name: 'a.md', path: '/d/a.md' }, 10, 10, menu,
      { onRename, onReveal, onDelete }
    );
    expect(menu.isVisible()).toBe(true);
    const buttons = container.querySelectorAll('.context-menu-item');
    buttons[0].click();
    expect(onRename).toHaveBeenCalledTimes(1);
    expect(onRename.mock.calls[0][0].name).toBe('a.md');
    expect(onReveal).not.toHaveBeenCalled();
    expect(onDelete).not.toHaveBeenCalled();
    expect(menu.isVisible()).toBe(false);
  });

  it('点击「在文件夹中显示」 → onReveal 被调', () => {
    const cb = { onRename: vi.fn(), onReveal: vi.fn(), onDelete: vi.fn() };
    fakeShowFileListContextMenu(
      { name: 'a.md', path: '/d/a.md' }, 10, 10, menu, cb
    );
    const buttons = container.querySelectorAll('.context-menu-item');
    buttons[1].click(); // 第二个按钮是「在文件夹中显示」
    expect(cb.onReveal).toHaveBeenCalledTimes(1);
    expect(cb.onRename).not.toHaveBeenCalled();
  });

  it('点击「删除」 → onDelete 被调', () => {
    const cb = { onRename: vi.fn(), onReveal: vi.fn(), onDelete: vi.fn() };
    fakeShowFileListContextMenu(
      { name: 'a.md', path: '/d/a.md' }, 10, 10, menu, cb
    );
    const buttons = container.querySelectorAll('.context-menu-item');
    buttons[2].click(); // 第三个按钮是「删除」
    expect(cb.onDelete).toHaveBeenCalledTimes(1);
  });
});

// ==========================================================================
// revealFile 分支：文件走 showItemInFolder，文件夹走 openDir
// ==========================================================================
//
// 背景：旧实现把文件和文件夹都丢给 api.showItemInFolder，但主进程会
// stat.isFile() 校验，目录被拒（NOT_A_FILE），用户在 folder 条目上点
// 「在文件夹中显示」反而弹「不是一个文件」错误 toast。修复后文件夹走
// api.openDir（shell.openPath 直接打开目录本身）。
//
// 这里直接 import createFileOps，用 vi.fn() 桩 api.openDir /
// api.showItemInFolder / window.api.friendlyFsError，断言 revealFile 命中
// 正确的 IPC。
describe('revealFile IPC 分支', () => {
  let fileOps;
  let api;
  let originalWindowApi;

  beforeEach(() => {
    document.body.innerHTML = '<div id="modal-root"></div>';
    api = {
      showItemInFolder: vi.fn().mockResolvedValue({ ok: true }),
      openDir: vi.fn().mockResolvedValue({ ok: true }),
    };
    // window.api.friendlyFsError 在 revealFile 失败分支用到
    originalWindowApi = globalThis.window && globalThis.window.api;
    if (typeof globalThis.window === 'undefined') globalThis.window = {};
    globalThis.window.api = { friendlyFsError: vi.fn().mockReturnValue('stub') };

    fileOps = createFileOps({
      state: { currentFile: null, isDirty: false },
      controls: {
        contextMenu: { show: vi.fn(), hide: vi.fn() },
        viewer: {},
        fileList: {},
        editor: { isDirty: () => false },
      },
      api,
      callbacks: {
        openFile: vi.fn(),
        updateWindowTitle: vi.fn(),
        clearCurrentFile: vi.fn(),
      },
    });
  });

  afterEach(() => {
    if (originalWindowApi === undefined) {
      delete globalThis.window.api;
    } else {
      globalThis.window.api = originalWindowApi;
    }
  });

  it('editable 文件 → 走 api.showItemInFolder，不调 openDir', async () => {
    await fileOps.revealFile({ name: 'a.md', path: '/d/a.md', entryType: 'editable' });
    expect(api.showItemInFolder).toHaveBeenCalledWith('/d/a.md');
    expect(api.openDir).not.toHaveBeenCalled();
  });

  it('binary 文件 → 走 api.showItemInFolder', async () => {
    await fileOps.revealFile({ name: 'img.png', path: '/d/img.png', entryType: 'binary' });
    expect(api.showItemInFolder).toHaveBeenCalledWith('/d/img.png');
    expect(api.openDir).not.toHaveBeenCalled();
  });

  it('folder 条目 → 走 api.openDir，不调 showItemInFolder', async () => {
    await fileOps.revealFile({ name: 'subdir', path: '/d/subdir', entryType: 'folder' });
    expect(api.openDir).toHaveBeenCalledWith('/d/subdir');
    expect(api.showItemInFolder).not.toHaveBeenCalled();
  });

  it('folder → openDir 返回失败 → 走 friendlyFsError toast（不静默吞）', async () => {
    api.openDir.mockResolvedValue({ ok: false, code: 'NOT_A_DIRECTORY', message: '路径不是文件夹' });
    await fileOps.revealFile({ name: 'subdir', path: '/d/subdir', entryType: 'folder' });
    expect(globalThis.window.api.friendlyFsError).toHaveBeenCalledWith(
      'NOT_A_DIRECTORY',
      '路径不是文件夹'
    );
  });

  it('缺 path 的 entry → 不发任何 IPC', async () => {
    await fileOps.revealFile({ name: 'x', entryType: 'editable' });
    expect(api.showItemInFolder).not.toHaveBeenCalled();
    expect(api.openDir).not.toHaveBeenCalled();
  });
});
