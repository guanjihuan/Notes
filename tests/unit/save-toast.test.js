// src/save-toast.js 单测（Phase N Q-fix + Phase 2 audit 修复）
//
// 覆盖 save() outer toast 决策的所有 (silent × result) 组合：
//   Phase N Q-fix 修四个真 bug：
//     1. shared path silent=false manual + IIFE stale → 旧逻辑不弹 toast
//        用户按 Ctrl+S 切文件后完全无反馈
//     2. shared path silent=true auto-save + manual silent=false 写盘成功
//        → 旧逻辑不弹「已保存」（IIFE silent=true 不弹 + shared manual
//        因 IIFE silent 被吞也不弹）
//     3. onSaveRequest silent=false 与 main.js confirmDiscardIfDirty 错误反馈
//        双重 toast
//     4. file:write catch 直回 e.message（英文 + 路径泄露）
//   Phase 2 audit 修 P1 #3：STALE 不再等同「写盘失败」—— writeFile 在 STALE
//   检查前已经 resolve，data 可能已落 targetPath。ok=true 让关窗路径能正常退
//   出，但 toast 文案不变（用户视角的「文件已切换」提示总是合适）。
//   本文件覆盖决策矩阵；bug 3 在调用方 silent=true（onSaveRequest），bug 4
//   在 main/file-ops.js#friendlyWriteError 处测，见 file-ops.test.js。

import { describe, it, expect, vi } from 'vitest';
import { decideSaveToast } from '../../src/save-toast.js';

function makeShowToast() {
  return vi.fn();
}

describe('decideSaveToast —— 基础合约', () => {
  it('silent=false + ok=true（无 STALE）→ 弹「已保存」(success)', () => {
    const showToast = makeShowToast();
    decideSaveToast(false, { ok: true }, showToast);
    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith('已保存', 'success', 2500);
  });

  it('silent=true + ok=true → 不弹（auto-save 静默）', () => {
    const showToast = makeShowToast();
    decideSaveToast(true, { ok: true }, showToast);
    expect(showToast).not.toHaveBeenCalled();
  });

  it('silent=true + reason=STALE → 不弹（auto-save 静默，不打扰用户）', () => {
    const showToast = makeShowToast();
    decideSaveToast(true, { ok: false, reason: 'STALE' }, showToast);
    expect(showToast).not.toHaveBeenCalled();
  });

  it('silent=true + 任何 reason → 都不弹', () => {
    // auto-save 飞行期任何失败 IIFE 内已按 result.error 弹过错误 toast（与 silent 无关），
    // 这里 silent=true 再弹会导致 auto-save 飞行期错误反馈与 silent=false 路径混淆
    const showToast = makeShowToast();
    decideSaveToast(true, { ok: false, reason: 'WRITE_FAILED' }, showToast);
    decideSaveToast(true, { ok: false, reason: 'IPC_ERROR' }, showToast);
    decideSaveToast(true, { ok: false, reason: 'STALE' }, showToast);
    decideSaveToast(true, { ok: true }, showToast);
    expect(showToast).not.toHaveBeenCalled();
  });

  it('result=null / undefined → 不抛、不弹', () => {
    const showToast = makeShowToast();
    expect(() => decideSaveToast(false, null, showToast)).not.toThrow();
    expect(() => decideSaveToast(false, undefined, showToast)).not.toThrow();
    expect(showToast).not.toHaveBeenCalled();
  });
});

describe('decideSaveToast —— STALE 反馈（核心 bug #1 修复 + Phase 2 P1 #3）', () => {
  it('silent=false + reason=STALE + ok=false → 弹「文件已切换，未保存到磁盘」(warning)', () => {
    // 关键修复 #1：飞行期用户切文件 → IIFE 静默 return {ok:false, reason:STALE} →
    // silent=false manual caller 必须有反馈，告知「文件已切换，未保存到磁盘」。
    // 旧逻辑 silent=false 但 result 不 ok → 不弹 → 用户按 Ctrl+S 什么反馈都没。
    const showToast = makeShowToast();
    decideSaveToast(false, { ok: false, reason: 'STALE' }, showToast);
    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith('文件已切换，未保存到磁盘', 'warning', 2500);
  });

  it('silent=false + reason=STALE + ok=true → 弹「已保存」(success，data 已落盘)', () => {
    // Round 13 fix (M20)：writeFile 在 STALE 检查前已 resolve → data 已落
    // targetPath，ok=true 表示写盘成功。此时用户已切走，editor 与 targetPath
    // 解耦，但磁盘上数据是对的 —— 弹「已保存」(success) 比「文件已切换」更
    // 准确反映「数据有没有存」。失败分支（ok=false）才弹「文件已切换」。
    const showToast = makeShowToast();
    decideSaveToast(false, { ok: true, reason: 'STALE' }, showToast);
    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith('已保存', 'success', 2500);
  });

  it('STALE + ok=true 走 success；ok=false 走 warning（防呆双向断言）', () => {
    // 防呆：必须严格按 ok 分流 —— ok=true 弹 success，ok=false 弹 warning。
    // 不能「STALE 一律走 warning」（会把「data 已落盘」误导成「没存」），
    // 也不能「STALE 一律走 success」（写盘失败却被告知「已保存」）。
    const okToast = makeShowToast();
    decideSaveToast(false, { ok: true, reason: 'STALE' }, okToast);
    expect(okToast).toHaveBeenCalledWith('已保存', 'success', 2500);
    expect(okToast).not.toHaveBeenCalledWith('文件已切换，未保存到磁盘', 'warning', 2500);
    const failToast = makeShowToast();
    decideSaveToast(false, { ok: false, reason: 'STALE' }, failToast);
    expect(failToast).toHaveBeenCalledWith('文件已切换，未保存到磁盘', 'warning', 2500);
    expect(failToast).not.toHaveBeenCalledWith('已保存', 'success', 2500);
  });

  it('silent=false + 其它失败 reason（CONFLICT_*/WRITE_FAILED/IPC_ERROR/...）→ 不弹', () => {
    // 关键防呆：IIFE 内部已按 result.error 弹过具体错误 toast（FILE_CHANGED_EXTERNALLY
    // → 弹冲突对话框 / FILE_NOT_FOUND → 弹「文件已被删除」/ errno → 弹「磁盘满 / 只读」等），
    // 这里再弹「文件已切换...」会误导用户以为换文件了。
    const showToast = makeShowToast();
    decideSaveToast(false, { ok: false, reason: 'WRITE_FAILED' }, showToast);
    decideSaveToast(false, { ok: false, reason: 'IPC_ERROR' }, showToast);
    decideSaveToast(false, { ok: false, reason: 'CONFLICT_DISCARDED' }, showToast);
    decideSaveToast(false, { ok: false, reason: 'CONFLICT_KEPT' }, showToast);
    decideSaveToast(false, { ok: false, reason: 'FILE_NOT_FOUND' }, showToast);
    decideSaveToast(false, { ok: false, reason: 'PATH_NOT_ALLOWED' }, showToast);
    decideSaveToast(false, { ok: false, reason: 'SYMLINK_NOT_ALLOWED' }, showToast);
    expect(showToast).not.toHaveBeenCalled();
  });

  it('silent=false + ok=false 无 reason → 不弹（防御性）', () => {
    const showToast = makeShowToast();
    decideSaveToast(false, { ok: false }, showToast);
    expect(showToast).not.toHaveBeenCalled();
  });
});

describe('decideSaveToast —— shared path 场景（核心 bug #2 修复）', () => {
  it('auto-save silent=true 飞行期 + manual silent=false 写盘成功 → 弹「已保存」', () => {
    // 关键修复：旧逻辑 IIFE silent=true 不弹 + shared manual silent=false 也
    // 被吞（直接 return IIFE 结果）→ 用户按 Ctrl+S 成功写盘无任何反馈。
    // 现在 shared path 调 decideSaveToast，silent=false manual 自己决定 → 弹。
    const showToast = makeShowToast();
    decideSaveToast(false, { ok: true }, showToast);
    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith('已保存', 'success', 2500);
  });

  it('auto-save silent=true 飞行期 + manual silent=false STALE → 弹「文件已切换」', () => {
    const showToast = makeShowToast();
    decideSaveToast(false, { ok: false, reason: 'STALE' }, showToast);
    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith('文件已切换，未保存到磁盘', 'warning', 2500);
  });

  it('auto-save silent=true 飞行期 + manual silent=false STALE+ok=true → 弹「已保存」', () => {
    // Round 13 fix (M20)：writeFile 成功但用户已切走 → 关窗路径用 ok=true
    // 退出，silent=false manual caller 看到「数据已落盘」弹 success 而非
    // 「文件已切换」—— 后者会误导（明明已存却说没存）。
    const showToast = makeShowToast();
    decideSaveToast(false, { ok: true, reason: 'STALE' }, showToast);
    expect(showToast).toHaveBeenCalledWith('已保存', 'success', 2500);
  });

  it('同 IIFE 结果：auto-save silent=true 不弹 + manual silent=false 弹 → 不互相干扰', () => {
    // 这是核心：IIFE 写盘成功后，auto-save 不弹、manual 弹「已保存」；
    // 各自按 silent 决策，避免双重 toast（force_overwrite 递归 + manual 共享
    // 的边缘 case 仍会有两次「已保存」，但这是 Phase N 之前已有的取舍）。
    const sharedResult = { ok: true };
    const autoSaveToast = makeShowToast();
    const manualToast = makeShowToast();
    decideSaveToast(true, sharedResult, autoSaveToast);
    decideSaveToast(false, sharedResult, manualToast);
    expect(autoSaveToast).not.toHaveBeenCalled();
    expect(manualToast).toHaveBeenCalledTimes(1);
    expect(manualToast).toHaveBeenCalledWith('已保存', 'success', 2500);
  });
});

describe('decideSaveToast —— onSaveRequest silent=true（核心 bug #3 修复）', () => {
  it('silent=true + 任何失败 reason → 不弹', () => {
    // 关键修复：onSaveRequest 调 save({silent:true})，关闭路径反馈由主进程
    // confirmDiscardIfDirty 原生框统一负责，避免双重 toast（renderer toast +
    // main 原生「保存失败」框）。本 helper 在 silent=true 时一律不弹，
    // 让 main.js 的原生对话框主导。
    const showToast = makeShowToast();
    decideSaveToast(true, { ok: false, reason: 'WRITE_FAILED' }, showToast);
    decideSaveToast(true, { ok: false, reason: 'IPC_ERROR' }, showToast);
    decideSaveToast(true, { ok: false, reason: 'STALE' }, showToast);
    decideSaveToast(true, { ok: true }, showToast);
    expect(showToast).not.toHaveBeenCalled();
  });

  it('silent=true + STALE ok=true → 不弹（关窗路径由 main.js 原生框主导）', () => {
    // Phase 2 P1 #3 回归：onSaveRequest silent=true + STALE ok=true（writeFile
    // 成功但用户已切走），save() outer 返回 true 让 main.js 顺利退出，
    // 但 renderer 不应弹任何 toast（关窗场景用户看不见，且避免与 main 原生框重叠）。
    const showToast = makeShowToast();
    decideSaveToast(true, { ok: true, reason: 'STALE' }, showToast);
    expect(showToast).not.toHaveBeenCalled();
  });
});

describe('decideSaveToast —— NO_CHANGES 反馈（audit 2026-08：早退路径用户感知）', () => {
  it('silent=false + reason=NO_CHANGES → 弹「已是最新」(info)', () => {
    // 关键修复：save() 的 !state.isDirty 早退路径手动调用 decideSaveToast，
    // 传 { ok:true, reason:'NO_CHANGES' }。旧逻辑早退 return true 不弹任何 toast，
    // auto-save 静默写盘后用户手动点保存 → 看不到反馈 → 「按钮坏了」类错觉。
    const showToast = makeShowToast();
    decideSaveToast(false, { ok: true, reason: 'NO_CHANGES' }, showToast);
    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith('已是最新', 'info', 1500);
  });

  it('silent=true + reason=NO_CHANGES → 不弹（auto-save 早退时静默）', () => {
    // auto-save silent 路径不应被新分支打扰；头部 `if (silent) return` 一并拦下。
    const showToast = makeShowToast();
    decideSaveToast(true, { ok: true, reason: 'NO_CHANGES' }, showToast);
    expect(showToast).not.toHaveBeenCalled();
  });

  it('NO_CHANGES 优先于 ok=true：reason=NO_CHANGES 时一律走 info', () => {
    // 防呆：传 ok=true 但带 NO_CHANGES reason 必须走 info 分支，不弹 success。
    // 否则手动保存「已是最新」会被误显示成「已保存」(success)，语义错位。
    const showToast = makeShowToast();
    decideSaveToast(false, { ok: true, reason: 'NO_CHANGES' }, showToast);
    expect(showToast).toHaveBeenCalledWith('已是最新', 'info', 1500);
    expect(showToast).not.toHaveBeenCalledWith('已保存', 'success', 2500);
  });
});

describe('decideSaveToast —— NO_FILE 反馈（Round 7 S-3：区分「没打开」与「已是最新」）', () => {
  it('silent=false + reason=NO_FILE → 弹「没有打开文件」(info)', () => {
    // 关键修复：save() 的 !state.currentFile 早退路径手动调用 decideSaveToast，
    // 传 { ok:true, reason:'NO_FILE' }。旧版共用 NO_CHANGES 文案「已是最新」，
    // 但用户视角「我什么都没打开」与「有文件且未改动」语义不同 —— 改用准确
    // 文案「没有打开文件」。
    const showToast = makeShowToast();
    decideSaveToast(false, { ok: true, reason: 'NO_FILE' }, showToast);
    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith('没有打开文件', 'info', 1500);
  });

  it('silent=true + reason=NO_FILE → 不弹（auto-save 早退时静默）', () => {
    const showToast = makeShowToast();
    decideSaveToast(true, { ok: true, reason: 'NO_FILE' }, showToast);
    expect(showToast).not.toHaveBeenCalled();
  });

  it('NO_FILE 不被 NO_CHANGES 截胡：两个 reason 独立走各自分支', () => {
    // 防呆：NO_FILE 与 NO_CHANGES 是两种不同的早退语义，不能相互覆盖。
    const fileToast = makeShowToast();
    decideSaveToast(false, { ok: true, reason: 'NO_FILE' }, fileToast);
    expect(fileToast).toHaveBeenCalledWith('没有打开文件', 'info', 1500);
    expect(fileToast).not.toHaveBeenCalledWith('已是最新', 'info', 1500);
    const changesToast = makeShowToast();
    decideSaveToast(false, { ok: true, reason: 'NO_CHANGES' }, changesToast);
    expect(changesToast).toHaveBeenCalledWith('已是最新', 'info', 1500);
    expect(changesToast).not.toHaveBeenCalledWith('没有打开文件', 'info', 1500);
  });
});

describe('decideSaveToast —— DELEGATED 反馈（Round 8 S-1：force_overwrite 委托 inner）', () => {
  // audit fix (Round 8 S-1)：force_overwrite 把写盘委托给递归 inner save()，
  // inner 自己已经按 silent=false 弹过「已保存」或具体错误 toast。outer 只负责
  // 把 ok 透传给调用方（关窗 / save_and_open 依赖它），不能再弹第二个 toast。
  // 关键：silent=false 也不弹，因为 inner 已经弹过；silent=true 也不弹（auto-save）。
  it('silent=false + reason=DELEGATED + ok=true → 不弹（inner 已弹过「已保存」）', () => {
    const showToast = makeShowToast();
    decideSaveToast(false, { ok: true, reason: 'DELEGATED' }, showToast);
    expect(showToast).not.toHaveBeenCalled();
  });
  it('silent=false + reason=DELEGATED + ok=false → 不弹（inner 已弹过错误 toast）', () => {
    const showToast = makeShowToast();
    decideSaveToast(false, { ok: false, reason: 'DELEGATED' }, showToast);
    expect(showToast).not.toHaveBeenCalled();
  });
  it('silent=true + reason=DELEGATED → 不弹（auto-save 静默）', () => {
    const showToast = makeShowToast();
    decideSaveToast(true, { ok: true, reason: 'DELEGATED' }, showToast);
    expect(showToast).not.toHaveBeenCalled();
  });
  it('DELEGATED 不被 NO_FILE / NO_CHANGES / STALE / 通用 ok=true 截胡：reason=DELEGATED 永远走 DELEGATED 分支', () => {
    // 反例验证：ok=true 时不能被「已保存」分支兜底再弹一个 toast。
    const showToast = makeShowToast();
    decideSaveToast(false, { ok: true, reason: 'DELEGATED' }, showToast);
    expect(showToast).not.toHaveBeenCalledWith('已保存', 'success', 2500);
    expect(showToast).not.toHaveBeenCalledWith('已是最新', 'info', 1500);
    expect(showToast).not.toHaveBeenCalledWith('没有打开文件', 'info', 1500);
    expect(showToast).not.toHaveBeenCalledWith('文件已切换，未保存到磁盘', 'warning', 2500);
  });
});