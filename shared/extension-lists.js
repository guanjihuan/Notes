// 文件扩展名白名单（main / preload / renderer 三处共用）
//
// ============================================================================
//
// 之前一批可编辑扩展名同时维护在两处（具体数量已不准）：
//   - main/file-ops.js 的 EDITABLE_EXTS Set（classifyEntry 入口决定文件
//     entryType，关系到 sidebar 展示 + 打开提示）
//   - src/app.js 的 LOCAL_FILE_EXTS 数组（resolveLocalFile 判断 md 内
//     链接是否可以跳转到该文件）
//
// 两边列表一旦漂移，「侧栏显示可编辑 / 点击却提示不支持」或「侧栏灰掉
// 但 md 里能点开」的体验割裂就会出现。本文件是单一事实源：
//
//   • EDITABLE_EXTS   — 可打开编辑的文件扩展名（小写、不含点）
//   • MARKDOWN_EXTS   — 支持 Markdown 渲染预览的扩展名（EDITABLE_EXTS 子集）
//
// 加载方式：
//   • main / preload（CJS）：const exts = require('../shared/extension-lists.js')
//   • renderer：经 preload contextBridge 过桥（window.api.EDITABLE_EXTS），
//     因为 renderer 是 ESM + Chromium 原生，不能直接 import CJS。
//     preload 内对 Set 调 Array.from 后再 exposeInMainWorld，所以 renderer 端
//     拿到的是 Array（不是 Set），用 .includes / Array.isArray 判断即可。
//
// 修改流程：只改本文件一处，main + renderer 两侧自动同步。
// ============================================================================

'use strict';

/**
 * 可打开编辑的文件扩展名白名单（小写、不含点）。
 *
 * 包含 Markdown + 常见纯文本 + 常见编程语言；其它扩展名一律视为 binary
 * （侧栏仍展示但灰掉、点击提示"不支持的文件类型"）。
 *
 * 范围决策（2026-08-25 反馈）：覆盖 Web 脚本 + 主流语言，避免「写笔记
 * 时顺手维护个 .py / .sql 也打不开」的体验割裂。编辑器是 CodeMirror
 * Markdown 6，没有专门的语法高亮（import map 里只配了 markdown /
 * javascript / css / html），所以 .py / .go / .rs 等虽然可编辑但会
 * 是纯文本色 —— 后续要做 syntax highlighting 再补 lang-* 包。
 *
 * 列表约定：
 *   - 按「用途族」分组：Markdown / 数据 / 配置 / 文档 / Python /
 *     JS-TS / Web 样式 / 组件框架 / JVM / Go / Rust / Ruby / PHP /
 *     Shell / Windows / SQL / C-C++ / C# / Swift / Scala / Lua /
 *     Perl / R / Dart
 *   - 排序方便 review 时一眼看清覆盖了哪些，没别的语义
 */
const EDITABLE_EXTS = new Set([
  // Markdown
  'md', 'markdown',
  // 常见纯文本
  'txt', 'text', 'log',
  // 表格 / 结构化数据
  'csv', 'tsv', 'json', 'xml', 'yaml', 'yml', 'toml',
  // 配置 / 环境
  'ini', 'cfg', 'conf', 'env',
  'gitconfig', // 隐藏文件 .gitconfig 走 lastIndexOf('.') === 0 路径，需在白名单才能 editable
  // 文档 / 排版
  'rst', 'tex',

  // Python
  'py', 'pyi', 'pyw',
  // JavaScript / TypeScript（jsx/tsx 让 React 用户也能直接编辑）
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx',
  // Web：HTML / CSS 衍生
  'html', 'htm', 'css', 'scss', 'sass', 'less',
  // 组件框架
  'vue', 'svelte',
  // JVM 系
  'java', 'kt', 'kts',
  // Go
  'go',
  // Rust
  'rs',
  // Ruby
  'rb',
  // PHP
  'php',
  // Shell 系（POSIX 主流）
  'sh', 'bash', 'zsh',
  // Windows 脚本
  'ps1',
  // SQL
  'sql',
  // C / C++
  'c', 'h', 'cpp', 'hpp', 'cc', 'cxx',
  // C#
  'cs',
  // Swift
  'swift',
  // Scala
  'scala',
  // Lua
  'lua',
  // Perl
  'pl',
  // R
  'r',
  // Dart
  'dart',
]);

/**
 * 支持 Markdown 渲染预览的扩展名（EDITABLE_EXTS 的子集）。
 *
 * 仅 .md / .markdown 走 viewer 预览，其它可编辑文件（.txt/.py/.json/...）
 * 在 viewer 显示「不支持预览」空态，但仍可在编辑器里修改。
 */
const MARKDOWN_EXTS = new Set(['md', 'markdown']);

module.exports = { EDITABLE_EXTS, MARKDOWN_EXTS };