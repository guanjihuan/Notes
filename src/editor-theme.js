// CodeMirror 6 主题 —— 单一来源
//
// 包含：
//   - editorThemeSpec      CSS 规则 spec（用我们的设计令牌覆盖 oneDark）
//   - editorTheme          暗色主题（dark: true → 让 oneDark 接管配色）
//   - editorThemeLight     亮色主题（不挂 dark，由 styles.css 的 [data-theme=light] 覆盖）
//   - pickEditorTheme      按 body[data-theme] 选择对应 extension 数组
//
// 选择高亮用 `!important`：oneDark 的 (0,5,0) 选择器特异性会盖住我们的规则，
// 否则用户在暗色主题下看到的是 oneDark 偏灰的 selection（看不清）。
//
// 亮色 active line / active gutter / panels / cursor 等属性也用 !important：
// @codemirror/view 的 base theme 用 `&light` / `&dark` 选择器（特异性 (0,2,0)），
// 我们的 `.cm-xxx` 是 (0,1,0)，会让 base theme 的硬编码色（亮 #e2f2ff / 暗 #222227）
// 覆盖我们的 var(--bg-hover)。亮色下「活动行 gutter 变浅蓝色块」就是这个原因。

import { EditorView } from '@codemirror/view';
import { oneDark } from '@codemirror/theme-one-dark';

const editorThemeSpec = {
  '&': {
    // 显式用 var(--bg-viewer)，跟 .editor-pane 同色 —— 视觉上仍是同一张画布，
    // 但必须显式写：oneDark 内部会给 .cm-editor 涂 #282c34（硬编码），
    // 不写会被它盖掉，导致 dark default 下编辑器比预览明显偏灰。
    // 用 !important 是因为 oneDark 的扩展在我们之后注入，CSS 源顺序让它赢。
    backgroundColor: 'var(--bg-viewer) !important',
    color: 'var(--fg-primary) !important',
    height: '100%',
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--fs-base)',
  },
  '.cm-content': {
    caretColor: 'var(--accent) !important',
    // 水平内边距：
    //   - 左 2px：与 lineWrapping 默认 4px 左边距叠加后第一个字符渲染在
    //     x=gutter.right+2 处 —— 视觉上几乎看不出差别，但点击 gutter 边线时
    //     posAtCoords 返回 pos=0（落在 padding 内）而不是 pos=1（落在第一个
    //     字符上）。配合下方的 .cm-foldGutter { display:none } 修复
    //     「鼠标点不了一行最前面位置」的 bug。
    //   - 右 --space-7：与 viewer 的右侧内边距对齐
    // 垂直保留 --space-5：编辑器比 viewer 顶部留白小一半，写的时候更紧凑
    padding: 'var(--space-5) var(--space-7) var(--space-5) 2px',
  },
  '.cm-cursor, .cm-dropCursor': {
    // base theme 给 .cm-cursor 设了黑色，&dark 下设 #528bff（oneDark 的 cursor 蓝）。
    // 我们的 accent 颜色被覆盖，需要 !important 盖掉。
    borderLeftColor: 'var(--accent) !important',
  },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': {
    backgroundColor: 'var(--accent-selection) !important',
  },
  '::selection': {
    backgroundColor: 'var(--accent-selection) !important',
  },
  '.cm-activeLine': {
    // 同样要盖掉 oneDark 的 #6699ff0b（蓝色调）+ base theme 的 &dark #99eeff33 /
    // &light #cceeff44，改用我们中性的 bg-hover
    backgroundColor: 'var(--bg-hover) !important',
  },
  '.cm-activeLineGutter': {
    // base theme 用 `&light .cm-activeLineGutter { background-color: #e2f2ff }` /
    // `&dark { background-color: #222227 }`，特异性 (0,2,0) 盖住我们的 (0,1,0)。
    // 亮色下 active gutter 会变成浅蓝色块；暗色下变成深灰色块 —— 都是 base theme 赢。
    // 加 !important 后我们的 var(--bg-hover) 才能稳定生效。
    backgroundColor: 'var(--bg-hover) !important',
    color: 'var(--fg-secondary) !important',
  },
  '.cm-gutters': {
    // 显式 bg-viewer 盖掉 oneDark 给 .cm-gutters 涂的 #282c34
    // —— 否则 gutter 会比 content 明显偏灰，看上去像"编辑区有个奇怪灰条"
    backgroundColor: 'var(--bg-viewer) !important',
    color: 'var(--fg-tertiary) !important',
    border: 'none',
    // 钉死宽度 = viewer 的 padding-left（--space-7 = 32px）：
    //   让 gutter 右侧紧贴的 .cm-content 文字起点 = viewer 文字起点，
    //   双栏对比时「编辑」和「预览」同一行的 # 与 一 字真正对齐。
    // CodeMirror 默认 gutter 按行号位数自适应（约 30-35px），
    //   钉死后 2 位数以内行号仍能放下；超长文件（千行+）再扩。
    width: 'var(--space-7)',
    minWidth: 'var(--space-7)',
    maxWidth: 'var(--space-7)',
  },
  // 行号单元格：去掉默认 padding，让行号在 32px gutter 内右对齐贴边
  '.cm-gutter': {
    padding: '0 6px 0 0',
  },
  // .cm-foldGutter：basicSetup 默认带 foldGutter()，它在 .cm-gutters 里渲染一个
  // 折叠箭头列（chevron）。该列默认宽度 ~16px，但 .cm-gutters 的 CSS width 是
  // 钉死 32px（只够装下 lineNumbers gutter），所以 foldGutter 实际渲染宽度
  // 溢出 gutter 边界 ~10px，盖在 cm-line 的开头字符上。
  //
  // 后果有两个：
  //   1. 视觉上 chevron 跟「行首第一个字符」重叠，markdown 文本看起来有奇怪的
  //      三角形压在第一个字前面。
  //   2. 鼠标点击 chevron 区域（用户以为是「行首最前面」的位置）时，hit target
  //      是 foldGutter 内部的 SPAN（不是 cm-line）。CM6 的 mousedown 监听挂
  //      在 view.contentDOM，gutter 是 contentDOM 的兄弟节点、事件不会冒泡到
  //      contentDOM —— CM6 完全不处理这次点击，光标位置不变。
  //      用户体感：「鼠标点不了一行的最前面的位置」。
  //
  // 折叠功能本身仍然由 foldGutter() 提供 keymap（Ctrl+Shift+[ / ] 等），
  // 这里只通过 CSS 隐藏 chevron 渲染部分；键盘 fold / unfold 命令照常工作。
  // 对 markdown 编辑场景来说（不像代码文件那样频繁折叠函数/类），视觉上
  // 干掉 chevron 比保留更清爽，行首点击的命中问题也彻底消失。
  // 加 !important 兜底——basicSetup 注入的样式也是通过 EditorView.theme，
  // 同特异性下源序胜负不可靠。
  '.cm-foldGutter': {
    display: 'none !important',
  },
  // .cm-line：覆盖 base theme 的 `padding: 0 2px 0 6px`，把左内边距归零。
  // 原 6px 左侧内边距会形成「行首死区」——鼠标点击那一段 6px 区域时，
  // CodeMirror 的 posAtCoords 会把光标定位到该位置所属的最近字符位置，
  // 但点击发生在 padding 内、还没有实际文字时，部分浏览器（尤其 Chromium
  // 在 cm-line 的 contenteditable 内）会把 click coords 落在 gutter 边界与
  // 文字起点之间这段空白上，无法可靠地放置光标到「该行的绝对最前面」。
  // 把左侧 padding 改为 0 后，gutter 右侧紧贴的就是第一个字符位置，
  // 点击 gutter 边线 → 光标直接落到该行最左侧（位置 0）。
  // 右侧保留 2px 让选中态在行末看起来不贴边。
  // 加 !important 是因为 base theme 与我们的 .cm-line 同为 (0,1,0)，
  // CSS 源顺序才能分胜负，加 important 后我们的规则无视源序始终胜出。
  //
  // 注意：折叠 gutter 的 chevron 已用 display:none 干掉（见上），所以
  // cm-line 元素真正从 x=gutter.right 开始延伸；这条 padding 规则确保
  // 内容从 cm-line 左缘紧贴渲染，「行首第一个字」与 cm-line 边界对齐。
  '.cm-line': {
    padding: '0 2px 0 0 !important',
  },
  '.cm-scroller': {
    fontFamily: 'var(--font-mono)',
    lineHeight: '1.7',
  },
  '.cm-panels': {
    // base theme `&light .cm-panels { background-color: #f5f5f5; color: black }` /
    // `&dark { background-color: #333338; color: white }` 会盖住我们的 (0,1,0) 选择器。
    // 搜索面板 / autocomplete 等等都用 .cm-panels，亮色下颜色不对。
    backgroundColor: 'var(--bg-elevated) !important',
    color: 'var(--fg-primary) !important',
  },
};

/** 暗色主题：dark 标记让 oneDark 自动覆盖我们的 CSS 变量 */
export const editorTheme = EditorView.theme(editorThemeSpec, { dark: true });

/** 亮色主题：不带 dark，由 styles.css [data-theme=light] 覆盖色板 */
export const editorThemeLight = EditorView.theme(editorThemeSpec);

// ---- 测试钩 ---------------------------------------------------------------
// editorThemeSpec 不直接 export（避免外部拿到 spec 后乱改）。
// 但 vitest 没法直接断言 EditorView.theme() 的内部 CSSOM 表现 —— 它是私有结构，
// 只能断言我们可控的部分：backgroundColor / color 声明里带了 !important，
// 才能盖住 oneDark 后注入的同 specificity 规则（oneDark 的 .cm-editor { background-color: #282c34 }），
// 以及 @codemirror/view base theme 的 `&light` / `&dark` 规则（特异性 (0,2,0)）。
//
// 这些 getter 只在测试用，prod 路径不会触达。
export const __editorThemeSpecForTests = {
  get backgroundColor() { return editorThemeSpec['&'].backgroundColor; },
  get color() { return editorThemeSpec['&'].color; },
  get gutterBackgroundColor() { return editorThemeSpec['.cm-gutters'].backgroundColor; },
  get gutterColor() { return editorThemeSpec['.cm-gutters'].color; },
  get activeLineBackgroundColor() { return editorThemeSpec['.cm-activeLine'].backgroundColor; },
  get activeLineGutterBackgroundColor() { return editorThemeSpec['.cm-activeLineGutter'].backgroundColor; },
  get activeLineGutterColor() { return editorThemeSpec['.cm-activeLineGutter'].color; },
  get cursorBorderLeftColor() { return editorThemeSpec['.cm-cursor, .cm-dropCursor'].borderLeftColor; },
  get caretColor() { return editorThemeSpec['.cm-content'].caretColor; },
  get panelsBackgroundColor() { return editorThemeSpec['.cm-panels'].backgroundColor; },
  get panelsColor() { return editorThemeSpec['.cm-panels'].color; },
  // 行单元 padding：覆盖 base theme `padding: 0 2px 0 6px`，把左内边距归零，
  // 避免 gutter 右侧留 6px 死区让光标无法放到该行的绝对最前面。
  get linePadding() { return editorThemeSpec['.cm-line'].padding; },
  // foldGutter 隐藏规则：basicSetup 默认 foldGutter() 会渲染 chevron 并
  // 溢出 32px gutter 的边界 ~10px，盖在 cm-line 的开头字符上，导致点击
  // 行首最前面位置时 hit target 是 gutter SPAN 而非 cm-line，CM6 不处理
  // 这次点击，光标位置不变。display:none + !important 兜底。
  get foldGutterDisplay() { return editorThemeSpec['.cm-foldGutter'].display; },
};

/**
 * 按 body[data-theme] 选择当前主题的 extensions 数组。
 * 暗色叠加 oneDark（语法高亮）；亮色只用自己的覆盖。
 *
 * @param {'dark' | 'light' | undefined} theme
 * @returns {Array}
 */
export function pickEditorTheme(theme) {
  return theme === 'light' ? [editorThemeLight] : [oneDark, editorTheme];
}
