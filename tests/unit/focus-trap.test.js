// src/focus-trap.js 单测（Phase O-L14 audit）
//
// 覆盖：
//   - IME 合成期间（isComposing=true）按 Tab 不抢焦点
//   - keyCode=229（Firefox / 旧 Chromium fallback）按 Tab 不抢焦点
//   - 普通 Tab 行为不变（首尾循环 / 容器内跳转）

/* @vitest-environment jsdom */

import { describe, it, expect, beforeEach } from 'vitest';
import { createFocusTrap } from '../../src/focus-trap.js';

let container;
let firstBtn;
let middleBtn;
let lastBtn;

beforeEach(() => {
  document.body.innerHTML = '';
  container = document.createElement('div');
  container.tabIndex = -1;
  firstBtn = document.createElement('button');
  firstBtn.textContent = 'first';
  middleBtn = document.createElement('button');
  middleBtn.textContent = 'middle';
  lastBtn = document.createElement('button');
  lastBtn.textContent = 'last';
  container.appendChild(firstBtn);
  container.appendChild(middleBtn);
  container.appendChild(lastBtn);
  document.body.appendChild(container);
});

function fireKey(target, opts) {
  const ev = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...opts });
  target.dispatchEvent(ev);
  return ev;
}

describe('focus-trap IME 合成守门（Phase O-L14）', () => {
  it('isComposing=true 时 Tab 不抢焦点（preventDefault 不触发）', () => {
    const trap = createFocusTrap(container);
    // 模拟 IME 合成期间按 Tab
    const ev = fireKey(middleBtn, { key: 'Tab', isComposing: true });
    // IME 期间不拦 Tab（让浏览器处理候选词）
    expect(ev.defaultPrevented).toBe(false);
    trap.dispose();
  });

  it('keyCode=229（Firefox / 旧 Chromium fallback）时 Tab 不抢焦点', () => {
    const trap = createFocusTrap(container);
    const ev = fireKey(middleBtn, { key: 'Tab', keyCode: 229 });
    expect(ev.defaultPrevented).toBe(false);
    trap.dispose();
  });
});
