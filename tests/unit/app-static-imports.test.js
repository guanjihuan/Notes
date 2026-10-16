// P2-9（audit C-4）：app.js 顶层静态 import 不拉 CM6。
//
// 背景：main.js 用 show:false + ready-to-show，窗口出现时机 ≈ renderer 首绘。
// app.js 是 <script type="module">，模块图全部 fetch+eval 完才执行 —— 顶层
// 静态 import './markdown-editor.js'（basicSetup 拖整个 23 条 importmap 的
// CM6 图）意味着「窗口出现」要等 CM6 全部下载解析完。
//
// 契约（本测试锁死）：
//   1. app.js 顶层不得静态 import 'codemirror' / '@codemirror/*' /
//      './markdown-editor.js'（CM6 只能经 dynamic import 进 renderer）
//   2. bootstrap 路径里必须有 dynamic import('./markdown-editor.js')
//   3. editor 不得是模块级 const new MarkdownEditor(...) —— 必须是 let，
//      由 bootstrap 在 dynamic import 完成后实例化（模块 eval 时不建编辑器）
//
// 与 tests/unit/csp-importmap-hash.test.js 同为「源码静态分析契约测试」：
// jsdom 无法 import app.js（模块级副作用 + window.api 前置），只能读源码断言。

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const appPath = join(dirname(fileURLToPath(import.meta.url)), '../../src/app.js');
const src = readFileSync(appPath, 'utf8');

// 顶层静态 import 行（行首无缩进的 import ... from '...'）
function staticImportSpecifiers(source) {
  const specs = [];
  for (const line of source.split('\n')) {
    const m = line.match(/^import\s.*?\sfrom\s+'([^']+)'/);
    if (m) specs.push(m[1]);
  }
  return specs;
}

describe('app.js 顶层不静态拉 CM6（audit P2-9）', () => {
  it("无静态 import 'codemirror' / '@codemirror/*' / './markdown-editor.js'", () => {
    const heavy = staticImportSpecifiers(src).filter((s) =>
      s === 'codemirror' || s.startsWith('@codemirror/') || s.startsWith('@lezer/') || s === './markdown-editor.js'
    );
    expect(heavy).toEqual([]);
  });

  it("bootstrap 路径存在 dynamic import('./markdown-editor.js')", () => {
    expect(src).toMatch(/import\('\.\/markdown-editor\.js'\)/);
  });

  it('editor 是模块级 let（bootstrap 内实例化），不是顶层 const new', () => {
    expect(src).not.toMatch(/^const editor = new MarkdownEditor/m);
    expect(src).toMatch(/^let editor/m);
  });

  it("无静态 import { EditorView } from '@codemirror/view'（facet 访问走 bootstrap 注入）", () => {
    expect(src).not.toMatch(/^import\s*\{\s*EditorView\s*\}\s*from\s*'@codemirror\/view'/m);
  });
});
