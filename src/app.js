// 渲染端 bootstrap
// 串联：SettingsStore + Toolbar + FileList + MarkdownViewer + MarkdownEditor + EditorToolbar + 事件订阅
//
// 启动顺序：settings → 静态事件 → IPC → 模式应用 → 文件列表 → 快捷键

import { SettingsStore } from './settings-store.js';
import { FileList } from './file-list.js';
import { MarkdownViewer } from './markdown-viewer.js';
import { MarkdownEditor } from './markdown-editor.js';
import { EditorToolbar, EDITOR_MODES } from './editor-toolbar.js';
import { Toolbar } from './toolbar.js';
import { SettingsDialog } from './settings-dialog.js';
import { showToast } from './feedback.js';
import { decideSaveToast } from './save-toast.js';
import { syncDirtyFromEditor as syncDirtyFromEditorPure } from './dirty-sync.js';
// 救援文件工具：5 处独立复制的「生成救援名 + 写盘 + toast」逻辑
// 集中到一处，命名规则 / 错误文案（特别是 friendlyFsError 传 r.message
// 而非 r.error 业务码）只改一处即可。详见 src/rescue.js 注释。
import { rescueDirtyContent } from './rescue.js';
import { showConfirmDialog } from './confirm-dialog.js';
import { isOpen as modalIsOpen } from './modal-stack.js';
import { mountKeyboardShortcuts } from './shortcuts.js';
import { syncSaveButton as syncSaveButtonUI } from './save-button-ui.js';
import { ContextMenu } from './context-menu.js';
import { EditorView } from '@codemirror/view';
import { isPathInside, dirnameOf, basenameOf, resolvePath, isMarkdownFile, pathsEqual } from './utils.js';
import { formatStatusStats } from './stats.js';
// 文件操作层（Stage 4c 抽离）
//
// friendlyFsError 不再从 src/file-ops.js 导入 —— Round 4 收尾把三处独立 mapping
// 合并到 shared/friendly-fs-error.js，由 preload 经 contextBridge 暴露成
// window.api.friendlyFsError（见 preload.js#sharedFriendlyFsError require）。src/app.js
// / src/file-ops.js / main/file-ops.js 都走同一份文案。
import { createFileOps } from './file-ops.js';
// AI 修改（OpenAI 兼容 API + 行级/词级 diff + 用户确认式应用）
import { createAiController } from './ai/ai-controller.js';

// 通用拖拽分割条工厂（mountSplitter / mountSidebarSplitter / mountAiSplitter 三段
// 共用的样板抽到一处）。dispose() 一次性解除挂载的所有 listener。
import { createSplitter } from './splitter.js';

// 启动错误兜底：如果 preload 没注入 window.api（极少见），显示错误并退出
if (!window.api) {
  const el = document.getElementById('boot-error');
  if (el) el.removeAttribute('hidden');
  throw new Error('[app] window.api not available; preload.js failed to inject contextBridge');
}

/**
 * 把 preload 缓存的 icon.ico PNG data URL 注入到左上角 <img>。
 * 同步设 src → load 事件触发后 unhide 并加 body.has-app-icon（CSS 隐藏 ::before 占位）。
 * src 拿不到（icon.ico 缺失 / 打包漏文件）→ img 保持 hidden，::before 渐变方块继续占位。
 * 不 await：图标是视觉锦上添花，不应阻塞 settings / IPC / 文件列表的初始化。
 */
function mountAppIcon() {
  const img = document.getElementById('app-icon');
  if (!img || typeof window.api.getAppIconDataUrl !== 'function') return;
  const url = window.api.getAppIconDataUrl();
  if (!url) return;
  img.addEventListener('load', () => {
    img.hidden = false;
    document.body.classList.add('has-app-icon');
  }, { once: true });
  // onerror 也走 hidden：避免破图图标 + ::before 同时不存在的尴尬状态
  img.addEventListener('error', () => {
    img.hidden = true;
  }, { once: true });
  img.src = url;
}

// schema 经 preload 的 contextBridge 过桥，不能直接 import shared/settings-schema.js（renderer 是
// 浏览器原生 ESM，无 CJS 互操作）。preload 先于 renderer 模块求值，顶层取值安全。
// audit fix (CQ-MED-9)：fileListSort 默认值双源 —— schema 在 DEFAULT_SETTINGS.fileListSort
// 与 SETTINGS_UI_OPTIONS.fileListSort[0].value 各有一份真相。renderer 之前把 'name' 字面量
// 硬编码在多处 fallback，schema 改默认或加新枚举时这些地方会悄无声息地继续走旧值。现在只读
// 一处事实源（schema），fallback 用 UI 选项表第一项 —— 与 schema.js#DEFAULT_SETTINGS.fileListSort
// 共享同一个 [0].value。
const FILE_LIST_SORT_OPTIONS = (window.api?.settingsSchema?.SETTINGS_UI_OPTIONS?.fileListSort) || [
  { value: 'name', label: '按名称' },
  { value: 'mtime-desc', label: '按修改时间' },
];
const FILE_LIST_SORT_VALUES = FILE_LIST_SORT_OPTIONS.map((o) => o.value);
const DEFAULT_FILE_LIST_SORT = FILE_LIST_SORT_VALUES[0] || 'name';

// friendlyWriteError 已抽离到 shared/friendly-fs-error.js，preload 暴露成
// window.api.friendlyFsError（Round 4 收尾：消除与 src/file-ops.js /
// main/file-ops.js 的三处独立 mapping 漂移）。下方所有 callsite 改用
// window.api.friendlyFsError；preload 不可用时降级到内置轻量版（与
// shared 模块一致，保证 renderer 自测与生产环境文案统一）。

/**
 * 应用状态
 */
const state = {
  files: [],
  entries: [],                  // Stage 8：当前目录全部条目（含 folder / editable / binary），与 state.files（仅文件）平行
  currentFile: null,           // {path, name, size, mtimeMs}
  alwaysOnTop: false,
  isMaximized: false,
  // 编辑相关
  // audit fix (Phase L2 M3)：init 占位用 schema DEFAULT_SETTINGS.editorMode，
  // 之前硬编码 'preview' 与 schema 默认 'split' 不一致；手改 config.json
  // 绕过 coerceLoadedSettings 时会落进错误分支。下方 fallback 同样改对齐。
  editorMode: (window.api?.settingsSchema?.DEFAULT_SETTINGS?.editorMode) || 'split',
  isDirty: false,              // 当前编辑器是否有未保存改动
  // 保存按钮的「保存中」视觉态用计数器实现，而不只是单 boolean：
  // inFlightSave sentinel 让多次 save() 共享同一份 IPC Promise，第二次
  // 进入时直接 await 共享结果；如果用单 boolean 第二次进入会闪烁
  // （设 true → 立刻被 finally 清 false）。用计数器累加/递减，归零才
  // 真正切回非 saving 态，对应 UI 不会抖动。
  savingCount: 0,
  lastSavedMtimeMs: null,      // 当前编辑器内容对应的磁盘 mtime
  // P1-2：存的是「上一次写盘后的 mtime」（不是 Date.now() 时间戳）——
  // 用于 fs.watch 回声抑制：fs-watcher 回调里拿到的 mtime 等于这个值说明是自身写盘回声，
  // 跳过「文件被外部修改」分支；外部真实修改的 mtime 严格大于它。
  // 旧名 recentlySavedAt 误导（让人以为是时间戳），改名 lastWriteMtimeMs 以反映
  // 真实含义：上一次成功 writeFile 的 mtime（即 lastSavedMtimeMs 的同值镜像，
  // 单独存以便「文件被打开」时也能拿到上一次写盘的基线）。
  lastWriteMtimeMs: 0,
  // 聚焦模式：默认关闭；Ctrl+Shift+F 切换；持久化到 settingsStore.focusMode
  focusMode: false,
  // 设置对话框开关状态：让 switchDataFolder 与之互斥，避免同时挂 dirty-check hook
  settingsDialogOpen: false,
  // Stage 8：Folder Browser
  // currentDir = 当前显示目录的绝对路径；currentRelDir = 对应 dataRoot 的 POSIX 相对路径
  // breadcrumb = [{ name, relDir }] 当前路径上的所有段（不含根），从根向下排
  //   根目录时 currentRelDir === '' 且 breadcrumb === []
  //   进入子目录后 breadcrumb 记录下钻轨迹，用于面包屑点击跳转
  //   切数据文件夹 / 启动时 currentDir 重置为新根，breadcrumb 清空
  currentDir: '',
  currentRelDir: '',
  breadcrumb: [],
  // 当前打开的文件所在目录的 relDir（POSIX，相对 dataRoot）。
  // 与 currentRelDir（当前显示目录的 relDir）解耦：浏览子目录时
  // currentRelDir 变但 currentFileRelDir 保持指向文件所在目录，
  // 防止 onFilesChanged 把「子目录事件」误判为「打开的文件被外部删除」。
  currentFileRelDir: '',
  // 当前打开的文件是否支持 Markdown 预览。
  // 只有 .md / .markdown 才走 viewer.loadContent() + preview/split 模式；
  // 其它可编辑文件（.txt/.py/.json/...）只走编辑器，viewer 走"不支持预览"空态。
  currentFileIsMarkdown: false,
};

/**
 * 元素引用
 */
const els = {
  searchInput: document.getElementById('search-input'),
  fileList: document.getElementById('file-list'),
  linkOpenFolder: document.getElementById('link-open-folder'),
  linkSwitchFolder: document.getElementById('btn-switch-folder'),
  btnResetFolder: document.getElementById('btn-reset-folder'),
  markdownBody: document.getElementById('markdown-body'),
  emptyState: document.getElementById('empty-state'),
  editorPane: document.getElementById('editor-pane'),
  splitter: document.getElementById('splitter'),
  sidebar: document.getElementById('sidebar'),
  sidebarSplitter: document.getElementById('sidebar-splitter'),
  btnSidebarResetWidth: document.getElementById('btn-sidebar-reset-width'),
  statusPath: document.getElementById('status-path'),
  statusMeta: document.getElementById('status-meta'),
  statusCount: document.getElementById('status-count'),
  statusMode: document.getElementById('status-mode'),
  statusModeLabel: document.getElementById('status-mode-label'),
  statusStats: document.getElementById('status-stats'),
  statusScroll: document.getElementById('status-scroll'),
  statusHeading: document.getElementById('status-heading'),
  // AI chip：状态栏新增，承载 AI 过程/错误/待确认状态 —— 见 [feedback-ai-tips-into-status-bar]
  statusAi: document.getElementById('status-ai'),
  statusAiLabel: document.getElementById('status-ai-label'),
  statusUnsaved: document.getElementById('status-unsaved'),
  toolbarAutosave: document.getElementById('toolbar-autosave'),
  btnSortName: document.getElementById('btn-sort-name'),
  btnSortMtime: document.getElementById('btn-sort-mtime'),
  btnTheme: document.getElementById('btn-theme'),
  btnPin: document.getElementById('btn-pin'),
  btnSave: document.getElementById('btn-save'),
  // 关闭当前文件（仅清空视图，磁盘文件不动）：放工具栏「操作组」紧邻保存按钮，
  // 语义上「保存」与「关闭」是相邻操作。沿用 .btn-icon，disabled 态走现有规则。
  btnCloseFile: document.getElementById('btn-close-file'),
  btnModePreview: document.getElementById('btn-mode-preview'),
  btnModeEdit: document.getElementById('btn-mode-edit'),
  btnModeSplit: document.getElementById('btn-mode-split'),
  btnSettings: document.getElementById('btn-settings'),
  btnResetLayout: document.getElementById('btn-reset-layout'),
  btnNewFile: document.getElementById('btn-new-file'),
  // Stage 8：Folder Browser 面包屑
  sidebarBreadcrumb: document.getElementById('sidebar-breadcrumb'),
  btnBreadcrumbRoot: document.getElementById('btn-breadcrumb-root'),
  sidebarBreadcrumbTrail: document.getElementById('sidebar-breadcrumb-trail'),
  btnMin: document.getElementById('btn-min'),
  btnMax: document.getElementById('btn-max'),
  btnClose: document.getElementById('btn-close'),
  appShell: document.querySelector('.app-shell'),
  appTitle: document.getElementById('app-title'),
  /*
    appTitleText：长文件名截断用的内层 span（fix：长文件名导致 toolbar 偏移）。
    - updateWindowTitle 把文件名写入这里，再由 .app-title-text 的
      overflow:hidden + text-overflow:ellipsis 实现省略号截断
    - 没有这个 span（旧版 HTML 兜底）时退回 els.appTitle.textContent
  */
  appTitleText: document.getElementById('app-title-text'),
  // AI 修改：按钮 + 底部 dock + 中间面板
  btnAi: document.getElementById('btn-ai'),
  aiChatDock: document.getElementById('ai-chat-dock'),
  appAi: document.getElementById('app-ai'),
  aiSplitter: document.getElementById('ai-splitter'),
};

/**
 * 设置存储
 */
const settingsStore = new SettingsStore(window.api);

// 文件操作实例（Stage 4c 抽离到 src/file-ops.js）
// 用 let 声明：在 fileList / viewer / editor / contextMenu 都实例化后才赋值；
// 这些组件构造时的箭头函数以闭包方式引用 fileOps，到点击 / 实际调用时一定已赋值。
let fileOps;

/**
 * 应用持久化的主题到 <body data-theme>
 *
 * 只支持 'dark' | 'light' 两态——旧版本写入的 'auto' 由 bootstrap 启动时迁移掉。
 *
 * audit fix (H5-renderer)：editor 守卫 —— bootstrap 早期阶段（settings
 * 还在加载、editor 还没挂载）applyTheme 可能先于 editor 赋值，editor.setTheme
 * 会抛 TypeError。editor 是 let 在 bootstrap 里才赋值，applyTheme 在多个
 * 调用点（initialTheme / settings update）都有可能比 editor 早执行。
 */
function applyTheme(theme) {
  const resolved = theme === 'light' ? 'light' : 'dark';
  document.body.dataset.theme = resolved;
  // 通知编辑器切换主题（oneDark / 浅色）—— 编辑器不在时静默跳过
  if (editor && typeof editor.setTheme === 'function') {
    editor.setTheme(resolved);
  }
}

function syncThemeButton(theme) {
  const label = theme === 'dark' ? '暗色主题' : '亮色主题';
  els.btnTheme.title = `切换主题 (当前: ${label})`;
  // audit H/M (a11y)：屏幕阅读器不会读 title/可见文字的状态变化，需要同步
  // aria-label 让 SR 用户听到「当前: 暗色 / 亮色主题」；theme 是二态循环，
  // 用 aria-pressed 比 aria-label 更诚实（"按下=当前态"），但这里实际是
  // 二选一的状态描述而非 toggle，所以用 aria-label 同步更准。
  // Phase M a11y：补 aria-pressed —— 二态按钮「按下=当前态」对 SR 用户
  // 更直接，配合 aria-label 双重表达（"当前暗色" + "按下=true"）。
  els.btnTheme.setAttribute('aria-label', `切换主题 (当前: ${label})`);
  els.btnTheme.setAttribute('aria-pressed', theme === 'dark' ? 'true' : 'false');
}

/**
 * 主题风格（palette）：与暗/亮正交独立的颜色风格维度。
 *
 * CSS 选择器形式：`[data-theme-palette="X"][data-theme="Y"]`。
 * 编辑器（CodeMirror）通过 CSS 变量自动跟随，无需在此通知。
 *
 * audit fix (Phase L2 M1)：之前是硬编码的 ['default', 'ocean', 'forest',
 * 'lavender', 'sunset'] + 中文 label map。schema 在 shared/settings-schema.js
 * 里有单一事实源（SETTINGS_UI_OPTIONS.themePalette），加新 palette 只需改
 * schema 一处。settings-dialog.js 早已用这套（[src/settings-dialog.js:28]），
 * 这里对齐同样的 source，避免双份字面量漂移。
 */
const PALETTES = (window.api?.settingsSchema?.SETTINGS_UI_OPTIONS?.themePalette ?? [])
  .map((p) => p.value);
const PALETTE_LABEL = (window.api?.settingsSchema?.SETTINGS_UI_OPTIONS?.themePalette ?? [])
  .reduce((acc, p) => { acc[p.value] = p.label; return acc; }, {});

function applyPalette(palette) {
  const resolved = PALETTES.includes(palette) ? palette : 'default';
  document.body.dataset.themePalette = resolved;
}

function syncPinButton(enabled) {
  els.btnPin.classList.toggle('is-active', !!enabled);
  // audit M (a11y)：置顶是 toggle，aria-pressed 让 SR 知道当前是「开」还是「关」
  els.btnPin.setAttribute('aria-pressed', String(!!enabled));
}

function syncMaxButton(isMaximized) {
  els.btnMax.title = isMaximized ? '还原' : '最大化';
  // audit M (a11y)：最大化是 toggle，aria-pressed 同步当前态
  els.btnMax.setAttribute('aria-pressed', String(!!isMaximized));
}

/**
 * 同步保存按钮：始终显示在工具栏，脏时进入 is-dirty 提醒态（warning 色 + 脉动），
 * 保存飞行期间进入 is-saving 态（cursor progress + opacity）——
 * 见 [[feedback-save-button-always-visible]]。干净时仍可点击，是空操作（save() 内部
 * 会因 !isDirty 提前返回）；保留按钮可见避免用户去记忆「按钮出现 ⇒ 需要保存」
 * 这个时序信号，也避免侧栏在切文件 / 保存成功时按钮位置跳动。
 *
 * 三态 / 「保存中」counter 语义 / 不设 disabled 等设计要点都在 src/save-button-ui.js
 * 里详细说明。这里只是个 thin wrapper：把模块级闭包 (els.btnSave / state / IPC)
 * 传给纯函数 helper，方便单测。
 */
// setDirty IPC 去重：savingCount 累加时 syncSaveButton 会被多次调用（共享路径
// 进/出 + 主路径 finally），但 isDirty 值不变 —— 不必每次都发 IPC。仅在
// isDirty 翻转时通知主进程，避免飞行期 IPC 噪音（关闭确认需要这个值）。
let lastSentDirtyToMain = null;
function syncSaveButton() {
  syncSaveButtonUI({
    btnSave: els.btnSave,
    statusUnsaved: els.statusUnsaved,
    state,
    setDirty: (dirty) => {
      if (dirty === lastSentDirtyToMain) return;
      lastSentDirtyToMain = dirty;
      window.api.setDirty(dirty).catch(() => {});
    },
  });
  // audit fix (save-button audit)：syncSaveButton 是 state.isDirty / state.savingCount
  // 变化的唯一入口（save() 主路径末尾 + openFile / clearCurrentFile / 编辑器 onChange /
  // 共享路径 finally 都会调它）。appTitle 的 dirty marker 「*」依赖 state.isDirty，
  // 但 updateWindowTitle 只在 clearCurrentFile / reload / openFile 三处调用，从不在
  // isDirty 翻转时调 —— 结果是 dirty 时标题栏一直停在「Notes — test.md」，缺
  // 「*」标记，用户看不出文件有未保存改动（在多窗口/多文件场景更割裂）。
  // 修复：syncSaveButton 内联调一次 updateWindowTitle，让标题/按钮/状态栏三处
  // 反馈始终同步。lastSentDirtyToMain 已在 helper 内部去重 IPC，这里只刷 DOM。
  updateWindowTitle();
  // 「关闭当前文件」按钮的 disabled 态跟 state.currentFile 走 —— 把它和
  // syncSaveButton 串到同一出口，openFile / clearCurrentFile 不必各自记得再调一次。
  // 这条调用非常便宜（几个 DOM 属性），不影响 hot path。
  syncCloseFileButton();
}

/**
 * 同步「关闭当前文件」按钮的 disabled 态：无文件可关时置灰，避免误导用户。
 * 不需要 pressed 态（这是命令式入口，不是 toggle），不需要 IPC 通知。
 * 走 .btn-icon 的现有 :disabled 样式（fg-tertiary + opacity:0.4 + cursor not-allowed）。
 *
 * 调用方：syncSaveButton / openFile / clearCurrentFile 末尾（与 syncSaveButton 复用同一
 * 触发点 —— 任何"当前文件"变化都会经由它们之一）。
 */
function syncCloseFileButton() {
  if (!els.btnCloseFile) return;
  const hasFile = !!state.currentFile;
  els.btnCloseFile.disabled = !hasFile;
  els.btnCloseFile.setAttribute('aria-disabled', hasFile ? 'false' : 'true');
  // title / aria-label 同步：屏幕阅读器对 disabled 按钮仍会读 aria-label；
  // 无文件时明确说「无打开文件」，避免读屏用户听到「关闭当前文件」后去按一个禁用的按钮。
  if (hasFile) {
    els.btnCloseFile.title = '关闭当前文件 (Ctrl+W)';
    els.btnCloseFile.setAttribute('aria-label', '关闭当前文件');
  } else {
    els.btnCloseFile.title = '关闭当前文件（无打开文件）';
    els.btnCloseFile.setAttribute('aria-label', '关闭当前文件（无打开文件）');
  }
}

/**
 * audit fix (Round 3 bug 2026-08)：同步 state.isDirty 到 editor.isDirty() 的实时真相。
 *
 * state.isDirty 是 markdown-editor 的 onChange 维护的派生状态，但 updateListener 在
 * IME 合成期间跳过 onChange（`if (... && !isComposing && onChangeCallback)` 的
 * `!isComposing` 守卫）—— 用户用 CJK 拼音 / 日文 IME / 韩文 IME 输入的字符不会触
 * 发 state.isDirty 翻转。markdown-editor.js#compositionend 主动补发 onChange 让
 * state 跟上 doc，但**前提是 compositionend 事件能 fire**。
 *
 * 触发 stale 的两条路径：
 *   - 用户在 IME 期间用键盘 Ctrl+S 触发保存 —— 焦点不离开编辑器，compositionend
 *     不立即 fire，state.isDirty 短暂 stale。
 *   - 用户在 IME 期间用 mousedown 点保存按钮 —— mousedown 抢焦点 → compositionend →
 *     onChange → state.isDirty 翻 true 的时序可能在 click handler 之后才到（不同
 *     浏览器/输入法的派发顺序差异）。
 *
 * stale 期间的副作用：
 *   - save() `!state.isDirty` 早退返回「已是最新」，但 editor.doc 里有未保存的
 *     IME 字符，磁盘没写入。
 *   - openFile / 切数据目录 / 关闭窗口 / Ctrl+R 的「未保存改动」对话框不弹，
 *     切走时 IME 字符随 view 销毁静默丢失（更严重的数据丢失）。
 *
 * editor.isDirty() 直接比 view.state.doc.toString() 与 lastSavedDoc，是「有未保
 * 存字符」的实时真相源（IME 临时字符也算 dirty）。
 *
 * 单向提升同步（**只**做 false → true）由 src/dirty-sync.js 纯函数实现 —— 本
 * 函数只是薄包一层，调 syncSaveButton 同步按钮视觉态 / IPC setDirty。
 *
 * 调用方：所有用 state.isDirty 做"有未保存改动"判断的入口（save / openFile /
 * withDataDirDirtyCheckHook / onSaveRequest / onReload / onFilesChanged rescue /
 * mountKeyboardShortcuts.onSave）在读取 state.isDirty 前必须调一次本函数，让
 * state 跟上 editor 的实时真相。
 *
 * @returns {boolean} 是否发生了提升（false→true）
 */
function syncDirtyFromEditor() {
  if (syncDirtyFromEditorPure(state, editor)) {
    syncSaveButton();
    return true;
  }
  return false;
}

/**
 * AI 修复预览显隐 → 视图模式锁定
 *
 * AI 修复预览（中间 diff 面板）出现时：强制编辑器切到「编辑」模式；如果是预览 / 双栏
 * 状态则一并跳到编辑。同时锁定模式 —— 期间不让切到 preview / split。
 *
 * AI 修复预览关闭时：解除模式锁，按当前 isMd 走回正常的 preview/split 禁用逻辑。
 *
 * 这是 ai-controller 的 onDiffOpenChange 回调的唯一职责，不在 controller 内做
 * （controller 不依赖 DOM 视图细节，仅 fire 事件），也不在 syncBodyFlag 内做
 * （避免 controller 与 DOM 操作耦合）。
 *
 * @param {boolean} isOpen
 */
function handleAiDiffOpenChange(isOpen) {
  if (isOpen) {
    // 锁模式到 edit —— toolbar 的 setModeLock 会让 selectMode / cycle / 外部 setMode
    // 都被吸到 edit；用户点 preview / split 按钮、状态栏 chip、Ctrl+E 都无效。
    editorToolbar.setModeLock('edit');
    // 强制切到 edit（即使当前已经在 edit 也无副作用 —— applyEditorMode 内部走 _setDOM）。
    // focus: false 避免偷焦点：用户可能在 AI 输入框里编辑 prompt，不应被打断。
    applyEditorMode('edit', { focus: false });
    // AI 修改预览打开时重置面板宽度 = 可用区 50%
    // —— 用户每次打开都默认对半分，drag 比例仅在本次会话内有效
    resetAiPanelWidthToHalf();
  } else {
    // 解除锁；按持久化的 state.editorMode 走正常的 md/non-md 禁用逻辑
    // （非 md 文件下 preview / split 仍会被禁用，md 文件恢复可选）。
    editorToolbar.setModeLock(null);
    applyEditorMode(state.editorMode, { focus: false });
  }
}

/**
 * 同步侧栏底部 AI 按钮的 pressed 态 / hint —— 模块级 helper，被 mountAiPanel
 * 的 click handler 与 bootstrap 的 onToggleAi 快捷键 handler 共享。
 * 单一入口，避免三处（点击 / 快捷键 / MutationObserver）重复更新导致
 * aria-pressed / aria-label / title 错位。
 */
function syncAiButton(open) {
  if (!els.btnAi) return;
  els.btnAi.setAttribute('aria-pressed', open ? 'true' : 'false');
  // P2-5 fix (audit)：aria-label 也跟着 open/close 状态切换，否则
  // 屏幕阅读器只听到固定的"AI 修改"，按钮按下后状态变了但读屏不会变。
  els.btnAi.setAttribute('aria-label', open ? '关闭 AI 修改' : 'AI 修改');
  els.btnAi.title = open ? '关闭 AI 修改 (Ctrl+Shift+A)' : 'AI 修改 (Ctrl+Shift+A)';
}

/**
 * 文件列表组件
 */
const fileList = new FileList({
  element: els.fileList,
  searchInput: els.searchInput,
  // Stage 8：onSelect 收到的是「条目」而非只是文件 —— entryType 决定分发：
  //   folder   → enterFolder() 进入子目录
  //   editable → openFile()  打开编辑
  //   binary   → toast 提示不支持的类型
  onSelect: (entry) => {
    if (!entry) return;
    if (entry.entryType === 'folder') {
      enterFolder(entry);
      return;
    }
    if (entry.entryType === 'binary') {
      showToast('不支持的文件类型', 'warning', 1500);
      return;
    }
    openFile(entry);
  },
  onContextMenu: (entry, x, y) => fileOps.showFileListContextMenu(entry, x, y),
  // M-series fix (audit Phase M-H2)：移除 fileList.setFiles 触发的 onFileRemoved
  // 回调。旧逻辑仅凭「previousActive 不在新 entries 里」就通知上层清空编辑器，
  // 把「用户导航到子目录」（Folder Browser：浏览期间不自动关文件）与「文件被
  // 外部删除」混淆。删除判定现在统一在 app.js#applyEntries 里用 directory
  // 比对（见下方）做精确区分；fileList 只负责渲染。
});

/**
 * Markdown 阅读视图
 */
const viewer = new MarkdownViewer({
  bodyElement: els.markdownBody,
  emptyElement: els.emptyState,
  statusPath: els.statusPath,
  statusMeta: els.statusMeta,
  // 无打开文件时，状态栏左侧 chip 用 state.currentDir 展示当前浏览目录路径
  // （替代原来的「—」占位），让用户随时知道自己在哪一层目录。
  // 走 callback 而非缓存值：state.currentDir 切目录时会变。
  getCurrentDir: () => state.currentDir,
  // audit C3 安全修复：resolveRelativeImages 异步取数据目录做边界检查，
  // 防止恶意 markdown 通过 `<img src="../../etc/secret">` 直接 file:// 读外部文件。
  // 用 callback 而非缓存值，因为 dataDir 会随用户切换设置而变。
  getDataDir: () => {
    if (window.api && typeof window.api.getDataDir === 'function') {
      return window.api.getDataDir();
    }
    return null;
  },
  onExternalLink: async (url) => {
    // 相对路径：尝试解析为数据目录内的另一个 .md / .markdown 文件，在 app 内打开
    const resolved = resolveLocalFile(url);
    if (resolved && resolved.file) {
      const opened = await openFile(resolved.file);
      // 跨文件跳转保留 fragment：渲染完后让 viewer 滚到对应锚点
      // （同文件内的 #锚点 走 markdown-viewer.js 的 click handler，不经过这里）
      if (opened && resolved.fragment && viewer && typeof viewer.scrollToAnchor === 'function') {
        // 给 viewer 一次 rAF 让它先完成 innerHTML 写入再 scroll
        requestAnimationFrame(() => viewer.scrollToAnchor(resolved.fragment));
      }
      return;
    }
    // http(s) / mailto：交给主进程在系统默认浏览器打开。
    // openExternal 是 invoke（返回 Promise），必须 await 才能拿到真正的 envelope ——
    // 直接 if (window.api.openExternal(url)) 永远为真（旧版 boolean），失败提示成了死代码。
    // audit fix (Round 7 IPC-10)：主进程已切到 `{ ok, code, message }` envelope，
    // 这里按 ok + 优先 message / 兜底业务码 'INVALID_URL' 处理。
    const result = await window.api.openExternal(url);
    if (!result || !result.ok) {
      const msg = result && result.message
        ? result.message
        : '无法打开该链接';
      showToast(msg, 'warning');
    }
  },
});

/**
 * 解析 markdown 中的相对链接到数据目录里的另一个文件。
 * 只接受相对路径，绝对路径与已知协议交给外部浏览器。
 *
 * Stage 8：白名单放宽到 EDITABLE_EXTS 对应的扩展名（与主进程 file-ops.js 同步）；
 * `.md` / `.markdown` 之外也允许 `.txt` / `.json` / `.csv` 等纯文本，让用户
 * 在 md 里可以点击跳转到这些文件。
 *
 * 白名单从 shared/extension-lists.js 经 preload contextBridge 拿 Array
 * （preload 内 Array.from 转一次，原结构是 Set），单一事实源 —— 与
 * main/file-ops.js 的 EDITABLE_EXTS 自动同步，改白名单只改一处。
 *
 * @param {string} url
 * @returns {{path:string,name:string}|null}
 */
function hasEditableExt(lowerPath) {
  const exts = window.api && window.api.EDITABLE_EXTS;
  if (!exts || !Array.isArray(exts)) return false;
  const dot = lowerPath.lastIndexOf('.');
  if (dot < 0 || dot === lowerPath.length - 1) return false;
  // 取最后一个点之后到末尾的扩展名（basename 末段，路径里的 '.' 不算）
  const after = lowerPath.slice(dot + 1);
  const slashIdx = Math.max(after.lastIndexOf('/'), after.lastIndexOf('\\'));
  if (slashIdx === 0) return false;
  const ext = slashIdx > 0 ? after.slice(0, slashIdx) : after;
  return exts.includes(ext);
}

function resolveLocalFile(url) {
  if (!url || typeof url !== 'string') return null;
  // 锚点或带协议 → 不是本地文件
  if (url.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(url)) return null;
  if (!state.currentFile) return null;

  // 拆出锚点：先剥掉 ?query（query 不影响文件定位），再读 #fragment。
  // 之前 url.split('#')[0] 把 fragment 默默丢掉了 —— 点 `notes.md#section-2`
  // 打开后没法跳到对应标题。fragment 在跨文件跳转时一起返回给 openFile 调用方。
  let target = url.split('?')[0];
  const hashIdx = target.indexOf('#');
  let fragment = '';
  if (hashIdx >= 0) {
    fragment = target.slice(hashIdx + 1);
    target = target.slice(0, hashIdx);
  }
  if (!target) return null;
  try {
    target = decodeURIComponent(target);
  } catch {
    // 非法编码就按原文当路径
  }

  // 解析：当前文件所在目录 + url。
  // resolvePath 会正确保留 POSIX 的根 '/' —— 之前这里用 split+过滤空串+join，
  // 在 macOS/Linux 上会把开头的 '/' 吃掉，生成 'home/u/...' 这种无效路径。
  const baseDir = dirnameOf(state.currentFile.path);
  const resolved = resolvePath(baseDir, target);
  if (!resolved) return null; // 越过根目录

  // Stage 8：白名单放宽 —— 与 EDITABLE_EXTS 对齐（不仅限 .md/.markdown）
  const lower = resolved.toLowerCase();
  if (!hasEditableExt(lower)) return null;

  // 在已知列表里找（O(n) 但列表通常很小）
  const file = state.files.find(f => f.path === resolved || f.path.toLowerCase() === lower);
  if (file) return { file, fragment };

  // 不在列表里：构造一个临时文件对象（readFile 时再做存在性检查）
  return { file: { path: resolved, name: basenameOf(resolved) }, fragment };
}

/**
 * Markdown 编辑器（CodeMirror 6 包装）
 *
 * onChange: 内容变化时设 isDirty + 高亮保存按钮 + 双栏实时刷新预览（debounced）
 * onSave:   Ctrl/Cmd+S 触发；调用 app.save()
 * onScroll: 编辑器滚动 / 光标移动 → 同步右侧预览滚动（仅 split 模式）
 */
// audit fix (Renderer F1 / scheduleLivePreview IME guard)：
// IME 合成期间 onChange 会被每次 keystroke 触发（composition 阶段 content
// 包含临时选词），200ms debounce 内的最后一次 keystroke 仍然会 fire
// → 预览渲染中显示「选词中的临时字符」造成闪烁。最简方案：合成期直接
// 跳过预览，compositionend 强制渲染一次。
//
// 实现思路：把「是否正在 IME 合成」状态挂到模块级 _imeComposing，setTimeout
// fire 时若在合成期，延后到下一个 200ms；compositionend 强制同步一次预览。
// 不与 editor 自己的 composition 跟踪冲突 —— MarkdownEditor 不管 IME，
// 这里独立维护。
let livePreviewTimer = null;
let _imeComposing = false;
function scheduleLivePreview() {
  if (livePreviewTimer) clearTimeout(livePreviewTimer);
  livePreviewTimer = setTimeout(() => {
    livePreviewTimer = null;
    if (state.editorMode !== 'split' || !state.currentFile) return;
    // audit fix (Renderer F1)：合成期不渲染预览。重新调度 200ms 之后再看。
    if (_imeComposing) {
      scheduleLivePreview();
      return;
    }
    viewer.loadContentLive(editor.getContent());
  }, 200);
}

// 把 IME 状态绑定到 editorPane —— compositionstart / end 是 DOM 标准事件，
// 任何 contenteditable / input 元素都派发，CodeMirror 6 也走标准事件。
// signal: els.editorPane 的 abortSignal 用于卸载时解绑（如果未来引入）。
if (els.editorPane) {
  els.editorPane.addEventListener('compositionstart', () => { _imeComposing = true; });
  els.editorPane.addEventListener('compositionend', () => {
    _imeComposing = false;
    // 合成结束 → 强制刷新一次预览：把刚刚 commit 的中文 commit 进 viewer。
    // 复用 scheduleLivePreview 而非直接 loadContentLive，与正常编辑路径
    // 完全一致（debounce + 守卫）。
    scheduleLivePreview();
  });
}

// AI 聊天面板显隐观察器（模块级持有，便于 unload/卸载时 disconnect）
let aiObserver = null;

const editor = new MarkdownEditor({
  element: els.editorPane,
  onChange: () => {
    state.isDirty = editor.isDirty();
    syncSaveButton();
    updateStatusStats();
    scheduleLivePreview();
    // 编辑动作 → 重新调度自动保存（debounce 语义：每次键入重置计时器）
    // 仅当用户实际输入（isDirty=true）时才有意义；isDirty=false 的回声
    // （如 setExternalContent）也会调用本函数，但 scheduleAutoSave 里
    // save() 在 isDirty=false 时直接返回，所以是安全的 no-op。
    scheduleAutoSave(currentAutoSaveDebounceMs());
    // AI 应用了部分 region / 用户继续编辑：让 AI 控制器重算剩余 diff。
    // 由 controller 内部判断是否有 pendingDiff，没有就 no-op。
    ai && ai.onContentChanged();
  },
  onSave: () => save(),
  onScroll: (progress) => {
    // 任何模式下都先刷新状态栏（rAF 内 coalesce，多次触发无开销）；
    // split 模式再额外把 viewer 同步过去。syncScrollGuard 用来避免
    // 反向同步（A→B→A）的循环。
    updateStatusScroll();
    if (state.editorMode !== 'split') return;
    if (syncScrollGuard) return;
    viewer.setScrollProgress(progress);
  },
});

/**
 * AI 修改控制器（自然语言 → diff → 应用）。
 *
 * 持有挂载点 + 编辑器 + state + 反馈回调，在 bootstrap 末尾完成 mount。
 * 此处先声明变量，bootstrap 里再 new —— 因为 createAiController 需要
 * settingsStore.getAll() 作为 getSettings 回调（settings 还没加载完时
 * 引用不到），所以延迟到 bootstrap 里。
 *
 * 编辑器 onChange 已经能回调到这里；openFile / clearCurrentFile / 文件外部
 * 修改覆盖本地 都通过 ai.onFileChanged 同步清掉 pendingDiff。
 */
let ai = null;

/**
 * 双栏反向同步：用户滚动阅读视图时，让编辑器跟随。
 *
 * 互斥锁 syncScrollGuard 防止「A→B→A→B」循环：
 * 编辑器触发 onScroll → viewer.setScrollProgress → 不会再次触发 viewer.onScroll
 * （我们的反向监听只在 user scroll 时触发，不在程序 set 时触发，因为
 *   setScrollProgress 是直接赋值 scroller.scrollTop，不会触发 scroll 事件
 *   —— 但某些浏览器仍然派发，所以加一道时间窗防护最稳）。
 */
let syncScrollGuard = false;
// audit fix (K2-M5)：长行 markdown（base64 / 内嵌 HTML / 未换行链接）下 editor /
// viewer 的 scrollHeight 不一致，progress 会算出不同值；rAF 1 帧就释放
// syncScrollGuard，会出现 A滚→B跟→B算progress推A→A跟→B再跟……的双栏
// 抖动。叠加 0.005 阈值（≈ 0.5% 滚动差）后，反向同步跳过「微抖」轮次，
// 双栏稳定下来。
let lastSyncedToEditor = -1;
viewer.onScroll((progress) => {
  if (state.editorMode !== 'split') return;
  if (syncScrollGuard) return;
  if (Math.abs(progress - lastSyncedToEditor) < 0.005) return;
  lastSyncedToEditor = progress;
  syncScrollGuard = true;
  editor.setScrollProgress(progress);
  // P1-9：用 rAF 而不是 setTimeout 50ms。
  // 50ms 是猜测值 —— 慢机器可能比 50ms 长，反向同步还没解除锁就被下一波 scroll 顶住；
  // 快机器 + 持续滚动时 50ms 又太短，guard 解除后再次触发循环导致双栏滚动来回抖动。
  // rAF 在浏览器下一次绘制前释放：足以让程序触发的 scroll event 被消化掉，
  // 又比硬编码时间短更贴合实际渲染节奏。
  requestAnimationFrame(() => { syncScrollGuard = false; });
});

/**
 * 右键菜单：统一为阅读视图和编辑器提供 复制/剪切/粘贴/全选
 *
 * 阅读视图（preview / split）：仅 复制 + 全选（视图是只读 HTML）
 * 编辑器（edit / split）：复制 / 剪切 / 粘贴 / 全选，按当前选区/可写状态启用禁用
 */
const contextMenu = new ContextMenu();

/**
 * 文件操作实例化（Stage 4c）
 *
 * 依赖 state（共享）+ controls（fileList / viewer / editor / contextMenu）
 * + api（window.api）+ callbacks（openFile / updateWindowTitle / updateStatusStats
 * / syncSaveButton）。
 *
 * 函数声明（function xxx）在模块顶部被 hoist，所以这里传引用完全合法
 * —— 调用时一定已定义。
 */
fileOps = createFileOps({
  state,
  controls: { fileList, viewer, editor, contextMenu },
  api: window.api,
  callbacks: {
    openFile,
    updateWindowTitle,
    updateStatusStats,
    syncSaveButton,
    clearCurrentFile,
    // Phase N 修复：rename 扩展名变化（md↔非md）后必须重跑 applyEditorMode
    // 同步工具栏 preview/split 按钮可用性 + setReadOnly。
    // file-ops.js 不直接依赖 app.js 模块，所以走 callback 注入。
    applyEditorMode,
    // audit fix (Round 9)：rename 后通知 AI controller 清 pendingDiff。
    // 路径变化 → baseContent / forFilePath 脱节 → 防 stale apply。
    // 用 ai.onFileChanged 而非直接传 ai 模块，保持 file-ops 无 app.js 依赖。
    onFileChanged: (file) => {
      if (ai && typeof ai.onFileChanged === 'function') {
        try { ai.onFileChanged(file); } catch (e) {
          console.warn('[app] ai.onFileChanged (rename) failed:', e);
        }
      }
    },
  },
});

/**
 * 当前文本选区是否非空（用于动态启用「复制 / 剪切」）
 */
function hasTextSelection() {
  const sel = window.getSelection();
  return !!(sel && sel.toString().length > 0);
}

/**
 * 把文本写入剪贴板。失败时给用户反馈（避免默默吞错）。
 * @param {string} text
 */
async function writeClipboard(text) {
  if (!text) return;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch (e) {
    console.warn('[app] navigator.clipboard.writeText 失败:', e);
  }
  // 兜底：execCommand 在 Electron 内仍可用
  try {
    const ok = document.execCommand('copy');
    if (!ok) throw new Error('execCommand 失败');
  } catch (e) {
    console.error('[app] 复制到剪贴板失败:', e);
    showToast('复制失败', 'error', 1500);
  }
}

/**
 * 从剪贴板读文本
 * @returns {Promise<string>}
 */
async function readClipboard() {
  try {
    if (navigator.clipboard && navigator.clipboard.readText) {
      return await navigator.clipboard.readText();
    }
  } catch (e) {
    console.warn('[app] navigator.clipboard.readText 失败:', e);
  }
  showToast('粘贴失败：无法访问剪贴板', 'error', 1500);
  return '';
}

/**
 * 阅读视图的右键菜单：复制 + 全选
 */
function mountViewerContextMenu() {
  if (!els.markdownBody) return;
  els.markdownBody.addEventListener('contextmenu', (e) => {
    // 当前焦点不在 viewer 内、或 view 隐藏时不弹出
    if (els.markdownBody.hidden) return;

    e.preventDefault();

    // 把当前选区存起来 —— 用户右键时选区已经形成
    const selected = hasTextSelection();

    contextMenu.show({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: '复制', value: 'copy', disabled: !selected },
        { separator: true, value: '' },
        { label: '全选', value: 'select_all' },
      ],
      onSelect: async (value) => {
        if (value === 'copy') {
          const sel = window.getSelection();
          await writeClipboard(sel ? sel.toString() : '');
        } else if (value === 'select_all') {
          // 让 viewer 容器内的所有文本被选中
          const range = document.createRange();
          range.selectNodeContents(els.markdownBody);
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
        }
      },
    });
  });
}

/**
 * 编辑器的右键菜单：复制 / 剪切 / 粘贴 / 全选
 *
 * 与阅读视图共用同一个 ContextMenu 实例，但选项集不同。
 * 复制 / 剪切 / 粘贴都走 CodeMirror 的事务，保证 undo history 与选区一致。
 */
function mountEditorContextMenu() {
  if (!els.editorPane) return;

  els.editorPane.addEventListener('contextmenu', (e) => {
    // 编辑器被设为只读时（preview 模式时虽然 panel 隐藏，仍做一次防御）
    if (state.editorMode === 'preview') return;

    e.preventDefault();

    // 在用户右键时同步一次编辑器焦点，否则点菜单后操作的是文档其他位置
    if (editor.view && document.activeElement !== editor.view.contentDOM) {
      editor.view.focus();
    }

    const view = editor.view;
    const editable = !view || view.state.facet(EditorView.editable);

    // 取主选区（CM6 支持多选区，右键菜单只针对主选区）
    const sel = view ? view.state.selection.main : null;
    const hasSelection = !!sel && sel.from !== sel.to;

    const items = [
      { label: '复制', value: 'copy', disabled: !hasSelection },
      { label: '剪切', value: 'cut', disabled: !editable || !hasSelection },
      { label: '粘贴', value: 'paste', disabled: !editable },
      { separator: true, value: '' },
      { label: '全选', value: 'select_all' },
    ];

    contextMenu.show({
      x: e.clientX,
      y: e.clientY,
      items,
      onSelect: async (value) => {
        if (!view) return;
        if (value === 'copy') {
          const text = view.state.sliceDoc(sel.from, sel.to);
          await writeClipboard(text);
        } else if (value === 'cut') {
          const text = view.state.sliceDoc(sel.from, sel.to);
          await writeClipboard(text);
          view.dispatch({
            changes: { from: sel.from, to: sel.to },
            selection: { anchor: sel.from },
            userEvent: 'input.delete',
          });
        } else if (value === 'paste') {
          const text = await readClipboard();
          if (!text) return;
          view.dispatch({
            changes: { from: sel.from, to: sel.to, insert: text },
            selection: { anchor: sel.from + text.length },
            userEvent: 'input.paste',
          });
        } else if (value === 'select_all') {
          const len = view.state.doc.length;
          view.dispatch({
            selection: { anchor: 0, head: len },
            userEvent: 'select.pointer',
          });
          view.focus();
        }
      },
    });
  });
}

/**
 * 清空当前打开的文件（视图回到 empty-state）。
 *
 * 这条逻辑之前被复制在 4 处（openFile 的 FILE_NOT_FOUND 分支、
 * onFilesChanged 的「文件已删」、file-ops.deleteFile、
 * settings-dialog 改 dataDir），其中 lastSavedMtimeMs 的重置
 * 值还不一致（null / 0）—— 集中到一处后所有路径都走同一份。
 *
 * 不发「文件已关闭」toast：调用方各自负责"为什么清空"的提示
 * （文件被删 / 用户主动删除 / 切换目录）。
 */
function clearCurrentFile() {
  state.currentFile = null;
  state.currentFileIsMarkdown = false;
  state.isDirty = false;
  state.lastSavedMtimeMs = null;
  state.currentFileRelDir = '';
  // P2-4：重置抑制窗口基点。lastWriteMtimeMs 在 P1-2 后存的是 mtime，不是时间戳，
  // 但语义仍是「最近一次写盘的 mtime」；clear 后这个 mtime 已经没意义了，
  // 留着会让下一个打开的文件在第一秒内把外部修改误判为「自身回声」。
  state.lastWriteMtimeMs = 0;
  // 取消挂起的自动保存 —— editor 被 unload 不会触发 onChange，旧的 timer 会
  // 带着陈旧的闭包一直挂到触发点（虽然 timeout 里的 state 守卫让它 no-op，
  // 但闭包长期持有 state/editor/save 引用不释放）。
  cancelScheduledAutoSave();
  // audit fix (H155)：清掉挂起的 live preview。scheduleLivePreview 200ms 后
  // 会调 viewer.loadContentLive(editor.getContent()) —— 但 editor 已被 unload
  // （getContent 返回 ''）→ viewer 仍会渲染空字符串、把刚 clear 的 empty state
  // 覆盖掉。用户看到的现象：点了别的文件，刚 clear 完 viewer 又闪一下变白。
  if (livePreviewTimer) {
    clearTimeout(livePreviewTimer);
    livePreviewTimer = null;
  }
  syncSaveButton();
  viewer.clear();
  editor.unload();
  fileList.setActive(null);
  updateWindowTitle();
  updateStatusStats();
  // 关闭文件：清掉挂起的 AI 修改（避免误应用到下一个打开的文件）
  if (ai) ai.onFileChanged(null);
}

/**
 * 关闭当前打开的文件（视图回到 empty-state，但磁盘文件保持不变）。
 *
 * 与 clearCurrentFile 的区别：本函数处理"用户主动关闭"的脏状态对话框，
 * 把「保存 / 放弃 / 取消」三选一决策交给用户。clearCurrentFile 内部已经
 * 处理了状态清理（currentFile=null / viewer/editor unload / 高亮清除），
 * 所以 closeCurrentFile 只做"是否允许清空"的判断 + 复用 clearCurrentFile。
 *
 * 不弹「文件已关闭」toast：用户主动点的关闭按钮，给 toast 是噪音
 * （与 clearCurrentFile 的"无 toast"约定一致 —— 见 line 887）。
 *
 * dirty 检查复用 openFile 的"同步 editor.isDirty() → state.isDirty"
 * 守门（IME 合成期间 state.isDirty 可能 stale，导致 CJK 用户按 Ctrl+W
 * 跳过脏对话框静默丢失 IME 字符）。
 *
 * 调用方：工具栏「关闭文件」按钮 + Ctrl+W 快捷键 + （未来）文件列表右键。
 */
async function closeCurrentFile() {
  if (!state.currentFile) return; // 已经没打开文件 → 静默 no-op
  // IME 合成期同步 state.isDirty，与 openFile / save 走同一守门。
  syncDirtyFromEditor();
  if (state.isDirty) {
    const choice = await showConfirmDialog({
      title: '未保存的改动',
      message: `当前文件「${state.currentFile.name}」有未保存的改动。\n\n关闭前请选择如何处理。`,
      icon: 'warning',
      buttons: [
        { value: 'cancel', label: '取消' },
        { value: 'discard', label: '放弃改动', variant: 'danger' },
        { value: 'save_and_close', label: '保存并关闭', variant: 'primary' },
      ],
    });
    // 用户取消 / 关闭对话框 → 不关文件，原样保留
    if (choice === 'cancel' || choice == null) return;
    if (choice === 'save_and_close') {
      // 走 save() 主路径：拿到失败原因（冲突 / IME / 文件没了），让用户
      // 看到完整反馈；save() 失败时不关闭（避免编辑器被清空后又没保存上）
      const ok = await save();
      if (!ok) return;
    } else {
      // 'discard'：复位脏态 + editor 基线 + 保存按钮（与 openFile 的
      // save_and_open/discard 分支同款：避免 auto-save 飞行期拿旧
      // lastSavedMtimeMs 误判为「外部修改」、或 syncSaveButton 没刷 UI）
      cancelScheduledAutoSave();
      state.isDirty = false;
      state.lastSavedMtimeMs = null;
      editor.markSaved();
      syncSaveButton();
    }
  }
  clearCurrentFile();
}

/**
 * 从磁盘重新读取并替换当前文件的内容（外部修改覆盖本地）。
 *
 * 把读盘 + 替换编辑器内容 + 替换 viewer 内容 + 同步 mtime 基线
 * 集中到一处 —— 「外部修改」脏/干净两个分支共用，避免两边任一被改
 * 后另一处遗忘同步。
 *
 * Bug #2 fix (audit)：reload 完成后必须调 ai.onFileChanged() —— 否则
 * 用户在 AI 请求飞行期间被外部修改当前文件，AI 拿着「旧 baseContent」
 * 算出 diff 后 apply，会把外部的修改静默覆盖掉（数据丢失风险）。
 * ai.onFileChanged 内部递增 requestGeneration + 清 pendingDiff + 重置
 * chat 状态，让「应用此处」按钮在 AI 重算完之前不再响应任何点击。
 *
 * @param {{path:string,name:string,mtimeMs?:number,size?:number}} file
 * @returns {Promise<boolean>} 是否成功替换（失败时调用方应保持原状态）
 */
async function reloadCurrentFileFromDisk(file) {
  if (!file || !file.path) return false;
  // 防 stale reload：用户可能在 await 之前已经切换 / 关闭文件。
  // 这种情况不能再用 state.currentFile 重新装载 —— 否则会把 A 的 mtime/size
  // 写到 B（或空）的 state 上，导致「切到 C 后状态栏又跳回 A」之类的诡异 UX。
  const targetPath = file.path;
  // audit fix (C5)：记录 reload 启动时的脏状态。await readFile 期间用户可能敲了
  // 几下键盘（state.isDirty 已经 true）。如果磁盘版本和本地无差异还好 —— 但我们
  // 仍然会调 setExternalContent 把它覆盖掉，用户输入丢失。调用方在「外部修改
  // 覆盖本地」分支已经在 reload 之前检查了 isDirty 并弹出冲突对话框，但「无本地
  // 修改、外部无变化」的静默 reload 路径里仍然有窗口：readFile 期间用户恰好输入
  // 了一个字符。下面这道「启动时脏 → 拒绝 reload」是更稳的兜底，代价是极少数
  // 情况下用户要多走一次冲突对话框（概率低、语义也合理）。
  //
  // audit fix (Phase O-H4)：用 editor.isDirty() 而非 state.isDirty。
  // state.isDirty 由 markdown-editor 的 updateListener 维护，IME 合成期间
  // （CJK 拼音输入）刻意跳过 onChange，state.isDirty 不刷新，但 view.state.doc
  // 已含 IME 临时字符。如果此时外部修改触发 reload，state.isDirty 仍是上一帧的
  // false → 穿过 dirtyAtStart/state.isDirty 守门 → setExternalContent 全量替换
  // doc → IME buffer 静默丢失。editor.isDirty() 直接比 view.state.doc.toString()
  // 与 lastSavedDoc，反映编辑器内部实时真相（IME 临时字符也算 dirty）。
  const dirtyAtStart = editor.isDirty();
  const result = await window.api.readFile(targetPath);
  // 第二次 await 后再次校验 —— 用户可能在 readFile 期间切走。
  if (!state.currentFile || state.currentFile.path !== targetPath) {
    return false;
  }
  if (!result.ok) {
    // audit fix (Phase L3-FS 1A)：二进制内容误命名为 .md 时不静默。
    // 外部 reload 路径下用户已经在编辑该文件，弹 toast 提示「已阻止」，
    // 不替换当前内容（避免用户继续编辑并保存污染版本）。
    if (result.error === 'NOT_TEXT') {
      showToast(result.message || '该文件不是有效的文本文件，已阻止加载', 'error');
    }
    return false;
  }
  // audit fix (C5)：await 期间用户开始输入 → 直接拒绝覆盖，把决定权留给调用方。
  // 调用方应该已经看过 isDirty=false 才进来的，但这是冗余兜底，成本低。
  // audit fix (Round 4 P1-3)：readFile await 期间可能触发 IME 合成（用户开始输入
  // 中文拼音）—— state.isDirty 由 updateListener 维护，IME 期间刻意跳过 onChange，
  // state.isDirty 仍为 false 但 editor 内部 view.state.doc 已含 IME 临时字符。
  // 这里改用 editor.isDirty()（与 dirtyAtStart 同源），覆盖 IME 这条 race 路径，
  // 否则 setExternalContent 全量替换会摧毁 IME buffer。
  if (dirtyAtStart || editor.isDirty()) {
    return false;
  }
  // 重新计算 currentFileIsMarkdown（理论上 reload 是同一路径，但 path 可能改变 —— 如重命名）
  state.currentFileIsMarkdown = isMarkdownFile(targetPath);
  // audit fix (Round 9)：readFile 期间用户可能进入 IME 合成（上面 906 行的
  // dirtyAtStart / editor.isDirty 守门用的是同步快照，到这里又过了一个同步
  // 路径，理论上 IME 还没起，但 editor.setExternalContent 自己内部又会再
  // 检一次 _composing）—— 抛 EDITOR_COMPOSING 时不能让 unhandled rejection
  // 冒上来。catch 后保持原状态（不替换 view，让用户 IME 结束后再点一次
  // 「重新加载」按钮）。
  try {
    editor.setExternalContent(result.content);
  } catch (e) {
    if (e && e.message === 'EDITOR_COMPOSING') {
      showToast('正在输入中文，请稍后再试', 'warning', 2000);
      return false;
    }
    throw e;
  }
  if (state.currentFileIsMarkdown) {
    viewer.loadContent(file, result.content);
  } else {
    viewer.showUnsupportedFile(file);
  }
  state.lastSavedMtimeMs = result.mtimeMs;
  state.currentFile = { ...state.currentFile, ...file, mtimeMs: result.mtimeMs, size: result.size };
  state.isDirty = false;
  syncSaveButton();
  updateWindowTitle();
  // reload 也按当前文件的 markdown 状态重新约束视觉模式 + 按钮可用性
  // audit fix (Phase 7 M2)：{ focus: false } 防止外部 reload 偷焦点 —— 用户
  // 可能正在侧栏 / 状态栏操作，强行 focus 到编辑器会打断交互。
  // 只重置 setReadOnly / 按钮可用性，不主动抢键盘焦点。
  applyEditorMode(state.editorMode, { focus: false });
  // Bug #2 fix：告诉 AI controller 文件内容已变更 —— 增量 generation、
  // 丢弃当前 pendingDiff（防 stale apply 覆盖外部修改）。
  if (ai && typeof ai.onFileChanged === 'function') {
    try { ai.onFileChanged(state.currentFile); } catch (e) {
      // 不让 ai 异常阻断 reload —— 但留 console 便于排查回归
      console.warn('[app] ai.onFileChanged failed:', e);
    }
  }
  return true;
}

/**
 * 更新顶部 app-title 文案。
 * 没有打开文件 → "Notes"；打开了 → "Notes — 文件名"；
 * 文件脏 → 追加星号后缀。
 *
 * 长文件名截断（fix：长文件名导致 toolbar 偏移）：
 * - 写入 #app-title-text（内层 span），CSS 负责 ellipsis 截断
 * - 同步写 title 属性，鼠标悬停可看到完整文件名（截断后丢失的信息补救）
 * - 没有 #app-title-text（兜底）时退回 #app-title.textContent
 */
function updateWindowTitle() {
  if (!els.appTitle) return;
  const target = els.appTitleText || els.appTitle;
  const base = 'Notes';
  if (!state.currentFile) {
    target.textContent = base;
    target.removeAttribute('title');
    return;
  }
  const dirtyMark = state.isDirty ? ' *' : '';
  const fullText = `${base} — ${state.currentFile.name}${dirtyMark}`;
  target.textContent = fullText;
  // 长文件名截断后丢失信息；title 属性给鼠标用户补回完整文本
  target.title = fullText;
}

/**
 * 视图模式切换工具栏
 *
 * 重要：setMode 写 dataset + 高亮按钮；cycle 走 onChange 让 app 同步持久化。
 * 启动时直接调用 setMode() 不触发 onChange —— 因为此时 app 还没初始化完成，
 * 而且持久化已经在 settings-store.load() 时完成。
 */
const editorToolbar = new EditorToolbar({
  elements: {
    btnPreview: els.btnModePreview,
    btnEdit: els.btnModeEdit,
    btnSplit: els.btnModeSplit,
  },
  onChange: (mode) => {
    settingsStore.update({ editorMode: mode });
    // 注意：splitRatio=0.5 的重置在 applyEditorMode 内部做（visualMode 闸），
    // 这里不需要重复写 —— onChange / bootstrap / reload / AI lock 都会走 applyEditorMode，
    // 单点维护。
    applyEditorMode(mode);
  },
});

/**
 * 双栏左侧占比：clamp 到 0.2..0.8（与主进程 app:save-settings 的校验一致），
 * 非法值回落到 0.5。
 * @param {unknown} value
 * @returns {number}
 */
function clampSplitRatio(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0.5;
  return Math.max(0.2, Math.min(0.8, n));
}

/**
 * 应用视图模式到 DOM 和编辑器
 *
 * Stage 8：非 Markdown 文件（.txt/.py/.json/...）只支持编辑 —— 即使 state.editorMode
 * 持久化的是 'preview' 或 'split'，DOM 视觉模式也强制回落到 'edit'；toolbar 的
 * preview/split 按钮 disabled（hover 提示原因）。
 *
 * 注意：state.editorMode 本身保持不变 —— 用户回到 Markdown 后能恢复上次选的模式。
 */
/**
 * 应用视图模式到 DOM 和编辑器
 *
 * Stage 8：非 Markdown 文件（.txt/.py/.json/...）只支持编辑 —— 即使 state.editorMode
 * 持久化的是 'preview' 或 'split'，DOM 视觉模式也强制回落到 'edit'；toolbar 的
 * preview/split 按钮 disabled（hover 提示原因）。
 *
 * 注意：state.editorMode 本身保持不变 —— 用户回到 Markdown 后能恢复上次选的模式。
 *
 * @param {string} mode - 'preview' | 'edit' | 'split'
 * @param {object} [opts]
 * @param {boolean} [opts.focus=true] - 是否在切到 edit/split 时聚焦编辑器。
 *   audit fix (Phase 7 M2)：外部 reload（fs-watcher 触发的 reloadCurrentFileFromDisk）
 *   不应该偷焦点 —— 用户可能正在侧栏 / 状态栏操作，强行 focus 到编辑器会
 *   打断交互。reload 路径显式传 { focus: false }。默认 true 保持用户主动切模式时的行为。
 */
function applyEditorMode(mode, opts) {
  if (!EDITOR_MODES.includes(mode)) return;
  state.editorMode = mode;

  // 非 md 文件：把视觉模式强制回落到 'edit'，但不写 state.editorMode。
  const isMd = state.currentFileIsMarkdown;
  const visualMode = isMd ? mode : 'edit';

  // 视觉模式从非 split 切到 split 时重置 splitRatio=0.5 —— 用户期待「双栏」= 50/50
  // （每次进入双栏都从默认比例起步，drag 只在本次会话内有效）。
  // 用 DOM 上的 prevVisualMode（document.body.dataset.editorMode）而不是 state.editorMode：
  //   - state.editorMode 会在 AI 打开时被覆盖为 'edit'（handleAiDiffOpenChange(true) →
  //     applyEditorMode('edit')），与用户真正看到的视觉模式可能脱节；
  //   - DOM 是 CSS 渲染的唯一依据，在 _setDOM 同步写入；这里在 setMode 之前读，正好是
  //     「进入前的视觉状态」，符合「看到双栏的瞬间重置」语义。
  // 这同时覆盖 md ↔ non-md 重命名场景：把 .md 改 .txt 时视觉退回 edit，再改回 .md 时
  // 视觉从 edit 重新进入 split，闸触发重置。
  // bootstrap 时 currentFile=null → isMd=false → visualMode='edit'，闸不触发（视觉不显示 split）；
  // 用户打开第一个 md 文件时 applyEditorMode 触发，visualMode='split'，DOM 之前是 'edit'，
  // 闸触发 —— 视觉上用户看到 split 的瞬间就是 50/50。
  // settingsStore.update 是乐观写盘（缓存同步更新、IPC 异步），MutationObserver 作为
  // microtask 在当前同步块之后才 drain；reset 写在这里是先于 _setDOM，便于阅读。
  if (visualMode === 'split' && document.body.dataset.editorMode !== 'split') {
    settingsStore.update({ splitRatio: 0.5 });
  }

  // editorToolbar.setMode 内部已 _setDOM 写 body[data-editor-mode] + 高亮按钮；
  // 不要再单独 dataset，否则两边写同一属性会产生「两次 setAttribute」的
  // MutationObserver 噪音，调试时易误以为有别的代码在动 DOM。
  editorToolbar.setMode(visualMode); // 同步按钮高亮（disabled 状态由下方负责）

  // 只读：仅在 md 文件 + 视觉模式为 preview 时才把编辑器设为只读；
  // 非 md 文件强制可写（预览本来就不渲染，setReadOnly(true) 会让用户失去写入能力）。
  editor.setReadOnly(visualMode === 'preview' && isMd);

  // 切到 edit / split 时聚焦编辑器 —— 但外部 reload 路径不希望被 focus 偷走
  const wantFocus = opts ? opts.focus !== false : true;
  if (wantFocus && (visualMode === 'edit' || visualMode === 'split')) {
    // 异步聚焦：等 DOM 更新后再 focus，否则可能焦点丢失。
    // 与 scrollFrame 同款风格：track 住 handle，连按 Ctrl+E 时只 focus 一次。
    if (editorFocusFrame) cancelAnimationFrame(editorFocusFrame);
    editorFocusFrame = requestAnimationFrame(() => {
      editorFocusFrame = null;
      editor.focus();
    });
  }

  // 模式按钮可用性：非 md 文件禁用 preview / split（edit 仍可用）
  if (els.btnModePreview) {
    els.btnModePreview.disabled = !isMd;
    els.btnModePreview.title = isMd
      ? '预览模式'
      : '预览模式（仅 Markdown 支持）';
    els.btnModePreview.setAttribute('aria-disabled', isMd ? 'false' : 'true');
  }
  if (els.btnModeSplit) {
    els.btnModeSplit.disabled = !isMd;
    els.btnModeSplit.title = isMd
      ? '双栏模式'
      : '双栏模式（仅 Markdown 支持）';
    els.btnModeSplit.setAttribute('aria-disabled', isMd ? 'false' : 'true');
  }

  updateStatusMode();
  updateStatusStats();
  updateStatusScroll();
}

/**
 * 状态栏：模式 chip（预览 / 编辑 / 双栏）
 *
 * 切换 icon 跟着 mode 变：preview=eye / edit=pencil / split=split，
 * 让 chip 本身看着像个"切换器"，而不只是一个状态指示。
 */
function updateStatusMode() {
  if (!els.statusMode) return;
  const mode = state.editorMode
    || window.api?.settingsSchema?.DEFAULT_SETTINGS?.editorMode
    || 'split';
  const labels = { preview: '预览', edit: '编辑', split: '双栏' };
  // 文字写到 #status-mode-label 子 span（chip 内的 SVG 图标保留）
  if (els.statusModeLabel) els.statusModeLabel.textContent = labels[mode] || mode;
  els.statusMode.dataset.mode = mode;
  // audit M (a11y)：SR 只读 aria-label 不读 textContent；同步让屏幕阅读器用户
  // 听到「切换视图模式（当前：预览）」，与可见 chip 文字一致。
  els.statusMode.setAttribute('aria-label', `切换视图模式（当前：${labels[mode] || mode}）`);
}

/**
 * 状态栏：AI chip —— 承载 AI 过程/错误/待确认状态。
 *
 * controller + panel 通过 notify(text, type) 回调进来，本函数负责：
 *   - 把 type 写到 data-ai-state（CSS 据此切换 running 脉冲 / danger 色 / accent-soft 高亮）
 *   - 把 text + "AI · " 前缀写到 #status-ai-label（text 为空时只显示 "AI"）
 *   - 更新 title（鼠标悬停看完整文案 —— label 60 字截断）
 *
 * 见 [feedback-ai-tips-into-status-bar]：状态贴近作用区域，AI 提示不再占
 * AI dock 底部单独一行，而是收进底部状态栏这个高频状态展示区。
 *
 * @param {string} text - chip 显示文案（不含 "AI · " 前缀）
 * @param {'idle'|'running'|'cancelled'|'error'|'success'|'diff'|'info'} [type]
 */
function updateStatusAi(text, type) {
  if (!els.statusAi || !els.statusAiLabel) return;
  const safeType = type || 'idle';
  els.statusAi.dataset.aiState = safeType;
  // text 为空 → 只显示 "AI"；有内容 → "AI · {text}"。60 字截断保护
  // 状态栏窄时不至于把 count / scroll 挤出去。
  const label = text && text.length > 0 ? `AI · ${text}` : 'AI';
  els.statusAiLabel.textContent = label.length > 60 ? `${label.slice(0, 59)}…` : label;
  els.statusAi.title = text || 'AI 修改';
  // audit M (a11y)：状态栏 chip 文字变化（idle/running/diff/error）对屏幕阅读器
  // 不可见 —— 只读 aria-label。把 state 拼进 aria-label 让 SR 用户能感知 AI 状态。
  // 同时 chip 也是 toggle（点击开/关 AI 面板），aria-pressed 反映 dock 状态。
  const stateHint = safeType === 'idle' ? '' : ` - ${text || safeType}`;
  els.statusAi.setAttribute('aria-label', `AI 修改${stateHint}`);
  // dock open state 由 syncAiButton 维护；这里只补 aria-label。
}

/**
 * 状态栏：字数 / 行数（编辑与查看共用）
 * - 编辑模式：直接读编辑器 view（实时反映用户输入）
 * - 预览模式：读 viewer 渲染后的纯文本
 */
let statsDebounceTimer = null;
function updateStatusStats() {
  if (statsDebounceTimer) {
    clearTimeout(statsDebounceTimer);
    // audit fix (K2-L9)：cancel 后立刻置 null —— 与 markdown-editor.js 的
    // _scrollFrame 同款风格。中途 cancel 到下一次 schedule 之间的窗口期，
    // 变量不再指向已 cancel 的旧句柄；后续若有「如果还挂着就 fire cancel
    // toast」之类的检查也不会踩坑。
    statsDebounceTimer = null;
  }
  statsDebounceTimer = setTimeout(() => {
    statsDebounceTimer = null;
    if (!els.statusStats) return;
    // 没有打开任何文件时，把字数 chip 直接藏掉，避免显示「0 词 · 0 行」误导用户
    if (!state.currentFile) {
      els.statusStats.hidden = true;
      els.statusStats.textContent = '';
      return;
    }
    let stats = { words: 0, lines: 0 };
    try {
      if (state.editorMode === 'preview') {
        stats = viewer.getStats();
      } else {
        stats = editor.getStats();
      }
    } catch (e) {
      // getStats 抛错（常发生在 pagehide / file clear 中途 view 已 dispose）
      // —— 不重置 textContent 让 chip 保留上次值，同时 console.warn 留排查线索
      console.warn('[app] updateStatusStats getStats failed:', e);
    }
    // Phase N M-2 fix：空文件（chars=0 / lines=0）不显示「0 词」chip。
    // 旧实现 formatStatusStats({words:0, lines:0}) 返回 '0 词'，状态栏中间一直
    // 显示一个误导 chip（"我打开了一个真的文件，但字数是 0"）。
    // viewer 已用「（空文件）」占位文案提示，这里让 stats chip 也不出现，双重反馈一致。
    const isEmpty = stats.chars === 0 && stats.words === 0 && stats.lines === 0;
    if (isEmpty) {
      els.statusStats.hidden = true;
      els.statusStats.textContent = '';
    } else {
      els.statusStats.textContent = formatStatusStats(stats);
      els.statusStats.hidden = false;
    }
  }, 200);
}

/**
 * 状态栏：滚动进度
 * - preview：viewer 的进度（阅读到哪儿）
 * - edit：editor 的进度（编辑器里滚到哪儿）
 * - split：viewer 的进度（双栏同步滚动，两边值一致，读者视角）
 */
let scrollFrame = null;
// 切模式（Ctrl+E / 点 mode chip）后用 rAF 等 DOM 更新完再 focus 编辑器；
// 与 scrollFrame 同款：track 住 handle，连续切模式时丢弃上一个未 fire 的帧，
// 避免多次 focus() 在同帧内排队、最后一帧执行多次（audit F1）。
let editorFocusFrame = null;
function updateStatusScroll() {
  if (!els.statusScroll) return;
  els.statusScroll.hidden = false;
  if (scrollFrame) {
    cancelAnimationFrame(scrollFrame);
    // audit fix (K2-L9)：cancel 后立刻置 null，与 statsDebounceTimer 同款。
    scrollFrame = null;
  }
  scrollFrame = requestAnimationFrame(() => {
    scrollFrame = null;
    const progress =
      state.editorMode === 'edit'
        ? editor.getScrollProgress()
        : viewer.getScrollProgress();
    els.statusScroll.textContent = `${Math.round(progress * 100)}%`;
  });
}

/**
 * 聚焦模式：把可见性写到 DOM（不触发持久化）。
 *
 * 启动时一次应用、避免无意义写盘。
 * 副作用：focus 模式下 viewer 占据整个窗口，需要重新计算 grid 列。
 */
function applyFocusMode(target) {
  state.focusMode = !!target;
  document.body.dataset.focusMode = state.focusMode ? 'true' : 'false';
}

/**
 * 切换聚焦模式（同时持久化）。
 */
function setFocusMode(next) {
  const target = typeof next === 'boolean' ? next : !state.focusMode;
  if (target === state.focusMode) return; // 状态没变 → 跳过 DOM 与写盘
  applyFocusMode(target);
  // audit #1：持久化失败必须告知用户，否则下次启动状态丢失无迹可循。
  settingsStore.update({ focusMode: state.focusMode }).catch((e) => {
    showToast(`聚焦模式状态保存失败：${e?.message || '未知错误'}`, 'error', 3500);
  });
}

/**
 * 工具栏
 *
 * 实例不需保留：构造函数里已经把所有按钮的 click 事件挂好，外部不需要再调用任何方法。
 */
new Toolbar({
  elements: {
    btnTheme: els.btnTheme,
    btnPin: els.btnPin,
    btnSettings: els.btnSettings,
    btnResetLayout: els.btnResetLayout,
    btnMin: els.btnMin,
    btnMax: els.btnMax,
    btnClose: els.btnClose,
    btnCloseFile: els.btnCloseFile,
  },
  onThemeClick: () => cycleTheme(),
  onPinClick: async () => {
    const next = !state.alwaysOnTop;
    try {
      await window.api.setAlwaysOnTop(next);
      state.alwaysOnTop = next;
      syncPinButton(next);
    } catch (e) {
      console.error('[app] setAlwaysOnTop 失败:', e);
      showToast(`置顶切换失败：${e.message}`, 'error');
    }
  },
  onSettingsClick: () => openSettingsDialog(),
  onResetLayoutClick: () => resetLayout(),
  onMinimize: () => window.api.minimizeWindow(),
  onToggleMaximize: () => window.api.toggleMaximizeWindow(),
  onClose: () => window.api.closeWindow(),
  // 关闭当前文件：与窗口关闭按钮（btnClose → onClose → closeWindow）区分。
  // 这里走 closeCurrentFile()：内部有"未保存改动"对话框；无文件时按钮 disabled
  // 不触发（disabled 浏览器层面 click 不派发）。
  onCloseFile: () => closeCurrentFile(),
});

/**
 * 保存按钮（手动保存入口）
 */
if (els.btnSave) {
  // Round 13 fix (LOW app.js #1)：原 `return save()` 在箭头函数里把 save()
  // 的 Promise 返回给 addEventListener 回调——返回值被 listener 忽略，是
  // 误导性表达。改成显式调用 + 让 listener 返回 void。
  els.btnSave.addEventListener('click', () => {
    save();
  });
}

/**
 * 状态栏 mode chip：直接点击切换视图模式（少一次去工具栏的旅程）
 * 与顶栏的视图按钮组是同一份功能的快捷入口 —— 跟设置面板不重复入口原则一致。
 */
if (els.statusMode) {
  els.statusMode.addEventListener('click', () => editorToolbar.cycle());
}

/**
 * 状态栏路径 chip：点击进入对应位置
 *
 * - 有打开文件 → reveal 文件（macOS Reveal / Win·Linux 选中，等同于侧栏右键「在文件夹中显示」）
 * - 没打开文件但有浏览目录 → 在文件管理器中打开该目录
 * - 都没有 → 静默 no-op（保持按钮 hover 视觉一致，但不做任何 IPC 调用）
 *
 * 旧版本无文件时点击完全没反应（注释里也写"静默无副作用"），但用户期望点击路径
 * 必须能去到一个对应位置 —— 让无文件状态也"活"起来。
 */
if (els.statusPath) {
  els.statusPath.addEventListener('click', () => {
    if (!fileOps) return;
    if (state.currentFile && state.currentFile.path) {
      fileOps.revealFile(state.currentFile);
    } else if (state.currentDir && window.api && typeof window.api.openDir === 'function') {
      // 走专门的 shell:open-dir IPC：dataDir 边界 + 目录 stat 检查都在主进程，
      // renderer 只负责把当前浏览目录透传过去。
      window.api.openDir(state.currentDir).then((result) => {
        if (!result || !result.ok) {
          showToast(`打开目录失败：${window.api.friendlyFsError(result && result.code, result && result.message)}`, 'error');
        }
      });
    }
  });
}

/**
 * AI 修改入口：
 *   - 侧栏底部 btn-ai：打开/关闭 AI 输入面板（与「数据目录」二级链接分组，主操作用 .sidebar-new-btn 描边样式）
 *   - createAiController：状态机实例，持有 chat/diff 两个面板
 *   - 同步 btn-ai 的 aria-pressed 视觉态（与 chatPanel.isOpen 联动）
 *
 * AI 是「点开就弹，关闭就退」的命令式入口，不进 settingsStore。
 */
function mountAiPanel() {
  if (!els.btnAi) return;
  // audit fix (M1)：重复 mount 时先拆旧实例 —— createAiController 持有 chat
  // panel 7 listener + diff panel + recomputeTimer + IPC 订阅，覆盖引用会让旧
  // 实例变孤儿，等 GC 期间旧监听器仍响应事件（看到的是「AI 点了没反应」）。
  if (ai && typeof ai.destroy === 'function') {
    try { ai.destroy(); } catch { /* ignore */ }
  }
  // 创建控制器（在 settings 加载完后）
  ai = createAiController({
    api: window.api,
    editor,
    state,
    toast: showToast,
    getSettings: () => settingsStore.getAll(),
    // preview 模式修复：AI apply region / all 后立即让 viewer 重新渲染，
    // 否则 viewer 仍显示旧内容 → 用户感觉"点了应用，文件没反应"。
    // split 模式下 scheduleLivePreview 也会跑（双触发幂等无害）。
    onAfterApply: () => {
      if (state.currentFile) viewer.loadContentLive(editor.getContent());
    },
    // 未配置时：直接打开设置并定位到 AI 段。比 toast 更直观 —— 见
    // [[feedback-modal-collapses-secondary-panels]]（开设置会自动收 dock，关后还原）。
    onOpenSettings: () => openSettingsDialog({ focusSection: 'ai' }),
    // AI 过程/错误/待确认状态 → statusbar 上的 #status-ai chip。
    // 详见 [feedback-ai-tips-into-status-bar] —— dock 底部不再单开一行。
    notify: updateStatusAi,
    // audit fix (Phase L3-AI 4)：AI dock 与设置对话框双向互斥。
    // openSettingsDialog 已在打开时主动 close dock、close 后还原；但用户在设置打开
    // 期间手动点 AI 入口（btn-ai / 状态栏 chip / 快捷键）会让 dock 透出 modal 背景后，
    // 视觉重叠 + 误点。controller 用这个 getter 在 togglePanel 里把住开关。
    isSettingsOpen: () => state.settingsDialogOpen,
    // AI 修复预览面板（中间 diff 面板）显隐 → 视图模式锁定。打开时强制
    // 切到编辑模式 + 禁用预览 / 双栏切换；关闭时还原。具体逻辑见 handleAiDiffOpenChange。
    onDiffOpenChange: handleAiDiffOpenChange,
  });
  // 挂载 chat dock + diff 面板到各自的 DOM 容器
  if (els.aiChatDock && els.appAi) {
    ai.bindMountPoint(els.aiChatDock, els.appAi, els.aiSplitter);
  }
  // 侧栏底部按钮：toggle。controller 内部已经判断"未配置时给提示"
  els.btnAi.addEventListener('click', () => {
    syncAiButton(ai.togglePanel());
  });
  // 状态栏 AI chip：toggle dock（与 btn-ai 同款入口；未配置时 controller 会跳设置对话框）。
  // btn-ai pressed 态由下方 aiObserver 跟随 aiChatDock.hidden 自动同步 —— 无需手工设置。
  // 沿用 [[feedback-save-button-always-visible]] 的原则：chip 始终可见，
  // idle 态也保留 "AI" 标签（不要 hidden 切换），让用户随时能找到入口。
  if (els.statusAi) {
    els.statusAi.addEventListener('click', () => {
      syncAiButton(ai.togglePanel());
    });
  }
  // 监听 chat 面板显隐变化 → 同步按钮 pressed 态（被 dock 自身的 × 按钮关闭时）
  // 用 MutationObserver 监听 aiChatDock 的 hidden 属性变化
  // 持有在模块级变量上，window unload 时统一 disconnect（避免 listener 泄漏）
  //
  // audit fix (renderer-M8)：旧实现没断开旧 observer 就直接 new —— 单实例
  // 生产路径下不会触发，但 HMR / 测试 / 任何未来的 re-mount 路径会让旧 observer
  // 闭包持续引用 syncAiButton + aiChatDock，造成 mutation 回调重复触发。
  // mountAiPanel 是幂等保证：每次进入先 dispose 旧的，再创建新的。
  if (aiObserver) {
    aiObserver.disconnect();
    aiObserver = null;
  }
  aiObserver = new MutationObserver(() => {
    if (!els.aiChatDock) return;
    syncAiButton(!els.aiChatDock.hidden);
  });
  aiObserver.observe(els.aiChatDock, { attributes: true, attributeFilter: ['hidden'] });
}

/**
 * 订阅 viewer 的 heading 变化事件：
 *  - 同步状态栏中央的「当前章节」面包屑
 *
 * viewer.onHeadingChange 会立刻用当前 heading 触发一次回调（即使为 null），
 * 所以订阅后无需手动同步一次。
 */
function watchViewerHeading() {
  viewer.onHeadingChange((heading) => {
    if (els.statusHeading) {
      if (heading && heading.text) {
        // 多于 32 字截断，避免长 heading 撑爆状态栏
        const text = heading.text.length > 32
          ? `${heading.text.slice(0, 31)}…`
          : heading.text;
        els.statusHeading.textContent = text;
        els.statusHeading.title = heading.text; // 鼠标悬停查看完整
        els.statusHeading.hidden = false;
      } else {
        els.statusHeading.textContent = '';
        els.statusHeading.title = '';
        els.statusHeading.hidden = true;
      }
    }
  });
}

/**
 * 主题切换：dark ↔ light
 */
async function cycleTheme() {
  const current = settingsStore.get('theme');
  const next = current === 'dark' ? 'light' : 'dark';
  try {
    await settingsStore.update({ theme: next });
  } catch (e) {
    showToast(`主题切换失败：${e.message}`, 'error');
    return;
  }
  applyTheme(next);
  syncThemeButton(next);
  showToast(`主题：${next === 'dark' ? '暗色' : '亮色'}`, 'info', 1500);
}

/**
 * 保存当前文件
 *
 * 流程：取编辑器内容 → 写盘 → 更新 mtime → markSaved → 通知文件列表（mtime 变化）
 *
 * 外部修改竞态防护（audit #2）：writeFile 传 expectedMtimeMs = state.lastSavedMtimeMs；
 * 主进程会比对磁盘 mtime，若文件已被外部修改则返回 FILE_CHANGED_EXTERNALLY，
 * 此时弹冲突对话框让用户选择「使用外部版本 / 强制覆盖 / 取消」。
 *
 * audit fix (Phase 3 C1)：两处竞态保护
 *   1. 入口 cancelScheduledAutoSave() —— 防止 auto-save 防抖定时器在 writeFile
 *      await 飞行期内 fire 触发第二次 save。第二次 save 捕获的是「旧
 *      lastSavedMtimeMs」（markSaved 还要等 writeFile 解析后才跑），磁盘 mtime
 *      已经变成第一次写入后的值 → mtime 校验失败 → 触发「文件外部修改」冲突
 *      对话框 —— 实际是用户自己的自动保存把自己弹红了。
 *   2. inFlightSave sentinel —— save#2 在 save#1 飞行期内到达，直接 await 同一
 *      个 Promise，避免重复 IPC + 重复写盘 + 重复 mtime 抖动。
 *
 * @param {object} [opts]
 * @param {boolean} [opts.silent=false] - true 时不弹「已保存」toast（自动保存路径用）
 *                                          失败无论 silent 与否都弹 error toast
 * @param {boolean} [opts.skipMtimeCheck=false] - true 时跳过 mtime 校验（用于「强制覆盖」二次保存）
 * @returns {Promise<boolean>} true 表示保存成功（或没有需要保存的内容）
 */
async function save(opts = {}) {
  const silent = !!opts.silent;
  const skipMtimeCheck = !!opts.skipMtimeCheck;
  // 审计修复 (Round 11 P0-1)：IME 合成期拒绝手动保存。
  // updateListener 的 !isComposing 守卫屏蔽 IME 期 onChange（避免每字触发 scheduleLivePreview /
  // scheduleAutoSave），但 editor.getContent() 仍会返回 IME buffer 里的半截内容。
  // 用户按 Ctrl+S / 点保存按钮 / Ctrl+R / 关窗手动选「保存」走 save() 路径，
  // 不守门的话会把 "niha" / "nihあ" 这种半截 IME 字符写盘。
  // 早退返回 { ok: false, reason: 'IME_COMPOSING' }，主进程已落盘的内容安全；
  // 静默路径（Ctrl+R、关窗 onSaveRequest）不弹 toast —— 后者已经会走主进程原生框提示。
  // auto-save 已在 scheduleAutoSave 里守门，这里再守一次兜底（手动入口的 IME 守门由这里统一）。
  if (typeof editor !== 'undefined' && typeof editor.isComposing === 'function' && editor.isComposing()) {
    if (!silent && typeof showToast === 'function') {
      showToast('正在输入，请稍后再试', 'warning', 1800);
    }
    return false;
  }
  // audit fix (C1)：入口先取消挂起的 auto-save 定时器，防止它在 writeFile
  // await 期间 fire 触发第二次 save 把磁盘 mtime 提前用掉。
  cancelScheduledAutoSave();
  // 所有调用方都累加 savingCount，syncSaveButton 据此显示「保存中…」态。
  // 共享路径（inFlightSave 已存在）也计数 —— 否则 Call#1 退场清 0 时
  // Call#2 还在飞行，is-saving 会过早熄灭。归零才清，UI 不抖。
  state.savingCount++;
  syncSaveButton();
  // audit fix (Round 3 bug 2026-08)：IME 合成期 onChange 被 markdown-editor.js
  // updateListener 跳过，state.isDirty 可能 stale（editor.doc 有 IME 字符但
  // state.isDirty 还是 false）。在 save() 入口同步一次，让下面的 !state.isDirty
  // 早退检查可靠 —— 否则用户 IME 期间点保存会走早退返回「已是最新」，IME 字符
  // 不会落盘。详见 syncDirtyFromEditor 注释块。
  syncDirtyFromEditor();
  // 关键修复（savingCount 泄漏）：用 try/finally 包整个 save() 函数体，保证
  // savingCount 与 inFlightSave 哨兵在任何早退 / 异常 / 共享路径下都能平衡。
  // 之前在内部共享路径 / 主路径各放一个 finally，会漏掉 `!currentFile` /
  // `!isDirty` 等 5 个早退 return —— savingCount 永远卡在 >0，保存按钮
  // 永久显示「保存中…」且后续 save() 永远命中共享分支（共享检查始终命中 +
  // inFlightSave 被未完成路径泄漏）。教训：内部嵌套 try/finally 处理多个
  // 计数器时代码脆弱，必须用一个外层 try/finally 一站式管理。
  // 见 [[project-settings-saving-flag]]。
  try {
    // audit fix (Phase N Q-fix)：toast 决策权统一收归 save() outer。
    //
    // IIFE 内部不弹「已保存」toast —— 改为 save() outer 在 silent=false + ok 时弹。
    // IIFE 内部继续按原样弹错误 toast（FILE_CHANGED_EXTERNALLY 各分支 / FILE_NOT_FOUND /
    // PATH_NOT_ALLOWED / SYMLINK_NOT_ALLOWED / errno 兜底 / catch IPC_ERROR），
    // 这些与 silent 无关，所有 silent 都弹。
    //
    // 修四个真 bug：
    //   1. silent=false manual caller 共享 IIFE + IIFE stale → 旧逻辑 silent=false
    //      但 success=false → 不弹 toast，用户按 Ctrl+S 切文件后完全无反馈。
    //      现在 silent=false + reason='STALE' → 弹「文件已切换，未保存到磁盘」。
    //   2. auto-save silent=true 飞行期 user 按 Ctrl+S 写盘成功 → 旧逻辑 IIFE
    //      silent=true 不弹「已保存」，shared manual silent=false 也不弹，用户无反馈。
    //      现在 manual silent=false → save() outer 弹「已保存」，与 IIFE silent
    //      无关（IIFE 自己不弹）。
    //   3. onSaveRequest silent=false 与 main.js confirmDiscardIfDirty 错误对话框
    //      双重反馈。修复点不在 save() 内，由调用方改 silent=true（见 line ~2768）。
    //   4. file:write catch message 字段直回 e.message（英文 + 路径），与
    //      _friendlyWriteError 对齐由 main.js 修。
    //
    // 共享路径不弹「已保存」是错的：silent=false manual caller 必须有反馈。让
    // owner 与 shared 都各自决定 silent 行为：owner 路径 silent=false 弹一次，
    // shared 路径 silent=false 也弹一次 —— force_overwrite 递归 inner save() +
    // shared manual 会出现双重「已保存」toast（这是 Phase N 之前已有的边缘 case，
    // 取舍让所有 silent=false caller 都看到反馈更重要）。
    if (inFlightSave && !skipMtimeCheck) {
      const result = await inFlightSave;
      decideSaveToast(silent, result, showToast);
      return !!(result && result.ok);
    }
    if (!state.currentFile) {
      // audit fix (Round 7 S-3)：区分「没有打开文件」与「文件已是最新」。
      // 旧版用 NO_CHANGES → toast 「已是最新」，但用户视角是「我什么都没打开，
      // 按 Ctrl+S 当然没有东西需要存」——「已是最新」暗示「有文件且未改动」，
      // 语义错位。改用 NO_FILE → toast 「没有打开文件」，给用户准确的反馈。
      // auto-save silent=true 路径被 decideSaveToast 头部 `if (silent) return`
      // 拦下，不弹。
      decideSaveToast(silent, { ok: true, reason: 'NO_FILE' }, showToast);
      return true;
    }
    if (state.editorMode === 'preview') {
      // Bug #1 fix (audit)：预览模式正常情况下没有脏内容（编辑器只读、用户输入被屏蔽），
      // 但 AI applyUserChange 是通过 view.dispatch() 改 doc，会绕过 EditorView.editable
      // 的只读检查。所以「preview 模式 + AI 已 apply + 切文件/关闭」路径上，
      // 早退 return true 会让主进程以为保存成功，关闭程序时 AI 改动就丢了。
      // P3 fix：之前这里调 applyEditorMode('edit') 永久把 state.editorMode 改成 'edit'，
      // 用户的 preview 偏好丢了；改为只解锁编辑器让 writeFile 走通，保存后再恢复 readOnly。
      if (!state.isDirty) {
        decideSaveToast(silent, { ok: true, reason: 'NO_CHANGES' }, showToast);
        return true;
      }
      editor.setReadOnly(false);
    }
    if (!state.isDirty) {
      // fix(audit 2026-08)：auto-save 静默写盘后 state.isDirty=false，用户手动点
      // 保存按钮落入此路径。旧逻辑静默 return 让用户觉得「按钮没反应 / 没保存
      // 上」，实际文件已最新。给一个简短「已是最新」info 让点击有反馈。
      // auto-save silent=true 路径被 decideSaveToast 头部 `if (silent) return` 拦下，不弹。
      decideSaveToast(silent, { ok: true, reason: 'NO_CHANGES' }, showToast);
      return true;
    } // 没有改动，无需保存

    // audit fix (C1)：把「实际写盘 + 冲突处理 + 状态更新」整段包进 IIFE 赋值给
    // inFlightSave，try/finally 确保异常路径也清掉 sentinel。force_overwrite 的
    // 二次保存走 skipMtimeCheck=true，上面早退判断会放它进来重新写一次新 Promise。
    inFlightSave = (async () => {
      // L1 fix (audit)：标记本 save 调用是否解锁了 preview 模式的只读，
      // finally 统一还原 —— 之前只在成功路径 + catch 路径 2 处还原，
      // discard_local 完成 / 文件外部修改后切走 / 各类早退 return false 路径
      // 都会漏掉，导致用户切回编辑器发现只读没恢复。
      // 条件用「调用 save 时的 editorMode 快照」，不用 await 后的 state，
      // 因为 save 飞行期间用户可能切文件 / 切回 edit 模式，state.editorMode
      // 已变 —— 我们只关心「这次 save 是否动过只读」。
      const restoredReadOnly = state.editorMode === 'preview' && state.currentFileIsMarkdown;
      const content = editor.getContent();
      // 锁定 save 入口到当前文件路径：用户可能在 await 期间切文件，必须用快照
      // 而不是 state.currentFile.path（避免 reload 时把 A 的 mtime 写到 B 上）。
      const targetPath = state.currentFile.path;
      const targetName = state.currentFile.name;
      // expectedMtimeMs 让主进程比对磁盘 mtime，挡住「fs:changed 还没到 → Ctrl+S 静默覆盖」
      const expectedMtimeMs = skipMtimeCheck ? null : state.lastSavedMtimeMs;
      try {
        const result = await window.api.writeFile(targetPath, content, expectedMtimeMs);
        // 防 stale save：writeFile 期间用户切走了 → 不能继续往下走（会把脏状态
        // 标干净、把 lastSavedMtimeMs 写到新文件的 state 上）。
        //
        // Phase 2 audit 修复 (P1 #3)：原代码无条件 `{ok:false, reason:'STALE'}`，
        // 但 writeFile 这一行**已经 resolve**了 —— 数据其实已经落盘到 targetPath
        // （result.ok=true）。关窗路径（onSaveRequest silent=true → reportSaveResult
        // → main.js confirmDiscardIfDirty）会把 ok=false 误判为「保存失败」并弹
        // 原生对话框挡住用户退出，即使 A 的字符已经安全写盘。修复：按 writeFile
        // 实际结果区分 —— result.ok=true（writeFile 写盘成功）→ ok=true 关窗可
        // 以安全退出；result.ok=false（writeFile 返回 FILE_CHANGED_EXTERNALLY 等
        // 错误）→ ok=false 关窗必须拦截。两种情况都标 reason:'STALE' 让 silent=false
        // caller 拿到「文件已切换」反馈。
        if (!state.currentFile || state.currentFile.path !== targetPath) {
          return { ok: !!(result && result.ok), reason: 'STALE' };
        }
        if (!result.ok) {
          // 文件在外部被修改（audit #2 触发）—— 弹冲突对话框
          if (result.error === 'FILE_CHANGED_EXTERNALLY') {
            const choice = await showConfirmDialog({
              title: '文件在外部被修改',
              message: `「${targetName}」在你编辑期间被外部修改。\n\n如何处理？`,
              icon: 'conflict',
              buttons: [
                { value: 'cancel', label: '取消（保留本地）', variant: 'secondary' },
                { value: 'discard_local', label: '放弃本地，使用外部版本', variant: 'secondary' },
                { value: 'force_overwrite', label: '强制覆盖（保留我的版本）', variant: 'primary' },
              ],
            });
            // dialog 期间用户切走 → 不再写任何 state（已经是新文件的 state）
            if (!state.currentFile || state.currentFile.path !== targetPath) {
              return { ok: false, reason: 'STALE' };
            }
            if (choice === 'discard_local') {
              // 用外部版本覆盖本地
              const reloadResult = await window.api.readFile(targetPath);
              // 再次校验（reloadResult 又是一次 await）
              if (!state.currentFile || state.currentFile.path !== targetPath) {
                return { ok: false, reason: 'STALE' };
              }
              if (reloadResult.ok) {
                // audit fix (Round 9)：和 reloadCurrentFileFromDisk 一致，readFile
                // 期间用户可能触发 IME 合成 → setExternalContent 抛 EDITOR_COMPOSING
                // 会让 unhandled promise rejection 冒上来。catch 后给用户「请稍后再试」
                // 的 toast，状态保持原样（不替 user setExternalContent，也不清 dirty）。
                let setOk = false;
                try {
                  editor.setExternalContent(reloadResult.content);
                  setOk = true;
                } catch (e) {
                  if (e && e.message === 'EDITOR_COMPOSING') {
                    showToast('正在输入中文，请稍后再试', 'warning', 2000);
                  } else {
                    throw e;
                  }
                }
                if (setOk) {
                  // P2 fix：非 md 文件（.txt / .json / ...）viewer 走的是 showUnsupportedFile 空态，
                  // 这里再调 loadContent 会破坏空态 + 触发 markdown 渲染（plain text 里也可能出现
                  // 「# section」被识别成 heading 而误渲染）。按 currentFileIsMarkdown 分支处理。
                  if (state.currentFileIsMarkdown) {
                    viewer.loadContent(state.currentFile, reloadResult.content);
                  } else {
                    viewer.showUnsupportedFile(state.currentFile);
                  }
                  state.lastSavedMtimeMs = reloadResult.mtimeMs;
                  state.currentFile = { ...state.currentFile, mtimeMs: reloadResult.mtimeMs, size: reloadResult.size };
                  state.isDirty = false;
                  syncSaveButton();
                  // Round 13 fix (M17)：discard_local 与 reloadCurrentFileFromDisk
                  // 对称调 applyEditorMode —— 不调会让 editor 仍处于 IME 合成期
                  // / 用户切到 edit-mode 之前的视图状态，与 state.editorMode 漂移。
                  applyEditorMode(state.editorMode, { focus: false });
                  // audit fix (Round 9)：和 reloadCurrentFileFromDisk 一致，丢弃本地
                  // 切换到外部版本后必须通知 AI controller 清 pendingDiff —— 否则 AI
                  // 可能基于 baseContent（本地）算 diff 后 setExternalContent 把本地内容
                  // 又盖回去。
                  if (ai && typeof ai.onFileChanged === 'function') {
                    try { ai.onFileChanged(state.currentFile); } catch (err) {
                      console.warn('[app] ai.onFileChanged failed (discard_local):', err);
                    }
                  }
                  showToast('已切换到外部版本', 'info', 1800);
                }
              } else if (reloadResult.error === 'NOT_TEXT') {
                // audit fix (Phase L3-FS 1A)：外部版本已变成二进制（同上）
                showToast(reloadResult.message || '外部版本不是有效文本，已取消切换', 'error');
              } else {
                showToast(`读取外部版本失败：${reloadResult.message || reloadResult.error}`, 'error');
              }
              return { ok: false, reason: 'CONFLICT_DISCARDED' };
            }
            if (choice === 'force_overwrite') {
              // 二次保存，跳过 mtime 校验（finally 仍会还原只读 —— 不需要 preserve）
              // audit fix (Phase N-B6)：强制覆盖是用户主动决策，必须给「已保存」反馈。
              // 原 silent=true 路径只在 auto-save 静默场景下合理；用户点完「强制覆盖」
              // 按钮后看到毫无反馈会困惑。强制 silent=false 让递归 save 走到「已保存」toast。
              //
              // Phase N Q-fix：递归 inner save() 走 save() outer silent=false 弹「已保存」，
              // 返回 {ok, reason}。这里直接透传 inner 结果 —— 当前 outer IIFE 把它当作
              // 本次写盘的结果返回（错误 toast 由 inner IIFE 内部已弹，shared path 不会
              // 再弹错误 toast，避免重复；force_overwrite 自身的「已保存」由 inner 触发）。
              // audit fix (Round 8 S-1)：必须把 inner 的 boolean 还原成 {ok, reason}
              // 信封。save() 自身返回的是 boolean（line ~1909 `return !!(result && result.ok)`），
              // 旧代码 `return save({...})` 让 IIFE 解析成 boolean `true` →
              // outer 的 `!!(result && result.ok)` 变成 `!!(true && undefined)` = **false**。
              // 后果：强制覆盖明明写盘成功，outer save() 却上报失败 ——
              //   · 关窗路径 onSaveRequest 收到 ok=false → 主进程弹「保存失败，已取消退出」
              //   · save_and_open 收到 false → 目标文件不再打开，用户只看到「已保存」toast
              // reason='DELEGATED' 让 decideSaveToast 知道 inner 已弹过反馈，outer 不重复弹。
              const innerOk = await save({ silent: false, skipMtimeCheck: true });
              return { ok: innerOk, reason: 'DELEGATED' };
            }
            // cancel / 默认：什么都不做，保留本地脏状态
            //
            // audit fix (Phase N-A3)：**不**推进 state.lastSavedMtimeMs 是有意为之。
            //   - onFilesChanged 的 cancel 分支会推进 mtime（见 app.js:2572-2573 附近），
            //     因为下一次外部修改才会再触发 fs:changed；推进 mtime 避免重复弹窗。
            //   - save() 的 cancel 分支**不**推进，因为下次 Ctrl+S 会再次调 writeFile，
            //     推进 mtime 会让本次未决冲突被静默绕过 —— 用户没选「保留本地」就
            //     直接写盘覆盖外部版本，外部改动丢失。
            //   - 所以 save() cancel 必弹「每次 Ctrl+S 都问一次」，直到用户选
            //     force_overwrite 或 discard_local。这是有意 UX：未决冲突不能
            //     让自动跳过。
            //   - 不要「修复」成对称行为（也推 mtime），那会引入静默覆盖。
            showToast('已保留本地版本', 'info', 1800);
            return { ok: false, reason: 'CONFLICT_KEPT' };
          }
          if (result.error === 'FILE_NOT_FOUND') {
            // audit fix (Phase O-H6)：先 clearCurrentFile 再异步救回脏内容，
            // 修复 race：之前直接 clearCurrentFile() 把 state.currentFile 置 null，
            // 但当前路径没有任何 rescue。紧接着 fs-watcher 把删除事件以
            // files:changed 推给 renderer，onFilesChanged 入口 `if (!state.currentFile)
            // return;` 提前返回，line 2580 的 rescued-*.md 救回路径永远不触发，
            // 用户的脏内容静默丢失。
            //
            // 修复策略：先 clearCurrentFile（让后续 fs-watcher 事件提前返回，避
            // 免双 rescue），再 fire-and-forget 调 file:create 把 content（IIFE
            // 顶部 line 1594 已取）救回到 `<原名>-rescued-<stamp>-<suffix>.md`。
            // 即便 createFile 期间用户切到其它文件或关闭窗口，rescue 文件也已
            // 在数据目录里，下次启动可见。
            //
            // 注意：先 clearCurrentFile 也意味着 UI 立刻清空（编辑器 / viewer
            // 卸载），用户看到「文件没了」+ 一条「正在救回」toast，几秒后 toast
            // 变「已救回到 xxx」或「救回失败」。这比「脏内容静默丢失」好得多。
            // Phase 2 audit 修复 (P2 Bug #2)：必须在 clearCurrentFile **之前**
            // 取最新内容 —— clearCurrentFile 会 unload editor view，之后
            // editor.getContent() 返回 ''。flight 期间用户输入的字符都在
            // editor view 里，必须现在取。content 闭包变量是 IIFE 入口的
            // 旧快照，不含飞行期新增字符。
            const latestContent = (typeof editor.getContent === 'function')
              ? editor.getContent()
              : content;
            // 先 clear，让 fs-watcher race 路径 entry 提前返回
            clearCurrentFile();
            showToast('文件已被删除；正在救回未保存内容…', 'warning', 3000);
            // 异步救回（fire-and-forget：不阻塞 save() 返回；race 安全因为
            // state.currentFile 已是 null，后续 onFilesChanged 不会再走 rescue 分支）
            // 命名 / toast 文案 / friendlyFsError 错误码传递逻辑全部交给 rescue.js，
            // 这里只关心「我有 content、想救回」一件事。
            rescueDirtyContent({
              api: window.api,
              originalName: targetName,
              content: latestContent,
              event: '文件已被删除',
            });
            return { ok: false, reason: 'FILE_NOT_FOUND' };
          }
          if (result.error === 'PATH_NOT_ALLOWED') {
            showToast('保存失败：路径不在数据目录内', 'error');
            return { ok: false, reason: 'PATH_NOT_ALLOWED' };
          }
          if (result.error === 'SYMLINK_NOT_ALLOWED') {
            showToast('保存失败：不允许写入符号链接', 'error');
            return { ok: false, reason: 'SYMLINK_NOT_ALLOWED' };
          }
          // P1-7：权限 / 只读 / 磁盘满 / 文件被另一进程独占
          // 用 result.code（原始 errno）给中文提示，不再把英文错误码甩给用户
          // audit fix：fallback 走 result.message（主进程已翻译为中文），
          // 之前用 result.error 会把英文 errno 串（如 'EACCES'）直接吐给用户。
          const friendly = window.api.friendlyFsError(result.code, result.message || result.error);
          showToast(`保存失败：${friendly}`, 'error');
          return { ok: false, reason: 'WRITE_FAILED' };
        }
        // 成功：更新基线 + UI
        // P0-2 真正生效修复（关键）：必须以「写盘时刻的 content 快照」为基准判断
        // dirty，而不是 editor.isDirty()（后者依赖 lastSavedDoc，markSaved 一旦
        // 跑过就被同步成当前 doc，永远返回 false）。
        // 之前 `state.isDirty = !!editor.isDirty()` 在 markSaved 之前调用，本意
        // 是想保留「飞行期用户新敲的字符」对应的 dirty 状态，结果在普通路径（用
        // 户先敲字再点保存，doc === content）下也把 state.isDirty 设成 true →
        // markSaved 跑完 is-dirty class 不消失、按钮永远亮着，用户以为保存按钮
        // 失灵（实测：window.api.writeFile 真的被调、磁盘文件真的写成功、但 UI
        // 上「已保存」反馈缺失 + is-dirty 残留）。
        //
        // 正确做法：拿 editor 当前 doc 跟刚才 writeFile 用的 content 快照对比
        //   - 相等（普通路径）→ state.isDirty = false，UI 立刻熄灭
        //   - 不等（飞行期用户敲了新字符，半步保存）→ state.isDirty = true，
        //     走 Phase N-A1 的「半步保存」兜底：用户主动 Ctrl+S 补刀 / 关窗走
        //     main.js confirmDiscardIfDirty 的 rendererDirty re-check
        //
        // 防御：editor 在 await window.api.writeFile 期间可能被 pagehide 拆掉
        // （dispose() 置 view = null）—— 那种情况下文已经要走了，不必再更新
        // state / UI，命中则跳过即可。
        if (editor.view) {
          const currentDoc = editor.view.state.doc.toString();
          state.isDirty = (currentDoc !== content);
          editor.markSaved();
          state.lastSavedMtimeMs = result.mtimeMs;
          state.lastWriteMtimeMs = result.mtimeMs; // P1-2：用 mtime 而非 Date.now() 作为回声抑制锚点
          syncSaveButton();
        }

        // 更新当前文件的 size/mtime（让侧边栏和状态栏反映最新值）
        state.currentFile = { ...state.currentFile, mtimeMs: result.mtimeMs, size: result.size };
        viewer.updateStatusBar(state.currentFile);

        // audit fix (Phase O-M4)：success toast 不在 IIFE 内部弹，由 save() outer
        // 统一在 silent=false + ok 时弹（line 1803-1805 之后）。
        // 否则用户连按两次 Ctrl+S：Call#1 走主路径 → IIFE 内部 toast；Call#2
        // 走 shared path → outer toast；同一次磁盘保存弹出两次「已保存」。
        // 错误 toast 仍在 IIFE 各分支（FILE_CHANGED_EXTERNALLY / FILE_NOT_FOUND /
        // PATH_NOT_ALLOWED / SYMLINK_NOT_ALLOWED / errno 兜底 / catch IPC_ERROR），
        // 与 silent 无关，所有 silent 都弹（用户必须感知失败）。
        return { ok: true };
      } catch (e) {
        console.error('[app] save 异常:', e);
        // IPC 协议层异常（Electron 包装 message 形如
        // `Error invoking remote method 'file:write': Error: ...`）含 IPC channel 名 +
        // 底层 errno + 路径，原样 toast 会泄露技术细节。
        // audit fix (K1-H3)：从包装 message 里抽出原 errno（形如 `EPERM: ...`、
        // `ENOSPC: ...`、`EACCES: ...`），传给 friendlyWriteError 做中文翻译。
        // 之前传 undefined 永远走 default 分支 = 「与主进程通信异常」，EACCES/EPERM/
        // ENOSPC 等具体错误都被掩盖，用户看不到「磁盘满 / 只读 / 权限」这种能立刻
        // 判断原因的提示。注意：e.code 是 undefined（IPC 层异常没有 errno.code 字段），
        // 只能从 e.message 抠字面量。
        const wrapped = (e && e.message) || '';
        const codeMatch = wrapped.match(/\b(EACCES|EPERM|ENOSPC|EROFS|EIO|EBUSY|ENAMETOOLONG|ENOTDIR|EISDIR|ENOTEMPTY|ENOENT)\b/);
        const code = codeMatch ? codeMatch[1] : undefined;
        showToast(`保存失败：${window.api.friendlyFsError(code, '与主进程通信异常')}`, 'error');
        return { ok: false, reason: 'IPC_ERROR' };
      } finally {
        // L1 fix (audit)：统一还原 preview 模式只读，覆盖成功 / 异常 / 早退 / 切文件
        // 所有路径。force_overwrite 递归调 save 时本 finally 也会跑，但新 save 内部
        // 自己也会再调 setReadOnly(false) 再 + finally 还原，幂等且无副作用。
        // audit fix (K2-M7)：finally 里重新拿当前 snapshot —— save 飞行期间用户
        // 可能已经点了 mode 按钮切到 edit / 切到另一个文件 / 触发 applyEditorMode，
        // 入口快照 restoredReadOnly 已陈旧。无脑 editor.setReadOnly(true) 会把新状态
        // 的编辑器强行锁只读，造成「切了文件后编辑器打不出字」的诡异现象
        // （setReadOnly 是 compartment 重配不会破坏 doc，但模式按钮态会跟实际
        // 只读态错位）。统一走 applyEditorMode 让 state.editorMode 决定。
        // audit fix (Phase O-L13)：save() finally 还原只读态非用户主动，
        // 传 focus:false 不抢焦点（save 飞行期用户的焦点不该被偷走）。
        if (typeof applyEditorMode === 'function') {
          applyEditorMode(state.editorMode, { focus: false });
        } else if (restoredReadOnly) {
          editor.setReadOnly(true);
        }
      }
    })();
    // audit fix (Phase O-M4)：主路径也走 outer toast 决策，与 shared path 对称。
    // IIFE 内部不弹 success toast（line 1773 注释已说明），save() outer 在
    // silent=false + result.ok 为真值时统一弹一次「已保存」。shared path（line 1569-1574）
    // 已有同款 toast 处理，主路径之前只 `return await inFlightSave` 把 IIFE
    // 内部 toast 当作 owner 反馈 —— 与 shared path 不对称导致双重反馈。
    //
    // Phase N Q-fix：契约统一为 IIFE 返回 {ok, reason}（line 1798 / 各 catch 分支）。
    // 主路径 + silent=false + reason='STALE'（飞行期切文件）→ 弹「文件已切换，
    // 未保存到磁盘」提示用户，silent=false manual caller 不再被吞反馈。
    const result = await inFlightSave;
    decideSaveToast(silent, result, showToast);
    return !!(result && result.ok);
  } finally {
    // 一站式清理：覆盖所有路径（共享路径等待 / 早退 / IIFE 内部 try/finally / 异常），
    // 保证 savingCount 与 inFlightSave 哨兵永远配对平衡。位置必须在最外层 try 的 finally
    // 里 —— 见 [[project-settings-saving-flag]] 教训：嵌套内部 finally 会被异常路径漏掉。
    state.savingCount--;
    syncSaveButton();
    // 主路径自己产生的 inFlightSave 在这里清；共享路径只 await 不创建新 IIFE，
    // 也走这里统一清空 —— 共享路径完成后这次 save() 结束，下次 save() 自然走主路径
    // 建新的 inFlightSave。重复置 null 无害（已是 null 时保持 null）。
    inFlightSave = null;
  }
}

/**
 * 打开一个文件
 *
 * 流程：
 *   1. 如果是切换到不同文件且当前脏 → 弹窗确认
 *   2. 读取文件
 *   3. 加载到 editor + viewer
 *   4. 重置 dirty / lastSavedMtimeMs
 *
 * 防重入：双击同一个文件、或快速切换文件时，会触发两次 openFile 并发。
 * 串行化保证同一时刻只有一个加载在进行；in-flight 期间重复调用复用
 * 同一 Promise，更晚到达的「新」调用自动抢占（epoch 守卫）。
 */

/**
 * openFile 并发控制（解决 #3：双击 / 快速切换同一文件时的双重 readFile + 双重 load）：
 *
 *   - inFlight = { path, promise }：最近一次尚未完成的加载。
 *     - 同一 path 第二次进入 await 之前 → 复用 promise（不发第二次 readFile）
 *     - 不同 path 第二次进入 → 抢占；旧调用在 await 之后检测 epoch 失效，主动放弃状态变更
 *
 *   - epoch 单调递增：每次 openFile 进入 +1；任何 await 之后比较 myEpoch !== openEpoch 即视为被抢占。
 */
let openEpoch = 0;
let openInFlight = null; // { path: string, promise: Promise }

async function openFile(file) {
  if (!file || !file.path) return;

  // 复用同一文件的 in-flight（同步命中，必须在第一个 await 之前）。
  // audit C1 修复：命中时**不**递增 epoch —— 否则 in-flight 内部的
  // `myEpoch !== openEpoch` 检查会因 openEpoch 已被新调用顶到 N+1 而失败，
  // 导致整个加载链在中途放弃状态变更（双击同一个文件，editor/viewer 不更新）。
  // 直接返回原 promise，等它正常走完；新调用方复用同一结果。
  // audit fix (Case-M1)：Windows / macOS 路径大小写不敏感 —— 用户输入的 case
  // 与 IPC 返回的 canonical case 可能不一致。`===` 会漏命中，导致同一文件
  // 被并发打开两次（双 editor 抖动、state.currentFile 终态不确定）。统一走
  // pathsEqual（utils.js 已有 case-fold 实现）。
  if (openInFlight && pathsEqual(openInFlight.path, file.path)) {
    return openInFlight.promise;
  }

  const myEpoch = ++openEpoch;

  // 防御性：检查目标文件是否在数据目录内（避免从 md 链接越权读文件）
  try {
    const dataDir = await window.api.getDataDir();
    if (dataDir && !isPathInside(file.path, dataDir)) {
      showToast('该链接指向数据文件夹之外的文件', 'warning');
      return;
    }
  } catch {
    // 获取数据目录失败：让主进程兜底
  }

  // audit fix (Round 3 bug 2026-08)：同步 state.isDirty 到 editor 实时真相，
  // 防止 IME 期间切文件 / 打开同名文件时不弹「未保存改动」对话框，让用户
  // 编辑的 IME 字符随 view 销毁静默丢失。详见 syncDirtyFromEditor 注释块。
  syncDirtyFromEditor();

  // 第二阶段代码审查 (Phase 2 review #5)：在第一个 await 之前抓「用户当前打开的文件」
  // + 脏态快照。下面的 dirty 对话框 / save() await 期间，clearCurrentFile 可能被
  // 触发（onFilesChanged race、外部删除、关窗路径、rename 完成），把 state.currentFile
  // 拍成 null、state.isDirty 拍成 false。FILE_NOT_FOUND 分支里如果继续读
  // state.currentFile / state.isDirty，rescue 检查会永远短路，dirty 内容静默丢失。
  // 用快照判断「我们当时打算 open 的那个文件是谁」才是正确的语义。
  const targetFileSnapshot = state.currentFile ? { ...state.currentFile } : null;
  const targetIsDirtySnapshot = !!state.isDirty;

  // 切换到不同文件且当前脏 → 提示
  if (state.isDirty && state.currentFile && state.currentFile.path !== file.path) {
    const choice = await showConfirmDialog({
      title: '未保存的改动',
      message: `当前文件「${state.currentFile.name}」有未保存的改动。\n\n打开「${file.name}」之前请选择如何处理。`,
      icon: 'warning',
      buttons: [
        { value: 'cancel', label: '取消' },
        { value: 'discard', label: '放弃改动', variant: 'danger' },
        { value: 'save_and_open', label: '保存并打开', variant: 'primary' },
      ],
    });
    if (myEpoch !== openEpoch) return; // dialog 期间被新调用抢占
    if (choice === 'cancel' || choice == null) return;
    if (choice === 'save_and_open') {
      let ok = await save();
      if (myEpoch !== openEpoch) return; // 保存途中被新调用抢占
      if (!ok) return;
      // 「半步保存」保护：save 飞行期内用户继续输入 → save 写盘内容是飞行期前
      // 的旧版，但 editor 已是新字符（state.isDirty=true）。下面 loadFile(B)
      // 会用 B 的内容覆盖编辑器，A 的新字符就此丢失。最多补 3 刀把新内容也
      // 写盘（silent=true 避免连续 toast 噪音）。
      //
      // audit fix (Phase 2)：3 刀后仍脏不能「兜底让 loadFile 继续」—— 那是
      // 切文件路径不是关窗路径，没有 main.js confirmDiscardIfDirty re-check
      // 兜底；fallthrough 会让 loadFile(B) 用 B 的内容覆盖编辑器，A 的最新字
      // 符永久丢失。改成「3 刀后仍脏 → 中止 open、提示用户先 Ctrl+S」。
      // 普通路径（saveAndOpen 之外）由用户主动 Ctrl+S 补刀；关窗路径由
      // main.js confirmDiscardIfDirty 的 rendererDirty re-check 兜底 —— 那两
      // 条路径已有保护，这里是第三条路径的补丁。
      //
      // audit fix (Phase O-H5)：break 条件原本是 `!== file.path` —— 永远成立
      // （currentFile 是 A，file 是 B），第一轮立刻退出，注释宣称的「最多 3
      // 次重试救回半步内容」从未执行，A 文件未保存字符静默丢失。改成 `===`
      // 才是正确的语义：currentFile 已是新文件时（被别的 openFile 抢占）才停。
      let stillDirtyAfterRetry = false;
      for (let i = 0; i < 3; i++) {
        if (!state.isDirty) break;
        if (!state.currentFile || pathsEqual(state.currentFile.path, file.path)) break;
        ok = await save({ silent: true });
        if (myEpoch !== openEpoch) return;
        if (!ok) break;
      }
      // Phase 2 防御：3 刀后仍脏（用户持续输入）→ 中止 open，绝不让
      // loadFile(B) 覆盖 A 的未保存字符。用户可 Ctrl+S 后再打开新文件。
      if (state.isDirty && state.currentFile && state.currentFile.path !== file.path) {
        stillDirtyAfterRetry = true;
      }
      if (stillDirtyAfterRetry) {
        showToast('「' + state.currentFile.name + '」还有未保存字符，请 Ctrl+S 保存后再打开', 'warning', 3000);
        return;
      }
    } else if (choice === 'discard') {
      // audit fix (K2-H1)：选「放弃改动」立刻复位脏态 —— 不要等到下面
      // entry.promise 里 line 1678 那一行（readFile 之后才 reset）。中间
      // 窗口期 auto-save 定时器若 fire，会以 A 的 lastSavedMtimeMs 把 B 的
      // 内容写盘，主进程比 mtime 必然不匹配 → 返回 FILE_CHANGED_EXTERNALLY，
      // 用户在刚打开的干净文件上看到红色「文件在外部被修改」冲突框，体验割裂。
      // 同样地，state.isDirty 在 reset 前若 auto-save 撞进来，editor.markSaved
      // 会把 isDirty 拍回 false 但 lastSavedMtimeMs 还是 A 的，副作用相同。
      cancelScheduledAutoSave();
      state.isDirty = false;
      state.lastSavedMtimeMs = null;
      // 同步 editor 的保存基线 —— 不调的话 editor.isDirty() 仍会基于旧 baseline
      // 返回 true（用户之前的输入相对 baseline 是「有改动」），state.isDirty=false
      // 与 editor 内部状态错位。下次 onChange 触发时 state.isDirty = editor.isDirty()
      // 会重新对齐到 true（用户继续输入），按钮会再翻 dirty 态；但中间「放弃后
      // 未输入」窗口里，按钮干净 + editor 内部 dirty 这种状态错位会让调试困惑。
      editor.markSaved();
      // 保存按钮同步：state.isDirty 已翻 false，但视觉态、IPC setDirty 都还没刷。
      // 之前没在这里调，下方 readFile 失败（FILE_TOO_LARGE / NOT_TEXT / 其它错误
      // 走 !result.ok 早退 return result，不走 line 1848 的 syncSaveButton）会让
      // 工具栏保存按钮**永久卡在 is-dirty 态**，用户编辑时也按 Ctrl+S：
      // save() 内 state.isDirty=false 早退 → 没真存盘，但按钮依旧显示「有待保存」，
      // 关窗时主进程的 rendererDirty 还是 true，会要求用户保存一个他们已经放弃的版本。
      syncSaveButton();
    }
  } else if (state.isDirty && state.currentFile && pathsEqual(state.currentFile.path, file.path)) {
    // Phase 2 audit 修复 (P0 BUG #1)：点同一文件 + dirty → 也走「保存 / 放弃 / 取消」对话框。
    // 原代码 `path !== file.path` 把同文件情况短路，编辑器直接被磁盘版本覆盖 → 未
    // 保存字符静默丢失（用户高频误点 / focus 切换都会触发）。提示文案改成「重新加载会丢
    // 弃本地改动」，让用户明白这是 reload 而非切文件。
    const choice = await showConfirmDialog({
      title: '未保存的改动',
      message: `当前文件「${state.currentFile.name}」有未保存的改动。\n\n重新加载会丢弃本地改动，如何处理？`,
      icon: 'warning',
      buttons: [
        { value: 'cancel', label: '取消' },
        { value: 'discard', label: '放弃改动', variant: 'danger' },
        { value: 'save', label: '保存', variant: 'primary' },
      ],
    });
    if (myEpoch !== openEpoch) return;
    if (choice === 'cancel' || choice == null) return;
    if (choice === 'save') {
      const ok = await save({ silent: true });
      if (myEpoch !== openEpoch) return;
      if (!ok) return;
      // 保存成功：让 reload 流程继续走下方 readFile
    } else {
      // 'discard'：复位脏态 + editor 基线（同上方 save_and_open discard 分支）
      cancelScheduledAutoSave();
      state.isDirty = false;
      state.lastSavedMtimeMs = null;
      editor.markSaved();
      syncSaveButton();
    }
  } else if (state.currentFile && pathsEqual(state.currentFile.path, file.path)) {
    // Phase 2 audit 修复：同文件 + 干净 → no-op，避免无谓的 readFile + editor.loadFile
    // 重新加载（编辑器内容 = 磁盘内容，刷新没意义，徒增 IO）。如果用户是想 reload
    // 外部修改过的文件，应该走工具栏「重新加载」按钮（reloadCurrentFileFromDisk），
    // 那是显式 intent。
    return null;
  }

  // 开始真正的加载
  const entry = { path: file.path, promise: null };
  openInFlight = entry;

  entry.promise = (async () => {
    try {
      const result = await window.api.readFile(file.path);
      // 抢占：被更新调用取代，跳过所有状态变更（不弹错误 toast，避免误导）
      if (myEpoch !== openEpoch) return result;

      if (!result.ok) {
        if (result.error === 'FILE_NOT_FOUND') {
          // Phase 2 audit 修复 (P0 BUG #2)：openFile 同路径 readFile 撞 FILE_NOT_FOUND
          // 时不能只 clearCurrentFile —— 用户的 dirty 内容还在编辑器里，
          // 清掉后随 view 销毁丢失。复用 onFilesChanged 的 rescue 模式（line 2737-2761
          // 的 createFile(rescueName, editor.getContent())）把脏内容救到数据目录。
          // 注意：必须在 clearCurrentFile **之前**取 editor.getContent() —— clearCurrentFile
          // 会 unload editor view，之后 editor.getContent() 返回 ''。
          //
          // 第二阶段代码审查 (Phase 2 review #5)：用上方抓的 targetFileSnapshot
          // + targetIsDirtySnapshot 代替直接读 state.currentFile / state.isDirty。
          // 原因：readFile 之前发生过 dirty 对话框 / save() await，clearCurrentFile
          // 可能在这段窗口里被触发（onFilesChanged race、fs-watcher rescue 删文件、
          // 关窗路径），把 state.currentFile 拍成 null、state.isDirty 拍成 false。
          // 原检查 `state.isDirty && state.currentFile && state.currentFile.path === file.path`
          // （pathsEqual 兜底 Windows / macOS 大小写）在 race 命中时永远短路 →
          // dirty 内容被静默丢失。用快照保持「我们当时打算 open 的那个文件是谁」
          // 这个意图不变。
          if (targetIsDirtySnapshot && targetFileSnapshot && pathsEqual(targetFileSnapshot.path, file.path)) {
            // 命名 / 写盘 / toast 文案统一走 src/rescue.js（含 friendlyFsError
            // 错误码 vs message 的语义判断）。注意：必须在 clearCurrentFile 之前
            // 调 rescueDirtyContent 之前的 editor.getContent() —— clearCurrentFile
            // 会 unload view，之后 getContent() 返回 ''。
            rescueDirtyContent({
              api: window.api,
              originalName: targetFileSnapshot.name,
              content: (typeof editor.getContent === 'function') ? editor.getContent() : '',
              event: '文件已被删除',
            });
          } else {
            showToast('文件已被删除', 'warning');
          }
          // audit fix (Round 8 S-2)：只有「消失的正是当前打开的文件」才能 clear。
          // 旧代码无条件 clearCurrentFile() —— 用户在 A（脏）时点了侧栏里一个已被
          // 外部删除、fs-watcher 还没刷掉的条目 B，readFile(B) 撞 FILE_NOT_FOUND，
          // 却把 A 一起清了：clearCurrentFile 会 editor.unload() 并把 isDirty 置 false，
          // A 的未保存内容既没救回也不会在关窗时告警 → 静默丢失。
          //
          // 第二阶段代码审查：clearCurrentFile 检查也用快照判断「消失的是不是当初
          // 打算 open 的那个文件」。state.currentFile 为 null 时 clearCurrentFile 是
          // no-op（line 2249 的早退路径），原表达式 `!state.currentFile || ...` 已经
          // 兼容 race；这里改成显式读快照让两条 rescue / clear 分支的判断口径一致，
          // 未来读代码时不必在两处分别解释为什么一个用 state 一个用 snapshot。
          const matchesTarget = targetFileSnapshot && pathsEqual(targetFileSnapshot.path, file.path);
          if (!state.currentFile || matchesTarget) {
            clearCurrentFile();
          }
        } else if (result.error === 'FILE_TOO_LARGE') {
          showToast(result.message || '文件过大', 'error');
        } else if (result.error === 'NOT_TEXT') {
          // audit fix (Phase L3-FS 1A)：二进制内容误命名为 .md，UI 直接
          // 拒绝编辑而不是静默接受（一旦保存会污染文件）。toast 给提示，
          // 不切换当前文件（避免侧栏双击切换走两次相同路径）。
          showToast(result.message || '该文件不是有效的文本文件，无法编辑', 'error');
        } else {
          // audit fix：result.message 在主进程非 ENOENT 路径下可能是
          // `EACCES: permission denied, open 'C:\\Users\\Alice\\foo.md'` 这种
          // 含完整路径的英文原文 —— 不应直接 toast。
          // 走 friendlyWriteError（与 save 路径同源）映射 EACCES/EPERM/EBUSY
          // 等常见 errno 到中文，unknown 时落 fallback 的 result.message（主进程
          // 已翻译为中文），与 save 路径保持一致。
          showToast(`读取失败：${window.api.friendlyFsError(result.code, result.message || result.error || '未知错误')}`, 'error');
        }
        return result;
      }

      // audit fix (Round 4 S-1)：合并 readFile 返回的 mtimeMs / size 到 currentFile。
// 之前只存 entry.mtimeMs / entry.size，readFile 之后 stat 重新计算可能差几 ms，
// fs-watcher 2s polling 推 files:changed 时新 entry 的 mtimeMs 比
// lastSavedMtimeMs 大几 ms → 误判「外部修改」弹 rescue 提示。把 readFile 的真实
// mtimeMs / size 回写到 currentFile，与 reload 路径 (line 927) 行为对齐。
      state.currentFile = { ...file, mtimeMs: result.mtimeMs, size: result.size };
      state.currentFileIsMarkdown = isMarkdownFile(file.path);
      // 打开文件时记下它所在目录的 relDir —— 与当前显示目录可能不同
      // （例如用户从根目录点开 notes/2026/foo.md 后跳到子目录 notes/2026/03 浏览）。
      // onFilesChanged 用这个字段判断「事件是否针对打开的文件所在目录」，
      // 防止浏览子目录时被误判为「打开的文件被外部删除」。
      // audit fix (Round 4 P1-6)：写到 readFile 之前。openFile 是异步流程：
      // state.currentFile 在入口设了，但 currentFileRelDir 写到 readFile await 之后，
      // 这中间 onFilesChanged 可能 fire（payloadRelDir vs currentFileRelDir 判断时
      // currentFileRelDir 还没值，可能误判跳过）。提到 readFile 之前立刻写好，
      // 与 currentFile 同步进入「已绑定 relDir」状态。
      state.currentFileRelDir = state.currentRelDir;
      fileList.setActive(file.path);

      editor.loadFile(file, result.content);
      if (state.currentFileIsMarkdown) {
        viewer.loadContent(file, result.content);
      } else {
        // 其它可编辑格式（txt/py/json/...）→ viewer 走「不支持预览」空态，
        // 状态栏仍展示文件名/大小/mtime（由 showUnsupportedFile 内部完成）。
        viewer.showUnsupportedFile(file);
      }
      // 重新应用模式：applyEditorMode 会按 state.currentFileIsMarkdown 自动
      // 把非 md 文件的视觉模式强制回落到 edit，并禁用 preview/split 按钮
      // （同时设置 editor.setReadOnly / updateStatusMode）。
      // state.editorMode 本身不变 —— 用户回到 md 后能恢复上次选的模式。
      // audit fix (Phase O-L13)：切文件流程非用户主动模式切换，传 focus:false
      // 不偷焦点（用户在 preview 阅读长笔记时被切到 md → split → edit 焦点跳变）。
      applyEditorMode(state.editorMode, { focus: false });
      // 切到新文件：清掉旧文件的 AI pendingDiff + 把 chat 面板恢复可输入态
      if (ai) ai.onFileChanged(file);

      state.isDirty = false;
      state.lastSavedMtimeMs = result.mtimeMs;
      // audit fix (Phase N-B6)：注意此处**不**重置 state.lastWriteMtimeMs。
      // lastWriteMtimeMs 是「上次自身写盘的 mtime」，与当前打开文件无关。
      // 若切文件时把它清零，新打开的文件的 fs:changed 事件在第一次 writeFile
      // 之前到达 → 回声抑制的 lastWriteMtimeMs > 0 守卫未生效 → 真实外部修改
      // 被误判为「自身写盘回声」吞掉。所以必须保留跨文件的写入历史。
      // clearCurrentFile 会清零（line 758），是因为它彻底销毁 editor/view，
      // 之后没有任何「自身写盘」语义可言；openFile 只是换文件对象，全局历史有效。
      syncSaveButton();
      updateFileCount();
      updateStatusStats();
      updateStatusScroll();
      // audit fix (Phase N+ / save-button audit)：openFile 路径需要刷新 app-title 文案。
      // 之前只有 clearCurrentFile (line ~801) 和 reload 路径 (line ~876) 调
      // updateWindowTitle；openFile 设了 state.currentFile 但没调它，导致用户打开
      // 文件后标题栏一直停在 "Notes"，看不出来打开了哪个文件 —— 与状态栏
      // （已显示 "C:\...\test.md"）+ 工具栏保存按钮（已切到干净态）的反馈不同步，
      // 「保存按钮不起作用」类错觉就是这么来的（用户以为按了没反应，其实是状态
      // 已经更新但标题栏那块 UI 漏刷）。
      updateWindowTitle();
      return result;
    } catch (e) {
      console.error('[app] openFile 异常:', e);
      if (myEpoch === openEpoch) {
        showToast(`读取失败：${e.message}`, 'error');
      }
      throw e;
    } finally {
      // 只清自己的 in-flight slot；如果期间被新调用接管，slot 已是新 entry
      if (openInFlight === entry) openInFlight = null;
    }
  })();

  return entry.promise;
}

/**
 * 更新文件计数（侧边栏显示 X 个文件 / Y 个文件夹）
 *
 * Stage 8：Folder Browser 同时显示文件夹与文件。计数拆成「X 个文件 / Y 个文件夹」，
 * 让用户一眼看到当前目录的结构密度，避免隐藏「我点进了一个 0 文件的空文件夹」。
 * 顶层状态栏 chip 宽度有限，0 项折叠（「0 个文件」「0 个文件夹」）。
 */
function updateFileCount() {
  if (!els.statusCount) return;
  let files = 0;
  let folders = 0;
  for (const entry of state.entries) {
    if (entry.entryType === 'folder') folders += 1;
    else files += 1;
  }
  const parts = [];
  parts.push(`${files} 个文件`);
  if (folders > 0) parts.push(`${folders} 个文件夹`);
  els.statusCount.textContent = parts.join(' / ');
}

/**
 * 把 IPC 返回的 entries 列表落地到 state + 侧栏 + 计数 + 面包屑。
 * 启动加载 / 子目录导航 / onFilesChanged 三条路径共用，集中在这里避免漏更新。
 *
 * Stage 8：
 *   - state.entries 是当前目录的全部条目（folder + editable + binary）
 *   - state.files 只保留 entryType !== 'folder' 的项（兼容老代码：resolveLocalFile、搜索等）
 *
 * M-series fix (audit Phase M-H2)：新增「打开的文件被外部删除」判定。
 * 旧实现把这个判定放在 file-list.setFiles 里（凭 previousActive 不在新 entries
 * 就清空），会把「用户导航到子目录」误判成「文件被删」，导致 Folder Browser
 * 模式下切子目录编辑器被清空。新判定：用「文件所在目录 === 当前浏览目录」
 * 区分两者 —— 只有文件在自己目录里但条目列表里没有，才是真的被删了。
 */
function applyEntries(entries) {
  const list = Array.isArray(entries) ? entries : [];
  state.entries = list;
  state.files = list.filter((e) => e.entryType !== 'folder');
  fileList.setFiles(list);
  updateFileCount();

  // 检测「打开的文件被外部删除」：仅当文件所在目录就是当前浏览目录时
  // 不在新 entries 才视为删除；用户在浏览别的目录时不应被误清。
  //
  // P0 fix (audit 2026-08)：脏情况下**不**调 clearCurrentFile —— 否则
  // state.currentFile 变 null → onFilesChanged line 2901 `if (!state.currentFile)
  // return` 早退 → line 2917 syncDirtyFromEditor 永远到不了 → line 2944
  // rescue 分支永远到不了 → 用户的脏内容既没被 clearCurrentFile 救回也没
  // 被 rescue 救回，state.isDirty 被清零 → 用户关闭窗口时 dirty=false 不弹
  // 未保存确认 → 内容随 DOM 销毁静默丢失。
  // 脏情况下让 onFilesChanged 的 rescue 接管：fileList.setFiles 之后侧栏
  // 高亮会自然消失（currentFile 仍在但新 entries 不含它），用户视觉上
  // 看到「文件从侧栏消失」+ rescue toast「原文件已被删除，未保存内容已
  // 救回到 xxx」+ clearCurrentFile，三步一致。
  //
  // IME race (audit Round 9)：必须用 `editor.isDirty()`（实时真相）而不是
  // `state.isDirty`（IME 合成期间被 updateListener 的 !isComposing 守卫
  // 屏蔽，可能 stale-false）。否则用户 IME 拼音期间外部删除文件 → state.isDirty
  // 是 stale-false → 守卫条件满足 → clearCurrentFile() → onFilesChanged
  // 走早退路径 → syncDirtyFromEditor/rescue 永远不到 → IME 字符随编辑器
  // view 销毁而丢失，且窗口关闭时 dirty=false 不弹保存提示。
  // 用 editor.isDirty() 是「编辑器里有未保存字符就不能销毁 view」的语义
  // 直译，绕开 state 同步时序问题。
  if (state.currentFile && state.currentFile.path && !editor.isDirty()) {
    const fileDir = dirnameOf(state.currentFile.path);
    const sameDir = fileDir && state.currentDir && pathsEqual(fileDir, state.currentDir);
    const stillThere = list.some((e) => pathsEqual(e.path, state.currentFile.path));
    if (sameDir && !stillThere) {
      clearCurrentFile();
    }
  }
}

/**
 * 渲染面包屑：根目录时整段 hidden；否则显示「根 / seg1 / seg2 / ...」
 * 每一段是按钮，点击调用 goToBreadcrumb(idx)；最后一段是当前目录（非可点击）。
 *
 * 与 enterFolder 一起维护 state.breadcrumb —— 该数组记录从根到当前目录的路径，
 * 每段是 { name, relDir }。空数组表示根目录。
 */
function renderBreadcrumb() {
  if (!els.sidebarBreadcrumb || !els.sidebarBreadcrumbTrail) return;
  if (!state.breadcrumb || state.breadcrumb.length === 0) {
    els.sidebarBreadcrumb.setAttribute('hidden', '');
    els.sidebarBreadcrumb.removeAttribute('data-rel-dir');
    els.sidebarBreadcrumbTrail.replaceChildren();
    return;
  }
  els.sidebarBreadcrumb.removeAttribute('hidden');
  els.sidebarBreadcrumb.setAttribute('data-rel-dir', state.currentRelDir || '');

  const frag = document.createDocumentFragment();
  state.breadcrumb.forEach((seg, idx) => {
    if (idx > 0) {
      const sep = document.createElement('span');
      sep.className = 'sidebar-breadcrumb-sep';
      sep.setAttribute('aria-hidden', 'true');
      sep.textContent = '/';
      frag.appendChild(sep);
    }
    if (idx === state.breadcrumb.length - 1) {
      // 当前段：非可点击，仅文本
      const span = document.createElement('span');
      span.className = 'sidebar-breadcrumb-current';
      span.textContent = seg.name;
      span.title = seg.relDir;
      frag.appendChild(span);
    } else {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'sidebar-breadcrumb-btn';
      btn.textContent = seg.name;
      btn.title = `跳转到 ${seg.relDir || '根'}`;
      btn.addEventListener('click', () => goToBreadcrumb(idx));
      frag.appendChild(btn);
    }
  });
  els.sidebarBreadcrumbTrail.replaceChildren(frag);
}

/**
 * 进入一个子目录（点击 folder 条目或面包屑某段时调用）。
 *
 * 流程：
 *   1. 计算新的 relDir = (currentRelDir ? currentRelDir + '/' : '') + folder.name
 *   2. 调 window.api.scanDir(relDir) 拉取该子目录的条目
 *   3. 调 window.api.watchDir(relDir) 切换 fs-watcher 监听目标（payload.relDir 跟着变）
 *   4. 更新 state.currentDir / currentRelDir / breadcrumb + applyEntries + renderBreadcrumb
 *
 * 设计要点：
 *   - scanDir / watchDir 并行不等待（互相不依赖），但本函数 await scanDir 用于错误处理；
 *     watchDir 即便失败（理论上不应该）也不阻塞 UI，监听器只是失去该目录的实时变化。
 *   - 切到子目录后，state.currentFile 仍指向老目录下的旧文件 —— 这正是 Folder Browser
 *     的语义：浏览期间不自动关掉已打开的文件；用户切回原目录或主动 close 才清。
 */
async function enterFolder(folder) {
  if (!folder || folder.entryType !== 'folder' || !folder.path) return;
  const nextRel = state.currentRelDir ? `${state.currentRelDir}/${folder.name}` : folder.name;
  try {
    // 并行：扫条目 + 切换 fs-watcher 目标（互不依赖）。
    // M-series fix (audit Phase M-H5)：原来 watchDir 失败被 .catch 吞掉只
    // 留 console.warn，sidebar 已显示条目但 fs-watcher 没附上，外部修改永远
    // 不显示 —— 用户毫无察觉的静默退化。改为捕获 watchDir 结果，失败时
    // 在进入文件夹后单独 toast 告知用户「侧栏不会自动刷新」。
    const [scanResult, watchResult] = await Promise.all([
      window.api.scanDir(nextRel),
      window.api.watchDir(nextRel)
        .then((r) => ({ ok: !!(r && r.ok), error: r && r.error, message: r && r.message }))
        .catch((e) => ({ ok: false, error: 'IPC_FAILED', message: e?.message })),
    ]);
    if (!scanResult || !scanResult.ok) {
      showToast(`进入「${folder.name}」失败：${scanResult?.message || scanResult?.error || '未知错误'}`, 'error');
      return;
    }
    state.currentDir = scanResult.dir || folder.path;
    state.currentRelDir = scanResult.relDir || nextRel;
    state.breadcrumb = buildBreadcrumb(state.currentRelDir);
    applyEntries(scanResult.entries || []);
    renderBreadcrumb();
    // 无打开文件时让状态栏路径跟随当前目录刷新
    viewer.refreshCurrentDir();
    // M-H5：watchDir 失败时显式告知用户。浏览本身没问题（条目已显示），
    // 但 fs-watcher 失效 = 外部修改不会自动出现在侧栏，用户需要手动重进。
    if (!watchResult.ok) {
      console.warn('[app] watchDir 失败（侧栏不会自动刷新外部修改）:', watchResult.message || watchResult.error);
      showToast(`已进入「${folder.name}」，但文件系统监听启动失败，外部修改不会自动刷新`, 'warning', 3500);
    }
  } catch (e) {
    console.error('[app] enterFolder 异常:', e);
    showToast(`进入「${folder.name}」失败：${e.message}`, 'error');
  }
}

/**
 * 回到根目录（面包屑的「根」按钮或调用方）。
 */
async function goToRoot() {
  if (!state.currentRelDir) return; // 已经在根
  await navigateToRelDir('');
}

/**
 * 跳转到面包屑某段（idx 是 state.breadcrumb 的下标）。
 * breadcrumb[i] 对应 relDir = breadcrumb[0..i] 拼起来。
 */
async function goToBreadcrumb(idx) {
  if (!state.breadcrumb || idx < 0 || idx >= state.breadcrumb.length) return;
  // 当前段直接 no-op（已经是它）
  if (idx === state.breadcrumb.length - 1) return;
  const targetRel = state.breadcrumb.slice(0, idx + 1).map((s) => s.name).join('/');
  await navigateToRelDir(targetRel);
}

/**
 * 公共导航：切到某个 relDir（root = ''）。出错时不修改 state，回退到上一次的列表。
 */
async function navigateToRelDir(relDir) {
  try {
    const [scanResult] = await Promise.all([
      window.api.scanDir(relDir),
      window.api.watchDir(relDir).catch((e) => {
        console.warn('[app] watchDir 失败（不影响浏览）:', e?.message);
      }),
    ]);
    if (!scanResult || !scanResult.ok) {
      showToast(`进入目录失败：${scanResult?.message || scanResult?.error || '未知错误'}`, 'error');
      return;
    }
    state.currentDir = scanResult.dir;
    state.currentRelDir = scanResult.relDir || relDir;
    state.breadcrumb = buildBreadcrumb(state.currentRelDir);
    applyEntries(scanResult.entries || []);
    renderBreadcrumb();
    viewer.refreshCurrentDir();
  } catch (e) {
    console.error('[app] navigateToRelDir 异常:', e);
    showToast(`进入目录失败：${e.message}`, 'error');
  }
}

/**
 * 从 relDir 反算 breadcrumb 数组（每段对应一层）。
 * 例：'notes/2026' → [{name:'notes', relDir:'notes'}, {name:'2026', relDir:'notes/2026'}]
 *     ''           → []
 *     'a'          → [{name:'a', relDir:'a'}]
 */
function buildBreadcrumb(relDir) {
  if (!relDir) return [];
  const parts = relDir.split('/').filter(Boolean);
  return parts.map((name, i) => ({
    name,
    relDir: parts.slice(0, i + 1).join('/'),
  }));
}

/**
 * 加载文件列表（仅启动时调用一次）
 * 后续更新走 onFilesChanged IPC handler。
 *
 * Stage 8：启动时重置 currentDir / breadcrumb（每次启动从根目录开始）。
 * 实际「恢复上次子目录」超出 v1 范围 —— 用户切目录时子目录状态丢失是可接受的；
 * 后续要做再加 settingsStore 持久化。
 */
async function loadFileList() {
  try {
    const result = await window.api.listFiles();
    if (!result || !result.ok) {
      showToast(`加载文件列表失败：${result?.error || '未知错误'}`, 'error');
      return;
    }
    state.currentDir = result.dir || '';
    state.currentRelDir = result.relDir || '';
    state.breadcrumb = buildBreadcrumb(state.currentRelDir);
    applyEntries(result.entries || result.files || []);
    renderBreadcrumb();
    viewer.refreshCurrentDir();
  } catch (e) {
    console.error('[app] loadFileList 异常:', e);
    showToast(`加载文件列表失败：${e.message}`, 'error');
  }
}

/**
 * dataDir 切换完成后的渲染端副作用：
 *   - 重载文件列表
 *   - 若当前打开的文件不在新列表里 → 关闭它
 * 与 SettingsDialog.onChanged 里 dataDir 那段同语义（见 audit #1），
 * 抽出来让 openSettingsDialog / switchDataFolder 共用。
 */
async function onDataDirChanged() {
  await loadFileList();
  if (state.currentFile && !state.files.some(f => f.path === state.currentFile.path)) {
    clearCurrentFile();
  }
}

/**
 * 把 dataDir 脏检查 hook 装到 settingsStore 上跑 fn，结束自动还原。
 * 调用方无需关心 try/finally 与上一钩子的保存/恢复。
 * 命名带 DataDir 是因为目前只有 dataDir 需要这种拦截；
 * 如果以后其他字段也要拦截，再抽通用的 withPreUpdateHook。
 */
async function withDataDirDirtyCheckHook(fn) {
  const previous = settingsStore.getPreUpdateHook();
  settingsStore.setPreUpdateHook(async (partial) => {
    // 只对 dataDir 变化做脏检查；其它设置直接放行
    if (!('dataDir' in partial)) return true;
    // audit fix (Round 3 bug 2026-08)：同步 state.isDirty —— IME 期间切数据
    // 目录若不弹「未保存改动」对话框，用户 IME 字符会随 view 销毁丢失。
    syncDirtyFromEditor();
    if (!state.isDirty || !state.currentFile) return true;

    const choice = await showConfirmDialog({
      title: '未保存的改动',
      message: `当前文件「${state.currentFile.name}」有未保存的改动。\n\n切换数据文件夹之前请选择如何处理。`,
      icon: 'warning',
      buttons: [
        { value: 'cancel', label: '取消', variant: 'secondary' },
        { value: 'discard', label: '放弃改动，继续', variant: 'danger' },
        { value: 'save_first', label: '保存并继续', variant: 'primary' },
      ],
    });
    if (choice === 'cancel' || choice == null) return false;
    if (choice === 'discard') return true;
    if (choice === 'save_first') {
      const ok = await save();
      // audit fix (2.2)：保存失败时给个 toast —— 不然 dialog 消失、dataDir 也不变，
      // 用户不知道发生了什么。
      if (!ok) {
        showToast('保存失败，已取消切换数据文件夹', 'warning', 2500);
      }
      return ok;
    }
    return true;
  });
  try {
    return await fn();
  } finally {
    settingsStore.setPreUpdateHook(previous);
  }
}

/**
 * 打开设置对话框
 *
 * 设置对话框只暴露「无即时触发入口」的偏好项：
 *   - 配色（palette）和阅读排版（无即时按钮）
 *   - AI（无按钮）
 *
 * 已经有即时入口的功能不进设置对话框：
 *   - 数据文件夹 → 侧栏底部「打开 / 切换数据文件夹」
 *   - 主题循环 / 置顶 / 视图模式 → 顶部工具栏或托盘菜单
 *   - 文件列表排序 → 左侧栏工具条
 *   - 自动保存 → 顶部工具栏按钮
 * 见 [[feedback-prefer-near-affected-area]] / [[feedback-no-toolbar-duplicate-in-settings]]。
 */
async function openSettingsDialog(options = {}) {
  state.settingsDialogOpen = true;
  // 模态期间临时收起 AI 输入 dock —— dock 在 body 网格的 row 4（状态栏下方），
  // 设置对话框（max-height 80vh）居中渲染到底部时会与 dock 的视觉区域重叠，
  // 即便 modal-overlay z-index 更高、dock 在半透明背景后仍透出来，视觉上像挡住对话框。
  // 只收起 chat dock，diff 中间面板不动（diff 在 app-shell 第 6 列，不与设置对话框重叠）。
  // close 路径 finally 里有恢复，关了设置会自动把 dock 还原。
  const aiWasOpen = ai && typeof ai.isChatOpen === 'function' && ai.isChatOpen();
  if (aiWasOpen) ai.togglePanel();
  try {
    await withDataDirDirtyCheckHook(async () => {
      const dialog = new SettingsDialog({
        api: window.api,
        settingsStore,
        onChanged: async (changes) => {
          if ('dataDir' in changes) {
            await onDataDirChanged();
          }
          if ('themePalette' in changes) {
            applyPalette(changes.themePalette);
            const label = PALETTE_LABEL[changes.themePalette] || changes.themePalette;
            showToast(`配色：${label}`, 'info', 1500);
          }
          // 阅读排版：立即生效（主题切换不会重置用户的字号/行距）
          if ('readerFontSize' in changes || 'readerLineHeight' in changes) {
            applyReaderSettings();
          }
          // fileListSort / autoSaveDebounceMs 已搬出设置对话框，由 sidebar-sort 工具条 /
          // toolbar 自动保存按钮自己处理；这里不再重复 apply，settingsStore.change 事件统一同步。
          // 见 [[feedback-prefer-near-affected-area]]。
        },
        // 实时预览：用户在设置里切配色 / 字号 / 行距，立刻反映到 app 主题。
        // 走 CSS / dataset，不走 settingsStore（不走就不持久化、不会触发 onChanged），
        // 取消时由 onPreviewRevert 把视觉回退到打开对话框瞬间。
        // AI 字段（provider / baseUrl / key / model / systemPrompt）不走预览——
        // 那是「下次请求要用的参数」，实时预览反而会让人误以为已经发出去。
        onPreview: (changes) => {
          if ('themePalette' in changes) {
            applyPalette(changes.themePalette);
          }
          if ('readerFontSize' in changes || 'readerLineHeight' in changes) {
            applyReaderSettings(changes);
          }
        },
        // 取消时把视觉回滚到基线（基线是 open() 时记录的「打开对话框瞬间」的值）。
        onPreviewRevert: (baseline) => {
          applyPalette(baseline.themePalette);
          applyReaderSettings(baseline);
        },
      });
      try {
        await dialog.open(options);
      } catch (e) {
        // preUpdateHook 拒绝 → settingsStore.update 抛 SETTINGS_UPDATE_CANCELLED，
        // SettingsDialog 已经捕获并显示 toast；这里静默吞掉避免双弹
        if (e && e.message !== 'SETTINGS_UPDATE_CANCELLED') throw e;
      }
    });
  } finally {
    state.settingsDialogOpen = false;
    // 还原 AI dock 状态：之前是开 → 现在 togglePanel() 一次即可（关 → 开）
    if (aiWasOpen && ai && typeof ai.togglePanel === 'function') {
      ai.togglePanel();
    }
  }
}

/**
 * 应用阅读字号 / 行距到 CSS 变量（挂在 documentElement，独立于主题）
 * 这样切主题不会重置用户的字号 / 行距
 *
 * @param {object} [partial] - 可选的覆盖值。键 readerFontSize / readerLineHeight。
 *   - 不传 → 两个维度都从 settingsStore 读（设置启动 / 落盘后的常规路径）
 *   - 部分字段 → 该字段用 partial 里的值；未携带的字段仍然回退到 settingsStore
 *
 * 用于设置对话框实时预览：settings-dialog 维护一个累计视觉快照
 * （palette/fs/lh 三个维度任一切换都更新整体），onPreview 总是传完整快照；
 * 这种 full-partial 路径也支持只携带一个字段 —— 比如以后想做「单维度 patch 式
 * 预览」时也接得住。
 */
function applyReaderSettings(partial) {
  const fs = partial && 'readerFontSize' in partial
    ? partial.readerFontSize
    : settingsStore.get('readerFontSize');
  const lh = partial && 'readerLineHeight' in partial
    ? partial.readerLineHeight
    : settingsStore.get('readerLineHeight');
  if (typeof fs === 'number' && Number.isFinite(fs)) {
    document.documentElement.style.setProperty('--reader-font-size', `${fs}px`);
  }
  if (typeof lh === 'number' && Number.isFinite(lh)) {
    document.documentElement.style.setProperty('--reader-line-height', String(lh));
  }
}

/**
 * 把「行为类偏好」（文件列表排序 + 自动保存）同步到 UI 与运行时状态。
 *
 * 单一入口：所有改这两个设置的路径（sidebar-sort 按钮、顶部工具栏自动保存按钮、
 * 未来的其他入口、外部 IPC）都会 emit 'change'，这里统一负责：
 *   1. 高亮对应的 sidebar-sort 按钮 + 更新 aria-pressed
 *   2. 重排 fileList（仅当 sortMode 真变化时才走 setSort）
 *   3. 更新 toolbar-autosave 按钮文案（label）+ active 态
 *   4. 重启 autoSave 定时器
 *
 * 设计动机：见 [[feedback-prefer-near-affected-area]]。
 * 之前这段逻辑散在 settings-dialog.onChanged 里，行为项搬出后必须有一个
 * 唯一的「settings → UI」同步点，否则多个入口各管一摊会出竞态。
 *
 * 缓存：settingsStore.on('change') 在无关变更（theme / palette / dataDir ...）下
 * 也会触发；用 lastSortApplied / lastAutosaveMs 缓存上次实际
 * 应用的值，让非行为类变更变成 O(1) no-op。
 */
let lastSortApplied = null;
let lastAutosaveMs = null;
function syncBehaviorPrefsUI(settings) {
  // 1. 排序按钮态 + fileList 重排
  // audit fix (CQ-MED-9)：未知 fileListSort 走 schema 第一项作为兜底，不再硬编码 'name'。
  const sort = FILE_LIST_SORT_VALUES.includes(settings.fileListSort)
    ? settings.fileListSort
    : DEFAULT_FILE_LIST_SORT;
  // 用 schema 第一项作为「按名称」按钮的值、第二项作为「按修改时间」按钮的值 —— 与
  // SETTINGS_UI_OPTIONS.fileListSort 的排列顺序保持一致；加新排序选项时只要在
  // schema 末尾追加即可，无需再改 renderer 字面量。
  const nameSortValue = FILE_LIST_SORT_VALUES[0] || 'name';
  const mtimeSortValue = FILE_LIST_SORT_VALUES[1] || 'mtime-desc';
  if (sort !== lastSortApplied) {
    lastSortApplied = sort;
    if (els.btnSortName) {
      const isName = sort === nameSortValue;
      els.btnSortName.classList.toggle('is-active', isName);
      els.btnSortName.setAttribute('aria-pressed', isName ? 'true' : 'false');
    }
    if (els.btnSortMtime) {
      const isMtime = sort === mtimeSortValue;
      els.btnSortMtime.classList.toggle('is-active', isMtime);
      els.btnSortMtime.setAttribute('aria-pressed', isMtime ? 'true' : 'false');
    }
    fileList?.setSort(sort);
  }

  // 2. 自动保存 chip 文案 + （关 → 取消 pending；开 → 等下次 onChange 重新调度）
  // audit fix：fallback 用 schema 同一份常量而不是硬编码 500，改默认值只改一处。
  const ms = Number.isFinite(settings.autoSaveDebounceMs)
    ? settings.autoSaveDebounceMs
    : window.api.settingsSchema.AUTO_SAVE_DEFAULT_DEBOUNCE_MS;
  if (ms !== lastAutosaveMs) {
    lastAutosaveMs = ms;
    // 用状态点 dot 的 dim/highlight 替代旧「自动保存: 开/关」冗余文案 —— 开启态
    // 点为 accent 高亮 + 微微脉动，关闭态点为 fg-muted dim；title 同时更新。
    if (els.toolbarAutosave) {
      const isOn = ms !== 0;
      // audit fix：移除 classList.toggle('is-active', isOn) —— 新 toolbar-toggle
      // CSS 走 aria-pressed 单一驱动；保留 is-active 反而会和 .btn-icon-text.is-active
      // 的旧规则叠加（accent 高亮 + bg-elevated + font-weight 600 + box-shadow），
      // 与纯 aria-pressed 设计冲突。
      els.toolbarAutosave.setAttribute('aria-pressed', isOn ? 'true' : 'false');
      // P3 fix：title 文案必须用真实 ms —— 之前硬编码 500，但 settings 默认是 500
      // 一致所以无感；用户调成 1500 后，title 还显示 500 造成误解。
      els.toolbarAutosave.title = isOn
        ? `自动保存：开启（停打后 ${ms}ms 保存）· 点击关闭`
        : '自动保存：关闭 · 点击开启';
    }
    // 用户主动切到「关」→ 立即取消任何 pending 保存；切到「开」→ 等下次 onChange 自然调度
    if (ms === 0) cancelScheduledAutoSave();
  }
}

/**
 * 自动保存：debounce 模式（用户停打 X ms 后保存一次）。
 *
 * 与老版 setInterval 的区别：
 * - 不再每隔 X 秒无脑轮询；只在每次编辑后调度一次定时器
 * - 连续键入会反复重置定时器，真正停手时才落盘
 * - 没人打字时完全静默（0 IO）
 *
 * 调用方：
 *   - editor.onChange：每次编辑后调一次
 *   - syncBehaviorPrefsUI：用户切换到「关」时调 cancelScheduledAutoSave
 *   - 用户点 toolbar 按钮：set → 0 / 500，下一次编辑自然走新值
 */
let autoSaveTimeout = null;
// audit fix (C1)：save 入口的 in-flight sentinel —— 防止 save#1 在 writeFile await
// 飞行期内 save#2 又被触发（auto-save 防抖定时器 / 冲突对话框内再次按 Ctrl+S 等），
// 走第二次 IPC 把磁盘 mtime 提前用掉、弹「文件外部修改」红框把自己吓到。
let inFlightSave = null;
function currentAutoSaveDebounceMs() {
  const v = settingsStore.get('autoSaveDebounceMs');
  return Number.isFinite(v) ? v : 500;
}
// audit fix (renderer-M5)：用户曾在设置里把 autoSaveDebounceMs 调成 1500ms
// 这种「自定义非零值」，点工具栏按钮关掉（→ 0）后再开启，原来会硬塞 500ms
// 默认值，自定义值悄悄丢失。这里记一份「上一次非零值」—— 关掉时不动，开启
// 时优先复用上次值，schema 默认 500 只在「从未开过」时兜底。
let lastNonZeroAutoSaveMs = 500;
function cancelScheduledAutoSave() {
  if (autoSaveTimeout) { clearTimeout(autoSaveTimeout); autoSaveTimeout = null; }
}
function scheduleAutoSave(debounceMs) {
  cancelScheduledAutoSave();
  if (!debounceMs || debounceMs <= 0) return;
  autoSaveTimeout = setTimeout(() => {
    autoSaveTimeout = null;
    // 审计修复 (Round 11 deep-fix P2-2)：定时器 fire 时不要直接读 state.isDirty。
    // IME compositionend 与 setTimeout 之间存在 micro-window：compositionend 触发
    // dirty-sync 更新 state，但定时器已经在 microtask 队列里、抢在前面跑 → state 是
    // 旧的 false → auto-save 跳过 → 用户立刻关窗 → IME buffer 永久丢失。
    // 改用 editor.isDirty() 取真值（CM6 内部按 doc 与 lastSavedDoc 比较，是
    // 同步真值），并显式调一次 syncDirtyFromEditor 让下游路径（toast、save
    // 链）的 state 与真值对齐。详见 src/dirty-sync.js 注释。
    syncDirtyFromEditor();
    if (
      state.isDirty
      && state.currentFile
      && editor.view
      // fix(audit 2026-08)：IME 合成期间跳过 auto-save。
      //   - editor.view.state.doc 包含 IME buffer（未确认字符）
      //   - save() → IPC 写盘 → 磁盘文件含半截 pinyin / 日文假名
      //   - 用户按空格确认 IME → editor 内容变化，但磁盘已是「半截 IME」状态
      //   - 用户感知：保存成功，但文件里有一行怪字符
      // 合成期 scheduleAutoSave 仍会被 onChange 反复 clearTimeout（updateListener
      // 内已有 isComposing 跳过），但 setTimeout 已经 firing 这一次（用户停手 500ms
      // 触发）仍会跑。补一道守卫：compositionend 时 scheduleAutoSave 会被下一次
      // onChange 重新触发，自然延后到 IME 结束后保存。
      && !editor.isComposing()
    ) {
      // audit fix #1：不再短路 `editorMode === 'preview'` —— AI applyUserChange 会绕过
      // EditorView.editable 只读检查在 preview 模式下写 doc，导致 isDirty=true 但编辑器不可见。
      // save() 内部会判断：真脏了就切到 edit 模式落盘，没脏才早退。
      // silent: 不弹「已保存」toast，失败仍然弹
      //
      // 这里显式 .catch 兜底 —— save() 内部已 try/catch 捕获所有 IPC 异常并弹 toast，
      // 理论上不会 reject；但若未来重构时 save() 加异步逻辑漏了 try 包，
      // 会变成 unhandledrejection 直接进 console 噪音。留一道防线。
      save({ silent: true }).catch((e) => {
        console.error('[app] auto-save unhandled rejection:', e);
      });
    }
  }, debounceMs);
}

/**
 * 主进程事件订阅
 *
 * Phase 6 audit (H1) fix：window.api.on* 返回 unsubscribe 函数（preload.js
 * 内部用 ipcRenderer.on 注册），但之前所有调用点都丢弃返回值。Ctrl+R 触发
 * window.location.reload 后，preload 重新求值会再注册一份新 listener，
 * 旧 listener 不会被自动拆 —— N 次 reload 后每次主进程 send 触发 N 次
 * callback 链（最显形的副作用是 menu:toggle-theme 被点 N 次主题翻 N 次、
 * menu:settings 打开 N 个 dialog 堆栈）。
 *
 * 修法：把 unsubscribe 收集到 ipcUnsubscribes 数组，pagehide 时统一拆。
 * 这与 fileList / viewer / editor 的 .dispose() 同款「统一释放入口」模式。
 */
const ipcUnsubscribes = [];
// audit fix (Phase 6 H2)：mountKeyboardShortcuts 返回 document keydown 的
// dispose 闭包，bootstrap 必须 capture 它并交给 pagehide —— 否则重复 bootstrap
// （未来 settings / dataDir 切换走热重载路径时）会堆 listener。
let disposeShortcuts = null;
function subscribeIpc() {
  // 文件列表变化（外部添加 / 删除 / 修改）
  // 用签名缓存去重：内容真正变化才 setFiles + updateFileCount，
  // 避免 fs.watch 抖动 + 2 秒 readdir 轮询触发的反复重渲。
  let lastFilesSignature = '';
  // audit fix (renderer-M2)：fs.watch 在一次用户操作（save / rename）里常
  // burst 出 3-5 个事件（create+modify+rename）。callback 是 async，会 await
  // showConfirmDialog —— 旧实现没有 re-entrance 守卫，第 2/3 次并发回调里
  // showConfirmDialog 撞到 modal-stack 单槽返回 null；choice === null 落到
  // else 分支（见 M6）把 state.lastSavedMtimeMs 静默推进，污染 dirty 检测
  // 并吞掉用户真正选择。
  //
  // audit fix (Round 7 FS-F3)：用 fsHandlerToken + inFlightToken 双 token
  // 模式取代旧布尔锁 inFlightFilesChanged。旧布尔锁的问题是：8s watchdog
  // 释放的是「别人的锁」 —— 原 handler 仍在 await showConfirmDialog，watchdog
  // 把 inFlight 置 false → 新事件可进入 → 第二个 handler 的 finally 会把
  // 第二个 handler 刚拿到的锁释放掉（2998 行 `if (inFlightFilesChanged)
  // inFlightFilesChanged = false` 无法识别「锁是不是我的」），长对话框场景
  // 下「锁」实际退化为无保护。token 模式下：入口拿 myToken = ++fsHandlerToken
  // 推进全局戳；inFlightToken 只在确认是当前「飞的 handler」时才被赋；
  // watchdog 与正常路径的 finally 都校验「myToken === inFlightToken」才释放。
  // 旧 handler finally 校验失败 noop。
  //
  // audit fix (Round 7 FS-F2)：被 inFlight 挡掉时记下 pendingRescanRel，当前
  // handler 在 finally 里若 token 仍是自己的、且有待补扫的 relDir，调
  // scanDir 补一次再释放锁。旧版只 console.debug 就 return —— main 端 fs-watcher
  // 已经把 lastFilesSnapshot 推进到新值（详见 main/fs-watcher.js updateSnapshot
  // line ~113），下一次 2s 轮询会判定「无变化」不再 emit，侧栏永久性 stale，
  // 直到发生另一次无关的磁盘变化才恢复。
  let fsHandlerToken = 0;
  let inFlightToken = 0;
  let pendingRescanRel = null;
  const FS_HANDLER_WATCHDOG_MS = 8000;
  ipcUnsubscribes.push(window.api.onFilesChanged(async (payload) => {
    const myToken = ++fsHandlerToken;
    // 入口解构 payload —— 即便被挡也记下 relDir 用于补扫。
    const { entries, error, relDir } = payload || {};
    const payloadRel = typeof relDir === 'string' ? relDir : '';
    // 上一 handler 仍在飞？记下要补扫的 relDir 后直接 return。
    if (inFlightToken !== 0) {
      console.debug('[app] fs:changed burst dropped (handler in flight)');
      // Round 13 fix (H11)：只有新事件与当前显示目录相关时才覆盖 pendingRescanRel。
      // 旧版无条件 `pendingRescanRel = payloadRel`（以及下方 inFlight 路径的
      // 同样无条件赋值）会让「在子目录里编辑时收到根目录变化」覆盖掉子目录里
      // 的 pending —— 用户切回子目录时看不到该刷的列表。
      if (payloadRel === state.currentRelDir) {
        pendingRescanRel = payloadRel;
      }
      return;
    }
    inFlightToken = myToken;
    pendingRescanRel = payloadRel;
    let watchdogTimer = null;
    try {
      watchdogTimer = setTimeout(() => {
        // 看门狗：仅当当前飞的仍是「我的」时强制放行；新 handler 已经进入
        // 的话不动它的锁。
        if (inFlightToken !== myToken) return;
        console.warn('[app] fs-watcher 回调看门狗触发，强制放行（handler 卡住超过 8s）');
        // 审计修复 (Round 11 P0-2)：释放锁 + 主动补扫。
        // 旧实现只 warn 不释放 —— 在 dialog 单槽永久卡死等罕见情况下，
        // 当前 handler 的 finally 永远跑不到 → inFlightToken 永远 > 0 →
        // 后续所有 fs:changed 都被入口 if (inFlightToken !== 0) 吞掉。
        // 现在 watchdog 直接解锁 + 记下补扫；如果原 handler finally 后来又跑，
        // token 已被覆盖，原 finally 的 if (inFlightToken === myToken) 守卫 noop，
        // 不会释放新 handler 的锁。
        if (inFlightToken === myToken) {
          const relToRescan = pendingRescanRel;
          pendingRescanRel = null;
          inFlightToken = 0;
          if (relToRescan && relToRescan === state.currentRelDir) {
            window.api.scanDir(relToRescan).then((r) => {
              if (r && r.ok && Array.isArray(r.entries)) applyEntries(r.entries);
            }).catch((e) => {
              console.warn('[app] watchdog rescan failed:', e && e.message);
            });
          }
        }
      }, FS_HANDLER_WATCHDOG_MS);
      // Stage 8：fs-watcher 只盯「当前显示目录」，payload.relDir 字段标识事件来源；
      // 与 state.currentRelDir 不匹配的事件（理论不会发生 —— 我们已经切了 watchDir，
      // 但 polling 期间用户可能在另一目录触发变化）一律忽略，避免子目录事件把根目录列表刷掉。
      // Round 13 fix (H11)：payloadRel 已在入口处解构（line ~2914），这里复用，
      // 删除重复 const 声明 —— 旧版在 try 块顶部又声明一次会让 lint 报
      // 'payloadRel' is already declared in upper scope。
      // payloadRel === state.currentRelDir 检查覆盖范围不变。
      if (payloadRel !== state.currentRelDir) {
        // audit fix：原版静默 return，未来如果出现「切目录 debounce 错位」类 bug
        // 会让侧栏停在旧视图而用户毫无线索。给一条 console.debug 让 DevTools 能
        // 看到事件流，调试期打开 console 即可捕获。
        if (typeof console !== 'undefined' && console.debug) {
          console.debug('[app] 忽略 fs-watcher 事件（relDir 不匹配）', {
            payloadRel,
            currentRelDir: state.currentRelDir,
          });
        }
        return;
      }

      // 仅推送错误（主进程扫描失败 —— audit #3）：保留上次的列表 + 显式提示用户。
      if (error && !entries) {
        // audit fix (Round 4 P0-2)：旧版 payload.code === 'ENOENT' 检查永远为 false
        // —— fs-watcher 自扫分支（fs.watch 触发后自己又扫）发送的 payload 只含
        // { error, relDir } 无 code 字段，绝大部分路径走自扫分支，用户把数据目录
        // 整个删掉时只能看到普通「扫描失败」没有「切换数据文件夹」指引。直接判 error
        // 字符串，与 fs-watcher 两条错误路径的字段无关。
        if (error === 'DATA_DIR_NOT_FOUND' || error === 'ENOENT') {
          // auto-fallback 2026-08：数据目录被外部删了 / 移动到移动硬盘未挂载 / 网盘掉线 —
          // 比普通扫描错误严重得多。runtime fallback 已在 main.js 兜底走默认（侧栏会显示
          // 默认目录的文件），但用户必须知道发生了什么 + 有 3 个恢复出口（恢复默认 /
          // 切换其他 / 稍后处理）。原版只是一个 toast 提示点击「切换数据文件夹」，
          // 错过即丢；升级到 confirm dialog 显式弹窗，行为与启动时的 promptDataDirFallback 对齐。
          // 用闭包持有 savedDataDir 在弹窗里显示「之前设置的是哪个路径」。
          // 注意：savedDataDir 拿的是 settingsStore 内存里的值 —— 主进程 fallback
          // 没改它，所以这里读到的还是用户当初设置的自定义路径（哪怕磁盘上已不存在）。
          const defaultDir = await window.api.getDefaultDataDir();
          promptDataDirFallback({
            saved: settingsStore.get('dataDir') || '',
            dir: defaultDir,
            defaultDir,
          });
        } else {
          showToast(`扫描文件失败：${error}`, 'error', 3500);
        }
        return;
      }

      const nextEntries = entries || [];
      // 签名：name | path | size | mtimeMs | isFolder —— 与 fs-watcher 的 snapshot 同步
      const signature = nextEntries.map((e) => {
        if (e.isFolder || e.entryType === 'folder') return `d:${e.name}`;
        return `f:${e.name}|${e.size}|${e.mtimeMs}`;
      }).join('\n');
      const filesChanged = signature !== lastFilesSignature;
      if (filesChanged) lastFilesSignature = signature;

      if (filesChanged) {
        applyEntries(nextEntries);
      }

      if (!state.currentFile) return;

      // P0 fix：仅当事件来自打开文件所在目录时，才检查「文件是否被外部删除」。
      // 之前用 state.files.some(...) 检查 —— 而 state.files 是当前显示目录的
      // 文件列表；用户从根目录打开 notes/2026/foo.md 后跳进子目录 notes/2026/03
      // 浏览，state.files 变成子目录条目（不含 foo.md），会被误判为「文件被外部
      // 删除」触发 rescue / clearCurrentFile，编辑器内容被清空。
      // 用事件 payload 自己的 entries（来自文件所在目录）来检查，
      // 并加 relDir 守门避免处理无关目录的事件。
      if (payloadRel !== state.currentFileRelDir) {
        return;
      }
      const stillExists = nextEntries.some((e) => pathsEqual(e.path, state.currentFile.path) && e.entryType !== 'folder');
      if (!stillExists) {
        // audit fix (Round 3 bug 2026-08)：IME 期间文件被外部删除 —— state.isDirty stale
        // 会绕过 rescue 路径直接 clearCurrentFile，editor.doc 里的 IME 字符随 view 销毁丢失。
        syncDirtyFromEditor();
        // Phase 2 audit 修复 (P1 BUG #3 / #4)：rename / delete 飞行期 fs-watcher
        // 先推 files:changed（A 不在 entries），但此时 currentFile.path 仍是
        // 旧值（A）。如果不识别「正在 rename / delete」就会误触发 rescue：
        //   - rename：救回一个 `<A>-rescued-<stamp>.md`（内容 = editor 内容 =
        //     与重命名后的 B 完全相同），产生孤儿文件 + 后续 rename IPC 返回
        //     时 state.currentFile 已被 rescue 分支清 null，post-await 更新
        //     跳过 → 编辑器清空。
        //   - delete：救回一个 `<A>-rescued-<stamp>.md`（内容 = 用户要删的 A
        //     内容），与「删除」操作意图完全相反 —— 用户预期的删除 + 多出
        //     一个文件。
        // 守卫：state.renamingPath / state.deletingPath 在 file-ops 的 rename /
        // delete 进入前设，离开时清。命中 → 跳过 rescue，由 file-ops 自己的
        // post-await 路径接管（rename 更新 state.currentFile.path；delete
        // 调 clearCurrentFile）。
        const isRenameInFlight = state.renamingPath
          && state.currentFile
          && state.currentFile.path === state.renamingPath;
        const isDeleteInFlight = state.deletingPath
          && state.currentFile
          && state.currentFile.path === state.deletingPath;
        if (isRenameInFlight || isDeleteInFlight) {
          // 飞行中的 rename / delete：由 file-ops 自己接管状态更新，
          // 这里只做无操作让 fs-watcher 流程继续（applyEntries 已更新
          // state.files，但 state.currentFile 不动）。
          return;
        }
        if (state.isDirty) {
          // P1-4：未保存内容不能静默丢失。命名 / 写盘 / toast / friendlyFsError
          // 错误码 vs message 的处理全部收口到 src/rescue.js（详见该文件注释 + audit
          // renderer-M9 的同秒重名问题）。这里只关心「有 content、想救回」。
          rescueDirtyContent({
            api: window.api,
            originalName: state.currentFile?.name,
            content: (typeof editor.getContent === 'function') ? editor.getContent() : '',
            event: '原文件已被删除',
          });
        } else {
          showToast('当前文件已被删除', 'warning');
        }
        clearCurrentFile();
        return;
      }

      // 当前文件被外部修改 → 根据脏状态决定行为
      // audit fix (Phase 7 M1)：原来用 state.files.find(...) 取当前文件的
      // 最新 entry，但 state.files 只在 filesChanged=true 时通过 applyEntries
      // 更新；如果 fs-watcher 在两次 polling 之间 burst 触发但 content
      // 不变（e.g. mtime + size 之外的时间戳变了，签名仍是 f:name|size|mtime
      // 所以 filesChanged=false），state.files 持有旧 mtime，下面的
      // `updated.mtimeMs > state.lastSavedMtimeMs` 永远不会 true，外部修改
      // 被静默吞掉。改成用本次事件的 nextEntries 查找，与上面 stillExists
      // 检查保持一致 —— 同一份 fresh data。
      //
      // P0 fix (audit 2026-08)：save() 飞行期间直接 return，不弹「外部修改」
      // 对话框。场景：用户按 Ctrl+S → writeFile 在 await → 飞行期 fs-watcher
      // 推 files:changed（可能是自身写盘回声，也可能是真的外部修改）→
      // 进入这段 → 弹「文件在外部被修改」对话框 → 用户以为是误报点
      // 「使用外部」→ reloadCurrentFileFromDisk → 飞行期用户新敲的字符
      // 被 setExternalContent 静默覆盖 → 用户以为保存成功实则丢字。
      // 跳过是安全的：save() 完成后会写 lastSavedMtimeMs = result.mtimeMs
      // （写盘成功的新 mtime），下次 fs:changed 时 mtime 比对逻辑会把外部
      // 修改（如果有）正确识别为「外部修改」并弹对话框。延迟一个 fs:changed
      // 周期（~300ms debounce）可接受。
      if (state.savingCount > 0) return;
      // fix(audit 2026-08)：Windows 路径大小写不敏感，必须用 pathsEqual。
      // state.currentFile.path 可能与 fs-watcher 返回的 case 不一致（用户输入
      // 时的 case vs 磁盘真实 case），=== 会漏掉外部修改。
      const updated = nextEntries.find((e) => pathsEqual(e.path, state.currentFile.path) && e.entryType !== 'folder');
      if (updated && state.lastSavedMtimeMs != null && updated.mtimeMs > state.lastSavedMtimeMs) {
        // 抑制「刚保存引发的回声」（P1-2）：按 mtime 比对而非时间窗。
        //   - 干净态：±5ms 容差覆盖 fs stat 抖动（NTFS/ReFS），吞无意义的 echo。
        //   - 脏态（Phase N-A4 → audit 2026-09-21）：从严格 === 放宽到 ±1500ms，
        //     覆盖 FAT32 / exFAT（2 秒桶）/ HFS+（1 秒）/ SMB（1-2 秒）下
        //     自身保存的 mtime 截断 —— 否则用户保存后会被误判为「外部修改」弹
        //     冲突对话框。1500ms 容差几乎不影响真实外部修改检测：
        //     外部进程改文件的窗口远大于 1.5s，且用户可手动 reload。
        if (state.lastWriteMtimeMs > 0
            && Math.abs(updated.mtimeMs - state.lastWriteMtimeMs) <= 1500) {
          return; // 自身写盘回声
        }
        if (state.isDirty) {
          // 脏：让用户选择
          const choice = await showConfirmDialog({
            title: '文件在外部被修改',
            message: `「${updated.name}」在外部被修改，但你有未保存的本地改动。\n\n选择保留哪一份？`,
            icon: 'conflict',
            buttons: [
              { value: 'cancel', label: '取消（暂不处理）', variant: 'secondary' },
              { value: 'keep_local', label: '保留我的', variant: 'secondary' },
              { value: 'use_external', label: '使用外部版本', variant: 'primary' },
            ],
          });
          // audit fix (renderer-M6)：choice === null 是 modal-stack 单槽被占
          // 时 showConfirmDialog 的返回值，与「用户主动取消」语义不同。
          // 旧实现的 else 分支把 lastSavedMtimeMs 静默推进到 updated.mtimeMs
          // —— 用户根本没做选择，dirty 检测却被锁住到下一次外部 mtime 变化。
          // 现在 null 单独识别为「对话框被拒」，不做任何状态推进，让下一次
          // fs.watch 事件再次弹出对话框。
          if (choice === 'use_external') {
            const ok = await reloadCurrentFileFromDisk(updated);
            if (ok) showToast('已切换到外部版本', 'info', 1800);
          } else if (choice === 'keep_local') {
            // 忽略外部修改：把 lastSavedMtimeMs 推进到最新外部 mtime，
            // 下次外部再改时仍然能检测到。
            state.lastSavedMtimeMs = updated.mtimeMs;
            showToast('已忽略外部修改，保留本地版本', 'info', 1800);
          } else if (choice === 'cancel') {
            // 用户主动取消：推进 mtime 以避免反复弹窗（行为不变）
            state.lastSavedMtimeMs = updated.mtimeMs;
          }
          // choice === null：modal-stack 被占，对话框没出来 → 什么都不做
        } else {
          // 干净：自动重载（保留原有体验）
          const ok = await reloadCurrentFileFromDisk(updated);
          if (ok) showToast('文件已在外部更新，已自动重新加载', 'info', 2200);
        }
      }
    } finally {
      // 正常路径：clear watchdog（如果已经触发则 watchdogTimer 已被设为 null）。
      if (watchdogTimer) {
        clearTimeout(watchdogTimer);
        watchdogTimer = null;
      }
      // audit fix (Round 7 FS-F3)：用 token 守护释放「自己的锁」。
      // 旧布尔锁的问题是：8s watchdog 把 inFlightFilesChanged 置 false 时，
      // 新 handler 已经进入并把 inFlightFilesChanged 重新置 true，但旧 handler
      // 的 finally 仍会运行 `if (inFlightFilesChanged) inFlightFilesChanged
      // = false`，把新 handler 刚拿到的锁给释放掉 —— 长对话框场景下「锁」
      // 实际退化为无保护。token 校验：旧 handler finally 检查
      // `inFlightToken === myToken`，不匹配直接跳过释放；新 handler 的锁
      // 由它自己的 finally 处理。
      //
      // 注意：不能在 finally 里直接 return —— eslint no-unsafe-finally 规则
      // 会让外层 handler 的返回值（如果 finally 所在 try 有返回值）变成
      // finally 的返回值，覆盖真实逻辑。这里 finally 所在 try 没有显式
      // return（applyEntries / setExternalContent 等副作用），但用 if 包裹
      // 释放路径更稳健：只在自己是当前 in-flight 时才走释放 + 补扫。
      if (inFlightToken === myToken) {
        // 释放前先做 F2 补扫（FS-F2）：在飞期间 main 端 fs-watcher 已经把
        // lastFilesSnapshot 推进到新值（main/fs-watcher.js#updateSnapshot
        // line ~113），下一次 2s 轮询会判定「无变化」不再 emit → 必须主动
        // 调 scanDir 拉一次 fresh data。仅当 pendingRescanRel 等于当前显示
        // 目录才补（避免给无关目录补扫造成侧栏错乱）。如果我的 handler 入口
        // 没记 pendingRescanRel（即没有被挡的情况），这里直接跳过补扫。
        const relToRescan = pendingRescanRel;
        pendingRescanRel = null;
        inFlightToken = 0; // 先释放锁，让下一个事件可以进入
        if (relToRescan && relToRescan === state.currentRelDir) {
          // 异步补扫，不 await —— finally 不能阻塞 handler 退出。补扫失败
          // 不影响 inFlightToken 释放（已经置 0），下次 fs:changed 会自然推进。
          window.api.scanDir(relToRescan).then((r) => {
            if (r && r.ok && Array.isArray(r.entries)) {
              // 与正常路径 applyEntries 同源；不刷 currentFile.rescue 路径。
              applyEntries(r.entries);
            }
          }).catch((e) => {
            console.warn('[app] pending rescan failed:', e && e.message);
          });
        }
      }
    }
  }));

  // 菜单命令
  ipcUnsubscribes.push(window.api.onMenuCommand((cmd) => {
    if (cmd === 'menu:toggle-theme') {
      cycleTheme();
    } else if (cmd === 'menu:settings') {
      openSettingsDialog();
    }
  }));

  // 置顶状态变化（来自托盘菜单）
  ipcUnsubscribes.push(window.api.onAlwaysOnTopChanged((enabled) => {
    state.alwaysOnTop = !!enabled;
    syncPinButton(state.alwaysOnTop);
  }));

  // 最大化状态变化
  ipcUnsubscribes.push(window.api.onMaximizeStateChanged((isMaximized) => {
    state.isMaximized = !!isMaximized;
    syncMaxButton(state.isMaximized);
  }));

  // auto-fallback 2026-08：启动时主进程广播一次数据目录解析结果。
  // fellBack=true → custom 路径不可用，已 runtime 回退到默认；
  // 弹一个一次性的引导弹窗，让用户明确知道这件事 + 给三个出口（恢复默认 / 切其他 / 取消）。
  // fellBack=false → 啥也不弹（避免每次启动都打扰用户）。
  ipcUnsubscribes.push(window.api.onDataDirResolved((payload) => {
    if (!payload || !payload.fellBack) {
      // 不广播：仅在 fellBack 时弹窗；正常启动不要任何反馈。
      return;
    }
    promptDataDirFallback(payload);
  }));

  // 主进程请求保存（用户点击关闭按钮、有未保存改动、选择「保存后退出」时触发）
  ipcUnsubscribes.push(window.api.onSaveRequest(async ({ reqId } = {}) => {
    if (!reqId) return;
    // audit fix (Round 3 bug 2026-08)：IME 期间关窗 —— state.isDirty stale
    // 会让 renderer 告诉主进程「无需保存」+ 用户关窗 → IME 字符丢失。同步一次。
    syncDirtyFromEditor();
    if (!state.isDirty || !state.currentFile) {
      // 没有需要保存的内容：直接告诉主进程成功
      // audit fix #1：去掉 `editorMode === 'preview'` 短路 —— AI 在 preview 模式下
      // 改 doc 也会标脏，save() 内部会切到 edit 模式落盘后再返回。
      window.api.reportSaveResult(reqId, { ok: true });
      return;
    }
    try {
      // save() 自己吞掉所有异常，用返回值表示成功与否；必须如实上报，
      // 否则主进程会以为保存成功并继续退出，改动就丢了。
      //
      // Phase N Q-fix：silent=true 让关窗口路径的反馈由主进程原生框主导
      // （confirmDiscardIfDirty 已经会在保存失败后弹「保存失败」原生框，
      // recursive confirmDiscardIfDirty 会在半步保存后弹「保存后又产生新
      // 改动」原生框），避免双重反馈（renderer toast 在关窗口期间用户看不
      // 见 + 主进程原生框会重叠显示）。成功路径用户也没法看到 toast（窗
      // 口即将关闭），所以也不弹。
      const ok = await save({ silent: true });
      window.api.reportSaveResult(reqId, { ok });
    } catch (e) {
      // 理论上到不了这里，兜底
      window.api.reportSaveResult(reqId, { ok: false, error: e?.message });
    }
  }));
}

/**
 * 打开数据文件夹
 */
async function openDataFolder() {
  const result = await window.api.openDataDir();
  if (!result.ok) {
    // audit fix：fallback 走 result.message（主进程已翻译为中文），
    // 之前用 result.error 会把英文 errno / 业务码吐给用户。
    showToast(`打开失败：${window.api.friendlyFsError(result?.code, result?.message || result?.error)}`, 'error');
  }
}

/**
 * 切换数据文件夹（侧栏底部入口）
 *
 * 复用 openSettingsDialog 已建立的：chooseDataDir IPC + 脏检查 hook + onDataDirChanged 副作用
 * 详见 [[feedback-prefer-near-affected-area]] —— 这是高频操作，贴近侧栏。
 *
 * 与设置对话框互斥：state.settingsDialogOpen 时直接拒绝，避免同时挂两个 dirty-check hook
 * 导致最后卸载的覆盖前面、丢失恢复原 hook。
 */
async function switchDataFolder() {
  if (state.settingsDialogOpen) {
    showToast('请先关闭设置对话框', 'info', 1500);
    return;
  }
  const picked = await window.api.chooseDataDir();
  if (!picked) return; // 用户取消系统目录对话框
  try {
    await withDataDirDirtyCheckHook(async () => {
      await settingsStore.update({ dataDir: picked });
      await onDataDirChanged();
    });
    showToast('已切换数据文件夹', 'success', 1500);
  } catch (e) {
    if (e?.message === 'SETTINGS_UPDATE_CANCELLED') return; // 用户主动取消「未保存改动」
    showToast(`切换数据文件夹失败：${e.message}`, 'error');
  }
}

/**
 * auto-fallback 2026-08：「回到默认」按钮 —— 把持久化的 dataDir 清空，
 * 让下次启动也走默认（与 runtime fallback 的区别：runtime fallback 只在
 * 内存里走默认，config.json 不动 —— U 盘插回下次启动还能用回去）。
 *
 * 已在默认文件夹时点这个按钮 = 无害 no-op；用 toast 明确告知，避免用户
 * 怀疑「按钮坏了吗」。如果默认目录也不可访问（极少见：home 目录被删？），
 * resetDataDir 返回失败 → 弹 error toast。
 */
async function resetDataFolder() {
  if (state.settingsDialogOpen) {
    showToast('请先关闭设置对话框', 'info', 1500);
    return;
  }
  // 已经在默认 → 无副作用告知，避免误以为按钮失灵
  const defaultDir = await window.api.getDefaultDataDir();
  const currentDir = await window.api.getDataDir();
  if (currentDir === defaultDir) {
    showToast('当前已在默认数据文件夹', 'info', 1500);
    return;
  }
  try {
    await withDataDirDirtyCheckHook(async () => {
      const result = await window.api.resetDataDir();
      if (!result.ok) {
        throw new Error(result.error || '恢复默认失败');
      }
      // settingsStore 同步清掉 dataDir 字段（reset IPC 走的是 saveConfig，
      // renderer 这边 settingsStore 内存里还残留旧值；直接 reload 一次对齐）。
      // 不 reload 的话下次再 update 别的字段时会把旧 dataDir 一起持久化回盘。
      await settingsStore.load();
      await onDataDirChanged();
    });
    showToast('已恢复到默认数据文件夹', 'success', 1800);
  } catch (e) {
    if (e?.message === 'SETTINGS_UPDATE_CANCELLED') return; // 用户主动取消「未保存改动」
    showToast(`恢复默认失败：${e.message}`, 'error');
  }
}

/**
 * auto-fallback 2026-08：数据文件夹不可用时的引导弹窗。
 * payload 来自主进程 data-dir:resolved 事件或 fs-watcher ENOENT 兜底；
 * { saved, dir, defaultDir } —— saved 是持久化的旧路径，dir 是当前 runtime 在用。
 *
 * 三选一按钮：
 *   - 恢复默认 → resetDataFolder()（持久化清空 dataDir）
 *   - 切换其他 → switchDataFolder()（弹原生 picker 让用户选）
 *   - 取消     → 什么都不做（用户可能稍后能恢复 U 盘）
 *
 * 在 modal-stack 单槽被占用时（设置对话框打开 / AI dock）改用 toast 兜底 —— 不阻塞
 * 用户当前操作，但提示去哪恢复。
 */
async function promptDataDirFallback(payload) {
  const saved = payload?.saved || '<未知>';
  const defaultDir = payload?.defaultDir || await window.api.getDefaultDataDir();
  // modal-stack 占用 → 降级到 toast
  if (typeof modalIsOpen === 'function' && modalIsOpen()) {
    showToast(`数据文件夹「${saved}」不可访问，已临时使用默认`, 'warning', 5000);
    return;
  }
  let choice;
  try {
    choice = await showConfirmDialog({
      title: '数据文件夹不可访问',
      message: `之前设置的数据文件夹无法访问：\n\n${saved}\n\n可能原因：所在磁盘已卸载 / 移动硬盘离线 / OneDrive 同步未完成 / 文件夹被删除。\n\n当前已临时使用默认文件夹 ${defaultDir}，请选择下一步。`,
      icon: 'warning',
      buttons: [
        { value: 'reset', label: '恢复默认', variant: 'primary' },
        { value: 'switch', label: '切换其他', variant: 'secondary' },
        { value: 'cancel', label: '稍后处理', variant: 'secondary' },
      ],
    });
  } catch (e) {
    console.warn('[app] promptDataDirFallback 弹窗失败:', e);
    showToast(`数据文件夹「${saved}」不可访问`, 'warning', 5000);
    return;
  }
  if (choice === 'reset') {
    resetDataFolder();
  } else if (choice === 'switch') {
    switchDataFolder();
  }
  // 'cancel' / null → 不做任何操作（保留 runtime fallback，让用户稍后自己处理）
}

/**
 * 双栏模式分割条拖动
 *
 * 支持鼠标 + 触控（平板 / 触屏一体机）。
 * 侧栏宽度优先从 CSS 变量 --w-sidebar 读取，避免与 styles.css 双重事实源。
 *
 * 写的是像素宽度（--w-editor）而不是 fr 比例 —— 这是 split + AI 模式下的关键修复：
 *   - 旧 fr 架构：editor 和 viewer 都用 fr，共享 fr_space，拖 #splitter 时两边
 *     一起变；拖 ai-splitter 时 AI 增长 px → fr_space 缩小 → editor 和 viewer
 *     都按比例缩（用户报「编辑器被挤」就是这个）。
 *   - 新 px 架构：editor 用 px (--w-editor)，viewer 用 1fr 自动填剩余。
 *     拖 #splitter → editor ±dx、AI 不动、viewer ∓dx；拖 ai-splitter →
 *     AI ±dx、viewer ∓dx、editor 完全不动（与用户直觉一致）。
 *
 * 持久化仍是 ratio（settings.splitRatio = editor.width / frSpace），保证：
 *   1. 窗口 resize 时按 saved ratio 重算 --w-editor，editor 仍跟窗口响应；
 *   2. settings schema 不动，老用户数据兼容。
 *
 * (audit round-X) AI 面板 打开关闭时 fr_space 也会变
 * （+ AI 360 + ai-splitter 4），
 * 没有 resize 事件触发但同样需要按 ratio 重算 editor / viewer 比例。
 * 见 mountSplitter 内 layoutAttrsObserver —— 与 resize 走同一道 rebalanceEditor。
 */
// 全局注册 splitter 通过 addEventListener 挂到 document / window 的所有 listener
// 由 createSplitter 工厂自管理（factory.dispose() 一次性解除 handle / document /
// window 上的所有 listener + is-dragging class）。这里只保留 3 个 factory 实例，
// pagehide 时统一 dispose —— 替代原 splitterDocumentListeners /
// splitterWindowListeners / splitterObservers 三套数组。
const splitterInstances = [];

/** 取当前侧栏宽度（px）。用户拖拽后由 --sidebar-width 控制（含 "px"），默认与 --w-sidebar 一致。 */
function getSidebarWidth() {
  if (!els.sidebar) return 0;
  const w = els.sidebar.getBoundingClientRect().width;
  return Number.isFinite(w) && w > 0 ? w : 220;
}

/**
 * AI 修改预览打开时把面板宽度重置为可用区 50%。
 *
 * 用户每次打开 AI 修改预览都默认对半分 —— 与编辑窗口的 splitRatio=0.5 同源设计：
 * 打开就是默认比例，drag 只在本次会话内有效。
 *
 * 宽度计算：容器宽度 - 侧栏 - sb-splitter(4) - ai-splitter(4) = 可用区，
 * AI 面板取其中一半，clamp 到 mountAiSplitter 的合法范围 [220, 720]。
 *
 * 与 mountAiSplitter 一致写到 :root（所有模式共用 --w-ai）。
 */
function resetAiPanelWidthToHalf() {
  if (!els.appShell) return;
  const containerW = els.appShell.getBoundingClientRect().width;
  if (!containerW) return;
  const sidebarW = getSidebarWidth();
  // 4px = sb-splitter, 4px = ai-splitter
  const fixedCols = sidebarW + 4 + 4;
  const available = Math.max(1, containerW - fixedCols);
  const half = Math.round(available * 0.5);
  const clamped = Math.max(220, Math.min(720, half));
  document.documentElement.style.setProperty('--w-ai', clamped + 'px');
}

/** editor + viewer 那段可用像素空间（fr_space）。减掉所有固定列：
 * sidebar + sb-splitter(4) + #splitter(4) + AI panel + ai-splitter(4)。
 * 这正是 split + AI 模式下拖 #splitter 报错的
 * 根因（旧实现只扣 sidebar+4，把 AI 面板宽度算成 fr 空间的一部分）。 */
function getEditorFrSpace() {
  if (!els.appShell) return 1;
  const containerWidth = els.appShell.getBoundingClientRect().width;
  if (!containerWidth) return 1;
  let fixed = getSidebarWidth();
  fixed += 4; // sb-splitter
  fixed += 4; // #splitter
  if (els.appAi && !els.appAi.hidden) {
    if (els.aiSplitter && !els.aiSplitter.hidden) {
      fixed += els.aiSplitter.getBoundingClientRect().width || 4;
    }
    fixed += els.appAi.getBoundingClientRect().width || 360;
  }
  return Math.max(1, containerWidth - fixed);
}

/**
 * editor / viewer 中间分割条
 *
 * 内部用 px 实现（--w-editor），持久化用 splitRatio (0..1)。窗口 resize /
 * AI 切换 时按 saved ratio 重新计算 editor 宽度。
 */
function mountSplitter() {
  if (!els.splitter || !els.appShell) return;
  const MIN_EDITOR_WIDTH = 280; // 与 05-sidebar.css minmax 一致
  const MIN_VIEWER_WIDTH = 200; // 阅读视图下限

  let currentEditorWidth = 0;

  function clampEditorWidth(width) {
    const frSpace = getEditorFrSpace();
    const maxW = Math.max(MIN_EDITOR_WIDTH, frSpace - MIN_VIEWER_WIDTH);
    const clamped = Math.max(MIN_EDITOR_WIDTH, Math.min(width, maxW));
    currentEditorWidth = clamped;
    return clamped;
  }

  function setEditorWidth(px) {
    els.appShell.style.setProperty('--w-editor', px + 'px');
  }

  function getEditorWidth() {
    return els.editorPane.getBoundingClientRect().width;
  }

  function getCurrentRatio() {
    const frSpace = getEditorFrSpace();
    if (frSpace <= 0) return 0.5;
    return clampSplitRatio(currentEditorWidth / frSpace);
  }

  const splitter = createSplitter({
    handle: els.splitter,
    axis: 'x',
    getSize: getEditorWidth,
    setSize: setEditorWidth,
    clampSize: clampEditorWidth,
    // 工厂拖完一次后会调 onDragEnd(clampSize(getSize())) —— 已 clamp 的 px。
    // 我们反算 ratio 持久化：settings schema 仍是 splitRatio (0..1)，内部用 px。
    // audit #1：写盘失败要让用户看到 —— 否则下次启动布局错乱无迹可循。
    onDragEnd: () => {
      const ratio = getCurrentRatio();
      settingsStore.update({ splitRatio: Number(ratio.toFixed(3)) }).catch((e) => {
        showToast(`布局比例保存失败：${e?.message || '未知错误'}`, 'error', 3500);
      });
    },
    // mount 时按 saved ratio 计算 editor 宽度（与拖动走同一道 clamp 闸）。
    // 每都从 settingsStore 重读 —— 这样切换到双栏时 onChange 写入的 0.5
    // 会被 MutationObserver 触发的 rebalance 立即拾取，避免停在旧 ratio。
    initialSize: () => getEditorFrSpace() * clampSplitRatio(settingsStore.get('splitRatio')),
  });

  // AI 面板 / 视图模式切换时 fr_space 也会变（+ AI 360 + ai-splitter 4），
  // 没有 resize 事件触发但同样需要按 ratio 重算。否则用户看到「打开 AI 后
  // 编辑器宽度没变、阅读视图被挤扁」或「关闭 AI 后阅读视图瞬间变宽」——
  // 与窗口 resize 行为不一致。
  //
  // data-editor-mode 也听一份：preview / edit / split 切换会让 grid 列数
  // 变化（mountSplitter 提前在 preview 模式下写过 --w-editor，切到 split
  // 模式需要重新按当前列数 + fr_space 重算，避免「切到 split 编辑器突然挤
  // 掉阅读视图」）。focus 模式不监听 —— editor 被隐藏、--w-editor 视觉上
  // 不生效，监听反而触发无意义的写入。
  if (typeof MutationObserver !== 'undefined' && document.body) {
    const layoutAttrsObserver = new MutationObserver(() => splitter.rebalance());
    layoutAttrsObserver.observe(document.body, {
      attributes: true,
      attributeFilter: ['data-ai-diff-open', 'data-editor-mode'],
    });
    // MutationObserver 不归工厂管 —— 把 disconnect 接进 dispose 路径。
    splitterInstances.push({
      dispose: () => {
        try { layoutAttrsObserver.disconnect(); } catch { /* ignore */ }
        splitter.dispose();
      },
    });
  } else {
    splitterInstances.push(splitter);
  }
}

/**
 * 侧栏拖拽分割条
 *
 * 区别于 editor/viewer 的 splitRatio 模型：侧栏宽度是固定像素 —— 因为侧栏
 * 总是位于窗口左侧，缩放窗口时它要么不变（不与右侧内容联动），要么让用户
 * 自己拖。持久化到 settingsStore.sidebarWidth（px），下次启动恢复。
 */
function mountSidebarSplitter() {
  if (!els.sidebarSplitter || !els.appShell) return;

  const MIN_WIDTH = 180;
  const MAX_WIDTH = 480;
  /** 扩展命中区：splitter 视觉只有 4px，但鼠标距 splitter 中线 ≤ HIT_RADIUS 时也算命中。 */
  const HIT_RADIUS = 6;

  function clampSidebarWidth(width) {
    return Math.max(MIN_WIDTH, Math.min(width, MAX_WIDTH));
  }

  function getSidebarPx() {
    return els.sidebar.getBoundingClientRect().width;
  }

  function applySidebarWidth(px) {
    els.appShell.style.setProperty('--sidebar-width', px + 'px');
  }

  function getInitialWidth() {
    const saved = settingsStore.get('sidebarWidth');
    if (Number.isFinite(saved) && saved >= MIN_WIDTH && saved <= MAX_WIDTH) {
      return saved;
    }
    // 从 CSS 变量读取当前默认宽度（考虑媒体查询已覆盖窄屏值的情况）
    const raw = getComputedStyle(document.documentElement).getPropertyValue('--sidebar-width').trim();
    const n = parseFloat(raw);
    return Number.isFinite(n) ? n : 220;
  }

  // 仅读 CSS 变量当前生效值（忽略 settingsStore 保存值），给「重置」按钮用。
  // 语义是「回到 CSS 默认」，不走持久化分支 —— 否则用户拖到 280 点重置会得到 280。
  function getDefaultSidebarWidth() {
    const raw = getComputedStyle(document.documentElement).getPropertyValue('--sidebar-width').trim();
    const n = parseFloat(raw);
    return Number.isFinite(n) ? n : 220;
  }

  // M-series fix (audit Phase M-H6)：splitter 中线缓存。
  // 每帧 mousemove 频繁调用 getBoundingClientRect 强制 layout flush + 改
  // style.cursor 触发 style recalc。改为：缓存中线，仅在 resize / scroll 时
  // 失效（失效成本远低于 mousemove 频率）。
  let cachedSplitterMidX = null;
  function getSplitterMidX() {
    if (cachedSplitterMidX == null) {
      const r = els.sidebarSplitter.getBoundingClientRect();
      cachedSplitterMidX = r.x + r.width / 2;
    }
    return cachedSplitterMidX;
  }
  function invalidateCache() {
    cachedSplitterMidX = null;
  }

  function distanceToSplitter(clientX) {
    return Math.abs(clientX - getSplitterMidX());
  }

  const splitter = createSplitter({
    handle: els.sidebarSplitter,
    axis: 'x',
    getSize: getSidebarPx,
    setSize: applySidebarWidth,
    clampSize: clampSidebarWidth,
    initialSize: getInitialWidth,
    // audit fix (Settings P2 / splitter clamp)：写入前 clamp。
    // 旧版直接 Math.round(finalW) → 若 finalW 因 flexbox shrink 短暂超出
    // [MIN_WIDTH, MAX_WIDTH]（窗口被拖到极窄 / 大字号 DPI 缩放），落盘值就
    // 越界。下次启动 getInitialWidth bounds check 会拒掉、走 CSS 默认 ——
    // 用户拖的宽度"莫名其妙丢失"。预先 clamp，保证落盘值与视觉宽度一致。
    // audit #1：持久化失败要让用户看到 —— 下次启动侧栏宽度丢失、用户不知情。
    onDragEnd: () => {
      const finalW = clampSidebarWidth(getSidebarPx());
      settingsStore.update({ sidebarWidth: Math.round(finalW) }).catch((e) => {
        showToast(`侧栏宽度保存失败：${e?.message || '未知错误'}`, 'error', 3500);
      });
    },
    hitZone: {
      radius: HIT_RADIUS,
      distanceTo: distanceToSplitter,
      // 命中区视觉反馈默认走 body.style.cursor（与原实现一致）
    },
    windowListeners: [
      // 窗口 resize / 全局滚动后，splitter 位置会变。resize 不冒泡到
      // document，必须挂 window；scroll capture 拦滚动容器触发的事件。
      // 走工厂同走一张表，dispose() 一次性解除。
      { type: 'resize', listener: invalidateCache },
      { type: 'scroll', listener: invalidateCache, options: { capture: true } },
    ],
  });

  // 侧栏恢复默认宽度按钮（hover splitter 时显形）
  // - mousedown 时拦下 + stopPropagation，避免 bubble 到 splitter 触发 drag
  //   （工厂 hit zone 用 handle.contains 排除子节点，但 capture 阶段还是会
  //   比 button 自己处理更早 fire，靠 stopPropagation 兜底）
  // - click 时把宽度写到 CSS 变量生效的默认，同时把 sidebarWidth 写回 null，
  //   让下次启动也走默认而非保存这个具体值（比写一个 px 更耐改 CSS 默认）
  if (els.btnSidebarResetWidth) {
    els.btnSidebarResetWidth.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    els.btnSidebarResetWidth.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const defaultW = getDefaultSidebarWidth();
      applySidebarWidth(clampSidebarWidth(defaultW));
      settingsStore.update({ sidebarWidth: null }).catch((err) => {
        showToast(`侧栏宽度保存失败：${err?.message || '未知错误'}`, 'error', 3500);
      });
      showToast('侧栏宽度已恢复默认', 'info', 1500);
    });
  }

  splitterInstances.push(splitter);
}

/**
 * AI 中间面板拖拽分割条
 *
 * 与 mountSidebarSplitter 走同一份像素宽度模型：拖动 dx → 直接写 --w-ai。
 * AI 面板的 grid-template 是 minmax(220px, var(--w-ai, 360px))，
 * 所以 MIN_WIDTH=220（与 CSS 一致）+ MAX_WIDTH=720（schema 上限）。
 *
 * 持久化到 settingsStore.aiWidth（px），下次启动恢复。
 *
 * 设计要点：splitter 仅在 body[data-ai-diff-open="true"] 时显示（CSS 控制），
 * 但拖拽逻辑与 splitter 是否显示无关 —— 启动后立即挂好 listener，
 * 用户首次展开 AI 面板时也能拖。
 */
function mountAiSplitter() {
  if (!els.aiSplitter || !els.appShell) return;

  const MIN_WIDTH = 220;
  const MAX_WIDTH = 720;
  const HIT_RADIUS = 6;

  function clampAiWidth(width) {
    return Math.max(MIN_WIDTH, Math.min(width, MAX_WIDTH));
  }

  function getAiPx() {
    return els.appAi ? els.appAi.getBoundingClientRect().width : 360;
  }

  function applyAiWidth(px) {
    // 写到 :root 而不是 .appShell，让所有模式（preview/edit/split/focus）共用
    document.documentElement.style.setProperty('--w-ai', px + 'px');
  }

  function getInitialWidth() {
    const saved = settingsStore.get('aiWidth');
    if (Number.isFinite(saved) && saved >= MIN_WIDTH && saved <= MAX_WIDTH) {
      return saved;
    }
    const raw = getComputedStyle(document.documentElement).getPropertyValue('--w-ai').trim();
    const n = parseFloat(raw);
    return Number.isFinite(n) ? n : 360;
  }

  /** AI 面板未打开时整个命中区禁用 —— 避免在 AI 关闭时拖出幽灵宽度 */
  function isAiAvailable() {
    return !els.aiSplitter.hidden && !(els.appAi && els.appAi.hidden);
  }

  function distanceToSplitter(clientX) {
    const r = els.aiSplitter.getBoundingClientRect();
    return Math.abs(clientX - (r.x + r.width / 2));
  }

  // 拖动起点的方向符号：AI 面板的列位置随模式变（split: AI 在 splitter 左 / 拖右 = AI
  // 变大；preview/edit + focus: AI 在 splitter 右且贴窗口右边缘 / 拖右 AI 向左扩张、
  // splitter 视觉左移 → 与鼠标反向）。每次拖动重新比较 getBoundingClientRect：
  //   splitter.x >= aiPanel.right ⇒ AI 在 splitter 左侧 ⇒ +1（鼠标右移 AI 变大）
  //   splitter.x <  aiPanel.left  ⇒ AI 在 splitter 右侧 ⇒ -1（鼠标右移 AI 变小）
  // 两边都不成立（splitter 跟 AI 重叠 / 不可见）兜底 +1，避免异常路径写出 0 宽度。
  function getDragSign() {
    if (!els.appAi || !els.aiSplitter) return 1;
    const ai = els.appAi.getBoundingClientRect();
    const sp = els.aiSplitter.getBoundingClientRect();
    if (sp.x >= ai.right - 0.5) return 1;   // AI 在 splitter 左侧
    if (sp.right <= ai.left + 0.5) return -1; // AI 在 splitter 右侧
    return 1;
  }

  const splitter = createSplitter({
    handle: els.aiSplitter,
    axis: 'x',
    getSize: getAiPx,
    setSize: applyAiWidth,
    clampSize: clampAiWidth,
    initialSize: getInitialWidth,
    getDragSign,
    // audit #1：持久化失败要让用户看到 —— 下次启动 AI 面板宽度丢失、用户不知情。
    onDragEnd: () => {
      const finalW = clampAiWidth(getAiPx());
      settingsStore.update({ aiWidth: Math.round(finalW) }).catch((e) => {
        showToast(`AI 面板宽度保存失败：${e?.message || '未知错误'}`, 'error', 3500);
      });
    },
    hitZone: {
      radius: HIT_RADIUS,
      distanceTo: distanceToSplitter,
      isAvailable: isAiAvailable,
    },
  });

  splitterInstances.push(splitter);
}

/**
 * 重置布局：恢复默认侧栏宽度（CSS 变量 --w-sidebar）+ 双栏比例 0.5 + AI 面板宽度。
 *
 * 与 mountSplitter / mountSidebarSplitter / mountAiSplitter 走同一份 CSS 自定义属性：
 *   - 侧栏：清掉 inline --sidebar-width，回落到 :root 的 --w-sidebar (220px)
 *   - 双栏：清掉 inline --w-editor，回落到 CSS 默认 50% (minmax 280px, 50%)
 *     （mountSplitter 启动时会按 splitRatio=0.5 重算 —— 不在这里硬写 0.5fr 避免与新 px 架构不一致）
 *   - AI 面板：清掉 :root 的 --w-ai，回落到 03-base.css 默认（360px）
 *
 * 持久化到 sidebarWidth=null / splitRatio=0.5 / aiWidth=null；下次启动也走默认值。
 * 失败（IPC / 校验）弹 error toast，不破坏当前显示状态。
 */
async function resetLayout() {
  try {
    await settingsStore.update({ sidebarWidth: null, splitRatio: 0.5, aiWidth: null });
  } catch (e) {
    console.error('[app] resetLayout 持久化失败:', e);
    showToast(`重置布局失败：${e.message}`, 'error');
    return;
  }
  if (els.appShell) {
    // 清掉 inline 值 → 自动落到 :root 默认（避免把 0 写进去导致侧栏消失）
    els.appShell.style.removeProperty('--sidebar-width');
    els.appShell.style.removeProperty('--w-editor');
  }
  // AI 面板宽度写在 :root（所有模式共用），这里清掉它回落到 03-base.css 默认
  document.documentElement.style.removeProperty('--w-ai');
  showToast('布局已重置', 'info', 1500);
}

/**
 * 主入口
 */
async function bootstrap() {
  // 0. 应用图标：data URL 注入是同步的，挂载点已存在 → 立刻跑。
  // 即使后续设置加载失败，左上角图标也能显示，UI 不至于看着「没起来」。
  mountAppIcon();
  // 1. 加载并应用设置
  await settingsStore.load();
  // 迁移：旧版的 'auto' 主题已不再支持，统一收敛到 'dark'，避免 UI 状态与磁盘数据不一致
  if (settingsStore.get('theme') === 'auto') {
    await settingsStore.update({ theme: 'dark' });
  }
  const initialTheme = settingsStore.get('theme');
  applyTheme(initialTheme);
  syncThemeButton(initialTheme);
  applyPalette(settingsStore.get('themePalette'));
  state.alwaysOnTop = !!settingsStore.get('alwaysOnTop');
  syncPinButton(state.alwaysOnTop);
  // 阅读排版 + 行为类偏好（排序 / 自动保存）
  applyReaderSettings();
  // 行为类偏好（排序、自动保存）已搬出设置对话框，由 sidebar-sort 工具条 / 状态栏 chip
  // 各自维护，settingsStore.change 事件统一把任意入口的改动同步到 UI 与运行时。
  // 见 [[feedback-prefer-near-affected-area]]。
  syncBehaviorPrefsUI(settingsStore.getAll());
  // M14 fix (audit)：listener 接收完整 event，让 rollback 路径能把 lastSortApplied /
  // lastAutosaveMs 三个缓存强制失效。否则 syncBehaviorPrefsUI
  // 在 settings 从乐观值回退到 before 时，「新值 vs 上次应用值」缓存比较可能错过
  // —— 比如 lastSortApplied=mtime-desc（乐观写盘时更新过），rollback 后 settings.sort=name
  // 走 if 不等会重新应用，看似 OK，但若 partial 未覆盖 sort 字段（只改了 autoSaveDebounceMs
  // 后失败），回滚前后 sort 都 = 'name'，缓存根本不会重算。rolledBack 标志强制清缓存
  // 走兜底，比猜测 partial 字段覆盖情况更稳。
  settingsStore.on('change', (event) => {
    if (event && event.rolledBack) {
      lastSortApplied = null;
      lastAutosaveMs = null;
    }
    syncBehaviorPrefsUI(event.settings);
  });
  // 聚焦模式初始可见性（持久化在 settingsStore.focusMode，默认 false）
  applyFocusMode(!!settingsStore.get('focusMode'));

  // 2. 应用持久化的视图模式（直接 setMode，不走 onChange 避免循环）
  const initialMode = settingsStore.get('editorMode')
    || window.api?.settingsSchema?.DEFAULT_SETTINGS?.editorMode
    || 'split';
  applyEditorMode(initialMode, { focus: false });

  // 2.5 阅读视图滚动监听 → 状态栏阅读进度
  // audit fix (renderer-M11)：存住 (scroller, listener) 元组，pagehide 时
  // 显式 removeEventListener，与下方 splitterInstances.dispose() 清理风格
  // 对齐。当前单实例下 listener 跟着 window 走、不显式拆也无所谓；但
  // viewer/splitter 都已统一 dispose 路径，留这一根不拆是清理不对称。
  const viewerScroller = els.markdownBody && els.markdownBody.parentElement;
  const viewerScrollListener = updateStatusScroll;
  if (viewerScroller) {
    viewerScroller.addEventListener('scroll', viewerScrollListener, { passive: true });
  }

  // 3. 绑定静态事件
  if (els.linkOpenFolder) {
    els.linkOpenFolder.addEventListener('click', () => {
      openDataFolder();
    });
  }
  if (els.linkSwitchFolder) {
    els.linkSwitchFolder.addEventListener('click', () => {
      switchDataFolder();
    });
  }
  if (els.btnResetFolder) {
    els.btnResetFolder.addEventListener('click', () => {
      resetDataFolder();
    });
  }
  if (els.btnNewFile) {
    els.btnNewFile.addEventListener('click', () => {
      fileOps.createNewFile();
    });
  }

  // Stage 8：面包屑的「回到根」按钮。已经在根时按钮被 hidden，不会被点到，
  // 这里不重复判断（点一下也就是 no-op）。
  if (els.btnBreadcrumbRoot) {
    els.btnBreadcrumbRoot.addEventListener('click', () => {
      goToRoot();
    });
  }

  // 3.5 行为偏好入口：sidebar-sort 工具条 + 顶部工具栏自动保存按钮
  // 见 [[feedback-prefer-near-affected-area]]
  const setFileListSort = (mode) => {
    if (settingsStore.get('fileListSort') === mode) return;
    settingsStore.update({ fileListSort: mode }).catch((e) => {
      showToast(`排序切换失败：${e.message}`, 'error');
    });
  };
  // audit fix (CQ-MED-9)：按钮 → 排序值的映射从 schema 派生，不再硬编码 'name'/'mtime-desc'。
  // 顺序与 SETTINGS_UI_OPTIONS.fileListSort 一致；增删排序方式时只需改 schema。
  els.btnSortName?.addEventListener('click', () => setFileListSort(FILE_LIST_SORT_VALUES[0] || 'name'));
  els.btnSortMtime?.addEventListener('click', () => setFileListSort(FILE_LIST_SORT_VALUES[1] || 'mtime-desc'));
  if (els.toolbarAutosave) {
    // 二态切换：点击在「关 (0)」和「开（恢复上次非零值）」之间翻转。
    // audit fix (renderer-M5)：之前固定 500ms，会把用户在设置里调过的
    // 自定义值（如 1500ms）吞掉。关掉时把当前非零值缓存到 lastNonZeroAutoSaveMs；
    // 开启时优先用缓存值，schema 默认 500 只在「从未开过」时兜底。
    // bootstrap 时把当前持久化值同步进缓存（避免「开机时是 1500ms，点关
    // 后点开变成 500ms」的二次踩坑）。
    const initialMs = currentAutoSaveDebounceMs();
    if (initialMs !== 0) lastNonZeroAutoSaveMs = initialMs;
    els.toolbarAutosave.addEventListener('click', () => {
      const current = currentAutoSaveDebounceMs();
      const next = current === 0 ? lastNonZeroAutoSaveMs : 0;
      // 关之前先把当前非零值落进缓存 —— 下次开才能恢复。
      if (current !== 0) lastNonZeroAutoSaveMs = current;
      settingsStore.update({ autoSaveDebounceMs: next }).then(() => {
        showToast(next === 0 ? '自动保存已关闭' : `自动保存：开启（停打后 ${next}ms 保存）`, 'info', 1500);
      }).catch((err) => {
        showToast(`自动保存切换失败：${err.message}`, 'error');
      });
    });
  }

  // 4. 订阅 IPC
  subscribeIpc();

  // 5. 装载分割条
  mountSplitter();
  mountSidebarSplitter();
  mountAiSplitter();

  // 5.5 heading 联动：把当前 heading 同步到状态栏面包屑
  watchViewerHeading();

  // 5.6 AI 修改：侧栏底部按钮 + 控制器初始化 + 面板挂载
  // ai 需要 settingsStore.getAll()，所以必须在 settings 加载完（步骤 1）之后才创建。
  mountAiPanel();

  // 6. 加载文件列表
  await loadFileList();

  // 7. 装载右键菜单（阅读视图 + 编辑器）
  mountViewerContextMenu();
  mountEditorContextMenu();

  // 8. 加载全局快捷键
  disposeShortcuts = mountKeyboardShortcuts({
    onFocusSearch: () => els.searchInput?.focus(),
    onClearSearch: () => {
      if (els.searchInput && document.activeElement === els.searchInput) {
        els.searchInput.value = '';
        els.searchInput.dispatchEvent(new Event('input'));
      }
    },
    onSettings: () => openSettingsDialog(),
    onToggleTheme: () => cycleTheme(),
    onSave: () => {
      // audit fix (Round 3 bug 2026-08)：IME 期间按 Ctrl+S —— state.isDirty stale
      // 会让键盘快捷键直接 return，editor.doc 里有未保存的 IME 字符不落盘。
      // save() 入口本身也有同步，但这个 handler 在 save() 之前就 return 了，
      // 必须在这里也同步一次。
      syncDirtyFromEditor();
      // audit fix #1：去掉 `editorMode !== 'preview'` 短路 —— AI 在 preview 模式下
      // 改 doc 也会标脏（applyUserChange 绕过 EditorView.editable），save() 内部会
      // 判断 isDirty + 切到 edit 模式落盘。这里只检查 isDirty 即可。
      if (state.isDirty) save();
    },
    onToggleEditorMode: () => editorToolbar.cycle(),
    onToggleFocusMode: () => setFocusMode(),
    onNewFile: () => fileOps.createNewFile(),
    onToggleAi: () => {
      if (!ai) return;
      // 统一走模块级 syncAiButton（与点击路径同款）—— 它会同步
      // aria-pressed / aria-label / title 三个属性。原 handler 只写
      // aria-pressed + title，aria-label 留给 MutationObserver 兜底更新，
      // 读屏用户能感知到中间 ~毫秒级空窗。这次改用同一入口，行为对齐。
      syncAiButton(ai.togglePanel());
    },
    // audit K1-H3：Ctrl+R 之前只在 README / 主菜单存在，渲染端快捷键缺失
    // 导致「文档承诺了快捷键但按了无效」。补全：location.reload 让 BrowserWindow
    // 重载 renderer，与主菜单的 webContents.reload 行为一致。
    //
    // Phase 2 audit 修复 (P1 #2)：Ctrl+R 之前直接 reload()，dirty 状态下
    // location.reload 不会触发 main.js BrowserWindow 'close' 事件 →
    // confirmDiscardIfDirty 不弹 → 内存里的新字符随 renderer 重载而丢失。
    // 修复：有 dirty 时弹与 Ctrl+W/关闭按钮同源的「保存 / 放弃 / 取消」对话
    // 框；选「取消」就 abort reload，选「保存」或「放弃」后再 reload。
    onReload: async () => {
      // audit fix (Round 3 bug 2026-08)：IME 期间 Ctrl+R —— state.isDirty stale
      // 会让 reload 不弹「未保存改动」对话框，IME 字符随 renderer 重载丢失。
      syncDirtyFromEditor();
      if (state.isDirty && state.currentFile && state.currentFile.path) {
        const choice = await showConfirmDialog({
          title: '未保存的改动',
          message: `当前文件「${state.currentFile.name}」有未保存的改动。\n\n重载窗口之前请选择如何处理。`,
          icon: 'warning',
          buttons: [
            { value: 'cancel', label: '取消', variant: 'primary' },
            { value: 'discard', label: '放弃改动', variant: 'danger' },
            { value: 'save', label: '保存', variant: 'primary' },
          ],
        });
        if (choice === 'cancel' || choice == null) return;
        if (choice === 'save') {
          const ok = await save({ silent: true });
          if (!ok) return; // 保存失败让用户自己决定是否再试
        } else {
          // 'discard' 路径：复位 dirty + 同步 editor 基线（与 openFile discard
          // 分支同源，见 openFile 注释块「audit fix (K2-H1)」）
          cancelScheduledAutoSave();
          state.isDirty = false;
          state.lastSavedMtimeMs = null;
          editor.markSaved();
          syncSaveButton();
        }
      }
      window.location.reload();
    },
    // 关闭当前打开的文件：与工具栏 onCloseFile 共用同一个 closeCurrentFile()。
    // closeCurrentFile() 内部已经处理「未保存改动」三选一对话框 + 同步 dirty；
    // 无文件时该函数内部直接 return，不会弹空对话框。
    onCloseFile: () => closeCurrentFile(),
  });

  // 注意：原 beforeunload 监听已删除（P2-11）。
  //   主进程 main.js 在 BrowserWindow 'close' 事件里就拦下来了，
  //   走 confirmDiscardIfDirty 弹自定义确认框；Electron 主进程拦截下
  //   renderer 的 beforeunload 永不生效，留着只是误导后来人。

  // pagehide 兜底：renderer 卸载时把 AI MutationObserver 显式 disconnect，
  // 避免 listener 长期持有 aiChatDock + syncAiButton 闭包。
  // 同时解绑三个 splitter 注册的 document 级 listener（mousemove/touchmove/
  // mouseup/touchend/touchcancel 各 5 个，共 15 个），释放 dragging/pointerId/
  // applyWidths 闭包。单进程单 renderer 下影响极小，但更正确。
  //
  // audit #C1 fix (memory leak critical)：原 pagehide 只拆 2 类 listener，遗漏：
  //   - ai.destroy()（chat panel 7 个 listener + AbortController）
  //   - viewer / editor / fileList / editorToolbar 的 dispose()
  //   - scrollFrame (rAF)、livePreviewTimer / autoSaveTimeout / statsDebounceTimer
  // 现在统一遍历拆分，规避「飞行中的 timer / rAF 回调访问已 dispose 的对象」。
  window.addEventListener('pagehide', () => {
    if (aiObserver) { aiObserver.disconnect(); aiObserver = null; }
    // splitter：每个 factory 实例 self-contains handle / document / window
    // listener；layoutAttrsObserver 由 mountSplitter 把 disconnect 接进 dispose。
    // 统一 dispose() 释放闭包（替代原 splitterDocumentListeners /
    // splitterWindowListeners / splitterObservers 三套数组）。
    for (const inst of splitterInstances) {
      try { inst.dispose(); } catch { /* ignore */ }
    }
    splitterInstances.length = 0;
    // audit fix (Phase 6 H1)：window.api.on* 的 unsubscribe 集中释放。
    // 否则 Ctrl+R 重载 N 次 → 主进程每发一次 menu:toggle-theme 触发 N 次
    // cycleTheme、menu:settings 打开 N 个 dialog 堆栈。
    for (const unsub of ipcUnsubscribes) {
      if (typeof unsub === 'function') {
        try { unsub(); } catch (e) { console.warn('[app] ipc unsubscribe failed:', e); }
      }
    }
    ipcUnsubscribes.length = 0;
    // audit fix (Phase 6 H2)：全局快捷键的 document keydown listener —— 与
    // ipcUnsubscribes 同源对称：mount 时 capture，pagehide 时统一拆。
    if (typeof disposeShortcuts === 'function') {
      try { disposeShortcuts(); } catch (e) { console.warn('[app] disposeShortcuts failed:', e); }
      disposeShortcuts = null;
    }
    // AI 控制器：chat panel 7 个 listener + AbortController + recomputeTimer
    if (typeof ai !== 'undefined' && ai && typeof ai.destroy === 'function') {
      try { ai.destroy(); } catch (e) { console.warn('[app] ai.destroy failed:', e); }
    }
    // 文件列表 / 阅读视图 / 编辑器：各自 .dispose() 解绑 signal 上挂的 listener
    if (fileList && typeof fileList.dispose === 'function') {
      try { fileList.dispose(); } catch (e) { console.warn('[app] fileList.dispose failed:', e); }
    }
    if (viewer && typeof viewer.dispose === 'function') {
      try { viewer.dispose(); } catch (e) { console.warn('[app] viewer.dispose failed:', e); }
    }
    if (editor && typeof editor.dispose === 'function') {
      try { editor.dispose(); } catch (e) { console.warn('[app] editor.dispose failed:', e); }
    }
    // 关闭任何挂起中的 rAF / debounce timer —— 它们若在 pagehide 之后 fire，
    // 会去访问已销毁的组件，抛错进 console；清理路径上每一处都做。
    if (typeof scrollFrame !== 'undefined' && scrollFrame) {
      cancelAnimationFrame(scrollFrame);
      scrollFrame = null;
    }
    if (typeof editorFocusFrame !== 'undefined' && editorFocusFrame) {
      cancelAnimationFrame(editorFocusFrame);
      editorFocusFrame = null;
    }
    if (typeof livePreviewTimer !== 'undefined' && livePreviewTimer) {
      clearTimeout(livePreviewTimer);
      livePreviewTimer = null;
    }
    if (typeof autoSaveTimeout !== 'undefined' && autoSaveTimeout) {
      clearTimeout(autoSaveTimeout);
      autoSaveTimeout = null;
    }
    if (typeof statsDebounceTimer !== 'undefined' && statsDebounceTimer) {
      clearTimeout(statsDebounceTimer);
      statsDebounceTimer = null;
    }
    // audit fix (renderer-M11)：阅读视图滚动 listener —— 与上方注册时
    // 一致的元组 (scroller, listener) + options，对称地 remove。
    if (viewerScroller && viewerScrollListener) {
      try { viewerScroller.removeEventListener('scroll', viewerScrollListener); }
      catch (e) { console.warn('[app] viewer scroll remove failed:', e); }
    }
  }, { once: true });

  console.debug('[app] 启动完成');
}

bootstrap().catch(err => {
  console.error('[app] bootstrap 失败:', err);
  // audit fix (3.4)：原 boot-error 兜底只在 window.api 缺失时生效，
  // IPC 抛错 / settings 加载失败 等会让 renderer 卡空白。这里把错误显示到
  // boot-error 元素 + 兜底 toast，让用户至少能看到原因。
  const bootEl = document.getElementById('boot-error');
  if (bootEl) {
    bootEl.removeAttribute('hidden');
    const msg = bootEl.querySelector('p.boot-error-detail');
    if (msg) msg.textContent = `错误详情：${err.message}`;
  }
  showToast(`启动失败：${err.message}`, 'error', 0);
});
