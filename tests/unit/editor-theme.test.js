// Stage 7 tests: editor-theme.js
//
// 覆盖：
//   - pickEditorTheme 按 body[data-theme] 返回对应的 extensions 数组
//   - 暗色叠加 oneDark；亮色只用自己的覆盖
//   - backgroundColor / color 必须带 !important（oneDark 后续注入的同 specificity
//     规则会赢，必须用 important 强制覆盖，否则编辑区会显示 #282c34 而不是 --bg-viewer）
//
// editorTheme / editorThemeLight 是 EditorView.theme() 返回的 extension 对象，
// 内部是 CM6 私有结构，不展开断言 —— 只验证 pickEditorTheme 的行为即可。

import { describe, it, expect } from 'vitest';
import { pickEditorTheme, editorTheme, editorThemeLight, __editorThemeSpecForTests } from '../../src/editor-theme.js';

describe('pickEditorTheme', () => {
  it('theme === "light" → 只返回 editorThemeLight', () => {
    const exts = pickEditorTheme('light');
    expect(exts).toHaveLength(1);
    expect(exts[0]).toBe(editorThemeLight);
  });

  it('theme === "dark" → 返回 [oneDark, editorTheme]', () => {
    const exts = pickEditorTheme('dark');
    expect(exts).toHaveLength(2);
    expect(exts[1]).toBe(editorTheme);
  });

  it('theme === undefined → 当暗色处理', () => {
    const exts = pickEditorTheme(undefined);
    expect(exts).toHaveLength(2);
    expect(exts[1]).toBe(editorTheme);
  });

  it('theme === "auto"（旧版本残留） → 当暗色处理（防御性）', () => {
    const exts = pickEditorTheme('auto');
    expect(exts).toHaveLength(2);
  });

  it('theme === ""（空字符串） → 当暗色处理', () => {
    const exts = pickEditorTheme('');
    expect(exts).toHaveLength(2);
  });

  it('theme === null → 当暗色处理', () => {
    const exts = pickEditorTheme(null);
    expect(exts).toHaveLength(2);
  });
});

describe('editorThemeSpec background overrides (oneDark / base theme 互斥)', () => {
  // oneDark 的 .cm-editor { background-color: #282c34 } 和 .cm-gutters 同色，
  // 在 dark theme 下会导致编辑区底色跟 .editor-pane / .viewer 的 --bg-viewer 不一致。
  // 必须用 !important 强制覆盖，否则 oneDark 后注入的同 specificity 规则会赢。
  it('.cm-editor backgroundColor 必须是 var(--bg-viewer) !important', () => {
    const v = __editorThemeSpecForTests.backgroundColor;
    expect(v).toMatch(/var\(--bg-viewer\)/);
    expect(v).toMatch(/!important/);
  });

  it('.cm-editor color 必须是 var(--fg-primary) !important', () => {
    const v = __editorThemeSpecForTests.color;
    expect(v).toMatch(/var\(--fg-primary\)/);
    expect(v).toMatch(/!important/);
  });

  it('.cm-gutters backgroundColor 必须是 var(--bg-viewer) !important', () => {
    const v = __editorThemeSpecForTests.gutterBackgroundColor;
    expect(v).toMatch(/var\(--bg-viewer\)/);
    expect(v).toMatch(/!important/);
  });

  it('.cm-gutters color 必须是 var(--fg-tertiary) !important', () => {
    const v = __editorThemeSpecForTests.gutterColor;
    expect(v).toMatch(/var\(--fg-tertiary\)/);
    expect(v).toMatch(/!important/);
  });

  // @codemirror/view 的 base theme 用 `&light .cm-activeLineGutter` / `&dark` 规则
  //（特异性 (0,2,0)）给 active 行 gutter 涂硬编码色（亮 #e2f2ff / 暗 #222227）。
  // 我们的 .cm-activeLineGutter 是 (0,1,0)，必须用 !important 才能让 var(--bg-hover) 稳定生效。
  // 否则亮色下「活动行 gutter 变浅蓝色块」就是这个原因。
  it('.cm-activeLine backgroundColor 必须是 var(--bg-hover) !important', () => {
    const v = __editorThemeSpecForTests.activeLineBackgroundColor;
    expect(v).toMatch(/var\(--bg-hover\)/);
    expect(v).toMatch(/!important/);
  });

  it('.cm-activeLineGutter backgroundColor 必须是 var(--bg-hover) !important', () => {
    const v = __editorThemeSpecForTests.activeLineGutterBackgroundColor;
    expect(v).toMatch(/var\(--bg-hover\)/);
    expect(v).toMatch(/!important/);
  });

  it('.cm-activeLineGutter color 必须是 var(--fg-secondary) !important', () => {
    const v = __editorThemeSpecForTests.activeLineGutterColor;
    expect(v).toMatch(/var\(--fg-secondary\)/);
    expect(v).toMatch(/!important/);
  });

  // base theme 给 .cm-cursor 设黑色，&dark 下设 #528bff（oneDark 的 cursor 蓝）。
  // 我们用 var(--accent)，需要 !important 才能不被覆盖。
  it('.cm-cursor/.cm-dropCursor borderLeftColor 必须是 var(--accent) !important', () => {
    const v = __editorThemeSpecForTests.cursorBorderLeftColor;
    expect(v).toMatch(/var\(--accent\)/);
    expect(v).toMatch(/!important/);
  });

  // .cm-content caretColor 同样被 base theme 影响 —— 加 !important 兜底。
  it('.cm-content caretColor 必须是 var(--accent) !important', () => {
    const v = __editorThemeSpecForTests.caretColor;
    expect(v).toMatch(/var\(--accent\)/);
    expect(v).toMatch(/!important/);
  });

  // base theme `&light .cm-panels { background: #f5f5f5; color: black }` /
  // `&dark { background: #333338; color: white }` 会盖住搜索面板的颜色。
  it('.cm-panels backgroundColor 必须是 var(--bg-elevated) !important', () => {
    const v = __editorThemeSpecForTests.panelsBackgroundColor;
    expect(v).toMatch(/var\(--bg-elevated\)/);
    expect(v).toMatch(/!important/);
  });

  it('.cm-panels color 必须是 var(--fg-primary) !important', () => {
    const v = __editorThemeSpecForTests.panelsColor;
    expect(v).toMatch(/var\(--fg-primary\)/);
    expect(v).toMatch(/!important/);
  });
});
