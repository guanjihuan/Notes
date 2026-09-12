// src/splitter.js —— 通用拖拽分割条工厂测试
//
// 覆盖 getDragSign 的方向反转逻辑：
//   - 不传 getDragSign（默认）→ 鼠标右移让目标变大（+1）
//   - 传 getDragSign 返回 -1 → 鼠标右移让目标变小（用于 AI 面板在 splitter
//     右侧且贴窗口右边缘的场景，避免 splitter 视觉反向跟随鼠标）
//   - getDragSign 抛错或返回非 -1/1 → 兜底 +1，不让一次坏拖动摧毁整个交互
//
// 通过 jsdom 模拟 document/element，绕过 mountAiSplitter 的 DOM 依赖，直接
// 驱动 createSplitter 的 mousedown/mousemove 路径验证 setSize 调用序列。
//
// 不覆盖：
//   - 命中区（hitZone）扩展 → 那是 mountSidebarSplitter/mountAiSplitter 的
//     调用方职责，工厂只关心"接到 hit zone 触发后行为正确"。
//   - touch 路径 → 与 mouse 路径走同一道 startDrag/applyDrag，代码层同源。

// @vitest-environment jsdom

import { describe, it, expect, vi } from 'vitest';
import { createSplitter } from '../../src/splitter.js';

/**
 * 在 jsdom 里构造一个最小可用的 splitter：
 *   - handle 是按钮元素
 *   - getSize/setSize/clampSize/onDragEnd 由用例注入
 *   - 不传 hitZone / initialSize / windowListeners（与 mountAiSplitter 主路径
 *     解耦，单独验证方向反转这条新分支）
 *
 * 返回 {handle, fireMouseDown, fireMouseMove, fireMouseUp, setSizeCalls}：
 *   - fireMouseDown(clientX) / fireMouseMove / fireMouseUp 模拟真实事件
 *   - setSizeCalls 记录所有 setSize 调用，可断言方向与幅度
 */
function makeSplitter({ getSize, setSize, clampSize, getDragSign }) {
  const handle = document.createElement('div');
  handle.style.width = '4px';
  document.body.appendChild(handle);

  const onDragEnd = vi.fn();
  const inst = createSplitter({
    handle,
    axis: 'x',
    getSize,
    setSize,
    clampSize,
    onDragEnd,
    getDragSign,
  });

  const setSizeCalls = [];
  const wrappedSetSize = (px) => {
    setSizeCalls.push(px);
    setSize(px);
  };
  // 重新绑一个 setSize 用于观察
  inst.dispose();
  const inst2 = createSplitter({
    handle,
    axis: 'x',
    getSize,
    setSize: wrappedSetSize,
    clampSize,
    onDragEnd,
    getDragSign,
  });

  const fireMouseDown = (clientX) => {
    handle.dispatchEvent(new MouseEvent('mousedown', { clientX, bubbles: true }));
  };
  const fireMouseMove = (clientX) => {
    document.dispatchEvent(new MouseEvent('mousemove', { clientX, bubbles: true }));
  };
  const fireMouseUp = (clientX = 0) => {
    document.dispatchEvent(new MouseEvent('mouseup', { clientX, bubbles: true }));
  };

  return {
    handle,
    inst: inst2,
    onDragEnd,
    fireMouseDown,
    fireMouseMove,
    fireMouseUp,
    setSizeCalls,
  };
}

describe('createSplitter —— 方向反转 (getDragSign)', () => {
  it('不传 getDragSign：鼠标右移 → 目标变大（默认 +1）', () => {
    let current = 300;
    const { fireMouseDown, fireMouseMove, fireMouseUp, setSizeCalls, onDragEnd } =
      makeSplitter({
        getSize: () => current,
        setSize: (px) => { current = px; },
        clampSize: (px) => Math.max(200, Math.min(800, px)),
      });

    fireMouseDown(500);
    fireMouseMove(560); // +60
    fireMouseUp();

    expect(setSizeCalls).toEqual([360]); // 300 + 60
    expect(onDragEnd).toHaveBeenCalledWith(360);
  });

  it('getDragSign 返回 -1：鼠标右移 → 目标变小（AI 面板在 splitter 右侧场景）', () => {
    let current = 360;
    const signProvider = vi.fn(() => -1);
    const { fireMouseDown, fireMouseMove, fireMouseUp, setSizeCalls, onDragEnd } =
      makeSplitter({
        getSize: () => current,
        setSize: (px) => { current = px; },
        clampSize: (px) => Math.max(220, Math.min(720, px)),
        getDragSign: signProvider,
      });

    fireMouseDown(500);
    fireMouseMove(560); // +60 但应反向 → 减 60
    fireMouseUp();

    expect(setSizeCalls).toEqual([300]); // 360 - 60
    expect(signProvider).toHaveBeenCalledTimes(1); // 仅 startDrag 时调用一次
    expect(onDragEnd).toHaveBeenCalledWith(300);
  });

  it('getDragSign 返回 +1：与默认行为一致（防御性测试）', () => {
    let current = 360;
    const { fireMouseDown, fireMouseMove, fireMouseUp, setSizeCalls } =
      makeSplitter({
        getSize: () => current,
        setSize: (px) => { current = px; },
        clampSize: (px) => Math.max(220, Math.min(720, px)),
        getDragSign: () => 1,
      });

    fireMouseDown(500);
    fireMouseMove(560);
    fireMouseUp();

    expect(setSizeCalls).toEqual([420]); // 360 + 60
  });

  it('getDragSign 在每次 startDrag 时重新求值（应对切模式）', () => {
    let current = 360;
    // 模拟「第一次拖动（split 模式）= +1，第二次拖动（preview 模式）= -1」
    const signProvider = vi.fn()
      .mockReturnValueOnce(1)
      .mockReturnValueOnce(-1);

    const { fireMouseDown, fireMouseMove, fireMouseUp, setSizeCalls } =
      makeSplitter({
        getSize: () => current,
        setSize: (px) => { current = px; },
        clampSize: (px) => Math.max(220, Math.min(720, px)),
        getDragSign: signProvider,
      });

    // 第一次拖动（+1）：鼠标右移 50 → current 应 +50
    fireMouseDown(500);
    fireMouseMove(550);
    fireMouseUp();
    expect(current).toBe(410);

    // 第二次拖动（-1）：鼠标右移 50 → current 应 -50
    fireMouseDown(500);
    fireMouseMove(550);
    fireMouseUp();
    expect(current).toBe(360);

    expect(signProvider).toHaveBeenCalledTimes(2);
    expect(setSizeCalls).toEqual([410, 360]);
  });

  it('getDragSign 抛错 → 兜底 +1，不让坏回调炸掉拖动', () => {
    let current = 360;
    const { fireMouseDown, fireMouseMove, fireMouseUp, setSizeCalls } =
      makeSplitter({
        getSize: () => current,
        setSize: (px) => { current = px; },
        clampSize: (px) => Math.max(220, Math.min(720, px)),
        // 抛错 → 工厂内部 try/catch 兜底为 +1，拖动继续按默认方向进行
        getDragSign: () => { throw new Error('layout not ready'); },
      });

    fireMouseDown(500); // 内部吞掉 getDragSign 抛错，dragSign = 1
    fireMouseMove(560); // startSize(360) + dragSign(1) * +60 = 420
    fireMouseUp();

    expect(setSizeCalls).toEqual([420]);
  });

  it('getDragSign 返回非 -1/1 的奇怪值 → 归一为 +1', () => {
    let current = 360;
    const { fireMouseDown, fireMouseMove, fireMouseUp, setSizeCalls } =
      makeSplitter({
        getSize: () => current,
        setSize: (px) => { current = px; },
        clampSize: (px) => Math.max(220, Math.min(720, px)),
        getDragSign: () => 0, // 0 不是合法符号 → 应被识别为 +1
      });

    fireMouseDown(500);
    fireMouseMove(560);
    fireMouseUp();

    expect(setSizeCalls).toEqual([420]); // 360 + 60（按 +1 算）
  });

  it('reverse 方向下 clamp 仍生效（防止拖出 MIN_WIDTH）', () => {
    let current = 230;
    const { fireMouseDown, fireMouseMove, fireMouseUp, setSizeCalls } =
      makeSplitter({
        getSize: () => current,
        setSize: (px) => { current = px; },
        clampSize: (px) => Math.max(220, Math.min(720, px)),
        getDragSign: () => -1,
      });

    fireMouseDown(500);
    // 鼠标右移 100 → 当前期望 current - 100 = 130，但 clamp 应钉到 MIN=220
    fireMouseMove(600);
    fireMouseUp();

    expect(setSizeCalls).toEqual([220]);
  });
});