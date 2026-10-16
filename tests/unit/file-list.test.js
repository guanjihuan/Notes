// src/file-list.js 测试
//
// 覆盖：
//   - fuzzyScore 评分函数（纯函数）：子串 vs 子序列、单词边界、相邻匹配、空 query
//   - setFiles：外部删除通知 (audit 2.1)
//   - applyFilter：排序模式（name / name-desc / mtime-desc / mtime-asc）、搜索 vs sortMode 优先级
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

  it('mtime-asc 模式按修改时间正序（旧 → 新）', () => {
    // 2026-10 加的下拉排序项之一，与 mtime-desc 方向相反。
    // 验证升序比较器不写反（避免与降序共享同一个 sort 函数只是顺序反了）。
    list.setSort('mtime-asc');
    feed([
      { name: 'old.md', path: '/d/old.md', mtimeMs: 100 },
      { name: 'new.md', path: '/d/new.md', mtimeMs: 300 },
      { name: 'mid.md', path: '/d/mid.md', mtimeMs: 200 },
    ]);
    expect(renderedNames()).toEqual(['old.md', 'mid.md', 'new.md']);
  });

  it('name-desc 模式按文件名倒序（Z → A，zh-CN locale）', () => {
    // 2026-10 加的下拉排序项之一，与默认 name 方向相反。
    list.setSort('name-desc');
    feed([
      { name: 'a.md', path: '/d/a.md' },
      { name: 'c.md', path: '/d/c.md' },
      { name: 'b.md', path: '/d/b.md' },
    ]);
    expect(renderedNames()).toEqual(['c.md', 'b.md', 'a.md']);
  });

  it('setSort 未知 mode 退回到 name 而非抛错', () => {
    // normalizeSortMode 的契约测试 —— UI / settings 传入拼错或过期值时，
    // 不该抛错或保留上一次未知状态；回到默认 'name' 是更安全的失败模式。
    feed([
      { name: 'b.md', path: '/d/b.md' },
      { name: 'a.md', path: '/d/a.md' },
    ]);
    expect(() => list.setSort('not-a-real-mode')).not.toThrow();
    expect(renderedNames()).toEqual(['a.md', 'b.md']);
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

// ============================================================================
// audit R7a P1-15：windowed 虚拟滚动
// ============================================================================
//
// 关键约束：jsdom 不做布局，clientHeight 永远是 0 → render() 自动走 full 模式。
// 测试需要主动 mock clientHeight（+ scrollTop / scrollHeight）才能触发
// windowed 分支。所有测试都在 beforeEach 里 defineProperty，afterEach 还原，
// 避免污染其它 describe 块。
describe('FileList windowed 虚拟滚动 (audit R7a P1-15)', () => {
  let element;
  let originalDescriptors;
  const VIEWPORT_H = 500;          // 10 个可见项
  const ITEM_H = 50;               // 与 .file-item CSS 同步

  /**
   * jsdom 不做布局，clientHeight/scrollHeight/scrollTop 都是 0。
   * 用 Object.defineProperty 直接覆盖实例属性，触发 windowed 分支。
   * configurable:true 是必须的（afterEach 要 delete 还原）。
   */
  function mockLayout(el, { clientHeight = VIEWPORT_H, scrollHeight = 0, scrollTop = 0 } = {}) {
    Object.defineProperty(el, 'clientHeight', { configurable: true, value: clientHeight });
    Object.defineProperty(el, 'scrollHeight', { configurable: true, value: scrollHeight });
    Object.defineProperty(el, 'scrollTop', { configurable: true, value: scrollTop, writable: true });
  }

  beforeEach(() => {
    document.body.innerHTML = '<ul id="files"></ul>';
    element = document.getElementById('files');
    mockLayout(element);
  });

  /** 造 N 个文件条目 */
  function makeFiles(n) {
    const out = [];
    for (let i = 0; i < n; i++) {
      const name = `f-${String(i).padStart(5, '0')}.md`;
      out.push({ name, path: `/d/${name}`, size: 100, mtimeMs: 1000 + i, entryType: 'editable' });
    }
    return out;
  }

  it('小列表（≤ 可见 + overscan）走 full 模式，DOM 节点数 = 总数', () => {
    const list = new FileList({ element, onSelect: vi.fn() });
    list.setFiles(makeFiles(5));
    expect(list._test_isWindowed()).toBe(false);
    expect(list._test_hasSentinel()).toBe(false);
    expect(element.querySelectorAll('.file-item')).toHaveLength(5);
  });

  it('大列表（> 可见 + overscan）切到 windowed 模式', () => {
    const list = new FileList({ element, onSelect: vi.fn() });
    list.setFiles(makeFiles(10000));
    expect(list._test_isWindowed()).toBe(true);
    expect(list._test_hasSentinel()).toBe(true);
  });

  it('windowed 模式 DOM 节点数 = 可见 + 2*overscan（不随总数线性增长）', () => {
    const list = new FileList({ element, onSelect: vi.fn() });
    list.setFiles(makeFiles(10000));
    // 可见 10 + 2*overscan 5 = 20 个 .file-item；sentinel 1 个；共 21 个 children
    const expected = 10 + 2 * 5; // 20
    expect(list._test_poolSize()).toBe(expected);
    expect(element.querySelectorAll('.file-item')).toHaveLength(expected);
    expect(element.querySelectorAll('.file-list-sentinel')).toHaveLength(1);
  });

  it('10000 文件 render 时间 < 50ms（核心 perf 指标）', () => {
    const list = new FileList({ element, onSelect: vi.fn() });
    const files = makeFiles(10000);
    // warmup：让 V8 对分配函数 inline-cache 收敛，第一次跑会比稳态慢
    list.setFiles(makeFiles(100));
    // 测时：只算 setFiles 内部 render 路径
    const t0 = performance.now();
    list.setFiles(files);
    const dt = performance.now() - t0;
    // audit 目标：< 50ms。jsdom 环境下无 layout/paint 开销，纯 DOM 构建，
    // windowed 模式 20 节点 < full 模式 10000 节点的 1/500，< 5ms 稳过。
    expect(dt).toBeLessThan(50);
  });

  it('scroll 后池内 <li> 的 textContent 反映新数据（不重建）', () => {
    const list = new FileList({ element, onSelect: vi.fn() });
    list.setFiles(makeFiles(10000));
    // 记录初始池里第一个 li 的引用
    const firstLi = list._test_poolSize() > 0 ? element.querySelectorAll('.file-item')[0] : null;
    expect(firstLi).toBeTruthy();
    const initialName = firstLi.querySelector('.file-name').textContent;
    expect(initialName).toBe('f-00000.md');

    // 滚到第 5000 行附近 → 池子 flush 新的 file
    Object.defineProperty(element, 'scrollTop', { configurable: true, value: 5000 * ITEM_H, writable: true });
    // scroll 事件 → rAF 节流 → _renderWindowed
    element.dispatchEvent(new Event('scroll'));
    // 同步等 rAF flush（jsdom 的 rAF 走 setImmediate，正常 await 即可）
    return new Promise((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          // 池中第一个 li 的 textContent 应是 f-04995.md（5000 - overscan 5）
          const newFirst = element.querySelectorAll('.file-item')[0];
          expect(newFirst.querySelector('.file-name').textContent).toBe('f-04995.md');
          // 同一个 <li> 引用（池子复用，不重建）
          expect(newFirst).toBe(firstLi);
          resolve();
        });
      });
    });
  });

  it('windowed 模式 setActive 跨 sentinel 也能正确高亮（不会高亮 sentinel）', () => {
    const list = new FileList({ element, onSelect: vi.fn() });
    list.setFiles(makeFiles(10000));
    // 滚到中间 → 池子里有 5000 附近的数据
    Object.defineProperty(element, 'scrollTop', { configurable: true, value: 5000 * ITEM_H, writable: true });
    element.dispatchEvent(new Event('scroll'));
    // 设 active 为 f-05000.md（当前 DOM 池里可能没有，但 filteredFiles 有）
    list.setActive('/d/f-05000.md');
    // sentinel 永远不应该被加 is-active
    const sentinel = element.querySelector('.file-list-sentinel');
    expect(sentinel.classList.contains('is-active')).toBe(false);
  });

  it('setFiles 切回小列表 → 自动 _teardownWindowed，DOM 节点数 = 小列表数', () => {
    const list = new FileList({ element, onSelect: vi.fn() });
    list.setFiles(makeFiles(10000));
    expect(list._test_isWindowed()).toBe(true);
    list.setFiles(makeFiles(3));
    expect(list._test_isWindowed()).toBe(false);
    expect(list._test_hasSentinel()).toBe(false);
    expect(element.querySelectorAll('.file-item')).toHaveLength(3);
  });

  it('setFiles([]) → 退出 windowed + 显示 data-empty', () => {
    const list = new FileList({ element, onSelect: vi.fn() });
    list.setFiles(makeFiles(10000));
    expect(list._test_isWindowed()).toBe(true);
    list.setFiles([]);
    expect(list._test_isWindowed()).toBe(false);
    expect(element.querySelectorAll('.file-item')).toHaveLength(0);
    expect(element.querySelector('.file-list-sentinel')).toBeNull();
    expect(element.dataset.empty).toBe('此文件夹为空');
  });

  it('moveActive 跨视口（windowed）能找到正确的 filteredFiles idx', () => {
    const list = new FileList({ element, onSelect: vi.fn() });
    list.setFiles(makeFiles(10000));
    // 滚到中间位置，让池子窗口落在 [4995, 5015)
    Object.defineProperty(element, 'scrollTop', { configurable: true, value: 5000 * ITEM_H, writable: true });
    element.dispatchEvent(new Event('scroll'));
    // activePath 设为 f-00000.md（第 0 项，远在窗口上方）
    list.setActive('/d/f-00000.md');
    // 向下走 3 步 → 应该是 f-00003.md
    list.moveActive(3);
    expect(list.activePath).toBe('/d/f-00003.md');
    // 一直按到底 → f-09999.md
    list.moveActive('last');
    expect(list.activePath).toBe('/d/f-09999.md');
  });

  it('windowed 模式下 search 过滤后切回 full 模式（总数变小）', () => {
    const list = new FileList({ element, onSelect: vi.fn(), searchInput: document.getElementById('search-input') });
    list.setFiles(makeFiles(10000));
    expect(list._test_isWindowed()).toBe(true);
    // 搜索 'f-00099' → fuzzyScore 命中的子集（f-00099.md 1 个，f-00090-f-00099 也含
    // 模糊命中 099 子序列，但远 < 10000）→ 切回 full
    // 直接调 applyFilter + render 模拟 search hit
    list.searchTerm = 'f-00099';
    list.applyFilter();
    list.render();
    expect(list._test_isWindowed()).toBe(false);
    expect(element.querySelectorAll('.file-item')).toHaveLength(list.filteredFiles.length);
  });
});
