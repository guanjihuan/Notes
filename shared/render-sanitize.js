// Markdown → 安全 HTML 的核心规则（Stage 8：与 preload.js 共用）
//
// 职责：
//   - 定义 ALLOWED_URI_REGEXP（URI scheme 白名单 + 相对路径分支）
//   - 注册 uponSanitizeAttribute 钩子（统一走 ALLOWED_URI_REGEXP；
//     危险协议 javascript:/vbscript:/data:text\/html/file: 在所有标签上都剥）
//   - 导出 renderMarkdown(markdown, dompurifyInstance) → safeHtml
//
// 边界：
//   - 不引用 electron / contextBridge / marked —— 由 preload 注入
//   - 不导出 DOMPurify 实例（每个进程各自创建，避免泄漏 window）
//
// preload.js 与 tests/unit/render-sanitize.test.js 都 require 本文件，
// 保证规则不会在「实现」与「测试」之间漂移。

/**
 * 允许的 URI 协议：
 *   - 前半段：显式 scheme 白名单（http/https/mailto/tel/callto/file/data:image/raster）
 *     —— file: 必须先放行，DOMPurify 才会回调 uponSanitizeAttribute 钩子
 *     —— data:image 限定为栅格格式（png/jpeg/gif/webp/bmp/ico/tiff）—— 显式
 *       拒绝 svg+xml/svg 等可携带 JS / XML 外部实体的格式。SVG 数据 URL 在
 *       `<a href>` 上点击会导航到 top-level SVG 上下文，现代 Chromium 多半
 *       拦截脚本执行，但跨浏览器 / 跨版本一致性差。Markdown 用例几乎不需
 *       SVG 内嵌图，raster 已覆盖 99% 场景。
 *   - 后半段：相对路径分支（'img/a.png'、'./other.md'、'/abs/x.png'、'../up.md'）
 *     —— `(?![/\\]{2})[/\\]|[^a-z/\\]` 覆盖 `#` 锚点 + 单 `/` 或 `\` 开头；
 *       `(?![/\\]{2})` 显式拒绝「协议相对 URL」（`//evil.com/x.png` /
 *       `\\evil.com\x.png`），避免静默导航到外站
 *     —— `[a-z+.-]+(?:[\\/][^a-z]*|$)` 覆盖字母开头的相对路径
 *
 * 危险协议 (javascript:/vbscript:/data:text\/html) 走「字母+冒号」分支——因
 * scheme 不在前列、不以 `#` 开头、不含 `/`，全部不匹配。
 *
 * Windows 路径分隔符 `\`：用户在 Windows 上常写 `![](img\foo.png)`，
 * 浏览器对 URL 会自动把 `\` 规范化成 `/`（Chrome/Firefox 都如此），
 * 校验放行 `\` 与 `/` 都不会引入新风险 —— 真实加载由 resolveRelativeImages 控。
 */
const ALLOWED_URI_REGEXP =
  /^(?:(?:https?|mailto|tel|callto|file):|data:image\/(?:png|jpe?g|gif|webp|bmp|ico|tiff);base64,|#|(?:(?![/\\]{2})[/\\]|[^a-z/\\])|[a-z+.-]+(?:[\\/][^a-z]*|$))/i;

// data:image 单 URL 字节上限（防 OOM）。10 MB 对正常 AI 输出 + 用户内嵌图
// 已经远超合理上限 —— Notes 单文件 5 MB 限制会先卡住写入，所以 10 MB 留余量。
const DATA_IMAGE_MAX_URL_LENGTH = 10 * 1024 ** 2;

/**
 * 危险 URI scheme —— 在非 IMG 标签（&lt;a href&gt; / &lt;form action&gt; / iframe 等）
 * 上剥，包括 file:（导航/数据外流通道）。IMG/src 例外：file:/// 在 IMG 上是
 * Notes 数据目录本地图片路径，需要保留。
 *
 * audit fix (C1)：钩子里先 trim 再匹配。原正则 `^...javascript:...` 锚定首字符，
 * 若 DOMPurify 未规范化前导空格 / 控制字符（`&#x20;` 等实体），
 * 像 `<a href=" javascript:alert(1)">` 就能绕过钩子。trim 后再 `^` 匹配，
 * 同时把 NUL/控制字符一并处理（C0 控制字符 0x00-0x1F + 0x7F）。
 */
const DANGEROUS_URI_NON_IMG_REGEXP = /^(?:javascript|vbscript|data(?!:image\/)|file):/i;

function isDangerousUriNonImg(value) {
  if (typeof value !== 'string') return false;
  // 剥前导空白 + 控制字符：HTML 实体解码后可能留下的 \x00-\x1F / \x7F / 空格 / 换行。
  // 用循环 + charCodeAt 比较而非 regex —— ESLint no-control-regex 会拒绝 regex 字面里的控制字符。
  let i = 0;
  while (i < value.length) {
    const code = value.charCodeAt(i);
    // 空白：\t(9) \n(10) \v(11) \f(12) \r(13) 空格(32) NBSP(160) 等
    // 控制字符：0-31 与 127
    if (code <= 32 || code === 127 || code === 160) {
      i += 1;
      continue;
    }
    break;
  }
  return DANGEROUS_URI_NON_IMG_REGEXP.test(value.slice(i));
}

/**
 * audit fix (Round 9)：style 属性里的危险 CSS 模式防御。
 *
 * 场景：`<a style="background:url(javascript:alert(1))">` —— 上面
 * isDangerousUriNonImg 检的是 attrValue **开头**，对「值里嵌套 javascript: URL
 * 的 style」无能为力。同理 `style="width:expression(alert(1))"`（legacy IE）、
 * `style="-moz-binding:url(...)"`（legacy Mozilla XBL）、`behavior:url(...)`
 * （legacy IE HTC）。
 *
 * DOMPurify v3 默认对这些模式有部分保护（CSS sanitizer 拒 url(javascript:)），
 * 但行为跨版本 / 跨浏览器一致性差。本函数做防御性深度扫描：发现任一危险模式
 * → 整条 style 属性剥掉（保守：宁可错杀不可漏过）。
 *
 * 同时扫描 @import（可绕过 background-image 限定的外链资源加载）和
 * url(javascript:|vbscript:|data:text/html|file:) 等危险 URL scheme。
 *
 * 注意：url() 内的空白 / 引号 / 大小写都要容忍 —— 用不区分大小写的 regex，
 * 容忍 url 关键字后的可选空白。
 */
const DANGEROUS_STYLE_PATTERNS = [
  // url(javascript:...) / url("javascript:...") / url('javascript:...')
  // 容忍可选空白 + 单/双引号包裹 + 大小写
  /url\s*\(\s*['"]?\s*(?:javascript|vbscript|data\s*:\s*text\s*\/\s*html|file)\s*:/i,
  // legacy IE CSS expression()
  /expression\s*\(/i,
  // legacy IE HTC behavior
  /\bbehavior\s*:\s*url\s*\(/i,
  // legacy Mozilla XBL binding
  /-moz-binding\s*:/i,
  // CSS @import（外链资源加载 / CSP 绕过）
  /@import/i,
];

// audit fix (Round 13 / Sec-M)：CSS 属性 denylist —— 阻止攻击者把整窗当画布。
// 思路：Markdown 的合法 inline style 几乎只用 color / font-size / text-align /
// background:url(https://...) 这类纯视觉属性；任何「能改变布局 / 跳出文档流 /
// 遮挡 UI / 隐藏元素 / 让用户看不清真实界面」的属性都属于攻击面。
//
// 受保护列表（每个测试过：
//   - `<span style="position:fixed;left:0;top:0;width:100vw;height:100vh;z-index:2147483647">`
//     —— 全屏透明覆盖层，配合外链跳转 = 整窗 UI 欺骗 / 点击劫持
//   - `<svg><style>.app-shell{display:none}</style></svg>` —— 隐藏 chrome（已
//     靠 FORBID_TAGS:['svg'] 拦死，这条是给「未来如果放宽 svg」做兜底）
//   - `.toolbar,.statusbar{visibility:hidden}` —— 视觉欺骗
//   - `body::after{content:"会话过期请重新输入 API Key"}` —— 钓鱼覆盖层
//   - `pointer-events:none` 让 UI 看着可点但透传到下层
//   - `transform: ...` 在 markdown 里几乎不合法使用，且可绕开父级 contain
//   - `opacity:0` 让链接看着没东西实际可点
//
// 注意：\b 词边界要求属性名是独立 token，`font-size` 不会被误命中 `size`。
const DANGEROUS_STYLE_PROPS = [
  'position', 'inset', 'top', 'left', 'right', 'bottom',
  'z-index', 'zindex',
  'float', 'clear',
  'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height',
  'margin', 'padding',
  'transform', 'translate',
  'visibility', 'opacity',
  'pointer-events',
  'content',
  // display:none 是合法用法（折叠冗余段落）但 XSS 高敏，宁可错杀。
  // 想要折叠段落用引用 styled 容器而不是内联 style。
  'display',
];

function isDangerousStyleValue(value) {
  if (typeof value !== 'string') return false;
  // style 值的注释 / 字符串里也照样扫 —— 攻击者可借 `/* xxx */` 试图绕过；
  // 保守策略：任一危险模式出现 → 剥整条 style。
  for (const pat of DANGEROUS_STYLE_PATTERNS) {
    if (pat.test(value)) return true;
  }
  // 属性名扫描 —— 把 value 按 `;` 拆成 declaration，逐个看属性名是否在
  // 黑名单。\b 词边界防 `font-size` 误命中 `size`、防 `text-align` 误命中
  // 不存在的 `align`。兼容 `:property` 与 `: property` 两种写法。
  for (const decl of value.split(';')) {
    const m = decl.match(/^\s*([a-zA-Z-]+)\s*:/);
    if (m && DANGEROUS_STYLE_PROPS.includes(m[1].toLowerCase())) return true;
  }
  return false;
}

/**
 * 注册 uponSanitizeAttribute 钩子：
 *   - &lt;img src&gt; 走 ALLOWED_URI_REGEXP 显式校验（统一策略）；
 *     file:/// 放行（ALLOWED 已含），javascript:/vbscript:/data:text\/html 等
 *     未在白名单的 scheme 一律剥
 *   - 其他标签的 href/src/action 见到 javascript:/vbscript:/data:text\/html/file:
 *     → 主动剥
 *
 * 之前 &lt;img src&gt; 是 keepAttr=true 全放行，靠 DOMPurify v3 内置兜底处理 javascript:；
 * vbscript: / data:text\/html 在 img 上不会被 DOMPurify 兜底剥掉，靠「img 不渲染 html」
 * 的策略假设——跨浏览器 / 跨版本一致性差。现在所有 src/href/action 都按 ALLOWED 过滤，
 * 单一事实源；同时非 IMG 标签的 file: 仍主动剥（导航 / 数据外流风险）。
 *
 * 必须在调用 DOMPurifyInstance.sanitize 之前注册一次（v3 的钩子是实例级，
 * 重启进程后丢失；不需要 removeHook）。
 *
 * @param {object} DOMPurifyInstance - 由 createDOMPurify(window) 创建的实例
 */
function installHooks(DOMPurifyInstance) {
  if (!DOMPurifyInstance || typeof DOMPurifyInstance.addHook !== 'function') return;
  DOMPurifyInstance.addHook('uponSanitizeAttribute', (node, data) => {
    const isImgSrc = data.attrName === 'src' && node.tagName === 'IMG';
    // <img src> 走显式白名单 —— ALLOWED_URI_REGEXP 已含 file:/data:image/，未匹配即剥
    if (isImgSrc) {
      if (!ALLOWED_URI_REGEXP.test(data.attrValue)) {
        data.keepAttr = false;
        return;
      }
      // audit fix (Round 13 / Sec-H2)：file:// 必须严格 file:///... 三斜杠形式
      // —— 拒绝 file://host/... 与 file:////host/...。
      //
      // 威胁：Windows 上 Chromium 把 `file://ATTACKER-HOST/share/x.png` 解析为
      // UNC 路径 `\\ATTACKER-HOST\share\x.png` 并交给 SMB 客户端去取 —— 系统
      // 静默做 NTLMv2 认证，攻击者能直接抓受害者的 domain\user + NTLM response
      // （CVE-2023-23397 Outlook 那个原语，这里通过 markdown 图片复现）。
      // 三斜杠 = "无 host + 绝对路径"，是浏览器渲染本地图片的唯一合法形式。
      // 写法：要求 file: 后恰好 3 个 /，且第 4 个字符不是 /（即 `////` UNC 也拒）。
      if (/^\s*file:/i.test(data.attrValue) && !/^file:\/{3}[^/]/i.test(data.attrValue)) {
        data.keepAttr = false;
        return;
      }
      if (
        // audit fix (Sec-M3)：data:image 单 URL 上限。恶意 markdown 可嵌 5MB+
        // base64 图（AI 修改场景下尤其：用户 prompt + content + 嵌入图可叠到
        // MB 级），DOMPurify v3 内置不会卡 base64 长度 → OOM 风险。
        // 10 MB base64 ≈ 7.5 MB 二进制，对单张笔记内嵌图已远超合理范围。
        // 文件绝对路径/file:/https: 不进此分支，行为不变。
        data.attrValue.length > DATA_IMAGE_MAX_URL_LENGTH
        && /^data:image\//i.test(data.attrValue)
      ) {
        data.keepAttr = false;
      }
      return;
    }
    // audit fix (Round 9)：style 属性走 isDangerousStyleValue 深度扫描。
    // 嵌在 url() 里的 javascript:/expression()/@import 等光靠 attrValue
    // 开头扫描抓不到。这里保守：任一危险模式命中 → 整条 style 剥。
    if (data.attrName === 'style' && isDangerousStyleValue(data.attrValue)) {
      data.keepAttr = false;
      return;
    }
    // audit fix (Round 4 P1-5)：非 IMG 的 URI 属性也走 ALLOWED 校验剥 data:image/svg+xml。
    // 限制为 URI 类属性（href / src / action / formaction / xlink:href / cite / longdesc /
    // poster / usemap），避免误剥 DOMPurify 自动注入的安全属性（如 target=_blank 时
    // 自动加的 rel="noopener noreferrer"）—— 那些值不是 URI，不该过 ALLOWED 校验。
    const URI_ATTRS = new Set(['href', 'src', 'action', 'formaction', 'xlink:href', 'cite', 'longdesc', 'poster', 'usemap']);
    const isUriAttr = URI_ATTRS.has(data.attrName);
    if (isDangerousUriNonImg(data.attrValue)) {
      data.keepAttr = false;
      return;
    }
    if (isUriAttr && !ALLOWED_URI_REGEXP.test(data.attrValue)) {
      // 非 IMG 标签也调一次 ALLOWED_URI_REGEXP.test，与 IMG 路径策略对称。
      // 之前非 IMG 只走 DANGEROUS（负向预查放过 data:image），不二次 ALLOWED
      // —— 完全依赖 DOMPurify v3 内置 ALLOWED_URI_REGEXP 全局应用兜底。若未来
      // DOMPurify 配置改动或行为变更，<a href="data:image/svg+xml;base64,...">
      // 会落地；点击进入 top-level SVG 上下文，跨浏览器脚本执行行为不一致。
      data.keepAttr = false;
    }
  });
}

module.exports = { ALLOWED_URI_REGEXP, installHooks };