// Markdown 阅读视图组件
// 职责：把 markdown 字符串渲染成 HTML、更新状态栏、拦截链接点击。
//
// 与 markdown-editor.js 的关系：viewer 只关心「显示」。
// 加载文件的 dirty 检查、IO 协调全部交给 app.js。

import { formatSize, formatDate, dirnameOf, resolvePath, toFileUrl, safeRenderMarkdown, isPathInside } from './utils.js';
import { getTextStats } from './stats.js';
import { createDisposable } from './component.js';

/**
 * 转义要放进 [id="..."] 属性选择器里的值。
 * 中文 / 数字开头的 id 直接拼 '#' 会是非法选择器，属性选择器最省事，
 * 只需要处理反斜杠和双引号。
 */
function cssAttrEscape(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * 状态栏路径在「无文件 / 无目录信息」时的占位文字。
 * 提取常量是为了 clear() / refreshCurrentDir() 里的 aria-label 判定
 * 不再硬编码 '—' 字面量，将来换占位也不会静默错分支。
 */
const STATUS_PATH_PLACEHOLDER = '—';

/**
 * 渲染 markdown 字符串为安全的 HTML
 * - 委托给 utils.safeRenderMarkdown：marked + DOMPurify 实际初始化在 preload.js 里完成
 * - 失败 / 不可用时降级为转义后的 <pre>（永远不返回未转义的原文）
 */
function renderMarkdown(markdown) {
  if (!markdown || typeof markdown !== 'string') return '';
  return safeRenderMarkdown(markdown);
}

/** 代码块复制按钮图标（lucide copy） */
const ICON_COPY = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
/** 复制成功对勾（lucide check） */
const ICON_CHECK = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"></polyline></svg>';
/** lightbox 关闭（×） */
const ICON_CLOSE = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';

export class MarkdownViewer {
  /**
   * @param {object} options
   * @param {HTMLElement} options.bodyElement - <article> 渲染容器
   * @param {HTMLElement} options.emptyElement - 空状态元素
   * @param {HTMLElement} options.statusPath - 状态栏路径
   * @param {HTMLElement} options.statusMeta - 状态栏元信息
   * @param {(url:string) => void|Promise<void>} options.onExternalLink - 外部链接点击回调
   * @param {() => string|Promise<string>} [options.getDataDir] - 返回当前数据目录绝对路径
   *   异步 callback；resolveRelativeImages 用它做安全边界检查（audit C3）。
   *   不传则跳过越界检查，回退到「只挡 ../.. 越界字符串」的原行为。
   * @param {() => string|null} [options.getCurrentDir] - 返回当前浏览目录的绝对路径
   *   没打开文件时状态栏用它替代「—」显示当前文件夹位置（用户从路径就能定位到根/子目录）。
   *   app.js 在 scanDir / loadFileList 完成后调 refreshCurrentDir() 让 chip 跟随刷新。
   */
  constructor({ bodyElement, emptyElement, statusPath, statusMeta, onExternalLink, getDataDir, getCurrentDir }) {
    this.bodyElement = bodyElement;
    this.emptyElement = emptyElement;
    this.statusPath = statusPath;
    this.statusMeta = statusMeta;
    this.onExternalLink = onExternalLink;
    // 数据目录提供者 —— 用 callback 而非缓存值，因为 dataDir 会随用户切换设置而变。
    this.getDataDir = typeof getDataDir === 'function' ? getDataDir : null;
    // 当前浏览目录提供者 —— 仅用于无文件时状态栏路径展示。
    this.getCurrentDir = typeof getCurrentDir === 'function' ? getCurrentDir : null;
    this.currentFile = null;
    this.currentContent = '';
    this.currentHeadingId = null;            // 当前在视口里最高可见的 heading id
    this.onHeadingChangeCallbacks = new Set();
    // 当前文档所有 heading 的快速查表（id → {level, text, id}），
    // 由 _rebuildHeadingObserver 同步构建；状态栏 heading chip 用它把
    // currentHeadingId 还原成可读文本。
    this._headingMap = new Map();
    // IntersectionObserver：跟踪"当前在视口顶部的 heading"。
    // P2-16：实例持久化（只建一次）；_headingNodes / _headingVisibleIds 是
    // 它的回调读取的实例状态，每次 _rebuildHeadingObserver 全量替换。
    this._headingObserver = null;
    this._headingNodes = [];
    this._headingVisibleIds = null;
    // 每个打开过的文件保留一份滚动位置。
    // 上限 SCROLL_POSITION_CACHE_LIMIT = 200：超出后按插入顺序淘汰最旧未访问的条目，
    // 防止打开几千个文件后 Map 无限增长（每个 entry ≈ 8 字节 key + 8 字节 number）。
    // Map 保留插入顺序；重新访问某文件时先 delete 再 set，等价于移到队尾。
    this.scrollPositions = new Map();
    this.SCROLL_POSITION_CACHE_LIMIT = 200;

    // 跨文件竞态守卫：resolveRelativeImages 是 fire-and-forget 的 async，
    // A→B 快速切换文件时，A 的回调可能在 B 已经接管 DOM 后才 resume。
    // 用单调递增的 generation token，每次 resolveRelativeImages 入口自增，
    // 关键 await 之后再比一次 —— 不等就 return，避免 A 的解析污染 B 的图片。
    this._resolveGen = 0;

    // audit R7b P1-16：loadContentLive 的 rAF chunked insert 单飞行控制。
    // 新一次 loadContentLive / loadContent / clear / showUnsupportedFile / dispose
    // 都必须 abort 上一次还没跑完的分批插入，否则旧 chunk 会 append 进新 DOM。
    this._liveInsertAbort = null;
    // 测试钩子用：_applyHtmlLive 返回的 promise（已 .catch 兜底，不会 reject）。
    this._liveInsertPromise = null;

    // 缓存空态元素初始 innerHTML —— showUnsupportedFile 会临时改写它，
    // 下一次 loadContent/clear 再还原回 index.html 里的默认文案（避免
    // 「上次打开 .txt 残留的'不支持预览'文字」污染下次空态）。
    this._defaultEmptyHTML = emptyElement ? emptyElement.innerHTML : '';

    // 统一 lifecycle：dispose() 一次性 unbind 所有 listener。
    createDisposable(this);

    // audit fix (Phase L1-M1)：onHeadingChange 回调 Set
    // 不在 listener 信号路径上 —— 持有 app.js / state / editor / ai 等大闭包，
    // dispose 时不显式 clear 就会一直挂到 pagehide。HMR / 调试路径下 viewer
    // 替换后旧回调还能触发，让新组件的 state 被污染。abort 时一次性清空。
    this.addAbort(() => {
      this.onHeadingChangeCallbacks.clear();
      // audit R7b P1-16：dispose 时取消还没跑完的 chunked insert，
      // 避免后续 rAF 帧继续往已废弃的 bodyElement 里 append。
      this._cancelLiveInsert();
      // audit fix (Round 12 P3)：_headingObserver 是 IntersectionObserver，
      // _rebuildHeadingObserver / clear / showUnsupportedFile 三处各自
      // disconnect，但 dispose 路径没有兜底。detach 后的 heading 节点
      // 被 IntersectionObserver 持有 → Detached HTMLHeadingElement 不被 GC
      // 直到 observer disconnect。
      if (this._headingObserver) {
        try { this._headingObserver.disconnect(); } catch { /* ignore */ }
        this._headingObserver = null;
      }
      // P2-16：持久化 observer 的实例状态也一并释放（节点数组 / 可见集），
      // 防止 dispose 后仍持有 detached heading 节点引用。
      this._headingNodes = [];
      this._headingVisibleIds = null;
      // 清理交互增强产生的全局浮层（FAB / lightbox），避免 dispose 后残留
      if (this._copyFab && this._copyFab.parentNode) {
        this._copyFab.parentNode.removeChild(this._copyFab);
        this._copyFab = null;
      }
      window.clearTimeout(this._copyFabReset);
      if (this._lightboxOverlay && this._lightboxOverlay.parentNode) {
        this._lightboxOverlay.parentNode.removeChild(this._lightboxOverlay);
        this._lightboxOverlay = null;
      }
    });

    // 拦截链接点击：所有 .markdown-body 内的 <a> 都通过 onExternalLink 走系统默认浏览器
    if (this.bodyElement) {
      this.bodyElement.addEventListener('click', (e) => {
        const anchor = e.target.closest('a[href]');
        if (!anchor) return;
        const href = anchor.getAttribute('href');
        // 统一先 preventDefault：空 href ('') / 锚点 / 任意相对路径，
        // 都不让浏览器按默认行为跑（空 href 不阻止会让 Electron 重载页面）。
        e.preventDefault();
        if (!href) return; // 空 href：什么都不做（合法占位，不触发系统行为）
        // 文内锚点（#xxx）：自己滚动，不改地址栏 hash。
        // marked 会把 href 里的中文百分号编码，而 id 是原文，必须先解码再匹配。
        if (href.startsWith('#')) {
          this.scrollToAnchor(href.slice(1));
          return;
        }
        if (this.onExternalLink) {
          // audit fix (Round 12 P2)：onExternalLink 在调用方是 async 函数
          // （src/app.js:419 走 openFile + openExternal IPC），同步调不会等
          // promise，IPC 抛 throw（非 ok=false）会变成 unhandledRejection。
          // 用户点击外链没反应、只能去主进程 console 翻日志。在 viewer
          // 这一层 catch 住所有异常 + 打 console + 不影响 click 后续。
          // 调用方已用 {ok,message} envelope 走友好提示，这里只兜
          // 「真 throw」这一条路径。
          try {
            const ret = this.onExternalLink(href);
            if (ret && typeof ret.catch === 'function') {
              ret.catch((err) => {
                console.error('[markdown-viewer] onExternalLink promise rejected:', err);
              });
            }
          } catch (err) {
            console.error('[markdown-viewer] onExternalLink threw synchronously:', err);
          }
        }
      }, { signal: this.signal });
    }

    // 阅读区交互增强：代码块复制 + 图片放大。刻意不改动 <pre>/<img> 的 DOM，
    // 以免破坏 loadContentLive 的 isEqualNode 前缀/后缀 diff（见 [[feedback-live-diff-safe]]）。
    this._setupContentInteractions();
  }

  /**
   * 滚动到文内锚点。
   * @param {string} rawHash - 不含 '#' 的片段，可能是百分号编码的
   * @returns {boolean} 是否找到目标
   */
  scrollToAnchor(rawHash) {
    if (!rawHash || !this.bodyElement) return false;
    let id = rawHash;
    try {
      id = decodeURIComponent(rawHash);
    } catch {
      // 非法编码就按原样匹配
    }
    // 用属性选择器而不是 '#'+id：中文/数字开头的 id 在 CSS 选择器里需要转义
    const target = this.bodyElement.querySelector(`[id="${cssAttrEscape(id)}"]`)
      || this.bodyElement.querySelector(`[id="${cssAttrEscape(rawHash)}"]`);
    if (!target) return false;
    target.scrollIntoView({ block: 'start' });
    return true;
  }

  /**
   * 渲染 markdown 字符串到视图。
   * @param {{path:string,name:string,size?:number,mtimeMs?:number}} file
   * @param {string} content - markdown 内容
   */
  async loadContent(file, content) {
    if (!file || !this.bodyElement) return;

    // audit R7b P1-16：切文件必须先取消还在跑的 live chunked insert，
    // 否则旧文件的剩余 chunk 会 append 进新文件的 DOM。
    this._cancelLiveInsert();

    // 恢复空态为 index.html 里的默认文案（showUnsupportedFile 可能改写过了）
    this._resetEmptyState();

    // 保存当前文件的滚动位置（LRU：删除再 set 移到末尾）
    if (this.currentFile && this.bodyElement.parentElement) {
      const path = this.currentFile.path;
      const top = this.bodyElement.parentElement.scrollTop;
      if (this.scrollPositions.has(path)) this.scrollPositions.delete(path);
      this.scrollPositions.set(path, top);
      // 超出上限：删最早插入的（Map 头部）
      while (this.scrollPositions.size > this.SCROLL_POSITION_CACHE_LIMIT) {
        const oldest = this.scrollPositions.keys().next().value;
        this.scrollPositions.delete(oldest);
      }
    }

    this.currentFile = file;
    this.currentContent = typeof content === 'string' ? content : '';
    // Phase N M-1 fix：空文件走「（空文件）」占位文案，而不是渲染空 body。
    // 旧实现 renderMarkdown('') 返回 '' → bodyElement.innerHTML='' → 用户看到
    // 一片空白面板，没有任何提示文件是「真的空」还是「渲染挂了」。
    // 与「未打开文件」空态（emptyElement 显示）区分：当前打开了文件，emptyElement 必须
    // 继续隐藏，否则用户以为文件没打开。
    if (!this.currentContent || this.currentContent.trim() === '') {
      this.bodyElement.innerHTML = '<div class="md-empty-file" role="note">（空文件）</div>';
      this.bodyElement.hidden = false;
      if (this.emptyElement) this.emptyElement.hidden = true;
      this._rebuildHeadingObserver();
      this.updateStatusBar(file);
      return;
    }
    const html = renderMarkdown(content);
    // 自增 generation token，让旧文件的 in-flight resolveRelativeImages 在
    // await getDataDir 之后读 _resolveGen 时失配，自行放弃（A→B 切文件场景）。
    this._resolveGen += 1;
    this.bodyElement.innerHTML = html;
    // resolveRelativeImages 内部 await getDataDir() —— loadContent 是 async 不阻塞调用方
    // （viewer 不暴露 promise；调用方 fire-and-forget 即可，与原同步行为对齐）
    this.resolveRelativeImages(file.path).catch((e) => {
      // 数据目录暂时取不到时（preload 还未注入等极端情况）→ 跳过图片解析，
      // 但不阻断主渲染流程。日志走 console.warn 让用户能看到。
      console.warn('[viewer] resolveRelativeImages 失败：', e && e.message);
    });
    this.bodyElement.hidden = false;
    if (this.emptyElement) this.emptyElement.hidden = true;

    // 重绑 heading observer（_rebuildHeadingObserver 内部重建 _headingMap）
    this._rebuildHeadingObserver();

    // 更新状态栏
    this.updateStatusBar(file);

    // 恢复滚动位置
    // audit fix (L36)：捕获 file.path 用于 rAF 内部的「当前文件没变」校验。
    // 之前直接用 this.currentFile.path，rAF 回调里 this 已经是新文件（A→B 切得很快
    // 时 this.currentFile 已被 B 替换），但 callback 里读 this.scrollPositions.get('B')
    // 等于「给 B 应用 A 的滚动位置」。A 的 scrollTop 被顺手存进了 scrollPositions.set('B', A的top)
    // —— 第二次开 B 会继承错误的滚动。
    // 现在 rAF 内先比对 capturedPath === this.currentFile.path，不一致就放弃 restore。
    const capturedPath = file.path;
    requestAnimationFrame(() => {
      if (!this.currentFile || this.currentFile.path !== capturedPath) return;
      // 命中：删除再 set，等价于把这条移到 Map 末尾（最近访问），LRU 语义
      if (this.scrollPositions.has(capturedPath)) {
        const v = this.scrollPositions.get(capturedPath);
        this.scrollPositions.delete(capturedPath);
        this.scrollPositions.set(capturedPath, v);
      }
      const restore = this.scrollPositions.get(capturedPath) || 0;
      if (this.bodyElement.parentElement) {
        this.bodyElement.parentElement.scrollTop = restore;
      }
    });
  }

  /**
   * 显示「该文件不支持预览」的空态。
   *
   * Stage 8 扩展：可编辑文件不一定是 Markdown（txt/py/json/...）—— 这些文件
   * 仍然能加载到编辑器，但 viewer 不渲染。空态改成「仅编辑模式」提示，
   * 状态栏仍展示文件名 / 大小 / mtime（与 loadContent 行为一致）。
   *
   * 不修改持久化的 state.editorMode —— 调用方负责把编辑器切到 edit 模式。
   * 后续 loadContent / clear 会自动还原空态默认文案。
   *
   * @param {{path:string,name:string,size?:number,mtimeMs?:number}} file
   */
  showUnsupportedFile(file) {
    if (!file) return;
    // audit R7b P1-16：清空正文前取消 in-flight live chunked insert
    this._cancelLiveInsert();
    this.currentFile = file;
    this.currentContent = '';
    this.currentHeadingId = null;
    this._headingMap = new Map();
    if (this._headingObserver) {
      try { this._headingObserver.disconnect(); } catch { /* ignore */ }
      this._headingObserver = null;
    }

    // 隐藏正文，显示空态并改写文案
    if (this.bodyElement) {
      this.bodyElement.innerHTML = '';
      this.bodyElement.hidden = true;
    }
    if (this.emptyElement) {
      // 直接 innerHTML 改写，保留外层 .empty-state 的布局/动画样式
      this.emptyElement.innerHTML = `
        <div class="empty-state-icon">
          <svg viewBox="0 0 24 24" width="36" height="36" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
            <polyline points="14 2 14 8 20 8"></polyline>
          </svg>
        </div>
        <p>该文件不支持预览</p>
        <p class="hint">仅 <code>.md</code> 与 <code>.markdown</code> 文件支持 Markdown 预览。<br>其他文本格式（<code>.txt</code> / <code>.py</code> / <code>.json</code> 等）仅支持编辑。</p>
      `;
      this.emptyElement.hidden = false;
    }

    // 状态栏仍展示文件名 / 大小 / mtime（与 markdown 文件一致）
    this.updateStatusBar(file);

    // heading 清空：通知订阅者
    this._emitHeadingChange();
  }

  /**
   * 恢复空态元素到 index.html 里的默认文案。
   * 由 loadContent / clear 在替换显示内容前调用，避免上次 showUnsupportedFile
   * 改写过的「不支持预览」文字残留。
   */
  _resetEmptyState() {
    if (this.emptyElement && this._defaultEmptyHTML !== undefined) {
      this.emptyElement.innerHTML = this._defaultEmptyHTML;
    }
  }

  /**
   * 把 <img> 的相对 src 改写成 file:// 绝对地址。
   *
   * 不改写的话相对路径会相对 index.html（应用安装目录）解析，
   * 笔记旁边的图片永远加载不出来。
   *
   * 只处理相对路径：绝对路径、data:、http(s): 等一律不动。
   *
   * audit C3 安全修复：解析后的绝对路径必须仍在数据目录内 —— 否则恶意 markdown
   * 可以写 `<img src="../../../Users/victim/secret.jpg">` 直接通过 file:// 读到
   * 用户机器上的任意可读文件。getDataDir 回调由构造时注入（app.js 传
   * `() => window.api.getDataDir()`），取不到时退化为「只挡 ../.. 越界字符串」的旧行为。
   *
   * @param {string} filePath - 当前 markdown 文件的绝对路径
   * @param {Node[]} [roots] - audit P2-14：只扫这些顶级块内的 img（live diff
   *   路径传入本次新插入的块）。未变更块的 img 上一轮已解析成 file://
   *   （绝对 src 在循环里本来就会跳过），scope 后连 querySelectorAll +
   *   getAttribute 的 O(N) 遍历都省掉。不传 → 全 body 扫描（loadContent /
   *   setFileMeta 路径维持原语义）。传 [] → 零变更，直接不扫。
   */
  async resolveRelativeImages(filePath, roots) {
    if (!this.bodyElement || !filePath) return;
    // audit fix (perf-MEDIUM)：A→B 快速切文件时，旧 loadContent 启动的
    // resolveRelativeImages(A) 是 fire-and-forget；await getDataDir 期间
    // currentFile 已被新 loadContent 替换为本文件 B，但 this.bodyElement
    // 也指向已被替换的 DOM（B 的内容）。若不挡，A 的解析结果会污染 B 的图片。
    //
    // audit fix (renderer-M3)：bodyElement 身份永远不会变（同一个 DOM 节点反复
    // innerHTML），用 generation token 保证：每次调用入口自增，**关键 await 之后**
    // 比对 —— 不一致就 return。token 由 loadContent / loadContentLive 在替换
    // innerHTML 之前自增，迫使所有早于本次的内层 await 回调放弃。
    //
    // B-1 fix (audit)：之前在 ++myGen 之后立刻 `if (myGen !== this._resolveGen) return;`
    // —— 这是 no-op：自增后立即比对，token 一定相等，要等到 await 期间才可能变化。
    // 现在只保留 await 后的真正检查（line ~301）。
    const myGen = ++this._resolveGen;
    const baseDir = dirnameOf(filePath);
    if (!baseDir) return;

    // 异步取当前数据目录 —— 失败/缺失时 dataDir 为 null，跳过边界检查（旧行为）。
    let dataDir = null;
    if (this.getDataDir) {
      try {
        const got = this.getDataDir();
        dataDir = (got && typeof got.then === 'function') ? await got : got;
        if (typeof dataDir !== 'string' || !dataDir) dataDir = null;
      } catch {
        dataDir = null;
      }
    }
    // await 之后再判一次 —— 期间可能被新 loadContent / loadContentLive 接管
    if (myGen !== this._resolveGen) return;

    // audit P2-14：roots scope。块自身是 <img>（顶级即图片）或块内嵌套
    // <img>（<p><img></p> 等）两种情况都要覆盖。
    let imgs;
    if (Array.isArray(roots)) {
      imgs = [];
      for (const root of roots) {
        if (!root || root.nodeType !== 1) continue;
        if (root.tagName === 'IMG' && root.hasAttribute('src')) imgs.push(root);
        for (const img of root.querySelectorAll('img[src]')) imgs.push(img);
      }
    } else {
      imgs = this.bodyElement.querySelectorAll('img[src]');
    }

    for (const img of imgs) {
      const src = img.getAttribute('src');
      if (!src) continue;
      // 带协议（含 data:/file:/http:）或以 / 开头的绝对路径 → 原样保留
      if (/^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith('/') || src.startsWith('//')) continue;

      let decoded = src;
      try {
        decoded = decodeURIComponent(src);
      } catch {
        // 非法编码就按原文当路径
      }
      const abs = resolvePath(baseDir, decoded);
      if (!abs) continue; // '../..' 越界
      // 安全边界：解析后的路径必须在数据目录内。越界直接剥 src，不暴露外部文件路径。
      // audit fix (Sec-M2)：旧版 `if (dataDir && !isPathInside(...))` 在 dataDir
      // 为 null（getDataDir IPC 失败 / 启动早期 / window.api 被换）时**跳过整段
      // 边界检查**，任意解析后的绝对路径都会被改写成 file:// URL 喂给浏览器 →
      // 文件系统枚举 oracle（恶意 md 可以用 `<img src="../victim.png">` 探测
      // 哪些路径指向合法图片）。改 fail-closed：dataDir 不可用时一律不下发 src。
      if (!dataDir || !isPathInside(abs, dataDir)) {
        img.removeAttribute('src');
        // 保留视觉占位：把 alt 提到 title，并加一个占位属性让 CSS 可选择
        img.setAttribute('data-blocked', 'external');
        const alt = img.getAttribute('alt');
        if (alt) img.setAttribute('title', `外部图片已拦截：${alt}`);
        continue;
      }
      img.setAttribute('src', toFileUrl(abs));
      // audit fix (P3)：图片懒加载 + 异步解码 —— 一篇含 20 张图的笔记，
      // 之前 marked 直接输出 <img src>，20 个图同时启动下载 + 都参与初始布局，
      // 长文档里看不见的图也抢带宽；CLS 也因为没有 width/height 一图一抖。
      // loading="lazy" 让浏览器在图进入视口前不下载，decoding="async" 让解码
      // 不阻塞主线程（避免大图 decode 卡顿）。这两个属性 setAttribute 已设就
      // 不会重复设（getAttribute 检查避免每次重渲都重写）。
      if (!img.hasAttribute('loading')) img.setAttribute('loading', 'lazy');
      if (!img.hasAttribute('decoding')) img.setAttribute('decoding', 'async');
    }
  }

  /**
   * 同步文件元数据（路径 / 名称 / mtime / size），不重渲染。
   *
   * P1-5：文件被重命名或重载后，state.currentFile.path/name/mtimeMs/size 都更新了，
   * 但 viewer.currentFile 还是旧值 —— viewer 的 resolveRelativeImages 走旧 baseDir，
   * 笔记里 `<img src="./foo.png">` 全部失效。
   *
   * 不全量 reloadContent 是因为：内容没变，只是元数据变了，重渲染会丢滚动位置、
   * IntersectionObserver 全量重建 —— 完全不必要。
   *
   * @param {{path?:string,name?:string,size?:number,mtimeMs?:number}} meta
   */
  setFileMeta(meta) {
    if (!meta || !this.currentFile) return;
    if (meta.path && meta.path !== this.currentFile.path) {
      // 路径变了（重命名 / dataDir 切换）→ 必须把 <img src="./..."> 重新解析到新 baseDir
      this.currentFile = { ...this.currentFile, ...meta };
      // audit fix (Round 4 F8)：resolveRelativeImages 抛错兜底。setFileMeta 在
      // 重命名 / 切目录高频路径上被调用，里面 for 循环可能因 getDataDir 异常或
      // setAttribute 触发 CSP 拦截抛错 —— 之前无 .catch，未捕获的 Promise rejection
      // 在 Electron 主进程 default handler 那里打 log。与 loadContent line 186-190 对齐。
      Promise.resolve(this.resolveRelativeImages(this.currentFile.path))
        .catch((e) => console.warn('[viewer] setFileMeta resolveRelativeImages:', e));
    } else {
      // 路径没变（只是 mtime / size 变化）→ 仅更新元数据即可
      this.currentFile = { ...this.currentFile, ...meta };
    }
    // 状态栏文件名 / mtime 也要刷新
    this.updateStatusBar(this.currentFile);
  }

  /**
   * 清空视图，回到空状态。
   *
   * audit C2 修复：保留 scrollPositions —— 之前 clear() 一刀切全清，
   * 导致「切换文件 → clear → 切回原文件」丢失滚动位置，用户体验差。
   * 现在只清当前文件的 entry（其它文件保留），等价于「清空当前视图但 LRU 缓存仍在」。
   */
  clear() {
    // 恢复空态默认文案（showUnsupportedFile 可能改写过了）
    this._resetEmptyState();
    // audit R7b P1-16：清空正文前取消 in-flight live chunked insert
    this._cancelLiveInsert();

    if (this.bodyElement) {
      this.bodyElement.innerHTML = '';
      this.bodyElement.hidden = true;
    }
    if (this.emptyElement) this.emptyElement.hidden = false;
    this.currentFile = null;
    this.currentContent = '';
    this.currentHeadingId = null;
    this._headingMap = new Map();
    if (this._headingObserver) {
      try { this._headingObserver.disconnect(); } catch { /* ignore */ }
      this._headingObserver = null;
    }
    // 只删当前文件的滚动位置 —— loadContent 已经在切换前把 top 存进 scrollPositions，
    // 再清一次反而覆盖。clear 的语义就是「不再有 currentFile」，所以 entry 留着无害。
    if (this.statusPath) {
      const label = this._folderLabel();
      this.statusPath.textContent = label;
      // audit P2-19：aria-label 与 textContent 同步，让屏幕阅读器既知道按钮作用
      // 也知道当前是哪个文件 / 文件夹。无文件时退到仅描述行为。
      this.statusPath.setAttribute('aria-label',
        label === STATUS_PATH_PLACEHOLDER ? '在文件管理器中显示当前文件夹' : `在文件管理器中显示 ${label}`);
    }
    if (this.statusMeta) this.statusMeta.textContent = '';
    this._emitHeadingChange();
  }

  /**
   * 当前浏览目录刷新 —— 没有打开文件时把状态栏路径切到当前文件夹。
   * 由 app.js 在 scanDir / loadFileList 成功后调用，路径信息同步到 chip。
   * 有文件打开时不影响（文件路径优先级更高，由 updateStatusBar 控制）。
   */
  refreshCurrentDir() {
    if (!this.statusPath) return;
    if (this.currentFile) return; // 文件路径优先，不覆盖
    const label = this._folderLabel();
    this.statusPath.textContent = label;
    // 与 clear() 同步：路径刷新后 aria-label 跟着变（audit P2-19）。
    this.statusPath.setAttribute('aria-label',
      label === STATUS_PATH_PLACEHOLDER ? '在文件管理器中显示当前文件夹' : `在文件管理器中显示 ${label}`);
  }

  /** 内部：根据 getCurrentDir 算出无文件时该显示的路径；拿不到则退到「—」占位。 */
  _folderLabel() {
    const dir = this.getCurrentDir ? this.getCurrentDir() : '';
    return dir || STATUS_PATH_PLACEHOLDER;
  }

  /**
   * 更新状态栏
   */
  updateStatusBar(file) {
    if (this.statusPath) {
      const path = file.path || file.name || STATUS_PATH_PLACEHOLDER;
      this.statusPath.textContent = path;
      // audit P2-19：aria-label 与 textContent 同源（统一用 path），屏幕阅读器
      // 听到什么、看到什么就一致。原本用 file.name 时，对深层路径 SR 只听到短名、
      // 视觉用户看到全路径，两边漂移。
      this.statusPath.setAttribute('aria-label',
        path === STATUS_PATH_PLACEHOLDER
          ? '在文件管理器中显示当前文件夹'
          : `在文件管理器中显示 ${path}`);
    }
    if (this.statusMeta) {
      const parts = [];
      if (typeof file.size === 'number') parts.push(formatSize(file.size));
      if (typeof file.mtimeMs === 'number') parts.push(formatDate(file.mtimeMs));
      this.statusMeta.textContent = parts.join(' · ');
    }
  }

  /**
   * 当前阅读视图的字数统计（CJK 友好）
   *
   * 词数基于渲染后的纯文本（读者看到的文字，不含 markdown 标记），
   * 行数基于源文档 —— 这样切换预览/编辑模式时状态栏的「N 行」不会跳变。
   * 之前这里数的是渲染后的块级元素个数，同一个文件在预览下显示 3 行、
   * 切到编辑就变成 6 行。
   *
   * @returns {{chars:number, words:number, lines:number}}
   */
  getStats() {
    // 行数基于源文档（不是渲染后的 textContent），切预览/编辑时不会跳变。
    const source = this.currentContent || '';
    return getTextStats(source);
  }

  /**
   * 阅读视图的滚动进度（0..1）
   * @returns {number}
   */
  getScrollProgress() {
    if (!this.bodyElement) return 0;
    const scroller = this.bodyElement.parentElement;
    if (!scroller) return 0;
    const max = scroller.scrollHeight - scroller.clientHeight;
    if (max <= 0) return 0;
    return Math.min(1, Math.max(0, scroller.scrollTop / max));
  }

  /**
   * 把阅读视图滚动到指定比例（0..1）。供双栏反向同步（editor → viewer / viewer → editor）。
   * @param {number} progress
   */
  setScrollProgress(progress) {
    if (!this.bodyElement) return;
    const scroller = this.bodyElement.parentElement;
    if (!scroller) return;
    const max = scroller.scrollHeight - scroller.clientHeight;
    if (max <= 0) return;
    const target = Math.min(1, Math.max(0, progress)) * max;
    scroller.scrollTop = target;
  }

  /**
   * 监听阅读视图自身的滚动（用于反向同步到编辑器）。
   *
   * audit fix (H1-renderer)：listener 必须挂在组件自己的 signal 上 —— 之前
   * 没传 signal，dispose() 时 listener 仍存在，闭包持住 viewer + 回调对象，
   * 单例 dispose 后再开新组件（旧 cb 在 rAF 里跑 → 抛"viewer disposed"
   * 类错误）。现在挂 signal，dispose() 一次性 unbind；同时返回 unsubscribe
   * 让调用方可以单独取消（多重订阅场景）。
   *
   * @param {(progress:number) => void} cb
   * @returns {() => void} unsubscribe
   */
  onScroll(cb) {
    if (!this.bodyElement || !this.bodyElement.parentElement) return () => {};
    const scroller = this.bodyElement.parentElement;
    const handler = () => {
      if (typeof cb === 'function') cb(this.getScrollProgress());
    };
    scroller.addEventListener('scroll', handler, { passive: true, signal: this.signal });
    return () => scroller.removeEventListener('scroll', handler);
  }

  /**
   * 设置阅读区「微交互」：代码块复制按钮 + 图片点击放大。
   *
   * 设计约束：loadContentLive 用 isEqualNode 做前缀/后缀 diff，任何对 <pre>/<img>
   * 子节点的 DOM 注入都会在实时编辑时破坏匹配、造成闪烁。所以这里的两类增强都
   * 走「事件委托 + 全局浮层」，绝不往 pre/img 里塞节点：
   *   - 复制按钮 = 一个固定定位的浮动 FAB（document.body 上常驻一个），
   *     悬浮代码块时算出位置贴到右上角；点击时读取 pre 文本写入剪贴板。
   *   - 图片放大 = 一个常驻的全局 lightbox 浮层（#image-lightbox），
   *     点击正文 <img> 时填入 src/alt 并显示。
   * 所有监听挂在 this.signal 上，dispose 自动解绑；FAB / lightbox 浮层在
   * 构造函数 addAbort 中一并从 document 移除。
   */
  _setupContentInteractions() {
    if (!this.bodyElement) return;
    const body = this.bodyElement;
    let copyFab = null;
    let hoverPre = null;

    const ensureCopyFab = () => {
      if (copyFab) return copyFab;
      copyFab = document.createElement('button');
      copyFab.type = 'button';
      copyFab.className = 'code-copy-fab';
      copyFab.setAttribute('aria-label', '复制代码');
      copyFab.hidden = true;
      copyFab.innerHTML = ICON_COPY;
      copyFab.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!hoverPre) return;
        const codeEl = hoverPre.querySelector('code');
        const text = (codeEl ? codeEl.innerText : hoverPre.innerText) || '';
        this._copyText(text).then((ok) => {
          if (!ok) return;
          copyFab.classList.add('is-copied');
          copyFab.innerHTML = ICON_CHECK;
          window.clearTimeout(this._copyFabReset);
          this._copyFabReset = window.setTimeout(() => {
            copyFab.classList.remove('is-copied');
            copyFab.innerHTML = ICON_COPY;
          }, 1200);
        });
      });
      copyFab.addEventListener('mouseleave', (e) => {
        // 从 FAB 移回 pre 时不收起，避免点击前按钮消失
        if (e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest('pre')) return;
        copyFab.hidden = true;
        hoverPre = null;
      });
      document.body.appendChild(copyFab);
      this._copyFab = copyFab;
      return copyFab;
    };

    const positionFab = (pre) => {
      const fab = ensureCopyFab();
      const rect = pre.getBoundingClientRect();
      // FAB 默认隐藏（offsetWidth=0），直接用 CSS 约定的 28px 宽度算位置，避免测不到
      const fabW = 28;
      if (rect.bottom < 0 || rect.top > window.innerHeight) {
        fab.hidden = true;
        return;
      }
      let left = rect.right - fabW - 8;
      let top = rect.top + 8;
      left = Math.max(8, Math.min(left, window.innerWidth - fabW - 8));
      top = Math.max(8, top);
      fab.style.left = `${left}px`;
      fab.style.top = `${top}px`;
      fab.hidden = false;
    };

    body.addEventListener('mouseover', (e) => {
      const pre = e.target.closest && e.target.closest('pre');
      if (!pre) return;
      positionFab(pre);
      hoverPre = pre;
    }, { signal: this.signal });

    body.addEventListener('mouseout', (e) => {
      const pre = e.target.closest && e.target.closest('pre');
      if (!pre) return;
      // 移到 FAB（在 bodyElement 之外）或 pre 内部子元素时不收起
      if (e.relatedTarget === copyFab) return;
      if (e.relatedTarget && pre.contains(e.relatedTarget)) return;
      if (hoverPre === pre) hoverPre = null;
      if (copyFab) copyFab.hidden = true;
    }, { signal: this.signal });

    const scroller = body.parentElement;
    if (scroller) {
      scroller.addEventListener('scroll', () => {
        if (hoverPre && hoverPre.isConnected) positionFab(hoverPre);
        else if (copyFab) copyFab.hidden = true;
      }, { passive: true, signal: this.signal });
    }

    // 图片点击放大（事件委托，不改动 <img>）
    body.addEventListener('click', (e) => {
      const img = e.target.closest && e.target.closest('img');
      if (!img) return;
      this._openLightbox(img.currentSrc || img.src, img.alt || '');
    }, { signal: this.signal });
  }

  /** 打开图片 lightbox（常驻全局浮层，避免重复创建 / 破坏 live diff）。 */
  _openLightbox(src, alt) {
    let overlay = this._lightboxOverlay;
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'image-lightbox';
      overlay.className = 'image-lightbox';
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-modal', 'true');
      overlay.setAttribute('aria-label', '图片预览');
      overlay.hidden = true;
      overlay.innerHTML = `
        <div class="image-lightbox-backdrop" data-close="1"></div>
        <div class="image-lightbox-stage">
          <img class="image-lightbox-img" alt="">
          <button type="button" class="image-lightbox-close" data-close="1" aria-label="关闭 (Esc)">${ICON_CLOSE}</button>
        </div>`;
      overlay.addEventListener('click', (e) => {
        if (e.target.dataset && e.target.dataset.close) this._closeLightbox();
      });
      document.body.appendChild(overlay);
      this._lightboxOverlay = overlay;
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && overlay && !overlay.hidden) this._closeLightbox();
      }, { signal: this.signal });
    }
    const img = overlay.querySelector('.image-lightbox-img');
    img.src = src;
    img.alt = alt;
    overlay.hidden = false;
    const closeBtn = overlay.querySelector('.image-lightbox-close');
    if (closeBtn) closeBtn.focus();
  }

  /** 关闭图片 lightbox。 */
  _closeLightbox() {
    const overlay = this._lightboxOverlay;
    if (!overlay) return;
    overlay.hidden = true;
    const img = overlay.querySelector('.image-lightbox-img');
    if (img) img.src = '';
  }

  /** 写入剪贴板，Electron 环境下 clipboard API 可能不可用，用 textarea execCommand 兜底。 */
  async _copyText(text) {
    if (!text) return false;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch { /* 走兜底 */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }

  /**
   * 轻量刷新（仅替换 body HTML，不动滚动位置 / 不触发 status bar 更新 / 不存历史）。
   *
   * 用于「编辑实时预览」：用户敲键盘时右侧实时跟手，又不希望每次都重置滚动。
   * 与 loadContent 的关键差异：
   *   - 不保存当前滚动位置（用户自己滚动到哪里就是哪里）
   *   - requestAnimationFrame 后不恢复滚动（保持原状）
   *   - 不更新状态栏
   *
   * @param {string} content - 最新的 markdown 字符串
   * @returns {{changed:boolean}} changed=true 表示内容确实变了
   */
  loadContentLive(content) {
    if (!this.bodyElement) return { changed: false };
    const next = typeof content === 'string' ? content : '';
    // M-series fix (audit Phase M-H3)：即便内容没变（早返回），也要 bump
    // generation token，让上一轮 in-flight 的 resolveRelativeImages 在
    // await getDataDir 之后读到旧 myGen → 自行放弃。否则 A→B→A 序列里
    // 中间那次 loadContentLive 早返回，pending 的 resolveRelativeImages
    // 仍会写入 body，覆盖新内容里的图片路径（用 baseDir 复用旧文件）。
    // loadContentLive 的 _resolveGen 跳号不致命：后续 loadContent / 下一次
    // loadContentLive 仍会 bump 到新值，最终一致性靠单调递增保证。
    if (next === this.currentContent) {
      this._resolveGen += 1;
      return { changed: false };
    }
    this.currentContent = next;
    const html = renderMarkdown(next);
    // 自增 generation token（与 loadContent 同源 —— 每次 innerHTML 替换都让
    // 上一轮的 resolveRelativeImages 失效），M7 fix：loadContentLive 内层
    // resolveRelativeImages 也必须走 generation 比对，单靠 capturedBody 不够
    // （bodyElement 身份不变）。
    this._resolveGen += 1;

    // audit R7b P1-16 + R8 P2-17：不再同步 `bodyElement.innerHTML = html` 整页替换。
    // 5MB markdown 渲染后 ~7-10MB HTML，同步解析 + 布局一次吃掉 100-400ms
    // 主线程，200ms debounce 的实时预览路径打字明显掉帧。_applyHtmlLive 做
    // 两端 diff：未变更的顶级块保留原 DOM 节点（heading observer 的观察
    // 目标随之存活），只删 + 插真正变化的中段；大中段再按每帧 ≤ 200 个
    // 节点分批，把成本摊到多帧。
    //
    // 单飞行：新一次 loadContentLive 先 abort 上一次还没跑完的 apply。
    // 中途 abort 留下的「新旧混合」body 会被下一次 diff 自动收敛（diff 的
    // 旧侧总是读当前真实 DOM），不需要清空重来。
    this._cancelLiveInsert();
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    this._liveInsertAbort = controller;
    this._liveInsertPromise = this._applyHtmlLive(html, controller ? controller.signal : null)
      .catch((e) => {
        // apply 内部不抛（每步都有 signal 检查），这里是防御性兜底，
        // 与 loadContent 的 resolveRelativeImages catch 对齐。
        console.warn('[viewer] live apply 失败：', e && e.message);
      });
    return { changed: true };
  }

  /**
   * 取消还没跑完的 live apply（audit R7b P1-16 / R8 P2-17）。
   *
   * 所有「替换 / 清空 bodyElement」的入口都要先调它：loadContent /
   * loadContentLive（下一次）/ clear / showUnsupportedFile / dispose。
   * 否则旧 apply 的后续 rAF 帧会继续 insertBefore，污染新 DOM。
   */
  _cancelLiveInsert() {
    if (this._liveInsertAbort) {
      try { this._liveInsertAbort.abort(); } catch { /* ignore */ }
      this._liveInsertAbort = null;
    }
  }

  /**
   * 把 HTML 字符串增量应用到 bodyElement（audit R7b P1-16 + R8 P2-17）。
   *
   * 流程：
   *   1. （同步，大 html 推迟一帧）createContextualFragment 解析 html
   *      —— fragment 节点全部 detached，解析不触发 body 的重排
   *   2. 两端 diff：旧 body.childNodes vs 新 fragment.childNodes，
   *      共同前缀 / 后缀用 isEqualNode 判定保留 —— 节点引用不动，
   *      heading observer 的观察目标随之存活。
   *      已知例外：含已解析图片的块无法保留 —— resolveRelativeImages 把
   *      src 改写成 file:// 并加 loading/decoding，与下一轮渲染产物里的
   *      原始相对 src 不再 isEqualNode → 该块被替换 + scoped 重解析。
   *      与 P1-16 前的全量替换基线等价（图片块本来就每轮重解析），非回归。
   *   3. 只删「旧中段」、只插「新中段」：实时打字场景中段通常就是
   *      正在编辑的那一个块 → 每次 debounce 只动 1 个节点
   *   4. 新中段 ≤ CHUNK 同步插（小文档零额外延迟）；> CHUNK 每帧最多
   *      CHUNK 个节点分批，每帧开头检查 signal.aborted
   *   5. 全部落地 → _finishLiveInsert：重建 heading observer + 按变更块
   *      scope 启动 resolveRelativeImages。两者都必须看到完整 DOM 才有意义。
   *
   * 两端 diff 的适用性：每次 debounce tick 对应源文档一段连续编辑，
   * 渲染产物的差异也是一段连续区间（单块改 / 单块增删最常见），
   * 前缀+后缀双侧收缩正好覆盖。退化场景（AI apply-all / 外部全量改写）
   * 中段 = 全文，行为等价于 P1-16 的分批全量替换， correctness 不变。
   *
   * abort 自愈：中途 abort 不做任何回滚，body 停在「新旧混合」态；
   * 下一次 _applyHtmlLive 的旧侧读当前真实 DOM，diff 自动补齐差异。
   *
   * @param {string} html - renderMarkdown 的产物
   * @param {AbortSignal|null} signal - 取消信号；null 时退化为不检查（兼容老环境）
   */
  async _applyHtmlLive(html, signal) {
    const body = this.bodyElement;
    if (!body) return;
    if (signal && signal.aborted) return;

    const source = html || '';
    // 大文档（> 256KB）连解析都推迟到下一帧：createContextualFragment 对
    // 7-10MB HTML 的解析本身就要 50-150ms，放在同步段会让 loadContentLive
    // 的调用方（editor onChange → debounce 回调）依然卡一个大帧。
    // 小文档保持同步解析 —— 典型笔记（几 KB）零额外延迟。
    const LARGE_HTML_BYTES = 256 * 1024;
    if (source.length > LARGE_HTML_BYTES) {
      await this._nextFrame();
      if (signal && signal.aborted) return;
    }

    // createContextualFragment 走浏览器原生 HTML parser，产物是 detached
    // fragment，解析期间不触发 body 的 layout/paint。
    const range = document.createRange();
    const fragment = range.createContextualFragment(source);

    // 两端 diff。isEqualNode 是原生深比较（属性顺序不敏感、无字符串分配），
    // 未变更块 O(块大小) 但全程 native code，远快于重建 DOM。
    const oldNodes = Array.from(body.childNodes);
    const newNodes = Array.from(fragment.childNodes);
    let start = 0;
    let oldEnd = oldNodes.length - 1;
    let newEnd = newNodes.length - 1;
    while (start <= oldEnd && start <= newEnd && oldNodes[start].isEqualNode(newNodes[start])) start++;
    while (oldEnd >= start && newEnd >= start && oldNodes[oldEnd].isEqualNode(newNodes[newEnd])) {
      oldEnd--;
      newEnd--;
    }

    const removeCount = oldEnd - start + 1;
    const insertCount = newEnd - start + 1;
    if (removeCount <= 0 && insertCount <= 0) {
      // 完全等价（debounce 抖动 / 属性顺序差异 / 改了又改回）→ 零 DOM 变更。
      // 仍走 finish：heading observer reconcile + 图片解析保持幂等语义。
      this._finishLiveInsert(signal, []);
      return;
    }

    // 删旧中段（detach 便宜，同步做）。
    for (let i = start; i <= oldEnd; i++) {
      body.removeChild(oldNodes[i]);
    }
    if (signal && signal.aborted) return;

    // 插新中段：refNode 是旧 suffix 第一个保留节点（仍在 body 里），
    // 没有 suffix 时 insertBefore(n, null) 等价 appendChild。
    const refNode = oldNodes[oldEnd + 1] || null;
    const toInsert = newNodes.slice(start, newEnd + 1);

    const CHUNK = 200; // 每帧 ≤ 200 个节点（P1-16 与用户对齐的取值）
    if (toInsert.length <= CHUNK) {
      for (const n of toInsert) body.insertBefore(n, refNode);
    } else {
      let idx = 0;
      while (idx < toInsert.length) {
        if (signal && signal.aborted) return;
        await this._nextFrame();
        if (signal && signal.aborted) return;
        const batch = document.createDocumentFragment();
        const end = Math.min(idx + CHUNK, toInsert.length);
        for (let i = idx; i < end; i++) batch.appendChild(toInsert[i]);
        body.insertBefore(batch, refNode);
        idx = end;
      }
    }
    this._finishLiveInsert(signal, toInsert);
  }

  /**
   * live apply 全部完成后的收尾（audit R7b P1-16 / R8 P2-14 / P2-16）：
   * heading observer 与 resolveRelativeImages 都依赖「完整 DOM」，
   * 必须等所有变更落地再跑，否则 observer 盯半截 DOM / 图片漏解析。
   *
   * @param {AbortSignal|null} signal
   * @param {Node[]} changedRoots - 本次新插入的顶级块（P2-14：图片解析只扫
   *   这些块；未变更块的 img 上一轮已解析过，重扫是纯浪费）。传 [] 表示
   *   零变更；loadContent 等非 diff 路径不传（= 全 body 扫描）。
   */
  _finishLiveInsert(signal, changedRoots) {
    if (signal && signal.aborted) return;
    // P2-16 契约（与 notes-2c 对齐）：observer 实例持久化，但每次重建必须
    // 全量 re-observe（renderer-M1 历史教训）。diff 保留了 heading 节点引用，
    // 但 re-observe 的成本 O(heading 数 5-50) 可忽略，不为此破坏统一语义。
    this._rebuildHeadingObserver();
    // fire-and-forget，与 loadContent 路径一致；catch 兜底避免 unhandled rejection。
    this.resolveRelativeImages(this.currentFile ? this.currentFile.path : null, changedRoots)
      .catch((e) => console.warn('[viewer] resolveRelativeImages 失败：', e && e.message));
  }

  /**
   * 等下一帧。jsdom / 老环境没有 requestAnimationFrame 时退化为 setTimeout(0)。
   * 独立成方法方便测试替换 / 未来统一调度。
   */
  _nextFrame() {
    return new Promise((resolve) => {
      if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
        window.requestAnimationFrame(() => resolve());
      } else {
        setTimeout(resolve, 0);
      }
    });
  }

  /**
   * 测试钩子：等当前 in-flight 的 chunked insert 完成（含被 abort 的 ——
   * promise 已 .catch 兜底，永远 resolve）。
   */
  _test_liveInsertDone() {
    return this._liveInsertPromise || Promise.resolve();
  }

  /**
   * 当前在视口里"最顶部可见"的 heading
   * @returns {{level:1|2|3, text:string, id:string}|null}
   */
  getCurrentHeading() {
    if (!this.currentHeadingId || !this._headingMap.size) return null;
    return this._headingMap.get(this.currentHeadingId) || null;
  }

  /**
   * 订阅"当前 heading 变化"事件
   *
   * 用 IntersectionObserver 跟踪每个 heading 元素是否进入/离开视口顶部
   * 一带状区域（rootMargin: '0px 0px -80% 0px' 表示视口顶部 20% 那一条带）。
   * 多个 heading 可能在同一带里 → 取"位置最高且仍在带内"的最后一个。
   *
   * @param {(heading: {level:1|2|3, text:string, id:string}|null) => void} cb
   * @returns {() => void} 取消订阅函数
   */
  onHeadingChange(cb) {
    if (typeof cb !== 'function') return () => {};
    this.onHeadingChangeCallbacks.add(cb);
    // 立刻用当前 heading 触发一次，让订阅者能立刻同步状态
    try { cb(this.getCurrentHeading()); } catch { /* ignore */ }
    return () => this.onHeadingChangeCallbacks.delete(cb);
  }

  /**
   * 重建 heading 观察：每次 loadContent / loadContentLive 都会调用 —— 因为
   * DOM 全换了，旧观察目标节点已 detach，必须重新 observe 新节点。
   * （P2-16 后 observer 实例本身持久化，见函数体注释。）
   */
  _rebuildHeadingObserver() {
    // P2-16 (audit)：observer 实例持久化 —— 不再每次 new IntersectionObserver。
    // loadContentLive 在 split 模式每个 debounced 击键都跑一次重建，旧实现
    // 每次都分配 observer 对象 + 回调闭包。现在实例只建一次，重建只做
    // disconnect + 全量 re-observe。
    // 注意：「全量 re-observe」不能省（renderer-M1 历史教训：innerHTML 替换
    // detach 旧节点，增量 observe 会盯着死节点，heading 追踪冻死）。
    if (this._headingObserver) {
      try { this._headingObserver.disconnect(); } catch { /* ignore */ }
    }
    if (!this.bodyElement) return;
    const headings = this.bodyElement.querySelectorAll('h1, h2, h3');
    // 同步构建 heading 快查表（id → {level, text, id}），
    // 让 getCurrentHeading 直接从 DOM 读取。
    this._headingMap = new Map();
    for (const h of headings) {
      if (!h.id) continue;
      this._headingMap.set(h.id, {
        level: Number(h.tagName.charAt(1)), // 'H1' → 1
        text: h.textContent || '',
        id: h.id,
      });
    }
    // 记录当前观察的 heading id 列表（调试 / 复用参考）
    this._observedHeadingIds = headings.length === 0 ? [] : Array.from(headings).map(h => h.id);
    if (headings.length === 0) {
      // 清空旧文档遗留的 heading 引用，避免指向已 detach 的节点（非空分支才在下方重建
      // _headingNodes / _headingVisibleIds，提前 return 时要补，否则 _onHeadingIntersection
      // 在空文档上仍持有旧节点引用）。
      this._headingNodes = [];
      this._headingVisibleIds = null;
      this.currentHeadingId = null;
      this._emitHeadingChange();
      return;
    }
    // P2-16：回调改读实例状态（_headingNodes / _headingVisibleIds），
    // 不再闭包捕获本次的 headings / visibleIds —— 闭包捕获会让旧 observer
    // 持有旧 NodeList，也正是「必须每次 new」的根因；实例状态化之后
    // observer 可以跨重建存活。
    this._headingNodes = Array.from(headings);
    this._headingVisibleIds = new Set();
    if (!this._headingObserver) {
      this._headingObserver = new IntersectionObserver((entries) => {
        this._onHeadingIntersection(entries);
      }, {
        root: this.bodyElement.parentElement || null,
        // 顶部 0-20% 的"激活带" —— 进入这个带才算"当前正在阅读"
        rootMargin: '0px 0px -80% 0px',
        // P2-9：单阈值 0 即可。原来的 [0, 1] 会在「进入带」与「完全在带里」各发一次，
        // 状态栏 heading chip 在边界来回闪烁；激活带由 rootMargin 控制已经够准确。
        threshold: 0,
      });
    }
    for (const h of this._headingNodes) this._headingObserver.observe(h);
  }

  /**
   * heading IntersectionObserver 回调（P2-16 抽成实例方法，供持久化 observer 复用）。
   *
   * 把"当前可见的 heading 集合"实时维护：进入带 → 加入；离开带 → 移除。
   * 最后 emit 的 currentHeadingId 是"位置最低且仍在带内"的（最接近顶部
   * 但还没滚走的那个 —— 这就是用户在阅读的章节）。
   * @param {IntersectionObserverEntry[]} entries
   */
  _onHeadingIntersection(entries) {
    const headings = this._headingNodes || [];
    const visibleIds = this._headingVisibleIds;
    if (!visibleIds) return;
    for (const e of entries) {
      const id = e.target.id;
      if (!id) continue;
      if (e.isIntersecting) visibleIds.add(id);
      else visibleIds.delete(id);
    }
    // 找在 visibleIds 里、且 DOM 顺序中位置最低（最后）的 heading
    let next = null;
    for (const h of headings) {
      if (visibleIds.has(h.id)) next = h.id;
    }
    // 如果一个都不在带内（滚过头了），保持上一次
    if (next === null && visibleIds.size === 0) {
      // 不主动改 currentHeadingId —— 让"上次已知"留在状态栏
      return;
    }
    // 注：`next === null` 在此处不可达 —— 进入本分支前 `if (next === null && visibleIds.size === 0) return;`
    // 已把「带内全空」的情况拦截；若 next 为 null 则 visibleIds 必为空，早已 return。
    // 故这里无需再处理「滚过头」回退逻辑（那段 getBoundingClientRect 计算是死代码，已删除）。
    if (next !== this.currentHeadingId) {
      this.currentHeadingId = next;
      this._emitHeadingChange();
    }
  }

  /**
   * 增量更新 heading observer（曾经是 P1-1 的 id-only 优化）
   *
   * 编辑实时预览（loadContentLive）每次都会 innerHTML 替换全部正文。
   *
   * audit fix (renderer-M1)：旧实现靠「heading id 列表相等就跳过重建」来
   * 优化，但 innerHTML 替换之后观察的目标节点本身已经被 detach —— id 列表
   * 相等（用户改的是正文而非 heading）时 observer 继续盯着 detach 节点，
   * 新 heading 节点没有任何 observer，「当前 heading」追踪直接冻死。
   *
   * heading 数量是 O(N) 且 N 通常 5-50，全量重建代价可忽略。直接走全量重建，
   * 简单且正确。
   *
   * audit fix (Round 4 F11)：原 _syncHeadingObserver 是仅做一层转发的薄壳，
   * 已被删除，调用方（loadContentLive）直接调 _rebuildHeadingObserver。
   */
  _emitHeadingChange() {
    if (!this.onHeadingChangeCallbacks.size) return;
    const heading = this.getCurrentHeading();
    for (const cb of this.onHeadingChangeCallbacks) {
      try { cb(heading); } catch (e) { console.error('[viewer] onHeadingChange callback 异常:', e); }
    }
  }
}
