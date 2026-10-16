// main/file-ops.js atomicWriteFile —— tmp 路径生成（audit P2-1）
//
// 背景：原 inline 实现 `Math.random().toString(36).slice(2, 8)`
//   - Math.random() 不加密安全，并发同毫秒 + 同 pid + 同 dst 可能撞名
//   - audit 要求与 crypto.randomUUID() 对齐（已在本仓库其它路径使用）
//
// 修复：抽 generateTmpPath(dst, { crypto, pid, now }) 工厂：
//   - 注入 crypto / pid / now 便于单测验证随机性来源
//   - 默认走 node:crypto.randomUUID()（128-bit 加密安全，6 段 8-4-4-4-12 hex）
//   - 路径格式：${dst}.tmp.${pid}.${ts}.${randomId}（保持现有格式不破坏 fs-watcher 兼容）
//
// 测试策略：纯函数 + 注入 crypto / pid / now。覆盖：
//   - crypto.randomUUID 被调用（mock）
//   - 同 pid+now 两次调用 → randomId 不同（实际是不同 UUID）
//   - 不同 pid 反映在路径里
//   - 不同 now 反映在路径里
//   - 路径格式完整：dst + ".tmp." + pid + "." + ts + "." + randomId

import { describe, it, expect, vi } from 'vitest';
import { generateTmpPath } from '../../main/generate-tmp-path.js';

describe('generateTmpPath（audit P2-1）', () => {
  it('crypto.randomUUID 被调用，返回的 randomId 来自它', () => {
    const cryptoMock = { randomUUID: vi.fn(() => 'uuid-abc-123') };
    const r = generateTmpPath('/data/note.md', {
      crypto: cryptoMock,
      pid: 1000,
      now: () => 1234567890,
    });
    expect(cryptoMock.randomUUID).toHaveBeenCalledTimes(1);
    expect(r).toBe('/data/note.md.tmp.1000.1234567890.uuid-abc-123');
  });

  it('同 pid+now 但 crypto 每次返不同 UUID → 路径不同', () => {
    let counter = 0;
    const cryptoMock = { randomUUID: vi.fn(() => `uuid-${++counter}`) };
    const r1 = generateTmpPath('/data/note.md', { crypto: cryptoMock, pid: 1000, now: () => 1234 });
    const r2 = generateTmpPath('/data/note.md', { crypto: cryptoMock, pid: 1000, now: () => 1234 });
    expect(r1).not.toBe(r2);
    expect(r1).toContain('uuid-1');
    expect(r2).toContain('uuid-2');
  });

  it('不同 pid 反映在路径里', () => {
    const cryptoMock = { randomUUID: vi.fn(() => 'uuid-x') };
    const r1 = generateTmpPath('/data/a.md', { crypto: cryptoMock, pid: 100, now: () => 1234 });
    const r2 = generateTmpPath('/data/a.md', { crypto: cryptoMock, pid: 200, now: () => 1234 });
    expect(r1).toContain('.tmp.100.');
    expect(r2).toContain('.tmp.200.');
  });

  it('不同 now 反映在路径里', () => {
    const cryptoMock = { randomUUID: vi.fn(() => 'uuid-x') };
    const r1 = generateTmpPath('/data/a.md', { crypto: cryptoMock, pid: 1, now: () => 1000 });
    const r2 = generateTmpPath('/data/a.md', { crypto: cryptoMock, pid: 1, now: () => 2000 });
    expect(r1).toContain('.1.1000.uuid-x');
    expect(r2).toContain('.1.2000.uuid-x');
  });

  it('路径格式：${dst}.tmp.${pid}.${ts}.${randomId}，5 段以 . 分割', () => {
    const r = generateTmpPath('/data/note.md', {
      crypto: { randomUUID: () => 'xyz' },
      pid: 42,
      now: () => 999,
    });
    // 末尾应该是 ".tmp.42.999.xyz"
    expect(r.endsWith('.tmp.42.999.xyz')).toBe(true);
  });

  it('dst 含扩展名 / 含路径分隔符都正确保留', () => {
    const r = generateTmpPath('C:/data/sub/note.md', {
      crypto: { randomUUID: () => 'u' },
      pid: 1,
      now: () => 1,
    });
    expect(r).toBe('C:/data/sub/note.md.tmp.1.1.u');
  });

  it('默认（不传 crypto）走 node:crypto.randomUUID，real call 不抛', () => {
    // 不传 opts.crypto → 走 require('node:crypto').randomUUID
    const r = generateTmpPath('/data/note.md', { pid: 1, now: () => 1 });
    // real randomUUID 返 36 字符的 UUID（8-4-4-4-12）
    expect(r).toMatch(/\.tmp\.1\.1\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('默认 pid 走 process.pid，now 走 Date.now()', () => {
    const r = generateTmpPath('/data/note.md');
    // 路径第 3 段 = process.pid
    const match = r.match(/\.tmp\.(\d+)\.(\d+)\./);
    expect(match).toBeTruthy();
    expect(Number(match[1])).toBe(process.pid);
    // ts 应当接近 Date.now()（误差 < 5s）
    const ts = Number(match[2]);
    expect(Math.abs(ts - Date.now())).toBeLessThan(5000);
  });
});
