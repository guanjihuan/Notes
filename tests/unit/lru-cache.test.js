// P2-6（audit）：main/ai.js 的 pickOpenAITokenConfig / joinUrl 每次调用重复
// 正则解析。AI 流式期间同 model / 同 baseURL 反复命中，加 LRU 缓存省 CPU。
//
// 设计：main/lru-cache.js 通用 createLruCache({ maxSize }) →
//   get(key) / set(key, value) / has(key) / size
//   - Map 迭代序 = 插入序；get 命中时 delete+set 提到最新（LRU 语义）
//   - set 超 maxSize 时删最老（Map 第一个键）
//   - maxSize 默认 64

import { describe, it, expect } from 'vitest';
const { createLruCache } = require('../../main/lru-cache.js');

describe('createLruCache —— P2-6 通用 LRU', () => {
  it('set/get 往返', () => {
    const c = createLruCache({ maxSize: 4 });
    c.set('a', 1);
    expect(c.get('a')).toBe(1);
    expect(c.has('a')).toBe(true);
    expect(c.get('missing')).toBeUndefined();
    expect(c.has('missing')).toBe(false);
  });

  it('超 maxSize 删最老的键', () => {
    const c = createLruCache({ maxSize: 2 });
    c.set('a', 1);
    c.set('b', 2);
    c.set('c', 3); // a 应被挤掉
    expect(c.has('a')).toBe(false);
    expect(c.has('b')).toBe(true);
    expect(c.has('c')).toBe(true);
    expect(c.size).toBe(2);
  });

  it('get 命中提到最新，延缓被淘汰', () => {
    const c = createLruCache({ maxSize: 2 });
    c.set('a', 1);
    c.set('b', 2);
    c.get('a');      // a 提最新，b 变老
    c.set('c', 3);   // 挤掉 b 而非 a
    expect(c.has('a')).toBe(true);
    expect(c.has('b')).toBe(false);
  });

  it('重复 set 同键覆盖值且不增 size', () => {
    const c = createLruCache({ maxSize: 2 });
    c.set('a', 1);
    c.set('a', 2);
    expect(c.get('a')).toBe(2);
    expect(c.size).toBe(1);
  });

  it('重复 set 同键视为「使用」，提到最新', () => {
    const c = createLruCache({ maxSize: 2 });
    c.set('a', 1);
    c.set('b', 2);
    c.set('a', 9);   // a 提最新
    c.set('c', 3);   // 挤掉 b
    expect(c.get('a')).toBe(9);
    expect(c.has('b')).toBe(false);
  });

  it('默认 maxSize=64', () => {
    const c = createLruCache();
    for (let i = 0; i < 70; i++) c.set('k' + i, i);
    expect(c.size).toBe(64);
    expect(c.has('k0')).toBe(false);
    expect(c.has('k69')).toBe(true);
  });

  it('值可以是对象 / undefined 以外的任意类型', () => {
    const c = createLruCache({ maxSize: 4 });
    const obj = { x: 1 };
    c.set('o', obj);
    c.set('n', null);
    expect(c.get('o')).toBe(obj);
    expect(c.get('n')).toBeNull();
    expect(c.has('n')).toBe(true);
  });
});
