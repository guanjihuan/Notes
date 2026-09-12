// 安全的 IPC 桥
// 通过 contextBridge 暴露最小化的 API 给渲染进程
//
// marked 和 DOMPurify 是从主进程 require 进来再暴露给渲染端使用。
// 这是因为 Electron 渲染进程在 contextIsolation 下无法直接用 `import 'marked'`
// 这种 bare specifier（需要打包工具 + import map），而我们坚持零打包。
//
// 关于 DOMPurify 初始化：
//   DOMPurify 需要一个 window/document 才能工作。Preload 脚本运行在隔离的
//   JS context 中（contextIsolation），但同一进程里的 window 对象已经存在。
//   我们在 preload 中用 `createDOMPurify(window)` 初始化，它返回的实例可以
//   把 sanitize 后的 HTML 字符串通过 contextBridge 暴露给渲染端 ——
//   返回的是字符串而非 DOM 节点，跨 contextBridge 没问题。
//
// IPC 通道配对由 scripts/check-ipc.js 自动审计（`npm run check`）。
// 新增 API 前先在 main.js 写好 ipcMain.handle / ipcMain.on / webContents.send，
// 再回到 preload 加 wrapper；脚本会校验通道双向配对。

const { contextBridge, ipcRenderer, nativeImage } = require('electron');
const { marked } = require('marked');
const nodePath = require('path');
const nodeFs = require('fs');

// 把 icon.ico 在 preload 启动时一次性转成 PNG data URL，渲染端作为 <img src> 用。
// nativeImage 直接读 .ico 会拿到 Windows 编码，<img> 不一定能渲染；toDataURL()
// 输出标准 PNG data URL，浏览器 100% 兼容。文件路径在 build.files 里已经包含，
// 打包后路径仍指向资源目录。读不到 → 返回 null，渲染端继续走 .app-title::before 占位。
let APP_ICON_DATA_URL = null;
try {
  const iconPath = nodePath.join(__dirname, 'icon.ico');
  if (nodeFs.existsSync(iconPath)) {
    const img = nativeImage.createFromPath(iconPath);
    if (img && !img.isEmpty()) {
      APP_ICON_DATA_URL = img.toDataURL();
    }
  }
} catch {
  // nativeImage 在某些 headless 测试 / 非 Electron 上下文里会失败；吞掉走 null 路径
}
const createDOMPurify = require('dompurify');
// 设置 schema（单一事实源）。preload 是 CJS，可以直接 require。
//
// renderer 不能自己 import 这个文件 —— 它是 CommonJS（module.exports），而
// renderer 跑在 Chromium 里（nodeIntegration:false），浏览器原生 ESM 没有任何
// CommonJS 互操作：改扩展名（.cjs → .js）只能让 ESM loader 不因 MIME 拒绝它，
// 模块本身依然一个具名导出都没有，import 会在链接阶段直接抛
// "does not provide an export named 'DEFAULT_SETTINGS'" 并让整个应用起不来。
// 所以 schema 必须和其他主进程能力一样，经 contextBridge 过桥。
const settingsSchema = require('./shared/settings-schema.js');
// Markdown → 安全 HTML 的核心规则（ALLOWED_URI_REGEXP + 钩子）。与 tests 共用同一份，
// 防止规则在「实现」与「测试」之间漂移。
const { ALLOWED_URI_REGEXP, installHooks } = require('./shared/render-sanitize.js');
// 文件扩展名白名单（EDITABLE_EXTS / MARKDOWN_EXTS）—— main + renderer 共用一份，
// 防止「侧栏显示可编辑但 md 链接打不开」或反之的体验割裂。renderer 经 contextBridge
// 拿数组（contextBridge 结构化克隆对 Set/Map 的支持视 Electron 版本而定，数组
// 是 100% 可靠的形态，渲染端直接 Array.includes 即可）。
const { EDITABLE_EXTS, MARKDOWN_EXTS } = require('./shared/extension-lists.js');
const EDITABLE_EXTS_LIST = Array.from(EDITABLE_EXTS);
const MARKDOWN_EXTS_LIST = Array.from(MARKDOWN_EXTS);
// Heading slug 算法（preload + 锚点滚动共用同一份，否则点击文内锚点会定位失败）。
// 实现见 shared/slug.js；renderer 端通过 window.api.slugifyHeadingBase 调用同一份，
// 不再源码级镜像，避免两边正则漂移（audit fix 3.1）。
const { slugifyHeading: sharedSlugify, slugifyHeadingBase: sharedSlugifyBase } = require('./shared/slug.js');
// AI 修改用的行级 + 词级 diff 算法。renderer 是 ESM + Chromium 原生，不能
// 直接 require CJS，所以经 contextBridge 暴露成纯函数（返回纯对象，结构化克隆 OK）。
const markdownDiff = require('./shared/markdown-diff.js');
// AI 错误码字面量（main / renderer 共享）—— renderer 是 ESM 不能直接 require CJS，
// 所以经 contextBridge 把整个 AI_ERROR 对象暴露到 window.api.aiErrors，
// renderer 在 src/ai/ai-status.js 顶层直接 window.api?.aiErrors?.AI_ERROR 取值。
const { AI_ERROR: sharedAiErrors } = require('./shared/ai-errors.js');
// errno → 中文提示（main + renderer 共享）—— 同一理由经 contextBridge 过桥，
// 详见 shared/friendly-fs-error.js 注释。renderer 在 src/app.js / src/file-ops.js
// 顶层取 window.api.friendlyFsError 调用，不再各自维护 mapping（避免 EROFS /
// ENAMETOOLONG / ENOTDIR / ENOTEMPTY 三处文案漂移）。
const { friendlyFsError: sharedFriendlyFsError } = require('./shared/friendly-fs-error.js');

// 兜底 beforeunload 清理：单条 IPC 通道一个 helper，pagehide 未跑时再拆 listener。
//
// 【必须在模块顶层定义，不能放成 contextBridge 对象的方法】
// contextBridge 暴露的 on* wrapper 都是箭头函数，箭头函数没有自己的 this，
// 它们的 this 来自词法作用域 = 模块顶层（Node CJS 里是 module.exports，
// 不是 contextBridge 的 API 对象）。如果 cleanupOn 是 API 对象的方法，
// 下面的 onXxx 调 this.cleanupOn(...) 会拿不到函数，渲染端 bootstrap 在
// 第一个 subscribeIpc 调用就会抛「this.cleanupOn is not a function」直接挂掉。
// 抽到模块顶层用普通函数声明，下面 on* 直接 cleanupOn(...) 调用。
//
// renderer 端 subscribeIpc 仍然有 pagehide 主清理路径，这里只是 pagehide
// 顺序漂移时的兜底。
function cleanupOn(channel, handler) {
  const beforeUnload = () => {
    try { ipcRenderer.removeListener(channel, handler); } catch { /* ignore */ }
    try { window.removeEventListener('beforeunload', beforeUnload); } catch { /* ignore */ }
  };
  try { window.addEventListener('beforeunload', beforeUnload, { once: true }); } catch { /* ignore */ }
  return () => {
    try { ipcRenderer.removeListener(channel, handler); } catch { /* ignore */ }
    try { window.removeEventListener('beforeunload', beforeUnload); } catch { /* ignore */ }
  };
}

// 配置 marked —— 在 preload 一次性完成
const mdRenderer = new marked.Renderer();
const baseLink = mdRenderer.link.bind(mdRenderer);
mdRenderer.link = (href, title, text) => {
  const html = baseLink(href, title, text);
  return html.replace(/^<a /, '<a target="_blank" rel="noopener noreferrer" ');
};

// 标题 id：marked 从 v9 起移除了内置 slugger，不再输出 id，
// 导致文内锚点（[跳转](#标题)）和目录全部失效。这里自己补回来。
// 每次 parse 前 headingSlugs 会被清空，保证同名标题的 -1/-2 后缀按文档重新计数。
//
// 算法实现见 shared/slug.js —— src/outline.js 用同一份规则的源码级镜像，
// 否则 heading id 在各调用方之间会对不上，文内锚点点击无法定位。
const headingSlugs = new Set();
mdRenderer.heading = (text, level, raw) =>
  `<h${level} id="${sharedSlugify(raw, headingSlugs)}">${text}</h${level}>\n`;

marked.setOptions({
  gfm: true,
  breaks: false,
  renderer: mdRenderer,
});

// 拿到工厂函数（兼容 ESM/CJS 互操作差异）
const DOMPurifyFactory = (typeof createDOMPurify === 'function')
  ? createDOMPurify
  : (createDOMPurify && typeof createDOMPurify.default === 'function')
    ? createDOMPurify.default
    : null;

// DOMPurify 实例（绑定到 preload 的 window）
let DOMPurifyInstance = null;
if (DOMPurifyFactory && typeof window !== 'undefined') {
  try {
    DOMPurifyInstance = DOMPurifyFactory(window);
  } catch (e) {
    console.error('[preload] DOMPurify 初始化失败:', e);
  }
} else if (!DOMPurifyFactory) {
  console.error('[preload] createDOMPurify 不可用');
}

if (!DOMPurifyInstance) {
  console.warn('[preload] DOMPurify 未初始化；renderMarkdown 将跳过 XSS 清洗');
}

// 允许的 URI 协议与 DOMPurify 钩子见 shared/render-sanitize.js。
// 顶部 require 已引入 ALLOWED_URI_REGEXP 与 installHooks；钩子在拿到 DOMPurify
// 实例后立即注册。
installHooks(DOMPurifyInstance);

contextBridge.exposeInMainWorld('api', {
  /**
   * 设置 schema —— 纯数据，供 renderer 同步读取。
   *
   * preload 在 renderer 模块求值之前就跑完了，所以 settings-store.js /
   * settings-dialog.js 可以在模块顶层直接取 window.api.settingsSchema。
   * contextBridge 会做结构化克隆，renderer 拿到的是只读副本。
   */
  settingsSchema: {
    DEFAULT_SETTINGS: settingsSchema.DEFAULT_SETTINGS,
    SETTINGS_UI_OPTIONS: settingsSchema.SETTINGS_UI_OPTIONS,
  },

  /**
   * AI 错误码表 —— 与 main/ai.js 同一份字面量（shared/ai-errors.js），
   * 经 contextBridge 过桥后 renderer 端不会与主进程漂移。纯数据对象。
   */
  aiErrors: {
    AI_ERROR: sharedAiErrors,
  },

  /**
   * errno → 中文提示（Round 4 收尾：合并三处独立 mapping）。
   * 与 main/file-ops.js#friendlyWriteError 同一份事实源（shared/friendly-fs-error.js），
   * renderer 端友好提示文案不再与主进程漂移。
   *
   * @param {string|null|undefined} code - errno 或业务码
   * @param {string|undefined} fallback - 未知 code 时的回退文案
   * @returns {string}
   */
  friendlyFsError: (code, fallback) => sharedFriendlyFsError(code, fallback),

  /**
   * 用 schema 把任意对象归一成完整 settings（补默认值 + 丢未知键）。
   * @param {*} raw
   * @returns {Record<string, *>}
   */
  coerceLoadedSettings: (raw) => settingsSchema.coerceLoadedSettings(raw),

  /**
   * Markdown → 安全 HTML
   * @param {string} markdown
   * @returns {string}
   */
  renderMarkdown: (markdown) => {
    if (typeof markdown !== 'string' || !markdown) return '';
    try {
      // 同名标题的去重后缀按文档计数，每次 parse 前重置
      headingSlugs.clear();
      const rawHtml = marked.parse(markdown);
      // 【fail-closed】DOMPurify 不可用 → 返回转义后的纯文本，绝不返回未清洗 HTML
      //   否则 attacker 写入 "<img src=x onerror=window.api.writeFile(...)>" 就能
      //   借 viewer.innerHTML 拿到 privileged API 调用权（preload 通过 contextBridge
      //   暴露的 api 在 renderer 同源策略下被认为是同源可执行）。
      if (!DOMPurifyInstance) {
        const escaped = String(rawHtml)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;');
        return `<pre class="md-purify-fallback">${escaped}</pre>`;
      }
      return DOMPurifyInstance.sanitize(rawHtml, {
        ADD_ATTR: ['target', 'rel', 'id'],
        ALLOWED_URI_REGEXP,
        // uponSanitizeAttribute 钩子在文件顶部通过 addHook 全局注册
        // （v3 不再支持 sanitize 配置传 hook），按 tag 白名单收口。
        // audit fix (Round 13 / Sec-M)：
        //   - 拒绝 <svg> / <math> / <template> / <form> / <input> / <button> /
        //     <select> / <textarea> —— DOMPurify 默认已经剥掉大部分，但 SVG-namespaced
        //     <style> 在 HTML 默认名单下会漏掉（default 的 FORBID_CONTENTS 只覆盖
        //     HTML <style>）。显式列出作为防御深度。
        //   - 注意：未加 FORBID_ATTR: ['style'] —— 项目里 markdown 允许合法 inline
        //     style（color / font-size / background:url(https://...) 等），由
        //     isDangerousStyleValue（render-sanitize.js 顶部）在 uponSanitizeAttribute
        //     钩子里按 CSS 属性名 / 危险值做 denylist 拦截。
        FORBID_TAGS: ['svg', 'math', 'template', 'form', 'input', 'button', 'select', 'textarea'],
      });
    } catch (e) {
      console.error('[preload] renderMarkdown 失败:', e);
      return '';
    }
  },

  // 文件操作（只读 + 写入 + 文件管理）
  listFiles: () => ipcRenderer.invoke('file:list'),
  // Folder Browser（Stage 8）：扫一个相对目录的一层条目（含文件夹 + 文件 + binary）。
  // relDir 是 dataRoot 下的 POSIX 相对路径（如 'notes/2026'），空串代表根。
  // 返回 { ok, dir, relDir, entries } 或 { ok:false, error, message? }。
  scanDir: (relDir) => ipcRenderer.invoke('file:scan-dir', relDir || ''),
  // 切换 fs-watcher 监听目标到指定子目录。渲染端进入子目录时调用，
  // 之后 fs-watcher 推送的 files:changed 事件 payload 会带 relDir，
  // 渲染端按 relDir 判断是否重扫。
  watchDir: (relDir) => ipcRenderer.invoke('file:watch-dir', relDir || ''),
  readFile: (filePath) => ipcRenderer.invoke('file:read', filePath),
  // 第三个参数 expectedMtimeMs 是可选的 mtime 校验（audit #2）；
  // 传入后主进程会比对磁盘当前 mtime，不一致则拒绝写入并返回 FILE_CHANGED_EXTERNALLY。
  // 不传则跳过校验（强写场景 / 老调用兼容）。
  writeFile: (filePath, content, expectedMtimeMs = null) =>
    ipcRenderer.invoke('file:write', filePath, content, expectedMtimeMs),
  // createFile 新签名（Folder Browser / Stage 8）：
  //   createFile(name, { dir?: 绝对路径, initialContent?: string })
  //   dir 不传 → dataRoot；initialContent 不传 → 主进程默认生成 `# 标题\n\n`。
  // 向后兼容：第二参仍是字符串时当作 initialContent，dir 走根。
  createFile: (name, opts) => {
    if (typeof opts === 'string') {
      return ipcRenderer.invoke('file:create', name, opts);
    }
    return ipcRenderer.invoke('file:create', name, opts || {});
  },
  renameFile: (oldPath, newName) => ipcRenderer.invoke('file:rename', oldPath, newName),
  deleteFile: (filePath) => ipcRenderer.invoke('file:delete', filePath),
  openDataDir: () => ipcRenderer.invoke('app:open-data-dir'),
  // 打开任意路径（不修改设置）—— 设置对话框的"打开预览"按钮使用
  openPath: (target) => ipcRenderer.invoke('app:open-path', target),
  // 打开 config.json 所在目录（设置对话框 AI 段）。不接参数：完整路径不过 IPC
  // （隐私），renderer 也无法传任意路径（安全）。见 main.js app:open-config-dir。
  openConfigDir: () => ipcRenderer.invoke('app:open-config-dir'),

  // 链接点击：在系统默认浏览器中打开
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),

  // 在系统文件管理器中显示文件（macOS = Reveal，Win/Linux = 选中文件）
  showItemInFolder: (filePath) => ipcRenderer.invoke('shell:show-item-in-folder', filePath),

  // 在系统文件管理器中打开数据目录下的任意目录（用于状态栏路径 chip 在
  // 「没打开文件」时的点击行为）。安全：主进程强制 isWithinDataDir 边界检查。
  openDir: (dirPath) => ipcRenderer.invoke('shell:open-dir', dirPath),

  // 应用信息
  getDataDir: () => ipcRenderer.invoke('app:get-data-dir'),
  getDefaultDataDir: () => ipcRenderer.invoke('app:get-default-data-dir'),
  // auto-fallback 2026-08：「回到默认」按钮的 IPC —— saveConfig({ dataDir: '' })
  // 持久化清空 + 重启 fsWatcher + 刷新托盘菜单，返回 { ok, dir, defaultDir }。
  resetDataDir: () => ipcRenderer.invoke('app:reset-data-dir'),
  getVersion: () => ipcRenderer.invoke('app:get-version'),

  // 设置
  getSettings: () => ipcRenderer.invoke('app:get-settings'),
  saveSettings: (partial) => ipcRenderer.invoke('app:save-settings', partial),
  // P1-1 fix (audit)：仅 settings 对话框回显用 —— 返回完整 AI API Key。
  // 不入 renderer 常驻缓存；调用方应在用完后立即从 DOM 清掉。
  // Q7/Q9 fix (audit)：reveal 必须先 arm —— settings-dialog 在用户点
  // 「显示 Key」按钮后先调 armRevealAiKey()，5 秒内调 revealAiKey() 才生效。
  armRevealAiKey: () => ipcRenderer.invoke('app:arm-reveal-ai-key'),
  revealAiKey: () => ipcRenderer.invoke('app:reveal-ai-key'),
  // 返回 config.json 真实路径 + 所在目录。设置对话框"数据存在哪"提示用。
  getConfigPath: () => ipcRenderer.invoke('app:get-config-path'),
  chooseDataDir: () => ipcRenderer.invoke('app:choose-data-dir'),

  // 事件监听（来自主进程）
  //
  // audit fix：renderer 在 `subscribeIpc()` 里把所有 onXxx 返回的 unsubscribe
  // 收集到 ipcUnsubscribes，并在 pagehide 时统一拆。
  // 但 pagehide vs beforeunload 顺序在不同 Chromium / Electron 版本下游移，
  // 极端情况下（旧 Electron / Ctrl+Shift+R 强制 reload）pagehide 不触发，
  // 主进程的 ipcRenderer.on 仍持有旧 callback。下次 reload 时 preload 重新
  // 求值又注册一份新 callback → 同一条事件触发多次（菜单被点 N 次开 N 个
  // dialog、theme 被翻 N 次、save-request 被处理 N 次）。
  // 这里把 cleanup 函数再额外挂到 window 的 beforeunload 上做兜底：
  //   - 正常路径：renderer 自己的 pagehide 先跑，unsubscribe 被消费
  //   - 兜底路径：pagehide 没跑 → beforeunload 触发，主进程侧 listener 被清
  // 每个 on* 单独挂 listener + beforeunload（共享 cleanupOn helper，见顶部）。

  onMenuCommand: (callback) => {
    // menu 事件是「无 payload 只有 channel 名」语义
    const events = ['menu:toggle-theme', 'menu:settings'];
    const handlers = events.map(name => {
      const handler = () => callback(name);
      ipcRenderer.on(name, handler);
      return { name, handler, cleanup: cleanupOn(name, handler) };
    });
    return () => handlers.forEach(({ cleanup }) => cleanup());
  },

  onFilesChanged: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('files:changed', handler);
    return cleanupOn('files:changed', handler);
  },

  onAlwaysOnTopChanged: (callback) => {
    const handler = (_event, enabled) => callback(enabled);
    ipcRenderer.on('always-on-top:changed', handler);
    return cleanupOn('always-on-top:changed', handler);
  },

  onMaximizeStateChanged: (callback) => {
    const handler = (_event, isMaximized) => callback(isMaximized);
    ipcRenderer.on('window:maximize-state', handler);
    return cleanupOn('window:maximize-state', handler);
  },

  // auto-fallback 2026-08：启动时主进程广播一次 data-dir:resolved。
  // payload: { dir, defaultDir, fellBack, saved }
  //   fellBack=true 表示 custom 路径不可用、临时回退到默认；
  //   renderer 在 fellBack=true 时弹引导弹窗（恢复默认 / 切换 / 取消），
  //   false 时只拿 defaultDir 做 UI 文案，不弹任何东西。
  onDataDirResolved: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('data-dir:resolved', handler);
    return cleanupOn('data-dir:resolved', handler);
  },

  // 通知主进程当前是否有未保存改动（用于关闭时弹保存确认）
  setDirty: (isDirty) => ipcRenderer.invoke('renderer:set-dirty', !!isDirty),

  // 主进程请求立即保存（关闭窗口时触发）
  onSaveRequest: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('renderer:save-request', handler);
    return cleanupOn('renderer:save-request', handler);
  },
  reportSaveResult: (reqId, result) => {
    ipcRenderer.send(`renderer:save-result:${reqId}`, result);
  },

  // 窗口控制
  setAlwaysOnTop: (enabled) => ipcRenderer.invoke('window:set-always-on-top', enabled),
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  toggleMaximizeWindow: () => ipcRenderer.invoke('window:toggle-maximize'),
  closeWindow: () => ipcRenderer.invoke('window:close'),

  // AI 修改（OpenAI 兼容 /chat/completions；配置由用户在设置中填写）
  // 返回结构：
  //   { ok:true, id, content, responseFormat:'json'|'raw' }  成功
  //   { ok:false, error, message }                           失败（error 是稳定错误码）
  aiEdit: (payload) => ipcRenderer.invoke('ai:edit', payload),
  // 取消进行中的 AI 请求：requestId 由 aiEdit 的成功路径或发送方自己维护
  aiCancel: (requestId) => ipcRenderer.send('ai:cancel', requestId),

  // AI diff 算法（行级 + 词级；renderer 不能直接 require CJS）
  // 暴露成纯函数：返回 { rows, regions }，对象经 contextBridge 结构化克隆
  aiDiffCompute: (base, next, options) => markdownDiff.computeFullMarkdownDiff(base, next, options),
  // 安全应用单 region；返回 { ok:true, content } 或 { ok:false, reason }
  aiDiffApply: (currentContent, region) => markdownDiff.applyDiffRegionSafely(currentContent, region),

  // Heading slug 基础算法（renderer 端不再源码级镜像）。
  // 返回空串意味着原文剥完 HTML + 行内标记后什么都不剩（纯符号 heading）。
  // contextBridge 跨边界走结构化克隆：string in / string out，不带内部状态。
  // 调用方负责把多个 heading 串起来做去重。
  slugifyHeadingBase: (raw) => sharedSlugifyBase(raw),

  /**
   * 文件扩展名白名单（共享自 shared/extension-lists.js）。
   *   - EDITABLE_EXTS_LIST: string[] — 可打开编辑的文件扩展名
   *   - MARKDOWN_EXTS_LIST: string[] — 支持预览的扩展名（EDITABLE_EXTS 子集）
   * 这里用数组（不是 Set）过桥：contextBridge 结构化克隆虽支持 Set/Map，
   * 但 Set/Map 内的字符串比较没有 Array.includes 直观；用数组 includes
   * 性能完全够用。 之前 src/app.js 维护着一份 LOCAL_FILE_EXTS 数组，
   * 与 main/file-ops.js 的 EDITABLE_EXTS 易漂移 —— 合并到 shared 后
   * 两边自动同步。
   */
  EDITABLE_EXTS: EDITABLE_EXTS_LIST,
  MARKDOWN_EXTS: MARKDOWN_EXTS_LIST,

  /**
   * 应用图标（PNG data URL，来自 icon.ico）。渲染端用 <img src> 显示在自定义
   * 标题栏左侧。文件缺失 / nativeImage 加载失败时返回 null，渲染端继续用
   * .app-title::before 占位（保持现有视觉）。
   * @returns {string|null}
   */
  getAppIconDataUrl: () => APP_ICON_DATA_URL,
});
