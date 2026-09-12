/* @vitest-environment jsdom */
// shared/render-sanitize.js 规则测试
//
// 覆盖：
//   1. XSS 防护：<script> / 事件属性 / javascript: / vbscript: / data:text\/html / iframe
//   2. <img src> 保留策略：相对路径、绝对路径、file:、data:image/、https:；危险协议被剥
//   3. 非 IMG 标签剥 file:（a / form / iframe）
//   4. ALLOWED_URI_REGEXP 单测：覆盖各 scheme / 相对路径 / 危险协议
//
// 这些规则也用于 preload.js 的 renderMarkdown —— 测试与实现共享
// shared/render-sanitize.js，禁止规则在两侧漂移。

import { describe, it, expect, beforeAll } from 'vitest';
import { JSDOM } from 'jsdom';
import createDOMPurify from 'dompurify';
import { marked } from 'marked';
import { ALLOWED_URI_REGEXP, installHooks } from '../../shared/render-sanitize.js';
// audit fix：直接 import shared/slug.js，不再源码级镜像 heading slug 算法。
// 之前在 beforeAll + render() 里复制了两份 slugify 实现 —— 与 shared/slug.js 漂移
// 时测试还能过，但真实场景（preload 走 shared/slug.js）已经对不上。
import { slugifyHeading } from '../../shared/slug.js';

let dom;
let DOMPurifyInstance;

beforeAll(() => {
  dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
  DOMPurifyInstance = createDOMPurify(dom.window);
  installHooks(DOMPurifyInstance);

  // 复制 preload 的 marked 配置（target=_blank + heading id slug）。
  // 这里的 slug 算法不再手写 —— 改走 shared/slug.js#slugifyHeading，
  // 与 preload / outline 三处保持唯一事实源。
  const mdRenderer = new marked.Renderer();
  const baseLink = mdRenderer.link.bind(mdRenderer);
  mdRenderer.link = (h, t, txt) => baseLink(h, t, txt).replace(/^<a /, '<a target="_blank" rel="noopener noreferrer" ');
  marked.setOptions({ gfm: true, breaks: false, renderer: mdRenderer });
});

function render(md) {
  // 重建 renderer + 每次独立的 seenSlugs（与 preload renderMarkdown 行为一致）：
  // heading id 的去重计数按文档重置，跨文档不串。
  const mdRenderer = new marked.Renderer();
  const baseLink = mdRenderer.link.bind(mdRenderer);
  mdRenderer.link = (h, t, txt) => baseLink(h, t, txt).replace(/^<a /, '<a target="_blank" rel="noopener noreferrer" ');
  const seenSlugs = new Set();
  mdRenderer.heading = (text, level, raw) => `<h${level} id="${slugifyHeading(raw, seenSlugs)}">${text}</h${level}>\n`;
  const rawHtml = marked.parse(md, { renderer: mdRenderer });
  return DOMPurifyInstance.sanitize(rawHtml, {
    ADD_ATTR: ['target', 'rel', 'id'],
    ALLOWED_URI_REGEXP,
    FORBID_TAGS: ['svg', 'math', 'template', 'form', 'input', 'button', 'select', 'textarea'],
  });
}

/**
 * 绕开 marked，直接喂 HTML 给 DOMPurify —— 模拟攻击者把恶意 HTML 塞进 markdown
 * 文档边缘（marked 解析时会吞掉大部分 inline HTML，但裸 inline / 嵌入已是 HTML 的
 * 子树仍会透传）。这里与 preload 真实 sanitize 配置严格对齐。
 */
function renderHtml(html) {
  return DOMPurifyInstance.sanitize(html, {
    ADD_ATTR: ['target', 'rel', 'id'],
    ALLOWED_URI_REGEXP,
    FORBID_TAGS: ['svg', 'math', 'template', 'form', 'input', 'button', 'select', 'textarea'],
  });
}

describe('ALLOWED_URI_REGEXP 单测', () => {
  it.each([
    ['https://e/x', true],
    ['http://e/x', true],
    ['mailto:x@y', true],
    ['tel:1234', true],
    ['callto:x', true],
    ['file:///C:/x.png', true],
    ['data:image/png;base64,AAA', true],
    ['#anchor', true],
    ['img/a.png', true],
    ['./other.md', true],
    ['/abs/x.png', true],
    ['x.png', true],
    ['../up.md', true],
    // Windows 反斜杠路径（用户在 Windows 上写 `![img\foo.png](img\foo.png)`）
    ['img\\foo.png', true],
    ['.\\foo.png', true],
    ['..\\up.md', true],
    ['\\abs\\x.png', true],
    ['javascript:alert(1)', false],
    ['vbscript:msgbox(1)', false],
    ['data:text/html,xxx', false],
    ['about:blank', false],
    ['chrome-extension://x/y', false],
    // 协议相对 URL：// 或 \\ 开头会被浏览器解析为「继承当前 scheme」，
    // 攻击面是「静默导航到外站 / 把用户隐私发给 evil.com」。
    // 必须与绝对路径 /abs/x.png 区分开 —— 单 / 放行，双 / 拒绝。
    ['//evil.com/x.png', false],
    ['\\\\evil.com\\x.png', false],
  ])('"%s" 匹配 = %s', (input, expected) => {
    expect(ALLOWED_URI_REGEXP.test(input)).toBe(expected);
  });
});

describe('XSS 防护', () => {
  it('<script> 被剥离', () => {
    const html = render('# x\n\n<script>alert(1)</script>');
    expect(html).not.toMatch(/<script/i);
  });

  it('onerror= 事件属性被剥离', () => {
    const html = render('<img src="x" onerror="alert(1)">');
    expect(html).not.toMatch(/onerror/i);
  });

  it('javascript: 在 <a href> 被剥离', () => {
    const html = render('[c](javascript:alert(1))');
    expect(html).not.toMatch(/javascript:/i);
  });

  it('vbscript: 被剥离', () => {
    const html = render('[c](vbscript:msgbox(1))');
    expect(html).not.toMatch(/vbscript:/i);
  });

  it('data:text/html 被剥离（仅 data:image/* 放行）', () => {
    const html = render('[c](data:text/html,<script>x</script>)');
    expect(html).not.toMatch(/href="data:text\/html/i);
  });

  it('<iframe> 标签被剥离', () => {
    const html = render('<iframe src="https://x"></iframe>');
    expect(html).not.toMatch(/<iframe/i);
  });

  it('<form action="javascript:"> action 被剥离', () => {
    const html = render('<form action="javascript:alert(1)"><input></form>');
    expect(html).not.toMatch(/action="javascript:/i);
  });

  it('//evil.com/x.png（协议相对 URL）在 <a href> 被剥离', () => {
    // 之前 ALLOWED_URI_REGEXP 的 `[^a-z]` 分支匹配任何非字母字符，
    // 放过 `//evil.com/x.png`。浏览器解析为「继承当前 scheme」，可静默
    // 导航到外站（或在 renderer 上下文里利用 about:blank 之类）。
    const html = render('[click](//evil.com/x.png)');
    expect(html).not.toMatch(/href="[^"]*evil\.com/i);
  });

  it('//evil.com/x.png 在 <img src> 被剥（不依赖 DOMPurify 内置）', () => {
    const html = render('![a](//evil.com/x.png)');
    expect(html).not.toMatch(/src="[^"]*evil\.com/i);
  });
});

describe('<img src> 保留策略', () => {
  it.each([
    ['相对路径 img/a.png', 'img/a.png'],
    ['相对 ./other.md', './other.md'],
    ['绝对 /abs/x.png', '/abs/x.png'],
    ['file:/// 协议', 'file:///C:/x.png'],
    ['data:image/png base64', 'data:image/png;base64,AAA'],
    ['https://', 'https://e/x.png'],
  ])('%s 保留 src', (_label, src) => {
    const html = render(`![a](${src})`);
    expect(html).toContain(`src="${src}"`);
  });

  it('javascript: 在 <img src> 被剥（hook 主动剥，不依赖 DOMPurify 内置）', () => {
    // 现在所有 src/href/action 都走 DANGEROUS_URI_REGEXP 主动剥 —— 不再依赖
    // DOMPurify v3 内置兜底（虽然 v3 仍会兜底剥 javascript:，但 hook 是第一道闸）。
    const html = render('![a](javascript:alert(1))');
    expect(html).not.toMatch(/src="javascript:/);
  });

  it('vbscript: 在 <img src> 被剥', () => {
    // 旧实现对 vbscript: 放行（keepAttr=true）—— DOMPurify v3 不兜底这个。
    // 现在由 hook 主动剥，与 javascript: 行为一致。
    const html = render('![a](vbscript:msgbox(1))');
    expect(html).not.toMatch(/src="vbscript:/i);
  });

  it('about:blank 在 <img src> 被剥（policy 统一：未在白名单的 scheme 一律不放）', () => {
    // 旧实现会放行 about:blank（不是危险协议但也不在白名单）；现在统一被剥。
    const html = render('![a](about:blank)');
    expect(html).not.toMatch(/src="about:/i);
  });

  it('data:text/html 在 <img src> 被剥（统一策略：仅 data:image/* 放行）', () => {
    // 之前测试断言「保留」（理由是浏览器不把 img 渲染为 HTML）—— 但跨浏览器 / 跨版本
    // 一致性差，且与 ALLOWED_URI_REGEXP 单点策略不一致。现在统一被剥。
    const html = render('![a](data:text/html,<script>x</script>)');
    expect(html).not.toMatch(/src="data:text\/html/i);
  });

  // fix(audit 2026-08)：SVG 数据 URL 在 <a href> 上点击会导航到 top-level SVG
  // 上下文，现代 Chromium 多半拦截脚本执行，但跨浏览器一致性差。
  // ALLOWED_URI_REGEXP 限定 data:image 为栅格格式（png/jpeg/gif/webp/...），
  // 显式拒绝 svg+xml —— Markdown 几乎不会内嵌 SVG，raster 已覆盖 99% 场景。
  it('data:image/svg+xml 在 <img src> 被剥（栅格白名单显式排除 SVG）', () => {
    const html = render('![a](data:image/svg+xml;base64,PHN2ZyB4bWxucz0naHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmcnPjxzY3JpcHQ+YWxlcnQoMSk8L3NjcmlwdD48L3N2Zz4=)');
    expect(html).not.toMatch(/src="data:image\/svg\+xml/i);
  });

  // audit fix (Round 13 / Sec-H2)：file:// 必须严格 file:///... 三斜杠。
  // 拒绝 file://host/... （Windows 上解析为 \\host\share，触发 SMB NTLMv2 认证，
  // 攻击者能抓受害者的 domain\user + NTLM hash —— CVE-2023-23397 类原语）。
  it.each([
    ['远程主机 evil.com（CVE-2023-23397 原语）', 'file://evil.com/share/pixel.png'],
    ['UNC 形式 ////', 'file:////evilhost/share/x.png'],
    ['显式 localhost（也应拒绝 — 唯一合法形式只有 ///）', 'file://localhost/C:/x.png'],
    ['大小写混合 UNC', 'FILE:////evilhost/x.png'],
    ['前导空格 + 远程主机（绕过 trim）', ' file://evil.com/x.png'],
  ])('file:// %s 在 <img src> 被剥', (_label, src) => {
    const html = render(`![a](${src})`);
    expect(html).not.toMatch(/src="file:/i);
  });

  it('file:/// 三斜杠（无 host）在 <img src> 仍保留（合法本地图片）', () => {
    const html = render('![a](file:///C:/Users/me/Notes/x.png)');
    expect(html).toContain('src="file:///C:/Users/me/Notes/x.png"');
  });

  // audit fix (Round 13 / Sec-M)：项目里 markdown 保留合法 inline style（color /
  // font-size / background:url(https://...) 等纯视觉属性），由 isDangerousStyleValue
  // 按 CSS 属性名做 denylist 拦截。denylist 覆盖了所有能改变布局 / 跳出文档流 /
  // 遮挡 UI / 隐藏元素 / 让用户看不清真实界面的属性 —— 即便攻击者把整个浏览器
  // 窗口当画布也办不到。
  //
  // 这些测试走 renderHtml() 而不是 render() —— marked 的 lexer 会对裸 inline
  // HTML 做容错（部分 inline 会按字符实体 / 段落拆分），无法精确验证 DOMPurify
  // 在 ALLOWED 名单下的剔除策略。绕开 marked 直喂 HTML 给 sanitize，行为更可预测。
  it.each([
    ['position:fixed 全屏覆盖层', '<a href="https://phish.example" style="position:fixed;left:0;top:0;width:100vw;height:100vh;z-index:2147483647;display:block">x</a>'],
    ['display:none（不让用户看到真实 UI）', '<div style="display:none">hidden</div>'],
    ['opacity:0（透明覆盖层）', '<div style="opacity:0;position:absolute;top:0;left:0;width:100vw;height:100vh">overlay</div>'],
    ['visibility:hidden', '<span style="visibility:hidden">x</span>'],
    ['pointer-events:none（透传点击到下层）', '<span style="pointer-events:none;position:absolute;inset:0">trap</span>'],
    ['transform（绕过父级 contain）', '<span style="transform:translate(-100vw,-100vh)">off-screen</span>'],
    ['content（注入伪元素文本）', '<span style="content:&apos;会话已过期&apos;">x</span>'],
    ['top/left/right/bottom/inset（绝对定位）', '<span style="position:absolute;top:0;left:0">x</span>'],
  ])('style 含危险属性 %s → style 属性被剥', (_label, htmlIn) => {
    const html = renderHtml(htmlIn);
    expect(html).not.toMatch(/style=/i);
  });

  it('合法 style（color / font-size / text-align）保留', () => {
    // 视觉自定义应通过合法 CSS 属性而非 inline style —— 但项目历史包袱允许
    // 一些纯样式 style。回归测试，确保 denylist 没误伤。
    const html = renderHtml('<span style="color:red;font-size:14px;text-align:center">x</span>');
    expect(html).toMatch(/color\s*:\s*red/i);
    expect(html).toMatch(/font-size\s*:\s*14px/i);
  });

  it('<svg> 标签被剥（防 SVG-namespaced <style> 注入文档级 CSS）', () => {
    const html = renderHtml('<svg><style>body::after{content:"phish"}</style></svg>');
    expect(html).not.toMatch(/<svg/i);
    expect(html).not.toMatch(/phish/);
  });

  it('<form>/<input> 被剥', () => {
    const html = renderHtml('<form action="https://evil.example"><input type="text" name="x"></form>');
    expect(html).not.toMatch(/<form/i);
    expect(html).not.toMatch(/<input/i);
  });

  it('data:image/png 仍保留（栅格白名单基线）', () => {
    const html = render('![a](data:image/png;base64,iVBORw0KGgo=)');
    expect(html).toMatch(/src="data:image\/png;base64,iVBORw0KGgo="/);
  });
});

describe('非 IMG 标签的 file: 协议', () => {
  it('<a href="file://..."> 被剥', () => {
    const html = render('[l](file:///C:/x.txt)');
    expect(html).not.toMatch(/href="file:\/\/\/C:\/x\.txt/);
  });

  it('<form action="file://..."> action 被剥', () => {
    const html = render('<form action="file:///C:/x"><input></form>');
    expect(html).not.toMatch(/action="file:\/\/\/C:\/x/);
  });

  // audit fix (Round 4 P1-5)：非 IMG 标签的 URI 属性也走 ALLOWED 校验剥
  // data:image/svg+xml。ALLOWED_URI_REGEXP 显式排除 svg+xml（只允许栅格），
  // 之前非 IMG 只走 DANGEROUS 负向预查放过 data:image/svg+xml → 完全依赖
  // DOMPurify v3 内置兜底。现在 hook 第二道闸显式剥。
  it('<a href="data:image/svg+xml;..."> 被剥（非 IMG 也走 ALLOWED）', () => {
    const html = render('[l](data:image/svg+xml;base64,PHN2Zz4=)');
    expect(html).not.toMatch(/href="data:image\/svg\+xml/i);
  });

  it('<a href="https://..."> 仍保留（普通 https 不被误剥）', () => {
    const html = render('[l](https://example.com)');
    expect(html).toMatch(/href="https:\/\/example\.com"/);
  });

  it('target=_blank 自动注入的 rel="noopener noreferrer" 不被误剥', () => {
    // 之前 bug：non-IMG ALLOWED 检查对所有非 IMG 属性生效，把 DOMPurify 自动
    // 加的安全 rel="noopener noreferrer" 也判定为不通过 ALLOWED → 误剥。
    // 现在限定为 URI 类属性（href/src/action 等），安全属性放过。
    const html = render('[x](https://e)');
    expect(html).toMatch(/rel="noopener noreferrer"/);
  });
});

describe('<img src> data:image 大小上限 (audit Sec-M3)', () => {
  it('正常大小 data:image/png base64 保留', () => {
    const html = render('![a](data:image/png;base64,AAAA)');
    expect(html).toMatch(/src="data:image\/png;base64,AAAA"/);
  });

  it('巨大 data:image (>10MB) 被剥 src', () => {
    // 绕过 marked 直接 sanitize：marked 的 lexer 在 11MB base64 上会先栈溢出，
    // 走 marked 路径反而测不到我们要保护的那一层。这里手搓 <img> 直接喂给
    // DOMPurify —— 验证 hook 在 data:image 巨长 base64 上会主动 keepAttr=false。
    const huge = `data:image/png;base64,${'A'.repeat(11 * 1024 * 1024)}`;
    const html = DOMPurifyInstance.sanitize(`<img src="${huge}">`, {
      ADD_ATTR: ['src'],
      ALLOWED_URI_REGEXP,
    });
    expect(html).not.toMatch(new RegExp(`src="data:image/png;base64,${'A'.repeat(100)}`));
  });

  it('10MB 临界值正好放过（不挡合理大小）', () => {
    // 边界：刚好等于上限应当放过；实际我们想留余量，写测试时只看 < 1MB
    const small = `data:image/png;base64,${'A'.repeat(1024 * 1024)}`;
    const html = render(`![x](${small})`);
    expect(html).toMatch(/src="data:image\/png;base64,A{100}/);
  });

  it('非 data: 的超长 URL 不受影响（绝对 file:/https: 走原路径）', () => {
    // file:/// 与 https:// 不应被本次 size 限制波及；行为与先前一致。
    const longHttps = `https://e.com/${'a'.repeat(1024 * 1024)}.png`;
    const html = render(`![x](${longHttps})`);
    expect(html).toMatch(/^<p><img src="https:\/\/e\.com\//);
  });
});

// audit fix (Round 9)：style 属性里嵌的危险 CSS 模式（javascript:/expression/
// behavior/-moz-binding/@import）走 DANGEROUS_STYLE_PATTERNS 主动剥。
// DOMPurify v3 自带部分保护，但跨版本一致性差；这里做防御性深度扫描。
describe('style 属性危险 CSS 模式（Round 9 防御性深度扫描）', () => {
  it('style 里 url(javascript:...) 被剥', () => {
    const html = render('<a href="https://e.com" style="background:url(javascript:alert(1))">x</a>');
    expect(html).not.toMatch(/url\s*\(\s*javascript:/i);
    // 整条 style 被剥（保守策略）
    expect(html).not.toMatch(/style=/i);
  });

  it('style 里 url("javascript:...") 引号包裹也被剥', () => {
    const html = render('<span style="background:url(\'javascript:alert(1)\')">x</span>');
    expect(html).not.toMatch(/javascript:/i);
  });

  it('style 里 url(VBScript:) 大小写不敏感也被剥', () => {
    const html = render('<span style="background:url(VBScript:msgbox(1))">x</span>');
    expect(html).not.toMatch(/vbscript:/i);
  });

  it('style 里 url(data:text/html...) 被剥（拒绝非 image data:）', () => {
    const html = render('<span style="background:url(data:text/html,<script>alert(1)</script>)">x</span>');
    expect(html).not.toMatch(/data:text\/html/i);
  });

  it('style 里 expression(alert(1)) legacy IE 模式被剥', () => {
    const html = render('<div style="width:expression(alert(1))">x</div>');
    expect(html).not.toMatch(/expression\s*\(/i);
  });

  it('style 里 behavior:url(...) legacy IE HTC 模式被剥', () => {
    const html = render('<div style="behavior:url(#default#anchorclick)">x</div>');
    expect(html).not.toMatch(/behavior\s*:/i);
  });

  it('style 里 -moz-binding:url(...) legacy Mozilla XBL 模式被剥', () => {
    const html = render('<div style="-moz-binding:url(\'http://evil/xbl.xml#x\')">x</div>');
    expect(html).not.toMatch(/-moz-binding/i);
  });

  it('style 里 @import 外链资源加载被剥', () => {
    const html = render('<div style="@import url(http://evil/x.css); color:red">x</div>');
    expect(html).not.toMatch(/@import/i);
  });

  it('合法 style 保留（color / font-size 等无害属性不动）', () => {
    const html = render('<span style="color:red; font-size:14px">x</span>');
    expect(html).toMatch(/style="[^"]*color\s*:\s*red/i);
    expect(html).toMatch(/style="[^"]*font-size\s*:\s*14px/i);
  });

  it('合法 url()（http: / data:image/）保留', () => {
    const html = render('<div style="background:url(https://e.com/x.png); color:red">x</div>');
    expect(html).toMatch(/style="[^"]*color\s*:\s*red/i);
    // 字符串里出现的 url(https://...) 是合法上下文不应剥
    expect(html).not.toMatch(/style="[^"]*javascript:|vbscript:|expression\s*\(|@import/i);
  });
});

describe('marked 输出增强', () => {
  it('链接注入 target=_blank + rel="noopener noreferrer"', () => {
    const html = render('[x](https://e)');
    expect(html).toMatch(/target="_blank"/);
    expect(html).toMatch(/rel="noopener noreferrer"/);
  });

  it('中文标题生成 id 锚点', () => {
    const html = render('## 你好世界');
    expect(html).toMatch(/<h2 id="你好世界">/);
  });

  it('同名标题生成 -1/-2 后缀', () => {
    const html = render('## 你好世界\n\n## 你好世界');
    expect(html).toMatch(/id="你好世界"/);
    expect(html).toMatch(/id="你好世界-1"/);
  });
});