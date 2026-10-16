// P2-9（audit C-4）配套：createFileOps 不得构造时缓存 editor。
//
// 背景：app.js 顶层不再 new MarkdownEditor（CM6 走 dynamic import，bootstrap
// 里才实例化），所以 createFileOps 在模块 eval 时拿到的 controls.editor 是
// null。file-ops.js 若构造时 `const { editor } = controls` 解构缓存，之后
// bootstrap 给 editor 赋值也传不进来 —— deleteFile 等路径 syncDirtyFromEditor
// (state, null) 直接 TypeError。
//
// 契约：controls.editor 必须运行时现取（app.js 侧用对象字面量 getter 提供
// 活视图），createFileOps 之后赋值也生效。

// @vitest-environment jsdom

import { describe, it, expect } from 'vitest';
import { createFileOps } from '../../src/file-ops.js';

describe('createFileOps editor 惰性解析（P2-9）', () => {
  it('createFileOps 之后才赋值的 editor 也能被 deleteFile 用到', async () => {
    let lateEditor = null;
    const calls = [];
    const controls = {
      fileList: {},
      contextMenu: {},
      viewer: {},
      // app.js 实际形态：对象字面量 getter，运行时才读模块级 let editor
      get editor() { return lateEditor; },
    };
    const state = { currentFile: null, isDirty: false, deletingPath: null };
    const ops = createFileOps({
      state,
      controls,
      api: { deleteFile: async () => ({ ok: true }) },
      callbacks: {
        openFile() {},
        updateWindowTitle() {},
        clearCurrentFile() {},
        updateStatusStats() {},
        syncSaveButton() {},
        applyEditorMode() {},
      },
    });

    // bootstrap 完成：editor 才实例化（模拟 app.js 的时序）
    lateEditor = {
      isDirty: () => { calls.push('isDirty'); return false; },
      getContent: () => 'content',
    };

    await ops.deleteFile({ path: '/tmp/a.md', name: 'a.md' });

    // deleteFile 第一行就 syncDirtyFromEditor(state, editor) —— 旧实现这里
    // 拿到构造时缓存的 null，editor.isDirty() 直接 TypeError
    expect(calls).toContain('isDirty');
    expect(state.deletingPath).toBe(null); // finally 清守卫，流程走完了
  });
});
