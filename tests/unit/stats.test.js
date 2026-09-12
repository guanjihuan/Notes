// Stage 7 tests: stats.js
//
// 覆盖：
//   - countWords：CJK 单字 + 拉丁词 + 混合 + 边界
//   - getTextStats：chars / words / lines 三个字段 + 空文档边界
//   - formatStatusStats：中文 locale + 0/1/N 行

import { describe, it, expect } from 'vitest';
import { countWords, getTextStats, formatStatusStats } from '../../src/stats.js';

describe('countWords', () => {
  it('空字符串 → 0', () => {
    expect(countWords('')).toBe(0);
  });

  it('纯空白 → 0', () => {
    expect(countWords('   \n  \t')).toBe(0);
  });

  it('null / undefined → 0', () => {
    expect(countWords(null)).toBe(0);
    expect(countWords(undefined)).toBe(0);
  });

  it('非字符串 → 0', () => {
    expect(countWords(42)).toBe(0);
    expect(countWords({})).toBe(0);
  });

  it('纯拉丁词按空格分', () => {
    expect(countWords('hello world foo bar')).toBe(4);
  });

  it('中文每个字算 1', () => {
    expect(countWords('你好世界')).toBe(4);
  });

  it('中日韩混合', () => {
    expect(countWords('Hello 你好 World 世界')).toBe(6); // 4 CJK + 2 latin
  });

  it('日文假名 + 韩文', () => {
    expect(countWords('こんにちは 안녕하세요')).toBe(10); // 5 hiragana + 5 hangul
  });

  it('标点不计数', () => {
    expect(countWords('!!! ??? ...')).toBe(0);
  });

  it('「hello-world」是一个词', () => {
    expect(countWords('hello-world')).toBe(1);
  });

  it('多行', () => {
    expect(countWords('first line\nsecond line\nthird line')).toBe(6);
  });
});

describe('getTextStats', () => {
  it('空字符串 → chars 0, words 0, lines 0', () => {
    // audit L8：空内容不再用 `|| 1` 兜底为 1 行。状态栏会显示「0 词」，
    // 避免「刚打开一个空白文件就看到『1 行』误导」。
    expect(getTextStats('')).toEqual({ chars: 0, words: 0, lines: 0 });
  });

  it('纯空白 → lines 0', () => {
    const stats = getTextStats('   \n   \n   ');
    expect(stats.lines).toBe(0);
    expect(stats.words).toBe(0);
  });

  it('单行内容', () => {
    const stats = getTextStats('hello world');
    expect(stats).toEqual({ chars: 11, words: 2, lines: 1 });
  });

  it('多行非空内容', () => {
    const stats = getTextStats('line one\nline two\nline three');
    expect(stats.lines).toBe(3);
    expect(stats.words).toBe(6);
    expect(stats.chars).toBe(28); // 8+1+8+1+10
  });

  it('空行不计数', () => {
    const stats = getTextStats('hello\n\n\nworld');
    expect(stats.lines).toBe(2);
    expect(stats.words).toBe(2);
  });

  it('null / 非字符串 → 默认值', () => {
    expect(getTextStats(null)).toEqual({ chars: 0, words: 0, lines: 0 });
    expect(getTextStats(42)).toEqual({ chars: 0, words: 0, lines: 0 });
  });

  it('CJK 内容', () => {
    const stats = getTextStats('你好世界\n欢迎使用');
    expect(stats.words).toBe(8);
    expect(stats.lines).toBe(2);
    expect(stats.chars).toBe('你好世界\n欢迎使用'.length);
  });
});

describe('formatStatusStats', () => {
  it('lines > 0 → 「N 词 · M 行」', () => {
    expect(formatStatusStats({ words: 100, lines: 5 })).toBe('100 词 · 5 行');
  });

  it('lines === 0 → 「N 词」', () => {
    expect(formatStatusStats({ words: 100, lines: 0 })).toBe('100 词');
  });

  it('千分位分隔（zh-CN locale）', () => {
    expect(formatStatusStats({ words: 1234, lines: 5 })).toBe('1,234 词 · 5 行');
    expect(formatStatusStats({ words: 12345, lines: 5 })).toBe('12,345 词 · 5 行');
  });

  it('0 词 → 「0 词」', () => {
    expect(formatStatusStats({ words: 0, lines: 0 })).toBe('0 词');
  });

  it('缺字段时 fallback', () => {
    expect(formatStatusStats({})).toBe('0 词');
    expect(formatStatusStats({ words: 10 })).toBe('10 词');
  });
});