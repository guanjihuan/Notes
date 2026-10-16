// P2-16（audit）：heading IntersectionObserver 实例持久化。
//
// 旧实现：_rebuildHeadingObserver 每次 new IntersectionObserver(cb) ——
// loadContentLive 在 split 模式每个 debounced 击键都跑一次重建，observer
// 对象 + 闭包反复分配。
//
// 新契约：
//   - observer 实例只建一次（多次 _rebuildHeadingObserver 不重复 new）
//   - 重建仍 disconnect + 全量 re-observe（M1 历史教训：innerHTML 替换
//     detach 旧节点，增量 observe 会让追踪冻死，不能省）
//   - dispose 仍 disconnect + 置 null（Round 12 P3 契约不变）

// @vitest-environment jsdom

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MarkdownViewer } from '../../src/markdown-viewer.js';

describe('heading observer 持久化（P2-16）', () => {
  let body;
  beforeEach(() => {
    document.body.innerHTML = '';
    body = document.createElement('div');
    body.id = 'markdown-body';
    document.body.appendChild(body);
  });

  function makeViewer() {
    return new MarkdownViewer({
      bodyElement: body,
      emptyElement: document.createElement('div'),
      statusPath: document.createElement('div'),
      statusMeta: document.createElement('div'),
    });
  }

  function addHeadings(...tags) {
    for (const t of tags) {
      const h = document.createElement(t);
      h.id = `${t}-${Math.random().toString(36).slice(2, 6)}`;
      h.textContent = 'title';
      body.appendChild(h);
    }
  }

  it('多次 _rebuildHeadingObserver 只 new 一次 IntersectionObserver', () => {
    const constructCalls = [];
    const fakeObserver = {
      observe: vi.fn(),
      disconnect: vi.fn(),
      unobserve: vi.fn(),
    };
    const RealIO = window.IntersectionObserver;
    window.IntersectionObserver = vi.fn(function () {
      constructCalls.push(true);
      return fakeObserver;
    });

    try {
      const viewer = makeViewer();
      addHeadings('h1', 'h2');
      viewer._rebuildHeadingObserver();
      viewer._rebuildHeadingObserver();
      viewer._rebuildHeadingObserver();
      expect(constructCalls.length).toBe(1);
      // 每次重建都 disconnect + 全量 re-observe（detach 节点不能增量）；
      // 第一次重建时 observer 尚不存在、无可 disconnect，故 3 次重建 = 2 次 disconnect
      expect(fakeObserver.disconnect.mock.calls.length).toBe(2);
      expect(fakeObserver.observe.mock.calls.length).toBe(6); // 2 headings × 3 次
      viewer.dispose();
    } finally {
      window.IntersectionObserver = RealIO;
    }
  });

  it('重建后观察的是新 DOM 节点，不是 detach 的旧节点', () => {
    const observed = [];
    const fakeObserver = {
      observe: vi.fn(function (node) { observed.push(node); }),
      disconnect: vi.fn(),
      unobserve: vi.fn(),
    };
    const RealIO = window.IntersectionObserver;
    window.IntersectionObserver = vi.fn(function () { return fakeObserver; });

    try {
      const viewer = makeViewer();
      addHeadings('h1');
      viewer._rebuildHeadingObserver();
      const firstNode = observed[0];
      // 模拟 innerHTML 全量替换：旧节点 detach，新节点进 DOM
      body.innerHTML = '';
      observed.length = 0;
      addHeadings('h1');
      viewer._rebuildHeadingObserver();
      const secondNode = observed[0];
      expect(secondNode).not.toBe(firstNode);
      expect(secondNode.isConnected).toBe(true);
      expect(firstNode.isConnected).toBe(false);
      viewer.dispose();
    } finally {
      window.IntersectionObserver = RealIO;
    }
  });

  it('dispose 仍 disconnect 一次并置 null（Round 12 P3 契约不变）', () => {
    const fakeObserver = {
      observe: vi.fn(),
      disconnect: vi.fn(),
      unobserve: vi.fn(),
    };
    const RealIO = window.IntersectionObserver;
    window.IntersectionObserver = vi.fn(function () { return fakeObserver; });

    try {
      const viewer = makeViewer();
      addHeadings('h1');
      viewer._rebuildHeadingObserver();
      viewer.dispose();
      expect(fakeObserver.disconnect.mock.calls.length).toBeGreaterThanOrEqual(1);
      expect(viewer._headingObserver).toBe(null);
    } finally {
      window.IntersectionObserver = RealIO;
    }
  });
});
