// src/rescue.js 测试
//
// 覆盖：
//   - buildRescueName 的命名规则（去 .md 后缀、毫秒精度、随机后缀、默认值 fallback）
//   - rescueDirtyContent 的三种结局：成功 / IPC result.error / IPC 异常
//   - friendlyFsError 错误码 vs message 的语义（audit Round 16 bug）

/* @vitest-environment jsdom */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildRescueName, rescueDirtyContent } from '../../src/rescue.js';
import * as feedback from '../../src/feedback.js';

describe('buildRescueName —— 命名规则', () => {
  it('原名带 .md → 去掉后缀再加 -rescued-...', () => {
    const name = buildRescueName('test.md');
    expect(name).toMatch(/^test-rescued-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}-[a-z0-9]{4}\.md$/);
  });

  it('原名大小写混合的 .MD 也去后缀（不区分大小写）', () => {
    const name = buildRescueName('NOTES.MD');
    expect(name.startsWith('NOTES-rescued-')).toBe(true);
  });

  it('原名不带 .md → 直接拼 -rescued-...', () => {
    const name = buildRescueName('plain-text');
    expect(name.startsWith('plain-text-rescued-')).toBe(true);
    expect(name.endsWith('.md')).toBe(true);
  });

  it('原名为空 / null / undefined → 用 untitled.md 作 base', () => {
    expect(buildRescueName('').startsWith('untitled-rescued-')).toBe(true);
    expect(buildRescueName(null).startsWith('untitled-rescued-')).toBe(true);
    expect(buildRescueName(undefined).startsWith('untitled-rescued-')).toBe(true);
  });

  it('时间戳含毫秒（避免同秒内重名，详见 audit renderer-M9）', () => {
    const name = buildRescueName('foo.md');
    // 形如 2026-09-21T10-30-45-123（slice(0,23) 保留 .mmm）
    expect(name).toMatch(/-\d{3}-[a-z0-9]{4}\.md$/);
  });

  it('随机后缀每次都不同（碰撞概率 ~1/1.6M）', () => {
    const a = buildRescueName('x.md');
    const b = buildRescueName('x.md');
    expect(a).not.toBe(b);
  });
});

describe('rescueDirtyContent —— 三种结局', () => {
  let showToastSpy;
  beforeEach(() => {
    showToastSpy = vi.spyOn(feedback, 'showToast').mockImplementation(() => {});
  });
  afterEach(() => {
    showToastSpy.mockRestore();
    delete window.api;
  });

  it('createFile ok=true → 弹 warning 成功 toast（含 rescue 名）', async () => {
    const api = { createFile: vi.fn().mockResolvedValue({ ok: true }) };
    const name = rescueDirtyContent({
      api,
      originalName: 'note.md',
      content: 'unsaved body',
      event: '文件已不在',
    });
    expect(name).toMatch(/^note-rescued-.+\.md$/);
    // await 让 promise 链执行
    await Promise.resolve();
    await Promise.resolve();
    expect(showToastSpy).toHaveBeenCalledTimes(1);
    expect(showToastSpy.mock.calls[0][0]).toMatch(/^文件已不在，未保存内容已救回到「note-rescued-.+\.md」$/);
    expect(showToastSpy.mock.calls[0][1]).toBe('warning');
    expect(showToastSpy.mock.calls[0][2]).toBe(4500);
  });

  it('createFile ok=false → 弹 error toast，friendlyFsError 传 message 而非 error 码', async () => {
    // audit fix (Round 16)：旧版直接传 r?.error（业务码字符串如 'INVALID_NAME'），
    // 用户在 toast 里看到原始业务码而非中文提示。
    //
    // 第二阶段代码审查 (Phase 2 review #2)：friendlyFsError 现在走注入的 api
    // 参数，不再 fallback 到 window.api。测试也对应调整 —— 把 friendlyFsError
    // 挂在 api param 上，模拟生产里 ctx.api（contextBridge 暴露的对象）。
    const api = {
      createFile: vi.fn().mockResolvedValue({
        ok: false,
        code: 'EACCES',
        error: 'INVALID_NAME', // 业务码，不该给用户看
        message: '文件名包含 Windows 保留字符', // 中文明文，应该展示
      }),
      friendlyFsError: (code, fallback) => fallback || code || '未知错误',
    };
    rescueDirtyContent({
      api,
      originalName: 'bad.md',
      content: 'x',
      event: '原文件已被删除',
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(showToastSpy).toHaveBeenCalledTimes(1);
    expect(showToastSpy.mock.calls[0][0]).toContain('原文件已被删除；未保存内容丢失（救回失败：文件名包含 Windows 保留字符）');
    // 关键断言：业务码「INVALID_NAME」**不能**出现在 toast 里
    expect(showToastSpy.mock.calls[0][0]).not.toContain('INVALID_NAME');
  });

  it('createFile 抛 IPC 异常 → 弹 error toast，不抛 unhandled rejection', async () => {
    const api = {
      createFile: vi.fn().mockRejectedValue(new Error('IPC channel disconnected')),
    };
    rescueDirtyContent({
      api,
      originalName: 'foo.md',
      content: 'x',
      event: '文件已不在',
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(showToastSpy).toHaveBeenCalledTimes(1);
    expect(showToastSpy.mock.calls[0][0]).toContain('文件已不在；未保存内容丢失');
  });

  it('createFile 返回 ok=false 且无 message（极端） → fallback 到 error 码', async () => {
    const api = {
      createFile: vi.fn().mockResolvedValue({ ok: false, code: 'EACCES', error: 'UNKNOWN' }),
      friendlyFsError: (code, fallback) => fallback || code || '未知错误',
    };
    rescueDirtyContent({
      api,
      originalName: 'foo.md',
      content: 'x',
      event: '文件已不在',
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(showToastSpy.mock.calls[0][0]).toContain('救回失败：UNKNOWN');
  });

  it('api.friendlyFsError 不可用（极端） → 直接走 r?.message || r?.error 字符串', async () => {
    // 早期启动 / preload 不可用时，注入的 api 上没有 friendlyFsError，
    // fallback 仍给出可读提示（与第二阶段审查 review #2 一致：不再回退到
    // window.api，契约是「谁注入谁负责」）。
    const api = {
      createFile: vi.fn().mockResolvedValue({ ok: false, message: '磁盘已满' }),
    };
    rescueDirtyContent({
      api,
      originalName: 'foo.md',
      content: 'x',
      event: '文件已不在',
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(showToastSpy.mock.calls[0][0]).toContain('救回失败：磁盘已满');
  });

  it('createFile 接受新签名 payload { initialContent }（第二阶段 review #1 回归）', async () => {
    // 之前 rescue.js 用 string overload `api.createFile(name, content)`，依赖 preload
    // 的向后兼容分支。如果 preload 移除 string overload，所有 rescue 调用会静默
    // 失败（fire-and-forget 调用方收不到错误，只看到「未保存内容丢失」toast）。
    // 现在 rescue.js 显式用 `{ initialContent }` 对象形式 —— 断言 createFile 收到的
    // 第二参是对象、content 落在 initialContent 字段，与 main/file-ops.js
    // resolveFileName 的新签名对齐。
    const api = {
      createFile: vi.fn().mockResolvedValue({ ok: true }),
    };
    rescueDirtyContent({
      api,
      originalName: 'note.md',
      content: 'unsaved body',
      event: '文件已不在',
    });
    await Promise.resolve();
    expect(api.createFile).toHaveBeenCalledTimes(1);
    const [name, payload] = api.createFile.mock.calls[0];
    expect(name).toMatch(/^note-rescued-.+\.md$/);
    expect(payload).toEqual({ initialContent: 'unsaved body' });
    // 关键：不再是 string 第二参
    expect(typeof payload).toBe('object');
    expect(typeof payload).not.toBe('string');
  });
});