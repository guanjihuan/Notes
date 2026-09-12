// src/dirty-sync.js 测试（Round 3 bug 修复 · 2026-08）
//
// 验证单向提升同步契约：
//   - state.isDirty=false + editor.isDirty()=true → state.isDirty=true（提升）
//   - state.isDirty=true + editor.isDirty()=false → 不动（半步保存场景保留 true）
//   - state.isDirty=false + editor.isDirty()=false → 不动（真干净）
//   - state.isDirty=true + editor.isDirty()=true → 不动（已一致）
//
// 半步保存（save 飞行期用户敲字符）契约**绝对不**被破坏：state.isDirty=true
// 是「doc 比 writeFile 内容多」的标志，不能被 editor 的基线对比覆盖。这是
// save-toast.js#decideSaveToast 之外的核心 invariant。
//
// 关联：[[project-dirty-sync-ime-race-2026-08]]。

/* @vitest-environment jsdom */

import { describe, it, expect } from 'vitest';
import { syncDirtyFromEditor } from '../../src/dirty-sync.js';

function makeState(isDirty = false) {
  return { isDirty };
}

function makeEditor(isDirtyFn) {
  return { isDirty: isDirtyFn };
}

describe('syncDirtyFromEditor —— IME race 单向提升契约', () => {
  it('state=false + editor=true → 提升到 true（核心 IME race bug 修复）', () => {
    // 关键场景：用户用 IME 输入字符，state.isDirty 因 onChange 被 updateListener
    // 跳过而保持 false，但 editor.doc 里有 IME 字符。同步后 state 必须跟上 truth，
    // 否则 save() 走 !state.isDirty 早退返回「已是最新」，IME 字符丢失。
    const state = makeState(false);
    const editor = makeEditor(() => true);
    const promoted = syncDirtyFromEditor(state, editor);
    expect(promoted).toBe(true);
    expect(state.isDirty).toBe(true);
  });

  it('state=true + editor=false → 不动（半步保存契约，绝不能降级）', () => {
    // 半步保存：save 飞行期用户敲了字符 → state.isDirty=true 表示「doc 比
    // writeFile 内容多」。editor.isDirty() 返回 false 是因为 markSaved 已把
    // lastSavedDoc 设为当前 doc。这是有意的「飞行期新字符」标记，本函数绝不能
    // 把它盖成 false —— 否则下次 save() 会走早退，飞行期字符丢失。
    const state = makeState(true);
    const editor = makeEditor(() => false);
    const promoted = syncDirtyFromEditor(state, editor);
    expect(promoted).toBe(false);
    expect(state.isDirty).toBe(true);
  });

  it('state=false + editor=false → 不动（真干净，无提升需要）', () => {
    // 干净文件刚打开，state 与 editor 都没改动 —— 同步是 no-op。
    const state = makeState(false);
    const editor = makeEditor(() => false);
    const promoted = syncDirtyFromEditor(state, editor);
    expect(promoted).toBe(false);
    expect(state.isDirty).toBe(false);
  });

  it('state=true + editor=true → 不动（已一致，提升无意义）', () => {
    // 普通 dirty 状态，state 与 editor 都认为是 dirty —— 同步是 no-op。
    const state = makeState(true);
    const editor = makeEditor(() => true);
    const promoted = syncDirtyFromEditor(state, editor);
    expect(promoted).toBe(false);
    expect(state.isDirty).toBe(true);
  });

  it('editor.isDirty() 是惰性求值：只在 state=false 时调用（短路优化）', () => {
    // 性能契约：state=true 时绝不应调 editor.isDirty() —— 否则 save() 每次
    // 入口都会跑 doc.toString() 这种全量字符串对比。验证 spy 不被调用。
    let calls = 0;
    const state = makeState(true);
    const editor = makeEditor(() => { calls += 1; return false; });
    syncDirtyFromEditor(state, editor);
    expect(calls).toBe(0);
  });

  it('editor.isDirty() 在 state=false 时确实被调用', () => {
    let calls = 0;
    const state = makeState(false);
    const editor = makeEditor(() => { calls += 1; return false; });
    syncDirtyFromEditor(state, editor);
    expect(calls).toBe(1);
  });

  it('可重复调用（幂等）：提升后再次调用是 no-op', () => {
    // 多次调用不会「又提升一次」造成副作用累积。第二次 state=true 直接走短路。
    const state = makeState(false);
    const editor = makeEditor(() => true);
    syncDirtyFromEditor(state, editor);
    expect(state.isDirty).toBe(true);
    const secondCall = syncDirtyFromEditor(state, editor);
    expect(secondCall).toBe(false);
    expect(state.isDirty).toBe(true);
  });

  it('状态可观察：state 是普通的 mutable 对象，函数只写 isDirty 这一个字段', () => {
    // 防回归：本函数不应动 state 上的其他字段（比如 lastSavedMtimeMs）——
    // 调用方（app.js）用 state 做 dirty 决策外还做别的（mtime 比对、IPC setDirty
    // 等），如果这里意外改了其他字段会引入很难追的 bug。
    const state = { isDirty: false, lastSavedMtimeMs: 12345, currentFile: { path: '/x.md' } };
    const editor = makeEditor(() => true);
    syncDirtyFromEditor(state, editor);
    expect(state.isDirty).toBe(true);
    expect(state.lastSavedMtimeMs).toBe(12345);
    expect(state.currentFile).toEqual({ path: '/x.md' });
  });
});

describe('syncDirtyFromEditor —— 与 save() 早退检查的协同', () => {
  // 这是 Round 3 bug 的核心契约：save() 入口调本函数后，!state.isDirty 早退
  // 检查必须可靠 —— 即「editor 有改动」+ 「state 同步后」= 「不早退」。
  //
  // 这些 case 不是测 save() 本体（那需要 mock 一堆 app.js 闭包），而是测
  // syncDirtyFromEditor 产生的 state 状态，确保 save() 早退条件不会误判。

  it('IME race：editor 有字符 + state 已同步 → state.isDirty=true（save 不早退）', () => {
    const state = makeState(false);
    const editor = makeEditor(() => true);
    syncDirtyFromEditor(state, editor);
    // 模拟 save() 的早退条件：`!state.isDirty`
    expect(!state.isDirty).toBe(false); // 应该走 writeFile
  });

  it('真干净：state 与 editor 都 false → state 仍 false（save 早退 OK）', () => {
    const state = makeState(false);
    const editor = makeEditor(() => false);
    syncDirtyFromEditor(state, editor);
    expect(!state.isDirty).toBe(true); // save 早退是正确行为
  });

  it('半步保存：state=true + editor=false → state 仍 true（save 走 writeFile）', () => {
    const state = makeState(true);
    const editor = makeEditor(() => false);
    syncDirtyFromEditor(state, editor);
    expect(!state.isDirty).toBe(false); // save 走 writeFile 落盘飞行期新字符
  });
});

// ---------------------------------------------------------------------------
// applyEntries 守卫语义（app.js line 2298）
//
// 契约：editor 有未保存字符时，applyEntries 检测「文件被外部删除」必须
// 用 `editor.isDirty()`（实时真相），不能用 `state.isDirty`（IME 合成
// 期间被 updateListener 的 !isComposing 守卫屏蔽，可能 stale-false）。
//
// Round 9 P0 bug：旧实现 `!state.isDirty` → IME 期间 stale-false → 守卫
// 通过 → clearCurrentFile() → onFilesChanged line 2901 `if (!state.currentFile)
// return` 早退 → line 2917 syncDirtyFromEditor 永远不到 → line 2944 rescue
// 分支永远不到 → IME 字符随编辑器 view 销毁而丢失 + 窗口关闭 dirty=false
// 不弹保存提示 + 静默丢字。
//
// 这些测试不 import app.js（4111 行 + 大量模块级闭包），直接重放守卫的
// if-condition 断言语义。app.js 里改动对应的守卫条件会被 grep 拦住。
// ---------------------------------------------------------------------------

describe('applyEntries 删除守卫语义 —— IME race 必须用 editor.isDirty()', () => {
  // 重放 app.js#applyEntries 的守卫：state.currentFile && state.currentFile.path && !<DIRTY_TRUTH>
  function shouldClearOnFileDeleted(state, dirtyTruth) {
    return Boolean(state.currentFile && state.currentFile.path && !dirtyTruth);
  }

  it('editor 有未保存字符（IME 合成中） → 不能清 currentFile', () => {
    // 关键场景：用户 IME 拼音期间 state.isDirty 是 stale-false，
    // 但 editor.isDirty() = true。守卫必须用 editor.isDirty() 才能
    // 拦下 clearCurrentFile，让 onFilesChanged 的 rescue 路径接管。
    const state = { currentFile: { path: '/foo.md', name: 'foo.md' } };
    const editorDirty = true;   // IME 缓冲里有字符
    const stateDirtyStale = false; // onChange 被守卫屏蔽

    // 旧实现（state.isDirty）：会清 currentFile → 丢字
    expect(shouldClearOnFileDeleted(state, stateDirtyStale)).toBe(true);
    // 新实现（editor.isDirty()）：拦下 clearCurrentFile → rescue 接管
    expect(shouldClearOnFileDeleted(state, editorDirty)).toBe(false);
  });

  it('正常 dirty 状态 → 不能清 currentFile', () => {
    const state = { currentFile: { path: '/foo.md', name: 'foo.md' } };
    expect(shouldClearOnFileDeleted(state, true)).toBe(false);
  });

  it('真干净 → 清 currentFile（外部删除正常处理）', () => {
    const state = { currentFile: { path: '/foo.md', name: 'foo.md' } };
    expect(shouldClearOnFileDeleted(state, false)).toBe(true);
  });

  it('没有打开文件 → 不清（无需处理）', () => {
    const state = { currentFile: null };
    expect(shouldClearOnFileDeleted(state, false)).toBe(false);
    expect(shouldClearOnFileDeleted(state, true)).toBe(false);
  });

  it('currentFile 缺 path 字段 → 不清（异常状态防御）', () => {
    const state = { currentFile: { name: 'foo.md' /* no path */ } };
    expect(shouldClearOnFileDeleted(state, false)).toBe(false);
  });

  it('守卫与 syncDirtyFromEditor 的协同：IME 提升后 rescue 路径必能触发', () => {
    // 端到端验证 P0 fix 的修复链：
    //   1. IME 期间 applyEntries 用 editor.isDirty() 拦下 clearCurrentFile
    //   2. onFilesChanged 不早退
    //   3. syncDirtyFromEditor 把 state.isDirty 提升到 true
    //   4. rescue 分支 `if (state.isDirty)` 看到 true → 落救回文件
    //
    // 这里只测第 1 步和第 3 步（最容易回归），第 4 步是 onFilesChanged 的
    // 既有契约（applyEntries 不再触发的话 rescue 自然能到）。
    const state = { currentFile: { path: '/foo.md', name: 'foo.md' }, isDirty: false };
    const editor = makeEditor(() => true); // IME 期间 editor 一定有未保存字符

    // step 1: 守卫拦下
    expect(shouldClearOnFileDeleted(state, editor.isDirty())).toBe(false);
    // step 3: syncDirtyFromEditor 把 state 提升
    const promoted = syncDirtyFromEditor(state, editor);
    expect(promoted).toBe(true);
    expect(state.isDirty).toBe(true);
  });
});