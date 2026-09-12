// 保存按钮 UI 同步 —— 纯函数，与 src/app.js 解耦，便于单测。
//
// 设计：
//   - 始终显示按钮（见 [[feedback-save-button-always-visible]]），靠 class / aria
//     表达三态：保存中 / 有待保存改动 / 干净。
//   - 「保存中」用 savingCount 计数器（>0 即为保存中）—— 共享 inFlightSave 期间
//     多次进入 save() 不会因共享 then 路径无 finally 而闪烁；归零才真正熄灭。
//   - 不设 disabled 属性 —— Ctrl+S 走 EditorView keymap（与 DOM disabled 无关），
//     设了反而与 click / hover 反馈不一致。视觉提示用 cursor + opacity。

/**
 * 把 state.isDirty / state.savingCount 同步到按钮的 class / aria-busy / aria-label / title，
 * 并把 isDirty 同步到状态栏「未保存」chip（hidden + 文案）。
 * 同时把 isDirty 通过 setDirtyFn 回调传出（用于 IPC 通知主进程）。
 *
 * @param {Object}   args
 * @param {HTMLElement|null} args.btnSave      保存按钮 DOM（可为 null，函数静默 return）
 * @param {HTMLElement|null} [args.statusUnsaved]  状态栏未保存 chip（可选；缺省不更新）
 * @param {Object}   args.state                renderer state（用 isDirty / savingCount）
 * @param {(dirty: boolean) => any} [args.setDirty]  异步通知外部（IPC）；缺省空操作
 */
export function syncSaveButton({ btnSave, statusUnsaved, state, setDirty = () => {} }) {
  if (!btnSave) return;
  const isSaving = state.savingCount > 0;
  btnSave.classList.toggle('is-dirty', state.isDirty);
  btnSave.classList.toggle('is-saving', isSaving);
  btnSave.setAttribute('aria-busy', isSaving ? 'true' : 'false');
  // 三态文案：保存中 > 有待保存改动 > 干净
  const label = isSaving
    ? '保存中…'
    : (state.isDirty ? '保存（有待保存的改动）' : '保存');
  btnSave.setAttribute('aria-label', label);
  btnSave.title = isSaving
    ? '保存中…'
    : (state.isDirty ? '保存（有待保存的改动） (Ctrl+S)' : '保存 (Ctrl+S)');
  // 状态栏「未保存」chip：preview / 全屏等场景下，工具栏按钮可能被遮挡，
  // 状态栏右下角的红点 chip 是更显眼的脏态指示。
  // 只反映 isDirty —— is-saving 是过渡态，飞行结束会立刻切回脏/干净，
  // 不需要重复在状态栏展示（避免一明一灭的视觉抖动）。
  if (statusUnsaved) {
    statusUnsaved.hidden = !state.isDirty;
    statusUnsaved.textContent = '未保存';
    statusUnsaved.setAttribute('aria-label', '当前文件有未保存的改动');
  }
  setDirty(state.isDirty);
}