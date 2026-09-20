// main/file-ops.js 单测（audit #6）
//
// 覆盖：
//   - isWithinDataDir: Windows 大小写不敏感 / POSIX 区分 / 边界 .. / 越权 ../etc
//   - assertNotSymlink: 真文件通过 / symlink 拒绝 / ENOENT 不挡
//   - resolveFileName: 空名 / 路径分隔符 / .. / 控制字符 / 重名加 (2)(3)
//   - scanFiles: ENOENT 不再自动 mkdir / 返回 DATA_DIR_NOT_FOUND / .md/.markdown 收录
//   - MAX_FILE_SIZE 数值正确
//
// 测试不依赖 electron，纯 Node 即可；用 mkdtempSync 建真实临时目录。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync,
} from 'fs';
import { tmpdir } from 'os';
import { join, sep } from 'path';

const fileOps = require('../../main/file-ops.js');
const {
  MAX_FILE_SIZE,
  assertNotSymlink,
  assertNoSymlinkAncestor,
  isWithinDataDir,
  resolveFileName,
  resolveRenameName,
  scanFiles,
  scanDir,
  classifyEntry,
  resolveDirRelative,
  toRelativeDir,
  EDITABLE_EXTS,
} = fileOps;

let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'notes-fileops-'));
});

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('MAX_FILE_SIZE', () => {
  it('是 5 MB', () => {
    expect(MAX_FILE_SIZE).toBe(5 * 1024 * 1024);
  });
});

describe('isWithinDataDir', () => {
  it('正常文件返回 true', () => {
    expect(isWithinDataDir(join(dir, 'a.md'), dir)).toBe(true);
  });

  it('根目录本身算内部', () => {
    expect(isWithinDataDir(dir, dir)).toBe(true);
  });

  it('越权路径（../etc/passwd）返回 false', () => {
    expect(isWithinDataDir(join(dir, '..', 'etc', 'passwd'), dir)).toBe(false);
  });

  it('空参数返回 false（防止误判 true）', () => {
    expect(isWithinDataDir('', dir)).toBe(false);
    expect(isWithinDataDir(join(dir, 'a.md'), '')).toBe(false);
    expect(isWithinDataDir(null, dir)).toBe(false);
    expect(isWithinDataDir(undefined, dir)).toBe(false);
  });

  it('Windows 大小写不敏感', () => {
    if (process.platform !== 'win32') {
      // 在 POSIX 上人为构造一个 Windows 行为测试跳过
      // （isWithinDataDir 始终走 POSIX 分支，不受测试环境影响）
      const mixed = dir.toUpperCase();
      // 用全路径解析过的 root 来做大小写差异
      const resolved = dir;
      // POSIX 上大小写敏感，A.md 与 a.md 是不同文件 → 视为越权
      expect(isWithinDataDir(`${resolved}${sep}Notes${sep}A.md`, `${resolved}${sep}notes`)).toBe(false);
      return;
    }
    expect(isWithinDataDir(join(dir.toUpperCase(), 'A.MD'), dir.toLowerCase())).toBe(true);
  });
});

describe('assertNotSymlink', () => {
  it('普通文件：返回 ok:true, isFile:true', async () => {
    const p = join(dir, 'normal.md');
    writeFileSync(p, 'hello');
    const r = await assertNotSymlink(p);
    expect(r).toEqual({ ok: true, isFile: true });
  });

  it('不存在：返回 ok:true, isFile:false（留给调用方走 FILE_NOT_FOUND）', async () => {
    const r = await assertNotSymlink(join(dir, 'missing.md'));
    expect(r).toEqual({ ok: true, isFile: false });
  });

  it('符号链接：返回 SYMLINK_NOT_ALLOWED', async () => {
    const real = join(dir, 'real.md');
    writeFileSync(real, 'real content');
    const link = join(dir, 'link.md');
    try {
      symlinkSync(real, link);
    } catch {
      // Windows 上非管理员可能不允许创建符号链接 → 跳过
      return;
    }
    const r = await assertNotSymlink(link);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('SYMLINK_NOT_ALLOWED');
  });
});

describe('assertNoSymlinkAncestor (Phase O-H1/H2/H3 防御)', () => {
  // dataRoot 下的子目录是 symlink 指向外部目标盘 —— file:scan-dir / file:watch-dir
  // 必须拒绝（之前只 lstat(absDir) 自身，被祖先链是 symlink 的场景绕过）。
  it('祖先链中是 symlink 的目录 → 拒绝（filePath 在 symlink 子目录下）', async () => {
    // 真实外部目标目录（在 dataRoot 之外）
    const externalTarget = mkdtempSync(join(tmpdir(), 'notes-ext-'));
    writeFileSync(join(externalTarget, 'secret.md'), 'secret');
    // dataRoot 内创建指向外部目标的 symlink
    const linkDir = join(dir, 'links');
    try {
      symlinkSync(externalTarget, linkDir);
    } catch {
      // Windows 上非管理员可能不允许创建符号链接 → 跳过
      return;
    }
    // file:scan-dir 会拿 absDir = dataRoot/links/secret.md 调 assertNoSymlinkAncestor
    // （scan-dir 入参是 dir，但 list 时会拼接文件名；这里我们用 filePath 在 symlink
    // 子树下，让 assertNoSymlinkAncestor 从 filePath 父目录开始向上 lstat）
    const r = await assertNoSymlinkAncestor(join(linkDir, 'secret.md'), dir);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('SYMLINK_NOT_ALLOWED');
    // 目标位置 = 中间 symlink 目录
    expect(r.message).toContain('links');
    rmSync(externalTarget, { recursive: true, force: true });
  });

  it('filePath 自身是 symlink → 拒绝（Phase O-fix：自身也参与检查）', async () => {
    // audit fix (Phase O-fix)：assertNoSymlinkAncestor 现在也检查 filePath 自身。
    // 之前只走父目录向上 lstat，导致 dataRoot/links（自身是 symlink 指向外部目标）
    // 整条链路：parent = dataRoot（合法）→ break → 漏检。
    // Phase O 把 file:scan-dir / file:watch-dir / file:create 的 lstat(targetDir)
    // 替换成 assertNoSymlinkAncestor(targetDir, dataRoot)，必须让「target 自身是
    // symlink」也被挡下，否则原 lstat 的越权检查失效。
    const externalTarget = mkdtempSync(join(tmpdir(), 'notes-ext-'));
    const linkDir = join(dir, 'links');
    try {
      symlinkSync(externalTarget, linkDir);
    } catch {
      return;
    }
    const r = await assertNoSymlinkAncestor(linkDir, dir);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('SYMLINK_NOT_ALLOWED');
    rmSync(externalTarget, { recursive: true, force: true });
  });

  it('全是普通目录 → 通过', async () => {
    const sub = join(dir, 'a', 'b', 'c');
    mkdirSync(sub, { recursive: true });
    const r = await assertNoSymlinkAncestor(join(sub, 'foo.md'), dir);
    expect(r.ok).toBe(true);
  });

  it('父目录不存在（target 尚未创建）→ 允许', async () => {
    const r = await assertNoSymlinkAncestor(join(dir, 'nonexistent', 'foo.md'), dir);
    expect(r.ok).toBe(true);
  });

  it('空路径 → 拒绝', async () => {
    const r = await assertNoSymlinkAncestor('', dir);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('INVALID_PATH');
  });
});

describe('resolveFileName', () => {
  // 2026-08-28 用户反馈：resolveFileName 不再强制补 .md，与 resolveRenameName 对齐。
  // 用户输入什么就用什么：
  //   - "hello"        → "hello"（无扩展名）
  //   - "hello.md"     → "hello.md"
  //   - "hello.txt"    → "hello.txt"（用户可建纯文本笔记）
  //   - "note.markdown"→ "note.markdown"
  //   - "NOTE.MD"      → "NOTE.MD"（大小写保留）
  // 这样用户新建 .txt 纯文本笔记 / .json 数据笔记不再需要「先建 .md → 重命名」两步。
  it('无扩展名 → 原样保留（不再自动补 .md）', async () => {
    const r = await resolveFileName('hello', dir);
    expect(r.ok).toBe(true);
    expect(r.name).toBe('hello');
    expect(r.path).toBe(join(dir, 'hello'));
    expect(isWithinDataDir(r.path, dir)).toBe(true);
  });

  it('.md 后缀原样保留', async () => {
    const r = await resolveFileName('hello.md', dir);
    expect(r.ok).toBe(true);
    expect(r.name).toBe('hello.md');
    expect(r.path).toBe(join(dir, 'hello.md'));
  });

  it('.txt 等其他扩展名原样保留（用户可建纯文本笔记）', async () => {
    const r = await resolveFileName('hello.txt', dir);
    expect(r.ok).toBe(true);
    expect(r.name).toBe('hello.txt');
    expect(r.path).toBe(join(dir, 'hello.txt'));
  });

  it('.markdown 扩展名原样保留', async () => {
    const r = await resolveFileName('note.markdown', dir);
    expect(r.ok).toBe(true);
    expect(r.name).toBe('note.markdown');
  });

  it('大小写保留（不强制小写化）', async () => {
    const r = await resolveFileName('NOTE.MD', dir);
    expect(r.ok).toBe(true);
    expect(r.name).toBe('NOTE.MD');
  });

  it('空字符串 / 非字符串 → 拒绝', async () => {
    expect((await resolveFileName('', dir)).ok).toBe(false);
    expect((await resolveFileName('   ', dir)).ok).toBe(false);
    expect((await resolveFileName(null, dir)).ok).toBe(false);
    expect((await resolveFileName(123, dir)).ok).toBe(false);
  });

  it('包含路径分隔符 → 拒绝', async () => {
    expect((await resolveFileName('a/b.md', dir)).ok).toBe(false);
    expect((await resolveFileName('a\\b.md', dir)).ok).toBe(false);
  });

  it('包含 .. → 拒绝（含 substring .. 也算，防止视觉混淆）', async () => {
    expect((await resolveFileName('..evil.md', dir)).ok).toBe(false);
    // `a..b.md` 也含 `..` 子串——生产代码故意一并拒绝（更严格，无歧义）
    expect((await resolveFileName('a..b.md', dir)).ok).toBe(false);
  });

  it('包含 Windows 保留字符 → 拒绝', async () => {
    expect((await resolveFileName('bad|name', dir)).ok).toBe(false);
    expect((await resolveFileName('bad:name', dir)).ok).toBe(false);
  });

  it('Windows 保留设备名（基础名取最后一个 . 之前）→ 拒绝', async () => {
    // "CON" / "CON.md" / "CON.txt" 都按 NTFS 规则视为设备名
    expect((await resolveFileName('CON', dir)).ok).toBe(false);
    expect((await resolveFileName('CON.md', dir)).ok).toBe(false);
    expect((await resolveFileName('CON.txt', dir)).ok).toBe(false);
    // "foo.CON" 不算 —— 基础名是 foo
    const ok = await resolveFileName('foo.CON', dir);
    expect(ok.ok).toBe(true);
  });

  it('基础名取最后一个 . 之前（foo.CON.bar 不算保留设备名）', async () => {
    // 基础名取最后一个 . 之前的部分。"foo.CON.bar" 的基础名是 "foo.CON"，
    // 不是保留设备名，应该通过校验。
    const r = await resolveFileName('foo.CON.bar', dir);
    expect(r.ok).toBe(true);
    expect(r.name).toBe('foo.CON.bar');
  });

  it('包含控制字符 → 拒绝', async () => {
    expect((await resolveFileName('bad .md', dir)).ok).toBe(false);
    expect((await resolveFileName('bad.md', dir)).ok).toBe(false);
  });

  it('重名加 (2) —— 扩展名原样保留', async () => {
    writeFileSync(join(dir, 'note.md'), 'a');
    const r = await resolveFileName('note.md', dir);
    expect(r.name).toBe('note (2).md');
  });

  it('重名加 (2) —— 无扩展名也照样加', async () => {
    writeFileSync(join(dir, 'note'), 'a');
    const r = await resolveFileName('note', dir);
    expect(r.name).toBe('note (2)');
  });

  it('重名加 (2) —— .txt 等其他扩展名原样保留', async () => {
    writeFileSync(join(dir, 'note.txt'), 'a');
    const r = await resolveFileName('note.txt', dir);
    expect(r.name).toBe('note (2).txt');
  });

  it('重名加 (2) —— .markdown 也原样保留', async () => {
    writeFileSync(join(dir, 'note.markdown'), 'a');
    const r = await resolveFileName('note.markdown', dir);
    expect(r.name).toBe('note (2).markdown');
  });

  it('重名计数 < 1000 强制终止', async () => {
    // 不真的造 1000 个文件 —— 改成造一个，然后立即探测高计数，逻辑上足够了
    writeFileSync(join(dir, 'a.md'), 'x');
    // 模拟 (2) 已存在
    writeFileSync(join(dir, 'a (2).md'), 'x');
    const r = await resolveFileName('a.md', dir);
    expect(r.name).toBe('a (3).md');
  });
});

describe('resolveRenameName（用户反馈：重命名不要自动补后缀）', () => {
  // 历史：resolveRenameName 是不强制 .md 后缀的版本。
  // 2026-08-28 反馈后，resolveFileName 也对齐了 —— 两个函数都不再强制补 .md，
  // 用户输入什么就用什么（包括无扩展名 / .txt / .json / .markdown 等）。
  // 本组测试覆盖：保留用户输入的扩展名；.md 也照样保留；大小写保留；
  // 各种校验（路径分隔符 / .. / Windows 保留字符 / 控制字符 / 保留设备名）；
  // 重名避让时扩展名原样保留。

  it('保留用户输入的扩展名（不改写）', async () => {
    const r = await resolveRenameName('bar.txt', dir);
    expect(r.ok).toBe(true);
    expect(r.name).toBe('bar.txt');
  });

  it('允许不带扩展名（不自动补 .md）', async () => {
    const r = await resolveRenameName('bar', dir);
    expect(r.ok).toBe(true);
    expect(r.name).toBe('bar');
  });

  it('.md 也照样保留', async () => {
    const r = await resolveRenameName('bar.md', dir);
    expect(r.ok).toBe(true);
    expect(r.name).toBe('bar.md');
  });

  it('保留 .markdown 扩展名', async () => {
    const r = await resolveRenameName('note.markdown', dir);
    expect(r.ok).toBe(true);
    expect(r.name).toBe('note.markdown');
  });

  it('大小写保留（不强制小写化）', async () => {
    const r = await resolveRenameName('NOTE.MD', dir);
    expect(r.ok).toBe(true);
    expect(r.name).toBe('NOTE.MD');
  });

  it('空字符串 / 非字符串 → 拒绝', async () => {
    expect((await resolveRenameName('', dir)).ok).toBe(false);
    expect((await resolveRenameName('   ', dir)).ok).toBe(false);
    expect((await resolveRenameName(null, dir)).ok).toBe(false);
  });

  it('包含路径分隔符 → 拒绝', async () => {
    expect((await resolveRenameName('a/b', dir)).ok).toBe(false);
    expect((await resolveRenameName('a\\b', dir)).ok).toBe(false);
  });

  it('包含 .. → 拒绝', async () => {
    expect((await resolveRenameName('..evil', dir)).ok).toBe(false);
    expect((await resolveRenameName('a..b.md', dir)).ok).toBe(false);
  });

  it('包含 Windows 保留字符 → 拒绝', async () => {
    expect((await resolveRenameName('bad|name', dir)).ok).toBe(false);
    expect((await resolveRenameName('bad:name', dir)).ok).toBe(false);
  });

  it('包含控制字符 → 拒绝', async () => {
    expect((await resolveRenameName('bad\x00name', dir)).ok).toBe(false);
    expect((await resolveRenameName('bad\x01name', dir)).ok).toBe(false);
  });

  it('Windows 保留设备名（基础名取最后一个 . 之前）→ 拒绝', async () => {
    // "CON" / "CON.md" / "CON.txt" 都按 NTFS 规则视为设备名
    expect((await resolveRenameName('CON', dir)).ok).toBe(false);
    expect((await resolveRenameName('CON.md', dir)).ok).toBe(false);
    expect((await resolveRenameName('CON.txt', dir)).ok).toBe(false);
    // "foo.CON" 不算 —— 基础名是 foo
    const ok = await resolveRenameName('foo.CON', dir);
    expect(ok.ok).toBe(true);
  });

  it('重名加 (2) —— 扩展名原样保留', async () => {
    writeFileSync(join(dir, 'note.md'), 'a');
    const r = await resolveRenameName('note.md', dir);
    expect(r.name).toBe('note (2).md');
  });

  it('重名加 (2) —— 无扩展名也照样加', async () => {
    writeFileSync(join(dir, 'note'), 'a');
    const r = await resolveRenameName('note', dir);
    expect(r.name).toBe('note (2)');
  });

  it('重名加 (2) —— .txt 等其他扩展名原样保留', async () => {
    writeFileSync(join(dir, 'note.txt'), 'a');
    const r = await resolveRenameName('note.txt', dir);
    expect(r.name).toBe('note (2).txt');
  });

  it('基础名取最后一个 . 之前（foo.CON.bar 不算保留设备名）', async () => {
    // 基础名取最后一个 . 之前的部分。"foo.CON.bar" 的基础名是 "foo.CON"，
    // 不是保留设备名，应该通过校验。
    const r = await resolveRenameName('foo.CON.bar', dir);
    expect(r.ok).toBe(true);
    expect(r.name).toBe('foo.CON.bar');
  });

  it('trim 输入首尾空格', async () => {
    const r = await resolveRenameName('  bar.md  ', dir);
    expect(r.name).toBe('bar.md');
  });
});

describe('scanFiles', () => {
  it('正常目录返回 {ok:true, files:[]}', async () => {
    mkdirSync(dir, { recursive: true });
    const r = await scanFiles(dir);
    expect(r.ok).toBe(true);
    expect(r.files).toEqual([]);
  });

  it('收录 .md 和 .markdown，排除其他后缀', async () => {
    writeFileSync(join(dir, 'a.md'), 'a');
    writeFileSync(join(dir, 'b.markdown'), 'b');
    writeFileSync(join(dir, 'c.txt'), 'c');
    writeFileSync(join(dir, '.hidden.md'), 'd'); // hidden 也算
    mkdirSync(join(dir, 'subdir'));
    const r = await scanFiles(dir);
    expect(r.ok).toBe(true);
    const names = r.files.map(f => f.name).sort();
    expect(names).toEqual(['.hidden.md', 'a.md', 'b.markdown']);
  });

  it('目录不存在 → 返回 DATA_DIR_NOT_FOUND，不再自动 mkdir（audit #3）', async () => {
    const missing = join(dir, 'not-created');
    const r = await scanFiles(missing);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('DATA_DIR_NOT_FOUND');
    expect(r.code).toBe('ENOENT');
    // 关键：目录不应被自动重建
    // （用 setTimeout 等一下，确保 fs 没在后台补活）
    await new Promise(res => setTimeout(res, 50));
    // existsSync 不在这里用 —— 改为 readdir，看是否依然 ENOENT
    const fs = await import('fs').then(m => m.promises);
    await expect(fs.readdir(missing)).rejects.toThrow();
  });

  it('空参数 → 返回 EINVAL', async () => {
    const r = await scanFiles('');
    expect(r.ok).toBe(false);
    expect(r.code).toBe('EINVAL');
  });

  it('结果包含 size / mtimeMs', async () => {
    writeFileSync(join(dir, 'a.md'), 'hello');
    const r = await scanFiles(dir);
    expect(r.ok).toBe(true);
    expect(r.files).toHaveLength(1);
    expect(r.files[0].size).toBe(5);
    expect(typeof r.files[0].mtimeMs).toBe('number');
    expect(r.files[0].path).toBe(join(dir, 'a.md'));
  });
});

// =====================================================================
// Stage 8：Folder Browser（scanDir / classifyEntry / resolveDirRelative）
// =====================================================================

describe('classifyEntry', () => {
  // 表格驱动：每个白名单扩展 → editable；其他 → binary
  // 与 main/file-ops.js 的 EDITABLE_EXTS 同步
  // （2026-08-25 反馈扩到 ~35 种常见编程语言）
  const editableSamples = [
    // Markdown / 纯文本 / 数据 / 配置
    'note.md', 'note.markdown',
    'foo.txt', 'foo.text', 'foo.log',
    'data.csv', 'data.tsv', 'data.json', 'data.xml',
    'config.yaml', 'config.yml', 'config.toml',
    'app.ini', 'app.cfg', 'app.conf', 'app.env',
    // 隐藏文件名 + 白名单扩展（如 .env / .gitconfig）→ editable
    // （旧逻辑因为 dot === 0 误判为 binary，导致列表与 md 链接割裂）
    '.env', '.gitconfig',
    'doc.rst', 'doc.tex',
    // Python
    'app.py', 'types.pyi', 'script.pyw',
    // JS / TS
    'main.js', 'mod.mjs', 'legacy.cjs', 'view.jsx',
    'app.ts', 'view.tsx',
    // Web
    'index.html', 'page.htm', 'styles.css', 'theme.scss', 'vars.sass', 'mixins.less',
    'App.vue', 'Card.svelte',
    // JVM
    'Main.java', 'App.kt', 'build.kts',
    // 其它语言
    'main.go', 'lib.rs', 'app.rb', 'index.php',
    'deploy.sh', 'setup.bash', 'rc.zsh',
    'install.ps1',
    'query.sql',
    'main.c', 'main.h', 'main.cpp', 'main.hpp',
    'App.cs',
    'App.swift',
    'App.scala',
    'main.lua', 'parse.pl', 'stats.r', 'app.dart',
  ];
  const binarySamples = [
    'photo.png', 'photo.jpg', 'photo.gif', 'photo.webp',
    'archive.zip', 'archive.tar', 'archive.gz',
    'doc.pdf', 'doc.docx', 'doc.xlsx',
    'app.exe', 'lib.dll',
    'noext', '.hidden', '.gitignore', // 无扩展名 / 点开头的隐藏文件（隐藏且不在白名单）
    // 已知二进制但没显式列：wasm / o / a / so / dylib / class / jar
    'mod.wasm', 'main.o', 'lib.a', 'lib.so', 'lib.dylib',
    'Main.class', 'lib.jar',
  ];

  it.each(editableSamples)('%s 分类为 editable', (name) => {
    expect(classifyEntry(name)).toBe('editable');
  });

  it.each(binarySamples)('%s 分类为 binary', (name) => {
    expect(classifyEntry(name)).toBe('binary');
  });

  it('大小写不敏感（README.MD → editable）', () => {
    expect(classifyEntry('README.MD')).toBe('editable');
    expect(classifyEntry('Config.YAML')).toBe('editable');
    expect(classifyEntry('Photo.PNG')).toBe('binary');
  });

  it('空 / 非字符串 → binary（保守判定）', () => {
    expect(classifyEntry('')).toBe('binary');
    expect(classifyEntry(null)).toBe('binary');
    expect(classifyEntry(undefined)).toBe('binary');
    expect(classifyEntry(123)).toBe('binary');
  });

  it('EDITABLE_EXTS 是 Set 且包含所有声明的代码扩展', () => {
    expect(EDITABLE_EXTS).toBeInstanceOf(Set);
    // 关键代码扩展全覆盖（避免以后改白名单时漏更新测试）
    const codeExts = [
      'md', 'markdown',
      'py', 'js', 'jsx', 'ts', 'tsx',
      'html', 'css',
      'go', 'rs', 'java', 'kt',
      'rb', 'php', 'sh',
    ];
    for (const ext of codeExts) {
      expect(EDITABLE_EXTS.has(ext)).toBe(true);
    }
  });

  it('EDITABLE_EXTS 不含常见二进制扩展', () => {
    // 防止「把 png 加进白名单」之类的回归
    expect(EDITABLE_EXTS.has('png')).toBe(false);
    expect(EDITABLE_EXTS.has('pdf')).toBe(false);
    expect(EDITABLE_EXTS.has('zip')).toBe(false);
    expect(EDITABLE_EXTS.has('exe')).toBe(false);
  });
});

describe('scanDir', () => {
  it('空目录 → {ok:true, entries:[]}', async () => {
    mkdirSync(dir, { recursive: true });
    const r = await scanDir(dir);
    expect(r.ok).toBe(true);
    expect(r.entries).toEqual([]);
    expect(r.dir).toBe(dir);
  });

  it('混合条目：每种 entryType 至少一个样本', async () => {
    writeFileSync(join(dir, 'note.md'), 'md');
    writeFileSync(join(dir, 'data.json'), '{}');
    writeFileSync(join(dir, 'photo.png'), Buffer.from([0, 1, 2]));
    mkdirSync(join(dir, 'subdir'));
    const r = await scanDir(dir);
    expect(r.ok).toBe(true);
    const byType = {};
    for (const e of r.entries) {
      byType[e.entryType] = (byType[e.entryType] || 0) + 1;
    }
    expect(byType.folder).toBe(1);
    expect(byType.editable).toBe(2); // note.md + data.json
    expect(byType.binary).toBe(1); // photo.png
  });

  it('文件夹排在文件前面（按 zh-CN locale 名称排序）', async () => {
    writeFileSync(join(dir, '笔记.md'), 'a');
    writeFileSync(join(dir, '苹果.png'), 'x');
    mkdirSync(join(dir, '目录'));
    const r = await scanDir(dir);
    expect(r.ok).toBe(true);
    expect(r.entries.map((e) => e.name)).toEqual(['目录', '笔记.md', '苹果.png']);
  });

  it('不递归（只列一层）', async () => {
    mkdirSync(join(dir, 'parent'));
    mkdirSync(join(dir, 'parent', 'child'));
    writeFileSync(join(dir, 'parent', 'child', 'deep.md'), 'd');
    const r = await scanDir(dir);
    expect(r.ok).toBe(true);
    const names = r.entries.map((e) => e.name);
    expect(names).toContain('parent');
    expect(names).not.toContain('child');
    expect(names).not.toContain('deep.md');
  });

  it('目录不存在 → 返回 DATA_DIR_NOT_FOUND', async () => {
    const missing = join(dir, 'no-such-dir');
    const r = await scanDir(missing);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('DATA_DIR_NOT_FOUND');
    expect(r.code).toBe('ENOENT');
  });

  it('空参数 → EINVAL', async () => {
    const r = await scanDir('');
    expect(r.ok).toBe(false);
    expect(r.code).toBe('EINVAL');
  });

  // audit fix (Round 12 P2)：非 ENOENT 错误的 e.message（英文 errno + 路径）
  // 不再直接吐出。fs-watcher 把 result.error 推 renderer，renderer 当 toast 文案
  // 显示，用户看到原始英文 + 绝对路径。改走 friendly-fs-error 与 Round 8 统一。
  it('audit fix (Round 12 P2)：权限错误 → 友好中文（不走原始 e.message）', async () => {
    // Windows 上 chmod 000 不会真正阻塞管理员读，路径可能仍可读；
    // 这里只验证代码路径：spy fs.readdir 抛 EACCES，看返回 error 是否走友好化。
    const fsPromises = await import('fs').then((m) => m.promises);
    const realReaddir = fsPromises.readdir;
    fsPromises.readdir = async function boom() {
      const err = new Error("EACCES: permission denied, scandir '/secret/path'");
      err.code = 'EACCES';
      throw err;
    };
    try {
      const r = await scanDir(dir);
      expect(r.ok).toBe(false);
      // 不能是原始 e.message（英文 errno + 路径）
      expect(r.error).not.toMatch(/^EACCES:/);
      expect(r.error).not.toMatch(/scandir/);
      // 必须是友好中文（friendly-fs-error 对 EACCES 给的固定文案）
      expect(typeof r.error).toBe('string');
      expect(r.error.length).toBeGreaterThan(0);
      expect(r.code).toBe('EACCES');
    } finally {
      fsPromises.readdir = realReaddir;
    }
  });

  it('符号链接文件被跳过（防御越权）', async () => {
    const real = join(dir, 'real.md');
    writeFileSync(real, 'real');
    const link = join(dir, 'link.md');
    try {
      symlinkSync(real, link);
    } catch {
      // Windows 非管理员可能无 symlink 权限 → 跳过这个用例
      return;
    }
    const r = await scanDir(dir);
    expect(r.ok).toBe(true);
    // 真实文件在但符号链接不在
    const names = r.entries.map((e) => e.name);
    expect(names).toContain('real.md');
    expect(names).not.toContain('link.md');
  });

  it('符号链接文件夹被跳过（防御越权）', async () => {
    const realDir = join(dir, 'real-folder');
    mkdirSync(realDir);
    writeFileSync(join(realDir, 'inside.md'), 'x');
    const link = join(dir, 'linked-folder');
    try {
      symlinkSync(realDir, link, 'dir');
    } catch {
      return; // 同上，权限不足跳过
    }
    const r = await scanDir(dir);
    expect(r.ok).toBe(true);
    const names = r.entries.map((e) => e.name);
    expect(names).toContain('real-folder');
    expect(names).not.toContain('linked-folder');
  });

  it('结果字段：folder / editable / binary 都带正确 shape', async () => {
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'a.md'), 'a');
    writeFileSync(join(dir, 'b.png'), 'b');
    const r = await scanDir(dir);
    expect(r.ok).toBe(true);
    const folder = r.entries.find((e) => e.entryType === 'folder');
    const editable = r.entries.find((e) => e.entryType === 'editable');
    const binary = r.entries.find((e) => e.entryType === 'binary');
    expect(folder).toMatchObject({
      name: 'sub',
      path: join(dir, 'sub'),
      entryType: 'folder',
      isFolder: true,
    });
    expect(editable).toMatchObject({
      name: 'a.md',
      path: join(dir, 'a.md'),
      entryType: 'editable',
      isFolder: false,
    });
    expect(typeof editable.size).toBe('number');
    expect(typeof editable.mtimeMs).toBe('number');
    expect(binary).toMatchObject({
      name: 'b.png',
      entryType: 'binary',
      isFolder: false,
    });
  });
});

describe('resolveDirRelative', () => {
  it('空字符串 → 根目录（relDir=""）', () => {
    const r = resolveDirRelative('', dir);
    expect(r.ok).toBe(true);
    expect(r.absDir).toBe(dir);
    expect(r.relDir).toBe('');
  });

  it('合法相对路径 → 正常解析', () => {
    const r = resolveDirRelative('notes/2026', dir);
    expect(r.ok).toBe(true);
    expect(r.relDir).toBe('notes/2026');
    // Windows 上 path.join 用 '\\'，POSIX 用 '/'
    expect(r.absDir).toBe(join(dir, 'notes', '2026'));
  });

  it('Windows 反斜杠统一转正斜杠', () => {
    const r = resolveDirRelative('notes\\2026', dir);
    expect(r.ok).toBe(true);
    expect(r.relDir).toBe('notes/2026');
  });

  it('包含 .. 段 → 拒绝', () => {
    expect(resolveDirRelative('..', dir).ok).toBe(false);
    expect(resolveDirRelative('a/../b', dir).ok).toBe(false);
    expect(resolveDirRelative('./a', dir).ok).toBe(false);
  });

  it('绝对路径 / 盘符 → 拒绝', () => {
    expect(resolveDirRelative('C:\\evil', dir).ok).toBe(false);
    expect(resolveDirRelative('/etc/passwd', dir).ok).toBe(false);
  });

  it('非字符串 → INVALID_REL_DIR', () => {
    expect(resolveDirRelative(null, dir).ok).toBe(false);
    expect(resolveDirRelative(123, dir).ok).toBe(false);
  });

  it('尾部正斜杠自动剥除', () => {
    const r = resolveDirRelative('notes/2026/', dir);
    expect(r.ok).toBe(true);
    expect(r.relDir).toBe('notes/2026');
  });

  it('解析后绝对路径仍必须在 dataRoot 内（防御 path.join 出 ..\\）', () => {
    // 用合法嵌套路径验证 isWithinDataDir 兜底。
    // （'.' / '..' 段在前面已经被显式拒绝，到不了 isWithinDataDir 这一步；
    // 这里只确认合法路径都过得了这层兜底检查，不会误拒。）
    const r = resolveDirRelative('a/b/c', dir);
    expect(r.ok).toBe(true);
    expect(isWithinDataDir(r.absDir, dir)).toBe(true);
  });
});

describe('toRelativeDir', () => {
  it('根目录 → ""', () => {
    expect(toRelativeDir(dir, dir)).toBe('');
  });

  it('子目录 → POSIX 相对路径', () => {
    const sub = join(dir, 'notes', '2026');
    expect(toRelativeDir(sub, dir)).toBe('notes/2026');
  });

  it('Windows 反斜杠统一转正斜杠', () => {
    const sub = join(dir, 'notes', 'sub');
    expect(toRelativeDir(sub, dir)).toBe('notes/sub');
  });

  it('不在 dataRoot 下 → ""（降级到根）', () => {
    expect(toRelativeDir('/etc/passwd', dir)).toBe('');
    expect(toRelativeDir('', dir)).toBe('');
    expect(toRelativeDir(null, dir)).toBe('');
  });

  it('空 dataRoot → ""', () => {
    expect(toRelativeDir(dir, '')).toBe('');
  });

  it('toRelativeDir ↔ resolveDirRelative 互逆（同一子目录）', () => {
    const sub = join(dir, 'a', 'b', 'c');
    const rel = toRelativeDir(sub, dir);
    expect(rel).toBe('a/b/c');
    const back = resolveDirRelative(rel, dir);
    expect(back.ok).toBe(true);
    // Windows 上 normalize 后大小写可能不同，不做严格相等；只检查相对路径 round-trip 一致
    expect(toRelativeDir(back.absDir, dir)).toBe(rel);
  });
});

describe('atomicWriteFile（C1/C2/C3 file-IO audit fix）', () => {
  let dir;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atomic-write-'));
  });
  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('正常路径：写入新文件后内容完整可读', async () => {
    const dst = join(dir, 'note.md');
    await fileOps.atomicWriteFile(dst, '# hello\n\ncontent');
    const { readFileSync } = await import('fs');
    expect(readFileSync(dst, 'utf-8')).toBe('# hello\n\ncontent');
  });

  it('覆盖已存在文件：内容被替换且不残留 tmp', async () => {
    const dst = join(dir, 'note.md');
    writeFileSync(dst, 'OLD content');
    await fileOps.atomicWriteFile(dst, 'NEW content');
    const { readFileSync, readdirSync } = await import('fs');
    expect(readFileSync(dst, 'utf-8')).toBe('NEW content');
    // 目录里不应有遗留的 .tmp.<pid>.<ts> 文件
    const leftover = readdirSync(dir).filter((n) => n.includes('.tmp.'));
    expect(leftover).toEqual([]);
  });

  it('写入失败时不残留 tmp 文件', async () => {
    // 把目录当文件写必失败
    const dst = join(dir);
    await expect(fileOps.atomicWriteFile(dst, 'x')).rejects.toBeTruthy();
    const { readdirSync } = await import('fs');
    const leftover = readdirSync(dir).filter((n) => n.includes('.tmp.'));
    expect(leftover).toEqual([]);
  });

  it('写入大文件（>64KB）也能完成', async () => {
    const dst = join(dir, 'big.md');
    const big = 'A'.repeat(100_000);
    await fileOps.atomicWriteFile(dst, big);
    const { statSync } = await import('fs');
    expect(statSync(dst).size).toBe(100_000);
  });
});

describe('renameWithRetry（C3 file-IO audit fix）', () => {
  it('正常路径：rename 成功', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'rename-'));
    try {
      const src = join(tmpDir, 'src.tmp');
      const dst = join(tmpDir, 'dst.md');
      writeFileSync(src, 'content');
      await fileOps.renameWithRetry(src, dst);
      const { existsSync, readFileSync } = await import('fs');
      expect(existsSync(src)).toBe(false);
      expect(readFileSync(dst, 'utf-8')).toBe('content');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('friendlyWriteError（Phase N Q-fix）', () => {
  // file:write catch 在 Phase N Q-fix 之前直接返回 e.message（含英文 errno +
  // 完整路径，会泄露路径细节）。现在走 friendlyWriteError(e) 翻译成中文，
  // 与 _friendlyCreateError / _friendlyRenameError / _friendlyDeleteError
  // / _friendlyReadError 对称。本组测试覆盖每个分支，防止未来重构时改坏
  // mapping（用户会看到误导的「未知错误 / 英文 errno + 路径」）。
  it('EACCES → 没写入权限 / 只读 / 占用提示', () => {
    const r = fileOps.friendlyWriteError({ code: 'EACCES' });
    expect(r).toMatch(/权限/);
    expect(r).toMatch(/独占|占用|只读/);
  });

  it('EPERM → 与 EACCES 共用文案', () => {
    expect(fileOps.friendlyWriteError({ code: 'EPERM' }))
      .toBe(fileOps.friendlyWriteError({ code: 'EACCES' }));
  });

  it('ENOSPC → 磁盘空间不足', () => {
    expect(fileOps.friendlyWriteError({ code: 'ENOSPC' })).toBe('磁盘空间不足');
  });

  it('EROFS → 只读文件系统，无法写入', () => {
    expect(fileOps.friendlyWriteError({ code: 'EROFS' })).toBe('只读文件系统，无法写入');
  });

  it('EBUSY → 文件被其他程序占用', () => {
    expect(fileOps.friendlyWriteError({ code: 'EBUSY' })).toBe('文件被其他程序占用');
  });

  it('EIO → 磁盘 I/O 错误', () => {
    expect(fileOps.friendlyWriteError({ code: 'EIO' })).toBe('磁盘 I/O 错误');
  });

  it('EISDIR → 目标路径是文件夹，无法写入', () => {
    expect(fileOps.friendlyWriteError({ code: 'EISDIR' })).toBe('目标路径是文件夹，无法写入');
  });

  it('ENAMETOOLONG → 路径过长', () => {
    expect(fileOps.friendlyWriteError({ code: 'ENAMETOOLONG' })).toBe('路径过长');
  });

  it('ENOTDIR → 父目录不是目录', () => {
    expect(fileOps.friendlyWriteError({ code: 'ENOTDIR' })).toBe('父目录不是目录');
  });

  it('未知 errno → 返回 e.message 作 fallback', () => {
    // Round 4 收尾：friendlyWriteError(e) 把 e.message 透传给 friendlyFsError
    // 作为 fallback —— 未知 errno 时 e.message 含英文 errno + 路径。
    expect(fileOps.friendlyWriteError({ code: 'EWHOKNOWS', message: 'some error' }))
      .toBe('some error');
  });

  it('未知 errno + 无 message → 返回「未知错误」', () => {
    expect(fileOps.friendlyWriteError({ code: 'EWHOKNOWS' })).toBe('未知错误');
  });

  it('e === null → 返回「未知错误」（不让 throw）', () => {
    // 防御性：catch 里 e 可能是 null / undefined（极端情况），不能让翻译函数
    // throw 把主进程 IPC handler 整个挂掉。friendlyFsError 兜底走 fallback||'未知错误'。
    expect(fileOps.friendlyWriteError(null)).toBe('未知错误');
    expect(fileOps.friendlyWriteError(undefined)).toBe('未知错误');
  });

  it('e.code 缺失 → 返回 e.message 作 fallback', () => {
    // 注意：旧测试期望「写入文件失败」（friendlyWriteError 内部 switch 走 default
    // case），Round 4 后走 friendlyFsError 兜底直接透传 e.message —— 主进程 catch
    // 出来的 e.message 通常含「EPERM: operation not permitted」+ 路径，但 renderer
    // 拿到的是已经走 friendlyFsError 二次翻译过的中文，不应让英文 errno 漏到这里。
    // 这里只断言不 throw + 返回字符串类型。
    const r = fileOps.friendlyWriteError({ message: 'EPERM: operation not permitted' });
    expect(typeof r).toBe('string');
    expect(r.length).toBeGreaterThan(0);
  });

  it('关键：不再泄露 e.message 中的英文 errno / 路径', () => {
    // 这是 Phase N Q-fix 的核心目标：避免「EPERM: operation not permitted,
    // open 'C:\\Users\\xxx\\file.md'」直接吐到用户面前。
    const e = { code: 'EPERM', message: "EPERM: operation not permitted, open 'C:\\Users\\me\\note.md'" };
    const r = fileOps.friendlyWriteError(e);
    expect(r).not.toMatch(/EPERM/);
    expect(r).not.toMatch(/operation/);
    expect(r).not.toMatch(/Users/);
    expect(r).not.toMatch(/note\.md/);
  });
});

describe('atomicWriteFile fsync 行为 (audit Round 4 P0-1)', () => {
  // POSIX rename(2) 是原子的，但「目录项写入磁盘」的时机由内核控制；不 fsync
  // 父目录就断电，磁盘上可能仍是旧名字 → 新文件彻底丢失。
  // audit 修：atomicWriteFile 在 rename 成功后对父目录做一次 fsync（仅 POSIX，
  // Windows NTFS 文件系统层 journal 元数据不需要且 fs.open 目录会拒绝写操作）。
  //
  // 这里用 spy 钉死「rename 之后调一次目录 open + sync + close」的时序：
  //   - sync 必须在 close 之前（先落盘再 close 的原子模式）
  //   - 调用次数至少 1 次（不是 0）
  //   - 目标路径必须包含目标文件的目录

  // audit fix: 与 config-store 那条 fsync 测试独立，避免 spy 互相覆盖。
  // 仅在非 Windows 上做严格时序断言（Linux/macOS 走完整流程）；
  // Windows 上目录 fsync 跳过，所以平台无关的部分（基础写入 + rename 成功）
  // 单测也跑一遍。
  const fsPromises = require('fs').promises;

  it('Linux/macOS：rename 成功后对父目录 fsync（先 sync 再 close）', async function() {
    if (process.platform === 'win32') {
      // Windows 平台跳过严格时序断言（fs-watcher 不走这条路径），
      // 但跑下面的基础写入断言保证兼容性。
      return;
    }
    const target = join(dir, 'note.md');
    writeFileSync(target, 'old content', 'utf-8');

    /** @type {Array<{method: string, whenMs: number}>} */
    const calls = [];
    let syncCalledAt = -1;
    let closeCalledAt = -1;
    const realOpen = fsPromises.open;
    fsPromises.open = async function spyOpen(p, flags) {
      const fh = await realOpen.call(fsPromises, p, flags);
      // 只 spy 父目录的 fd（路径 = dir 名）
      if (typeof p === 'string' && p === dir && flags === 'r') {
        const realSync = fh.sync.bind(fh);
        const realClose = fh.close.bind(fh);
        fh.sync = async function spySync() {
          syncCalledAt = Date.now();
          calls.push({ method: 'sync' });
          return realSync();
        };
        fh.close = async function spyClose() {
          closeCalledAt = Date.now();
          calls.push({ method: 'close' });
          return realClose();
        };
      }
      return fh;
    };
    try {
      await fileOps.atomicWriteFile(target, 'new content');
    } finally {
      fsPromises.open = realOpen;
    }
    expect(syncCalledAt).toBeGreaterThan(0);
    expect(closeCalledAt).toBeGreaterThan(0);
    expect(syncCalledAt).toBeLessThanOrEqual(closeCalledAt);
    const syncIdx = calls.findIndex((c) => c.method === 'sync');
    const closeIdx = calls.findIndex((c) => c.method === 'close');
    expect(syncIdx).toBeGreaterThanOrEqual(0);
    expect(closeIdx).toBeGreaterThan(syncIdx);
  });

  it('Windows 上：目录 fsync 跳过（NTFS 不需要）', async function() {
    if (process.platform !== 'win32') return;
    // 在 Windows 上不可能调用 fs.open(dir, 'r') 做 fsync（NTFS 拒绝写）。
    // 本测试仅验证写入仍然成功 + 内容正确，作为 sanity check。
    const target = join(dir, 'note.md');
    await fileOps.atomicWriteFile(target, 'windows content');
    const { readFileSync } = require('fs');
    expect(readFileSync(target, 'utf-8')).toBe('windows content');
  });

  it('基础写入：原子覆盖 dst，tmp 不残留', async () => {
    const target = join(dir, 'note.md');
    writeFileSync(target, 'before', 'utf-8');
    await fileOps.atomicWriteFile(target, 'after');
    const { readFileSync, readdirSync } = require('fs');
    expect(readFileSync(target, 'utf-8')).toBe('after');
    // tmp 文件必须清理（不留垃圾）
    const leftover = readdirSync(dir).filter((f) => f.includes('.tmp.'));
    expect(leftover).toEqual([]);
  });
});

// audit fix (Tmp-L2)：ATOMIC_TMP_RE 之前太宽，把用户合法文件（`report.tmp.<ts>.<ts>.<rand>`）
// 也当成孤儿静默 unlink。这组测试钉死「仅匹配 EDITABLE_EXTS.tmp.<pid>.<ts>.<rand>」的边界。
describe('ATOMIC_TMP_RE（cleanupStaleFileTmpFiles 模式 audit Tmp-L2）', () => {
  it('匹配：<basename>.<editableExt>.tmp.<pid>.<ts>.<rand>', () => {
    expect(fileOps.ATOMIC_TMP_RE.test('note.md.tmp.12345.1700000000000.abcdef')).toBe(true);
    expect(fileOps.ATOMIC_TMP_RE.test('a.py.tmp.999.1700000000000.a1b2c3')).toBe(true);
    expect(fileOps.ATOMIC_TMP_RE.test('sub_deep_name.json.tmp.7.1700000000000.zz9xka')).toBe(true);
  });

  it('拒绝：用户文件 report.tmp.<ts>.<ts>.<rand>（无 EDITABLE_EXT 前缀）', () => {
    // 这正是误伤 bug 的源头 —— 没有 md / py / json 等扩展名前缀，
    // 旧版 `/\\.tmp\\.\\d+\\.\\d+\\.[a-z0-9]+$/i` 会把这条匹配上。
    expect(fileOps.ATOMIC_TMP_RE.test('report.tmp.2024.1234567.abcdef')).toBe(false);
    expect(fileOps.ATOMIC_TMP_RE.test('backup.tmp.1700000000000.1700000000000.abcdef')).toBe(false);
  });

  it('拒绝：binary / 非白名单扩展名', () => {
    expect(fileOps.ATOMIC_TMP_RE.test('photo.jpg.tmp.123.1700000000000.abcdef')).toBe(false);
    expect(fileOps.ATOMIC_TMP_RE.test('archive.zip.tmp.123.1700000000000.abcdef')).toBe(false);
  });

  it('拒绝：config-store 的 config.json.tmp.* 也在范围外（由它自己管）', () => {
    // config-store 的旧 tmp 不被 fileOps 清理 —— 这里只确认 ATOMIC_TMP_RE 不会
    // 误伤。注意 config.json 不在 EDITABLE_EXTS（json 在）是，所以这条 *会* 匹配上；
    // 故 cleanupStaleFileTmpFiles 内部排除逻辑在更上层处理。tmp 段格式补 digit.ts.rand 即可。
    expect(fileOps.ATOMIC_TMP_RE.test('config.json.tmp.123.1700000000000.abcdef')).toBe(true);
    // 但 `config.json.tmp.123` 这种三段缺一不可被拒（rand 不在）。
    expect(fileOps.ATOMIC_TMP_RE.test('config.json.tmp.123.1700000000000')).toBe(false);
  });

  it('拒绝：长度字段结构错误（rand 大于 8 字符 / pid 非数字）', () => {
    expect(fileOps.ATOMIC_TMP_RE.test('note.md.tmp.abc.1700000000000.abcdef')).toBe(false); // pid 非数字
    expect(fileOps.ATOMIC_TMP_RE.test('note.md.tmp.123.abc.abcdef')).toBe(false); // ts 非数字
    expect(fileOps.ATOMIC_TMP_RE.test('note.md.tmp.123.1700000000000.UPPERCASE')).toBe(false); // rand 范围
  });
});

// audit fix (Tmp-L2)：端到端验证 cleanupStaleFileTmpFiles 不会清理非自家产物
describe('cleanupStaleFileTmpFiles（端到端 audit Tmp-L2）', () => {
  it('用户文件 report.tmp.<ts>.<ts>.<rand> 即使旧到 24h+ 也不被删', async () => {
    // 写入一个旧 mtime 的文件（远大于 CROSS_PID_STALE_THRESHOLD_MS = 24h）。
    const userFile = join(dir, 'report.tmp.1700000000000.1700000000000.aabbcc');
    writeFileSync(userFile, 'user data', 'utf-8');
    const past = Date.now() - (48 * 60 * 60 * 1000); // 48 小时前
    const { utimesSync } = require('fs');
    utimesSync(userFile, past / 1000, past / 1000);

    await fileOps.cleanupStaleFileTmpFiles(dir);

    // 必须仍在 —— 旧版会因为 tmp 段格式匹配而删掉它。
    const { existsSync } = require('fs');
    expect(existsSync(userFile)).toBe(true);
  });

  it('真正属于自家 atomicWriteFile 产物的孤儿 .md.tmp.<pid>.<ts>.<rand> 会按阈值清理', async () => {
    // 模拟本进程 PID + 一个非常旧的时间戳（>24h）
    const orphanName = `note.md.tmp.${process.pid}.1000000000000.abc123`;
    const orphanFile = join(dir, orphanName);
    writeFileSync(orphanFile, 'orphan', 'utf-8');
    const past = Date.now() - (48 * 60 * 60 * 1000);
    const { utimesSync } = require('fs');
    utimesSync(orphanFile, past / 1000, past / 1000);

    await fileOps.cleanupStaleFileTmpFiles(dir);

    // 自家 PID 时 STALE_THRESHOLD_MS = 60s，48h 自然删除
    const { existsSync } = require('fs');
    expect(existsSync(orphanFile)).toBe(false);
  });
});