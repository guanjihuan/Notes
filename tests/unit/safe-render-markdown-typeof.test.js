// safeRenderMarkdown typeof guard 测试（Round 8 R-1）
//
// 单独成文件 + jsdom env，不污染 utils.test.js 的 node env：
//   - utils.test.js 里 pathsEqual Windows case-fold 测试依赖 Node 24 的
//     navigator.platform='Win32'（jsdom 25 是 ''），不同 env 命中不同 isWindows
//     分支。utils.test.js 留在 node env 跑基线更稳。
//   - 本测试需要 window 存在以挂 window.api stub → 必须 jsdom。
//
// 覆盖：renderMarkdown 契约是 string，但 jsdom 单测或未来 mock 替换可能返回
// 非字符串。typeof guard 防 null / undefined / 数字 直接 setBody 触发下游
// DOM 解析错。**关键反例**：必须用 typeof，不能用 `||`，因为 '' 是空 markdown
// 的合法返回（preload 对空字符串返回 ''）—— `result ||` 会把合法空 markdown
// 误降级为 <pre>，污染空文档渲染。

// @vitest-environment jsdom

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { safeRenderMarkdown } from '../../src/utils.js';

describe('safeRenderMarkdown —— typeof guard (Round 8 R-1)', () => {
  let savedApi;
  beforeEach(() => {
    savedApi = window.api;
  });
  afterEach(() => {
    window.api = savedApi;
  });

  it('window.api.renderMarkdown 返回 null → 降级为 <pre>', () => {
    window.api = { renderMarkdown: () => null };
    expect(safeRenderMarkdown('text')).toContain('<pre');
  });
  it('window.api.renderMarkdown 返回 undefined → 降级为 <pre>', () => {
    window.api = { renderMarkdown: () => undefined };
    expect(safeRenderMarkdown('text')).toContain('<pre');
  });
  it('window.api.renderMarkdown 返回数字 → 降级为 <pre>', () => {
    window.api = { renderMarkdown: () => 42 };
    expect(safeRenderMarkdown('text')).toContain('<pre');
  });
  it('window.api.renderMarkdown 返回合法字符串 → 透传', () => {
    window.api = { renderMarkdown: () => '<p>ok</p>' };
    expect(safeRenderMarkdown('text')).toBe('<p>ok</p>');
  });
  it('空 markdown → window.api.renderMarkdown 返回空字符串 → 透传空字符串（不降级）', () => {
    // 关键反例：旧版用 `||` 会把 '' 误降级为 <pre>，污染空文档渲染。
    window.api = { renderMarkdown: () => '' };
    expect(safeRenderMarkdown('')).toBe('');
  });
});