// P2-23（audit）：AI 面板 placeholder 区分「无文件」vs「未配置」。
//
// 设计：纯函数 pickPlaceholder 决策三态文案，
//   - !hasFile                  → 「请先打开一个 Markdown 文件」
//   - hasFile + !configured     → 「AI 未配置 — 点「⚙ 设置」填 Base URL 与 API Key」
//   - hasFile + configured      → 「描述你想如何修改当前文档...」
//
// 把决策抽成纯函数方便单测（避免起 jsdom 跑 DOM 副作用）。panel 内部
// setEnabled / setConfigured 走它。
//
// 另测：setEnabled / setConfigured 在 jsdom 下同步 DOM 状态（input.placeholder +
// .ai-chat-configure-link.hidden），保证「内联设置链」只在该显示时显示。

// @vitest-environment jsdom

import { describe, it, expect, beforeEach } from 'vitest';
import { pickPlaceholder, AiChatPanel } from '../../src/ai/ai-chat-panel.js';

describe('pickPlaceholder —— P2-23 三态文案', () => {
  it('无文件 → 提示先打开文件', () => {
    expect(pickPlaceholder({ hasFile: false, configured: true }))
      .toBe('请先打开一个 Markdown 文件');
  });

  it('有文件 + 未配置 → 提示去设置里配置', () => {
    const text = pickPlaceholder({ hasFile: true, configured: false });
    expect(text).toContain('AI 未配置');
    expect(text).toContain('设置');
  });

  it('有文件 + 已配置 → 默认描述型 placeholder', () => {
    expect(pickPlaceholder({ hasFile: true, configured: true }))
      .toBe('描述你想如何修改当前文档...');
  });

  it('优先级：!hasFile 永远盖过 !configured（即便都没配）', () => {
    expect(pickPlaceholder({ hasFile: false, configured: false }))
      .toBe('请先打开一个 Markdown 文件');
  });
});

describe('AiChatPanel.setEnabled / setConfigured —— DOM 同步', () => {
  /** @returns {HTMLElement} 重建一份 index.html 里的 ai-chat-dock 骨架 */
  function buildDock() {
    const dock = document.createElement('div');
    dock.className = 'ai-chat-dock';
    dock.innerHTML = `
      <div class="ai-chat-form-row">
        <button class="ai-chat-toggle" type="button">×</button>
        <div class="ai-chat-input-wrap">
          <input type="text" class="ai-chat-input" />
          <button class="ai-chat-configure-link" type="button" hidden>⚙ 设置</button>
        </div>
        <button class="ai-chat-submit" type="button" data-mode="submit" disabled>生成修改</button>
      </div>
    `;
    return dock;
  }

  let dock;
  beforeEach(() => {
    dock = buildDock();
  });

  it('未初始化时默认 configured=true（避免中间态被误判）', () => {
    const panel = new AiChatPanel({
      element: dock,
      onSubmit: () => {},
      onCancel: () => {},
    });
    // 默认 _configured !== false === true
    panel.setEnabled(false); // 无文件
    expect(dock.querySelector('.ai-chat-input').placeholder)
      .toBe('请先打开一个 Markdown 文件');
  });

  it('hasFile + !configured → placeholder 切到「未配置」+ 内联链显示', () => {
    const panel = new AiChatPanel({
      element: dock,
      onSubmit: () => {},
      onCancel: () => {},
    });
    panel.setEnabled(true); // 有文件
    panel.setConfigured(false); // 未配置
    const input = dock.querySelector('.ai-chat-input');
    const link = dock.querySelector('.ai-chat-configure-link');
    expect(input.placeholder).toContain('AI 未配置');
    expect(link.hidden).toBe(false);
  });

  it('hasFile + configured → placeholder 切回「描述修改」+ 内联链隐藏', () => {
    const panel = new AiChatPanel({
      element: dock,
      onSubmit: () => {},
      onCancel: () => {},
    });
    panel.setEnabled(true);
    panel.setConfigured(false);
    panel.setConfigured(true); // 配置完成
    const input = dock.querySelector('.ai-chat-input');
    const link = dock.querySelector('.ai-chat-configure-link');
    expect(input.placeholder).toBe('描述你想如何修改当前文档...');
    expect(link.hidden).toBe(true);
  });

  it('!hasFile 永远隐藏内联链（不论配置与否）', () => {
    const panel = new AiChatPanel({
      element: dock,
      onSubmit: () => {},
      onCancel: () => {},
    });
    panel.setEnabled(false); // 无文件
    panel.setConfigured(false); // 未配置
    expect(dock.querySelector('.ai-chat-configure-link').hidden).toBe(true);
  });

  it('点击内联链调 onOpenSettings 回调（如果传了）', () => {
    let called = 0;
    const panel = new AiChatPanel({
      element: dock,
      onSubmit: () => {},
      onCancel: () => {},
      onOpenSettings: () => { called += 1; },
    });
    panel.setEnabled(true);
    panel.setConfigured(false);
    const link = dock.querySelector('.ai-chat-configure-link');
    link.click();
    expect(called).toBe(1);
  });
});

