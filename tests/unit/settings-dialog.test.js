// settings-dialog.js 的纯函数测试。
//
// settings-dialog 整个类没有单测（mount 路径太重、依赖 modal-stack / settingsStore
// / window.api 等太多胶水），但其中有几个无副作用的小函数值得保护。
// 本文件只覆盖那些 —— 别引整个 dialog 进来，那会拖一堆 stub。

import { describe, it, expect } from 'vitest';
import { clearAiKeyDefaultValue } from '../../src/settings-dialog.js';

describe('clearAiKeyDefaultValue（Sec-M3 修复：防 dataset 残留真 Key）', () => {
  // 背景：reveal flow 会先写 input.dataset.defaultValue = 真 Key，再把
  // .value 同步暴露给用户；关 dialog 时必须把 dataset.defaultValue 删掉，
  // 否则 XSS / DevTools / 复制粘贴能直接读出真 Key，绕过 arm/reveal 5 秒窗口。
  // 这条函数被 3 处调用：mount 后 / modal.setOnClose 早期 handler / 主 close handler。

  it('正常 input 元素：删掉 defaultValue，保留其他 dataset 属性', () => {
    const input = {
      dataset: { defaultValue: 'sk-real-key', other: 'untouched' },
    };
    clearAiKeyDefaultValue(input);
    expect(input.dataset.defaultValue).toBeUndefined();
    expect(input.dataset.other).toBe('untouched');
  });

  it('dataset 上没有 defaultValue 时不抛错（幂等）', () => {
    const input = { dataset: { other: 'x' } };
    expect(() => clearAiKeyDefaultValue(input)).not.toThrow();
    expect(input.dataset.other).toBe('x');
  });

  it('null / undefined 输入静默 no-op，不抛', () => {
    expect(() => clearAiKeyDefaultValue(null)).not.toThrow();
    expect(() => clearAiKeyDefaultValue(undefined)).not.toThrow();
  });

  it('没有 dataset 属性的对象静默 no-op', () => {
    // 防御：如果调用方传错对象（比如 element ref 但还没 mount、或者 wrapper），
    // 不能让 reveal 关 dialog 流程崩。真实 DOM 元素总有 dataset，所以这是兜底。
    const fake = {};
    expect(() => clearAiKeyDefaultValue(fake)).not.toThrow();
  });

  it('多次调用幂等（连续关 dialog / 双保险路径不会破坏）', () => {
    const input = { dataset: { defaultValue: 'k' } };
    clearAiKeyDefaultValue(input);
    clearAiKeyDefaultValue(input);
    clearAiKeyDefaultValue(input);
    expect(input.dataset.defaultValue).toBeUndefined();
  });
});
