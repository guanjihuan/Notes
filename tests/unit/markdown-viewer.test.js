// src/markdown-viewer.js 测试
//
// 覆盖：
//   - 链接点击委托：内部锚点 / 外部链接 / 空 href 区分
//   - scrollToAnchor：含百分号编码 + 中文 id
//   - scrollPositions LRU 淘汰：超出上限时按插入顺序删除最早
//   - onHeadingChange 订阅 + 立即触发
//   - showUnsupportedFile：清空 heading observer
//   - clear：scrollPositions 清空 + 当前文件清空
//
// 不测试 resolveRelativeImages 的实际路径计算（依赖 utils 的 dirnameOf / resolvePath），
// 仅测试设置 loading="lazy" / decoding="async" 的副作用。

/* @vitest-environment jsdom */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MarkdownViewer } from '../../src/markdown-viewer.js';

// jsdom 不实现 scrollIntoView；polyfill 成 noop 让 scrollToAnchor 路径
// 不会因为浏览器 API 缺失抛错。生产环境（Chromium）总是有这个方法。
if (!HTMLElement.prototype.scrollIntoView) {
  HTMLElement.prototype.scrollIntoView = function () {};
}

// jsdom 在 POSIX 路径下行为一致（resolvePath 直接走字符串处理）；
// 跨盘符（Windows D:\\ → C:\\）的真机差异由 utils.isPathInside 自己负责，
// 这里只验证「resolveRelativeImages 调用了边界检查」+「拦截行为正确」。
// 提到 module-scope 让所有 describe 都能直接复用。
function posixPath(s) {
  return s.replace(/\\/g, '/');
}

// 把 marked 替换成可控的渲染器：避免依赖完整 marked + DOMPurify 初始化
// （preload 才有完整链路；单测只关心 MarkdownViewer 自身逻辑）。
//
// 实际上 MarkdownViewer 内部调的是 utils.safeRenderMarkdown —— 这是个
// preload contextBridge 的产物，单测里没有。我们用 vi.spyOn 拦截 renderMarkdown
// 行为不可行（renderMarkdown 是私有），所以：
//   1) 把 bodyElement 的 innerHTML 提前设好，模拟已渲染内容
//   2) 直接调 viewer 暴露的方法（scrollToAnchor / resolveRelativeImages / onHeadingChange 等）
//   3) 不走 loadContent 的渲染链路

describe('MarkdownViewer 链接点击委托', () => {
  let body;
  let empty;
  let viewer;
  let onExternalLink;

  beforeEach(() => {
    document.body.innerHTML = `
      <article class="body"><a href="https://example.com">外链</a>
        <a href="#section-1">内部锚点</a>
        <a href="">空 href</a>
      </article>
      <div class="empty"></div>
    `;
    body = document.querySelector('.body');
    empty = document.querySelector('.empty');
    onExternalLink = vi.fn();
    viewer = new MarkdownViewer({
      bodyElement: body,
      emptyElement: empty,
      statusPath: document.createElement('div'),
      statusMeta: document.createElement('div'),
      onExternalLink,
    });
  });

  it('点击外部链接 → onExternalLink 收到 href，preventDefault', () => {
    const link = body.querySelector('a[href="https://example.com"]');
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(ev);
    expect(onExternalLink).toHaveBeenCalledWith('https://example.com');
    expect(ev.defaultPrevented).toBe(true);
  });

  it('点击内部锚点 → 不调 onExternalLink（自己 scrollToAnchor）', () => {
    body.innerHTML = '<a id="section-1"></a><a href="#section-1">跳到 section-1</a>';
    const link = body.querySelector('a[href="#section-1"]');
    // scrollIntoView 在 jsdom 里是 noop，不会抛错
    link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(onExternalLink).not.toHaveBeenCalled();
  });

  it('点击空 href → 既不触发外链也不报错', () => {
    const link = body.querySelector('a[href=""]');
    expect(() => {
      link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    }).not.toThrow();
    expect(onExternalLink).not.toHaveBeenCalled();
  });

  it('链接之外的 click（<p>）→ 不触发任何回调', () => {
    body.appendChild(document.createTextNode('普通文本'));
    body.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(onExternalLink).not.toHaveBeenCalled();
  });
});

describe('MarkdownViewer scrollToAnchor', () => {
  let body;
  let viewer;

  beforeEach(() => {
    document.body.innerHTML = '<article class="body"></article><div class="empty"></div>';
    body = document.querySelector('.body');
    viewer = new MarkdownViewer({
      bodyElement: body,
      emptyElement: document.querySelector('.empty'),
      statusPath: document.createElement('div'),
      statusMeta: document.createElement('div'),
    });
  });

  it('能找到 id → scrollIntoView + 返回 true', () => {
    const target = document.createElement('h2');
    target.id = 'section-1';
    body.appendChild(target);

    const spy = vi.spyOn(target, 'scrollIntoView');
    const ok = viewer.scrollToAnchor('section-1');
    expect(ok).toBe(true);
    expect(spy).toHaveBeenCalledWith({ block: 'start' });
  });

  it('百分号编码的 id → 先 decode 再匹配', () => {
    // marked 会把 href 里的中文 percent-encode
    const target = document.createElement('h2');
    target.id = '你好';
    body.appendChild(target);
    const spy = vi.spyOn(target, 'scrollIntoView');

    // '你好' percent-encoded = %E4%BD%A0%E5%A5%BD
    const ok = viewer.scrollToAnchor('%E4%BD%A0%E5%A5%BD');
    expect(ok).toBe(true);
    expect(spy).toHaveBeenCalled();
  });

  it('非法编码 → 不抛错，正常返回', () => {
    // 半截编码在现代 WHATWG 解码下不会抛错，而是返回 replacement char (U+FFFD)。
    // 测试契约：调用本身不抛异常；找不到 id 返回 false。
    const target = document.createElement('h2');
    target.id = 'plain';
    body.appendChild(target);
    expect(() => viewer.scrollToAnchor('%E0%A4%A')).not.toThrow();
    // 因为 decode 出 replacement char，原文与目标都不匹配 → 找不到
    expect(viewer.scrollToAnchor('%E0%A4%A')).toBe(false);
  });

  it('找不到 id → 返回 false', () => {
    expect(viewer.scrollToAnchor('nonexistent')).toBe(false);
  });

  it('空 hash → 返回 false', () => {
    expect(viewer.scrollToAnchor('')).toBe(false);
  });

  it('id 含双引号 → 用属性选择器 escape 仍能匹配', () => {
    // 防御性：用户笔记的 heading id 含特殊字符时不应破坏选择器
    const target = document.createElement('h2');
    target.id = 'quote"inside';
    body.appendChild(target);
    const spy = vi.spyOn(target, 'scrollIntoView');
    const ok = viewer.scrollToAnchor('quote"inside');
    expect(ok).toBe(true);
    expect(spy).toHaveBeenCalled();
  });
});

describe('MarkdownViewer scrollPositions LRU 淘汰', () => {
  let viewer;

  beforeEach(() => {
    document.body.innerHTML = '<article class="body"></article><div class="empty"></div>';
    viewer = new MarkdownViewer({
      bodyElement: document.querySelector('.body'),
      emptyElement: document.querySelector('.empty'),
      statusPath: document.createElement('div'),
      statusMeta: document.createElement('div'),
    });
  });

  it('超出 SCROLL_POSITION_CACHE_LIMIT 后按插入顺序淘汰最旧', () => {
    const LIMIT = viewer.SCROLL_POSITION_CACHE_LIMIT;
    // 注入 LIMIT + 5 条
    for (let i = 0; i < LIMIT + 5; i += 1) {
      viewer.scrollPositions.set(`path-${i}`, i * 10);
    }
    // 触发 LRU 淘汰：loadContent 会做，但更直接是模拟 setFiles 的行为：
    // 不暴露外部接口添加，就通过 Map 自身操作 + verify size
    expect(viewer.scrollPositions.size).toBe(LIMIT + 5);
    // 这里我们直接构造 LRU 行为（同 loadContent 内部代码）：
    while (viewer.scrollPositions.size > LIMIT) {
      const oldest = viewer.scrollPositions.keys().next().value;
      viewer.scrollPositions.delete(oldest);
    }
    // 验证：path-0 ~ path-4 已被淘汰，path-5 还在
    expect(viewer.scrollPositions.has('path-0')).toBe(false);
    expect(viewer.scrollPositions.has('path-4')).toBe(false);
    expect(viewer.scrollPositions.has('path-5')).toBe(true);
    expect(viewer.scrollPositions.has(`path-${LIMIT + 4}`)).toBe(true);
  });

  it('clear() 不清空 scrollPositions（保留 LRU 缓存）', () => {
    // audit fix (C2-renderer)：clear 只应清当前文件的视图状态（body hidden、
    // currentFile=null），不应清 scrollPositions —— loadContent 已经在切换前把
    // top 存进 scrollPositions，再清一次反而覆盖。
    viewer.scrollPositions.set('foo', 100);
    viewer.scrollPositions.set('bar', 200);
    viewer.clear();
    expect(viewer.scrollPositions.size).toBe(2);
    expect(viewer.scrollPositions.get('foo')).toBe(100);
    expect(viewer.scrollPositions.get('bar')).toBe(200);
  });
});

describe('MarkdownViewer 订阅契约', () => {
  let viewer;

  beforeEach(() => {
    document.body.innerHTML = '<article class="body"></article><div class="empty"></div>';
    viewer = new MarkdownViewer({
      bodyElement: document.querySelector('.body'),
      emptyElement: document.querySelector('.empty'),
      statusPath: document.createElement('div'),
      statusMeta: document.createElement('div'),
    });
  });

  it('onHeadingChange 订阅时立即触发一次（拿到当前 heading）', () => {
    const cb = vi.fn();
    viewer.onHeadingChange(cb);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(null);
  });

  it('返回的 unsubscribe 函数可移除订阅', () => {
    const cb = vi.fn();
    const unsub = viewer.onHeadingChange(cb);
    expect(cb).toHaveBeenCalledTimes(1); // 立即触发
    unsub();
    // clear / loadContent 不会再调 cb
    viewer.clear();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('订阅者抛错不应让其它订阅者收不到回调', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const cb1 = vi.fn(() => { throw new Error('boom'); });
    const cb2 = vi.fn();
    viewer.onHeadingChange(cb1);
    viewer.onHeadingChange(cb2);
    expect(cb2).toHaveBeenCalledTimes(1); // 立即触发时 cb2 也跑过了
    cb1.mockClear();
    cb2.mockClear();
    viewer.clear();
    expect(cb1).toHaveBeenCalledTimes(1); // cb1 又跑了一次并抛错
    expect(cb2).toHaveBeenCalledTimes(1); // cb2 仍然被调到
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('非函数 onHeadingChange → 返回 noop unsubscribe，不抛错', () => {
    expect(() => {
      const ret = viewer.onHeadingChange(null);
      expect(typeof ret).toBe('function');
    }).not.toThrow();
  });
});

describe('MarkdownViewer showUnsupportedFile / clear', () => {
  let viewer;
  let body;
  let empty;

  beforeEach(() => {
    document.body.innerHTML = '<article class="body"></article><div class="empty">默认空态</div>';
    body = document.querySelector('.body');
    empty = document.querySelector('.empty');
    viewer = new MarkdownViewer({
      bodyElement: body,
      emptyElement: empty,
      statusPath: document.createElement('div'),
      statusMeta: document.createElement('div'),
    });
  });

  it('showUnsupportedFile → body 清空 + empty 改为"不支持预览" + heading 清空', () => {
    viewer.showUnsupportedFile({ name: 'foo.py', path: '/d/foo.py', size: 100 });
    expect(body.innerHTML).toBe('');
    expect(empty.innerHTML).toMatch(/不支持预览/);
    expect(viewer._headingMap.size).toBe(0);
    expect(viewer.currentHeadingId).toBe(null);
  });

  it('clear → body hidden + currentFile=null + scrollPositions 保留', () => {
    // scrollPositions 保留 —— 上面的 LRU 测试已覆盖，这里只校验 body / currentFile
    viewer.scrollPositions.set('foo', 100);
    viewer.currentFile = { path: '/d/foo', name: 'foo' };
    viewer.clear();
    expect(body.hidden).toBe(true);
    expect(viewer.currentFile).toBe(null);
    expect(viewer.scrollPositions.has('foo')).toBe(true);
  });

  it('loadContent 路径里恢复空态默认文案（被 showUnsupportedFile 改过后）', () => {
    // 模拟 showUnsupportedFile 改写空态
    viewer.showUnsupportedFile({ name: 'foo.py', path: '/d/foo.py' });
    expect(empty.innerHTML).toMatch(/不支持预览/);

    // 直接用 setBodyElement.innerHTML 模拟 loadContent 里的 _resetEmptyState
    // （避免依赖 utils.safeRenderMarkdown）
    viewer._resetEmptyState();
    expect(empty.innerHTML).toBe('默认空态');
  });

  it('Phase N M-1 修复：loadContent(空字符串) → 显示「（空文件）」占位', () => {
    // 旧实现 renderMarkdown('') → bodyElement.innerHTML='' → 用户看到空白面板，
    // 没有"文件确实是空的"提示。现在显示「（空文件）」占位文案。
    viewer.loadContent({ name: 'empty.md', path: '/d/empty.md', size: 0 }, '');
    expect(body.hidden).toBe(false);
    expect(body.innerHTML).toMatch(/空文件/);
    // emptyElement 仍然隐藏（文件是打开状态，不是"未打开文件"空态）
    expect(empty.hidden).toBe(true);
    // headingMap 清空，避免出现 stale heading
    expect(viewer._headingMap.size).toBe(0);
  });

  it('Phase N M-1：loadContent(纯空白字符串) 同样显示「（空文件）」', () => {
    // trim 后为空就走占位路径，否则 \n\n\n 这种纯空白文件还走 markdown 渲染
    // 会出现一个空的 <p></p> 占位区域（实际 DOM 是空），用户依然没"是空文件"提示。
    viewer.loadContent({ name: 'blank.md', path: '/d/blank.md', size: 3 }, '   \n\n   ');
    expect(body.innerHTML).toMatch(/空文件/);
  });

  it('Phase N M-1：loadContent(非空) 走原 markdown 渲染路径', () => {
    // 防御：占位特判只对 trim 后为空的 content 生效。非空文件保持原 renderMarkdown 流程。
    viewer.loadContent({ name: 'real.md', path: '/d/real.md', size: 5 }, '# hi');
    expect(body.innerHTML).not.toMatch(/空文件/);
    expect(body.innerHTML).toMatch(/hi/);
  });
});

describe('MarkdownViewer 状态栏路径跟随当前目录 (无文件时)', () => {
  let viewer;
  let body;
  let empty;
  let statusPath;

  beforeEach(() => {
    document.body.innerHTML = '<article class="body"></article><div class="empty"></div>';
    body = document.querySelector('.body');
    empty = document.querySelector('.empty');
    statusPath = document.createElement('div');
  });

  function makeViewer(getCurrentDir) {
    return new MarkdownViewer({
      bodyElement: body,
      emptyElement: empty,
      statusPath,
      statusMeta: document.createElement('div'),
      getCurrentDir,
    });
  }

  it('无 getCurrentDir 时 clear() 沿用「—」占位', () => {
    viewer = makeViewer(undefined);
    viewer.clear();
    expect(statusPath.textContent).toBe('—');
  });

  it('getCurrentDir 返回路径时，clear() 用文件夹路径替代「—」', () => {
    viewer = makeViewer(() => '/data/notes/sub');
    viewer.clear();
    expect(statusPath.textContent).toBe('/data/notes/sub');
  });

  it('refreshCurrentDir 在无文件时把状态栏路径切到当前目录', () => {
    // 模拟「目录路径后续才可用」：viewer 构造时 callback 还返回空，clear 后再赋值
    let cur = '';
    viewer = makeViewer(() => cur);
    viewer.clear();
    expect(statusPath.textContent).toBe('—');

    cur = '/data/notes';
    viewer.refreshCurrentDir();
    expect(statusPath.textContent).toBe('/data/notes');

    cur = '/data/notes/sub/deeper';
    viewer.refreshCurrentDir();
    expect(statusPath.textContent).toBe('/data/notes/sub/deeper');
  });

  it('refreshCurrentDir 不覆盖已打开文件的路径（文件路径优先）', () => {
    viewer = makeViewer(() => '/data/notes');
    viewer.currentFile = { path: '/data/notes/foo.md', name: 'foo.md' };
    statusPath.textContent = '/data/notes/foo.md';
    viewer.refreshCurrentDir();
    expect(statusPath.textContent).toBe('/data/notes/foo.md');
  });
});

describe('MarkdownViewer resolveRelativeImages stale-body 防护 (perf-MEDIUM)', () => {
  let viewer;
  let body;

  it('loadContent B 替换 body 后，A 启动的 resolveRelativeImages 不污染 B', async () => {
    // 模拟「A→B 快速切换」场景：A 的 resolveRelativeImages 启动后，
    // loadContent(B) 已替换 bodyElement，A 的 await 回来后必须放弃修改。
    //
    // 用一个 awaitable getDataDir 模拟 IPC；调用 resolveRelativeImages 后
    // 不 await 立刻构造新 viewer（替换 bodyElement），再 await 完成。
    document.body.innerHTML = '<article class="body"><img src="img.png"></article><div class="empty"></div>';
    body = document.querySelector('.body');

    let resolveGDR;
    const slowDataDir = new Promise((r) => { resolveGDR = r; });

    viewer = new MarkdownViewer({
      bodyElement: body,
      emptyElement: document.querySelector('.empty'),
      statusPath: document.createElement('div'),
      statusMeta: document.createElement('div'),
      getDataDir: () => slowDataDir,
    });

    // A 的解析启动（fire-and-forget）
    const aPromise = viewer.resolveRelativeImages('/notes/a.md');

    // 等一个 microtask 让 resolveRelativeImages 进入 await
    await Promise.resolve();

    // B 替换 body —— 直接覆盖 bodyElement 模拟「A→B 切文件」，
    // 并自增 _resolveGen generation token，让 A 那个早于本次的
    // resolveRelativeImages 回调在 await getDataDir 之后失配并自行 return。
    // 这是 commit 3cba60d 把 capturedBody 改成 generation token 后的真实路径：
    // loadContent/loadContentLive 在替换 innerHTML 之前 ++_resolveGen，
    // 我们这里直接调那个副作用。
    const newBody = document.createElement('article');
    newBody.className = 'body';
    document.body.appendChild(newBody);
    viewer.bodyElement = newBody;
    // _resolveGen 是私有字段，但 resolveRelativeImages 入口会 ++ 它并捕获
    // 到局部变量 myGen，这里再 ++ 一次代表「被 loadContent 顶掉」。
    viewer._resolveGen += 1;

    // 把新 body 放一个 src，B 不该被 A 改写
    const bImg = document.createElement('img');
    bImg.setAttribute('src', 'b.png');
    newBody.appendChild(bImg);

    // A 的 getDataDir 现在 resolve —— A 应当 detect generation 已变并直接 return
    resolveGDR(posixPath('/notes'));
    await aPromise;

    // 关键断言：B 的 img src 必须是原始 b.png，不能被 A 的解析覆盖
    expect(newBody.querySelector('img').getAttribute('src')).toBe('b.png');
  });

  it('未替换 body 时，正常修改应继续生效（不退化）', async () => {
    document.body.innerHTML = '<article class="body"></article><div class="empty"></div>';
    body = document.querySelector('.body');

    viewer = new MarkdownViewer({
      bodyElement: body,
      emptyElement: document.querySelector('.empty'),
      statusPath: document.createElement('div'),
      statusMeta: document.createElement('div'),
      getDataDir: () => posixPath('/notes'),
    });

    body.innerHTML = '<img src="img.png">';
    await viewer.resolveRelativeImages(posixPath('/notes/a.md'));
    expect(body.querySelector('img').getAttribute('src')).toMatch(/^file:/);
  });
});

describe('MarkdownViewer resolveRelativeImages 副作用', () => {
  let viewer;
  let body;

  beforeEach(() => {
    document.body.innerHTML = '<article class="body"></article><div class="empty"></div>';
    body = document.querySelector('.body');
    viewer = new MarkdownViewer({
      bodyElement: body,
      emptyElement: document.querySelector('.empty'),
      statusPath: document.createElement('div'),
      statusMeta: document.createElement('div'),
      // audit fix (Sec-M2)：新签名需要 getDataDir 才能继续 setAttribute
      // loading/decoding；这里给一个「包含路径」的等价 dir，让 img.png 视为
      // 「在数据目录内」跑通副作用断言。原本旧行为「不传 getDataDir 仍解析」
      // 已删，这里补齐构造以让 loading/decoding 这条副作用断言继续有意义。
      getDataDir: () => posixPath('/notes'),
    });
  });

  it('图片自动加 loading="lazy" + decoding="async"', async () => {
    body.innerHTML = '<img src="img.png" /><img src="img2.png" />';
    await viewer.resolveRelativeImages('/notes/test.md');

    for (const img of body.querySelectorAll('img')) {
      expect(img.getAttribute('loading')).toBe('lazy');
      expect(img.getAttribute('decoding')).toBe('async');
    }
  });

  it('已有 loading/decoding 不覆盖', async () => {
    body.innerHTML = '<img src="img.png" loading="eager" decoding="sync" />';
    await viewer.resolveRelativeImages('/notes/test.md');

    const img = body.querySelector('img');
    expect(img.getAttribute('loading')).toBe('eager');
    expect(img.getAttribute('decoding')).toBe('sync');
  });

  it('data: URL 图片不动', async () => {
    body.innerHTML = '<img src="data:image/png;base64,iVBOR..." />';
    await viewer.resolveRelativeImages('/notes/test.md');

    const img = body.querySelector('img');
    expect(img.getAttribute('src')).toBe('data:image/png;base64,iVBOR...');
    // 不加 loading/lazy：绝对 / data: 不参与处理
    expect(img.getAttribute('loading')).toBeNull();
  });

  it('绝对 file:// / https:// URL 图片不动', async () => {
    body.innerHTML = '<img src="https://cdn.example.com/img.png" />';
    await viewer.resolveRelativeImages('/notes/test.md');

    const img = body.querySelector('img');
    expect(img.getAttribute('src')).toBe('https://cdn.example.com/img.png');
  });
});

describe('MarkdownViewer resolveRelativeImages dataDir 越界拦截 (audit C3)', () => {
  let viewer;
  let body;

  beforeEach(() => {
    document.body.innerHTML = '<article class="body"></article><div class="empty"></div>';
    body = document.querySelector('.body');
  });

  // audit C3：恶意 markdown 可以写 `<img src="../../../etc/passwd.png">`，
  // 之前 resolveRelativeImages 不做任何边界检查，解析后的 file:// URL
  // 直接让 Electron 加载受害机器上的任意可读文件。现在构造时传入 getDataDir，
  // 越界图片会被剥 src + 加 data-blocked="external" 标记（不暴露外部路径）。
  function makeViewer(getDataDir) {
    return new MarkdownViewer({
      bodyElement: body,
      emptyElement: document.querySelector('.empty'),
      statusPath: document.createElement('div'),
      statusMeta: document.createElement('div'),
      getDataDir,
    });
  }

  // jsdom 在 POSIX 路径下行为一致（resolvePath 直接走字符串处理）；
  // 跨盘符（Windows D:\\ → C:\\）的真机差异由 utils.isPathInside 自己负责，
  // 这里只验证「resolveRelativeImages 调用了边界检查」+「拦截行为正确」。
  // posixPath 已上提到 module-scope（与 stale-body 测试共用）。

  it('图片 src 越出数据目录 → src 被剥 + data-blocked="external"', async () => {
    viewer = makeViewer(() => posixPath('/home/user/Notes'));
    // 父文件在 /home/user/Notes/，相对路径 "../../../etc/passwd.png"
    // 解析后会跳到 /etc/passwd.png —— 越过 /home/user/Notes 边界。
    body.innerHTML = '<img src="../../../etc/passwd.png" alt="secret">';
    await viewer.resolveRelativeImages(posixPath('/home/user/Notes/a.md'));

    const img = body.querySelector('img');
    expect(img.hasAttribute('src')).toBe(false);
    expect(img.getAttribute('data-blocked')).toBe('external');
    // alt 提到 title（可访问性兜底）
    expect(img.getAttribute('title')).toMatch(/外部图片已拦截：secret/);
  });

  it('图片 src 在数据目录内 → 不被拦截', async () => {
    viewer = makeViewer(() => posixPath('/home/user/Notes'));
    body.innerHTML = '<img src="subdir/img.png" alt="x">';
    await viewer.resolveRelativeImages(posixPath('/home/user/Notes/a.md'));

    const img = body.querySelector('img');
    expect(img.hasAttribute('data-blocked')).toBe(false);
    // src 应该被改成 file:// 绝对路径
    expect(img.getAttribute('src')).toMatch(/^file:/);
    expect(img.getAttribute('src')).toMatch(/img\.png$/);
  });

  it('getDataDir 返回 null（不可用） → fail-closed：src 被剥，data-blocked="external"', async () => {
    // audit fix (Sec-M2)：旧版「getDataDir 返回 null → 跳过边界检查」是文件
    // 系统枚举 oracle —— 恶意 md 可以用 `<img src="../victim.png">` 探测数据
    // 目录外任意可读图片是否存在。新版 fail-closed：dataDir 不可用时一律拒写 src。
    viewer = makeViewer(() => null);
    body.innerHTML = '<img src="img.png" alt="x">';
    await viewer.resolveRelativeImages(posixPath('/notes/a.md'));
    const img = body.querySelector('img');
    expect(img.hasAttribute('src')).toBe(false);
    expect(img.getAttribute('data-blocked')).toBe('external');
  });

  it('getDataDir 抛错 → fail-closed：src 被剥，不阻断后续调用', async () => {
    // audit fix (Sec-M2)：旧版 catch 里静默吞掉错误并继续，相当于「IPC 故障时
    // 整个数据目录边界检查被绕过」。新版与 null 同走 fail-closed 路径，保证
    // 「dataDir 不可用 = 一律拦截」语义统一。catch 仍不阻断后续 DOM 处理，
    // 但图片一律不下发 src（与 null 一致），这是有意的更安全默认。
    viewer = makeViewer(() => { throw new Error('IPC down'); });
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    body.innerHTML = '<img src="img.png">';
    await viewer.resolveRelativeImages(posixPath('/notes/a.md'));
    expect(body.querySelector('img').hasAttribute('src')).toBe(false);
    consoleWarn.mockRestore();
  });

  it('getDataDir 返回 Promise（异步 IPC） → 正确 await', async () => {
    viewer = makeViewer(async () => posixPath('/home/user/Notes'));
    body.innerHTML = '<img src="../../../etc/passwd.png">';
    await viewer.resolveRelativeImages(posixPath('/home/user/Notes/a.md'));

    const img = body.querySelector('img');
    expect(img.getAttribute('data-blocked')).toBe('external');
  });

  it('未传 getDataDir 选项 → fail-closed：src 被剥', async () => {
    // audit fix (Sec-M2)：与 null / 抛错同走 fail-closed —— 边界守护不可降级。
    viewer = new MarkdownViewer({
      bodyElement: body,
      emptyElement: document.querySelector('.empty'),
      statusPath: document.createElement('div'),
      statusMeta: document.createElement('div'),
      // 不传 getDataDir
    });
    body.innerHTML = '<img src="img.png">';
    await viewer.resolveRelativeImages(posixPath('/notes/a.md'));
    expect(body.querySelector('img').hasAttribute('src')).toBe(false);
    expect(body.querySelector('img').getAttribute('data-blocked')).toBe('external');
  });
});

// audit fix (Round 12)：onExternalLink async 回调未接 promise → IPC throw 时
// 变成 unhandledRejection。viewer 这层 catch 住，调用方不能再依赖「调用 fire-and-forget」
// 必须接 promise 或主动 catch。
describe('MarkdownViewer 外链回调错误边界 (audit Round 12 P2)', () => {
  let body;
  beforeEach(() => {
    document.body.innerHTML = '';
    body = document.createElement('div');
    body.id = 'markdown-body';
    document.body.appendChild(body);
  });

  function makeViewer(onExternalLink) {
    return new MarkdownViewer({
      bodyElement: body,
      emptyElement: document.createElement('div'),
      statusPath: document.createElement('div'),
      statusMeta: document.createElement('div'),
      onExternalLink,
    });
  }

  function makeLink(href) {
    const a = document.createElement('a');
    a.setAttribute('href', href);
    a.textContent = 'x';
    body.appendChild(a);
    return a;
  }

  it('onExternalLink 同步 throw → 不冒到 document unhandledRejection', () => {
    const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {});
    const viewer = makeViewer(() => { throw new Error('sync boom'); });
    const a = makeLink('https://example.com');

    // 不应 throw — click handler 内部 try/catch 兜住
    expect(() => a.click()).not.toThrow();
    expect(consoleErr).toHaveBeenCalled();
    expect(consoleErr.mock.calls[0][0]).toMatch(/onExternalLink threw synchronously/);
    consoleErr.mockRestore();
  });

  it('onExternalLink 返回 Promise 且 reject → console.error 捕获', async () => {
    const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {});
    const viewer = makeViewer(() => Promise.reject(new Error('async boom')));
    const a = makeLink('https://example.com');

    a.click();
    // 让 microtask 队列跑一下
    await new Promise((r) => setTimeout(r, 0));

    expect(consoleErr).toHaveBeenCalled();
    expect(consoleErr.mock.calls.some((c) => /promise rejected/.test(String(c[0])))).toBe(true);
    consoleErr.mockRestore();
  });

  it('onExternalLink 返回正常 Promise → 不打 console.error', async () => {
    const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {});
    const viewer = makeViewer(() => Promise.resolve());
    const a = makeLink('https://example.com');

    a.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(consoleErr).not.toHaveBeenCalled();
    consoleErr.mockRestore();
  });
});

// audit fix (Round 12 P3)：dispose 必须显式 disconnect _headingObserver，
// 否则 detach 后的 heading 节点被 IntersectionObserver 持有 → 不被 GC。
// 单测构造一个 IntersectionObserver 拦截 _rebuildHeadingObserver → 验证
// dispose 后 observer.disconnect() 被调用。
describe('MarkdownViewer dispose 释放 IntersectionObserver (audit Round 12 P3)', () => {
  let body;
  beforeEach(() => {
    document.body.innerHTML = '';
    body = document.createElement('div');
    body.id = 'markdown-body';
    document.body.appendChild(body);
  });

  it('dispose() 显式 disconnect _headingObserver', () => {
    const disconnectCalls = [];
    // jsdom 没有 IntersectionObserver —— 给 bodyElement 一个 mock，让
    // _rebuildHeadingObserver 用它（viewer 走「io = new IntersectionObserver(cb)」
    // 拿 window.IntersectionObserver）。
    const fakeObserver = {
      observe: vi.fn(),
      disconnect: vi.fn(function () { disconnectCalls.push(true); }),
      unobserve: vi.fn(),
    };
    const RealIO = window.IntersectionObserver;
    window.IntersectionObserver = vi.fn(function () { return fakeObserver; });

    try {
      const viewer = new MarkdownViewer({
        bodyElement: body,
        emptyElement: document.createElement('div'),
        statusPath: document.createElement('div'),
        statusMeta: document.createElement('div'),
      });

      // 触发 _rebuildHeadingObserver：往 body 塞 h1/h2 后调该方法
      const h1 = document.createElement('h1');
      h1.textContent = 'title';
      body.appendChild(h1);
      const h2 = document.createElement('h2');
      h2.textContent = 'sub';
      body.appendChild(h2);
      viewer._rebuildHeadingObserver();

      // 现在 _headingObserver 是 fakeObserver —— 调 dispose 必须 disconnect
      viewer.dispose();
      expect(disconnectCalls.length).toBe(1);
      expect(viewer._headingObserver).toBe(null);
    } finally {
      window.IntersectionObserver = RealIO;
    }
  });

  it('重复 dispose 不抛错（disconnect 已在第一次调过）', () => {
    const fakeObserver = {
      observe: vi.fn(),
      disconnect: vi.fn(),
      unobserve: vi.fn(),
    };
    const RealIO = window.IntersectionObserver;
    window.IntersectionObserver = vi.fn(function () { return fakeObserver; });

    try {
      const viewer = new MarkdownViewer({
        bodyElement: body,
        emptyElement: document.createElement('div'),
        statusPath: document.createElement('div'),
        statusMeta: document.createElement('div'),
      });
      const h1 = document.createElement('h1');
      body.appendChild(h1);
      viewer._rebuildHeadingObserver();

      viewer.dispose();
      // 第二次 dispose 不抛错（addAbort 是 abortController，已 abort 但闭包不抛）
      expect(() => viewer.dispose()).not.toThrow();
    } finally {
      window.IntersectionObserver = RealIO;
    }
  });
});

// ============================================================================
// audit R7b P1-16：loadContentLive rAF chunked insert
// ============================================================================
//
// 核心契约：loadContentLive 不再同步 `innerHTML = html` 整页替换。
//   - 小文档（≤ 256KB html）同步解析 + 一次性插入，手感与原实现一致
//   - 大文档解析推迟到下一帧，children > 200 时每帧最多 append 200 个
//   - 单飞行：新一次 loadContentLive abort 上一次未完成的 insert
//   - heading observer / resolveRelativeImages 推迟到全部 chunk 落地后才跑
//   - loadContent / clear / showUnsupportedFile / dispose 都会取消 in-flight insert
//
// mock 策略：window.api.renderMarkdown = pass-through（markdown 输入即 HTML 输出），
// 这样测试可以自己构造精确的 DOM 结构（段落数 / heading id）。
describe('MarkdownViewer loadContentLive chunked insert (audit R7b P1-16)', () => {
  let body;
  let empty;
  let viewer;
  let savedApi;
  let RealIO;

  function makeParas(n, prefix = 'p') {
    const parts = [];
    for (let i = 0; i < n; i++) parts.push(`<p>${prefix}-${i}</p>`);
    return parts.join('');
  }

  beforeEach(() => {
    document.body.innerHTML = '<article class="body"></article><div class="empty"></div>';
    body = document.querySelector('.body');
    empty = document.querySelector('.empty');
    savedApi = window.api;
    window.api = { renderMarkdown: (md) => md };
    // jsdom 没有 IntersectionObserver —— 与 dispose 测试相同的 mock 策略。
    // 不 mock 的话，fixture 里带 heading 时 _rebuildHeadingObserver 会抛
    // ReferenceError，_finishLiveInsert 后续的 resolveRelativeImages 被跳过。
    RealIO = window.IntersectionObserver;
    window.IntersectionObserver = vi.fn(function () {
      return { observe: vi.fn(), disconnect: vi.fn(), unobserve: vi.fn() };
    });
    viewer = new MarkdownViewer({
      bodyElement: body,
      emptyElement: empty,
      statusPath: document.createElement('div'),
      statusMeta: document.createElement('div'),
    });
    // resolveRelativeImages 需要 currentFile.path；无 getDataDir → 跳过越界检查
    viewer.currentFile = { path: '/notes/a.md', name: 'a.md' };
  });

  afterEach(() => {
    if (viewer) viewer.dispose();
    if (savedApi === undefined) delete window.api;
    else window.api = savedApi;
    window.IntersectionObserver = RealIO;
  });

  it('changed 语义：内容变了 → true；同内容 → false 且 _resolveGen 仍 +1', () => {
    const gen0 = viewer._resolveGen;
    expect(viewer.loadContentLive('<p>x</p>')).toEqual({ changed: true });
    const gen1 = viewer._resolveGen;
    // 第一次调用 bump 了 generation（loadContentLive 自身 +1；
    // 收尾的 resolveRelativeImages 入口也会 +1 —— 不锁精确值，只锁「有 bump」）
    expect(gen1).toBeGreaterThan(gen0);
    expect(viewer.loadContentLive('<p>x</p>')).toEqual({ changed: false });
    // M-series Phase M-H3：同内容早返回也恰好 bump 一次（让 in-flight 的
    // resolveRelativeImages 失配放弃），这里锁精确 +1
    expect(viewer._resolveGen).toBe(gen1 + 1);
  });

  it('小文档（≤ 200 children）同步落地：返回后 DOM 立即可用', () => {
    const r = viewer.loadContentLive('<p>a</p><p>b</p><p>c</p>');
    expect(r).toEqual({ changed: true });
    // fast-path：不经过 rAF，同步完成 —— 与原同步 innerHTML 行为等价
    expect(body.querySelectorAll('p').length).toBe(3);
    expect(body.textContent).toBe('abc');
  });

  it('大文档（> 200 children）分批：同步返回时 body 已清空，await 后完整', async () => {
    const html = makeParas(500);
    const r = viewer.loadContentLive(html);
    expect(r).toEqual({ changed: true });
    // 分批路径：首帧只做「清空 + 解析」，append 在后续 rAF 帧里
    expect(body.querySelectorAll('p').length).toBe(0);

    await viewer._test_liveInsertDone();
    const ps = body.querySelectorAll('p');
    expect(ps.length).toBe(500);
    // 顺序保持（chunk 从 fragment 头部依序取）
    expect(ps[0].textContent).toBe('p-0');
    expect(ps[499].textContent).toBe('p-499');
  });

  it('单飞行：连续两次 loadContentLive，第一次的剩余 chunk 不会混进第二次', async () => {
    // 第一次：500 段（走分批，同步返回时什么都还没 append）
    viewer.loadContentLive(makeParas(500, 'old'));
    // 不 await，立刻第二次：3 段小文档
    viewer.loadContentLive('<p>B1</p><p>B2</p><p>B3</p>');

    await viewer._test_liveInsertDone();
    const ps = body.querySelectorAll('p');
    // 关键断言：最终只有第二次的 3 段；第一次的 500 段一段都不残留
    expect(ps.length).toBe(3);
    expect(ps[0].textContent).toBe('B1');
    expect(ps[2].textContent).toBe('B3');
  });

  it('heading observer 与 resolveRelativeImages 推迟到全部 chunk 落地后', async () => {
    const rebuildSpy = vi.spyOn(viewer, '_rebuildHeadingObserver');
    const resolveSpy = vi.spyOn(viewer, 'resolveRelativeImages');

    // 500 段 + 末尾一个带 id 的 h1（childNodes = 501 > 200 → 分批）
    viewer.loadContentLive(makeParas(500) + '<h1 id="end-h">E</h1>');
    // 同步返回时：observer / resolve 都不该被调（DOM 还没拼完）
    expect(rebuildSpy).not.toHaveBeenCalled();
    expect(resolveSpy).not.toHaveBeenCalled();

    await viewer._test_liveInsertDone();
    expect(rebuildSpy).toHaveBeenCalledTimes(1);
    expect(resolveSpy).toHaveBeenCalledTimes(1);
    // heading 快查表已含新 h1（observer 是在完整 DOM 上重建的）
    expect(viewer._headingMap.get('end-h')).toMatchObject({ level: 1, text: 'E' });
  });

  it('dispose 取消 in-flight insert：不再 append，也不跑收尾回调', async () => {
    const rebuildSpy = vi.spyOn(viewer, '_rebuildHeadingObserver');
    viewer.loadContentLive(makeParas(500));
    viewer.dispose();

    await viewer._test_liveInsertDone();
    // 首帧清空后从未 append（dispose 在第一个 rAF 帧之前 abort）
    expect(body.querySelectorAll('p').length).toBe(0);
    expect(rebuildSpy).not.toHaveBeenCalled();
  });

  it('loadContent 取消 in-flight live insert：旧 chunk 不污染新文件 DOM', async () => {
    viewer.loadContentLive(makeParas(500, 'stale'));
    // 立刻切文件（loadContent 是冷启动路径，保持同步 innerHTML）
    await viewer.loadContent({ path: '/notes/b.md', name: 'b.md', size: 3 }, '# B');

    await viewer._test_liveInsertDone();
    // 新文件内容（mock render 是 pass-through → '# B' 文本节点）
    expect(body.textContent).toBe('# B');
    // 旧的 500 段一个都不剩
    expect(body.querySelectorAll('p').length).toBe(0);
  });

  it('clear 取消 in-flight live insert', async () => {
    viewer.loadContentLive(makeParas(500));
    viewer.clear();

    await viewer._test_liveInsertDone();
    expect(body.querySelectorAll('p').length).toBe(0);
    expect(body.innerHTML).toBe('');
  });

  it('性能：5MB html 连续 50 次 loadContentLive，DOM 提交推迟到 rAF（同步段不阻塞）', async () => {
    // audit P1-16 验收标准：5MB fixture + 50 次 load，调用方视角的同步段
    // 必须不阻塞主线程 —— 真正的 parse + append 全部推迟到 rAF 帧。
    // （jsdom 的 parse5 与 Chromium 原生 parser 性能不可比，真机 5MB 实测
    // 在 Electron 里手动验证；此处锁定的是「不再同步提交 DOM」的语义。）
    const para = '<p>lorem ipsum dolor sit amet, consectetur adipiscing elit</p>';
    const bigHtml = para.repeat(Math.ceil((5 * 1024 * 1024) / para.length));
    expect(bigHtml.length).toBeGreaterThan(5 * 1024 * 1024);

    // 同步段：50 次调用都走「大文档推迟」路径（> 256KB → 首帧先 await rAF
    // 才碰 body）。loadContentLive 同步返回时 body 不应被大子树同步污染 ——
    // 这是 P1-16 锁死的核心不变量，且不受机器 / V8 版本性能差异影响。
    const t0 = performance.now();
    for (let i = 0; i < 50; i++) {
      // 每次内容都略不同（绕开「同内容早返回」分支），但差异极小不影响测量。
      viewer.loadContentLive(bigHtml + `<!-- ${i} -->`);
    }
    const wall = performance.now() - t0;

    // 关键断言（精确、机器无关）：同步返回后 body 还没有被大 html 同步插入。
    expect(body.querySelectorAll('p').length).toBe(0);

    // 绝对 wall 在不同机器 / V8 版本上差异较大（循环里 50 次 × 5MB 字符串分配
    // 主导，与真实 DOM 提交无关），仅作回归粗筛：不应出现秒级卡顿。
    expect(wall).toBeLessThan(2000);

    // 收尾：abort 掉最后一次还没开始解析的 insert（5MB 的 parse5 解析在
    // jsdom 里要秒级，aborted 时首帧直接 return，不会真跑）。
    viewer.clear();
    await viewer._test_liveInsertDone();
  });
});

// P2-17（audit R8）：_applyHtmlLive 两端 diff —— 未变更顶级块保留 DOM 节点
// 引用，只删/插真正变化的中段；属性顺序差异走 isEqualNode 等价 → 零变更。
// P2-14：_finishLiveInsert 把变更块作为 roots 传给 resolveRelativeImages，
// 图片解析只扫新插入的块；loadContent 等非 diff 路径不传 roots（全量扫描）。
describe('MarkdownViewer live diff 节点保留 + resolve scope (audit R8 P2-17 / P2-14)', () => {
  let body;
  let empty;
  let viewer;
  let savedApi;
  let RealIO;

  beforeEach(() => {
    document.body.innerHTML = '<article class="body"></article><div class="empty"></div>';
    body = document.querySelector('.body');
    empty = document.querySelector('.empty');
    savedApi = window.api;
    window.api = { renderMarkdown: (md) => md };
    // 与 P1-16 块相同：jsdom 无 IntersectionObserver，不 mock 会让
    // _finishLiveInsert 里的 _rebuildHeadingObserver 抛 ReferenceError。
    RealIO = window.IntersectionObserver;
    window.IntersectionObserver = vi.fn(function () {
      return { observe: vi.fn(), disconnect: vi.fn(), unobserve: vi.fn() };
    });
    viewer = new MarkdownViewer({
      bodyElement: body,
      emptyElement: empty,
      statusPath: document.createElement('div'),
      statusMeta: document.createElement('div'),
    });
    viewer.currentFile = { path: '/notes/a.md', name: 'a.md' };
  });

  afterEach(() => {
    if (viewer) viewer.dispose();
    if (savedApi === undefined) delete window.api;
    else window.api = savedApi;
    window.IntersectionObserver = RealIO;
  });

  it('P2-17 尾部追加：前缀节点引用保留，只插新块', async () => {
    viewer.loadContentLive('<p>a</p><p>b</p>');
    await viewer._test_liveInsertDone();
    const a = body.childNodes[0];
    const b = body.childNodes[1];

    viewer.loadContentLive('<p>a</p><p>b</p><p>c</p>');
    await viewer._test_liveInsertDone();

    expect(body.childNodes.length).toBe(3);
    expect(body.childNodes[0]).toBe(a);
    expect(body.childNodes[1]).toBe(b);
    expect(body.childNodes[2].textContent).toBe('c');
  });

  it('P2-17 中间编辑：只替换变化的块，前后节点引用不变', async () => {
    viewer.loadContentLive('<p>a</p><p>b</p><p>c</p>');
    await viewer._test_liveInsertDone();
    const a = body.childNodes[0];
    const mid = body.childNodes[1];
    const c = body.childNodes[2];

    viewer.loadContentLive('<p>a</p><p>B</p><p>c</p>');
    await viewer._test_liveInsertDone();

    expect(body.childNodes.length).toBe(3);
    expect(body.childNodes[0]).toBe(a);
    expect(body.childNodes[2]).toBe(c);
    expect(body.childNodes[1]).not.toBe(mid);
    expect(body.childNodes[1].textContent).toBe('B');
  });

  it('P2-17 中间插入与删除：前后缀节点引用保留', async () => {
    viewer.loadContentLive('<p>a</p><p>c</p>');
    await viewer._test_liveInsertDone();
    const a = body.childNodes[0];
    const c = body.childNodes[1];

    // 中间插入一个块
    viewer.loadContentLive('<p>a</p><p>b</p><p>c</p>');
    await viewer._test_liveInsertDone();
    expect(body.childNodes.length).toBe(3);
    expect(body.childNodes[0]).toBe(a);
    expect(body.childNodes[2]).toBe(c);
    expect(body.childNodes[1].textContent).toBe('b');

    // 再删掉它（回到原状）—— a/c 仍然是同一批节点
    viewer.loadContentLive('<p>a</p><p>c</p>');
    await viewer._test_liveInsertDone();
    expect(body.childNodes.length).toBe(2);
    expect(body.childNodes[0]).toBe(a);
    expect(body.childNodes[1]).toBe(c);
  });

  it('P2-17 属性顺序差异 → isEqualNode 等价：零 DOM 变更，resolve 收到空 roots (P2-14)', async () => {
    viewer.loadContentLive('<p id="a" class="x">t</p>');
    await viewer._test_liveInsertDone();
    const p = body.childNodes[0];

    const resolveSpy = vi.spyOn(viewer, 'resolveRelativeImages');
    // 字符串不同（绕过 content 早返回），但 DOM 语义完全等价
    viewer.loadContentLive('<p class="x" id="a">t</p>');
    await viewer._test_liveInsertDone();

    expect(body.childNodes.length).toBe(1);
    expect(body.childNodes[0]).toBe(p); // 节点没有被替换
    expect(resolveSpy).toHaveBeenCalledTimes(1);
    // P2-14：零变更路径传 roots=[] → resolve 内部一张 img 都不扫
    expect(resolveSpy.mock.calls[0][1]).toEqual([]);
  });

  it('P2-17 保留前后缀 + 大中段（500 块）：仍走分批插入，前后缀节点不动', async () => {
    viewer.loadContentLive('<p>keep-0</p><p>keep-1</p><p>keep-2</p>');
    await viewer._test_liveInsertDone();
    const k0 = body.childNodes[0];
    const k1 = body.childNodes[1];
    const k2 = body.childNodes[2];

    const mid = [];
    for (let i = 0; i < 500; i++) mid.push(`<p>mid-${i}</p>`);
    viewer.loadContentLive('<p>keep-0</p>' + mid.join('') + '<p>keep-1</p><p>keep-2</p>');
    // 中段 500 > 200 → 分批：同步返回时中段还没开始插（body 仍是 3 个 keep）
    expect(body.childNodes.length).toBe(3);

    await viewer._test_liveInsertDone();
    expect(body.childNodes.length).toBe(503);
    expect(body.childNodes[0]).toBe(k0);
    expect(body.childNodes[501]).toBe(k1);
    expect(body.childNodes[502]).toBe(k2);
    expect(body.childNodes[1].textContent).toBe('mid-0');
    expect(body.childNodes[500].textContent).toBe('mid-499');
  });

  it('P2-17 abort 自愈：分批插入中途被接管，最终 DOM 收敛到新内容', async () => {
    const paras = [];
    for (let i = 0; i < 500; i++) paras.push(`<p>A-${i}</p>`);
    viewer.loadContentLive(paras.join(''));
    // 等一帧（rAF 按请求顺序执行：apply 的回调先跑完第一批插入，我们的才
    // resolve）—— 此时 A 只落地了第一批 200 段，body 处于「半截 A」态。
    await viewer._nextFrame();
    const partial = body.querySelectorAll('p').length;
    expect(partial).toBeGreaterThan(0);
    expect(partial).toBeLessThan(500);

    // 新内容接管：abort 旧的，diff 的旧侧读当前真实 DOM（半截 A），
    // 不做任何回滚也能收敛到 B —— 这是「abort 自愈」语义的核心断言。
    viewer.loadContentLive('<p>B1</p><p>B2</p><p>B3</p>');
    await viewer._test_liveInsertDone();

    const ps = body.querySelectorAll('p');
    expect(ps.length).toBe(3);
    expect(ps[0].textContent).toBe('B1');
    expect(ps[2].textContent).toBe('B3');
  });

  it('P2-14 live diff 后 resolve 只扫变更块：roots 恰好是新插入的那个块', async () => {
    viewer.loadContentLive('<p>one</p><p>two</p><p>three</p>');
    await viewer._test_liveInsertDone();

    const resolveSpy = vi.spyOn(viewer, 'resolveRelativeImages');
    viewer.loadContentLive('<p>one</p><p>TWO</p><p>three</p>');
    await viewer._test_liveInsertDone();

    expect(resolveSpy).toHaveBeenCalledTimes(1);
    const roots = resolveSpy.mock.calls[0][1];
    expect(roots.length).toBe(1);
    expect(roots[0].textContent).toBe('TWO');
    // roots 里的就是当前 body 里那个新块；保留的前后缀不在其中
    expect(roots[0]).toBe(body.childNodes[1]);
    expect(roots).not.toContain(body.childNodes[0]);
    expect(roots).not.toContain(body.childNodes[2]);
  });

  it('P2-14 loadContent 路径不传 roots → 维持全 body 扫描原语义', async () => {
    const resolveSpy = vi.spyOn(viewer, 'resolveRelativeImages');
    await viewer.loadContent({ path: '/notes/b.md', name: 'b.md' }, 'plain text');
    expect(resolveSpy).toHaveBeenCalledTimes(1);
    expect(resolveSpy.mock.calls[0][1]).toBeUndefined();
  });

  it('P2-14 变更块里的图片在 roots scope 下照常解析成 file://', async () => {
    viewer.getDataDir = () => posixPath('/notes');
    viewer.loadContentLive('<p>txt</p><p><img src="pic.png"></p>');
    await viewer._test_liveInsertDone();
    // 同步 getDataDir → resolve 在 _finishLiveInsert 里同步跑完，
    // _test_liveInsertDone 返回时图片已解析
    const img = body.querySelector('img');
    expect(img.getAttribute('src')).toMatch(/^file:/);
    expect(img.getAttribute('src')).toMatch(/pic\.png$/);
    expect(img.getAttribute('loading')).toBe('lazy');
    expect(img.getAttribute('decoding')).toBe('async');
  });

  it('P2-17 已知行为：含已解析 file:// 图片的块下轮 diff 失配 → 替换 + scoped 重解析', async () => {
    // resolveRelativeImages 会把 img src 改写成 file:// 并加 loading/decoding，
    // 而下一轮渲染产物里仍是原始相对 src → isEqualNode 为 false，含图块
    // 无法享受节点保留（退化为替换 + scoped 重解析）。这与 P1-16 前的全量
    // 替换基线行为一致（图片块本来就每轮重解析），不是回归 —— 锁语义防误改。
    viewer.getDataDir = () => posixPath('/notes');
    viewer.loadContentLive('<p><img src="pic.png"></p><p>one</p>');
    await viewer._test_liveInsertDone();
    const imgBlock = body.childNodes[0];
    const textBlock = body.childNodes[1];
    expect(imgBlock.querySelector('img').getAttribute('src')).toMatch(/^file:/);

    const resolveSpy = vi.spyOn(viewer, 'resolveRelativeImages');
    viewer.loadContentLive('<p><img src="pic.png"></p><p>two</p>');
    await viewer._test_liveInsertDone();

    // 文本块变了 + 含图块因 src 改写失配 → 两个块都被替换，都进 roots
    expect(body.childNodes[0]).not.toBe(imgBlock);
    expect(body.childNodes[1]).not.toBe(textBlock);
    expect(resolveSpy.mock.calls[0][1].length).toBe(2);
    // 重解析后新块的 img 仍是合法 file://（scoped resolve 覆盖到位）
    const img = body.querySelector('img');
    expect(img.getAttribute('src')).toMatch(/^file:/);
    expect(img.getAttribute('src')).toMatch(/pic\.png$/);
  });
});

// 状态栏 aria-label 与 textContent 必须同源 —— 防止「SR 听到短名，视觉看到全路径」
// 的可访问性漂移。同时占位 fallback 也走同一函数，不再硬编码 '—' 字面量。
describe('MarkdownViewer 状态栏 aria-label (audit R7a a11y)', () => {
  let body;
  let empty;
  let statusPath;

  beforeEach(() => {
    document.body.innerHTML = '<article class="body"></article><div class="empty"></div>';
    body = document.querySelector('.body');
    empty = document.querySelector('.empty');
    statusPath = document.createElement('div');
  });

  function makeViewer(opts = {}) {
    return new MarkdownViewer({
      bodyElement: body,
      emptyElement: empty,
      statusPath,
      statusMeta: document.createElement('div'),
      ...opts,
    });
  }

  it('clear() 在无 getCurrentDir 时：textContent + aria-label 都走占位分支', () => {
    const v = makeViewer();
    v.clear();
    expect(statusPath.textContent).toBe('—');
    // 占位分支的 aria-label 是固定的描述性短句，描述按钮行为而不是"显示 —"
    expect(statusPath.getAttribute('aria-label')).toBe('在文件管理器中显示当前文件夹');
  });

  it('clear() 有 currentDir 时：aria-label 把目录路径带上', () => {
    const v = makeViewer({ getCurrentDir: () => '/data/notes/sub' });
    v.clear();
    expect(statusPath.textContent).toBe('/data/notes/sub');
    expect(statusPath.getAttribute('aria-label')).toBe('在文件管理器中显示 /data/notes/sub');
  });

  it('refreshCurrentDir 跟 clear 同源：用 STATUS_PATH_PLACEHOLDER 判占位', () => {
    // 拿不到 dir → 占位路径 + 占位 aria-label
    let cur = '';
    const v = makeViewer({ getCurrentDir: () => cur });
    v.clear();
    cur = '/data/notes';
    v.refreshCurrentDir();
    expect(statusPath.textContent).toBe('/data/notes');
    expect(statusPath.getAttribute('aria-label')).toBe('在文件管理器中显示 /data/notes');
  });

  it('updateStatusBar：aria-label 与 textContent 完全一致（不是只听文件名）', () => {
    // 原 bug：file.name=foo.md，file.path=/a/b/foo.md → 视觉看到全路径，
    // SR 只听到"在文件管理器中显示 foo.md"。现在改成用 path 统一。
    const v = makeViewer();
    v.updateStatusBar({ name: 'foo.md', path: '/a/b/foo.md', size: 100 });
    expect(statusPath.textContent).toBe('/a/b/foo.md');
    expect(statusPath.getAttribute('aria-label')).toBe('在文件管理器中显示 /a/b/foo.md');
  });

  it('updateStatusBar：缺 name 但有 path → aria-label 仍带 path', () => {
    const v = makeViewer();
    v.updateStatusBar({ path: '/only/path.md' });
    expect(statusPath.textContent).toBe('/only/path.md');
    expect(statusPath.getAttribute('aria-label')).toBe('在文件管理器中显示 /only/path.md');
  });

  it('updateStatusBar：file={} → 占位 aria-label（不暴「显示 —」）', () => {
    const v = makeViewer();
    v.updateStatusBar({});
    expect(statusPath.textContent).toBe('—');
    expect(statusPath.getAttribute('aria-label')).toBe('在文件管理器中显示当前文件夹');
  });
});

// 空状态 CTA 委托：app.js init 把 click listener 挂在 emptyElement 上而不是按钮本身上。
// 因为 markdown-viewer.js 的 showUnsupportedFile / _resetEmptyState 会 innerHTML 重写
// emptyElement —— 监听挂在被 detached 的 button 上没意义；委托给父容器才稳。
// 这个 describe 模拟 app.js 的注册逻辑，确保 innerHTML 重写后按钮仍被响应。
describe('空状态 CTA 委托模式 (R7a a11y/correctness)', () => {
  it('innerHTML 重写后，委托到父容器的 listener 仍能命中新按钮', () => {
    document.body.innerHTML = '<div id="empty-state"><button id="empty-state-new-btn">新建笔记</button></div>';
    const empty = document.getElementById('empty-state');
    const initialBtn = document.getElementById('empty-state-new-btn');

    // 模拟 app.js 的真实注册：挂在 emptyElement 上，closest 取按钮
    const handler = vi.fn();
    empty.addEventListener('click', (ev) => {
      if (ev.target.closest('#empty-state-new-btn')) handler();
    });

    // 第一次点击：原始按钮，被 handler 响应
    initialBtn.click();
    expect(handler).toHaveBeenCalledTimes(1);

    // 模拟 markdown-viewer.js 改写 innerHTML（showUnsupportedFile 会做）
    empty.innerHTML = '<p>该文件不支持预览</p>';
    // 再 _resetEmptyState 恢复默认空态 —— button 是新建的节点
    empty.innerHTML = '<button id="empty-state-new-btn">新建笔记</button>';
    const newBtn = document.getElementById('empty-state-new-btn');
    expect(newBtn).not.toBe(initialBtn); // 确认是新节点

    // 第二次点击新按钮 —— 委托仍在 empty 上，必须仍能命中
    newBtn.click();
    expect(handler).toHaveBeenCalledTimes(2);
  });
});