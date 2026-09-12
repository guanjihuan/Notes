// shared/slug.js 的单测
//
// 这是 preload.js 与 src/outline.js 共用的 heading slug 算法唯一事实源。
// 改算法 = 同步改这里 + preload.js + src/outline.js + tests/unit/outline.test.js。

import { describe, it, expect } from 'vitest';
import {
  slugifyHeadingBase,
  slugifyHeading,
} from '../../shared/slug.js';

describe('slugifyHeadingBase', () => {
  it('空字符串 → 空串（slugifyHeading 才回退 section）', () => {
    expect(slugifyHeadingBase('')).toBe('');
  });

  it('空白字符串 → 空串', () => {
    expect(slugifyHeadingBase('   ')).toBe('');
  });

  it('纯符号 → 空串（兜底由带去重的 slugifyHeading 提供）', () => {
    // 这里只测「基础 slug」——空结果由调用方决定是跳过还是兜底为 'section'。
    expect(slugifyHeadingBase('!@#$')).toBe('');
  });

  it('基础小写化 + 空格变 -', () => {
    expect(slugifyHeadingBase('Hello World')).toBe('hello-world');
  });

  it('CJK 保留（基本平面 0x4E00-0x9FFF）', () => {
    expect(slugifyHeadingBase('你好世界')).toBe('你好世界');
  });

  it('下划线被洗掉（_ 在 [`*_~] 字符集里，连同行内标点一起剥）', () => {
    expect(slugifyHeadingBase('hello_world')).toBe('helloworld');
    expect(slugifyHeadingBase('foo_bar_baz')).toBe('foobarbaz');
  });

  it('行内 HTML 标签被剥离', () => {
    expect(slugifyHeadingBase('Hello <em>x</em>')).toBe('hello-x');
    expect(slugifyHeadingBase('<span class="x">A</span> B')).toBe('a-b');
  });

  it('行内 markdown 标记符号被剥离', () => {
    expect(slugifyHeadingBase('Hello *World*')).toBe('hello-world');
    expect(slugifyHeadingBase('Hello `code`')).toBe('hello-code');
    expect(slugifyHeadingBase('Hello _em_')).toBe('hello-em');
    expect(slugifyHeadingBase('Hello ~~del~~')).toBe('hello-del');
  });

  it('连续空白合并为单个 -', () => {
    expect(slugifyHeadingBase('foo   bar  baz')).toBe('foo-bar-baz');
    expect(slugifyHeadingBase('  a  b  ')).toBe('a-b');
  });

  it('标点 / 引号被洗掉', () => {
    expect(slugifyHeadingBase('A & B!')).toBe('a-b');
    expect(slugifyHeadingBase('foo "bar" baz')).toBe('foo-bar-baz');
    expect(slugifyHeadingBase('foo/bar')).toBe('foobar');
    expect(slugifyHeadingBase('foo:bar')).toBe('foobar');
  });

  it('首尾 - 不裁剪（与 marked 旧默认一致）', () => {
    expect(slugifyHeadingBase('--foo--bar--')).toBe('--foo--bar--');
  });

  it('数字开头保留', () => {
    expect(slugifyHeadingBase('123 abc')).toBe('123-abc');
  });

  it('组合记号保留（拉丁语族 / 越南语等）', () => {
    // \p{M} 应保留 combining marks
    expect(slugifyHeadingBase('café')).toBe('café');
    expect(slugifyHeadingBase('naïve résumé')).toBe('naïve-résumé');
  });

  it('非字符串输入用 toString 兜底（不抛错）', () => {
    // 数字正常字符串化；null/undefined 在 String() 后是 'null'/'undefined'，
    // 不会触发 section 兜底——因为这里只看 trim 后的非空判断。
    expect(slugifyHeadingBase(123)).toBe('123');
    expect(slugifyHeadingBase(null)).toBe('null');
    expect(slugifyHeadingBase(undefined)).toBe('undefined');
  });
});

describe('slugifyHeading 重复检测', () => {
  it('同名 heading 加 -1 / -2 后缀', () => {
    const seen = new Set();
    expect(slugifyHeading('Same', seen)).toBe('same');
    expect(slugifyHeading('Same', seen)).toBe('same-1');
    expect(slugifyHeading('Same', seen)).toBe('same-2');
  });

  it('带标记的同名也会撞后缀（标记先剥）', () => {
    const seen = new Set();
    expect(slugifyHeading('Title', seen)).toBe('title');
    // 同样算 'title' → 撞 'title'（已存在），得 'title-1'
    expect(slugifyHeading('**Title**', seen)).toBe('title-1');
    // 'Title *bold*' 剥标记 + 小写化后变 'title bold' → 'title-bold'，与 'title' 不同
    expect(slugifyHeading('Title *bold*', seen)).toBe('title-bold');
  });

  it('空 Set / 清空后重置计数', () => {
    const seen = new Set();
    slugifyHeading('foo', seen);
    slugifyHeading('foo', seen);
    seen.clear();
    expect(slugifyHeading('foo', seen)).toBe('foo');
  });

  it('不同 slug 不互相干扰', () => {
    const seen = new Set();
    expect(slugifyHeading('A', seen)).toBe('a');
    expect(slugifyHeading('B', seen)).toBe('b');
    expect(slugifyHeading('A', seen)).toBe('a-1');
    expect(slugifyHeading('B', seen)).toBe('b-1');
  });

  it('空 base 在带去重的 slugifyHeading 里回退为 section', () => {
    // 纯符号 heading 走 slugifyHeading 也能得到非空 id
    const seen = new Set();
    expect(slugifyHeading('!@#$', seen)).toBe('section');
    expect(slugifyHeading('!!!', seen)).toBe('section-1');
  });
});