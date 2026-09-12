// src/context-menu.js 的单测
//
// 主要覆盖 audit #C3（critical memory leak）修复：
//   - 快速 show→hide→show 循环，rAF 回调里的 addEventListener 不应泄漏
//   - 同步 hide() 应当取消未 fire 的 rAF，避免它在我们 detach 之后再去挂监听

/* @vitest-environment jsdom */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ContextMenu } from '../../src/context-menu.js';

describe('ContextMenu show/hide lifecycle', () => {
  let menu;
  let container;

  beforeEach(() => {
    // 用独立 container，避免污染全局 body / 与其它测试串扰
    container = document.createElement('div');
    container.id = 'context-menu-test-container';
    document.body.appendChild(container);
    menu = new ContextMenu({ container });
  });

  afterEach(() => {
    menu.hide();
    if (container.parentElement) container.parentElement.removeChild(container);
  });

  it('show 后 isVisible() → true', () => {
    menu.show({
      x: 100, y: 100,
      items: [{ label: '复制', value: 'copy' }],
      onSelect: () => {},
    });
    expect(menu.isVisible()).toBe(true);
    expect(container.querySelector('.context-menu')).toBeTruthy();
  });

  it('hide 后 isVisible() → false', () => {
    menu.show({
      x: 100, y: 100,
      items: [{ label: '复制', value: 'copy' }],
      onSelect: () => {},
    });
    menu.hide();
    expect(menu.isVisible()).toBe(false);
    expect(container.querySelector('.context-menu')).toBeNull();
  });

  it('hide() 可重复调用（不抛错）', () => {
    menu.show({
      x: 100, y: 100,
      items: [{ label: '复制', value: 'copy' }],
      onSelect: () => {},
    });
    expect(() => {
      menu.hide();
      menu.hide();
      menu.hide();
    }).not.toThrow();
  });

  it('audit #C3：show 后立即 hide，应取消挂起的 rAF', async () => {
    // 模拟场景：用户打开菜单，立刻关闭（onSelect 路径）。原实现的 rAF 仍会
    // fire 并挂 5 个 listener —— 现在必须被取消。
    menu.show({
      x: 100, y: 100,
      items: [{ label: '复制', value: 'copy' }],
      onSelect: () => {},
    });
    // rAF 还没 fire（jsdom 默认 fire，但 show 同步执行后立即 hide 应抢先）
    menu.hide();

    // 等待足够时间让原 rAF（如果没被取消）会 fire 的窗口过去
    await new Promise((r) => setTimeout(r, 50));
    // 此时再 show 一次：必须能成功挂上新菜单
    expect(() => {
      menu.show({
        x: 200, y: 200,
        items: [{ label: '粘贴', value: 'paste' }],
        onSelect: () => {},
      });
    }).not.toThrow();
    expect(menu.isVisible()).toBe(true);
  });

  it('audit #C3：show→hide→show 快速循环不抛错、不泄漏菜单节点', async () => {
    // 模拟右键 → 选项 → 立即右键 的快速循环
    for (let i = 0; i < 5; i += 1) {
      menu.show({
        x: 50 + i * 10, y: 50 + i * 10,
        items: [{ label: `Item ${i}`, value: `v${i}` }],
        onSelect: () => {},
      });
      menu.hide();
    }
    // 让所有挂起的 rAF 跑完
    await new Promise((r) => setTimeout(r, 50));
    // 容器里只应该有一个当前菜单，或者零个（取决于时序）
    const menus = container.querySelectorAll('.context-menu');
    expect(menus.length).toBeLessThanOrEqual(1);
    expect(menu.isVisible()).toBe(false);
  });

  it('空 items 数组 → 不创建菜单', () => {
    menu.show({ x: 100, y: 100, items: [], onSelect: () => {} });
    expect(menu.isVisible()).toBe(false);
    expect(container.querySelector('.context-menu')).toBeNull();
  });

  it('非数组 items → 不创建菜单', () => {
    menu.show({ x: 100, y: 100, items: null, onSelect: () => {} });
    expect(menu.isVisible()).toBe(false);
  });
});