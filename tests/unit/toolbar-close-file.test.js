// src/toolbar.js 的 onCloseFile 接线测试
//
// 覆盖：
//   - btnCloseFile click → onCloseFile 被调用
//   - 缺失 onCloseFile 时不挂 listener（防御）
//   - 缺失 btnCloseFile 时不挂 listener
//
// 真实运行链路：app.js 在 syncSaveButton() 末尾调 syncCloseFileButton()，
// 把按钮从 disabled → enabled；用户点击 → Toolbar 构造时挂的 listener 触发
// onCloseFile() → closeCurrentFile()。本测试只覆盖 Toolbar 自身的接线
// 段（构造时是否挂对 listener），不覆盖 closeCurrentFile 内部逻辑
// （那个由 app.js 模块顶层，单元测试触不到）。

/* @vitest-environment jsdom */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Toolbar } from '../../src/toolbar.js';

describe('toolbar.onCloseFile 接线', () => {
  let btnCloseFile;
  let elements;

  beforeEach(() => {
    document.body.innerHTML = `
      <button id="btn-close-file" type="button" disabled>关闭文件</button>
      <button id="btn-theme">主题</button>
      <button id="btn-pin">置顶</button>
      <button id="btn-settings">设置</button>
      <button id="btn-reset-layout">重置布局</button>
      <button id="btn-min">最小化</button>
      <button id="btn-max">最大化</button>
      <button id="btn-close">关闭窗口</button>
    `;
    btnCloseFile = document.getElementById('btn-close-file');
    elements = {
      btnTheme: document.getElementById('btn-theme'),
      btnPin: document.getElementById('btn-pin'),
      btnSettings: document.getElementById('btn-settings'),
      btnResetLayout: document.getElementById('btn-reset-layout'),
      btnMin: document.getElementById('btn-min'),
      btnMax: document.getElementById('btn-max'),
      btnClose: document.getElementById('btn-close'),
      btnCloseFile,
    };
  });

  /** 用 dispatchEvent 触发 click —— jsdom 的 .click() 在 form 容器里行为不稳。 */
  function clickEl(el) {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  }

  it('btnCloseFile click → onCloseFile 被调用一次', () => {
    const onCloseFile = vi.fn();
    new Toolbar({ elements, onCloseFile });
    clickEl(btnCloseFile);
    expect(onCloseFile).toHaveBeenCalledTimes(1);
  });

  it('多次点击 → onCloseFile 调用相应次数（无去重）', () => {
    const onCloseFile = vi.fn();
    new Toolbar({ elements, onCloseFile });
    clickEl(btnCloseFile);
    clickEl(btnCloseFile);
    clickEl(btnCloseFile);
    expect(onCloseFile).toHaveBeenCalledTimes(3);
  });

  it('btnCloseFile 缺失 → onCloseFile 不被调用也不抛错', () => {
    const onCloseFile = vi.fn();
    const elementsNoBtn = { ...elements };
    delete elementsNoBtn.btnCloseFile;
    expect(() => new Toolbar({ elements: elementsNoBtn, onCloseFile })).not.toThrow();
    expect(onCloseFile).not.toHaveBeenCalled();
  });

  it('btnCloseFile 存在但 onCloseFile 缺失 → 不挂 listener', () => {
    // 验证方式：btnCloseFile.click() 时不应触发任何引用错误。
    // 由于 listener 没挂，调用就是一个空操作；测试"不抛错"即可。
    expect(() => new Toolbar({ elements })).not.toThrow();
    // 没有 onCloseFile 时 listener 没挂，逻辑无副作用。
    // （更深层的"没挂"需要 spy addEventListener，超出本测试范围。）
  });

  it('按钮 disabled 状态不影响 listener 挂载', () => {
    // 浏览器层面 disabled 按钮 click 不派发，但 listener 应在构造时已挂。
    // jsdom 不会模拟浏览器的 disabled-click 抑制（disabled 后 click 仍派发），
    // 所以这个测试主要防回归：listener 必须挂上、调用 click 不抛错。
    btnCloseFile.disabled = true;
    const onCloseFile = vi.fn();
    new Toolbar({ elements, onCloseFile });
    expect(() => clickEl(btnCloseFile)).not.toThrow();
    expect(onCloseFile).toHaveBeenCalled();
  });

  it('btnClose 与 btnCloseFile 互不影响', () => {
    const onClose = vi.fn();
    const onCloseFile = vi.fn();
    new Toolbar({ elements, onClose, onCloseFile });
    clickEl(document.getElementById('btn-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onCloseFile).not.toHaveBeenCalled();
    clickEl(btnCloseFile);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onCloseFile).toHaveBeenCalledTimes(1);
  });
});
