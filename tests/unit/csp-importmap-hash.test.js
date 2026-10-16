// index.html —— CSP 收紧（audit P0-2）
//
// 背景：原 CSP `script-src 'self' 'unsafe-inline'` —— 注释承认仅 importmap
// 需要 inline，但 'unsafe-inline' 留下 XSS 后续路径（任何位置注入的 inline
// script 都被放行）。
//
// 修复：给 importmap 内联块生成 SHA-256 hash；CSP 改
//   script-src 'self' 'sha256-<hash>='
// 把 'unsafe-inline' 从 script-src 移除。hash 必须与 importmap 当前实际内容
// 匹配（任何 importmap 调整后必须重算 + 同步 CSP，否则 importmap 被 CSP
// 拦截，renderer 启动会「Failed to resolve module specifier」）。
//
// 注：style-src 的 'unsafe-inline' 保留 —— marked 渲染的代码块用到 inline
// style（CSP 收紧会破坏阅读视图）。本测试只盯 script-src。
//
// 测试策略：直接读 index.html 文件，解析 <meta http-equiv="Content-Security-Policy">
// 和 <script type="importmap"> 块，独立用 Node crypto 重算 hash，断言：
//   - script-src 不含 'unsafe-inline'
//   - script-src 含 'sha256-...' 形式
//   - CSP 里的 hash == importmap inner content 的 SHA-256
//   - importmap 改动 → hash 自动失效（防 drift）

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = resolve(__dirname, '../../index.html');

function readIndexHtml() {
  return readFileSync(INDEX_HTML, 'utf8');
}

function extractCsp(html) {
  // content 属性里含单引号 ('self') + 哈希等号，不能用 [^"']+ 简单排除；
  // 用更稳的「非贪婪 + 显式终止」：content="..." 直到遇到 " 后接空白/>/换行。
  const m = html.match(/<meta\s+http-equiv=["']Content-Security-Policy["']\s+content=(["'])([\s\S]*?)\1\s*>/i);
  if (!m) throw new Error('未找到 <meta http-equiv="Content-Security-Policy">');
  return m[2];
}

function parseCspDirectives(csp) {
  // 简单解析：split by ';'，每个 directive 按空格 split key / values。
  // 值可能带单/双引号（CSP source-list 语法），解析时去掉外层引号便于后续比对。
  /** @type {Record<string, string[]>} */
  const out = {};
  for (const raw of csp.split(';')) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/);
    const key = parts.shift();
    out[key] = parts.map((v) => {
      // 去外层 ' 或 "（CSP value 内部不含嵌套引号，simple trim 安全）
      if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) {
        return v.slice(1, -1);
      }
      return v;
    });
  }
  return out;
}

function extractImportmapContent(html) {
  const m = html.match(/<script\s+type=["']importmap["']\s*>([\s\S]*?)<\/script>/i);
  if (!m) throw new Error('未找到 <script type="importmap">');
  return m[1];
}

function sha256Base64(content) {
  // 浏览器 HTML tokenizer 在算 CSP inline-script hash 前，会把脚本内容里的
  // \r\n / \r 归一化成 \n（这是 2026-10-16 importmap 被 CSP 拦截的真因：仓库
  // 源文件是 CRLF，但 CSP 必须放 LF 归一化后的 hash）。这里先归一化再算，
  // 与浏览器行为一致，否则测试会在「文件 CRLF」时算出错的 hash 还判定通过。
  const normalized = content.replace(/\r\n?/g, '\n');
  return createHash('sha256').update(normalized).digest('base64');
}

describe('index.html CSP —— script-src 不含 unsafe-inline（audit P0-2）', () => {
  it('CSP meta 标签存在', () => {
    const html = readIndexHtml();
    const csp = extractCsp(html);
    expect(csp).toBeTruthy();
  });

  it("script-src 不含 'unsafe-inline'", () => {
    // parseCspDirectives 已剥外层引号 → 直接比对 'unsafe-inline'（无引号）。
    // 用 .some 而非 .toContain：避免未来 CSP 拼成 host-source-list 误判。
    const html = readIndexHtml();
    const directives = parseCspDirectives(extractCsp(html));
    expect(directives['script-src']).toBeDefined();
    expect(directives['script-src'].some((v) => v === 'unsafe-inline')).toBe(false);
  });

  it('script-src 含 self + 至少一个 sha256-XXX=', () => {
    const html = readIndexHtml();
    const directives = parseCspDirectives(extractCsp(html));
    const scriptSrc = directives['script-src'];
    expect(scriptSrc).toContain('self');
    const hashEntries = scriptSrc.filter((v) => /^sha256-/.test(v));
    expect(hashEntries.length).toBeGreaterThanOrEqual(1);
  });

  it('CSP 里的 sha256 hash == importmap inner content 的 SHA-256', () => {
    const html = readIndexHtml();
    const directives = parseCspDirectives(extractCsp(html));
    const importmapContent = extractImportmapContent(html);
    const expectedHash = sha256Base64(importmapContent);
    const expectedEntry = `sha256-${expectedHash}`;

    const scriptSrc = directives['script-src'];
    expect(scriptSrc).toContain(expectedEntry);
  });

  it('importmap 内容变更 → hash 自动失效（防 drift，文档化契约）', () => {
    // 这条不是失败用例，是「设计意图」文档：
    //   任何 importmap 调整（新增/删除/改路径）后必须重算 SHA-256 并同步 CSP。
    //   改完 importmap 不重算 hash → 上面那条测试失败，提示开发者。
    // 不需要断言（已由上一条隐含覆盖），存在仅为了让读者明白这条测试的意图。
    expect(true).toBe(true);
  });
});
