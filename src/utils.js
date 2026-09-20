// 共享小工具 —— 文本格式化与转义
//
// 单一来源：之前 formatSize / formatDate 在 file-list.js 和
// markdown-viewer.js 各定义了一份；escapeHtml / escapeAttr 在
// settings-dialog.js 和 confirm-dialog.js 也重复了一遍。

// 时间常量 —— formatRelativeTime 内部需要「秒」「天」量级；提出来便于阅读
const MS_PER_SEC = 1000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * 文件大小 -> 人类可读字符串（B / KB / MB）
 * @param {number} bytes
 */
export function formatSize(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * mtime -> 短日期字符串（YYYY-MM-DD HH:mm）
 * @param {number} mtimeMs
 */
export function formatDate(mtimeMs) {
  if (typeof mtimeMs !== 'number' || !Number.isFinite(mtimeMs)) return '';
  const d = new Date(mtimeMs);
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${y}-${mo}-${da} ${h}:${mi}`;
}

/**
 * mtime -> 相对时间字符串（用于侧栏文件列表的密度提升）
 *
 * 阈值梯度（基于 now）：
 *   < 60s        → "刚刚"
 *   < 60min      → "N 分钟前"
 *   < 24h（且跨日）→ "昨天"
 *   < 24h（同日）  → "N 小时前"
 *   < 7d         → "N 天前"
 *   ≥ 7d         → 回落到 formatDate（绝对时间）
 *
 * @param {number} mtimeMs
 * @param {number} [nowMs=Date.now()]
 * @returns {string}
 */
export function formatRelativeTime(mtimeMs, nowMs = Date.now()) {
  if (typeof mtimeMs !== 'number' || !Number.isFinite(mtimeMs)) return '';
  if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) nowMs = Date.now();
  const diffMs = Math.max(0, nowMs - mtimeMs);
  const sec = Math.floor(diffMs / MS_PER_SEC);

  if (sec < 60) return '刚刚';

  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟前`;

  // 跨日判断：基于本地"今天 0:00"的差值
  const mtime = new Date(mtimeMs);
  const now = new Date(nowMs);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfMtimeDay = new Date(mtime.getFullYear(), mtime.getMonth(), mtime.getDate()).getTime();
  const daysApart = Math.round((startOfToday - startOfMtimeDay) / MS_PER_DAY);

  if (daysApart === 0) {
    const hr = Math.floor(min / 60);
    return `${hr} 小时前`;
  }
  if (daysApart === 1) return '昨天';
  if (daysApart < 7) return `${daysApart} 天前`;

  // ≥ 7d：回落绝对时间，避免"183 天前"这种无意义表达
  return formatDate(mtimeMs);
}

/**
 * 转义 HTML 文本节点内容
 */
export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 安全渲染 markdown —— markdown-viewer / ai-diff-panel 共享的入口。
 *
 * 优先走 preload 暴露的 window.api.renderMarkdown（marked + DOMPurify 走主进程加载，
 * XSS 防护集中）。失败 / 不可用时退化为转义后的 <pre>，永远不返回未转义的原文。
 *
 * @param {string} markdown
 * @returns {string} 安全 HTML（可放入 markdown-body 容器）
 */
export function safeRenderMarkdown(markdown) {
  if (typeof window !== 'undefined'
      && window.api
      && typeof window.api.renderMarkdown === 'function') {
    try {
      const result = window.api.renderMarkdown(markdown || '');
      // audit fix (Round 8 R-1)：renderMarkdown 契约是 string，但 jsdom 单测或
      // 未来 mock 替换可能返回非字符串。typeof guard 防 `null / undefined / 数字`
      // 直接 setBody 触发下游 DOM 解析错或 .innerHTML=null 抛错。**必须用 typeof，
      // 不能用 `||`**，因为 '' 是空 markdown 的合法返回（preload 对空字符串返回 ''，
      // 不是 <pre>）—— `result ||` 会把合法空 markdown 误降级。
      if (typeof result === 'string') return result;
      console.warn('[utils] renderMarkdown 返回非字符串，降级为 <pre>：', typeof result);
    } catch (e) {
      console.warn('[utils] renderMarkdown 失败，降级为 <pre>：', e && e.message);
    }
  } else if (typeof window !== 'undefined') {
    console.warn('[utils] window.api.renderMarkdown 不可用，降级为 <pre>');
  }
  return `<pre class="md-render-fallback">${escapeHtml(markdown || '')}</pre>`;
}

/**
 * 转义 HTML 属性值。
 *
 * 与 escapeHtml 等价 —— escapeHtml 已经覆盖了 `"` 和 `'`（→ &quot; / &#39;），
 * 直接放进属性上下文（`attr="..."` / `attr='...'`）都是安全的。
 *
 * 这里保留独立导出有两个目的：
 *   - 语义标识：调用方看到 escapeAttr 就知道这是放进 HTML 属性的；
 *     review 时一眼能区分「文本节点」与「属性值」两个不同的转义场景
 *   - 未来扩展：若要给属性转义加更激进的规则（如拒绝控制字符），
 *     改这一处即可，不必把所有 escapeHtml 调用点扫一遍
 *
 * @param {string} s
 */
export function escapeAttr(s) {
  return escapeHtml(s);
}

/**
 * 检查 child 路径是否在 parent 目录之内（防御性边界检查）。
 * 不依赖文件系统（不解析 symlink），只做字符串前缀比对。
 * Windows 下忽略大小写。
 *
 * 与 main.js 的 isWithinDataDir 行为一致 —— 这里只是 renderer 端的快速兜底。
 *
 * 边界：
 *   - parent 为根目录（POSIX '/'、Windows 'C:\'）时，norm 会把末尾分隔符
 *     剥掉变成空串或纯盘符；这种「根」视为「任何非空路径都在其内」。
 *   - child 为空串 → 不视为在任何目录内（路径非法）。
 *
 * @param {string} child
 * @param {string} parent
 */
export function isPathInside(child, parent) {
  if (!child || !parent) return false;
  const norm = (s) => s.replace(/\\/g, '/').replace(/\/+$/, '');
  let a = norm(parent);
  let b = norm(child);
  if (!b) return false; // 空 child 路径不视为合法
  // 与 pathsEqual 策略对齐 —— Windows + macOS（APFS 默认）都按大小写不敏感，
  // Linux 严格相等。否则主进程 isWithinDataDir（main.js 的同名守卫）和 renderer
  // 侧边界检查在 macOS 上会出现一过 allow 一过 reject 的不一致。
  if (isCaseInsensitiveFs()) {
    a = a.toLowerCase();
    b = b.toLowerCase();
  }
  // 根目录边界：norm 之后 a 是空串（POSIX '/'）或仅含盘符（Windows 'C:'）。
  // 这两种情况下任何非空 child 都在 parent 内 —— 视 a 为「空前缀」。
  if (a === '' || /^[a-z]:$/i.test(a)) {
    return true;
  }
  if (a === b) return true;
  return b.startsWith(a + '/');
}

/**
 * 平台相关的路径相等比较。
 *
 * Windows（NTFS）/ macOS（APFS 默认 case-insensitive）路径大小写不敏感，
 * 但 Linux（ext4 等默认大小写敏感）严格相等。
 * 同样两条路径在前两类平台要求 .toLowerCase() 相等；Linux 上要求严格相等。
 *
 * 用法：sidebar / file-list 把当前打开文件（state.currentFile.path，可能是
 * 用户输入的 case）与磁盘条目（fs 返回的真实 case）做匹配时，
 * `state.currentFile.path === entry.path` 在 Windows / macOS 上经常 false，
 * 导致高亮 / 选中态错位。统一走 pathsEqual 兜住。
 *
 * 与主进程 main/fs-watcher.js 的 pathKey 策略保持一致 —— 双方都用
 * 「Windows / darwin 折叠，Linux 严格」。否则 main 侧 Map key 命中而 renderer
 * 侧路径比较 false，会出现「主进程 self-write filter 命中了，但 renderer
 * 还是把同一文件当成两份」的幽灵 bug。
 *
 * @param {string|null|undefined} a
 * @param {string|null|undefined} b
 * @returns {boolean}
 */
export function pathsEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return isCaseInsensitiveFs() ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * 当前文件系统是否大小写不敏感（Windows NTFS / macOS APFS 默认）。
 *
 * 与 isWindows 不同 —— Linux 上 ext4 / xfs 大小写敏感，但 macOS APFS（默认）
 * 是大小写不敏感的。APFS 也支持 case-sensitive 卷，但作为桌面 Electron 应用
 * 的最常见部署形态我们按默认 case-insensitive 处理，行为与 macOS Finder、
 * Terminal、`open` 命令一致。
 *
 * 注意：本函数跑在 renderer 里，process 不存在 —— 用 navigator.userAgentData
 * 替代 process.platform。
 *
 * @returns {boolean}
 */
function isCaseInsensitiveFs() {
  if (typeof navigator === 'undefined') return false;
  // Chromium 90+: userAgentData.platform 形如 'Windows' / 'macOS' / 'Linux'
  if (navigator.userAgentData && typeof navigator.userAgentData.platform === 'string') {
    const p = navigator.userAgentData.platform.toLowerCase();
    if (p.includes('win') || p.includes('macos') || p.includes('mac')) return true;
  }
  if (typeof navigator.platform === 'string' && navigator.platform) {
    if (/^(win|mac)/i.test(navigator.platform)) return true;
  }
  // 兜底：UA 字符串嗅探
  const ua = navigator.userAgent || '';
  return /Windows NT|Macintosh|Mac OS X/i.test(ua);
}

/**
 * 取路径所在目录（不含末尾分隔符）。
 * 纯字符串操作，renderer 里没有 path 模块可用。
 * @param {string} filePath
 * @returns {string}
 */
export function dirnameOf(filePath) {
  if (!filePath || typeof filePath !== 'string') return '';
  const idx = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  if (idx < 0) return '';
  // 保留 POSIX 根目录的那个 '/'
  if (idx === 0) return '/';
  return filePath.slice(0, idx);
}

/**
 * 取路径的最后一段（文件名）。
 * @param {string} filePath
 * @returns {string}
 */
export function basenameOf(filePath) {
  if (!filePath || typeof filePath !== 'string') return '';
  const idx = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  return idx < 0 ? filePath : filePath.slice(idx + 1);
}

/**
 * 把相对路径按 baseDir 解析成绝对路径，并折叠 '.' / '..'。
 *
 * 这里必须自己实现而不能简单地 split+join：POSIX 绝对路径的第一段是空串，
 * 过滤空串再 join 会把开头的 '/' 吃掉（'/home/a' → 'home/a'）。
 * 所以先记住「根前缀」（'/' 或 'C:\'），只对其后的段做折叠。
 *
 * @param {string} baseDir - 绝对目录
 * @param {string} relative - 相对路径（也接受绝对路径，此时原样规范化）
 * @returns {string|null} 绝对路径；越过根目录时返回 null
 */
export function resolvePath(baseDir, relative) {
  if (typeof relative !== 'string' || !relative) return null;

  const winAbs = /^[a-z]:[\\/]/i.test(relative);
  const posixAbs = relative.startsWith('/');
  const input = (winAbs || posixAbs) ? relative : `${baseDir}/${relative}`;

  // 提取根前缀：Windows 盘符 或 POSIX '/'
  let root = '';
  let rest = input;
  const driveMatch = /^([a-z]:)[\\/]/i.exec(input);
  if (driveMatch) {
    root = driveMatch[1] + '\\';
    rest = input.slice(driveMatch[0].length);
  } else if (input.startsWith('/')) {
    root = '/';
    rest = input.slice(1);
  }

  const sep = root.includes('\\') ? '\\' : '/';
  const stack = [];
  for (const part of rest.split(/[\\/]/)) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (stack.length === 0) return null; // 越过根目录 → 拒绝
      stack.pop();
    } else {
      stack.push(part);
    }
  }
  return root ? root + stack.join(sep) : stack.join(sep);
}

/**
 * Markdown 扩展名数组（小写、不含点）。
 * 来源：shared/extension-lists.js 经 preload contextBridge 暴露（window.api.MARKDOWN_EXTS）。
 * 这里仅做 fallback：preload 失败（极少见）时降级到硬编码 ['md','markdown']，
 * 不让 isMarkdownFile 抛错拖死 bootstrap。
 */
function getMarkdownExts() {
  const fromApi = (typeof window !== 'undefined') && window.api && window.api.MARKDOWN_EXTS;
  if (Array.isArray(fromApi)) return fromApi;
  return ['md', 'markdown'];
}

/**
 * 文件路径是否为 Markdown（按扩展名判定）。
 *
 * 大小写不敏感；隐藏文件（.gitignore）返回 false。
 *
 * @param {string} filePath
 * @returns {boolean}
 */
export function isMarkdownFile(filePath) {
  if (!filePath || typeof filePath !== 'string') return false;
  const name = basenameOf(filePath);
  // 隐藏文件 / 没有扩展名 / 末尾是点 → 不是 md
  if (!name || name.startsWith('.') || !name.includes('.')) return false;
  const dot = name.lastIndexOf('.');
  if (dot === name.length - 1) return false;
  const ext = name.slice(dot + 1).toLowerCase();
  return getMarkdownExts().includes(ext);
}

/**
 * 本地绝对路径 → file:// URL。
 * 用于把 markdown 里的相对图片路径改写成能被 <img> 真正加载的地址
 * （否则会相对 index.html 所在的应用目录解析，永远 404）。
 *
 * @param {string} absPath
 * @returns {string}
 */
export function toFileUrl(absPath) {
  if (!absPath || typeof absPath !== 'string') return '';
  let p = absPath.replace(/\\/g, '/');
  if (!p.startsWith('/')) p = '/' + p; // Windows 的 'C:/x' → '/C:/x'
  // 逐段编码，保留 '/'；# 和 ? 必须编码，否则会被当成 fragment / query
  const encoded = p.split('/').map(encodeURIComponent).join('/');
  // 盘符里的冒号不要留成 %3A —— 保持 file:///C:/... 这种 Chromium 最认的形式
  return 'file://' + encoded.replace(/^\/([a-z])%3A\//i, '/$1:/');
}

// 注：countWords 已迁移到 ./stats.js（CJK 友好词数 + 行数 + chars 的统一来源）。
