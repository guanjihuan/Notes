// main/file-list-cache.js 单测（audit R7a P1-20）
//
// 覆盖：
//   - 首次 getOrBuild → 调 scanFn，结果缓存
//   - 同 dir 二次 getOrBuild → 命中缓存，不调 scanFn
//   - invalidate → 下次 getOrBuild 重扫
//   - dir 变化 → 重扫
//   - scanFn 返回 {ok:false} → 返回 {error} 不缓存
//   - files 字段只含非文件夹条目（兼容 state.files）
//   - peek / _setForTest 测试钩子

import { describe, it, expect, beforeEach } from 'vitest';

const cache = require('../../main/file-list-cache.js');

const ENTRIES_500 = Array.from({ length: 500 }, (_, i) => ({
  name: `f-${i}.md`,
  path: `/data/f-${i}.md`,
  entryType: 'editable',
  isFolder: false,
  size: 100,
  mtimeMs: 1000 + i,
}));

function scanFnMock(entries = ENTRIES_500) {
  return async (dir) => ({ ok: true, dir, entries });
}

beforeEach(() => {
  cache.invalidate();
  cache._setForTest(null);
});

describe('file-list-cache: 缓存命中 / 失效', () => {
  it('首次 getOrBuild 调 scanFn，结果缓存', async () => {
    let calls = 0;
    const scan = async (dir) => { calls += 1; return { ok: true, dir, entries: ENTRIES_500 }; };
    const r = await cache.getOrBuild('/data', scan);
    expect(calls).toBe(1);
    expect(r.entries).toHaveLength(500);
    expect(r.total).toBe(500);
    expect(r.files).toHaveLength(500);
    expect(r.dir).toBe('/data');
  });

  it('同 dir 二次 getOrBuild 命中缓存，不调 scanFn', async () => {
    let calls = 0;
    const scan = async (dir) => { calls += 1; return { ok: true, dir, entries: ENTRIES_500 }; };
    await cache.getOrBuild('/data', scan);
    await cache.getOrBuild('/data', scan);
    expect(calls).toBe(1);
  });

  it('invalidate → 下次 getOrBuild 重扫', async () => {
    let calls = 0;
    const scan = async (dir) => { calls += 1; return { ok: true, dir, entries: ENTRIES_500 }; };
    await cache.getOrBuild('/data', scan);
    expect(calls).toBe(1);
    cache.invalidate();
    await cache.getOrBuild('/data', scan);
    expect(calls).toBe(2);
  });

  it('dir 变化 → 重扫', async () => {
    let calls = 0;
    const scan = async (dir) => { calls += 1; return { ok: true, dir, entries: ENTRIES_500 }; };
    await cache.getOrBuild('/data', scan);
    await cache.getOrBuild('/other', scan);
    expect(calls).toBe(2);
  });

  it('scanFn 返回 {ok:false} → 返回 {error}，不缓存', async () => {
    let calls = 0;
    const scan = async () => {
      calls += 1;
      return { ok: false, error: 'DATA_DIR_NOT_FOUND', code: 'ENOENT' };
    };
    const r = await cache.getOrBuild('/missing', scan);
    expect(r.error).toBeTruthy();
    expect(r.error.ok).toBe(false);
    expect(r.error.code).toBe('ENOENT');
    expect(cache.peek()).toBeNull();
    // 下次再 getOrBuild 同 dir 仍会重扫（没缓存可命中）
    await cache.getOrBuild('/missing', scan);
    expect(calls).toBe(2);
  });
});

describe('file-list-cache: files 字段派生', () => {
  it('files 只含非文件夹条目（state.files 兼容）', async () => {
    const mixed = [
      { name: 'a.md', path: '/a', entryType: 'editable', isFolder: false, size: 1, mtimeMs: 1 },
      { name: 'sub', path: '/sub', entryType: 'folder', isFolder: true },
      { name: 'b.png', path: '/b', entryType: 'binary', isFolder: false, size: 2, mtimeMs: 2 },
    ];
    const scan = async (dir) => ({ ok: true, dir, entries: mixed });
    const r = await cache.getOrBuild('/data', scan);
    expect(r.entries).toHaveLength(3);
    expect(r.files).toHaveLength(2); // a.md + b.png
    expect(r.files.every((f) => !f.isFolder)).toBe(true);
  });

  it('files 字段投影 shape 与 renderer state.files 一致', async () => {
    const scan = scanFnMock();
    const r = await cache.getOrBuild('/data', scan);
    const sample = r.files[0];
    expect(sample).toHaveProperty('name');
    expect(sample).toHaveProperty('path');
    expect(sample).toHaveProperty('size');
    expect(sample).toHaveProperty('mtimeMs');
    expect(sample).toHaveProperty('entryType');
    // isFolder 故意不进 files（filter 已经移除）
    expect(sample).not.toHaveProperty('isFolder');
  });
});

describe('file-list-cache: peek / _setForTest', () => {
  it('peek 拿当前缓存（不改）', async () => {
    const scan = scanFnMock();
    await cache.getOrBuild('/data', scan);
    const snap = cache.peek();
    expect(snap.dir).toBe('/data');
    expect(snap.total).toBe(500);
    // 二次 peek 同一引用
    expect(cache.peek()).toBe(snap);
  });

  it('_setForTest 直接设缓存，getOrBuild 同 dir 命中', async () => {
    cache._setForTest({ dir: '/preset', entries: [], files: [], total: 0, at: 0 });
    let called = false;
    const scan = async () => { called = true; return { ok: true, dir: '/preset', entries: [] }; };
    const r = await cache.getOrBuild('/preset', scan);
    expect(called).toBe(false);
    expect(r.dir).toBe('/preset');
    expect(r.total).toBe(0);
  });
});

describe('file-list-cache: 分页一致性', () => {
  // 模拟 file:list handler 的使用方式：
  //   1) 首次 getOrBuild → 拿 entries
  //   2) slice(offset, offset+limit) → 返回第一页
  //   3) loadMore → 再次 slice(off+limit) → 不重扫（命中缓存）
  it('分页多次 slice 共享一次 scan（10000 文件 50 页）', async () => {
    const big = Array.from({ length: 10000 }, (_, i) => ({
      name: `n-${String(i).padStart(5, '0')}.md`,
      path: `/data/n-${i}.md`,
      entryType: 'editable',
      isFolder: false,
      size: 100,
      mtimeMs: 1000 + i,
    }));
    let calls = 0;
    const scan = async (dir) => { calls += 1; return { ok: true, dir, entries: big }; };

    // 首屏
    const r = await cache.getOrBuild('/data', scan);
    expect(r.total).toBe(10000);
    const limit = 200;
    const seen = [];
    for (let offset = 0; offset < r.total; offset += limit) {
      // 每次分页只 slice 缓存，不重扫
      const page = r.entries.slice(offset, offset + limit);
      seen.push(...page);
    }
    expect(calls).toBe(1); // 一次 scan，50 次 slice
    expect(seen).toHaveLength(10000);
    // 顺序保持（slice 不会重排）
    expect(seen[0].name).toBe('n-00000.md');
    expect(seen[9999].name).toBe('n-09999.md');
  });
});
