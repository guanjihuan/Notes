// 保存路径 toast 决策（Phase N Q-fix）
//
// 把 save() 主路径与 shared path 都需要的 toast 决策抽成纯函数，方便单测
// 覆盖所有 silent × result 组合，避免两端 inline if/else 漂移。
//
// 历史问题：save() IIFE 内部曾直接 `if (!silent) showToast('已保存')`，
// shared path 复用 IIFE 返回值时用的是 IIFE 创建者的 silent —— 用户连按
// 两次 Ctrl+S（auto-save silent=true 飞行期 user silent=false 手动），silent
// 标志被 IIFE 吞掉，manual caller 收不到「已保存」反馈。重构后：
//   - IIFE 内部不再弹 success toast，统一返回 {ok, reason}
//   - save() outer（主路径 + shared path）按自己的 silent 决定是否弹
//   - shared path 还有 stale 场景（飞行期切文件 → IIFE 静默 return STALE），
//     silent=false manual caller 必须弹「文件已切换，未保存到磁盘」
//
// 错误 toast（FILE_CHANGED_EXTERNALLY 各分支 / FILE_NOT_FOUND / PATH_NOT_ALLOWED
// / SYMLINK_NOT_ALLOWED / errno 兜底 / IPC_ERROR）仍在 IIFE 各分支里按 result.error
// 弹，与 silent 无关 —— 所有 silent 都弹错误（用户必须感知失败）。本 helper
// 只管 success + STALE 两种 toast 决策。
//
// @param {boolean} silent
// @param {{ok:boolean, reason?:string}|null|undefined} result
// @param {(message: string, type: 'success'|'warning'|'error'|'info', duration: number) => void} showToast
// @returns {void}

/**
 * 根据调用方 silent 标志 + IIFE 返回结果决定是否弹 toast。
 *
 * 决策矩阵：
 *   - silent=false + ok=true（无 STALE / NO_CHANGES 标记） → 「已保存」(success, 2500ms)
 *   - silent=false + reason='STALE'（无论 ok）              → 「文件已切换，未保存到磁盘」(warning)
 *     Phase 2 audit 修复 (P1 #3)：STALE 不再等同「写盘失败」。飞行期用户切
 *     走时 writeFile 已 resolve，data 可能已落 targetPath。ok=true 让关窗路径
 *     能正确退出；用户视角的反馈（manual Ctrl+S silent=false）应该总是 STALE
 *     提示（因为 editor 已不在 targetPath 上），文案保持中性「文件已切换，未
 *     保存到磁盘」—— 如果用户想知道数据到底有没有存，去看 A 文件本身。
 *   - silent=false + reason='NO_CHANGES'                   → 「已是最新」(info, 1500ms)
 *     fix(audit 2026-08)：auto-save 静默写盘后 state.isDirty=false，用户手动
 *     点保存按钮落入 !state.isDirty 早退路径，旧逻辑静默 return 让用户觉得
 *     「按钮坏了 / 没保存上」—— 实际文件已最新。给一个简短 info 让点击有反馈。
 *     auto-save silent=true 路径不影响（silent 早退）。
 *   - silent=false + reason='NO_FILE'                      → 「没有打开文件」(info, 1500ms)
 *     fix(audit Round 7 S-3)：旧版与 NO_CHANGES 共用「已是最新」文案，但语义
 *     错位 ——「已是最新」暗示「有文件且未改动」，用户视角「什么都没打开，
 *     按 Ctrl+S 当然没东西存」需要准确的「没有打开文件」。auto-save silent
 *     路径不影响。
 *   - silent=true  → 啥都不弹（auto-save / 关窗 silent=true 静默场景）
 *   - 其它失败 reason（CONFLICT_* / FILE_NOT_FOUND / PATH_NOT_ALLOWED / SYMLINK_NOT_ALLOWED
 *     / WRITE_FAILED / IPC_ERROR）→ 错误 toast 已在 IIFE 各分支按 result.error 弹过，
 *     本 helper 不重复弹（避免误导性「保存失败（请重试）」覆盖 IIFE 已弹的具体原因）。
 *
 * 「已保存」duration 从 1200ms 提到 2500ms（fix audit 2026-08）：1200ms 太快，
 * 用户实际只看到约半秒淡出动画，根本来不及形成「保存完成」的认知，导致
 * 「保存按钮失灵」类错觉反复出现。2500ms 是大多数 IDE（VS Code / Sublime）
 * 「Saved」toast 的常用区间，足够看见。
 */
export function decideSaveToast(silent, result, showToast) {
  if (silent) return;
  if (!result) return;
  if (result.reason === 'STALE') {
    showToast('文件已切换，未保存到磁盘', 'warning', 2500);
    return;
  }
  if (result.reason === 'NO_CHANGES') {
    showToast('已是最新', 'info', 1500);
    return;
  }
  if (result.reason === 'NO_FILE') {
    // audit fix (Round 7 S-3)：与 NO_CHANGES 区分。语义是「没有打开文件」
    // 而不是「文件已是最新」，文案准确反映状态。
    showToast('没有打开文件', 'info', 1500);
    return;
  }
  if (result.reason === 'DELEGATED') {
    // audit fix (Round 8 S-1)：force_overwrite 把写盘委托给递归 inner save()，
    // inner 自己已经按 silent=false 弹过「已保存」或具体错误 toast。outer 只负责
    // 把 ok 透传给调用方（关窗 / save_and_open 依赖它），不能再弹第二个 toast。
    return;
  }
  if (result.ok) {
    showToast('已保存', 'success', 2500);
  }
  // 其它失败 reason：IIFE 内部已按 result.error 弹过原因 toast，这里不重复。
}