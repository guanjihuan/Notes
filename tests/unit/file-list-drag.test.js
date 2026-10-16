// src/file-list.js —— 拖拽投放（drag → dragover → drop）事件委托单测
//
// 覆盖：
//   - 普通拖拽文件到文件夹：onDropIntoFolder(entry, folderEntry, { copy:false })
//   - 按住 Ctrl/Cmd 拖拽到文件夹：onDropIntoFolder(entry, folderEntry, { copy:true })
//   - 拖到非文件夹（文件）不放：不触发
//   - 文件夹拖到自己的子孙目录：视为非法目标，不触发
//
// jsdom 不原生支持 DragEvent 的 dataTransfer，这里手动给事件挂一个 dataTransfer 桩。

/* @vitest-environment jsdom */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as FileListMod from '../../src/file-list.js';

const { FileList } = FileListMod;

function makeDataTransfer() {
  return {
    data: {},
    effectAllowed: '',
    dropEffect: '',
    setData(type, val) { this.data[type] = String(val); },
    getData(type) { return this.data[type] || ''; },
  };
}

function fire(el, type, { ctrlKey = false, metaKey = false } = {}) {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  ev.dataTransfer = makeDataTransfer();
  // ctrlKey / metaKey 在 jsdom 的 Event 上只读，用 defineProperty 注入
  Object.defineProperty(ev, 'ctrlKey', { value: ctrlKey });
  Object.defineProperty(ev, 'metaKey', { value: metaKey });
  el.dispatchEvent(ev);
  return ev;
}

describe('FileList 拖拽投放', () => {
  let element;
  let list;
  let onDrop;

  beforeEach(() => {
    document.body.innerHTML = `<ul id="files"></ul>`;
    element = document.getElementById('files');
    onDrop = vi.fn();
    list = new FileList({ element, onSelect: vi.fn(), onDropIntoFolder: onDrop });
    list.setFiles([
      { name: 'note.md', path: '/d/note.md', entryType: 'file' },
      { name: 'sub', path: '/d/sub', entryType: 'folder' },
    ]);
  });

  function liFor(path) {
    // querySelector 里路径含 / 与中文，用属性选择器 + 转义；jsdom 无 CSS.escape，
    // 直接用 [data-path="..."]（路径不含引号，安全）并兜底到 find。
    return element.querySelector(`.file-item[data-path="${path}"]`)
      || Array.from(element.querySelectorAll('.file-item')).find((li) => li.dataset.path === path);
  }

  it('普通拖拽文件到文件夹 → 触发 move（copy:false）', () => {
    const fileLi = liFor('/d/note.md');
    const folderLi = liFor('/d/sub');
    fire(fileLi, 'dragstart');
    fire(folderLi, 'dragover');
    expect(folderLi.classList.contains('is-drop-target')).toBe(true);
    fire(folderLi, 'drop');

    expect(onDrop).toHaveBeenCalledTimes(1);
    const [dragged, target, opts] = onDrop.mock.calls[0];
    expect(dragged.path).toBe('/d/note.md');
    expect(target.path).toBe('/d/sub');
    expect(target.entryType).toBe('folder');
    expect(opts).toEqual({ copy: false });
  });

  it('按住 Ctrl 拖拽文件到文件夹 → 触发 copy（copy:true）', () => {
    const fileLi = liFor('/d/note.md');
    const folderLi = liFor('/d/sub');
    fire(fileLi, 'dragstart');
    fire(folderLi, 'dragover', { ctrlKey: true });
    fire(folderLi, 'drop', { ctrlKey: true });

    expect(onDrop).toHaveBeenCalledTimes(1);
    const [dragged, target, opts] = onDrop.mock.calls[0];
    expect(dragged.path).toBe('/d/note.md');
    expect(target.path).toBe('/d/sub');
    expect(opts).toEqual({ copy: true });
  });

  it('拖到非文件夹（文件）不放 → 不触发', () => {
    const fileLi = liFor('/d/note.md');
    fire(fileLi, 'dragstart');
    fire(fileLi, 'dragover'); // 拖到自己身上
    fire(fileLi, 'drop');

    expect(onDrop).not.toHaveBeenCalled();
    expect(fileLi.classList.contains('is-drop-target')).toBe(false);
  });

  it('文件夹拖到自身 → 非法目标，不触发', () => {
    const folderLi = liFor('/d/sub');
    fire(folderLi, 'dragstart');
    fire(folderLi, 'dragover');
    fire(folderLi, 'drop');

    expect(onDrop).not.toHaveBeenCalled();
  });

  it('文件夹拖到自己的子孙目录 → 非法目标，不触发', () => {
    list.setFiles([
      { name: 'A', path: '/d/A', entryType: 'folder' },
      { name: 'B', path: '/d/A/B', entryType: 'folder' },
    ]);
    const aLi = liFor('/d/A');
    const bLi = liFor('/d/A/B');
    fire(aLi, 'dragstart');
    fire(bLi, 'dragover');
    fire(bLi, 'drop');

    expect(onDrop).not.toHaveBeenCalled();
  });

  it('dragend 清空拖拽源状态', () => {
    const fileLi = liFor('/d/note.md');
    fire(fileLi, 'dragstart');
    expect(fileLi.classList.contains('is-dragging')).toBe(true);
    fire(fileLi, 'dragend');
    expect(fileLi.classList.contains('is-dragging')).toBe(false);
    expect(list._dragEntry).toBeNull();
  });
});

describe('FileList 空白区域右键菜单', () => {
  let element;
  let list;
  let onItem;
  let onEmpty;

  beforeEach(() => {
    document.body.innerHTML = `<ul id="files"></ul>`;
    element = document.getElementById('files');
    onItem = vi.fn();
    onEmpty = vi.fn();
    list = new FileList({
      element,
      onSelect: vi.fn(),
      onContextMenu: onItem,
      onContextMenuEmpty: onEmpty,
    });
    list.setFiles([
      { name: 'note.md', path: '/d/note.md', entryType: 'file' },
      { name: 'sub', path: '/d/sub', entryType: 'folder' },
    ]);
  });

  function rightClick(target, { x = 4, y = 6 } = {}) {
    const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y });
    target.dispatchEvent(ev);
  }

  function liFor(path) {
    return element.querySelector(`.file-item[data-path="${path}"]`)
      || Array.from(element.querySelectorAll('.file-item')).find((li) => li.dataset.path === path);
  }

  it('右键空白区域（ul 本身）→ 触发 onContextMenuEmpty，不触发 onContextMenu', () => {
    rightClick(element);
    expect(onEmpty).toHaveBeenCalledTimes(1);
    expect(onEmpty.mock.calls[0][0]).toBe(4);
    expect(onEmpty.mock.calls[0][1]).toBe(6);
    expect(onItem).not.toHaveBeenCalled();
  });

  it('右键具体条目 → 触发 onContextMenu，不触发 onContextMenuEmpty', () => {
    rightClick(liFor('/d/note.md'));
    expect(onItem).toHaveBeenCalledTimes(1);
    expect(onEmpty).not.toHaveBeenCalled();
  });

  it('未提供 onContextMenuEmpty 时，空白区域右键不报错也不弹菜单', () => {
    const ul = document.createElement('ul');
    document.body.appendChild(ul);
    const bare = new FileList({ element: ul, onSelect: vi.fn(), onContextMenu: vi.fn() });
    bare.setFiles([{ name: 'a.md', path: '/d/a.md', entryType: 'file' }]);
    expect(() => rightClick(ul)).not.toThrow();
  });
});
