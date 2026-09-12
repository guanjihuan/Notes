// src/save-button-ui.js 测试
//
// 覆盖保存按钮 UI 同步函数的三态：
//   - 干净（isDirty=false, savingCount=0）
//   - 有待保存改动（isDirty=true, savingCount=0）
//   - 保存中（isDirty=*, savingCount>0）
//   - 同时保存中 + 脏
//
// 设计要点（见 src/save-button-ui.js 注释）：
//   - 始终显示按钮（[[feedback-save-button-always-visible]]），不切 hidden
//   - aria-busy 与 is-saving class 同步
//   - btnSave=null 时静默 return（不抛）
//   - setDirty 回调只在 isDirty 翻转时才有意义，但函数本身每次都调一次
//     （去重由调用方在调用频率上控制；这里只验证契约）
//
// 限制：save() / scheduleAutoSave() 内部使用 savingCount，但二者都在 src/app.js
// 闭包里耦合（state / els / window.api），无法直接 import 单测。本文件只覆盖
// 已抽出的 syncSaveButtonUI 纯函数；save() 的 in-flight sentinel / 防抖语义等
// 留待未来把 save() 拆出 helper 后再补。

/* @vitest-environment jsdom */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { syncSaveButton } from '../../src/save-button-ui.js';

function makeBtn() {
  // 模拟工具栏保存按钮的最小子集：classList + setAttribute + title getter/setter
  const btn = document.createElement('button');
  btn.id = 'btn-save';
  return btn;
}

function makeStatusUnsaved() {
  const el = document.createElement('span');
  el.id = 'status-unsaved';
  el.hidden = true;
  el.textContent = '';
  return el;
}

describe('syncSaveButton 三态同步', () => {
  let btn;
  let setDirty;

  beforeEach(() => {
    btn = makeBtn();
    setDirty = vi.fn();
  });

  it('干净态（isDirty=false, savingCount=0）：移除 is-dirty + is-saving', () => {
    const state = { isDirty: false, savingCount: 0 };
    syncSaveButton({ btnSave: btn, state, setDirty });
    expect(btn.classList.contains('is-dirty')).toBe(false);
    expect(btn.classList.contains('is-saving')).toBe(false);
    expect(btn.getAttribute('aria-busy')).toBe('false');
    expect(btn.getAttribute('aria-label')).toBe('保存');
    expect(btn.title).toBe('保存 (Ctrl+S)');
    expect(setDirty).toHaveBeenCalledWith(false);
  });

  it('脏态（isDirty=true, savingCount=0）：加 is-dirty + 改文案', () => {
    const state = { isDirty: true, savingCount: 0 };
    syncSaveButton({ btnSave: btn, state, setDirty });
    expect(btn.classList.contains('is-dirty')).toBe(true);
    expect(btn.classList.contains('is-saving')).toBe(false);
    expect(btn.getAttribute('aria-busy')).toBe('false');
    expect(btn.getAttribute('aria-label')).toBe('保存（有待保存的改动）');
    expect(btn.title).toBe('保存（有待保存的改动） (Ctrl+S)');
    expect(setDirty).toHaveBeenCalledWith(true);
  });

  it('保存中（isDirty=false, savingCount=1）：加 is-saving + aria-busy=true', () => {
    const state = { isDirty: false, savingCount: 1 };
    syncSaveButton({ btnSave: btn, state, setDirty });
    expect(btn.classList.contains('is-dirty')).toBe(false);
    expect(btn.classList.contains('is-saving')).toBe(true);
    expect(btn.getAttribute('aria-busy')).toBe('true');
    expect(btn.getAttribute('aria-label')).toBe('保存中…');
    expect(btn.title).toBe('保存中…');
    // savingCount>0 不影响 isDirty 通知，setDirty 仍按 isDirty 当前值传
    expect(setDirty).toHaveBeenCalledWith(false);
  });

  it('同时保存中 + 脏（savingCount>0 优先于 isDirty 的文案）', () => {
    // 在飞行期间用户又敲了字，isDirty 重新为 true —— 文案应当显示「保存中…」
    // 而不是「有待保存改动」。is-dirty class 保留是为了视觉提示（warning 色脉动）
    const state = { isDirty: true, savingCount: 1 };
    syncSaveButton({ btnSave: btn, state, setDirty });
    expect(btn.classList.contains('is-dirty')).toBe(true);
    expect(btn.classList.contains('is-saving')).toBe(true);
    expect(btn.getAttribute('aria-busy')).toBe('true');
    expect(btn.getAttribute('aria-label')).toBe('保存中…');
    expect(setDirty).toHaveBeenCalledWith(true);
  });

  it('savingCount 累加（并发 save）：归零前不切回非 saving 态', () => {
    // 模拟 inFlightSave 共享：第一次 save 入口 ++savingCount → 1；第二次 save
    // 共享路径又 ++savingCount → 2。共享 then 完成时两次 finally 各 -1，最终归零。
    // 函数本身只读 savingCount>0 判定，所以中间任意调用都保持 is-saving。
    const state = { isDirty: false, savingCount: 2 };
    syncSaveButton({ btnSave: btn, state, setDirty });
    expect(btn.classList.contains('is-saving')).toBe(true);
    expect(btn.getAttribute('aria-busy')).toBe('true');
  });

  it('btnSave=null → 静默 return，不抛', () => {
    const state = { isDirty: true, savingCount: 0 };
    // eslint-disable-next-line no-unused-vars
    const localSetDirty = vi.fn();
    expect(() => syncSaveButton({ btnSave: null, state, setDirty: localSetDirty }))
      .not.toThrow();
    // btnSave=null 时整个函数提前 return，不会调 setDirty
    expect(localSetDirty).not.toHaveBeenCalled();
  });

  it('setDirty 缺省 → 默认空操作（不抛）', () => {
    const state = { isDirty: true, savingCount: 0 };
    expect(() => syncSaveButton({ btnSave: btn, state })).not.toThrow();
    // 即便 btnSave 存在且 state.isDirty=true，没传 setDirty 也不抛
    expect(btn.classList.contains('is-dirty')).toBe(true);
  });

  it('savingCount 归零保护：helper 不修改 savingCount', () => {
    // 回归保护：syncSaveButtonUI 是纯 UI 同步，不应修改 state.savingCount。
    // savingCount 的累加/递减必须由 save() 入口/finally 唯一管理，否则会
    // 与 save() 内部的累加叠加导致计数永远不平衡 → 保存按钮永远卡在
    // 「保存中…」态。手动审计 src/app.js:save() 用外层 try/finally 覆盖
    // 所有 6 个 return 路径，但 helper 这里也加一道防线。
    const state = { isDirty: true, savingCount: 5 };
    const before = state.savingCount;
    syncSaveButton({ btnSave: btn, state, setDirty });
    expect(state.savingCount).toBe(before);
    expect(state.savingCount).toBe(5);
  });

  it('连续调用：脏→保存中→干净，三阶段过渡', () => {
    // 模拟完整 save() 生命周期：onChange (脏) → save 入口 (savingCount++) → 成功
    // (markSaved + savingCount--)
    syncSaveButton({ btnSave: btn, state: { isDirty: true, savingCount: 0 }, setDirty });
    expect(btn.classList.contains('is-dirty')).toBe(true);
    expect(btn.classList.contains('is-saving')).toBe(false);

    // save 入口
    syncSaveButton({ btnSave: btn, state: { isDirty: true, savingCount: 1 }, setDirty });
    expect(btn.classList.contains('is-dirty')).toBe(true);
    expect(btn.classList.contains('is-saving')).toBe(true);
    expect(btn.getAttribute('aria-busy')).toBe('true');

    // save 完成：isDirty 重读为 false，savingCount 归零
    syncSaveButton({ btnSave: btn, state: { isDirty: false, savingCount: 0 }, setDirty });
    expect(btn.classList.contains('is-dirty')).toBe(false);
    expect(btn.classList.contains('is-saving')).toBe(false);
    expect(btn.getAttribute('aria-busy')).toBe('false');
    expect(btn.getAttribute('aria-label')).toBe('保存');
  });
});

describe('syncSaveButton 状态栏未保存 chip', () => {
  let btn;
  let chip;
  let setDirty;

  beforeEach(() => {
    btn = makeBtn();
    chip = makeStatusUnsaved();
    setDirty = vi.fn();
  });

  it('脏态：chip 显示「未保存」', () => {
    syncSaveButton({ btnSave: btn, statusUnsaved: chip, state: { isDirty: true, savingCount: 0 }, setDirty });
    expect(chip.hidden).toBe(false);
    expect(chip.textContent).toBe('未保存');
    expect(chip.getAttribute('aria-label')).toBe('当前文件有未保存的改动');
  });

  it('干净态：chip hidden', () => {
    syncSaveButton({ btnSave: btn, statusUnsaved: chip, state: { isDirty: false, savingCount: 0 }, setDirty });
    expect(chip.hidden).toBe(true);
  });

  it('保存中但已脏：仍显示 chip（不让过渡态闪烁）', () => {
    // 设计决策：savingCount>0 但 isDirty=true 时仍显示 chip —— 飞行结束后
    // 会立刻切回脏/干净，状态栏不要一明一灭的视觉抖动。仅 isDirty 驱动 chip。
    syncSaveButton({ btnSave: btn, statusUnsaved: chip, state: { isDirty: true, savingCount: 1 }, setDirty });
    expect(chip.hidden).toBe(false);
    expect(chip.textContent).toBe('未保存');
  });

  it('保存中且不脏（飞行期用户撤销编辑？）：chip hidden', () => {
    syncSaveButton({ btnSave: btn, statusUnsaved: chip, state: { isDirty: false, savingCount: 1 }, setDirty });
    expect(chip.hidden).toBe(true);
  });

  it('chip 不传：DOM 不被影响', () => {
    // 兼容旧调用方（不传 statusUnsaved），不应抛错
    expect(() =>
      syncSaveButton({ btnSave: btn, state: { isDirty: true, savingCount: 0 }, setDirty })
    ).not.toThrow();
  });
});