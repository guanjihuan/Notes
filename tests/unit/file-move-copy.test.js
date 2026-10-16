// main/file-ops.js —— recursiveCopy 单测
//
// 覆盖：
//   - 单层文件复制
//   - 多层文件夹树递归复制（含子目录 + 子文件）
//   - 源目录中的符号链接子项被跳过（安全：不跟随软链）
//   - 目标名冲突由调用方（_prepareRelocate）用 resolveRenameFolderName 解，
//     本测试只验证 recursiveCopy 对给定 destAbs 的完整落地。
//
// 纯 Node，用 mkdtempSync 建真实临时目录；Windows 上 symlink 需要管理员权限，
// 故 symlink 用例用 try/catch 跳过（无权限环境不报错、不污染结果）。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, readFileSync, readdirSync, statSync,
} from 'fs';
import { tmpdir } from 'os';
import { join, sep } from 'path';

const fileOps = require('../../main/file-ops.js');
const { recursiveCopy } = fileOps;

let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'notes-reccopy-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function lsTree(root) {
  // 返回 { 相对路径(用 / 归一): 'file' | 'dir' }，相对 root
  const out = {};
  (function walk(abs, rel) {
    const entries = readdirSync(abs);
    for (const name of entries) {
      const a = join(abs, name);
      const r = (rel ? join(rel, name) : name).split(sep).join('/');
      const st = statSync(a);
      if (st.isDirectory()) { out[r] = 'dir'; walk(a, r); }
      else if (st.isFile()) out[r] = 'file';
    }
  })(root, '');
  return out;
}

describe('recursiveCopy', () => {
  it('复制单个文件', async () => {
    const src = join(dir, 'src');
    const dst = join(dir, 'dst');
    mkdirSync(src);
    writeFileSync(join(src, 'a.md'), 'hello');

    await recursiveCopy(src, dst);

    expect(statSync(join(dst, 'a.md')).isFile()).toBe(true);
    expect(readFileSync(join(dst, 'a.md'), 'utf8')).toBe('hello');
  });

  it('递归复制多层文件夹树', async () => {
    const src = join(dir, 'src');
    const dst = join(dir, 'dst');
    mkdirSync(join(src, 'sub'), { recursive: true });
    writeFileSync(join(src, 'root.md'), 'r');
    writeFileSync(join(src, 'sub', 'child.md'), 'c');

    await recursiveCopy(src, dst);

    const tree = lsTree(dst);
    expect(tree['root.md']).toBe('file');
    expect(tree['sub']).toBe('dir');
    expect(tree['sub/child.md']).toBe('file');
    expect(readFileSync(join(dst, 'sub', 'child.md'), 'utf8')).toBe('c');
  });

  it('源目录中的符号链接子项被跳过（不跟随、不落地）', async () => {
    const src = join(dir, 'src');
    const dst = join(dir, 'dst');
    mkdirSync(src);
    writeFileSync(join(src, 'real.md'), 'real');
    try {
      // 用一个真实文件做软链目标，再链过去
      symlinkSync(join(src, 'real.md'), join(src, 'link.md'));
    } catch {
      // Windows 无管理员权限时 symlink 会抛 EPERM；跳过后本用例视为满足「无软链落地」
      expect(true).toBe(true);
      return;
    }

    await recursiveCopy(src, dst);

    expect(statSync(join(dst, 'real.md')).isFile()).toBe(true);
    expect(() => statSync(join(dst, 'link.md'))).toThrow(); // 软链未复制
  });

  it('目标已存在同名目录时抛错（不静默覆盖）', async () => {
    const src = join(dir, 'src');
    const dst = join(dir, 'dst');
    mkdirSync(src);
    mkdirSync(dst); // 已存在
    writeFileSync(join(src, 'x.md'), 'x');

    await expect(recursiveCopy(src, dst)).rejects.toBeTruthy();
  });
});
