// state.isDirty ↔ editor.isDirty() 单向提升同步 helper（Round 3 bug 修复）
//
// 抽离动机：app.js 的 syncDirtyFromEditor 是模块级闭包函数，无法 import 单测。
// 把「单向上提」的纯逻辑挪到本文件，app.js 里再薄包一层负责 UI 同步
//（syncSaveButton）。这样单测可以纯函数式验证「editor 有未保存字符时 state
// 必须被提升」契约，不需要 mock 一堆 app.js 模块级闭包。
//
// 关键不变量（详见 app.js#syncDirtyFromEditor 注释块）：
//   - state.isDirty 是 onChange 维护的派生状态；markdown-editor.js updateListener
//     在 IME 合成期间跳过 onChange，state.isDirty 可能 stale。
//   - 半步保存场景：state.isDirty=true + editor.isDirty()=false —— 这是有意保留
//     的「飞行期新字符」标记，本函数**绝不**把它盖成 false。
//   - 因此本函数只做 false → true 单向提升，永远不做 true → false。

/**
 * 把 state.isDirty 同步到 editor.isDirty() 的实时真相（仅提升）。
 *
 * @param {{ isDirty: boolean }} state - 应用状态对象（仅读 + 写 isDirty）
 * @param {{ isDirty: () => boolean }} editor - 编辑器实例（提供 isDirty() 真相）
 * @returns {boolean} true 表示发生了 false→true 的提升；false 表示无需提升
 *   （已是 true / editor 也说没改动 / 半步保存场景保持 true）
 */
export function syncDirtyFromEditor(state, editor) {
  if (!state.isDirty && editor.isDirty()) {
    state.isDirty = true;
    return true;
  }
  return false;
}