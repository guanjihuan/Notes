// main/ipc-sender.js —— assertMainSender / assertTopFrame / assertAiRequestId 单测
//
// 覆盖：
//   - assertMainSender 四种拒绝路径：event 缺 sender / mainWindow 未创建 /
//     mainWindow 已销毁 / sender 不是主窗口 webContents
//   - assertMainSender 放行路径：sender 匹配 + mainWindow 存活
//   - assertTopFrame：senderFrame 缺失拒绝 / parent 真值拒绝 / parent null 放行
//   - assertAiRequestId：两种合法格式（ai-<ts>-<uuid> / 裸 uuid）+ 各种垃圾拒绝

// @vitest-environment node

import { describe, it, expect, vi } from 'vitest';

const {
  assertMainSender,
  assertTopFrame,
  assertAiRequestId,
  SENDER_NOT_ALLOWED,
  INVALID_REQUEST_ID,
} = await import('../../main/ipc-sender.js');

// ---- helpers ----

function makeWin(webContents) {
  return {
    webContents,
    isDestroyed: () => false,
  };
}

function makeEvent(sender) {
  return { sender };
}

describe('assertMainSender', () => {
  const sender = { id: 42 };

  it('event 缺 sender → 拒绝（SENDER_NOT_ALLOWED）', () => {
    const getMainWindow = () => makeWin(sender);
    const r = assertMainSender({}, getMainWindow);
    expect(r).toEqual({ ok: false, error: SENDER_NOT_ALLOWED });
  });

  it('event 完全 undefined → 拒绝', () => {
    const r = assertMainSender(undefined, () => makeWin(sender));
    expect(r).toEqual({ ok: false, error: SENDER_NOT_ALLOWED });
  });

  it('mainWindow 未创建（getMainWindow 返回 null） → 拒绝', () => {
    const r = assertMainSender(makeEvent(sender), () => null);
    expect(r).toEqual({ ok: false, error: SENDER_NOT_ALLOWED });
  });

  it('mainWindow 已销毁 → 拒绝', () => {
    const win = { isDestroyed: () => true };
    const r = assertMainSender(makeEvent(sender), () => win);
    expect(r).toEqual({ ok: false, error: SENDER_NOT_ALLOWED });
  });

  it('sender 不等于 mainWindow.webContents → 拒绝（防 webview / 子窗口）', () => {
    const otherSender = { id: 99 };
    const getMainWindow = () => makeWin(sender);
    const r = assertMainSender(makeEvent(otherSender), getMainWindow);
    expect(r).toEqual({ ok: false, error: SENDER_NOT_ALLOWED });
  });

  it('sender 等于 mainWindow.webContents + mainWindow 存活 → 放行', () => {
    const getMainWindow = () => makeWin(sender);
    const r = assertMainSender(makeEvent(sender), getMainWindow);
    expect(r).toEqual({ ok: true });
  });

  it('getMainWindow 不是函数 → 拒绝（防御性）', () => {
    const r = assertMainSender(makeEvent(sender), null);
    expect(r).toEqual({ ok: false, error: SENDER_NOT_ALLOWED });
  });

  it('主窗口在调用过程中被销毁（getMainWindow 返回已销毁 win） → 拒绝', () => {
    // 模拟：handler 入口时主窗口还活着，但 getter 被调时已销毁（destroy 事件刚好触发）
    const sender = { id: 42 };
    const getMainWindow = vi.fn(() => ({ isDestroyed: () => true }));
    const r = assertMainSender(makeEvent(sender), getMainWindow);
    expect(r).toEqual({ ok: false, error: SENDER_NOT_ALLOWED });
  });
});

describe('assertTopFrame', () => {
  it('event.senderFrame 缺失 → 拒绝（保守）', () => {
    const r = assertTopFrame({});
    expect(r).toEqual({ ok: false, error: SENDER_NOT_ALLOWED });
  });

  it('event 完全 undefined → 拒绝', () => {
    expect(assertTopFrame(undefined)).toEqual({ ok: false, error: SENDER_NOT_ALLOWED });
  });

  it('senderFrame.parent 真值（iframe / webview） → 拒绝', () => {
    const r = assertTopFrame({ senderFrame: { parent: { id: 99 } } });
    expect(r).toEqual({ ok: false, error: SENDER_NOT_ALLOWED });
  });

  it('senderFrame.parent null（顶层 frame） → 放行', () => {
    const r = assertTopFrame({ senderFrame: { parent: null } });
    expect(r).toEqual({ ok: true });
  });
});

describe('assertAiRequestId', () => {
  // 标准 UUIDv4 形式
  const UUID_V4 = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
  // main/ai.js:968 的格式：ai-<timestamp>-<uuid>
  const AI_TS_UUID = `ai-1700000000000-${UUID_V4}`;

  it('renderer 侧格式：裸 UUIDv4 → 放行', () => {
    const r = assertAiRequestId(UUID_V4);
    expect(r).toEqual({ ok: true, requestId: UUID_V4 });
  });

  it('main 侧 fallback 格式：ai-<ts>-<uuid> → 放行', () => {
    const r = assertAiRequestId(AI_TS_UUID);
    expect(r).toEqual({ ok: true, requestId: AI_TS_UUID });
  });

  it('大写 UUIDv4 也放行（正则 case-insensitive）', () => {
    const r = assertAiRequestId(UUID_V4.toUpperCase());
    expect(r.ok).toBe(true);
  });

  it('非 string（number / object / null） → 拒绝', () => {
    expect(assertAiRequestId(123).error).toBe(INVALID_REQUEST_ID);
    expect(assertAiRequestId({}).error).toBe(INVALID_REQUEST_ID);
    expect(assertAiRequestId(null).error).toBe(INVALID_REQUEST_ID);
    expect(assertAiRequestId(undefined).error).toBe(INVALID_REQUEST_ID);
  });

  it('空串 → 拒绝', () => {
    expect(assertAiRequestId('').error).toBe(INVALID_REQUEST_ID);
  });

  it('过长（>200 字符） → 拒绝（防内存放大）', () => {
    expect(assertAiRequestId('a'.repeat(201)).error).toBe(INVALID_REQUEST_ID);
  });

  it('UUIDv4 但缺一位 → 拒绝（hex 字符数错）', () => {
    const short = 'f47ac10b-58cc-4372-a567-0e02b2c3d47';
    expect(assertAiRequestId(short).error).toBe(INVALID_REQUEST_ID);
  });

  it('UUIDv4 但第 3 段首位不是 4 → 拒绝', () => {
    const v3 = 'f47ac10b-58cc-4372-3567-0e02b2c3d479';
    expect(assertAiRequestId(v3).error).toBe(INVALID_REQUEST_ID);
  });

  it('UUIDv4 但第 4 段首位不是 [89ab] → 拒绝', () => {
    const badVariant = 'f47ac10b-58cc-4372-4567-0e02b2c3d479';
    expect(assertAiRequestId(badVariant).error).toBe(INVALID_REQUEST_ID);
  });

  it('ai- 前缀但 timestamp 不是纯数字 → 拒绝', () => {
    const bad = `ai-notanumber-${UUID_V4}`;
    expect(assertAiRequestId(bad).error).toBe(INVALID_REQUEST_ID);
  });

  it('ai- 前缀但 timestamp 过长（>18 位）→ 拒绝（防 DoS）', () => {
    const bad = `ai-${'1'.repeat(19)}-${UUID_V4}`;
    expect(assertAiRequestId(bad).error).toBe(INVALID_REQUEST_ID);
  });

  it('包含 SQL 注入 / shell 元字符 → 拒绝', () => {
    expect(assertAiRequestId(`' OR 1=1; --`).error).toBe(INVALID_REQUEST_ID);
    expect(assertAiRequestId(`$(rm -rf /)`).error).toBe(INVALID_REQUEST_ID);
  });
});
