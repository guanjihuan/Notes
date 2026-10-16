// splitRatio 重置决策 —— applyEditorMode 内部按视觉模式决定是否重置。
// ============================================================================
//
// 背景（audit P0-4 + Memory-2）：
//   - 编辑双栏（splitRatio）每次「打开」都默认对半分，drag 比例仅本次会话内
//     有效，不跨应用重启保留。
//   - 旧实现用 `document.body.dataset.editorMode !== 'split'` 做闸 —— 但默认
//     editorMode='split' 冷启动时 dataset 已是 'split'，闸永远为假，上次拖的
//     70% 在冷启动被恢复。
//   - 修复：按 visualMode 决定（不再依赖 DOM dataset / state.editorMode）——
//     visualMode='split' 即重置，其它不动。包括非 md 文件强制回落 'edit'
//     的场景，自然不重置。
//
// 错误处理：settingsStore.update 失败用 onError 上报（默认 console.warn），
// 不抛出 —— 布局重置是非关键路径，写盘失败不应让 app 挂掉。
//
// mountSplitter.onDragEnd 同步改为 noop（drag 不再持久化），留在 app.js
// commit 里人工 review，不在本文件。

/**
 * 视觉模式为 'split' 时，重置 settings.splitRatio 到 0.5；其它模式不动。
 *
 * @param {string} visualMode - 解析后的视觉模式（'preview' | 'edit' | 'split'）
 * @param {{ update: (partial: object) => Promise<*> }} settingsStore
 * @param {(msg: string) => void} [onError] - settingsStore.update 失败上报；
 *   默认 console.warn（不抛，避免布局重置错误炸掉 app）
 * @returns {void}
 */
export function applySplitRatioResetIfEnteringSplit(visualMode, settingsStore, onError) {
  if (visualMode !== 'split') return;
  // 已经是 0.5 就跳过写盘：本函数会在每次打开 / 模式切换 / save() finally 里被调用，
  // 若每次都写 splitRatio:0.5，会对 settings 文件产生无意义的写入（触发额外的
  // scan / 写入竞争）。settingsStore.get 存在时才短路（不存在则照旧写，保持旧行为）。
  if (typeof settingsStore.get === 'function' && settingsStore.get('splitRatio') === 0.5) {
    return;
  }
  const report = onError || ((msg) => console.warn(msg));
  settingsStore.update({ splitRatio: 0.5 }).catch((e) => {
    report(`布局比例重置失败：${e?.message || '未知错误'}`);
  });
}
