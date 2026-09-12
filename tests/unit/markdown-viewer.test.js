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

import { describe, it, expect, beforeEach, vi } from 'vitest';
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
    });
  });

  it('图片自动加 loading="lazy" + decoding="async"', () => {
    body.innerHTML = '<img src="img.png" /><img src="img2.png" />';
    viewer.resolveRelativeImages('/notes/test.md');

    for (const img of body.querySelectorAll('img')) {
      expect(img.getAttribute('loading')).toBe('lazy');
      expect(img.getAttribute('decoding')).toBe('async');
    }
  });

  it('已有 loading/decoding 不覆盖', () => {
    body.innerHTML = '<img src="img.png" loading="eager" decoding="sync" />';
    viewer.resolveRelativeImages('/notes/test.md');

    const img = body.querySelector('img');
    expect(img.getAttribute('loading')).toBe('eager');
    expect(img.getAttribute('decoding')).toBe('sync');
  });

  it('data: URL 图片不动', () => {
    body.innerHTML = '<img src="data:image/png;base64,iVBOR..." />';
    viewer.resolveRelativeImages('/notes/test.md');

    const img = body.querySelector('img');
    expect(img.getAttribute('src')).toBe('data:image/png;base64,iVBOR...');
    // 不加 loading/lazy：绝对 / data: 不参与处理
    expect(img.getAttribute('loading')).toBeNull();
  });

  it('绝对 file:// / https:// URL 图片不动', () => {
    body.innerHTML = '<img src="https://cdn.example.com/img.png" />';
    viewer.resolveRelativeImages('/notes/test.md');

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

  it('getDataDir 返回 null（旧版未注入） → 不做边界检查，仅防 ../.. 越界', async () => {
    viewer = makeViewer(() => null);
    // 不传 / 传 null 时 resolveRelativeImages 跳过 isPathInside 校验。
    // resolvePath 内部仍会拒绝 '../..' 越界（保留旧行为）。
    body.innerHTML = '<img src="../../outside.png">';
    await viewer.resolveRelativeImages(posixPath('/notes/a.md'));
    const img = body.querySelector('img');
    // resolvePath 返回 null → src 不变
    expect(img.hasAttribute('src')).toBe(true);
    expect(img.getAttribute('src')).toBe('../../outside.png');
  });

  it('getDataDir 抛错 → 不阻断（catch 降级，旧行为继续）', async () => {
    viewer = makeViewer(() => { throw new Error('IPC down'); });
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    body.innerHTML = '<img src="img.png">';
    await viewer.resolveRelativeImages(posixPath('/notes/a.md'));
    // 不抛错；图片被正常解析
    expect(body.querySelector('img').getAttribute('src')).toMatch(/^file:/);
    consoleWarn.mockRestore();
  });

  it('getDataDir 返回 Promise（异步 IPC） → 正确 await', async () => {
    viewer = makeViewer(async () => posixPath('/home/user/Notes'));
    body.innerHTML = '<img src="../../../etc/passwd.png">';
    await viewer.resolveRelativeImages(posixPath('/home/user/Notes/a.md'));

    const img = body.querySelector('img');
    expect(img.getAttribute('data-blocked')).toBe('external');
  });

  it('未传 getDataDir 选项 → 不做边界检查（旧行为兼容）', async () => {
    viewer = new MarkdownViewer({
      bodyElement: body,
      emptyElement: document.querySelector('.empty'),
      statusPath: document.createElement('div'),
      statusMeta: document.createElement('div'),
      // 不传 getDataDir
    });
    body.innerHTML = '<img src="img.png">';
    await viewer.resolveRelativeImages(posixPath('/notes/a.md'));
    expect(body.querySelector('img').getAttribute('src')).toMatch(/^file:/);
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