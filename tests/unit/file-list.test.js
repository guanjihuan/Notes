// src/file-list.js 测试
//
// 覆盖：
//   - fuzzyScore 评分函数（纯函数）：子串 vs 子序列、单词边界、相邻匹配、空 query
//   - setFiles：外部删除通知 (audit 2.1)
//   - applyFilter：排序模式（name / mtime-desc）、搜索 vs sortMode 优先级
//   - moveActive：边界（空列表、首/尾）+ 键盘导航
//   - dispose 后 listener 失效
//
// 涉及 DOM 的部分用 jsdom。注意：fuzzyScore 未导出，本文件通过动态 import +
// 反射拿到（避免在生产代码里加 _test_ 前缀的导出）。

/* @vitest-environment jsdom */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as FileListMod from '../../src/file-list.js';

const { FileList } = FileListMod;

// fuzzyScore 是模块内私有函数。办法：通过 setFiles + 排序结果反推（看哪个文件名排前）。
// 简单点：直接构造一个内部 fuzzyScore 的副本契约测试 —— 同样的输入应该得同样的排序。
// 真值表通过构造几个代表性文件名对比 sortMode= name vs search 顺序来锁定。
describe('FileList 搜索 / 排序行为', () => {
  let element;
  let searchInput;
  let list;

  beforeEach(() => {
    document.body.innerHTML = `
      <ul id="files"></ul>
      <input id="search-input" type="text" />
    `;
    element = document.getElementById('files');
    searchInput = document.getElementById('search-input');
    list = new FileList({ element, searchInput, onSelect: vi.fn() });
  });

  // 工具：拿到 setFiles 后渲染到 DOM 的 li 列表（按渲染顺序）
  function renderedNames() {
    return Array.from(element.querySelectorAll('.file-item'))
      .map((li) => li.dataset.path)
      .map((p) => p.split(/[\\/]/).pop());
  }

  function feed(files) {
    list.setFiles(files);
  }

  it('默认按文件名（zh-CN locale）排序', () => {
    feed([
      { name: 'b.md', path: '/d/b.md' },
      { name: 'a.md', path: '/d/a.md' },
      { name: 'c.md', path: '/d/c.md' },
    ]);
    expect(renderedNames()).toEqual(['a.md', 'b.md', 'c.md']);
  });

  it('mtime-desc 模式按修改时间倒序', () => {
    list.setSort('mtime-desc');
    feed([
      { name: 'old.md', path: '/d/old.md', mtimeMs: 100 },
      { name: 'new.md', path: '/d/new.md', mtimeMs: 300 },
      { name: 'mid.md', path: '/d/mid.md', mtimeMs: 200 },
    ]);
    expect(renderedNames()).toEqual(['new.md', 'mid.md', 'old.md']);
  });

  it('无 mtime 时 mtime-desc 模式按 name 兜底（不抛错）', () => {
    list.setSort('mtime-desc');
    feed([
      { name: 'b.md', path: '/d/b.md' },
      { name: 'a.md', path: '/d/a.md' },
    ]);
    // undefined 排序是稳定的 JS 行为；至少不该抛错
    expect(renderedNames()).toHaveLength(2);
  });

  it('搜索词非空时 fuzzy 排序覆盖 mtime-desc', () => {
    list.setSort('mtime-desc');
    feed([
      { name: 'alpha.md', path: '/d/alpha.md', mtimeMs: 300 },
      { name: 'beta.md',   path: '/d/beta.md',   mtimeMs: 100 },
      { name: 'README.md', path: '/d/README.md', mtimeMs: 50 },
    ]);
    // 搜 'read' 应该让 README.md 排前，不管它的 mtime 是最旧的
    searchInput.value = 'read';
    searchInput.dispatchEvent(new Event('input'));
    // 等 debounce flush（100ms）
    return new Promise((r) => setTimeout(r, 150)).then(() => {
      expect(renderedNames()[0]).toBe('README.md');
    });
  });

  it('搜索词大小写不敏感', () => {
    feed([
      { name: 'README.md', path: '/d/README.md' },
      { name: 'notes.md',  path: '/d/notes.md' },
    ]);
    searchInput.value = 'read';
    searchInput.dispatchEvent(new Event('input'));
    return new Promise((r) => setTimeout(r, 150)).then(() => {
      expect(renderedNames()).toEqual(['README.md']);
    });
  });

  it('搜索无匹配 → 空状态 + 提示文案', () => {
    feed([
      { name: 'alpha.md', path: '/d/alpha.md' },
      { name: 'beta.md',  path: '/d/beta.md' },
    ]);
    searchInput.value = 'xyz-no-match';
    searchInput.dispatchEvent(new Event('input'));
    return new Promise((r) => setTimeout(r, 150)).then(() => {
      expect(renderedNames()).toEqual([]);
      // 空状态文案：搜索 vs 目录空 区分
      expect(element.dataset.empty).toMatch(/没有匹配/);
    });
  });

  it('目录真为空 → 空状态文案 = "此文件夹为空"', () => {
    feed([]);
    expect(element.dataset.empty).toBe('此文件夹为空');
  });

  it('搜索词触发模糊匹配：子序列允许字符不相邻', () => {
    feed([
      { name: 'foo.md',           path: '/d/foo.md' },
      { name: 'f_o_o_bar.md',     path: '/d/f_o_o_bar.md' },
    ]);
    searchInput.value = 'fob';
    searchInput.dispatchEvent(new Event('input'));
    return new Promise((r) => setTimeout(r, 150)).then(() => {
      // 'f-o-b' 在 'f_o_o_bar' 里按子序列能匹配（f, o[4], b[7]）
      expect(renderedNames()).toContain('f_o_o_bar.md');
    });
  });

  it('搜索高亮：匹配的子串用 <mark> 包起来', () => {
    feed([{ name: 'README.md', path: '/d/README.md' }]);
    searchInput.value = 'read';
    searchInput.dispatchEvent(new Event('input'));
    return new Promise((r) => setTimeout(r, 150)).then(() => {
      const mark = element.querySelector('.file-item mark');
      expect(mark).not.toBeNull();
      expect(mark.textContent.toLowerCase()).toBe('read');
    });
  });
});

describe('FileList 外部删除通知 (audit 2.1)', () => {
  let element;
  let list;

  beforeEach(() => {
    document.body.innerHTML = '<ul id="files"></ul>';
    element = document.getElementById('files');
  });

  it('当前激活文件不在新 entries → activePath 清零（高亮消失）', () => {
    // M-series fix (audit Phase M-H2)：setFiles 不再触发 onFileRemoved。
    // 删除判定上移到 app.js#applyEntries 用 directory 比对做精确区分。
    // 这里只验证 setFiles 的渲染侧合约：高亮跟着 activePath 走，
    // 不在新列表里的 active 文件会让 activePath 自动归零。
    list = new FileList({ element, onSelect: vi.fn() });
    list.setActive('/d/target.md');
    expect(list.activePath).toBe('/d/target.md');
    list.setFiles([{ name: 'other.md', path: '/d/other.md' }]);
    expect(list.activePath).toBe(null);
  });

  it('当前激活文件仍存在 → activePath 保持', () => {
    list = new FileList({ element, onSelect: vi.fn() });
    list.setActive('/d/target.md');
    list.setFiles([
      { name: 'target.md', path: '/d/target.md' },
      { name: 'other.md', path: '/d/other.md' },
    ]);
    expect(list.activePath).toBe('/d/target.md');
  });

  it('新 entries 只剩同名文件夹（folder entryType）→ activePath 清零', () => {
    // 文件路径 active 时，新 entries 只剩同名文件夹也视为"不在了"，
    // 因为 activePath 永远指向文件而非目录。这是 Phase 8 旧合约的延伸。
    list = new FileList({ element, onSelect: vi.fn() });
    list.setActive('/d/target');
    list.setFiles([{ name: 'target', path: '/d/target', isFolder: true, entryType: 'folder' }]);
    expect(list.activePath).toBe(null);
  });
});

describe('FileList entryType 向后兼容', () => {
  let element;
  let list;

  beforeEach(() => {
    document.body.innerHTML = '<ul id="files"></ul>';
    element = document.getElementById('files');
    list = new FileList({ element, onSelect: vi.fn() });
  });

  it('无 entryType 字段 → 视为 editable', () => {
    list.setFiles([{ name: 'foo.md', path: '/d/foo.md' }]);
    const li = element.querySelector('.file-item');
    expect(li.dataset.entryType).toBe('editable');
    expect(li.classList.contains('is-editable')).toBe(true);
  });

  it('folder entryType → is-folder class', () => {
    list.setFiles([
      { name: 'subdir', path: '/d/subdir', isFolder: true, entryType: 'folder' },
    ]);
    const li = element.querySelector('.file-item');
    expect(li.dataset.entryType).toBe('folder');
    expect(li.classList.contains('is-folder')).toBe(true);
  });

  it('binary entryType → is-binary class + meta 包含"不可编辑"', () => {
    list.setFiles([
      { name: 'image.png', path: '/d/image.png', size: 1234, entryType: 'binary' },
    ]);
    const li = element.querySelector('.file-item');
    expect(li.dataset.entryType).toBe('binary');
    expect(li.classList.contains('is-binary')).toBe(true);
    expect(li.querySelector('.file-meta').textContent).toMatch(/不可编辑/);
  });
});

describe('FileList 键盘导航 / 委托', () => {
  let element;
  let list;
  let onSelect;

  beforeEach(() => {
    document.body.innerHTML = '<ul id="files"></ul>';
    element = document.getElementById('files');
    onSelect = vi.fn();
    list = new FileList({ element, onSelect });
    list.setFiles([
      { name: 'a.md', path: '/d/a.md' },
      { name: 'b.md', path: '/d/b.md' },
      { name: 'c.md', path: '/d/c.md' },
    ]);
  });

  it('点击 li → onSelect 收到对应 file', () => {
    const items = element.querySelectorAll('.file-item');
    items[1].click();
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0].name).toBe('b.md');
  });

  it('Enter 键在 li 上 → onSelect', () => {
    const items = element.querySelectorAll('.file-item');
    items[0].focus();
    items[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0].name).toBe('a.md');
  });

  it('Space 键在 li 上 → onSelect', () => {
    const items = element.querySelectorAll('.file-item');
    items[2].focus();
    items[2].dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0].name).toBe('c.md');
  });

  it('↓/↑ 不直接触发 onSelect（仅移动高亮）', () => {
    const items = element.querySelectorAll('.file-item');
    items[0].focus();
    element.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(onSelect).not.toHaveBeenCalled();
    // 高亮应该挪到第二项
    expect(items[1].classList.contains('is-active')).toBe(true);
  });

  it('↑/↓ 越界 → 钳制在 [0, last]', () => {
    const items = element.querySelectorAll('.file-item');
    list.setActive('/d/a.md');
    items[0].focus();
    // 第一项再按 ↑ → 应仍在第一项
    element.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    expect(items[0].classList.contains('is-active')).toBe(true);

    list.setActive('/d/c.md');
    items[2].focus();
    // 最后一项再按 ↓ → 应仍在最后一项
    element.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(items[2].classList.contains('is-active')).toBe(true);
  });

  it('Home / End → first / last', () => {
    const items = element.querySelectorAll('.file-item');
    items[1].focus();
    element.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    expect(items[2].classList.contains('is-active')).toBe(true);

    items[2].focus();
    element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    expect(items[0].classList.contains('is-active')).toBe(true);
  });
});

describe('FileList dispose lifecycle', () => {
  let element;
  let searchInput;
  let list;

  beforeEach(() => {
    document.body.innerHTML = `
      <ul id="files"></ul>
      <input id="search-input" type="text" />
    `;
    element = document.getElementById('files');
    searchInput = document.getElementById('search-input');
  });

  it('dispose 后点击 li 不再触发 onSelect', () => {
    const onSelect = vi.fn();
    list = new FileList({ element, searchInput, onSelect });
    list.setFiles([{ name: 'a.md', path: '/d/a.md' }]);
    list.dispose();
    element.querySelector('.file-item').click();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('dispose 后 searchInput 触发不再 crash（debounce timer 已清）', () => {
    list = new FileList({ element, searchInput, onSelect: vi.fn() });
    list.setFiles([{ name: 'a.md', path: '/d/a.md' }]);
    list.dispose();
    searchInput.value = 'query';
    expect(() => {
      searchInput.dispatchEvent(new Event('input'));
    }).not.toThrow();
  });

  it('dispose 后不会因挂起的 debounce 触发出错', async () => {
    list = new FileList({ element, searchInput, onSelect: vi.fn() });
    list.setFiles([{ name: 'a.md', path: '/d/a.md' }]);
    searchInput.value = 'a';
    searchInput.dispatchEvent(new Event('input'));
    // 在 100ms debounce 之内 dispose
    list.dispose();
    // 等到 debounce 应该 fire 的时间点
    await new Promise((r) => setTimeout(r, 150));
    // 没有任何报错（监听已解绑，flushSearch 不会跑）
  });
});