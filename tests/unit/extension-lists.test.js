// shared/extension-lists.js 的单一事实源测试
// ============================================================================
//
// 之前 EDITABLE_EXTS 与 MARKDOWN_EXTS 在 main/file-ops.js 和 src/app.js 各
// 维护一份，列表漂移会导致「侧栏显示可编辑但 md 链接打不开」或反之的体验
// 割裂。本测试覆盖共享列表的内容与不变量，确保新增/删除扩展名只在
// shared/extension-lists.js 一处即可生效。
//
// 不变量：
//   - MARKDOWN_EXTS ⊆ EDITABLE_EXTS（Markdown 一定可编辑）
//   - 大小写：所有 key 已规范化为小写、不含点
//   - 关键用户场景：.md / .markdown / .txt / .py / .json / .html 都覆盖
//   - 防御：二进制扩展（.png / .exe）一定不在
// ============================================================================

import { describe, it, expect } from 'vitest';
import { EDITABLE_EXTS, MARKDOWN_EXTS } from '../../shared/extension-lists.js';

describe('EDITABLE_EXTS', () => {
  it('关键 Markdown 扩展在白名单内', () => {
    expect(EDITABLE_EXTS.has('md')).toBe(true);
    expect(EDITABLE_EXTS.has('markdown')).toBe(true);
  });

  it('常见纯文本 / 数据 / 配置扩展在白名单内', () => {
    const expected = ['txt', 'text', 'log', 'csv', 'json', 'yaml', 'yml', 'toml', 'xml', 'ini', 'env'];
    for (const ext of expected) {
      expect(EDITABLE_EXTS.has(ext), `expected '${ext}' in EDITABLE_EXTS`).toBe(true);
    }
  });

  it('主流编程语言扩展在白名单内', () => {
    const expected = [
      'py', 'js', 'ts', 'tsx', 'jsx',
      'html', 'css', 'scss', 'vue', 'svelte',
      'java', 'go', 'rs', 'rb', 'php',
      'sh', 'bash', 'ps1', 'sql',
      'c', 'cpp', 'h', 'cs', 'swift', 'scala', 'lua', 'pl', 'r', 'dart',
    ];
    for (const ext of expected) {
      expect(EDITABLE_EXTS.has(ext), `expected '${ext}' in EDITABLE_EXTS`).toBe(true);
    }
  });

  it('二进制扩展一定不在白名单内', () => {
    const binaries = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'pdf', 'zip', 'tar', 'gz', 'exe', 'dll', 'so', 'dylib', 'mp4', 'mp3', 'wav', 'docx', 'xlsx', 'pptx'];
    for (const ext of binaries) {
      expect(EDITABLE_EXTS.has(ext), `binary '${ext}' must NOT be in EDITABLE_EXTS`).toBe(false);
    }
  });

  it('所有 key 都规范化为小写、不含点', () => {
    for (const ext of EDITABLE_EXTS) {
      expect(ext).toBe(ext.toLowerCase());
      expect(ext).not.toMatch(/^\./);
      expect(ext).not.toMatch(/\./);
    }
  });
});

describe('MARKDOWN_EXTS', () => {
  it('仅 md / markdown', () => {
    expect(MARKDOWN_EXTS.has('md')).toBe(true);
    expect(MARKDOWN_EXTS.has('markdown')).toBe(true);
    expect(MARKDOWN_EXTS.size).toBe(2);
  });

  it('所有 key 都规范化为小写、不含点', () => {
    for (const ext of MARKDOWN_EXTS) {
      expect(ext).toBe(ext.toLowerCase());
      expect(ext).not.toMatch(/^\./);
      expect(ext).not.toMatch(/\./);
    }
  });
});

describe('不变量', () => {
  it('MARKDOWN_EXTS ⊆ EDITABLE_EXTS（Markdown 一定可编辑）', () => {
    for (const ext of MARKDOWN_EXTS) {
      expect(EDITABLE_EXTS.has(ext), `MARKDOWN_EXTS 的 '${ext}' 必须在 EDITABLE_EXTS 中`).toBe(true);
    }
  });
});