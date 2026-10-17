// src/utils.js 的纯函数测试
// 当前覆盖 isMarkdownFile —— 这是 Stage 8 引入的工具，
// 决定一个文件是否能渲染 Markdown 预览（仅 .md / .markdown）。

import { describe, it, expect } from 'vitest';
import {
  isMarkdownFile,
  isPathInside,
  pathsEqual,
  formatSize,
  formatDate,
  formatRelativeTime,
  escapeHtml,
  escapeAttr,
  dirnameOf,
  basenameOf,
  resolvePath,
  toFileUrl,
  safeRenderMarkdown,
} from '../../src/utils.js';

describe('isPathInside', () => {
  it('基本包含关系 → true', () => {
    expect(isPathInside('/data/notes/foo.md', '/data/notes')).toBe(true);
    expect(isPathInside('/data/notes/sub/foo.md', '/data/notes')).toBe(true);
  });

  it('完全相等的路径 → true（自身视为在内）', () => {
    expect(isPathInside('/data/notes', '/data/notes')).toBe(true);
    expect(isPathInside('/data/notes/', '/data/notes')).toBe(true);
    expect(isPathInside('/data/notes', '/data/notes/')).toBe(true);
  });

  it('前缀相同但不是子目录（避免 /foo 包含 /foobar） → false', () => {
    expect(isPathInside('/data/foobar.md', '/data/foo')).toBe(false);
  });

  it('完全不同的路径 → false', () => {
    expect(isPathInside('/etc/passwd', '/data/notes')).toBe(false);
    expect(isPathInside('/data/foo.md', '/var/log')).toBe(false);
  });

  it('parent 是 POSIX 根目录 / → 任何非空 child 都视为在内', () => {
    // 修复点：旧版本 norm('/') → ''，导致 a === '' 与任何 child 都不等、b.startsWith('/') 又为 false，
    // 误判「根目录下没有路径」。现在显式把空前缀视为「任何子路径都在内」。
    expect(isPathInside('/foo/bar', '/')).toBe(true);
    expect(isPathInside('/a', '/')).toBe(true);
    expect(isPathInside('/notes/x.md', '/')).toBe(true);
  });

  it('parent 是 Windows 根盘符 C:\\ → 任何非空 child 都视为在内（jsdom/Windows 测试场景）', () => {
    // 这里没法在 node 里真实触发 isWindows()，但 norm 之后变成 'c:' 是确定的：
    // 直接构造「模拟 Windows」路径。算法只看规范化结果，不依赖平台检测。
    // 这一档测试对应 norm(parent) === 'c:' 的分支。
    expect(isPathInside('C:\\Users\\foo\\note.md', 'C:\\')).toBe(true);
  });

  it('空 child / 空 parent / null → false', () => {
    expect(isPathInside('', '/data')).toBe(false);
    expect(isPathInside('/data/foo.md', '')).toBe(false);
    expect(isPathInside(null, '/data')).toBe(false);
    expect(isPathInside('/data/foo.md', null)).toBe(false);
    expect(isPathInside(undefined, undefined)).toBe(false);
  });

  it('child 仅有分隔符（规范化后为空）→ false', () => {
    // 修复点：避免「//」或「/」被当成合法 child 漏进根目录
    expect(isPathInside('/', '/data')).toBe(false);
    expect(isPathInside('//', '/data')).toBe(false);
  });

  it('混合路径分隔符（正反斜杠）→ 视为相同', () => {
    // norm 把所有 \\ → /，所以 'C:\\data' 与 'C:/data' 等价
    // （node 测试环境下 isWindows 返回 false，不会 lowercase；
    //  这一档主要验证 norm 的归一化效果）
    expect(isPathInside('/data/notes/foo.md', '\\data\\notes')).toBe(true);
  });
});

describe('pathsEqual', () => {
  it('两个相同字符串 → true', () => {
    expect(pathsEqual('/a/b/c', '/a/b/c')).toBe(true);
    expect(pathsEqual('C:\\Users\\foo', 'C:\\Users\\foo')).toBe(true);
  });

  it('空值 / null / undefined → false（仅双空相等视为 false）', () => {
    expect(pathsEqual('', '/a')).toBe(false);
    expect(pathsEqual('/a', '')).toBe(false);
    expect(pathsEqual(null, '/a')).toBe(false);
    expect(pathsEqual('/a', undefined)).toBe(false);
  });

  it('路径内容不同 → false', () => {
    expect(pathsEqual('/a/b', '/a/c')).toBe(false);
    expect(pathsEqual('C:\\foo', 'C:\\bar')).toBe(false);
  });

  // Windows case-fold 行为：jsdom 25 默认 userAgent 是 'Mozilla/5.0 (win32)'
  // → isWindows() 返回 true。所以两条 case 不同的路径在测试环境下应判等。
  // 真实的运行环境（Windows / POSIX）效果以 isPathInside 的 Windows 段已经覆盖的
  // 「跨斜杠 + 大小写不敏感」原则一致 —— 不为「假想平台」造用例。
  it('Windows 路径大小写不敏感：case-fold 后相等 → true', () => {
    // jsdom 默认 mock 是 win32 userAgent → 这条断言测的是真实运行行为
    expect(pathsEqual('C:\\Users\\Foo\\note.md', 'c:\\users\\foo\\note.md')).toBe(true);
    expect(pathsEqual('/A/b.md', '/a/b.md')).toBe(true);
  });
});

describe('isMarkdownFile', () => {
  it('扩展名为 .md → true', () => {
    expect(isMarkdownFile('note.md')).toBe(true);
    expect(isMarkdownFile('/abs/path/to/note.md')).toBe(true);
    expect(isMarkdownFile('C:\\Users\\foo\\notes\\note.md')).toBe(true);
  });

  it('扩展名为 .markdown → true', () => {
    expect(isMarkdownFile('README.markdown')).toBe(true);
    expect(isMarkdownFile('/path/to/README.markdown')).toBe(true);
  });

  it('大小写不敏感', () => {
    expect(isMarkdownFile('Note.MD')).toBe(true);
    expect(isMarkdownFile('Note.Md')).toBe(true);
    expect(isMarkdownFile('Note.Markdown')).toBe(true);
  });

  it('其它可编辑扩展 → false（仅支持编辑，不支持预览）', () => {
    expect(isMarkdownFile('data.json')).toBe(false);
    expect(isMarkdownFile('script.py')).toBe(false);
    expect(isMarkdownFile('config.yaml')).toBe(false);
    expect(isMarkdownFile('plain.txt')).toBe(false);
    expect(isMarkdownFile('main.js')).toBe(false);
    expect(isMarkdownFile('main.ts')).toBe(false);
    expect(isMarkdownFile('styles.css')).toBe(false);
    expect(isMarkdownFile('page.html')).toBe(false);
  });

  it('无扩展名 / 隐藏文件 / 空字符串 → false', () => {
    expect(isMarkdownFile('')).toBe(false);
    expect(isMarkdownFile('.gitignore')).toBe(false);
    expect(isMarkdownFile('Makefile')).toBe(false);
    expect(isMarkdownFile(null)).toBe(false);
    expect(isMarkdownFile(undefined)).toBe(false);
    expect(isMarkdownFile(42)).toBe(false);
  });

  it('以 .md 结尾但不是扩展名（如 .md5、.model）→ false', () => {
    // 防御：'foo.model' 的 lastIndexOf('.') 是 'model' 里的点，但我们按最后一个点判断，
    // 应该是 'l'，所以 false。'foo.md5' 最后一个点是 '.md5' 之前？还是…… 看实现：
    // path.lastIndexOf('.') → 找到最后一个 '.' 的位置。对 'foo.md5'，dot 在 3，
    // 取 dot+1 之后到末尾 'md5'，不是集合里的 md。
    expect(isMarkdownFile('photo.md5')).toBe(false);
    expect(isMarkdownFile('archive.model')).toBe(false);
  });

  it('多点文件名（note.v2.md、a.b.c.markdown）→ true', () => {
    // basename 末段的最后一个点才是扩展名分隔
    expect(isMarkdownFile('note.v2.md')).toBe(true);
    expect(isMarkdownFile('a.b.c.markdown')).toBe(true);
  });

  it('无扩展名的常见文件名 → false', () => {
    expect(isMarkdownFile('README')).toBe(false);
    expect(isMarkdownFile('LICENSE')).toBe(false);
    expect(isMarkdownFile('/abs/path/Makefile')).toBe(false);
  });
});

describe('formatSize', () => {
  it('字节 / KB / MB 分级', () => {
    expect(formatSize(0)).toBe('0 B');
    expect(formatSize(512)).toBe('512 B');
    expect(formatSize(1024)).toBe('1.0 KB');
    expect(formatSize(1536)).toBe('1.5 KB');
    expect(formatSize(1024 * 1024)).toBe('1.0 MB');
    expect(formatSize(1024 * 1024 * 2.5)).toBe('2.5 MB');
  });
  it('非法输入 → 占位符', () => {
    expect(formatSize(-1)).toBe('—');
    expect(formatSize(NaN)).toBe('—');
    expect(formatSize('100')).toBe('—');
    expect(formatSize(null)).toBe('—');
  });
});

describe('formatDate', () => {
  it('YYYY-MM-DD HH:mm', () => {
    // 用本地时区无关的方式构造：直接取 0 时刻附近
    const d = new Date(2024, 0, 15, 9, 5); // 2024-01-15 09:05 本地
    expect(formatDate(d.getTime())).toBe('2024-01-15 09:05');
  });
  it('非法输入 → 空串', () => {
    expect(formatDate(NaN)).toBe('');
    expect(formatDate('xxx')).toBe('');
    expect(formatDate(null)).toBe('');
  });
});

describe('formatRelativeTime', () => {
  const now = new Date(2024, 5, 15, 12, 0, 0).getTime(); // 2024-06-15 12:00:00

  it('< 60s → "刚刚"', () => {
    expect(formatRelativeTime(now - 5_000, now)).toBe('刚刚');
    expect(formatRelativeTime(now - 59_000, now)).toBe('刚刚');
  });
  it('< 60min → "N 分钟前"', () => {
    expect(formatRelativeTime(now - 60_000, now)).toBe('1 分钟前');
    expect(formatRelativeTime(now - 5 * 60_000, now)).toBe('5 分钟前');
    expect(formatRelativeTime(now - 59 * 60_000, now)).toBe('59 分钟前');
  });
  it('同日 < 24h → "N 小时前"', () => {
    expect(formatRelativeTime(now - 60 * 60_000, now)).toBe('1 小时前');
    expect(formatRelativeTime(now - 3 * 60 * 60_000, now)).toBe('3 小时前');
  });
  it('昨天 → "昨天"', () => {
    const yesterday = now - 25 * 60 * 60_000; // 跨过 0 点
    expect(formatRelativeTime(yesterday, now)).toBe('昨天');
  });
  it('< 7d → "N 天前"', () => {
    expect(formatRelativeTime(now - 3 * 86400_000, now)).toBe('3 天前');
    expect(formatRelativeTime(now - 6 * 86400_000, now)).toBe('6 天前');
  });
  it('≥ 7d 且同年 → 紧凑 "MM-DD HH:mm"', () => {
    const old = new Date(2024, 5, 1, 12, 0, 0).getTime(); // now 也在 2024-06
    expect(formatRelativeTime(old, now)).toBe('06-01 12:00');
  });
  it('≥ 7d 且跨年 → "YYYY-MM-DD"（保年份，舍时分）', () => {
    const old = new Date(2023, 5, 1, 12, 0, 0).getTime();
    expect(formatRelativeTime(old, now)).toBe('2023-06-01');
  });
  it('未来时间 → 当成 0 差（"刚刚"）', () => {
    expect(formatRelativeTime(now + 5_000, now)).toBe('刚刚');
  });
  it('非法输入 → 空串', () => {
    expect(formatRelativeTime(NaN, now)).toBe('');
    expect(formatRelativeTime('xxx', now)).toBe('');
    expect(formatRelativeTime(null, now)).toBe('');
    expect(formatRelativeTime(undefined, now)).toBe('');
  });
  it('非法 nowMs → 退回 Date.now() 不报错', () => {
    // 不传 nowMs；should 不抛
    expect(typeof formatRelativeTime(now - 1000)).toBe('string');
    // 显式传非法 nowMs → 内部用 Date.now() 兜底
    expect(typeof formatRelativeTime(now - 1000, NaN)).toBe('string');
  });
});

describe('escapeHtml / escapeAttr', () => {
  it('escapeHtml 转义五个特殊字符', () => {
    expect(escapeHtml('<script>')).toBe('&lt;script&gt;');
    expect(escapeHtml('a & b')).toBe('a &amp; b');
    expect(escapeHtml('"x"')).toBe('&quot;x&quot;');
    expect(escapeHtml("'x'")).toBe('&#39;x&#39;');
    expect(escapeHtml('<a href="x">y</a>')).toBe(
      '&lt;a href=&quot;x&quot;&gt;y&lt;/a&gt;'
    );
  });
  it('null/undefined → 空串', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });
  it('escapeAttr 等价 escapeHtml（语义标识而非行为差异）', () => {
    const inputs = ['<x>', 'a"b', "a'b", 'a&b'];
    for (const s of inputs) {
      expect(escapeAttr(s)).toBe(escapeHtml(s));
    }
  });
});

describe('dirnameOf / basenameOf', () => {
  it('POSIX 路径', () => {
    expect(dirnameOf('/data/notes/foo.md')).toBe('/data/notes');
    expect(basenameOf('/data/notes/foo.md')).toBe('foo.md');
  });
  it('Windows 路径', () => {
    expect(dirnameOf('C:\\Users\\foo\\bar.md')).toBe('C:\\Users\\foo');
    expect(basenameOf('C:\\Users\\foo\\bar.md')).toBe('bar.md');
  });
  it('根目录下的文件', () => {
    expect(dirnameOf('/foo.md')).toBe('/');
    expect(basenameOf('/foo.md')).toBe('foo.md');
  });
  it('无分隔符的文件名', () => {
    expect(dirnameOf('foo.md')).toBe('');
    expect(basenameOf('foo.md')).toBe('foo.md');
  });
  it('非法输入 → 空串', () => {
    expect(dirnameOf('')).toBe('');
    expect(dirnameOf(null)).toBe('');
    expect(basenameOf('')).toBe('');
    expect(basenameOf(undefined)).toBe('');
  });
});

describe('resolvePath', () => {
  it('POSIX 相对路径解析', () => {
    expect(resolvePath('/data/notes', 'foo.md')).toBe('/data/notes/foo.md');
    expect(resolvePath('/data/notes', 'sub/foo.md')).toBe('/data/notes/sub/foo.md');
  });
  it('POSIX 绝对路径原样规范化', () => {
    expect(resolvePath('/data/notes', '/etc/passwd')).toBe('/etc/passwd');
    expect(resolvePath('/data/notes', '/a/./b/../c')).toBe('/a/c');
  });
  it('折叠 "." 和 ".."', () => {
    expect(resolvePath('/data', './foo/./bar.md')).toBe('/data/foo/bar.md');
    expect(resolvePath('/data/sub', '../foo.md')).toBe('/data/foo.md');
    expect(resolvePath('/data/sub/deep', '../../foo.md')).toBe('/data/foo.md');
  });
  it('越过根目录 → null', () => {
    expect(resolvePath('/data', '../../etc/passwd')).toBe(null);
    expect(resolvePath('/', '../foo')).toBe(null);
  });
  it('Windows 盘符路径', () => {
    expect(resolvePath('C:\\data', 'foo.md')).toBe('C:\\data\\foo.md');
    expect(resolvePath('C:\\data', 'C:\\foo.md')).toBe('C:\\foo.md');
  });
  it('空 / 非法输入 → null', () => {
    expect(resolvePath('/data', '')).toBe(null);
    expect(resolvePath('/data', null)).toBe(null);
    expect(resolvePath('/data', undefined)).toBe(null);
  });
});

describe('toFileUrl', () => {
  it('POSIX 绝对路径', () => {
    expect(toFileUrl('/data/notes/foo.md')).toBe('file:///data/notes/foo.md');
  });
  it('Windows 盘符路径', () => {
    expect(toFileUrl('C:\\data\\foo.md')).toBe('file:///C:/data/foo.md');
    expect(toFileUrl('C:/data/foo.md')).toBe('file:///C:/data/foo.md');
  });
  it('文件名含 # / ? / 空格 → 编码但保留盘符冒号', () => {
    expect(toFileUrl('/data/has space/foo.md')).toBe('file:///data/has%20space/foo.md');
    expect(toFileUrl('/data/has#hash/foo.md')).toBe('file:///data/has%23hash/foo.md');
    expect(toFileUrl('/data/has?q=1/foo.md')).toBe('file:///data/has%3Fq%3D1/foo.md');
  });
  it('空 / 非法输入 → 空串', () => {
    expect(toFileUrl('')).toBe('');
    expect(toFileUrl(null)).toBe('');
    expect(toFileUrl(undefined)).toBe('');
  });
});

describe('safeRenderMarkdown', () => {
  // markdown-viewer / ai-diff-panel 共用入口：失败 / 不可用时必须
  // 返回转义后的 <pre>，不能泄漏未转义的原文（XSS fail-closed）。
  // node 环境无 window —— 这里跑的就是 "window 不可用" 的降级分支。

  it('window 不可用 → 降级为 <pre>，转义危险字符', () => {
    const html = safeRenderMarkdown('<script>alert(1)</script>');
    expect(html).toContain('<pre');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
  });

  it('window 不可用 → 纯文本透传', () => {
    const html = safeRenderMarkdown('safe text');
    expect(html).toContain('<pre');
    expect(html).toContain('safe text');
  });

  it('空 / 非法输入 → <pre> 包空内容', () => {
    expect(safeRenderMarkdown('')).toContain('<pre');
    expect(safeRenderMarkdown(null)).toContain('<pre');
    expect(safeRenderMarkdown(undefined)).toContain('<pre');
  });
});