// main.js app:save-settings —— invalid partial payload 拒绝（audit P1-1）
//
// 背景：原 handler `if (!partial || typeof partial !== 'object') return
// { ok: true, settings: configStore.getConfig() };` 把 null / undefined /
// string / array 都当成「无更新」静默放过，renderer 缓存与磁盘脱钩
// （settingsStore.update({...}) 拿不到 error 也不会重试，直到下次合法保存）。
//
// 修复：抽出 isValidPartialSettings(partial) 纯函数；handler 顶部用。
// 拒收集合：null / undefined / 任何 primitive / Array / Function。
// 接收：plain object（typeof === 'object' && !Array.isArray）。
//
// 测试策略：直接 import 纯函数，无 Electron / fs / IPC mock 依赖。

import { describe, it, expect } from 'vitest';
import { isValidPartialSettings } from '../../main/save-settings-validate.js';

describe('app:save-settings partial payload 校验（audit P1-1）', () => {
  it('null → false', () => {
    expect(isValidPartialSettings(null)).toBe(false);
  });

  it('undefined → false', () => {
    expect(isValidPartialSettings(undefined)).toBe(false);
  });

  it('字符串 primitive → false', () => {
    expect(isValidPartialSettings('hello')).toBe(false);
  });

  it('数字 primitive → false', () => {
    expect(isValidPartialSettings(42)).toBe(false);
  });

  it('boolean primitive → false', () => {
    expect(isValidPartialSettings(true)).toBe(false);
  });

  it('Array → false（即使非空）', () => {
    expect(isValidPartialSettings([])).toBe(false);
    expect(isValidPartialSettings(['a', 'b'])).toBe(false);
  });

  it('Function → false', () => {
    expect(isValidPartialSettings(() => {})).toBe(false);
  });

  it('plain object（空）→ true', () => {
    expect(isValidPartialSettings({})).toBe(true);
  });

  it('plain object（带字段）→ true', () => {
    expect(isValidPartialSettings({ alwaysOnTop: true })).toBe(true);
  });
});
