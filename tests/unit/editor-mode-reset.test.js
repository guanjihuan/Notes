// src/editor-mode-reset.js —— splitRatio 重置决策的纯函数测试
//
// 背景（audit P0-4 + Memory-2）：
//   - 编辑双栏（splitRatio）每次「打开」都默认对半分，drag 比例仅本次会话内
//     有效，不跨应用重启保留。
//   - 旧实现：applyEditorMode 内部用 `document.body.dataset.editorMode !== 'split'`
//     做闸 —— 但默认 editorMode='split' 冷启动时，dataset 已是 'split'，闸永远为
//     假，上次拖的 70% 在冷启动被恢复。
//   - 修复：applyEditorMode 内部无条件按 visualMode 决定 —— visualMode='split'
//     时调 settingsStore.update({ splitRatio: 0.5 })，其它不动。
//   - 顺带：mountSplitter.onDragEnd 改为 noop（drag 不再持久化）。
//
// 这里只测纯函数；mountSplitter 那个 onDragEnd noop 改动是单行「删除
// settingsStore.update 调用」，没分支可测，留在 app.js commit 里人工 review。

// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { applySplitRatioResetIfEnteringSplit } from '../../src/editor-mode-reset.js';

describe('applySplitRatioResetIfEnteringSplit', () => {
  let updateMock;
  let settingsStore;

  beforeEach(() => {
    updateMock = vi.fn().mockResolvedValue({ ok: true });
    settingsStore = { update: updateMock };
  });

  it('visualMode = split → 调 settingsStore.update({ splitRatio: 0.5 })', () => {
    applySplitRatioResetIfEnteringSplit('split', settingsStore);
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(updateMock).toHaveBeenCalledWith({ splitRatio: 0.5 });
  });

  it('visualMode = edit → 不调 update', () => {
    applySplitRatioResetIfEnteringSplit('edit', settingsStore);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('visualMode = preview → 不调 update', () => {
    applySplitRatioResetIfEnteringSplit('preview', settingsStore);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('visualMode 是未知字符串（防御性）→ 不调 update', () => {
    // 防止未来 schema 加新模式时这里误触 reset
    applySplitRatioResetIfEnteringSplit('unknown', settingsStore);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('update reject → onError 被调，函数不抛', async () => {
    updateMock.mockRejectedValue(new Error('disk full'));
    const onError = vi.fn();
    // 不 await：函数本身 fire-and-forget；测试用 microtask flush 等待 catch 跑完
    applySplitRatioResetIfEnteringSplit('split', settingsStore, onError);
    await new Promise((r) => setTimeout(r, 0));
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toMatch(/disk full/);
  });

  it('update reject + 未传 onError → 不抛（用 console.warn 兜底，不让布局重置炸掉 app）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    updateMock.mockRejectedValue(new Error('disk full'));
    expect(() => applySplitRatioResetIfEnteringSplit('split', settingsStore)).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('update 成功 → onError 不被调（成功路径不打扰用户）', async () => {
    const onError = vi.fn();
    applySplitRatioResetIfEnteringSplit('split', settingsStore, onError);
    await new Promise((r) => setTimeout(r, 0));
    expect(onError).not.toHaveBeenCalled();
  });
});
