// P2-10 / P2-12（audit）：主进程日志改写异步缓冲。
//
// 旧实现：console.log/warn/error 重写层每行 appendFileSync + mkdirSync ——
// 同步 IO 阻塞 main 事件循环（AI 流式高频日志时尤甚），且顶层同步 fs。
//
// 新模块 main/main-log-writer.js：createMainLogWriter({ logDir, logFile,
// fsImpl, flushMs, maxBuffered, setTimeoutImpl, clearTimeoutImpl }) →
//   write(line)   入缓冲；超 maxBuffered 丢最老；调度 flush
//   flush()       mkdir(recursive) + appendFile 一把写出；失败静默丢弃
//   dispose()     取消待发 flush（测试 / 退出用）
//
// fsImpl 默认 fs.promises；时钟 / 定时器可注入，单测同步推进。

import { describe, it, expect, vi } from 'vitest';
const { createMainLogWriter } = require('../../main/main-log-writer.js');

function fakeFs() {
  const calls = { mkdir: [], append: [] };
  return {
    calls,
    mkdir: async (dir, opts) => { calls.mkdir.push([dir, opts]); },
    appendFile: async (file, data) => { calls.append.push([file, data]); },
  };
}

function fakeTimers() {
  const pending = [];
  return {
    pending,
    setTimeout: (fn, ms) => { const h = { fn, ms, unref() {} }; pending.push(h); return h; },
    clearTimeout: (h) => { const i = pending.indexOf(h); if (i >= 0) pending.splice(i, 1); },
    fireAll: () => { const fns = pending.splice(0); for (const h of fns) h.fn(); },
  };
}

describe('createMainLogWriter —— P2-10 异步缓冲日志', () => {
  it('write 只入缓冲，flush 后一把 appendFile', async () => {
    const fs = fakeFs();
    const w = createMainLogWriter({ logDir: '/d', logFile: '/d/a.log', fsImpl: fs });
    w.write('l1\n');
    w.write('l2\n');
    expect(fs.calls.append).toEqual([]);
    await w.flush();
    expect(fs.calls.mkdir).toEqual([['/d', { recursive: true }]]);
    expect(fs.calls.append).toEqual([['/d/a.log', 'l1\nl2\n']]);
  });

  it('flush 期间缓冲清空；空缓冲 flush 是 no-op', async () => {
    const fs = fakeFs();
    const w = createMainLogWriter({ logDir: '/d', logFile: '/d/a.log', fsImpl: fs });
    await w.flush();
    expect(fs.calls.append).toEqual([]);
    w.write('x\n');
    await w.flush();
    await w.flush();
    expect(fs.calls.append).toEqual([['/d/a.log', 'x\n']]);
  });

  it('mkdir 只第一次做（缓存 promise）', async () => {
    const fs = fakeFs();
    const w = createMainLogWriter({ logDir: '/d', logFile: '/d/a.log', fsImpl: fs });
    w.write('a\n');
    await w.flush();
    w.write('b\n');
    await w.flush();
    expect(fs.calls.mkdir.length).toBe(1);
    expect(fs.calls.append.length).toBe(2);
  });

  it('写失败静默丢弃，不抛错，缓冲不残留', async () => {
    const fs = {
      mkdir: async () => {},
      appendFile: async () => { throw new Error('disk full'); },
    };
    const w = createMainLogWriter({ logDir: '/d', logFile: '/d/a.log', fsImpl: fs });
    w.write('boom\n');
    await expect(w.flush()).resolves.toBeUndefined();
    // 缓冲已清，不会无限重试
    await w.flush();
  });

  it('缓冲超 maxBuffered 丢最老行', async () => {
    const fs = fakeFs();
    const w = createMainLogWriter({
      logDir: '/d', logFile: '/d/a.log', fsImpl: fs, maxBuffered: 3,
    });
    w.write('1\n'); w.write('2\n'); w.write('3\n'); w.write('4\n');
    await w.flush();
    expect(fs.calls.append).toEqual([['/d/a.log', '2\n3\n4\n']]);
  });

  it('write 调度一次 flush 定时器（不重复排）', async () => {
    const fs = fakeFs();
    const timers = fakeTimers();
    const w = createMainLogWriter({
      logDir: '/d', logFile: '/d/a.log', fsImpl: fs,
      setTimeoutImpl: timers.setTimeout, clearTimeoutImpl: timers.clearTimeout,
      flushMs: 250,
    });
    w.write('a\n');
    w.write('b\n');
    expect(timers.pending.length).toBe(1);
    expect(timers.pending[0].ms).toBe(250);
    timers.fireAll();
    await w.flush(); // 等 in-flight 落地
    expect(fs.calls.append.length).toBe(1);
    expect(fs.calls.append[0][1]).toBe('a\nb\n');
  });

  it('dispose 取消待发 flush', () => {
    const timers = fakeTimers();
    const w = createMainLogWriter({
      logDir: '/d', logFile: '/d/a.log', fsImpl: fakeFs(),
      setTimeoutImpl: timers.setTimeout, clearTimeoutImpl: timers.clearTimeout,
    });
    w.write('a\n');
    expect(timers.pending.length).toBe(1);
    w.dispose();
    expect(timers.pending.length).toBe(0);
  });

  it('默认 fsImpl / 定时器下 write 不抛错', () => {
    const w = createMainLogWriter({ logDir: '/nonexistent-dir-x', logFile: '/nonexistent-dir-x/a.log' });
    expect(() => w.write('hello\n')).not.toThrow();
    w.dispose();
  });
});
