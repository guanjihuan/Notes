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
 * 渲染 markdown 字符串为安全的 HTML
 * - 委托给 utils.safeRenderMarkdown：marked + DOMPurify 实际初始化在 preload.js 里完成
 * - 失败 / 不可用时降级为转义后的 <pre>（永远不返回未转义的原文）
 */
function renderMarkdown(markdown) {
  if (!markdown || typeof markdown !== 'string') return '';
  return safeRenderMarkdown(markdown);
}

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
    // IntersectionObserver：跟踪"当前在视口顶部的 heading"
    this._headingObserver = null;
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
      // audit fix (Round 12 P3)：_headingObserver 是 IntersectionObserver，
      // _rebuildHeadingObserver / clear / showUnsupportedFile 三处各自
      // disconnect，但 dispose 路径没有兜底。detach 后的 heading 节点
      // 被 IntersectionObserver 持有 → Detached HTMLHeadingElement 不被 GC
      // 直到 observer disconnect。
      if (this._headingObserver) {
        try { this._headingObserver.disconnect(); } catch { /* ignore */ }
        this._headingObserver = null;
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
   */
  async resolveRelativeImages(filePath) {
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

    for (const img of this.bodyElement.querySelectorAll('img[src]')) {
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
    if (this.statusPath) this.statusPath.textContent = this._folderLabel();
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
    this.statusPath.textContent = this._folderLabel();
  }

  /** 内部：根据 getCurrentDir 算出无文件时该显示的路径；拿不到则退到 '—'。 */
  _folderLabel() {
    const dir = this.getCurrentDir ? this.getCurrentDir() : '';
    return dir || '—';
  }

  /**
   * 更新状态栏
   */
  updateStatusBar(file) {
    if (this.statusPath) {
      this.statusPath.textContent = file.path || file.name;
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
    this.bodyElement.innerHTML = html;
    this.resolveRelativeImages(this.currentFile ? this.currentFile.path : null);
    // P1-1：增量更新 IntersectionObserver 而不是每次 innerHTML 后全量重建。
    // 编辑实时预览里 200ms 防抖触发一次，10K 行的笔记每次重建 observer
    // 会做 disconnect + new + N 次 observe，长文档能感知到卡顿。
    // 仅当 heading 集合发生变化（增 / 删 / id 变）才重建，否则完全跳过。
    // audit fix (Round 4 F11)：直呼底层 _rebuildHeadingObserver。_syncHeadingObserver
    // 是仅做一层转发的薄壳，签名上的优化语义已被 _rebuildHeadingObserver 全量重建
    // 替代，留着壳子只会让读代码的人多绕一层。直接调底层 + 注释说明「全量重建代价
    // 可忽略」。
    this._rebuildHeadingObserver();
    return { changed: true };
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
   * 重建 heading IntersectionObserver
   *
   * 每次 loadContent / loadContentLive 都会调用 —— 因为 DOM 全换了，
   * 旧的 observer 持有的 DOM 节点已经无效，必须重建。
   */
  _rebuildHeadingObserver() {
    if (this._headingObserver) {
      try { this._headingObserver.disconnect(); } catch { /* ignore */ }
      this._headingObserver = null;
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
      this.currentHeadingId = null;
      this._emitHeadingChange();
      return;
    }
    // 把"当前可见的 heading 集合"实时维护：进入带 → 加入；离开带 → 移除。
    // 最后 emit 的 currentHeadingId 是"位置最低且仍在带内"的（最接近顶部
    // 但还没滚走的那个 —— 这就是用户在阅读的章节）。
    const visibleIds = new Set();
    this._headingObserver = new IntersectionObserver((entries) => {
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
      // 滚过头（带内全空，且最后位置在视口下方） → 选中最后一个 heading
      if (next === null) {
        // 用 viewport 顶部坐标最近的 heading
        const scroller = this.bodyElement.parentElement;
        if (scroller) {
          // offsetTop 相对最近的 positioned 祖先；本布局里 .viewer / .markdown-body
          // 都是 position: static，offsetParent 一路爬到 <body> —— 与
          // scroller.scrollTop 完全不在同一坐标系，会导致「滚过头时永远选不中」。
          // 改用 getBoundingClientRect 拿视口坐标，scroller.scrollTop 在两边都加
          // 上 → 相互抵消，等价于比较 h.rect.top <= scroller.rect.top。
          const scrollerTop = scroller.getBoundingClientRect().top;
          let best = null;
          let bestDist = Infinity;
          for (const h of headings) {
            const hTop = h.getBoundingClientRect().top;
            if (hTop <= scrollerTop) {
              const d = scrollerTop - hTop;
              if (d < bestDist) { bestDist = d; best = h.id; }
            }
          }
          next = best;
        }
      }
      if (next !== this.currentHeadingId) {
        this.currentHeadingId = next;
        this._emitHeadingChange();
      }
    }, {
      root: this.bodyElement.parentElement || null,
      // 顶部 0-20% 的"激活带" —— 进入这个带才算"当前正在阅读"
      rootMargin: '0px 0px -80% 0px',
      // P2-9：单阈值 0 即可。原来的 [0, 1] 会在「进入带」与「完全在带里」各发一次，
      // 状态栏 heading chip 在边界来回闪烁；激活带由 rootMargin 控制已经够准确。
      threshold: 0,
    });
    for (const h of headings) this._headingObserver.observe(h);
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
