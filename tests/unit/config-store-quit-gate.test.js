// main/config-store.js —— saveConfig isQuitting 闸（audit P1-2）
//
// 背景：renderer 错误风暴（如 settingsStore.update 触发循环）会建无界
// Promise 链；进程退出时 IPC handler `await configStore.saveConfig(...)`
// 被卡在最末一个未完成 task，before-quit 等不到 save 全部完成 → quit 阻塞。
//
// 修复：加 isQuitting 闸。before-quit 触发时把闸置 true，新 saveConfig
// 立即返回 { ok: false, error: 'APP_QUITTING' }（同步值，不是 Promise，
// 避免 IPC await 永不 resolve）。in-flight 任务照常完成（已 fsync 的
// 文件 rename 完才返回 ok:true，强制 abort 会丢正在写的 tmp）—— 「
// 进程退出」语意下「最新一个 save 完成」即可接受。
//
// 测试策略：直接 import config-store 模块，用 _setIsQuitting 控制闸。
// saveConfig 内部写 tmp + rename 到真文件 → 测试用真 fs + tmpdir 隔离。
// 注意：每次测试前 _reset 清状态 + _setIsQuitting(false)，避免 case 串扰。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as configStore from '../../main/config-store.js';

let mockHomeDir;
let mockUserDataDir;
let home;

function makeIsolatedHome() {
  const dir = mkdtempSync(join(tmpdir(), 'notes-config-quit-'));
  // 写入一个最小可用的 config.json（init 需要它存在）
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ alwaysOnTop: false }, null, 2), 'utf-8');
  return dir;
}

describe('config-store saveConfig isQuitting 闸（audit P1-2）', () => {
  beforeEach(async () => {
    mockHomeDir = mkdtempSync(join(tmpdir(), 'notes-cq-home-'));
    mockUserDataDir = mkdtempSync(join(tmpdir(), 'notes-cq-ud-'));
    configStore._setApp({
      getPath: (name) => {
        if (name === 'home') return mockHomeDir;
        if (name === 'userData') return mockUserDataDir;
        throw new Error(`unexpected getPath(${name})`);
      },
    });
    configStore._reset();
    configStore._setIsQuitting(false);
    home = makeIsolatedHome();
    await configStore.init({ homeDir: home });
  });

  it('默认状态：isQuitting = false', () => {
    expect(configStore._isQuitting()).toBe(false);
  });

  it('_setIsQuitting(true) 后 isQuitting 反映为 true', () => {
    configStore._setIsQuitting(true);
    expect(configStore._isQuitting()).toBe(true);
  });

  it('isQuitting=true 时 saveConfig 同步返 { ok:false, error:APP_QUITTING }，不写盘', async () => {
    configStore._setIsQuitting(true);
    const before = readFileSync(join(home, 'config.json'), 'utf-8');

    const result = await configStore.saveConfig({ alwaysOnTop: true });

    expect(result).toEqual({ ok: false, error: 'APP_QUITTING' });

    // 文件未被改写（before vs after 内容一致）
    const after = readFileSync(join(home, 'config.json'), 'utf-8');
    expect(after).toBe(before);
  });

  it('isQuitting=true 时 saveConfig 返的 Promise 已 resolve（不等链尾）', async () => {
    // 关键：闸开时返回的必须是「已 resolve 的值」，否则 IPC handler
    // `await saveConfig(...)` 永远挂在链尾 → before-quit 阻塞。
    configStore._setIsQuitting(true);

    // 10 次并发调用 → 全部应立即 resolve
    const results = await Promise.all(
      Array.from({ length: 10 }, () => configStore.saveConfig({ alwaysOnTop: true }))
    );

    expect(results).toHaveLength(10);
    for (const r of results) {
      expect(r).toEqual({ ok: false, error: 'APP_QUITTING' });
    }
  });

  it('isQuitting=true 时 in-flight 之前的 save 仍正常完成（不强制 abort）', async () => {
    // 第一个 save 在闸开启前排进 queue，应正常完成
    const p1 = configStore.saveConfig({ alwaysOnTop: true });
    configStore._setIsQuitting(true);
    const r1 = await p1;

    expect(r1.ok).toBe(true);
    expect(r1.value.alwaysOnTop).toBe(true);

    // 闸开后后续 save 被拒
    const r2 = await configStore.saveConfig({ alwaysOnTop: false });
    expect(r2).toEqual({ ok: false, error: 'APP_QUITTING' });
  });

  it('isQuitting=true → _setIsQuitting(false) 后 saveConfig 恢复工作', async () => {
    configStore._setIsQuitting(true);
    const r1 = await configStore.saveConfig({ alwaysOnTop: true });
    expect(r1).toEqual({ ok: false, error: 'APP_QUITTING' });

    configStore._setIsQuitting(false);
    const r2 = await configStore.saveConfig({ alwaysOnTop: true });
    expect(r2.ok).toBe(true);
  });

  afterEach(() => {
    if (home && existsSync(home)) {
      rmSync(home, { recursive: true, force: true });
    }
    if (mockHomeDir) rmSync(mockHomeDir, { recursive: true, force: true });
    if (mockUserDataDir) rmSync(mockUserDataDir, { recursive: true, force: true });
  });
});
